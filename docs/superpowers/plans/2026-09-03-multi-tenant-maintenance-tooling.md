# Multi-Tenant Maintenance Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator three small, manually-invoked tools that close the one real gap in the existing multi-tenancy architecture — per-workspace data files (`config/profile.yml`, `portals.yml`) that were seeded once from a template and never see later template improvements — plus a way to check every workspace's health at once and notify bound users of updates.

**Architecture:** Three independent `core/*.mjs` scripts, each following this codebase's existing script conventions (`// @ts-check`, `ROOT` computed from `import.meta.url`, `isMainModule()` main-guard, named exports for testability). All three reuse existing exports rather than re-deriving logic: `listWorkspaces()` from `core/admin-overview-snapshot.mjs`, `sendCannedReply()` from `core/telegram-monitor.mjs`, and `doctor.mjs`'s existing `--target`/`--json` flags (invoked as a subprocess, since `doctor.mjs` has no reusable export and always runs its CLI body at import time).

**Tech Stack:** Node.js (`.mjs`, ESM), `node:test` + `node:assert/strict` for tests (auto-discovered by `core/test-all.mjs`'s `tests/**/*.test.mjs` scan), the `yaml` package (new dependency) for comment-preserving YAML edits.

**Spec:** `docs/superpowers/specs/2026-09-03-multi-tenant-maintenance-tooling-design.md`

## Global Constraints

- Additive-only: the backfill tool never modifies or removes an existing key in a live file, regardless of its value (including `null`/`false`/`[]`).
- Comment preservation is mandatory for any write to `config/profile.yml` or `portals.yml` — use the `yaml` package's `Document` API (`parseDocument`/`getIn`/`setIn`/`clone`/`toString`), never `js-yaml`'s `dump()`, for these two files.
- All three tools are operator-invoked only. None is wired into a mode file, cron, CI, or any other automatic trigger.
- Every new script uses `isMainModule(import.meta.url)` (from `core/is-main.mjs`) as its main-guard — never a naive `import.meta.url === process.argv[1]` comparison, which silently breaks when a script is reached through a workspace's directory junction.
- `ROOT` in every new script is `dirname(dirname(fileURLToPath(import.meta.url)))` (the script lives in `core/`, one level below the repo root) — matches `provision-workspace.mjs`'s existing convention exactly.
- Test files live under `tests/` (plural), import from `node:test`, and need no manual registration — `core/test-all.mjs` discovers `tests/**/*.test.mjs` automatically.

---

## File Structure

- Create: `core/backfill-templates.mjs` — core diff/write logic + CLI for the template-drift backfill.
- Create: `tests/backfill-templates.test.mjs`
- Create: `core/doctor-all.mjs` — cross-workspace health-check aggregator (wraps `doctor.mjs` + `backfill-templates.mjs`).
- Create: `tests/doctor-all.test.mjs`
- Create: `core/broadcast.mjs` — operator broadcast tool wrapping `sendCannedReply`.
- Create: `tests/broadcast.test.mjs`
- Modify: `package.json` — add `yaml` dependency.
- Modify: `core/AGENTS.md` — add one-line Main Files table entries for the three new scripts (matching the existing `admin-overview-snapshot.mjs`/`admin-overview-render.mjs` rows' style).

---

### Task 1: `backfill-templates.mjs` core diff/write logic

**Files:**
- Create: `core/backfill-templates.mjs`
- Test: `tests/backfill-templates.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks (first task).
- Produces (for Task 2 and Task 3 to consume):
  - `export const TEMPLATE_PAIRS: { live: string, template: string }[]` — workspace-relative live path + repo-root-relative template path, for `config/profile.yml`/`config/profile.example.yml` and `portals.yml`/`templates/portals.example.yml`.
  - `export function findMissingKeyPaths(templateNode, liveNode, path = []): string[][]`
  - `export function checkFile(liveFilePath: string, templateFilePath: string): { missing: string[][], error: string|null }`
  - `export function applyFile(liveFilePath: string, templateFilePath: string): string[][]` (returns paths written)
  - `export function checkWorkspace(wsDir: string, reposRoot?: string): { file: string, missing: string[][], error: string|null }[]`
  - `export function applyWorkspace(wsDir: string, reposRoot?: string): { file: string, written: string[][] }[]`

- [ ] **Step 1: Install the `yaml` package**

Run: `npm install yaml`

Verify `package.json` now lists `yaml` under `"dependencies"`.

- [ ] **Step 2: Write the failing tests for `findMissingKeyPaths`, `checkFile`, `applyFile`**

Create `tests/backfill-templates.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { findMissingKeyPaths, checkFile, applyFile } from '../core/backfill-templates.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-templates-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('findMissingKeyPaths finds a top-level key missing from the live doc', () => {
  const template = parseDocument('a: 1\nb: 2\n');
  const live = parseDocument('a: 1\n');
  const missing = findMissingKeyPaths(template.contents, live.contents);
  assert.deepEqual(missing, [['b']]);
});

