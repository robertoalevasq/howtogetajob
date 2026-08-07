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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

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

export default {
  /**
   * @param {{ message?: string, replyToMessageId?: number }} payload
   * @param {import('../_types.js').PluginContext} ctx
   */
  async notify(payload, ctx) {
    const token = ctx.env.TELEGRAM_BOT_TOKEN;
    if (!token) return { sent: false, error: 'TELEGRAM_BOT_TOKEN not set' };
    const chatId = ctx.settings.chat_id;
    if (!chatId) return { sent: false, error: 'telegram.chat_id not set in config/plugins.yml' };

    const message = (payload && payload.message) || '';
    if (!message) return { sent: false, error: 'no message text given' };

    if (ctx.dryRun) {
      ctx.log(`would send to Telegram chat ${chatId}: ${message.slice(0, 200)}`);
      return { sent: false, dryRun: true };
    }

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
    return { sent: true, messageId: result?.result?.message_id };
  },

  /**
   * @param {import('../_types.js').PluginContext} ctx
   */
  async ingest(ctx) {
    const token = ctx.env.TELEGRAM_BOT_TOKEN;
    if (!token) { ctx.log('telegram: TELEGRAM_BOT_TOKEN not set'); return { messages: [] }; }

    const lastUpdateId = loadOffset();
    // timeout=0: a single non-blocking poll. This runs on a recurring
    // schedule (see modes/telegram.md) rather than long-polling, so a
    // cron-driven call never sits waiting on Telegram's servers.
    const url = `${apiUrl(token, 'getUpdates')}?offset=${lastUpdateId + 1}&timeout=0`;
    const res = await ctx.fetch(url);
    const data = await res.json();
    const updates = Array.isArray(data.result) ? data.result : [];

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
      });

    if (updates.length > 0) {
      const maxUpdateId = Math.max(...updates.map(u => u.update_id));
      if (!ctx.dryRun) saveOffset(maxUpdateId);
    }

    return { messages };
  },
};
