# Mode: telegram — Remote Job Search via Telegram

Poll a Telegram bot for job-search commands and route them: run a full search cycle (scan every portal + the full ATS universe + evaluate every match + generate reports/PDFs), then apply to the results — one role or the whole eligible batch — with every approval (tailored resume, then field mapping, then submit) arriving as a Telegram reply instead of an interactive session, and every gate open to edit requests before it's approved. This file is a thin routing/confirmation layer over `cycle`, `apply`, and `apply-batch` mode's exact existing workflows; it never reimplements or weakens anything they already do, it only changes *where the human's answers come from*.

**HEADLESS.** Never use `AskUserQuestion` in this mode — every point where `cycle`/`apply`/`apply-batch` would normally ask the candidate something becomes a Telegram message + a pending confirmation instead, and this mode pauses until a reply resolves it (possibly a later poll cycle, possibly minutes or hours later).

**SLASH-ONLY (2026-08-15).** Every message that *starts* something new — a search, an apply, a PDF retrieval or edit — must be a recognized `/command`. Free-text phrase-matching ("search", "find jobs", "apply all" as plain sentences) is not an entry point into this mode; interpreting which of several similar phrases the candidate meant is exactly the ambiguity that risks misrouting a message and burning tokens on the interpretation itself. **The one exception** is a pasted job URL — that's a deterministic pattern match, not an interpreted phrase, so it still auto-triggers apply. **Replies to something already pending are the other exception** — once a `resume-approval`/`field-approval`/`submit-approval`/`edit-intent` confirmation is open, free text is expected and unambiguous, since it's scoped to that one pending item.

**IMPORTANT — Token optimization:** Do NOT poll this mode repeatedly through Claude Code. Use `telegram-monitor.mjs` instead — a headless entry point that polls Telegram without Claude (zero tokens on empty results) and invokes Claude routing only when messages arrive. See the [Scheduling section](#scheduling--minimal-claude-entry-point-zero-tokens-on-empty-polls) for setup via Windows Task Scheduler.

## First-Time Setup

Run once, before the first poll:

1. Check `.env` for `TELEGRAM_BOT_TOKEN`. If missing, walk the candidate through creating a bot:
   > 1. Open Telegram, search **@BotFather**. 2. Send `/newbot`. 3. Pick a display name. 4. Pick a username ending in `bot`. 5. Copy the token BotFather gives you. 6. Send your new bot any message so I can find your chat ID.
   Once they paste the token, write it to `.env` as `TELEGRAM_BOT_TOKEN=...` — never echo it back in chat, never write it anywhere else.
2. Look up the chat ID: `curl -s "https://api.telegram.org/bot{TOKEN}/getUpdates"`, extract `result[0].message.chat.id`. If empty, remind the candidate to message the bot first, then retry.
3. Ensure `config/plugins.yml` exists (`cp config/plugins.example.yml config/plugins.yml` if not). Set `telegram.enabled: true` and `telegram.chat_id: "{chat_id}"`.
4. Register the bot's "/" command menu: `node core/telegram-set-commands.mjs` — a curated list (`/run`, `/scan`, `/apply`, `/applyall`, `/pdf`, `/status`, `/settings`, `/help`), not the full recognized set (`/yes`/`/no`/`/skip`/`/cancel`/`/editpdf` still work typed, just aren't menu clutter). Safe/idempotent to re-run whenever the list changes.
5. Verify: `node core/plugins.mjs run telegram notify "👋 career-ops connected. Send /help to see everything I can do."` — confirm it arrives.
6. Create `data/telegram-state.md` from the template below if it doesn't exist.

## State — `data/telegram-state.md`

```markdown
# Telegram State

## Pending Confirmations
<!-- One block per pending item:
[msg_id: X] stage: resume-approval|field-approval|submit-approval|batch-approval|question|edit-intent|settings-menu|settings-edit — <short description> — waiting since <date>
  report: NNN
  job_url: https://...
  data: <stage-specific JSON — swapped-bullet list + candidate JSON path for resume-approval, field_mapping for field-approval, filled-form summary for submit-approval, question text for question (a Step 6c one-at-a-time field question additionally carries the loop's resolved/missed field list so far, so a resume knows what's already settled without re-deriving it; a Step 5-alt account-creation question instead carries a short marker — "awaiting account-creation consent", "awaiting verification", or "awaiting password paste-back" — so a resume lands on the right sub-step of that flow; for these three markers `data` is the marker string only, NEVER the generated password itself — the password is never written to this file, see `modes/apply.md` Step 5-alt item 7), eligible/excluded lists for batch-approval, empty for edit-intent; for `settings-menu`, `data` is empty — the numbered menu itself is the message already sent, nothing further to carry; for `settings-edit`, `data` is `{ field: "<location|work_mode|targeting|salary|sponsorship>", phase: "awaiting-answer"|"awaiting-confirmation", pending: <parsed-but-unwritten value, present only once phase is "awaiting-confirmation"> }` — `field` tells a resumed session which field the reply is answering without re-parsing the menu, and `phase` tells it whether this reply is the candidate's raw answer to the field-specific question (still needs parsing + a read-back) or their yes/correction reply to that read-back (see `modes/telegram.md` Step 3h #3 and #5) — collapsing both rounds into one `settings-edit` stage without this `phase` marker was a real bug (found live 2026-08-29): a bare `data: "location"` gave no way to tell a fresh field answer apart from a confirm-or-correct reply, so the second round's answer was silently misrouted back into the menu parser instead of being read as the location value it was>
  edit_count: <optional, omitted/0 by default — how many edit-loop rounds this item has been through, for audit only>
-->
(none)

## Batch Queue
<!-- Populated only during an active "apply all" batch. Report numbers remaining,
     highest score first. Empty outside a batch run. -->
(none)

## Recent Actions
<!-- Last 20, newest first: <date> — <what happened> — report NNN if applicable -->
```

User-layer, gitignored under `data/*` — never commit.

## Workflow (one poll cycle)

### Step 1 — Poll

`node core/telegram-poll.mjs poll` → JSON `{"messages":[...]}`. No new messages → exit silently, no Telegram send, no state write, no log entry. (This mode is meant to run on a recurring schedule — see Scheduling below — so a silent no-op cycle is the common case, not an error.)

### Step 2 — Classify each message

Every task-starting row below requires a recognized `/command` (`parseCommand()` in `telegram-poll.mjs`, which returns `{isCommand, command, args}`) — see the SLASH-ONLY note above for why. The two exceptions, a pasted job URL and a reply to something already pending, are marked below.

