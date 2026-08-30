#!/usr/bin/env node
// @ts-check
// access-code.mjs — the one-time access-code registry for onboarding new
// Telegram users. Generated out of band by the operator (`generate`), then
// consumed by core/telegram-router.mjs's routeMessages() (`redeem`).
// See docs/superpowers/specs/2026-08-18-telegram-router-onboarding-design.md.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { accessCodesPath, botIdentityCachePath } from './hub-paths.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { isMainModule } from './is-main.mjs';

// This file lives in core/ (#workspace-multitenancy Task 1) — REPO_ROOT is
// the actual repo root .env lives under, matching hub-paths.mjs's own
// resolution for the same reason (a single shared bot token, never
// workspace-scoped).
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const CODE_LENGTH = 24;
// No ambiguous characters (0/O, 1/l/I) — a human occasionally has to
// transcribe or read this code aloud even though it's normally copy-pasted.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function generateCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return code;
}

function loadRegistry(path) {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveRegistry(path, registry) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2));
}

/** @param {string|null} [label] @param {{ repoRoot?: string }} [opts] */
export async function generateAccessCode(label, opts = {}) {
  const path = accessCodesPath(opts);
  return withPipelineLock(path, () => {
    const registry = loadRegistry(path);
    const now = new Date();
    const entry = {
      code: generateCode(),
      label: label || null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + EXPIRY_MS).toISOString(),
      redeemedBy: null,
      redeemedAt: null,
    };
    registry.push(entry);
    saveRegistry(path, registry);
    return entry;
  });
}

/** @param {{ repoRoot?: string }} [opts] */
export async function listAccessCodes(opts = {}) {
  const registry = loadRegistry(accessCodesPath(opts));
  const now = Date.now();
  return registry.map(entry => ({
    ...entry,
    status: entry.redeemedBy
      ? 'redeemed'
      : (new Date(entry.expiresAt).getTime() < now ? 'expired' : 'pending'),
  }));
}

/** @param {string} code @param {{ repoRoot?: string }} [opts] */
export async function revokeAccessCode(code, opts = {}) {
  const path = accessCodesPath(opts);
  return withPipelineLock(path, () => {
    const registry = loadRegistry(path);
    const entry = registry.find(e => e.code === code);
    if (!entry) throw new Error(`No such code: ${code}`);
    if (entry.redeemedBy) throw new Error(`Code already redeemed by chat ${entry.redeemedBy} — cannot revoke`);
    entry.expiresAt = new Date(0).toISOString(); // force-expire, keeps an audit trail rather than deleting
    saveRegistry(path, registry);
    return entry;
  });
}

/**
 * Attempt to redeem `text` (already trimmed by the caller) as a pending,
 * unexpired code for `chatId`. Returns the redeemed entry on success, or
 * null if `text` doesn't match any pending/valid code — including an
 * expired or already-redeemed one, which are treated identically to "no
 * match" by design (see the design spec's router Step 4).
 *
 * @param {string} text @param {string|number} chatId @param {{ repoRoot?: string }} [opts]
 */
export async function redeemAccessCode(text, chatId, opts = {}) {
  const path = accessCodesPath(opts);
  return withPipelineLock(path, () => {
    const registry = loadRegistry(path);
    const now = Date.now();
    const entry = registry.find(
      e => e.code === text && !e.redeemedBy && new Date(e.expiresAt).getTime() >= now,
    );
    if (!entry) return null;
    entry.redeemedBy = String(chatId);
    entry.redeemedAt = new Date().toISOString();
    saveRegistry(path, registry);
    return entry;
  });
}

/**
 * Best-effort lookup of the bot's own @username, so `generate`'s CLI output
 * can include a ready-to-forward message without the operator needing a
 * separate manual getMe query every time (found live 2026-08-29: this was
 * being done as an ad-hoc one-off script each time a code was generated).
 * Cached indefinitely once fetched — a bot's username essentially never
 * changes, and this avoids a network call on every `generate` invocation.
 * Never throws: a missing token, network failure, or bad response all
 * resolve to null, since a share message is a nice-to-have, never a reason
 * to fail code generation itself.
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<string|null>}
 */
export async function getBotUsername(opts = {}) {
  const cachePath = botIdentityCachePath(opts);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
      if (cached && typeof cached.username === 'string' && cached.username) return cached.username;
    } catch {
      // fall through to a fresh fetch below
    }
  }
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      dotenv.config({ path: join(opts.repoRoot || REPO_ROOT, '.env'), quiet: true });
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return null;
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    const username = data?.result?.username;
    if (typeof username !== 'string' || !username) return null;
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ username, cachedAt: new Date().toISOString() }, null, 2));
    return username;
  } catch {
    return null;
  }
}

async function runCli() {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'generate') {
    const labelIdx = rest.indexOf('--label');
    const label = labelIdx !== -1 ? rest[labelIdx + 1] : null;
    const entry = await generateAccessCode(label);
    console.log(`Code:    ${entry.code}`);
    console.log(`Label:   ${entry.label || '(none)'}`);
    console.log(`Expires: ${entry.expiresAt}`);
    const expiresDate = entry.expiresAt.slice(0, 10);
    const username = await getBotUsername();
    console.log('');
    if (username) {
      console.log('Share message:');
      console.log(`Hey! Set up your job search bot on Telegram: message @${username} and send it the code ${entry.code} to get started. Code expires ${expiresDate}.`);
    } else {
      console.log(`(No share message — set TELEGRAM_BOT_TOKEN in .env to include a ready-to-forward message here.)`);
    }
    return 0;
  }

  if (cmd === 'list') {
    const codes = await listAccessCodes();
    if (codes.length === 0) { console.log('No access codes.'); return 0; }
    for (const c of codes) {
      const redeemedNote = c.redeemedBy ? `  redeemed by ${c.redeemedBy} (${c.redeemedAt})` : '';
      console.log(`${c.code}  ${c.status.padEnd(9)}  ${c.label || '(no label)'}  created ${c.createdAt}${redeemedNote}`);
    }
    return 0;
  }

  if (cmd === 'revoke') {
    const code = rest[0];
    if (!code) { console.error('Usage: node access-code.mjs revoke <code>'); return 1; }
    try {
      await revokeAccessCode(code);
      console.log(`Revoked: ${code}`);
      return 0;
    } catch (err) {
      console.error(err.message);
      return 1;
    }
  }

  console.error('Usage: node access-code.mjs <generate [--label "Name"] | list | revoke <code>>');
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runCli();
}
