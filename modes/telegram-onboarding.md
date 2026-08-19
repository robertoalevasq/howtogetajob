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

`currentStep` is one of: `name`, `cv`, `profile`, `discord`, `done`. This mode reads the state, processes the new message against `currentStep`, writes the answer into a real file as soon as it's given (never held only in memory), advances `currentStep`, and re-saves the state — except at `done`, where the state file is deleted instead (see Step 6).

## Step 1 — Welcome (first turn only, `currentStep: "name"` with no prior answer)

If this is the very first message since redemption (no `answers.name` yet), send:

> `🎉 You're in! Let's get you set up — takes about 5 minutes. First, what's your name?`

Wait for the reply.

## Step 2 — Name → slug → provision

On receiving a name reply:

1. Store it: `answers.name = "<reply text>"`.
2. Resolve a slug: `node core/provision-workspace.mjs --from-name "<name>"` — prints the resolved slug (already deduped against existing workspaces) to stdout. Record `state.slug` = that printed value.
3. Provisioning already happened as a side effect of step 2 (`--from-name` calls `provisionWorkspace()` internally) — do not call `provision-workspace.mjs <slug>` again separately.
4. Advance `currentStep` to `cv`, save state.
5. Send: `Thanks {name}! Now, paste your CV/resume as text — don't worry about formatting, I'll clean it up.`

From this point on, every file write below targets `workspaces/{slug}/...` by its full path (not a bare relative path — this mode's own session `cwd` is fixed at the **repo root** for its whole lifetime, including after `state.slug` exists; `core/telegram-router.mjs` dispatches every onboarding turn with `cwd = repoRoot` unconditionally, precisely so the hub-global `data/onboarding/{chatId}.json` and the repo-root seed templates stay reachable by their bare relative paths). Only the *content* of files inside the new workspace changes, never the session's own working directory.

## Step 3 — CV

On receiving the CV text reply:

1. Convert it to clean markdown (standard sections: Summary, Experience, Projects, Education, Skills) — same conversion the interactive onboarding flow already does.
2. Write to `workspaces/{slug}/cv.md`.
3. Advance `currentStep` to `profile`, save state.
4. Send: `Got your CV. Now a few quick questions:\n1️⃣ What roles are you targeting? (e.g. "Senior Backend Engineer")\n2️⃣ Location/timezone?\n3️⃣ Salary target range?\n\nReply with all three, in any format — I'll figure it out.`

## Step 4 — Profile basics

On receiving the roles/location/salary reply:

1. Parse the three answers (best-effort natural-language extraction — if something's ambiguous, ask a single focused follow-up rather than guessing, then continue once answered).
2. Copy `config/profile.example.yml` (the repo-root template — a bare relative path is correct here, the session cwd *is* the repo root) into `workspaces/{slug}/config/profile.yml` if it isn't already the seeded template (it already is, from `--from-name`'s provisioning step) — edit in the target roles, location, and salary range fields.
3. Send: `Last setup choice — how much do you want to spend on model usage per evaluation?\n💰 economy — cheapest/fastest, good for scanning lots of offers\n⚖️ standard — balanced (most people pick this)\n💎 premium — most capable, best for offers you really care about\n\nReply with one word.`
4. Advance `currentStep` to `discord`, save state (the spend-tier reply is handled inline in Step 5, since it's the same logical question set — `currentStep` only needs to distinguish "waiting on roles/location/salary" from "waiting on discord/skip").

## Step 5 — Spend tier + Discord webhook (optional)

On receiving the spend-tier reply:

1. Set `workspaces/{slug}/config/profile.yml`'s `spend_tier` to the matched value (default `standard` if the reply doesn't clearly match one of the three).
2. Send: `One more optional thing — want progress updates in Discord too? Paste a webhook URL, or reply "skip".`

On receiving the Discord reply:

1. If it's a URL: write it to `workspaces/{slug}/.env` as `DISCORD_WEBHOOK_URL=...` (create the file if it doesn't exist; never echo the URL back in a Telegram message). Set `workspaces/{slug}/config/plugins.yml`'s `discord.enabled: true`.
2. If it's "skip" (or equivalent): leave `workspaces/{slug}/config/plugins.yml`'s `discord.enabled: false` (the seeded template default — no edit needed).
3. Either way, also set `workspaces/{slug}/config/plugins.yml`'s `telegram.enabled: true`, `telegram.chat_id: "{chatId}"`, and `telegram.chat_ids: ["{chatId}"]` — this is what makes the *ordinary* post-onboarding `modes/telegram.md` flow able to message them normally via `ctx.settings`, once bound. (This does not itself bind the chat — see Step 6.)
4. Advance `currentStep` to `done`, save state.

## Step 6 — Bind and finish

1. Run the bind: `node core/provision-workspace.mjs --bind-chat {slug} {chatId}`. This sets `workspaces/{slug}/workspace.json`'s `chat_id` — the one action that makes `core/telegram-router.mjs` recognize this chat as bound from the next poll onward. On failure (e.g. `already bound`), treat it like any other step failure — see "Error handling" below — never retry blindly.
2. Delete the onboarding state: remove `data/onboarding/{chatId}.json` — the hub-global one at the **repo root** (this session's cwd), never a copy under `workspaces/{slug}/`.
3. Send the completion message, followed immediately by `modes/telegram.md` Step 3g's exact help text (read it from that file — never duplicate/paraphrase it here, since it drifts):
   > `✅ All set! You're ready to search. Here's what I can do:`
4. Nothing further happens in this turn — the *next* message from this chat will be picked up by `core/telegram-router.mjs` as a bound chat and routed through `modes/telegram.md` normally.

## `/restart`

Recognized at any point during onboarding (mirrors the edit-loop pattern in `modes/telegram.md`): delete `data/onboarding/{chatId}.json` (again, the hub-global one at the repo root) and send `No problem — let's start over. What's your name?`, effectively re-running Step 1. Does **not** delete an already-provisioned-but-unbound `workspaces/{slug}/` directory from a prior attempt — that's inert clutter until the operator notices and cleans it up manually, same "flag, never auto-delete" treatment as everywhere else in this codebase's data-contract conventions. If the person completes onboarding again under a new name after a `/restart`, they get a second workspace directory (a harmless, if slightly confusing, side effect of restarting after already having provisioned once — not worth special-casing for a ~2-20 person circle).

## Error handling

If a step's tool call fails (a write error, `provision-workspace.mjs` exiting non-zero), do not fabricate progress — send `⚠️ Something went wrong on my end — could you resend that last message?`, leave `currentStep` unchanged, and stop this turn. The next message retries the same step.

## What this mode never does

- Never uses `AskUserQuestion`.
- Never sends a message without the explicit `--chat-id {chatId}` flag.
- Never binds a chat (`workspace.json`'s `chat_id`) until every prior onboarding question has actually been answered — the bind call itself is the first action of Step 6, precisely because a failure there (e.g. "already bound") should leave the onboarding state and pending completion message untouched, safe to retry, rather than happening after the state is already deleted and a false success message already sent.
- Never invents CV content, skills, or achievements not present in what the candidate actually pasted — same non-fabrication discipline as every other content-generating mode in this system.
- Never requires the Discord webhook — it is always skippable.
