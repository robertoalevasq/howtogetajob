import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('STATUS_PATH resolves under the workspace cwd', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  const original = process.cwd();
  process.chdir(ws);
  try {
    delete process.env.CAREER_OPS_CYCLE_STATUS;
    const mod = await import(`../core/cycle-status.mjs?t=${Date.now()}`);
    assert.equal(mod.STATUS_PATH, join(ws, 'data', 'cache', 'cycle-status.json'));
  } finally {
    process.chdir(original);
    rmSync(ws, { recursive: true, force: true });
  }
});

test('discord-ticker STATE_PATH resolves under the workspace cwd', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  const original = process.cwd();
  process.chdir(ws);
  try {
    delete process.env.CAREER_OPS_DISCORD_TICKER_STATE;
    const mod = await import(`../core/discord-ticker.mjs?t=${Date.now()}`);
    assert.equal(mod.STATE_PATH, join(ws, 'data', 'cache', 'discord-ticker-state.json'));
  } finally {
    process.chdir(original);
    rmSync(ws, { recursive: true, force: true });
  }
});
