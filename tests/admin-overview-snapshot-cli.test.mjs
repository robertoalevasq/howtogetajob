// tests/admin-overview-snapshot-cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../core/admin-overview-snapshot.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeFakeRepo(root) {
  // buildSnapshot shells out to `node core/stats.mjs` and `node
  // core/cycle-status.mjs` relative to its OWN real ROOT (see Task 1/2's
  // execFileSync calls), not the fake reposRoot under test — so those
  // still resolve to the real scripts. Only workspaces/ needs to exist
  // under the fake root for listWorkspaces() to find it.
  const wsDir = join(root, 'workspaces', 'alice');
  mkdirSync(join(wsDir, 'data', 'cache'), { recursive: true });
  writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({
    slug: 'alice', chat_id: '123', display_name: 'Alice', created_at: '2026-01-01',
  }));
}

test('buildSnapshot assembles roster, tracker stats, active-task status, and empty history into one object', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-build-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'admin-overview-build-claude-'));
  try {
    makeFakeRepo(root);
    const snapshot = buildSnapshot(root, claudeHome);
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.workspaces[0].slug, 'alice');
    assert.ok('trackerStats' in snapshot.workspaces[0]);
    assert.ok('activeTask' in snapshot.workspaces[0]);
    assert.equal(snapshot.workspaces[0].activeTask.state, 'no_run');
    assert.ok(snapshot.generatedAt);
    assert.deepEqual(snapshot.tokenUsageByWorkspace, {});
    assert.deepEqual(snapshot.runCountsByWorkspace, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});

test('CLI writes the snapshot JSON to the given output path and exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-build-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'admin-overview-build-claude-'));
  const outPath = join(root, 'snapshot.json');
  try {
    makeFakeRepo(root);
    execFileSync(process.execPath, [
      join(REPO_ROOT, 'core', 'admin-overview-snapshot.mjs'), outPath,
    ], {
      encoding: 'utf-8',
      env: { ...process.env, CAREER_OPS_ADMIN_OVERVIEW_REPO_ROOT: root, CAREER_OPS_ADMIN_OVERVIEW_CLAUDE_HOME: claudeHome },
    });
    assert.ok(existsSync(outPath));
    const written = JSON.parse(readFileSync(outPath, 'utf-8'));
    assert.equal(written.workspaces.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});
