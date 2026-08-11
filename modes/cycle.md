# Mode: cycle — Full Cycle (scan everything → pipeline → tracker → top-match PDFs)

One command that runs the steps the user normally invokes separately: scan
portals *and* the full public ATS universe → process the inbox → tracker is
updated inline → make sure every strong match actually has a PDF → deliver
the result. This mode does not introduce new evaluation logic — it sequences
the existing `scan`, `scan-ats-full.mjs`, `pipeline`, and `pdf` modes and adds
a closing safety-net sweep, plus several zero-token integrity scripts
(`reconcile-pipeline.mjs`, `detect-reposts.mjs`, `sync-pdf-flags.mjs`,
`verify-pipeline.mjs`) that exist in this repo but were never wired into any
mode before — a plain small `/career-ops pipeline` or `/career-ops scan` run
doesn't need them, but a `cycle`-scale run (many parallel writers, high
volume) is exactly the scenario they were built for. Because the full ATS
sweep can run for hours, a `cycle` run is thorough, not fast — that trade is
intentional.

**Read `modes/_custom.md` before starting, if it exists — cycle must not
silently override the user's own house rules.** `_custom.md` may carry a
documented, dated exception for `cycle` specifically (e.g. a parallelism cap
higher than a general "sequential only" rule) where `cycle`'s volume is a
different scale than what the rule was written for. If no such dated
exception exists yet for a rule that would make `cycle` impractical, ask the
user once (as cycle.md was itself set up) and write the answer back to
`_custom.md` so it doesn't need to be asked again. Everything in `_custom.md`
without a documented exception governs `cycle` exactly as it governs every
other mode — in particular, a "no stop-and-ask, run continuously" rule and a
"defer tracker merge" rule are *followed*, not overridden, in Step 2 and the
tracker-write note below.

## Guardrails — what a `cycle` run must never do mid-run

Drawn directly from the 2026-08-04 run, where the agent improvised around gaps these rules now
close (a broken Discord ticker triggered a mid-run pause to ask "which fix?", and the same run
reported inconsistent keeper counts across its own turns). If you find yourself about to do one of
these, stop and re-read `_custom.md`'s no-stop-and-ask rule (scoped to the whole run, not just
pipeline backlog) instead.

