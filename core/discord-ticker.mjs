#!/usr/bin/env node
// @ts-check
/**
 * discord-ticker.mjs — one living Discord status message, owned and
 * self-healing.
 *
 * Replaces the old prompt-level convention from modes/cycle.md's "Progress
 * reporting" section: rebuild an embed JSON file per checkpoint, parse a
 * message id out of CLI stdout, remember it across agent turns, and manually
 * decide what to do if an edit fails. On 2026-08-04 that convention broke
 * mid-run — a malformed embed hit a genuine Discord 400, and no further
 * checkpoint update was ever attempted for the rest of a many-hour run,
 * because nothing owned "try again" once the first attempt failed.
 *
 * This script owns three things the prompt-level version left to chance:
 *   1. Embed validation — Discord's real field-length/count limits are
 *      enforced client-side (truncate, don't error) so a malformed payload
 *      never reaches the API as a live 400 in the first place.
 *   2. Message identity — the current message id is persisted to
 *      data/cache/discord-ticker-state.json, not carried in agent-turn
 *      memory, so any checkpoint (any turn, any subagent) calls the same
 *      "tick" and always targets the right message.
 *   3. Self-healing — if an edit fails after retries (message deleted,
 *      channel pruned, stale id), it falls back to creating a fresh message
 *      instead of going silent for the rest of the run.
 *
 * Usage:
 *   node discord-ticker.mjs tick --embed-file <path>   # create-or-edit, self-healing
 *   node discord-ticker.mjs reset                        # forget the persisted message id
 *
 * Call `reset` once at the start of a new cycle run (Step 0) so a previous
 * run's message id is never silently reused. Call `tick` at every checkpoint
 * unconditionally — a failure is logged and non-fatal; the very next
 * checkpoint's tick tries again on its own, so a transient outage
 * self-recovers without anyone deciding to "give up" partway through.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runHook } from '../plugins/_engine.mjs';
import { acquireTrackerLock, writeFileAtomic } from './tracker-utils.mjs';
import { workspaceRoot } from './workspace-root.mjs';
import { isMainModule } from './is-main.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
// This script lives in core/, one directory below the repo root
// (#workspace-multitenancy Task 1) — REPO_ROOT is the System Layer root
// runHook()/pluginRoots() need for bundled plugin discovery (always this
// script's own real location). Discord has no Telegram-style single-token
// constraint, so -- unlike telegram-poll.mjs's intentionally hub-based
// ingest hook (see hub-paths.mjs) -- realNotify() below pairs this with
// workspaceRoot() for the actual config/plugins.yml resolution, so a
// per-workspace webhook is read from the right place
// (#workspace-multitenancy final-review Critical 3).
const REPO_ROOT = dirname(ROOT);
// Overridable so tests can isolate state in a sandbox instead of touching
// this repo's real data/ directory (same convention as
// CAREER_OPS_REPORTS_DIR in reserve-report-num.mjs). Falls back to the
// current workspace root (#workspace-multitenancy Task 8), not this
// script's own directory — each user's ticker state must land in their own
// workspace.
export const STATE_PATH = process.env.CAREER_OPS_DISCORD_TICKER_STATE
  || join(workspaceRoot(), 'data', 'cache', 'discord-ticker-state.json');
export const LOCK_DIR = `${STATE_PATH}.lock`;
export const LOG_PATH = process.env.CAREER_OPS_DISCORD_TICKER_LOG
  || join(workspaceRoot(), 'data', 'discord-ticker.log');

// Discord's documented embed limits. Enforcing these before sending turns a
// live 400 into a silently-truncated payload — degrade, never die.
const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  maxFields: 25,
  footerText: 2048,
  authorName: 256,
  totalChars: 6000,
};

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + '…';
}

function normalizeColor(color) {
  if (typeof color === 'number' && Number.isFinite(color)) {
    return Math.max(0, Math.min(0xFFFFFF, Math.round(color)));
  }
  if (typeof color === 'string') {
    const n = parseInt(color.replace(/^#/, ''), 16);
    if (Number.isFinite(n)) return Math.max(0, Math.min(0xFFFFFF, n));
  }
  return undefined;
}

/**
 * Clamp an arbitrary embed object to Discord's real limits. Pure function —
 * no network, no state — so it's trivially unit-testable.
 *
 * @param {object} raw - Embed JSON as authored by a checkpoint (title,
 *   description, color, fields[], footer, author).
 * @returns {object} A Discord-safe embed.
 */
