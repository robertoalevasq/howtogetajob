# Workday/Login-Gated ATS Account Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third path to `modes/apply.md`'s Reachability check — bot-driven account creation on a signup-capable login-gated ATS form — with its own explicit consent gate, a generated-but-never-persisted password, and a durable pause/resume flow for email verification.

**Architecture:** This is entirely mode-file prose (agent instructions), not executable code. `modes/apply.md`'s Step 5 Reachability check gains a new sub-section (Step 5-alt) inserted immediately after its existing 3 numbered items, reusing the existing `stage: question` pending-confirmation mechanism (no new stage type) the same way Step 6c already does. `core/AGENTS.md`'s Ethical Use section gains one line. No code changes, no new files, no new tests beyond the existing `node core/test-all.mjs` regression run and a manual state-machine walkthrough.

**Tech Stack:** Markdown mode-instruction files; Playwright (already in use by this mode for form-filling); the existing `telegram-poll.mjs` / `data/telegram-state.md` `stage: question` mechanism (`modes/telegram.md`).

**Spec:** `docs/superpowers/specs/2026-08-25-workday-account-creation-design.md`

## Global Constraints

- The new option only appears when the Reachability check's page read detects a *signup-capable* gate (a visible "create account"/"sign up" affordance alongside sign-in) — a pure sign-in-only wall falls through to today's unchanged two-path behavior.
- The consent-gate confirmation phrase is the literal string **"yes, create it"** — never a bare "yes" — specifically so it cannot be swept up by a different gate's generic "yes" reply.
- The email used is read from `config/profile.yml` → `candidate.email` and shown to the candidate for confirmation as part of the consent-gate message — never silently assumed.
- Generated password: **16 characters, mixed upper/lower/digit/symbol.**
- The password is **never persisted** — not in a report, not in `data/application-defaults.md`, not logged, not written to any state file. It is sent to the candidate exactly once (folded into the consent-gate confirmation or immediately after signup succeeds) and then dropped from the bot's own state entirely.
- On resume after email verification, the candidate pastes the password back from that earlier message — the bot does not (cannot) recall it.
- Reuses the **existing** `stage: question` pending-confirmation type — no new `stage:` value is added to `data/telegram-state.md`'s schema. The `data` field for this flow's question(s) records which sub-step is paused (`"awaiting verification"` or `"awaiting password paste-back"`), the same convention Step 6c's `data` field already uses to carry loop position.
- Step 6 (and everything after it) must never run until this new flow (when triggered) fully resolves — preserving the 2026-08-21 defect fix: no speculative field content before the form is genuinely reachable.
- Falls back to today's existing hard-stop (sign in yourself / skip) on: CAPTCHA on the signup form itself, a second password-policy rejection, or an "email already registered" response.
- No code files are touched. `node core/test-all.mjs` must show no new failures after every task.

---

### Task 1: Step 5-alt — the three-option gate and consent-gate wording

**Files:**
- Modify: `modes/apply.md:54-61` (the existing Reachability check's numbered items 1-3, specifically item 2's two-option list)

**Interfaces:**
- Consumes: nothing new — this task only adds prose reachable from the existing Reachability check text at `modes/apply.md:54`.
- Produces: a named sub-section ("Step 5-alt — Offer account creation") that Task 2 and Task 3 extend. The consent-gate confirmation phrase `"yes, create it"` is defined here and referenced by name in Task 3's resume-handling text — use that exact phrase, verbatim, in every task that mentions it.

- [ ] **Step 1: Read the current Reachability check text**

Open `modes/apply.md` and re-read lines 54-61 (the block starting `**Reachability check (form gated behind login/CAPTCHA):**`). Confirm item 2 still reads:

```
2. If the page/form is NOT reachable — an authentication wall, CAPTCHA, or similar blocks the real fields — **stop immediately, in this same turn, before Step 6 runs.** Do not construct a field-approval preview from the JD text plus generic ATS-category guesses; a preview built from guesses and presented as something to approve is misleading even when labeled speculative, since the candidate has no way to tell which parts are real without the actual form in front of them. Instead, tell the candidate plainly what's blocking access and offer exactly two paths forward:
   - They sign in (or create an account) themselves, in their own browser, then share the real questions — screenshot or paste — the same way Step 1's "Without Playwright" branch already works.
   - They skip this application for now; nothing is lost, and the tailored resume (already built and approved before the form was ever touched, per `modes/telegram.md` Step 3b) is unaffected.
```

If the line numbers or exact wording have drifted since this plan was written, locate the block by its heading text (`**Reachability check`) instead of trusting the line numbers above.

