import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('outcome.mjs spawns set-status.mjs with cwd scoped to the workspace', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  writeFileSync(join(ws, 'data', 'applications.md'),
    '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 2 | 2026-08-15 | Beta | Manager | 3.5/5 | Applied | ❌ | [2](reports/2-beta-2026-08-15.md) | |\n');
  try {
    execFileSync('node', [join(REPO_ROOT, 'core', 'outcome.mjs'), '2', 'rejected'], { cwd: ws });
    assert.ok(true); // reaching here without throwing means it resolved the workspace tracker, not the repo root's
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
