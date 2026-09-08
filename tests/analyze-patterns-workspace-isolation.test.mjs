import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Regression test for the workspace-multitenancy bug: analyze-patterns.mjs
// used to derive its tracker/reports root from
// dirname(fileURLToPath(import.meta.url)), which resolves THROUGH a
// workspace's core/ symlink to the shared hub root regardless of which
// workspace invoked it. Run with cwd set to a throwaway workspace and NO
// CAREER_OPS_WORKSPACE override (the exact default-path case the bug lived
// in) — this must resolve data/applications.md from that cwd via
// workspaceRoot(), not from the repo root.
test('analyze-patterns.mjs resolves data/applications.md from the invoking workspace cwd, not the repo root', () => {
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
    // --min-threshold 1 so a single non-Evaluated row is enough to run the
    // analysis (the CLI default of 5 exists to avoid noisy claims on a real
    // tracker; irrelevant to proving path resolution here).
    const out = execFileSync('node', [
      join(REPO_ROOT, 'core', 'analyze-patterns.mjs'), '--min-threshold', '1',
    ], { cwd: ws, encoding: 'utf-8' });
    const result = JSON.parse(out);

    // The repo root has no data/applications.md (gitignored user-layer
    // content, absent in a clean checkout) — under the pre-fix bug this call
    // would find no tracker at all and return `{error: 'No applications
    // found in tracker.'}` regardless of the workspace's real content. A
    // successful result whose counts match the workspace's single row can
    // only come from reading the workspace's own file.
    assert.equal(result.error, undefined, `expected no error, got: ${result.error}`);
    assert.equal(result.metadata.total, 1);
    assert.equal(result.funnel.applied, 1);
    assert.equal(result.metadata.dateRange.from, '2026-08-01');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