- [ ] **Step 2: Replace item 2's "exactly two paths" wording with three paths, and insert the new Step 5-alt sub-section**

Replace the whole item 2 bullet (the "stop immediately... offer exactly two paths forward" paragraph plus its two sub-bullets) with:

```markdown
2. If the page/form is NOT reachable — an authentication wall, CAPTCHA, or similar blocks the real fields — **stop immediately, in this same turn, before Step 6 runs.** Do not construct a field-approval preview from the JD text plus generic ATS-category guesses; a preview built from guesses and presented as something to approve is misleading even when labeled speculative, since the candidate has no way to tell which parts are real without the actual form in front of them. Instead, tell the candidate plainly what's blocking access and check whether the same page shows a "create account" / "sign up" affordance alongside sign-in (Playwright can see this in the same page read that found the gate):
   - **If a create-account affordance IS visible**, offer three paths — see "Step 5-alt — Offer account creation" below for the third:
     1. Let the bot create an account for them.
     2. They sign in (or create an account) themselves, in their own browser, then share the real questions — screenshot or paste — the same way Step 1's "Without Playwright" branch already works.
     3. They skip this application for now; nothing is lost, and the tailored resume (already built and approved before the form was ever touched, per `modes/telegram.md` Step 3b) is unaffected.
   - **If no create-account affordance is visible** (a pure sign-in-only wall — e.g. an existing-employee portal), offer only paths 2 and 3 above, exactly as before this feature existed.
```

Then, immediately after item 3 of the Reachability check (the "This check is a hard gate, not a warning..." sentence, currently the last line before "Once reachability is confirmed, the rest of the preflight runs:"), insert a new sub-section:

```markdown

### Step 5-alt — Offer account creation

Only reachable from the Reachability check above, and only when a create-account affordance was visible on the gated page. On the candidate choosing "let the bot create an account for me":

1. Read `config/profile.yml` → `candidate.email`. Send the consent-gate message:

   > "This role's application is gated behind a {ATS name} account. I can create one for you: I'd sign up using **{candidate.email}** and a randomly-generated password, which I'll send you once — this means agreeing to {ATS name}'s Terms of Service on your behalf. I won't store the password anywhere after sending it, so save it somewhere. Reply 'yes, create it' to continue, 'sign in myself' to do it yourself instead, or 'skip'."

   `{ATS name}` is the platform detected during Step 1/Step 5 preflight (e.g. "Workday"). `{candidate.email}` is shown, never silently assumed — if the candidate wants a different email for this signup, treat their reply as a correction and re-send the consent message with the corrected address before proceeding.

2. Stop and wait for the reply (Telegram: `stage: question` pending confirmation, `data: "awaiting account-creation consent"`; interactively: a normal conversational pause).
3. **"yes, create it"** (this exact phrase — a bare "yes" here does not count, since it must never collide with a different gate's generic "yes" reply) → continue to Task 2's signup flow.
4. **"sign in myself"** (or a clear equivalent) → fall back to path 2 of the Reachability check's item 2 above (candidate signs in themselves, shares the real questions).
5. **"skip"** (or a clear equivalent) → fall back to path 3 (skip this application).
6. Any other reply that isn't a clear match to one of the three → ask one clarifying follow-up ("Sorry, did you want me to create the account, would you rather sign in yourself, or skip this one?") rather than guessing which path was meant.
```

- [ ] **Step 3: Verify no other part of the file references the old "exactly two paths" wording**

Run:

```bash
grep -n "exactly two paths" modes/apply.md
```

Expected: no matches (the phrase was only ever used inside the block just edited). If a match remains elsewhere, read that context and fix it to be consistent with the new three-path wording — do not leave a stale reference to the old two-path framing.

- [ ] **Step 4: Run the mode-file test suite**

```bash
node --test tests/ 2>&1 | tail -40
```

Expected: no new failures relative to the baseline (re-run `git stash && node --test tests/ 2>&1 | tail -5 && git stash pop` first if you need a clean baseline for comparison — there is no test that asserts specific `modes/apply.md` content today, confirmed during plan-writing, so this step is a regression check, not an assertion this task must satisfy).

- [ ] **Step 5: Commit**

```bash
git add modes/apply.md
git commit --only modes/apply.md -m "feat(apply): offer bot-driven account creation at a signup-capable Reachability gate"
```

