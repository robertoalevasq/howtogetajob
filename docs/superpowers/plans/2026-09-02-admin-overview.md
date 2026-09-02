# Admin Overview Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a data-gathering + HTML-rendering pipeline for a private, standing Artifact that shows the hub owner every workspace's roster/tracker stats, in-progress task status, and token-usage/run-count history — all sourced from files and Claude Code's own local session transcripts that already exist, with zero new mode-file instrumentation.

**Architecture:** Two pure-Node, zero-LLM scripts. `core/admin-overview-snapshot.mjs` gathers everything (workspace roster via `workspace.json`, tracker stats via `core/stats.mjs`, active-task status via `core/cycle-status.mjs --json`, and token-usage/run-count history mined from `~/.claude/projects/*.jsonl`) into one JSON file. `core/admin-overview-render.mjs` turns that JSON into a complete, ready-to-publish HTML file. A scheduled headless Claude Code invocation runs both scripts in sequence, then calls the `Artifact` tool to republish — that headless turn does almost nothing else, so it costs very little per firing.

**Tech Stack:** Node.js ESM (`.mjs`), no new dependencies. Node's native `node:test`/`node:assert` runner, matching the convention already used in `tests/provision-workspace.test.mjs` and the other recent `*-workspace-isolation.test.mjs` files.

**Spec:** [docs/superpowers/specs/2026-09-02-admin-overview-design.md](../specs/2026-09-02-admin-overview-design.md)

## Global Constraints

