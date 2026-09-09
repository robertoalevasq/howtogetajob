# Apply-Mode Playwright Delegation Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it structurally impossible for career-ops' main Claude Code session to drive mutating Playwright interactions directly (the bug burning 13M-53M tokens per apply session across four workspaces), and make sure the fix — and any future `.claude/settings.json` change — actually reaches every provisioned workspace without anyone having to remember to check.

**Architecture:** A `PreToolUse` hook (`core/hooks/guard-playwright-delegation.mjs`) blocks mutating Playwright tool calls when Claude Code's hook payload has no `agent_id` (main session) and allows them when it does (delegated subagent) — verified to work regardless of settings.json pre-approval, since `PreToolUse` runs before the permission system. `core/backfill-templates.mjs` gains a JSON-diff sync target for `.claude/settings.json` (its existing YAML sync targets are untouched), and `core/test-all.mjs` gains a CI-enforced drift guard using that new capability, so a future settings.json change that isn't propagated to every workspace fails the build automatically.

**Tech Stack:** Node.js `.mjs` (no framework), `node:test`/`node:assert/strict` for unit tests, plain JSON (no `yaml` package needed for this part — that stays scoped to the existing profile.yml/portals.yml sync).

**Spec:** `docs/superpowers/specs/2026-09-08-apply-playwright-delegation-guard-design.md`

## Global Constraints

- Matcher scope is exactly these 8 tool names, never more, never fewer: `mcp__playwright__browser_click`, `mcp__playwright__browser_type`, `mcp__playwright__browser_fill_form`, `mcp__playwright__browser_press_key`, `mcp__playwright__browser_select_option`, `mcp__playwright__browser_drag`, `mcp__playwright__browser_drop`, `mcp__playwright__browser_file_upload`. Never `browser_navigate`/`browser_snapshot`/`browser_wait_for`/`browser_close`/`browser_find`/`browser_evaluate`/`browser_tabs` — those must keep working directly from the main session.
- The hook fails OPEN (allow, exit 0) on any error reading or parsing its own stdin — a bug in the guard script must never brick apply mode. Only a successfully-parsed payload with a falsy `agent_id` gets denied.
- Never touch the user's global `~/.claude/settings.json` — every change in this plan is scoped to the career-ops repo (root `.claude/settings.json` and per-workspace copies) or to career-ops' own `core/`/`tests/` files.
- `backfill-templates.mjs`'s existing YAML behavior (`TEMPLATE_PAIRS`, `findMissingKeyPaths`, `checkFile`, `applyFile`) must not change — the new JSON support is additive, a parallel code path, not a modification of the YAML one.
- All new file-sync logic is additive-only: never overwrite or remove an existing value in a workspace's live file, whether YAML or JSON.
- **CORRECTED during Task 3 (see its ledger entry):** `workspaces/*` is entirely gitignored (only `workspaces/.gitkeep` is tracked) — GitHub Actions CI and any fresh worktree/clone ALWAYS see zero workspaces, by design, not as an edge case. The new `test-all.mjs` drift guard must therefore treat "zero workspaces found" as a clean PASS with an explicit skip note (never a silent pass, but also never a failure) — it is a local safety net that only enforces drift when the suite runs somewhere with real workspace data present, unlike the `SYSTEM_PATHS coverage guard`, which legitimately can fail on zero because tracked files always exist in a real checkout. Real drift among workspaces that ARE found must still fail loud.

---

### Task 1: PreToolUse hook script

**Files:**
- Create: `core/hooks/guard-playwright-delegation.mjs`
- Test: `tests/guard-playwright-delegation.test.mjs`

**Interfaces:**
- Produces: `export function decide(payload)` — pure function, `payload` is the parsed hook JSON (or `null`/`undefined`/any shape), returns `{ exitCode: number, output: string|null }`. `exitCode` is `0` (allow) when `payload` is truthy and `payload.agent_id` is truthy; otherwise `2` (deny) with `output` set to a JSON string. When `exitCode` is `0`, `output` is `null`.
- No other task consumes this file directly — it's wired into `.claude/settings.json` by Task 4 as a shell command, not imported by other code.

- [ ] **Step 1: Write the failing tests**

