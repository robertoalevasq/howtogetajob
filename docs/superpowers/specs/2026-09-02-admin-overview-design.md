# Admin Overview Artifact — Design

## Problem

The career-ops hub now runs multiple tenants (`workspaces/ernesto-vasquez`, `roberto-vasquez`, `leonie`, `thomas-acosta`), and there's no way to see, at a glance: which workspaces exist and how active they are, whether anything is currently mid-run (a stuck `cycle`, an in-progress scan), how much Claude token usage each workspace has consumed over time, and how often each career-ops command/mode actually gets invoked. All of this data exists somewhere on disk already — it's just scattered across per-workspace files and Claude Code's own local session logs, with no aggregated view.

## Goals

- A single, private, standing Artifact page the hub owner can reopen anytime without asking Claude first, showing:
  1. The workspace roster (who exists, when created, Telegram-bound or not, tracker stats).
  2. Which workspaces have an in-progress long-running task right now (or a stuck one).
  3. Token-usage history per workspace, over time.
  4. Best-effort run-count history per command/mode, per workspace, over time.
- Reuse existing scripts/data wherever possible (`core/stats.mjs`, `workspace.json`, `data/cache/cycle-status.json`) rather than building parallel infrastructure.
- Zero new instrumentation in mode files — both history features (token usage, run counts) mine Claude Code's own existing local session transcripts rather than requiring every mode file to self-report.

## Non-goals