- **Privacy-critical, non-negotiable:** the transcript-parsing functions extract ONLY `timestamp`, `usage`, and (for `Skill` tool-call lines) `input.skill`/`input.args` from each JSONL line. Never read, store, log, or render any other field — no message content, no tool results, no file contents. This is tested explicitly (Task 4 and Task 8).
- Never silently drop or misclassify data: an unrecognized `Skill` invocation goes into an explicit `unclassified` run-count bucket; a workspace slug found in transcript history but no longer present in `workspaces/` goes into an explicit `deleted-or-renamed` bucket. Neither is ever dropped or folded into the wrong bucket.
- A broken/missing per-workspace file (corrupt `workspace.json`, no `cycle-status.json` yet, `stats.mjs` failing) must never crash the whole snapshot — skip that one entry gracefully and continue.
- No new dependencies. No `db`/`room`/other Artifact capability — this is a plain static page, redeployed on a schedule (see spec's Architecture section for why).
- Reuse existing scripts as subprocesses (`core/stats.mjs`, `core/cycle-status.mjs --json`) rather than reimplementing their logic.
- Project-directory-name matching against this hub's own path must be case-insensitive for the prefix (Claude Code has been observed emitting both upper- and lower-case drive letters for the same hub across sessions).

---

### Task 1: Workspace roster + tracker stats

**Files:**
- Create: `core/admin-overview-snapshot.mjs`
- Test: `tests/admin-overview-roster.test.mjs`

**Interfaces:**
- Produces: `export function listWorkspaces(reposRoot?: string): {slug: string, displayName: string, chatId: string|null, createdAt: string|null, dir: string}[]`
- Produces: `export function getTrackerStats(wsDir: string): object|null` — the parsed JSON from `core/stats.mjs`, or `null` on any failure

- [ ] **Step 1: Write the failing tests**

```js
// tests/admin-overview-roster.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorkspaces, getTrackerStats } from '../core/admin-overview-snapshot.mjs';

test('listWorkspaces enumerates provisioned workspaces and skips ones with no workspace.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    const wsDir = join(root, 'workspaces', 'alice');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({
      slug: 'alice', chat_id: '123', display_name: 'Alice', created_at: '2026-01-01',
    }));
    mkdirSync(join(root, 'workspaces', 'incomplete'), { recursive: true });

    const result = listWorkspaces(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].slug, 'alice');
    assert.equal(result[0].displayName, 'Alice');
    assert.equal(result[0].chatId, '123');
    assert.equal(result[0].createdAt, '2026-01-01');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspaces returns an empty array (not a crash) when workspaces/ does not exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    assert.deepEqual(listWorkspaces(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspaces skips a workspace with corrupt workspace.json instead of throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    const wsDir = join(root, 'workspaces', 'broken');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), '{not valid json');
    assert.deepEqual(listWorkspaces(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspaces falls back to the directory name when workspace.json has no slug field', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    const wsDir = join(root, 'workspaces', 'noname');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ created_at: '2026-01-01' }));
    const result = listWorkspaces(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].slug, 'noname');
    assert.equal(result[0].chatId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getTrackerStats returns parsed JSON from a real workspace-shaped directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    const wsDir = join(root, 'ws');
    mkdirSync(join(wsDir, 'data'), { recursive: true });
    writeFileSync(join(wsDir, 'data', 'applications.md'), [
      '# Applications Tracker', '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-08-01 | Acme | Engineer | 4.0/5 | Applied | ✅ | [1](reports/001-acme-2026-08-01.md) | |',
    ].join('\n'));
    const stats = getTrackerStats(wsDir);
    assert.ok(stats);
    assert.equal(stats.tracker.total, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getTrackerStats returns null (not a throw) for a nonexistent directory', () => {
  assert.equal(getTrackerStats('/definitely/does/not/exist/anywhere'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin-overview-roster.test.mjs`
Expected: fails — `core/admin-overview-snapshot.mjs` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```js
// core/admin-overview-snapshot.mjs
/**
 * admin-overview-snapshot.mjs — gathers a cross-workspace snapshot for the
 * admin overview artifact: workspace roster, tracker stats, active-task
 * status, and token-usage/run-count history mined from Claude Code's own
 * local session transcripts.
 *
 * PRIVACY-CRITICAL: the transcript-parsing functions in this file extract
 * ONLY `timestamp`, `usage`, and Skill-tool-call `input.skill`/`input.args`
 * fields from each JSONL line — never any other field (message content,
 * tool results, file contents). See
 * docs/superpowers/specs/2026-09-02-admin-overview-design.md.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Enumerate every provisioned workspace under workspaces/.
 *
 * @param {string} [reposRoot] - Override for tests.
 * @returns {{slug: string, displayName: string, chatId: string|null, createdAt: string|null, dir: string}[]}
 */
export function listWorkspaces(reposRoot = ROOT) {
  const workspacesDir = join(reposRoot, 'workspaces');
  if (!existsSync(workspacesDir)) return [];
  const slugs = readdirSync(workspacesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const result = [];
  for (const slug of slugs) {
    const dir = join(workspacesDir, slug);
    const metaPath = join(dir, 'workspace.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      result.push({
        slug: meta.slug || slug,
        displayName: meta.display_name || slug,
        chatId: meta.chat_id || null,
        createdAt: meta.created_at || null,
        dir,
      });
    } catch {
      // corrupt/unreadable workspace.json — skip, don't crash the whole snapshot
    }
  }
  return result;
}

/**
 * Run core/stats.mjs against one workspace and return its parsed JSON, or
 * null if the script fails/produces unparseable output (never throws —
 * a broken workspace must not crash the whole snapshot).
 *
 * @param {string} wsDir - Absolute path to the workspace directory.
 * @returns {object|null}
 */
export function getTrackerStats(wsDir) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'core', 'stats.mjs')], {
      cwd: wsDir,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin-overview-roster.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/admin-overview-snapshot.mjs tests/admin-overview-roster.test.mjs
git commit -m "feat: add workspace roster + tracker stats gathering for admin overview"
```

---

### Task 2: Active-task status

**Files:**
- Modify: `core/admin-overview-snapshot.mjs`
- Test: `tests/admin-overview-active-task.test.mjs`

**Interfaces:**
- Consumes: nothing new from Task 1 (independent function, same file)
- Produces: `export function getActiveTaskStatus(wsDir: string): {state: 'no_run'|'running'|'stalled'|'done', staleMs: number|null, lastUpdateAgo: string|null, step: object|null}`

- [ ] **Step 1: Write the failing tests**

```js
// tests/admin-overview-active-task.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getActiveTaskStatus } from '../core/admin-overview-snapshot.mjs';

test('getActiveTaskStatus reports no_run for a workspace that never ran cycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    const result = getActiveTaskStatus(root);
    assert.equal(result.state, 'no_run');
    assert.equal(result.staleMs, null);
    assert.equal(result.step, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getActiveTaskStatus reports done for a workspace with a completed cycle run', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    mkdirSync(join(root, 'data', 'cache'), { recursive: true });
    writeFileSync(join(root, 'data', 'cache', 'cycle-status.json'), JSON.stringify({
      version: 1,
      runId: '2026-01-01T00:00:00.000Z',
      savedAt: new Date().toISOString(),
      step: { id: 'done', label: 'Cycle complete' },
      counters: {},
      lastError: null,
    }));
    const result = getActiveTaskStatus(root);
    assert.equal(result.state, 'done');
    assert.equal(result.step.id, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getActiveTaskStatus reports running for a fresh in-progress cycle run', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    mkdirSync(join(root, 'data', 'cache'), { recursive: true });
    writeFileSync(join(root, 'data', 'cache', 'cycle-status.json'), JSON.stringify({
      version: 1,
      runId: '2026-01-01T00:00:00.000Z',
      savedAt: new Date().toISOString(),
      step: { id: '2-pipeline', label: 'Pipeline Processing' },
      counters: { pipeline_pending: 5 },
      lastError: null,
    }));
    const result = getActiveTaskStatus(root);
    assert.equal(result.state, 'running');
    assert.equal(result.step.label, 'Pipeline Processing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getActiveTaskStatus never throws for a workspace directory that does not exist', () => {
  assert.doesNotThrow(() => getActiveTaskStatus('/definitely/does/not/exist/anywhere'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin-overview-active-task.test.mjs`
Expected: fails — `getActiveTaskStatus` is not exported yet.

- [ ] **Step 3: Add the implementation**

Append to `core/admin-overview-snapshot.mjs`:

```js
/**
 * Run core/cycle-status.mjs --json against one workspace and return its
 * liveness classification. The script itself already handles "never run
 * yet" gracefully (prints {liveness: {state: 'no_run', ...}} and exits 0),
 * so the try/catch here only guards against a genuinely broken/corrupt
 * state file — never let one bad workspace crash the whole snapshot.
 *
 * @param {string} wsDir
 * @returns {{state: string, staleMs: number|null, lastUpdateAgo: string|null, step: object|null}}
 */
export function getActiveTaskStatus(wsDir) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'core', 'cycle-status.mjs'), '--json'], {
      cwd: wsDir,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const data = JSON.parse(out);
    return { ...data.liveness, step: data.step || null };
  } catch {
    return { state: 'no_run', staleMs: null, lastUpdateAgo: null, step: null };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin-overview-active-task.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/admin-overview-snapshot.mjs tests/admin-overview-active-task.test.mjs
git commit -m "feat: add active-task status gathering for admin overview"
```

---

### Task 3: Transcript discovery (hub prefix + workspace-slug mapping)

**Files:**
- Modify: `core/admin-overview-snapshot.mjs`
- Test: `tests/admin-overview-transcript-discovery.test.mjs`

**Interfaces:**
- Produces: `export function hubProjectDirPrefix(reposRoot?: string): string`
- Produces: `export function classifyProjectDir(dirName: string, prefix: string): {scope: 'hub'} | {scope: 'workspace', slug: string} | {scope: 'other'}`
- Produces: `export function findHubTranscriptFiles(reposRoot?: string, claudeHome?: string): {path: string, scope: 'hub'|'workspace', slug: string|null}[]`

- [ ] **Step 1: Write the failing tests**

```js
// tests/admin-overview-transcript-discovery.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubProjectDirPrefix, classifyProjectDir, findHubTranscriptFiles } from '../core/admin-overview-snapshot.mjs';

test('hubProjectDirPrefix replaces colons, backslashes, and underscores with hyphens', () => {
  const prefix = hubProjectDirPrefix('C:\\Users\\thebo\\_vscode\\career-ops');
  assert.equal(prefix, 'C--Users-thebo--vscode-career-ops');
});

test('classifyProjectDir identifies the bare hub root, case-insensitively', () => {
  const prefix = 'C--Users-thebo--vscode-career-ops';
  assert.deepEqual(classifyProjectDir('C--Users-thebo--vscode-career-ops', prefix), { scope: 'hub' });
  assert.deepEqual(classifyProjectDir('c--Users-thebo--vscode-career-ops', prefix), { scope: 'hub' });
});

test('classifyProjectDir identifies a workspace project dir and extracts the slug', () => {
  const prefix = 'C--Users-thebo--vscode-career-ops';
  const result = classifyProjectDir('C--Users-thebo--vscode-career-ops-workspaces-alice', prefix);
  assert.deepEqual(result, { scope: 'workspace', slug: 'alice' });
});

test('classifyProjectDir is case-insensitive on the drive-letter prefix for workspace dirs too', () => {
  const prefix = 'C--Users-thebo--vscode-career-ops';
  const result = classifyProjectDir('c--Users-thebo--vscode-career-ops-workspaces-bob', prefix);
  assert.deepEqual(result, { scope: 'workspace', slug: 'bob' });
});

test('classifyProjectDir returns other for a project directory unrelated to this hub', () => {
  const prefix = 'C--Users-thebo--vscode-career-ops';
  const result = classifyProjectDir('C--Users-thebo-some-other-project', prefix);
  assert.deepEqual(result, { scope: 'other' });
});

test('findHubTranscriptFiles finds .jsonl files under hub and workspace project dirs, ignoring unrelated ones', () => {
  const reposRoot = join(mkdtempSync(join(tmpdir(), 'admin-overview-repo-')), 'career-ops');
  mkdirSync(reposRoot, { recursive: true });
  const claudeHome = mkdtempSync(join(tmpdir(), 'admin-overview-claude-'));
  try {
    const prefix = reposRoot.replace(/[:\\_]/g, '-');
    const hubDir = join(claudeHome, 'projects', prefix);
    const wsDir = join(claudeHome, 'projects', `${prefix}-workspaces-alice`);
    const otherDir = join(claudeHome, 'projects', 'totally-unrelated-project');
    mkdirSync(hubDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(hubDir, 'session1.jsonl'), '{}\n');
    writeFileSync(join(wsDir, 'session2.jsonl'), '{}\n');
    writeFileSync(join(otherDir, 'session3.jsonl'), '{}\n');
    // A subagent transcript nested one level deeper, matching the real layout observed on disk.
    mkdirSync(join(wsDir, 'subsession', 'subagents'), { recursive: true });
    writeFileSync(join(wsDir, 'subsession', 'subagents', 'agent1.jsonl'), '{}\n');

    const found = findHubTranscriptFiles(reposRoot, claudeHome);
    const scopes = found.map((f) => f.scope).sort();
    assert.deepEqual(scopes, ['hub', 'workspace', 'workspace']);
    const wsEntries = found.filter((f) => f.scope === 'workspace');
    assert.ok(wsEntries.every((e) => e.slug === 'alice'));
    assert.ok(!found.some((f) => f.path.includes('totally-unrelated-project')));
  } finally {
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(dirname(reposRoot), { recursive: true, force: true });
  }
});

test('findHubTranscriptFiles returns an empty array when ~/.claude/projects does not exist', () => {
  const claudeHome = mkdtempSync(join(tmpdir(), 'admin-overview-claude-empty-'));
  try {
    assert.deepEqual(findHubTranscriptFiles('/some/repo', claudeHome), []);
  } finally {
    rmSync(claudeHome, { recursive: true, force: true });
  }
});
```

Note: this test file imports `dirname` for its own cleanup — add `import { dirname } from 'node:path';` alongside the existing `join` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin-overview-transcript-discovery.test.mjs`
Expected: fails — none of these three functions exist yet.

- [ ] **Step 3: Add the implementation**

Append to `core/admin-overview-snapshot.mjs`:

```js
/**
 * Compute this hub's Claude-Code-style encoded path prefix, used to find
 * this hub's own project directories under ~/.claude/projects/. Claude Code
 * encodes a launch path by replacing ':', '\\', and '_' with '-' while
 * preserving case — and has been observed emitting both upper- and
 * lower-case drive letters for the same hub across different sessions, so
 * callers must match against this prefix case-insensitively.
 *
 * @param {string} [reposRoot]
 * @returns {string}
 */
export function hubProjectDirPrefix(reposRoot = ROOT) {
  return reposRoot.replace(/[:\\_]/g, '-');
}

const WORKSPACE_MARKER = '-workspaces-';

/**
 * Given one ~/.claude/projects/ directory name, determine whether it
 * belongs to this hub's own root, one of its workspaces, or an unrelated
 * project on the same machine.
 *
 * @param {string} dirName
 * @param {string} prefix - From hubProjectDirPrefix().
 * @returns {{scope: 'hub'} | {scope: 'workspace', slug: string} | {scope: 'other'}}
 */
export function classifyProjectDir(dirName, prefix) {
  const lowerDir = dirName.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerDir === lowerPrefix) return { scope: 'hub' };
  const markerLower = (lowerPrefix + WORKSPACE_MARKER);
  if (!lowerDir.startsWith(markerLower)) return { scope: 'other' };
  const slug = dirName.slice((prefix + WORKSPACE_MARKER).length);
  if (!slug) return { scope: 'other' };
  return { scope: 'workspace', slug };
}

function walkJsonlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * Find every .jsonl transcript file under ~/.claude/projects/ that belongs
 * to this hub (its own root, or one of its workspaces) — never files from
 * unrelated projects on the same machine. Searches recursively, since
 * subagent transcripts live one level deeper (observed real layout:
 * "{project-dir}/{sessionId}/subagents/{agentId}.jsonl").
 *
 * @param {string} [reposRoot]
 * @param {string} [claudeHome] - Override for tests; defaults to `~/.claude`.
 * @returns {{path: string, scope: 'hub'|'workspace', slug: string|null}[]}
 */
export function findHubTranscriptFiles(reposRoot = ROOT, claudeHome = join(homedir(), '.claude')) {
  const projectsDir = join(claudeHome, 'projects');
  if (!existsSync(projectsDir)) return [];
  const prefix = hubProjectDirPrefix(reposRoot);
  const results = [];
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const classification = classifyProjectDir(entry.name, prefix);
    if (classification.scope === 'other') continue;
    const dirPath = join(projectsDir, entry.name);
    for (const file of walkJsonlFiles(dirPath)) {
      results.push({ path: file, scope: classification.scope, slug: classification.slug || null });
    }
  }
  return results;
}
```

Add `import { homedir } from 'os';` to the existing import line from `'os'` at the top of the file (new import needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin-overview-transcript-discovery.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/admin-overview-snapshot.mjs tests/admin-overview-transcript-discovery.test.mjs
git commit -m "feat: add hub transcript discovery for admin overview"
```

---

### Task 4: Transcript parsing — usage + Skill-call extraction (privacy-critical)

**Files:**
- Modify: `core/admin-overview-snapshot.mjs`
- Test: `tests/admin-overview-transcript-parse.test.mjs`

**Interfaces:**
- Consumes: nothing new from earlier tasks (independent function, same file)
- Produces: `export function extractUsageAndSkillCalls(filePath: string): {usageEntries: {timestamp: string, usage: object}[], skillCalls: {timestamp: string, skill: string, args: string}[]}`

- [ ] **Step 1: Write the failing tests**

