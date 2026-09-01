# Persistent Browser Sessions for the Apply Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one real Playwright browser alive across a candidate's replies during a multi-turn Telegram application, instead of launching a fresh one every turn, without changing how the Step 7b subagent drives Playwright or weakening any existing safety gate.

**Architecture:** A detached holder process (`core/apply-browser-holder.mjs`) launches a real Chromium instance via Playwright's `chromium.launchServer()`, exposing a CDP endpoint it writes to a per-workspace state file. Before dispatching an apply-flow message, `core/telegram-monitor.mjs` resolves which report the message concerns, looks up (or spawns) that report's holder, liveness-checks it, and — if live — passes `claude -p` a `--mcp-config`/`--strict-mcp-config` override pointing `@playwright/mcp` at that endpoint via `--cdp-endpoint` instead of letting it launch its own browser.

**Tech Stack:** Node.js (`.mjs`), Playwright (`chromium.launchServer`/`chromium.connect`, already a dependency — `package.json` pins `"playwright": "1.62.1"`), `@playwright/mcp` (already the project's configured Playwright MCP server, via `.mcp.json`), `node:test` for tests.

**Spec:** `docs/superpowers/specs/2026-08-31-apply-persistent-browser-design.md`

## Global Constraints

- The CDP endpoint binds to `127.0.0.1` only, never `0.0.0.0` or any externally-reachable interface — CDP access is full remote browser control.
- One holder process per active application (`{workspace}-{report}`), never shared across candidates — this is a structural isolation requirement, not a preference.
- Every existing safety gate (resume-approval, field-approval, submit-approval, account-creation consent, never-fabricate rules) stays completely unchanged — this plan touches transport (which browser a dispatch connects to), never a decision point.
- Any failure in the persistent-browser mechanism (crashed holder, stale state, connection refused) must fall back to today's behavior (a fresh, non-persistent browser) rather than blocking the application.
- State file: `{workspaceCwd}/data/.apply-browser-sessions.json`, keyed by report number, shape `{"<report>": {"endpoint": "ws://...", "pid": <number>, "createdAt": "<ISO>"}}` — this file lives under `data/`, already covered by the blanket `data/*` gitignore rule (verified: `git check-ignore` on a sibling file, `data/.apply-secrets.json`, already passes).

---

## Task 1: Browser holder — launch, endpoint discovery, state file writer

**Files:**
- Create: `core/apply-browser-holder.mjs`
- Create: `tests/apply-browser-holder.test.mjs`

**Interfaces:**
- Produces: `launchHolder({ report, workspaceCwd, statePath })` → `Promise<{ endpoint: string, browserServer: import('playwright').BrowserServer }>` — starts the browser, writes the state file entry, returns the live handle. Exported for Task 2 to build on and for direct testing.
- Produces: `browserSessionsStatePath(workspaceCwd)` → `string` — the one place `{workspaceCwd}/data/.apply-browser-sessions.json` gets computed, so Task 4 (which reads this same file from the daemon side) never re-derives the path differently.
- Produces: `readBrowserSessions(statePath)` / `writeBrowserSessions(statePath, sessions)` — small JSON read/write helpers, mirroring the load/save pattern `core/access-code.mjs` already uses for its own registry file (`loadRegistry`/`saveRegistry`).

- [ ] **Step 1: Write the failing test for path resolution and read/write helpers**

```js
// tests/apply-browser-holder.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserSessionsStatePath, readBrowserSessions, writeBrowserSessions } from '../core/apply-browser-holder.mjs';

function fakeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'career-ops-browser-holder-'));
}

test('browserSessionsStatePath resolves under {workspace}/data/.apply-browser-sessions.json', () => {
  const ws = fakeWorkspace();
  try {
    assert.equal(browserSessionsStatePath(ws), join(ws, 'data', '.apply-browser-sessions.json'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('readBrowserSessions returns {} when the file does not exist yet', () => {
  const ws = fakeWorkspace();
  try {
    const path = browserSessionsStatePath(ws);
    assert.deepEqual(readBrowserSessions(path), {});
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('writeBrowserSessions creates the data/ directory and persists entries; readBrowserSessions reads them back', () => {
  const ws = fakeWorkspace();
  try {
    const path = browserSessionsStatePath(ws);
    writeBrowserSessions(path, { '937': { endpoint: 'ws://127.0.0.1:9999/devtools/browser/abc', pid: 12345, createdAt: '2026-08-31T00:00:00.000Z' } });
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(raw['937'].pid, 12345);
    const reread = readBrowserSessions(path);
    assert.equal(reread['937'].endpoint, 'ws://127.0.0.1:9999/devtools/browser/abc');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/apply-browser-holder.test.mjs`
Expected: FAIL — `core/apply-browser-holder.mjs` does not exist yet, so the import throws `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write `core/apply-browser-holder.mjs`'s path/read/write helpers and the launch function**

```js
#!/usr/bin/env node
// @ts-check
// apply-browser-holder.mjs — a detached, long-lived process that keeps one
// real Playwright browser alive for one in-progress job application, so a
// candidate's later replies (each its own fresh `claude -p` dispatch, per
// core/telegram-monitor.mjs's architecture) can reconnect to the SAME
// browser via @playwright/mcp's --cdp-endpoint instead of launching a new
// one and re-authenticating/re-navigating from scratch every turn.
//
// One holder per {workspace, report} pair, never shared across candidates —
// see docs/superpowers/specs/2026-08-31-apply-persistent-browser-design.md's
// "Multi-tenancy isolation" section. The CDP endpoint binds to 127.0.0.1
// only: CDP access is full remote browser control, and this process must
// never be reachable from outside the machine it runs on.
//
// Usage: node apply-browser-holder.mjs --report <num> --workspace <path>
// (always spawned detached — see core/telegram-monitor.mjs's spawn call —
// so it outlives both the claude -p dispatch that triggered it and the
// daemon process itself).

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainModule } from './is-main.mjs';

