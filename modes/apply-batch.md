# Mode: apply-batch — Batch Apply to Evaluated Keepers

Runs `apply` mode's fill-and-review flow across every currently-eligible tracker row, one at a time, so the candidate can clear a backlog of ready applications in one sitting instead of invoking `apply` per role. It never submits anything itself — the review-before-submit gate is identical to `apply` mode's, per role.

## Requirements

Same as `apply` mode: Playwright in visible mode. This mode has no manual/screenshot fallback — there's no screen to screenshot for a role you haven't opened yet.

**`[HEADLESS]` invocation, outside `modes/telegram.md`'s wrapper:** same hard rule as `apply` mode — every checkpoint below (Step 2's batch go-ahead, and each row's field-approval/submit-approval inside `apply` mode's own flow) is a genuine gate, never a stall to route around. `modes/telegram.md` already converts these into Telegram messages + pending confirmations for its own callers. A bare headless invocation with no Telegram/live-chat context to answer must refuse immediately — report that `apply-batch` requires interactive or Telegram-mediated approval and stop, rather than guessing at any checkpoint.

## Source of truth

`data/applications.md` (the tracker) is the only source. **Never** `output/cycle-keepers/` or any similar one-off digest — those aren't part of career-ops's documented output contract (see `AGENTS.md`'s Main Files table) and can silently go stale. If a `cycle-keepers`-style summary exists from a prior run, ignore it; recompute eligibility fresh from the tracker every time this mode runs.

## Workflow

### Step 1 — Resolve the candidate set

Read `data/applications.md`. A row qualifies when **all** of the following hold:

1. `Status` == `Evaluated` — not `Applied`, `Responded`, `Interview`, `Offer`, `Hired`, `Rejected`, `Discarded`, or `SKIP`. Applying to a row already past this stage is exactly the double-submission mistake `apply` mode's own cross-channel/repeat-application checks exist to catch — filtering it out here means those checks never even have to fire on a stale row.
2. `Score` >= `auto_pdf_score_threshold` from `config/profile.yml` (default `4.0` if unset) — the same bar as the ethical-use rule in `AGENTS.md`: *"Below 4.0/5, explicitly recommend against applying."*
3. The linked report's `**URL:**` resolves to Greenhouse, Lever, or Workday — match the hostname the same way `detectVendor()` in `analyze-patterns.mjs` does (`*.greenhouse.io`, `jobs.lever.co`/`*.lever.co`, `*.myworkdayjobs.com`/`*.myworkdaysite.com`). Anything else (Ashby, Workable, unknown/custom ATS) is out of scope for this mode — list it separately as "supported by `apply` mode directly, not by batch" rather than silently dropping it.
4. The linked report file's mtime is **not older than** `cv.md`, `config/profile.yml`, or `modes/_profile.md` — the same freshness guard as `apply` mode's Step 5e. A row that fails only this check is not silently skipped: list it separately as "needs re-evaluation against the current CV/profile before it can be applied to," with the specific file(s) that changed and when.

### Step 2 — Present before touching a browser

One line per qualifying row: report #, company, role, score, ATS. A second list for rows excluded only by the freshness guard (re-evaluation candidates). A third list for rows matching 1-2 but on an out-of-scope ATS. Wait for the candidate's go-ahead — or a trimmed subset ("skip #710, do the rest") — before opening a single tab. This is the one consolidated checkpoint for the whole batch; nothing below asks a batch-level question again.

### Step 3 — Process each qualifying row, highest score first

For each row:

1. Navigate to the report's `**URL:**` with Playwright.
2. Run `apply` mode's full workflow against it (Steps 1 through 8: preflight gates, knock-out scan, immigration/prohibited-content checks, boilerplate-defaults cache, generate, fill via Step 7b, present).
3. **Stop at the same review-before-submit gate `apply` mode always stops at.** Show the filled form or response summary, wait for explicit candidate approval, and let the candidate click Submit themselves. `apply-batch` changes nothing about this gate — it only chains the setup work across rows.
4. On candidate confirmation of submission, run `apply` mode's Step 9 (`set-status.mjs ... Applied`, `followup-seed.mjs`) before moving to the next row.
5. On candidate decline for this row, leave its tracker row untouched and move on — never auto-mark it `Discarded`; that inference is the candidate's call, not this mode's.
6. If `apply` mode's Step 5 preflight surfaces a blacklist hit, a company/role mismatch, or a closed posting for a row, treat it the same way `apply` mode would (stop, ask, or skip per that step's own rules) and continue to the next row afterward rather than aborting the whole batch.

### Step 4 — End-of-batch summary

One line each, omitted when zero:
```
Applied:              N
Skipped (candidate):  N
Needs re-evaluation:  N (freshness guard — list report #s)
Out of scope (ATS):   N (list report #s + vendor)
```

## What this mode never does

- Never submits an application — identical rule to `apply` mode, per `AGENTS.md`'s ethical-use section.
- Never processes a row outside Greenhouse/Lever/Workday. Ashby, Workable, and unknown ATSs have documented quirks in `apply` mode's Known ATS Quirks section, but aren't wired into this batch runner yet.
- Never treats `output/cycle-keepers/` or any similar ad hoc digest as a source of eligible rows.
- Never applies to a row whose linked report predates `cv.md` / `config/profile.yml` / `modes/_profile.md` without the candidate explicitly overriding that row's Step 5e gate.
- Never infers a skip as a `Discarded` status change.