1. **Never pause to re-diagnose a failed non-critical step.** "Non-critical" = anything whose
   failure already has a logged-and-continue path: a Discord tick (see Progress Reporting —
   logged to `data/discord-ticker.log`, never fatal), a `cycle-status.mjs` write (logged to
   `data/cycle-status.log`, never fatal — see Progress Reporting), a Step 3.6 integrity finding
   (folded into the Step 4 summary, never a blocker), a single Step 2 subagent's PDF failure
   (Step 3's safety net exists for exactly this). Log it, move to the next checkpoint, keep going.
2. **Never ask the user a question `_custom.md` already answers.** Before asking anything mid-run,
   check: does the no-stop-and-ask rule cover this? Does the sequential-vs-8-wave exception cover
   this? Does the deferred-merge rule cover this? Only ask if none of them do.
3. **Never hand-troubleshoot a broken script mid-run** (ad hoc `curl`, hand-editing a state file,
   improvising a new diagnostic flow). If a scripted step fails, its own failure handling (retry,
   log, skip) is the full extent of the response — not a new one you invent in the moment.
4. **Every count you state — in the terminal, in a Discord tick, in the Step 4 summary, or in
   answer to "how's it going?" — is read from disk at that instant, never from memory of what you
   said earlier in this conversation.** Sources of truth: `data/pipeline.md`'s Pending/Processed
   section lengths, `batch/tracker-additions/*.tsv` row counts for this run, the `reports/`
   directory listing, and `data/cache/cycle-status.json` (see Progress Reporting). A number carried
   forward from an earlier turn is exactly how the same run reported "4 keepers" and then "14
   keepers" for the same underlying state.
5. **A Progress Reporting failure never blocks or alters Steps 1–4.** Discord delivery, the status
   file, and the actual scan/pipeline/PDF/tracker work are fully decoupled; nothing in Progress
   Reporting is allowed to change what Steps 1–4 do.
6. **Never prefix a script invocation with `cd <path> &&`** — always run `node script.mjs ...` /
   `git ...` as a bare command from the repo root. This is both the existing Bash-tool convention
   and required for this project's `Bash(node *)`/`Bash(git *)` permission grants to actually
   match — a `cd && node` compound is parsed as two separate rules and won't be covered by either,
   which reintroduces a manual-approval prompt mid-run.

## Step 0 — Pre-flight

Two cheap, zero-token checks before spending any time on Step 1:

1. **`node validate-portals.mjs`** — structural validation of `portals.yml`
   (schema/shape, no network calls). If it fails, stop here and report the
   specific errors — scanning against a broken config wastes the whole run
   on results from whatever partially-parsed config survived.
2. **`node reconcile-pipeline.mjs`** — syncs any URLs already evaluated via
   `/career-ops batch` (which writes to `batch/batch-state.tsv` but never
   back to `data/pipeline.md`) into `data/pipeline.md`'s "Processed" section.
   Skip this without it and a URL you already batch-evaluated between `cycle`
   runs gets re-surfaced by Pass A/B and evaluated a second time — a wasted
   duplicate report and tracker row. Cheap and safe to run even when nothing
   needs reconciling (no-ops with a `0 reconciled` result).

## Progress reporting (status file + Discord) — start this right after Step 0

`cycle` can run for hours. Two layers of visibility, both driven by scripts rather than hand-built
per checkpoint, so neither can go permanently silent the way the old hand-built Discord convention
did:

- **`data/cache/cycle-status.json`, via `cycle-status.mjs`** — the fine-grained, always-on record.
  Updated at *every* checkpoint below with no throttling (it's a local file write behind a short
  lock, effectively free — no network, no rate limit exposure). Check it anytime from the terminal
  with `node cycle-status.mjs` (human-readable) or `node cycle-status.mjs --json`. `update()` never
  throws and is never fatal to the run — a write that can't acquire its lock is logged to
  `data/cycle-status.log` and skipped; guardrail 5 above covers why this must never block Steps 1–4.
- **Discord, via `discord-ticker.mjs`** — the coarse-grained, phone-checkable signal. One message,
  edited in place, at a throttled subset of the same checkpoints (see below). Skip this layer
  entirely if the `discord` plugin isn't configured (same check as Step 5) — it's a nice-to-have on
  top of a working run, not a requirement; `cycle-status.json` is the requirement.

`discord-ticker.mjs` validates/clamps the embed to Discord's real limits before sending and
persists the message id to disk (not agent-turn memory), falling back to a fresh message if editing
the old one fails after retries — see the script's own header comment for why (a 2026-08-04 run
went permanently silent on a single malformed embed under the old hand-built convention).

1. **Right after Step 0 passes**, start both fresh: `node cycle-status.mjs reset` and
   `node discord-ticker.mjs reset` (clears any stale state from a previous interrupted run).
2. Update `cycle-status.mjs` at *every* checkpoint listed below — write a small JSON patch to a
   scratch file (`{"step": {"id": "...", "label": "..."}, "counters": {...}}`, only the fields that
   changed) and run `node cycle-status.mjs update --file <patch-path>`.
3. Tick `discord-ticker.mjs` only at the **Discord-throttled** checkpoints marked below — write the
   embed JSON to a scratch file and run `node discord-ticker.mjs tick --embed-file <scratch-path>`.
