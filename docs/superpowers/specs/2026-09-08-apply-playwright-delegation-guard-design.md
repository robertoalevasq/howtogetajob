# Apply-Mode Playwright Delegation Guard — Design

## Problem

`modes/apply.md` Step 7b already instructs Claude to delegate all mechanical Playwright form-filling (`browser_click`/`browser_type`/`browser_fill_form`/etc.) to a subagent pinned to the workspace's resolved `spend_tier` model, rather than driving the browser directly from the main session. A live failure on 2026-09-07/08 (already documented inline in Step 7b) found this being silently skipped — every observed turn filled forms directly in the main flow — and a stronger warning paragraph was added to the step as a result.

That prose reinforcement did not hold. `core/token-efficiency-log.mjs`'s durable per-session log shows Thomas Acosta's four most expensive sessions (2026-09-02 through 2026-09-08, 13M–53M tokens each, ~120M tokens combined) all carry `subagent_delegated: false` alongside 20–80 raw `browser_click`/`browser_type`/`browser_snapshot`/`browser_press_key` calls in the main flow, and `cache_read_tokens` accounting for 99%+ of total tokens in the worst of them — the classic signature of full-page accessibility-tree snapshots accumulating in a session that never resets its context via a disposable subagent. All four sessions carry the `[HEADLESS]` marker (confirmed via transcript grep), meaning they are `claude -p` dispatches from `telegram-monitor.mjs`, not interactive sessions someone was watching.

Investigation ruled out the initially-suspected cause (routing to a wrong/expensive model): `spend_tier: economy` is correctly set for Thomas, and no local-model/Ollama path is involved in `apply` at all (`ollama-delegate.mjs` is scoped to three unrelated evaluation sub-tasks). The actual defect is behavioral: the main session keeps doing the mechanical work itself instead of spawning the subagent Step 7b already specifies, and a second round of prose (the 2026-09-07/08 warning) did not change that. This design replaces the prose-only guard with a mechanical one.

**This is not Thomas-specific.** Re-running the report across every provisioned workspace shows the identical pattern everywhere apply/Playwright activity exists: `roberto-vasquez` has 7 sessions with `subagent_delegated: false` and `no_subagent_delegation` flagged (4M–8M tokens each); `roberto` has 7 such sessions up to 22M tokens, one with 145 raw click/type/fill/press calls in a single run; `leonie` shows the same snapshot-accumulation signature. Only `ernesto-vasquez` has no apply activity yet to show the pattern one way or the other. The fix is therefore designed to ship at the repo-root `.claude/settings.json` template (auto-propagated to every future workspace via `provision-workspace.mjs`) plus a one-time backfill into all currently-provisioned workspaces — not a Thomas-only patch.

## Goals

- Make it structurally impossible for the main Claude Code session to execute a mutating Playwright interaction (`browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_select_option`, `browser_drag`, `browser_drop`, `browser_file_upload`) without going through a subagent — not just discouraged, blocked.
- Zero blast radius outside career-ops: no changes to the user's global `~/.claude/settings.json`, no effect on other projects on the machine.
- Zero behavior change for the tool calls that are legitimately fine directly in the main flow: `browser_navigate`, `browser_snapshot`, `browser_wait_for`, `browser_close`, `browser_find`, `browser_evaluate`, `browser_tabs` (used by AGENTS.md's Offer Verification step and Step 7b's own scoped-snapshot guidance).
- Propagate to every current and future workspace with minimal, well-precedented maintenance (this repo already has an established pattern for "a permissions change must be re-applied to every provisioned workspace").
- Fail loud, not silent: when the guard fires, the block reason handed back to Claude should be specific enough that the very next action is a correct delegation, not a retry loop.
- **Make future `.claude/settings.json` drift mechanically detectable, not dependent on anyone remembering to check.** This ships alongside the hook itself, not as a separate follow-up — see "Component: SYSTEM_FILE_COPIES drift guard" below.

## Non-goals

