# Apply Mode — Autonomous Account Creation for Login-Gated ATS Forms

**Status:** Approved, pending implementation plan
**Date:** 2026-08-25
**Author:** Roberto Alevás Vásquez (via Claude)

## Context

`modes/apply.md`'s Reachability check (Step 5, shipped 2026-08-24 in response to a real 2026-08-21 incident) hard-stops the moment a form is found gated behind a login/CAPTCHA wall — it explicitly refuses to invent or use candidate credentials, offering only two paths: the candidate signs in themselves and shares the real questions, or they skip the application. This closed a real defect (speculative field content generated before a Workday login gate was discovered) but leaves every login-gated ATS application requiring the candidate's own manual intervention.

The user wants a third option: let the bot create the ATS account itself — using the candidate's own (confirmed) email plus a randomly-generated password — so it can get past a signup-capable gate without the candidate needing to leave the conversation. This directly intersects with the just-shipped Reachability check and introduces something the system has never handled before: a generated secret that must be communicated to the candidate and, in some cases, used again later in the same flow.

A key constraint discovered while scoping this: Workday (and most ATS signups) requires clicking an email verification link before the new account is usable, and the bot has no access to the candidate's inbox unless they've separately connected the optional Gmail plugin (off by default). This means full end-to-end autonomy isn't achievable for most users regardless of design — the flow must accommodate a real pause while the candidate checks their own email.

## Goals

1. **A third path at the Reachability gate**, offered only when the detected gate is signup-capable (a "create account" affordance is visible alongside sign-in, which Playwright can detect in the same page read that found the gate): create an account for me / sign in myself / skip.
2. **An explicit, separate consent gate before any signup action.** Creating a real account and agreeing to the ATS's Terms of Service on the candidate's behalf is a materially bigger commitment than approving field values — it gets its own plainly-worded confirmation, distinct from the existing field-approval "reply yes," using a distinguishable confirmation phrase ("yes, create it") so it can't be swept up by a different gate's generic "yes."
3. **Email confirmed, never assumed.** The email used for signup is read from `config/profile.yml` and shown to the candidate for confirmation as part of the consent gate — never silently applied.
4. **Password never persisted.** Generated (16 chars, mixed upper/lower/digit/symbol), sent to the candidate exactly once via chat, then dropped from the bot's own state entirely — never written to a report, `data/application-defaults.md`, or any log.
5. **Handle the email-verification pause.** If Workday requires verification, the bot stops the turn (existing `stage: question` mechanism), asks the candidate to verify and reply when done, then — because the password was never stored — asks them to paste it back from the earlier message before signing in and proceeding.
6. **Generalizes to any login-gated ATS**, reusing the same Reachability detection Step 5 already has — this isn't Workday-specific machinery, Workday is just the ATS that surfaced the need.
7. **A durable resume position.** Because a real-world pause (checking email) can span a poll-cycle boundary in Telegram, the pending confirmation's `data` field must record which sub-step this flow is paused at ("awaiting verification" vs. "awaiting password paste-back") — the same durability pattern the 2026-08-24 one-at-a-time collection plan already established for Step 6c's skip-tracking, reused verbatim, no new stage type.

## Non-goals

- **No CAPTCHA solving.** This only gets past a login/signup *wall* with a visible create-account form. A CAPTCHA on that signup form still falls back to today's hard-stop.
- **No account creation when the gate isn't signup-capable** (pure sign-in-only walls, e.g. an existing-employee portal). The new third option never appears in that case; today's two-path behavior is unchanged.
- **No password persistence of any kind**, transient or durable. This was considered (a short-lived entry in the same pending-confirmation state used elsewhere) and explicitly rejected in favor of the candidate being the password's only record after the initial send.
- **No requirement on the Gmail plugin.** The candidate completes email verification themselves, in their own inbox, exactly as they would if they'd signed up on their own — this feature saves them the signup form-filling, not the verification step.
- **No change to the three-gate approval model** (resume-approval → field-approval → submit-approval) or to Step 6/6b/6c's field-collection logic — this only extends what happens at the Reachability gate, before any of that runs.
- **No standing "always auto-create, never ask" preference.** Every signup-capable gate gets its own explicit consent gate; a durable opt-out-of-asking is a possible future `_custom.md` house rule but out of scope here.

