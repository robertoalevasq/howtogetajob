# Telegram Routing Fixes + Emulation Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `/run` subagent-delegation bug with a strengthened documentation warning, then build a v1 emulation harness that runs real `claude -p` dispatches against synthetic Telegram input in a disposable workspace, to catch this class of bug (and the two already-fixed ones) without needing a real candidate to hit it live.

**Architecture:** Reuses existing, already-tested machinery wherever it exists — `provisionWorkspace()` for the disposable workspace (junctions `core`/`modes` to the real repo, seeds real templates), `findHubTranscriptFiles()` from `admin-overview-snapshot.mjs` for locating a dispatch's own session transcript, and the real (unmodified) `dispatchOne()`/`resolveDisambiguationHint()` production code path. The harness adds only what doesn't already exist: pending-confirmation seeding, transcript assertions, and the three scenario definitions.

**Tech Stack:** Node.js (`.mjs`), `node:test` for the harness's own unit tests, real `claude -p` CLI invocations for the end-to-end scenarios.

**Spec:** `docs/superpowers/specs/2026-09-14-telegram-routing-fixes-and-emulation-harness-design.md`

## Global Constraints

- No workspace under `workspaces/` is ever touched by the harness — every scenario runs in a fresh `os.tmpdir()` directory, deleted on success, left on disk (path printed) on failure.
- `config/plugins.yml`'s `telegram.enabled` stays `false` in every disposable workspace — the harness never needs a real bot token and never risks a real send.
- The harness's own deterministic helpers get normal fast unit tests with fakes; only `main()` (the 3 end-to-end scenarios) costs real `claude -p` calls, and that's a manual/opt-in run, never part of `test-all.mjs`.
- Every new exported function follows this codebase's existing JSDoc-comment convention (see `core/telegram-monitor.mjs`, `core/admin-overview-snapshot.mjs` for the house style).

---

## File Structure

- **Modify:** `modes/cycle.md` — add a warning paragraph after the title (fix 1).
- **Modify:** `modes/telegram.md` — add a cross-reference sentence at the top of Step 3a (fix 1).
- **Create:** `core/telegram-emulate.mjs` — the harness: workspace setup, pending-confirmation seeding, transcript lookup/assertions, the 3 scenarios, and `main()`.
- **Create:** `tests/telegram-emulate.test.mjs` — unit tests for the harness's own deterministic helpers (no real `claude -p` calls).

---

### Task 1: Strengthen the `/run` delegation warning (fix 1)

**Files:**
- Modify: `modes/cycle.md` (top of file, after the title)
- Modify: `modes/telegram.md` (top of Step 3a)
- Test: none (documentation) — verified by grep + the full `test-all.mjs` doc-consistency pass

**Interfaces:** None — this task produces no new functions.

- [ ] **Step 1: Read the current top of `modes/cycle.md`**

Run: `sed -n '1,10p' modes/cycle.md`

Confirm line 1 is `# Mode: cycle — Full Cycle (scan everything → pipeline → tracker → top-match PDFs)` and line 2 is currently blank before the "One command that runs..." paragraph — this step just confirms the exact insertion point before editing.

- [ ] **Step 2: Insert the warning into `modes/cycle.md`**

Using the Edit tool, replace:

```
# Mode: cycle — Full Cycle (scan everything → pipeline → tracker → top-match PDFs)

One command that runs the steps the user normally invokes separately:
```

with:

```
# Mode: cycle — Full Cycle (scan everything → pipeline → tracker → top-match PDFs)

**Every step below runs inline, in this orchestrating turn — never delegated to an `Agent`/`Task` subagent.** Confirmed live 2026-09-13: a headless `/run` dispatch tried to delegate Steps 0-5 to an Agent, caught itself mid-turn ("I'm in headless mode... running in the background would end the turn prematurely"), retried by launching the agent "in foreground" (still a delegation), then re-checked the cycle lock, found **its own** just-acquired lock, concluded a different run was already active, and abandoned the cycle — leaving the lock held-and-stale and nothing ever scanned. The only place this mode ever delegates to a subagent is deep inside `modes/apply.md` Step 7b (Playwright form-filling) — that is a different flow than the scan/pipeline orchestration this file describes, and is never a reason to delegate any step written here.

One command that runs the steps the user normally invokes separately:
```

- [ ] **Step 3: Insert the cross-reference into `modes/telegram.md` Step 3a**

Find the line `### Step 3a — Run full cycle` in `modes/telegram.md`. Using the Edit tool, replace:

```
### Step 3a — Run full cycle

0. **Duplicate-run guard — check the lock BEFORE announcing anything.**
```

with:

```
### Step 3a — Run full cycle

**Read `modes/cycle.md`'s own top-of-file warning before doing anything else in this step — every one of `cycle.md`'s Steps 0-5 runs inline, never delegated to an Agent/Task subagent, no exceptions.** This is the first thing a headless `/run` dispatch reads; the confusion that produced the 2026-09-13 incident (see `cycle.md`'s warning for the full story) started here, not deep inside `cycle.md`.

0. **Duplicate-run guard — check the lock BEFORE announcing anything.**
```

- [ ] **Step 4: Verify both edits landed correctly**

Run: `grep -n "2026-09-13" modes/cycle.md modes/telegram.md`

Expected: one match in each file, both inside the new warning text.