**IMPORTANT — staging discipline:** this repo has pre-existing staged files unrelated to this work (`.claude/settings.json`, `.mcp.json`, `archive/.gitkeep`) and an untracked `pipeline-batch-2026-08-03-COMPLETE-WITH-PDFS.tar.gz`. Always use `git commit --only <exact files>`, never a bare `git commit -m` after `git add` — a bare commit sweeps in whatever else happens to be staged. Run `git status` before committing to confirm only the intended file(s) are about to be committed.

---

### Task 2: Signup flow — password generation, retry-on-policy-rejection, post-signup branch

**Files:**
- Modify: `modes/apply.md` (the "Step 5-alt — Offer account creation" section Task 1 just added — append to it, do not create a second section)

**Interfaces:**
- Consumes: Task 1's Step 5-alt section header and its numbered items 1-6 (this task's new content is numbered items 7 onward, continuing the same list).
- Produces: the post-signup branch point ("no verification required" vs. "verification required") that Task 3 resumes from. Task 3 must reference this section by name ("Step 5-alt") and by its item numbers, not duplicate this content.

- [ ] **Step 1: Append the signup/password/retry logic to Step 5-alt**

Immediately after item 6 (the "any other reply" clarifying-follow-up bullet Task 1 added), append:

```markdown
7. **Generate the password.** 16 characters, mixed upper/lower/digit/symbol — a default that clears most ATS password-complexity policies without the candidate needing to specify anything.
8. **Send the password to the candidate exactly once**, folded into the confirmation of the consent-gate reply (e.g. "Got it — creating your account now. Your generated password is: `{password}` — save this, I won't show it again.") or, if signup takes a moment, immediately after step 9 succeeds. Either way, exactly once, in this turn.
9. **Drive the real signup form via Playwright** with the confirmed email and generated password — the same subagent-delegated mechanical-fill approach Step 7b already uses for the main application form (pin `model` to the resolved `spend_tier`), reusing whatever ATS-specific quirk handling from `## Known ATS Quirks` below applies to the signup form's own fields (e.g. the Workday React-field quirk applies here too, since Workday's signup form is the same React stack as its application form).
10. **Password-policy rejection.** If the signup form shows a visible validation error naming its password policy (e.g. "must include a special character," "minimum 10 characters"), regenerate a new 16-character password honoring the stated policy and retry step 9 once. A second rejection falls back to the Reachability check's existing hard-stop (tell the candidate account creation isn't working automatically, offer "sign in yourself" / "skip" — do not attempt a third generation).
11. **Email-already-registered.** If the signup form reports the email is already in use, tell the candidate plainly: "Looks like an account may already exist for {candidate.email} at {ATS name} — I don't have that account's password, so I can't sign in either." Then fall back to the same hard-stop as step 10 (sign in yourself / skip).
12. **CAPTCHA on the signup form itself.** If a CAPTCHA blocks the signup form (distinct from the login wall this whole flow exists to get past), this feature cannot proceed — fall back to the same hard-stop as step 10. This feature only ever gets past a login *wall*, never a CAPTCHA.
13. **Post-signup branch**, once step 9 succeeds without a policy rejection or CAPTCHA block:
    - **No verification required** (the account is immediately usable — some tenants allow this): proceed directly to Step 6, exactly as if the Reachability check had found the form reachable from the start.
    - **Verification required** (the typical case — a "check your email to verify your account" message appears): continue to "Step 5-alt — Resuming after email verification" below.
```

- [ ] **Step 2: Run the mode-file test suite**

```bash
node --test tests/ 2>&1 | tail -40
```

Expected: no new failures.

- [ ] **Step 3: Commit**

```bash
git status
git add modes/apply.md
git commit --only modes/apply.md -m "feat(apply): add password generation, retry-on-policy-rejection, and post-signup branch to account-creation flow"
```

Confirm via `git status` first that only `modes/apply.md` is staged for this commit (same staging-discipline note as Task 1).

---

### Task 3: Resuming after email verification — password paste-back and durable pause state

**Files:**
- Modify: `modes/apply.md` (append a new subsection after Step 5-alt, still within the Reachability-check area — before the existing "Once reachability is confirmed, the rest of the preflight runs:" line at the original line 62)
- Modify: `modes/telegram.md:34` (the `data:` field description in the `## Pending Confirmations` schema comment)

**Interfaces:**
- Consumes: Task 2's item 13 branch point ("Verification required... continue to Step 5-alt — Resuming after email verification below") and the `data: "awaiting verification"` / `data: "awaiting password paste-back"` marker convention.
- Produces: nothing further downstream — this is the last piece of the account-creation flow; once it resolves, control returns to Step 6 exactly as documented in Task 2 Step 1's "no verification required" branch.

