# De-brand Personal Fork — Design

**Status:** Approved, pending implementation plan
**Date:** 2026-08-21
**Author:** Roberto Alevás Vásquez (via Claude)

## Context

This checkout is a personal fork of `github.com/santifer/career-ops`, an
MIT-licensed open-source project. Immediately after finishing a large plan
that fixed stale `core/` script-path references repo-wide, the user asked
to remove the now-irrelevant upgrade-testing infrastructure
(`core/upgrade-tests.mjs` tests upgrading across santifer's own historical
release tags — a scenario that doesn't apply to a decoupled personal
instance) and, more broadly, "remove all connection to santifer's repo."

A repo-wide `grep -rl santifer` found ~70 real files (after filtering a
leftover test-artifact directory and workspace junction-copies of the same
content) spanning several genuinely different kinds of "connection":
functional code that fetches from the upstream repo, governance/legal docs
that describe the upstream project's own community structure, community
links (Discord, a manifesto-signing site), a community-curated plugin
registry, and general credit/origin prose repeated across ~17 README
language variants.

**Hard constraint, verified by reading the actual `LICENSE` file:** this
project is MIT-licensed, copyright held by Santiago Fernández de Valderrama.
MIT requires "the above copyright notice and this permission notice shall
be included in all copies or substantial portions of the Software." The
`LICENSE` file's copyright notice is explicitly out of scope — it does not
get touched, regardless of how the rest of this de-branding goes.

## Goals

- `core/upgrade-tests.mjs` and its CI wiring removed entirely — it tests a
  scenario (upgrading across santifer's release history) that no longer
  applies once decoupled.
- `core/update-system.mjs`'s self-updater (`CANONICAL_REPO`, fetch/apply
  path) stops silently pointing at santifer's repo — the whole
  update/apply mechanism is disabled with a clear message, not left to
  fail confusingly against a repo it shouldn't be talking to.
- The manifesto feature (`core/manifesto.mjs`, `MANIFESTO.md`, the `npm run
  manifesto` script, and every reference to it across `doctor.mjs`,
  `scan.mjs`, `test-all.mjs`, `update-system.mjs`, mode files, and READMEs)
  removed entirely — it's a community-building feature for the upstream
  project's user base, not something that makes sense decoupled.
- Governance/legal docs that only describe the *upstream* project's own
  community structure — `TRADEMARK.md`, `SIGNATURES.md`, `GOVERNANCE.md`,
  `MAINTAINERS.md`, `CONTRIBUTORS.md`, `CODE_OF_CONDUCT.md`,
  `CONTRIBUTING.md`, `SUPPORT.md`, `SECURITY.md` (and its confirmed-identical
  duplicate `.github/SECURITY.md`) — deleted outright, along with any CI/doc
  cross-references to them (contribution-workflow mentions, issue templates
  that assume outside contributors).
- `plugins-registry/*.json` kept as a static local list (the plugin
  manifests are useful regardless of who originally curated them), but every
  "submit yours upstream" / registration-workflow reference (e.g.
  `.github/ISSUE_TEMPLATE/plugin-registration.yml`) removed.
- Community/branding links (Discord invite, the manifesto site, GitHub
  issue/repo URLs) stripped from `core/AGENTS.md`, `ARCHITECTURE.md`, and
  every `README*.md` language variant.
- `core/AGENTS.md`'s "Origin" section and every README's equivalent
  intro/credit prose rewritten: a brief, neutral note that this is a
  personal fork of an open-source MIT-licensed project — no promotional
  "built by / land a role" narrative, no live links to santifer's site or
  portfolio repo (`cv-santiago`) — while the *spirit* of attribution (beyond
  just the `LICENSE` file) is preserved in that neutral note.
- `package.json`'s `author`/`homepage`/`repository` fields neutralized —
  this checkout has no remote configured, so nothing is invented in their
  place; they're simply cleared rather than left pointing at santifer's
  metadata.

## Non-goals

