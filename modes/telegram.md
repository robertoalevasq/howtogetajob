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
  data: <stage-specific JSON — swapped-bullet list + candidate JSON path for resume-approval, field_mapping for field-approval, filled-form summary for submit-approval, question text for question (a Step 6c one-at-a-time field question additionally carries the loop's resolved/missed field list so far, so a resume knows what's already settled without re-deriving it; a Step 5-alt account-creation question instead carries a short marker — "awaiting account-creation consent", "awaiting verification", or "awaiting password paste-back" — so a resume lands on the right sub-step of that flow; for these three markers `data` is the marker string only, NEVER the generated password itself — the password is never written to this file, see `modes/apply.md` Step 5-alt item 7), eligible/excluded lists for batch-approval, empty for edit-intent; for `settings-menu`, `data` is empty — the numbered menu itself is the message already sent, nothing further to carry; for `settings-edit`, `data` is the field key being edited (one of `location`, `work_mode`, `targeting`, `salary`, `sponsorship`) so a resumed session knows which field the reply is answering without re-parsing the menu>
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
| `/yes` / `/no` / `/skip` / `/cancel` | recognized command | routes exactly like the equivalent standalone word in the Confirmation reply row below |
| Job URL | contains a job-posting URL pattern (Greenhouse/Lever/Workday/Ashby/etc.) — **the one non-slash exception**, since it's a deterministic pattern match, not an interpreted phrase | Step 3b: start apply |
| Confirmation reply | a **threaded reply** (`replyToMessageId` matches a pending confirmation's message id), OR a standalone `yes`/`y`/`go`/`no`/`skip`/`cancel` when exactly one confirmation is pending, OR **free text that isn't a job URL or a recognized command** when exactly one `resume-approval`/`field-approval`/`submit-approval`/`edit-intent`/`question`/`settings-menu`/`settings-edit` confirmation is pending — **the other non-slash exception**, since it's scoped to whatever's already open | Step 4: confirm |
| Anything else — including plain-English attempts like "search" or "apply all" | not a recognized `/command`, not a job URL, nothing pending to reply to | Step 5: note (nudges toward `/help`) |

If a standalone confirm word or free-text reply arrives with **multiple** pending confirmations (of any stage, including `edit-intent`), don't guess — reply with a numbered list of what's pending and wait for a number in a future cycle. This is the only disambiguation needed now: since PDF edits open through `/editpdf` (a command) rather than matching on free text, there's no longer a routing collision between an in-flight apply confirmation and an out-of-band PDF edit request — each pending item is unambiguous once opened.

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

5. When `cycle` finishes, `cycle.md` Step 5 (Deliver) automatically routes to the canonical Telegram delivery from `modes/_custom.md` → "Telegram Notifications", which sends the full digest of all matches ≥3.5 with PDFs. No bespoke top-match-only card here — the Telegram delivery is now uniform regardless of whether it came from `telegram` mode, a plain `/career-ops cycle` run, or any other entry point.

6. If `cycle` is interrupted before finishing (crash, session end, usage limit), don't treat that specially here — `cycle` mode's own resilience section already makes re-running safe (Pass B resumes from checkpoint, Pass A is idempotent, Step 2/3 only touch unprocessed rows). A repeated `/run` just runs Step 3a again.

### Step 3b — Start apply (single role)

0. **Resolve `args[0]` from `/apply` into a job URL first:**
   - Looks like a URL → use it directly.
   - Looks like a report number (e.g. `042`) → look it up in `data/applications.md` by the # column, follow its report link, and extract the `**URL:**` header from that report file.
   - No args → use the most recently discussed job this session.
   - Can't resolve any of the above (bad report #, no prior job discussed) → reply `Couldn't find that — send a job URL, a report number (e.g. "/apply 042"), or "/pdf" to see recent reports.` and stop; do not create a pending confirmation.
1. Acknowledge immediately: `🎯 Got it — applying to {URL}. Tailoring your resume...` (send before doing any slow work, so the candidate knows it registered).
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

1. Resolve the eligible set exactly like `apply-batch` mode's Step 1: `data/applications.md` rows with `Status: Evaluated`, `Score >= auto_pdf_score_threshold` (default 4.0), an ATS the fill flow supports (Greenhouse/Lever/Workday), and the Step 5e freshness guard against `cv.md`/`config/profile.yml`/`modes/_profile.md`.
2. Send the eligible list (report #, company, role, score) plus a separate "needs re-evaluation" list (freshness-guard exclusions) via Telegram. Store it as a `stage: batch-approval` pending confirmation — the one consolidated checkpoint for the whole batch, matching `apply-batch` mode's own Step 2.
3. On approval, write the remaining report numbers (highest score first) to `data/telegram-state.md`'s `## Batch Queue`, then start Step 3b for the first one.
4. On rejection, or a reply to the pending `batch-approval` message like "skip {company}", trim the queue accordingly (or drop the batch entirely) before starting anything — this is a reply to something already pending, not a fresh command, so free text is expected here per the SLASH-ONLY exceptions.

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
Only usable when something's already waiting on you: "yes"/"y"/"go", "no"/"skip", "cancel". If more than one thing is pending, I'll ask you to pick by number.

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
3. **On a numbered reply (1-5):**
   - `1` (Location): ask `Where are you based now? (city, state/country)` — on reply, update `location.city`/`location.timezone`/`location.country` (same inference rule `telegram-onboarding.md` Step 4b already uses: infer `country` only from an unambiguous city/country name in the reply, never guess). Send a read-back (`Got it — location is now {city}, {country}. Confirm?`), store `stage: settings-edit` with `data: "location"`, wait for "yes"/correction exactly like `telegram-onboarding.md` Step 4's own confirm loop. On confirmation, run `modes/_portals-pruning.md`'s location-triggered steps (its section 3, `location_filter`) using the new location, then return to the Step 3h.1 menu.
   - `2` (Work mode): ask `Remote only, remote preferred, hybrid ok, or onsite ok?` — parse into one of the four `location.work_mode` enum values (same mapping `telegram-onboarding.md` Step 4's `answers.workMode` parsing already uses). Read back, confirm, write `location.work_mode`. On confirmation, run `modes/_portals-pruning.md`'s work-mode-triggered steps (its section 3, `location_filter`) using the new value, then return to the menu.
   - `3` (Targeting): if currently `title_based`, ask `Add more target roles, or switch to industry-based targeting instead?` — a reply naming roles updates `target_roles.primary` (read back, confirm, run `_portals-pruning.md` sections 1-2, `title_filter.positive` and `tracked_companies`/`search_queries` pruning); a reply indicating a switch to industry-based asks `What industry, and do you know specific companies in it? (name a few, or I can suggest some)` — on reply, set `targeting_mode: "industry_based"`, populate `target_industries` with the named industry (candidate supplies or confirms a `slug`), then run `_portals-pruning.md` section 4 (`industry_companies`) to resolve companies via `discover` mode. If currently `industry_based`, offer the symmetric choice: add companies/industries, or switch back to `title_based` (switching back only changes `targeting_mode` — per `_portals-pruning.md` section 4's own note, `industry_companies` is left in place, not deleted). Read back and confirm before any write, same as every other field. On confirmation, return to the Step 3h.1 menu.
   - `4` (Salary): ask `What's your new target range?` — read back, confirm, write `compensation.target_range`/`compensation.minimum` (parse a walk-away floor from the reply if stated; otherwise leave `minimum` unchanged and say so in the read-back). On confirmation, return to the Step 3h.1 menu.
   - `5` (Sponsorship): ask `Do you need visa sponsorship now, or are you authorized?` — same non-inference rule as onboarding (never infer from location — see `telegram-onboarding.md` Step 4's "Never infer `answers.needsSponsorship` from location alone" rule). Read back, confirm, write `location.visa_status`/`needs_sponsorship`/`authorized_in` exactly per `telegram-onboarding.md` Step 4b's existing instruction for this trio. On confirmation, return to the Step 3h.1 menu.
4. **On "done" (or equivalent) with `stage: settings-menu` pending:** clear the pending confirmation, reply `Settings unchanged.` or, if any field was actually edited earlier in this session, a one-line summary of what changed. No `_portals-pruning.md` run needed here — each field edit above already ran it inline at the moment of confirmation, not batched to the end.
5. **On a reply to `stage: settings-edit`:** resolve exactly like `telegram-onboarding.md` Step 4b's own confirm-or-correct loop — "yes"/equivalent proceeds with the write already described above per field; anything else is treated as a correction and re-asks the same field's question with the new input folded in, without advancing.
6. Log every completed edit to `data/telegram-state.md`'s Recent Actions, same convention as every other step in this file.

### Step 4 — Confirm

Look up the pending confirmation the reply resolves (threaded match, or the sole pending item, or a numbered disambiguation reply).

**First, classify the reply itself** for any `resume-approval`/`field-approval`/`submit-approval` confirmation:
- **Approve** — `yes`, `y`, `go`, `approve`, `submit`, or equivalent, with no attached change request.
- **Reject** — `no`, `skip`, `cancel`, or equivalent, or an explicit "abandon this one."
- **Edit request** — anything else that reads as an instruction (e.g. "use the second onboarding bullet instead," "Q3 should mention X," "Q5: {replacement answer}"). This is the common case now — treat free text as an edit attempt, not noise.
- **Ambiguous** — doesn't clearly read as approve, reject, or a parseable instruction (e.g. "maybe later," "let me think," "?"). **Treat as reject** (never guess toward approval), but say so explicitly in the reply so the candidate knows why: `Couldn't tell if that was an approval, a rejection, or an edit request — treating it as declined. Send "/apply {report#}" to try again, or be more specific about what to change next time.`

- **`stage: question`** — feed the reply back into `apply` mode exactly as if the candidate had answered inline, then resume the paused step. This can re-enter Step 3b partway through (e.g., resume Step 6 after a Step 5e freshness question is answered "continue anyway").

- **`stage: edit-intent`** — treat the reply as the edit instruction and run Step 3e steps 3-8. If too ambiguous to apply confidently, ask a clarifying question and stay in `stage: edit-intent` rather than advancing.

- **`stage: settings-menu`** — a numbered reply (1-5) runs the matching branch in Step 3h #3; "done" (or equivalent) runs Step 3h #4. Anything else: re-send the menu with a reminder to reply with a number or "done", stay in `stage: settings-menu`.
- **`stage: settings-edit`** — resolve per Step 3h #5 (the field key being edited is `data`).

- **`stage: resume-approval`, approve** — continue Step 3b from step 3: scan the application form using the approved tailored resume.
- **`stage: resume-approval`, edit request** — parse the request against `cv.md`'s Verified Bullet Variants (match by competency, e.g. "onboarding," "invoice processing"). If it maps to a specific pre-approved variant, swap it into the tailored payload; if it maps to a claim outside the verified library (e.g. Salesforce, VLOOKUP, anything on `modes/_profile.md`'s Accuracy Guardrails never-claim list), don't apply it — explain briefly why (which guardrail it hits) and offer to update `cv.md` out-of-band instead, so it's available for future applications. Either way, regenerate the preview, resend it with the same `📄 ... Reply "yes" to continue, or tell me what to change.` framing, bump `edit_count`, and stay in `stage: resume-approval` — do not advance until an explicit approval arrives. No cap on edit rounds.
- **`stage: resume-approval`, reject** — see **Reject & clean up** below; nothing was submitted yet, so no filled-form payload to stash.

- **`stage: field-approval`, approve** — re-navigate to the report's URL fresh with Playwright (this may be a much later poll cycle; never assume a tab is still open), run `apply` mode's **Step 7b** (subagent-delegated fill) using the stored, approved mapping. Take a screenshot / summarize what filled vs. what didn't (`fields_failed`, `needs_manual_upload` from Step 7b's contract). Send it as `Everything looks good — submit? Reply "yes" to submit, "no" to cancel, or tell me what to fix.` and store a new `stage: submit-approval` confirmation. **Never skip this gate** — submitting is irreversible.
- **`stage: field-approval`, edit request** — apply the requested change to the stored field→value mapping (no form has been touched yet, so this is a cheap in-memory edit), regenerate the mapping preview, resend it with the same trailing `Reply "yes" to continue, or tell me what else to change.` hint, bump `edit_count`, stay in `stage: field-approval`. Do not fall through to filling until an explicit approval arrives.
- **`stage: field-approval`, reject** — see **Reject & clean up** below.

- **`stage: submit-approval`, approve** — click Submit (the only point that submits an **application** — a Step 5-alt signup form can also submit, but that has its own, separate consent gate), then run `apply` mode's **Step 8** (persist the `## Application Answers` section) and **Step 9** (`set-status.mjs ... Applied`, `followup-seed.mjs`). Send confirmation: `✅ Applied to {Role} at {Company}.` Remove the pending confirmation, add a line to Recent Actions.
- **`stage: submit-approval`, edit request** — validate the requested change first: reject anything that violates `modes/_profile.md`'s Accuracy Guardrails (fabrication, never-claim items) with a brief explanation, and reject anything that doesn't actually answer the field in question (ask for clarification instead of guessing). If it passes both checks, re-navigate and re-run Step 7b with the corrected field (a surgical re-fill of just that field, not a full re-run), regenerate the filled-form summary, resend `Everything look good now — submit? Reply "yes" to submit, "no" to cancel, or tell me what else to fix.`, bump `edit_count`, stay in `stage: submit-approval`. **`skip {field}`** is a recognized special case: leave that field blank in the submission and note it in the summary, for the candidate to finish manually after submit — this does not count as a rejection.
- **`stage: submit-approval`, reject** — see **Reject & clean up** below.

- **`stage: batch-approval`, reply approves** — proceed as Step 3c #3 describes.
- **`stage: batch-approval`, reply rejects** — drop the batch, confirm `No problem — send "/applyall" again whenever you're ready.`

**Reject & clean up** (any of `resume-approval`/`field-approval`/`submit-approval`, rejected or ambiguous-treated-as-rejected): mark the report `SKIP` via `node core/set-status.mjs {report#} SKIP --note "[telegram] user rejected at {stage}"`, remove the pending confirmation, and log one line to Recent Actions (`{date} — apply {report#} rejected at {stage}`). Then send a stage-specific confirmation back to the candidate — never clean up silently:
- `resume-approval` reject: `Not applying to {company} — {role}. Send "/apply {report#}" again anytime if you change your mind.`
- `field-approval` reject: `Not applying to {company} — {role}. The form was never touched. Send "/apply {report#}" again anytime if you change your mind.`
- `submit-approval` reject: also stash the filled-form payload to `data/cache/rejected-apply-{report#}.json` before discarding — it's the one artifact genuinely expensive to reconstruct. Send: `Not submitted — {company} — {role}. The filled form is saved if you want to finish it yourself, or send "/apply {report#}" to start fresh.` No expiry job for that stash; it just sits there until the candidate deals with it or the standing stray-file check in `modes/_custom.md`'s Autonomous-Run Guardrails eventually flags it stale.

**Batch progression:** whenever a row fully resolves (a `submit-approval` reply of either kind, or a `resume-approval`/`field-approval` rejection) **and `## Batch Queue` is non-empty**, immediately pop the next report number and start Step 3b for it — the candidate doesn't send a fresh `/apply` for each subsequent role, only the replies for whichever gate is currently active, one row at a time. Edit-loop rounds within a single row never advance the queue — only a terminal outcome (submitted, or rejected at any of the three gates) does. `/applyall` only approves *starting* the batch; every individual application still gets its own three gates. When the queue empties, send the batch summary (applied / skipped / needs-re-evaluation / out-of-scope counts), matching `apply-batch` mode's Step 4.

### Step 5 — Note

Anything that isn't a recognized `/command`, a job URL, or a reply to something pending: log to `data/telegram-inbox.md` with a timestamp, reply `Noted 👍 — commands need a /, try /help to see what I can do.` Don't guess at intent beyond that — this is a fixed reply, not an attempt to interpret what the candidate meant, so it costs nothing extra to send even though it fires more often now that free-text phrases no longer route anywhere.

### Step 6 — Update state

After processing every message this cycle: rewrite `data/telegram-state.md`'s Pending Confirmations, Batch Queue, and Recent Actions (prepend, keep last 20). One write per cycle, not per message.

**Note on Step 3d (PDF retrieval):** PDF queries are one-shot (no pending confirmation), so they don't create state entries — only log the retrieval to Recent Actions (e.g., `"2026-08-08 14:32 — retrieved PDF for report 042 (Acme)"`).

## Sending messages

`node core/plugins.mjs run telegram notify "message"` — see `plugins/telegram/skill.md` for formatting rules (HTML tags, 4096-char hard limit) and how to capture a `message_id` for threading. Keep every message mobile-readable: concise, line breaks over walls of text.

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
- Never applies an edit request that violates `modes/_profile.md`'s Accuracy Guardrails (fabrication, never-claim items) — it explains why and offers to update `cv.md` out-of-band instead.
- Never guesses an ambiguous reply toward approval — anything that isn't clearly a "yes," a "no," or a parseable edit instruction is treated as a rejection, and the candidate is told why.
- Never starts a full cycle without an explicit trigger message — no implicit or time-based auto-cycle lives in this file (that's what `CronCreate`/`docs/AUTOMATION.md` scheduling is for, and it's opt-in, set up separately).
- Never weakens any `apply`/`apply-batch`/`cycle` preflight gate (blacklist, cross-channel, knock-out, immigration-status, prohibited-content, freshness) — it only changes how the resulting question reaches the candidate.
- Never stores the bot token anywhere but `.env`, and never echoes it in a message this mode sends.
- Never reads or writes any path outside this chat's own bound workspace (the `cwd` `core/telegram-router.mjs` resolved for it) — a bound chat's session has no more structural isolation from a sibling tenant's workspace than the model's own judgment enforces, so it must never go looking at one on purpose.
