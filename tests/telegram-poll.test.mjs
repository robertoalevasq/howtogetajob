// Regression coverage for core/telegram-poll.mjs's hub-global poll path.
//
// The bug this file exists for: poll() used to call runHook('ingest', ...)
// with `workspaceRoot: workspaceRoot()` and no `forceEnabled`, which made the
// enabled-gate look for a config/plugins.yml that no longer exists at the
// repo root (plugin config is per-workspace since #workspace-multitenancy).
// The telegram manifest was therefore never loaded, runHook returned [], and
// poll() printed {"messages":[],"error":"telegram plugin not enabled …"} —
// so telegram-monitor.mjs's daemon received zero messages, silently, forever.
//
// These tests drive the REAL script as a child process (the exact path the
// daemon spawns), with TELEGRAM_BOT_TOKEN deliberately blanked so ingest()
// short-circuits before any network call — reaching that short-circuit at all
// is the proof the plugin was loaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORE_DIR = join(REPO_ROOT, 'core');

/** Run `node telegram-poll.mjs poll` the way telegram-monitor.mjs does (cwd: core/). */
function runPoll() {
  const stdout = execFileSync(process.execPath, ['telegram-poll.mjs', 'poll'], {
    cwd: CORE_DIR,
    encoding: 'utf-8',
    // Blank (not absent) so dotenv — which never overrides an already-present
    // key — cannot fill it in from a real .env and trigger a live API call.
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '', CAREER_OPS_TELEGRAM_LONGPOLL_SECONDS: '0' },
  });
  // The plugin's ctx.log writes a plain line to stdout before the JSON; the
  // JSON result is always the last non-empty line.
  const lines = stdout.trim().split(/\r?\n/).filter(l => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}

test('telegram-poll poll() no longer reports the telegram plugin as not enabled', () => {
  const result = runPoll();
  assert.equal(
    result.error,
    undefined,
    `poll() reported an error instead of loading the plugin: ${result.error}`,
  );
  assert.ok(Array.isArray(result.messages), 'expected a messages array');
});

test('telegram-poll poll() reaches the plugin\'s own ingest hook (no repo-root config/plugins.yml needed)', () => {
  // With the token blanked, ingest() returns { messages: [] } from its own
  // guard. Getting that shape back — rather than the engine-level "not
  // enabled" error object — is what proves the hub-global forceEnabled path
  // actually loads the manifest.
  const result = runPoll();
  assert.deepEqual(result, { messages: [] });
});
