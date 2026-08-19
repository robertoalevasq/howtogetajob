# Telegram Router + Access-Code + Onboarding — Design

**Status:** Approved, pending implementation plan
**Date:** 2026-08-18
**Author:** Roberto Alevás Vásquez (via Claude)

## Context

`docs/superpowers/specs/2026-08-15-workspace-multitenancy-core-design.md`
built the data/path/secrets layer that makes multi-tenancy possible:
`workspaces/{slug}/` directories with real per-tenant User Layer files and
junctions to a shared System Layer, `provision-workspace.mjs` to
create/repair them, `workspaceRoot()`/`hub-paths.mjs` for path resolution,
and a per-workspace `config/plugins.yml` (chat_id, Discord webhook). That
spec deliberately stopped short of three things, named there as "the next
design pass":

- The Telegram router that maps an incoming `chat_id` to a workspace
- The one-time access-code gate for first-time bot users
- The conversational onboarding flow that provisions a new workspace

This spec covers all three, since they're tightly coupled (the router needs
access-code state to decide bound vs. unbound; onboarding needs the router to
know when it's done) — a single cohesive design, not three independent ones.

`modes/telegram.md` (the existing command-routing mode: `/run`, `/apply`,
`/status`, etc.) needs **no changes** — it already resolves every path as a
bare relative reference against the session's `cwd`, so once a chat is
routed to the right `cwd` it works unchanged, regardless of which workspace
it belongs to.

**Scale:** small, known circle (~2-20 people), single shared Telegram bot
token, single shared Claude Code session/compute billing (both already fixed
by the core design's non-goals).

## Goals

- A brand-new Telegram user can prove they're authorized (a code you gave
  them out of band) and, through a Telegram conversation alone, end up with
  a fully provisioned, bound `workspaces/{slug}/` — no CLI or filesystem
  access to your machine, ever (confirmed: Telegram is their entire
  interface to career-ops, today and going forward).
- The shared daemon correctly routes an already-bound chat's messages to
  *its own* workspace, even with several workspaces coexisting.
- No LLM spend for anyone who isn't either already bound or actively
  redeeming/using a valid code — wrong-code and stranger traffic costs at
  most a canned reply.
- A stranger who finds the bot cannot access any workspace's data, cannot
  trigger any real action (`cycle`, `apply`, etc.), and cannot meaningfully
  brute-force their way in.

## Non-goals

- CLI/filesystem access for anyone but the operator — explicitly ruled out;
  Telegram is the only interface a provisioned tenant ever gets.
- Per-tenant Anthropic/Claude API billing (already a non-goal of the core
  design — unchanged here).
- Automatic expiry of abandoned onboarding sessions — they persist
  indefinitely and resume on the next message, matching this codebase's
  existing "flag, never auto-delete" convention for stray state.
- Full parity with every open-ended question in the interactive "First Run"
  onboarding (the superpower/deal-breakers/best-achievement questions) —
  those remain something the person can add later just by telling the bot
  about themselves in normal use.
- Multi-language onboarding, localized to the tenant's own preferred
  `language.output` — out of scope; onboarding conversation is English only
  for now (their `config/profile.yml` can still set any `language.output`
  for their own subsequent usage).

## Architecture

### State model

Three new hub-global files (resolved via `hub-paths.mjs`, never
workspace-scoped — same treatment as the existing telegram-offset/daemon-lock
entries there), plus one existing file gains a new writer:

- **`data/access-codes.json`** — the code registry, an array of
  `{ code, label, createdAt, expiresAt, redeemedBy, redeemedAt }`.
  `redeemedBy`/`redeemedAt` are `null` until redemption. `code` is a 24-char
  random alphanumeric string (~140 bits of entropy — brute force by manual
  guessing or even a scripted attacker is not a practical concern regardless
  of rate limiting; the lockout below is about noise, not security).
- **`data/access-code-attempts.json`** — wrong-attempt tracking, keyed by
  `chatId`: `{ [chatId]: { count, lockedUntil } }`. `count` increments per
  wrong attempt; once it hits the threshold, `lockedUntil` is stamped
  `now + 1 hour` and `count` resets to 0. Further wrong attempts *during*
  the lockout window are silently dropped (not replied to, not counted) so
  a spammer can't extend their own silence indefinitely by continuing to
  try — the lockout simply expires at `lockedUntil` and normal (reply +
  count) behavior resumes. Never blocks a legitimate, already-bound chat.
- **`data/onboarding/{chatId}.json`** — one file per in-progress onboarding:
  `{ chatId, redeemedCode, slug, answers: {...}, currentStep, startedAt,
  lastMessageAt }`. `slug` is `null` until the name question is answered.
  Deleted once onboarding completes.
- **`workspaces/{slug}/workspace.json`** (existing file from the core
  design) — its `chat_id` field is the actual "this chat is bound" signal
  the router checks. `provision-workspace.mjs` already supports creating a
  workspace without a `chat_id` (it stays `null`); a new dedicated bind step
  (below) is the only path allowed to set it.

