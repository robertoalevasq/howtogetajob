import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Regression test for the workspace-multitenancy bug: followup-cadence.mjs
// used to derive its tracker/follow-ups/profile root from
// dirname(fileURLToPath(import.meta.url)), which resolves THROUGH a
// workspace's core/ symlink to the shared hub root regardless of which
// workspace invoked it. Run with cwd set to a throwaway workspace and NO
// CAREER_OPS_WORKSPACE override (the exact default-path case the bug lived
// in) — this must resolve data/applications.md from that cwd via
// workspaceRoot(), not from the repo root (whose own data/applications.md
// is absent as gitignored user-layer content in a clean checkout).
test('followup-cadence.mjs resolves data/applications.md from the invoking workspace cwd, not the repo root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  writeFileSync(join(ws, 'data', 'applications.md'), [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-01-01 | Workspace-Isolation-Canary Corp | Canary Engineer | 4.0/5 | Applied | ❌ | [1](reports/001-canary-2026-01-01.md) | |',
  ].join('\n'));

  try {
    // Under the pre-fix bug this call would find no tracker at all (the repo
    // root has no data/applications.md) and return `{error: 'No
    // applications found in tracker.'}` regardless of the workspace's real
    // content. A successful result naming the workspace's own canary company
    // can only come from reading the workspace's own file.
    const out = execFileSync('node', [
      join(REPO_ROOT, 'core', 'followup-cadence.mjs'),
    ], { cwd: ws, encoding: 'utf-8' });
    const result = JSON.parse(out);

    assert.equal(result.error, undefined, `expected no error, got: ${result.error}`);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].company, 'Workspace-Isolation-Canary Corp');
    // Long-overdue applied row with no follow-ups.md in the workspace (or
    // the repo root, which is what would leak under the bug) — this is only
    // reachable if the tracker AND the (absent) follow-ups file both
    // resolved to the workspace.
    assert.equal(result.entries[0].urgency, 'overdue');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