test('findMissingKeyPaths finds a nested key missing without recursing past the missing point', () => {
  const template = parseDocument('narrative:\n  superpowers: []\n  deal_breakers: []\n');
  const live = parseDocument('narrative:\n  superpowers: []\n');
  const missing = findMissingKeyPaths(template.contents, live.contents);
  assert.deepEqual(missing, [['narrative', 'deal_breakers']]);
});

test('findMissingKeyPaths reports a whole missing subtree as one path, not per-leaf', () => {
  const template = parseDocument('location:\n  country: US\n  work_mode: remote\n');
  const live = parseDocument('a: 1\n');
  const missing = findMissingKeyPaths(template.contents, live.contents);
  assert.deepEqual(missing, [['location']]);
});

test('findMissingKeyPaths returns empty when live already has everything the template has', () => {
  const template = parseDocument('a: 1\nb: 2\n');
  const live = parseDocument('a: 1\nb: 2\nc: 3\n'); // live can have EXTRA keys, that is fine
  const missing = findMissingKeyPaths(template.contents, live.contents);
  assert.deepEqual(missing, []);
});

test('findMissingKeyPaths treats an existing falsy value as present, not missing', () => {
  const template = parseDocument('a: 1\n');
  const live = parseDocument('a: false\n');
  const missing = findMissingKeyPaths(template.contents, live.contents);
  assert.deepEqual(missing, []);
});

test('checkFile reports missing paths without writing anything', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: 1\n');
    writeFileSync(templatePath, 'a: 1\nb: 2\n');
    const before = readFileSync(livePath, 'utf8');
    const result = checkFile(livePath, templatePath);
    assert.deepEqual(result.missing, [['b']]);
    assert.equal(result.error, null);
    assert.equal(readFileSync(livePath, 'utf8'), before);
  });
});

test('checkFile returns no missing/no error when either file does not exist', () => {
  withTempDir((dir) => {
    const result = checkFile(join(dir, 'nope.yml'), join(dir, 'also-nope.yml'));
    assert.deepEqual(result.missing, []);
    assert.equal(result.error, null);
  });
});

test('checkFile reports a parse error instead of throwing on malformed YAML', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: [1, 2\n'); // unterminated flow sequence
    writeFileSync(templatePath, 'a: 1\n');
    const result = checkFile(livePath, templatePath);
    assert.deepEqual(result.missing, []);
    assert.ok(result.error);
  });
});

test('applyFile adds a missing top-level key and leaves existing content untouched', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: 1\n');
    writeFileSync(templatePath, 'a: 1\nb: 2\n');
    const written = applyFile(livePath, templatePath);
    assert.deepEqual(written, [['b']]);
    const result = parseDocument(readFileSync(livePath, 'utf8')).toJS();
    assert.deepEqual(result, { a: 1, b: 2 });
  });
});

test('applyFile adds a missing nested key under an existing parent, keeping sibling keys', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'narrative:\n  superpowers: [foo]\n');
    writeFileSync(templatePath, 'narrative:\n  superpowers: []\n  deal_breakers: [bar]\n');
    applyFile(livePath, templatePath);
    const result = parseDocument(readFileSync(livePath, 'utf8')).toJS();
    assert.deepEqual(result, { narrative: { superpowers: ['foo'], deal_breakers: ['bar'] } });
  });
});

test('applyFile never modifies an existing key, even one with a falsy value', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: false\nb: []\n');
    writeFileSync(templatePath, 'a: true\nb: [1, 2]\nc: 3\n');
    const written = applyFile(livePath, templatePath);
    assert.deepEqual(written, [['c']]);
    const result = parseDocument(readFileSync(livePath, 'utf8')).toJS();
    assert.deepEqual(result, { a: false, b: [], c: 3 });
  });
});

test('applyFile is idempotent — a second run finds nothing left to add', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: 1\n');
    writeFileSync(templatePath, 'a: 1\nb: 2\n');
    applyFile(livePath, templatePath);
    const secondRun = applyFile(livePath, templatePath);
    assert.deepEqual(secondRun, []);
  });
});

test('applyFile preserves the live file\'s pre-existing comments byte-for-byte outside the inserted key', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, '# a real user comment explaining this field\na: 1\n');
    writeFileSync(templatePath, '# a real user comment explaining this field\na: 1\n# template docs for b\nb: 2\n');
    applyFile(livePath, templatePath);
    const after = readFileSync(livePath, 'utf8');
    assert.match(after, /# a real user comment explaining this field/);
    assert.match(after, /# template docs for b/);
  });
});