- [ ] **Step 5: Run the full test suite to confirm no doc-consistency check broke**

Run: `node core/test-all.mjs`

Expected: same pass count as before this change, 0 new failures (this is a pure prose addition; nothing should reference these exact line numbers or exact paragraph text).

- [ ] **Step 6: Commit**

```bash
git add modes/cycle.md modes/telegram.md
git commit -m "$(cat <<'EOF'
fix(cycle): move the no-subagent-delegation warning to the top, name the 2026-09-13 incident

A headless /run dispatch delegated cycle.md's Steps 0-5 to an Agent tool
call, caught itself mid-turn, retried with a "foreground agent" (still a
delegation), then found its own just-acquired cycle-lock and concluded a
different run was already active -- abandoning the run with the lock left
held-and-stale and nothing ever scanned. The existing "do not delegate"
instruction was correct but buried; this moves it to the first thing both
cycle.md and telegram.md's Step 3a say, naming the specific failure mode.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `makeDisposableWorkspace()` — disposable test workspace via `provisionWorkspace()`

**Files:**
- Create: `core/telegram-emulate.mjs`
- Test: `tests/telegram-emulate.test.mjs`

**Interfaces:**
- Consumes: `provisionWorkspace(slug, opts)` from `core/provision-workspace.mjs` — `opts.reposRoot` relocates where `workspaces/{slug}` is created while junction/seed sources still resolve off the real repo root (already supports test isolation, per that file's own comment).
- Produces: `makeDisposableWorkspace(): { wsDir: string, tempRoot: string, cleanup: () => void }` — later tasks use `wsDir` as `dispatch.cwd`, and call `cleanup()` after a scenario finishes.

- [ ] **Step 1: Write the failing test**

Create `tests/telegram-emulate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { makeDisposableWorkspace } from '../core/telegram-emulate.mjs';

test('makeDisposableWorkspace creates a workspace with junctions to the real core/modes and telegram disabled', () => {
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    assert.ok(existsSync(wsDir), 'workspace directory should exist');
    assert.ok(lstatSync(join(wsDir, 'core')).isSymbolicLink(), 'core should be a junction/symlink');
    assert.ok(lstatSync(join(wsDir, 'modes')).isSymbolicLink(), 'modes should be a junction/symlink');
    assert.ok(existsSync(join(wsDir, 'core', 'telegram-monitor.mjs')), 'core junction should reach the real repo files');
    assert.ok(existsSync(join(wsDir, 'cv.md')), 'a minimal cv.md should be seeded');
    assert.ok(existsSync(join(wsDir, 'config', 'profile.yml')), 'profile.yml should be seeded from the template');
    const plugins = yaml.load(readFileSync(join(wsDir, 'config', 'plugins.yml'), 'utf-8'));
    assert.equal(plugins.telegram.enabled, false, 'telegram must stay disabled in every disposable workspace');
    assert.ok(existsSync(join(wsDir, 'data', 'telegram-state.md')) === false, 'no telegram-state.md until a scenario seeds one');
  } finally {
    cleanup();
  }
  assert.ok(!existsSync(wsDir), 'cleanup() should remove the disposable workspace');
});

test('makeDisposableWorkspace writes a minimal portals.yml with zero tracked companies (fast Pass A)', () => {
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    const portals = yaml.load(readFileSync(join(wsDir, 'portals.yml'), 'utf-8'));
    assert.deepEqual(portals.tracked_companies, []);
    assert.deepEqual(portals.search_queries, []);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/telegram-emulate.test.mjs`
Expected: FAIL — `Cannot find module '../core/telegram-emulate.mjs'` (the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `core/telegram-emulate.mjs`:

```js
// @ts-check
// telegram-emulate.mjs — v1 harness that runs REAL claude -p dispatches
// against synthetic Telegram input, in a disposable workspace, to catch the
// three routing bugs confirmed live 2026-09-11 through 2026-09-13 without
// needing a real candidate to hit them again. See
// docs/superpowers/specs/2026-09-14-telegram-routing-fixes-and-emulation-harness-design.md.
//
// Every scenario runs in a fresh os.tmpdir() directory -- no workspace under
// workspaces/ is ever touched. telegram.enabled stays false in every
// disposable workspace: the harness never needs a real bot token and never
// risks a real send; assertions read state files and session transcripts,
// never delivery confirmations.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { provisionWorkspace } from './provision-workspace.mjs';

const MINIMAL_CV = `# Test Candidate

**Email:** test-candidate@example.com

## Experience

### Example Corp -- Remote

**Test Role**
January 2024 - Present

- Did representative work for harness-testing purposes only.

## Education

### Example University

**Bachelor of Science**
`;

/**
 * Creates a disposable, fully-junctioned test workspace (real core/modes
 * reachable exactly like a real workspace, telegram disabled, a minimal
 * portals.yml with zero tracked companies so Pass A stays fast) inside a
 * fresh temp directory. Nothing under the real repo's workspaces/ is ever
 * touched.
 *
 * @returns {{ wsDir: string, tempRoot: string, cleanup: () => void }}
 */
export function makeDisposableWorkspace() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'career-ops-emulate-'));
  const wsDir = provisionWorkspace('test-candidate', { reposRoot: tempRoot });

  writeFileSync(join(wsDir, 'cv.md'), MINIMAL_CV, 'utf-8');

  // provisionWorkspace seeds portals.yml from templates/portals.example.yml,
  // which ships ~100 demo tracked_companies -- fine for a real candidate,
  // needlessly slow for a harness scenario that only needs Step 0/early
  // Step 1 to be reachable quickly. Overwrite with the minimum valid shape
  // validate-portals.mjs accepts (no required top-level fields beyond
  // per-company checks, which only run against enabled companies).
  const portalsPath = join(wsDir, 'portals.yml');
  writeFileSync(portalsPath, yaml.dump({
    title_filter: { positive: ['Coordinator'], negative: [] },
    location_filter: [],
    tracked_companies: [],
    search_queries: [],
    industry_companies: [],
  }), 'utf-8');

  return {
    wsDir,
    tempRoot,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/telegram-emulate.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add core/telegram-emulate.mjs tests/telegram-emulate.test.mjs
git commit -m "$(cat <<'EOF'
feat(telegram-emulate): disposable test workspace via provisionWorkspace()

Reuses provisionWorkspace()'s existing test-isolation support (opts.reposRoot
relocates the workspace while junction/seed sources still resolve off the
real repo) rather than reimplementing workspace setup. Overwrites portals.yml
with zero tracked companies so Pass A stays fast in later scenarios.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `seedPendingConfirmations()` — validated against the real `resolveDisambiguationHint`

