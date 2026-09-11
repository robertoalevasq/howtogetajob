# Remove the spend_tier concept — design

## Problem

`config/profile.yml`'s `spend_tier` (`economy`/`standard`/`premium`) lets a
career-ops workspace pick which model class evaluates offers. In practice:

- Every workspace observed running this system uses `economy` (or should).
  The tier choice adds a setup question, a config field, a resolution rule,
  a tier→model table per CLI, and a tier-gated pre-screen gate in
  `batch.md`/`pipeline.md` — all in service of a choice nobody exercises.
- The tiering only ever worked for **delegated subagents** (e.g.
  `apply.md` Step 7b's Playwright-fill subagent, correctly pinned to the
  resolved tier's model). **Main orchestrating sessions never resolved
  it at all** — `telegram-monitor.mjs`'s `dispatchOne` only pins a model
  for `onboarding` dispatches; `routing`/`cycle-resume` dispatches (i.e.
  every real `apply`/`cycle`/`pipeline` run driven over Telegram) fall
  through to the account default, observed as Sonnet 5. A user's own
  interactive `claude` session has no pin at all.

This is a deliberate architectural decision, not a bug fix: "we shouldn't
have tiers, let's remove that entirely. it is all economy." — collapse
every code path, config field, and piece of documentation that expresses a
tier choice down to "always the cheapest model," and close the main-session
gap so that collapse actually takes effect everywhere, not just in
subagents.

## Goals

1. Delete the `spend_tier` concept from every place it's read, written, or
   documented: config schema, `_shared.md`'s routing table, every mode
   file's tier-conditional prose, the onboarding question, `batch-runner.sh`,
   `test-all.mjs`, and `docs/RUNNING_ON_A_BUDGET.md`.
2. Make main orchestrating sessions actually run on Haiku for Claude Code —
   both Telegram-dispatched headless sessions and a user's own interactive
   session in a workspace directory — not just delegated subagents (which
   already did this correctly and need no change beyond losing the
   `spend_tier` lookup and hardcoding Haiku).
3. Delete the tier-gated pre-screen gate in `batch.md`/`pipeline.md` (it
   never ran under `economy`, so under an economy-only world it's dead code).
4. Leave every historical record (past design docs, past plans, the
   changelog, old on-disk fixture state) untouched — this is a forward-only
   removal, not a rewrite of history.

## Non-goals

- No migration step to strip `spend_tier` out of already-provisioned
  workspaces' real `config/profile.yml` files. An orphaned key nothing
  reads is harmless; no code will look at it again after this change.
- No change to delegated-subagent model pinning's *mechanism* (a `model:`
  param on the Task/Agent dispatch) — only to what value it's pinned to
  (hardcoded Haiku instead of a resolved tier).
- No change to non-Claude-Code CLI routing beyond deleting their now-empty
  table rows — those rows already said "your CLI's cheapest/fastest
  available model" for every tier, so the CLI-agnostic guidance collapses
  to a single sentence, not a rewrite of per-CLI setup instructions
  elsewhere in the docs (`RUNNING_ON_A_BUDGET.md` §3 stays as-is).
- No attempt to programmatically enforce Haiku on every possible invocation
  path (e.g. a user could still pass `--model sonnet` by hand, or a CLI
  other than Claude Code has no equivalent to `.claude/settings.json`).
  This removes the *configuration surface* and sets sane defaults; it does
  not add a runtime guard against a human overriding their own session.

## Architecture

No new files, no new abstractions. This is a deletion pass across the
existing surface area that today expresses `spend_tier`, plus two small,
additive fixes to close the main-session gap. Touched files, grouped by
role:

### 1. Shared routing doc — `modes/_shared.md`

Delete the "Spend Tier (Model Routing)" section (the resolution rule, the
tier→model table, and the "refer to tiers only as..." convention rule).
Replace with a short "Model Routing" note: every CLI always uses its
cheapest/fastest available model (Haiku 4.5 for Claude Code); no
configuration; extended thinking off. This keeps `_shared.md`'s role as
the one place other mode files point to for "which model" — it just now
says one thing instead of three.

### 2. Config schema — `config/profile.example.yml`

Delete the `spend_tier` key and its three-option comment block. Real
workspace `config/profile.yml` files are untouched (see Non-goals).

### 3. Mode files with tier-conditional prose

- `modes/apply.md` — Step 7/7b's subagent-pinning language changes from
  "pin to the resolved spend_tier model" to a direct reference to
  `_shared.md`'s new note (effectively: pin to Haiku).
- `modes/cycle.md` — delete the "resolve spend_tier once" step in Step 2;
  nothing left to resolve.
- `modes/pipeline.md` — delete the tier-gated pre-screen gate section
  (Goal 3) and the "regardless of spend_tier" qualifier on the unrelated
  metadata pre-filter (the qualifier becomes meaningless once there's only
  one tier).
- `modes/batch.md` — delete the tier-gated pre-screen gate section, same
  reasoning as pipeline.md.
- `modes/telegram-onboarding.md` — delete Step 4c's spend_tier-setting
  instruction. New workspaces are never asked.

### 4. Onboarding script — `core/AGENTS.md`

Delete the three-option economy/standard/premium question from Step 2
("Profile") of the onboarding checklist, and the "(including `spend_tier`,
default `standard`)" instruction that follows it.