- Not touching the global `~/.claude/settings.json` allow-list, and not restricting the main session's tool set via a custom subagent-type `tools:`/`disallowedTools:` allowlist (the "Option 2" approach from brainstorming) — that requires confirming subagents can get permission pre-approval independent of the top-level session, which is unconfirmed and carries real risk of breaking headless Playwright entirely across every workspace if wrong. Worth a follow-up investigation later, not part of this change.
- Not building a circuit-breaker/post-hoc token-budget kill switch (the "Option 3" approach) — superseded by the fact that a hard `PreToolUse` block is achievable directly.
- Not touching `generate-pdf.mjs` or `scan-interamt.mjs` — both drive Playwright as a plain Node library call, never through Claude's MCP tool-call loop, so this guard cannot and should not apply to them.
- Not changing `modes/apply.md` Step 7b's existing prose — it stays as the primary instruction for *how* to delegate (batching, snapshot scoping, quirk handling); this hook is a backstop for *whether* delegation happens at all, not a replacement for that guidance.
- Not scoping the guard to "only during apply mode" — it applies to the tool names themselves, everywhere, since no other mode in this codebase currently drives these specific mutating Playwright tools directly from the main flow (confirmed: `pipeline`/`oferta`/`scan`/`pdf`/`latex` don't touch them).

## Investigation summary (facts that shaped this design)

- **The permission model was not the actual gate.** career-ops' own `.claude/settings.json` (root and every per-workspace copy) only allow-lists the read-only Playwright tools. The mutating ones execute anyway because the user's global `~/.claude/settings.json` allow-lists every `mcp__playwright__*` tool unconditionally, across all projects — confirmed by reading that file directly. Any fix that relied on the permission system's allow/deny state would have been moot without touching that global file.
- **`PreToolUse` hooks run before the permission system, not after.** Verified against the primary Claude Code docs (`code.claude.com/docs/en/hooks`, fetched directly after two independent research passes gave contradictory answers on this exact point — one of them was a confabulation). A hook that exits 2 (or returns `hookSpecificOutput.permissionDecision: "deny"` in JSON on stdout) blocks the tool call outright, regardless of what any settings.json allow rule says. This is what makes a project-scoped hard block possible without touching the global config.
- **The hook JSON includes an `agent_id` field that is only present when the call originates inside a subagent** spawned via Task/Agent — absent for the main session. This is the exact signal needed to distinguish "main flow doing it directly" (block) from "delegated subagent doing it" (allow).
- **Matchers support exact tool-name lists or regex** (`"mcp__playwright__browser_click|mcp__playwright__browser_type|..."` or a regex alternation) scoped precisely to the tool set this design targets, leaving `browser_navigate`/`browser_snapshot`/etc. untouched.
- **Each workspace has its own `.claude/settings.json`**, copied from the repo root's by `core/provision-workspace.mjs` at provisioning time — not inherited from the repo root at runtime. That file's own comments already document why: `claude -p` spawned with `cwd` set to a workspace directory resolves permissions relative to that cwd, never finding the repo root's settings. This is also why a permissions/hooks change must be manually re-applied to already-provisioned workspaces; `provision-workspace.mjs`'s own comment flags this as expected, precedented maintenance, not new complexity.
- **This drift class has no existing detection, and that's a confirmed gap, not a hypothetical one.** `.claude/settings.json` is provisioned via `SYSTEM_FILE_COPIES` — a separate, smaller list in `provision-workspace.mjs` than `SEEDED_FILES` (which covers `config/profile.yml`, `portals.yml`, etc.). `SEEDED_FILES` targets get ongoing additive-sync coverage via `backfill-templates.mjs` + `doctor-all.mjs`'s per-workspace health check, because they're expected to legitimately diverge (user personalization) while still needing new upstream fields synced in. `SYSTEM_FILE_COPIES` gets none of that — `backfill-templates.mjs` has zero awareness of `.claude/settings.json` (confirmed by grep). It's pure system/plumbing content, not personalization, yet nothing has ever watched it for drift. Separately, neither `doctor-all.mjs` nor `backfill-templates.mjs` is wired into `test-all.mjs` at all today, unlike `validate-script-references.mjs`, which runs automatically inside `test-all.mjs` (and therefore in CI on every PR, since a moved script's stale references are detectable from tracked repo content alone) specifically so that class of past mistake can never silently ship again. `.claude/settings.json` drift can't reach that same bar — see the correction in "Component: SYSTEM_FILE_COPIES drift guard" below: the data needed to detect it (workspace files) is gitignored and structurally absent from any CI checkout, so this design's guard is the strongest mechanical bar actually available for this specific drift class — a local-run guard, not a CI one — rather than "someone remembers to run a report."

## Architecture

```
Main Claude Code session (apply mode, Step 7b)
  │
  ├─ attempts mcp__playwright__browser_click directly
  │     │
  │     ▼
  │  PreToolUse hook fires (matcher: mutating Playwright tools only)
  │     │
  │     ├─ core/hooks/guard-playwright-delegation.mjs reads hook JSON from stdin
  │     ├─ agent_id present?
  │     │     ├─ NO  → exit 2, JSON { permissionDecision: "deny", permissionDecisionReason: "..." }
  │     │     │         → Claude Code blocks the call, shows Claude the reason
  │     │     │         → Claude has no direct path left; spawns the Step 7b subagent instead
  │     │     └─ YES → exit 0 (no JSON) → normal permission flow applies, call proceeds
  │
  └─ delegated subagent (spawned per Step 7b) attempts the same tool
        │
        ▼
     PreToolUse hook fires again, sees agent_id present → allows
```

Both the main-session (denied) and subagent (allowed) paths hit the exact same hook and matcher — the only branch is `agent_id`. There is no mode-awareness in the hook itself; it doesn't know it's "apply mode," only that a mutating Playwright tool was called without an `agent_id`.

## Component design

**New file: `core/hooks/guard-playwright-delegation.mjs`**

- A standalone `.mjs` script, following this repo's existing `core/*.mjs` CLI-script conventions (no framework, plain Node, testable via stdin/stdout like `preflight-check.mjs` or `jd-skill-gap.mjs`).
- Reads the hook's JSON payload from stdin (`tool_name`, `agent_id`, and whatever else Claude Code's `PreToolUse` payload carries — the rest is unused).
- If `agent_id` is absent/null: writes `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<specific message>"}}` to stdout and exits 2.
  - The reason string names the exact fix: *"Direct Playwright interaction from the main session is blocked. Delegate this to a subagent per modes/apply.md Step 7b — spawn Agent with the field-fill task instead of calling browser tools directly."*
- If `agent_id` is present: exits 0 with no output (falls through to normal permission handling, which already allows it since the subagent's own tool access is unaffected by this change).
- No dependency on any workspace-specific file (`config/profile.yml`, `data/*`) — the check is purely structural, so the same script works unmodified across every workspace via the `core` junction, same as every other shared script in this repo.

**Registration: `.claude/settings.json` (repo root + every workspace)**

```json
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
```

Added to the repo root's `.claude/settings.json` (so `provision-workspace.mjs` picks it up automatically for every future workspace) and backfilled by hand into the four existing workspaces' own copies (`ernesto-vasquez`, `leonie`, `roberto-vasquez`, `thomas-acosta`) — the same one-time sweep already implied as necessary maintenance by that file's existing comments.

**Documentation**

- `core/AGENTS.md` Main Files table: one new row for `hooks/guard-playwright-delegation.mjs`.
- `modes/apply.md` Step 7b: a short addition noting the hook now exists as a hard backstop, so the existing prose reads as "how to delegate correctly" rather than "please remember to delegate" — the reader should understand the direct path is no longer just discouraged, it no longer works.

## Component: SYSTEM_FILE_COPIES drift guard

This ships in the same change, not as a follow-up.

**Correction made during implementation (2026-09-08, Task 3):** this section originally claimed the new `test-all.mjs` check "fails CI automatically" the way `validate-script-references.mjs` does. That claim is **false** and was caught by the Task 3 implementer before it shipped. `workspaces/*` is entirely gitignored (`.gitignore:167`, confirmed via `git check-ignore` and `git ls-files workspaces/` returning only `workspaces/.gitkeep`) — every workspace's `.claude/settings.json` is per-machine, per-tenant local state that never reaches a git checkout at all, by design (it's real candidate personal data alongside the settings). GitHub Actions CI checks out a fresh clone with **zero** workspaces every time, unconditionally — not "usually," always. A guard that hard-fails on finding zero workspaces would therefore fail every PR's CI run forever, permanently red. The design below is corrected accordingly: the guard is a **local safety net**, not a GitHub-Actions-enforced gate — it fires whenever `test-all.mjs` runs somewhere with real workspace data present (a maintainer's or an AI session's local machine, per the existing "run the full suite before pushing" convention this repo already expects), and skips cleanly (not silently — an explicit, visible skip message) when none exist, which is the normal and expected state in CI.

1. **Extend `backfill-templates.mjs` to track `.claude/settings.json`** as a new sync target alongside its existing `config/profile.yml`/`portals.yml` coverage. Unlike those two (YAML, comment-preserving), this is a JSON structural diff: for each key/array-item present in the repo root's `.claude/settings.json` but absent from a workspace's copy, add it additively. Never remove a workspace-local addition that isn't in the root template — same non-destructive principle already governing the YAML side. `--check` reports drift without writing; `--apply` fixes it, exactly mirroring the existing profile/portals flow. (Implemented as designed — this part of the correction above doesn't affect it.)
2. **Add a new automatic check to `core/test-all.mjs`**, styled on the existing `SYSTEM_PATHS coverage guard` / `validate-script-references.mjs` checks' probe-then-real-check shape. Call it the **SYSTEM_FILE_COPIES drift guard**: it runs the new `checkJsonFile`/`JSON_TEMPLATE_PAIRS` across every workspace `listWorkspaces(ROOT)` finds and **fails the suite** if any workspace's `.claude/settings.json` is missing something the root template has. When zero workspaces are found (the normal case in CI, and in any fresh clone or worktree), it **passes with an explicit skip note** rather than failing — see the correction above for why. This means the guard's actual enforcement moment is whenever someone (human or AI) runs `node core/test-all.mjs` locally on a machine with real provisioned workspaces, not a GitHub Actions run.
3. **Add a short rule to `core/AGENTS.md`'s "Stack and Conventions" section**, next to the existing "Moving or renaming any script requires TWO reference sweeps" rule (same section, same pattern): *any change to a `SYSTEM_FILE_COPIES`-listed file requires re-running `backfill-templates.mjs --apply` (or a full `doctor-all.mjs` pass) across every provisioned workspace before the change ships — backstopped by `test-all.mjs`'s SYSTEM_FILE_COPIES drift guard whenever the suite runs locally with real workspace data present (it cannot backstop this in GitHub Actions CI itself, since workspaces are gitignored and never reach a CI checkout) — but do it anyway; the check should never be the first line of defense, only the one that can't be forgotten.* `AGENTS.md` is read automatically every session (unlike a dated spec file under `docs/superpowers/specs/`), which is what makes this instruction actually reach a future session instead of depending on it rediscovering this document.

