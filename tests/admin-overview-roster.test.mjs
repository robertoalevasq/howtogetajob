import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorkspaces, getTrackerStats } from '../core/admin-overview-snapshot.mjs';

test('listWorkspaces enumerates provisioned workspaces and skips ones with no workspace.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    const wsDir = join(root, 'workspaces', 'alice');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({
      slug: 'alice', chat_id: '123', display_name: 'Alice', created_at: '2026-01-01',
    }));
    mkdirSync(join(root, 'workspaces', 'incomplete'), { recursive: true });

    const result = listWorkspaces(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].slug, 'alice');
    assert.equal(result[0].displayName, 'Alice');
    assert.equal(result[0].chatId, '123');
    assert.equal(result[0].createdAt, '2026-01-01');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspaces returns an empty array (not a crash) when workspaces/ does not exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    assert.deepEqual(listWorkspaces(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspaces skips a workspace with corrupt workspace.json instead of throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    const wsDir = join(root, 'workspaces', 'broken');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), '{not valid json');
    assert.deepEqual(listWorkspaces(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspaces falls back to the directory name when workspace.json has no slug field', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    const wsDir = join(root, 'workspaces', 'noname');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ created_at: '2026-01-01' }));
    const result = listWorkspaces(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].slug, 'noname');
    assert.equal(result[0].chatId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getTrackerStats returns parsed JSON from a real workspace-shaped directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    const wsDir = join(root, 'ws');
    mkdirSync(join(wsDir, 'data'), { recursive: true });
    writeFileSync(join(wsDir, 'data', 'applications.md'), [
      '# Applications Tracker', '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-08-01 | Acme | Engineer | 4.0/5 | Applied | ✅ | [1](reports/001-acme-2026-08-01.md) | |',
    ].join('\n'));
    const stats = getTrackerStats(wsDir);
    assert.ok(stats);
    assert.equal(stats.tracker.total, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getTrackerStats returns null (not a throw) for a nonexistent directory', () => {
  assert.equal(getTrackerStats('/definitely/does/not/exist/anywhere'), null);
});

test('getTrackerStats stays scoped to wsDir even if the parent process has a stale CAREER_OPS_WORKSPACE env var', () => {
  // stats.mjs resolves its target workspace via workspaceRoot(), which is
  // process.env.CAREER_OPS_WORKSPACE || process.cwd(). If getTrackerStats
  // inherited that env var unmodified, a stale value would silently
  // override the cwd-based scoping and every workspace would report
  // identical data. getTrackerStats must force CAREER_OPS_WORKSPACE to the
  // real wsDir regardless of what the parent process has set.
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  const decoyRoot = mkdtempSync(join(tmpdir(), 'admin-overview-decoy-'));
  const previousEnv = process.env.CAREER_OPS_WORKSPACE;
  try {
    const wsDir = join(root, 'ws');
    mkdirSync(join(wsDir, 'data'), { recursive: true });
    writeFileSync(join(wsDir, 'data', 'applications.md'), [
      '# Applications Tracker', '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-08-01 | Acme | Engineer | 4.0/5 | Applied | ✅ | [1](reports/001-acme-2026-08-01.md) | |',
    ].join('\n'));
    // Decoy workspace has NO tracker data — if scoping leaked, stats would
    // come back empty/null instead of reflecting wsDir's one row.
    mkdirSync(join(decoyRoot, 'data'), { recursive: true });
    process.env.CAREER_OPS_WORKSPACE = decoyRoot;

    const stats = getTrackerStats(wsDir);
    assert.ok(stats);
    assert.equal(stats.tracker.total, 1);
  } finally {
    if (previousEnv === undefined) delete process.env.CAREER_OPS_WORKSPACE;
    else process.env.CAREER_OPS_WORKSPACE = previousEnv;
    rmSync(root, { recursive: true, force: true });
    rmSync(decoyRoot, { recursive: true, force: true });
  }
});
