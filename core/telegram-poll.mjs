#!/usr/bin/env node
// @ts-check
/**
 * telegram-poll.mjs — thin CLI wrapper around the telegram plugin's `ingest`
 * hook (plugins/telegram/index.mjs), mirroring how discord-ticker.mjs wraps
 * the plugin engine's `notify` hook directly rather than going through
 * plugins.mjs's own CLI. `node plugins.mjs run <id> ingest` assumes every
 * ingest hook returns job listings (title/url) and appends them to
 * data/pipeline.md — that would silently discard chat messages, so polling
 * goes through runHook() directly instead, same as the ticker does for sends.
 *
 *   node telegram-poll.mjs poll   # new messages since the last call, as JSON
 *   node telegram-poll.mjs reset  # clear the stored polling offset
 */

import { existsSync, unlinkSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runHook } from '../plugins/_engine.mjs';
import { telegramOffsetPath } from './hub-paths.mjs';
import { isMainModule } from './is-main.mjs';

// This script now lives in core/, one directory below the repo root; ROOT is
// the actual repo root that data/ and plugins/ live under (see
// #workspace-multitenancy Task 1).
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Parse bot commands from a message (slash-command routing).
 * Returns an object: { isCommand: bool, command: string, args: [string] }
 * Examples:
 *   "/search" → { isCommand: true, command: "search", args: [] }
 *   "/apply https://..." → { isCommand: true, command: "apply", args: ["https://..."] }
 *   "/yes 2" → { isCommand: true, command: "yes", args: ["2"] }
 *   "pasted URL" → { isCommand: false, command: null, args: [] }
 */
function parseCommand(text) {
  if (!text || !text.startsWith('/')) {
    return { isCommand: false, command: null, args: [] };
  }

  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  const commandRaw = parts[0].slice(1).toLowerCase();  // remove leading /, lowercase
  const args = parts.slice(1);

  // Recognized commands (zero-LLM routing). All task-starting actions require
  // one of these — no free-text phrase ever starts a task (2026-08-15); the
  // only exception is a pasted job URL (see modes/telegram.md Step 2).
  const recognized = ['run', 'cycle', 'scan', 'search', 'applyall', 'apply', 'yes', 'no', 'skip', 'cancel', 'status', 'help', 'pdf', 'editpdf'];
  const isRecognized = recognized.includes(commandRaw);

  return {
    isCommand: isRecognized,
    command: isRecognized ? commandRaw : null,
    args: isRecognized ? args : [],
  };
}

function offsetPath() {
  return process.env.CAREER_OPS_TELEGRAM_OFFSET || telegramOffsetPath();
}

async function poll() {
  // Polling is HUB-GLOBAL, not workspace-scoped: there is exactly one
  // Telegram poller for the whole system (Telegram rejects concurrent
  // getUpdates on the same bot token — see hub-paths.mjs), and since the
  // router landed, every inbound message is classified by chatId AFTER the
  // poll (core/telegram-router.mjs), not by whichever workspace happened to
  // be the cwd. So both roots are the repo root here, and `forceEnabled`
  // bypasses the per-workspace enabled-gate for the telegram manifest ONLY
  // (it is scoped by `only`, never a blanket bypass — see loadPlugins). That
  // gate would otherwise read a config/plugins.yml that no longer exists at
  // the repo root at all: plugin config is per-workspace since the
  // #workspace-multitenancy migration, so gating a hub-global poll on it
  // made the daemon receive zero messages, silently. ingest() needs nothing
  // from config/plugins.yml — only TELEGRAM_BOT_TOKEN, which it checks itself.
  //
  // runHook's own timeout must outlive ingest()'s ctx.fetch call, which
  // itself must outlive Telegram's own long-poll timeout — three nested
  // timeouts that all need to agree, driven from the same env var so a
  // long-poll caller (telegram-monitor.mjs --daemon) only has to set it once.
  // Matches runHook's own 15s default exactly when long-polling is off.
  const longPollSeconds = Math.max(0, Math.min(50, Number(process.env.CAREER_OPS_TELEGRAM_LONGPOLL_SECONDS) || 0));
  const results = await runHook('ingest', undefined, {
    root: ROOT,
    workspaceRoot: ROOT,
    dryRun: false,
    only: 'telegram',
    forceEnabled: true,
    timeoutMs: (longPollSeconds + 15) * 1000,
  });
  const telegramResult = results.find(r => r.id === 'telegram');
  if (!telegramResult) {
    console.log(JSON.stringify({ messages: [], error: 'telegram plugin not enabled — see config/plugins.yml and .env' }));
    return;
  }
  if (!telegramResult.ok) {
    console.log(JSON.stringify({ messages: [], error: telegramResult.error }));
    return;
  }
  console.log(JSON.stringify(telegramResult.result));
}

function reset() {
  const path = offsetPath();
  if (existsSync(path)) unlinkSync(path);
  console.log('telegram polling offset reset.');
}

/**
 * Export parseCommand for use by modes/telegram.md Step 2 routing
 */
export { parseCommand };

async function main() {
  const [, , cmd] = process.argv;
  if (cmd === 'poll') return poll();
  if (cmd === 'reset') return reset();
  console.error('Usage: node telegram-poll.mjs <poll|reset>');
  process.exit(1);
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
