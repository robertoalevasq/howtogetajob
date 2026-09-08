import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Regression test for the workspace-multitenancy bug: find.mjs used to
// default its tracker path to dirname(fileURLToPath(import.meta.url)),
// which resolves THROUGH a workspace's core/ symlink to the shared hub root
// regardless of which workspace invoked it. Run with cwd set to a
// throwaway workspace and NO CAREER_OPS_TRACKER override (the exact
// default-path case the bug lived in) — this must resolve
// data/applications.md from that cwd via workspaceRoot(), not the repo root.
test('find.mjs resolves data/applications.md from the invoking workspace cwd, not the repo root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  writeFileSync(join(ws, 'data', 'applications.md'), [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-08-01 | Workspace-Isolation-Canary Corp | Canary Engineer | 4.0/5 | Applied | ❌ | [1](reports/001-canary-2026-08-01.md) | |',
  ].join('\n'));

  try {
    // The repo root has no data/applications.md (gitignored user-layer
    // content, absent in a clean checkout) — under the pre-fix bug this call
    // would fail with "not found — nothing to search" (exit 1) regardless of
    // the workspace's real tracker. A match found here can only come from
    // reading the workspace's own file.
    const out = execFileSync('node', [
      join(REPO_ROOT, 'core', 'find.mjs'), '1', '--json',
    ], { cwd: ws, encoding: 'utf-8' });
    const matches = JSON.parse(out);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].company, 'Workspace-Isolation-Canary Corp');
    assert.equal(matches[0].trackerNum, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