export function sanitizeEmbed(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('embed payload must be a JSON object');
  }
  const embed = {};
  // Discord rejects title/description/footer/author when the key is present
  // but the string is empty — omit the key entirely rather than send "".
  const title = raw.title != null ? truncate(String(raw.title), LIMITS.title) : '';
  if (title) embed.title = title;
  const description = raw.description != null ? truncate(String(raw.description), LIMITS.description) : '';
  if (description) embed.description = description;
  const color = normalizeColor(raw.color);
  if (color !== undefined) embed.color = color;
  if (raw.footer && raw.footer.text != null) {
    const footerText = truncate(String(raw.footer.text), LIMITS.footerText);
    if (footerText) embed.footer = { text: footerText };
  }
  if (raw.author && raw.author.name != null) {
    const authorName = truncate(String(raw.author.name), LIMITS.authorName);
    if (authorName) embed.author = { name: authorName };
  }
  if (Array.isArray(raw.fields)) {
    embed.fields = raw.fields.slice(0, LIMITS.maxFields).map((f) => ({
      name: truncate(String((f && f.name) ?? ''), LIMITS.fieldName) || '​',
      value: truncate(String((f && f.value) ?? ''), LIMITS.fieldValue) || '​',
      ...(f && f.inline != null ? { inline: !!f.inline } : {}),
    }));
  }

  // Total-size clamp: Discord rejects an embed whose combined text exceeds
  // 6000 chars even when every individual field is within its own limit.
  // Drop trailing fields first (cheapest content to lose) before the
  // headline title/description would ever need trimming further.
  const totalChars = () =>
    (embed.title?.length || 0) + (embed.description?.length || 0) +
    (embed.footer?.text?.length || 0) + (embed.author?.name?.length || 0) +
    (embed.fields || []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  while (totalChars() > LIMITS.totalChars && embed.fields && embed.fields.length) {
    embed.fields.pop();
  }

  // Discord rejects an embed with no visible content (title, description,
  // fields, footer, author all absent) — color alone doesn't count. Fail
  // loudly and locally here instead of as an opaque Discord 400 two retries
  // deep (confirmed real: HTTP 400 {"embeds":["0"]} on 2026-08-09/08-12).
  const hasContent = embed.title || embed.description || embed.footer || embed.author
    || (embed.fields && embed.fields.length > 0);
  if (!hasContent) {
    throw new Error('sanitizeEmbed produced an empty embed (no title/description/fields/footer/author) — refusing to send');
  }

  return embed;
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { messageId: null };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { messageId: parsed.messageId ?? null };
  } catch {
    return { messageId: null };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2));
}

function logLine(line) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, `${new Date().toISOString()}\t${line}\n`);
}

/**
 * Real Discord send/edit, routed through the plugin engine's notify hook
 * (same discord plugin the rest of career-ops uses). Kept as the default
 * `notify` dependency so tests can inject a fake without touching the
 * network or the engine's SSRF/host-allowlist guard.
 */
async function realNotify(payload) {
  const results = await runHook('notify', payload, { root: REPO_ROOT, workspaceRoot: workspaceRoot(), dryRun: false, only: 'discord' });
  const discordResult = results.find((r) => r.id === 'discord');
  if (!discordResult) {
    throw new Error('discord plugin not enabled/configured — run `node plugins.mjs list` first');
  }
  if (!discordResult.ok) throw new Error(discordResult.error || 'unknown notify failure');
  return discordResult.result;
}

// Overridable so tests don't pay real wall-clock backoff time (same
// convention as the *_LOCK_RETRY_MS envs elsewhere in this repo).
const RETRY_DELAYS_MS = process.env.CAREER_OPS_DISCORD_TICKER_RETRY_MS
  ? process.env.CAREER_OPS_DISCORD_TICKER_RETRY_MS.split(',').map(Number)
  : [1000, 3000];

async function sendWithRetry(notify, payload, label) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await notify(payload);
    } catch (err) {
      lastErr = err;
      logLine(`${label} attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1} failed: ${err.message}`);
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw lastErr;
}

/**
 * Create-or-edit the one living ticker message. Never throws on a Discord-
 * side failure after retries are exhausted for an edit — it falls back to
 * creating a fresh message instead, so the ticker can't go permanently
 * silent the way it did on 2026-08-04. Only throws if creating a brand new
 * message also fails (e.g. the webhook itself is missing/revoked) — even
 * then, the failure is logged, and the caller is expected to call `tick`
 * again at the next checkpoint regardless (see module doc).
 *
 * @param {string} embedFile - Path to a JSON file containing the raw embed.
 * @param {{ notify?: (payload: object) => Promise<{messageId: string}> }} [deps]
 */
export async function tick(embedFile, deps = {}) {
  const notify = deps.notify || realNotify;
  if (!existsSync(embedFile)) throw new Error(`--embed-file not found: ${embedFile}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(embedFile, 'utf8'));
  } catch (e) {
    throw new Error(`--embed-file is not valid JSON: ${e.message}`);
  }
  const embed = sanitizeEmbed(raw);

  const lock = await acquireTrackerLock(LOCK_DIR, { timeoutMs: 15_000 });
  try {
    const state = loadState();

    if (state.messageId) {
      try {
        await sendWithRetry(notify, { embed, editMessageId: state.messageId }, `edit ${state.messageId}`);
        return { action: 'edited', messageId: state.messageId };
      } catch (err) {
        logLine(`edit ${state.messageId} exhausted retries (${err.message}) — falling back to a fresh message`);
      }
    }

    const result = await sendWithRetry(notify, { embed }, 'create');
    saveState({ messageId: result.messageId, createdAt: new Date().toISOString() });
    return { action: 'created', messageId: result.messageId };
  } finally {
    lock.release();
  }
}

/** Forget the persisted message id so the next `tick` starts a fresh message. */
export function reset() {
  saveState({ messageId: null });
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'tick') {
    const idx = rest.indexOf('--embed-file');
    if (idx === -1 || !rest[idx + 1]) {
      console.error('Usage: node discord-ticker.mjs tick --embed-file <path>');
      process.exit(1);
    }
    const result = await tick(resolve(rest[idx + 1]));
    console.log(`ticker: ${result.action} message id: ${result.messageId}`);
  } else if (cmd === 'reset') {
    reset();
    console.log('ticker: state reset — next tick will start a fresh message.');
  } else {
    console.error('Usage: node discord-ticker.mjs tick --embed-file <path> | node discord-ticker.mjs reset');
    process.exit(1);
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`❌ discord-ticker: ${err.message}`);
    process.exit(1);
  });
}
