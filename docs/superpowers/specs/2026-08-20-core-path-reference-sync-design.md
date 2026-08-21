# `core/` Path Reference Sync — Design

**Status:** Approved, pending implementation plan
**Date:** 2026-08-20
**Author:** Roberto Alevás Vásquez (via Claude)

## Context

`docs/superpowers/plans/2026-08-15-workspace-multitenancy-core.md`'s Task 1
moved ~70 scripts from the repo root into `core/`, so that every per-user
workspace could junction one stable `core/` directory rather than symlinking
dozens of individual files. Task 1's own verification step swept for stale
references correctly — but only within the class of reference it was written
to check: JS `import`/`require` paths and `join(ROOT, ...)` calls *inside the
moved `.mjs` files themselves*:

```
grep -rnE "(from|require)\s*\(?['\"]\./(plugins|providers|...)" core/*.mjs
grep -rnE "join\(\s*(ROOT|__dirname|CAREER_OPS)\s*,\s*['\"](plugins|...)" core/*.mjs
```

It never swept for the *other* kind of reference these scripts have: a bare
`node {script}.mjs` shell-command invocation written in prose (a mode file, a
README, a CI workflow step) — which isn't an import at all, and nothing in
Task 1's verification would ever have looked at a `.md` or `.yml` file. Tasks
2, 3, and 9 in that same plan — each relocating a different kind of file —
*did* include exactly this sweep (`grep -rn ... --include="*.md" --include=
"*.mjs"`), proving the discipline existed; it just wasn't specified for
Task 1's specific case.