test('applyFile makes no write at all when nothing is missing', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: 1\n');
    writeFileSync(templatePath, 'a: 1\n');
    const before = readFileSync(livePath, 'utf8');
    const written = applyFile(livePath, templatePath);
    assert.deepEqual(written, []);
    assert.equal(readFileSync(livePath, 'utf8'), before);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/backfill-templates.test.mjs`
Expected: FAIL with "Cannot find module '../core/backfill-templates.mjs'" (file doesn't exist yet).

- [ ] **Step 4: Implement `core/backfill-templates.mjs`'s core logic**

```js
// @ts-check
// backfill-templates.mjs — additively syncs new fields from
// config/profile.example.yml and templates/portals.example.yml into an
// already-provisioned workspace's real config/profile.yml and portals.yml.
// Never modifies or removes an existing key, regardless of its value.
//
// Uses the `yaml` package's Document API (not js-yaml's dump()) because
// config/profile.example.yml is 75% comments and templates/portals.example.yml
// is 42% comments — a parse-then-dump round-trip would silently delete all
// of it. See docs/superpowers/specs/2026-09-03-multi-tenant-maintenance-tooling-design.md.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, isMap } from 'yaml';
import { isMainModule } from './is-main.mjs';
import { listWorkspaces } from './admin-overview-snapshot.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // core/'s parent = repo root

export const TEMPLATE_PAIRS = [
  { live: 'config/profile.yml', template: 'config/profile.example.yml' },
  { live: 'portals.yml', template: 'templates/portals.example.yml' },
];

/**
 * Key paths present in templateNode but absent from liveNode. Stops at the
 * shallowest missing point — a whole missing subtree is returned as one
 * path, never rebuilt key-by-key.
 * @param {import('yaml').Node} templateNode
 * @param {import('yaml').Node} liveNode
 * @param {string[]} path
 * @returns {string[][]}
 */
export function findMissingKeyPaths(templateNode, liveNode, path = []) {
  const missing = [];
  if (!isMap(templateNode)) return missing;
  for (const item of templateNode.items) {
    const key = /** @type {any} */ (item.key).value;
    const childPath = [...path, key];
    if (!isMap(liveNode) || !liveNode.has(key)) {
      missing.push(childPath);
    } else {
      missing.push(...findMissingKeyPaths(item.value, liveNode.get(key, true), childPath));
    }
  }
  return missing;
}

/**
 * Compare one (live, template) file pair. Never throws — a missing file or
 * a parse error is reported in the return value.
 * @returns {{ missing: string[][], error: string|null }}
 */
export function checkFile(liveFilePath, templateFilePath) {
  if (!existsSync(liveFilePath) || !existsSync(templateFilePath)) {
    return { missing: [], error: null };
  }
  let liveDoc, templateDoc;
  try {
    liveDoc = parseDocument(readFileSync(liveFilePath, 'utf8'));
    templateDoc = parseDocument(readFileSync(templateFilePath, 'utf8'));
  } catch (err) {
    return { missing: [], error: /** @type {Error} */ (err).message };
  }
  if (liveDoc.errors.length > 0) return { missing: [], error: String(liveDoc.errors[0]) };
  if (templateDoc.errors.length > 0) return { missing: [], error: String(templateDoc.errors[0]) };
  return { missing: findMissingKeyPaths(templateDoc.contents, liveDoc.contents), error: null };
}

/**
 * Write every missing key path from `checkFile` into the live file, cloned
 * from the template so its attached comments move along with it. No-op
 * (no write at all) when nothing is missing.
 * @returns {string[][]} paths written
 */
export function applyFile(liveFilePath, templateFilePath) {
  const { missing, error } = checkFile(liveFilePath, templateFilePath);
  if (error || missing.length === 0) return [];
  const liveDoc = parseDocument(readFileSync(liveFilePath, 'utf8'));
  const templateDoc = parseDocument(readFileSync(templateFilePath, 'utf8'));
  for (const path of missing) {
    const node = templateDoc.getIn(path, true);
    liveDoc.setIn(path, node && typeof (/** @type {any} */ (node).clone) === 'function' ? /** @type {any} */ (node).clone() : node);
  }
  writeFileSync(liveFilePath, liveDoc.toString());
  return missing;
}

/** @returns {{ file: string, missing: string[][], error: string|null }[]} */
export function checkWorkspace(wsDir, reposRoot = ROOT) {
  return TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    ...checkFile(join(wsDir, live), join(reposRoot, template)),
  }));
}

