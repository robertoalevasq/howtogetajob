# Persistent Browser Sessions for the Apply Flow — Design

## Problem

Every candidate reply during a Telegram-driven application (`modes/apply.md` + `modes/telegram.md` Step 3b) triggers a brand-new `claude -p` dispatch with no memory of the previous turn, and Playwright's browser is launched fresh each time via `.mcp.json`'s default `@playwright/mcp` config. For a multi-page ATS wizard (Workday in particular, which this system already automates heavily), this means every single turn re-authenticates, re-navigates to wherever the application left off, and re-runs read-only recon on pages already seen — before it can even act on the candidate's new reply.

This was measured directly, not estimated, from a real transcript of one apply-flow turn (a candidate approving one page): **60 API calls, ~323,000 cache-creation tokens, ~2.75 million cumulative cache-read tokens** across the orchestrating dispatch and the subagent it delegates the fill to. A meaningful share of that is the fixed cost of re-establishing state that a previous turn already established seconds or minutes earlier.

A companion, smaller fix (batching the Step 7b subagent's fill-then-verify cycle instead of snapshotting after every field) is already implemented in `modes/apply.md` and is out of scope for this design — it reduces snapshot count within a single turn, but does nothing for the cross-turn re-establishment cost this design targets.

## Goals

- Eliminate the "re-authenticate, re-navigate, re-recon" cost that happens on every turn of a multi-turn application by keeping the actual browser (cookies, session, open tab, page state) alive between a candidate's replies.
- Do this without changing how the Step 7b subagent drives Playwright — it keeps using the same `mcp__playwright__*` tools it already knows.
- Preserve full tenant isolation: two candidates' applications (in practice, already observed running concurrently this session) must never share a browser process or any state.
- Preserve every existing safety gate unchanged: resume-approval, field-approval, submit-approval, the account-creation consent gate, and the never-fabricate rules are untouched by this design. This is a performance/cost change to the transport layer under the flow, not a change to the flow's decision points.
- Degrade gracefully: if anything about the persistent-browser mechanism fails (crashed holder, stale state, connection refused), the flow falls back to today's behavior (a fresh browser) rather than hard-failing the application.

## Non-Goals

- Not attempting to keep the Claude *session* itself alive across turns (investigated and rejected — see "Rejected approach" below). Each turn is still its own `claude -p` dispatch; only the browser persists.
- Not building a general-purpose remote-browser-pool service. This is scoped narrowly to one browser per one in-progress application.
- Not changing anything about `modes/apply.md`'s Step 7b subagent's actual fill/verify logic beyond what the already-shipped batching fix covers.

## Rejected Approach: Claude Code Background Agents

Before settling on this design, we tested whether `claude --bg` (Claude Code's own background-agent mechanism) could serve as the persistence layer, since it's the obvious first thing to check before building anything custom.

Confirmed directly against a real background agent: while a background agent is running (`status: busy`), `claude --resume <session-id> -p "..."` from a separate process is rejected outright: `"Session X is currently running as a background agent. Use claude agents to find and attach to it, or add --fork-session to branch off a copy."` The same rejection persists even after the agent finishes (`status: idle`, `state: done`) — a background-agent session can never be fed new input via a scripted resume, only via `claude attach <id>` (a genuine interactive terminal hand-off, not automatable by a headless daemon) or `--fork-session` (which starts a disconnected copy with its own fresh process — no continuity of the live browser). This mechanism is built for a human checking back on a long task later, not for an external orchestrator driving a session turn by turn. Ruled out on this evidence, not on suspicion.

## Architecture

### Component: the browser holder process

A new script, `core/apply-browser-holder.mjs`, launched fully detached from whatever spawns it:

```js
spawn(process.execPath, [holderScriptPath, '--report', reportNum, '--workspace', workspaceCwd], {
  detached: true,
  stdio: 'ignore',
}).unref();
```

`detached: true` + `stdio: 'ignore'` + `.unref()` together mean the holder survives its parent's exit — it is not a child of the `claude -p` dispatch, and not a child of the daemon's own process lifetime either, so restarting the daemon (as happens routinely — see `core/telegram-monitor.mjs`'s own recent fixes this session) does not kill in-progress holders.

On startup, the holder:
1. Uses Playwright's `chromium.launchServer({ args: ['--remote-debugging-port=0'] })` — port `0` lets the OS assign a free port, avoiding collisions between multiple concurrent holders (one per active application, per the Goals above).
2. Reads the resulting CDP endpoint. `launchServer()` exposes this directly via `browserServer.wsEndpoint()` — no need to poll `http://127.0.0.1:{port}/json/version` for the `webSocketDebuggerUrl`, since Playwright's own API already returns it.
3. Writes `{endpoint, pid: process.pid, createdAt: <ISO timestamp>}` to the state file (see below).
4. Stays alive, doing nothing else, until told to stop (see Cleanup) or its idle timeout elapses.

The CDP endpoint binds to `127.0.0.1` only — **never** `0.0.0.0` or any externally-reachable interface. CDP access is equivalent to full remote control of the browser (arbitrary JS execution, cookie access, network interception); exposing it beyond localhost would be a serious security regression, not a convenience.

### State file

`data/.apply-browser-sessions.json` inside the relevant candidate's own workspace (same directory as `.apply-secrets.json`, same reasoning: workspace-scoped, gitignored under the existing `data/*` rule — see `core/AGENTS.md`'s Data Contract). Keyed by report number, mirroring `.apply-secrets.json`'s own shape:

```json
{
  "937": { "endpoint": "ws://127.0.0.1:54231/devtools/browser/...", "pid": 41234, "createdAt": "2026-08-31T18:02:11.000Z" }
}
```

### How a dispatch connects to it

When the daemon determines a dispatch should reuse an existing holder (see below), it invokes `claude -p` with:

```
--mcp-config '{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest","--cdp-endpoint","<endpoint>"]}}}' --strict-mcp-config
```

`--strict-mcp-config` ensures only this override is used for the dispatch, not a merge with the project's default `.mcp.json` (which would otherwise also try to launch its own browser). The Step 7b subagent inside that dispatch calls `mcp__playwright__browser_navigate`, `browser_snapshot`, etc. exactly as it does today — the MCP *server* process is still spawned fresh per dispatch (cheap; it holds no state of its own), but it *connects* to the already-running browser instead of launching a new one, so cookies, the authenticated session, and the current page all carry over.

### Daemon-side decision logic (new code in `core/telegram-monitor.mjs`)

The daemon cannot run full `modes/telegram.md`-level routing — that logic belongs in the mode file, not the daemon, per this project's existing separation of concerns (the daemon dispatches; mode files decide). But it can cheaply determine *which report* an incoming apply-flow message concerns using two existing, already-structured signals, without re-implementing routing:

1. A fresh `/apply {report}` or `/apply {url}` command — the report number is either directly in the command args, or (for a URL) resolvable the same way `modes/telegram.md` Step 3b item 0 already does (match against `data/applications.md`).
2. A reply to a pending confirmation — `telegram-state.md`'s pending confirmation block already carries a `report:` field for every apply-flow stage (`resume-approval`, `field-approval`, `submit-approval`, `question`). If exactly one confirmation is pending for the target chat (the same condition `modes/telegram.md`'s own Step 2 "Confirmation reply" row already requires), read its `report:` field directly.

Before dispatching a message resolved to report `N` in workspace `W`:

1. Read `W/data/.apply-browser-sessions.json` for an entry for `N`.
2. **No entry** → this is the first turn needing Playwright for this application; spawn a holder (as above), wait for it to write its endpoint (poll the state file briefly, bounded — e.g. up to 5 seconds, matching the kind of bounded wait `pipeline-lock.mjs` already uses elsewhere in this codebase), then dispatch with `--mcp-config` pointed at the new endpoint.
3. **Entry exists** → liveness-check it before trusting it (see Failure Handling below). Alive → dispatch with `--mcp-config` pointed at the existing endpoint. Dead or unreachable → delete the stale entry and fall back to step 2's fresh-spawn path.
4. **Message doesn't resolve to a report at all** (a command unrelated to apply, or an ambiguous multi-pending-confirmation case) → dispatch exactly as today, no `--mcp-config` override, using the project's default `.mcp.json`. This design only ever adds a persistence path; it never removes the existing fallback behavior for anything it can't confidently resolve.

### Liveness check

Before trusting a stored endpoint, verify the holder process is still real: a two-part check, both must pass:
1. The recorded `pid` still exists as a running process — `core/pipeline-lock.mjs` already does exactly this check (`process.kill(pid, 0)`, the standard cross-platform no-op existence check) for its own lock-ownership logic; reuse that pattern rather than inventing a new one. (`core/cycle-lock.mjs` is not useful precedent here despite superficially similar naming — it deliberately avoids PID-based checks in favor of heartbeat-refresh staleness, per its own header comment, because its use case has no reliable PID to check against. This design's case is different: the holder's PID is always known and directly checkable, so the simpler `pipeline-lock.mjs` pattern applies.)
2. A CDP connection to `endpoint` actually succeeds (a `pid` matching a *different*, coincidentally-reused process is possible after a crash and OS PID recycling — checking both, not just the PID, avoids trusting a false positive).

Either check failing means "treat as gone": delete the state entry, fall through to spawning fresh. This is the concrete mechanism behind the Goals section's "degrade gracefully" requirement — a broken persistent-browser path never blocks an application, it just loses the optimization for that one turn.

### Cleanup

The holder's entry (and the holder process itself, sent a termination signal) is removed on the same terminal-state triggers `modes/apply.md` Step 9 already uses for `data/.apply-secrets.json` cleanup (Step 5-alt item 7's password cache): a successful submission, an explicit candidate "skip", or a hard-stop with no working path forward. This is a mode-file-level addition — Step 9 (and the various hard-stop points that already clean up `.apply-secrets.json`) gets one more line: also stop the holder and remove its state entry, if one exists for this report.

