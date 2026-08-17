import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('set-status.mjs writes to the workspace cwd, not the repo root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  writeFileSync(join(ws, 'data', 'applications.md'),
    '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-08-15 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | [1](reports/1-acme-2026-08-15.md) | |\n');
  try {
    execFileSync('node', [join(REPO_ROOT, 'core', 'set-status.mjs'), '1', 'Applied'], { cwd: ws });
    const content = readFileSync(join(ws, 'data', 'applications.md'), 'utf-8');
    assert.match(content, /Applied/);
    const repoRootTracker = readFileSync(join(REPO_ROOT, 'data', 'applications.md'), 'utf-8').toString();
    assert.doesNotMatch(repoRootTracker, /\| 1 \| 2026-08-15 \| Acme \|/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