Create `tests/guard-playwright-delegation.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decide } from '../core/hooks/guard-playwright-delegation.mjs';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'hooks', 'guard-playwright-delegation.mjs');

test('decide() denies when agent_id is absent (main session)', () => {
  const result = decide({ tool_name: 'mcp__playwright__browser_click' });
  assert.equal(result.exitCode, 2);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /Step 7b/);
});

test('decide() denies when agent_id is explicitly null', () => {
  const result = decide({ tool_name: 'mcp__playwright__browser_type', agent_id: null });
  assert.equal(result.exitCode, 2);
});

test('decide() denies on an empty payload object', () => {
  const result = decide({});
  assert.equal(result.exitCode, 2);
});

test('decide() denies on a null payload without throwing', () => {
  const result = decide(null);
  assert.equal(result.exitCode, 2);
});

test('decide() allows when agent_id is present (delegated subagent)', () => {
  const result = decide({ tool_name: 'mcp__playwright__browser_click', agent_id: 'agent-abc123' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, null);
});

test('script exits 2 and prints a deny JSON when stdin has no agent_id', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify({ tool_name: 'mcp__playwright__browser_fill_form' }),
    encoding: 'utf8',
  });
  assert.equal(proc.status, 2);
  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});

test('script exits 0 with no stdout when stdin has an agent_id', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify({ tool_name: 'mcp__playwright__browser_click', agent_id: 'agent-xyz' }),
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0);
  assert.equal(proc.stdout, '');
});

test('script fails open (exit 0) on malformed stdin instead of crashing or blocking', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: 'not valid json{{{',
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0);
});

test('script fails open (exit 0) on empty stdin', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: '',
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/guard-playwright-delegation.test.mjs`
Expected: FAIL — `Cannot find module '.../core/hooks/guard-playwright-delegation.mjs'` (the file doesn't exist yet).

- [ ] **Step 3: Implement the hook script**

Create `core/hooks/guard-playwright-delegation.mjs`:

```javascript
// core/hooks/guard-playwright-delegation.mjs
//
// PreToolUse hook for the mutating Playwright interaction tools (see the
// matcher registered in .claude/settings.json). Blocks the call when it
// originates in the main Claude Code session (no `agent_id` in the hook
// payload) and allows it when it originates inside a delegated subagent
// (`agent_id` present).
//
// This exists because modes/apply.md Step 7b's prose instruction to
// delegate Playwright form-filling to a subagent was silently skipped in
// practice, twice, even after a stronger warning was added to that step —
// see docs/superpowers/specs/2026-09-08-apply-playwright-delegation-guard-design.md.
//
// Fails OPEN (allow) on any error reading/parsing stdin: a bug in this
// script must never brick apply mode entirely. A regression here is still
// visible, just at the cost/observability layer instead of as a hard block
// — see core/token-efficiency-log.mjs's `no_subagent_delegation` flag.

import { isMainModule } from '../is-main.mjs';

const DENY_REASON =
  'Direct Playwright interaction from the main session is blocked. Delegate this to a subagent per modes/apply.md Step 7b — spawn a subagent with the field-fill task instead of calling browser tools directly from the main flow.';

/**
 * Pure decision logic — no stdin, no process.exit, so it's directly
 * testable. `payload` is the parsed PreToolUse hook JSON, or null/undefined
 * if parsing already failed upstream (the caller handles that fail-open
 * case before this is ever invoked; this function always denies on a falsy
 * or agent_id-less payload, since a caller should only reach here with
 * something it wants evaluated).
 * @param {any} payload
 * @returns {{ exitCode: number, output: string|null }}
 */
export function decide(payload) {
  if (payload && payload.agent_id) {
    return { exitCode: 0, output: null };
  }
  return {
    exitCode: 2,
    output: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON,
      },
    }),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // malformed/empty input — fail open, never block on our own bug
    return;
  }
  const { exitCode, output } = decide(payload);
  if (output) process.stdout.write(output);
  process.exit(exitCode);
}

if (isMainModule(import.meta.url)) {
  main();
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/guard-playwright-delegation.test.mjs`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add core/hooks/guard-playwright-delegation.mjs tests/guard-playwright-delegation.test.mjs
git commit -m "$(cat <<'EOF'
feat(hooks): add PreToolUse guard blocking undelegated Playwright interaction

Denies mcp__playwright__browser_click/type/fill_form/press_key/
select_option/drag/drop/file_upload when the hook payload has no
agent_id (main session), allows them from a delegated subagent.
Not yet registered in any settings.json -- that's Task 4.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: JSON sync support in `backfill-templates.mjs`

**Files:**
- Modify: `core/backfill-templates.mjs`
- Test: `tests/backfill-templates.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `export const JSON_TEMPLATE_PAIRS = [{ live: '.claude/settings.json', template: '.claude/settings.json' }]`; `export function findMissingJsonPaths(templateValue, liveValue, path = [])` returning `{path: string[], value: any, arrayAppend?: boolean}[]`; `export function checkJsonFile(liveFilePath, templateFilePath)` returning `{missing: string[][], error: string|null}` (same shape as the existing `checkFile`); `export function applyJsonFile(liveFilePath, templateFilePath)` returning `{written: string[][], error: string|null}` (same shape as the existing `applyFile`, minus `conflicts` — JSON conflicts are silently skipped, never reported, since settings.json's shape doesn't need that granularity). `checkWorkspace`/`applyWorkspace` (already exported) now also include one result entry per `JSON_TEMPLATE_PAIRS` member, in the same array shape as their existing YAML entries (`{file, missing|written, error}`) — Task 3 relies on this.

- [ ] **Step 1: Write the failing tests**

Add to `tests/backfill-templates.test.mjs` (extend the existing import line and append these tests — do not create a new file):

```javascript
import { findMissingKeyPaths, checkFile, applyFile, findMissingJsonPaths, checkJsonFile, applyJsonFile, JSON_TEMPLATE_PAIRS, checkWorkspace, applyWorkspace } from '../core/backfill-templates.mjs';
```

```javascript
test('findMissingJsonPaths finds a top-level key missing from the live object', () => {
  const missing = findMissingJsonPaths({ a: 1, b: 2 }, { a: 1 });
  assert.deepEqual(missing, [{ path: ['b'], value: 2 }]);
});

test('findMissingJsonPaths reports a whole missing subtree as one path, not per-leaf', () => {
  const missing = findMissingJsonPaths({ hooks: { PreToolUse: [] } }, { a: 1 });
  assert.deepEqual(missing, [{ path: ['hooks'], value: { PreToolUse: [] } }]);
});

test('findMissingJsonPaths never overwrites an existing scalar value', () => {
  const missing = findMissingJsonPaths({ a: 1 }, { a: 999 });
  assert.deepEqual(missing, []);
});

test('findMissingJsonPaths adds new array items by value identity, keeping existing ones', () => {
  const missing = findMissingJsonPaths(
    { permissions: { allow: ['a', 'b', 'c'] } },
    { permissions: { allow: ['a'] } },
  );
  assert.deepEqual(missing, [{ path: ['permissions', 'allow'], value: ['b', 'c'], arrayAppend: true }]);
});

test('findMissingJsonPaths adds new hook matcher entries by matcher identity, keeping existing ones', () => {
  const existingHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo old' }] };
  const newHook = { matcher: 'mcp__playwright__browser_click', hooks: [{ type: 'command', command: 'node core/hooks/guard-playwright-delegation.mjs' }] };
  const missing = findMissingJsonPaths(
    { hooks: { PreToolUse: [existingHook, newHook] } },
    { hooks: { PreToolUse: [existingHook] } },
  );
  assert.deepEqual(missing, [{ path: ['hooks', 'PreToolUse'], value: [newHook], arrayAppend: true }]);
});

test('findMissingJsonPaths returns empty when an array already has every template item', () => {
  const missing = findMissingJsonPaths({ permissions: { allow: ['a'] } }, { permissions: { allow: ['a', 'b'] } });
  assert.deepEqual(missing, []);
});

test('findMissingJsonPaths returns empty when live already has everything the template has', () => {
  const missing = findMissingJsonPaths({ a: 1 }, { a: 1, b: 2 });
  assert.deepEqual(missing, []);
});

test('checkJsonFile reports missing paths without writing anything', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.json');
    const templatePath = join(dir, 'template.json');
    writeFileSync(livePath, JSON.stringify({ a: 1 }));
    writeFileSync(templatePath, JSON.stringify({ a: 1, b: 2 }));
    const before = readFileSync(livePath, 'utf8');
    const result = checkJsonFile(livePath, templatePath);
    assert.deepEqual(result.missing, [['b']]);
    assert.equal(result.error, null);
    assert.equal(readFileSync(livePath, 'utf8'), before);
  });
});

