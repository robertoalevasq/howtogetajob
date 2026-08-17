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
