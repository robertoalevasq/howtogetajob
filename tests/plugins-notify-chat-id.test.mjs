import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Found live in production transcripts (2026-09-01 through 2026-09-08,
// confirmed across 2 different workspaces, 6 separate occurrences): an
// operator-side probe of this CLI's own usage — `node plugins.mjs run
// telegram notify --help` — had no --help handling at all, so "--help" fell
// through as the literal message text and was actually sent to a real
// candidate's Telegram chat. --help must short-circuit to a usage message
// and never reach the send path, and must work even with zero config (no
// config/plugins.yml, no .env) — the same way --help works on any CLI
// regardless of whether the tool is otherwise set up.
test('plugins.mjs run telegram notify --help prints usage and never sends anything', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'career-ops-notify-help-'));
  try {
    const stdout = execFileSync(
      'node',
      [join(ROOT, 'core', 'plugins.mjs'), 'run', 'telegram', 'notify', '--help'],
      { cwd, encoding: 'utf-8' },
    );
    assert.match(stdout, /usage/i);
    assert.doesNotMatch(stdout, /sent\.|would send/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('plugins.mjs run telegram notify -h prints usage too (short flag)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'career-ops-notify-help-short-'));
  try {
    const stdout = execFileSync(
      'node',
      [join(ROOT, 'core', 'plugins.mjs'), 'run', 'telegram', 'notify', '-h'],
      { cwd, encoding: 'utf-8' },
    );
    assert.match(stdout, /usage/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// A REAL message that happens to start with "--" (unlikely, but possible —
// e.g. a candidate-facing note about CLI flags) must still send normally,
// not be swallowed by the --help guard. Guard is scoped to the EXACT
// single-token "--help"/"-h" case, never a prefix match.
test('plugins.mjs run telegram notify treats a real message starting with -- as a normal message, not help', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'career-ops-notify-dashmsg-'));
  try {
    mkdirSync(join(cwd, 'config'), { recursive: true });
    writeFileSync(join(cwd, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
    const stdout = execFileSync(
      'node',
      [join(ROOT, 'core', 'plugins.mjs'), 'run', 'telegram', 'notify', '--help', 'me understand this form', '--chat-id', '555', '--dry-run'],
      { cwd, encoding: 'utf-8' },
    );
    assert.match(stdout, /would send|sent\./i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('plugins.mjs run telegram notify --chat-id bypasses the plugin-enabled gate', () => {
  // A fresh cwd with NO config/plugins.yml at all — telegram is "not
  // configured" by every normal measure. --chat-id must still work.
  const cwd = mkdtempSync(join(tmpdir(), 'career-ops-notify-override-'));
  try {
    mkdirSync(join(cwd, 'config'), { recursive: true });
    writeFileSync(join(cwd, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
    const stdout = execFileSync(
      'node',
      [join(ROOT, 'core', 'plugins.mjs'), 'run', 'telegram', 'notify', 'hello', '--chat-id', '555', '--dry-run'],
      { cwd, encoding: 'utf-8' },
    );
    assert.match(stdout, /telegram notify: sent\.|would send/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