| Message | Detection | Route |
|---|---|---|
| `/run` or `/cycle` | recognized command | Step 3a: run full cycle |
| `/scan` | recognized command | run `modes/scan.md` directly |
| `/apply {url}` / `/apply {report#}` / `/apply` (no args) | recognized command | Step 3b: start apply — resolve `args[0]` per Step 3b's own resolution rule; no args → most recently discussed job |
| `/applyall` | recognized command | Step 3c: start batch apply |
| `/pdf {report#\|company}` / `/pdf` (no args) | recognized command | Step 3d: retrieve & send PDF |
| `/editpdf {report#\|company}` / `/editpdf` (no args) | recognized command | Step 3e: open an edit intent |
| `/status` | recognized command | Step 3f: report status |
| `/settings` | recognized command | Step 3h: view/edit profile settings |
| `/help` | recognized command | Step 3g: show help |
| `/yes` / `/no` / `/skip` / `/cancel` | recognized command | routes exactly like the equivalent standalone word in the Confirmation reply row below — **declines whatever's currently pending only; it has no way to interrupt a `/run`/`/applyall`/`apply` turn already in progress**, since that's one long-lived dispatch that isn't polling for new messages until it ends |
| Job URL | contains a job-posting URL pattern (Greenhouse/Lever/Workday/Ashby/etc.) — **the one non-slash exception**, since it's a deterministic pattern match, not an interpreted phrase | Step 3b: start apply |
| Confirmation reply | a **threaded reply** (`replyToMessageId` matches a pending confirmation's message id), OR a standalone `yes`/`y`/`go`/`no`/`skip`/`cancel` when exactly one confirmation is pending, OR **free text that isn't a job URL or a recognized command** when exactly one `resume-approval`/`field-approval`/`submit-approval`/`edit-intent`/`question`/`settings-menu`/`settings-edit` confirmation is pending — **the other non-slash exception**, since it's scoped to whatever's already open, OR a **bare digit reply to a numbered disambiguation** (see below) — this one comes with a deterministic resolution already computed for you, never guessed | Step 4: confirm |
| Anything else — including plain-English attempts like "search" or "apply all" | not a recognized `/command`, not a job URL, nothing pending to reply to (checked fresh — see Step 5) | Step 5: note (nudges toward `/help`) |

If a standalone confirm word or free-text reply arrives with **multiple** pending confirmations (of any stage, including `edit-intent`), don't guess — reply with a numbered list of what's pending and wait for a number in a future cycle. This is the only disambiguation needed now: since PDF edits open through `/editpdf` (a command) rather than matching on free text, there's no longer a routing collision between an in-flight apply confirmation and an out-of-band PDF edit request — each pending item is unambiguous once opened.

**Numbering contract (mandatory, both directions):** when sending that numbered list, number it in the exact order the confirmations appear in `data/telegram-state.md`'s `## Pending Confirmations` section, top to bottom, 1-indexed — never re-order for readability (highest score first, most recent first, etc.). This isn't just a formatting preference: `telegram-monitor.mjs`'s `resolveDisambiguationHint()` resolves a later bare-digit reply against this exact same file-order numbering, deterministically, before the routing prompt is even built. If the digit resolves, the prompt you receive carries a block starting `DETERMINISTIC DISAMBIGUATION RESOLUTION:` naming the exact `[msg_id: ...]` it selects — **trust it and route straight to Step 4 for that item; do not re-derive the mapping yourself, and do not classify that message as unclassified/Step 5 even though it isn't "yes"/"no"/a command/a URL.** This closes a real, previously-undocumented gap: nothing ever recorded how a "1"/"2" reply mapped back to a specific pending item, so a fresh dispatch had no way to resolve one and fell through to the generic nudge for a message that was genuinely answering an open question (confirmed live 2026-09-12, and identically once before that — msg 656).

### Step 3a — Run full cycle

0. **Duplicate-run guard — check the lock BEFORE announcing anything.** Run `node core/cycle-lock.mjs status` first. If it returns `held: true` **and** `stale: false`, a cycle is genuinely in progress: reply `⏳ A search cycle is already running (started {startedAt}). I'll message you when it finishes — send /status anytime for progress.` and **stop here**; do not send the kickoff message, do not read `cycle.md`, do not start a second run. Otherwise (not held, or held-but-stale — a dead run whose lock is reclaimable) continue to step 1.

   This ordering matters: step 1's kickoff message is unconditional once reached, so checking the lock afterwards would announce "🚀 Starting a full search cycle" and then immediately contradict it with "already in progress" (found live 2026-08-27 — introduced by the 2026-08-26 fix below that made the kickoff mandatory-first). `cycle.md` Step 0 still runs its own `cycle-lock.mjs acquire` as the authoritative guard against a race between this check and the actual start; this step only prevents the misleading announcement.

1. **Once step 0 clears — before reading `modes/cycle.md` — actually run this command, right now, as its own standalone tool call:**
   ```bash
   node core/plugins.mjs run telegram notify "🚀 Starting a full search cycle — scanning every portal + the full ATS universe, then evaluating every match. This can take hours (a full ATS sweep is a multi-hour operation by design). I'll message you when it's done."
   ```
   This is a real, mandatory action — not a description of what will happen, and not something `cycle` mode's own Progress Reporting section (Discord-only) substitutes for (found live 2026-08-26: a real `/run` produced Discord ticks throughout via `cycle.md`'s own reporting, but Telegram received nothing at all until the run finished, hours later — because this send never actually happened as a distinct action before `cycle.md` was read). Send it, confirm the CLI reports success, *then* proceed to step 2.
2. Run `cycle` mode's complete workflow (`modes/cycle.md`, Steps 0 through 5) exactly as if invoked interactively. This changes nothing about how `cycle` runs internally — its own guardrails, Discord progress reporting, `cycle-status.mjs` checkpoints, and integrity passes all still apply unchanged. `cycle.md`'s own Progress Reporting section is Discord-only supplementary detail throughout the run — it is not a substitute for this step's one-time Telegram kickoff message, which must already be sent before `cycle.md` is even opened.
3. This is a long-running turn by design, matching `cycle`'s own nature. Subsequent Telegram polls simply queue behind it — `CronCreate` only fires while idle — that's expected, not a bug.
4. **Auto-generate PDFs for all keepers (≥threshold):** `cycle` mode (Step 2 + Step 3 above) already handles this inline, respecting `config/profile.yml`'s `cv.output_format` setting. PDFs are generated in LaTeX or HTML format as configured, following the same format branch as every other run. This step is already part of the normal `cycle` flow — no additional PDF work is needed here.

