# Telegram Apply Flow — Concurrency, Login-Gate, and Cache-Unification Fix

**Status:** Approved, pending implementation plan
**Date:** 2026-08-24
**Author:** Roberto Alevás Vásquez (via Claude)

## Context

On 2026-08-21, Ernesto (the candidate) ran `/apply` on an IMF Workday posting through the Telegram bot. The user pasted the actual Discord transcript of that conversation. It shows three distinct, real defects:

1. **Message pile-up.** The bot sent the same Step 5e freshness-guard warning (report #927's score/proof points possibly stale after a `cv.md`/`_profile.md` edit) three times, each worded slightly differently, over about 19 minutes. In between, the bot twice replied `Noted 👍 — commands need a /, try /help to see what I can do.` — the fixed Step 5 fallback for unrecognized free text — even though the candidate's replies were meant to answer the pending question. The bot itself later acknowledged the pile-up: "a couple of overlapping checks ran on this one."
2. **Speculative field content presented as actionable.** Before ever confirming the Workday form was reachable, the bot generated a full "field-approval preview" with guessed values (a `$60,000–$85,000` compensation guess, a defaulted "how did you hear about us") and asked the candidate to reply "yes" to it — then had to send a follow-up message retracting it once it discovered the form was gated behind account creation/login.
3. **The cache-and-reuse mechanism the user wants only works for the Playwright-DOM path.** `data/application-defaults.md` + `modes/apply.md` Step 6b already implement almost exactly what the user described (auto-fill known fields, ask once for new ones, cache the answer for next time) — but the mechanism is scoped to fields Playwright reads off a real, reachable DOM. When a form is login-gated and the candidate has to paste/screenshot the real questions manually instead (the fallback path both `apply.md` Step 1 and `telegram.md` Step 3b step 4 already document), nothing routes those pasted questions through the same Step 6/6b/7 matching-and-caching logic.

### Root cause of defect 1 (read from the code, not guessed)

`core/telegram-monitor.mjs`'s daemon (`daemonLoop()`) long-polls Telegram every 25s. Since a 2026-08-15 change, it fires each bound chat's routing dispatch (`claude -p`, running `modes/telegram.md` Steps 2-6) **non-blocking** — `fanOutDispatches()` calls `dispatch(d).catch(...)` without awaiting it, specifically so a long `cycle` run for one chat never blocks replies to a different chat. The code's own comment justifies the safety of firing concurrent `claude -p` invocations by citing two guards: `cycle-lock.mjs` (protects `cycle` concurrency) and the human-confirmation gate (prevents a doubled dispatch from double-*submitting*). Neither guard protects against **the same chat's own previous dispatch still being in flight** when a new message from that same chat arrives. `routeMessages()` (`core/telegram-router.mjs`) groups messages by chat **within one poll's batch only** — it has zero memory of any dispatch from a prior poll cycle.

A single `claude -p` invocation that includes a fresh A-F re-evaluation (as report #927's Step 5e resolution did — "this can take a few minutes") genuinely runs for several minutes. Telegram's `getUpdates` offset (`core/telegram-poll.mjs`) means a message is never redelivered once consumed — so if Ernesto sent more than one message during that window (the user themselves noted "I don't have all of the messages ernesto sent" — there were more than what's visible), each one spawned its **own independent, concurrent `claude -p` process** for the same chat. Each process ran its own copy of Step 3b/Step 5e, independently derived its own wording for the same warning, and both read-then-wrote the same workspace's `data/telegram-state.md` with no lock between them — explaining both symptoms: duplicate differently-worded messages (each process's own generation) and the misrouted "commands need a /" replies (a losing process reading a Pending Confirmations section a sibling process had already overwritten).

This is a genuine gap in the 2026-08-15 non-blocking design, not a flaw in that design's original goal (keeping other chats responsive during a long `cycle`). The fix adds exactly the guard that design left out: per-chat serialization, without reintroducing cross-chat blocking.

## Goals

1. **Per-chat in-flight guard in the daemon.** While a chat's routing dispatch is running, any new message for that same chat is held (queued), not immediately dispatched as a second concurrent `claude -p` process. When the in-flight dispatch settles, the daemon immediately fires a follow-up dispatch with whatever queued up for that chat — nothing is dropped, and the candidate never has to resend. Different chats remain fully unblocked from each other and from a long `cycle`, matching the original 2026-08-15 intent.
2. **Reachability/login-gate preflight before any field content is generated.** `modes/apply.md`'s DETECT/PREFLIGHT steps must confirm the real application form is actually reachable (not behind an authentication wall, CAPTCHA, or other gate that hides the real fields) *before* Step 6 (Analyze) or Step 7 (Generate) produce anything. If gated, stop immediately and surface that to the candidate — never build a speculative field-approval preview from JD text + generic ATS categories and present it as something to approve.
3. **Unify the boilerplate cache across both field-discovery paths.** Whether fields come from Playwright reading a live DOM or from the candidate pasting/screenshotting questions after they've logged in themselves, both paths must run through the same Step 6/6b/7 matching-and-caching logic against `data/application-defaults.md` — auto-fill what's cached, ask once for what isn't, cache the confirmed answer for next time. The candidate should never have to re-answer a boilerplate question just because this particular application happened to go through the manual-paste fallback instead of Playwright.

## Non-goals

- **No rewrite of the daemon's overall concurrency model.** Cross-chat non-blocking dispatch stays exactly as the 2026-08-15 design intended — this only closes the same-chat gap that design left open.
- **No new external dependencies or services.** The in-flight guard is in-process (the daemon is a single long-running Node process); no external queue, database, or lock service.
- **No change to the three-gate human-confirmation model** (resume-approval → field-approval → submit-approval). This fix doesn't touch how or when those gates fire, only the concurrency and content-generation problems that corrupted them on 2026-08-21.
- **No change to `data/application-defaults.md`'s cacheable-category list** (Step 6b's Field Matching Reference table). This fix makes the existing categories reachable from a second path; it doesn't add new cacheable categories.
- **Not a general retry/resilience overhaul of the daemon.** `dispatchOne()`'s existing spawn-failure retry and emergency-notification behavior are unrelated to this bug and stay as-is.

## Architecture

### Fix 1 — Per-chat in-flight guard (`core/telegram-monitor.mjs`)

Add an in-memory `Map<chatId, { messages: [] }>` — call it the pending-queue map — scoped to the daemon process's own lifetime (a daemon restart clears it, which is correct: nothing "in flight" survives a process restart anyway, since the `claude -p` child died with it).

On each poll cycle, `routeMessages()` still classifies messages exactly as it does today. The change is in how `daemonLoop()`/`fanOutDispatches()` decides whether to fire a `routing`-kind dispatch immediately:

- If chat X has **no** in-flight dispatch: fire it immediately (current behavior, unchanged), and mark chat X as in-flight for the duration of that `dispatch(d)` promise.
- If chat X **already has** an in-flight dispatch: append this cycle's messages for chat X onto the pending-queue map instead of firing a new dispatch.
- When an in-flight dispatch for chat X settles (resolves or rejects — `dispatch(d).catch(...)`'s `.finally()`), check the pending-queue map: if chat X has queued messages, immediately fire a new dispatch with exactly those queued messages (clearing the queue entry), keeping chat X marked in-flight for that new dispatch. If nothing queued, clear chat X's in-flight marker.

This is a bounded loop (a dispatch can only re-trigger itself once per settle, and each settle either finds nothing queued and stops, or finds something and fires once more) — it terminates naturally as soon as no new messages have arrived for that chat since the last dispatch started.

`onboarding`-kind dispatches are unaffected — they're already awaited sequentially, one at a time, across the whole daemon (see `fanOutDispatches()`'s existing onboarding loop), which has no same-chat concurrency gap to close.

### Fix 2 — Reachability preflight (`modes/apply.md`)

Extend Step 1 (DETECT) / Step 5 (PREFLIGHT gate): after detecting the page (via Playwright or the candidate's own report of what they see), explicitly check whether the actual application form fields are visible and reachable, or whether the page shows an authentication wall, CAPTCHA, "sign in to continue," or equivalent gate hiding the real form.

If gated:
- Do not proceed to Step 6 (Analyze) or Step 7 (Generate) under any circumstance.
- Surface the blocker to the candidate immediately, in the same turn Step 1/5 detects it — not after building and sending a preview.
- Offer the same two paths `modes/apply.md`'s own Requirements section and the 8/21 transcript already used correctly once the blocker was found: the candidate signs in themselves and shares the real questions (screenshot or paste), or skips this application for now.
- The tailored resume from Step 3b of `modes/telegram.md` (built and approved *before* the form is ever touched, per that mode's existing design) is unaffected — it's already complete and doesn't depend on form reachability.

This closes the exact defect from 8/21: the bot must reach this determination before generating any field-approval content, not after.

### Fix 3 — Unify the cache across both field-discovery paths (`modes/apply.md`)

Step 6 (Analyze) currently reads "Identify ALL visible form questions" without distinguishing where those questions came from. Make explicit that Steps 6, 6b, and 7 run identically regardless of whether the question list came from a live Playwright DOM read or from the candidate's pasted/screenshotted text (the fallback path Step 1's "Without Playwright" branch and the Requirements section already document, and the same path this mode's own text points to for a login-gated form per Fix 2 above).

Concretely: whichever path produced the question list, each question still gets matched against `data/application-defaults.md`'s cached categories (Step 6b #1), a cache hit still counts as "explicitly present" for the `needs_candidate_confirmation` contract (Step 6b #2), and a candidate's confirmed new answer to a boilerplate-category question — whether typed as a form-fill approval or as a reply to a manually-relayed question — still gets appended to the cache (Step 6b #3). The Field Matching Reference table (which fields are cacheable) doesn't change; only the *path* by which a question reaches that table's matching logic is being made uniform.

## Testing

- **Fix 1:** a unit/integration test for `fanOutDispatches`/the new queuing logic — simulate two poll cycles arriving for the same chat before the first dispatch's promise resolves, and assert: (a) only one `claude -p` invocation is in flight at a time for that chat, (b) the second cycle's messages are not lost — they appear in a follow-up dispatch once the first settles, (c) a different chat's dispatch is never held up by this. Run `node core/test-all.mjs` for regressions.
- **Fix 2:** exercise `modes/apply.md`'s DETECT/PREFLIGHT logic against a login-gated fixture (or a documented manual walkthrough, since this mode is agent-instruction-driven, not a pure script) and confirm no field-approval preview is generated before the gate check resolves.
- **Fix 3:** confirm a boilerplate answer given through the manual-paste path gets written to `data/application-defaults.md` the same way a Playwright-path answer does, and that a subsequent application (either path) reads it back without re-asking.
- Full `node core/test-all.mjs` run at the end, same discipline as every prior plan this session.