```js
// tests/admin-overview-transcript-parse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractUsageAndSkillCalls } from '../core/admin-overview-snapshot.mjs';

function writeFixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-overview-transcript-'));
  const filePath = join(dir, 'session.jsonl');
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, filePath };
}

test('extractUsageAndSkillCalls pulls timestamp+usage from assistant message lines', () => {
  const { dir, filePath } = writeFixture([
    {
      type: 'assistant', timestamp: '2026-08-31T17:21:28.588Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'some secret conversation content' }] },
      usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
    },
  ]);
  try {
    const result = extractUsageAndSkillCalls(filePath);
    assert.equal(result.usageEntries.length, 1);
    assert.equal(result.usageEntries[0].timestamp, '2026-08-31T17:21:28.588Z');
    assert.deepEqual(result.usageEntries[0].usage, { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractUsageAndSkillCalls pulls skill+args from Skill tool-call lines', () => {
  const { dir, filePath } = writeFixture([
    {
      type: 'assistant', timestamp: '2026-08-31T17:22:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'career-ops', args: 'Run career-ops pipeline mode for data/pipeline.md.' } }],
      },
    },
  ]);
  try {
    const result = extractUsageAndSkillCalls(filePath);
    assert.equal(result.skillCalls.length, 1);
    assert.equal(result.skillCalls[0].timestamp, '2026-08-31T17:22:00.000Z');
    assert.equal(result.skillCalls[0].skill, 'career-ops');
    assert.equal(result.skillCalls[0].args, 'Run career-ops pipeline mode for data/pipeline.md.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractUsageAndSkillCalls ignores tool calls that are not Skill', () => {
  const { dir, filePath } = writeFixture([
    {
      type: 'assistant', timestamp: '2026-08-31T17:23:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    },
  ]);
  try {
    const result = extractUsageAndSkillCalls(filePath);
    assert.equal(result.skillCalls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractUsageAndSkillCalls skips a malformed JSON line instead of crashing the whole file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-overview-transcript-'));
  const filePath = join(dir, 'session.jsonl');
  writeFileSync(filePath, [
    '{not valid json at all',
    JSON.stringify({
      type: 'assistant', timestamp: '2026-08-31T17:24:00.000Z',
      message: { role: 'assistant', content: [] },
      usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 },
    }),
  ].join('\n') + '\n');
  try {
    const result = extractUsageAndSkillCalls(filePath);
    assert.equal(result.usageEntries.length, 1);
    assert.equal(result.usageEntries[0].timestamp, '2026-08-31T17:24:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractUsageAndSkillCalls returns empty arrays (not a throw) for a nonexistent file', () => {
  const result = extractUsageAndSkillCalls('/definitely/does/not/exist.jsonl');
  assert.deepEqual(result, { usageEntries: [], skillCalls: [] });
});

test('extractUsageAndSkillCalls never includes message content anywhere in its return value', () => {
  const secretText = 'THIS-IS-PRIVATE-CONVERSATION-CONTENT-12345';
  const { dir, filePath } = writeFixture([
    {
      type: 'assistant', timestamp: '2026-08-31T17:25:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: secretText }] },
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
    },
  ]);
  try {
    const result = extractUsageAndSkillCalls(filePath);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(secretText), 'privacy violation: message content leaked into extraction result');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin-overview-transcript-parse.test.mjs`
Expected: fails — `extractUsageAndSkillCalls` is not exported yet.

- [ ] **Step 3: Add the implementation**

Append to `core/admin-overview-snapshot.mjs`:

```js
/**
 * PRIVACY-CRITICAL: parse one .jsonl transcript file and extract ONLY
 * `timestamp`+`usage` (from lines carrying a top-level `usage` object) and
 * `timestamp`+Skill-tool-call `input.skill`/`input.args` (from `tool_use`
 * content blocks named "Skill"). Every other field on every line —
 * `message.content` text, other tool inputs/results, anything else — is
 * read only to locate these two shapes and is never copied into the
 * return value. A malformed line is skipped, never thrown.
 *
 * @param {string} filePath
 * @returns {{usageEntries: {timestamp: string, usage: object}[], skillCalls: {timestamp: string, skill: string, args: string}[]}}
 */
export function extractUsageAndSkillCalls(filePath) {
  const usageEntries = [];
  const skillCalls = [];
  if (!existsSync(filePath)) return { usageEntries, skillCalls };

  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { usageEntries, skillCalls };
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip, don't crash the whole file
    }
    const timestamp = entry.timestamp;
    if (!timestamp) continue;

    if (entry.usage && typeof entry.usage === 'object') {
      usageEntries.push({
        timestamp,
        usage: {
          input_tokens: entry.usage.input_tokens || 0,
          cache_creation_input_tokens: entry.usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: entry.usage.cache_read_input_tokens || 0,
          output_tokens: entry.usage.output_tokens || 0,
        },
      });
    }

    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === 'Skill' && block.input) {
          skillCalls.push({
            timestamp,
            skill: String(block.input.skill || ''),
            args: String(block.input.args || ''),
          });
        }
      }
    }
  }

  return { usageEntries, skillCalls };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin-overview-transcript-parse.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/admin-overview-snapshot.mjs tests/admin-overview-transcript-parse.test.mjs
git commit -m "feat: add privacy-scoped transcript usage/skill-call extraction"
```

---

### Task 5: Run classification

**Files:**
- Modify: `core/admin-overview-snapshot.mjs`
- Test: `tests/admin-overview-classify.test.mjs`

**Interfaces:**
- Consumes: nothing new from earlier tasks (independent function, same file)
- Produces: `export function classifyRunFromArgs(argsText: string): string` — a mode name (e.g. `'pipeline'`, `'cycle'`, `'scan'`, `'oferta'`, `'auto-pipeline'`) or the literal string `'unclassified'`

- [ ] **Step 1: Write the failing tests**

```js
// tests/admin-overview-classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunFromArgs } from '../core/admin-overview-snapshot.mjs';

test('classifyRunFromArgs recognizes pipeline mode', () => {
  assert.equal(classifyRunFromArgs('Run career-ops pipeline mode for data/pipeline.md.'), 'pipeline');
});

test('classifyRunFromArgs recognizes cycle mode', () => {
  assert.equal(classifyRunFromArgs('Run the career-ops cycle mode: scan, then pipeline, then top-match PDFs.'), 'cycle');
});

test('classifyRunFromArgs recognizes scan mode', () => {
  assert.equal(classifyRunFromArgs('Run the career-ops scan mode and summarize new matches.'), 'scan');
});

test('classifyRunFromArgs recognizes a JD/URL evaluation as auto-pipeline', () => {
  assert.equal(classifyRunFromArgs('Evaluate this JD with career-ops auto-pipeline: https://company.com/jobs/123'), 'auto-pipeline');
});

test('classifyRunFromArgs recognizes tracker mode', () => {
  assert.equal(classifyRunFromArgs('Run the career-ops tracker mode and summarize the current statuses.'), 'tracker');
});

test('classifyRunFromArgs recognizes pdf mode', () => {
  assert.equal(classifyRunFromArgs('Run the career-ops pdf mode for the latest evaluated role.'), 'pdf');
});

test('classifyRunFromArgs returns unclassified for text matching no known pattern, never a wrong guess', () => {
  assert.equal(classifyRunFromArgs('Telegram routing for received message: "Yes" from Ernesto (chatId 8859195406, messageId 395). Route per modes/telegram.md Steps 2-6.'), 'unclassified');
});

test('classifyRunFromArgs returns unclassified for empty/missing text', () => {
  assert.equal(classifyRunFromArgs(''), 'unclassified');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin-overview-classify.test.mjs`
Expected: fails — `classifyRunFromArgs` is not exported yet.

- [ ] **Step 3: Add the implementation**

Append to `core/admin-overview-snapshot.mjs`:

