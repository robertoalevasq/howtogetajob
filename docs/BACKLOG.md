# Nice-to-Haves Backlog

Running list of small, non-blocking ideas and deferred findings surfaced during work on career-ops — things worth evaluating for a future session, not urgent enough to act on immediately. Not a replacement for `docs/superpowers/specs/`/`docs/superpowers/plans/` (those are for real design work); this is a lightweight capture point so ideas don't get lost between sessions.

Each entry: what it is, where it came from, and why it wasn't done now.

## Open

- **Extend `PreToolUse` deny-message test coverage to assert the full JSON shape via the CLI subprocess path, not just `permissionDecision`.** From: Task 1 review of `core/hooks/guard-playwright-delegation.mjs` (2026-09-08 apply-playwright-delegation-guard plan). Why deferred: substance is already covered since the subprocess path calls the same `decide()` function whose own tests check the full shape — this would be belt-and-suspenders, not a real gap.
- **Reword `decide()`'s JSDoc comment in `core/hooks/guard-playwright-delegation.mjs`** — currently slightly redundant about how a null/undefined payload is handled. From: Task 1 review, same plan. Why deferred: purely cosmetic, no functional impact.
- **Generalize `backfill-templates.mjs`'s JSON sync beyond `.claude/settings.json`** if a second `SYSTEM_FILE_COPIES`-class file ever appears. From: 2026-09-08 apply-playwright-delegation-guard design spec's own Risks section. Why deferred: `SYSTEM_FILE_COPIES` is currently a one-entry list; building generality for a second case that doesn't exist yet would be speculative.
- **Investigate whether Claude Code subagents can get their own tool-permission pre-approval independent of the main session** (the "Option 2" approach considered and rejected during the Playwright delegation guard brainstorm — restricting the main session's own tool access via a custom subagent-type allowlist). From: 2026-09-08 apply-playwright-delegation-guard design spec's Non-goals. Why deferred: unconfirmed mechanism, real risk of breaking headless Playwright across every workspace if the assumption is wrong; the `PreToolUse` hook approach shipped instead achieves the same outcome without that risk.
- **Have `applyJsonFile` delegate to `checkJsonFile` for its missing-computation/error-handling instead of duplicating the read/parse/try-catch block.** From: Task 2 review of `core/backfill-templates.mjs` (2026-09-08 apply-playwright-delegation-guard plan). Why deferred: harmless duplication, not a correctness issue; `applyFile`'s existing YAML equivalent does delegate to `checkFile`, so this would just bring the JSON path in line with that established pattern.
- **Distinguish a template-side parse error from a live-side parse error in `checkJsonFile`/`applyJsonFile`'s reported message** (currently one combined try/catch, vs. the YAML path's separate `liveDoc.errors`/`templateDoc.errors`). From: Task 2 review, same plan. Why deferred: not incorrect, just less precise diagnostics on a rare failure path.

## Done / promoted

(Move an item here with the date and what happened to it, once it's picked up — keep it, don't delete, so the history of what was considered stays visible.)
