# Workspace / Multi-Tenancy Core — Design

**Status:** Approved, pending implementation plan
**Date:** 2026-08-15
**Author:** Roberto Alevás Vásquez (via Claude)

## Context

career-ops is currently a single-tenant, single-directory system: exactly one
`cv.md`, one `config/profile.yml`, one `data/` tree, one `reports/` directory,
one Telegram chat allowlist, one Discord webhook, one set of lock files — all
resolved as paths relative to wherever the script/mode itself lives (`ROOT =
dirname(fileURLToPath(import.meta.url))`) or, for markdown mode files, implicit
relative-to-project-root prose.

The goal is to let several people share one career-ops installation — one
codebase, one running Telegram bot — while each person's CV, profile, targeting
keywords, tracker, reports, and generated PDFs stay completely separate from
everyone else's.

**This fork has diverged from the upstream `santifer/career-ops` repository
and does not track it.** Design decisions below are free to restructure the
repo layout without weighing upstream-compatibility cost — that constraint
does not apply here.

This spec covers **only** the data/path/secrets layer that makes multi-tenancy
possible. It deliberately does **not** cover:

- The Telegram router that maps an incoming `chat_id` to a workspace
- The one-time access-code gate for first-time bot users
- The conversational onboarding flow (profile Q&A, resume upload, Discord
  webhook collection) that provisions a new workspace end-to-end

Those are a separate design, built on top of the primitives defined here
(`provision-workspace.mjs`, the `workspaces/{slug}/workspace.json` binding
point, and the path-resolution rules below).

## Goals

- Each person's User Layer data (per `DATA_CONTRACT.md`) is fully isolated:
  their own `cv.md`, `config/profile.yml`, `portals.yml` (including their own
  `title_filter`/`location_filter` keywords), `data/`, `reports/`, `output/`,
  etc.
- The System Layer (modes, scripts, templates) stays a single shared copy —
  one codebase to update, not N divergent checkouts.
- Isolation is enforced by the filesystem/OS, not by agent prompt discipline.
- No dependency on elevated/administrator privileges, and no dependency on a
  machine-wide OS setting (e.g. Windows Developer Mode) — see "Why
  directory junctions, not file symlinks or hardlinks" below.
- A solo, non-multi-tenant user of this codebase sees **zero** behavior
  change and needs **zero** migration for their own workflow.
- Your own existing live data (currently at the repo root) migrates into the
  same `workspaces/{slug}/` structure as everyone else — no special-cased root.

## Non-goals

- Access control / the invite-code gate (next design pass)
- The onboarding conversation itself (next design pass)
- Per-user Anthropic/Claude API billing — all workspaces run under the
  operator's own Claude Code session/API key, by explicit decision (revisit
  later if usage becomes a real constraint)
- A shared/deduplicated raw ATS scan cache across workspaces — each
  workspace's `data/cache/ats-companies/*` stays independent, by explicit
  decision (simplicity over efficiency for a 2-20 person circle; revisit if
  redundant multi-hour sweeps become a real pain point)
- Preserving compatibility, or update-pull capability, with the upstream
  `santifer/career-ops` repository — this fork does not track upstream (see
  "Update mechanism" below)

## Why directory junctions, not file symlinks or hardlinks

Investigated directly (verified on this machine, Windows 11 Pro):

- **Plain file symlinks require admin privilege** (or the Developer Mode /
  `SeCreateSymbolicLinkPrivilege` workarounds) — confirmed by testing
  `New-Item -ItemType SymbolicLink` on a file without elevation, which fails.
- **Directory junctions and hardlinks do not** require elevation — confirmed
  by the same test.
- **Hardlinks are unsafe here regardless**: `update-system.mjs apply()`
  writes updated system files via `git checkout FETCH_HEAD -- <path>` (see
  `update-system.mjs:1006`), which replaces a file's on-disk inode rather
  than editing its content in place. A hardlinked copy inside a workspace
  would keep pointing at the pre-update inode forever, silently diverging
  from the real file the moment it's next updated. (This is moot for the
  active workflow per "Update mechanism" below, but the same risk would
  apply to any future direct edit of a system file too, since editors and
  `git` commands broadly favor replace-on-write over edit-in-place.)