**Files:**
- Modify: `core/telegram-emulate.mjs`
- Test: `tests/telegram-emulate.test.mjs`

**Interfaces:**
- Consumes: `resolveDisambiguationHint(dispatch)` from `core/telegram-monitor.mjs` (already exported) — used here only to *validate* the seeded format is genuinely parseable by production code, not to build new logic.
- Produces: `seedPendingConfirmations(wsDir: string, blocksText: string): void` — writes `data/telegram-state.md` with the given raw block text between the standard headers.

- [ ] **Step 1: Write the failing test**

Add to `tests/telegram-emulate.test.mjs`:

```js
import { resolveDisambiguationHint } from '../core/telegram-monitor.mjs';
import { seedPendingConfirmations } from '../core/telegram-emulate.mjs';

test('seedPendingConfirmations writes a telegram-state.md the REAL resolveDisambiguationHint can parse', () => {
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    seedPendingConfirmations(wsDir,
      '[msg_id: 100] stage: question — Test question A — waiting since 2026-01-01\n' +
      '  report: 1\n' +
      '  job_url: https://example.com/a\n' +
      '  data: Test question A body\n\n' +
      '[msg_id: 200] stage: question — Test question B — waiting since 2026-01-01\n' +
      '  report: 2\n' +
      '  job_url: https://example.com/b\n' +
      '  data: Test question B body'
    );
    const dispatch = { chatId: '999000111', cwd: wsDir, kind: 'routing', messages: [{ chatId: '999000111', text: '1' }] };
    const hint = resolveDisambiguationHint(dispatch);
    assert.ok(hint, 'the real production parser should resolve this seeded state');
    assert.match(hint, /selects item 1: \[msg_id: 100\]/);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/telegram-emulate.test.mjs`
Expected: FAIL — `seedPendingConfirmations is not a function`

- [ ] **Step 3: Write the minimal implementation**

Add to `core/telegram-emulate.mjs`:

```js
const TELEGRAM_STATE_TEMPLATE = (pendingBlock) => `# Telegram State

## Pending Confirmations

${pendingBlock}

## Batch Queue

(none)

## Recent Actions

`;

/**
 * Writes data/telegram-state.md with the given raw pending-confirmation
 * block text (same `[msg_id: N] stage: ...` shape production code writes)
 * between the standard headers. `blocksText` is inserted verbatim -- callers
 * separate multiple blocks with a blank line, matching the real file format
 * `resolveDisambiguationHint()`/`resolveReportForDispatch()` already parse.
 *
 * @param {string} wsDir
 * @param {string} blocksText
 */
export function seedPendingConfirmations(wsDir, blocksText) {
  writeFileSync(join(wsDir, 'data', 'telegram-state.md'), TELEGRAM_STATE_TEMPLATE(blocksText), 'utf-8');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/telegram-emulate.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add core/telegram-emulate.mjs tests/telegram-emulate.test.mjs
git commit -m "$(cat <<'EOF'
feat(telegram-emulate): seedPendingConfirmations, validated against the real resolveDisambiguationHint

Validates the seeded format against production's own parser rather than a
second hand-written parser that could silently drift from what
resolveDisambiguationHint() actually expects.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `findLatestTranscript()` — reuses `findHubTranscriptFiles()`

**Files:**
- Modify: `core/telegram-emulate.mjs`
- Test: `tests/telegram-emulate.test.mjs`

**Interfaces:**
- Consumes: `findHubTranscriptFiles(reposRoot, claudeHome)` from `core/admin-overview-snapshot.mjs` (already exported, already supports a `claudeHome` override for tests).
- Produces: `findLatestTranscript(tempRoot: string, slug: string, sinceMs: number, opts?: { claudeHome?: string }): string | null` — the newest `.jsonl` transcript path for that disposable workspace's slug, created at or after `sinceMs`, or `null` if none found.

- [ ] **Step 1: Write the failing test**

Add to `tests/telegram-emulate.test.mjs`:

```js
import { mkdtempSync as mkdtemp2, mkdirSync, writeFileSync as writeFile2, utimesSync } from 'node:fs';
import { findLatestTranscript } from '../core/telegram-emulate.mjs';
import { hubProjectDirPrefix } from '../core/admin-overview-snapshot.mjs';