test('checkJsonFile returns no missing/no error when either file does not exist', () => {
  withTempDir((dir) => {
    const result = checkJsonFile(join(dir, 'nope.json'), join(dir, 'also-nope.json'));
    assert.deepEqual(result.missing, []);
    assert.equal(result.error, null);
  });
});

test('checkJsonFile reports a parse error instead of throwing on malformed JSON', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.json');
    const templatePath = join(dir, 'template.json');
    writeFileSync(livePath, '{not valid json');
    writeFileSync(templatePath, JSON.stringify({ a: 1 }));
    const result = checkJsonFile(livePath, templatePath);
    assert.equal(result.missing.length, 0);
    assert.ok(result.error);
  });
});

test('applyJsonFile writes missing top-level keys additively', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.json');
    const templatePath = join(dir, 'template.json');
    writeFileSync(livePath, JSON.stringify({ a: 1 }));
    writeFileSync(templatePath, JSON.stringify({ a: 1, hooks: { PreToolUse: [{ matcher: 'x', hooks: [] }] } }));
    const result = applyJsonFile(livePath, templatePath);
    assert.deepEqual(result.written, [['hooks']]);
    assert.equal(result.error, null);
    const written = JSON.parse(readFileSync(livePath, 'utf8'));
    assert.deepEqual(written, { a: 1, hooks: { PreToolUse: [{ matcher: 'x', hooks: [] }] } });
  });
});

test('applyJsonFile appends new array items without touching existing ones', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.json');
    const templatePath = join(dir, 'template.json');
    writeFileSync(livePath, JSON.stringify({ permissions: { allow: ['keep-me'] } }));
    writeFileSync(templatePath, JSON.stringify({ permissions: { allow: ['keep-me', 'new-one'] } }));
    const result = applyJsonFile(livePath, templatePath);
    assert.deepEqual(result.written, [['permissions', 'allow']]);
    const written = JSON.parse(readFileSync(livePath, 'utf8'));
    assert.deepEqual(written.permissions.allow, ['keep-me', 'new-one']);
  });
});

test('applyJsonFile is a no-op (no write) when nothing is missing', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.json');
    const templatePath = join(dir, 'template.json');
    writeFileSync(livePath, JSON.stringify({ a: 1 }));
    writeFileSync(templatePath, JSON.stringify({ a: 1 }));
    const before = readFileSync(livePath, 'utf8');
    const result = applyJsonFile(livePath, templatePath);
    assert.deepEqual(result.written, []);
    assert.equal(readFileSync(livePath, 'utf8'), before);
  });
});