- [ ] **Step 1: Add the "Resuming after email verification" subsection to `modes/apply.md`**

Insert this new subsection immediately after Step 5-alt's item 13 (Task 2's last addition), and before the existing "Once reachability is confirmed, the rest of the preflight runs:" line:

```markdown

### Step 5-alt — Resuming after email verification

1. Tell the candidate: "Check your email for {ATS name}'s verification link, click it, then reply here when done." Stop and wait for the reply — Telegram: `stage: question` pending confirmation, `data: "awaiting verification"`; interactively: a normal conversational pause. This pause can span a real gap (minutes to hours) while the candidate checks their inbox — the same kind of gap Step 6c's collection loop already has to survive across a Telegram poll-cycle boundary.
2. On a reply that reads as "done" (or a clear equivalent — "verified," "clicked it," "ready"): ask the candidate to paste the password back from the earlier message (the bot never stored it — see Step 5-alt item 8 above). Update the pending confirmation to `data: "awaiting password paste-back"` if this needs its own turn boundary (Telegram); interactively, this is just the next line of the same conversation.
3. On receiving the pasted password: sign in to the ATS with the confirmed email and this password via Playwright.
   - **Sign-in succeeds** → proceed to Step 6, exactly as if the Reachability check had found the form reachable from the start.
   - **Sign-in fails** (wrong/mistyped password) → ask the candidate to re-paste it; no retry cap here, this is ordinary back-and-forth with the candidate, not a self-correction loop (same convention `modes/telegram-onboarding.md` Step 4b already uses for its own correction handling).
4. On a reply that doesn't clearly read as "done" or a password (e.g. "still waiting," "having trouble," a question) — ask one clarifying follow-up rather than guessing which state the candidate is in, and stay on the same `data` marker until it's resolved.
5. If the candidate abandons this pause (never replies) — no special timeout handling; this is the same indefinite wait every other `stage: question` pause in this mode already has. The tailored resume was already built and approved before any of this started (Step 5-alt item 1 onward), so nothing is lost by an abandoned pause.
```

- [ ] **Step 2: Update `modes/telegram.md`'s Pending Confirmations schema comment**

Open `modes/telegram.md` and re-locate the `data:` field description inside the `## Pending Confirmations` comment block (around line 34). Confirm it currently reads:

```
  data: <stage-specific JSON — swapped-bullet list + candidate JSON path for resume-approval, field_mapping for field-approval, filled-form summary for submit-approval, question text for question (a Step 6c one-at-a-time field question additionally carries the loop's resolved/missed field list so far, so a resume knows what's already settled without re-deriving it), eligible/excluded lists for batch-approval, empty for edit-intent>
```

Replace it with:

```
  data: <stage-specific JSON — swapped-bullet list + candidate JSON path for resume-approval, field_mapping for field-approval, filled-form summary for submit-approval, question text for question (a Step 6c one-at-a-time field question additionally carries the loop's resolved/missed field list so far, so a resume knows what's already settled without re-deriving it; a Step 5-alt account-creation question instead carries a short marker — "awaiting account-creation consent", "awaiting verification", or "awaiting password paste-back" — so a resume lands on the right sub-step of that flow), eligible/excluded lists for batch-approval, empty for edit-intent>
```

If the exact line has drifted since this plan was written, locate it by searching for `swapped-bullet list` (a phrase unique to this one line) rather than trusting the line number.

- [ ] **Step 3: Run the mode-file test suite**

```bash
node --test tests/ 2>&1 | tail -40
```

Expected: no new failures. Specifically re-run `tests/telegram-monitor.test.mjs` and `tests/telegram-router.test.mjs` (both exist and touch Telegram plumbing) to confirm the schema-comment edit didn't collide with anything:

```bash
node --test tests/telegram-monitor.test.mjs tests/telegram-router.test.mjs 2>&1 | tail -30
```

- [ ] **Step 4: Commit**

```bash
git status
git add modes/apply.md modes/telegram.md
git commit --only modes/apply.md modes/telegram.md -m "feat(apply): add email-verification pause/resume flow for bot-driven account creation"
```

Confirm via `git status` first that only these two files are staged for this commit.

---

### Task 4: `AGENTS.md` Ethical Use addition, full state-machine walkthrough, and final regression check

**Files:**
- Modify: `core/AGENTS.md:339-347` (the `## Ethical Use -- CRITICAL` section)

**Interfaces:**
- Consumes: the complete Step 5-alt flow from Tasks 1-3 (this task's walkthrough step reads the finished result, doesn't add to it).
- Produces: nothing further — this is the plan's last task.

