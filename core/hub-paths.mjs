// @ts-check
// hub-paths.mjs — the two paths that must NEVER follow workspace resolution.
// There is exactly one Telegram poller for the whole system (Telegram rejects
// concurrent getUpdates on the same bot token), so its cursor and daemon lock
// always resolve off this file's own real location — never process.cwd() or
// CAREER_OPS_WORKSPACE. Deliberately a different function shape than
// workspace-root.mjs's workspaceRoot() so a caller can't accidentally reach
// for the wrong one.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_DIR = dirname(fileURLToPath(import.meta.url));
// This file lives in core/, one directory below the repo root
// (#workspace-multitenancy Task 1) — REPO_ROOT is the actual repo root that
// data/ lives under, matching the pattern in telegram-monitor.mjs and
// discord-ticker.mjs. The two paths below land at the same repo-root data/
// locations they resolved to before Task 1's move.
const REPO_ROOT = dirname(CORE_DIR);

export function telegramOffsetPath() {
  return join(REPO_ROOT, 'data', 'telegram-offset.json');
}

export function telegramDaemonLockPath() {
  return join(REPO_ROOT, 'data', 'telegram-daemon');
}

export function accessCodesPath(opts = {}) {
  return join(opts.repoRoot || REPO_ROOT, 'data', 'access-codes.json');
}

export function accessCodeAttemptsPath(opts = {}) {
  return join(opts.repoRoot || REPO_ROOT, 'data', 'access-code-attempts.json');
}

export function onboardingDir(opts = {}) {
  return join(opts.repoRoot || REPO_ROOT, 'data', 'onboarding');
}

export function onboardingStatePath(chatId, opts = {}) {
  return join(onboardingDir(opts), `${chatId}.json`);
}

export function botIdentityCachePath(opts = {}) {
  return join(opts.repoRoot || REPO_ROOT, 'data', 'telegram-bot-identity.json');
}

// A record of what telegram-monitor.mjs dispatched, written deterministically
// by the router BEFORE it spawns `claude -p` — never dependent on whether the
// dispatched session bothers to call the Skill tool. Closes an observability
// gap token-efficiency-log.mjs found live 2026-09-08: many real headless
// dispatches never invoke Skill at all (the routed command already lives in
// the prompt text), so transcript-mining alone can't classify their mode.
export function dispatchLogPath(opts = {}) {
  return join(opts.repoRoot || REPO_ROOT, 'data', 'dispatch-log.jsonl');
}

// Diagnostic record of every data/telegram-state.md lock acquire/release
// (see dispatchOne()'s STATE_LOCK_TIMEOUT_MS lock in telegram-monitor.mjs).
// Added 2026-09-12 after a real dispatch's own telegram-state.md read
// changed content mid-turn despite the lock supposedly covering that whole
// turn — confirmed from the dispatch's session transcript, but with no way
// to tell from that alone whether the lock was ever actually held, contended,
// or bypassed. This log exists so the NEXT occurrence has direct evidence
// (who held the lock, when, for how long, and what — if anything — was
// waiting) instead of requiring transcript archaeology to reconstruct.
export function stateLockLogPath(opts = {}) {
  return join(opts.repoRoot || REPO_ROOT, 'data', 'logs', 'telegram-state-lock.jsonl');
}
