// @ts-check
// telegram-router.mjs — zero-token, deterministic classification of
// incoming Telegram messages by chatId: bound (route to that workspace),
// mid-onboarding (resume), code-redemption attempt, or wrong-code/lockout.
// See docs/superpowers/specs/2026-08-18-telegram-router-onboarding-design.md.
//
// Every read here is fresh off disk — no in-memory cache of the bound-chat
// map or any registry. Each poll already respawns telegram-poll.mjs as a
// new process, and reading a handful of small JSON files at 2-20-workspace
// scale is free; a cache would only add invalidation bugs.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessCodeAttemptsPath, onboardingStatePath } from './hub-paths.mjs';
import { redeemAccessCode } from './access-code.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // core/'s parent = repo root
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 60 * 60 * 1000; // 1 hour

/**
 * Map of chatId (string) -> absolute workspace directory, built from every
 * workspaces/*\/workspace.json with a non-null chat_id. An unreadable/
 * corrupt workspace.json is skipped, not fatal — repairing it isn't this
 * function's job.
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Map<string, string>}
 */
export function buildBoundChatMap(opts = {}) {
  const repoRoot = opts.repoRoot || ROOT;
  const workspacesDir = join(repoRoot, 'workspaces');
  const map = new Map();
  if (!existsSync(workspacesDir)) return map;
  const slugs = readdirSync(workspacesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  for (const slug of slugs) {
    const metaPath = join(workspacesDir, slug, 'workspace.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (meta.chat_id) map.set(String(meta.chat_id), join(workspacesDir, slug));
    } catch {
      // corrupt/unreadable workspace.json — skip, don't crash the whole poll
    }
  }
  return map;
}

export function readOnboardingState(chatId, opts = {}) {
  const path = onboardingStatePath(chatId, opts);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeOnboardingState(chatId, state, opts = {}) {
  const path = onboardingStatePath(chatId, opts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function deleteOnboardingState(chatId, opts = {}) {
  const path = onboardingStatePath(chatId, opts);
  if (existsSync(path)) unlinkSync(path);
}

function loadAttempts(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function saveAttempts(path, attempts) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(attempts, null, 2));
}

/** True if `chatId` is currently inside its lockout window. */
export function isLockedOut(chatId, opts = {}) {
  const attempts = loadAttempts(accessCodeAttemptsPath(opts));
  const entry = attempts[String(chatId)];
  return !!(entry && entry.lockedUntil && new Date(entry.lockedUntil).getTime() > Date.now());
}

/**
 * Record one wrong access-code attempt for `chatId`. On the attempt that
 * reaches LOCKOUT_THRESHOLD, stamps `lockedUntil` = now + LOCKOUT_MS and
 * resets `count` to 0 — the caller must have already confirmed via
 * isLockedOut() that this chat isn't currently locked out before calling
 * this (an attempt made during an active lockout should be dropped
 * silently, never reach this function — see routeMessages()).
 *
 * @returns {{ justLockedOut: boolean }}
 */
export function recordWrongAttempt(chatId, opts = {}) {
  const path = accessCodeAttemptsPath(opts);
  const attempts = loadAttempts(path);
  const key = String(chatId);
  const entry = attempts[key] || { count: 0, lockedUntil: null };
  entry.count += 1;
  let justLockedOut = false;
  if (entry.count >= LOCKOUT_THRESHOLD) {
    entry.lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
    entry.count = 0;
    justLockedOut = true;
  }
  attempts[key] = entry;
  saveAttempts(path, attempts);
  return { justLockedOut };
}

/**
 * Classify and route one poll's messages. Side effects (canned replies
 * sent via opts.sendReply, onboarding state written, codes claimed, wrong-
 * attempt counters updated) happen here; the return value lists only the
 * chat groups that need an LLM invocation.
 *
 * @param {Array<{chatId: string|number, text: string, [key: string]: any}>} messages
 * @param {{ repoRoot?: string, sendReply?: (chatId: string, text: string) => Promise<void> }} [opts]
 * @returns {Promise<Array<{ chatId: string, cwd: string, kind: 'routing'|'onboarding', messages: any[], state: object|null }>>}
 */
export async function routeMessages(messages, opts = {}) {
  const repoRoot = opts.repoRoot || ROOT;
  const boundMap = buildBoundChatMap(opts);

  const byChat = new Map();
  for (const m of messages) {
    const key = String(m.chatId);
    if (!byChat.has(key)) byChat.set(key, []);
    byChat.get(key).push(m);
  }

  const dispatches = [];
  for (const [chatId, chatMessages] of byChat) {
    const workspaceDir = boundMap.get(chatId);
    if (workspaceDir) {
      dispatches.push({ chatId, cwd: workspaceDir, kind: 'routing', messages: chatMessages, state: null });
      continue;
    }

    const state = readOnboardingState(chatId, opts);
    if (state) {
      const cwd = state.slug ? join(repoRoot, 'workspaces', state.slug) : repoRoot;
      dispatches.push({ chatId, cwd, kind: 'onboarding', messages: chatMessages, state });
      continue;
    }

    // Unbound, no onboarding state: every message in this chat's batch is
    // either a code-redemption attempt or noise. Process in order —
    // realistically always exactly one message reaches this branch per poll.
    for (const m of chatMessages) {
      if (isLockedOut(chatId, opts)) continue; // drop silently: no reply, no counter change

      const redeemed = await redeemAccessCode((m.text || '').trim(), chatId, opts);
      if (redeemed) {
        const now = new Date().toISOString();
        const newState = {
          chatId, redeemedCode: redeemed.code, slug: null, answers: {},
          currentStep: 'name', startedAt: now, lastMessageAt: now,
        };
        writeOnboardingState(chatId, newState, opts);
        dispatches.push({ chatId, cwd: repoRoot, kind: 'onboarding', messages: [m], state: newState });
      } else {
        recordWrongAttempt(chatId, opts);
        if (opts.sendReply) {
          await opts.sendReply(chatId, 'Please enter your access code to continue.');
        }
      }
    }
  }
  return dispatches;
}
