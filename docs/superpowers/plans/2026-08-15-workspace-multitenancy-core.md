# Workspace / Multi-Tenancy Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure career-ops so multiple people can share one codebase while each person's CV, profile, targeting keywords, tracker, reports, and PDFs stay filesystem-isolated in their own `workspaces/{slug}/` directory.

**Architecture:** Root-level `*.mjs` scripts and every other mixed-content directory move so the repo splits cleanly into System Layer (whole directories, safe to junction) and User Layer (real per-workspace files). A new `provision-workspace.mjs` creates each workspace's directory junctions + seeded real files; a `workspaceRoot()` helper (`CAREER_OPS_WORKSPACE` env override, else `process.cwd()`) replaces the `ROOT`-based resolution scripts currently use for user-layer paths; a separate `hub-paths.mjs` hard-codes the two paths that must never become workspace-scoped.

**Tech Stack:** Node.js (`.mjs`, ESM), Windows directory junctions (`fs.symlinkSync(target, path, 'junction')`) / POSIX symlinks, existing `test-all.mjs` test harness.

**Spec:** `docs/superpowers/specs/2026-08-15-workspace-multitenancy-core-design.md`

## Global Constraints

- No file-level symlinks anywhere (require admin/Developer Mode on Windows) — every shared reference is either a whole-directory junction/symlink, or a seeded real copy for genuinely mixed directories. Never a hardlink (goes stale on `git checkout`-based writes).
- `update-system.mjs` and everything downstream of it (`VERSION`, `CANONICAL_REPO`, its test coverage) is **never deleted or edited for removal** — only `AGENTS.md`'s automatic-invocation section goes away.
- `SYSTEM_PATHS` (in `update-system.mjs`) stays the single source of truth for what's System Layer — `provision-workspace.mjs` imports it, never duplicates it.
- Workspace slugs match `^[a-z0-9][a-z0-9-]{1,31}$`; anything else is rejected before it touches a path.
- A solo user who never creates a workspace must see **zero** behavior change — `workspaceRoot()` falls back to `process.cwd()`, which **is** the repo root for that user.
- Every task ends with `node core/test-all.mjs` (or the specific new test file for that task) passing before commit.

## Two corrections to the spec, discovered during planning (both applied below, not deferred):

1. `batch/` and `interview-prep/sessions/` are mixed System/User directories, same shape as `modes/`/`config/`, that the spec didn't name. Fixed the same way: `batch/`'s user-runtime content (`tracker-additions/`, `batch-state.tsv`, `logs/`, `wave*`, `*-worker.mjs`) relocates into `data/`, making `batch/` purely junctionable; `interview-prep/sessions/`'s two system scaffold files (`.gitkeep`, `README.md`) are seeded as real copies at provisioning time (a `.gitkeep`/README essentially never changes, so drift risk is negligible).
2. The junction set is **not** "every `SYSTEM_PATHS` entry" — most entries are standalone docs nothing reads relative to a workspace's `cwd` at runtime. The actual junction list (Task 7) is the fixed set of directories genuinely dereferenced by workspace-relative operations: `core/`, `modes/`, `templates/`, `providers/`, `plugins/`, `plugins-registry/`, `docs/`, `dashboard/`, `fonts/`, `examples/`, `lib/`, `batch/` (after fix #1), `.agents/`, `.claude/skills/`, `.cursor/skills/`, `.opencode/skills/`, `.opencode/commands/`, `.grok/skills/`, `.kimi/skills/`, `.antigravitycli/skills/`, `.qwen/`, `.claude-plugin/`.

Final destination for `_profile.md`/`_custom.md`/`_brief.md` (spec left this open): **repo root, alongside `cv.md`** — not a new subdirectory. Simplest option, matches how `cv.md` already sits there.

---

### Task 1: Move root-level scripts into `core/`

**Files:**
- Create: `core/` (137 `.mjs` files moved here via `git mv`)
- Modify: `package.json` (46 `scripts` entries get `core/` prefix)
- Test: existing `test-all.mjs` suite (verifies nothing broke, not new tests)

**Interfaces:**
- Consumes: nothing from earlier tasks (this is Task 1)
- Produces: `core/` as the real location every later task's scripts live in. Every subsequent task's "Modify: X.mjs" paths mean `core/X.mjs`.

- [ ] **Step 1: Write the move script**

Create a throwaway file `.tmp/move-to-core.sh` (not committed — cleanup in Step 5):

```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p core
# Every root-level *.mjs file, one git mv per line. Generated from the
# repo-root `.mjs` file listing captured during planning (137 files).
for f in \
  add-entry.mjs agent-inbox.mjs agent-inbox-tests.mjs analyze-patterns.mjs \
  application-answers.mjs application-artifacts.mjs archive-posting.mjs \
  assessment-log.mjs batch-tailor.mjs browser-extract.mjs build-cv-html.mjs \
  build-cv-latex.mjs build-dashboard.mjs build-digest.mjs check-liveness.mjs \
  check-table-freshness.mjs classify-tier.mjs company-funded.mjs \
  company-history.mjs company-history.test.mjs contacts.mjs contacts.test.mjs \
  cv-sections-core.mjs cv-sync-check.mjs cv-templates.mjs cycle-lock.mjs \
  cycle-status.mjs dedup-tracker.mjs detect-reposts.mjs detect-reposts.test.mjs \
  discord-ticker.mjs discover-ats.mjs discover-ats.test.mjs doctor.mjs \
  eval-golden.mjs extract-latex-content.mjs find.mjs fingerprint-core.mjs \
  fix-slugs.mjs followup-cadence.mjs followup-cadence.test.mjs \
  followup-seed.mjs followup-seed-tests.mjs funnel-velocity.mjs gemini-eval.mjs \
  generate-cover-letter.mjs generate-latex.mjs generate-pdf.mjs img-to-pdf.mjs \
  invite-match.mjs invite-match.test.mjs jd-fetch-cache.mjs jd-field-extract.mjs \
  jd-similarity.mjs jd-similarity.test.mjs jd-skill-gap.mjs jsonc-parse.mjs \
  liveness-api.mjs liveness-browser.mjs liveness-core.mjs manifesto.mjs \
  mark-pdf-ready.mjs match-star.mjs merge-tracker.mjs normalize-statuses.mjs \
  ollama-eval.mjs openai-eval.mjs openai-tailor.mjs openrouter-runner.mjs \
  outcome.mjs paste-reply.mjs paste-reply-tests.mjs patch-latex-content.mjs \
  pipeline-lock.mjs playwright.cv.config.mjs plugin-audit.mjs \
  plugin-install.mjs plugins.mjs portal-health-lock.mjs prepare-application.mjs \
  process-quality.mjs process-quality.test.mjs profile-language.mjs \
  reconcile-pipeline.mjs reply-matcher.mjs reply-matcher.test.mjs \
  reply-watch.mjs reserve-report-num.mjs role-matcher.mjs salary-gap.mjs \
  scan.mjs scan-ats-full.mjs scan-interamt.mjs seed-fixture.mjs \
  set-status.mjs set-status-tests.mjs skill-extract.mjs stats.mjs \
  sync-pdf-flags.mjs telegram-monitor.mjs telegram-poll.mjs \
  telegram-set-commands.mjs test-all.mjs test-salary-filter.mjs \
  test-trust-validator.mjs theme-style.mjs tracker.mjs \
  tracker-columns-tests.mjs tracker-links.mjs tracker-parse.mjs \
  tracker-utils.mjs tracker-writer-lock-tests.mjs updater-migration-tests.mjs \
  update-system.mjs upgrade-tests.mjs upskill.mjs validate-plugin-registry.mjs \
  validate-portals.mjs validate-system-paths-coverage.mjs \
  validate-untrusted-content-coverage.mjs verify-cv-facts.mjs \
  verify-jd-coverage.mjs verify-pipeline.mjs verify-portals.mjs \
  weekly-digest.mjs
do
  git mv "$f" "core/$f"
done
```

- [ ] **Step 2: Run the move script**

Run: `bash .tmp/move-to-core.sh`
Expected: 137 files now under `core/`, `git status` shows them as renames.

- [ ] **Step 3: Fix relative imports/paths that now point the wrong way**

Every moved file's relative reference to a directory that did **not** move (`plugins/`, `providers/`, `templates/`, `dashboard/`, `batch/`, `config/`, `data/`, `tests/`, `lib/`, `docs/`) needs one extra `../` prepended, since the file's own location gained one directory level. A reference to another moved `.mjs` sibling needs **no** change (both files moved together).

