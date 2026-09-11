# Cycle-Mode Checkpointed Resume — Design

## Problem

`cycle` mode's Step 2 (pipeline evaluation) processes the entire pending backlog inline, sequentially, in one Claude Code session, by deliberate design (`modes/cycle.md`: *"No subagent fan-out — process inline, sequentially"*). This is correct for headless safety but has no upper bound: a large backlog means one session accumulates evaluation after evaluation in its own context, and because every later turn re-reads that entire accumulated context, cost compounds across the run.

Two real sessions from 2026-09-09 show the pattern: Ernesto's `cycle` run (42.0M raw tokens, 98.8% cache-read, 70.1 min) and Thomas's (40.1M raw tokens, 98.6% cache-read, 76.8 min). In real API list-price dollars this is cheap (~$10/session — cache-read is priced at ~10% of input). But this account runs on a **Claude Pro subscription with a rolling per-session token allowance, not metered billing** — and we have two *directly observed* incidents of that allowance running out mid-work: Ernesto's run above was cut off mid-scan by `"You've hit your session limit"`, and a separate Thomas Telegram dispatch that same day couldn't even start for the same reason. One giant session monopolizing the shared quota is the actual, demonstrated problem — not dollar cost.

`cycle.md` also states its inline-only design is partly justified by *"a headless/Telegram-triggered run has no permission path for an unreviewed Agent call"* — this appears stale: the same headless `claude -p` path (same `.claude/settings.json`, zero permission flags) ran Agent-tool subagent delegation dozens of times successfully in Thomas's `apply` flow this same week. The other stated justification — avoiding N-times context-reload cost from per-URL subagent delegation — is a real, unverified tradeoff. Whether Pro's session-limit meter discounts cache-read tokens the way API billing does is **undocumented** (confirmed via direct research; Anthropic support is the only authoritative source). Given that unknown, this design does not touch delegation at all — it caps how large any single session's accumulated context can get, which reduces quota pressure regardless of how cache-reads are weighted.

## Goals

- Bound the size any single `cycle` Step 2 session can grow to, so no run can single-handedly exhaust the account's rolling quota the way the two 2026-09-09 sessions did.
- Resume automatically, without a human re-sending `/run`, once a batch boundary is hit.
- Distinguish a clean, proactive stop (safe to resume immediately) from an actual quota exhaustion (must wait for the reported reset time — resuming immediately just repeats the failure).
- Reuse existing state and infrastructure — no new files, no new subsystem.

## Non-goals

- Not delegating Step 2's evaluation work to per-URL subagents (Option B from brainstorming) — its payoff is unverified and could plausibly make quota pressure worse, not better, if cache-reads are already cheap in Pro's quota accounting. Not pursued here.
- Not correcting `cycle.md`'s stale "no permission path for Agent calls" claim — irrelevant to this design (which doesn't delegate), and not worth touching prose unrelated to the change at hand.
- Not building settings-fingerprint compatibility checking (`scan-ats-full.mjs`'s `checkpointCompatible` pattern) for the continuation state. That guards a multi-hour background process where `portals.yml`/flags can plausibly change mid-run; Step 2's much shorter batches don't carry the same risk, and the existing staleness check (`computeLiveness`, below) already covers the actual failure mode — an abandoned run sitting unresumed.
- Not adding a time-based OR-condition to the batch boundary alongside URL count. URL count is the more direct proxy for how much context a batch adds; two knobs for one signal is unneeded.

## Investigation summary (facts that shaped this design)

- `data/pipeline.md`'s existing Pending/Processed split is already `cycle`'s source of truth for "what's left to evaluate" — `cycle.md`: *"Step 2 only ever sees what's still under 'Pending'... anything already moved to 'Processed'... is never re-evaluated."* No new state is needed to know what a continuation should pick up.
- `core/cycle-status.mjs` already persists real-time run state to `data/cache/cycle-status.json` at every checkpoint `cycle.md` already hits (`update(patch)`), including `step.id` (`STEP_IDS` includes `'2-pipeline'`) and `counters.pipelineUrlsPending`/`pipelineUrlsProcessed`. This is already exactly "is there an incomplete cycle run, and how much is left" — reading it needs no new file.
- `core/cycle-status.mjs` already exports `computeLiveness(state, now)`, classifying a run `no_run | running | stalled | done` from how stale its last update is (`STALL_AFTER_MS`). A `stalled` run with `pipelineUrlsPending > 0` is precisely "incomplete, abandoned or paused, safe to check." No new staleness logic is needed.
- `core/cycle-lock.mjs` already has a `status` CLI command telling whether a run currently holds the lock. No new lock-check code is needed.
- `core/telegram-monitor.mjs`'s daemon (`main()`'s `while (true)` loop) only ever dispatches a new session in response to an incoming Telegram message (`if (messages.length > 0)`) — there is no periodic "check for other pending work" tick today. This is the one genuinely new piece of behavior this design adds.
- The `"You've hit your session limit · resets 7:50pm (America/New_York)"` message format has been directly observed twice in this account's transcripts and is machine-parseable (a fixed prefix plus a `h:mmpm (Timezone)` clock time).