4. On the run's last checkpoint: `cycle-status.mjs` gets `step.id: "done"`; `discord-ticker.mjs`
   gets one final tick with a short completion marker — title `"✅ career-ops cycle — complete"`,
   description `"Full report below."`, color `"#57F287"` (green; the detailed report still goes out
   separately via Phase 1 in Step 5 — don't cram the full Step 4 summary into this message). Use
   `"#FEE75C"` (yellow) instead of green if Step 3.6's integrity pass found issues, so the ticker
   itself flags it before anyone opens the summary.
5. **Call both scripts unconditionally at every checkpoint they're due, regardless of whether the
   previous call reported success or failure.** Neither failure is fatal, and neither is grounds to
   stop trying at future checkpoints (Guardrails 1 and 5 above) — each call is an independent
   attempt, so a transient outage self-recovers on its own.

**Checkpoint moments:**
- Pass A complete → `cycle-status` update (offer counts) + Discord tick ("Pass B starting")
- Each Pass B checkpoint (every 500 companies, same cadence as the script's own
  `data/cache/ats-full-checkpoint.json` writes) → `cycle-status` update (companies swept so far /
  total, matches found so far) + Discord tick, same content
- Pass B complete (incl. repost detection) → `cycle-status` update + Discord tick (total new
  offers, reposts flagged, "Pipeline starting (N pending)")
- **After each Step 2 wave** → `cycle-status` update every wave (waves done / total, URLs evaluated
  so far — this is the fine-grained truth). **Discord tick only every 3rd wave** (always including
  the first and the last) — at 8-wide waves over a large pending count this can be ~30+ waves/run;
  anyone checking from their phone only needs coarse movement, and `cycle-status.json` carries the
  per-wave detail for anyone at a terminal.
- Step 2 complete, entering Step 3 → `cycle-status` update + Discord tick ("Generating safety-net
  PDFs...")
- Step 3.6 complete → `cycle-status` update + Discord tick ("Finalizing..." — right before the
  final completion tick)

## Step 1 — Scan (two passes, both required)

`cycle` is the "scan everything" entrypoint — unlike a plain `/career-ops
scan`, it always runs both passes below, in order. Tell the user up front
that Pass B can run long (the script's own docs call a full sweep
"multi-hour") so the whole cycle may take a while — this is expected, not a
hang.

### Pass A — Tracked-company scan

Execute `modes/scan.md` in full (its own recommended delegation — a
background subagent — still applies). This covers `tracked_companies` and
`search_queries` from `portals.yml` and appends any new offers to
`data/pipeline.md`.

### Pass B — Full ATS sweep

`modes/scan.md` only ever looks at companies you've explicitly configured.
`scan-ats-full.mjs` is a separate, complementary script: it walks the
**entire public Greenhouse/Lever/Ashby/Workday/iCIMS company directory** —
no `tracked_companies` entry needed — filtered by `portals.yml`'s
`title_filter`/`location_filter`, and writes matches into the same
`data/pipeline.md` / `data/scan-history.tsv` that Pass A uses (same dedup,
same downstream `pipeline` step). It is zero-LLM-token, pure HTTP.

Because a full pass can run for hours, it checkpoints every 500 companies to
`data/cache/ats-full-checkpoint.json` and supports `--resume`. Drive it to
completion yourself — the user should never need a second terminal:

1. Check whether `data/cache/ats-full-checkpoint.json` exists.
   - Exists (an earlier sweep was interrupted) → run
     `node scan-ats-full.mjs --resume`
   - Absent → run `node scan-ats-full.mjs` (fresh sweep, default `--since 3`
     window unless the user asked for a wider one)
2. Launch it as a background shell process (not a blocking foreground call)
   so you can keep narrating progress instead of going silent for hours.
3. Poll it periodically. If it exits before reporting completion (crash,
   network failure, resolver outage) and the checkpoint file is still
   present, re-run with `--resume` automatically. Repeat until it reports
   completion.
4. If two consecutive resumes land on the exact same checkpoint position
   (no forward progress), stop looping, report the stall to the user with
   the last error output, and let them decide whether to keep waiting,
   narrow `--ats`/`--since`, or investigate.
5. On completion, delete/ignore the checkpoint (the script clears it itself
   on a clean finish) and fold its match count into the Step 4 summary.

Capture both passes' output summaries (offers found / filtered / duplicates
/ new added) to show in the final report.

After both passes complete, run `node detect-reposts.mjs --summary` — it
flags roles re-listed 2+ times in the last 90 days from `data/scan-history.tsv`
(a churn/ghost-posting signal a single scan can't see on its own, since it
only ever looks at "is this URL new," not "have I seen this same role
before"). This has never been wired into any mode before now despite being a
documented feature — fold any flagged rows into the Step 4 summary as a
caution note next to the relevant entries, not a blocker.

## Step 2 — Pipeline

Before running `modes/pipeline.md`, count the surviving "Pending" entries in
`data/pipeline.md` (after the liveness sweep). Pass B routinely nets far more
matches than a targeted scan, so this count needs an explicit check every
time, not just when it "looks big":

- **Read `spend_tier` from `config/profile.yml`, and check `modes/_custom.md`
  for a pre-screen override.** On `economy` tier, `pipeline.md`'s pre-screen
  gate is a no-op *by default* — every surviving URL goes straight to a full
  A-F evaluation, uncapped. `_custom.md` may already force the standard-tier
  gate to apply regardless of tier (a documented budget-conscious override) —
  if so, the volume risk below is already mitigated and there's nothing
  further to do here. If no such override exists and the pending count is
  large (more than ~25) on `economy` tier, this is where a normal mode would
  pause to confirm — **but check `_custom.md` first**: a "no stop-and-ask,
  run continuously" house rule means don't pause here even for a large batch;
  process it in full and report the scope in the Step 4 summary instead.
  Only pause and ask if `_custom.md` doesn't already answer this (or doesn't
  exist) — never ask when a standing instruction already covers it.
- **Liveness sweep throttle:** if the pending count exceeds ~20, always pass
  `--throttle` to `check-liveness.mjs` — don't leave this to per-run
  judgment.
- **Parallel subagent fan-out.** `pipeline.md`'s "3+ pending URLs → launch
  agents in parallel" has no upper bound, and a strict "sequential only, one
  subagent at a time" house rule (if `_custom.md` sets one, without cycle's
  documented exception — see the top of this file) would make evaluating a
  100+-entry sweep result impractically slow layered on top of Pass B's own
  multi-hour runtime. This file's documented exception (recorded in
  `_custom.md`, confirmed 2026-08-04) authorizes processing in waves of at
  most **8 concurrent subagents** *specifically for `cycle`*: launch a wave,
  wait for all of it to finish, launch the next wave, and so on until the
  pending list is exhausted. A normal `/career-ops pipeline` call must still
  follow the sequential rule exactly — this exception is scoped to `cycle`
  only, per its own recorded terms.
