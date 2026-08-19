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
import { existsSync, readdirSync } from 'node:fs';

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

/**
 * Resolve which workspace the shared Telegram daemon reads plugin config
 * from (config/plugins.yml -> chat_id/chat_ids, the Discord webhook, etc).
 * There is one bot token and poller for the whole system (same reasoning
 * as the two paths above), but plugin config is workspace-scoped since the
 * #workspace-multitenancy migration moved config/plugins.yml out of the
 * repo root — the daemon has to pick exactly one workspace to read that
 * config from until a real chat_id -> workspace router exists (tracked as
 * a follow-up design, not part of this fix).
 *
 * CAREER_OPS_TELEGRAM_WORKSPACE names the slug explicitly and always wins.
 * Without it, this auto-selects only when exactly one workspace exists
 * under workspaces/ (today's actual single/small-tenant reality) and
 * refuses to guess otherwise — silently picking the wrong tenant's chat_id
 * would leak routing to/from the wrong person once a second workspace
 * exists.
 *
 * @param {{ repoRoot?: string }} [opts] - repoRoot override for test
 *   isolation only (mirrors provision-workspace.mjs's opts.reposRoot);
 *   production callers never pass this.
 * @returns {string} absolute path to the resolved workspace's root
 */
export function resolveHubWorkspace(opts = {}) {
  const explicit = process.env.CAREER_OPS_TELEGRAM_WORKSPACE;
  const workspacesDir = join(opts.repoRoot || REPO_ROOT, 'workspaces');
  if (explicit) {
    const dir = join(workspacesDir, explicit);
    if (!existsSync(dir)) {
      throw new Error(`CAREER_OPS_TELEGRAM_WORKSPACE="${explicit}" but workspaces/${explicit}/ does not exist.`);
    }
    return dir;
  }
  const slugs = existsSync(workspacesDir)
    ? readdirSync(workspacesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    : [];
  if (slugs.length === 1) return join(workspacesDir, slugs[0]);
  if (slugs.length === 0) {
    throw new Error('No workspaces provisioned under workspaces/ — run provision-workspace.mjs before starting the Telegram daemon.');
  }
  throw new Error(`Multiple workspaces exist (${slugs.join(', ')}) — set CAREER_OPS_TELEGRAM_WORKSPACE to the one the shared Telegram daemon should serve.`);
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