## Correction made during plan-writing (2026-09-10)

The Architecture/Component sections below originally had `cycle.md` Step 2 itself detect and write `lastStopReason: "session-limit"` when the account's usage limit fires. **That's not implementable as written:** the `"You've hit your session limit · resets Xpm"` message is injected by the CLI when a turn gets cut off — the model process is already terminated by the time it appears, so no further tool call (including a status-file write) can happen from inside that turn.

The actual mechanism, confirmed against this repo's own prior incident: `telegram-monitor.mjs` already has a documented 2026-08-30 case of exactly this ("a candidate's routing-failure notification said only 'claude -p routing exited 1' when the real cause... streamed right past on stdout/stderr with nothing capturing it"), which is why `spawnCapturingTail()` exists — `claude -p` exits **non-zero** on a session-limit cutoff, and the tail of its output (containing the limit message) is already captured into the rejected `Error`'s message that `dispatchOne`'s `catch` block receives today. Detection therefore belongs in that existing catch block, not in `cycle.md` prose — matching the pattern the codebase already had, not a new one.

Separately: rather than adding new exported functions to `cycle-lock.mjs`/`cycle-status.mjs` for cross-workspace reads (both modules resolve their state paths from a fixed `workspaceRoot()` call at import time, not parameterized per call), the daemon reuses their **existing CLI interfaces as subprocesses with `cwd` set to the target workspace** — identical to how this file already spawns `node core/plugins.mjs run telegram notify ...` with `{cwd: dispatch.cwd}` two lines away. Zero new exports in either file.

Also: a resume dispatch is **not** routed through `buildRoutingPrompt`/`modes/telegram.md`'s message classification — a synthetic continuation isn't a candidate's Telegram message, and forcing it through classification would require touching `modes/telegram.md` too (outside this design's 3-file scope). It gets its own small prompt builder and dispatch `kind`, mirroring how `onboarding` already gets its own builder and kind.

## Architecture

```
modes/cycle.md Step 2 (unchanged evaluation logic, one new exit condition)
  │
  ├─ processes URLs from data/pipeline.md, one at a time (unchanged)
  ├─ after each URL: batch counter += 1
  │
  └─ counter reaches 20 (BATCH_SIZE)?
        └─ cycle-status.mjs update: { lastStopReason: "batch-limit" }
           → cycle-lock.mjs release (so the daemon's lock check below sees "free")
           → write Step 4-style partial summary, exit cleanly

telegram-monitor.mjs — claude -p exits non-zero on a session-limit cutoff (existing,
documented 2026-08-30 behavior; spawnCapturingTail() already captures the tail)
  │
  └─ dispatchOne()'s existing catch block: does err.message match the
     "session limit ... resets Xpm (Tz)" pattern?
        └─ yes → spawn `node cycle-status.mjs update --file <patch>` with cwd: dispatch.cwd,
                 patch = { lastStopReason: "session-limit", resumeNotBefore: <parsed X, as ISO> }
                 (existing notifyRoutingFailure() call is untouched — this runs alongside it)

telegram-monitor.mjs daemon, existing poll loop — one new check per iteration
  │
  └─ for each [chatId, workspaceDir] in buildBoundChatMap():
        ├─ spawn `node cycle-lock.mjs status` (cwd: workspaceDir) → held? → skip this workspace
        ├─ spawn `node cycle-status.mjs --json` (cwd: workspaceDir) → parse
        │     └─ liveness.state !== "stalled" or counters.pipelineUrlsPending === 0 → skip
        ├─ lastStopReason === "session-limit" and now < resumeNotBefore → skip (check again next poll)
        └─ otherwise → dispatch a { kind: "cycle-resume", chatId, cwd: workspaceDir } through the
           existing routeDispatch/fanOutDispatches path — a NEW prompt builder
           (buildCycleResumePrompt), not buildRoutingPrompt/modes/telegram.md classification.
```

