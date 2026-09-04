// @ts-check
// broadcast.mjs — operator tool to notify every bound Telegram user of a
// system update worth telling them about. Reuses the existing
// sendCannedReply() send path (already proven for the wrong-code/lockout
// case in telegram-monitor.mjs) rather than adding a new send mechanism.
// Manually invoked only — never wired into a mode file, cron, or CI.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';
import { listWorkspaces } from './admin-overview-snapshot.mjs';
import { sendCannedReply } from './telegram-monitor.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Send `text` to every provisioned workspace's bound chat_id.
 * @param {string} text
 * @param {{ reposRoot?: string, send?: (chatId: string, text: string) => Promise<void>, dryRun?: boolean }} [opts]
 * @returns {Promise<{ sent: {slug: string, chatId: string}[], skipped: {slug: string, reason: string}[] }>}
 */
export async function broadcast(text, opts = {}) {
  const { reposRoot = ROOT, send = sendCannedReply, dryRun = false } = opts;
  const workspaces = listWorkspaces(reposRoot);
  const sent = [];
  const skipped = [];
  for (const ws of workspaces) {
    if (!ws.chatId) {
      skipped.push({ slug: ws.slug, reason: 'no chat_id bound yet' });
      continue;
    }
    if (dryRun) {
      sent.push({ slug: ws.slug, chatId: ws.chatId });
      continue;
    }
    try {
      await send(ws.chatId, text);
      sent.push({ slug: ws.slug, chatId: ws.chatId });
    } catch (err) {
      skipped.push({ slug: ws.slug, reason: /** @type {Error} */ (err).message });
    }
  }
  return { sent, skipped };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const text = argv.filter((a) => a !== '--dry-run').join(' ');
  if (!text.trim()) {
    console.error('Usage: node core/broadcast.mjs "message text" [--dry-run]');
    process.exit(1);
  }
  const { sent, skipped } = await broadcast(text, { dryRun });
  console.log(`${dryRun ? 'Would send' : 'Sent'} to ${sent.length} workspace(s): ${sent.map((s) => s.slug).join(', ') || '(none)'}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length}: ${skipped.map((s) => `${s.slug} (${s.reason})`).join(', ')}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ broadcast: ${err.message}`);
    process.exit(1);
  });
}