The router scans `workspaces/*/workspace.json` fresh on every poll — no
in-memory cache. Each poll already respawns `telegram-poll.mjs` as a new
process, and reading a handful of small JSON files at 2-20-workspace scale
is free; a cache would only add invalidation bugs for no measurable benefit.

### Router (`core/telegram-router.mjs`)

Zero-token, deterministic — called from `telegram-monitor.mjs` immediately
after `pollTelegram()` returns, before any `claude -p` invocation. Messages
from one poll can belong to several different chats (one shared bot), so it
groups by `chatId` first, then for each:

1. **Bound** (`chatId` found in some `workspaces/*/workspace.json`) → resolve
   that workspace's absolute path. This chat's messages go to the existing
   `modes/telegram.md` routing prompt, invoked with `cwd` **and**
   `CAREER_OPS_WORKSPACE` both set to that path (see "Fixing the cwd gap"
   below — env var alone is not sufficient).
2. **Unbound, `data/onboarding/{chatId}.json` exists** → mid-onboarding.
   Invoke the onboarding prompt (below) with the accumulated state and the
   new message. `cwd` is `workspaces/{slug}` if the state's `slug` is
   already set (workspace already scaffolded), otherwise the repo root (no
   workspace-specific file access happens before a slug exists).
3. **Unbound, no onboarding state, message text (trimmed of surrounding
   whitespace, matched case-sensitively) equals a pending, unexpired code in
   `access-codes.json`** → check the lockout (below) first — if this chat
   is currently locked out, drop silently (see step 4). Otherwise atomically
   claim the code (mirrors `reserve-report-num.mjs`'s claim/release-on-
   conflict pattern, so two simultaneous redemptions of the same code can't
   both win), create `data/onboarding/{chatId}.json`, invoke the onboarding
   prompt to send the welcome + first question. **This is the only path
   that costs an LLM call for a chat that isn't already bound or
   mid-onboarding.**