/** @returns {{ file: string, written: string[][] }[]} */
export function applyWorkspace(wsDir, reposRoot = ROOT) {
  return TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    written: applyFile(join(wsDir, live), join(reposRoot, template)),
  }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/backfill-templates.test.mjs`
Expected: PASS (all cases from Step 2)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json core/backfill-templates.mjs tests/backfill-templates.test.mjs
git commit -m "feat: add backfill-templates.mjs core diff/write logic

Additive-only sync of new config/profile.example.yml and
templates/portals.example.yml fields into an already-provisioned
workspace's real files, using the yaml package's Document API so
existing comments and untouched keys survive byte-for-byte."
```

---

### Task 2: `backfill-templates.mjs` CLI

**Files:**
- Modify: `core/backfill-templates.mjs`
- Modify: `tests/backfill-templates.test.mjs`

**Interfaces:**
- Consumes: `TEMPLATE_PAIRS`, `checkWorkspace`, `applyWorkspace` (Task 1); `listWorkspaces(reposRoot)` from `core/admin-overview-snapshot.mjs` (existing, returns `{slug, displayName, chatId, createdAt, dir}[]`).
- Produces (for Task 3 to consume): the CLI itself is not imported by other tasks — Task 3 imports `checkWorkspace` directly (already produced by Task 1).

- [ ] **Step 1: Write the failing CLI tests**

Append to `tests/backfill-templates.test.mjs`:

```js
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Matches the established pattern in tests/doctor-workspace-isolation.test.mjs
// and tests/doctor-template-leftovers.test.mjs: join() off a REPO_ROOT
// resolved via fileURLToPath, not a raw file:// URL pathname (which carries
// a leading "/" before the drive letter on Windows, e.g. "/C:/Users/...").
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO_ROOT, 'core', 'backfill-templates.mjs');

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
    return { stdout, status: 0 };
  } catch (err) {
    return { stdout: err.stdout?.toString() ?? '', status: err.status };
  }
}

test('CLI --check reports missing fields and exits 1 when something is missing', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'workspaces', 'alice', 'config'), { recursive: true });
    writeFileSync(join(dir, 'workspaces', 'alice', 'config', 'profile.yml'), 'a: 1\n');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'profile.example.yml'), 'a: 1\nb: 2\n');
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'portals.example.yml'), 'x: 1\n');

    const { stdout, status } = runCli(['alice', '--check', '--json', '--repos-root', dir]);
    const [result] = JSON.parse(stdout);
    assert.equal(result.slug, 'alice');
    assert.ok(result.files.find((f) => f.file === 'config/profile.yml').missing.length > 0);
    assert.equal(status, 1);
  });
});

test('CLI --apply writes missing fields and exits 0', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'workspaces', 'alice', 'config'), { recursive: true });
    writeFileSync(join(dir, 'workspaces', 'alice', 'config', 'profile.yml'), 'a: 1\n');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'profile.example.yml'), 'a: 1\nb: 2\n');
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'portals.example.yml'), 'x: 1\n');

    const { status } = runCli(['alice', '--apply', '--repos-root', dir]);
    assert.equal(status, 0);
    const after = readFileSync(join(dir, 'workspaces', 'alice', 'config', 'profile.yml'), 'utf8');
    assert.match(after, /b: 2/);
  });
});

test('CLI --all --check --json covers every workspace via listWorkspaces()', () => {
  withTempDir((dir) => {
    for (const slug of ['alice', 'bob']) {
      mkdirSync(join(dir, 'workspaces', slug, 'config'), { recursive: true });
      writeFileSync(join(dir, 'workspaces', slug, 'config', 'profile.yml'), 'a: 1\n');
      writeFileSync(join(dir, 'workspaces', slug, 'workspace.json'), JSON.stringify({ slug }));
    }
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'profile.example.yml'), 'a: 1\nb: 2\n');
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'portals.example.yml'), 'x: 1\n');

    const { stdout } = runCli(['--all', '--check', '--json', '--repos-root', dir]);
    const results = JSON.parse(stdout);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.slug).sort(), ['alice', 'bob']);
  });
});

test('CLI reports an unknown slug without crashing', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'workspaces'), { recursive: true });
    const { stdout, status } = runCli(['ghost', '--check', '--json', '--repos-root', dir]);
    const [result] = JSON.parse(stdout);
    assert.ok(result.error);
    assert.equal(status, 1);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test tests/backfill-templates.test.mjs`
Expected: FAIL — CLI does not yet parse `--check`/`--apply`/`--all`/`--repos-root`/`--json` (usage error or crash).

- [ ] **Step 3: Add the CLI to `core/backfill-templates.mjs`**

Append to the bottom of `core/backfill-templates.mjs` (after the exports from Task 1):

