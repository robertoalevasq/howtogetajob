// @ts-check
// telegram — sends outbound messages (notify) and polls inbound messages
// (ingest) via the Telegram Bot API. Bundled plugin: same trust level as
// discord/gmail, reviewed here.
//
// Egress goes through ctx.fetch only (manifest.allowedHosts:
// ["api.telegram.org"]), so the SSRF guard in plugins/_engine.mjs applies to
// every call this makes.
//
// ingest() owns its own pagination cursor (data/telegram-offset.json, mirrors
// gmail's data/gmail-state.json) — Telegram's getUpdates is a stateful,
// offset-based API, and that offset is this plugin's own bookkeeping, not a
// web-facing data file plugins.mjs's CLI would otherwise own. Note this hook
// is driven directly via runHook('ingest', ...) from telegram-poll.mjs, NOT
// via `node plugins.mjs run telegram ingest` — that CLI path assumes every
// ingest hook returns job listings and would silently discard chat messages.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { dirname, basename } from 'path';

// Telegram Bot API's real constraints — sending against these blindly either
// gets silently rejected by the API or trips its rate limiter.
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB per file, direct bot upload
const MAX_GROUP_FILES = 10; // sendMediaGroup's own per-call cap
const MAX_CAPTION_CHARS = 1024; // shorter than sendMessage's 4096 text limit
const INTER_CHAT_DELAY_MS = 1000; // ~1 msg/sec/chat, Telegram's own guidance

const sleep = ms => new Promise(r => setTimeout(r, ms));

function offsetPath() {
  return process.env.CAREER_OPS_TELEGRAM_OFFSET || 'data/telegram-offset.json';
}

function loadOffset() {
  try {
    const path = offsetPath();
    if (!existsSync(path)) return 0;
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isFinite(state.last_update_id) ? state.last_update_id : 0;
  } catch {
    return 0;
  }
}

function saveOffset(id) {
  try {
    const path = offsetPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ last_update_id: id }, null, 2));
  } catch (err) {
    console.warn(`telegram: could not persist polling offset — ${err.message}`);
  }
}

function apiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/** POST a single-file sendDocument call. Returns the parsed API response. */
async function sendDocument(ctx, token, chatId, filePath, caption, replyToMessageId) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([readFileSync(filePath)]), basename(filePath));
  if (caption) form.append('caption', caption.slice(0, MAX_CAPTION_CHARS));
  if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));
  const res = await ctx.fetch(apiUrl(token, 'sendDocument'), { method: 'POST', body: form });
  return res.json();
}

/**
 * POST a grouped sendMediaGroup call (2-10 documents in one album message —
 * Telegram's native equivalent of Discord's multi-attachment message). Only
 * the first item's caption is shown, per Telegram's own convention.
 */
async function sendMediaGroup(ctx, token, chatId, filePaths, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  const media = filePaths.map((p, i) => {
    const item = { type: 'document', media: `attach://file${i}` };
    if (i === 0 && caption) item.caption = caption.slice(0, MAX_CAPTION_CHARS);
    return item;
  });
  form.append('media', JSON.stringify(media));
  filePaths.forEach((p, i) => form.append(`file${i}`, new Blob([readFileSync(p)]), basename(p)));
  const res = await ctx.fetch(apiUrl(token, 'sendMediaGroup'), { method: 'POST', body: form });
  return res.json();
}