```js
// Ordered so a more specific pattern (e.g. "auto-pipeline") is checked
// before a broader one that could also match the same text. Best-effort
// only — this reads free-text prompt args, not a structured command, so
// anything not clearly matching one of these lands in 'unclassified'
// rather than being guessed into the wrong bucket.
const RUN_CLASSIFICATION_PATTERNS = [
  ['auto-pipeline', /auto-pipeline|evaluate this jd/i],
  ['cycle', /\bcycle mode\b/i],
  ['pipeline', /\bpipeline mode\b/i],
  ['scan', /\bscan mode\b/i],
  ['tracker', /\btracker mode\b/i],
  ['pdf', /\bpdf mode\b/i],
  ['oferta', /\boferta\b/i],
  ['batch', /\bbatch mode\b/i],
  ['apply', /\bapply mode\b/i],
];

/**
 * Best-effort classification of a career-ops Skill invocation's free-text
 * `args` into a mode name, based on the same prompt patterns documented in
 * core/AGENTS.md's Skill Modes table. Never guesses: unrecognized text
 * returns 'unclassified' rather than being folded into the wrong bucket.
 *
 * @param {string} argsText
 * @returns {string}
 */
export function classifyRunFromArgs(argsText) {
  if (!argsText) return 'unclassified';
  for (const [name, pattern] of RUN_CLASSIFICATION_PATTERNS) {
    if (pattern.test(argsText)) return name;
  }
  return 'unclassified';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin-overview-classify.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/admin-overview-snapshot.mjs tests/admin-overview-classify.test.mjs
git commit -m "feat: add best-effort run classification from Skill call args"
```

---

### Task 6: Aggregation (token usage + run counts, by workspace and by day)

**Files:**
- Modify: `core/admin-overview-snapshot.mjs`
- Test: `tests/admin-overview-aggregate.test.mjs`

**Interfaces:**
- Consumes: the shapes produced by `extractUsageAndSkillCalls` (Task 4), `classifyRunFromArgs` (Task 5), and `findHubTranscriptFiles`'s per-file `{scope, slug}` (Task 3)
- Produces: `export function aggregateHistory(files: {path: string, scope: 'hub'|'workspace', slug: string|null}[], knownSlugs: string[]): {tokenUsageByWorkspace: object, runCountsByWorkspace: object}` — see the test cases below for the exact nested shape

- [ ] **Step 1: Write the failing tests**

```js
// tests/admin-overview-aggregate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateHistory } from '../core/admin-overview-snapshot.mjs';

function writeTranscript(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-overview-agg-'));
  const filePath = join(dir, 'session.jsonl');
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, filePath };
}

test('aggregateHistory buckets token usage by workspace and by day', () => {
  const { dir, filePath } = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.000Z', message: { role: 'assistant', content: [] },
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } },
    { type: 'assistant', timestamp: '2026-08-31T14:00:00.000Z', message: { role: 'assistant', content: [] },
      usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 15 } },
    { type: 'assistant', timestamp: '2026-09-01T09:00:00.000Z', message: { role: 'assistant', content: [] },
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } },
  ]);
  try {
    const result = aggregateHistory([{ path: filePath, scope: 'workspace', slug: 'alice' }], ['alice']);
    const alice = result.tokenUsageByWorkspace.alice;
    assert.equal(alice['2026-08-31'].input_tokens, 30);
    assert.equal(alice['2026-08-31'].output_tokens, 20);
    assert.equal(alice['2026-09-01'].input_tokens, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateHistory buckets run counts by workspace, mode, and day, including unclassified', () => {
  const { dir, filePath } = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Skill', input: { skill: 'career-ops', args: 'Run career-ops pipeline mode for data/pipeline.md.' } },
    ] } },
    { type: 'assistant', timestamp: '2026-08-31T11:00:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Skill', input: { skill: 'career-ops', args: 'Telegram routing for received message.' } },
    ] } },
  ]);
  try {
    const result = aggregateHistory([{ path: filePath, scope: 'workspace', slug: 'alice' }], ['alice']);
    const alice = result.runCountsByWorkspace.alice['2026-08-31'];
    assert.equal(alice.pipeline, 1);
    assert.equal(alice.unclassified, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateHistory buckets a slug not in knownSlugs under "deleted-or-renamed", never dropped', () => {
  const { dir, filePath } = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.000Z', message: { role: 'assistant', content: [] },
      usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } },
  ]);
  try {
    const result = aggregateHistory([{ path: filePath, scope: 'workspace', slug: 'ghost-workspace' }], ['alice']);
    assert.ok(!('ghost-workspace' in result.tokenUsageByWorkspace));
    assert.equal(result.tokenUsageByWorkspace['deleted-or-renamed']['2026-08-31'].input_tokens, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateHistory buckets hub-scope files under "hub", separate from any workspace', () => {
  const { dir, filePath } = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.000Z', message: { role: 'assistant', content: [] },
      usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } },
  ]);
  try {
    const result = aggregateHistory([{ path: filePath, scope: 'hub', slug: null }], ['alice']);
    assert.equal(result.tokenUsageByWorkspace.hub['2026-08-31'].input_tokens, 7);
    assert.ok(!('alice' in result.tokenUsageByWorkspace) || Object.keys(result.tokenUsageByWorkspace.alice || {}).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateHistory returns empty aggregates (not a throw) for an empty file list', () => {
  const result = aggregateHistory([], ['alice']);
  assert.deepEqual(result.tokenUsageByWorkspace, {});
  assert.deepEqual(result.runCountsByWorkspace, {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin-overview-aggregate.test.mjs`
Expected: fails — `aggregateHistory` is not exported yet.

- [ ] **Step 3: Add the implementation**

Append to `core/admin-overview-snapshot.mjs`:

```js
function dayKey(isoTimestamp) {
  return isoTimestamp.slice(0, 10); // "2026-08-31T..." -> "2026-08-31"
}

function bucketKeyFor(scope, slug, knownSlugs) {
  if (scope === 'hub') return 'hub';
  if (slug && knownSlugs.includes(slug)) return slug;
  return 'deleted-or-renamed';
}

/**
 * Aggregate token-usage and run-count history across a set of discovered
 * transcript files (from findHubTranscriptFiles), bucketed by workspace
 * slug and by day. A file whose slug no longer matches any workspace in
 * `knownSlugs` is bucketed under 'deleted-or-renamed' rather than dropped
 * or mis-attributed. Hub-root-scoped files bucket under 'hub'.
 *
 * @param {{path: string, scope: 'hub'|'workspace', slug: string|null}[]} files
 * @param {string[]} knownSlugs - Slugs of currently-provisioned workspaces (from listWorkspaces).
 * @returns {{tokenUsageByWorkspace: Object<string, Object<string, {input_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number, output_tokens: number}>>, runCountsByWorkspace: Object<string, Object<string, Object<string, number>>>}}
 */
export function aggregateHistory(files, knownSlugs) {
  const tokenUsageByWorkspace = {};
  const runCountsByWorkspace = {};

  for (const file of files) {
    const bucket = bucketKeyFor(file.scope, file.slug, knownSlugs);
    const { usageEntries, skillCalls } = extractUsageAndSkillCalls(file.path);

    if (!tokenUsageByWorkspace[bucket]) tokenUsageByWorkspace[bucket] = {};
    for (const { timestamp, usage } of usageEntries) {
      const day = dayKey(timestamp);
      if (!tokenUsageByWorkspace[bucket][day]) {
        tokenUsageByWorkspace[bucket][day] = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
      }
      const dayTotals = tokenUsageByWorkspace[bucket][day];
      dayTotals.input_tokens += usage.input_tokens;
      dayTotals.cache_creation_input_tokens += usage.cache_creation_input_tokens;
      dayTotals.cache_read_input_tokens += usage.cache_read_input_tokens;
      dayTotals.output_tokens += usage.output_tokens;
    }

    if (!runCountsByWorkspace[bucket]) runCountsByWorkspace[bucket] = {};
    for (const { timestamp, skill, args } of skillCalls) {
      if (!skill.includes('career-ops')) continue; // only career-ops invocations count as a "run"
      const day = dayKey(timestamp);
      const mode = classifyRunFromArgs(args);
      if (!runCountsByWorkspace[bucket][day]) runCountsByWorkspace[bucket][day] = {};
      runCountsByWorkspace[bucket][day][mode] = (runCountsByWorkspace[bucket][day][mode] || 0) + 1;
    }
  }

  return { tokenUsageByWorkspace, runCountsByWorkspace };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin-overview-aggregate.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/admin-overview-snapshot.mjs tests/admin-overview-aggregate.test.mjs
git commit -m "feat: add token-usage/run-count aggregation for admin overview"
```