- **Pin each wave's subagents to the resolved spend tier's model explicitly**
  — resolve `spend_tier` once (per `modes/_shared.md`'s Spend Tier table) and
  pass it as the `model` parameter on every `Agent(...)` call in the wave,
  rather than leaving each subagent to read `config/profile.yml` and
  self-select. Both should agree, but pinning it at dispatch time is the more
  reliable enforcement point (the orchestrator already knows the tier before
  spawning) and keeps 8-wide waves on the cheapest tier from silently costing
  more than intended.
- **Tracker writes go through TSV, never a direct edit to
  `data/applications.md`.** This is a system-wide rule (`modes/_shared.md`'s
  ALWAYS list), not just a `_custom.md` preference: write each result to
  `batch/tracker-additions/{num}-{company-slug}.tsv` (per the format in
  `AGENTS.md`), the same as any other pipeline evaluation. `cycle` does not
  change this — Step 3 and Step 4 below read from the TSVs it produces, not
  from `data/applications.md`, precisely because this run's results are not
  expected to be merged into the tracker yet.
- **For wave-dispatched subagents: embed the concrete PDF-generation commands
  in the subagent dispatch prompt.** When a URL clears `auto_pdf_score_threshold`
  and `cv.output_format` is `"latex"` (read from `config/profile.yml`), the
  subagent's own prompt must inline the full two-command chain, not just point
  to "run modes/latex.md". Give it the explicit commands:
  1. Build the tailored JSON payload from this report + cv.md, write to `/tmp/cv-{candidate}-{company}.json`
  2. `node build-cv-latex.mjs /tmp/cv-{candidate}-{company}.json output/{num}-{company}-{YYYY-MM-DD}.tex`
  3. `node generate-latex.mjs output/{num}-{company}-{YYYY-MM-DD}.tex output/{num}-{company}-{YYYY-MM-DD}.pdf`
  
  This prevents the subagent from losing the thread and improvising a fallback.

Execute `modes/pipeline.md` (liveness sweep, pre-screen gate, per-URL
evaluation) with the fan-out and tracker-write handling above. Each processed
URL already gets its report + TSV tracker line, and a PDF if its score
clears `auto_pdf_score_threshold` (default `3.0`) — so most of "PDF for top
jobs" already happens here, inline, per URL.

**Wait for every wave — including all of its parallel subagents — to
actually finish** before moving to Step 3. Step 3 depends on this run's TSV
files being complete; starting it while a wave is still writing will miss or
duplicate entries.

If Step 1 found zero new offers, skip straight to Step 2's liveness sweep —
there may still be unprocessed entries left over in `data/pipeline.md` from
before this run.

## Step 3 — Top-match PDF safety net

Don't rely on Step 2's narrated summary table to decide what needs a PDF — at
cycle-scale volume that text can be long, reformatted inconsistently across
parallel subagents, or thinned by conversation compaction. Read this run's
`batch/tracker-additions/*.tsv` files directly instead (ground truth Step 2
just finished writing — not `data/applications.md`, which won't reflect this
run until someone runs `merge-tracker.mjs`, deferred or not per the note
above) and find every TSV row from this run that:
- scored `>= auto_pdf_score_threshold` (the same threshold Step 2 used — a
  "top job" here means one that already qualified for a PDF — column 6, the
  `X.X/5` cell), **and**
- shows PDF ❌ (column 7 — generation was skipped, errored, or Playwright was
  unavailable to the worker that processed it).

For each one, read `config/profile.yml` and check `cv.output_format`:
- If `"latex"`, run `modes/latex.md` against its report. The "Non-interactive invocation" subsection there gives the concrete path. **Important:** run the `generate-latex.mjs` compile step **inline in this orchestrator's own Bash commands**, not delegated to a further subagent — environment/PATH differences between subagent shells and the main session can cause spurious "LaTeX engine not found" failures even when tectonic is installed on the host.
- Otherwise (default), run `modes/pdf.md` against its report

This is the net that catches parallel-subagent PDF failures Step 2
itself couldn't retry.

If nothing qualifies, skip this step silently — do not generate PDFs for
entries that never cleared the threshold.

## Resilience — if a run gets interrupted

A `cycle` run can span hours; don't treat an interruption (crash, closed
session, machine sleep, hit a usage limit) as a failed run needing a restart
from scratch. Recovery is just re-running `/career-ops cycle`:
- Pass B resumes itself from `data/cache/ats-full-checkpoint.json` if it
  didn't finish.