Together, (2) is the guarantee for anyone running the suite locally against real workspace data — which is already the established, expected pre-push workflow in this repo — and (3) is the same belt-and-suspenders convention this repo already applies to the structurally identical script-reference problem. Neither is a GitHub-Actions-enforced gate the way `validate-script-references.mjs` is, because the underlying data this guard checks structurally cannot exist in a CI checkout.

## Testing

- **Unit test** (`tests/guard-playwright-delegation.test.mjs`): feed the script JSON via stdin covering (a) a matched tool with no `agent_id` → assert exit 2 and correct JSON shape; (b) a matched tool with `agent_id` present → assert exit 0, no stdout; (c) malformed/empty stdin → assert it fails safe (does not silently allow-through in a way that masks a real bug, but also does not crash the whole tool-call pipeline — exact fail-safe direction to be decided during implementation, defaulting to "allow" so a hook bug can't brick apply mode entirely, with the gap caught instead by the existing `no_subagent_delegation` efficiency flag).
- **`backfill-templates.mjs` unit coverage**: extend its existing test file with cases for the new `.claude/settings.json` JSON-diff target — a workspace copy missing the new `hooks` block gets it added additively; a workspace with its own extra `permissions.allow` entry keeps it untouched; `--check` reports drift without writing.
- **SYSTEM_FILE_COPIES drift guard test in `test-all.mjs`**: a synthetic probe proving the guard actually fails when a workspace's `.claude/settings.json` is deliberately made to lag a root template it constructs in a temp dir (mirrors the existing `SYSTEM_PATHS coverage guard` probe pattern), followed by the real check against the actual repo tree — which passes with an explicit skip note when `listWorkspaces(ROOT)` finds zero workspaces (the normal case in CI and in a fresh worktree/clone — see the correction in "Component: SYSTEM_FILE_COPIES drift guard" above for why zero is not itself treated as a failure here, unlike the SYSTEM_PATHS guard's zero-tracked-files case).
- **Live confirmation**: after rollout, the next real Thomas Acosta apply session's row in `data/token-efficiency-log.tsv` should show `subagent_delegated: true` and the absence of `no_subagent_delegation` in `efficiency_flags` — the same telemetry that caught the original bug closes the loop on the fix.