/** @param {string} workspaceCwd */
export function browserSessionsStatePath(workspaceCwd) {
  return join(workspaceCwd, 'data', '.apply-browser-sessions.json');
}

/** @param {string} path @returns {Record<string, {endpoint: string, pid: number, createdAt: string}>} */
export function readBrowserSessions(path) {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** @param {string} path @param {Record<string, any>} sessions */
export function writeBrowserSessions(path, sessions) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sessions, null, 2));
}

/**
 * Launch a real, remote-debuggable browser and record it in this workspace's
 * session-state file under `report`. Port 0 lets the OS assign a free port —
 * multiple holders (different reports, possibly different candidates) run
 * concurrently, so a fixed port would collide.
 *
 * @param {{report: string, workspaceCwd: string}} opts
 * @returns {Promise<{endpoint: string, browserServer: import('playwright').BrowserServer}>}
 */
export async function launchHolder({ report, workspaceCwd }) {
  const browserServer = await chromium.launchServer({
    headless: true,
    args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
  });
  const endpoint = browserServer.wsEndpoint();
  const statePath = browserSessionsStatePath(workspaceCwd);
  const sessions = readBrowserSessions(statePath);
  sessions[report] = { endpoint, pid: process.pid, createdAt: new Date().toISOString() };
  writeBrowserSessions(statePath, sessions);
  return { endpoint, browserServer };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/apply-browser-holder.test.mjs`
Expected: PASS (3 tests) — `launchHolder` itself isn't exercised by these three tests yet (it needs a real browser launch, covered in Task 2's tests instead, where the CLI entrypoint and lifecycle are tested together).

- [ ] **Step 5: Commit**

```bash
git add core/apply-browser-holder.mjs tests/apply-browser-holder.test.mjs
git commit -m "feat(apply): add browser holder's launch/state-file core

Path resolution, JSON read/write, and the launchServer()-based launch
function for a per-application persistent browser. CLI entrypoint and
idle-timeout lifecycle land in the next commit."
```

---

## Task 2: Browser holder — CLI entrypoint, idle timeout, and clean shutdown

**Files:**
- Modify: `core/apply-browser-holder.mjs`
- Modify: `tests/apply-browser-holder.test.mjs`

**Interfaces:**
- Consumes: `launchHolder`, `browserSessionsStatePath`, `readBrowserSessions`, `writeBrowserSessions` from Task 1.
- Produces: `runHolderCli(argv, opts)` → `Promise<void>` — parses `--report`/`--workspace`, calls `launchHolder`, then waits (via the injectable `opts.idleTimeoutMs` and `opts.onIdleTimeout`) until told to stop, removing its own state entry before exiting either way. Exported so tests can drive it without spawning a real detached process.
- Produces: `removeBrowserSession(workspaceCwd, report)` — deletes one report's entry from the state file if present; used both by the holder's own shutdown path and (in Task 4) by the daemon when it finds a stale entry.

- [ ] **Step 1: Write the failing tests for shutdown/cleanup and idle-timeout behavior**

```js
// append to tests/apply-browser-holder.test.mjs
import { removeBrowserSession, runHolderCli } from '../core/apply-browser-holder.mjs';

test('removeBrowserSession deletes only the named report, leaving other entries intact', () => {
  const ws = fakeWorkspace();
  try {
    const path = browserSessionsStatePath(ws);
    writeBrowserSessions(path, {
      '937': { endpoint: 'ws://a', pid: 1, createdAt: '2026-08-31T00:00:00.000Z' },
      '938': { endpoint: 'ws://b', pid: 2, createdAt: '2026-08-31T00:00:00.000Z' },
    });
    removeBrowserSession(ws, '937');
    const remaining = readBrowserSessions(path);
    assert.equal(remaining['937'], undefined);
    assert.equal(remaining['938'].endpoint, 'ws://b');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('removeBrowserSession is a no-op when the report was never present or the file does not exist', () => {
  const ws = fakeWorkspace();
  try {
    // File doesn't exist at all yet.
    assert.doesNotThrow(() => removeBrowserSession(ws, '999'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('runHolderCli launches a real browser, writes the state entry, then removes it on idle timeout', async () => {
  const ws = fakeWorkspace();
  try {
    let closed = false;
    const fakeLaunch = async ({ report, workspaceCwd }) => {
      // Real launchHolder writes the entry itself — the fake must too, so
      // runHolderCli's cleanup-on-exit path has something real to remove.
      const path = browserSessionsStatePath(workspaceCwd);
      const sessions = readBrowserSessions(path);
      sessions[report] = { endpoint: 'ws://127.0.0.1:9/fake', pid: process.pid, createdAt: new Date().toISOString() };
      writeBrowserSessions(path, sessions);
      return { endpoint: 'ws://127.0.0.1:9/fake', browserServer: { close: async () => { closed = true; } } };
    };
    await runHolderCli(['--report', '937', '--workspace', ws], { launch: fakeLaunch, idleTimeoutMs: 10 });
    assert.equal(closed, true, 'the browser server should be closed on idle timeout');
    assert.deepEqual(readBrowserSessions(browserSessionsStatePath(ws))['937'], undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/apply-browser-holder.test.mjs`
Expected: FAIL — `removeBrowserSession` and `runHolderCli` are not exported yet.

- [ ] **Step 3: Implement the CLI entrypoint, idle timeout, and cleanup**

Append to `core/apply-browser-holder.mjs` (after `launchHolder`):

```js
/** @param {string} workspaceCwd @param {string} report */
export function removeBrowserSession(workspaceCwd, report) {
  const path = browserSessionsStatePath(workspaceCwd);
  const sessions = readBrowserSessions(path);
  if (!(report in sessions)) return;
  delete sessions[report];
  writeBrowserSessions(path, sessions);
}

// No CDP activity for this long means the application was abandoned —
// self-terminate rather than leaving an orphaned browser process running
// indefinitely (see the spec's "Cleanup" section). This is a BACKSTOP: the
// documented mode-file cleanup triggers (Step 9 success, explicit skip, a
// hard-stop) are expected to remove the session first in the normal case —
// this only fires when every one of those was somehow missed.
const DEFAULT_IDLE_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * @param {string[]} argv - e.g. ['--report', '937', '--workspace', '/path']
 * @param {{launch?: typeof launchHolder, idleTimeoutMs?: number}} [opts]
 *   `launch` and `idleTimeoutMs` are injectable so tests never spawn a real
 *   browser or wait 45 real minutes.
 */
export async function runHolderCli(argv, opts = {}) {
  const launch = opts.launch || launchHolder;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const reportIdx = argv.indexOf('--report');
  const workspaceIdx = argv.indexOf('--workspace');
  const report = reportIdx !== -1 ? argv[reportIdx + 1] : null;
  const workspaceCwd = workspaceIdx !== -1 ? argv[workspaceIdx + 1] : null;
  if (!report || !workspaceCwd) {
    throw new Error('Usage: apply-browser-holder.mjs --report <num> --workspace <path>');
  }

  const { browserServer } = await launch({ report, workspaceCwd });

  let resolveStop;
  const stopped = new Promise(r => { resolveStop = r; });
  const timer = setTimeout(() => resolveStop(), idleTimeoutMs);
  const stopEarly = () => { clearTimeout(timer); resolveStop(); };
  process.on('SIGTERM', stopEarly);
  process.on('SIGINT', stopEarly);

  await stopped;
  await browserServer.close();
  removeBrowserSession(workspaceCwd, report);
}

if (isMainModule(import.meta.url)) {
  runHolderCli(process.argv.slice(2)).catch(err => {
    console.error(`[apply-browser-holder] ${err.message}`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/apply-browser-holder.test.mjs`
Expected: PASS (6 tests). The idle-timeout test uses `idleTimeoutMs: 10` so it completes in milliseconds, not 45 real minutes.

- [ ] **Step 5: Commit**

```bash
git add core/apply-browser-holder.mjs tests/apply-browser-holder.test.mjs
git commit -m "feat(apply): browser holder CLI entrypoint, idle timeout, cleanup

runHolderCli launches the browser, waits for either a stop signal
(SIGTERM/SIGINT, sent by the daemon at a documented cleanup trigger) or
its own idle timeout, then always closes the browser and removes its
own state entry before exiting -- an abandoned application never leaves
an orphaned browser process running indefinitely."
```

---

## Task 3: Daemon — resolve which report an incoming apply-flow message concerns

**Files:**
- Modify: `core/telegram-monitor.mjs`
- Modify: `tests/telegram-monitor.test.mjs`

**Interfaces:**
- Consumes: nothing new from earlier tasks — this is pure message/state-file parsing.
- Produces: `resolveReportForDispatch(dispatch)` → `string | null` — `dispatch` is the same shape `dispatchOne` already receives (`{chatId, cwd, kind, messages, state}`). Returns a report number string, or `null` when it can't confidently resolve one (Task 4 treats `null` as "use the default MCP config, no override" — see the spec's item 4 under "Daemon-side decision logic").

- [ ] **Step 1: Write the failing tests**

```js
// append to tests/telegram-monitor.test.mjs
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveReportForDispatch } from '../core/telegram-monitor.mjs';

function fakeWorkspaceWithState(pendingBlock) {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-report-resolve-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  writeFileSync(join(ws, 'data', 'telegram-state.md'), [
    '# Telegram State',
    '',
    '## Pending Confirmations',
    pendingBlock,
    '',
    '## Batch Queue',
    '(none)',
  ].join('\n'));
  return ws;
}

test('resolveReportForDispatch resolves a fresh "/apply {report}" command directly from the message text', () => {
  const dispatch = { chatId: '1', cwd: '/fake/does-not-need-to-exist', kind: 'routing', messages: [{ chatId: '1', text: '/apply 937' }], state: null };
  assert.equal(resolveReportForDispatch(dispatch), '937');
});

test('resolveReportForDispatch resolves from telegram-state.md when exactly one confirmation is pending', () => {
  const ws = fakeWorkspaceWithState(
    '[msg_id: 398] stage: field-approval — NRECA, report 937 — Self Identify (5 of 6)\n  report: 937\n  job_url: https://example.com\n  data: {}',
  );
  try {
    const dispatch = { chatId: '1', cwd: ws, kind: 'routing', messages: [{ chatId: '1', text: 'yes' }], state: null };
    assert.equal(resolveReportForDispatch(dispatch), '937');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveReportForDispatch returns null when zero confirmations are pending', () => {
  const ws = fakeWorkspaceWithState('(none)');
  try {
    const dispatch = { chatId: '1', cwd: ws, kind: 'routing', messages: [{ chatId: '1', text: 'yes' }], state: null };
    assert.equal(resolveReportForDispatch(dispatch), null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveReportForDispatch returns null when MULTIPLE confirmations are pending (ambiguous)', () => {
  const ws = fakeWorkspaceWithState(
    '[msg_id: 100] stage: question — first\n  report: 100\n  job_url: https://example.com\n  data: {}\n' +
    '[msg_id: 200] stage: question — second\n  report: 200\n  job_url: https://example.com\n  data: {}',
  );
  try {
    const dispatch = { chatId: '1', cwd: ws, kind: 'routing', messages: [{ chatId: '1', text: 'yes' }], state: null };
    assert.equal(resolveReportForDispatch(dispatch), null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveReportForDispatch returns null for a command unrelated to apply', () => {
  const dispatch = { chatId: '1', cwd: '/fake', kind: 'routing', messages: [{ chatId: '1', text: '/status' }], state: null };
  assert.equal(resolveReportForDispatch(dispatch), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/telegram-monitor.test.mjs`
Expected: FAIL — `resolveReportForDispatch` is not exported yet. Also add `import { join } from 'node:path';` at the top of the test file if not already present (check the existing imports first — `tests/telegram-monitor.test.mjs` does not currently import `join`, `mkdtempSync`, `mkdirSync`, `writeFileSync`, or `tmpdir`; add all five to the top of the file alongside the existing imports).

- [ ] **Step 3: Implement `resolveReportForDispatch` in `core/telegram-monitor.mjs`**

Add near the other exported helpers (e.g. just above `dispatchOne`):

```js
/**
 * Determine which tracker report number an apply-flow message concerns,
 * using only signals that are already structured (never re-implementing
 * modes/telegram.md's own routing) — see the spec's "Daemon-side decision
 * logic" section. Returns null whenever it can't confidently resolve one;
 * callers treat null as "no browser-session override, dispatch normally"
 * (docs/superpowers/specs/2026-08-31-apply-persistent-browser-design.md
 * item 4 under Architecture > Daemon-side decision logic) — this function
 * only ever adds a persistence path, never removes the existing fallback.
 *
 * Deliberately does NOT resolve `/apply {url}` (only `/apply {report#}`) —
 * URL-to-report resolution requires fuzzy-matching against
 * data/applications.md the way modes/telegram.md Step 3b item 0 does, which
 * belongs in that mode file's routing logic, not duplicated here. A URL-based
 * /apply simply dispatches without a browser-session override, same as any
 * other unresolvable case.
 *
 * @param {{chatId: string, cwd: string, kind: 'routing'|'onboarding', messages: any[], state: object|null}} dispatch
 * @returns {string | null}
 */
export function resolveReportForDispatch(dispatch) {
  for (const msg of dispatch.messages || []) {
    const m = /^\/apply\s+(\d+)\b/.exec((msg.text || '').trim());
    if (m) return m[1];
  }

  const statePath = join(dispatch.cwd, 'data', 'telegram-state.md');
  if (!existsSync(statePath)) return null;
  let content;
  try {
    content = readFileSync(statePath, 'utf-8');
  } catch {
    return null;
  }
  const afterHeader = content.split('## Pending Confirmations')[1];
  if (!afterHeader) return null;
  const section = afterHeader.split('## Batch Queue')[0];
  const blocks = section.match(/^\[msg_id: \d+\].*$/gm) || [];
  if (blocks.length !== 1) return null;
  const reportMatch = /^\s*report:\s*(\d+)\s*$/m.exec(section);
  return reportMatch ? reportMatch[1] : null;
}
```

The file's existing imports already cover most of what this needs: `import { existsSync } from 'fs';` and `import { resolve, dirname, join } from 'path';` are both already present near the top of `core/telegram-monitor.mjs`. Only `readFileSync` is missing — change the existing `import { existsSync } from 'fs';` line to `import { existsSync, readFileSync } from 'fs';`. Do not add any new import statements for `existsSync` or `join`; they're already there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/telegram-monitor.test.mjs`
Expected: PASS (all existing tests plus the 5 new ones — 20 total).

- [ ] **Step 5: Commit**

```bash
git add core/telegram-monitor.mjs tests/telegram-monitor.test.mjs
git commit -m "feat(apply): resolve which report a dispatch concerns

resolveReportForDispatch handles the two structured signals available
without duplicating modes/telegram.md's own routing: a fresh /apply
{report} command, or the report: field on a single pending
confirmation. Returns null (safe fallback: dispatch without a
browser-session override) for anything else, including /apply {url}
and ambiguous multi-pending-confirmation cases."
```

---

## Task 4: Daemon — resolve, spawn, or reuse a report's browser session

**Files:**
- Modify: `core/telegram-monitor.mjs`
- Modify: `tests/telegram-monitor.test.mjs`

**Interfaces:**
- Consumes: `browserSessionsStatePath`, `readBrowserSessions`, `removeBrowserSession` from `core/apply-browser-holder.mjs` (Tasks 1-2).
- Produces: `resolveBrowserMcpArgs(report, workspaceCwd, deps)` → `Promise<string[]>` — returns either `[]` (no override — use the project's default `.mcp.json`) or `['--mcp-config', '<json>', '--strict-mcp-config']`. `deps` is an object of injectable dependencies (`checkPidAlive`, `checkCdpAlive`, `spawnHolder`, `waitForEndpoint`) so tests never spawn a real process or launch a real browser.

- [ ] **Step 1: Write the failing tests**

```js
// append to tests/telegram-monitor.test.mjs
import { resolveBrowserMcpArgs } from '../core/telegram-monitor.mjs';
import { writeBrowserSessions, browserSessionsStatePath } from '../core/apply-browser-holder.mjs';

function fakeWorkspaceDir() {
  return mkdtempSync(join(tmpdir(), 'career-ops-mcp-args-'));
}

test('resolveBrowserMcpArgs returns [] (no override) when report is null', async () => {
  const args = await resolveBrowserMcpArgs(null, '/fake', {});
  assert.deepEqual(args, []);
});

test('resolveBrowserMcpArgs reuses a live existing session, verified by BOTH pid and CDP checks', async () => {
  const ws = fakeWorkspaceDir();
  try {
    writeBrowserSessions(browserSessionsStatePath(ws), {
      '937': { endpoint: 'ws://127.0.0.1:1/fake', pid: 4242, createdAt: '2026-08-31T00:00:00.000Z' },
    });
    const args = await resolveBrowserMcpArgs('937', ws, {
      checkPidAlive: async (pid) => pid === 4242,
      checkCdpAlive: async (endpoint) => endpoint === 'ws://127.0.0.1:1/fake',
      spawnHolder: async () => { throw new Error('should not spawn — a live session already exists'); },
    });
    assert.equal(args.length, 3);
    assert.equal(args[0], '--mcp-config');
    assert.equal(args[2], '--strict-mcp-config');
    const config = JSON.parse(args[1]);
    assert.deepEqual(config.mcpServers.playwright.args, ['@playwright/mcp@latest', '--cdp-endpoint', 'ws://127.0.0.1:1/fake']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveBrowserMcpArgs treats a dead PID as gone, deletes the stale entry, and spawns fresh', async () => {
  const ws = fakeWorkspaceDir();
  try {
    writeBrowserSessions(browserSessionsStatePath(ws), {
      '937': { endpoint: 'ws://127.0.0.1:1/stale', pid: 9999, createdAt: '2026-08-31T00:00:00.000Z' },
    });
    let spawned = false;
    const args = await resolveBrowserMcpArgs('937', ws, {
      checkPidAlive: async () => false, // dead
      checkCdpAlive: async () => { throw new Error('should not even check CDP once the PID check already failed'); },
      spawnHolder: async () => { spawned = true; },
      waitForEndpoint: async () => 'ws://127.0.0.1:2/fresh',
    });
    assert.equal(spawned, true);
    assert.equal(JSON.parse(args[1]).mcpServers.playwright.args[2], 'ws://127.0.0.1:2/fresh');
    // The stale entry must be gone from the state file (not left for the
    // NEXT lookup to trip over again).
    const remaining = (await import('../core/apply-browser-holder.mjs')).readBrowserSessions(browserSessionsStatePath(ws));
    assert.equal(remaining['937'], undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveBrowserMcpArgs treats a failed CDP connection as gone even when the PID is alive (PID recycling)', async () => {
  const ws = fakeWorkspaceDir();
  try {
    writeBrowserSessions(browserSessionsStatePath(ws), {
      '937': { endpoint: 'ws://127.0.0.1:1/stale', pid: 4242, createdAt: '2026-08-31T00:00:00.000Z' },
    });
    let spawned = false;
    await resolveBrowserMcpArgs('937', ws, {
      checkPidAlive: async () => true, // a DIFFERENT process happens to reuse this PID
      checkCdpAlive: async () => false, // but it's not actually our browser
      spawnHolder: async () => { spawned = true; },
      waitForEndpoint: async () => 'ws://127.0.0.1:2/fresh',
    });
    assert.equal(spawned, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveBrowserMcpArgs spawns a fresh holder when no entry exists yet', async () => {
  const ws = fakeWorkspaceDir();
  try {
    let spawnedWith = null;
    const args = await resolveBrowserMcpArgs('937', ws, {
      spawnHolder: async (opts) => { spawnedWith = opts; },
      waitForEndpoint: async () => 'ws://127.0.0.1:3/brand-new',
    });
    assert.deepEqual(spawnedWith, { report: '937', workspaceCwd: ws });
    assert.equal(JSON.parse(args[1]).mcpServers.playwright.args[2], 'ws://127.0.0.1:3/brand-new');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveBrowserMcpArgs falls back to [] (no override) if spawning or waiting for the endpoint fails', async () => {
  const ws = fakeWorkspaceDir();
  try {
    const args = await quietErrors(() => resolveBrowserMcpArgs('937', ws, {
      spawnHolder: async () => {},
      waitForEndpoint: async () => { throw new Error('holder never wrote its endpoint in time'); },
    }));
    assert.deepEqual(args, []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/telegram-monitor.test.mjs`
Expected: FAIL — `resolveBrowserMcpArgs` is not exported yet.

- [ ] **Step 3: Implement `resolveBrowserMcpArgs` and its real (non-test) dependencies in `core/telegram-monitor.mjs`**

Add near `resolveReportForDispatch`:

```js
// `spawn` is already imported at the top of this file
// (`import { spawn, execSync } from 'child_process';`) — do not add a
// second import for it. Add these two new imports near that existing one:
import { browserSessionsStatePath, readBrowserSessions, removeBrowserSession } from './apply-browser-holder.mjs';
import { chromium } from 'playwright';

const APPLY_BROWSER_HOLDER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'apply-browser-holder.mjs');
const BROWSER_ENDPOINT_WAIT_MS = 5000;
const BROWSER_ENDPOINT_POLL_INTERVAL_MS = 100;

/** @param {number} pid */
async function checkPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} endpoint */
async function checkCdpAlive(endpoint) {
  try {
    const browser = await chromium.connect(endpoint, { timeout: 3000 });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

/** @param {{report: string, workspaceCwd: string}} opts */
async function spawnHolder({ report, workspaceCwd }) {
  spawn(process.execPath, [APPLY_BROWSER_HOLDER_PATH, '--report', report, '--workspace', workspaceCwd], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

/** @param {string} workspaceCwd @param {string} report */
async function waitForEndpoint(workspaceCwd, report) {
  const statePath = browserSessionsStatePath(workspaceCwd);
  const deadline = Date.now() + BROWSER_ENDPOINT_WAIT_MS;
  while (Date.now() < deadline) {
    const sessions = readBrowserSessions(statePath);
    if (sessions[report]?.endpoint) return sessions[report].endpoint;
    await new Promise(r => setTimeout(r, BROWSER_ENDPOINT_POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for apply-browser-holder to write its endpoint for report ${report}`);
}

function buildMcpConfigArgs(endpoint) {
  const config = { mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--cdp-endpoint', endpoint] } } };
  return ['--mcp-config', JSON.stringify(config), '--strict-mcp-config'];
}

/**
 * Resolve the --mcp-config override (if any) that should be appended to this
 * dispatch's `claude -p` invocation so it reconnects to report `report`'s
 * persistent browser instead of launching its own — see the spec's
 * "Architecture > How a dispatch connects to it" and "Daemon-side decision
 * logic" sections. Returns [] (no override, dispatch exactly as today) when
 * `report` is null, or when anything about the persistence mechanism fails —
 * this function is never allowed to block or fail a dispatch; the fallback
 * IS the safety net described in the spec's "degrade gracefully" goal.
 *
 * @param {string | null} report
 * @param {string} workspaceCwd
 * @param {{checkPidAlive?: typeof checkPidAlive, checkCdpAlive?: typeof checkCdpAlive, spawnHolder?: typeof spawnHolder, waitForEndpoint?: typeof waitForEndpoint}} [deps] - overridable for tests.
 * @returns {Promise<string[]>}
 */
export async function resolveBrowserMcpArgs(report, workspaceCwd, deps = {}) {
  if (!report) return [];
  const pidAlive = deps.checkPidAlive || checkPidAlive;
  const cdpAlive = deps.checkCdpAlive || checkCdpAlive;
  const doSpawn = deps.spawnHolder || spawnHolder;
  const doWait = deps.waitForEndpoint || waitForEndpoint;

  try {
    const statePath = browserSessionsStatePath(workspaceCwd);
    const sessions = readBrowserSessions(statePath);
    const existing = sessions[report];

    if (existing) {
      const alive = (await pidAlive(existing.pid)) && (await cdpAlive(existing.endpoint));
      if (alive) return buildMcpConfigArgs(existing.endpoint);
      removeBrowserSession(workspaceCwd, report);
    }

    await doSpawn({ report, workspaceCwd });
    const endpoint = await doWait(workspaceCwd, report);
    return buildMcpConfigArgs(endpoint);
  } catch (err) {
    console.error(`[telegram-monitor] Persistent browser session unavailable for report ${report}, falling back to a fresh browser: ${err.message}`);
    return [];
  }
}
```

Before adding these imports, check the top of `core/telegram-monitor.mjs` for its existing `child_process` and `node:path`/`node:url` imports (it already imports `spawn` from `node:child_process`, and `dirname`/`fileURLToPath` are very likely already imported too, given `resolveClaudeCommand()` and `REPO_ROOT` earlier in this same file already use path/URL resolution) — reuse those existing imports rather than adding duplicates under different names.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/telegram-monitor.test.mjs`
Expected: PASS (all existing tests plus the 6 new ones — 26 total).

- [ ] **Step 5: Commit**

```bash
git add core/telegram-monitor.mjs tests/telegram-monitor.test.mjs
git commit -m "feat(apply): resolve/spawn/reuse a report's persistent browser

resolveBrowserMcpArgs is the daemon-side decision point: reuse a live
existing holder (verified by BOTH a PID-alive check and an actual CDP
connection, since a recycled PID could otherwise pass a PID-only check),
clean up and respawn on a stale one, or spawn fresh when none exists.
Any failure anywhere in this path falls back to [] (no override) rather
than blocking the dispatch -- the persistence layer can only ever help,
never break, an application."
```

---

## Task 5: Wire the resolved MCP args into the actual dispatch

**Files:**
- Modify: `core/telegram-monitor.mjs`
- Modify: `tests/telegram-monitor.test.mjs`

**Interfaces:**
- Consumes: `resolveReportForDispatch` (Task 3), `resolveBrowserMcpArgs` (Task 4).
- Produces: `dispatchOne` now calls `invoke(prompt, cwd, timeoutMs, model, extraArgs)` — a 5th parameter, appended to `invokeClaudeRoutingOnce`'s spawned `claude` args. `invokeClaudeRoutingOnce`'s signature becomes `(prompt, cwd, timeoutMs, model, extraArgs = [])`.

- [ ] **Step 1: Write the failing tests**

```js
// append to tests/telegram-monitor.test.mjs
test('dispatchOne resolves and threads browser-session extraArgs for a ROUTING dispatch with a resolvable report', async () => {
  const calls = [];
  const fakeInvoke = async (prompt, cwd, timeoutMs, model, extraArgs) => { calls.push({ cwd, extraArgs }); };
  const dispatch = {
    chatId: '1', cwd: '/fake/workspace/alice', kind: 'routing',
    messages: [{ chatId: '1', text: '/apply 937' }], state: null,
  };
  await dispatchOne(dispatch, fakeInvoke, async () => ['--mcp-config', '{"fake":true}', '--strict-mcp-config']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].extraArgs, ['--mcp-config', '{"fake":true}', '--strict-mcp-config']);
});

test('dispatchOne passes an empty extraArgs array for an ONBOARDING dispatch — never resolves a browser session for onboarding', async () => {
  const calls = [];
  const fakeInvoke = async (prompt, cwd, timeoutMs, model, extraArgs) => { calls.push({ extraArgs }); };
  const dispatch = {
    chatId: '1', cwd: '/fake/workspace', kind: 'onboarding',
    messages: [{ chatId: '1', text: 'Alice' }], state: { currentStep: 'name' },
  };
  let resolveBrowserCalled = false;
  await dispatchOne(dispatch, fakeInvoke, async () => { resolveBrowserCalled = true; return []; });
  assert.equal(calls[0].extraArgs.length, 0);
  assert.equal(resolveBrowserCalled, false, 'onboarding never needs a browser session — resolving one would be wasted work on the hot path for every onboarding message');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/telegram-monitor.test.mjs`
Expected: FAIL — `dispatchOne` doesn't yet accept a third parameter for the browser-args resolver, so `extraArgs` is always `undefined` in the fake's recorded calls.

- [ ] **Step 3: Update `dispatchOne` and `invokeClaudeRoutingOnce`**

Change `dispatchOne`'s signature and body:

```js
/**
 * @param {{chatId: string, cwd: string, kind: 'routing'|'onboarding', messages: any[], state: object|null}} dispatch
 * @param {(prompt: string, cwd: string, timeoutMs?: number, model?: string, extraArgs?: string[]) => Promise<void>} [invoke] - overridable for tests.
 * @param {(dispatch: object) => Promise<string[]>} [resolveBrowserArgs] - overridable for tests; defaults to resolving report + browser session for real.
 */
export async function dispatchOne(dispatch, invoke = invokeClaudeRoutingOnce, resolveBrowserArgs = defaultResolveBrowserArgs) {
  const prompt = dispatch.kind === 'onboarding'
    ? buildOnboardingPrompt(dispatch)
    : buildRoutingPrompt(dispatch.messages);
  const timeoutMs = dispatch.kind === 'onboarding' ? ONBOARDING_TIMEOUT_MS : undefined;
  const model = dispatch.kind === 'onboarding' ? ONBOARDING_MODEL : undefined;
  // Onboarding never touches Playwright/apply.md — resolving a browser
  // session for it would be pure wasted work on a hot path every onboarding
  // message travels.
  const extraArgs = dispatch.kind === 'onboarding' ? [] : await resolveBrowserArgs(dispatch);

  try {
    await invoke(prompt, dispatch.cwd, timeoutMs, model, extraArgs);
  } catch (err) {
    if (err.spawnFailed) {
      console.error(`[telegram-monitor] Spawn failed (${err.message}) — retrying once...`);
      try {
        await invoke(prompt, dispatch.cwd, timeoutMs, model, extraArgs);
        return;
      } catch (retryErr) {
        console.error(`[telegram-monitor] Retry also failed (${retryErr.message}) — sending emergency notification.`);
        notifyRoutingFailure(retryErr.message, dispatch);
        throw retryErr;
```

(Leave everything after this point in the existing `catch` block untouched — only the function signature, the new `extraArgs` line, and the two `invoke(...)` call sites above gain the 5th argument.)

Add the default resolver just above `dispatchOne`:

```js
/** @param {object} dispatch */
async function defaultResolveBrowserArgs(dispatch) {
  return resolveBrowserMcpArgs(resolveReportForDispatch(dispatch), dispatch.cwd);
}
```

Update `invokeClaudeRoutingOnce` to accept and forward the 5th parameter:

```js
function invokeClaudeRoutingOnce(prompt, cwd, timeoutMs, model, extraArgs = []) {
  const { cmd, shell } = resolveClaudeCommand();
  const args = model ? ['-p', prompt, '--model', model, ...extraArgs] : ['-p', prompt, ...extraArgs];
  return spawnCapturingTail(cmd, args, {
    cwd,
    shell,
    timeoutMs,
    exitErrorPrefix: 'claude -p routing exited',
    timeoutErrorMessage: (ms) => `claude -p timed out after ${ms}ms`,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/telegram-monitor.test.mjs`
Expected: PASS — all existing tests (including the two original `dispatchOne` tests from before this plan, which call `dispatchOne(dispatch, fakeInvoke)` with no third argument and so get the real `defaultResolveBrowserArgs` — for those tests' fake workspace paths like `/fake/workspace`, `resolveReportForDispatch` finds no `telegram-state.md` and returns `null`, so `resolveBrowserMcpArgs` short-circuits to `[]` immediately with no spawning or network activity; confirm this by re-running those two specific tests and checking they still pass with no new failures or hangs) plus the 2 new ones from this task.

- [ ] **Step 5: Commit**

```bash
git add core/telegram-monitor.mjs tests/telegram-monitor.test.mjs
git commit -m "feat(apply): thread resolved browser-session args into the real dispatch

dispatchOne now resolves report + browser-session MCP args for routing
dispatches (never for onboarding, which never touches Playwright) and
passes them through to invokeClaudeRoutingOnce, which appends them to
the spawned claude -p invocation. The resolver is injectable so existing
and new tests never spawn a real process or launch a real browser."
```

---

## Task 6: `apply.md` — clean up the persistent browser session at the same points `.apply-secrets.json` already gets cleaned up

**Files:**
- Modify: `modes/apply.md`

**Interfaces:** None — this is prose-only, no code interfaces.

- [ ] **Step 1: Add the cleanup line to Step 9 (successful submission)**

In `modes/apply.md`, find Step 9's numbered list (it currently has an item reading `**If this report has an entry in \`data/.apply-secrets.json\`... delete it now.**` immediately followed by an item about `needs_manual_upload` cleanup). Add one more item immediately after those two, before the "Suggest next step" item:

```
X. **If this report has an entry in `data/.apply-browser-sessions.json`, stop the holder process and remove the entry now.** The browser's only purpose was letting later turns of this application reconnect without re-authenticating; once the application is submitted there are no more turns to reconnect for. Send the recorded `pid` a termination signal (the holder's own shutdown path — see `core/apply-browser-holder.mjs` — closes the browser and removes its own state entry on receiving one, the same clean-shutdown path its idle timeout also uses) rather than deleting the state entry directly and leaving the process running orphaned.
```

(Renumber the items after this insertion accordingly, and use the actual next-available number in place of `X` — re-read Step 9's current numbering before editing, since earlier tasks this session already inserted items into this same list.)

- [ ] **Step 2: Add the same cleanup to the hard-stop points that already clean up `.apply-secrets.json`**

Search `modes/apply.md` for every other place `data/.apply-secrets.json` gets deleted on a hard-stop (Step 5-alt items 10-13's password-policy-rejection/email-already-registered/CAPTCHA/ambiguous-failure branches already each have their own cleanup instruction for the password cache). Add a parallel one-sentence instruction to each of those same branches: also stop the holder and remove its `data/.apply-browser-sessions.json` entry for this report, for the same reason — a hard-stop means no more turns are coming for this application, so there's nothing left to hold a browser open for.

- [ ] **Step 3: Verify by careful reading**

This is a documentation-only change with no automated test coverage possible (mode files are prose read by a future Claude session, not executable code) — matching this project's established convention for `modes/*.md` changes throughout this session. Re-read the full amended Step 9 and Step 5-alt sections once end-to-end to confirm the new items read coherently alongside the existing `.apply-secrets.json` cleanup instructions, and that the numbering is correct throughout.

- [ ] **Step 4: Run the full test suite to confirm the prose-only change didn't disturb anything**

Run: `node core/test-all.mjs`
Expected: `📊 Results: <N> passed, 0 failed` — no test asserts on this exact prose, so this run should be a pure confirmation that nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add modes/apply.md
git commit -m "docs(apply): clean up the persistent browser session at every existing cleanup point

Mirrors the data/.apply-secrets.json cleanup already documented at Step
9 (successful submission) and the Step 5-alt hard-stop branches -- a
persistent browser's only purpose is letting a later turn reconnect
without re-authenticating, so the same 'no more turns coming' triggers
that already clean up the password cache clean this up too."
```

---

## Task 7: Manual end-to-end verification

**Files:** None modified — this task is a verification checklist, not a code change.

This step exists because the spec explicitly calls out that the actual CDP-reconnection mechanism needs at least one real, manual verification against a live ATS — unit tests with injectable fakes (Tasks 1-5) prove the *decision logic* is correct, but cannot prove `@playwright/mcp --cdp-endpoint` genuinely reconnects to an already-authenticated live page the way this whole feature depends on.

- [ ] **Step 1: Manually launch a holder and confirm its endpoint is connectable**

```bash
node core/apply-browser-holder.mjs --report test-manual --workspace workspaces/roberto-vasquez &
sleep 2
cat workspaces/roberto-vasquez/data/.apply-browser-sessions.json
```

Expected: a JSON object with a `test-manual` key containing a `ws://127.0.0.1:<port>/...` endpoint and a real `pid`.

- [ ] **Step 2: Confirm a fresh `@playwright/mcp` invocation can connect to that endpoint and see a real page**

```bash
npx @playwright/mcp@latest --cdp-endpoint "$(node -e "console.log(JSON.parse(require('fs').readFileSync('workspaces/roberto-vasquez/data/.apply-browser-sessions.json')).\"test-manual\".endpoint)")" &
```

Then, from a Claude Code session configured with this MCP server (or by using the `mcp__playwright__browser_navigate` tool directly in an interactive session pointed at this config), navigate to a real page (e.g. a Workday sign-in page), sign in, then **kill and restart the MCP server process** (not the holder — the holder must keep running) and connect again with the same `--cdp-endpoint`. Confirm the second connection sees the SAME signed-in page/session, not a fresh login screen — this is the entire premise the feature rests on, and needs to be seen working once, live, before trusting it in production.

- [ ] **Step 3: Confirm idle-timeout and SIGTERM cleanup both actually remove the state entry**

```bash
kill $(node -e "console.log(JSON.parse(require('fs').readFileSync('workspaces/roberto-vasquez/data/.apply-browser-sessions.json')).\"test-manual\".pid)")
sleep 2
cat workspaces/roberto-vasquez/data/.apply-browser-sessions.json
```

Expected: the `test-manual` key is gone (or the file is now `{}` if it was the only entry) — confirming the holder's SIGTERM handler actually ran its cleanup path in a real process, not just in the unit test's fake.

- [ ] **Step 4: Report the outcome**

Note in the SDD ledger (or directly to the user, if executing this plan interactively rather than via subagent-driven-development) whether steps 1-3 behaved as expected. If step 2's session-continuity check fails (the second connection does NOT see the already-authenticated page), this is a load-bearing finding — it means the core mechanism this whole feature depends on doesn't work as designed, and the daemon-side wiring from Tasks 3-5 should not be considered production-ready until that's root-caused, even though its own unit tests pass (unit tests with fakes only prove the *decision logic* around a working CDP-connect, not that the CDP-connect itself works end-to-end).

---

## Self-Review Notes

- **Spec coverage:** Problem/Goals (Tasks 1-5 implement the mechanism; Task 7 verifies the core premise), Rejected Approach (documented in the spec itself, no code implication), Architecture's holder process + state file + connection mechanism + daemon decision logic + liveness check + cleanup + multi-tenancy isolation (Tasks 1, 2, 3, 4, 5, 6 respectively), Testing Approach (each task's own tests, plus Task 7 for the one thing fakes can't cover), Open Implementation Details (the `process.kill(pid, 0)` cross-platform assumption is exercised for real the moment Task 7 runs on the actual deployment machine, not just asserted in a mocked unit test).
- **Placeholder scan:** no TBD/TODO markers; every step has real, complete code or a concrete manual verification command.
- **Type consistency:** `resolveReportForDispatch(dispatch) → string | null` (Task 3) feeds directly into `resolveBrowserMcpArgs(report, workspaceCwd, deps) → Promise<string[]>` (Task 4) via `defaultResolveBrowserArgs` (Task 5) — checked the parameter order and types match at each handoff. `launchHolder({report, workspaceCwd}) → {endpoint, browserServer}` (Task 1) matches what `runHolderCli` (Task 2) destructures and what the daemon's `spawnHolder`/`waitForEndpoint` (Task 4) expect to eventually observe via the state file, not via a direct return value (the daemon spawns a detached process — it can't receive a return value from it directly, only observe the state file it writes, which is exactly how Task 4's `waitForEndpoint` is written).
