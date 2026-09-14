# Telegram routing fixes + real-dispatch emulation harness

## Context

Over 2026-09-11 through 2026-09-13, three separate, confirmed-live bugs hit
the same real candidate (Thomas Acosta) in Telegram routing:

1. **Multi-message batching** — several queued messages for one chat got
   bundled into a single `claude -p` turn, which had no mechanical guarantee
   it re-read `data/telegram-state.md` between messages. Fixed 2026-09-12
   (`createRoutingQueue()` now drains one message per dispatch, never
   batched — see `core/telegram-monitor.mjs`).
2. **Undocumented digit-disambiguation mapping** — a numbered disambiguation
   ("1 for X, 2 for Y") was sent, but nothing recorded how a later "1"/"2"
   reply mapped back to a specific pending item, so it reliably fell through
   to the generic `/help` nudge. Fixed 2026-09-12
   (`resolveDisambiguationHint()` deterministically resolves a bare-digit
   reply from `## Pending Confirmations` file order and injects the
   resolution into the routing prompt).
3. **`/run` subagent-delegation confusion** — confirmed live 2026-09-13 via
   the dispatch's own session transcript: the model tried to delegate
   `cycle.md`'s Steps 0-5 to an `Agent` tool call (violating `_custom.md`'s
   "No-subagent inline processing" rule and `cycle.md` Step 1's explicit
   "do not delegate to an Agent(...) subagent" instruction), caught itself
   mid-turn, retried with a "foreground agent" (still a delegation), then
   re-checked the cycle lock and found **its own** just-acquired lock,
   concluded a different run was already active, and abandoned the cycle —
   leaving the lock held, stale, and nothing ever scanned. Not yet fixed;
   this spec covers it.

Two mechanical fixes (1 and 2) already landed with passing tests. This spec
covers the third (a documentation-strength fix, not mechanical — see
Decision below) plus a way to catch this whole class of bug going forward
without waiting for a real candidate to hit it: a harness that drives the
**real** routing dispatch (real `claude -p`, real prompt, real tool access)
against synthetic Telegram input in a disposable workspace.

## Decision: fix 3 stays a documentation fix, not a mechanical guard

The obvious mechanical parallel is `core/hooks/guard-playwright-delegation.mjs`
— a `PreToolUse` hook that already blocks direct (non-subagent) Playwright
mutation calls. The equivalent here would block the `Agent`/`Task` tool
during a headless cycle dispatch. **This doesn't work**, because Agent/Task
delegation is *legitimate* elsewhere in the same headless flow:
`modes/apply.md` Step 7b correctly delegates Playwright form-filling to a
subagent during the exact same kind of headless Telegram dispatch. A blanket
"no Agent tool in headless mode" hook would break that.

A hook that tries to distinguish "delegating cycle orchestration" (forbidden)
from "delegating a Playwright fill" (required) would have to pattern-match
the Agent call's own prompt text — fuzzy, easy to defeat by phrasing, and a
worse mechanical guarantee than it looks. Given that, this fix stays prose —
but strengthened and repositioned, matching how the Playwright guard's
*design doc* itself was written before the mechanical hook existed: name the
failure explicitly, move it to the top of the file, state it as a correction
of a specific confirmed incident.

### Changes

- `modes/cycle.md`: add a short, impossible-to-miss warning as the first
  paragraph after the title, before Step 0 — stating plainly that every step
  runs inline in the orchestrating turn, Agent/Task delegation for
  scan/pipeline/cycle work is never correct, and naming the 2026-09-13
  incident (self-conflicting cycle-lock, abandoned run, nothing scanned) as
  what happens when this is violated.
- `modes/telegram.md` Step 3a: add one sentence at the very top of the step,
  before item 0, cross-referencing the same warning — Step 3a is the actual
  entry point a headless dispatch reads first, so the warning needs to be
  visible from there too, not only from deep inside `cycle.md`.

This is *not* expected to be bulletproof — prose reminders have a known
failure history in this codebase. It's the right-sized fix given no clean
mechanical alternative exists, and the emulation harness below exists partly
to catch it if it recurs.

## Emulation harness (v1)

### Goal

Exercise the real routing/dispatch path — real prompt construction, a real
`claude -p` call, real tool access — against synthetic Telegram input, in a
disposable workspace, so a regression on any of the three bugs above is
caught by running a script, not by a real candidate hitting it live.

### Scope (v1)

Exactly the three scenarios above. Each real `claude -p` call costs real
tokens and wall-clock time; this is deliberately not a general-purpose
routing-table test suite (see Alternatives Considered).

1. **Digit disambiguation** — seed 2 pending confirmations, send `"1"`,
   assert it resolves to the *first* one (not a Step 5 nudge).