- Pass A is naturally idempotent (dedup against `scan-history.tsv`).
- Step 2 only ever sees what's still under "Pending" in `data/pipeline.md` —
  anything already moved to "Processed" (report + TSV tracker line written)
  is never re-evaluated.
- Step 3 only looks for rows still missing a PDF, so it can't double-generate
  one.

Say this explicitly to the user if a run does get interrupted, so they know
re-running is safe and cheap rather than starting over.

## Step 3.5 — Tracker merge decision

Every result from this run so far lives in `batch/tracker-additions/*.tsv`,
not `data/applications.md` (see Step 2's tracker-write note). Whether that
stays that way depends on `modes/_custom.md`:

- **`_custom.md` states a deferred-merge preference** (e.g. "do NOT run
  `merge-tracker.mjs` until explicitly told to") → leave the TSVs unmerged.
  Report the count waiting in the Step 4 summary and remind the user to run
  `node merge-tracker.mjs` when ready. This is not a partial failure — it's
  the requested behavior.
- **No such preference is recorded** (default) → run `node
  merge-tracker.mjs` now, so `data/applications.md` reflects this run
  immediately and the deliverable (Step 5) is describing the current, real
  tracker state rather than something the user still has to go merge by hand.

## Step 3.6 — Integrity pass

Two more zero-token checks, cleanup rather than pre-flight, run after the
merge decision and before summarizing. If Step 3.5 merged, these now cover
this run's own new rows too — that ordering is deliberate.

1. **`node sync-pdf-flags.mjs`** — reconciles the tracker's PDF column
   against `data/pdf-index.tsv` (the canonical PDF↔report manifest). Step 2's
   wave-batched parallel subagents and Step 3's safety net both write PDFs
   and tracker rows independently; a race between "PDF file written" and
   "tracker cell updated" can leave a stale ❌ next to a PDF that actually
   exists. This self-heals it rather than leaving the user to notice and
   wonder why a PDF that clearly exists shows as missing.
2. **`node verify-pipeline.mjs`** — the standard pipeline health check
   (broken report↔tracker links, stale report-number reservations, etc.).
   This is normally a manual command; running it automatically here catches
   an integrity problem from a `cycle`-scale run (many parallel writers) the
   same day instead of it surfacing as confusion days later. Fold any issues
   it reports into the Step 4 summary — don't silently swallow them.
3. **`node reserve-report-num.mjs --gc`** — releases any report-number
   reservation sentinels left behind by a crashed or abandoned worker (the
   same class of leak that produced 104 stray `{num}-RESERVED.md` files in
   `reports/` on 2026-08-04, cleaned up by hand after the fact). Cheap,
   zero-token, safe to run even when nothing needs collecting. Fold the
   collected count into the Step 4 summary the same way as the other two
   checks — omit the line entirely if zero.

## Step 4 — Summary

**Every `N` below is counted fresh from `data/pipeline.md`, `batch/tracker-additions/*.tsv`, and
`reports/` at the moment this summary is written** — never reused from earlier narration in this
run, including your own (Guardrail 4). Print one consolidated report:

```
career-ops cycle — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pre-flight: portals.yml valid, N URLs reconciled from batch/batch-state.tsv
Scan (tracked):  N offers found → N new added to pipeline.md (N duplicates, N filtered, N expired)
Scan (full ATS): N companies swept, N matches found → N new added (N duplicates) [+ resumed Nx if interrupted]
Reposts flagged: N (churn/ghost-posting signal — see notes below)
Pipeline:  N URLs processed → N pre-filtered (no fetch — metadata pre-filter), N reports written,
           N discarded (pre-screen, after fetch), N inaccessible
Tracker:   N TSV rows written → merged into data/applications.md
           [or: N TSV rows written, unmerged per _custom.md — run `node merge-tracker.mjs` when ready]
PDFs:      N generated inline (Step 2) + N generated by the safety net (Step 3) = N total
Integrity: N PDF flags reconciled, N stale reservation(s) released, N issue(s) from
           verify-pipeline.mjs [or "clean"]

Top matches (score >= {threshold}):
| # | Company | Role | Score | PDF | Recommended action |
|---|---------|------|-------|-------|-------|
...
```

This is the terminal/conversation report. Step 5 rebuilds the same counts as
a Discord embed rather than reusing this literal text — Discord doesn't
render markdown tables, and (see Step 5) the top-matches field there gets a
real link a plain table cell can't carry.

### Job digest

The embed's "Top matches" field is deliberately compact (`Company — Role —
Score/5 — pdf`) — a status line, not enough to act on. The user still needs,
per top match: what the role actually is, why it scored the way it did, and
the URL to apply — none of which fits in an embed field. Build a separate
file for this, `output/{YYYY-MM-DD}/cycle-digest.txt`, one section per top
match (same set as the PDF-eligible entries — same `auto_pdf_score_threshold`
filter, so this file and the PDFs always cover identical roles).

Plain text, not markdown — Discord shows an attached file's inline preview
as raw text, not rendered markdown, so `##`/`**` syntax shows up as literal
clutter (confirmed live: a `.md` version rendered `**Score:**` with the
asterisks visible). Use plain lines and a dash divider instead:

```
{Company} — {Role}
Score: {X.X}/5
Apply: {the job's own URL, from the report's **URL:** line}
Why it fits: {1-3 sentences summarizing the report's own fit rationale —
condense the report's Block B / "Quick Fit" / closing verdict, never invent
a reason the report didn't give}
Report: reports/{num}-{slug}-{date}.md
PDF: {local path from Step 2/3}

────────────────────────────
```

Read each entry's report file (already written by Step 2/3) to pull the URL
and fit rationale — don't re-derive either from the TSV, which doesn't carry
them. This is a straight condense-and-copy from the report's own language,
same non-fabrication rule as everywhere else in this system: if the report
didn't say it, the digest doesn't either.

Source the top-matches table from this run's TSVs (Step 3's data source),
not from `data/applications.md` — even after a Step 3.5 merge, reading the
same TSVs you already parsed is simpler and cannot drift from what Step 3
just acted on.

Skip a line entirely when its count is zero (e.g. no reposts flagged, no
reconciliation needed) rather than printing a row of zeros — the summary
should stay short on a clean run, not grow with checks that found nothing.

Do not repeat the full per-URL detail already shown by Step 2 — this is a
roll-up, not a re-print.

## Step 5 — Deliver (Discord + Telegram)

**Canonical delivery spec:** Read `modes/_custom.md` if it exists. If present, follow its "Discord Notifications" and "Telegram Notifications" sections exactly as written. If `modes/_custom.md` is missing or omits those sections, use the fallback implementation below.

### Fallback (if `modes/_custom.md` is absent or silent)

**Discord:**
1. If Discord plugin is not configured (`node plugins.mjs list`) or `DISCORD_WEBHOOK_URL` is missing from `.env`, skip Discord delivery and log it in the final report.
2. Collect PDF paths from Step 2 (inline) + Step 3 (safety net) for entries scoring `>= auto_pdf_score_threshold`.
3. Send a plain-text message per `_custom.md`'s Discord Notifications Phase 1 (for every match ≥3.5, send tier marker, company, role, score, URL, one-line reason; split if message exceeds ~2000 chars).
4. Attach all PDFs in chunks of ≤10 files per message, labeled `"Resumes 1/N"`, `"Resumes 2/N"`, etc.
5. Skip if zero qualifying matches.

**Telegram:**
Same as Discord: plain-text digest for all matches ≥3.5, followed by PDF attachments. Skip if zero qualifying matches or Telegram plugin not configured.

### Notes on consistency

Both Discord and Telegram use the same plain-text format and thresholds here, removing the divergence between `cycle.md`'s old embed spec and `_custom.md`'s plain-text spec. Every run now routes to the same delivery code regardless of entry point (`pipeline`, `cycle`, `telegram` mode, or `batch`).