The result, discovered live on 2026-08-20 while investigating why a running
`/run` cycle's Telegram acknowledgment never arrived: `node plugins.mjs run
telegram notify ...` (Step 3a of `modes/telegram.md`) fails with
`MODULE_NOT_FOUND`, since `plugins.mjs` now lives at `core/plugins.mjs`. A
systematic sweep for every `core/*.mjs` script, across every `.md`/`.yml`
reference site in the repo, found the same bug recurring in:

- **A real code bug**, not just documentation: `core/update-system.mjs`'s own
  self-update re-exec mechanism (`resolveReexecCheckout('FETCH_HEAD',
  'update-system.mjs')` and the following `execFileSync` call) passes the
  stale bare filename, so `git show FETCH_HEAD:update-system.mjs` finds
  nothing and the checkout/re-exec silently no-ops.
- **Broken CI**: `.github/workflows/test.yml` runs `node test-all.mjs
  --quick` and `node upgrade-tests.mjs --pr-gate`/`--canary` with no
  `working-directory` override, from a checkout root where neither script
  exists; `.github/workflows/plugin-registry-validate.yml` has the same
  issue with `validate-plugin-registry.mjs`.
- **Live runtime docs an agent actually executes**: `modes/telegram.md`,
  `core/AGENTS.md`, every plugin's `skill.md`, `batch/batch-prompt.md`.
- **Human-facing docs**: `CONTRIBUTING.md`, the PR template, `tests/
  README.md`, `dashboard/README.md`, `providers/README.md`,
  `DATA_CONTRACT.md`, `DOCKER.md` (the `./cops node <script>` row),
  `templates/README.md`, `examples/*.md`, `seeds/README.md`, `plugins/
  README.md`, and `README.md` across all ~8 language translations.
- **`ARCHITECTURE.md` itself**, which documents a principle ("scripts stay
  at root — a cosmetic reorganization would break forks and plugins for no
  functional gain," #1386) that Task 1 silently overrode without updating.

Not affected, confirmed by manually auditing all 24 `core/*.mjs` files that
call `spawn`/`execFileSync`/`execSync`: every other file consistently
defines its own `const ROOT = dirname(fileURLToPath(import.meta.url))` (its
own directory, `core/`) and correctly references siblings by bare filename
relative to that — the pattern that made `telegram-monitor.mjs` look
suspicious at first but is actually correct. `update-system.mjs` is the one
file that deliberately defines `ROOT` one level higher (the actual repo
root, for reasons unrelated to this bug) and then mixed the two conventions
in its re-exec path.

## Goals

- Every bare `node {core-script}` reference in a live doc, CI workflow, or
  piece of code that's actually broken gets fixed to `node core/
  {core-script}` (or the equivalent for non-`node`-prefixed forms like
  `./cops node <script>`).
- The one real code bug (`update-system.mjs`'s re-exec mechanism) is fixed
  and, ideally, exercised by the existing `upgrade-tests.mjs` compat-matrix
  harness rather than left as a silent no-op.
- CI (`.github/workflows/test.yml`, `plugin-registry-validate.yml`) can
  actually run the scripts it invokes.
- `ARCHITECTURE.md`'s stated principle is rewritten to match reality: why
  scripts live in `core/` now (a structural requirement of the multi-tenancy
  junction design, not a cosmetic reorganization), when this superseded the
  original #1386 principle, and how path-reference integrity is now
  guaranteed going forward (the next goal).
- **A permanent, automated regression check** — not a written rule anyone
  has to remember — that fails `test-all.mjs` (and therefore CI) if any
  future script move reintroduces a bare, unprefixed reference anywhere in
  the repo's tracked docs/CI files. This is the actual future-proofing: it
  doesn't depend on whoever makes the next move having read any rule, in
  this session or a future one, human or AI.
- A short, durable convention note (in `core/AGENTS.md`, System Layer, read
  automatically every session) naming the checklist Tasks 2/3/9 already
  used correctly, so the next file-moving task starts from it instead of
  re-deriving it — or skipping it, the way Task 1 did.

## Non-goals

- **No compatibility shims** at the old root-level paths (`scan.mjs`,
  `doctor.mjs`, etc.) — decided explicitly: fix every reference to point at
  the real `core/` location, accept that the old bare paths are gone, keep
  one canonical location with nothing to keep in sync going forward.
- **No automated code-layer scanner** for `.mjs`-to-`.mjs` `spawn`/
  `execFileSync` calls. All 24 files using these were audited by hand
  tonight; 23 already correctly use their own file-local `ROOT` convention,
  and the one real bug (`update-system.mjs`) is a fix, not a pattern to
  build detection for. Building a generalized "resolve this file's ROOT
  convention" analyzer for a bug class we've now manually verified has
  exactly one instance is not a good use of engineering effort relative to
  the doc/CI-layer check, which already caught 30+ real instances.
- **No retroactive edits to `archive/**` or `docs/superpowers/{plans,
  specs}/**`.** These are frozen historical records — a plan or spec is a
  point-in-time snapshot of what was decided and built, not living
  documentation, and editing one after the fact to match current reality
  would falsify the record the same way editing a merged commit would.
- **No generated "living documentation" map/graph of the whole repo's file
  connections.** Considered and deliberately scaled back: the proportionate
  version of this is the regression test itself (which already *is* a
  complete, mechanically-verified answer to "does everything point where it
  should," recomputed fresh every run) — a separate generated-markdown
  artifact would be one more thing to keep in sync for no benefit the test
  doesn't already provide.

## Architecture

Two independent pieces of work, neither depending on the other:

**Remediation** — fix every currently-broken reference, in priority order
by actual severity: the real code bug first (silent self-update failure),
then CI (blocks every future PR), then live-runtime docs (the class that
caused tonight's incident directly), then human-facing docs, then the
architecture-principle rewrite.

**Prevention** — one new assertion in `core/test-all.mjs`, wired into the
suite that already runs on every commit locally and (once the CI fix above
lands) on every PR. This is deliberately built *first*, before most of the
remediation: running it immediately after writing it produces the complete,
authoritative list of every current violation — replacing the ad-hoc,
incrementally-expanding manual grep search this session did (and that
directly motivated this whole redesign: "I feel like we just made this a
mess... we're kind of doing this blindly"). Every later remediation task
works off that list, not off memory or a fresh grep pass.

## Component: the regression check

A new check in `core/test-all.mjs`, following the file's existing
conventions for a standalone assertion group. Logic:

1. Enumerate every script basename in `core/*.mjs` at test-run time (not a
   hardcoded list — this is what makes the check generalize to any *future*
   script move, not just today's known set).
2. Enumerate every tracked file to scan: `git ls-files` filtered to `*.md`
   and `*.yml`/`*.yaml`, excluding `archive/**` and `docs/superpowers/
   {plans,specs}/**` (frozen historical records, per Non-goals). Using
   `git ls-files` rather than a filesystem walk sidesteps any confusion from
   workspace junctions (`workspaces/*/core` etc. resolving to the same
   underlying files) — it only ever sees real, uniquely-tracked paths.
3. For each script basename, search each scanned file's content for a bare
   `node {basename}` occurrence not immediately preceded by `core/` (a
   literal substring check suffices — `"node core/scan.mjs"` does not
   contain `"node scan.mjs"` as a substring, so no lookbehind regex is
   needed). Also check the `./cops node {basename}` form specifically for
   `DOCKER.md`.
4. Any violation found → the assertion fails, printing every `file:line`
   hit so a human/agent immediately has the complete list, not just "some
   test failed."
5. Zero violations → pass. This is the steady state after remediation, and
   the state every future PR must maintain.

## Component: `core/update-system.mjs` fix

`resolveReexecCheckout('FETCH_HEAD', 'update-system.mjs')` (currently) →
`resolveReexecCheckout('FETCH_HEAD', 'core/update-system.mjs')`. Since
`relativeImportSpecifiers(source)` walks relative imports from
`pathPosix.dirname(file)`, fixing the entry point should correctly cascade
the whole graph-walk without further changes — but this needs verifying
directly, not assumed, once the fix is in place. The subsequent
`execFileSync(process.execPath, ['update-system.mjs', 'apply'], { cwd:
ROOT, ... })` needs the matching fix (either the array argument or an
equivalent `join()`-based resolution, whichever matches this file's
existing style once read in context). `REEXEC_FALLBACK_FILES` needs
checking for the same stale-bare-name issue while in this code.

Also worth investigating directly (not fixing blind): why `upgrade-tests.mjs`
— which specifically exercises `update-system.mjs apply` and a post-upgrade
`doctor.mjs --json` smoke test across historical release tags — doesn't
appear to have caught this. Understanding whether it's a gap in that
harness's coverage (e.g. `oldTag` predates the Task 1 move, so the bug never
gets exercised) or something else informs whether this needs its own
follow-up, separate from this plan.

## Component: CI workflow fixes

`.github/workflows/test.yml`: `node test-all.mjs --quick` → `node core/
test-all.mjs --quick`; `node upgrade-tests.mjs --pr-gate` / `--canary` →
`node core/upgrade-tests.mjs --pr-gate` / `--canary`.
`.github/workflows/plugin-registry-validate.yml`: `node
validate-plugin-registry.mjs` (both occurrences) → `node core/
validate-plugin-registry.mjs`.

## Component: doc remediation

Everything the regression check's first (expected-to-fail) run reports,
grouped by the categories already identified during this session's manual
sweep for task-sizing purposes (`modes/telegram.md` remainder,
`core/AGENTS.md` remainder, plugin `skill.md` files, `batch/batch-
prompt.md`, then the broader human-facing doc set, then all-language
`README.md`s) — but the actual fix list is whatever the check reports, not
this pre-sweep, since the check is authoritative and this session's manual
search was explicitly established as *not* reliable enough to trust as the
final word.

## Component: `ARCHITECTURE.md` rewrite

Replace the `#1386` section's claim that scripts stay at root with: scripts
live in `core/` as of the 2026-08-15 multi-tenancy work, because every
per-user workspace junctions one stable `core/` directory rather than
symlinking dozens of files individually — a structural requirement, not a
cosmetic reorganization. Path stability is still a real value here; it's
now guaranteed by the automated regression check in `core/test-all.mjs`
(Component above) rather than by "we just don't move things," after a
2026-08-20 incident where that guarantee was silently absent for one
particular kind of reference.

## Component: durable convention note

A short addition to `core/AGENTS.md` (System Layer, read automatically
every session) naming the checklist: moving or renaming any script requires
*two* sweeps, not one — the internal import/require graph (what Task 1
already did correctly) **and** external shell-invocation references across
`.md`/`.yml` files (what it missed). Points at the `test-all.mjs` check as
the mechanical backstop, but states the checklist explicitly so a future
plan gets it right the first time rather than relying on the backstop to
catch it after the fact.

## Testing

- The regression check itself is the primary test artifact — see Component
  above for its full logic and acceptance criteria (zero violations).
- `core/update-system.mjs`'s fix needs a targeted verification that the
  re-exec path's file-graph resolution actually works end-to-end post-fix
  (exact test approach — extending `upgrade-tests.mjs` vs. a smaller
  focused test — is a plan-level decision, not fixed here).
- CI workflow fixes are verified by inspection (no CI runner available in
  this environment) plus confirming the corrected commands work when run
  locally from a repo-root cwd, matching what the workflow's default
  working directory actually is.
- Doc remediation is verified by re-running the regression check after each
  category of fix and confirming its violation count drops to zero.