## Architecture

**Step 5-alt — Offer account creation (new, inserted into the existing Reachability check in Step 5).**

When the Reachability check's page read detects a login/CAPTCHA gate, before presenting the existing two options, check whether the same page also shows a "create account" / "sign up" affordance alongside sign-in. If so, present three options instead of two:

1. Create an account for me
2. I'll sign in myself
3. Skip this application

Options 2 and 3 behave exactly as today's Step 5 already documents — unchanged. Option 1 triggers the new flow below. If no create-account affordance is visible, this step is a no-op and today's two-path behavior applies unchanged.

**Consent gate.** On "create an account for me," before touching the signup form, send:

> "This role's application is gated behind a {ATS} account. I can create one for you: I'd sign up using **{email from config/profile.yml}** and a randomly-generated password, which I'll send you once — this means agreeing to {ATS}'s Terms of Service on your behalf. I won't store the password anywhere after sending it, so save it somewhere. Reply 'yes, create it' to continue, 'sign in myself' to do it yourself instead, or 'skip'."

Only the literal "yes, create it" (not a bare "yes") proceeds — chosen specifically to avoid collision with the generic "yes" used by field-approval and submit-approval gates elsewhere in this mode.

**Signup.** On confirmation: generate a 16-character password (mixed upper/lower/digit/symbol), drive the ATS's real signup form via Playwright with the confirmed email and generated password, and send the password to the candidate exactly once, either folded into the consent-gate confirmation message or immediately after signup succeeds.

**Password-policy rejection.** If the signup form rejects the generated password (a visible validation error naming its policy — e.g. "must include a special character"), regenerate once honoring the stated policy and retry. A second failure falls back to today's hard-stop (sign in yourself / skip) rather than guessing further.

**Post-signup branch:**
- **No verification required** (rare — some tenants allow immediate use): proceed directly to Step 6 as if reachability were confirmed normally.
- **Verification required** (typical): stop this turn via the existing `stage: question` mechanism, telling the candidate to check their email, click the link, and reply when done. The pending confirmation's `data` records this flow is paused at "awaiting verification."

**Resume after verification.** On the candidate's "done" (or equivalent) reply: ask them to paste the password back from the earlier message. Update the pending confirmation's `data` to "awaiting password paste-back" if a further pause is needed (e.g. an unclear reply prompts a re-ask). Once the password is provided, sign in with it via Playwright and proceed to Step 6 exactly as if reachability were confirmed normally. A wrong/mistyped password produces a failed sign-in — ask the candidate to re-paste; no retry cap, ordinary back-and-forth rather than a self-correction loop, matching the convention already used for confirm-loops elsewhere in this system (e.g. `modes/telegram-onboarding.md` Step 4b's correction handling).

**Email-already-registered.** If the signup form reports the email is already in use (a prior application by the candidate, or a prior run of this same feature), tell the candidate an account may already exist there and fall back to the existing two options — the bot never has that account's password, so it cannot sign in on their behalf either.

**Documentation touch:** `core/AGENTS.md`'s "Ethical Use" section gets one additional line alongside its existing "never submit an application without the user reviewing it first" — noting that account creation on a candidate's behalf likewise never proceeds without its own explicit consent gate, so this boundary is discoverable in the same place as the system's other stop-before-acting rules, not only inside `apply.md`.

## Testing

`modes/apply.md` (and the one-line `AGENTS.md` addition) are agent-instruction prose, not executable code — verified the same way this session's other `modes/apply.md` changes were: careful reading plus a manual state-machine walkthrough confirming every pause has a correctly-scoped resume, the "no create-account affordance" fallback leaves today's tested Reachability behavior byte-for-byte unchanged, and Step 6 still never runs until this new flow fully resolves (preserving the fix for the original 2026-08-21 defect — no speculative field content before the account genuinely works). Confirm `node core/test-all.mjs` shows no new failures after the edits, checking first whether any existing test asserts specific content/structure in either file.