test('checkWorkspace includes the .claude/settings.json JSON pair alongside the existing YAML pairs', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'workspaces', 'ws1', '.claude'), { recursive: true });
    mkdirSync(join(dir, '.claude'), { recursive: true });
    mkdirSync(join(dir, 'config'), { recursive: true });
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
    writeFileSync(join(dir, 'workspaces', 'ws1', '.claude', 'settings.json'), JSON.stringify({}));
    writeFileSync(join(dir, 'config', 'profile.example.yml'), 'a: 1\n');
    writeFileSync(join(dir, 'templates', 'portals.example.yml'), 'a: 1\n');
    const results = checkWorkspace(join(dir, 'workspaces', 'ws1'), dir);
    const settingsResult = results.find((r) => r.file === '.claude/settings.json');
    assert.ok(settingsResult, 'expected a .claude/settings.json entry in checkWorkspace results');
    assert.deepEqual(settingsResult.missing, [['hooks']]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/backfill-templates.test.mjs`
Expected: FAIL — `findMissingJsonPaths is not a function` (and similar) for the new imports.

- [ ] **Step 3: Implement the JSON sync support**

In `core/backfill-templates.mjs`, add after the existing `TEMPLATE_PAIRS` constant (do not modify `TEMPLATE_PAIRS`, `findMissingKeyPaths`, `checkFile`, or `applyFile`):

```javascript
export const JSON_TEMPLATE_PAIRS = [
  { live: '.claude/settings.json', template: '.claude/settings.json' },
];

/**
 * Identity key for a JSON array item, used to decide whether a template
 * item already exists in a live array. Hook-matcher objects (which carry a
 * `matcher` field) are identified by that field, since two hook entries for
 * the same matcher are the same registration even if their command differs
 * — this never overwrites an existing entry's command, only skips adding a
 * duplicate. Everything else (plain strings in permissions.allow, etc.) is
 * identified by exact value.
 * @param {any} item
 */
function jsonItemIdentity(item) {
  if (item && typeof item === 'object' && !Array.isArray(item) && 'matcher' in item) {
    return `matcher:${item.matcher}`;
  }
  return `value:${JSON.stringify(item)}`;
}

/**
 * Key paths (and, for arrays, groups of missing items) present in
 * templateValue but absent from liveValue. Mirrors findMissingKeyPaths's
 * "stop at the shallowest missing point" rule for objects. For arrays,
 * diffs item-by-item using jsonItemIdentity so a template array can gain
 * new entries without ever touching an existing live entry. Never reports
 * a path where live already holds a scalar value, even a different one —
 * additive-only, same as the YAML side.
 * @param {any} templateValue
 * @param {any} liveValue
 * @param {string[]} path
 * @returns {{path: string[], value: any, arrayAppend?: boolean}[]}
 */
export function findMissingJsonPaths(templateValue, liveValue, path = []) {
  const missing = [];
  if (Array.isArray(templateValue)) {
    if (!Array.isArray(liveValue)) {
      if (templateValue.length > 0) missing.push({ path, value: templateValue, arrayAppend: true });
      return missing;
    }
    const liveIdentities = new Set(liveValue.map(jsonItemIdentity));
    const newItems = templateValue.filter((item) => !liveIdentities.has(jsonItemIdentity(item)));
    if (newItems.length > 0) missing.push({ path, value: newItems, arrayAppend: true });
    return missing;
  }
  if (templateValue && typeof templateValue === 'object') {
    if (liveValue === undefined) {
      missing.push({ path, value: templateValue });
      return missing;
    }
    if (typeof liveValue !== 'object' || liveValue === null || Array.isArray(liveValue)) {
      return missing; // existing scalar/array where object expected — never overwrite
    }
    for (const key of Object.keys(templateValue)) {
      const childPath = [...path, key];
      if (!(key in liveValue)) {
        missing.push({ path: childPath, value: templateValue[key] });
      } else {
        missing.push(...findMissingJsonPaths(templateValue[key], liveValue[key], childPath));
      }
    }
    return missing;
  }
  return missing; // scalar template value: never overwrite an existing live value
}

/**
 * Compare one (live, template) JSON file pair. Never throws — a missing
 * file or a parse error is reported in the return value. Same return shape
 * as checkFile so callers can treat YAML and JSON pairs identically.
 * @returns {{ missing: string[][], error: string|null }}
 */
export function checkJsonFile(liveFilePath, templateFilePath) {
  if (!existsSync(liveFilePath) || !existsSync(templateFilePath)) {
    return { missing: [], error: null };
  }
  let liveValue, templateValue;
  try {
    liveValue = JSON.parse(readFileSync(liveFilePath, 'utf8'));
    templateValue = JSON.parse(readFileSync(templateFilePath, 'utf8'));
  } catch (err) {
    return { missing: [], error: /** @type {Error} */ (err).message };
  }
  const entries = findMissingJsonPaths(templateValue, liveValue);
  return { missing: entries.map((e) => e.path), error: null };
}

/**
 * Write every missing key/array-item from checkJsonFile into the live file.
 * No-op (no write at all) when nothing is missing. Same return shape as
 * applyFile, minus `conflicts` — a JSON type conflict (live scalar where
 * template wants an object) is silently skipped, same non-destructive rule,
 * without needing YAML's richer conflict reporting for this simpler shape.
 * @returns {{ written: string[][], error: string|null }}
 */
export function applyJsonFile(liveFilePath, templateFilePath) {
  if (!existsSync(liveFilePath) || !existsSync(templateFilePath)) {
    return { written: [], error: null };
  }
  let liveValue, templateValue;
  try {
    liveValue = JSON.parse(readFileSync(liveFilePath, 'utf8'));
    templateValue = JSON.parse(readFileSync(templateFilePath, 'utf8'));
  } catch (err) {
    return { written: [], error: /** @type {Error} */ (err).message };
  }
  const entries = findMissingJsonPaths(templateValue, liveValue);
  if (entries.length === 0) return { written: [], error: null };

  for (const { path, value, arrayAppend } of entries) {
    let target = liveValue;
    for (const key of path.slice(0, -1)) {
      if (typeof target[key] !== 'object' || target[key] === null || Array.isArray(target[key])) {
        target[key] = {};
      }
      target = target[key];
    }
    const lastKey = path[path.length - 1];
    if (arrayAppend) {
      if (!Array.isArray(target[lastKey])) target[lastKey] = [];
      target[lastKey].push(...value);
    } else {
      target[lastKey] = value;
    }
  }
  writeFileSync(liveFilePath, JSON.stringify(liveValue, null, 2) + '\n');
  return { written: entries.map((e) => e.path), error: null };
}
```

Then update `checkWorkspace` and `applyWorkspace` (replace their existing bodies) to include the JSON pairs:

```javascript
/** @returns {{ file: string, missing: string[][], error: string|null }[]} */
export function checkWorkspace(wsDir, reposRoot = ROOT) {
  const yamlResults = TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    ...checkFile(join(wsDir, live), join(reposRoot, template)),
  }));
  const jsonResults = JSON_TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    ...checkJsonFile(join(wsDir, live), join(reposRoot, template)),
  }));
  return [...yamlResults, ...jsonResults];
}