### 5. Main-session model enforcement

This is the part that's new behavior, not just deletion — it's the fix for
the gap the user originally flagged ("we need all of apply and everything
else to use haiku instead of sonnet").

- **`core/telegram-monitor.mjs`**: in `dispatchOne`, the `model` variable
  is currently:
  ```js
  const model = dispatch.kind === 'onboarding' ? ONBOARDING_MODEL : undefined;
  ```
  Change so every dispatch kind resolves to Haiku — there is no longer a
  reason for `routing`/`cycle-resume` dispatches to fall through to the
  account default. (`ONBOARDING_MODEL` already equals `'haiku'`; this
  removes the conditional entirely, or folds it into one unconditional
  constant reused for every kind — implementation plan decides the exact
  shape.) The comment above this line, which currently says a routing
  dispatch "is unlimited and uses the account default," gets corrected to
  reflect that it now always uses Haiku too.
- **`.claude/settings.json`** (root, and every provisioned workspace via
  `provision-workspace.mjs`'s `SYSTEM_FILE_COPIES`): add a top-level
  `"model": "haiku"` key. This is Claude Code's documented project-level
  default-model setting — an explicit `--model` flag, `/model` command, or
  `ANTHROPIC_MODEL` env var still overrides it (precedence: CLI flag > env
  var > project settings.json > user settings.json), so nothing here
  fights a deliberate override; it just fixes what happens when nobody
  overrides anything, closing the gap for a user's own interactive
  `claude` session in a workspace directory.
- Because `.claude/settings.json` is a `SYSTEM_FILE_COPIES` entry,
  `core/AGENTS.md`'s existing rule applies: `node core/backfill-templates.mjs
  --all --apply` must run once after this change ships, so every
  already-provisioned workspace picks up the new default without waiting
  for its next `doctor.mjs` run to notice drift.

### 6. Batch runner — `batch/batch-runner.sh`

Collapse `read_spend_tier()` (awk-parses `config/profile.yml`),
`spend_tier_to_model()` (tier→model lookup), and the tier-branching inside
`resolve_worker_model()` into one fact: the default worker model is always
`claude-haiku-4-5` unless `--model` overrides it on the command line. No
`config/profile.yml` parsing left in this script. Update the usage banner,
`--model` help text, and the `Model: ... (spend_tier=...)` run-summary line
to match (the summary line simply drops the now-nonexistent
`spend_tier=` clause).

### 7. Batch prompt — `batch/batch-prompt.md`

The mandatory pre-screen-before-evaluation rule at line ~101 is *not* the
tier-gated gate from Section 3/6 above — it already runs "regardless of
spend_tier" today, i.e. unconditionally. That rule itself is unaffected;
only the now-meaningless "regardless of spend_tier" qualifier is deleted
from its wording.

### 8. Tests — `core/test-all.mjs`, `tests/helpers.mjs`

Delete the "14. Batch spend_tier model routing" section's five
tier-branching assertions and the `makeTierFixture` helper (economy→haiku,
premium→opus, missing-key→standard, invalid-value→standard fallback — none
of these branches exist anymore). Replace with two assertions against the
collapsed `resolve_worker_model()` from Section 6: no `--model` flag →
resolves to `claude-haiku-4-5`; `--model` flag present → that value wins
over the hardcoded default. Update the stray comment in `tests/helpers.mjs`
that references "all five spend_tier tests" to match the new count.

### 9. Budget doc — `docs/RUNNING_ON_A_BUDGET.md`

Rewrite Section 2 ("Pick Your Spend Tier") — currently the tier table plus
a `spend_tier: standard` YAML example — into a short paragraph: Claude Code
always runs the cheapest available model (Haiku 4.5); there's no tier to
configure. Adjust the one sentence in Section 2b that credits
"`spend_tier: economy` and the pre-screen gate above" for making high-volume
days cheaper — the pre-screen gate is gone (Section 3/6) and economy is no
longer a choice, so this becomes "career-ops already defaults to the
cheapest model for exactly this reason." The rest of the document
(non-Claude-Code CLI routing, local-model tradeoffs, the worked cost
example, zero-cost paths) is unrelated to `spend_tier` and stays as-is.

### 10. Explicitly out of scope (untouched)

- `docs/superpowers/specs/*` and `docs/superpowers/plans/*` — historical
  design/planning documents. They record what was true when written
  (including designs that explicitly reference `spend_tier`, like the
  Playwright-delegation-guard design and several onboarding-flow plans).
  Rewriting them would falsify the record; they are not live documentation.
- `CHANGELOG.md` — same reasoning; the original `spend_tier` feature
  changelog entry stays.
- `test-fixtures/upgrade/state-v1.16/config/profile.yml` and
  `state-v1.18/config/profile.yml` — these simulate real pre-upgrade
  on-disk state that legitimately had `spend_tier: standard` written by an
  older version of the software. An orphaned key in old fixture data is
  the harmless-leftover case this design already accepts (see Non-goals);
  no fixture change is needed.
- `core/classify-tier.mjs` — an unrelated job-title seniority classifier
  (intern/entry/mid/senior); shares no code or vocabulary with
  `spend_tier` beyond the word "tier."
- Incidental English/market usage of "standard" or "premium" found during
  the blast-radius scan (e.g. `modes/de/_shared.md`, `modes/tr/README.md`,
  `web/src/components/mobile-nav.tsx`) — not tier names, not touched.

## Testing

- `core/test-all.mjs` full suite must pass after the change, with the two
  replacement assertions from Section 8 covering `batch-runner.sh`'s
  collapsed model resolution (default → Haiku, `--model` override wins).
- Manual/inspection check (no new test infra needed — this is prose and
  config, not new logic): grep the repo post-change for `spend_tier` and
  confirm the only remaining hits are the explicitly-out-of-scope
  historical docs and fixtures listed in Section 10.
- `dispatchOne`'s existing test coverage (from the cycle-checkpoint-resume
  work) already asserts on the `model` argument passed to `invoke()` for
  various dispatch kinds — extend those assertions to confirm every kind
  now resolves to Haiku, not just `onboarding`.

## Risks

- **`.claude/settings.json`'s `"model": "haiku"` is a real behavior change
  for interactive sessions**, not just headless ones — a user running
  `claude` by hand in a workspace they previously ran on Sonnet will now
  get Haiku by default. This is the explicit intent ("it is all economy"),
  and an explicit `--model`/`/model` override still works per the
  documented precedence order, so this is accepted as intended, not a risk
  to mitigate further.
- **`backfill-templates.mjs --all --apply` must actually be run** after
  this ships, or already-provisioned workspaces silently keep their old
  `.claude/settings.json` without the new `model` key (main sessions there
  stay on the account default until the next manual backfill or
  `doctor.mjs`-triggered fix). This is an existing, documented process
  (`core/AGENTS.md`'s `SYSTEM_FILE_COPIES` rule) — the implementation plan
  must include running it as an explicit step, not just editing the
  template.
- **Deleting the pre-screen gate removes a real (if currently unused)
  cost-control feature.** Under the old tiering, `standard`/`premium`
  users got a cheap pre-screen pass before full evaluation; under
  economy-only, nobody gets it. Accepted per your answer to the
  clarifying question (delete, not make unconditional) — flagged here so
  it's an explicit, recorded trade-off rather than a silent loss.
