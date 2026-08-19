import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
