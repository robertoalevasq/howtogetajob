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

**Read `_custom.md` before starting, if it exists — cycle must not
silently override the user's own house rules.** `_custom.md`'s "No-subagent
inline processing for bulk pipeline evaluation" House Rule governs `cycle`
unconditionally — it explicitly covers cycle's pipeline step, and the same
inline-only approach applies to Step 1's scan pass too (see Step 1 below). No
exception exists, none is negotiated at runtime, and nothing here asks the
user about parallelism. Everything else in `_custom.md` without a documented
exception governs `cycle` exactly as it governs every other mode — in
particular, a "no stop-and-ask, run continuously" rule and a "defer tracker
merge" rule are *followed*, not overridden, in Step 2 and the tracker-write
note below.

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
   (folded into the Step 4 summary, never a blocker), a single URL's PDF failure during Step 2
   (Step 3's safety net exists for exactly this). Log it, move to the next checkpoint, keep going.
2. **Never ask the user a question `_custom.md` already answers.** Before asking anything mid-run,
   check: does the no-stop-and-ask rule cover this? Does the deferred-merge rule cover this? Only
   ask if neither does.
3. **Never hand-troubleshoot a broken script mid-run** (ad hoc `curl`, hand-editing a state file,
   improvising a new diagnostic flow). If a scripted step fails, its own failure handling (retry,
   log, skip) is the full extent of the response — not a new one you invent in the moment. This
   explicitly includes Discord/Telegram delivery: always `node core/plugins.mjs run <discord|telegram>
   notify ...` (see `_custom.md`'s Discord/Telegram Notifications sections), never a raw `curl` call
   improvised because a `plugins.mjs` call failed or "felt" incomplete.
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

Three cheap, zero-token checks before spending any time on Step 1:

1. **`node core/cycle-lock.mjs acquire`** — run this FIRST, before anything else. Parse the JSON result:
   - `{"acquired": true}` → continue to the checks below.
   - `{"acquired": false, ...}` → **stop the run entirely, right here.** Do not run the other pre-flight checks, do not start Step 1. Report clearly (in the terminal, and via the same delivery channel that triggered this run if headless — e.g. a short Telegram/Discord note): a cycle is already in progress (include `startedAt` from the JSON), this trigger is being skipped to avoid duplicate work and duplicate notifications. This is the deterministic version of what an ad hoc run once did by chance after noticing overlapping state — added 2026-08-13 after two independent cycle invocations ran concurrently, swept the same ~39K companies, and delivered duplicate Discord/Telegram notifications for the same matches.
2. **`node core/validate-portals.mjs`** — structural validation of `portals.yml`
   (schema/shape, no network calls). If it fails, stop here and report the
   specific errors — scanning against a broken config wastes the whole run
   on results from whatever partially-parsed config survived.
3. **`node core/reconcile-pipeline.mjs`** — syncs any URLs already evaluated via
   `/career-ops batch` (which writes to `data/batch-state.tsv` but never
   back to `data/pipeline.md`) into `data/pipeline.md`'s "Processed" section.
   Skip this without it and a URL you already batch-evaluated between `cycle`
   runs gets re-surfaced by Pass A/B and evaluated a second time — a wasted
   duplicate report and tracker row. Cheap and safe to run even when nothing
   needs reconciling (no-ops with a `0 reconciled` result).

**Release the lock whenever this run stops being `cycle`'s to hold** — at the very end of Step 5 on a normal completion, or immediately if Step 0/1/2 stops the run early for any reason (a validate-portals failure, a Pass B stall that still lets the run continue to Step 2, etc. — anywhere the run keeps going, keep the lock; anywhere it truly ends, release it: `node core/cycle-lock.mjs release`). If a run crashes hard enough to skip even that, the lock self-heals after 30 minutes of no refreshes (see Progress Reporting below) — no manual cleanup needed.

## Progress reporting (status file + Discord) — start this right after Step 0

`cycle` can run for hours. Two layers of visibility, both driven by scripts rather than hand-built
per checkpoint, so neither can go permanently silent the way the old hand-built Discord convention
did:

**This section is Discord-only supplementary reporting — it is not where Telegram's initial kickoff
message comes from.** When `cycle` runs via `modes/telegram.md`'s Step 3a, that step's own item 1
(a standalone `telegram notify` call, sent before this file is even read) is Telegram's entire
presence until Step 5's final delivery — nothing here sends anything to Telegram mid-run, by design.
If invoking `cycle` from `modes/telegram.md`, confirm that step 1 already ran before treating the
run as started.

- **`data/cache/cycle-status.json`, via `cycle-status.mjs`** — the fine-grained, always-on record.
  Updated at *every* checkpoint below with no throttling (it's a local file write behind a short
  lock, effectively free — no network, no rate limit exposure). Check it anytime from the terminal
  with `node core/cycle-status.mjs` (human-readable) or `node core/cycle-status.mjs --json`. `update()` never
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

1. **Right after Step 0 passes**, start both fresh: `node core/cycle-status.mjs reset` and
   `node core/discord-ticker.mjs reset` (clears any stale state from a previous interrupted run).
2. Update `cycle-status.mjs` at *every* checkpoint listed below — write a small JSON patch to a
   scratch file (`{"step": {"id": "...", "label": "..."}, "counters": {...}}`, only the fields that
   changed) and run `node core/cycle-status.mjs update --file <patch-path>`.
3. **Also run `node core/cycle-lock.mjs refresh` at every one of the same checkpoints** — this is what
   keeps the Step 0 lock from being reclaimed as stale (30 min with no refresh) during a long-running
   pass. The checkpoint cadence below already fires far more often than that, so a healthy run never
   comes close to the staleness window; this is purely upkeep, not a step that can meaningfully fail.
4. Tick `discord-ticker.mjs` only at the **Discord-throttled** checkpoints marked below — write the
   embed JSON to a scratch file and run `node core/discord-ticker.mjs tick --embed-file <scratch-path>`.
5. On the run's last checkpoint: `cycle-status.mjs` gets `step.id: "done"`; `discord-ticker.mjs`
   gets one final tick with a short completion marker — title `"✅ career-ops cycle — complete"`,
   description `"Full report below."`, color `"#57F287"` (green; the detailed report still goes out
   separately via Phase 1 in Step 5 — don't cram the full Step 4 summary into this message). Use
   `"#FEE75C"` (yellow) instead of green if Step 3.6's integrity pass found issues, so the ticker
   itself flags it before anyone opens the summary. Then `node core/cycle-lock.mjs release` — the run is
   over, the lock's job is done.
6. **Call cycle-status.mjs and discord-ticker.mjs unconditionally at every checkpoint they're due,
   regardless of whether the previous call reported success or failure.** Neither failure is fatal,
   and neither is grounds to stop trying at future checkpoints (Guardrails 1 and 5 above) — each call
   is an independent attempt, so a transient outage self-recovers on its own.

**Checkpoint moments:**
- Pass A complete → `cycle-status` update (offer counts) + Discord tick ("Pass B starting")
- Each Pass B checkpoint (every 500 companies, same cadence as the script's own
  `data/cache/ats-full-checkpoint.json` writes) → `cycle-status` update (companies swept so far /
  total, matches found so far) + Discord tick, same content
- Pass B complete (incl. repost detection) → `cycle-status` update + Discord tick (total new
  offers, reposts flagged, "Pipeline starting (N pending)")
- **During Step 2** → `cycle-status` update every 25 URLs processed (URLs done / total pending — this
  is the fine-grained truth). **Discord tick only every 75 URLs** (always including the first and the
  last) — on a large pending count that's still frequent enough to show movement without spamming;
  anyone checking from their phone only needs coarse movement, and `cycle-status.json` carries the
  finer-grained detail for anyone at a terminal.
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

Execute `modes/scan.md` in full **inline, in this orchestrating turn — do not
delegate it to an `Agent(...)` subagent.** `scan.md`'s own "Recommended
Execution" section suggests background-subagent delegation to protect a
*smaller interactive* session's context window; `cycle` is already the large
orchestrating context for the whole run, so there's nothing to protect, and a
headless/Telegram-triggered `cycle` invocation has no permission path for an
unreviewed `Agent` call to begin with (same reasoning as Step 2's inline-only
rule). This covers `tracked_companies` and `search_queries` from
`portals.yml` and appends any new offers to `data/pipeline.md`.

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
completion yourself — the user should never need a second terminal.

**Step 2 does not start until Pass B reaches one of exactly two end states: full
completion, or the stall-exit in point 4 below. There is no third option.**
A Pass B that is still healthily progressing — checkpoint advancing, however
slowly, however many hours in — is never grounds to move on early. (Confirmed
2026-08-12: a real run moved to Step 2 while Pass B was at 68% and still
advancing. That was a bug, not a sanctioned shortcut — this section exists to
close it.)

1. Check whether `data/cache/ats-full-checkpoint.json` exists.
   - Exists (an earlier sweep was interrupted) → run
     `node core/scan-ats-full.mjs --resume`
   - Absent → run `node core/scan-ats-full.mjs` (fresh sweep, default `--since 3`
     window unless the user asked for a wider one)
2. Launch it as a background shell process (not a blocking foreground call)
   so you can keep narrating progress instead of going silent for hours —
   **but "not a blocking foreground call" describes how you launch the
   process, not whether you wait for it.** You still block on it finishing
   before Step 2 begins; only the narration/progress-reporting stays live in
   the meantime.
3. Poll it periodically. If it exits before reporting completion (crash,
   network failure, resolver outage) and the checkpoint file is still
   present, re-run with `--resume` automatically. Repeat until it reports
   completion. **Each time you poll and see `data/cache/ats-full-checkpoint.json`
   has crossed a new 500-company boundary since your last tick, stop and run
   the "Each Pass B checkpoint" update from Progress reporting above —
   `cycle-status.mjs` + `discord-ticker.mjs tick` — before continuing to
   poll.** That section defines the cadence; this is the step where it
   actually has to fire. Skipping it here is exactly what goes silent for
   the rest of a multi-hour run (confirmed 2026-08-15: a live run swept
   3,000+ companies with zero cycle-status or Discord updates because this
   loop never called back to it).

   **"Poll it periodically" means repeated tool calls inside this same,
   still-open turn — never a sent response you expect to "come back to."**
   In a headless dispatch (`[HEADLESS]` present — see AGENTS.md's Headless
   Invocation Signal, which every `/run` through `telegram.md` Step 3a is)
   there is no next turn: a `claude -p` invocation ends the process the
   moment a response is sent, and whatever the background sweep was doing
   ends with it, whether or not it finished. Confirmed live 2026-08-28: a
   real `/run` did everything else in this section correctly — right ATS,
   right checkpoint cadence, real Discord ticks — then, mid-sweep, sent a
   response reading *"Ticked. Continuing to wait for the next Pass B
   checkpoint or completion notification."* That sentence is itself the
   bug: it is a promise to come back that a one-shot process cannot keep.
   The sweep never checkpointed again; `/status` reported it dead an hour
   later; nothing else in this run ever ran. **Do not send a response,
   partial summary, or "still working" message while Pass B is
   incomplete.** If a tick or a progress narration is worth recording, say
   it via `discord-ticker.mjs`/`cycle-status.mjs` (files, not your own
   response) and immediately make the next polling tool call in the same
   turn — the turn stays open until step 4's exit condition or full
   completion, full stop.
4. **The only early-exit condition:** if two consecutive resumes land on the
   exact same checkpoint position (genuinely zero forward progress, not
   merely "still running"), give up on Pass B gracefully. Log the last error
   output and the checkpoint position to the Step 4 summary, stop the resume
   loop, and continue the run with whatever Pass B already swept. Diagnosing
   the stall (narrowing `--ats`/`--since`, investigating the network/resolver
   issue) happens in a separate session after the run, per the Guardrails
   above — it is never grounds to pause mid-run and wait for a decision, and
   it is the *only* condition (alongside full completion) under which Step 2
   may begin.
5. On completion, delete/ignore the checkpoint (the script clears it itself
   on a clean finish) and fold its match count into the Step 4 summary.

Capture both passes' output summaries (offers found / filtered / duplicates
/ new added) to show in the final report.

After both passes complete, run `node core/detect-reposts.mjs --summary` — it
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

- **Read `spend_tier` from `config/profile.yml`, and check `_custom.md`
  for a pre-screen override.** On `economy` tier, `pipeline.md`'s pre-screen
  gate is a no-op *by default* — every surviving URL goes straight to a full
  A-F evaluation, uncapped. `_custom.md` may already force the standard-tier
  gate to apply regardless of tier (a documented budget-conscious override) —
  if so, the volume risk below is already mitigated and there's nothing
  further to do here.
- **Never pause here for a large pending count.** `_custom.md`'s "no
  stop-and-ask, run continuously" house rule covers this unconditionally —
  absence of an explicit override is not grounds to stop and ask. Process the
  full backlog and report the scope (including how large it was) in the Step
  4 summary.
- **Liveness sweep throttle:** if the pending count exceeds ~20, always pass
  `--throttle` to `check-liveness.mjs` — don't leave this to per-run
  judgment.
- **No subagent fan-out — process inline, sequentially.** Per `_custom.md`'s
  "No-subagent inline processing for bulk pipeline evaluation" House Rule,
  which explicitly covers `cycle`'s pipeline step: evaluate the pending
  backlog directly in this orchestrating turn, one URL at a time, with no
  `Agent(...)` calls. This is a deliberate token-cost and headless-reliability
  tradeoff (no per-URL context-load repeat, and a headless/Telegram-triggered
  run has no permission path for an unreviewed `Agent` call) — sequential
  processing on a large sweep is expected to take a while; that is fine.
  `pipeline.md`'s own "3+ pending URLs → launch agents in parallel" text does
  not apply here — see the corrected note in `modes/pipeline.md`.
- **Resolve `spend_tier` once, at the start of Step 2**, per
  `modes/_shared.md`'s Spend Tier table, and use it for every inline
  evaluation this step performs.
- **Tracker writes go through TSV, never a direct edit to
  `data/applications.md`.** This is a system-wide rule (`modes/_shared.md`'s
  ALWAYS list), not just a `_custom.md` preference: write each result to
  `batch/tracker-additions/{num}-{company-slug}.tsv` (per the format in
  `AGENTS.md`), the same as any other pipeline evaluation. `cycle` does not
  change this — Step 3 and Step 4 below read from the TSVs it produces, not
  from `data/applications.md`, precisely because this run's results are not
  expected to be merged into the tracker yet.
- **When a URL clears `auto_pdf_score_threshold` and `cv.output_format` is
  `"latex"`** (read from `config/profile.yml`), run the full two-command
  chain inline, right here, in this same turn — never point yourself at "run
  modes/latex.md" as a vague deferral:
  1. Build the tailored JSON payload from this report + `cv.md`, write to
     `.tmp/cv-{candidate}-{company}.json`.
  2. `node core/build-cv-latex.mjs .tmp/cv-{candidate}-{company}.json output/{num}-{company}-{YYYY-MM-DD}.tex`
  3. `node core/generate-latex.mjs output/{num}-{company}-{YYYY-MM-DD}.tex output/{num}-{company}-{YYYY-MM-DD}.pdf`

Execute `modes/pipeline.md` (liveness sweep, pre-screen gate, per-URL
evaluation) with the inline, sequential handling above. Each processed URL
already gets its report + TSV tracker line, and a PDF if its score clears
`auto_pdf_score_threshold` (default `3.0`) — so most of "PDF for top jobs"
already happens here, inline, per URL.

**Finish evaluating every pending URL** before moving to Step 3 — Step 3
depends on this run's TSV files being complete.

If Step 1 found zero new offers, skip straight to Step 2's liveness sweep —
there may still be unprocessed entries left over in `data/pipeline.md` from
before this run.

## Step 3 — Top-match PDF safety net

Don't rely on Step 2's narrated summary table to decide what needs a PDF — at
cycle-scale volume that text can be long, and a long inline run risks it being
thinned by conversation compaction. Read this run's
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

This is the net that catches individual PDF failures Step 2 itself couldn't
retry inline (a transient render error, a missing dependency at the moment
that URL was processed).

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

**The Step 0 lock (`cycle-lock.mjs`) self-heals — no manual cleanup needed, but there's a
timing note:** a hard crash skips the normal `release` call, so a restart attempted within 30
minutes of the crash will correctly see the lock as still held and skip, per Step 0's own
instructions — this is not a bug, it's the lock doing its job (a resumed run is genuinely the
same logical run, not a second concurrent one). If re-running right after a crash matters, either
wait out the 30-minute staleness window or run `node core/cycle-lock.mjs release` explicitly first —
but there's rarely a reason to rush this, since Pass B/Pass A/Step 2/Step 3's own resumability
above means nothing is lost by waiting.

Say this explicitly to the user if a run does get interrupted, so they know
re-running is safe and cheap rather than starting over.

## Step 3.5 — Tracker merge decision

Every result from this run so far lives in `batch/tracker-additions/*.tsv`,
not `data/applications.md` (see Step 2's tracker-write note). Whether that
stays that way depends on `_custom.md`:

- **`_custom.md` states a deferred-merge preference** (e.g. "do NOT run
  `merge-tracker.mjs` until explicitly told to") → leave the TSVs unmerged.
  Report the count waiting in the Step 4 summary and remind the user to run
  `node core/merge-tracker.mjs` when ready. This is not a partial failure — it's
  the requested behavior.
- **No such preference is recorded** (default) → run `node
  core/merge-tracker.mjs` now, so `data/applications.md` reflects this run
  immediately and the deliverable (Step 5) is describing the current, real
  tracker state rather than something the user still has to go merge by hand.

## Step 3.6 — Integrity pass

Two more zero-token checks, cleanup rather than pre-flight, run after the
merge decision and before summarizing. If Step 3.5 merged, these now cover
this run's own new rows too — that ordering is deliberate.

1. **`node core/sync-pdf-flags.mjs`** — reconciles the tracker's PDF column
   against `data/pdf-index.tsv` (the canonical PDF↔report manifest). Step 2's
   inline per-URL processing and Step 3's safety net both write PDFs
   and tracker rows independently; a race between "PDF file written" and
   "tracker cell updated" can leave a stale ❌ next to a PDF that actually
   exists. This self-heals it rather than leaving the user to notice and
   wonder why a PDF that clearly exists shows as missing.
2. **`node core/verify-pipeline.mjs`** — the standard pipeline health check
   (broken report↔tracker links, stale report-number reservations, etc.).
   This is normally a manual command; running it automatically here catches
   an integrity problem from a `cycle`-scale run (many parallel writers) the
   same day instead of it surfacing as confusion days later. Fold any issues
   it reports into the Step 4 summary — don't silently swallow them.
3. **`node core/reserve-report-num.mjs --gc`** — releases any report-number
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
Pre-flight: portals.yml valid, N URLs reconciled from data/batch-state.tsv
Scan (tracked):  N offers found → N new added to pipeline.md (N duplicates, N filtered, N expired)
Scan (full ATS): N companies swept, N matches found → N new added (N duplicates) [+ resumed Nx if interrupted]
Reposts flagged: N (churn/ghost-posting signal — see notes below)
Pipeline:  N URLs processed → N pre-filtered (no fetch — metadata pre-filter), N reports written,
           N discarded (pre-screen, after fetch), N inaccessible
Tracker:   N TSV rows written → merged into data/applications.md
           [or: N TSV rows written, unmerged per _custom.md — run `node core/merge-tracker.mjs` when ready]
PDFs:      N generated inline (Step 2) + N generated by the safety net (Step 3) = N total
Integrity: N PDF flags reconciled, N stale reservation(s) released, N issue(s) from
           verify-pipeline.mjs [or "clean"]

Top matches (score >= {threshold}):
| # | Company | Role | Score | PDF | Recommended action |
|---|---------|------|-------|-------|-------|
...
```

### Stray-file check (cheap, non-blocking — flags, never deletes)

One more zero-token check before summarizing: `git status --porcelain -uall -- . ':!reports' ':!output' ':!data' ':!jds' ':!archive' ':!batch' ':!.tmp'` — these seven directories are the documented data contract's own working areas and are expected to have untracked content; everything else at repo root or elsewhere is not. Any `??` line this returns is something unexpected sitting outside the data contract — exactly the kind of file a future autonomous run could mistake for real config/instructions (see `_custom.md`'s Autonomous-Run Guardrails). Fold any hits into the summary as a one-line FYI (file count + names) — this step only flags, it never deletes anything itself; that decision stays with the user. Omit the line entirely if the check finds nothing.

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

**This step is unconditional — attempt it no matter what happened in Steps 1-4.** A crash, a partial evaluation, an interrupted Pass B, a Step 3.6 integrity finding — none of these are grounds to skip delivery. Collect whatever reports/PDFs/tracker rows actually exist on disk at this moment (same "read from disk, not memory" discipline as Guardrail 4, not what you expected to have produced) and deliver those. This mirrors how Progress Reporting is already decoupled from Steps 1-4 (Guardrail 5) — Step 5 gets the same treatment.

**Ground every delivery claim in a confirmed response, never in "the call didn't error."** `node core/plugins.mjs run <discord|telegram> notify ...` now prints whether each platform actually confirmed the send (file delivery count, failures, oversized files) — read that output before writing "Delivered via Discord/Telegram" in the Step 4 summary. A call that returns normally with `sent: false` (e.g. every file rejected as too large, every chat unreachable) is not a delivery; report it as a failure, not a success.

**Canonical delivery spec:** Read `_custom.md` if it exists. If present, follow its "Discord Notifications" and "Telegram Notifications" sections exactly as written. If `_custom.md` is missing or omits those sections, use the fallback implementation below.

### Fallback (if `_custom.md` is absent or silent)

**Discord:**
1. If Discord plugin is not configured (`node core/plugins.mjs list`) or `DISCORD_WEBHOOK_URL` is missing from `.env`, skip Discord delivery and log it in the final report.
2. Collect PDF paths from Step 2 (inline) + Step 3 (safety net) for entries scoring `>= auto_pdf_score_threshold`.
3. Send a plain-text message per `_custom.md`'s Discord Notifications Phase 1 (for every match ≥3.5, send tier marker, company, role, score, URL, one-line reason; split if message exceeds ~2000 chars).
4. Attach all PDFs in chunks of ≤10 files per message, labeled `"Resumes 1/N"`, `"Resumes 2/N"`, etc.
5. Skip if zero qualifying matches.

**Telegram:**
Same as Discord: plain-text digest for all matches ≥3.5, followed by PDF attachments. Skip if zero qualifying matches or Telegram plugin not configured.

### Notes on consistency

Both Discord and Telegram use the same plain-text format and thresholds here, removing the divergence between `cycle.md`'s old embed spec and `_custom.md`'s plain-text spec. Every run now routes to the same delivery code regardless of entry point (`pipeline`, `cycle`, `telegram` mode, or `batch`).
