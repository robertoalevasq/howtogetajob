// tests/dedup-tracker-workspace-root.test.mjs — regression coverage for the
// workspace-symlink data-integrity bug: dedup-tracker.mjs used to derive its
// tracker root from its own on-disk location (dirname(fileURLToPath(...))),
// which resolves THROUGH a workspace's `core` symlink/junction back to the
// shared hub root. Under a real workspace dispatch (no CAREER_OPS_TRACKER
// override — that env var is a test-only escape hatch, never set by live
// dispatches) this silently dedup'd the HUB ROOT's tracker instead of the
// invoking workspace's own data/applications.md.
//
// The fix routes the default root through workspaceRoot() (core/workspace-root.mjs),
// which is process.env.CAREER_OPS_WORKSPACE || process.cwd() — matching how
// the router actually spawns workspace dispatches (cwd set to the target
// workspace). This test proves the DEFAULT path (no CAREER_OPS_TRACKER set),
// which is exactly the case existing tests never covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('dedup-tracker.mjs defaults to the workspace cwd, not the repo root (no CAREER_OPS_TRACKER override)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-dedup-ws-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  const trackerPath = join(ws, 'data', 'applications.md');
  writeFileSync(trackerPath,
    '# Applications Tracker\n\n'
    + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
    + '|---|------|---------|------|-------|--------|-----|--------|-------|\n'
    + '| 1 | 2026-06-01 | WorkspaceRootProbeCo | Backend Engineer | 4.2/5 | Evaluated | ❌ | [1](reports/1-x-2026-06-01.md) | strong infra fit |\n'
    + '| 2 | 2026-06-01 | WorkspaceRootProbeCo | Backend Engineer | 4.0/5 | Evaluated | ❌ | [1](reports/1-x-2026-06-01.md) | dup |\n');

  // Deliberately no CAREER_OPS_TRACKER / CAREER_OPS_WORKSPACE set — this is
  // the real-world default path a live workspace dispatch actually takes:
  // only cwd distinguishes one workspace from another.
  const env = { ...process.env };
  delete env.CAREER_OPS_TRACKER;
  delete env.CAREER_OPS_WORKSPACE;

  try {
    execFileSync(process.execPath, [join(REPO_ROOT, 'core', 'dedup-tracker.mjs')], {
      cwd: ws, env, encoding: 'utf-8', timeout: 30000,
    });

    // The duplicate row was merged/removed IN THE WORKSPACE tracker.
    const content = readFileSync(trackerPath, 'utf-8');
    const occurrences = (content.match(/WorkspaceRootProbeCo/g) || []).length;
    assert.equal(occurrences, 1, `expected the duplicate to be merged down to 1 row, got ${occurrences}`);

    // The real repo-root tracker (present in a provisioned checkout, absent
    // in a clean one) must be untouched either way — proving the write
    // landed in the workspace, never the hub root.
    const repoRootTrackerPath = join(REPO_ROOT, 'data', 'applications.md');
    if (existsSync(repoRootTrackerPath)) {
      const repoRootTracker = readFileSync(repoRootTrackerPath, 'utf-8');
      assert.doesNotMatch(repoRootTracker, /WorkspaceRootProbeCo/);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