- [ ] **Step 1: Add one line to `core/AGENTS.md`'s Ethical Use section**

Re-read the current section (confirm it still matches):

```markdown
## Ethical Use -- CRITICAL

**This system is designed for quality, not quantity** — genuine matches, never mass-application spam.

- **NEVER submit an application without the user reviewing it first.** Fill forms, draft answers, generate PDFs -- but always STOP before clicking Submit/Send/Apply. The user makes the final call.
- **Strongly discourage low-fit applications.** Below 4.0/5, explicitly recommend against applying; only proceed if the user has a specific reason to override.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50. Guide the user toward fewer, better applications.
- **Respect recruiters' time.** Only send what's worth reading.
```

Add one new bullet immediately after the "NEVER submit an application" bullet:

```markdown
- **NEVER create an account on the candidate's behalf without its own explicit consent.** When a login-gated application offers the option, `apply` mode's account-creation flow (`modes/apply.md` → Step 5-alt) always stops for a plainly-worded, distinct confirmation before signing up — creating a real account and agreeing to a third party's Terms of Service on someone's behalf is a bigger commitment than approving form field values, and gets its own gate, never folded into a general approval.
```

- [ ] **Step 2: Manual state-machine walkthrough**

This is the plan's substantive verification step (per the spec's Testing section — this is agent-instruction prose, not executable code, so this walkthrough IS the test). Re-read the finished `modes/apply.md` Reachability check through Step 5-alt's two subsections (Tasks 1-3's combined output) end to end and trace every path by hand, confirming:

1. **No create-account affordance detected** → falls straight through to today's original two-path behavior (sign in yourself / skip), byte-for-byte unchanged from before this plan. Confirm the "If no create-account affordance is visible" bullet from Task 1 Step 2 actually says this.
2. **Candidate picks "let the bot create an account"** → consent-gate message sent, turn stops, resumes only on `"yes, create it"` / `"sign in myself"` / `"skip"` / unclear-reply-reask. Confirm Step 6 is not reachable from any point before the consent gate resolves.
3. **Consent given → signup succeeds, no verification needed** → lands directly at Step 6. Confirm this is the only path that skips the "Resuming after email verification" subsection entirely, and that it's clearly marked as the rare case.
4. **Consent given → signup succeeds, verification needed** → stops at "check your email," resumes only on a "done"-shaped reply, then asks for the password paste-back, then either succeeds into Step 6 or loops on a failed sign-in with no retry cap.
5. **Password-policy rejection (first)** → silent regenerate-and-retry, no candidate-visible interruption. **Second rejection** → hard-stop, same two paths as the no-affordance case.
6. **Email already registered** → hard-stop with the specific "account may already exist" message, same two fallback paths.
7. **CAPTCHA on signup form** → hard-stop, same two fallback paths.
8. Confirm every one of the three `data` markers ("awaiting account-creation consent", "awaiting verification", "awaiting password paste-back") added to `modes/telegram.md`'s schema comment in Task 3 actually corresponds to a real pause point in the `modes/apply.md` text — no marker should be orphaned (defined in the schema but never actually used) and no pause point should be missing a marker.
9. Confirm the password is never written to any file path anywhere across all three tasks' new text — grep for it explicitly:

```bash
grep -n "password" modes/apply.md
```

Read every match; each one should describe *generating*, *sending once*, or *asking the candidate to paste it back* — none should describe writing it to `data/application-defaults.md`, a report, or any other file.

If the walkthrough finds a gap (an orphaned marker, a path that reaches Step 6 without resolving consent, a hard-stop that's missing one of the two fallback options), fix it directly in the relevant task's file before proceeding — this walkthrough is the gate for calling the plan done, not a separate follow-up.

- [ ] **Step 3: Full regression run**

```bash
node core/test-all.mjs 2>&1 | tail -60
```

Expected: no new failures relative to `main` before this plan's first commit (Task 1). If `test-all.mjs` doesn't exist or errors for an unrelated reason, fall back to `node --test tests/ 2>&1 | tail -60` and note the discrepancy in the commit message.

- [ ] **Step 4: Commit**

```bash
git status
git add core/AGENTS.md
git commit --only core/AGENTS.md -m "docs(agents): document the account-creation consent gate in Ethical Use"
```

Confirm via `git status` first that only `core/AGENTS.md` is staged (if the walkthrough in Step 2 required fixes to `modes/apply.md` or `modes/telegram.md`, commit those separately first with their own `git commit --only`, before this final `core/AGENTS.md` commit — never bundle a walkthrough fix into an unrelated file's commit).