- **Not a true real-time "who's online" view.** "Active tasks" means "is a long-running operation currently in progress for this workspace" (from on-disk lock/status files), not a live process/session registry — nothing in career-ops tracks that today, and building it was explicitly descoped during brainstorming.
- **Not a precise analytics system.** Run-count classification is a best-effort text match against free-form prompt args recorded in session transcripts, not a guaranteed-accurate count. Ambiguous or unrecognized invocations land in an explicit "unclassified" bucket rather than being silently dropped or miscounted.
- **Not comprehensive usage attribution.** Only sessions actually *launched* with a given workspace as the project root (Telegram-triggered headless `claude -p` runs, per `workspace-root.mjs`'s existing design) are attributed to that workspace's history. Interactive hub-root sessions that happen to touch a workspace's files (e.g., manual testing) are not attributed to any specific tenant — this is a known, disclosed scoping boundary, not a bug to fix here.
- **No live `db`/`room` capability.** The page is a plain static Artifact, redeployed on a schedule. See the Architecture section for why this was chosen over a `db`-backed live-reading page.

## Data sources

| Data | Source | Notes |
|---|---|---|
| Workspace roster | `workspaces/*/workspace.json` | slug, display_name, chat_id (bound Y/N), created_at |
| Profile summary | `workspaces/{slug}/config/profile.yml` | spend_tier, target_roles, archetype summary |
| Tracker stats | `node core/stats.mjs` (JSON mode), run with `cwd` set to each workspace | Reused as-is — already computes the "ever*" funnel (evaluated/applied/interview/offer counts) |
| Active task status | `workspaces/{slug}/data/cache/cycle-status.json` + whether that workspace's cycle-lock is currently held (and its age, to flag a stuck one) | No new file format — reads what `cycle-status.mjs`/`cycle-lock.mjs` already write |
| Token usage history | `~/.claude/projects/{project-dir}/**/*.jsonl`, filtered to project-dirs matching this hub's path, `usage` field per line (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`) | **Extract only the `usage` object and the line's `timestamp` — never read, store, or render any conversation content from these files.** Bucketed by workspace (derived from the project-dir name) and by day. |
| Run-count history | Same transcript files, `"name":"Skill"` tool-call entries where `input.skill` matches `"career-ops"` or `"workspaces/{slug}:career-ops"`, classified by matching `input.args` text against a small keyword table (`pipeline`, `cycle`, `scan`, `oferta`/`evaluate`, a bare URL/JD-shaped string → `auto-pipeline`, etc.) | Best-effort; anything that doesn't match a known pattern goes into an explicit `unclassified` count, never silently dropped or guessed into the wrong bucket |

**Workspace-slug-from-project-dir mapping:** Claude Code names a project directory by converting the launch path's drive letter, backslashes, and underscores to hyphens (e.g. `C:\Users\thebo\...\career-ops\workspaces\ernesto-vasquez` → `C--Users-thebo-...-career-ops-workspaces-ernesto-vasquez`). The snapshot script derives this hub's own prefix from its real `ROOT` path (never hardcoded), and any project-dir name that doesn't extend that prefix with `-workspaces-{slug}` is ignored (it belongs to a different repo/session, not this hub).

## Architecture

**One new script, `core/admin-overview-snapshot.mjs` — pure Node, zero LLM tokens:**

1. Enumerate `workspaces/*/workspace.json` for the roster.
2. For each, shell out to `node core/stats.mjs` with `cwd` set to that workspace for tracker stats.
3. Read each workspace's `data/cache/cycle-status.json` + lock-file state for active-task status.
4. Walk `~/.claude/projects/`, filter to this hub's project-dirs, and for each matching `.jsonl` file, stream it line-by-line extracting only `timestamp`, `usage`, and (for `Skill` tool-call lines) `input.skill`/`input.args` — nothing else is read into memory or retained.
5. Aggregate into one JSON snapshot: roster + active tasks + token-usage-by-day-by-workspace + run-count-by-mode-by-workspace (with an `unclassified` bucket).
6. Render a complete, ready-to-publish HTML file from that JSON.

**Why not a `db`-backed live page:** the `db` capability would let the page itself pull fresh data client-side without a republish, but achieving "reopen anytime, no need to ask Claude" doesn't require that — a scheduled redeploy of a plain static page satisfies it with meaningfully less surface (no capability declaration, no `rules` configuration, no client-side data-fetching code). The only thing `db` would add is a live tick-without-reload if the tab is left open across a refresh cycle, which isn't needed for a periodic admin check.

**Scheduling:** a Windows Task Scheduler entry runs `claude -p "[HEADLESS] run node core/admin-overview-snapshot.mjs, then publish the admin-overview artifact from the HTML file it writes"` on an interval the user picks (e.g. every 15-30 min). That headless turn does almost nothing — run the script, call `Artifact` with the resulting file — so it costs very little per firing. All the real work (steps 1-6 above) is zero-token.

## Artifact layout

1. **Workspace roster** — table: slug, display name, created date, Telegram-bound (✓/—), spend tier, tracker stats (evaluated/applied/interview/offer), last activity date.
2. **Active tasks** — one row per workspace with something in progress: task type, current step, started-at, and a "stuck?" flag if the lock is older than a sanity threshold (e.g. 2 hours).
3. **Token usage over time** — per-workspace, last 7/30 days, total tokens (input + cache + output) by day.
4. **Run counts over time** — per-workspace, per classified mode, last 7/30 days, plus the `unclassified` bucket shown honestly rather than hidden.

## Privacy

The artifact stays private by default (per how Artifacts work) — visible only to the hub owner unless explicitly shared. It surfaces activity for every tenant (`leonie`, `roberto-vasquez`, `thomas-acosta`), which the hub owner has already confirmed is their call to make per the earlier Ollama-delegation rollout conversation. Token-usage/run-count mining reads real session transcripts but is scoped to extract only the specific fields named above — the snapshot script must never copy conversation text, tool results, or file contents from those transcripts into its output or the rendered page.

## Testing

- Unit tests for the transcript-parsing logic (`extractUsage`, `classifyRunFromSkillArgs`) against small fixture `.jsonl` files — including a line with no `usage` field, a `Skill` call with unrecognized args (must land in `unclassified`, not silently dropped or misclassified), and a malformed/truncated JSON line (must skip that line, not crash the whole file).
- A test confirming the project-dir-to-workspace-slug mapping correctly ignores project directories that don't extend this hub's own root prefix.
- A test confirming the rendered HTML never contains any string from a fixture transcript's message/content fields — only from the `usage`/classification aggregates. This is the one privacy-critical invariant worth a dedicated regression test.
- Manual verification: run the script once against this real hub, confirm the numbers roughly match what's already known (e.g., `ernesto-vasquez`'s 47 tracker rows should match what `stats.mjs` reports directly), and eyeball the rendered page before scheduling it.