Both `cycle-lock.mjs` and `cycle-status.mjs` are used purely through their **existing CLI interfaces**, invoked as subprocesses with `cwd` set to the target workspace — the same pattern this file already uses for `node core/plugins.mjs run telegram notify ...`. Neither file gains new exports; `cycle-status.mjs` gains two new default fields in its state shape.

## Component design

**`modes/cycle.md` Step 2 — batch boundary**

- Add a per-invocation counter, reset at Step 2's start. After each URL evaluation, increment it; at 20 (matching the existing "pending count exceeds ~20 → throttle liveness" threshold already in this step, rather than inventing a new number): patch `cycle-status.json` with `lastStopReason: "batch-limit"` (via the existing `cycle-status.mjs update --file` call this step already makes at its checkpoints), release the cycle lock (`node cycle-lock.mjs release` — normally only done at end-of-run; a batch-limit stop is a controlled, safe-to-resume-immediately pause, not a failure, so it releases the same way), write the Step 4-style partial summary (identical shape to a full completion, just smaller in scope — no new summary format), and end the turn.
- `lastStopReason`/`resumeNotBefore` are cleared (`null`) at Step 0 preflight, same place `cycle-status.mjs reset` already runs for a fresh run — a genuinely new run should never inherit a stale continuation reason.
- Session-limit detection is **not** cycle.md's job — see the correction above.

**`core/cycle-status.mjs` — schema extension only**

- Add `lastStopReason: null` and `resumeNotBefore: null` to `emptyState()`'s returned object (the only place default field values are defined). No new exported functions — `update()`'s existing `{...state, ...patch}` merge already handles these two new patch keys for free, and `reset()` already clears them by constructing a fresh `emptyState()`.

**`core/telegram-monitor.mjs` — three additions**

1. **Session-limit detection in `dispatchOne`'s existing `catch` block.** After the existing `console.error`/`notifyRoutingFailure` calls (untouched), check `err.message` against a `parseSessionLimitReset(text, now)` helper. If it matches, write a workspace-scoped status patch by spawning `node cycle-status.mjs update --file <tmp-patch.json>` with `cwd: dispatch.cwd` (a temp JSON file is required because that's the CLI's only input shape — no stdin variant exists). `parseSessionLimitReset` is a pure function: regex-matches `resets (\d{1,2}):(\d{2})(am|pm) \(([^)]+)\)`, converts that wall-clock time in the named IANA zone to the next UTC instant at/after `now` (using `Intl.DateTimeFormat` offset correction — no new dependency), and falls back to `now + 1 hour` if the message doesn't match (documented in Risks below).
2. **`checkForStalledCycle(routeDispatch)`**, called once per poll-loop iteration right after the existing message-handling block (piggybacking on the loop's own long-poll pacing — no new timer). For each `[chatId, workspaceDir]` in `buildBoundChatMap({repoRoot: REPO_ROOT})` (already exported by `telegram-router.mjs`, already imported by this file's routing path): spawn `node cycle-lock.mjs status` with `cwd: workspaceDir` → if `held`, skip this workspace. Spawn `node cycle-status.mjs --json` with `cwd: workspaceDir` → parse; its `liveness` field is already computed server-side by that CLI, so no need to import `computeLiveness` — if `liveness.state !== 'stalled'` or `counters.pipelineUrlsPending === 0`, skip. If `lastStopReason === 'session-limit'` and `Date.now() < Date.parse(resumeNotBefore)`, skip. Otherwise, dispatch `{ chatId, cwd: workspaceDir, kind: 'cycle-resume', messages: [] }` through the existing `routeDispatch`/`fanOutDispatches` path (no new dispatch machinery, just a new dispatch object and a new kind).
3. **`buildCycleResumePrompt(dispatch)`**, alongside the existing `buildRoutingPrompt`/`buildOnboardingPrompt`, reusing the same `KNOWN_PATHS_PRIMER`. States plainly that a previous `cycle` Step 2 batch stopped with pending URLs remaining in `data/pipeline.md`, and instructs resuming `modes/cycle.md` at Step 2 directly — explicitly do NOT restart Step 0/Step 1 (the scan/lock/preflight steps), since the pipeline backlog and `cycle-status.json` state are already current. `dispatchOne` gains one more branch (alongside its existing `onboarding` special case): `dispatch.kind === 'cycle-resume'` selects this builder.