```js
function formatPath(path) {
  return path.join('.');
}

function resolveTargets(argv, reposRoot) {
  if (argv.includes('--all')) {
    return listWorkspaces(reposRoot).map((w) => ({ slug: w.slug, dir: w.dir }));
  }
  const slug = argv.find((a) => !a.startsWith('--') && a !== reposRoot);
  if (!slug) return null;
  return [{ slug, dir: join(reposRoot, 'workspaces', slug) }];
}

async function main() {
  const argv = process.argv.slice(2);
  const rootIdx = argv.indexOf('--repos-root');
  const reposRoot = rootIdx !== -1 ? argv[rootIdx + 1] : ROOT;
  const cleanArgv = rootIdx !== -1 ? argv.filter((a, i) => i !== rootIdx && i !== rootIdx + 1) : argv;
  const jsonOut = cleanArgv.includes('--json');
  const apply = cleanArgv.includes('--apply');

  const targets = resolveTargets(cleanArgv, reposRoot);
  if (!targets) {
    console.error('Usage: node core/backfill-templates.mjs <slug> [--check|--apply] [--json] | --all [--check|--apply] [--json]');
    process.exit(1);
  }

  const results = targets.map(({ slug, dir }) => {
    if (!existsSync(dir)) return { slug, error: `no such workspace: ${slug}`, files: [] };
    const files = apply ? applyWorkspace(dir, reposRoot) : checkWorkspace(dir, reposRoot);
    return { slug, error: null, files };
  });

  const anyIssue = results.some((r) => r.error || r.files.some((f) => (f.missing || []).length > 0 || f.error));

  if (jsonOut) {
    console.log(JSON.stringify(results));
  } else {
    for (const r of results) {
      if (r.error) { console.log(`${r.slug}: ${r.error}`); continue; }
      const parts = r.files
        .filter((f) => (f.missing || []).length > 0)
        .map((f) => `${f.file} missing ${f.missing.map(formatPath).join(', ')}`);
      console.log(parts.length ? `${r.slug}: ${parts.join('; ')}` : `${r.slug}: up to date`);
    }
  }
  if (!apply && anyIssue) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ backfill-templates: ${err.message}`);
    process.exit(1);
  });
}
```

Note: `applyFile`'s return (`written`) is exposed under the same `missing` key name as `checkFile` when running in `--apply` mode is NOT the case — `applyWorkspace` returns `{ file, written }`, not `{ file, missing }`. Fix the CLI's `--apply` JSON branch to read `f.written` instead of `f.missing` for the `anyIssue`/human-readable parts when `apply` is true:

```js
  const anyIssue = results.some((r) => r.error || r.files.some((f) => ((apply ? f.written : f.missing) || []).length > 0 || f.error));
```

and in the human-readable branch:

```js
      const parts = r.files
        .filter((f) => ((apply ? f.written : f.missing) || []).length > 0)
        .map((f) => `${f.file} ${apply ? 'wrote' : 'missing'} ${(apply ? f.written : f.missing).map(formatPath).join(', ')}`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/backfill-templates.test.mjs`
Expected: PASS (all Task 1 + Task 2 cases)

- [ ] **Step 5: Commit**

```bash
git add core/backfill-templates.mjs tests/backfill-templates.test.mjs
git commit -m "feat: add backfill-templates.mjs CLI (--check/--apply, single slug or --all)"
```

---

### Task 3: `doctor-all.mjs` cross-workspace health check

**Files:**
- Create: `core/doctor-all.mjs`
- Test: `tests/doctor-all.test.mjs`

**Interfaces:**
- Consumes: `listWorkspaces(reposRoot)` from `core/admin-overview-snapshot.mjs`; `checkWorkspace(wsDir, reposRoot)` from `core/backfill-templates.mjs` (Task 1); `node core/doctor.mjs --json --target <dir>` invoked as a subprocess (existing script, unchanged — `doctor.mjs` has no reusable export and always runs its CLI body at import time, so it cannot be imported directly).
- Produces: nothing consumed by later tasks — this is the last consumer in the chain.

- [ ] **Step 1: Write the failing tests**

Create `tests/doctor-all.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, checkAllWorkspaces } from '../core/doctor-all.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-all-'));
  try {
    // doctor.mjs and its own template reads (config/profile.example.yml,
    // templates/portals.example.yml, modes/_profile.template.md,
    // modes/_brief.template.md) resolve off doctor.mjs's OWN real location,
    // not off --target — so the real repo's core/, config/, templates/,
    // modes/ must be reachable. Point doctor.mjs at the real files by
    // running it from the real REPO_ROOT and only pointing --target at the
    // fixture workspace directory (this is exactly how doctor.mjs is used
    // against a real workspaces/{slug}/ dir in production).
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('runDoctor returns parsed JSON for a workspace missing every prerequisite', () => {
  withTempRepo((dir) => {
    const wsDir = join(dir, 'empty-workspace');
    mkdirSync(wsDir, { recursive: true });
    const { doctor, error } = runDoctor(wsDir, REPO_ROOT);
    assert.equal(error, null);
    assert.equal(doctor.onboardingNeeded, true);
    assert.ok(doctor.missing.includes('cv.md'));
  });
});

test('runDoctor reports an error instead of throwing when doctor.mjs cannot run', () => {
  const { doctor, error } = runDoctor('/definitely/does/not/exist', '/also/does/not/exist');
  assert.equal(doctor, null);
  assert.ok(error);
});

test('checkAllWorkspaces marks a workspace unhealthy when doctor.mjs reports onboardingNeeded', () => {
  withTempRepo((dir) => {
    const wsDir = join(dir, 'workspaces', 'incomplete');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ slug: 'incomplete' }));

    const results = checkAllWorkspaces(dir, REPO_ROOT);
    assert.equal(results.length, 1);
    assert.equal(results[0].slug, 'incomplete');
    assert.equal(results[0].healthy, false);
    assert.equal(results[0].doctor.onboardingNeeded, true);
  });
});

