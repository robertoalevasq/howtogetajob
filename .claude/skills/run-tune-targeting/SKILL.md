---
name: run-tune-targeting
description: Retarget a career-ops workspace's job-search keywords (portals.yml title_filter) and profile archetypes to actually fit the candidate's resume, using real scan results as evidence instead of guessing. Use when asked to tune/retune someone's profile, fix their job-search keywords, find better-fitting roles, add exclusions for mismatched titles, or find entry-level equivalents in categories that were already matching.
---

career-ops is a Markdown-prompt-driven job-search tool (`modes/*.md`, read by an AI agent), not a GUI/server app — there's no window to screenshot. The "app" here is a workspace's data files plus a real CLI driver: `core/tune-targeting.mjs`. Drive it directly with `node`; no browser, no tmux.

All paths below are relative to the repo root (`career-ops/`), run from inside the target workspace directory (`workspaces/{slug}/`) so the tool's relative reads (`portals.yml`, `data/pipeline.md`, `config/profile.yml`, `data/scan-history.tsv`) resolve against that candidate's own files — `core/` itself is a directory junction back to the shared script, so `node core/tune-targeting.mjs` works unchanged from any workspace.

## Prerequisites

None beyond what career-ops already needs (Node.js, the repo's own `npm install` — `js-yaml` is already a dependency, used to parse `portals.yml`).

## Build

No build step — it's a plain `.mjs` script, run directly.

## Run (agent path)

This is a two-step workflow: **analyze** (read-only, suggests) → **prune** (destructive, only after a human approves the keyword list). It never edits `portals.yml` itself — the actual archetype/keyword judgment call stays with the person driving it, same as every other zero-token gate in this codebase (`preflight-check.mjs`, `jd-skill-gap.mjs`).

```bash
cd workspaces/{slug}
node core/tune-targeting.mjs analyze --summary
```

Reads the workspace's scanned-title corpus (prefers `data/cache/ats-full-checkpoint.json` if a full-ATS sweep just ran and hasn't cleared its checkpoint yet; falls back to `data/scan-history.tsv` rows still marked `added`) and `portals.yml`'s `title_filter`. Prints, per configured positive keyword: how many real postings it matched and which seniority/domain "signal words" (`Senior`, `Enterprise`, `Strategic`, `Director`, `Clinical`, `Federal`, …) co-occurred in those matches — the same words that mark a posting as requiring years of quota-carrying or domain-specific experience the candidate doesn't have. It also flags positive keywords with **zero matches** (dead weight — burns a full scan cycle for nothing) and existing negative keywords with zero hits (harmless, just inert against the current corpus).

Use `--summary` for the human-readable report (above) or omit it for JSON (`{corpusSize, perKeyword, lowYieldPositiveKeywords, candidateExclusions, entrySignalHits, deadNegativeKeywords}`).

**Read the candidate's actual resume/CV alongside the report** (`cv.md`, `_profile.md`, `config/profile.yml`'s `target_roles`) — the tool ranks patterns in the scan data, it does not know what the candidate has actually done. A frequent signal word is only worth excluding if the postings carrying it genuinely don't match; a keyword with real matches is only worth keeping if those matches map to real experience. This is a judgment call the tool feeds, not replaces.

Once you and the human have picked a final keyword list: hand-edit `portals.yml`'s `title_filter.positive`/`negative` (small, deliberate lists — just edit the file), then apply that decision retroactively to whatever's already queued:

```bash
node core/tune-targeting.mjs prune --negative "Senior,Enterprise,Strategic,Director,Federal,Clinical" --workspace .
```

`title_filter` only applies at **scan time** — editing `portals.yml` alone does nothing to postings already sitting in `data/pipeline.md`'s Pending list from an earlier scan. `prune` removes any pending row whose title matches one of the given (comma-separated, case-insensitive substring) keywords, and updates the matching `data/scan-history.tsv` rows from `added` to `skipped_title` so the audit trail stays honest and a future scan doesn't treat them as new.

`--workspace <path>` (both commands, default `.`) points at a different workspace without `cd`-ing — useful for scripting analysis across multiple workspaces from the repo root.

## Run (human path)

Same commands — this tool has no interactive/GUI mode, agent and human paths are identical.

## Test

No dedicated test file yet. Verified this session by:

```bash
node core/tune-targeting.mjs analyze --summary --workspace workspaces/thomas-acosta
```

— ran against a real 613-title scan corpus, correctly re-surfaced signal words the corpus still contained (`Sr.` × 15, `Global` × 10, `Vice President` × 6, `Surgical` × 5) and independently flagged 4 positive keywords (`Assistant Manager`, `Shift Manager`, `Restaurant Manager`, `Venue Manager`) as zero-match dead weight — confirming by a second, independent method a structural finding first made by hand: hospitality/restaurant employers largely don't post to the ATS platforms this corpus is drawn from (Greenhouse/Lever/Ashby/Workday), so title-filter tuning alone can't fix that gap.

`prune` verified in an isolated scratch workspace: a 3-row pending list + matching scan-history, pruning `["Senior", "Enterprise"]` correctly removed 2 of 3 rows and flipped exactly those 2 scan-history rows to `skipped_title`, leaving the untouched row's status alone.

---

## Gotchas

- **The corpus mixes scan sessions.** `loadCorpus()` reads *every* `scan-history.tsv` row still marked `added`, not just the current run's pending set — including leftover rows from a much earlier session that were already dealt with (processed, applied to, or manually discarded) outside today's Pending list. Running `analyze` right after a fresh sweep is the cleanest signal; running it later on an old workspace will surface historical noise alongside anything currently pending. Don't assume every count in the report is "still sitting in the inbox" — cross-check against `data/pipeline.md` if that distinction matters.
- **`prune` is a plain substring match on the title text**, same semantics as `scan.mjs`'s own `title_filter` (case-insensitive, no word-boundary check). A short keyword like `"Sr"` deliberately also catches `"Sr."` and `"Sr,"` — that's intentional, but it means an overly short/generic keyword (e.g. a bare `"AI"`) could catch more than intended. Prefer keywords with enough characters to be unambiguous, and eyeball the `analyze` output's per-keyword match list before finalizing.
- **This never edits `portals.yml`.** It was tempting to have `analyze` auto-write its top suggestions, but the whole point (per this repo's own Data Contract — see `AGENTS.md`) is that targeting decisions are a human judgment call informed by evidence, not a heuristic auto-applying itself. Keep it that way if this tool grows further.

## Troubleshooting

- **`analyze` reports `corpusSize: 0`**: neither `data/cache/ats-full-checkpoint.json` nor `data/scan-history.tsv` exists yet for this workspace — run a scan (`scan.mjs` or `scan-ats-full.mjs`) first so there's real data to analyze against.