Run this to find every candidate site across the moved files:

```bash
grep -rnE "(from|require)\s*\(?['\"]\./(plugins|providers|templates|dashboard|batch|config|data|tests|lib|docs)/" core/*.mjs
grep -rnE "join\(\s*(ROOT|__dirname|CAREER_OPS)\s*,\s*['\"](plugins|providers|templates|dashboard|batch|config|data|tests|lib|docs)" core/*.mjs
```

For each match, prepend `../` to the target (e.g. `'./plugins/_engine.mjs'` → `'../plugins/_engine.mjs'`, `join(ROOT, 'templates', ...)` → `join(ROOT, '..', 'templates', ...)`). Fix every match found — the exact set depends on what the grep returns, so apply this rule file-by-file using `Edit` rather than a blind sed (a mechanical rule, but the site list must come from the actual grep output, not be pre-guessed here).

- [ ] **Step 4: Update `package.json`'s `scripts` block**

Modify `package.json` — every entry below currently reads `"node <file>.mjs ..."`; change to `"node core/<file>.mjs ..."` (46 entries, `test:cv-visual`/`test:cv-visual:update`/`serve:dashboard`/`postinstall` are unaffected since they don't invoke a root `.mjs` file directly):

```json
{
  "scripts": {
    "doctor": "node core/doctor.mjs",
    "or": "node core/openrouter-runner.mjs",
    "or:scan": "node core/openrouter-runner.mjs scan",
    "or:pipeline": "node core/openrouter-runner.mjs pipeline",
    "or:eval": "node core/openrouter-runner.mjs evaluate",
    "or:apply": "node core/openrouter-runner.mjs apply",
    "verify": "node core/verify-pipeline.mjs",
    "normalize": "node core/normalize-statuses.mjs",
    "dedup": "node core/dedup-tracker.mjs",
    "merge": "node core/merge-tracker.mjs",
    "reconcile": "node core/reconcile-pipeline.mjs",
    "pdf": "node core/generate-pdf.mjs",
    "jd:similarity": "node core/jd-similarity.mjs",
    "img-to-pdf": "node core/img-to-pdf.mjs",
    "cover-letter": "node core/generate-cover-letter.mjs --payload",
    "cv:verify-facts": "node core/verify-cv-facts.mjs",
    "test:cv-visual": "playwright test --config=playwright.cv.config.mjs",
    "test:cv-visual:update": "playwright test --config=playwright.cv.config.mjs --update-snapshots",
    "sync-check": "node core/cv-sync-check.mjs",
    "update:check": "node core/update-system.mjs check",
    "update:test": "node core/updater-migration-tests.mjs",
    "update": "node core/update-system.mjs apply",
    "rollback": "node core/update-system.mjs rollback",
    "liveness": "node core/check-liveness.mjs",
    "extract": "node core/browser-extract.mjs",
    "scan": "node core/scan.mjs",
    "scan:full": "node core/scan-ats-full.mjs",
    "scan:seeds": "node core/scan-ats-full.mjs --seeds yc,a16z",
    "scan:yc": "node core/scan-ats-full.mjs --seeds yc",
    "scan:interamt": "node core/scan-interamt.mjs",
    "company:funded": "node core/company-funded.mjs",
    "validate:portals": "node core/validate-portals.mjs",
    "verify:portals": "node core/verify-portals.mjs",
    "tracker": "node core/tracker.mjs",
    "find": "node core/find.mjs",
    "patterns": "node core/analyze-patterns.mjs",
    "upskill": "node core/upskill.mjs",
    "add": "node core/add-entry.mjs",
    "reposts": "node core/detect-reposts.mjs",
    "digest": "node core/weekly-digest.mjs",
    "freshness": "node core/check-table-freshness.mjs",
    "invite-match": "node core/invite-match.mjs",
    "paste-reply": "node core/paste-reply.mjs",
    "gemini:eval": "node core/gemini-eval.mjs",
    "ollama:eval": "node core/ollama-eval.mjs",
    "openai:eval": "node core/openai-eval.mjs",
    "openai:tailor": "node core/openai-tailor.mjs",
    "eval:golden": "node core/eval-golden.mjs",
    "star": "node core/match-star.mjs",
    "archive": "node core/archive-posting.mjs",
    "prepare:application": "node core/prepare-application.mjs",
    "application:init": "node core/application-artifacts.mjs --init",
    "build:dashboard": "node core/build-dashboard.mjs",
    "serve:dashboard": "cd dashboard && go run . --path ..",
    "postinstall": "npx playwright install chromium --with-deps || npx playwright install chromium --with-deps",
    "manifesto": "node core/manifesto.mjs"
  }
}
```

Keep every other `package.json` key (`name`, `version`, `dependencies`, etc.) untouched — only the `scripts` block changes.

- [ ] **Step 5: Clean up the throwaway move script and run the test suite**

```bash
rm .tmp/move-to-core.sh
node core/test-all.mjs
```

Expected: some failures on the first run (import paths this step's grep missed). Fix each reported failure the same way as Step 3 (add the missing `../`), re-run, repeat until `test-all.mjs` passes.

- [ ] **Step 6: Commit**

```bash
git add -A -- core/ package.json
git commit -m "refactor: move root-level scripts into core/ for workspace junctioning"
```

---

### Task 2: Relocate `config/plugins.example.yml` to `templates/`, and rescue the `interview-prep/sessions/` scaffold files

**Files:**
- Modify: `config/plugins.example.yml` → `templates/plugins.example.yml` (git mv)
- Modify: `interview-prep/sessions/.gitkeep` → `templates/interview-prep-sessions/.gitkeep`, `interview-prep/sessions/README.md` → `templates/interview-prep-sessions/README.md` (git mv) — see note below
- Modify: `modes/telegram.md`, `core/plugins.mjs`, `core/test-all.mjs`, `DATA_CONTRACT.md`, `core/update-system.mjs` (four `SYSTEM_PATHS`/`BOOTSTRAP_PATHS` references total — see Step 2), `plugins/README.md`, `docs/PLUGIN_REVIEW.md`
- Test: `core/test-all.mjs`

**Interfaces:**
- Consumes: `core/` from Task 1 (the referencing scripts now live there)
- Produces: `config/` is now a pure User Layer directory — no System Layer files remain in it. `templates/interview-prep-sessions/.gitkeep` and `templates/interview-prep-sessions/README.md` become the permanent template source Task 10's `provision-workspace.mjs` seeds new workspaces from.

**Why the `interview-prep/sessions/` move is bundled into this task:** Task 15 (operator's own data migration) does a full `git mv interview-prep workspaces/{slug}/interview-prep` — if the two system-owned scaffold files stayed inside `interview-prep/sessions/` at the repo root, that move would carry them into Roberto's own workspace and leave the repo root with no `interview-prep/` directory at all. Any *later* workspace provisioned after that migration would then silently fail to seed those two files (`provision-workspace.mjs`'s `seedFile()` treats a missing template source as a no-op, not an error — see Task 10 Step 3). Relocating them to `templates/` now, before Task 15 ever runs, keeps them permanently available regardless of what happens to any one workspace's own `interview-prep/` content.

- [ ] **Step 1: Move both sets of files**

```bash
git mv config/plugins.example.yml templates/plugins.example.yml
mkdir -p templates/interview-prep-sessions
git mv interview-prep/sessions/.gitkeep templates/interview-prep-sessions/.gitkeep
git mv interview-prep/sessions/README.md templates/interview-prep-sessions/README.md
```

- [ ] **Step 2: Update every reference**

In each of `modes/telegram.md`, `core/plugins.mjs`, `core/test-all.mjs`, `DATA_CONTRACT.md`, `core/update-system.mjs` (both `SYSTEM_PATHS` line `'config/plugins.example.yml'` and `BOOTSTRAP_PATHS` line `'config/plugins.example.yml'`), `plugins/README.md`, `docs/PLUGIN_REVIEW.md`: replace the literal string `config/plugins.example.yml` with `templates/plugins.example.yml`. Use `Edit` per file (each occurrence's surrounding context differs — e.g. `AGENTS.md`'s onboarding text says `cp config/plugins.example.yml config/plugins.yml`, which becomes `cp templates/plugins.example.yml config/plugins.yml`).

Additionally, in `core/update-system.mjs`'s `SYSTEM_PATHS` array, replace the two lines `'interview-prep/sessions/.gitkeep'` and `'interview-prep/sessions/README.md'` with `'templates/interview-prep-sessions/.gitkeep'` and `'templates/interview-prep-sessions/README.md'`. Check `DATA_CONTRACT.md` for any reference to these two paths and update it the same way.

- [ ] **Step 3: Verify no stale references remain**

```bash
grep -rn "config/plugins.example.yml" --include="*.md" --include="*.mjs" .
grep -rn "interview-prep/sessions/\.gitkeep\|interview-prep/sessions/README\.md" --include="*.md" --include="*.mjs" .
```

Expected: no output for the first command (empty). The second command should only match the literal directory structure comment in `.gitignore` (lines describing `interview-prep/sessions/*` — that pattern is about the WORKSPACE-level real directory going forward, not the template source, and stays as-is) — no match should point at a *source* reference to the old repo-root template location.

- [ ] **Step 4: Run tests and commit**

```bash
node core/test-all.mjs
git add -A -- config/ templates/plugins.example.yml templates/interview-prep-sessions/ interview-prep/ modes/telegram.md core/plugins.mjs core/test-all.mjs DATA_CONTRACT.md core/update-system.mjs plugins/README.md docs/PLUGIN_REVIEW.md
git commit -m "refactor: move config/plugins.example.yml and interview-prep/sessions/ scaffold to templates/"
```

---

### Task 3: Relocate `modes/_profile.md`, `modes/_custom.md`, `modes/_brief.md` to the repo root

**Files:**
- Modify: `core/doctor.mjs` (`USER_LAYER_PREREQS`, the `templates` copy-pair array)
- Modify: every file referencing `modes/_profile.md`, `modes/_custom.md`, or `modes/_brief.md` (132 reference sites across ~84+32+16 files, per the research pass — bulk find-and-replace)
- Modify: `.gitignore` (3 lines)
- Test: `core/test-all.mjs`

**Interfaces:**
- Consumes: `core/` from Task 1
- Produces: `modes/` is now a pure System Layer directory — `_profile.md`/`_custom.md`/`_brief.md` live at the repo root, same level as `cv.md`. The **templates** (`modes/_profile.template.md`, `modes/_custom.template.md`, `modes/_brief.template.md`) stay in `modes/` unchanged — only the destination instance files move.

- [ ] **Step 1: Update `doctor.mjs`'s prereq and template-copy logic**

Modify `core/doctor.mjs` — change the `modes/_profile.md` entry in `USER_LAYER_PREREQS`:

```js
const USER_LAYER_PREREQS = [
  { path: 'cv.md', fix: ['Create cv.md in the project root with your CV in markdown', 'See examples/ for reference CVs'] },
  { path: 'config/profile.yml', fix: ['Run: cp config/profile.example.yml config/profile.yml', 'Then edit it with your details'] },
  { path: '_profile.md', fix: ['Run: cp modes/_profile.template.md _profile.md', 'Then customize your archetypes / targeting narrative'] },
  { path: 'portals.yml', fix: ['Run: cp templates/portals.example.yml portals.yml', 'Then customize with your target companies'] },
];
```

And the template copy-pair array (destination paths change, template source paths stay in `modes/`):

```js
const templates = [
  { target: '_profile.md', template: 'modes/_profile.template.md' },
  { target: '_custom.md', template: 'modes/_custom.template.md' },
  { target: '_brief.md', template: 'modes/_brief.template.md' },
];
```

- [ ] **Step 2: Bulk find-and-replace across the repo**

Run this from the repo root — literal string replacement, safe against accidentally matching `modes/_profile.template.md` since that string never contains the substring `modes/_profile.md`:

```bash
grep -rl "modes/_profile\.md" --include="*.md" --include="*.mjs" --include="*.yml" --include="*.json" . \
  | grep -v "modes/_profile.template.md" \
  | xargs sed -i 's|modes/_profile\.md|_profile.md|g'
grep -rl "modes/_custom\.md" --include="*.md" --include="*.mjs" --include="*.yml" --include="*.json" . \
  | xargs sed -i 's|modes/_custom\.md|_custom.md|g'
grep -rl "modes/_brief\.md" --include="*.md" --include="*.mjs" --include="*.yml" --include="*.json" . \
  | grep -v "modes/_brief.template.md" \
  | xargs sed -i 's|modes/_brief\.md|_brief.md|g'
```

- [ ] **Step 3: Verify no stale references remain**

```bash
grep -rn "modes/_profile\.md\b" --include="*.md" --include="*.mjs" . | grep -v template
grep -rn "modes/_custom\.md\b" --include="*.md" --include="*.mjs" .
grep -rn "modes/_brief\.md\b" --include="*.md" --include="*.mjs" . | grep -v template
```

Expected: no output for all three. If the per-CLI `.claude/skills/career-ops/SKILL.md`-style files (`.cursor/`, `.opencode/`, `.qwen/`, `.antigravitycli/`, `.grok/`, `.kimi/`, `.agents/`) are generated/derived from a canonical source rather than hand-maintained, find that source (check for a `scaffolder/` script or generation step referenced in `package.json`/docs) and regenerate them instead of hand-editing each — if no such generator exists, edit each of the 8 directly.

- [ ] **Step 4: Update `.gitignore`**

Modify `.gitignore` — replace these three lines (currently under "User config and customization"):

```
config/profile.yml
config/cv-facts.json
config/benchmarks.yml
portals.yml
modes/_profile.md
modes/_custom.md
modes/_brief.md
```

with:

```
config/profile.yml
config/cv-facts.json
config/benchmarks.yml
portals.yml
_profile.md
_custom.md
_brief.md
```

- [ ] **Step 5: Run tests and commit**

```bash
node core/test-all.mjs
git add -A
git commit -m "refactor: relocate _profile.md/_custom.md/_brief.md out of modes/ so it becomes pure system-layer"
```

---

### Task 4: `hub-paths.mjs` — the two paths that must never become workspace-scoped

**Files:**
- Create: `core/hub-paths.mjs`
- Create: `tests/hub-paths.test.mjs`
- Modify: `core/telegram-poll.mjs` (replace inline `offsetPath()` computation)
- Modify: `core/telegram-monitor.mjs` (replace inline `DAEMON_LOCK_PATH` computation)

**Interfaces:**
- Consumes: `core/` from Task 1
- Produces: `telegramOffsetPath()`, `telegramDaemonLockPath()` — both zero-argument functions returning absolute paths always resolved off `hub-paths.mjs`'s own real location, never `process.cwd()` or `CAREER_OPS_WORKSPACE`.

- [ ] **Step 1: Write the failing test**

Create `tests/hub-paths.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegramOffsetPath, telegramDaemonLockPath } from '../core/hub-paths.mjs';

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'core');

test('telegramOffsetPath resolves under core/data regardless of cwd', () => {
  const original = process.cwd();
  process.chdir('/tmp');
  try {
    const p = telegramOffsetPath();
    assert.equal(p, join(CORE_DIR, 'data', 'telegram-offset.json'));
  } finally {
    process.chdir(original);
  }
});

test('telegramDaemonLockPath resolves under core/data regardless of cwd', () => {
  const original = process.cwd();
  process.chdir('/tmp');
  try {
    const p = telegramDaemonLockPath();
    assert.equal(p, join(CORE_DIR, 'data', 'telegram-daemon'));
  } finally {
    process.chdir(original);
  }
});

test('paths are unaffected by CAREER_OPS_WORKSPACE', () => {
  process.env.CAREER_OPS_WORKSPACE = '/some/other/workspace';
  try {
    const p = telegramOffsetPath();
    assert.equal(p, join(CORE_DIR, 'data', 'telegram-offset.json'));
  } finally {
    delete process.env.CAREER_OPS_WORKSPACE;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hub-paths.test.mjs`
Expected: FAIL with "Cannot find module '../core/hub-paths.mjs'"

- [ ] **Step 3: Write `core/hub-paths.mjs`**

```js
// @ts-check
// hub-paths.mjs — the two paths that must NEVER follow workspace resolution.
// There is exactly one Telegram poller for the whole system (Telegram rejects
// concurrent getUpdates on the same bot token), so its cursor and daemon lock
// always resolve off this file's own real location — never process.cwd() or
// CAREER_OPS_WORKSPACE. Deliberately a different function shape than
// workspace-root.mjs's workspaceRoot() so a caller can't accidentally reach
// for the wrong one.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function telegramOffsetPath() {
  return join(ROOT, 'data', 'telegram-offset.json');
}

export function telegramDaemonLockPath() {
  return join(ROOT, 'data', 'telegram-daemon');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hub-paths.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire it into `telegram-poll.mjs`**

Modify `core/telegram-poll.mjs` — replace the existing `offsetPath()` function and its `ROOT`-based body:

```js
import { telegramOffsetPath } from './hub-paths.mjs';

function offsetPath() {
  return process.env.CAREER_OPS_TELEGRAM_OFFSET || telegramOffsetPath();
}
```

(Keeps the existing `CAREER_OPS_TELEGRAM_OFFSET` override, which stays a legitimate hub-level override — it's still not workspace-scoped, just operator-overridable.)

- [ ] **Step 6: Wire it into `telegram-monitor.mjs`**

Modify `core/telegram-monitor.mjs` — replace the `DAEMON_LOCK_PATH` constant:

```js
import { telegramDaemonLockPath } from './hub-paths.mjs';

const DAEMON_LOCK_PATH = telegramDaemonLockPath();
```

- [ ] **Step 7: Run the full test suite and commit**

```bash
node core/test-all.mjs
git add core/hub-paths.mjs tests/hub-paths.test.mjs core/telegram-poll.mjs core/telegram-monitor.mjs
git commit -m "feat: add hub-paths.mjs for the two paths that must stay hub-global"
```

---

### Task 5: `workspace-root.mjs` — the `workspaceRoot()` helper

**Files:**
- Create: `core/workspace-root.mjs`
- Create: `tests/workspace-root.test.mjs`

**Interfaces:**
- Consumes: nothing (standalone helper)
- Produces: `workspaceRoot()` — zero-argument function returning `process.env.CAREER_OPS_WORKSPACE` if set, else `process.cwd()`. Every later task that migrates a script's user-layer path resolution imports this.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace-root.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceRoot } from '../core/workspace-root.mjs';

test('falls back to process.cwd() when CAREER_OPS_WORKSPACE is unset', () => {
  delete process.env.CAREER_OPS_WORKSPACE;
  assert.equal(workspaceRoot(), process.cwd());
});

test('uses CAREER_OPS_WORKSPACE when set', () => {
  process.env.CAREER_OPS_WORKSPACE = '/some/workspace/dir';
  try {
    assert.equal(workspaceRoot(), '/some/workspace/dir');
  } finally {
    delete process.env.CAREER_OPS_WORKSPACE;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/workspace-root.test.mjs`
Expected: FAIL with "Cannot find module '../core/workspace-root.mjs'"

- [ ] **Step 3: Write `core/workspace-root.mjs`**

```js
// @ts-check
// workspace-root.mjs — resolves the root for USER-LAYER paths (data/,
// reports/, cv.md, config/, portals.yml, etc.). System-layer paths (templates/,
// providers/, plugins/) keep resolving off each script's own ROOT
// (dirname(fileURLToPath(import.meta.url))) unchanged — this helper is only
// for the paths that must land inside the CURRENT workspace.
//
// A future router always spawns claude -p with cwd set to the target
// workspace directory, so process.cwd() is correct by construction there.
// For a solo user running career-ops from the repo root as before workspaces
// existed, process.cwd() IS the repo root — identical behavior, no migration
// needed. CAREER_OPS_WORKSPACE is an explicit override for the rare case cwd
// isn't trustworthy (matches the CAREER_OPS_REPORTS_DIR-style overrides
// already used elsewhere in this codebase).

export function workspaceRoot() {
  return process.env.CAREER_OPS_WORKSPACE || process.cwd();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/workspace-root.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add core/workspace-root.mjs tests/workspace-root.test.mjs
git commit -m "feat: add workspaceRoot() helper for user-layer path resolution"
```

---

### Task 6: Migrate `set-status.mjs` and `merge-tracker.mjs` off the dual-purpose `CAREER_OPS` constant

**Files:**
- Modify: `core/set-status.mjs`
- Modify: `core/merge-tracker.mjs`
- Test: `core/set-status-tests.mjs`, existing tracker tests, plus a new isolation test

**Interfaces:**
- Consumes: `workspaceRoot()` from Task 5
- Produces: both scripts' tracker path resolution now workspace-aware; their `templates/states.yml` resolution stays `ROOT`-based (system-layer, unchanged).

- [ ] **Step 1: Write the failing isolation test**

Create `tests/set-status-workspace-isolation.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('set-status.mjs writes to the workspace cwd, not the repo root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  writeFileSync(join(ws, 'data', 'applications.md'),
    '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-08-15 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | [1](reports/1-acme-2026-08-15.md) | |\n');
  try {
    execFileSync('node', [join(REPO_ROOT, 'core', 'set-status.mjs'), '1', 'Applied'], { cwd: ws });
    const content = readFileSync(join(ws, 'data', 'applications.md'), 'utf-8');
    assert.match(content, /Applied/);
    const repoRootTracker = readFileSync(join(REPO_ROOT, 'data', 'applications.md'), 'utf-8').toString();
    assert.doesNotMatch(repoRootTracker, /\| 1 \| 2026-08-15 \| Acme \|/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/set-status-workspace-isolation.test.mjs`
Expected: FAIL — either an error resolving the tracker, or it writes to the repo root's own `data/applications.md` instead of the workspace's.

- [ ] **Step 3: Fix `set-status.mjs`**

Modify `core/set-status.mjs` — split the dual-purpose constant. Change:

```js
const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const STATES_FILE = join(CAREER_OPS, 'templates/states.yml');
```

to:

```js
import { workspaceRoot } from './workspace-root.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATES_FILE = join(ROOT, 'templates/states.yml');
```

And change the tracker resolution line:

```js
const APPS_FILE = resolveTrackerPath(CAREER_OPS);
```

to:

```js
const APPS_FILE = resolveTrackerPath(workspaceRoot());
```

Update every other use of `CAREER_OPS` in this file: uses tied to `templates/states.yml` or another system-layer sibling stay `ROOT`-based; any use feeding into the tracker path stays `workspaceRoot()`-based.

- [ ] **Step 4: Fix `merge-tracker.mjs`**

Modify `core/merge-tracker.mjs` the same way:

```js
import { workspaceRoot } from './workspace-root.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATES_FILE = join(ROOT, 'templates/states.yml'); // system-layer, unchanged

const APPS_FILE = resolveTrackerPath(workspaceRoot());
const TRACKER_DIR = dirname(APPS_FILE);

const ADDITIONS_DIR = process.env.CAREER_OPS_ADDITIONS
  ? process.env.CAREER_OPS_ADDITIONS
  : join(workspaceRoot(), 'data', 'tracker-additions'); // relocated from batch/ — see Task 9
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');

const BATCH_STATE_FILE = process.env.CAREER_OPS_BATCH_STATE
  ? process.env.CAREER_OPS_BATCH_STATE
  : join(workspaceRoot(), 'data', 'batch-state.tsv'); // relocated from batch/ — see Task 9
```

And the `mkdirSync` call:

```js
mkdirSync(join(workspaceRoot(), 'data'), { recursive: true });
```

(The `ADDITIONS_DIR`/`BATCH_STATE_FILE` relocation from `batch/` to `data/` is Task 9's fix for the mixed-directory problem — applying the new default path here now avoids a second edit to this file later.)

- [ ] **Step 5: Run tests and verify they pass**

Run: `node --test tests/set-status-workspace-isolation.test.mjs && node core/set-status-tests.mjs && node core/test-all.mjs`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add core/set-status.mjs core/merge-tracker.mjs tests/set-status-workspace-isolation.test.mjs
git commit -m "fix: split dual-purpose CAREER_OPS constant in set-status.mjs and merge-tracker.mjs"
```

---

### Task 7: Migrate `outcome.mjs` and `doctor.mjs`

**Files:**
- Modify: `core/outcome.mjs`
- Modify: `core/doctor.mjs`
- Test: new isolation tests for each

**Interfaces:**
- Consumes: `workspaceRoot()` from Task 5
- Produces: both scripts' user-layer resolution is workspace-aware; `doctor.mjs --target <dir>` stays the highest-priority override (unchanged), falling back to `workspaceRoot()` instead of its own `__dirname`.

- [ ] **Step 1: Write the failing test for `outcome.mjs`**

Create `tests/outcome-workspace-isolation.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('outcome.mjs spawns set-status.mjs with cwd scoped to the workspace', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  writeFileSync(join(ws, 'data', 'applications.md'),
    '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 2 | 2026-08-15 | Beta | Manager | 3.5/5 | Applied | ❌ | [2](reports/2-beta-2026-08-15.md) | |\n');
  try {
    execFileSync('node', [join(REPO_ROOT, 'core', 'outcome.mjs'), '2', 'rejected'], { cwd: ws });
    assert.ok(true); // reaching here without throwing means it resolved the workspace tracker, not the repo root's
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/outcome-workspace-isolation.test.mjs`
Expected: FAIL (resolves against `core/data/applications.md`, which doesn't exist, or against the repo root's real tracker instead of the workspace's)

- [ ] **Step 3: Fix `outcome.mjs`**

Modify `core/outcome.mjs`:

```js
import { workspaceRoot } from './workspace-root.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url)); // system-layer only from here down
const SET_STATUS_SCRIPT = join(CAREER_OPS, 'set-status.mjs');
const ARCHIVE_POSTING_SCRIPT = join(CAREER_OPS, 'archive-posting.mjs');

// ...

const appsFile = resolveTrackerPath(workspaceRoot());
```

And the two `execFileSync` calls that spawn `set-status.mjs` — change `cwd: CAREER_OPS` to `cwd: workspaceRoot()` (the spawned `set-status.mjs` process needs its own `cwd` to be the workspace, since it resolves its OWN tracker path via `workspaceRoot()` per Task 6):

```js
const statusOutput = execFileSync(NODE, setStatusArgs, { cwd: workspaceRoot(), env: process.env, encoding: 'utf-8' });
```

- [ ] **Step 4: Write the failing test for `doctor.mjs`**

Create `tests/doctor-workspace-isolation.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('doctor.mjs --json reports the workspace cwd is missing cv.md, not the repo root state', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  try {
    const output = execFileSync('node', [join(REPO_ROOT, 'core', 'doctor.mjs'), '--json'], { cwd: ws, encoding: 'utf-8' });
    const result = JSON.parse(output);
    assert.equal(result.onboardingNeeded, true);
    assert.ok(result.missing.includes('cv.md'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `node --test tests/doctor-workspace-isolation.test.mjs`
Expected: FAIL — `doctor.mjs`'s default `projectRoot` is currently `__dirname` (`core/`), not the workspace `cwd`, so it reports the repo's own state instead.

- [ ] **Step 6: Fix `doctor.mjs`**

Modify `core/doctor.mjs` — change:

```js
const projectRoot =
  targetIdx !== -1 && argv[targetIdx + 1] ? argv[targetIdx + 1] : __dirname;
```

to:

```js
import { workspaceRoot } from './workspace-root.mjs';

const projectRoot =
  targetIdx !== -1 && argv[targetIdx + 1] ? argv[targetIdx + 1] : workspaceRoot();
```

(`--target` stays the highest-priority override, unchanged — only the fallback changes.)

- [ ] **Step 7: Run tests and commit**

```bash
node --test tests/outcome-workspace-isolation.test.mjs tests/doctor-workspace-isolation.test.mjs
node core/test-all.mjs
git add core/outcome.mjs core/doctor.mjs tests/outcome-workspace-isolation.test.mjs tests/doctor-workspace-isolation.test.mjs
git commit -m "fix: outcome.mjs and doctor.mjs resolve user-layer paths via workspaceRoot()"
```

---

### Task 8: Migrate `cycle-status.mjs`, `discord-ticker.mjs`, `cycle-lock.mjs`

**Files:**
- Modify: `core/cycle-status.mjs`
- Modify: `core/discord-ticker.mjs`
- Modify: `core/cycle-lock.mjs`
- Test: one isolation test covering all three (same pattern, one file)

**Interfaces:**
- Consumes: `workspaceRoot()` from Task 5
- Produces: all three state/lock files land inside the current workspace by default, still overridable by their existing env vars.

- [ ] **Step 1: Write the failing test**

Create `tests/state-files-workspace-isolation.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('STATUS_PATH resolves under the workspace cwd', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  const original = process.cwd();
  process.chdir(ws);
  try {
    delete process.env.CAREER_OPS_CYCLE_STATUS;
    const mod = await import(`../core/cycle-status.mjs?t=${Date.now()}`);
    assert.equal(mod.STATUS_PATH, join(ws, 'data', 'cache', 'cycle-status.json'));
  } finally {
    process.chdir(original);
    rmSync(ws, { recursive: true, force: true });
  }
});

test('discord-ticker STATE_PATH resolves under the workspace cwd', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  const original = process.cwd();
  process.chdir(ws);
  try {
    delete process.env.CAREER_OPS_DISCORD_TICKER_STATE;
    const mod = await import(`../core/discord-ticker.mjs?t=${Date.now()}`);
    assert.equal(mod.STATE_PATH, join(ws, 'data', 'cache', 'discord-ticker-state.json'));
  } finally {
    process.chdir(original);
    rmSync(ws, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/state-files-workspace-isolation.test.mjs`
Expected: FAIL — both currently resolve under `core/data/...` (their own `ROOT`), not the workspace `cwd`.

- [ ] **Step 3: Fix `cycle-status.mjs`**

Modify `core/cycle-status.mjs`:

```js
import { workspaceRoot } from './workspace-root.mjs';

export const STATUS_PATH = process.env.CAREER_OPS_CYCLE_STATUS
  || join(workspaceRoot(), 'data', 'cache', 'cycle-status.json');
export const LOCK_DIR = `${STATUS_PATH}.lock`;
export const LOG_PATH = process.env.CAREER_OPS_CYCLE_STATUS_LOG
  || join(workspaceRoot(), 'data', 'cycle-status.log');
```

- [ ] **Step 4: Fix `discord-ticker.mjs`**

Modify `core/discord-ticker.mjs`:

```js
import { workspaceRoot } from './workspace-root.mjs';

export const STATE_PATH = process.env.CAREER_OPS_DISCORD_TICKER_STATE
  || join(workspaceRoot(), 'data', 'cache', 'discord-ticker-state.json');
export const LOCK_DIR = `${STATE_PATH}.lock`;
export const LOG_PATH = process.env.CAREER_OPS_DISCORD_TICKER_LOG
  || join(workspaceRoot(), 'data', 'discord-ticker.log');
```

- [ ] **Step 5: Fix `cycle-lock.mjs`**

Modify `core/cycle-lock.mjs` — wrap the bare relative literal for override-consistency with the rest of the codebase (it already behaves cwd-relative today; this makes it explicit and overridable):

```js
import { workspaceRoot } from './workspace-root.mjs';
import { join } from 'node:path';

const LOCK_DIR = process.env.CAREER_OPS_CYCLE_LOCK
  || join(workspaceRoot(), 'data', 'cycle.lock');
const OWNER_PATH = `${LOCK_DIR}/owner.json`;
```

- [ ] **Step 6: Run tests and commit**

```bash
node --test tests/state-files-workspace-isolation.test.mjs
node core/test-all.mjs
git add core/cycle-status.mjs core/discord-ticker.mjs core/cycle-lock.mjs tests/state-files-workspace-isolation.test.mjs
git commit -m "fix: cycle-status.mjs, discord-ticker.mjs, cycle-lock.mjs resolve under workspaceRoot()"
```

---

### Task 9: Relocate `batch/`'s user-runtime content into `data/`

**Files:**
- Modify: `.gitignore`
- Modify: `core/merge-tracker.mjs` (already pointed at the new `data/` paths in Task 6 — this task moves the actual runtime content and any remaining references)
- Test: `core/test-all.mjs`

**Interfaces:**
- Consumes: Task 6's `merge-tracker.mjs` changes (already writing to `data/tracker-additions`, `data/batch-state.tsv`)
- Produces: `batch/` contains only System Layer files (`batch-prompt.md`, `batch-runner.sh`, `aggregate-tokens.mjs`, `README.md`, `utils/token-tracker.mjs` if that's nested under `batch/` — verify) — safe to junction wholesale in Task 10.

- [ ] **Step 1: Move any existing runtime content**

If `batch/tracker-additions/`, `batch/batch-state.tsv`, or `batch/logs/` currently have real (non-`.gitkeep`) content in this repo, move it:

```bash
mkdir -p data/tracker-additions data/batch-logs
git mv batch/tracker-additions/*.tsv data/tracker-additions/ 2>/dev/null || true
git mv batch/batch-state.tsv data/batch-state.tsv 2>/dev/null || true
git mv batch/logs/* data/batch-logs/ 2>/dev/null || true
```

(The `|| true` guards are because these files are gitignored runtime content — Step 1 may find nothing to move in a clean checkout, which is expected, not an error.)

- [ ] **Step 2: Update `.gitignore`**

Modify `.gitignore` — replace the `batch/` runtime-content block:

```
batch/logs/*
!batch/logs/.gitkeep
batch/batch-state.tsv
batch/batch-input.tsv
batch/tracker-additions/**/*.tsv
batch/wave*
batch/*-worker.mjs
batch/*.log
batch/*.paused
!batch/tracker-additions/.gitkeep
```

with:

```
data/batch-logs/*
!data/batch-logs/.gitkeep
data/batch-state.tsv
data/batch-input.tsv
data/tracker-additions/**/*.tsv
data/batch-wave*
data/batch-*-worker.mjs
!data/tracker-additions/.gitkeep
```

- [ ] **Step 3: Check for any remaining `batch/tracker-additions` or `batch/batch-state.tsv` references outside `merge-tracker.mjs`**

```bash
grep -rn "batch/tracker-additions\|batch/batch-state" --include="*.md" --include="*.mjs" --include="*.sh" .
```

Update any hits found (mode files, docs) to the new `data/`-relative paths.

- [ ] **Step 4: Create the `.gitkeep` placeholders and run tests**

```bash
mkdir -p data/tracker-additions data/batch-logs
touch data/tracker-additions/.gitkeep data/batch-logs/.gitkeep
node core/test-all.mjs
```

- [ ] **Step 5: Commit**

```bash
git add -A -- batch/ data/ .gitignore
git commit -m "refactor: relocate batch/'s user-runtime content into data/ so batch/ is pure system-layer"
```

---

### Task 10: `provision-workspace.mjs` — create a workspace

**Files:**
- Create: `core/provision-workspace.mjs`
- Create: `tests/provision-workspace.test.mjs`

**Interfaces:**
- Consumes: `SYSTEM_PATHS` from `core/update-system.mjs` (imported, not duplicated), `doctor.mjs`'s template-copy pattern, `templates/interview-prep-sessions/.gitkeep`+`README.md` from Task 2 (the permanent template source for those two seeded files — do not seed from `interview-prep/sessions/` directly, that path is the workspace-local *destination*, not a source)
- Produces: `provisionWorkspace(slug, opts)` — creates `workspaces/{slug}/`, junctions the fixed system-directory list, seeds real user-layer files, writes `workspace.json`. Exported for later tasks/tests; also runnable as `node core/provision-workspace.mjs <slug>`.

- [ ] **Step 1: Write the failing test**

Create `tests/provision-workspace.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionWorkspace, SLUG_RE } from '../core/provision-workspace.mjs';

test('rejects invalid slugs', () => {
  assert.equal(SLUG_RE.test('../etc'), false);
  assert.equal(SLUG_RE.test('a/b'), false);
  assert.equal(SLUG_RE.test('Alice'), false); // uppercase not allowed
  assert.equal(SLUG_RE.test('a'), false); // too short (min 2 chars)
  assert.equal(SLUG_RE.test('alice'), true);
  assert.equal(SLUG_RE.test('alice-2'), true);
});

test('provisionWorkspace throws on an invalid slug without touching disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    assert.throws(() => provisionWorkspace('../escape', { reposRoot: root }));
    assert.equal(existsSync(join(root, 'workspaces')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionWorkspace creates the expected junctions and real files', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('alice', { reposRoot: root });
    const wsDir = join(root, 'workspaces', 'alice');
    assert.ok(existsSync(join(wsDir, 'workspace.json')));
    const meta = JSON.parse(readFileSync(join(wsDir, 'workspace.json'), 'utf-8'));
    assert.equal(meta.slug, 'alice');
    assert.ok(meta.created_at);

    // Real user-layer entries
    assert.ok(existsSync(join(wsDir, 'data')));
    assert.ok(existsSync(join(wsDir, 'config')));
    assert.ok(existsSync(join(wsDir, 'data', 'pipeline.md')));

    // Junctioned system entries
    const modesLink = lstatSync(join(wsDir, 'modes'));
    assert.ok(modesLink.isSymbolicLink() || modesLink.isDirectory());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionWorkspace is idempotent — re-running does not error or duplicate', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('bob', { reposRoot: root });
    assert.doesNotThrow(() => provisionWorkspace('bob', { reposRoot: root, repair: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/provision-workspace.test.mjs`
Expected: FAIL with "Cannot find module '../core/provision-workspace.mjs'"

- [ ] **Step 3: Write `core/provision-workspace.mjs`**

```js
// @ts-check
// provision-workspace.mjs — creates or repairs a workspaces/{slug}/ directory:
// real files for User Layer content, whole-directory junctions for System
// Layer content. See docs/superpowers/specs/2026-08-15-workspace-multitenancy-core-design.md.
//
// The junction list below is deliberately NOT "every SYSTEM_PATHS entry" —
// most SYSTEM_PATHS entries are standalone docs (README.md, LICENSE, etc.)
// nothing reads relative to a workspace's cwd at runtime; a script that needs
// a shared system file resolves it via its OWN ROOT (real location), not the
// workspace's directory listing. This list is only the directories genuinely
// dereferenced by workspace-relative operations (mode prose invoking
// `node core/scan.mjs`, Claude reading `modes/oferta.md` via a bare relative
// Read call, etc).

import { existsSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // core/'s parent = repo root

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

// Fixed set of top-level System Layer directories genuinely dereferenced by
// workspace-relative operations. See the module doc comment above for why
// this is not "every SYSTEM_PATHS entry."
export const JUNCTION_DIRS = [
  'core', 'modes', 'templates', 'providers', 'plugins', 'plugins-registry',
  'docs', 'dashboard', 'fonts', 'examples', 'lib', 'batch',
  '.agents', '.claude/skills', '.cursor/skills', '.opencode/skills',
  '.opencode/commands', '.grok/skills', '.kimi/skills',
  '.antigravitycli/skills', '.qwen', '.claude-plugin',
];

// User Layer real directories created empty (seeded on demand, not templated).
const REAL_EMPTY_DIRS = [
  'data', 'reports', 'output', 'jds', 'interview-prep', 'writing-samples',
  'config',
];

// { destination relative to workspace root, template relative to repo root }
const SEEDED_FILES = [
  { target: 'config/profile.yml', template: 'config/profile.example.yml' },
  { target: 'config/plugins.yml', template: 'templates/plugins.example.yml' },
  { target: 'portals.yml', template: 'templates/portals.example.yml' },
  { target: '_profile.md', template: 'modes/_profile.template.md' },
  { target: '_custom.md', template: 'modes/_custom.template.md' },
  { target: '_brief.md', template: 'modes/_brief.template.md' },
  { target: 'interview-prep/sessions/.gitkeep', template: 'templates/interview-prep-sessions/.gitkeep' },
  { target: 'interview-prep/sessions/README.md', template: 'templates/interview-prep-sessions/README.md' },
];

const PIPELINE_SKELETON = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

## Pending

## Processed
`;

const APPLICATIONS_SKELETON = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

function junctionType() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

/** Create a junction/symlink at wsDir/name pointing at repoRoot/name, if it doesn't already exist. */
function ensureJunction(repoRoot, wsDir, relDir) {
  const target = join(repoRoot, ...relDir.split('/'));
  const linkPath = join(wsDir, ...relDir.split('/'));
  if (existsSync(linkPath)) return false; // already present — repair no-ops here
  mkdirSync(dirname(linkPath), { recursive: true });
  if (!existsSync(target)) return false; // source doesn't exist in this repo (e.g. optional dir) — skip
  symlinkSync(target, linkPath, junctionType());
  return true;
}

function seedFile(repoRoot, wsDir, target, template) {
  const targetPath = join(wsDir, ...target.split('/'));
  const templatePath = join(repoRoot, ...template.split('/'));
  if (existsSync(targetPath)) return false;
  mkdirSync(dirname(targetPath), { recursive: true });
  if (!existsSync(templatePath)) return false;
  copyFileSync(templatePath, targetPath);
  return true;
}

/**
 * @param {string} slug
 * @param {{ reposRoot?: string, chatId?: string, displayName?: string, repair?: boolean }} [opts]
 */
export function provisionWorkspace(slug, opts = {}) {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid workspace slug "${slug}" — must match ${SLUG_RE}`);
  }
  const repoRoot = opts.reposRoot || ROOT;
  const wsDir = join(repoRoot, 'workspaces', slug);
  mkdirSync(wsDir, { recursive: true });

  for (const dir of JUNCTION_DIRS) ensureJunction(repoRoot, wsDir, dir);

  for (const dir of REAL_EMPTY_DIRS) {
    const p = join(wsDir, dir);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  for (const { target, template } of SEEDED_FILES) seedFile(repoRoot, wsDir, target, template);

  const pipelinePath = join(wsDir, 'data', 'pipeline.md');
  if (!existsSync(pipelinePath)) writeFileSync(pipelinePath, PIPELINE_SKELETON, 'utf-8');

  const trackerPath = join(wsDir, 'data', 'applications.md');
  if (!existsSync(trackerPath)) writeFileSync(trackerPath, APPLICATIONS_SKELETON, 'utf-8');

  const metaPath = join(wsDir, 'workspace.json');
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, JSON.stringify({
      slug,
      chat_id: opts.chatId || null,
      display_name: opts.displayName || slug,
      created_at: new Date().toISOString().slice(0, 10),
    }, null, 2), 'utf-8');
  }

  return wsDir;
}

async function main() {
  const [, , slug, ...rest] = process.argv;
  if (!slug) {
    console.error('Usage: node core/provision-workspace.mjs <slug> [--repair]');
    process.exit(1);
  }
  const repair = rest.includes('--repair');
  const wsDir = provisionWorkspace(slug, { repair });
  console.log(`workspace ready: ${wsDir}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`❌ provision-workspace: ${err.message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/provision-workspace.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite and commit**

```bash
node core/test-all.mjs
git add core/provision-workspace.mjs tests/provision-workspace.test.mjs
git commit -m "feat: add provision-workspace.mjs"
```

---

### Task 11: `provision-workspace.mjs --repair-all`

**Files:**
- Modify: `core/provision-workspace.mjs`
- Modify: `tests/provision-workspace.test.mjs`

**Interfaces:**
- Consumes: `provisionWorkspace()` from Task 10
- Produces: `repairAllWorkspaces(opts)` — iterates every `workspaces/*/`, re-running `provisionWorkspace(slug, { repair: true })` on each so a newly-added `JUNCTION_DIRS` entry gets picked up by every existing workspace. `--repair-all` CLI flag.

- [ ] **Step 1: Write the failing test**

Add to `tests/provision-workspace.test.mjs`:

```js
import { repairAllWorkspaces } from '../core/provision-workspace.mjs';
import { symlinkSync } from 'node:fs';

test('repairAllWorkspaces adds a junction for a directory introduced after initial provisioning', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('carol', { reposRoot: root });
    // Simulate a brand-new system directory that didn't exist at provisioning time
    mkdirSync(join(root, 'newsystemdir'));
    const originalDirs = [...JUNCTION_DIRS];
    JUNCTION_DIRS.push('newsystemdir');
    try {
      repairAllWorkspaces({ reposRoot: root });
      assert.ok(existsSync(join(root, 'workspaces', 'carol', 'newsystemdir')));
    } finally {
      JUNCTION_DIRS.length = 0;
      JUNCTION_DIRS.push(...originalDirs);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

(This requires `JUNCTION_DIRS` to be a mutable exported array, not a frozen constant — confirm the Step 3 implementation below keeps it that way.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/provision-workspace.test.mjs`
Expected: FAIL with "Cannot find export 'repairAllWorkspaces'"

- [ ] **Step 3: Add `repairAllWorkspaces` to `core/provision-workspace.mjs`**

Add near the bottom, before `main()`:

```js
export function repairAllWorkspaces(opts = {}) {
  const repoRoot = opts.reposRoot || ROOT;
  const workspacesDir = join(repoRoot, 'workspaces');
  if (!existsSync(workspacesDir)) return [];
  const slugs = readdirSync(workspacesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const repaired = [];
  for (const slug of slugs) {
    provisionWorkspace(slug, { reposRoot: repoRoot, repair: true });
    repaired.push(slug);
  }
  return repaired;
}
```

And update `main()` to support `--repair-all` as a distinct invocation from `<slug> [--repair]`:

```js
async function main() {
  const [, , first, ...rest] = process.argv;
  if (first === '--repair-all') {
    const repaired = repairAllWorkspaces({});
    console.log(`repaired ${repaired.length} workspace(s): ${repaired.join(', ')}`);
    return;
  }
  if (!first) {
    console.error('Usage: node core/provision-workspace.mjs <slug> [--repair] | node core/provision-workspace.mjs --repair-all');
    process.exit(1);
  }
  const repair = rest.includes('--repair');
  const wsDir = provisionWorkspace(first, { repair });
  console.log(`workspace ready: ${wsDir}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/provision-workspace.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full suite and commit**

```bash
node core/test-all.mjs
git add core/provision-workspace.mjs tests/provision-workspace.test.mjs
git commit -m "feat: add provision-workspace.mjs --repair-all"
```

---

### Task 12: Regression test — junction list vs. `SYSTEM_PATHS` never silently diverge

**Files:**
- Create: `tests/junction-list-coverage.test.mjs`

**Interfaces:**
- Consumes: `JUNCTION_DIRS` from `core/provision-workspace.mjs`, `SYSTEM_PATHS` from `core/update-system.mjs`
- Produces: a test that fails loudly if a new top-level System Layer directory is added to `SYSTEM_PATHS` without a corresponding `JUNCTION_DIRS` entry — the "don't let this drift silently" guarantee the spec calls for.

- [ ] **Step 1: Write the test**

Create `tests/junction-list-coverage.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUNCTION_DIRS } from '../core/provision-workspace.mjs';
import { SYSTEM_PATHS } from '../core/update-system.mjs';

test('every top-level directory-shaped SYSTEM_PATHS entry has a JUNCTION_DIRS counterpart', () => {
  const topLevelDirs = new Set(
    SYSTEM_PATHS
      .filter((p) => p.endsWith('/'))
      .map((p) => p.replace(/\/$/, ''))
      .filter((p) => !p.includes('/')) // top-level only, not nested like modes/ar/
  );
  const known = new Set(JUNCTION_DIRS);
  const missing = [...topLevelDirs].filter((d) => !known.has(d));
  assert.deepEqual(missing, [],
    `New top-level system directory(ies) added to SYSTEM_PATHS without a JUNCTION_DIRS entry in provision-workspace.mjs: ${missing.join(', ')}. ` +
    `If the new directory is genuinely dereferenced by workspace-relative operations, add it to JUNCTION_DIRS. ` +
    `If it's a standalone doc/config directory nothing reads relative to a workspace cwd, add it to this test's own allowlist instead.`);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/junction-list-coverage.test.mjs`
Expected: PASS. If it fails, reconcile `JUNCTION_DIRS` (Task 10) against the actual current `SYSTEM_PATHS` — the list above may need one more entry than initially captured (`.opencode/skills/` and `.opencode/commands/` are two separate `SYSTEM_PATHS` entries under the same parent, for example — confirm both are present in `JUNCTION_DIRS`).

- [ ] **Step 3: Commit**

```bash
git add tests/junction-list-coverage.test.mjs
git commit -m "test: guard against JUNCTION_DIRS silently drifting from SYSTEM_PATHS"
```

---

### Task 13: Verify `CLAUDE.md`/`AGENTS.md` directory walk-up discovery from a workspace

**Files:**
- No code changes — this is an empirical verification step the spec flagged as unresolved.

**Interfaces:**
- Consumes: `provisionWorkspace()` from Task 10
- Produces: a documented answer (recorded in this plan's own checkbox, and in a short note appended to the spec) to whether project instructions load automatically for a nested workspace `cwd`, or whether follow-up work is needed.

- [ ] **Step 1: Provision a throwaway test workspace**

```bash
node core/provision-workspace.mjs verify-walkup-test
```

- [ ] **Step 2: Start an interactive Claude Code session with that workspace as cwd and confirm project instructions loaded**

Run (outside this automated plan — this is a manual verification step since it requires an interactive session):

```bash
cd workspaces/verify-walkup-test
claude
```

In that session, ask "what does DATA_CONTRACT.md say the User Layer is?" or similar — if the response correctly reflects this repo's `AGENTS.md`/`CLAUDE.md` content without you pasting it manually, walk-up discovery works.

- [ ] **Step 3: Record the result**

If walk-up discovery **works**: add a line to `docs/superpowers/specs/2026-08-15-workspace-multitenancy-core-design.md`'s "Why directory junctions" section confirming it, and no further action needed.

If walk-up discovery **does not work**: this plan needs an additional task (not written here, since the fix depends on what's actually observed — e.g. real copies of `CLAUDE.md`/`AGENTS.md` seeded per-workspace, kept in sync via `--repair`, or an explicit `--add-dir`/config flag). Stop and report back before proceeding to Task 14.

- [ ] **Step 4: Clean up the test workspace**

```bash
rm -rf workspaces/verify-walkup-test
```

---

### Task 14: Remove `AGENTS.md`'s automatic Update Check invocation

**Files:**
- Modify: `AGENTS.md` (delete one section, lines 63–80 as of this plan's writing — confirm exact line numbers haven't shifted from earlier edits in this plan before deleting)

**Interfaces:**
- Consumes: nothing
- Produces: no session ever runs `node core/update-system.mjs check` automatically again. `update-system.mjs` itself is untouched.

- [ ] **Step 1: Remove the section**

Modify `AGENTS.md` — delete the entire `## Update Check` section:

```markdown
## Update Check

On the first message of each session, run silently:

```bash
node core/update-system.mjs check
```

If `{"status": "update-available", "local": ..., "remote": ..., "changelog": ...}`:

- **No `[HEADLESS]` marker present** (the normal case — an interactive session) → tell the user:
  > "career-ops update available (v{local} → v{remote}). Your data (CV, profile, tracker, reports) will NOT be touched. Want me to update?"

  If yes → `node core/update-system.mjs apply`. If no → `node core/update-system.mjs dismiss`.
- **`[HEADLESS]` marker present** (see "Headless Invocation Signal" above) → never surface this question and never block on it. Run the check, and if an update is available, `node core/update-system.mjs dismiss` it and proceed with the current version — the same update will surface again next time an interactive session runs, so nothing is lost, just deferred to when a human can actually answer.

Every other status (`up-to-date`, `dismissed`, `offline`, `no-remote-version`) → say nothing either way. The user can force a check anytime ("check for updates" / "update career-ops"); rollback: `node core/update-system.mjs rollback`.
```

Leave exactly one blank line between the end of "## Headless Invocation Signal" and the start of "## What is career-ops" (i.e. don't leave a double-blank gap where this section used to be).

- [ ] **Step 2: Verify nothing else references this section**

```bash
grep -n "Update Check" AGENTS.md core/test-all.mjs
```

Expected: no remaining references assuming the section exists (if `test-all.mjs` has a test asserting `AGENTS.md` contains this section, update or remove that specific assertion — don't touch unrelated tests in that file).

- [ ] **Step 3: Run tests and commit**

```bash
node core/test-all.mjs
git add AGENTS.md
git commit -m "chore: stop auto-invoking update-system.mjs check on session start (update-system.mjs itself untouched)"
```

---

### Task 15: Migrate the operator's own data into `workspaces/{slug}/`

**Files:**
- Move: `cv.md`, `config/profile.yml`, `config/plugins.yml`, `config/cv-facts.json` (if present), `config/benchmarks.yml` (if present), `_profile.md`, `_custom.md`, `_brief.md`, `portals.yml`, `data/`, `reports/`, `output/`, `jds/`, `interview-prep/`, `writing-samples/` (real content only), `voice-dna.md` (if present), `article-digest.md` (if present), `plugins.local/` (if present), `plugins.lock` (if present), `opencode.json` (if present) → `workspaces/{slug}/`

**Interfaces:**
- Consumes: `provisionWorkspace()` from Task 10
- Produces: the repo root holds no live personal data; `workspaces/{slug}/` is a fully working, isolated instance.

- [ ] **Step 1: Choose the slug and provision the workspace**

```bash
node core/provision-workspace.mjs roberto
```

(Replace `roberto` with whatever slug is preferred — must match `^[a-z0-9][a-z0-9-]{1,31}$`.)

- [ ] **Step 2: Move real content over the freshly-seeded placeholders**

```bash
WS=workspaces/roberto
git mv cv.md "$WS/cv.md"
git mv config/profile.yml "$WS/config/profile.yml"
[ -f config/plugins.yml ] && git mv config/plugins.yml "$WS/config/plugins.yml"
[ -f config/cv-facts.json ] && git mv config/cv-facts.json "$WS/config/cv-facts.json"
[ -f config/benchmarks.yml ] && git mv config/benchmarks.yml "$WS/config/benchmarks.yml"
git mv _profile.md "$WS/_profile.md"
git mv _custom.md "$WS/_custom.md"
git mv _brief.md "$WS/_brief.md"
git mv portals.yml "$WS/portals.yml"
rm -rf "$WS/data" && git mv data "$WS/data"
rm -rf "$WS/reports" && git mv reports "$WS/reports"
rm -rf "$WS/output" && git mv output "$WS/output"
rm -rf "$WS/jds" && git mv jds "$WS/jds"
rm -rf "$WS/interview-prep" && git mv interview-prep "$WS/interview-prep"
[ -d writing-samples ] && rm -rf "$WS/writing-samples" && git mv writing-samples "$WS/writing-samples"
[ -f voice-dna.md ] && git mv voice-dna.md "$WS/voice-dna.md"
[ -f article-digest.md ] && git mv article-digest.md "$WS/article-digest.md"
[ -d plugins.local ] && git mv plugins.local "$WS/plugins.local"
[ -f plugins.lock ] && git mv plugins.lock "$WS/plugins.lock"
[ -f opencode.json ] && git mv opencode.json "$WS/opencode.json"
```

(Each `rm -rf "$WS/..."` before a directory `git mv` removes the empty placeholder Task 10 seeded, so `git mv` doesn't refuse to overwrite an existing destination.)

- [ ] **Step 3: Set the Discord webhook in the workspace's own `.env`**

```bash
echo "DISCORD_WEBHOOK_URL=<your existing webhook URL from the repo-root .env>" > workspaces/roberto/.env
```

Then remove `DISCORD_WEBHOOK_URL` from the repo-root `.env` (it's no longer a global secret per the spec — leave `TELEGRAM_BOT_TOKEN` and any Claude/Anthropic credentials in the repo-root `.env`, those stay global).

- [ ] **Step 4: Verify from inside the new workspace**

```bash
cd workspaces/roberto
node core/../../core/doctor.mjs --json
```

Expected: `{"onboardingNeeded": false, "missing": [], ...}` (everything found, since the real data just moved in).

```bash
node core/../../core/stats.mjs --summary
```

Expected: reflects the real tracker/report history, not an empty state.

- [ ] **Step 5: Run the full test suite from the repo root and commit**

```bash
cd ../..
node core/test-all.mjs
git add -A
git commit -m "chore: migrate operator's own data into workspaces/roberto/"
```

---

### Task 16: Final housekeeping — `.gitignore` for `workspaces/`

**Files:**
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `workspaces/*` is gitignored except a `.gitkeep`, so no future workspace's personal data is ever accidentally committed.

- [ ] **Step 1: Add the ignore rule**

Modify `.gitignore` — append:

```
# Per-user workspaces (multi-tenancy) — real user-layer files live here,
# junctioned system-layer directories should never be committed as their
# junction targets either. Only the placeholder is tracked.
workspaces/*
!workspaces/.gitkeep
```

- [ ] **Step 2: Create the placeholder and verify**

```bash
touch workspaces/.gitkeep
git add .gitignore workspaces/.gitkeep
git status
```

Expected: no workspace directories (`workspaces/roberto/`, etc.) show as untracked or staged — only `.gitignore` and `workspaces/.gitkeep`.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: gitignore workspaces/ contents, track only the placeholder"
```

---

## Self-Review Notes (completed during planning, not a step to execute)

- **Spec coverage:** every spec section has a task — directory layout/junctions (10, 11), path resolution rule (5, 6, 7, 8), hub-global paths (4), provisioning contract (10, 11), secrets (15 Step 3, confirmed no engine code changes needed), migration (15), update mechanism (14), testing (4-13 each carry their own tests, 12 is the dedicated regression guard), the two spec-flagged open items (`core/` naming — resolved as `core/`; `_profile.md` destination — resolved as repo root) are resolved in the Global Constraints section rather than deferred again.
- **Placeholder scan:** no TBD/TODO markers; Task 13 is the one task whose next step depends on an empirical result not yet known, but it's explicit about what happens in both branches rather than hand-waving.
- **Type consistency:** `workspaceRoot()` (Task 5) used identically in Tasks 6-8; `provisionWorkspace(slug, opts)` / `repairAllWorkspaces(opts)` signatures (Task 10-11) match between their definition and their test usage; `JUNCTION_DIRS` is imported by name in Task 12 exactly as exported in Task 10.
