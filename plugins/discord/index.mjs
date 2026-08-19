// @ts-check
// discord — posts a notify() message (and optionally files) to a Discord
// webhook, or edits a previously sent one in place. Bundled plugin: same
// trust level as gmail/notion, reviewed here.
//
// Egress goes through ctx.fetch only (manifest.allowedHosts: ["discord.com"]),
// so the SSRF guard in plugins/_engine.mjs applies to every call this makes.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

// Discord's default (non-boosted) webhook limits. Boosted servers allow more,
// but we can't know the target server's boost level from here — staying under
// the universal floor means this never silently fails on a normal server.
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 10;

// ?wait=true makes Discord return the created/edited message object (with its
// id) instead of a bare 204 — required so a caller can capture the id and
// edit the same message again later (a "living" progress message).
function messagesUrl(webhookUrl, editMessageId) {
  const base = editMessageId ? `${webhookUrl}/messages/${editMessageId}` : webhookUrl;
  return `${base}?wait=true`;
}

// Discord wants embed.color as a decimal int (0xRRGGBB). Accepting "#RRGGBB"
// too means a caller can write JSON without doing hex math by hand.
function normalizeEmbed(embed) {
  if (!embed || typeof embed !== 'object') return embed;
  if (typeof embed.color === 'string') {
    const hex = embed.color.replace(/^#/, '');
    return { ...embed, color: parseInt(hex, 16) };
  }
  return embed;
}

async function sendOrEdit(ctx, webhookUrl, editMessageId, body) {
  const res = await ctx.fetch(messagesUrl(webhookUrl, editMessageId), {
    method: editMessageId ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export default {
  /**
   * @param {{ message?: string, embed?: object, filePath?: string, filePaths?: string[], editMessageId?: string }} payload
   * @param {import('../_types.js').PluginContext} ctx
   */
  async notify(payload, ctx) {
    const webhookUrl = ctx.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return { sent: false, error: 'DISCORD_WEBHOOK_URL not set' };

    const message = (payload && payload.message) || '';
    const embed = normalizeEmbed(payload && payload.embed);
    const editMessageId = payload && payload.editMessageId;
    // filePath (single, legacy) and filePaths (array) are both accepted —
    // normalize to one list. Discord's edit endpoint doesn't accept new file
    // uploads via PATCH the same way create does — editing is text/embed only.
    const filePaths = editMessageId ? [] : [
      ...(payload && payload.filePath ? [payload.filePath] : []),
      ...(payload && Array.isArray(payload.filePaths) ? payload.filePaths : []),
    ];

    // A file-only send (attachment, no caption) is legitimate and must not
    // get a placeholder — only truly empty (no message, no embed, no files)
    // is a caller mistake. plugins.mjs's CLI already rejects this case before
    // it reaches here; this is defense-in-depth for direct runHook() callers
    // (e.g. discord-ticker.mjs) that bypass that CLI validation.
    if (!message && !embed && filePaths.length === 0) {
      return { sent: false, error: 'notify called with no message, embed, or file — nothing to send' };
    }
    const body = {};
    if (message) body.content = message;
    if (embed) body.embeds = [embed];

    if (ctx.dryRun) {
      ctx.log(`would ${editMessageId ? `edit message ${editMessageId}` : 'post'} to Discord${filePaths.length ? ` with ${filePaths.length} attachment(s)` : ''}${embed ? ' (embed)' : ''}: ${message || (embed && embed.title) || ''}`);
      return { sent: false, dryRun: true };
    }

    if (editMessageId) {
      const result = await sendOrEdit(ctx, webhookUrl, editMessageId, body);
      return { sent: true, edited: true, messageId: result.id };
    }

    if (filePaths.length === 0) {
      const result = await sendOrEdit(ctx, webhookUrl, null, body);
      return { sent: true, attached: 0, messageId: result.id };
    }

    const sizes = filePaths.map(p => statSync(p).size);
    const totalBytes = sizes.reduce((a, b) => a + b, 0);

    if (filePaths.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
      const mb = (totalBytes / (1024 * 1024)).toFixed(1);
      const listing = filePaths.map(p => `  • ${basename(p)}`).join('\n');
      const result = await sendOrEdit(
        ctx, webhookUrl, null,
        { content: `${message}\n\n(${filePaths.length} file(s), ${mb}MB total — too much for a single Discord message. Files are waiting on your machine:\n${listing})` },
      );
      return { sent: true, attached: 0, reason: 'too large', totalBytes, fileCount: filePaths.length, messageId: result.id };
    }

    const form = new FormData();
    form.append('payload_json', JSON.stringify(body));
    filePaths.forEach((p, i) => {
      form.append(`files[${i}]`, new Blob([readFileSync(p)]), basename(p));
    });
    const res = await ctx.fetch(messagesUrl(webhookUrl, null), { method: 'POST', body: form });
    const result = await res.json();
    // Discord returns a CDN url per uploaded attachment — the only real,
    // hyperlinkable pointer to a file that otherwise only lives on disk.
    // Keyed by filename so a caller can match it back to the path it sent.
    const attachmentUrls = {};
    for (const a of (result.attachments || [])) attachmentUrls[a.filename] = a.url;
    return { sent: true, attached: filePaths.length, totalBytes, messageId: result.id, attachmentUrls };
  },
};