/** @returns {{ file: string, written: string[][], conflicts?: string[][], error: string|null }[]} */
export function applyWorkspace(wsDir, reposRoot = ROOT) {
  const yamlResults = TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    ...applyFile(join(wsDir, live), join(reposRoot, template)),
  }));
  const jsonResults = JSON_TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    ...applyJsonFile(join(wsDir, live), join(reposRoot, template)),
  }));
  return [...yamlResults, ...jsonResults];
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/backfill-templates.test.mjs`
Expected: PASS — all existing tests still green, all new tests green.

- [ ] **Step 5: Commit**

```bash
git add core/backfill-templates.mjs tests/backfill-templates.test.mjs
git commit -m "$(cat <<'EOF'
feat(backfill-templates): add JSON sync support for .claude/settings.json

Parallel code path to the existing YAML sync (config/profile.yml,
portals.yml) -- neither touches the other. Diffs objects by key and
arrays by item identity (matcher field for hook entries, exact value
otherwise), additive-only like the YAML side. checkWorkspace/
applyWorkspace now include .claude/settings.json in their results.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: SYSTEM_FILE_COPIES drift guard in `test-all.mjs`

**Files:**
- Modify: `core/test-all.mjs`

**Interfaces:**
- Consumes: `JSON_TEMPLATE_PAIRS`, `checkJsonFile` from `./backfill-templates.mjs` (Task 2); `listWorkspaces` from `./admin-overview-snapshot.mjs` (existing export, confirmed signature `listWorkspaces(reposRoot = ROOT)` returning `{slug, displayName, chatId, createdAt, dir}[]`, skipping any `workspaces/*` directory that lacks a `workspace.json` file).
- Produces: nothing consumed by a later task — this is the terminal enforcement mechanism itself.

There is no separate test file for this task: the check is inline in `test-all.mjs` (matching the existing plugin.json-mirror and Dockerfile-pin checks, which also have no dedicated test files), and it proves its own correctness by including a synthetic "must fail on real drift" probe alongside the production check, mirroring the existing `SYSTEM_PATHS coverage guard`'s probe pattern.

- [ ] **Step 1: Add the imports**

In `core/test-all.mjs`, find this line near the top:

```javascript
import { pass, fail, warn, run, lastRunFailure, formatRunFailure, fileExists, finish, ROOT, QUICK, NODE, getBash, toBashPath } from '../tests/helpers.mjs';
```

Add two new import lines directly after it:

```javascript
import { JSON_TEMPLATE_PAIRS, checkJsonFile } from './backfill-templates.mjs';
import { listWorkspaces } from './admin-overview-snapshot.mjs';
```

- [ ] **Step 2: Add the drift guard check**

