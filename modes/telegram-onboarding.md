# Mode: telegram-onboarding — Provisioning a New Workspace via Telegram

Runs the conversational half of a new person's setup, once `core/telegram-router.mjs` has already redeemed their access code. This file is a thin question-and-write layer over the same ground the interactive "First Run — Onboarding" section of `core/AGENTS.md` covers — CV, profile basics, portals defaults — just delivered as short Telegram messages, one question at a time, and ending with the workspace becoming bound instead of "the basics are ready."

**HEADLESS.** Never use `AskUserQuestion` in this mode — every question is a Telegram message, and this mode pauses (returns from this turn) until the next poll delivers a reply.

**Every outbound message in this conversation uses an explicit chat-id override — never rely on `config/plugins.yml`'s `chat_id`:**

```bash
node core/plugins.mjs run telegram notify "message text" --chat-id {chatId}
```

`{chatId}` is given in this turn's prompt. This is deliberate and different from `modes/telegram.md`'s own convention (which relies on `ctx.settings.chat_id` once a chat is bound) — during onboarding, no workspace exists yet, or one exists but isn't finished being configured, so the `--chat-id` flag is the only reliable target for the whole conversation, start to finish.

## State

Onboarding state lives at `data/onboarding/{chatId}.json` (hub-global, written by `core/telegram-router.mjs` on redemption and updated by this mode as the conversation progresses):

```json
{
  "chatId": "12345",
  "redeemedCode": "...",
  "slug": null,
  "answers": {},
  "currentStep": "name",
  "startedAt": "2026-08-18T...",
  "lastMessageAt": "2026-08-18T..."
}
```

`currentStep` is one of: `name`, `cv`, `profile`, `profile_confirm`, `profile_narrative`, `discord`, `done`. This mode reads the state, processes the new message against `currentStep`, writes the answer into a real file as soon as it's given (never held only in memory), advances `currentStep`, and re-saves the state — except at `done`, where the state file is deleted instead (see Step 6).

## Step 1 — Welcome (first turn only, `currentStep: "name"` with no prior answer)

If this is the very first message since redemption (no `answers.name` yet), send:

> `🎉 You're in! Let's get you set up — takes about 5 minutes. First, what's your name?`

Wait for the reply.

## Step 2 — Name → slug → provision

On receiving a name reply:

1. Store it: `answers.name = "<reply text>"`.
2. **Never interpolate the reply text directly into a shell command** — it is untrusted external content (a Telegram message from someone who has proven nothing beyond holding a valid code) and must never be built into a `Bash` command string, the same discipline this codebase uses everywhere else for untrusted text. Instead:
   a. Write the raw name, verbatim, to a fixed scratch path: `.tmp/onboarding-name-{chatId}.txt` (create `.tmp/` if it doesn't exist).
   b. Resolve a slug: `node core/provision-workspace.mjs --from-name-file .tmp/onboarding-name-{chatId}.txt` — prints the resolved slug (already deduped against existing workspaces) to stdout. Record `state.slug` = that printed value. Because the shell command line itself only ever contains the fixed, caller-chosen path (never the name's own content), nothing the candidate typed can affect how this command is parsed.
   c. Delete the scratch file once the slug is resolved.
3. Provisioning already happened as a side effect of step 2 (`--from-name-file` calls `provisionWorkspace()` internally) — do not call `provision-workspace.mjs <slug>` again separately.
4. Advance `currentStep` to `cv`, save state.
5. Send: `Thanks {name}! Now, paste your CV/resume as text — don't worry about formatting, I'll clean it up.`

From this point on, every file write below targets `workspaces/{slug}/...` by its full path (not a bare relative path — this mode's own session `cwd` is fixed at the **repo root** for its whole lifetime, including after `state.slug` exists; `core/telegram-router.mjs` dispatches every onboarding turn with `cwd = repoRoot` unconditionally, precisely so the hub-global `data/onboarding/{chatId}.json` and the repo-root seed templates stay reachable by their bare relative paths). Only the *content* of files inside the new workspace changes, never the session's own working directory.

## Step 3 — CV

On receiving the CV text reply:

1. Convert it to clean markdown (standard sections: Summary, Experience, Projects, Education, Skills) — same conversion the interactive onboarding flow already does.
2. Write to `workspaces/{slug}/cv.md`.
3. Advance `currentStep` to `profile`, save state.
4. Send: `Got your CV. Now a few quick questions:\n1️⃣ What roles are you targeting? (e.g. "Senior Backend Engineer")\n2️⃣ Location/timezone?\n3️⃣ Remote only, or open to hybrid/onsite too?\n4️⃣ Salary target range?\n5️⃣ Do you need visa sponsorship to work there, or are you already authorized?\n\nReply with all five, in any format — I'll figure it out.`

## Step 4 — Profile basics: parse and confirm

On receiving the roles/location/work-mode/salary/sponsorship reply:

1. Parse the five answers (best-effort natural-language extraction — if something's ambiguous, ask a single focused follow-up rather than guessing, then continue once answered). If the reply names more than one acceptable location (found live 2026-08-20: a real reply named four — "Tampa, anywhere in California, Chicago, Pittsburgh" — and only the one asked about for timezone purposes made it into any file, silently dropping the other three), identify which is primary (ask if it isn't already clear) and keep the rest as a separate list for the flexibility note Step 4b writes.
2. Store the parsed answers in `answers.roles`, `answers.primaryLocation`, `answers.otherLocations` (array, may be empty), `answers.workMode`, `answers.salary`, and `answers.needsSponsorship` (boolean) — this is the source Step 4b writes from, so nothing needs re-parsing after confirmation. `answers.workMode` must be one of `remote_only` / `remote_preferred` / `hybrid_ok` / `onsite_ok` — map the candidate's own words onto these (e.g. "remote only" → `remote_only`, "prefer remote but open to hybrid" → `remote_preferred`, "fine with hybrid" → `hybrid_ok`, "happy to be in office" → `onsite_ok`); if the reply doesn't clearly resolve to one of the four, ask a single focused follow-up rather than guessing — this feeds real evaluation scoring (`modes/oferta.md` Block A's Remote row), not just a form field. **Never infer `answers.needsSponsorship` from location alone** (found live 2026-08-25: an onboarding run derived it from "Tampa, FL" and silently inherited the seeded template's "no sponsorship needed, US-authorized" default instead — living somewhere doesn't establish work-authorization status; a candidate could live in the US on a visa needing sponsorship, or vice versa). If the reply doesn't clearly answer this specific question, ask it again as its own focused follow-up before proceeding — this is exactly the kind of fact AGENTS.md's Source-of-Truth Boundary requires to come from an explicit statement, not an assumption, since it feeds real evaluation scoring (work-authorization check) and real visa-sponsorship answers on real job applications.
3. Send a read-back so the candidate — not a script — is the one who notices a dropped detail (this is what would have caught the four-locations case at the source):
   `Got it — here's what I have:\nRoles: {roles}\nPrimary location: {primaryLocation}{, also open to: {otherLocations} — only if otherLocations is non-empty}\nWork mode: {"Remote only" | "Remote preferred" | "Open to hybrid" | "Open to onsite", from answers.workMode}\nTarget comp: {salary}\nSponsorship: {"Needs sponsorship" or "Already authorized, no sponsorship needed"}\n\nReply "yes" to continue, or tell me what to fix.`
4. Advance `currentStep` to `profile_confirm`, save state. Do not write any workspace files yet — Step 4b does that, only after confirmation.

## Step 4b — Profile basics: write files

On receiving the `profile_confirm` reply:

1. If it's a correction (not "yes"/equivalent): re-parse the correction against the stored `answers.*` (update only what changed), re-send the same read-back format as Step 4's item 3 with the corrected values, stay on `profile_confirm` (don't advance). No retry cap here — this is an ordinary back-and-forth with the person, not a self-correction loop.
2. Once confirmed ("yes" or equivalent):
   a. Copy `config/profile.example.yml` (the repo-root template — a bare relative path is correct here, the session cwd *is* the repo root) into `workspaces/{slug}/config/profile.yml` if it isn't already the seeded template (it already is, from `--from-name`'s provisioning step). Edit it in full — the seeded copy is the *example* template verbatim, and every one of its example values is fabricated content about a fictional person ("Jane Smith," a fake LinkedIn/GitHub, an invented "built and sold my SaaS" story). Leaving any of it in place is exactly the fabrication this system's own non-negotiable rule (AGENTS.md → Source-of-Truth Boundary) exists to prevent — it must never survive onboarding:
      - `target_roles`/`compensation.target_range`/`compensation.minimum`: fill from the confirmed `answers.roles`/`answers.salary`.
      - `location.city`/`location.timezone`: fill from the confirmed `answers.primaryLocation`.
      - `location.country`: infer from `answers.primaryLocation` only when it's an unambiguous country/city name (e.g. "Tampa, FL" → "United States") — this is reading an already-stated fact, not inventing one.
      - `location.visa_status`/`needs_sponsorship`/`authorized_in`: fill from `answers.needsSponsorship` (Step 4, confirmed) — **never leave the template's "No sponsorship needed"/`false`/`["United States"]` in place unexamined.** If `answers.needsSponsorship` is true, write a plain-language `visa_status` reflecting that, `needs_sponsorship: true`, and `authorized_in: []` (or the specific country they confirmed authorization in, if they said one) — do not default this trio to the seeded persona's US-authorized example just because it's already there.
      - `location.work_mode`: write `answers.workMode` verbatim (one of `remote_only`/`remote_preferred`/`hybrid_ok`/`onsite_ok`) — never leave the template's `"no_preference"` default in place once the candidate has actually answered the work-mode question.
      - `compensation.location_flexibility`: if `answers.otherLocations` is non-empty, a plain-language note naming them (e.g. `"Tampa is home base; also open to relocating to California, Chicago, or Pittsburgh"`) — never leave it blank when the candidate named more than one place. Blank (`""`) only when `answers.otherLocations` is empty.
      - `candidate.email`/`candidate.phone`/`candidate.linkedin`/`candidate.portfolio_url`/`candidate.github`: fill from whatever the pasted CV (Step 3) actually contains — if the CV has no GitHub link, for example, set `github: ""`, never leave the template's `github.com/janesmith`. **Verify each one before writing it**, not just at the end (found live 2026-08-25: a real run wrote a plausible-looking `github.com/{username}` guessed from the candidate's own portfolio/LinkedIn handles, even though no GitHub link appeared anywhere in the pasted CV) — for each of these five fields, the value must be a literal string that appears in Step 3's pasted CV text; if you cannot point to where in that text the value came from, it doesn't belong here, and the field is blank (`""`) instead.
      - `candidate.twitter`: blank (`""`) unless the CV explicitly gives one — never leave the template's placeholder.
      - `narrative.headline`, `narrative.exit_story`: blank (`""`) — nothing in this conversation asks for these, so there is no real answer to put here, only the template's fabricated one to remove.
      - `narrative.superpowers`: blank (`[]`) for now.
      - `narrative.proof_points`: derive 2-3 entries from the CV's (Step 3) strongest **quantified** achievements — the same kind of content `_brief.md`'s Proof Points section below already draws from (e.g. "15+ dashboards delivered for 5 departments," "91% accuracy classification model"). Use the template's `{name, url, hero_metric}` shape; omit `url` (leave `""`) when the CV doesn't give one for that achievement. Never invent a metric the CV doesn't state — this is content already collected in Step 3, reused more fully, not a new claim.
   b. Edit `workspaces/{slug}/portals.yml`'s `title_filter.positive` list (found live 2026-08-20: this drives what job postings scanning actually searches for, and the seeded template ships it pre-filled with AI/ML-focused example keywords — "GenAI," "LLMOps," "Agentic," etc. — that match nothing for a candidate targeting an unrelated field, silently making every scan return zero relevant results). Replace the seeded list with keywords drawn directly from `target_roles.primary` (the same roles just written to `profile.yml` above) plus their obvious close synonyms (e.g. targeting "Data Analyst" → also add "Data Analytics," "Business Intelligence," "BI Analyst" — stay close to what was actually said, never invent an unrelated specialty). Leave `title_filter.negative` and `seniority_boost` as seeded — tuning those further is a reasonable thing to leave for the candidate to refine later through normal conversation, not something onboarding needs to guess at.
   b2. **Prune the rest of the scan universe to match — `title_filter.positive` alone doesn't fix the cost problem** (found 2026-08-25, auditing a real workspace onboarded via this exact flow on 2026-08-20: `title_filter.positive` had been correctly fixed by step (b) above, but the seeded `tracked_companies` (~130 entries) and `search_queries` (~40 entries, mostly `enabled: true`) were untouched — both scaffolded around the same AI/Forward-Deployed/DevRel demo archetype the template's `title_filter` example keywords come from, mostly non-US. A mismatched entry still pays its real scan cost — a WebSearch call, or a Playwright/API company fetch — every run even though it can never pass the now-correct title filter, which is exactly what made that candidate's first real scan take too long). Before advancing:
      - **Preferred path — toggle, don't delete:** for each `tracked_companies` entry whose `scan_method: websearch` carries a hardcoded `scan_query` with no keyword overlapping `target_roles.primary` (e.g. a query locked to `"AI Engineer" OR "Forward Deployed"` for a candidate targeting Data Analyst roles), set `enabled: false` — that query can never surface a matching title, so leaving it on only burns a WebSearch call every run for zero possible yield. Same for any `search_queries` entry whose `query:` keywords don't overlap `target_roles.primary`. `enabled: false` keeps entries available if the candidate's targeting changes later, so prefer it whenever the edit is practical within this dispatch's time/token budget (onboarding runs on a bounded timeout with a fast pinned model — see `core/telegram-monitor.mjs`'s `ONBOARDING_TIMEOUT_MS`/`ONBOARDING_MODEL`).
      - **Fallback path — replace, don't leave bloat:** if toggling every mismatched entry individually isn't practical in this dispatch (found live 2026-08-25: the seeded `tracked_companies`/`search_queries` run to ~170 combined entries, and a bounded onboarding dispatch reasonably rewrote the section from scratch rather than editing each one), replacing `tracked_companies`/`search_queries` with a small, freshly-written set is an accepted alternative — carry forward any *seeded* entry that already matches `target_roles.primary` (checked against its real, already-validated URL/`api:`/`scan_query`, never invented), and write new `search_queries` entries in the seeded file's own format, scoped to `target_roles.primary`, using only real ATS `site:` patterns already demonstrated elsewhere in the template (Greenhouse/Ashby/Lever/etc.) — never fabricate a company name or URL that wasn't already in the seeded file. `tracked_companies: []` is a correct, honest outcome when nothing seeded matches — don't hand-pick a curated replacement company list to fill it; that needs verified real ATS URLs (`discover` mode), out of scope for onboarding.
      - **Either path, always:** if `answers.primaryLocation`/`answers.otherLocations` name a specific country/region rather than "anywhere"/"global remote," write an active `location_filter` block (`always_allow`/`allow`/`block`) matching the candidate's actual policy — `portals.yml` ships this block commented out by default, and it costs nothing to add regardless of which path above was taken, so never skip it. If `answers.workMode` is `remote_only` or `remote_preferred`, include `"Remote"` in `always_allow` regardless of what else is listed there — the block's own "empty location → pass" default means scan-level filtering can't fully enforce a remote-only policy on postings with no location metadata at all; the evaluation-time cap in `modes/oferta.md` Block A is what actually enforces that case, this just keeps the scan from needlessly dropping postings that *are* correctly tagged remote.
      - Skip this whole sub-step only if `target_roles.primary` genuinely is AI/ML/DevRel-adjacent and the candidate's location answer is global/remote-anywhere — in that case the seeded scaffold is already a reasonable fit.
   c. Edit `workspaces/{slug}/_profile.md` and `workspaces/{slug}/_brief.md` (found live 2026-08-20: both are seeded from `modes/_profile.template.md`/`modes/_brief.template.md` by provisioning, exactly like `portals.yml`, and neither was otherwise touched by this mode — left alone, `_profile.md`'s "Your Target Roles"/"Your Adaptive Framing" tables ship generic AI/LLMOps example archetypes that drive real scoring per `core/AGENTS.md`'s "Archetypes / targeting → `_profile.md`", and `_brief.md` — read by `modes/triage.md` on every first-pass filtering decision — ships as entirely unfilled `{placeholder}` text):
      - `_profile.md`: replace the "Your Target Roles" and "Your Adaptive Framing" tables' example rows with the candidate's actual `target_roles.primary`/`archetypes` (from profile.yml, above) and proof points drawn only from what their CV (Step 3) actually contains. Leave the rest of the file (negotiation scripts, comp/location scoring guidance) as seeded — it's generic instructions to the agent, not a factual claim about the candidate, so it isn't fabrication.
      - `_brief.md`: fill in Identity, Target Archetypes, Proof Points, and Comp Strategy from the same roles/CV/location/salary/sponsorship data already collected in this conversation — Identity's citizenship/sponsorship line must match `answers.needsSponsorship` exactly, never the seeded template's "US citizen, no sponsorship needed" placeholder. For sections with no real answer yet (Hard DQ Criteria, Soft Red Flags, Priority Override List), leave an explicit "none yet" rather than inventing one — same convention the seeded `_custom.md` already uses for its own empty sections.
   d. Run the completeness check: `node core/doctor.mjs --target workspaces/{slug} --json` and read `.templateLeftovers` from its output. If it's a non-empty array: re-edit the flagged fields/files using data already in this conversation (no new question to the candidate — this is self-correction against information already gathered, not a wait on a reply), then re-run the same command once. If `.templateLeftovers` is still non-empty after that one retry: proceed anyway (never leave a real person stuck mid-setup on an internal QA issue), but append one line to `data/onboarding-gaps.log` (hub-global, repo root — create the file if it doesn't exist) in this exact format: `{ISO timestamp} chatId={chatId} slug={slug} fields={comma-separated file:field entries from the still-flagged findings}`. This is one bounded retry, never more — matches this codebase's existing "flag, never silently hide" convention (`data/blacklist.md`, agent-inbox) rather than looping indefinitely.
   e. Send: `One more optional thing — in a line or two, how would you pitch yourself professionally, and what's your #1 strength that sets you apart? Reply "skip" to finish now — you can always tell me more later.`
   f. Advance `currentStep` to `profile_narrative`, save state.

## Step 4c — Professional headline (optional)

On receiving the `profile_narrative` reply:

1. If it's "skip" (or equivalent): leave `workspaces/{slug}/config/profile.yml`'s `narrative.headline` (`""`) and `narrative.superpowers` (`[]`) as Step 4b left them — this is still correct, not a gap, exactly like the Discord webhook being skippable.
2. Otherwise, write the reply to those fields **lightly polished, not verbatim and not embellished**: fix grammar/phrasing/conciseness for a professional tone, but preserve every factual claim exactly as given and never add a claim, metric, or descriptor the candidate didn't state — the same "keywords get reformulated, never fabricated" discipline `core/AGENTS.md`'s Source-of-Truth Boundary already requires everywhere else in this system (CV tailoring, cover letters), applied here to the candidate's own self-description instead of CV bullets. A single strength becomes a one-item `narrative.superpowers` list; multiple strengths in one reply split into separate list items, each polished the same way. The "how would you pitch yourself" half of the reply goes to `narrative.headline`.
3. Send: `Last setup choice — how much do you want to spend on model usage per evaluation?\n💰 economy — cheapest/fastest, good for scanning lots of offers\n⚖️ standard — balanced (most people pick this)\n💎 premium — most capable, best for offers you really care about\n\nReply with one word, or "skip" for economy (the default).`
4. Advance `currentStep` to `discord`, save state (the spend-tier reply is handled inline in Step 5, since it's the same logical question set — `currentStep` only needs to distinguish "waiting on the headline/skip reply" from "waiting on discord/skip").

## Step 5 — Spend tier + Discord webhook (optional)

On receiving the spend-tier reply:

1. Set `workspaces/{slug}/config/profile.yml`'s `spend_tier` to the matched value — `economy` for "skip" (or any reply that doesn't clearly match one of the three; found live 2026-08-25, worth surfacing as an explicit option rather than an unstated fallback — compute is shared across every tenant on one account, and `economy` is the safer default as more people onboard onto it).
2. Send: `One more optional thing — want progress updates in Discord too? Paste a webhook URL, or reply "skip".`

On receiving the Discord reply:

1. If it's "skip" (or equivalent): leave `workspaces/{slug}/config/plugins.yml`'s `discord.enabled: false` (the seeded template default — no edit needed). Go to step 3.
2. Otherwise, **validate before writing anything** — the reply is untrusted external content, and `.env` is a file `dotenv` parses as `KEY=value` lines for every node process run at that workspace's cwd, so an unvalidated multi-line paste could inject arbitrary keys. It must be a single line matching `^https://discord\.com/api/webhooks/\d+/[\w-]+$` (Discord's actual webhook URL shape) with no other content:
   - **Matches:** write it to `workspaces/{slug}/.env` as `DISCORD_WEBHOOK_URL=...` on its own line (create the file if it doesn't exist; never echo the URL back in a Telegram message). Set `workspaces/{slug}/config/plugins.yml`'s `discord.enabled: true`.
   - **Doesn't match:** don't write anything. Reply `That doesn't look like a Discord webhook URL (should start with https://discord.com/api/webhooks/...) — paste it again, or reply "skip".` and stay on this same question (do not advance `currentStep`).
3. Either way, also set `workspaces/{slug}/config/plugins.yml`'s `telegram.enabled: true`, `telegram.chat_id: "{chatId}"`, and `telegram.chat_ids: ["{chatId}"]` — this is what makes the *ordinary* post-onboarding `modes/telegram.md` flow able to message them normally via `ctx.settings`, once bound. (This does not itself bind the chat — see Step 6.)
4. Advance `currentStep` to `done`, save state.

## Step 6 — Bind and finish

1. Run the bind: `node core/provision-workspace.mjs --bind-chat {slug} {chatId}`. This sets `workspaces/{slug}/workspace.json`'s `chat_id` — the one action that makes `core/telegram-router.mjs` recognize this chat as bound from the next poll onward. On failure (e.g. `already bound`), treat it like any other step failure — see "Error handling" below — never retry blindly.
2. Delete the onboarding state: remove `data/onboarding/{chatId}.json` — the hub-global one at the **repo root** (this session's cwd), never a copy under `workspaces/{slug}/`.
3. Send the completion message, followed immediately by `modes/telegram.md` Step 3g's exact help text (read it from that file — never duplicate/paraphrase it here, since it drifts):
   > `✅ All set! You're ready to search. Here's what I can do:`
   Then send one more short message inviting ongoing enrichment for whatever's still deliberately blank (exit story, hard disqualifiers, priority companies, and headline/superpowers if Step 4c was skipped):
   > `The more you tell me about yourself over time, the smarter this gets — just message me anytime.`
4. Nothing further happens in this turn — the *next* message from this chat will be picked up by `core/telegram-router.mjs` as a bound chat and routed through `modes/telegram.md` normally.

## `/restart`

Recognized at any point during onboarding (mirrors the edit-loop pattern in `modes/telegram.md`): delete `data/onboarding/{chatId}.json` (again, the hub-global one at the repo root) and send `No problem — let's start over. What's your name?`, effectively re-running Step 1. Does **not** delete an already-provisioned-but-unbound `workspaces/{slug}/` directory from a prior attempt — that's inert clutter until the operator notices and cleans it up manually, same "flag, never auto-delete" treatment as everywhere else in this codebase's data-contract conventions. If the person completes onboarding again under a new name after a `/restart`, they get a second workspace directory (a harmless, if slightly confusing, side effect of restarting after already having provisioned once — not worth special-casing for a ~2-20 person circle).

## Error handling

If a step's tool call fails (a write error, `provision-workspace.mjs` exiting non-zero), do not fabricate progress — send `⚠️ Something went wrong on my end — could you resend that last message?`, leave `currentStep` unchanged, and stop this turn. The next message retries the same step. This applies to Step 4b's `doctor.mjs` completeness check crashing/erroring outright too — that's a tool failure like any other. It does **not** apply to a clean `doctor.mjs` run that finds real `templateLeftovers`: that case is handled entirely inside Step 4b (one self-correction retry, then proceed and log), never by this generic "resend the last message" path, since there's no last message to resend — the candidate never sees this check happen at all unless it changes what gets written.

## What this mode never does

- Never uses `AskUserQuestion`.
- Never sends a message without the explicit `--chat-id {chatId}` flag.
- Never binds a chat (`workspace.json`'s `chat_id`) until every prior onboarding question has actually been answered — the bind call itself is the first action of Step 6, precisely because a failure there (e.g. "already bound") should leave the onboarding state and pending completion message untouched, safe to retry, rather than happening after the state is already deleted and a false success message already sent.
- Never invents CV content, skills, or achievements not present in what the candidate actually pasted — same non-fabrication discipline as every other content-generating mode in this system. The same rule applies to Step 4c's optional headline/strength question: polishing the candidate's own words for grammar and tone is fine, adding a claim, metric, or descriptor they didn't state is not.
- Never requires the Discord webhook — it is always skippable.
- Never reads or writes any path outside `workspaces/{slug}/...` (this conversation's own workspace, once it exists), the hub-global `data/onboarding/{chatId}.json` state file, or the hub-global `data/onboarding-gaps.log` file. Redeeming a code proves someone holds it, not that they're trusted with another tenant's `cv.md`, tracker, or reports — this mode has no more structural isolation from a sibling workspace than the model's own judgment enforces, so it must never go looking at one on purpose.
