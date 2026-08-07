---
name: career-ops-plugin-discord
description: How to use the discord notify plugin and what it sends.
license: MIT
---

# discord

> This file teaches an AI agent how to drive THIS plugin. It only covers the
> `notify` hook — it never edits core files, scoring, or the tracker.

## How to run it

- `node plugins.mjs run discord notify "message text"` — posts a plain text
  message to the configured webhook.
- `node plugins.mjs run discord notify "message text" --file path/to/file` —
  same, with one attachment.
- `--file` is repeatable: `... --file a.pdf --file b.pdf` attaches multiple
  files in a single message (Discord webhook limits: 10 files, 8MB combined
  on a non-boosted server). Over either limit, the message is sent with a
  listing of the files' names instead of attaching them — it never fails
  silently and never truncates a file to fit.
- `node plugins.mjs run discord notify "updated text" --edit <messageId>` —
  edits a previously sent message in place instead of posting a new one. Read
  the `message id: {id}` line the CLI printed on the first call (every notify
  call prints one) to get the id to reuse. `--edit` and `--file` are not
  combined; a message with attachments can't be edited into having different
  attachments through this path — but `--edit` and `--embed-file` combine
  fine (editing a message's embed, not its attachments).
- `node plugins.mjs run discord notify --embed-file path/to/embed.json` —
  sends a Discord embed instead of (or alongside, if a message is also given)
  plain text: a bordered, colored card with a title, description, `fields`
  (label/value pairs), footer, and timestamp. Write the JSON to a file first
  (shell quoting can't carry a nested object reliably) — see the shape below.
  A trailing plain-text argument still works as the message text sent
  alongside the embed (shows as a small line above the card); omit it to send
  only the embed.

  ```json
  {
    "title": "career-ops cycle — 2026-08-04",
    "color": "#57F287",
    "fields": [
      { "name": "Scan (tracked)", "value": "38 offers found → 12 new" },
      { "name": "Top matches (≥4.0)", "value": "**BAH** — Data Engineer — 4.6/5 — [cv-bah.pdf](https://cdn.discordapp.com/...)" }
    ],
    "footer": { "text": "career-ops" }
  }
  ```

  `color` accepts either a `"#RRGGBB"` string or a decimal int (Discord's
  native format) — the plugin converts the string form for you.

## What it produces

Nothing is written back to career-ops's own data files — this is an outbound
notify hook, not a producer. The hook's return value (`{ sent, attached,
edited?, messageId, reason?, attachmentUrls? }`) is only for the caller's own
logging — the CLI already surfaces `messageId` on stdout, and when a `--file`
upload succeeds it also prints each attached file's real Discord CDN URL
(`attachment urls: <filename> → <url>`). That URL is the only way to get a
clickable link to a file that otherwise only exists on the local disk — use
it to patch an earlier summary embed (via `--edit`) so a "top matches" field
can link straight to the PDF that was just uploaded, instead of a dead local
path. These URLs are signed and can expire after roughly a day; treat them as
good for same-day use, not a permanent record — the PDF on disk is the
permanent copy.

## Settings

None beyond the required secret. `DISCORD_WEBHOOK_URL` (in `.env`) is the
per-channel webhook URL from Discord's channel settings → Integrations →
Webhooks → New Webhook → Copy Webhook URL.
