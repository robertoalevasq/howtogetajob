# De-brand Personal Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `core/upgrade-tests.mjs` and every functional/branding connection to santifer's upstream `career-ops` repo, while preserving MIT-required attribution (the `LICENSE` file, untouched) and a brief neutral fork note.

**Architecture:** Functional decoupling first (update-system.mjs, scaffolder's installer, the dashboard's live "share your story" link, openrouter-runner.mjs's referrer header) — these have real behavioral consequences if left half-done. Then outright deletions (governance docs, the manifesto feature and its CI workflows, `upgrade-tests.mjs`) — mechanically safe once the functional pieces no longer depend on them. Then metadata/identity neutralization (`package.json`, `scaffolder/package.json`, `CITATION.cff`, plugin-marketplace manifests). Then in-place prose edits (`AGENTS.md`, `ARCHITECTURE.md`, docs, code comments). READMEs (17 language variants — the largest task by file count) come last. A final task re-runs the same discovery sweep used to write this plan and confirms it comes back clean.

Unlike the `core/validate-script-references.mjs` guard built by the prior plan, **no permanent regression tool is built here.** A de-branding pass is a one-time event, not a recurring risk — building CI infrastructure for it would be pure ceremony. Verification uses a single documented `git grep` invocation (Task 10), not a maintained script.

**Tech Stack:** Node.js (`.mjs`), Go 1.25 (`dashboard/`), Markdown, YAML (GitHub Actions/issue templates), JSON.

**Spec:** `docs/superpowers/specs/2026-08-21-de-brand-personal-fork-design.md`

## Global Constraints

- **`LICENSE` is never touched.** MIT requires its copyright notice stay intact — no exceptions, in any task.
- **No git history rewriting.** Past commits, authorship, and messages stay as-is.
- **No relicensing.** MIT stays MIT.
- **Inert historical shorthand stays.** A bare issue number with no live URL (e.g. `#workspace-multitenancy Task 1` in a code comment) is not a "connection" — leave it. Where a comment carries an *actual URL* to `github.com/santifer/...`, strip the URL but keep the bare `#NNNN` as plain text (this plan does that in Task 7).
- **Auto-generated historical changelogs stay.** `web/CHANGELOG.md` and `docs/SOURCE_INDEXING_LOG.md` are frozen historical records (release-please output, an append-only source log) full of real links to real past PRs/issues on santifer's repo. Rewriting them is equivalent to rewriting history — leave them alone in full, including their santifer links. (Same reasoning as the git-history non-goal.)
- **Never invent new identity data.** When a field is cleared (an author, a homepage, a module path), it is cleared or replaced with an ownerless placeholder — never filled with guessed or invented information about who this fork "belongs to."
- **After every task:** run `node core/test-all.mjs` and confirm no new failures beyond what that task intentionally changed. Where a test's own hardcoded regex asserts the *old* (now-removed) content as correct, fix the regex to the new correct value in the same task — do not work around it, do not leave it broken (established precedent from the prior `core/` path-reference-sync plan, hit twice there).

---

### Task 1: Functional decoupling — update-system.mjs, scaffolder's installer, openrouter-runner.mjs

**Files:**
- Modify: `core/update-system.mjs`
- Modify: `scaffolder/bin/cli.mjs`
- Modify: `core/openrouter-runner.mjs`
- Modify: `package.json` (the `update`/`rollback` script aliases only — leave every other script alone)

**Interfaces:**
- Produces: `check()` and `apply()` in `core/update-system.mjs` both short-circuit before any network call, in a way later tasks (Task 3's `SYSTEM_PATHS` cleanup) can build on without re-touching this control flow.

- [ ] **Step 1: Read the current file before editing**

Open `core/update-system.mjs` and locate:
- Lines ~57-59: `CANONICAL_REPO`, `RAW_VERSION_URL`, `RELEASES_API` constants.
- The `check()` function (~line 756): calls `curlGet(RAW_VERSION_URL)` and `curlGet(RELEASES_API, ...)`, and already has an early-return pattern for the dismiss flag:
  ```js
  async function check() {
    // Respect dismiss flag
    if (existsSync(join(ROOT, '.update-dismissed'))) {
      console.log(JSON.stringify({ status: 'dismissed' }));
      return;
    }
    ...
  ```
- The `apply()` function (~line 855-876): creates a backup branch, then does `git('fetch', CANONICAL_REPO, 'main')`.
- Line ~1167: `console.log('    npm run manifesto  ·  https://career-ops.org/manifesto?utm_source=updater');` — remove this line entirely (the manifesto feature is deleted in Task 3; removing the print here now, in this task, avoids a dangling reference in between tasks).

- [ ] **Step 2: Add a disabled-state early return to `check()`**

Immediately after the existing dismiss-flag check (same `if`/`return` shape, so the CLI's existing "machine-readable JSON status" contract stays intact), add:

```js
  if (existsSync(join(ROOT, '.update-dismissed'))) {
    console.log(JSON.stringify({ status: 'dismissed' }));
    return;
  }

  // This instance has no upstream repo configured to update from — see
  // de-brand-personal-fork plan. check()/apply() both short-circuit here
  // rather than fetching from a repo this checkout has no relationship to.
  console.log(JSON.stringify({ status: 'disabled', reason: 'auto-update is disabled for this instance (no upstream repo configured)' }));
  return;
```

Delete (or leave dead code out entirely — prefer deleting) the rest of `check()`'s body below this point, since it's now unreachable: the `curlGet(RAW_VERSION_URL)`/`curlGet(RELEASES_API, ...)` calls and everything that consumes their results. Also delete the now-unused `RAW_VERSION_URL` and `RELEASES_API` constants at the top of the file. Confirm `curlGet` isn't used anywhere else in the file before deleting it too (`grep -n "curlGet" core/update-system.mjs` — if it has no other callers, remove the function; if it does, leave it).

- [ ] **Step 3: Add a disabled-state throw to `apply()`**

At the very top of `apply()`, before the backup-branch/stash logic runs, add:

```js
async function apply() {
  throw new Error('Auto-update is disabled for this instance (no upstream repo configured). See core/AGENTS.md for how this fork relates to the original project.');
  // unreachable code below intentionally left as dead weight removed next line
```

Then delete the rest of `apply()`'s body (the backup-branch creation, the `git('fetch', CANONICAL_REPO, 'main')` call, the re-exec logic, the `SYSTEM_PATHS`-driven checkout loop — all of it). This throw is caught by the existing top-level `try`/`catch` at the bottom of the file (~line 1288), which already does `console.error(err.message || err); process.exit(1);` — so no changes are needed there.

Delete the now-unused `CANONICAL_REPO` constant.

**Do not delete `rollback()` or `dismiss()`** — both are purely local (restoring from a local backup branch; touching a local dismiss-flag file) and stay functional; they don't touch the network or `CANONICAL_REPO`.

- [ ] **Step 4: Decouple scaffolder's installer the same way**

Read `scaffolder/bin/cli.mjs`. It has:
```js
const REPO = "https://github.com/santifer/career-ops.git";
const LATEST_RELEASE = "https://api.github.com/repos/santifer/career-ops/releases/latest";
```
used at a `fetch(LATEST_RELEASE, ...)` call (~line 75) and a `cloneArgs.push(REPO, target)` call (~line 110). Find the CLI's entry point (its `init` command / main function — read the file to locate it) and add an early, clear message and non-zero exit before either of those call sites run, matching this file's existing console output style (read a few of its other `console.log`/`console.error` calls first to match tone):

```js
console.error("This installer is disabled for this personal fork — it has no upstream repo to install from. If you're looking for the original project, see https://github.com/santifer/career-ops.");
process.exit(1);
```

Delete the now-dead code below that point in the same function (the fetch/clone logic), and delete the `REPO`/`LATEST_RELEASE` constants once nothing references them.

- [ ] **Step 5: Remove the referrer header in openrouter-runner.mjs**

`core/openrouter-runner.mjs` has two occurrences of:
```js
'HTTP-Referer':  'https://github.com/santifer/career-ops',
```
This is OpenRouter's optional app-attribution header — the API works fine without it. Delete both lines (the whole `'HTTP-Referer': ...,` key-value pair) from whatever headers object each appears in. Do not replace with a different URL — this checkout has no remote to attribute to.

- [ ] **Step 6: Update package.json's update/rollback scripts**

Current:
```json
    "update:check": "node core/update-system.mjs check",
    "update:test": "node core/updater-migration-tests.mjs",
    "update": "node core/update-system.mjs apply",
    "rollback": "node core/update-system.mjs rollback",
```
Leave `update:check`, `update:test`, `update`, and `rollback` as-is — they still point at real, working commands; `check`/`apply` now just report the disabled state instead of erroring confusingly. No `package.json` change needed in this step (the disabled message speaks for itself when the script runs). Skip this step's edit — verify by running `npm run update:check` and `npm run update` manually and confirming both print the disabled-state message from Steps 2-3 instead of a crash.

- [ ] **Step 7: Test**

Run:
```bash
node core/update-system.mjs check
node core/update-system.mjs apply
```
Expected: both print the disabled-state message from Steps 2/3 and exit cleanly (check: exit 0 with JSON; apply: exit 1 with the error message, no stack trace).

Run:
```bash
node core/test-all.mjs
```
Expected: no new failures. If a test asserts `CANONICAL_REPO`, `RAW_VERSION_URL`, `RELEASES_API`, or the old `apply()`/`check()` behavior, fix that test's expectation to match the new disabled behavior in this same task.

- [ ] **Step 8: Commit**

```bash
git add core/update-system.mjs scaffolder/bin/cli.mjs core/openrouter-runner.mjs
git commit -m "feat: disable upstream-dependent auto-update, installer, and referrer header"
```

---

### Task 2: Delete upgrade-tests.mjs and its CI wiring

**Files:**
- Delete: `core/upgrade-tests.mjs`
- Modify: `.github/workflows/test.yml`
- Modify: `core/test-all.mjs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `core/validate-script-references.mjs`'s enumerated script list naturally loses `upgrade-tests.mjs` — this is expected, not a regression (its own test asserts 0 violations against whatever's actually in `core/`, not a fixed count).

- [ ] **Step 1: Delete the file**

```bash
git rm core/upgrade-tests.mjs
```

- [ ] **Step 2: Remove the CI job**

In `.github/workflows/test.yml`, delete the entire `upgrade-gate` job:
```yaml
  upgrade-gate:
    name: Upgrade regression gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0            # harness needs release tags
          persist-credentials: false # the harness only ever touches a local mirror
      - uses: actions/setup-node@v7
        with:
          node-version: '24'
      - uses: actions/setup-go@v7
        with:
          go-version: '1.26'   # old updaters rebuild the dashboard during apply
      - run: npm install --ignore-scripts
      - name: Upgrade PR gate (newest old release -> this commit)
        run: node core/upgrade-tests.mjs --pr-gate
      - name: Canary (harness must be able to fail)
        run: node core/upgrade-tests.mjs --canary
```
Read the surrounding YAML first to confirm indentation and that no other job depends on `upgrade-gate` (e.g. via a `needs:` key) before deleting — if one does, remove that dependency too.

- [ ] **Step 3: Fix the dangling comment in test-all.mjs**

`core/test-all.mjs` around line 5014 has a comment referencing `upgrade-tests.mjs` (something like "as the GIT_CONFIG_GLOBAL pin in upgrade-tests.mjs"). Read the actual current line and its surrounding context (`grep -n "upgrade-tests" core/test-all.mjs` to get the live line number — it may have shifted from prior tasks). Rewrite the comment to no longer reference a file that doesn't exist — either remove the cross-reference entirely or rephrase to describe the pin without pointing at the deleted file, whichever reads more naturally in context.

- [ ] **Step 4: Test**

```bash
node core/test-all.mjs
node core/validate-script-references.mjs
```
Expected: both pass. `validate-script-references.mjs` should report a lower script count than before (one fewer enumerated script) but still 0 violations.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove upgrade-tests.mjs and its CI gate"
```

---

### Task 3: Delete governance/manifesto files, their CI workflows, and sweep every cross-reference

**Files:**
- Delete: `TRADEMARK.md`, `SIGNATURES.md`, `GOVERNANCE.md`, `MAINTAINERS.md`, `CONTRIBUTORS.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SUPPORT.md`, `SECURITY.md`, `.github/SECURITY.md`, `MANIFESTO.md`, `core/manifesto.mjs`, `.github/PULL_REQUEST_TEMPLATE/sign-manifesto.md`
- Delete: `.github/workflows/manifesto-guestbook.yml`, `.github/workflows/signature-ci.yml`, `.github/workflows/ledger-bot.yml`, `.github/workflows/welcome.yml`
- Modify: `package.json`, `core/doctor.mjs`, `core/scan.mjs`, `core/update-system.mjs`, `core/AGENTS.md`, `core/test-all.mjs`

**Interfaces:**
- Consumes: Task 1's `core/update-system.mjs` state (the `apply()`/`check()` bodies are already gone — this task only touches `SYSTEM_PATHS` and the manifesto print line, both untouched by Task 1).
- Produces: nothing later tasks depend on structurally, but Task 7 must not re-introduce links to any file deleted here.

- [ ] **Step 1: Delete the governance/manifesto files**

```bash
git rm TRADEMARK.md SIGNATURES.md GOVERNANCE.md MAINTAINERS.md CONTRIBUTORS.md CODE_OF_CONDUCT.md CONTRIBUTING.md SUPPORT.md SECURITY.md .github/SECURITY.md MANIFESTO.md core/manifesto.mjs .github/PULL_REQUEST_TEMPLATE/sign-manifesto.md
git rm .github/workflows/manifesto-guestbook.yml .github/workflows/signature-ci.yml .github/workflows/ledger-bot.yml .github/workflows/welcome.yml
```

- [ ] **Step 2: Remove the manifesto npm script**

In `package.json`, delete the line:
```json
    "manifesto": "node core/manifesto.mjs",
```

- [ ] **Step 3: Remove doctor.mjs's manifesto + Discord lines**

In `core/doctor.mjs`, find (near the end of the success branch, `grep -n "manifesto\|discord" core/doctor.mjs` to get the live lines):
```js
    console.log('Join the community: https://discord.gg/8pRpHETxa4');
    console.log('Read the manifesto: `npm run manifesto` — a new way of job searching is taking shape, and you are now part of it.');
```
Delete both lines entirely.

- [ ] **Step 4: Remove scan.mjs's manifesto block and Discord line**

In `core/scan.mjs`, find (`grep -n "manifesto\|discord" core/scan.mjs`):
```js
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
```
Delete this line.

Then find and delete the entire one-time manifesto-note block:
```js
  // One-time-ever manifesto note: first successful REAL run only. The state
  // file keeps it from ever repeating; --dry-run must leave no trace, and a
  // piped/quiet run is not the moment for it.
  if (!dryRun && process.stdout.isTTY && !process.argv.includes('--quiet') && !existsSync('.manifesto-noted')) {
    // OSC 8 hyperlink where support is known, so the click attributes as
    // utm_source=cli while the visible text stays clean; otherwise print the
    // URL with the utm so typed visits attribute too.
    const osc8 = ['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'Tabby'].includes(process.env.TERM_PROGRAM)
      || !!process.env.WT_SESSION || !!process.env.KITTY_WINDOW_ID
      || parseInt(process.env.VTE_VERSION || '0', 10) >= 5000;
    const link = osc8
      ? '\x1b]8;;https://career-ops.org/manifesto?utm_source=cli\x1b\\career-ops.org/manifesto\x1b]8;;\x1b\\'
      : 'career-ops.org/manifesto?utm_source=cli';
    console.log(`\nthe practice behind this tool has a name and a manifesto: ${link}`);
    try { writeFileSync('.manifesto-noted', new Date().toISOString() + '\n'); } catch { /* best-effort */ }
  }
```
Delete this whole `if` block. After deleting, check whether `existsSync` and `writeFileSync` are still used elsewhere in the file (`grep -c "existsSync\|writeFileSync" core/scan.mjs`) before considering removing their imports — most likely they're used elsewhere, so leave the imports alone; just confirm.

- [ ] **Step 5: Clean update-system.mjs's SYSTEM_PATHS and manifesto print**

In `core/update-system.mjs`, `SYSTEM_PATHS` (the array starting ~line 81, already read in Task 1) contains these entries that now point at deleted files — remove each line:
```js
  'SIGNATURES.md',
  'CONTRIBUTING.md',
  'MAINTAINERS.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTORS.md',
  'GOVERNANCE.md',
  'SECURITY.md',
  'SUPPORT.md',
  'TRADEMARK.md',
```
(Read the actual current array first — Task 1 didn't touch this region, so these should be exactly where the earlier grep found them, but confirm before deleting.) This matters even though `apply()`'s body was already deleted in Task 1: `SYSTEM_PATHS` is `export`ed and may be consumed elsewhere (check `grep -rn "SYSTEM_PATHS" core/*.mjs` for other importers before assuming it's now fully dead — if something still reads it as a manifest of what belongs to the system layer, a stale entry pointing at a deleted file is exactly the "stale manifest entry" class of bug `updater-migration-tests.mjs`'s own `#2002` guard was built to catch, per the comment already in this file at ~line 92).

The manifesto print line at ~line 1167 (`console.log('    npm run manifesto  ·  ...')`) was already removed in Task 1 Step 1 — confirm it's gone; if Task 1 was somehow skipped, remove it now.

- [ ] **Step 6: Remove the Manifesto section and Community/Governance section from AGENTS.md**

In `core/AGENTS.md`, delete this entire section (currently right before "## Headless / Batch Mode"):
```markdown
## The CareerOps Manifesto

This project practices CareerOps (see `MANIFESTO.md`). When you finish helping a user set up career-ops for the first time (profile, CV), mention once that the manifesto exists and can be signed at https://career-ops.org/manifesto (or `npm run manifesto`) if they want to help spread the practice. Never repeat the suggestion, never block on it, never nag.
```

Also find the `## CI/CD, Community and Governance` section (near the end, before `## The CareerOps Manifesto`) — currently:
```markdown
## CI/CD, Community and Governance

- **GitHub Actions** on every PR: the full `test-all.mjs` suite, risk-based auto-labeler (🔴 core-architecture, ⚠️ agent-behavior, 📄 docs), first-timer welcome bot. **Branch protection** on `main`: status checks required, no direct pushes (except admin bypass). **Dependabot** on npm/Go/Actions.
- **Contributing:** issue first → discussion → PR with linked issue → CI passes → maintainer review → merge.
- **Governance:** BDFL with contributor ladder (Participant → Contributor → Triager → Reviewer → Maintainer, see `GOVERNANCE.md`) · Contributor Covenant 2.1 (`CODE_OF_CONDUCT.md`) · private vulnerability reporting (`SECURITY.md`) · help questions → Discord/Discussions, not issues (`SUPPORT.md`) · Discord: https://discord.gg/8pRpHETxa4
```
Replace with just the CI-mechanics part that's still true and doesn't reference a deleted file/bot, dropping the "Contributing"/"Governance" bullets and the welcome-bot mention entirely:
```markdown
## CI/CD

- **GitHub Actions** on every PR: the full `test-all.mjs` suite, risk-based auto-labeler (🔴 core-architecture, ⚠️ agent-behavior, 📄 docs). **Branch protection** on `main`: status checks required, no direct pushes (except admin bypass). **Dependabot** on npm/Go/Actions.
```
(Verify this auto-labeler and Dependabot config still actually exist before keeping this sentence — `ls .github/workflows/` and `cat .github/dependabot.yml` if present — if either was removed as part of some earlier unrelated change, adjust the sentence to match reality rather than leaving stale claims.)

- [ ] **Step 7: Clean up the stale allowlist in test-all.mjs's leak check**

`core/test-all.mjs`'s "Personal data leak check" (~line 1320, already read) has an `allowedFiles` array. Remove the entries for files deleted in this task:
```js
  'CONTRIBUTING.md', 'TRADEMARK.md',
  ...
  'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'SECURITY.md', 'SUPPORT.md',
  ...
  'MANIFESTO.md', 'SIGNATURES.md', '.github/PULL_REQUEST_TEMPLATE/sign-manifesto.md',
  '.github/SECURITY.md',
```
Read the actual current array (`grep -n "allowedFiles" -A 20 core/test-all.mjs`) and remove exactly the entries whose files this task deleted, keeping `package.json`, `.github/FUNDING.yml`, `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `.github/plugin/plugin.json`, `CITATION.cff`, `dashboard/internal/ui/screens/pipeline.go`, `dashboard/internal/ui/screens/progress.go`, and the README variants in the array for now — those get handled (and their allowlist entries reconsidered) in Tasks 4, 6, and 9.

- [ ] **Step 8: Test**

```bash
node core/test-all.mjs
```
Expected: no failures. If the leak check now finds a genuine hit in a file no longer in the allowlist (e.g. a lingering reference this task's edits missed), fix that reference in this same task rather than re-adding it to the allowlist.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: remove manifesto feature and upstream governance docs"
```

---

### Task 4: Dashboard — Go module rename and credit-string cleanup

**Files:**
- Modify: `dashboard/go.mod`
- Modify: `dashboard/main.go`, `dashboard/internal/data/career.go`, `dashboard/internal/data/derive.go`, `dashboard/internal/data/derive_test.go`, `dashboard/internal/data/pdf.go`, `dashboard/internal/data/pdf_test.go`, `dashboard/internal/data/progress_metrics_test.go`, `dashboard/internal/ui/screens/pipeline.go`, `dashboard/internal/ui/screens/pipeline_pdf_test.go`, `dashboard/internal/ui/screens/pipeline_test.go`, `dashboard/internal/ui/screens/progress.go`, `dashboard/internal/ui/screens/sort_test.go`, `dashboard/internal/ui/screens/viewer.go`, `dashboard/internal/ui/screens/viewer_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `go build ./...` and `go test ./...` must both pass inside `dashboard/` when this task is done — later tasks don't touch Go files, so this is this task's own closed loop.

- [ ] **Step 1: Rename the module in go.mod**

In `dashboard/go.mod`, change:
```
module github.com/santifer/career-ops/dashboard
```
to:
```
module career-ops/dashboard
```
(An ownerless local module path — `go build`/`go test` work fine with a non-resolving module path as long as every internal import is consistent with it, which the next step ensures.)

- [ ] **Step 2: Update every internal import**

Every file listed above imports one or more of:
```go
"github.com/santifer/career-ops/dashboard/internal/data"
"github.com/santifer/career-ops/dashboard/internal/i18n"
"github.com/santifer/career-ops/dashboard/internal/model"
"github.com/santifer/career-ops/dashboard/internal/theme"
```
In each file, replace the `github.com/santifer/career-ops/dashboard` prefix with `career-ops/dashboard`, keeping the rest of each import path identical (e.g. `github.com/santifer/career-ops/dashboard/internal/data` → `career-ops/dashboard/internal/data`). Use a project-wide find/replace scoped to `dashboard/**/*.go` for the literal string `github.com/santifer/career-ops/dashboard` → `career-ops/dashboard` — every occurrence across all 14 files (confirmed via `grep -rc "github.com/santifer/career-ops/dashboard" --include="*.go" dashboard/` before starting: `main.go` 5, `pipeline.go` 4, `viewer.go` 4, `progress.go` 3, `pipeline_pdf_test.go` 2, `pipeline_test.go` 2, `sort_test.go` 2, `viewer_test.go` 2, and 1 each in `career.go`, `derive.go`, `derive_test.go`, `pdf.go`, `pdf_test.go`, `progress_metrics_test.go`) is the same substitution — no per-file judgment needed here.

- [ ] **Step 3: Remove the manifesto/credit strings in pipeline.go**

In `dashboard/internal/ui/screens/pipeline.go`, find:
```go
	// The manifesto segment is an OSC 8 hyperlink (utm_source=dashboard);
	// terminals without support show the same text, just not clickable. The
	// gap math uses the plain text so the escapes never skew the layout.
	const brandPlain = "built on the CareerOps Manifesto · career-ops by santifer.io"
	manifestoLink := "\x1b]8;;https://career-ops.org/manifesto?utm_source=dashboard\x1b\\built on the CareerOps Manifesto\x1b]8;;\x1b\\"
	brand := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(manifestoLink + " · career-ops by santifer.io")
```
Replace with a plain, non-linked brand string (the manifesto feature is gone, so there's nothing to hyperlink):
```go
	const brandPlain = "career-ops"
	brand := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(brandPlain)
```
Delete the now-unused `manifestoLink` variable and its comment. Search the rest of the file for any other use of `brandPlain`'s old value or `manifestoLink` before finalizing (`grep -n "brandPlain\|manifestoLink" dashboard/internal/ui/screens/pipeline.go`) to make sure nothing else references the deleted variable.

- [ ] **Step 4: Remove the "share your story" upstream link**

Still in `pipeline.go`, find:
```go
const storyTemplateURL = "https://github.com/santifer/career-ops/issues/new?template=i-got-hired.yml"
```
and its usage:
```go
			m.hiredStep = 3
			return m, func() tea.Msg {
				return PipelineOpenURLMsg{URL: storyTemplateURL}
			}
```
This flow opens a browser to file a "you got hired" issue on santifer's repo — not applicable to this fork (it doesn't accept external issues). Change the usage so this keypress just advances state without opening a URL:
```go
			m.hiredStep = 3
```
(i.e. delete the `return m, func() tea.Msg { return PipelineOpenURLMsg{URL: storyTemplateURL} }` and keep only the state advance, matching what the adjacent `"n", "N", "enter", "esc"` case already does two lines below it — read the surrounding switch statement first to match its exact style.) Delete the now-unused `storyTemplateURL` constant. Check whether `PipelineOpenURLMsg` is used anywhere else in the file before considering removing that type — most likely it is (an "open report URL" keybinding elsewhere), so leave the type itself alone, just remove this one dead call site.

- [ ] **Step 5: Remove the credit string in progress.go**

In `dashboard/internal/ui/screens/progress.go`, find:
```go
	brand := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("career-ops by santifer.io")
```
Replace with:
```go
	brand := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("career-ops")
```

- [ ] **Step 6: Build and test**

```bash
cd dashboard
go build ./...
go test ./...
cd ..
```
Expected: clean build, all tests pass. A build failure here almost always means one import wasn't renamed in Step 2 — re-run `grep -rn "santifer" dashboard/**/*.go` (or `grep -rln "santifer" dashboard/` if your shell doesn't expand `**`) and fix any remaining hit before re-testing.

- [ ] **Step 7: Test the wider suite**

```bash
node core/test-all.mjs
```
Expected: no new failures (the leak-check allowlist entries for `dashboard/internal/ui/screens/pipeline.go`/`progress.go` in `core/test-all.mjs` can now be removed, since these files no longer contain "Santiago"/"santifer.io" — do so: find and delete those two lines from the `allowedFiles` array touched in Task 3 Step 7).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: rename dashboard Go module, drop upstream credit strings and story-share link"
```

---

### Task 5: Plugin registry decoupling

**Files:**
- Delete: `.github/ISSUE_TEMPLATE/plugin-registration.yml`
- Modify: `plugins/README.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Delete the registration issue template**

```bash
git rm .github/ISSUE_TEMPLATE/plugin-registration.yml
```
This template exists entirely to onboard external contributors into santifer's community plugin registry ("Register your career-ops-plugin-<name> repo so it can be listed as an approved community plugin," links to `CODE_OF_CONDUCT.md`/`docs/PLUGINS.md` on santifer's repo) — a workflow this fork doesn't run. `plugins-registry/*.json` itself is untouched; this only removes the *submission* workflow.

- [ ] **Step 2: Edit plugins/README.md**

Read the full file. It documents the plugin architecture broadly (hook taxonomy, the no-auto-submit safety constraint, security expectations) — keep all of that. Remove only the registration/submission-specific content, including the line:
```markdown
  [Where career-ops is going (#904)](https://github.com/santifer/career-ops/discussions/904) —
```
and any surrounding sentence that only makes sense in the context of submitting a plugin for community listing (e.g. instructions to open a registry PR, a link to the now-deleted issue template). If a sentence mixes "here's how the hook system works" (keep) with "here's how to submit yours" (remove), split them and keep only the architectural half.

- [ ] **Step 3: Test**

```bash
node core/test-all.mjs
```
Expected: no failures (there is no `.github/ISSUE_TEMPLATE/plugin-registration.yml`-specific test as far as this plan's discovery found — if one exists, fix it in this task).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: drop plugin-registration workflow, keep architecture docs"
```

---

### Task 6: Metadata neutralization

**Files:**
- Modify: `package.json`
- Modify: `scaffolder/package.json`
- Delete: `CITATION.cff`
- Modify: `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `.github/plugin/plugin.json`
- Delete: `.github/FUNDING.yml`

**Interfaces:**
- Consumes: nothing from earlier tasks (Task 1 already handled `package.json`'s `update`/`rollback` scripts and confirmed no change needed there; Task 3 already removed the `manifesto` script).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Neutralize package.json's identity fields**

Read the current `package.json`. Remove (or set to empty, whichever keeps the file valid JSON and idiomatic — prefer removing the key entirely) the `author`, `homepage`, and `repository` fields if present (confirm their exact current values and key names with `grep -n "\"author\"\|\"homepage\"\|\"repository\"" package.json` — the field values point at santifer's identity/repo and should not be replaced with invented data, per Global Constraints).

- [ ] **Step 2: Neutralize scaffolder/package.json's identity fields**

Read `scaffolder/package.json` in full. It currently has:
```json
  "name": "@santifer/career-ops",
  ...
  "author": "Santiago Fernández de Valderrama <hi@santifer.io> (https://santifer.io)",
  "homepage": "https://github.com/santifer/career-ops#readme",
  ...
  "repository": {
    ...
    "url": "git+https://github.com/santifer/career-ops.git",
    ...
  },
  "bugs": {
    "url": "https://github.com/santifer/career-ops/issues"
  },
```
Given Task 1 already disabled this package's actual installer functionality, this `package.json`'s `name` field (`@santifer/career-ops`, an npm-scoped package name under santifer's org) no longer describes anything real for this checkout either. Rename `name` to `career-ops-scaffolder` (unscoped, so it can't be mistaken for a package actually published under santifer's npm org), and remove the `author`, `homepage`, `repository`, and `bugs` fields entirely — same "clear, don't invent" treatment as Step 1.

- [ ] **Step 3: Delete CITATION.cff**

```bash
git rm CITATION.cff
```
This file exists to let others cite the *original* project academically/in publications (`repository-code: "https://github.com/santifer/career-ops"`, `authors: [Santiago Fernández de Valderrama]`). A private, unpublished personal fork has no citation use-case of its own, and the `LICENSE` file plus `core/AGENTS.md`'s origin note (Task 7) already satisfy attribution — keeping a citation file pointed at someone else's repo under this fork's name would be actively misleading.

- [ ] **Step 4: Neutralize the plugin-marketplace manifests**

Read `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, and `.github/plugin/plugin.json` in full. Each registers an `"owner"`-style object with:
```json
    "name": "santifer",
    "url": "https://santifer.io"
```
Change `"name"` to a neutral placeholder appropriate to the surrounding schema (e.g. `"personal fork"` — read each file's schema/comments first to confirm what the field is actually used for before choosing exact wording) and remove the `"url"` field entirely (don't invent a replacement URL).

- [ ] **Step 5: Delete FUNDING.yml**

```bash
git rm .github/FUNDING.yml
```
It contains only `github: santifer` — a GitHub Sponsors link to santifer's account. This fork isn't soliciting funding under that account; deleting is simpler and safer than trying to neutralize a funding-platform config file.

- [ ] **Step 6: Test**

```bash
node core/test-all.mjs
```
Expected: no failures. Update `core/test-all.mjs`'s leak-check `allowedFiles` array (Task 3 Step 7 territory) to remove entries for `package.json`, `.github/FUNDING.yml`, `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `.github/plugin/plugin.json`, and `CITATION.cff` now that they no longer contain personal-data strings (leave `scaffolder/package.json` off that list too if it was ever on it — check first).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: clear identity metadata from package manifests, drop CITATION.cff and FUNDING.yml"
```

---

### Task 7: In-place edits — AGENTS.md, ARCHITECTURE.md, docs/*.md, code comment headers, PR template

**Files:**
- Modify: `core/AGENTS.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/COWORK.md`, `docs/FAQ.md`, `docs/PLUGINS.md`, `docs/SETUP.md`
- Modify: `core/check-table-freshness.mjs`, `core/detect-reposts.mjs`, `core/discover-ats.mjs`, `core/discover-ats.test.mjs`, `core/invite-match.mjs`, `core/process-quality.mjs`, `core/weekly-digest.mjs`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`

**Interfaces:**
- Consumes: nothing structural from earlier tasks — this is prose/comment editing only, but must not link to any file Task 3 or Task 5 deleted.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Rewrite AGENTS.md's Origin section**

In `core/AGENTS.md`, replace:
```markdown
## Origin

Built and used by [santifer](https://santifer.io) to evaluate 740+ offers, generate 100+ tailored CVs, and land a Head of Applied AI role. The archetypes, scoring, and negotiation scripts reflect that search; his portfolio is also open source: [cv-santiago](https://github.com/santifer/cv-santiago).

**It works out of the box, but it's designed to be made yours.** You (AI Agent) can edit the user's files: they say "change the archetypes to data engineering roles" and you do it. That's the whole point.
```
with:
```markdown
## Origin

This is a personal fork of [career-ops](https://github.com/santifer/career-ops), an MIT-licensed open-source job search pipeline originally created by Santiago Fernández de Valderrama. See `LICENSE` for the full copyright notice.

**It works out of the box, but it's designed to be made yours.** You (AI Agent) can edit the user's files: they say "change the archetypes to data engineering roles" and you do it. That's the whole point.
```

- [ ] **Step 2: Strip the ARCHITECTURE.md issue links**

In `ARCHITECTURE.md`, find (already located: lines ~24 and ~28):
```markdown
Settled doctrine ([#918](https://github.com/santifer/career-ops/issues/918)): ...
```
and:
```markdown
Scripts live in `core/` as of the 2026-08-16 multi-tenancy work ([#1386](https://github.com/santifer/career-ops/issues/1386) originally argued the opposite — see below for why that changed). ...
```
In both cases, convert the markdown link to plain inert text — keep the bare issue number, drop the link and URL:
```markdown
Settled doctrine (#918): ...
```
```markdown
Scripts live in `core/` as of the 2026-08-16 multi-tenancy work (#1386 originally argued the opposite — see below for why that changed). ...
```
Leave the rest of both paragraphs' prose untouched (including mentions of "community plugins" or "thousands of fork scripts" — that's architectural rationale about the wider ecosystem this design choice serves, not a link or a credit, and out of this plan's scope).

- [ ] **Step 3: Edit docs/COWORK.md, docs/FAQ.md, docs/PLUGINS.md, docs/SETUP.md**

Read each file in full (`grep -n "santifer\|career-ops\.org\|discord\.gg" docs/COWORK.md docs/FAQ.md docs/PLUGINS.md docs/SETUP.md` to get live line numbers — they were already located once during planning but may have shifted). For each hit:
- A `git clone https://github.com/santifer/career-ops.git` instruction (in `docs/COWORK.md` and `docs/SETUP.md`): this checkout already exists locally with no remote configured, so a "how to get the code" instruction pointing at santifer's repo is stale for this fork's own docs. Leave the clone command's *shape* intact (someone reading these docs for the general pattern still benefits) but don't present it as "how to get this specific fork."
- A `npx @santifer/career-ops init` instruction (in `docs/FAQ.md` and `docs/SETUP.md`): this installer is now disabled (Task 1) — remove or clearly mark this instruction as inapplicable to this fork rather than leaving it as working advice.
- `docs/FAQ.md`'s Discord link and GitHub Discussions link: remove.
- `docs/PLUGINS.md`'s `[Discussion #904](https://github.com/santifer/career-ops/discussions/904)` link: remove (same discussion referenced and removed from `plugins/README.md` in Task 5 — if by this point that removal already happened, this is the same content in a second location).

Use judgment appropriate to each doc's purpose: these are still meant to be useful setup/FAQ docs for whoever uses this checkout — the goal is removing the *upstream-connection* framing, not gutting the practical instructions. Where an instruction only makes sense assuming a live upstream relationship, simplify it to describe what's true for this checkout instead of deleting the surrounding help content wholesale.

- [ ] **Step 4: Strip the issue-comment header URLs in core/*.mjs**

Each of these files has a JSDoc-style header comment citing its originating GitHub issue with a live URL:
```js
 * Issue #2036 — github.com/santifer/career-ops
```
(`core/check-table-freshness.mjs` #2036, `core/detect-reposts.mjs` #1205, `core/discover-ats.mjs` #1864, `core/discover-ats.test.mjs` #1864, `core/invite-match.mjs` #1495, `core/process-quality.mjs` #1466, `core/weekly-digest.mjs` #2129). In each file, strip the URL, keeping the bare issue number as inert historical shorthand (same treatment as `ARCHITECTURE.md`'s #918/#1386 in Step 2):
```js
 * Issue #2036
```

- [ ] **Step 5: Edit the PR template**

In `.github/PULL_REQUEST_TEMPLATE.md`, remove or rewrite these lines:
```markdown
- [ ] I have read [CONTRIBUTING.md](https://github.com/santifer/career-ops/blob/main/CONTRIBUTING.md)
- [ ] My changes respect the [Data Contract](https://github.com/santifer/career-ops/blob/main/DATA_CONTRACT.md) (no modifications to user-layer files)
- [ ] My changes align with the [project roadmap](https://github.com/santifer/career-ops/discussions/156)

Questions? [Join the Discord](https://discord.gg/8pRpHETxa4) for faster feedback.
```
`CONTRIBUTING.md` is deleted (Task 3) — remove that checklist item. `DATA_CONTRACT.md` still exists and is still relevant — keep that item, but repoint the link locally: `[Data Contract](../DATA_CONTRACT.md)` (confirm the correct relative path from `.github/PULL_REQUEST_TEMPLATE.md` to `DATA_CONTRACT.md` at the repo root — read the file's current location first). The roadmap-discussion item and the Discord line both point at upstream community spaces — remove both.

- [ ] **Step 6: Test**

```bash
node core/test-all.mjs
```
Expected: no failures.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: neutral origin note, strip upstream issue/discussion links from architecture and setup docs"
```

---

### Task 8: web/ and scaffolder/ doc cleanup

**Files:**
- Modify: `web/README.md`
- Modify: `scaffolder/README.md`

**Interfaces:**
- Consumes: Task 1's decision that `scaffolder`'s installer is disabled — this task's README edit must describe that accurately.
- Produces: nothing later tasks depend on.

**Explicitly out of scope for this task: `web/CHANGELOG.md`.** Per Global Constraints, it's a frozen, auto-generated historical record (release-please output) full of real links to real past commits/issues on santifer's repo — leave it entirely alone, including every santifer link in it.

- [ ] **Step 1: Edit web/README.md**

Read the file in full. It currently has:
```markdown
> [Discussion #1142](https://github.com/santifer/career-ops/discussions/1142) ·
> roadmap context → [Discussion #156](https://github.com/santifer/career-ops/discussions/156).
```
Remove this line (both discussion links point at upstream community spaces this fork doesn't participate in). Read the rest of the file for any other santifer/career-ops.org/Discord references beyond what was found during planning and apply the same removal treatment, keeping the rest of the dashboard-app documentation (setup instructions, feature descriptions) intact.

- [ ] **Step 2: Edit scaffolder/README.md**

Read the file in full. It currently has:
```markdown
One-command installer for [**career-ops**](https://github.com/santifer/career-ops) — the AI-powered job search pipeline built on Claude Code.
...
npx @santifer/career-ops init
...
npx @santifer/career-ops init [folder]   # default folder: ./career-ops
...
Prefer the manual route? `git clone` still works exactly as before — see the [setup guide](https://github.com/santifer/career-ops/blob/main/docs/SETUP.md).
...
MIT © [Santiago Fernández de Valderrama](https://santifer.io)
```
Since Task 1 disabled this installer's actual functionality, rewrite the README to state that plainly near the top (e.g. "This installer is disabled in this personal fork — see `core/AGENTS.md` for how this checkout relates to the original project.") rather than leaving working-sounding `npx` instructions that no longer do anything. Remove the live links to santifer's repo/setup guide. For the MIT credit line, keep it but drop the live `https://santifer.io` link, consistent with the "MIT-required credit stays, live links go" rule used everywhere else in this plan — e.g. `MIT © Santiago Fernández de Valderrama`.

- [ ] **Step 3: Test**

```bash
node core/test-all.mjs
```
Expected: no failures.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: disable-state note and stripped upstream links in web/ and scaffolder/ READMEs"
```

---

### Task 9: README*.md — all language variants

**Files:**
- Modify: `README.md`, `README.ar.md`, `README.cn.md`, `README.da.md`, `README.de.md`, `README.es.md`, `README.fr.md`, `README.hi.md`, `README.ja.md`, `README.ko-KR.md`, `README.pl.md`, `README.pt-BR.md`, `README.ru.md`, `README.ta.md`, `README.tr.md`, `README.ua.md`, `README.zh-TW.md` (17 files)

**Interfaces:**
- Consumes: `core/AGENTS.md`'s new Origin text (Task 7 Step 1) as the canonical tone/content reference for what "neutral fork credit" sounds like.
- Produces: nothing later tasks depend on.

This is the largest task by file count. Every file shares the same structural pattern (confirmed by reading `README.md`'s first 40 lines during planning) — a promotional header block, then substantive setup/feature documentation below a `---` divider. The treatment is the same principle applied per-file, not a mechanical find/replace (the promotional text is different prose per language, and only a native/fluent pass can judge whether a translated replacement reads naturally) — but the *shape* of the edit is identical across all 17 files.

- [ ] **Step 1: Confirm the shared header pattern**

`README.md`'s current header (before the `---` divider) is:
```markdown
<p align="center"><picture>...</picture></p>

<div align="center">

[English](README.md) | [Español](README.es.md) | ... (language switcher — 17 links)

</div>

<p align="center">
  <a href="https://x.com/santifer"><img src="docs/hero-banner.jpg" alt="career-ops Multi-Agent Job Search System" width="800"></a>
</p>

<p align="center">
  <em>I spent months applying to jobs the hard way. So I engineered the system I wish I had.</em><br>
  Companies use AI to filter candidates. <strong>I just gave candidates AI to <em>choose</em> companies.</strong><br>
  <em>Now it's open source.</em>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/25195" ...><img ... alt="santifer%2Fcareer-ops | Trendshift" .../></a>
</p>

<p align="center">
  <a href="https://www.producthunt.com/products/santifer-io?..." ...><img ... alt="career-ops on Claude | Product Hunt" .../></a>
</p>

<p align="center"><sub>FEATURED IN</sub></p>

<p align="center">
  <a href="https://wired.com.gr/..."><picture>...<img alt="WIRED" ...></picture></a>
  ...
  <a href="https://www.businessinsider.com/..."><picture>...<img alt="Business Insider" ...></picture></a>
</p>

---
```
For each of the 17 files, open it and confirm this same structural shape appears (language variants may have minor formatting differences — trust what's actually in the file over this description).

- [ ] **Step 2: Apply the same edit to each file**

For each of the 17 files:
1. **Keep** the wordmark image and the language-switcher `<div align="center">...</div>` block exactly as-is — purely functional, not branding.
2. **Remove** the `<a href="https://x.com/santifer">` hero-banner block (a direct link to santifer's personal X/Twitter account).
3. **Remove** the Trendshift badge block (`trendshift.io/repositories/25195`, alt text literally `santifer%2Fcareer-ops`) and the ProductHunt badge block (`producthunt.com/products/santifer-io`) — both are upstream-repo/upstream-person promotional badges, not something this fork earned independently.
4. **Remove** the `FEATURED IN` press block (WIRED, Business Insider — press coverage of santifer's own story, not this fork).
5. **Replace** the personal narrative paragraph (`I spent months applying...`) with a neutral, non-promotional one-liner in that language, e.g. (English, adapt per-language for the other 16):
   ```markdown
   <p align="center">
     <em>AI-powered job search automation — evaluate offers, generate tailored CVs, and track your pipeline end to end.</em><br>
     This is a personal fork of the open-source <a href="https://github.com/santifer/career-ops">career-ops</a> project.
   </p>
   ```
6. **Everything below the `---` divider**: read it for any additional santifer/career-ops.org/Discord/discord.gg links (setup instructions, community links further down, footer credit lines) and strip those the same way already established in every other task — live upstream links removed, functional content otherwise untouched. Do not rewrite feature descriptions, setup instructions, or other substantive documentation below the divider beyond removing such links.

- [ ] **Step 3: Test after each file (or after the batch)**

```bash
node core/test-all.mjs
```
Run after finishing all 17 (or in smaller batches if that's easier to verify) — expected: no failures. The leak-check `allowedFiles` array in `core/test-all.mjs` currently lists all 17 README files as "legitimately credit Santiago" — once this task removes the live-link/promotional credit and replaces it with the neutral one-liner from Step 2 (which still names "career-ops" and links to the upstream repo, but no longer names Santiago personally in a promotional context), re-run the leak check and confirm it's still clean; if a README still legitimately mentions "Santiago" anywhere (e.g. inside the neutral fork-origin sentence, if you choose wording that includes his name), leave that file's entry in the allowlist — don't remove an entry that's still accurate.

- [ ] **Step 4: Commit**

```bash
git add README*.md
git commit -m "docs: replace promotional header with neutral fork credit across all README language variants"
```

---

### Task 10: Final verification sweep

**Files:** none modified (verification only), unless a residual hit is found — then fix it in whatever file it's in.

**Interfaces:**
- Consumes: the complete state of every prior task.
- Produces: the plan's exit criteria.

- [ ] **Step 1: Re-run the discovery sweep this plan was built from**

```bash
grep -rl "santifer" --include="*.md" --include="*.mjs" --include="*.json" --include="*.yml" --include="*.yaml" --include="*.go" --include="*.sh" --include="*.html" --include="*.cff" -i . 2>/dev/null | grep -v "node_modules\|archive/\|docs/superpowers/\|\.tmp-script-test\|workspaces/"
```
Expected remaining hits, and only these:
- `LICENSE` (untouched per Global Constraints — MIT copyright notice).
- `web/CHANGELOG.md` and `docs/SOURCE_INDEXING_LOG.md` (untouched historical records per Global Constraints).
- Any README's neutral fork-credit sentence from Task 9 Step 2 that names "Santiago Fernández de Valderrama" or links to `github.com/santifer/career-ops` as the upstream project (this is the intentional MIT-spirit credit, not a leftover).
- `core/AGENTS.md`'s new Origin section (Task 7 Step 1), for the same reason.
- `scaffolder/README.md`'s `MIT © Santiago Fernández de Valderrama` line (Task 8 Step 2), for the same reason.

Any other hit is a miss — go fix it in its own file, following whichever earlier task's category it belongs to (delete outright / functional decouple / edit in place), then re-run this grep.

- [ ] **Step 2: Re-run the same sweep for career-ops.org and the Discord invite**

```bash
grep -rli "career-ops\.org\|discord\.gg/8pRpHETxa4" --include="*.md" --include="*.mjs" --include="*.json" --include="*.yml" --include="*.yaml" --include="*.go" . 2>/dev/null | grep -v "node_modules\|archive/\|docs/superpowers/\|\.tmp-script-test\|workspaces/"
```
Expected: zero hits, except `web/CHANGELOG.md`/`docs/SOURCE_INDEXING_LOG.md` if either happens to reference these (unlikely, but they're exempted regardless). Fix anything else found.

- [ ] **Step 3: Full test suite**

```bash
node core/test-all.mjs
```
Expected: fully green, no failures.

- [ ] **Step 4: Script-reference guard**

```bash
node core/validate-script-references.mjs
```
Expected: 0 violations (its enumerated script count is lower than before this plan started, since `core/manifesto.mjs` and `core/upgrade-tests.mjs` are both gone — that's expected, not a regression).

- [ ] **Step 5: Dashboard build**

```bash
cd dashboard
go build ./...
go test ./...
cd ..
```
Expected: clean build, all tests pass.

- [ ] **Step 6: Manual smoke check of the disabled paths**

```bash
node core/update-system.mjs check
node core/update-system.mjs apply
node scaffolder/bin/cli.mjs init 2>&1 | head -5
```
Expected: all three report their disabled state clearly (per Task 1) rather than crashing or silently doing nothing.

- [ ] **Step 7: Commit (only if Step 1 or 2 found and fixed something)**

```bash
git add -A
git commit -m "fix: residual upstream references found by final de-brand sweep"
```
If Steps 1-2 found nothing to fix, there's nothing to commit here — this task is verification-only.
