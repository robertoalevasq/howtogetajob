---
name: career-ops-plugin-telegram
description: How to use the telegram notify + ingest plugin and what it sends/receives.
license: MIT
---

# telegram

> This file teaches an AI agent how to drive THIS plugin. It covers `notify`
> (send) and `ingest` (poll for new messages). It never edits core files,
> scoring, or the tracker — the actual routing/classification/confirmation
> logic lives in `modes/telegram.md`, which is the only thing that
> should decide what a message means or act on it.

## How to send (`notify`)

- `node core/plugins.mjs run telegram notify "message text"` — sends a plain text
  message (HTML formatting allowed: `<b>`, `<i>`, `<code>`) to the configured
  chat. Messages over 4096 chars are truncated at Telegram's own hard limit.
- The CLI prints `message id: {id}` on success — capture it when the message
  needs a threaded reply later (Telegram's `reply_to_message_id`).

## How to poll (`ingest`)

Do **not** call this through `node core/plugins.mjs run telegram ingest` — that CLI
path assumes every `ingest` hook returns job listings and silently discards
anything without a `title`/`url`, which would eat every chat message. Use the
dedicated wrapper instead:

- `node core/telegram-poll.mjs poll` — returns new messages since the last poll as
  JSON: `{"messages":[{"updateId":...,"messageId":...,"chatId":...,"text":"...","date":...,"replyToMessageId":null,"from":"..."}]}`.
  Advances and persists the polling offset as a side effect — a message is
  only returned once.
- `node core/telegram-poll.mjs reset` — clears the stored offset (re-poll from
  Telegram's current backlog; useful after a config mistake, not routine use).

## What it produces

`ingest` writes nothing to career-ops's own data files — it only advances its
own pagination cursor (`data/telegram-offset.json`, plugin-private
bookkeeping, not a shared data file). Turning a returned message into a
pending confirmation, an `apply` mode invocation, or a tracker update is
entirely `modes/telegram.md`'s job.

## Settings

`config/plugins.yml` → `telegram.chat_id` (non-secret — the numeric chat ID
`getUpdates` returns once you've messaged the bot). `TELEGRAM_BOT_TOKEN` (in
`.env`) is the bot token from @BotFather — treat it as a full credential
(anyone with it can send/read as your bot); never print it in a message this
plugin sends, never log it, never write it anywhere but `.env`.
