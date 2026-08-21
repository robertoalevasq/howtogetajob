# `core/` Path Reference Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every stale bare-path reference to a `core/*.mjs` script left over from the #workspace-multitenancy Task 1 move (2026-08-15), including a real code bug and broken CI, and add a permanent automated guard so this class of bug can never silently recur.

**Architecture:** A new standalone validator script (`core/validate-script-references.mjs`, mirroring the existing `validate-system-paths-coverage.mjs` pattern) enumerates every `core/*.mjs` basename and scans all tracked `.md`/`.yml` files for bare, unprefixed invocations — written and run *first*, so its own failure output becomes the authoritative, complete fix list for every later task, replacing manual/incremental grep discovery. Remediation then proceeds in severity order: a real code bug, then CI, then live-runtime docs, then human-facing docs, then the architecture-principle rewrite, then a durable convention note.

**Tech Stack:** Node.js (`.mjs`), `git ls-files` for tracked-file enumeration, `node:test`-free plain-assertion style matching `core/test-all.mjs`'s existing `pass()`/`fail()` convention.

**Spec:** `docs/superpowers/specs/2026-08-20-core-path-reference-sync-design.md`

## Global Constraints

- **No compatibility shims** at old root-level paths — every reference gets fixed to `core/{script}`, nothing is left working at the old bare path (spec Non-goals).
- **No automated code-layer `spawn`/`execFileSync` scanner** — the doc/CI/config-layer check (this plan's Task 1) is the only automated guard being built; the one real code bug found (`core/update-system.mjs`) is a direct fix, not a pattern to build detection for (spec Non-goals).
- **Never edit `archive/**` or `docs/superpowers/{plans,specs}/**`** — frozen historical records, explicitly excluded from both the scanner and all remediation tasks (spec Non-goals).
- **No separate generated documentation/map artifact** — the regression check itself, re-run on demand, is the complete answer to "does everything point where it should" (spec Non-goals).
- The regression check must fail loud (never silently pass) when it cannot inspect the tree — e.g. `git ls-files` returning empty from an untracked directory — matching the exact defensive pattern already established in `core/validate-system-paths-coverage.mjs` (whose own header cites this exact bug class landing five times previously).
- The check enumerates `core/*.mjs` basenames dynamically at run time, never a hardcoded list — this is what makes it generalize to any *future* script move, not just today's known set (spec Component: the regression check).

---

## Task 1: `validate-script-references.mjs` + wiring into `test-all.mjs`

**Files:**
- Create: `core/validate-script-references.mjs`
- Modify: `core/test-all.mjs`

**Interfaces:**
- Produces: `core/validate-script-references.mjs` — a standalone script, `node core/validate-script-references.mjs` run from the repo root exits 0 (clean, prints `OK: {N} doc/CI files scanned against {M} core/ scripts, no stale bare references`) or exits 1 (violations found, each printed as `{file}:{line}: bare '...' — should be '...'`). Also accepts no special flags — unlike `validate-system-paths-coverage.mjs`'s `--self-test`, this task's tests live in `test-all.mjs` directly (see Step 5), matching the simpler validators in this codebase (e.g. `validate-untrusted-content-coverage.mjs`).
- Consumes: nothing new — mirrors the existing `core/validate-system-paths-coverage.mjs` pattern for `ROOT`/`REPO_ROOT` resolution and `git ls-files` enumeration.

This task's later step (Step 6) runs the finished check and captures its full violation list — that becomes the authoritative input every later task in this plan reads from directly (by re-running the same command themselves), not a snapshot to trust after the fact.

- [ ] **Step 1: Write the failing tests in `core/test-all.mjs`**

Read `core/test-all.mjs` around lines 1095-1157 first (the `validate-system-paths-coverage.mjs`/`validate-untrusted-content-coverage.mjs` wiring) to confirm the current `pass()`/`fail()` helper names and the `ROOT`/`spawnSync`/`mkdirSync`/`copyFileSync`/`rmSync` imports are already available in that scope (they are, per the existing code at those lines) — this task's new block goes immediately after the closing `}` of the existing `untrusted` block (currently ending at line 1157) and before the comment starting `// The plugin manifest ships in two locations...` (currently line 1159).

Insert this block at that location:

```js
// Same shape again, for the #workspace-multitenancy Task 1 move
// (2026-08-15): every core/*.mjs script must never be referenced by a bare,
// unprefixed `node {script}` in any doc/CI file, or a future script move can
// silently break a Telegram acknowledgment, a CI job, or a contributor's
// documented workflow with zero signal until someone notices by hand (found
// live 2026-08-20 — modes/telegram.md's `node plugins.mjs` and 30+ other
// references across the repo, plus a real bug in core/update-system.mjs's
// own self-update re-exec path).
{
  const probeDir = join(ROOT, '.tmp-script-ref-guard-probe');
  try {
    const probeCoreDir = join(probeDir, 'core');
    mkdirSync(probeCoreDir, { recursive: true });
    copyFileSync(join(ROOT, 'core', 'validate-script-references.mjs'), join(probeCoreDir, 'validate-script-references.mjs'));
    const probe = spawnSync(process.execPath, [join(probeCoreDir, 'validate-script-references.mjs')], {
      cwd: probeCoreDir,
      encoding: 'utf-8',
    });
    if (probe.status !== 0) {
      pass('script-reference guard fails when it cannot inspect the tree (not a silent pass)');
    } else {
      fail('script-reference guard exited 0 from an untracked dir — it is a no-op in CI again');
    }
  } catch (err) {
    fail(`could not probe the script-reference guard: ${err.message} (a failed probe is not a pass)`);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

{
  const refs = spawnSync(process.execPath, [join(ROOT, 'core', 'validate-script-references.mjs')], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  if (refs.status === 0) {
    pass('no stale bare-path references to a core/*.mjs script exist anywhere in tracked docs/CI files');
  } else {
    fail(`Stale core/ script references found:\n${(refs.stderr || refs.stdout || '').trim()}`);
  }
}
```

- [ ] **Step 2: Run the new tests to verify they fail**

**Important:** `test-all.mjs --only <substring>` filters which `tests/**/*.test.mjs` *files* run — it does NOT filter inline assertion blocks like the two just added (the file's own header comment carries a "LOUD WARNING" about exactly this: `--only` skips every inline check). Verifying these two new blocks means running the real suite, not a filtered one.

First confirm the target script genuinely doesn't exist yet, which is why both new blocks are expected to fail:

```bash
ls core/validate-script-references.mjs
```

Expected: `No such file or directory`.

Then run the full suite once to get real RED evidence (this file is large, so this is the one point in this task where a full run is worth the time — not repeated every step):

```bash
node core/test-all.mjs
```

Expected: both new assertions FAIL — `spawnSync` against a nonexistent script reports a non-zero/error status for both the probe block and the real-check block. Note the failure output for comparison against the GREEN run in Step 4.

- [ ] **Step 3: Write `core/validate-script-references.mjs`**

```js
#!/usr/bin/env node

/**
 * validate-script-references.mjs — structural coverage check for the
 * core/ script-path move (#workspace-multitenancy Task 1, 2026-08-15).
 *
 * Every core/*.mjs script is invoked by shell command from many places
 * across the repo's docs, CI workflows, and other prose — README files,
 * mode files, AGENTS.md, plugin skill.md docs, CI workflow YAML. A bare
 * `node {script}.mjs` reference in any of these is broken: none of these
 * scripts live at the repo root anymore, only under core/. Task 1's own
 * verification swept only the JS import graph between the moved files
 * themselves, never this class of reference — found live 2026-08-20 when
 * a Telegram acknowledgment silently failed because modes/telegram.md
 * still said `node plugins.mjs`.
 *
 * Run: node validate-script-references.mjs
 * Exit 0 = clean. Exit 1 = violations listed.
 */

import { execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ROOT is this script's own directory (core/) — used to enumerate sibling
// .mjs scripts. REPO_ROOT is one level up, the actual repo root `git
// ls-files` must run from.
const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(ROOT);

// Frozen historical records — never corrected retroactively to match
// current reality (same convention as this repo's own completed specs/plans
// generally; see AGENTS.md's Data Contract for the equivalent user-layer
// rule).
const EXCLUDE_PREFIXES = ['archive/', 'docs/superpowers/plans/', 'docs/superpowers/specs/'];

function isExcluded(file) {
  return EXCLUDE_PREFIXES.some((p) => file.startsWith(p));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let tracked;
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8' })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
} catch (err) {
  console.error('FAIL: git ls-files failed:', err.message);
  process.exit(1);
}

// An empty file list means this run could not inspect anything — reporting
// success would make the guard a no-op. Same failure class documented in
// validate-system-paths-coverage.mjs: a check that cannot look must fail,
// not pass.
if (tracked.length === 0) {
  console.error('FAIL: git ls-files returned no paths — this run could not inspect anything.');
  console.error('');
  console.error('Run this from the repository root. An empty listing usually means the');
  console.error('script was invoked from an untracked directory (a temp copy, a fixture');
  console.error('dir), where git reports nothing and the coverage check is meaningless.');
  process.exit(1);
}

let scripts;
try {
  scripts = readdirSync(ROOT).filter((f) => f.endsWith('.mjs'));
} catch (err) {
  console.error('FAIL: could not read core/ directory:', err.message);
  process.exit(1);
}
if (scripts.length === 0) {
  console.error('FAIL: no .mjs scripts found in core/ — this run could not inspect anything.');
  process.exit(1);
}

const scanFiles = tracked.filter(
  (f) => (f.endsWith('.md') || f.endsWith('.yml') || f.endsWith('.yaml')) && !isExcluded(f),
);

const violations = [];
for (const file of scanFiles) {
  let content;
  try {
    content = readFileSync(join(REPO_ROOT, file), 'utf-8');
  } catch {
    continue; // tracked but not present locally — nothing to scan
  }
  const lines = content.split(/\r?\n/);
  for (const script of scripts) {
    const esc = escapeRegExp(script);
    // Word-boundary-ish trailing guard (?![\w.-]) so "node scan.mjs" doesn't
    // false-match inside a longer token like "node scan.mjs2" or
    // "node scan.mjs-old". No guard is needed on the *preceding* side: the
    // literal substring "node scan.mjs" never occurs inside "node
    // core/scan.mjs" (there's "core/" in between), so a correctly-prefixed
    // reference can never trigger this pattern.
    const bareRe = new RegExp(`node ${esc}(?![\\w.-])`);
    const copsRe = new RegExp(`\\./cops node ${esc}(?![\\w.-])`);
    lines.forEach((line, idx) => {
      if (copsRe.test(line)) {
        violations.push(`${file}:${idx + 1}: bare './cops node ${script}' — should be './cops node core/${script}'`);
        return;
      }
      if (bareRe.test(line)) {
        violations.push(`${file}:${idx + 1}: bare 'node ${script}' — should be 'node core/${script}'`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`Found ${violations.length} stale bare script reference(s):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('');
  console.error('Every core/*.mjs script moved out of the repo root (#workspace-multitenancy');
  console.error('Task 1, 2026-08-15) — prefix each reference with core/.');
  process.exit(1);
}

console.log(`OK: ${scanFiles.length} doc/CI files scanned against ${scripts.length} core/ scripts, no stale bare references`);
process.exit(0);
```

- [ ] **Step 4: Run the new tests to verify they pass structurally**

Run:

```bash
node core/validate-script-references.mjs
```

Expected: exits 1, printing a (likely long) list of every currently-broken reference in the repo. This is expected and correct — the script itself is now working, it just hasn't been fed a clean tree yet. Do NOT treat this as a bug in the script; this IS the authoritative violation list Tasks 2-8 consume.

Then run the full suite again (same reason as Step 2 — inline assertions aren't filterable by `--only`):

```bash
node core/test-all.mjs
```

Expected: the probe assertion (`script-reference guard fails when it cannot inspect the tree`) now PASSES — the guard correctly fails loud from an untracked copy. The real-check assertion (`no stale bare-path references to a core/*.mjs script exist...`) currently FAILS (matching the real, not-yet-fixed tree) — this is the expected, correct state at the end of this task; it turns green as Tasks 2-8 fix every violation (confirmed explicitly in Task 6 Step 4, the last doc-fixing task).

- [ ] **Step 5: Save the full violation list for later tasks**

```bash
node core/validate-script-references.mjs 2> /tmp/script-ref-violations.txt
cat /tmp/script-ref-violations.txt
```

Read the output. Confirm it includes (at minimum) references to `plugins.mjs`, `doctor.mjs`, `cycle-status.mjs`, `set-status.mjs`, `merge-tracker.mjs`, `outcome.mjs`, `reserve-report-num.mjs`, `dedup-tracker.mjs`, `normalize-statuses.mjs`, `verify-pipeline.mjs`, `stats.mjs`, `telegram-poll.mjs`, `telegram-set-commands.mjs`, `test-all.mjs`, `upgrade-tests.mjs`, `validate-plugin-registry.mjs`, `scan.mjs`, `gemini-eval.mjs`, `agent-inbox.mjs`, `generate-latex.mjs`, `build-cv-latex.mjs`, `check-liveness.mjs` — if a category you expected is entirely absent from the output, note it in your report as a concern (either it's already correct, or the scanner has a gap worth flagging to the controller before proceeding). This file is a convenience snapshot only — every later task in this plan re-runs the real command itself for current, authoritative state, since each fix changes what's left.

- [ ] **Step 6: Commit**

```bash
git add core/validate-script-references.mjs core/test-all.mjs
git commit -m "$(cat <<'EOF'
feat: add permanent guard against stale core/ script path references

New core/validate-script-references.mjs (mirrors the existing
validate-system-paths-coverage.mjs pattern, including its "must fail
loud when it cannot inspect the tree" defensive shape) scans every
tracked .md/.yml file for a bare `node {script}` reference to any
core/*.mjs script. Wired into test-all.mjs with the same
probe-then-real two-assertion pattern already used for the
SYSTEM_PATHS coverage guard. Currently fails against the real tree --
this failure IS the complete, authoritative fix list the rest of this
plan works from, replacing the manual/incremental grep discovery that
let this bug go unnoticed since the #workspace-multitenancy Task 1
move (2026-08-15).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Fix `core/update-system.mjs`'s real code bug

**Files:**
- Modify: `core/update-system.mjs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: nothing new consumed by later tasks — this fix is independent of the doc/CI remediation, just addressed early per severity ordering.

- [ ] **Step 1: Read the current exact content to confirm anchors**

Read `core/update-system.mjs` at line 544 (`REEXEC_FALLBACK_FILES`) and lines 878-897 (the re-exec call site) to confirm the anchor text below still matches — it was read directly during planning, but confirm before editing.

- [ ] **Step 2: Fix `REEXEC_FALLBACK_FILES`**

Find:

```js
const REEXEC_FALLBACK_FILES = ['update-system.mjs', 'scaffolder/bin/skill-entrypoints.mjs'];
```

Replace with:

```js
const REEXEC_FALLBACK_FILES = ['core/update-system.mjs', 'scaffolder/bin/skill-entrypoints.mjs'];
```

(`scaffolder/bin/skill-entrypoints.mjs` did not move in Task 1 — confirmed it still exists at that exact path — so it stays unchanged.)

- [ ] **Step 3: Fix the re-exec entry point and the execFileSync call**

Find:

```js
        const reexecFiles = resolveReexecCheckout('FETCH_HEAD', 'update-system.mjs');
        git('checkout', 'FETCH_HEAD', '--', ...reexecFiles);
        execFileSync(process.execPath, ['update-system.mjs', 'apply'], {
```

Replace with:

```js
        const reexecFiles = resolveReexecCheckout('FETCH_HEAD', 'core/update-system.mjs');
        git('checkout', 'FETCH_HEAD', '--', ...reexecFiles);
        execFileSync(process.execPath, ['core/update-system.mjs', 'apply'], {
```

This works because `resolveReexecCheckout`'s graph-walk computes `dir = pathPosix.dirname(file)` from its `entry` argument — with `entry = 'core/update-system.mjs'`, `dir` becomes `'core'`, and every relative import spec found in the source gets correctly joined against that (`pathPosix.join('core', './hub-paths.mjs')` → `'core/hub-paths.mjs'`), so every file `git checkout FETCH_HEAD -- ...reexecFiles` fetches lands at its real, correct path. No changes are needed inside `resolveReexecCheckout` itself.

- [ ] **Step 4: Investigate why `core/upgrade-tests.mjs` didn't catch this**

Read `core/upgrade-tests.mjs` around its `execFileSync(process.execPath, ['update-system.mjs', 'apply'], { cwd: install, ... })` call (currently around line 123) and its `execFileSync(process.execPath, ['doctor.mjs', '--json'], { cwd: install, ... })` smoke test (currently around line 179). Determine: does this harness's `oldTag` (the historical release tag it clones and upgrades from) predate the 2026-08-15 Task 1 move? If so, that's why the re-exec bug was never exercised — the *old* tree genuinely has `update-system.mjs`/`doctor.mjs` at the root, so these two bare-path calls are correct *for that old tree*, and the bug only lives in the *target* (current) tree's own internal re-exec logic, which this harness's re-exec path may not actually traverse in the way `core/update-system.mjs apply`'s real self-update flow does. Write your findings (not a code fix — this task is scoped to the `update-system.mjs` bug only) into your report file. If you find the harness genuinely should catch this and doesn't due to a real gap, note it clearly as a concern for the controller to decide whether it's in scope for a follow-up — do not expand this task's own diff to fix `upgrade-tests.mjs` without that decision.

- [ ] **Step 5: Run the full test suite**

```bash
node core/test-all.mjs
```

Expected: same pass/fail counts as before this task except Task 1's new `validate-script-references.mjs`-derived assertion should now show two fewer core references it was reporting for `core/update-system.mjs` itself (it wasn't scanning `.mjs` files at all — Task 1's scanner only scans `.md`/`.yml`/`.yaml` — so this task's fix does not change that assertion's pass/fail state; it should already have been passing for `.mjs`-internal content since the scanner never looked there. Confirm no regressions elsewhere.

- [ ] **Step 6: Commit**

```bash
git add core/update-system.mjs
git commit -m "$(cat <<'EOF'
fix: correct core/update-system.mjs's own self-update re-exec path

resolveReexecCheckout('FETCH_HEAD', 'update-system.mjs') and the
following execFileSync both referenced the stale bare filename --
`git show FETCH_HEAD:update-system.mjs` finds nothing (the file lives
at core/update-system.mjs since the 2026-08-15 #workspace-multitenancy
move), so the checkout silently no-ops and the re-exec would fail too.
Fixed both call sites plus REEXEC_FALLBACK_FILES. This is a real
production bug in the self-updater's own re-exec safety mechanism, not
a documentation issue -- found during a live doc/CI reference sweep
2026-08-20.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Fix CI workflow files

**Files:**
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/plugin-registry-validate.yml`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Read both files to confirm current anchor text**

Read `.github/workflows/test.yml` in full (86 lines) and `.github/workflows/plugin-registry-validate.yml` in full (64 lines) to confirm the anchors below still match.

- [ ] **Step 2: Fix `.github/workflows/test.yml`**

Find:

```yaml
      - run: node test-all.mjs --quick
```

Replace with:

```yaml
      - run: node core/test-all.mjs --quick
```

Find:

```yaml
      - name: Upgrade PR gate (newest old release -> this commit)
        run: node upgrade-tests.mjs --pr-gate
      - name: Canary (harness must be able to fail)
        run: node upgrade-tests.mjs --canary
```

Replace with:

```yaml
      - name: Upgrade PR gate (newest old release -> this commit)
        run: node core/upgrade-tests.mjs --pr-gate
      - name: Canary (harness must be able to fail)
        run: node core/upgrade-tests.mjs --canary
```

- [ ] **Step 3: Fix `.github/workflows/plugin-registry-validate.yml`**

Find:

```yaml
      # Deterministic shape gate (no network).
      - name: Validate registry shape
        run: node validate-plugin-registry.mjs

      # Deep gate: clone each entry at its pinned SHA + static-validate + audit.
      # No secrets are present in this job; nothing the plugin ships is executed.
      - name: Clone + audit each registry entry
        run: node validate-plugin-registry.mjs --deep
```

Replace with:

```yaml
      # Deterministic shape gate (no network).
      - name: Validate registry shape
        run: node core/validate-plugin-registry.mjs

      # Deep gate: clone each entry at its pinned SHA + static-validate + audit.
      # No secrets are present in this job; nothing the plugin ships is executed.
      - name: Clone + audit each registry entry
        run: node core/validate-plugin-registry.mjs --deep
```

- [ ] **Step 4: Verify the corrected commands actually work locally**

```bash
node core/test-all.mjs --quick
node core/upgrade-tests.mjs --pr-gate 2>&1 | head -5
node core/validate-plugin-registry.mjs
```

Expected: the first command runs (it's the real suite, so full green/red status matters — same baseline as the rest of this plan). The second only needs to confirm it *starts* running rather than hitting `MODULE_NOT_FOUND` immediately (a `--pr-gate` full run may need network/git-history access not available in every environment — confirm it gets past argument parsing and into real work, not an immediate module-resolution crash). The third should run cleanly (`node core/validate-plugin-registry.mjs` with no args does the shape gate).

- [ ] **Step 5: Run the regression check to confirm these two files are now clean**

```bash
node core/validate-script-references.mjs 2>&1 | grep -E "test\.yml|plugin-registry-validate\.yml"
```

Expected: no output (both files no longer appear in the violation list).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/test.yml .github/workflows/plugin-registry-validate.yml
git commit -m "$(cat <<'EOF'
fix: correct core/ script paths in CI workflow files

.github/workflows/test.yml ran `node test-all.mjs --quick` and `node
upgrade-tests.mjs --pr-gate`/`--canary` with no working-directory
override, from a checkout root where neither script exists (both live
at core/ since the 2026-08-15 #workspace-multitenancy move).
plugin-registry-validate.yml had the identical issue with
validate-plugin-registry.mjs. Neither had a root-level shim or an npm
script alias to fall back on -- these were broken outright.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Fix live-runtime docs — mode files, `AGENTS.md`, plugin `skill.md`, `batch/batch-prompt.md`

**Files:**
- Modify: `modes/telegram.md`
- Modify: `core/AGENTS.md`
- Modify: `plugins/telegram/skill.md`
- Modify: `plugins/discord/skill.md`
- Modify: `plugins/notion/skill.md`
- Modify: `plugins/gmail/skill.md`
- Modify: `plugins/_template/skill.md`
- Modify: `plugins/apify/skill.md`
- Modify: `batch/batch-prompt.md`

**Interfaces:**
- Consumes: Task 1's `core/validate-script-references.mjs`.
- Produces: nothing consumed by later tasks.

This is the highest-real-world-impact category: these are files an LLM agent actually executes shell commands from at runtime, not just human reference material. `modes/telegram.md`'s `node plugins.mjs run telegram notify ...` (Step 3a's "Acknowledge immediately") is the exact command whose failure motivated this whole plan.

- [ ] **Step 1: Get the current, authoritative violation list for this task's files**

```bash
node core/validate-script-references.mjs 2>&1 | grep -E "^  (modes/telegram\.md|core/AGENTS\.md|plugins/(telegram|discord|notion|gmail|_template|apify)/skill\.md|batch/batch-prompt\.md):"
```

Read every line of this output before making any edit — it is the complete, current list for this task, not a pre-guessed one.

- [ ] **Step 2: Fix each violation**

For each `{file}:{line}: bare 'node {script}' — should be 'node core/{script}'` (or the `./cops node` form) reported in Step 1's output: read the file, find that exact line, and change `node {script}` to `node core/{script}` (or `./cops node {script}` to `./cops node core/{script}`) — nothing else on the line changes. This is a fully mechanical, unambiguous transformation; apply it file-by-file with `Edit`, not a blind find-and-replace across files you haven't individually confirmed the match in (a script name could theoretically appear inside prose without being a command — read each hit in context before editing, even though every occurrence found during this plan's own research was a genuine command reference).

Pay particular attention to `modes/telegram.md`'s Step 3a "Acknowledge immediately" line and its PDF-delivery steps (3d/3e) — these are the exact commands that failed live on 2026-08-20; confirm each is now correctly `node core/plugins.mjs run telegram notify ...`.

- [ ] **Step 3: Re-run the check to confirm this task's files are clean**

```bash
node core/validate-script-references.mjs 2>&1 | grep -E "^  (modes/telegram\.md|core/AGENTS\.md|plugins/(telegram|discord|notion|gmail|_template|apify)/skill\.md|batch/batch-prompt\.md):"
```

Expected: no output.

- [ ] **Step 4: Run the full test suite**

```bash
node core/test-all.mjs
```

Expected: no regressions; Task 1's script-reference assertion should show fewer remaining violations than before this task (not yet zero — later tasks still have their own categories outstanding).

- [ ] **Step 5: Commit**

```bash
git add modes/telegram.md core/AGENTS.md plugins/telegram/skill.md plugins/discord/skill.md plugins/notion/skill.md plugins/gmail/skill.md plugins/_template/skill.md plugins/apify/skill.md batch/batch-prompt.md
git commit -m "$(cat <<'EOF'
fix: correct core/ script paths in live-runtime docs

modes/telegram.md, core/AGENTS.md, every plugin's skill.md, and
batch/batch-prompt.md all still referenced core/*.mjs scripts by their
pre-2026-08-15 bare root-level path. These are files an agent actually
executes shell commands from at runtime -- modes/telegram.md's Step 3a
"Acknowledge immediately" (node plugins.mjs run telegram notify ...)
is the exact command whose MODULE_NOT_FOUND failure motivated this
whole plan, found live 2026-08-20 investigating a missing Telegram
acknowledgment on a running /run cycle.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Fix human-facing docs

**Files:**
- Modify: `CONTRIBUTING.md`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `tests/README.md`
- Modify: `dashboard/README.md`
- Modify: `providers/README.md`
- Modify: `DATA_CONTRACT.md`
- Modify: `DOCKER.md`
- Modify: `templates/README.md`
- Modify: `seeds/README.md`
- Modify: `plugins/README.md`
- Modify: any `examples/*.md` file the check reports (confirm exact filenames from the check's own output — likely includes `examples/latex-tex/README.md` and `examples/ats-normalization-test.md`, but read the check's real output rather than assuming this list is exhaustive)

**Interfaces:**
- Consumes: Task 1's `core/validate-script-references.mjs`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Get the current, authoritative violation list for this task's files**

```bash
node core/validate-script-references.mjs 2>&1 | grep -vE "^  (modes/telegram\.md|core/AGENTS\.md|plugins/(telegram|discord|notion|gmail|_template|apify)/skill\.md|batch/batch-prompt\.md|README(\.\w+)?\.md):"
```

(This excludes Task 4's already-fixed files and Task 6's README files, which get their own task — everything else remaining is this task's scope. Read the full output before editing.)

- [ ] **Step 2: Fix each violation**

Same mechanical rule as Task 4 Step 2: for each reported `{file}:{line}`, change `node {script}` to `node core/{script}`, or for `DOCKER.md`'s `./cops node check-liveness.mjs <url>` row specifically, to `./cops node core/check-liveness.mjs <url>` — verified earlier that `./cops`'s `node|npm|npx|go|bash|sh` case forwards the command as-is into the container with no path translation, so this is a real, live-facing fix, not cosmetic. Read each file's surrounding context before editing (some of these, like `DATA_CONTRACT.md`'s `assessment-log.mjs`/`tracker.mjs` references, are inline in explanatory prose rather than a standalone code block — the fix is the same mechanical substitution either way).

- [ ] **Step 3: Re-run the check to confirm this task's files are clean**

```bash
node core/validate-script-references.mjs 2>&1 | grep -vE "^  (modes/telegram\.md|core/AGENTS\.md|plugins/(telegram|discord|notion|gmail|_template|apify)/skill\.md|batch/batch-prompt\.md|README(\.\w+)?\.md):"
```

Expected: no output (only README-related violations, handled by Task 6, remain).

- [ ] **Step 4: Run the full test suite**

```bash
node core/test-all.mjs
```

Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add CONTRIBUTING.md .github/PULL_REQUEST_TEMPLATE.md tests/README.md dashboard/README.md providers/README.md DATA_CONTRACT.md DOCKER.md templates/README.md seeds/README.md plugins/README.md examples/
git commit -m "$(cat <<'EOF'
fix: correct core/ script paths in contributor-facing docs

CONTRIBUTING.md, the PR template, and every other doc a human
contributor actually follows (tests/README.md, dashboard/README.md,
providers/README.md, DATA_CONTRACT.md, DOCKER.md, templates/README.md,
seeds/README.md, plugins/README.md, examples/*.md) still documented
the pre-2026-08-15 root-level script paths. Anyone following
CONTRIBUTING.md's own documented `node test-all.mjs` workflow would
hit the same MODULE_NOT_FOUND failure CI itself was hitting.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Fix `README.md` across all language variants

**Files:**
- Modify: `README.md`
- Modify: `README.ar.md`, `README.cn.md`, `README.da.md`, `README.de.md`, `README.fr.md`, `README.hi.md`, `README.pl.md`, `README.ta.md`, `README.tr.md` (confirm this exact filename set against the repo root — the check's own output is authoritative if it finds a different set)

**Interfaces:**
- Consumes: Task 1's `core/validate-script-references.mjs`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Get the current, authoritative violation list for this task's files**

```bash
node core/validate-script-references.mjs 2>&1 | grep -E "^  README(\.\w+)?\.md:"
```

- [ ] **Step 2: Fix each violation**

Same mechanical rule as Task 4/5: change `node {script}` to `node core/{script}` at each reported line. **Do not touch anything else on these lines or in the surrounding prose** — the commands appear inside code blocks and inline snippets across many languages (Arabic, Chinese, Danish, German, French, Hindi, Polish, Tamil, Turkish); only the code-block command text needs to change (`node scan.mjs` → `node core/scan.mjs`, etc.), never the translated prose around it. This is language-neutral — the shell command syntax itself carries no translation content.

- [ ] **Step 3: Re-run the check to confirm this task's files are clean**

```bash
node core/validate-script-references.mjs 2>&1 | grep -E "^  README(\.\w+)?\.md:"
```

Expected: no output.

- [ ] **Step 4: Run the full test suite**

```bash
node core/test-all.mjs
```

Expected: **zero remaining violations from Task 1's `validate-script-references.mjs`-derived assertion** — this is the first point in the plan where that specific assertion should go fully green, since Tasks 2-6 together cover every category the spec identified except the two remaining prose-only tasks below (`ARCHITECTURE.md`'s principle and the durable convention note, neither of which are bare script-path violations the checker itself flags).

- [ ] **Step 5: Commit**

```bash
git add README.md README.ar.md README.cn.md README.da.md README.de.md README.fr.md README.hi.md README.pl.md README.ta.md README.tr.md
git commit -m "$(cat <<'EOF'
fix: correct core/ script paths in README across all language variants

The same handful of commands (node scan.mjs, node gemini-eval.mjs,
node agent-inbox.mjs) appear in code blocks across README.md and all
~8 translated variants, all still at the pre-2026-08-15 root-level
path. Fixed the command text only -- translated prose is untouched,
since the shell command syntax itself carries no language content.

This is the last category of stale reference validate-script-
references.mjs was built to catch -- that assertion in test-all.mjs
now passes clean.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Rewrite `ARCHITECTURE.md`'s stale principle

**Files:**
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is prose, not a script reference the checker flags).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Read the current section in full**

Read `ARCHITECTURE.md` around line 28 (the `#1386` "repo keeps its ~70 scripts at the root deliberately" section) and enough surrounding context to understand the section's full scope before rewriting — this task changes the section's content, not just one sentence, so read broadly enough to preserve whatever else the section legitimately still says.

- [ ] **Step 2: Rewrite the principle**

Find the paragraph containing (verify exact current wording first, since it may include more surrounding sentences than the fragment quoted during planning):

```
The repo keeps its ~70 scripts at the root deliberately ([#1386](https://github.com/santifer/career-ops/issues/1386)). Path stability is a feature here, not an accident: the updater's `SYSTEM_PATHS` allowlist, community plugins, docs, guides, and the muscle memory of thousands of users (`node scan.mjs`) all reference these paths. A cosmetic reorganization would break forks and plugins for no functional gain.
```

Replace with:

```
Scripts live in `core/` as of the 2026-08-15 multi-tenancy work (#1386 originally argued the opposite — see below for why that changed). Every per-user workspace junctions one stable `core/` directory rather than symlinking dozens of individual files; moving the scripts into a single directory was a structural requirement of that design, not a cosmetic reorganization. Path stability is still a real value here — the updater's `SYSTEM_PATHS` allowlist, community plugins, docs, guides, and user muscle memory (`node core/scan.mjs`) all still depend on it — but it's now guaranteed by an automated check (`core/validate-script-references.mjs`, run on every `test-all.mjs` invocation and in CI) rather than by never moving anything. That guarantee was silently absent for one specific class of reference (shell-invocation strings in docs/CI, as opposed to JS import paths) from 2026-08-15 until a 2026-08-20 incident surfaced it — the check exists so that gap can't recur.
```

- [ ] **Step 3: Verify the rewrite reads coherently in context**

Read the full section again after editing (not just the diff) to confirm it flows naturally with whatever text immediately precedes and follows it, and that no other sentence in the same section still asserts the now-superseded "scripts stay at root" claim as if it were still true.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "$(cat <<'EOF'
docs: update ARCHITECTURE.md's script-location principle to match reality

The #1386 principle ("scripts stay at root, moving them is cosmetic
with no functional gain") was silently overridden by the 2026-08-15
multi-tenancy work, which moved ~70 scripts into core/ for a real
structural reason (per-workspace junctions need one stable directory).
Rewrote the section to state current reality, explain why it changed,
and point at the new automated guard (core/validate-script-
references.mjs) as what now guarantees the same path-stability value
the original principle was protecting -- mechanically, not by policy.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Durable convention note in `core/AGENTS.md` + final verification

**Files:**
- Modify: `core/AGENTS.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks — this is the final task in the plan.

- [ ] **Step 1: Read the current "Stack and Conventions" section**

Read `core/AGENTS.md` around line 377 (`## Stack and Conventions`) through line 384 (just before `### TSV Format for Tracker Additions`) to confirm current exact content — Task 4 already fixed this section's own `node merge-tracker.mjs` reference, so re-read post-Task-4 content, not the pre-Task-4 version seen during planning.

- [ ] **Step 2: Add the convention note**

Find (the line immediately before `### TSV Format for Tracker Additions`):

```
- **RULE: NEVER create new entries in applications.md if company+role already exists.** Update the existing entry.
```

Replace with:

```
- **RULE: NEVER create new entries in applications.md if company+role already exists.** Update the existing entry.
- **RULE: Moving or renaming any script requires TWO reference sweeps, not one.** The internal import/require graph among the moved files (`grep -rnE "(from|require)\s*\(?['\"]\./" core/*.mjs` style) catches JS-level breakage. It does **not** catch the other kind of reference these scripts have: a bare `node {script}` shell-command invocation written in prose — a mode file, a README, a CI workflow step. That second sweep (`grep -rn "node {old-name}" --include="*.md" --include="*.yml"`) is what a 2026-08-15 move skipped for one task while getting it right for three others in the same plan, and it silently broke a live Telegram acknowledgment, CI itself, and the self-updater's own re-exec path for five days before anyone noticed. `core/validate-script-references.mjs` (run automatically by `test-all.mjs`/CI) is the mechanical backstop that catches this now if it's ever missed again — but do the sweep anyway; the check should never be the first line of defense, only the one that can't be forgotten.
```

(If the actual elapsed time between 2026-08-15 and 2026-08-20 differs from "five days" once you check both dates directly, correct the number — don't leave an unverified claim.)

- [ ] **Step 3: Final verification — the full suite is clean**

```bash
node core/test-all.mjs
```

Expected: full suite green, matching (or exceeding, with the new Task 1 assertions counted) the baseline pass count from before this plan began. Specifically confirm `node core/validate-script-references.mjs` alone exits 0:

```bash
node core/validate-script-references.mjs
```

Expected: `OK: {N} doc/CI files scanned against {M} core/ scripts, no stale bare references`.

- [ ] **Step 4: Commit**

```bash
git add core/AGENTS.md
git commit -m "$(cat <<'EOF'
docs: add durable convention note for future script moves

core/AGENTS.md is read automatically every session -- names the
checklist explicitly (import-graph sweep AND external doc/CI
reference sweep, both, every time a script moves) rather than relying
on core/validate-script-references.mjs alone to catch a future gap.
The check is the backstop; this note is what should make it
unnecessary in the first place. Closes out the core-path-reference-
sync plan -- validate-script-references.mjs now passes clean against
the full repo.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** every Component in the spec (regression check, `update-system.mjs` fix, CI fixes, doc remediation by category, `ARCHITECTURE.md` rewrite, durable convention note) has a corresponding task above. The spec's Testing section's four points are covered: the check's own logic (Task 1), the `update-system.mjs` targeted verification (Task 2 Step 5, with the exact test approach left to the implementer per the spec's own deferral), CI fixes verified by local inspection since no CI runner is available here (Task 3 Step 4), and doc remediation verified by re-running the check per category (Tasks 4-6 Step 3, Task 6 Step 4 for the full zero-violations state).
- **Ordering dependency:** Tasks 2-8 all depend on Task 1 existing (they all invoke `core/validate-script-references.mjs`), so Task 1 must run first and its script must actually work before any later task can get its authoritative violation list. Tasks 2 and 3 do not depend on each other or on Tasks 4-6's doc fixes — they could technically run in parallel with those, but per subagent-driven-development's own rule against parallel implementer dispatch, they still run sequentially in the order presented (severity order, matching the spec's own Architecture section).
- **No task hardcodes today's exact violation list as literal file edits** — per the spec's explicit instruction ("the plan should NOT hardcode exact line numbers this far in advance... the check's own output is authoritative, not this session's earlier manual grep sweep"). Every doc-fixing task instead specifies the exact, unambiguous mechanical transformation rule and has its implementer pull the real current violation list from the tool built in Task 1 — the same pattern the original workspace-multitenancy-core plan's own Task 1 used ("the exact set depends on what the grep returns... apply this rule file-by-file using Edit rather than a blind sed").