2. **Rapid-fire burst** — enqueue 3 messages for one chat before the first
   dispatch settles, assert 3 separate dispatches ran (never one batched
   call carrying all 3 messages).
3. **`/run` delegation** — clean cycle-lock, send `/run`, assert the
   dispatch's own session transcript never contains an `Agent`/`Task`
   tool-use, and that the cycle-lock is not left held-and-stale afterward.

### Components

- **`core/telegram-emulate.mjs`** (new) — the harness script.
  - `makeDisposableWorkspace()`: copies the minimum real-workspace shape
    (`cv.md`, `config/profile.yml`, `portals.yml`, empty `data/applications.md`
    / `data/pipeline.md`) into a fresh temp directory per run. `telegram`
    stays disabled in `config/plugins.yml` — the harness never needs a real
    bot token and never risks a real send; assertions read state files and
    session transcripts, never delivery confirmations.
  - `seedPendingConfirmations(ws, blocks)`: writes a `## Pending
    Confirmations` section with the given blocks, matching the real file
    format `resolveDisambiguationHint()` already parses.
  - `runScenario(name, dispatch)`: calls the **real, unmodified**
    `dispatchOne(dispatch)` (default `invoke` — genuinely spawns `claude -p`),
    records the wall-clock window, then locates that dispatch's own session
    transcript by finding the newest `.jsonl` file under
    `~/.claude/projects/<disposable ws path, with `/`/`\` and `.` replaced by `-`, matching the naming already observed under `~/.claude/projects/` for every real workspace today>/` created after the
    call started (the same technique used by hand to diagnose today's three
    bugs — no new CLI flag or SDK dependency needed).
  - `assertNoAgentToolUse(transcriptPath)` / `assertResolvedTo(state, msgId)`
    / `assertDispatchCount(n)`: small, focused assertion helpers reading the
    transcript JSONL and the resulting `telegram-state.md`.
  - `main()`: runs the 3 scenarios in sequence (never parallel — they'd
    contend for the same Telegram-adjacent global state patterns this whole
    system already avoids parallelizing), prints a pass/fail summary, exits
    non-zero on any failure.
- **No changes to `dispatchOne`, `createRoutingQueue`, or
  `resolveDisambiguationHint`** — the harness is a consumer of the existing,
  already-tested production code path, not a reimplementation of it.

### Data flow

```
telegram-emulate.mjs
  → makeDisposableWorkspace()          (temp dir, minimal real shape)
  → seedPendingConfirmations(ws, ...)  (writes data/telegram-state.md)
  → dispatchOne({ cwd: ws, kind: 'routing', messages: [...] })
        → buildRoutingPrompt(dispatch)     (real prompt, incl. any
                                             deterministic hint)
        → invokeClaudeRoutingOnce(...)     (real claude -p spawn)
              → writes its own session transcript to
                ~/.claude/projects/<disposable-ws-path-slug>/<session-id>.jsonl
  → find newest transcript in that project dir
  → assert against transcript + resulting data/telegram-state.md
```

### Error handling

- A scenario's `claude -p` call failing to spawn or timing out is a **test
  failure**, reported with the captured stderr tail — not silently retried
  (the harness is diagnostic; retrying would hide exactly the kind of
  flakiness worth seeing).
- Disposable workspaces are left on disk on failure (path printed in the
  failure output) for manual inspection, and cleaned up automatically on
  success — matching this project's existing "leave evidence on failure,
  clean up on success" convention (e.g. `apply-browser-holder.mjs`'s session
  cleanup).
- No workspace under `workspaces/` is ever touched — everything runs in a
  fresh temp directory, so a harness bug cannot corrupt real candidate data.

### Testing (of the harness itself)

The harness's own deterministic pieces (`makeDisposableWorkspace`,
`seedPendingConfirmations`, the assertion helpers) get normal unit tests with
a fake `dispatchOne`/fake transcript file, the same way `createRoutingQueue`
was tested — no real `claude -p` call needed to verify the harness's own
plumbing. Only running `main()` end-to-end costs real dispatches, and that's
a manual/CI-opt-in run, not part of `test-all.mjs`'s normal fast suite.

### Alternatives considered

- **Full routing-table coverage** (every command × every pending-stage
  combination) — rejected for v1 per explicit scope decision: real cost per
  scenario, and today's three bugs are the only ones with confirmed live
  evidence. Nothing prevents adding scenarios later the same way.
- **Fake-`invoke()` harness** (like the existing unit tests) — rejected as
  the *only* mechanism, because it cannot catch model-behavior bugs (the
  `/run` delegation bug is entirely a model decision, invisible to any test
  that never calls the real model). Still valuable and already exists as
  `tests/telegram-monitor.test.mjs` — this harness is additive, not a
  replacement.