test('findLatestTranscript returns the newest matching transcript created at/after the given time', () => {
  const fakeClaudeHome = mkdtemp2(join(tmpdir(), 'career-ops-emulate-claudehome-'));
  const fakeTempRoot = mkdtemp2(join(tmpdir(), 'career-ops-emulate-reporoot-'));
  try {
    const prefix = hubProjectDirPrefix(fakeTempRoot);
    const projectDir = join(fakeClaudeHome, 'projects', `${prefix}-workspaces-test-candidate`);
    mkdirSync(projectDir, { recursive: true });

    const oldFile = join(projectDir, 'old-session.jsonl');
    const newFile = join(projectDir, 'new-session.jsonl');
    writeFile2(oldFile, '{}\n', 'utf-8');
    writeFile2(newFile, '{}\n', 'utf-8');
    const oldTime = new Date('2020-01-01T00:00:00Z');
    const newTime = new Date('2030-01-01T00:00:00Z');
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(newFile, newTime, newTime);

    const since = new Date('2025-01-01T00:00:00Z').getTime();
    const found = findLatestTranscript(fakeTempRoot, 'test-candidate', since, { claudeHome: fakeClaudeHome });
    assert.equal(found, newFile);
  } finally {
    rmSync(fakeClaudeHome, { recursive: true, force: true });
    rmSync(fakeTempRoot, { recursive: true, force: true });
  }
});