/** Split into chunks of at most `size` (Telegram's own sendMediaGroup cap). */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default {
  /**
   * @param {{ message?: string, replyToMessageId?: number, filePath?: string, filePaths?: string[] }} payload
   * @param {import('../_types.js').PluginContext} ctx
   */
  async notify(payload, ctx) {
    const token = ctx.env.TELEGRAM_BOT_TOKEN;
    if (!token) return { sent: false, error: 'TELEGRAM_BOT_TOKEN not set' };

    // Support both chat_ids (array) and chat_id (single) for backwards compatibility
    const chatIds = ctx.settings.chat_ids || (ctx.settings.chat_id ? [ctx.settings.chat_id] : null);
    if (!chatIds || chatIds.length === 0) return { sent: false, error: 'telegram.chat_id or chat_ids not set in config/plugins.yml' };

    const message = (payload && payload.message) || '';
    // filePath (single, legacy) and filePaths (array) both accepted, same
    // normalization discord/index.mjs uses.
    const filePaths = [
      ...(payload && payload.filePath ? [payload.filePath] : []),
      ...(payload && Array.isArray(payload.filePaths) ? payload.filePaths : []),
    ];
    if (!message && filePaths.length === 0) return { sent: false, error: 'no message text or file given' };

    if (ctx.dryRun) {
      ctx.log(`would send to Telegram chats ${chatIds.join(', ')}: ${message.slice(0, 200)}${filePaths.length ? ` with ${filePaths.length} file(s)` : ''}`);
      return { sent: false, dryRun: true };
    }

    // Text-only path — unchanged behavior.
    if (filePaths.length === 0) {
      const results = [];
      for (const chatId of chatIds) {
        const body = {
          chat_id: chatId,
          text: message.slice(0, 4096), // Telegram's hard per-message limit
          parse_mode: 'HTML',
        };
        if (payload && payload.replyToMessageId) body.reply_to_message_id = payload.replyToMessageId;

        const res = await ctx.fetch(apiUrl(token, 'sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await res.json();
        results.push({ chatId, sent: true, messageId: result?.result?.message_id });
      }
      return { sent: true, chats: results };
    }

    // File path(s) — split out anything over Telegram's 50MB direct-upload
    // limit so one oversized PDF doesn't sink the whole batch; report it by
    // name instead (same "list what's too big, don't fail silently" pattern
    // discord/index.mjs uses for its own 8MB total-batch limit).
    const tooLarge = [];
    const sendable = [];
    for (const p of filePaths) {
      if (!existsSync(p)) { tooLarge.push({ path: p, reason: 'not found' }); continue; }
      const size = statSync(p).size;
      if (size > MAX_FILE_BYTES) tooLarge.push({ path: p, reason: `${(size / (1024 * 1024)).toFixed(1)}MB exceeds Telegram's 50MB bot-upload limit` });
      else sendable.push(p);
    }

    const chats = [];
    for (const chatId of chatIds) {
      const chatResult = { chatId, sent: 0, failed: [], tooLarge };
      const groups = chunk(sendable, MAX_GROUP_FILES);
      for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        // Only the first group in a multi-chunk send carries the caption —
        // matches Discord's single-label-per-batch convention.
        const caption = g === 0 ? message : '';
        if (group.length === 1) {
          const result = await sendDocument(ctx, token, chatId, group[0], caption, payload && payload.replyToMessageId);
          if (result && result.ok) chatResult.sent += 1;
          else chatResult.failed.push({ path: group[0], error: result && result.description });
        } else {
          const result = await sendMediaGroup(ctx, token, chatId, group, caption);
          if (result && result.ok) {
            chatResult.sent += group.length;
          } else {
            // Grouped send rejected (e.g. this Bot API version doesn't
            // support document media groups) — fall back to sequential
            // sendDocument calls rather than losing the batch.
            for (let i = 0; i < group.length; i++) {
              const fallback = await sendDocument(ctx, token, chatId, group[i], i === 0 ? caption : '', payload && payload.replyToMessageId);
              if (fallback && fallback.ok) chatResult.sent += 1;
              else chatResult.failed.push({ path: group[i], error: fallback && fallback.description });
              if (i < group.length - 1) await sleep(INTER_CHAT_DELAY_MS);
            }
          }
        }
        if (g < groups.length - 1) await sleep(INTER_CHAT_DELAY_MS);
      }
      chats.push(chatResult);
      if (chatIds.indexOf(chatId) < chatIds.length - 1) await sleep(INTER_CHAT_DELAY_MS);
    }

    const totalSent = chats.reduce((n, c) => n + c.sent, 0);
    const totalFailed = chats.reduce((n, c) => n + c.failed.length, 0);
    return { sent: totalSent > 0, attached: totalSent, failed: totalFailed, tooLarge: tooLarge.length, chats };
  },

  /**
   * @param {import('../_types.js').PluginContext} ctx
   */
  async ingest(ctx) {
    const token = ctx.env.TELEGRAM_BOT_TOKEN;
    if (!token) { ctx.log('telegram: TELEGRAM_BOT_TOKEN not set'); return { messages: [] }; }

    const lastUpdateId = loadOffset();
    // timeout=0 (default): a single non-blocking poll — the original
    // behavior for a cron-driven call (Task Scheduler every N minutes) that
    // must never sit waiting on Telegram's servers.
    // timeout=N (opt-in via CAREER_OPS_TELEGRAM_LONGPOLL_SECONDS, set by
    // telegram-monitor.mjs --daemon): Telegram holds the request open up to
    // N seconds and responds the instant a message arrives, or with an
    // empty result after N seconds — real long-polling for a persistent
    // caller, added 2026-08-13. Capped at 50s, a conservative ceiling that
    // stays well clear of intermediary HTTP timeouts on either end.
    const longPollSeconds = Math.max(0, Math.min(50, Number(process.env.CAREER_OPS_TELEGRAM_LONGPOLL_SECONDS) || 0));
    const url = `${apiUrl(token, 'getUpdates')}?offset=${lastUpdateId + 1}&timeout=${longPollSeconds}`;
    // ctx.fetch's own abort timer (default 10s) must outlive Telegram's own
    // long-poll timeout, or the request gets cut off before Telegram ever
    // gets a chance to respond.
    const res = await ctx.fetch(url, { timeoutMs: (longPollSeconds + 10) * 1000 });
    const data = await res.json();
    const updates = Array.isArray(data.result) ? data.result : [];

    // Access control (added 2026-08-13): getUpdates returns every message
    // from every chat that has ever messaged this bot — Telegram has no
    // per-chat scoping at the API level. Without this check, anyone who
    // finds the bot and starts a conversation could trigger real actions
    // (a cycle run, an apply flow). Same chat_ids/chat_id config notify()
    // already reads — a chat outside that set is logged and dropped here,
    // never routed. Coerced to String() since Telegram's API returns
    // msg.chat.id as a number but config/plugins.yml's chat_id is a string.
    const allowedChatIds = new Set(
      (ctx.settings.chat_ids || (ctx.settings.chat_id ? [ctx.settings.chat_id] : []))
        .map(id => String(id)),
    );

    const messages = updates
      .filter(u => u.message && typeof u.message.text === 'string')
      .map(u => {
        const msg = u.message;
        // Detect whether this message is a bot command (starts with /)
        const isCommand = typeof msg.text === 'string' && msg.text.startsWith('/');
        // Also check Telegram's entity-based command detection if available
        const hasCommandEntity = Array.isArray(msg.entities) &&
          msg.entities.some(e => e.type === 'bot_command' && e.offset === 0);
        const isCommandMessage = isCommand || hasCommandEntity;

        return {
          updateId: u.update_id,
          messageId: msg.message_id,
          chatId: msg.chat.id,
          text: msg.text,
          date: msg.date,
          replyToMessageId: msg.reply_to_message?.message_id ?? null,
          from: msg.from?.username || msg.from?.first_name || 'unknown',
          isCommand: isCommandMessage,  // new field for downstream routing
        };
      })
      .filter(m => {
        // Fail closed, not open: an empty allowlist means chat_id/chat_ids
        // isn't configured at all (config/plugins.yml), not "allow anyone" —
        // the whole point of this filter is a fixed, deliberate identity,
        // so an unset config should never silently widen to "everyone."
        if (allowedChatIds.size === 0) {
          ctx.log(`telegram: no chat_id/chat_ids configured — rejecting message from ${m.chatId} (${m.from}). Set telegram.chat_id in config/plugins.yml.`);
          return false;
        }
        if (allowedChatIds.has(String(m.chatId))) return true;
        ctx.log(`telegram: rejected message from unauthorized chat ${m.chatId} (${m.from}): ${m.text.slice(0, 80)}`);
        return false;
      });

    // Offset advances past every fetched update regardless of the allowlist
    // filter above — an unauthorized chat's message must never be
    // redelivered on the next poll just because it was rejected, not routed.
    if (updates.length > 0) {
      const maxUpdateId = Math.max(...updates.map(u => u.update_id));
      if (!ctx.dryRun) saveOffset(maxUpdateId);
    }

    return { messages };
  },
};
