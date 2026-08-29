#!/usr/bin/env node
/**
 * telegram-set-commands.mjs — Register career-ops's Telegram bot commands
 * so they appear in the client's native "/" autocomplete menu (Bot API's
 * setMyCommands). One-time setup step, safe/idempotent to re-run whenever
 * the command list changes (see modes/telegram.md's First-Time Setup).
 *
 * Curated list, not the full recognized set (2026-08-13 decision, extended
 * 2026-08-15) — /yes, /no, /skip, /cancel are answers to an in-context
 * prompt, and /editpdf is a niche follow-on to /pdf; none are worth
 * browsing to in a menu. They still work when typed, just aren't listed here.
 *
 * No generic "raw Bot API call" helper exists elsewhere in this repo to
 * reuse (plugins/telegram/index.mjs's apiUrl() isn't exported, and
 * setMyCommands doesn't fit that plugin's notify/ingest hook shapes) — this
 * is a standalone script, matching scan.mjs's own direct-dotenv pattern
 * rather than routing through plugins/_engine.mjs's runHook() machinery for
 * what's a one-shot setup call.
 *
 * Usage:
 *   node telegram-set-commands.mjs
 */

const COMMANDS = [
  { command: 'run', description: 'Start a full autonomous search cycle' },
  { command: 'scan', description: 'Scan portals only, no evaluation' },
  { command: 'apply', description: 'Apply to a job (paste URL, or a report #)' },
  { command: 'applyall', description: 'Batch-apply to everything eligible' },
  { command: 'pdf', description: 'Resend a generated resume (report # or company)' },
  { command: 'status', description: 'Cycle progress, pipeline stats, and pending approvals' },
  { command: 'settings', description: 'View or change your profile settings' },
  { command: 'help', description: 'Show every command and how to reply' },
];

async function main() {
  try {
    const { config } = await import('dotenv');
    config({ quiet: true });
  } catch {
    // dotenv optional — fall back to ambient process.env
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set — see .env.example and modes/telegram.md\'s First-Time Setup.');
    process.exit(1);
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commands: COMMANDS }),
  });
  const result = await res.json();

  if (!result.ok) {
    console.error(`setMyCommands failed: ${result.description || JSON.stringify(result)}`);
    process.exit(1);
  }

  console.log(`Registered ${COMMANDS.length} commands:`);
  for (const c of COMMANDS) console.log(`  /${c.command} — ${c.description}`);
  console.log('\nThey should now appear in Telegram\'s "/" menu for this bot (may take a moment to refresh client-side).');
}

main();