- Weighed enabling Developer Mode (or the narrower
  `SeCreateSymbolicLinkPrivilege` grant via Local Security Policy, also
  available on this Windows 11 Pro machine) against restructuring the repo
  to avoid needing file-level links at all. **Decision: restructure the
  repo.** Junctions are pure path references — they can never go stale the
  way a hardlink can, they need no OS privilege ever, and (per the Context
  section above) there's no upstream-compatibility cost to weigh against a
  one-time reorganization.

**Resulting reorganization:**

- Root-level `*.mjs` scripts move into a new shared subdirectory (working
  name `core/` — final name decided in the implementation plan) so it can be
  junctioned wholesale into every workspace. Internal script-to-script
  invocations (e.g. `telegram-monitor.mjs` spawning `telegram-poll.mjs`) need
  no changes, since both scripts move together and stay siblings; only
  `modes/*.md` prose and docs that invoke a script by its old root-relative
  name (`node scan.mjs` → `node core/scan.mjs`) need updating — a mechanical
  but real find-and-replace across roughly 80 mode files plus docs.
- `modes/_profile.md`, `modes/_custom.md`, `modes/_brief.md` — the three User
  Layer files currently nested inside the otherwise-System-Layer `modes/`
  directory — move out of `modes/` entirely, so that directory becomes pure
  System Layer and junctionable as a whole. Exact new location (workspace
  root vs. a new `profile/` subdirectory) decided in the implementation plan;
  every reference to `modes/_profile.md` etc. across `AGENTS.md`, `CLAUDE.md`,
  and every mode file's own prose needs updating to match.