- **`LICENSE` itself** — untouched, per the hard constraint above.
- **Rewriting git history** to remove santifer's name from past commit
  authorship/messages — not practical or meaningful for a local checkout
  with no remote, and not what was asked.
- **Relicensing away from MIT** — a legal decision requiring the copyright
  holder's involvement, not something this de-branding effort attempts.
- **Stripping inert historical shorthand** — code comments referencing a
  bare issue number (e.g. "the exact #1998 failure class," found in
  `core/update-system.mjs`'s own comments) don't link anywhere live and
  aren't a "connection" in the sense this effort targets; they're internal
  labels. Rewriting every such comment across dozens of files for a
  cosmetic win isn't worth the churn or the risk of losing useful context.
- **`plugins-registry/*.json`'s actual content/curation** — kept as-is
  (a frozen snapshot), not re-curated or re-validated against upstream.

## Architecture

Same pattern as the just-completed `core/` path-reference-sync plan, since
it worked well there: **build a verification/inventory tool first**, before
any remediation, so the tool's own output — not a pre-guessed file list —
becomes the authoritative source of truth for every later task. The key
difference here is that this inventory needs to *classify*, not just
*detect*: each of the ~70 files gets tagged with how it should be treated
(`delete`, `edit`, `functional-change`, or `leave-alone`), since the
treatment differs by category in a way a single mechanical find-and-replace
(like the previous plan's `node {script}` → `node core/{script}` rule)
cannot capture.

Remediation then proceeds by category, roughly in this order: functional
decoupling first (the self-updater, `upgrade-tests.mjs` — these are the
parts with real behavioral consequences), then outright deletions
(governance docs, the manifesto feature, plugin-registration-workflow
references — mechanically safe once the functional pieces are settled),
then in-place edits (README credit text, `AGENTS.md`'s Origin section,
`package.json` metadata, community links across docs) — deferring the
highest-volume, most repetitive category (17 README language variants) to
last, matching the previous plan's own successful ordering.

## Component: the inventory/classification tool

A script (exact name/location TBD at plan time, likely `core/`-adjacent or
a one-off scratch script since — unlike the previous plan's guard — there
is no ongoing reason to keep this as a permanent regression check; a
de-branding pass is a one-time event, not a recurring risk the way a script
move is) that:

1. Enumerates every tracked file (`git ls-files`) containing "santifer"
   (case-insensitive) or specific known santifer-owned URLs/domains
   (`github.com/santifer`, `santifer.io`, `career-ops.org`).
2. For each hit, the implementer classifies it by hand into one of the four
   treatment categories above, based on this spec's Goals section — the
   tool's job is producing a complete, accurate list to classify *from*,
   not automating the classification itself (unlike the previous plan's
   guard, where "bare path, needs `core/` prefix" was a single unambiguous
   rule; here, whether a file gets deleted vs. edited is a judgment call
   this spec makes per-category, not something a script should infer).
3. The classified list becomes each remediation task's Step 1 input,
   mirroring exactly how the previous plan's Task 1 output became every
   later task's authoritative fix list.

## Component: functional decoupling

**`core/update-system.mjs`:** `CANONICAL_REPO` and the `git('fetch',
CANONICAL_REPO, 'main')` call, plus whatever `apply`/`rollback` control
flow depends on a live upstream fetch succeeding, get replaced with a clear,
early "auto-update is disabled for this instance" message and a clean
non-zero exit (or whatever exit-code convention the surrounding CLI already
uses for "intentionally unavailable" — read the file's existing error-path
conventions before choosing). `npm run update`/`npm run rollback` (the
`package.json` script aliases) either get removed or updated to point at a
script that immediately reports the disabled state — implementer's call at
plan time, based on what's least confusing for a future `npm run update`
attempt.

**`core/upgrade-tests.mjs`:** deleted outright. Its CI wiring in
`.github/workflows/test.yml` (the "Upgrade regression gate" job, fixed to
use the correct `core/` path just one plan ago) removed along with it. The
one comment-level reference to it in `core/test-all.mjs` (line ~5014, a
note about a `GIT_CONFIG_GLOBAL` pin shared between two files) updated to
remove the now-dangling cross-reference.

## Component: outright deletions

`TRADEMARK.md`, `SIGNATURES.md`, `GOVERNANCE.md`, `MAINTAINERS.md`,
`CONTRIBUTORS.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SUPPORT.md`,
`SECURITY.md`, `.github/SECURITY.md` (confirmed byte-identical duplicates —
both go), `MANIFESTO.md`, `core/manifesto.mjs`,
`.github/PULL_REQUEST_TEMPLATE/sign-manifesto.md`. Each deletion needs its
own cross-reference sweep — e.g. `package.json`'s `"manifesto"` script
entry, `core/doctor.mjs`/`core/scan.mjs`/`core/update-system.mjs`'s own
references to the manifesto feature, `core/AGENTS.md`'s "sign the
manifesto" instruction and the "Contributing" / "Governance" section that
currently points at these docs, `.github/ISSUE_TEMPLATE/*.yml` entries that
reference deleted docs, and `core/update-system.mjs`'s `SYSTEM_PATHS`/
`USER_PATHS` arrays (which almost certainly register these exact paths —
deleting the file without removing its registration would reintroduce
literally the same class of bug the previous plan's guard was built to
catch, just for a deleted-file case instead of a moved-file case; the
implementer should explicitly check this).

## Component: plugin registry decoupling

`plugins-registry/*.json` files themselves are untouched (kept as a frozen
local snapshot). `.github/ISSUE_TEMPLATE/plugin-registration.yml` and any
prose in `plugins/README.md`/`CONTRIBUTING.md`-adjacent docs describing
"how to submit your plugin to the registry" get removed or rewritten to
reflect that this is a personal, no-longer-accepting-submissions snapshot —
exact wording is plan-level detail.

## Component: in-place edits

**`core/AGENTS.md`'s "Origin" section, `ARCHITECTURE.md`, every
`README*.md` (~17 variants):** the credit/origin paragraph rewritten per
the Goals section (neutral MIT-fork note, no promotional narrative, no live
links); Discord invite and any `career-ops.org`/`github.com/santifer` URLs
removed. Given the previous plan's Task 6 already established a clean,
verified pattern for touching all ~17 README language variants
mechanically (fixing a shared command reference without disturbing
translated prose around it), this task should follow the same discipline —
except here the change is prose-level, not a code-block command, so each
language's translator-equivalent text needs individual judgment, not a
single mechanical substitution. This is likely the single largest task in
the eventual plan by file count.

**`package.json`:** `author`, `homepage`, `repository` fields cleared
(empty string or field removed entirely — implementer's call, whichever is
more idiomatic for an npm `package.json` with no active publish target).

## Testing

- After the inventory tool runs, its classified output should account for
  every file the original `grep -rl santifer` sweep found (minus the
  leftover test-artifact directory and workspace junction-copies, which
  aren't independent files).
- After all deletions and edits, re-run the same `grep -rl santifer`-style
  sweep (case-insensitive, plus the specific known domains) — expect zero
  hits outside `LICENSE` and the inert issue-number shorthand explicitly
  named as a non-goal.
- Run the full test suite (`node core/test-all.mjs`) after each task and at
  the end — expect no regressions. Given this plan deletes files that
  `core/update-system.mjs`'s `SYSTEM_PATHS`/`USER_PATHS` likely register,
  and deletes `core/upgrade-tests.mjs` which the previous plan's CI fix
  just pointed a workflow job at, watch specifically for the same class of
  "a test hardcoded old content as expected" regression the previous plan
  hit twice (in `updater-migration-tests.mjs` and `test-all.mjs`'s own
  batch-prompt assertion) — fix any such regression strictly within the
  same task, matching that established precedent.
- Confirm `node core/validate-script-references.mjs` (the guard built by
  the previous plan) still reports 0 violations throughout — deleting
  `core/upgrade-tests.mjs` removes one entry from its dynamically-enumerated
  script list, which is expected and fine, not a regression.