test('checkAllWorkspaces one broken workspace does not suppress the others', () => {
  withTempRepo((dir) => {
    for (const slug of ['broken', 'other']) {
      const wsDir = join(dir, 'workspaces', slug);
      mkdirSync(wsDir, { recursive: true });
      writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ slug }));
    }
    const results = checkAllWorkspaces(dir, REPO_ROOT);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.slug).sort(), ['broken', 'other']);
  });
});

test('checkAllWorkspaces includes template-drift findings from backfill-templates.mjs', () => {
  withTempRepo((dir) => {
    const wsDir = join(dir, 'workspaces', 'drifted');
    mkdirSync(join(wsDir, 'config'), { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ slug: 'drifted' }));
    // A profile.yml missing a field that config/profile.example.yml (real
    // repo file) has — real repo template, so this WILL show drift.
    writeFileSync(join(wsDir, 'config', 'profile.yml'), 'candidate:\n  name: Test\n');

    const results = checkAllWorkspaces(dir, REPO_ROOT);
    const [result] = results;
    assert.ok(result.drift.some((d) => d.file === 'config/profile.yml' && d.missing.length > 0));
    assert.equal(result.healthy, false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/doctor-all.test.mjs`
Expected: FAIL with "Cannot find module '../core/doctor-all.mjs'"

- [ ] **Step 3: Implement `core/doctor-all.mjs`**

```js
// @ts-check
// doctor-all.mjs — runs doctor.mjs's prerequisite/leftover check AND
// backfill-templates.mjs's template-drift check against every provisioned
// workspace in one pass, so a broken or out-of-date workspace is caught
// before its user hits it. Purely observational — never writes anything;
// applying a fix stays a deliberate `backfill-templates.mjs --apply` call.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';
import { listWorkspaces } from './admin-overview-snapshot.mjs';
import { checkWorkspace } from './backfill-templates.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Run `node core/doctor.mjs --json --target <dir>` and parse its output.
 * Never throws — a crash or non-JSON output is reported as { error }.
 * @returns {{ doctor: object|null, error: string|null }}
 */
export function runDoctor(dir, reposRoot = ROOT) {
  try {
    const out = execFileSync('node', [join(reposRoot, 'core', 'doctor.mjs'), '--json', '--target', dir], { encoding: 'utf8' });
    return { doctor: JSON.parse(out), error: null };
  } catch (err) {
    return { doctor: null, error: /** @type {Error} */ (err).message };
  }
}

/**
 * @returns {{ slug: string, healthy: boolean, doctor: object|null, drift: object[], error: string|null }[]}
 */
export function checkAllWorkspaces(workspacesRoot = ROOT, reposRoot = ROOT) {
  return listWorkspaces(workspacesRoot).map(({ slug, dir }) => {
    const { doctor, error: doctorError } = runDoctor(dir, reposRoot);
    let drift = [];
    let driftError = null;
    try {
      drift = checkWorkspace(dir, reposRoot).filter((f) => f.missing.length > 0 || f.error);
    } catch (err) {
      driftError = /** @type {Error} */ (err).message;
    }
    const error = doctorError || driftError || null;
    const healthy = !error
      && Boolean(doctor)
      && !doctor.onboardingNeeded
      && doctor.templateLeftovers.length === 0
      && drift.length === 0;
    return { slug, healthy, doctor, drift, error };
  });
}

function summarize(results) {
  const healthyCount = results.filter((r) => r.healthy).length;
  const unhealthy = results.filter((r) => !r.healthy);
  const summary = `${healthyCount}/${results.length} workspaces healthy`;
  return unhealthy.length === 0 ? summary : `${summary} — needs attention: ${unhealthy.map((r) => r.slug).join(', ')}`;
}

async function main() {
  const jsonOut = process.argv.includes('--json');
  const results = checkAllWorkspaces();
  if (jsonOut) {
    console.log(JSON.stringify({ workspaces: results, summary: summarize(results) }));
  } else {
    for (const r of results) {
      if (r.error) { console.log(`${r.slug}: ERROR — ${r.error}`); continue; }
      if (r.healthy) { console.log(`${r.slug}: ok`); continue; }
      const issues = [];
      if (r.doctor?.onboardingNeeded) issues.push(`missing: ${r.doctor.missing.join(', ')}`);
      if (r.doctor?.templateLeftovers?.length) issues.push(`${r.doctor.templateLeftovers.length} template-leftover warning(s)`);
      if (r.drift.length) issues.push(`template drift in ${r.drift.map((d) => d.file).join(', ')}`);
      console.log(`${r.slug}: ${issues.join('; ')}`);
    }
    console.log(summarize(results));
  }
  if (results.some((r) => !r.healthy)) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ doctor-all: ${err.message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/doctor-all.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/doctor-all.mjs tests/doctor-all.test.mjs
git commit -m "feat: add doctor-all.mjs cross-workspace health-check aggregator"
```

---

### Task 4: `broadcast.mjs` operator broadcast tool

**Files:**
- Create: `core/broadcast.mjs`
- Test: `tests/broadcast.test.mjs`

**Interfaces:**
- Consumes: `listWorkspaces(reposRoot)` from `core/admin-overview-snapshot.mjs`; `sendCannedReply(chatId, text, hook?)` from `core/telegram-monitor.mjs` (existing export, signature confirmed at `core/telegram-monitor.mjs:404`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Create `tests/broadcast.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { broadcast } from '../core/broadcast.mjs';

// `fn` is async here (unlike Task 1's/Task 3's sync `withTempDir`/`withTempRepo`
// helpers) — the `finally` must `await` it, otherwise rmSync would delete the
// temp dir before the async test body actually runs its assertions.
async function withTempRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'broadcast-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedWorkspace(root, slug, chatId) {
  const wsDir = join(root, 'workspaces', slug);
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ slug, chat_id: chatId }));
}

test('broadcast sends to every workspace with a bound chat_id', async () => {
  await withTempRoot(async (dir) => {
    seedWorkspace(dir, 'alice', '111');
    seedWorkspace(dir, 'bob', '222');
    const sentCalls = [];
    const send = async (chatId, text) => { sentCalls.push({ chatId, text }); };

    const { sent, skipped } = await broadcast('hello', { reposRoot: dir, send });
    assert.equal(sentCalls.length, 2);
    assert.deepEqual(sentCalls.map((c) => c.chatId).sort(), ['111', '222']);
    assert.equal(sent.length, 2);
    assert.equal(skipped.length, 0);
  });
});

test('broadcast skips a workspace with no chat_id bound yet, without erroring', async () => {
  await withTempRoot(async (dir) => {
    seedWorkspace(dir, 'alice', '111');
    seedWorkspace(dir, 'pending', null);
    const sentCalls = [];
    const send = async (chatId, text) => { sentCalls.push({ chatId, text }); };

    const { sent, skipped } = await broadcast('hello', { reposRoot: dir, send });
    assert.equal(sentCalls.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].slug, 'pending');
  });
});

test('broadcast --dry-run (dryRun: true) sends nothing', async () => {
  await withTempRoot(async (dir) => {
    seedWorkspace(dir, 'alice', '111');
    const sentCalls = [];
    const send = async (chatId, text) => { sentCalls.push({ chatId, text }); };

    const { sent } = await broadcast('hello', { reposRoot: dir, send, dryRun: true });
    assert.equal(sentCalls.length, 0);
    assert.equal(sent.length, 1); // reported as "would send" without calling send()
  });
});

test('broadcast continues to the next workspace if one send fails', async () => {
  await withTempRoot(async (dir) => {
    seedWorkspace(dir, 'alice', '111');
    seedWorkspace(dir, 'bob', '222');
    const send = async (chatId) => {
      if (chatId === '111') throw new Error('telegram down');
    };

    const { sent, skipped } = await broadcast('hello', { reposRoot: dir, send });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, '222');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].slug, 'alice');
    assert.match(skipped[0].reason, /telegram down/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/broadcast.test.mjs`
Expected: FAIL with "Cannot find module '../core/broadcast.mjs'"

- [ ] **Step 3: Implement `core/broadcast.mjs`**

```js
// @ts-check
// broadcast.mjs — operator tool to notify every bound Telegram user of a
// system update worth telling them about. Reuses the existing
// sendCannedReply() send path (already proven for the wrong-code/lockout
// case in telegram-monitor.mjs) rather than adding a new send mechanism.
// Manually invoked only — never wired into a mode file, cron, or CI.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';
import { listWorkspaces } from './admin-overview-snapshot.mjs';
import { sendCannedReply } from './telegram-monitor.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Send `text` to every provisioned workspace's bound chat_id.
 * @param {string} text
 * @param {{ reposRoot?: string, send?: (chatId: string, text: string) => Promise<void>, dryRun?: boolean }} [opts]
 * @returns {Promise<{ sent: {slug: string, chatId: string}[], skipped: {slug: string, reason: string}[] }>}
 */
export async function broadcast(text, opts = {}) {
  const { reposRoot = ROOT, send = sendCannedReply, dryRun = false } = opts;
  const workspaces = listWorkspaces(reposRoot);
  const sent = [];
  const skipped = [];
  for (const ws of workspaces) {
    if (!ws.chatId) {
      skipped.push({ slug: ws.slug, reason: 'no chat_id bound yet' });
      continue;
    }
    if (dryRun) {
      sent.push({ slug: ws.slug, chatId: ws.chatId });
      continue;
    }
    try {
      await send(ws.chatId, text);
      sent.push({ slug: ws.slug, chatId: ws.chatId });
    } catch (err) {
      skipped.push({ slug: ws.slug, reason: /** @type {Error} */ (err).message });
    }
  }
  return { sent, skipped };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const text = argv.filter((a) => a !== '--dry-run').join(' ');
  if (!text.trim()) {
    console.error('Usage: node core/broadcast.mjs "message text" [--dry-run]');
    process.exit(1);
  }
  const { sent, skipped } = await broadcast(text, { dryRun });
  console.log(`${dryRun ? 'Would send' : 'Sent'} to ${sent.length} workspace(s): ${sent.map((s) => s.slug).join(', ') || '(none)'}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length}: ${skipped.map((s) => `${s.slug} (${s.reason})`).join(', ')}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ broadcast: ${err.message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/broadcast.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/broadcast.mjs tests/broadcast.test.mjs
git commit -m "feat: add broadcast.mjs operator tool for notifying bound Telegram users"
```

---

### Task 5: Documentation and full suite verification

**Files:**
- Modify: `core/AGENTS.md`

**Interfaces:**
- Consumes: nothing new — this task only documents what Tasks 1-4 already built.
- Produces: nothing — terminal task.

- [ ] **Step 1: Add Main Files table rows**

In `core/AGENTS.md`, in the Main Files table, immediately after the existing `admin-overview-render.mjs` row, add:

```markdown
| `backfill-templates.mjs` | Additive-only sync of new `config/profile.example.yml`/`templates/portals.example.yml` fields into an already-provisioned workspace's real `config/profile.yml`/`portals.yml`, using the `yaml` package so existing comments survive — `node core/backfill-templates.mjs <slug\|--all> --check\|--apply [--json]` |
| `doctor-all.mjs` | Cross-workspace health check — runs `doctor.mjs` plus `backfill-templates.mjs --check` against every provisioned workspace in one pass so a broken or out-of-date workspace is caught before its user hits it (JSON or plain-text summary); purely observational, never writes |
| `broadcast.mjs` | Operator tool to notify every bound Telegram user of a system update worth telling them about, reusing the existing `sendCannedReply` send path — `node core/broadcast.mjs "message" [--dry-run]` |
```

- [ ] **Step 2: Manual end-to-end verification against the real 4 workspaces (not an automated test — run this yourself and report the actual output)**

All three commands below are read-only / dry-run against real production data — safe to run as-is.

```bash
node core/doctor-all.mjs
node core/backfill-templates.mjs --all --check
node core/broadcast.mjs "test message — verifying broadcast.mjs works" --dry-run
```

Expected: `doctor-all.mjs` prints one line per real workspace (`ernesto-vasquez`, `leonie`, `roberto-vasquez`, `thomas-acosta`) plus a summary line; `backfill-templates.mjs --all --check` reports `up to date` for all four (no template field has changed since their onboarding, so zero drift is the correct result — this also doubles as the regression check that the tool works correctly on real data); `broadcast.mjs --dry-run` lists all four workspaces under "Would send" with none actually skipped (all four have a bound `chat_id`). Do not claim this step passed without actually running it and looking at the output.

- [ ] **Step 3: Run the full test suite**

Run: `node core/test-all.mjs`
Expected: all suites pass, including the three new `tests/*.test.mjs` files (auto-discovered — no manual registration needed).

- [ ] **Step 4: Commit**

```bash
git add core/AGENTS.md
git commit -m "docs: add Main Files entries for backfill-templates/doctor-all/broadcast"
```
