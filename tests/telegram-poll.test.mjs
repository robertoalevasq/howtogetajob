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
  assert.notEqual(
    result.error,
    'telegram plugin not enabled — see config/plugins.yml and .env',
    'poll() fell back to the engine-level "not enabled" error — the manifest was never loaded',
  );
  assert.ok(Array.isArray(result.messages), 'expected a messages array');
});

test('telegram-poll poll() reaches the plugin\'s own ingest hook (no repo-root config/plugins.yml needed)', () => {
  // With the token blanked, ingest() returns { messages: [], error:
  // 'TELEGRAM_BOT_TOKEN not set' } from its own guard. Getting that shape
  // back — rather than the engine-level "not enabled" error — is what
  // proves the hub-global forceEnabled path actually loaded the manifest
  // and reached the plugin's own code, not just the engine's gate.
  const result = runPoll();
  assert.deepEqual(result, { messages: [], error: 'TELEGRAM_BOT_TOKEN not set' });
});

test('telegram-poll poll() sees a real TELEGRAM_BOT_TOKEN from the repo-root .env regardless of the spawned process\'s own cwd', () => {
  // Reproduces the actual production failure this whole file guards
  // against, but from the opposite direction: with the token NOT blanked
  // (inherited from this test process's own env, which loadDotenvOnce()
  // populates from the repo-root .env the same way the real daemon does),
  // ingest() must get past its own missing-token guard entirely — proving
  // the hub-global dotenv fix in plugins/_engine.mjs actually reaches a
  // process spawned with cwd: core/, not just that the manifest loads.
  const stdout = execFileSync(process.execPath, ['telegram-poll.mjs', 'poll'], {
    cwd: CORE_DIR,
    encoding: 'utf-8',
    env: { ...process.env, CAREER_OPS_TELEGRAM_LONGPOLL_SECONDS: '0' },
  });
  const lines = stdout.trim().split(/\r?\n/).filter(l => l.trim());
  const result = JSON.parse(lines[lines.length - 1]);
  assert.notEqual(result.error, 'TELEGRAM_BOT_TOKEN not set', 'the poll subprocess never saw the token');
  assert.ok(Array.isArray(result.messages), 'expected a messages array');
});

test('telegram-poll poll() sets CAREER_OPS_TELEGRAM_OFFSET to the hub-global path before calling ingest()', async () => {
  // Unlike the tests above, this imports the module directly rather than
  // spawning a subprocess: with the token blanked, ingest() returns before
  // ever reaching saveOffset() (nothing to save an offset for), so a
  // subprocess-level check can't observe this fix from its effect on disk.
  // Checking the env var poll() sets is the mechanism itself — plugins/
  // telegram/index.mjs's own offsetPath() defaults to the BARE relative
  // 'data/telegram-offset.json', resolved against whatever cwd ingest()
  // happens to run from (core/, under the real daemon) — a split from the
  // hub-global path every other consumer (reset(), hub-paths.mjs) uses,
  // unless this env var bridges the two.
  const { telegramOffsetPath } = await import('../core/hub-paths.mjs');
  const { poll } = await import('../core/telegram-poll.mjs');
  const originalOffset = process.env.CAREER_OPS_TELEGRAM_OFFSET;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.CAREER_OPS_TELEGRAM_OFFSET;
  process.env.TELEGRAM_BOT_TOKEN = ''; // blank — short-circuits ingest() before any network call
  const originalLog = console.log;
  console.log = () => {}; // poll() writes its JSON result to stdout; not under test here
  try {
    await poll();
    assert.equal(process.env.CAREER_OPS_TELEGRAM_OFFSET, telegramOffsetPath());
  } finally {
    console.log = originalLog;
    if (originalOffset === undefined) delete process.env.CAREER_OPS_TELEGRAM_OFFSET;
    else process.env.CAREER_OPS_TELEGRAM_OFFSET = originalOffset;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});