## Risks / open questions

- **Hook script latency**: `PreToolUse` hooks run synchronously before every matched tool call. The script is trivial (parse JSON, branch, exit) so this should be negligible, but worth confirming there's no per-call overhead surprise once measured live.
- **Fail-safe direction on hook script errors**: if the hook script itself throws or Node fails to start, does Claude Code treat that as "allow" or "block"? This affects whether a bug in the guard script could either silently reopen the hole it's meant to close, or brick apply mode entirely. Needs a quick confirmation during implementation (the docs' "other exit codes" behavior — non-blocking, action proceeds — suggests a crash defaults to allow, which is the safer failure direction given Non-goals above already say correctness here isn't safety-critical, just a cost control).
- **JSON structural diff scope for `backfill-templates.mjs`**: settings.json's `hooks.PreToolUse` is an array of matcher objects, not a flat key set — the additive-diff logic needs to compare by matcher content (has this exact hook entry already been added?) rather than blindly appending, or a repeated `--apply` run would duplicate hook registrations. Worth getting right in implementation since it's a new code path, not reused from the YAML diff logic.
- **This closes the detection gap for `.claude/settings.json` specifically, not every possible drift class.** If a future change touches some other file provisioned once and never re-synced (a new `SYSTEM_FILE_COPIES` entry not yet imagined), it inherits the same guard automatically only if it's added to that same list and covered by the same drift-guard check — worth remembering `SYSTEM_FILE_COPIES` is meant to stay a short, deliberate list precisely because everything on it now carries this obligation.