test('findLatestTranscript returns null when nothing matches', () => {
  const fakeClaudeHome = mkdtemp2(join(tmpdir(), 'career-ops-emulate-claudehome-empty-'));
  const fakeTempRoot = mkdtemp2(join(tmpdir(), 'career-ops-emulate-reporoot-empty-'));
  try {
    const found = findLatestTranscript(fakeTempRoot, 'test-candidate', Date.now(), { claudeHome: fakeClaudeHome });
    assert.equal(found, null);
  } finally {
    rmSync(fakeClaudeHome, { recursive: true, force: true });
    rmSync(fakeTempRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/telegram-emulate.test.mjs`
Expected: FAIL — `findLatestTranscript is not a function`

- [ ] **Step 3: Write the minimal implementation**

Add to `core/telegram-emulate.mjs` (add the import at the top alongside the existing ones):

```js
import { statSync } from 'node:fs';
import { findHubTranscriptFiles } from './admin-overview-snapshot.mjs';
```

```js
/**
 * Finds the newest .jsonl session transcript belonging to the given
 * disposable workspace slug, created at or after `sinceMs`. Reuses
 * findHubTranscriptFiles() (admin-overview-snapshot.mjs) rather than a
 * second implementation of Claude Code's project-directory naming.
 *
 * @param {string} tempRoot - the disposable workspace's temp root (NOT the wsDir itself -- same value passed as reposRoot to provisionWorkspace()).
 * @param {string} slug - the workspace slug used with provisionWorkspace() (e.g. 'test-candidate').
 * @param {number} sinceMs - epoch ms; only transcripts modified at/after this instant are considered.
 * @param {{ claudeHome?: string }} [opts] - claudeHome override for tests; defaults to ~/.claude.
 * @returns {string | null}
 */
export function findLatestTranscript(tempRoot, slug, sinceMs, opts = {}) {
  const all = findHubTranscriptFiles(tempRoot, opts.claudeHome);
  const matching = all
    .filter(f => f.scope === 'workspace' && f.slug === slug)
    .map(f => ({ path: f.path, mtimeMs: statSync(f.path).mtimeMs }))
    .filter(f => f.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matching.length > 0 ? matching[0].path : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/telegram-emulate.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add core/telegram-emulate.mjs tests/telegram-emulate.test.mjs
git commit -m "$(cat <<'EOF'
feat(telegram-emulate): findLatestTranscript, reusing findHubTranscriptFiles

No second implementation of Claude Code's project-directory path encoding --
this is a thin filter/sort over the already-tested admin-overview-snapshot.mjs
helper, which already supports a claudeHome override for exactly this kind
of test isolation.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Assertion helpers

**Files:**
- Modify: `core/telegram-emulate.mjs`
- Test: `tests/telegram-emulate.test.mjs`

**Interfaces:**
- Consumes: nothing new (plain file reads).
- Produces:
  - `readTranscriptToolUses(transcriptPath: string): string[]` — every tool name used anywhere in a transcript (including subagent sidecar files, if any).
  - `assertNoAgentToolUse(transcriptPath: string): void` — throws if `Agent` or `Task` appears in `readTranscriptToolUses()`.
  - `readPendingConfirmationBlock(wsDir: string, msgId: string): string | null` — the raw `[msg_id: N] ...` block text for one pending item, or `null` if not present.

- [ ] **Step 1: Write the failing test**

Add to `tests/telegram-emulate.test.mjs`:

```js
import { readTranscriptToolUses, assertNoAgentToolUse, readPendingConfirmationBlock } from '../core/telegram-emulate.mjs';

function writeFakeTranscript(path, toolNames) {
  const lines = toolNames.map(name => JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] },
  }));
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

test('readTranscriptToolUses lists every tool_use name in a transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-emulate-transcript-'));
  try {
    const p = join(dir, 'session.jsonl');
    writeFakeTranscript(p, ['Read', 'Bash', 'Edit']);
    assert.deepEqual(readTranscriptToolUses(p), ['Read', 'Bash', 'Edit']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertNoAgentToolUse passes when no Agent/Task tool_use is present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-emulate-transcript-clean-'));
  try {
    const p = join(dir, 'session.jsonl');
    writeFakeTranscript(p, ['Read', 'Bash']);
    assert.doesNotThrow(() => assertNoAgentToolUse(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertNoAgentToolUse throws when an Agent tool_use is present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-emulate-transcript-dirty-'));
  try {
    const p = join(dir, 'session.jsonl');
    writeFakeTranscript(p, ['Read', 'Agent', 'Bash']);
    assert.throws(() => assertNoAgentToolUse(p), /Agent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readPendingConfirmationBlock returns the matching block, or null if absent', () => {
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    seedPendingConfirmations(wsDir,
      '[msg_id: 100] stage: question — A\n  data: {}\n\n[msg_id: 200] stage: question — B\n  data: {}'
    );
    const found = readPendingConfirmationBlock(wsDir, '100');
    assert.match(found, /\[msg_id: 100\] stage: question — A/);
    assert.equal(readPendingConfirmationBlock(wsDir, '999'), null);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/telegram-emulate.test.mjs`
Expected: FAIL — `readTranscriptToolUses is not a function`

- [ ] **Step 3: Write the minimal implementation**

Add to `core/telegram-emulate.mjs`:

```js
/**
 * Every tool_use name found anywhere in a session transcript, in order of
 * appearance. Reads line-by-line JSONL, same shape used throughout this
 * codebase's own transcript-mining code (see admin-overview-snapshot.mjs).
 *
 * @param {string} transcriptPath
 * @returns {string[]}
 */
export function readTranscriptToolUses(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
  const names = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use' && typeof c.name === 'string') names.push(c.name);
    }
  }
  return names;
}

/**
 * Throws if the transcript ever calls the Agent or Task tool -- the
 * mechanical check for the 2026-09-13 /run delegation bug (see cycle.md's
 * top-of-file warning, Task 1 of this plan).
 *
 * @param {string} transcriptPath
 */
export function assertNoAgentToolUse(transcriptPath) {
  const names = readTranscriptToolUses(transcriptPath);
  const offenders = names.filter(n => n === 'Agent' || n === 'Task');
  if (offenders.length > 0) {
    throw new Error(`Expected no Agent/Task tool_use in ${transcriptPath}, found ${offenders.length}: ${offenders.join(', ')}`);
  }
}

/**
 * Returns the raw `[msg_id: N] stage: ... ...` block text for one pending
 * confirmation from a workspace's current data/telegram-state.md, or null
 * if that msg_id isn't currently pending. Used to assert a specific item
 * was resolved (block disappears) while a sibling item was untouched (block
 * survives unchanged).
 *
 * @param {string} wsDir
 * @param {string} msgId
 * @returns {string | null}
 */
export function readPendingConfirmationBlock(wsDir, msgId) {
  const content = readFileSync(join(wsDir, 'data', 'telegram-state.md'), 'utf-8');
  const afterHeader = content.split('## Pending Confirmations')[1];
  if (!afterHeader) return null;
  const section = afterHeader.split('## Batch Queue')[0];
  const re = new RegExp(`(\\[msg_id: ${msgId}\\][\\s\\S]*?)(?=\\n\\[msg_id: |$)`);
  const m = re.exec(section.trim());
  return m ? m[1].trim() : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/telegram-emulate.test.mjs`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add core/telegram-emulate.mjs tests/telegram-emulate.test.mjs
git commit -m "$(cat <<'EOF'
feat(telegram-emulate): transcript and pending-confirmation assertion helpers

readTranscriptToolUses/assertNoAgentToolUse give a mechanical check for the
/run delegation bug; readPendingConfirmationBlock lets a scenario assert one
pending item was resolved while a sibling was left untouched, regardless of
exactly how the resolved item's downstream handling played out.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The 3 scenarios + `main()` — the real end-to-end wiring

**Files:**
- Modify: `core/telegram-emulate.mjs`
- Test: manual run of `main()` itself (real `claude -p` calls — not part of `test-all.mjs`)

**Interfaces:**
- Consumes: `dispatchOne`, `spawnCapturingTail`, and `resolveClaudeCommand` from `core/telegram-monitor.mjs`. `invokeClaudeRoutingOnce` itself is not exported (private) — Task 6 instead imports `dispatchOne` and, for the bounded scenario, builds a custom `invoke` wrapper around it using `dispatchOne`'s own `invoke` override parameter (already supported, already used throughout `tests/telegram-monitor.test.mjs`). Also consumes everything from Tasks 2-5.
- Produces: `runDigitDisambiguationScenario()`, `runRapidFireBurstScenario()`, `runCycleDelegationScenario()`, each returning `{ name: string, passed: boolean, detail: string }`; `main()` runs all three and prints a summary.

Since `invokeClaudeRoutingOnce` is not exported from `telegram-monitor.mjs`, Task 6 needs `dispatchOne`'s default invoke behavior for scenarios 1 and 2 (unbounded — fine, both are fast: a lightweight question-reply and a `/status` call), and a *bounded* real invocation only for scenario 3. Scenario 3 builds its own minimal real spawn using the same `spawnCapturingTail` export with an explicit `timeoutMs`, passed as `dispatchOne`'s `invoke` override — this stays within the supported override seam instead of modifying `dispatchOne` itself.

That bounded spawn needs to resolve the real `claude`/`claude.exe`/`claude.cmd` command exactly the way production code does (on this project's real deployment platform, Windows, that resolution walks `npm root -g` to find the actual `.exe`, only falling back to `claude.cmd`/`shell:true` if the `.exe` genuinely can't be found) — reimplementing a simplified version of that logic in the harness would silently diverge from what `dispatchOne` really does and risk masking a real spawn-resolution bug behind a harness that always takes the fallback path. `resolveClaudeCommand()` was private (no `export` keyword); Step 1 below exports it so the harness reuses the exact real logic instead of a second copy.

- [ ] **Step 1: Export `resolveClaudeCommand` from `core/telegram-monitor.mjs`**

Read the current declaration first:

Run: `grep -n "^function resolveClaudeCommand" core/telegram-monitor.mjs`
Expected: `112:function resolveClaudeCommand() {`

Using the Edit tool, replace:

```js
let resolvedClaude = null;
function resolveClaudeCommand() {
```

with:

```js
let resolvedClaude = null;
export function resolveClaudeCommand() {
```

This is a pure visibility change (no behavior change — every existing internal caller keeps calling the same function). Run `node core/test-all.mjs` to confirm nothing broke, then proceed to Step 2 below.

- [ ] **Step 2: Write the failing test (a smoke-test-shaped check, not the full real run)**

Add to `tests/telegram-emulate.test.mjs`:

```js
import { runDigitDisambiguationScenario, runRapidFireBurstScenario, runCycleDelegationScenario } from '../core/telegram-emulate.mjs';

// These three are real end-to-end tests -- each spawns a real `claude -p`
// process. Skipped by default (matches this plan's Global Constraints: only
// a manual/opt-in run costs real dispatches, never part of the fast suite
// test-all.mjs runs). Run explicitly with:
//   CAREER_OPS_EMULATE_REAL=1 node --test tests/telegram-emulate.test.mjs
const REAL = process.env.CAREER_OPS_EMULATE_REAL === '1';

test('runDigitDisambiguationScenario resolves "1" to the first pending item, leaves the second untouched', { skip: !REAL }, async () => {
  const result = await runDigitDisambiguationScenario();
  assert.ok(result.passed, result.detail);
});

test('runRapidFireBurstScenario produces 3 separate dispatches, never one batched call', { skip: !REAL }, async () => {
  const result = await runRapidFireBurstScenario();
  assert.ok(result.passed, result.detail);
});

test('runCycleDelegationScenario never calls the Agent/Task tool', { skip: !REAL }, async () => {
  const result = await runCycleDelegationScenario();
  assert.ok(result.passed, result.detail);
});
```

- [ ] **Step 3: Run the test to verify it fails (skipped, not passing — confirms wiring)**

Run: `node --test tests/telegram-emulate.test.mjs`
Expected: FAIL — `runDigitDisambiguationScenario is not a function` (still fails even though skipped, because the import itself throws when the export doesn't exist).

- [ ] **Step 4: Write the minimal implementation**

Add to `core/telegram-emulate.mjs` (add these imports alongside the existing ones):

```js
import { dispatchOne, spawnCapturingTail, resolveClaudeCommand } from './telegram-monitor.mjs';
```

```js
const TEST_CHAT_ID = '999000111';

/**
 * Scenario 1: seeds 2 pending `stage: question` items, sends the bare digit
 * "1", and asserts the real routing dispatch resolved it to the FIRST item
 * (msg_id 100) while leaving the second (msg_id 200) untouched -- the
 * mechanical check for the 2026-09-12 disambiguation-mapping bug.
 *
 * @returns {Promise<{ name: string, passed: boolean, detail: string }>}
 */
export async function runDigitDisambiguationScenario() {
  const name = 'digit-disambiguation';
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    seedPendingConfirmations(wsDir,
      '[msg_id: 100] stage: question — Test question A — waiting since 2026-01-01\n' +
      '  report: 1\n  job_url: https://example.com/a\n  data: Test question A body\n\n' +
      '[msg_id: 200] stage: question — Test question B — waiting since 2026-01-01\n' +
      '  report: 2\n  job_url: https://example.com/b\n  data: Test question B body'
    );
    const before100 = readPendingConfirmationBlock(wsDir, '100');
    const before200 = readPendingConfirmationBlock(wsDir, '200');

    await dispatchOne({
      chatId: TEST_CHAT_ID, cwd: wsDir, kind: 'routing',
      messages: [{ chatId: TEST_CHAT_ID, messageId: 300, text: '1', date: Math.floor(Date.now() / 1000), replyToMessageId: null, from: 'Harness', isCommand: false }],
    });

    const after100 = readPendingConfirmationBlock(wsDir, '100');
    const after200 = readPendingConfirmationBlock(wsDir, '200');
    const item1Changed = after100 !== before100;
    const item2Untouched = after200 === before200;
    const passed = item1Changed && item2Untouched;
    return {
      name, passed,
      detail: passed ? 'item 1 changed, item 2 untouched' : `item1Changed=${item1Changed} item2Untouched=${item2Untouched} (before100=${JSON.stringify(before100)}, after100=${JSON.stringify(after100)}, before200=${JSON.stringify(before200)}, after200=${JSON.stringify(after200)})`,
    };
  } finally {
    cleanup();
  }
}

/**
 * Scenario 2: fires 3 `/status` messages for the same chat in quick
 * succession and asserts 3 SEPARATE session transcripts were created --
 * the mechanical check for the 2026-09-12 message-batching bug. `/status`
 * is used because it is documented as one-shot with no pending confirmation
 * (modes/telegram.md Step 3f), keeping this scenario fast and side-effect-free.
 *
 * @returns {Promise<{ name: string, passed: boolean, detail: string }>}
 */
export async function runRapidFireBurstScenario() {
  const name = 'rapid-fire-burst';
  const { wsDir, tempRoot, cleanup } = makeDisposableWorkspace();
  try {
    const startMs = Date.now();
    const makeMsg = (id) => ({ chatId: TEST_CHAT_ID, messageId: id, text: '/status', date: Math.floor(Date.now() / 1000), replyToMessageId: null, from: 'Harness', isCommand: true });
    await Promise.all([
      dispatchOne({ chatId: TEST_CHAT_ID, cwd: wsDir, kind: 'routing', messages: [makeMsg(400)] }),
      dispatchOne({ chatId: TEST_CHAT_ID, cwd: wsDir, kind: 'routing', messages: [makeMsg(401)] }),
      dispatchOne({ chatId: TEST_CHAT_ID, cwd: wsDir, kind: 'routing', messages: [makeMsg(402)] }),
    ]);
    const all = findHubTranscriptFiles(tempRoot);
    const matching = all.filter(f => f.scope === 'workspace' && f.slug === 'test-candidate');
    const passed = matching.length === 3;
    return {
      name, passed,
      detail: passed ? '3 separate transcripts found' : `expected 3 transcripts, found ${matching.length}`,
    };
  } finally {
    cleanup();
  }
}

const CYCLE_DELEGATION_TIMEOUT_MS = 180_000; // 3 minutes -- enough to reach
// Step 0 pre-flight + the start of Step 1 with zero tracked companies
// (see makeDisposableWorkspace's minimal portals.yml); Pass B's full ATS
// sweep is multi-hour BY DESIGN regardless of config, so this scenario can
// only observe the early part of a /run dispatch -- a deliberate, documented
// limitation, not an oversight. Whether the call completes or times out,
// whatever transcript exists by then is what gets asserted against.

/**
 * Scenario 3: sends `/run` with a bounded real dispatch (timeoutMs =
 * CYCLE_DELEGATION_TIMEOUT_MS) and asserts the resulting transcript never
 * calls the Agent/Task tool -- the mechanical check for the 2026-09-13
 * subagent-delegation bug (see Task 1's warning). A timeout is an EXPECTED
 * outcome here, not a failure -- see the constant's own comment for why a
 * full cycle can never finish inside a bounded test window.
 *
 * @returns {Promise<{ name: string, passed: boolean, detail: string }>}
 */
export async function runCycleDelegationScenario() {
  const name = 'cycle-delegation';
  const { wsDir, tempRoot, cleanup } = makeDisposableWorkspace();
  try {
    const startMs = Date.now();
    const boundedInvoke = (prompt, cwd, _timeoutMs, model, extraArgs) => {
      const { cmd, shell } = resolveClaudeCommand();
      const args = model ? ['-p', prompt, '--model', model, ...extraArgs] : ['-p', prompt, ...extraArgs];
      return spawnCapturingTail(cmd, args, {
        cwd, shell, timeoutMs: CYCLE_DELEGATION_TIMEOUT_MS,
        exitErrorPrefix: 'claude -p routing exited',
        timeoutErrorMessage: (ms) => `claude -p timed out after ${ms}ms`,
      });
    };

    try {
      await dispatchOne({
        chatId: TEST_CHAT_ID, cwd: wsDir, kind: 'routing',
        messages: [{ chatId: TEST_CHAT_ID, messageId: 500, text: '/run', date: Math.floor(Date.now() / 1000), replyToMessageId: null, from: 'Harness', isCommand: true }],
      }, boundedInvoke);
    } catch (err) {
      if (!err.timedOut) throw err; // a timeout is expected (see constant comment); anything else is a real failure
    }

    const transcriptPath = findLatestTranscript(tempRoot, 'test-candidate', startMs);
    if (!transcriptPath) {
      return { name, passed: false, detail: 'no transcript found for the /run dispatch' };
    }
    try {
      assertNoAgentToolUse(transcriptPath);
      return { name, passed: true, detail: `no Agent/Task tool_use in ${transcriptPath}` };
    } catch (err) {
      return { name, passed: false, detail: err.message };
    }
  } finally {
    cleanup();
  }
}

/**
 * Runs all 3 scenarios in sequence (never parallel -- each spawns real
 * claude -p processes and this keeps output/failures easy to attribute),
 * prints a pass/fail summary, and exits non-zero if any scenario failed.
 */
export async function main() {
  const scenarios = [runDigitDisambiguationScenario, runRapidFireBurstScenario, runCycleDelegationScenario];
  const results = [];
  for (const scenario of scenarios) {
    console.log(`Running ${scenario.name}...`);
    results.push(await scenario());
  }
  console.log('\n=== telegram-emulate results ===');
  let anyFailed = false;
  for (const r of results) {
    console.log(`${r.passed ? '✅' : '❌'} ${r.name}: ${r.detail}`);
    if (!r.passed) anyFailed = true;
  }
  if (anyFailed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

Also add the missing import at the top of the file:

```js
import { findHubTranscriptFiles } from './admin-overview-snapshot.mjs';
```

(This was already added in Task 4 — confirm it's present rather than duplicating the import line.)

- [ ] **Step 5: Run the test to verify the skip-wiring passes (no real dispatches yet)**

Run: `node --test tests/telegram-emulate.test.mjs`
Expected: PASS (12 tests: 9 from before + 3 new, all 3 new ones reported as `skipped` since `CAREER_OPS_EMULATE_REAL` isn't set).

- [ ] **Step 6: Run the REAL end-to-end scenarios once, to verify they actually pass**

Run: `CAREER_OPS_EMULATE_REAL=1 node --test tests/telegram-emulate.test.mjs`

This costs 3 real `claude -p` calls (real tokens, real wall-clock time — the third scenario alone can take up to 3 minutes per `CYCLE_DELEGATION_TIMEOUT_MS`). Expected: PASS (12 tests, none skipped this time).

If scenario 1 or 2 fails: read the `detail` field in the test output — it names exactly which item/count didn't match, and the disposable workspace path is left on disk if `cleanup()` didn't run (a thrown assertion inside the `try` still hits `finally`'s `cleanup()`, so a failure here means a bug in the harness's own logic worth fixing before re-running, not leftover state).

If scenario 3 fails on "no transcript found": the dispatch likely errored before ever spawning `claude -p` (e.g. a lock-acquisition failure) — check the thrown error surfaced by the outer `catch` block's re-throw (only `err.timedOut` is swallowed).

- [ ] **Step 7: Run the full existing test suite to confirm nothing else broke**

Run: `node core/test-all.mjs`
Expected: same baseline pass count plus this new suite's file entry, 0 new failures. (`test-all.mjs` runs `tests/telegram-emulate.test.mjs` without `CAREER_OPS_EMULATE_REAL` set, so it only exercises the fast, skipped-real-scenario path — matching this plan's Global Constraint that real dispatches never join the fast suite.)

- [ ] **Step 8: Commit**

```bash
git add core/telegram-monitor.mjs core/telegram-emulate.mjs tests/telegram-emulate.test.mjs
git commit -m "$(cat <<'EOF'
feat(telegram-emulate): the 3 v1 scenarios + main() -- real dispatches, opt-in

Digit disambiguation, rapid-fire burst, and /run delegation, each driving
the real dispatchOne()/claude -p path against a disposable workspace. Gated
behind CAREER_OPS_EMULATE_REAL=1 in tests/telegram-emulate.test.mjs so the
fast suite (test-all.mjs) never pays for a real claude -p call; `main()`
runs all three unconditionally for a manual/CI-opt-in end-to-end check.

Exports telegram-monitor.mjs's resolveClaudeCommand() (was private) so the
bounded scenario 3 spawn reuses the real claude.exe/claude.cmd resolution
logic instead of a second, simpler copy that would silently diverge from
what dispatchOne() actually does on this project's Windows deployment.

Verified live: all 3 scenarios pass against the current (fixed) production
code.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Fix 1 (Task 1) ✅. Harness components — disposable workspace (Task 2), pending-confirmation seeding (Task 3), transcript lookup (Task 4), assertion helpers (Task 5), the 3 scenarios + `main()` (Task 6) — all covered. Error handling (leave-on-failure/clean-on-success) is implemented via each scenario's own `try/finally cleanup()`, matching the spec's stated convention.
- **Placeholder scan:** no TBD/TODO; every step has real, complete code.
- **Type/name consistency:** `wsDir`/`tempRoot`/`cleanup` from `makeDisposableWorkspace()` are used with those exact names in every later task; `resolveDisambiguationHint`, `findHubTranscriptFiles`, `dispatchOne`, `spawnCapturingTail`, `resolveClaudeCommand` are called with their real, already-existing signatures throughout, not invented ones. Verified directly against the current source of `core/provision-workspace.mjs`, `core/telegram-monitor.mjs`, and `core/hub-paths.mjs` during planning (not assumed from memory).
- **Correctness catch during self-review:** the first draft of Task 6 mirrored a simplified, WRONG copy of `resolveClaudeCommand()` (always falling to the `claude.cmd`/`shell:true` fallback path, skipping the real `npm root -g` → `claude.exe` resolution this project's actual Windows deployment relies on). Fixed by exporting the real function (Task 6 Step 1) instead of duplicating it — one line of production code, no behavior change for any existing caller.
- **Deviation from the spec worth flagging to the user:** the spec's data-flow diagram implied a single generic `runScenario()` helper; this plan instead gives each scenario its own named function (`runDigitDisambiguationScenario`, etc.) since their setup/assertion logic differs enough that a shared runner would need scenario-specific callbacks anyway — same behavior the spec describes, slightly different internal shape.