4. **Unbound, no onboarding state, message doesn't match a valid code**
   (including an expired or already-redeemed code, treated identically to
   an invalid one) → wrong-attempt path against `access-code-attempts.json`:
   - Currently locked out (`lockedUntil` in the future) → drop silently, no
     reply, no counter change.
   - Not locked out, under threshold → send the canned "enter your access
     code to continue" reply (zero-token — `node core/plugins.mjs run
     telegram notify`, no Claude invocation) and increment `count`.
   - Not locked out, this attempt reaches the threshold (5) → send the
     canned reply one last time, then set `lockedUntil = now + 1 hour` and
     reset `count` to 0.

### Access codes (`core/access-code.mjs`)

A small standalone CLI, matching `provision-workspace.mjs`'s shape:

- **`generate --label "Alice"`** — creates the code, appends to
  `access-codes.json` with `expiresAt` = now + 7 days, prints the code (you
  send it to them however you like — this script never transmits it itself).
- **`list`** — pending (unredeemed, unexpired) / redeemed (with slug + date)
  / expired, for your own visibility.
- **`revoke <code>`** — marks a pending code dead before it's used.

### Onboarding (`modes/telegram-onboarding.md`)

Structured like `modes/telegram.md` (HEADLESS, no `AskUserQuestion`, every
question is a Telegram message, one at a time) but covering the trimmed-
parity ground from AGENTS.md's "First Run" flow:

1. Welcome message + ask their name.
2. Slugify the name (`Alice Chen` → `alice`, collision → `alice-2`),
   record it in the onboarding state, run
   `node core/provision-workspace.mjs {slug}` — scaffolds real template
   files (no `chat_id` yet) so subsequent answers write into real files
   instead of being held in memory.
3. Ask for their CV as pasted text → write to `workspaces/{slug}/cv.md`
   (clean markdown, same conversion the interactive onboarding already
   does).
4. Ask target roles, location, salary range, spend tier (same three-tier
   explanation as the interactive flow) → write to
   `workspaces/{slug}/config/profile.yml`.
5. Ask for a Discord webhook URL, explicitly skippable ("send it now, or
   reply 'skip' — you can add it anytime later") → if provided, write to
   `workspaces/{slug}/.env`; if skipped, `config/plugins.yml`'s
   `discord.enabled: false`. `telegram.enabled: true` and `chat_id` are
   always set — Telegram is how they got here at all.
6. **Bind**: a dedicated function (not a free-form file edit) sets
   `workspace.json`'s `chat_id`, enforcing one-chat-per-workspace and
   one-workspace-per-chat, then deletes `data/onboarding/{chatId}.json`.
7. Send a completion message + the existing `/help` text (Step 3g of
   `modes/telegram.md`). From the next poll onward the router sees this
   chat as bound.

`/restart` is recognized at any point during onboarding (mirrors the
edit-loop pattern already used elsewhere in `modes/telegram.md`) — clears
that chat's onboarding state (but not any already-provisioned, still-unbound
workspace directory — same "flag, don't auto-delete" treatment) and starts
over from the welcome message, for the case where someone pastes the wrong
CV or wants to redo an early answer cleanly.

If Claude's routing invocation itself errors out during onboarding (not the
person going quiet — an actual crash), the emergency-notify path
(`notifyRoutingFailure`) alerts **you** (the operator's own workspace), never
the still-unbound prospective tenant — there's no Discord webhook or
Telegram target configured for them yet, and even if there were, they're not
the audience for "routing infrastructure broke."

### Fixing the cwd gap in `telegram-monitor.mjs`

The earlier session's stopgap (`resolveHubWorkspace()` called once at daemon
startup, setting `CAREER_OPS_WORKSPACE` for the whole process) is superseded
here and needs correcting, not just extending: it set the env var but never
touched `invokeClaudeRoutingOnce`'s hardcoded `cwd: REPO_ROOT` in the
`spawn('claude', ['-p', prompt], ...)` call. Per the core design's own path
resolution rule, `.mjs` scripts that call `workspaceRoot()` pick up the env
var correctly, but Claude's own direct Read/Write/Bash tool calls on bare
relative paths (`cv.md`, `data/applications.md`) resolve against the spawned
process's real OS `cwd` — the env var alone does nothing for those.

The fix: `invokeClaudeRoutingOnce`/`invokeClaudeRouting` gain a `cwd`
parameter, supplied per-call by the router logic in `main()`/`daemonLoop()`
(the resolved workspace path for a bound chat, `workspaces/{slug}` or the
repo root for onboarding per the router's Step 2 above). The single
global `resolveHubWorkspace()` call at daemon startup goes away entirely —
the router now determines the right workspace per chat, per message batch,
which supersedes the single-workspace-for-everything stopgap.

### Interaction with the plugin-level chat allowlist

The `ingest()` allowlist added earlier this session (drop any message from
an unconfigured `chat_id`) is removed. It cannot coexist with onboarding — a
brand-new person's first message is, by definition, from a `chat_id` nobody
has configured anywhere. Access control fully moves to the router described
above, which has complete knowledge of bound/unbound/mid-onboarding state
that the plugin never had. `ingest()` reverts to a generic "fetch messages"
integration with no career-ops-specific policy embedded in it — the cleaner
separation, per the earlier decision.

## Testing

- `core/access-code.mjs`: generate produces a code matching the expected
  entropy/charset, respects the 7-day expiry, `list` categorizes correctly,
  `revoke` prevents later redemption, redeeming an already-redeemed or
  expired code fails.
- Concurrent redemption of the same code: two simultaneous claims, exactly
  one wins (mirrors existing `reserve-report-num.mjs` test coverage style).
- `core/telegram-router.mjs`: bound chat resolves to the right workspace
  path with multiple workspaces present; unbound+no-state+valid-code starts
  onboarding; unbound+no-state+invalid-code sends the canned reply and
  increments the attempt counter; lockout threshold/window behavior
  (silence after 5, resumes after the window, per-chat isolation — one
  chat's lockout never affects another's); mid-onboarding state resolves
  `cwd` correctly both before and after a slug is recorded.
- `telegram-monitor.mjs`: `invokeClaudeRoutingOnce` is invoked with the
  router-resolved `cwd`, not a hardcoded `REPO_ROOT` — a regression test in
  the same spirit as the core design's `is-main-junction.test.mjs` (provision
  a real fixture workspace, assert the spawn args target it).
- Bind step: sets `chat_id` exactly once, refuses to bind a slug that
  already has one, refuses to bind a `chat_id` already bound elsewhere.
- `SYSTEM_PATHS` coverage: `core/access-code.mjs`, `core/telegram-router.mjs`,
  and `modes/telegram-onboarding.md` all need entries (the coverage-guard
  test added in the core design work will otherwise fail on these as soon
  as they're committed).

## Migration

Almost none — no existing data changes shape, and the only behavior changes to
existing code are the `ingest()` allowlist removal and the
`invokeClaudeRoutingOnce` cwd parameterization described above.

**One manual step is required, though** (corrected 2026-08-19 during final
review; the section previously read "None"). An existing single-tenant
operator already has their `chat_id` in `config/plugins.yml`, but the router
reads bindings exclusively from `workspaces/{slug}/workspace.json` — a
freshly-provisioned workspace has `"chat_id": null`, so the operator's own
messages would fall through to the access-code gate. Bind once, per workspace:

```bash
node core/provision-workspace.mjs --bind-chat <slug> <chatId>
```

Note this is deliberately one chat per workspace. A `config/plugins.yml` with
several entries under `chat_ids` (a multi-recipient *notify* fan-out) has no
equivalent under the router's inbound model: only the single bound `chat_id`
routes in. Any additional chat that should be able to *drive* a workspace
needs its own workspace, or it stays notify-only.