Find the existing block in `core/test-all.mjs` that starts with `// Same shape again, for the #workspace-multitenancy Task 1 move` (the script-reference guard probe, immediately followed by its real check — this is the section read during planning, just before the plugin.json-mirror check). Insert the new check directly after that script-reference guard's real-check block (after the closing `}` of the block containing `pass('no stale bare-path references to a core/*.mjs script exist anywhere in tracked docs/CI files');`) and before the `// The plugin manifest ships in two locations` comment:

```javascript
// SYSTEM_FILE_COPIES drift guard: core/provision-workspace.mjs copies
// .claude/settings.json into every workspace ONCE at provisioning time and
// never re-syncs it automatically (unlike config/profile.yml/portals.yml,
// which get ongoing additive-sync coverage via backfill-templates.mjs +
// doctor-all.mjs specifically because they're meant to diverge per
// candidate). settings.json is pure system plumbing, not personalization —
// nothing should ever legitimately differ from the root template. See
// docs/superpowers/specs/2026-09-08-apply-playwright-delegation-guard-design.md.
//
// IMPORTANT: workspaces/* is entirely gitignored (only workspaces/.gitkeep
// is tracked) -- every workspace is per-machine, per-tenant local state
// that never reaches a git checkout. GitHub Actions CI therefore ALWAYS
// sees zero workspaces here, by design, not as an edge case. This guard
// cannot be a CI-enforced gate the way SYSTEM_PATHS/script-reference are --
// it is a LOCAL safety net that fires whenever this suite runs somewhere
// with real workspace data present (a maintainer's or an AI session's
// local machine). Finding zero workspaces is therefore the NORMAL case in
// CI and must pass cleanly (with an explicit, visible skip note, never
// silently) -- it is only real drift among workspaces that ARE found that
// must fail loud.
//
// First: prove the guard actually detects real drift when workspaces DO
// exist, using a synthetic temp tree -- this must fail loud, not silently
// pass, the same principle the SYSTEM_PATHS coverage guard's own probe
// above already established (that guard was a silent no-op in CI for years
// before this pattern existed to catch it).
{
  const probeDir = join(ROOT, '.tmp-system-file-copies-drift-probe');
  try {
    mkdirSync(join(probeDir, '.claude'), { recursive: true });
    mkdirSync(join(probeDir, 'workspaces', 'fake-ws', '.claude'), { recursive: true });
    writeFileSync(join(probeDir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'x', hooks: [] }] } }));
    writeFileSync(join(probeDir, 'workspaces', 'fake-ws', '.claude', 'settings.json'), JSON.stringify({}));
    writeFileSync(join(probeDir, 'workspaces', 'fake-ws', 'workspace.json'), JSON.stringify({ slug: 'fake-ws' }));
    const probeWorkspaces = listWorkspaces(probeDir);
    const probeDrifted = [];
    for (const { slug, dir } of probeWorkspaces) {
      for (const { live, template } of JSON_TEMPLATE_PAIRS) {
        const { missing, error } = checkJsonFile(join(dir, live), join(probeDir, template));
        if (error || missing.length > 0) probeDrifted.push(slug);
      }
    }
    if (probeWorkspaces.length > 0 && probeDrifted.length > 0) {
      pass('SYSTEM_FILE_COPIES drift guard correctly detects a deliberately-drifted synthetic workspace (not a silent pass)');
    } else {
      fail('SYSTEM_FILE_COPIES drift guard failed to detect a deliberately-drifted synthetic workspace — it would silently pass on real drift too');
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// And the real check, against the actual repo tree.
{
  const workspaces = listWorkspaces(ROOT);
  if (workspaces.length === 0) {
    pass('SYSTEM_FILE_COPIES drift guard: 0 workspaces found (expected — workspaces/* is gitignored and absent from this checkout/CI run; the guard only enforces drift when run locally with real workspace data present)');
  } else {
    const drifted = [];
    for (const { slug, dir } of workspaces) {
      for (const { live, template } of JSON_TEMPLATE_PAIRS) {
        const { missing, error } = checkJsonFile(join(dir, live), join(ROOT, template));
        if (error) drifted.push(`${slug}/${live}: ${error}`);
        else if (missing.length > 0) drifted.push(`${slug}/${live} missing ${missing.map((p) => p.join('.')).join(', ')}`);
      }
    }
    if (drifted.length === 0) {
      pass(`SYSTEM_FILE_COPIES drift guard: every provisioned workspace's .claude/settings.json is in sync with the root template (${workspaces.length} workspace(s) checked)`);
    } else {
      fail(`SYSTEM_FILE_COPIES drift — run "node core/backfill-templates.mjs --all --apply" to fix:\n${drifted.join('\n')}`);
    }
  }
}
```

- [ ] **Step 3: Run the full check manually to confirm both the probe and the real check currently PASS**

Run: `node core/test-all.mjs --quick 2>&1 | grep -A2 "SYSTEM_FILE_COPIES"`

Expected in a worktree (which has no `workspaces/*` data at all — gitignored, per-machine local state that a git checkout never carries): the synthetic probe passes (`SYSTEM_FILE_COPIES drift guard correctly detects a deliberately-drifted synthetic workspace`), and the real check passes with the zero-workspace skip note (`SYSTEM_FILE_COPIES drift guard: 0 workspaces found (expected...)`). This is the correct, permanent state for CI and for any fresh worktree/clone — it is NOT something Task 4 changes, since Task 4 also runs inside this same worktree and also has no real workspace data to find drift in. Propagating the hook into the real, local workspaces on the actual machine (outside git entirely, since those files are gitignored) is a separate, post-merge operational step — see the note at the end of Task 4 below, not a "temporarily fails then passes" demonstration inside this worktree.

- [ ] **Step 4: Commit**

```bash
git add core/test-all.mjs
git commit -m "$(cat <<'EOF'
feat(test-all): add SYSTEM_FILE_COPIES drift guard for .claude/settings.json

Fails CI if any provisioned workspace's .claude/settings.json has
drifted from the root template -- mirrors the existing SYSTEM_PATHS
coverage guard pattern (a synthetic-drift probe proves the guard
fails loud, then the real check runs against the actual tree).
Expected to currently FAIL for real (no workspace has the Task 1
hook registered yet) -- Task 4 makes it pass.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Register the hook and document the rule

**Files:**
- Modify: `.claude/settings.json` (repo root)
- Modify: `core/AGENTS.md`
- Modify: `modes/apply.md`

**Not part of this task's diff:** the four workspaces' own `.claude/settings.json` files. `workspaces/*` is entirely gitignored (only `workspaces/.gitkeep` is tracked — confirmed via `.gitignore:167` and `git ls-files workspaces/`), so those files don't exist in this worktree at all and can never be committed to any branch. Propagating this task's root-template change into them is a post-merge operational step against the real local machine, documented at the end of this task, not a task deliverable with its own diff/commit/review.

**Interfaces:**
- Consumes: nothing new from Task 3 directly (the drift guard's zero-workspace skip behavior means this task's in-worktree verification doesn't exercise real propagation — see Step 5).
- Produces: nothing — this is the last task in the plan; the post-merge note after it is an operational step, not a task.

- [ ] **Step 1: Add the hooks block to the repo-root `.claude/settings.json`**

Current file ends with:

```json
    "additionalDirectories": [
      "C:\\Users\\thebo\\.claude",
      "C:\\Users\\thebo",
      "\\tmp"
    ]
  }
}
```

Change the closing of the `permissions` object and the file's final close to:

```json
    "additionalDirectories": [
      "C:\\Users\\thebo\\.claude",
      "C:\\Users\\thebo",
      "\\tmp"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__playwright__browser_click|mcp__playwright__browser_type|mcp__playwright__browser_fill_form|mcp__playwright__browser_press_key|mcp__playwright__browser_select_option|mcp__playwright__browser_drag|mcp__playwright__browser_drop|mcp__playwright__browser_file_upload",
        "hooks": [
          { "type": "command", "command": "node core/hooks/guard-playwright-delegation.mjs" }
        ]
      }
    ]
  }
}
```

(i.e. add a comma after the `permissions` object's closing `}`, then the new `"hooks"` key, before the file's final `}`.)

**Note on why there's no in-worktree "watch it fail, then fix it" step here (there was in an earlier draft of this plan):** `workspaces/*` is entirely gitignored — this worktree, like any git checkout, has zero real workspace data, so `listWorkspaces(ROOT)` returns `[]` here regardless of what this step just added to root's `.claude/settings.json`. There is nothing to demonstrate drift against inside this worktree. The real workspaces (`ernesto-vasquez`, `leonie`, `roberto-vasquez`, `thomas-acosta`) exist only on the local machine's main checkout, outside git entirely. Propagating the hook into them is a **post-merge operational step**, done once this branch's code is merged back into the main checkout — see the very end of this task, after Step 6.

- [ ] **Step 2: Add the Main Files row to `core/AGENTS.md`**

Find this row in the Main Files table (it documents `broadcast.mjs`, alphabetically/thematically near other operator-facing scripts):

```
| `broadcast.mjs` | Operator tool to notify every bound Telegram user of a system update worth telling them about, reusing the existing `sendCannedReply` send path — `node core/broadcast.mjs "message" [--dry-run]` |
```

Add a new row directly after it:

```
| `hooks/guard-playwright-delegation.mjs` | `PreToolUse` hook (registered in `.claude/settings.json`) that blocks mutating Playwright interaction tools (`browser_click`/`browser_type`/`browser_fill_form`/etc.) when called from the main session and allows them from a delegated subagent — the mechanical backstop for `modes/apply.md` Step 7b's delegation requirement, see `docs/superpowers/specs/2026-09-08-apply-playwright-delegation-guard-design.md` |
```

- [ ] **Step 3: Add the backstop note to `modes/apply.md` Step 7b**

Find the existing paragraph in Step 7b that begins with:

```
**This applies every time this step is reached, not just the first time.**
```

Immediately after that paragraph (before item `1.` of the numbered list), add:

```
**As of 2026-09-08, this is no longer just an instruction.** A `PreToolUse` hook (`core/hooks/guard-playwright-delegation.mjs`) blocks every one of these tool calls outright when made directly from the main flow — the direct path described as a bug above is now a dead end, not merely discouraged. The steps below are "how to delegate correctly" (batching, snapshot scoping, quirk handling), not "whether to."
```

- [ ] **Step 4: Add the propagation rule to `core/AGENTS.md`'s Stack and Conventions section**

Find this existing line:

```
- **RULE: Moving or renaming any script requires TWO reference sweeps, not one.** The internal import/require graph among the moved files (`grep -rnE "(from|require)\s*\(?['\"]\./" core/*.mjs` style) catches JS-level breakage. It does **not** catch the other kind of reference these scripts have: a bare `node {script}` shell-command invocation written in prose — a mode file, a README, a CI workflow step. That second sweep (`grep -rn "node {old-name}" --include="*.md" --include="*.yml"`) is what a 2026-08-16 move skipped for one task while getting it right for three others in the same plan, and it silently broke a live Telegram acknowledgment, CI itself, and the self-updater's own re-exec path for four days before anyone noticed. `core/validate-script-references.mjs` (run automatically by `test-all.mjs`/CI) is the mechanical backstop that catches this now if it's ever missed again — but do the sweep anyway; the check should never be the first line of defense, only the one that can't be forgotten.
```

Add a new bullet directly after it:

```
- **RULE: Any change to a file in `provision-workspace.mjs`'s `SYSTEM_FILE_COPIES` list (currently just `.claude/settings.json`) requires re-running `node core/backfill-templates.mjs --all --apply` before the change ships**, so every already-provisioned workspace picks it up — unlike `SEEDED_FILES` (`config/profile.yml`, `portals.yml`, etc.), which are meant to diverge per candidate, `SYSTEM_FILE_COPIES` entries are pure system plumbing that should never legitimately differ from the root template. `test-all.mjs`'s SYSTEM_FILE_COPIES drift guard is the mechanical backstop that fails CI if this is missed — but run the backfill anyway; the check should never be the first line of defense, only the one that can't be forgotten.
```

- [ ] **Step 5: Run the full test suite in this worktree and confirm everything is green**

Run: `node core/test-all.mjs --quick 2>&1 | grep -A2 "SYSTEM_FILE_COPIES"`

Expected: the synthetic probe still passes, and the real check passes with the zero-workspace skip note (`SYSTEM_FILE_COPIES drift guard: 0 workspaces found (expected...)`) — unchanged from Task 3's baseline, since this worktree has no real workspace data to find drift in either way. This step is a sanity check that Step 1's JSON edit didn't break JSON parsing or introduce a syntax error, not a drift demonstration. Also run the full suite once without `--quick` to confirm nothing else regressed: `node core/test-all.mjs`.

- [ ] **Step 6: Commit**

```bash
git add .claude/settings.json core/AGENTS.md modes/apply.md
git commit -m "$(cat <<'EOF'
feat(apply): register the Playwright delegation guard hook

Adds the hooks.PreToolUse block to the repo-root .claude/settings.json.
Documents the hook in AGENTS.md's Main Files table, notes it as a hard
backstop in apply.md Step 7b, and adds the SYSTEM_FILE_COPIES
propagation rule to AGENTS.md's Stack and Conventions section.

Does NOT touch any workspaces/* file -- that directory is entirely
gitignored (per-machine candidate data), so propagating this hook
into the real local workspaces is a post-merge operational step run
directly against the main checkout, not something this branch's
history can contain. See the plan's post-merge note for that step.

Closes the loop from
docs/superpowers/specs/2026-09-08-apply-playwright-delegation-guard-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Post-merge operational step (not part of Task 4's diff — run after this branch merges to main)

Once this plan's branch is reviewed, merged, and its code is present in the **main checkout** (not this worktree — `workspaces/*` only physically exists there), propagate the hook into the real local workspaces:

```bash
node core/backfill-templates.mjs --all --apply
```

Expected output: one line per workspace (`ernesto-vasquez`, `leonie`, `roberto-vasquez`, `thomas-acosta`) reporting `.claude/settings.json wrote hooks`, and `up to date` (or nothing new) for `config/profile.yml`/`portals.yml` unless those happen to have unrelated pending drift already.

Verify semantically (not with a raw `diff` — `applyJsonFile` fully re-serializes the file it writes via `JSON.stringify(..., null, 2)`, which normalizes away the root file's cosmetic blank lines inside its `allow` array; a byte-for-byte diff would show that formatting difference even though the data is identical):

```bash
node core/backfill-templates.mjs --all --check
```

Expected: `up to date` (or only pre-existing, unrelated YAML drift if any already existed) for all four workspaces.

Then, from the main checkout, run the full suite once more to see the drift guard's real check pass for real (not the zero-workspace skip):

```bash
node core/test-all.mjs
```

Expected: `SYSTEM_FILE_COPIES drift guard: every provisioned workspace's .claude/settings.json is in sync with the root template (4 workspace(s) checked)`.

This step has no commit of its own — nothing in `workspaces/*` is ever tracked by git.

---

## Post-implementation (not a task — an observation to make later, live)

After this ships, the next real Thomas Acosta (or any workspace's) apply session that reaches Step 7b should show `subagent_delegated: true` in `data/token-efficiency-log.tsv` and no `no_subagent_delegation` flag. Check with:

```bash
node core/token-efficiency-log.mjs update
node core/token-efficiency-report.mjs --workspace thomas-acosta
```

This isn't a task with its own commit — it's the live confirmation the spec's Testing section calls for, and it can only happen after a real apply session runs post-deploy.