---

### Task 7: Snapshot orchestration + CLI

**Files:**
- Modify: `core/admin-overview-snapshot.mjs`
- Test: `tests/admin-overview-snapshot-cli.test.mjs`

**Interfaces:**
- Consumes: `listWorkspaces`, `getTrackerStats`, `getActiveTaskStatus`, `findHubTranscriptFiles`, `aggregateHistory` (Tasks 1-6, same file)
- Produces: `export function buildSnapshot(reposRoot?: string): object` (the full JSON snapshot); CLI contract: `node core/admin-overview-snapshot.mjs <output.json>` writes the snapshot there and exits 0

- [ ] **Step 1: Write the failing test**

```js
// tests/admin-overview-snapshot-cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../core/admin-overview-snapshot.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeFakeRepo(root) {
  // buildSnapshot shells out to `node core/stats.mjs` and `node
  // core/cycle-status.mjs` relative to its OWN real ROOT (see Task 1/2's
  // execFileSync calls), not the fake reposRoot under test — so those
  // still resolve to the real scripts. Only workspaces/ needs to exist
  // under the fake root for listWorkspaces() to find it.
  const wsDir = join(root, 'workspaces', 'alice');
  mkdirSync(join(wsDir, 'data', 'cache'), { recursive: true });
  writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({
    slug: 'alice', chat_id: '123', display_name: 'Alice', created_at: '2026-01-01',
  }));
}

test('buildSnapshot assembles roster, tracker stats, active-task status, and empty history into one object', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-build-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'admin-overview-build-claude-'));
  try {
    makeFakeRepo(root);
    const snapshot = buildSnapshot(root, claudeHome);
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.workspaces[0].slug, 'alice');
    assert.ok('trackerStats' in snapshot.workspaces[0]);
    assert.ok('activeTask' in snapshot.workspaces[0]);
    assert.equal(snapshot.workspaces[0].activeTask.state, 'no_run');
    assert.ok(snapshot.generatedAt);
    assert.deepEqual(snapshot.tokenUsageByWorkspace, {});
    assert.deepEqual(snapshot.runCountsByWorkspace, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});