`checkForStalledCycle` must never throw into the main loop — same defensive convention `cycle-status.mjs` itself already documents ("`update()` must never throw and never blocks the run"). Wrap its body in try/catch, log and continue on any failure.

## Testing

- **Unit tests** (`test-all.mjs`, styled on existing `cycle-status.mjs`/`scan-ats-full.mjs` checkpoint tests): the reset-time parser (`"resets 7:50pm (America/New_York)"` → correct absolute ISO timestamp, including a DST-boundary case); `checkForStalledCycle`'s decision logic against synthetic `cycle-status.json` states (`no_run`, `running`, `stalled`+`pipelineUrlsPending: 0`, `stalled`+batch-limit, `stalled`+session-limit-not-yet-elapsed, `stalled`+session-limit-elapsed) — assert dispatch happens only in the last two cases where the guard should actually fire, and only after `resumeNotBefore` has passed for the session-limit one; the lock-check short-circuit (locked → never reads cycle-status at all).
- **Behavioral replay**, matching how the last three fixes were verified: feed `checkForStalledCycle` a real synthetic `cycle-status.json` matching Ernesto's actual 2026-09-09 stopped state (`step: '2-pipeline'`, real `pipelineUrlsPending` count, `lastStopReason: 'session-limit'`, a `resumeNotBefore` a few minutes in the future) and confirm it correctly withholds dispatch until that time passes, then dispatches.
- **Live confirmation**: after rollout, the next real `cycle` run whose backlog exceeds 20 URLs should show up in `data/token-efficiency-log.tsv` as multiple smaller sessions under the same logical run rather than one 40M+-token session — the same telemetry that surfaced the original problem closes the loop on the fix.

## Risks / open questions

- **`resumeNotBefore` parsing is coupled to the exact wording of the session-limit message.** If Anthropic changes that message's format, the parser fails closed (falls back to *some* safe default delay, e.g. retry in 1 hour) rather than mis-parsing into an immediate retry loop — needs to be explicit in the parser, not assumed.
- **A `cycle` run that stops for a reason other than these two** (a genuine crash, an uncaught error) leaves `lastStopReason` at whatever it last was, which could be stale. `computeLiveness`'s `STALL_AFTER_MS` window bounds how long a genuinely-abandoned state can sit before it's eligible for auto-resume, but a crash *right after* a batch-limit stop was written and *before* Step 2 actually made progress could, worst case, resume into the same crash. Not different from today's behavior (a human re-running `/run` after a crash has the same risk) — no regression, but not a new safety net either.
- **Whether this measurably reduces quota pressure remains unverified against Pro's actual (undocumented) accounting** — this design's guarantee is "bounds peak per-session context," which is unconditionally sound engineering regardless of that unknown, but the live-confirmation step above is the only way to know the practical size of the win.