- `config/plugins.example.yml` moves to `templates/`, so `config/` becomes a
  pure User Layer directory (no linking needed there at all — a real
  directory like `data/`). 8 existing references to the old path
  (`modes/telegram.md`, `plugins.mjs`, `test-all.mjs`, `DATA_CONTRACT.md`,
  `update-system.mjs`, `plugins/README.md`, `docs/PLUGIN_REVIEW.md`, plus the
  file's own prior location) need updating.
- Root-level project-instruction files (`CLAUDE.md`, `AGENTS.md`, `CODEX.md`,
  `OPENCODE.md`, `KIMI.md`, `GEMINI.md`) are assumed — not yet empirically
  verified — to be discovered by Claude Code via directory walk-up from
  `cwd` (the same mechanism `git` uses to find `.git`), the same way a
  nested project directory today inherits a parent `CLAUDE.md`. If true, a
  workspace nested under the repo root inherits these files automatically
  with no linking or copying needed at all, since they'd just be found one
  level up. **To verify empirically during implementation**: provision a
  test workspace, set `cwd` there, confirm project instructions still load.
  If the assumption is wrong, this needs its own follow-up decision at that
  point (real copies kept in sync some other way, or an explicit path
  configured elsewhere).

## Architecture

### Directory layout

```
career-ops/                          (repo root — pure System Layer after migration)
├── core/*.mjs                       (real, shared — relocated from repo root)
├── modes/*.md                       (real, shared — pure System Layer after _profile.md et al move out)
├── templates/, providers/, plugins/, docs/, ...  (real, shared)
├── workspaces/
│   ├── roberto/
│   │   ├── workspace.json           (real — slug, chat_id, display name, created date)
│   │   ├── .env                     (real, gitignored — DISCORD_WEBHOOK_URL, etc.)
│   │   ├── cv.md                    (real)
│   │   ├── _profile.md, _custom.md, _brief.md   (real — new location TBD in plan)
│   │   ├── config/                  (real, whole directory — pure User Layer)
│   │   │   ├── profile.yml
│   │   │   ├── plugins.yml
│   │   │   └── ...
│   │   ├── portals.yml              (real)
│   │   ├── data/                    (real)
│   │   ├── reports/                 (real)
│   │   ├── output/                  (real)
│   │   ├── jds/                     (real)
│   │   ├── interview-prep/          (real)
│   │   ├── core/ → ../../../core             (junction, whole dir)
│   │   ├── modes/ → ../../../modes           (junction, whole dir)
│   │   ├── templates/ → ../../../templates   (junction, whole dir)
│   │   ├── providers/ → ../../../providers   (junction, whole dir)
│   │   ├── plugins/ → ../../../plugins       (junction, whole dir)
│   │   ├── docs/ → ../../../docs             (junction, whole dir)
│   │   └── ...
│   └── alice/
│       └── ... (same shape)
```

`workspaces/` itself is gitignored except a `.gitkeep`/README; no user data is
ever committed.

### What gets junctioned vs. real-copied

`update-system.mjs` already maintains `SYSTEM_PATHS` — the authoritative,
machine-readable list of every path the (now-dormant, see "Update mechanism"
below) auto-updater was allowed to overwrite, which is definitionally the
System Layer. `provision-workspace.mjs` imports and reuses that same array
(rather than maintaining a second list) purely as a static reference for
what's System Layer, independent of whether the remote-pull machinery it was
originally written for is ever invoked again. Everything in `SYSTEM_PATHS`
becomes a top-level directory junction (after the reorganization above
removes every mixed-content directory); everything else that's part of a
normal install is User Layer and gets a real file/directory, seeded from the
same template files `doctor.mjs` already uses today (`config/profile.example.yml`
→ `config/profile.yml`, empty `data/applications.md` tracker, etc.).

`workspace.json` is the binding record a future router uses to map an
incoming Telegram `chat_id` to this workspace:

```json
{
  "slug": "roberto",
  "chat_id": "491507842",
  "display_name": "Roberto",
  "created_at": "2026-08-15"
}
```

### provision-workspace.mjs contract

- **Slug validation**: `^[a-z0-9][a-z0-9-]{1,31}$` (matching the plugin
  engine's own `ID_RE` convention in `plugins/_engine.mjs`) — rejects
  anything containing `..`, `/`, `\`, or other characters that could escape
  the `workspaces/` directory when used to build a path.
- **Idempotent `--repair`/`--repair-all`**: re-syncs an existing workspace's
  junction set against the current `SYSTEM_PATHS`. Since junctions are pure
  path references, they cannot go stale from content changes — the only
  thing repair needs to do is add a junction for any top-level system
  directory that didn't exist yet when a workspace was first provisioned.
  Never touches real (User Layer) files.
- **Not wired into any automatic pipeline** — see "Update mechanism" below.
  Run manually whenever the System Layer changes in a way that adds a new
  top-level directory.

### Path resolution rule

Every script keeps computing `ROOT = dirname(fileURLToPath(import.meta.url))`
exactly as today, now resolving to `core/` after the reorganization.
**System-asset** joins (`templates/`, `providers/`, `plugins/`, registry
files) keep resolving off `ROOT` unchanged — Node's ESM resolves
`import.meta.url` through a junction to the real shared directory, so this is
correct with no code change.

**User-layer** joins (`data/`, `reports/`, `output/`, `cv.md`, `config/`,
`portals.yml`, etc.) switch from `ROOT`-based to a new helper:

```js
function workspaceRoot() {
  return process.env.CAREER_OPS_WORKSPACE || process.cwd();
}
```

`CAREER_OPS_WORKSPACE` is an explicit override/escape-hatch for the rare case
where `cwd` isn't trustworthy (matches the existing `CAREER_OPS_REPORTS_DIR`
/ `CAREER_OPS_DISCORD_TICKER_STATE` / `CAREER_OPS_TELEGRAM_OFFSET`-style
per-script overrides already in the codebase), unset by default.

Because a future router will always `spawn(..., { cwd: workspaceDir })`
before invoking `claude -p` for a given user, `process.cwd()` is correct by
construction for that path. For a solo user who just runs career-ops from the
repo root as today, `process.cwd()` **is** the repo root — identical
behavior, zero migration required for anyone who never sets up `workspaces/`.

`modes/*.md` prose requires no changes to path references — bare relative
paths like `data/applications.md` already resolve against the session's cwd
via the Read/Write/Bash tools. Script *invocation* strings (`node scan.mjs`)
do need updating to the new `core/` prefix, per the reorganization above.

The concrete list of `*.mjs` scripts whose user-layer joins need to move from
`ROOT`-based to `workspaceRoot()`-based is enumerated file-by-file in the
implementation plan, not here. Known candidates from this investigation:
`scan.mjs`, `scan-ats-full.mjs`, `set-status.mjs`, `merge-tracker.mjs`,
`tracker-utils.mjs`, `pipeline-lock.mjs`, `cycle-lock.mjs`,
`cycle-status.mjs`, `discord-ticker.mjs`, `telegram-poll.mjs`,
`telegram-monitor.mjs`, `outcome.mjs`, `doctor.mjs`, and others touching
`data/`, `reports/`, `output/`, `cv.md`, or `config/`.

### Hub-global paths (hub-paths.mjs)

Two paths must **never** follow workspace resolution, regardless of `cwd` or
`CAREER_OPS_WORKSPACE`, because there is exactly one Telegram poller for the
entire system (Telegram rejects concurrent `getUpdates` on the same bot
token):

- `data/telegram-offset.json` — the single poller's cursor
- The daemon's single-instance lock (`data/telegram-daemon.lock`)

These live in a small, dedicated `hub-paths.mjs` module that always resolves
off `ROOT`, structurally incapable of picking up workspace scoping — a
different function name (not a convention future code has to remember) than
`workspaceRoot()`. Kept intentionally minimal (just these two entries) for
now; expected to gain more entries (e.g. the access-code registry) in the
next design pass, added there rather than speculated about here.

### Secrets

The Discord webhook is no longer a process-global `DISCORD_WEBHOOK_URL` env
var. It lives in `workspaces/{slug}/.env` (real file, gitignored). A future
router reads that file and merges it into the `env` option of the
`spawn('claude', ['-p', prompt], { cwd: workspaceDir, env: {...process.env,
...workspaceEnv} })` call for that workspace's invocation. `buildCtx` in
`plugins/_engine.mjs` already sources secrets from `process.env` — since each
workspace's Claude invocation is its own child process with its own merged
env, **no changes are needed to `plugins/_engine.mjs` or
`plugins/discord/index.mjs`**.

`TELEGRAM_BOT_TOKEN` and Claude/Anthropic compute credentials stay global —
one bot token, and by explicit decision, one shared Claude Code session/API
key pays for every workspace's invocations. (Concurrent `claude -p`
invocations under one account already work today — the existing daemon's
non-blocking dispatch already relies on exactly that, e.g. answering `/status`
while a `cycle` run is in flight — so this isn't a new risk being introduced.)

### State & locks: hub-global vs. per-workspace

**Hub-global** (`hub-paths.mjs`, never workspace-scoped):
- `data/telegram-offset.json`
- The daemon single-instance lock

**Per-workspace** (real file/dir inside `workspaces/{slug}/`):
- `data/telegram-state.md`
- `cycle-lock` state
- `data/cache/cycle-status.json`
- `data/cache/discord-ticker-state.json`
- `pipeline-lock` state
- `data/cache/ats-companies/*` (raw scan cache — not shared across users, by
  explicit decision)
- Every other per-user data file already covered by the User Layer table

This split exists because there's exactly one Telegram poller for the whole
system (hub-global), but each user runs independent, concurrent `cycle`/
`apply` workflows against their own data (per-workspace).

## Update mechanism

This fork does not track the upstream `santifer/career-ops` repository (see
Context above), so `update-system.mjs`'s remote check/apply/rollback/dismiss
flow is not part of this project's workflow going forward. System-layer
files get edited directly in this repo instead.

**By explicit decision: nothing about `update-system.mjs` is removed.** The
script, `VERSION`, `CANONICAL_REPO`, and its `test-all.mjs`/`upgrade-tests.mjs`
coverage all stay in the codebase exactly as they are, dormant and unused.
The only change is that **nothing invokes it automatically anymore** —
`AGENTS.md`'s "Update Check" section (which currently runs `node
update-system.mjs check` silently on every session's first message) is
removed so no session ever triggers a remote-update look-up. `SYSTEM_PATHS`
remains useful purely as a static reference for what's System Layer (used by
`provision-workspace.mjs`), independent of whether the remote-pull machinery
is ever invoked again.

Consequently, `provision-workspace.mjs --repair`/`--repair-all` is **not**
wired into `apply()` (there is no `apply()` call in this workflow to wire it
into) — it's a manually-invoked maintenance command, run whenever a
System-Layer change adds a new top-level directory.

## Migration

Two things move together, since the reorganization above is a prerequisite
for workspaces to work at all:

1. **Repo restructuring** (one-time, affects the whole codebase): root-level
   `*.mjs` scripts move into `core/`; `_profile.md`/`_custom.md`/`_brief.md`
   move out of `modes/`; `config/plugins.example.yml` moves to `templates/`;
   every mode file, doc, and internal reference to any of these old paths is
   updated to match.
2. **Your own data migration**: your existing live data (currently at the
   repo root: `cv.md`, `config/profile.yml`, `data/`, `reports/`, `output/`,
   etc.) moves into `workspaces/{your-slug}/` using the same real-file/
   junction split as any other workspace — no special-cased root. The repo
   root becomes pure System Layer after migration.

The implementation plan covers the concrete migration steps and ordering
(restructure first, then provision+migrate your own workspace, verify
nothing was left behind, update any scheduled tasks pointing at old root
paths).

## Testing

- `provision-workspace.mjs` needs unit coverage: junction set matches
  `SYSTEM_PATHS` exactly (no drift), seeded real files match `doctor.mjs`'s
  existing template-copy behavior, `workspace.json` is written correctly,
  slug validation rejects path-traversal attempts.
- `--repair`/`--repair-all` needs coverage for the "new top-level system
  directory added after initial provisioning" case.
- Path-resolution changes need coverage that a script run with `cwd` set to a
  fixture workspace reads/writes only within that workspace, never the shared
  root — this is the isolation guarantee the whole design rests on.
- Empirically verify the `CLAUDE.md`/`AGENTS.md` directory walk-up discovery
  assumption from a workspace fixture's `cwd` (see "Why directory junctions"
  above) — this determines whether any follow-up work is needed for those
  files.
- Existing `test-all.mjs` / `upgrade-tests.mjs` fixture conventions
  (`seed-fixture.mjs`, `test-fixtures/`) should be extended rather than
  duplicated for workspace fixtures.
- A regression test asserting `SYSTEM_PATHS` (update-system.mjs) and the
  provisioning junction set never diverge, so the "one source of truth" claim
  in this design stays true over time.

## Open items for the next design pass (Telegram router + onboarding)

- Access-code generation and redemption (one-time codes, generated out of
  band by the operator; a redeemed code permanently binds a `chat_id` to a
  workspace via `workspace.json`)
- Where pending/unredeemed codes are stored (likely a small hub-global
  registry, extending `hub-paths.mjs`, since a code doesn't belong to a
  workspace until it's redeemed)
- The conversational profile Q&A + resume ingestion + Discord webhook
  collection flow, likely reusing/retargeting `modes/interview.md`
- How the router selects `cwd` per incoming message (read all
  `workspaces/*/workspace.json`, build a `chat_id → slug` map, cached and
  refreshed each poll)
- Final destination for the relocated `_profile.md`/`_custom.md`/`_brief.md`
  (workspace root vs. a new subdirectory) — decided in the implementation
  plan for this spec, noted here in case it affects onboarding's file-writing
  logic