test('CLI writes the snapshot JSON to the given output path and exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-build-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'admin-overview-build-claude-'));
  const outPath = join(root, 'snapshot.json');
  try {
    makeFakeRepo(root);
    execFileSync(process.execPath, [
      join(REPO_ROOT, 'core', 'admin-overview-snapshot.mjs'), outPath,
    ], {
      encoding: 'utf-8',
      env: { ...process.env, CAREER_OPS_ADMIN_OVERVIEW_REPO_ROOT: root, CAREER_OPS_ADMIN_OVERVIEW_CLAUDE_HOME: claudeHome },
    });
    assert.ok(existsSync(outPath));
    const written = JSON.parse(readFileSync(outPath, 'utf-8'));
    assert.equal(written.workspaces.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin-overview-snapshot-cli.test.mjs`
Expected: fails — `buildSnapshot` is not exported and there's no CLI entry yet.

- [ ] **Step 3: Add the orchestration + CLI**

Append to `core/admin-overview-snapshot.mjs`:

```js
/**
 * Assemble the full cross-workspace snapshot: roster (with tracker stats
 * and active-task status inlined per workspace) plus token-usage/run-count
 * history aggregated from this hub's Claude Code session transcripts.
 *
 * @param {string} [reposRoot] - Override for tests.
 * @param {string} [claudeHome] - Override for tests; defaults to `~/.claude`.
 * @returns {object}
 */
export function buildSnapshot(reposRoot = ROOT, claudeHome = join(homedir(), '.claude')) {
  const workspaces = listWorkspaces(reposRoot).map((ws) => ({
    ...ws,
    trackerStats: getTrackerStats(ws.dir),
    activeTask: getActiveTaskStatus(ws.dir),
  }));
  const knownSlugs = workspaces.map((ws) => ws.slug);
  const files = findHubTranscriptFiles(reposRoot, claudeHome);
  const { tokenUsageByWorkspace, runCountsByWorkspace } = aggregateHistory(files, knownSlugs);

  return {
    generatedAt: new Date().toISOString(),
    workspaces,
    tokenUsageByWorkspace,
    runCountsByWorkspace,
  };
}

async function main() {
  const [, , outPath] = process.argv;
  if (!outPath) {
    console.error('Usage: node admin-overview-snapshot.mjs <output.json>');
    return 1;
  }
  const reposRoot = process.env.CAREER_OPS_ADMIN_OVERVIEW_REPO_ROOT || ROOT;
  const claudeHome = process.env.CAREER_OPS_ADMIN_OVERVIEW_CLAUDE_HOME || join(homedir(), '.claude');
  const snapshot = buildSnapshot(reposRoot, claudeHome);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`admin-overview-snapshot: wrote ${outPath} (${snapshot.workspaces.length} workspace(s))`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
```

Add `writeFileSync` to the existing `fs` import line, and add two new imports at the top of the file:

```js
import { isMainModule } from './is-main.mjs';
```

(alongside the existing imports — `homedir` from `'os'` was already added in Task 3).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin-overview-snapshot-cli.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/admin-overview-snapshot.mjs tests/admin-overview-snapshot-cli.test.mjs
git commit -m "feat: add admin-overview-snapshot.mjs orchestration + CLI"
```

---

### Task 8: HTML rendering (privacy-critical regression test)

**Files:**
- Create: `core/admin-overview-render.mjs`
- Test: `tests/admin-overview-render.test.mjs`

**Interfaces:**
- Consumes: the snapshot shape produced by `buildSnapshot` (Task 7) — read from a JSON file, not imported directly (this script is invoked as a separate CLI step)
- Produces: `export function renderHtml(snapshot: object): string`; CLI contract: `node core/admin-overview-render.mjs <snapshot.json> <output.html>` writes the rendered page there and exits 0

- [ ] **Step 1: Write the failing tests**

```js
// tests/admin-overview-render.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderHtml } from '../core/admin-overview-render.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sampleSnapshot() {
  return {
    generatedAt: '2026-09-02T12:00:00.000Z',
    workspaces: [
      {
        slug: 'alice', displayName: 'Alice', chatId: '123', createdAt: '2026-01-01',
        trackerStats: { tracker: { total: 5 }, funnel: { everApplied: 2 } },
        activeTask: { state: 'running', staleMs: 60000, lastUpdateAgo: '1m ago', step: { id: '2-pipeline', label: 'Pipeline Processing' } },
      },
      {
        slug: 'bob', displayName: 'Bob', chatId: null, createdAt: '2026-02-01',
        trackerStats: null,
        activeTask: { state: 'no_run', staleMs: null, lastUpdateAgo: null, step: null },
      },
    ],
    tokenUsageByWorkspace: {
      alice: { '2026-09-01': { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } },
    },
    runCountsByWorkspace: {
      alice: { '2026-09-01': { pipeline: 2, unclassified: 1 } },
    },
  };
}

test('renderHtml includes every workspace slug and display name', () => {
  const html = renderHtml(sampleSnapshot());
  assert.match(html, /alice/);
  assert.match(html, /Alice/);
  assert.match(html, /bob/);
  assert.match(html, /Bob/);
});

test('renderHtml shows active-task state for a running workspace', () => {
  const html = renderHtml(sampleSnapshot());
  assert.match(html, /running/i);
  assert.match(html, /Pipeline Processing/);
});

test('renderHtml handles a workspace with null trackerStats without crashing', () => {
  const html = renderHtml(sampleSnapshot());
  assert.match(html, /bob/); // got this far without throwing
});

test('renderHtml surfaces the unclassified run-count bucket, never hiding it', () => {
  const html = renderHtml(sampleSnapshot());
  assert.match(html, /unclassified/i);
});

test('renderHtml produces a complete HTML document starting with a doctype', () => {
  const html = renderHtml(sampleSnapshot());
  assert.match(html.trim(), /^<!doctype html>/i);
});

test('CLI reads a snapshot JSON file and writes rendered HTML to the given output path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-overview-render-'));
  try {
    const snapshotPath = join(dir, 'snapshot.json');
    const outPath = join(dir, 'output.html');
    writeFileSync(snapshotPath, JSON.stringify(sampleSnapshot()));
    execFileSync(process.execPath, [
      join(REPO_ROOT, 'core', 'admin-overview-render.mjs'), snapshotPath, outPath,
    ], { encoding: 'utf-8' });
    assert.ok(existsSync(outPath));
    const html = readFileSync(outPath, 'utf-8');
    assert.match(html, /alice/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin-overview-render.test.mjs`
Expected: fails — `core/admin-overview-render.mjs` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```js
// core/admin-overview-render.mjs
/**
 * admin-overview-render.mjs — pure JSON-to-HTML renderer for the admin
 * overview artifact. Reads a snapshot file (from admin-overview-snapshot.mjs)
 * and writes a complete, ready-to-publish HTML document. No filesystem
 * access beyond the two file arguments, no network access, no LLM calls.
 */
import { readFileSync, writeFileSync } from 'fs';
import { isMainModule } from './is-main.mjs';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderWorkspaceRow(ws) {
  const total = ws.trackerStats?.tracker?.total ?? '—';
  const applied = ws.trackerStats?.funnel?.everApplied ?? '—';
  const chatBound = ws.chatId ? '✓' : '—';
  return `<tr>
    <td>${escapeHtml(ws.slug)}</td>
    <td>${escapeHtml(ws.displayName)}</td>
    <td>${escapeHtml(ws.createdAt)}</td>
    <td>${chatBound}</td>
    <td>${escapeHtml(total)}</td>
    <td>${escapeHtml(applied)}</td>
  </tr>`;
}

function renderActiveTaskRow(ws) {
  const t = ws.activeTask;
  if (t.state === 'no_run') return '';
  const stepLabel = t.step?.label || t.step?.id || '—';
  return `<tr>
    <td>${escapeHtml(ws.slug)}</td>
    <td>${escapeHtml(t.state)}</td>
    <td>${escapeHtml(stepLabel)}</td>
    <td>${escapeHtml(t.lastUpdateAgo)}</td>
  </tr>`;
}

function renderRunCountsSection(runCountsByWorkspace) {
  const rows = [];
  for (const [slug, byDay] of Object.entries(runCountsByWorkspace)) {
    for (const [day, modes] of Object.entries(byDay)) {
      for (const [mode, count] of Object.entries(modes)) {
        rows.push(`<tr><td>${escapeHtml(slug)}</td><td>${escapeHtml(day)}</td><td>${escapeHtml(mode)}</td><td>${count}</td></tr>`);
      }
    }
  }
  return rows.join('\n');
}

function renderTokenUsageSection(tokenUsageByWorkspace) {
  const rows = [];
  for (const [slug, byDay] of Object.entries(tokenUsageByWorkspace)) {
    for (const [day, totals] of Object.entries(byDay)) {
      const total = totals.input_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens + totals.output_tokens;
      rows.push(`<tr><td>${escapeHtml(slug)}</td><td>${escapeHtml(day)}</td><td>${total.toLocaleString()}</td></tr>`);
    }
  }
  return rows.join('\n');
}

/**
 * Render a complete HTML document from a snapshot object. Pure function —
 * no filesystem or network access.
 *
 * @param {object} snapshot - From admin-overview-snapshot.mjs's buildSnapshot().
 * @returns {string}
 */
export function renderHtml(snapshot) {
  const activeTaskRows = snapshot.workspaces.map(renderActiveTaskRow).filter(Boolean).join('\n');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>career-ops admin overview</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fff; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
  th { background: #f5f5f5; }
  h2 { margin-top: 2rem; }
  .meta { color: #666; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>career-ops admin overview</h1>
<p class="meta">Generated ${escapeHtml(snapshot.generatedAt)}</p>

<h2>Workspaces</h2>
<table>
<tr><th>Slug</th><th>Display name</th><th>Created</th><th>Telegram-bound</th><th>Evaluated</th><th>Applied</th></tr>
${snapshot.workspaces.map(renderWorkspaceRow).join('\n')}
</table>

<h2>Active tasks</h2>
${activeTaskRows
    ? `<table><tr><th>Workspace</th><th>State</th><th>Step</th><th>Last update</th></tr>${activeTaskRows}</table>`
    : '<p>No workspace currently has an in-progress task.</p>'}

<h2>Token usage by day</h2>
<table>
<tr><th>Workspace</th><th>Day</th><th>Total tokens</th></tr>
${renderTokenUsageSection(snapshot.tokenUsageByWorkspace)}
</table>

<h2>Run counts by day</h2>
<table>
<tr><th>Workspace</th><th>Day</th><th>Mode</th><th>Count</th></tr>
${renderRunCountsSection(snapshot.runCountsByWorkspace)}
</table>
</body>
</html>`;
}

async function main() {
  const [, , snapshotPath, outPath] = process.argv;
  if (!snapshotPath || !outPath) {
    console.error('Usage: node admin-overview-render.mjs <snapshot.json> <output.html>');
    return 1;
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  const html = renderHtml(snapshot);
  writeFileSync(outPath, html, 'utf-8');
  console.log(`admin-overview-render: wrote ${outPath}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin-overview-render.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Add the privacy regression test, then run the full pair once more**

This is the one privacy-critical invariant worth its own dedicated test, per the Global Constraints: confirm the rendered HTML never contains a string that could only have come from a transcript's conversation content, even when the FULL pipeline (snapshot + render) runs against a real-shaped transcript containing such content.

Add to `tests/admin-overview-render.test.mjs`:

```js
test('end-to-end: rendering a snapshot built from a transcript with secret conversation content never leaks that content into the HTML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-overview-e2e-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'admin-overview-e2e-claude-'));
  try {
    const secretText = 'THIS-IS-PRIVATE-CONVERSATION-CONTENT-SHOULD-NEVER-APPEAR-IN-HTML';
    const wsDir = join(dir, 'workspaces', 'alice');
    mkdirSync(join(wsDir, 'data', 'cache'), { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({
      slug: 'alice', chat_id: '123', display_name: 'Alice', created_at: '2026-01-01',
    }));

    const prefix = dir.replace(/[:\\_]/g, '-');
    const transcriptDir = join(claudeHome, 'projects', `${prefix}-workspaces-alice`);
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, 'session.jsonl'), JSON.stringify({
      type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: secretText }] },
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
    }) + '\n');

    const snapshotPath = join(dir, 'snapshot.json');
    const outPath = join(dir, 'output.html');
    execFileSync(process.execPath, [
      join(REPO_ROOT, 'core', 'admin-overview-snapshot.mjs'), snapshotPath,
    ], { encoding: 'utf-8', env: { ...process.env, CAREER_OPS_ADMIN_OVERVIEW_REPO_ROOT: dir, CAREER_OPS_ADMIN_OVERVIEW_CLAUDE_HOME: claudeHome } });
    execFileSync(process.execPath, [
      join(REPO_ROOT, 'core', 'admin-overview-render.mjs'), snapshotPath, outPath,
    ], { encoding: 'utf-8' });

    const html = readFileSync(outPath, 'utf-8');
    assert.ok(!html.includes(secretText), 'PRIVACY VIOLATION: transcript conversation content leaked into rendered HTML');
    assert.match(html, /alice/); // sanity: the pipeline actually ran and found the workspace
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});
```

Add `mkdirSync` to the existing `node:fs` import line in `tests/admin-overview-render.test.mjs`.

Run: `node --test tests/admin-overview-render.test.mjs`
Expected: all tests pass, including the new end-to-end privacy test.

- [ ] **Step 6: Commit**

```bash
git add core/admin-overview-render.mjs tests/admin-overview-render.test.mjs
git commit -m "feat: add admin-overview-render.mjs with privacy-regression end-to-end test"
```

---

### Task 9: Scheduling setup + manual end-to-end verification

**Files:**
- Create: `docs/ADMIN_OVERVIEW.md`

**Interfaces:**
- None — this task is documentation plus a manual verification pass against the real hub. Nothing here is covered by automated tests; say so plainly rather than inventing a test for an inherently manual step.

- [ ] **Step 1: Write the setup documentation**

```markdown
# Admin Overview Artifact — Setup

Two scripts do all the work, zero LLM tokens:

```bash
node core/admin-overview-snapshot.mjs /tmp/admin-overview-snapshot.json
node core/admin-overview-render.mjs /tmp/admin-overview-snapshot.json /tmp/admin-overview.html
```

The first gathers workspace roster, tracker stats, active-task status, and
token-usage/run-count history (mined from `~/.claude/projects/`) into one
JSON file. The second turns that JSON into a complete HTML page. Neither
step needs Claude — they're both plain Node scripts.

## One-time: publish the artifact

In an interactive Claude Code session, run the two commands above, then ask
Claude to publish `/tmp/admin-overview.html` as an Artifact. Keep the
resulting URL — every future scheduled run redeploys to that same URL.

## Scheduled refresh (Windows Task Scheduler)

1. Open Task Scheduler → Create Task.
2. Trigger: whatever interval you want (e.g. every 30 minutes).
3. Action: Start a program.
   - Program: `claude`
   - Arguments:
     ```
     -p "[HEADLESS] This is a non-interactive, unattended invocation — no human is present to answer a question this turn, and there is no future turn to come back to: this is a single, one-shot invocation that ends when this response ends. Run `node core/admin-overview-snapshot.mjs .tmp/admin-overview-snapshot.json` then `node core/admin-overview-render.mjs .tmp/admin-overview-snapshot.json .tmp/admin-overview.html`, then republish the admin-overview Artifact (URL: <paste the URL from the one-time publish step above>) from the resulting .tmp/admin-overview.html file. Do not ask any questions. If either script fails, report the error in your final message and stop — do not attempt to publish a partial or fabricated snapshot."
     ```
   - Start in: the repo root (so the relative `.tmp/` paths resolve correctly).
4. If you use a subscription rather than an API key for this, generate a long-lived token once (`claude setup-token`) and set it as `CLAUDE_CODE_OAUTH_TOKEN` in the scheduled task's environment — see `docs/RUNNING_ON_A_BUDGET.md`'s "batch mode is the exception" section for why headless invocations need this.

## Known limitations (by design, not bugs)

- **Not truly real-time.** The page shows whatever was true as of the last scheduled run. If the machine is asleep or the task doesn't fire, the page goes stale — there's no live capability backing it.
- **Token-usage/run-count history only covers sessions launched with a workspace as the project root** (e.g. Telegram-triggered runs). Interactive hub-root sessions that happen to touch a workspace's files aren't attributed to that workspace's history.
- **Run classification is best-effort.** It's a keyword match against free-text prompt args, not a structured log — see the `unclassified` bucket in the rendered page for anything it couldn't confidently classify.
```

- [ ] **Step 2: Commit the documentation**

```bash
git add docs/ADMIN_OVERVIEW.md
git commit -m "docs: add admin overview setup + scheduling guide"
```

- [ ] **Step 3: Manual end-to-end verification (not an automated test — run this yourself and report the actual output)**

```bash
node core/admin-overview-snapshot.mjs /tmp/admin-overview-snapshot.json
node core/admin-overview-render.mjs /tmp/admin-overview-snapshot.json /tmp/admin-overview.html
```

Expected: both exit 0. Open `/tmp/admin-overview-snapshot.json` and confirm it lists all four real workspaces (`ernesto-vasquez`, `roberto-vasquez`, `leonie`, `thomas-acosta`) with plausible tracker-stat numbers (e.g. `ernesto-vasquez` should show `total: 47`, matching what `stats.mjs` reports directly). Open `/tmp/admin-overview.html` in a browser and confirm it renders sensibly. Do not claim this step passed without actually running it and looking at the output — this is exactly the kind of claim that needs evidence, not assumption.

- [ ] **Step 4: Run the full test suite**

Run: `node core/test-all.mjs`
Expected: every new test file passes, and nothing else regresses. (There may be one long-standing unrelated failure in `tests/telegram-poll.test.mjs` — a pre-existing environment issue, not caused by this work; confirm any failure you see is that specific one before treating the suite as green.)