As a backstop for anything that falls through those documented triggers (an abandoned application the candidate simply never returns to), the holder enforces its own idle timeout — 30–60 minutes of no CDP activity — and self-terminates, removing its own state entry on the way out. This means an abandoned application never leaves an orphaned browser process running indefinitely, even if every mode-file-level cleanup trigger is somehow missed.

### Multi-tenancy isolation

One holder process per active application (`{workspace}-{report}`), never a shared process serving multiple applications. This is a structural guarantee, not a policy one: two candidates' applications literally cannot share browser state because they never share a process. The resource cost is real but bounded by actual concurrent usage — a headless Chromium instance is roughly 100–300MB; at today's actual scale (two known active candidates, occasionally overlapping) this is trivial, and the idle-timeout keeps it from growing unbounded if usage scales up later.

## Testing Approach

- `core/apply-browser-holder.mjs`'s own logic (endpoint discovery, state-file writing, idle-timeout self-termination) is unit-testable in isolation, the same way `core/access-code.mjs`'s `getBotUsername()` was made testable this session — by decoupling the mechanism from any one specific caller.
- The daemon's new decision logic (report resolution from a pending confirmation, liveness-check-then-reuse-or-respawn, fallback-to-default-config on ambiguity) is unit-testable with injectable fakes, matching the existing pattern in `tests/telegram-monitor.test.mjs` (`dispatchOne`'s injectable `invoke` parameter).
- The actual CDP-connect mechanism (does `@playwright/mcp --cdp-endpoint` genuinely reconnect to a real already-authenticated page) needs at least one real, manual end-to-end verification against a live ATS during implementation — this is exactly the kind of external-service integration point that unit tests with fakes cannot fully substitute for.

## Open Implementation Details (for the implementation plan, not blocking this spec)

- The exact bounded-wait mechanism for step 2 of the daemon's decision logic (waiting for a freshly-spawned holder to write its endpoint) should follow this codebase's existing polling-with-timeout conventions rather than introduce a new one.
- `process.kill(pid, 0)` (the pattern `pipeline-lock.mjs` already uses) is cross-platform in Node, including Windows (this project's primary deployment platform, per its `PowerShell`-based tooling elsewhere) — confirm this holds during implementation rather than assuming it without a real check, since this design's correctness depends on it distinguishing "alive" from "dead" accurately.