5. When `cycle` finishes, `cycle.md` Step 5 (Deliver) automatically routes to the canonical Telegram delivery from the workspace's own `_custom.md` → "Telegram Notifications" (user-layer file, not a system-layer path — see `core/AGENTS.md`'s Data Contract), which sends the full digest of all matches ≥3.5 with PDFs. No bespoke top-match-only card here — the Telegram delivery is now uniform regardless of whether it came from `telegram` mode, a plain `/career-ops cycle` run, or any other entry point. If a workspace's `_custom.md` has no "Telegram Notifications" section yet, `cycle.md`'s own fallback applies — but the fallback is free-form prose with no deterministic link guarantee, so a workspace whose Telegram digests are missing job links needs a real "Telegram Notifications" section added (see the `ernesto-vasquez` workspace's `_custom.md` for the reference implementation built on `build-digest.mjs`), not a one-off prompt fix.
6. If the digest came back sparse (few or no matches ≥3.5) — especially on this workspace's first real cycle — append one line to the digest message mentioning `tune-targeting.mjs`: it ranks dead-weight `title_filter` keywords and flags mismatched scan queries using this run's own scan corpus as evidence (see the `run-tune-targeting` skill). Skip this line on a normal, non-sparse run — it's a targeted nudge for an apparently mistuned search, not a standing footer.

7. If `cycle` is interrupted before finishing (crash, session end, usage limit), don't treat that specially here — `cycle` mode's own resilience section already makes re-running safe (Pass B resumes from checkpoint, Pass A is idempotent, Step 2/3 only touch unprocessed rows). A repeated `/run` just runs Step 3a again.

### Step 3b — Start apply (single role)

0. **Resolve `args[0]` from `/apply` into a job URL first:**
   - Looks like a URL → use it directly.
   - Looks like a report number (e.g. `042`) → look it up in `data/applications.md` by the # column, follow its report link, and extract the `**URL:**` header from that report file.
   - No args → use the most recently discussed job this session.
   - Can't resolve any of the above (bad report #, no prior job discussed) → reply `Couldn't find that — send a job URL, a report number (e.g. "/apply 042"), or "/pdf" to see recent reports.` and stop; do not create a pending confirmation.
0.5. **Determine whether this URL has already been evaluated.** Normalize it with `core/scan.mjs`'s exported `normalizeUrlForDedup(url)` (strips known tracking params, drops the hash, lowercases/trims the trailing slash off the path — the same normalization the scanner's own dedup already applies) and compare against every report's `**URL:**` header, normalized the same way (`data/applications.md`'s rows link to `reports/*.md`; grep their `**URL:**` lines rather than re-deriving from the tracker text).
   - **A match exists** → continue at item 1 below using that report's number, exactly as today (this is the common case — a URL from `/run`, `/scan`, or a pipeline entry the candidate already saw).
   - **No match** → this is a URL the pipeline has never seen. Acknowledge distinctly: `🔍 New role — I haven't evaluated this one yet. Screening it now...` (a screening pass costs real time — JD extraction, WebSearch context, full scoring — so this message matters even more than item 1's fast-path ack). Run `auto-pipeline` mode against this URL inline, exactly as if the candidate had pasted it directly in any other career-ops session (evaluate + report + PDF + tracker — see `core/AGENTS.md`'s Skill Modes table). This produces a real report number and score the same way any other fresh URL would.
     - **Resulting score is below 4.0/5** (`core/AGENTS.md`'s Ethical Use rule: "Below 4.0/5, explicitly recommend against applying; only proceed if the user has a specific reason to override"): send the score and the one line from the report's Block B that best explains the weak fit, then ask `This one scored {score}/5 — {reason}. Still want to apply anyway?` Store a `stage: question` pending confirmation. Proceed to item 1 only on an explicit yes/override; a "no" or an unrelated reply ends here — no resume tailored, no application started, and the report/tracker entry from the screening pass stays exactly as `auto-pipeline` left it (nothing to undo — a scored-but-not-applied role is a normal, already-supported tracker state).
     - **Score is 4.0/5 or above** → continue straight to item 1 below using the new report number. No separate confirmation needed here — the resume-approval gate that item 2 already creates is the candidate's next natural stop point, so adding another one first would just be a redundant gate.
1. Acknowledge immediately: `🎯 Got it — applying to {URL}. Tailoring your resume...` (send before doing any slow work, so the candidate knows it registered). Skip this specific message when item 0.5 already sent its own screening acknowledgment for a brand-new URL this same turn — one "got it, working on it" message per turn is enough.
2. **Tailor the resume first, gated on approval, before touching the application form at all:**
   a. Load the report's Block B (fit assessment) and the JD text; match relevant items against `cv.md`'s "Verified Bullet Variants by Function" section — one competency at a time.
   b. For each competency where a pre-approved variant fits the JD's language better than the current bullet, swap it in. **Swap only — never invent.** If a JD requirement has no matching verified variant, leave that section as-is; a gap in coverage is not license to fabricate.
   c. Build the tailored payload at `.tmp/cv-{candidate}-{company}.json` (summary + competencies + bullets), following the same `cv.output_format` branch `pdf`/`latex` mode already use.
   d. Send a preview — professional summary + the specific bullets that changed, clearly marked — as: `📄 Tailored resume for {company} — {role}. Reply "yes" to continue, or tell me what to change.` Store a `stage: resume-approval` pending confirmation (report, job_url, data: list of swapped bullets + the candidate JSON path).
   e. Stop here. Do not scan the application form yet — that only starts once this gate resolves via Step 4.
3. **Once `stage: resume-approval` resolves with approval**, continue from here (this may be a much later poll cycle): run `apply` mode's Steps 1 through 7 against the URL (detect, identify, search/load context, **every** preflight gate — 5, 5b, 5c, 5d, 5e — analyze, boilerplate cache, generate), using the approved tailored resume from step 2 above instead of the stock `cv.md` rendering. Nothing here is skipped or weakened; `apply` mode's own rules decide what happens at each step.
4. **Any point where `apply` mode would stop and ask the candidate something** (a Step 5 mismatch, a Step 5b knock-out warning, a Step 5e freshness-guard prompt, or one of Step 6c's one-at-a-time field questions) becomes a `stage: question` pending confirmation instead of an in-session question: send the question text to Telegram, store it, and end this poll cycle. Resume from the same point once a reply arrives (Step 4). A single application can produce a *sequence* of these — Step 6c asks its unresolved fields one at a time, so expect several `stage: question` round-trips in a row for one report before the field-approval message below ever fires. Each one is independent and unremarkable; nothing about handling it differs from a single Step 5 preflight question.
5. Once Step 7 produces its consolidated summary — every field Step 6c already resolved, plus Step 7's own fresh generation, plus anything missed — send it as the field-approval message (keep under 4000 chars — split by `apply` mode's own Step 7 output-format categories, Auto-filled / Collected this run / Generated / Missed, if longer), with a trailing `Reply "yes" to continue, "no" to skip, or tell me what to change.` hint — `apply` mode's own Step 7 format has no such line (it's written for an interactive session with no gate), so this mode adds it. Store a `stage: field-approval` pending confirmation with the report number, job URL, and the full summary as JSON.
6. Do not proceed to filling anything yet — that's Step 4, gated on the reply.

### Step 3c — Start batch apply

1. Resolve the eligible set exactly like `apply-batch` mode's Step 1: `data/applications.md` rows with `Status: Evaluated`, `Score >= auto_pdf_score_threshold` (default 4.0), an ATS the fill flow supports (Greenhouse/Lever/Workday), and the Step 5e freshness guard against `cv.md`/`config/profile.yml`/`_profile.md`.
2. **If the eligible set is empty**, there is nothing this pending confirmation could ever be approving — send the "needs re-evaluation" / out-of-scope breakdown so the candidate knows *why* (e.g. "Nothing eligible right now — N report(s) need re-evaluation, M are on an unsupported ATS. Re-run /applyall once that's resolved.") and **stop without storing a `stage: batch-approval` pending confirmation.** A pending item with no possible "yes" just sits there forever — every unrelated reply that arrives afterward has to be disambiguated against it (Step 2's "can't guess with 2+ pending items" rule fires on literally everything else the candidate sends), which is a real cost this system paid live: found 2026-09-08, one dead empty-eligible `batch-approval` sat open for a full day and forced a numbered disambiguation round-trip on more than a dozen unrelated replies in a row.
3. Otherwise, send the eligible list (report #, company, role, score) plus the "needs re-evaluation" list via Telegram. Store it as a `stage: batch-approval` pending confirmation — the one consolidated checkpoint for the whole batch, matching `apply-batch` mode's own Step 2.
4. On approval, write the remaining report numbers (highest score first) to `data/telegram-state.md`'s `## Batch Queue`, then start Step 3b for the first one.
5. On rejection, or a reply to the pending `batch-approval` message like "skip {company}", trim the queue accordingly (or drop the batch entirely) before starting anything — this is a reply to something already pending, not a fresh command, so free text is expected here per the SLASH-ONLY exceptions.
6. **If a re-run of `/applyall` finds the existing pending `batch-approval`'s eligible set has since dropped to empty** (every candidate resolved, re-evaluated away, or gone stale) before the candidate ever replied to it, replace it the same way: remove the stale pending confirmation and follow step 2 above instead of leaving two conflicting `batch-approval`-shaped things around.

### Step 3d — Retrieve & send PDF

1. Resolve `/pdf`'s `args[0]`: numeric-looking → report # (match by # column in `data/applications.md`); otherwise → fuzzy-match against the Company column, highest-score match if multiple rows for the same company; no args → the most recently discussed report.
2. Can't resolve it (bad report #, no company match, no prior report discussed) → reply `Couldn't find that report — try "/pdf {report#}" or "/pdf {company}".` and stop.
3. Once the report is found, construct the PDF filename: `cv-{company-slug}-{YYYY-MM-DD}.pdf` (read the date from the report's date column; company-slug is the company name lowercased + hyphenated).
4. Check if the file exists in `output/`. If not found, send: `❌ No PDF found for report {#} ({company}). Check if it was generated during the apply workflow.`
5. If found, send via: `node core/plugins.mjs run telegram notify "{emoji} Here's your PDF for {company} — {role}:" --file output/{pdf_filename}`
   - Emoji: 📎 if PDF was just generated this session, 📄 if it's from an earlier batch.
   - Let the Telegram plugin handle the attachment delivery; it returns a URL and file size.
6. If the retrieval or send fails (file I/O error, plugin timeout), send: `⚠️ Couldn't retrieve PDF for report {#}. Try again in a moment.` and log the error.
7. Do NOT create a pending confirmation — this is a one-shot retrieval, not a gate. Simply send the PDF and continue.

### Step 3e — Edit a PDF (two-step: `/editpdf` opens intent, the reply is the instruction)

Free-form edit instructions have no fixed argument shape to put after a slash, so this command opens intent first and treats the *next* message as the actual edit — same principle as any other pending confirmation, not an exception to slash-only.

1. Resolve `/editpdf`'s `args[0]` the same way Step 3d does (report # or company; no args → most recently discussed report). Can't resolve it → same error message as Step 3d #2.
2. Acknowledge: `✏️ What would you like to change in the {company} resume? Reply with the edit (e.g. "change the onboarding bullet to mention X").` Store a `stage: edit-intent` pending confirmation (report, company — no other data needed yet).
3. **Once a reply arrives** (Step 4's `stage: edit-intent` branch resumes here): treat the reply text as the edit instruction. Read the target report file and the current CV JSON/tex source for that PDF (the `.tmp/cv-{candidate}-{company}.json` payload used to build it, rebuilt fresh if not present — never edit a `.pdf` or `.tex` file directly).
4. Apply the requested change to the JSON payload. Same non-fabrication rule as everywhere else in this system: a requested rewording is fine; a requested new claim not backed by `cv.md`/`config/profile.yml`/`article-digest.md` is not — if the request asks for something unverifiable, reply asking for the missing detail instead of inventing it, and stay in `stage: edit-intent` for the clarified answer.
5. Re-run the appropriate build chain per `config/profile.yml`'s `cv.output_format`: `node core/build-cv-latex.mjs .tmp/cv-{candidate}-{company}.json output/{num}-{company}-{YYYY-MM-DD}.tex` then `node core/generate-latex.mjs ...` for `"latex"`, or the `build-cv-html.mjs`/`generate-pdf.mjs` equivalent otherwise.
6. Send the regenerated PDF back: `node core/plugins.mjs run telegram notify "📎 Updated resume for {company} — {role}:" --file output/{pdf_filename}`. Remove the pending confirmation.
7. **No approval gate needed** — regenerating a draft PDF isn't submission, so `Off-Limits` (never submit / never merge-tracker without confirmation) doesn't apply here. Log the edit to Recent Actions.
8. If the reply is too ambiguous to apply confidently (unclear which bullet, unclear what change), ask a clarifying question and stay in `stage: edit-intent` rather than advancing — same one-clarifying-round pattern as a Step 3b `stage: question` pause.

### Step 3f — Report status

One on-demand reply combining all three, added 2026-08-13 so a single check-in answers "what's going on" instead of three separate queries:

1. **Cycle progress:** `node core/cycle-status.mjs --json` → branch on the **`liveness.state`** field it returns. **Never infer "running" from `step.id` alone** — a dead run's `step.id` stays frozen at whatever it was when the process died, which is exactly how a real `/status` reported a cycle as "running" for ~7 hours after it had crashed (found live 2026-08-27; before that fix `--json` carried no liveness field at all, so this step's own instruction told the agent to treat any non-`done` step as active).
   - `"running"` → a cycle really is in progress: report the current step label, counters, and how long since the last checkpoint (`liveness.lastUpdateAgo`).
   - `"stalled"` → the run has not checkpointed in over 40 minutes and is treated as **dead, not slow**. Say so plainly — e.g. `⚠️ The last search cycle stopped at "{step.label}" and hasn't progressed in {liveness.lastUpdateAgo}. It looks like it died rather than still running. Send /run to start a fresh cycle — it resumes the ATS sweep from its last checkpoint, so nothing already scanned is lost.` Report the frozen counters as the last known progress, explicitly labeled as where it stopped, never as current activity. This advice is always actionable: the stall threshold is deliberately longer than `cycle-lock.mjs`'s 30-minute staleness window, so a stalled run's lock is already reclaimable and `/run` will not be refused.
   - `"done"` → report the last completed run's summary counters with its `savedAt` timestamp.
   - `"no_run"` (no status file yet, or an unreadable one) → say no cycle has recorded status yet; do not invent progress numbers.
2. **Pipeline/tracker stats:** `node core/stats.mjs --summary` — include as-is; it's already a compact, mobile-readable block.
3. **Pending approvals:** read `data/telegram-state.md`'s Pending Confirmations section — if `(none)`, say so; otherwise list each pending item's stage + short description + how long it's been waiting.
4. Send as one message via `node core/plugins.mjs run telegram notify "<combined text>"`. This is a one-shot read, not a pending confirmation — don't create a `telegram-state.md` entry for it, just log it to Recent Actions (matching Step 3d's PDF-retrieval convention).

### Step 3g — Show help

Send this exact static message via `node core/plugins.mjs run telegram notify "<message>"` (HTML subset — `<b>`, `<i>`, `<code>` only, matches `plugins/telegram/skill.md`'s formatting rules):

```
🤖 <b>career-ops help</b>

I search for jobs, evaluate them, tailor your resume, and can apply for you — but I <b>never submit anything without your explicit yes</b>. Every task starts with a / command; free text only works when I'm already waiting on a reply from you.

<b>1. Start a search</b>
/run — full cycle: scan every portal + evaluate every match (can take hours — you'll be told when it starts)
/scan — scan only, skip evaluation (faster, no reports/PDFs)

<b>2. Check what's happening</b>
/status — current search progress, lifetime pipeline stats, anything waiting on you

<b>3. Apply to one job</b>
Paste a job URL, or send /apply (uses the most recent job we discussed)
→ Three approvals, in order, every time:
  1️⃣ <b>Resume</b> — I tailor it and show you what changed. Reply "yes" to continue, or tell me what to swap.
  2️⃣ <b>Form fields</b> — I propose answers. Reply "yes" to continue, or tell me what to fix.
  3️⃣ <b>Final review</b> — I fill the real form and show you exactly what it looks like. Reply "yes" to submit — the only step that actually sends anything.
At <i>any</i> of these: "no" skips this application (nothing is lost — /apply it again anytime), or describe a change in plain English and I'll update and ask again. No limit on revisions.

<b>4. Apply to everything eligible</b>
/applyall — shows the eligible list first; once you approve starting, each role still gets all 3 approvals above, one at a time.

<b>5. PDFs</b>
/pdf {report#} — resend an already-generated resume
/editpdf {report#} — I'll ask what to change, then regenerate it (no approval needed — it's just a draft)

<b>6. Settings</b>
/settings — view or change your location, work mode, targeting, salary target, or sponsorship status

<b>7. Quick replies</b>
Only usable when something's already waiting on you: "yes"/"y"/"go" to approve, "no"/"skip"/"cancel" (or /cancel) to decline it — cancelling only ever declines whatever's currently pending, it doesn't stop a search or apply run already in progress.
If more than one thing is waiting at once, I'll send a numbered list — reply with just the number (e.g. "1") to answer that one specifically. Plain-English phrases like "cancel everything" or "both" can't be matched to a specific item, so they won't work here; the number is what resolves it.

Send /help anytime to see this again.
```

One-shot, no pending confirmation — log to Recent Actions same as Step 3d/3f.

### Step 3h — View/edit profile settings

1. Read `config/profile.yml`. Build the numbered menu from whichever of these fields are present (a field with no real value yet — e.g. a fresh onboard that skipped the optional narrative step — is still listed, showing its current default):

   ```
   ⚙️ <b>Your Settings</b>

   1. Location: {location.city}, {location.country}
   2. Work mode: {location.work_mode, or "not set" if absent}
   3. Targeting: {"title-based — " + target_roles.primary.join(", ") if targeting_mode is title_based, else "industry-based — " + target_industries.map(i => i.name).join(", ")}
   4. Salary target: {compensation.target_range}
   5. Sponsorship: {"Needs sponsorship" if location.needs_sponsorship else "Not needed"}

   Reply with a number to change it, or "done".
   ```

2. Send it, store a pending confirmation with `stage: settings-menu`, advance and wait.
3. **On a numbered reply (1-5):** send the matching field-specific question below, then — **before waiting for the reply** — store `stage: settings-edit` with `data: { field: "<key>", phase: "awaiting-answer" }` (never leave the pending confirmation at `stage: settings-menu` once a field question has actually been asked; that stale stage is exactly what would otherwise cause Step 4 to route the candidate's real answer back into the menu-reply parser instead of here). Then wait.
   - `1` (Location) — `data.field: "location"`: ask `Where are you based now? (city, state/country)`.
   - `2` (Work mode) — `data.field: "work_mode"`: ask `Remote only, remote preferred, hybrid ok, or onsite ok?`.
   - `3` (Targeting) — `data.field: "targeting"`: if currently `title_based`, ask `Add more target roles, or switch to industry-based targeting instead?`; if currently `industry_based`, ask the symmetric question — add companies/industries, or switch back to `title_based`.
   - `4` (Salary) — `data.field: "salary"`: ask `What's your new target range?`.
   - `5` (Sponsorship) — `data.field: "sponsorship"`: ask `Do you need visa sponsorship now, or are you authorized?`.
4. **On "done" (or equivalent) with `stage: settings-menu` pending:** clear the pending confirmation, reply `Settings unchanged.` or, if any field was actually edited earlier in this session, a one-line summary of what changed. No `_portals-pruning.md` run needed here — each field edit below already ran it inline at the moment of confirmation, not batched to the end. (This branch only ever fires while `stage` is still `settings-menu` — i.e. before the candidate has picked a field to edit this round — precisely because step 3 above moves the pending stage to `settings-edit` the instant a field question is asked.)
5. **On a reply to `stage: settings-edit`:** branch on `data.phase` — this is what distinguishes the candidate's raw answer to the field question (step 3, above) from their yes/correction reply to that answer's read-back:
   - **`phase: "awaiting-answer"`** (this reply is the raw answer to the question step 3 just asked): parse it per the field named in `data.field`, per the rules below, then send that field's read-back message and update the pending confirmation to `data: { field, phase: "awaiting-confirmation", pending: <parsed value(s)> }` — still `stage: settings-edit`, remain waiting. `pending` is the only place the parsed-but-unconfirmed value lives; nothing is written to `config/profile.yml` yet.
     - `location`: infer `country` only from an unambiguous city/country name in the reply, never guess (same inference rule `telegram-onboarding.md` Step 4b already uses). `pending: { city, timezone, country }`. Read-back: `Got it — location is now {city}, {country}. Confirm?`
     - `work_mode`: parse into one of the four `location.work_mode` enum values (same mapping `telegram-onboarding.md` Step 4's `answers.workMode` parsing already uses). `pending: { work_mode }`. Read-back: `Got it — work mode is now {label}. Confirm?`
     - `targeting`: which of the four reply shapes applies depends on the candidate's *current* `targeting_mode` (already known from Step 3h #3's own read of `config/profile.yml` — no need to re-read anything to tell them apart):
       - Currently `title_based`, reply names roles: `pending: { mode: "title_based", roles: [...] }`.
       - Currently `title_based`, reply indicates a switch to industry-based: ask the one follow-up `What industry, and do you know specific companies in it? (name a few, or I can suggest some)` first, and stay in `phase: "awaiting-answer"` for that follow-up's reply before there's enough to read back (same "ask a single focused follow-up rather than guessing" latitude `telegram-onboarding.md` Step 4 uses) — once resolved, `pending: { mode: "industry_based", industry: { name, slug, description }, companies: [...] }`.
       - Currently `industry_based`, reply adds companies/industries (staying industry-based): same one-follow-up latitude as above if the reply doesn't already name enough — once resolved, `pending: { mode: "industry_based", industry: { name, slug, description }, companies: [...] }`, additive to the existing `target_industries`/`industry_companies` list, never a replacement (new companies resolved via `discover` mode exactly like the initial switch-to-industry-based path).
       - Currently `industry_based`, reply switches back to `title_based`: `pending: { mode: "title_based" }` with no `roles` key — the candidate is reverting, not supplying new roles in the same turn (they can add roles afterward through this same menu once back in title-based mode).
       Read-back once resolved, any of the four: `Got it — targeting is now {summary}. Confirm?`
     - `salary`: parse the target range and, if stated, a walk-away floor. `pending: { target_range, minimum }` (`minimum` omitted/unchanged if not stated — say so in the read-back). Read-back: `Got it — target range is now {range}{, minimum {minimum}, if given}. Confirm?`
     - `sponsorship`: same non-inference rule as onboarding — never infer from location (see `telegram-onboarding.md` Step 4's "Never infer `answers.needsSponsorship` from location alone" rule). `pending: { visa_status, needs_sponsorship, authorized_in }`. Read-back: `Got it — sponsorship: {label}. Confirm?`
     - `brief-fill` (only ever opened by the `industry_based` sync branch below, when `_brief.md` is still template text): a decline — "skip", "no", "later", or equivalent — is a valid answer, not a correction: clear this pending confirmation, reply `No problem — leaving your triage brief as-is.`, then re-send the Step 3h.1 menu and store a fresh `stage: settings-menu` (this is the branch that owes the deferred menu re-send). Otherwise parse whatever the reply actually gives: `pending: { roles: [...], minimum }` — **either key may be absent**, since the candidate may answer only half the question, and a missing half is left unwritten rather than guessed. If the reply gives neither (it's off-topic or unparseable), re-ask once with the same question and stay in `phase: "awaiting-answer"`; if the *next* reply is also unparseable, stop re-asking and take the decline path above — never leave the candidate stuck in a question they evidently aren't answering, and never let this loop unbounded. Read-back: `Got it — I'll put {roles summary} in your triage brief{, with a hard floor of {minimum}, if given}. Confirm?` Note in the read-back that this updates `_brief.md` only.
   - **`phase: "awaiting-confirmation"`** (this reply answers the read-back step above just sent): resolve exactly like `telegram-onboarding.md` Step 4b's own confirm-or-correct loop:
     - "yes"/equivalent — **`data.field: "brief-fill"` first, because it is the one field that is not a `config/profile.yml` field at all:** write `pending.roles` into `_brief.md`'s **Target Archetypes** table using the exact same rules the `title_based`-with-roles sync bullet below already gives (proof cells `none yet` rather than invented), and `pending.minimum` into the `**Hard floor: …**` line using the exact same rule the `salary` sync bullet below already gives; write only the half/halves the candidate actually supplied, and leave every other section of `_brief.md` untouched. Write **nothing** to `config/profile.yml` — the candidate was answering a triage-brief question, not changing `target_roles.primary` or `compensation`, and their `targeting_mode` is `industry_based`, where `target_roles.primary` isn't read for scanning anyway; silently repurposing this answer into a targeting change would be exactly the kind of silent write this Step forbids. No `_portals-pruning.md` step applies. Then reply `Updated your triage brief.`, re-send the Step 3h.1 menu, store a fresh `stage: settings-menu`, and wait — this branch owes that deferred menu re-send. **For every other `data.field`:** write `data.pending` into `config/profile.yml` (`location.city`/`timezone`/`country` for location; `location.work_mode` for work mode; `compensation.target_range`/`minimum` for salary; `location.visa_status`/`needs_sponsorship`/`authorized_in` for sponsorship — exactly per `telegram-onboarding.md` Step 4b's existing instructions for each of these fields). For targeting, the write depends on `pending.mode`: `"title_based"` with a `roles` key writes `target_roles.primary` (`targeting_mode` stays `"title_based"`, unchanged if it already was); `"industry_based"` writes `targeting_mode: "industry_based"` and merges `pending.industry`/`pending.companies` into `target_industries`/`portals.yml`'s `industry_companies` (additive, per the parsing rule above); `"title_based"` with **no** `roles` key (the revert case) writes only `targeting_mode: "title_based"` and leaves `target_roles.primary` and `target_industries` exactly as they were. Then run the matching `_portals-pruning.md` step using the new value: location or work mode → its section 3 (`location_filter`); targeting roles added or changed (`pending.mode: "title_based"` with `roles`) → sections 1-2 (`title_filter.positive` and `tracked_companies`/`search_queries` pruning); targeting switched to industry-based or given new companies while staying industry-based (`pending.mode: "industry_based"`, either case) → section 4 (`industry_companies`, resolved via `discover` mode); targeting reverted to `title_based` with no new roles, salary, or sponsorship → no `_portals-pruning.md` step applies (per `_portals-pruning.md` section 4's own note, `industry_companies` is left in place on a revert, not deleted, so there's nothing to prune back). Then run the `_brief.md`/`_profile.md` sync below for the same field. Finally, re-send the Step 3h.1 menu (reflecting the new value), store a fresh `stage: settings-menu` pending confirmation, and wait — **unless** the sync step you just ran ended by asking the candidate a question of its own and storing its own pending confirmation (only the `industry_based` branch's unfilled-brief offer does this, and only when it actually fires). In that case that confirmation *is* the pending item: do **not** re-send the menu and do **not** overwrite it with a `stage: settings-menu` — the menu is re-sent later, by whichever branch resolves that exchange. Never leave two pending confirmations open at once here, and never store a stage that no branch is waiting to receive.

       **`_brief.md` / `_profile.md` sync (runs on the same "yes", in the same turn as the `config/profile.yml` write).** `modes/triage.md` reads **only** `_brief.md` — never `config/profile.yml`, never `_profile.md` — and this plan made `triage` **mandatory** for every industry-sourced posting (`modes/pipeline.md` step `c2`). So a `/settings` edit that updates `config/profile.yml` and stops there leaves the candidate's next scan being triaged against their *old* profile: the stored value changed, the downstream behavior didn't. That is the same contradiction `_portals-pruning.md` exists to prevent for `portals.yml`, and it is closed the same way — inline, at the moment of confirmation, never batched to the end.

       Write **only** values already confirmed in this `/settings` conversation (the `data.pending` the candidate just approved). Never re-derive a value from an unrelated field, never infer, never fill an adjacent placeholder you happen to notice — the same non-inference discipline the sponsorship and location rules above already use. Edit the smallest span that carries the changed fact and leave every other line of the file byte-identical. If `_brief.md` does not exist, skip this sync and say so in the menu re-send (`triage` already falls back to full evaluation when `_brief.md` is missing — see `modes/triage.md`); do not create the file from `/settings`.

       Per field — every one of the five is listed, including the ones where the correct answer is "nothing changes":

       - **`location`** → `_brief.md`'s **Identity** section. That section is one line covering seniority, discipline, years, location/timezone, and work authorization. Rewrite **only** its location/timezone clause from `pending.city`/`pending.country`/`pending.timezone`; keep the seniority, discipline, years, and work-authorization clauses verbatim. No `_profile.md` change — its comp/location scoring guidance is generic instruction to the agent, not a factual claim about the candidate.
       - **`work_mode`** → `_brief.md`'s **Location Scoring** section, **only on a plain contradiction**. That section is a qualitative policy the candidate may have tuned themselves (per-tier scoring bands), not a single fact to overwrite, so the default is to leave it exactly as it is. Fire only when the new value is `remote_only` **and** the existing section either has no remote/on-site distinction at all or still scores an on-site/hybrid tier at or above the triage PASS threshold (`config/profile.yml → pipeline.triage_threshold`, default 3.5) — i.e. the bands as written would keep passing roles the candidate just said they will not take. Even then, **append one line, never edit or delete an existing band**, and mark it as machine-written so it can be reversed later: `- **Remote-only as of {YYYY-MM-DD}: any role requiring on-site presence → 2.0.** <!-- set by /settings -->`. Symmetrically, when the new value moves *away* from `remote_only` (to `remote_preferred`/`hybrid_ok`/`onsite_ok`), remove a previously appended `<!-- set by /settings -->` line if one is present — that line is ours, so removing it destroys no candidate-authored nuance — and change nothing else. In every other case leave the section untouched and say so in the menu re-send (`Work mode updated. Left your _brief.md location scoring as-is — tell me if you want it changed.`). No `_profile.md` change.
       - **`targeting`**, `pending.mode: "title_based"` **with** a `roles` key → `_brief.md`'s **Target Archetypes** table and `_profile.md`'s "Your Target Roles" / "Your Adaptive Framing" tables (the same two files and the same tables `telegram-onboarding.md` Step 4b item **c** writes, by the same rules). Add or replace rows to match the confirmed `pending.roles`. For the "What they buy (your proof)" column, use only proof points already present in the candidate's own `cv.md` / existing `_brief.md` Proof Points — if none maps to a newly added role, write an explicit `none yet` in that cell rather than inventing one, exactly as onboarding does for its empty sections. Leave Proof Points, Comp Strategy, Hard DQ Criteria, Soft Red Flags, and the Priority Override List untouched.
       - **`targeting`**, `pending.mode: "industry_based"` (switching in, or adding industries/companies while already industry-based) → **no `_brief.md` or `_profile.md` write at all.** This is deliberate, not an omission. **Target Archetypes is a functional-capability list, not an industry list**, and the whole cost-control design depends on it staying that way: the mandatory `triage` gate works precisely because archetype fit answers "does this candidate's real skillset fit this JD" *independently of which industry the employer is in* (see the design doc's "Cost control" section). Writing an industry into that table would make every posting at a targeted employer look like a direct archetype hit regardless of function — which is both a new scoring dimension (forbidden by the plan's Global Constraints) and the exact failure the triage gate exists to prevent. The industry lives in `config/profile.yml`'s `target_industries` and `portals.yml`'s `industry_companies`; nothing about it belongs in `_brief.md`. **One check does apply here, though:** industry targeting makes `triage` mandatory, and `triage` cannot run against an unfilled `_brief.md` (`modes/triage.md` falls back to full evaluation) — which would silently reinstate exactly the per-posting full-evaluation cost this gate prevents. So before returning to the menu, read `_brief.md` and check whether its **Target Archetypes** or **Comp Strategy** sections are still unfilled `{placeholder}` template text.
         - **If both are filled:** nothing more to do — fall through to the normal menu re-send.
         - **If either is still placeholder text — and the candidate hasn't already declined this offer earlier in the current `/settings` session:** send `Heads up: your triage brief still has unfilled sections, and industry targeting relies on it to filter postings cheaply. What are your real target roles, and what's your salary floor? (Or reply "skip" and I'll leave it for now.)` and store a pending confirmation with `stage: settings-edit`, `data: { field: "brief-fill", phase: "awaiting-answer" }`, then wait. **Do not re-send the menu on this path** — this question needs a stage to land in, and per the "yes" branch above the menu re-send is skipped precisely when a sync step opens its own confirmation. (Without this, the question would be asked with only `stage: settings-menu` pending, and Step 4's `settings-menu` dispatcher — which recognizes a number or "done" and nothing else — would discard the candidate's answer and re-send the menu. That dead-end shape is the exact bug two earlier rounds of this Step closed; do not reintroduce it.) Never fill these sections from guesswork.
       - **`targeting`**, `pending.mode: "title_based"` with **no** `roles` key (the revert case) → **no `_brief.md` or `_profile.md` change.** Nothing was written to either file on the way into industry-based targeting (per the rule above), so there is nothing to reverse; and the candidate supplied no new roles this turn, so there is nothing to add. Their existing Target Archetypes still describe what they can do.
       - **`salary`** → `_brief.md`'s **Comp Strategy** section. Update **one** target row to the confirmed `pending.target_range`, keeping that row's existing "Requirement"/conditions text verbatim — the number changed, the conditions the candidate attached to it did not. The template ships two rows (`~{$X}` and `{$Y}+`), so pick deliberately: if exactly one row's current number matches the *previous* `compensation.target_range`, update that row; otherwise update the first (primary) row and leave the second exactly as-is. Never rewrite both rows from one number — the second row exists to express a *different* comp/intensity trade-off the candidate authored, and overwriting it with the same figure destroys that distinction. Then: if `pending.minimum` was actually stated, also rewrite the `**Hard floor: {$X}. Below that, FAIL regardless of other signals.**` line to that new floor — this line is what triage FAILs against, so leaving it stale is the single most consequential version of this whole gap. If no floor was stated, **leave the hard floor line untouched** and say so in the menu re-send — the same "minimum unchanged if not stated" rule the read-back above already uses. Either way, re-read the two together before finishing: the hard floor must not end up **above** the target row you just updated (a floor above the target is incoherent and would make triage FAIL the candidate's own stated target). If the new range would leave it that way, don't silently adjust either one — flag it in the menu re-send and ask which they meant. No `_profile.md` change.
       - **`sponsorship`** → `_brief.md`'s **Identity** section — the work-authorization clause only, rewritten from the confirmed `pending.visa_status`/`needs_sponsorship`/`authorized_in`, with the seniority, discipline, years, and location clauses kept verbatim. This is the same clause `telegram-onboarding.md` Step 4b item **c** warns must match `answers.needsSponsorship` exactly rather than the template's "US citizen, no sponsorship needed" placeholder. No `_profile.md` change.
     - anything else (a correction): fold the new input into the prior answer, re-parse per the same field rule above, re-send that field's read-back with the corrected value, update `data.pending` accordingly, remain in `stage: settings-edit` with `phase: "awaiting-confirmation"` — no retry cap, same ordinary back-and-forth `telegram-onboarding.md` Step 4b's own correction loop uses.
6. Log every completed edit (the write that happens on a `phase: "awaiting-confirmation"` "yes") to `data/telegram-state.md`'s Recent Actions, same convention as every other step in this file.

### Step 4 — Confirm

Look up the pending confirmation the reply resolves (threaded match, or the sole pending item, or a numbered disambiguation reply).

**First, classify the reply itself** for any `resume-approval`/`field-approval`/`submit-approval` confirmation:
- **Approve** — `yes`, `y`, `go`, `approve`, `submit`, or equivalent, with no attached change request.
- **Reject** — `no`, `skip`, `cancel`, or equivalent, or an explicit "abandon this one."
- **Edit request** — anything else that reads as an instruction (e.g. "use the second onboarding bullet instead," "Q3 should mention X," "Q5: {replacement answer}"). This is the common case now — treat free text as an edit attempt, not noise.
- **Ambiguous** — doesn't clearly read as approve, reject, or a parseable instruction (e.g. "maybe later," "let me think," "?"). **Treat as reject** (never guess toward approval), but say so explicitly in the reply so the candidate knows why: `Couldn't tell if that was an approval, a rejection, or an edit request — treating it as declined. Send "/apply {report#}" to try again, or be more specific about what to change next time.`

- **`stage: question`** — feed the reply back into `apply` mode exactly as if the candidate had answered inline, then resume the paused step. This can re-enter Step 3b partway through (e.g., resume Step 6 after a Step 5e freshness question is answered "continue anyway").

- **`stage: edit-intent`** — treat the reply as the edit instruction and run Step 3e steps 3-8. If too ambiguous to apply confidently, ask a clarifying question and stay in `stage: edit-intent` rather than advancing.

- **`stage: settings-menu`** — a numbered reply (1-5) runs the matching branch in Step 3h #3, which asks that field's question and immediately moves the pending confirmation to `stage: settings-edit` (`phase: "awaiting-answer"`) before waiting — so this `stage: settings-menu` branch only ever fires again once the candidate is back at the menu with nothing mid-edit. "done" (or equivalent) runs Step 3h #4. Anything else: re-send the menu with a reminder to reply with a number or "done", stay in `stage: settings-menu`.
- **`stage: settings-edit`** — resolve per Step 3h #5, branching on `data.phase`: `"awaiting-answer"` means this reply is the raw answer to the field question Step 3h #3 just asked (parse it, send the read-back, move to `phase: "awaiting-confirmation"`); `"awaiting-confirmation"` means this reply answers that read-back (yes writes `data.pending` and returns to the menu; anything else is a correction that re-asks with the new input folded in, staying in `phase: "awaiting-confirmation"`). `data.field` is normally one of the five menu fields, but it can also be `"brief-fill"` — the one field not opened from the menu, raised instead by the `industry_based` targeting sync when `_brief.md` is still template text. It resolves through this same two-phase loop and writes only `_brief.md`; see Step 3h #5's `brief-fill` rules for both phases, including that "skip" is a valid answer rather than a correction.

- **`stage: resume-approval`, approve** — continue Step 3b from step 3: scan the application form using the approved tailored resume.
- **`stage: resume-approval`, edit request** — parse the request against `cv.md`'s Verified Bullet Variants (match by competency, e.g. "onboarding," "invoice processing"). If it maps to a specific pre-approved variant, swap it into the tailored payload; if it maps to a claim outside the verified library (e.g. Salesforce, VLOOKUP, anything on `_profile.md`'s Accuracy Guardrails never-claim list), don't apply it — explain briefly why (which guardrail it hits) and offer to update `cv.md` out-of-band instead, so it's available for future applications. Either way, regenerate the preview, resend it with the same `📄 ... Reply "yes" to continue, or tell me what to change.` framing, bump `edit_count`, and stay in `stage: resume-approval` — do not advance until an explicit approval arrives. No cap on edit rounds.
- **`stage: resume-approval`, reject** — see **Reject & clean up** below; nothing was submitted yet, so no filled-form payload to stash.

- **`stage: field-approval`, approve** — re-navigate to the report's URL fresh with Playwright (this may be a much later poll cycle; never assume a tab is still open), run `apply` mode's **Step 7b** (subagent-delegated fill) using the stored, approved mapping. Take a screenshot / summarize what filled vs. what didn't (`fields_failed`, `needs_manual_upload` from Step 7b's contract). Send it as `Everything looks good — submit? Reply "yes" to submit, "no" to cancel, or tell me what to fix.` and store a new `stage: submit-approval` confirmation. **Never skip this gate** — submitting is irreversible.
- **`stage: field-approval`, edit request** — apply the requested change to the stored field→value mapping (no form has been touched yet, so this is a cheap in-memory edit), regenerate the mapping preview, resend it with the same trailing `Reply "yes" to continue, or tell me what else to change.` hint, bump `edit_count`, stay in `stage: field-approval`. Do not fall through to filling until an explicit approval arrives.
- **`stage: field-approval`, reject** — see **Reject & clean up** below.

- **`stage: submit-approval`, approve** — click Submit (the only point that submits an **application** — a Step 5-alt signup form can also submit, but that has its own, separate consent gate). Verify via `browser_snapshot` that this is genuinely the review/submit page before clicking anything. The click itself is a mutating Playwright action, so it goes through the same subagent delegation as Step 7b's field-fill (the guard hook blocks it from the main session either way) — spawn that subagent pinned `model: haiku` (a single "click the button labeled Submit on this already-verified page" task doesn't need more than that; don't leave the model unpinned to fall through to whatever the main session inherited). Then run `apply` mode's **Step 8** (persist the `## Application Answers` section) and **Step 9** (`set-status.mjs ... Applied`, `followup-seed.mjs`). Send confirmation: `✅ Applied to {Role} at {Company}.` Remove the pending confirmation, add a line to Recent Actions.
- **`stage: submit-approval`, edit request** — validate the requested change first: reject anything that violates `_profile.md`'s Accuracy Guardrails (fabrication, never-claim items) with a brief explanation, and reject anything that doesn't actually answer the field in question (ask for clarification instead of guessing). If it passes both checks, re-navigate and re-run Step 7b with the corrected field (a surgical re-fill of just that field, not a full re-run), regenerate the filled-form summary, resend `Everything look good now — submit? Reply "yes" to submit, "no" to cancel, or tell me what else to fix.`, bump `edit_count`, stay in `stage: submit-approval`. **`skip {field}`** is a recognized special case: leave that field blank in the submission and note it in the summary, for the candidate to finish manually after submit — this does not count as a rejection.
- **`stage: submit-approval`, reject** — see **Reject & clean up** below.

- **`stage: batch-approval`, reply approves** — proceed as Step 3c #3 describes.
- **`stage: batch-approval`, reply rejects** — drop the batch, confirm `No problem — send "/applyall" again whenever you're ready.`

**Reject & clean up** (any of `resume-approval`/`field-approval`/`submit-approval`, rejected or ambiguous-treated-as-rejected): mark the report `SKIP` via `node core/set-status.mjs {report#} SKIP --note "[telegram] user rejected at {stage}"`, remove the pending confirmation, and log one line to Recent Actions (`{date} — apply {report#} rejected at {stage}`). Then send a stage-specific confirmation back to the candidate — never clean up silently:
- `resume-approval` reject: `Not applying to {company} — {role}. Send "/apply {report#}" again anytime if you change your mind.`
- `field-approval` reject: `Not applying to {company} — {role}. The form was never touched. Send "/apply {report#}" again anytime if you change your mind.`
- `submit-approval` reject: also stash the filled-form payload to `data/cache/rejected-apply-{report#}.json` before discarding — it's the one artifact genuinely expensive to reconstruct. Send: `Not submitted — {company} — {role}. The filled form is saved if you want to finish it yourself, or send "/apply {report#}" to start fresh.` No expiry job for that stash; it just sits there until the candidate deals with it or the standing stray-file check in `modes/_custom.md`'s Autonomous-Run Guardrails eventually flags it stale.

**Batch progression:** whenever a row fully resolves (a `submit-approval` reply of either kind, or a `resume-approval`/`field-approval` rejection) **and `## Batch Queue` is non-empty**, immediately pop the next report number and start Step 3b for it — the candidate doesn't send a fresh `/apply` for each subsequent role, only the replies for whichever gate is currently active, one row at a time. Edit-loop rounds within a single row never advance the queue — only a terminal outcome (submitted, or rejected at any of the three gates) does. `/applyall` only approves *starting* the batch; every individual application still gets its own three gates. When the queue empties, send the batch summary (applied / skipped / needs-re-evaluation / out-of-scope counts), matching `apply-batch` mode's Step 4.

### Step 5 — Note

**Before concluding "nothing pending to reply to," re-read `data/telegram-state.md`'s `## Pending Confirmations` section directly, right now, in this step — never rely on a belief about what's pending formed earlier in this same turn.** Found live 2026-09-12: a message that should have matched the Confirmation-reply row (free text answering the one thing genuinely pending — e.g. "Apply" as an answer to a yes/no override question this very same conversation had just asked) instead reached Step 5 claiming zero confirmations were pending, when one demonstrably was. Since `dispatchOne()` now processes one message per dispatch (see `createRoutingQueue()` in `telegram-monitor.mjs`), each dispatch already starts from a fresh reasoning context — but stay disciplined about it anyway: this step's own conclusion must be grounded in an actual read of the current file content, not in whatever was inferred about "what's open" while classifying earlier in the table above.

If that re-read finds a pending confirmation after all, route to Step 4 instead — do not send the generic nudge for a message that genuinely was answering something open. Only once the file is actually, freshly confirmed empty of any relevant pending item: log to `data/telegram-inbox.md` with a timestamp, reply `Noted 👍 — commands need a /, try /help to see what I can do.` Don't guess at intent beyond that — this is a fixed reply, not an attempt to interpret what the candidate meant, so it costs nothing extra to send even though it fires more often now that free-text phrases no longer route anywhere.

### Step 6 — Update state

After processing every message this cycle: rewrite `data/telegram-state.md`'s Pending Confirmations, Batch Queue, and Recent Actions (prepend, keep last 20). One write per cycle, not per message.

**Note on Step 3d (PDF retrieval):** PDF queries are one-shot (no pending confirmation), so they don't create state entries — only log the retrieval to Recent Actions (e.g., `"2026-08-08 14:32 — retrieved PDF for report 042 (Acme)"`).

## Sending messages

`node core/plugins.mjs run telegram notify "message"` — see `plugins/telegram/skill.md` for formatting rules (HTML tags, 4096-char hard limit) and how to capture a `message_id` for threading. Keep every message mobile-readable: concise, line breaks over walls of text.

**Any message announcing a job match or evaluation result MUST include the job's own Apply URL and the report number — never a bare company/role/score summary.** Found live 2026-09-11: an operator manually delivering match results outside a normal `/run` (a resumed/stalled cycle, a retargeting follow-up) sent plain text like `"nordstrom — Assistant Manager, 3.8/5"` with no link and no report number — the candidate had a PDF and a score but no way to actually apply or reference the evaluation without asking. This applies whether the send happens inside `cycle.md`'s own Step 5 delivery or from any other context (a manual operator send, a one-off re-evaluation, a PDF regeneration reply) — the destination is always the same candidate who needs the same information to act. Use `cycle.md`'s Job Digest shape (Step 5, "Job digest") per match, adapted to Telegram's HTML subset instead of Discord's plain text:

```
<b>{Company} — {Role}</b>
Score: {X.X}/5
Apply: {the job's own URL, from the report's **URL:** line}
Report: #{num}
```

Pull the URL from the report's own `**URL:**` header line — never re-derive it from the tracker TSV or from memory. For multiple matches in one message, repeat the block per match with a blank line between; stay under the 4096-char hard limit (split into multiple sends if a batch is large).

## Scheduling — Minimal Claude entry point (zero tokens on empty polls)

This mode is meant to run on a recurring cadence. **Do NOT invoke Step 1 repeatedly through Claude** — that wastes tokens on empty polls (loading AGENTS.md + mode files even when no messages exist).

Instead, use `telegram-monitor.mjs` — a headless entry point that:
1. Polls Telegram directly (zero tokens)
2. Exits silently if no messages (zero Claude context)
3. Invokes Claude routing (Steps 2-6) **only when messages arrive**

Two modes, same token cost either way — polling itself is always zero-token in both; the difference is purely latency (how quickly a message gets picked up). **Pick one, never run both against the same bot token** — Telegram rejects concurrent `getUpdates` calls with a 409.

### Persistent long-poll daemon (recommended — 2026-08-13, seconds instead of minutes)

```bash
# As Administrator:
telegram-daemon-scheduler.bat
```

Sets up a Task Scheduler entry (`CareerOps-Telegram-Daemon`, triggered at logon) that keeps `node core/telegram-monitor.mjs --daemon` running continuously via `telegram-daemon-wrapper.bat`'s own restart-on-exit loop. The daemon holds a real Telegram long-poll open (`CAREER_OPS_TELEGRAM_LONGPOLL_SECONDS`, default 25s in the daemon) instead of checking every few minutes, so a message is picked up within seconds. Internally resilient to transient errors (logs and retries after 5s without exiting); a single-instance lock (`data/telegram-daemon.lock`) stops a second daemon instance from ever starting concurrently. This setup script automatically disables the old scheduled-poll task below if it finds one enabled, so the two can't conflict.

```bash
# Start it immediately without logging off/on:
schtasks /run /tn "CareerOps-Telegram-Daemon"

# Stop it:
schtasks /end /tn "CareerOps-Telegram-Daemon"
schtasks /change /tn "CareerOps-Telegram-Daemon" /disable
```

### Scheduled single-poll (original, higher latency)

```bash
# As Administrator:
telegram-setup-scheduler.bat
```

This creates a recurring task that runs `node core/telegram-monitor.mjs` every 5 minutes — each run does one non-blocking check and exits. A message can sit up to 5 minutes before it's noticed. Simpler operationally (nothing stays running between checks), but strictly worse latency than the daemon above for the same token cost — prefer the daemon unless there's a specific reason not to keep a persistent process running (e.g. a machine that's frequently off, where "at logon" triggers are more reliable than "must already be running").

**Manual, one-off usage (either mode):**
```bash
# One-off poll (exits silently if empty)
node core/telegram-monitor.mjs

# One-off long-poll (blocks up to 25s, exits after one round)
CAREER_OPS_TELEGRAM_LONGPOLL_SECONDS=25 node core/telegram-monitor.mjs
```

### Interactive mode (not recommended for recurring use)

For testing only, use `CronCreate` to re-enter this mode's Step 1 every few minutes within Claude Code. **Caveat:** cron jobs live only in the current session — they stop if the session ends, and auto-expire after 7 days. A `/run` trigger that kicks off a multi-hour `cycle` run will hold the session busy for that whole span (Step 3a #3) — polls queue behind it rather than being lost, but the 7-day/session-scoped ceiling still applies to the cron job itself. This is fine for testing but wasteful for production (tokens spent even on empty polls).

## What this mode never does

- Never uses `AskUserQuestion` — every candidate decision travels through Telegram.
- Never starts a task from a free-text phrase — every task-starting message must be a recognized `/command`, except a pasted job URL (deterministic pattern match) and a reply to something already pending (unambiguous by scope). A plain-English attempt like "search" or "apply all" gets logged and nudged toward `/help`, never guessed at.
- Never scans or fills an application form before the tailored resume has its own explicit `resume-approval` reply — resume review always comes first.
- Never clicks Submit without a **separate**, explicit `submit-approval` reply after the field-approval reply — three distinct gates (resume-approval, field-approval, submit-approval), never collapsed into one or skipped, even inside a batch.
- Never bulk-approves a batch's actual applications — `/applyall` only approves *starting* the queue; each row still gets its own resume-approval, field-approval, and submit-approval.
- Never treats an edit-loop round as approval — only an explicit "yes"/equivalent advances a gate; edits regenerate the preview and re-ask, they never fall through on their own.
- Never applies an edit request that violates `_profile.md`'s Accuracy Guardrails (fabrication, never-claim items) — it explains why and offers to update `cv.md` out-of-band instead.
- Never guesses an ambiguous reply toward approval — anything that isn't clearly a "yes," a "no," or a parseable edit instruction is treated as a rejection, and the candidate is told why.
- Never starts a full cycle without an explicit trigger message — no implicit or time-based auto-cycle lives in this file (that's what `CronCreate`/`docs/AUTOMATION.md` scheduling is for, and it's opt-in, set up separately).
- Never weakens any `apply`/`apply-batch`/`cycle` preflight gate (blacklist, cross-channel, knock-out, immigration-status, prohibited-content, freshness) — it only changes how the resulting question reaches the candidate.
- Never stores the bot token anywhere but `.env`, and never echoes it in a message this mode sends.
- Never reads or writes any path outside this chat's own bound workspace (the `cwd` `core/telegram-router.mjs` resolved for it) — a bound chat's session has no more structural isolation from a sibling tenant's workspace than the model's own judgment enforces, so it must never go looking at one on purpose.
