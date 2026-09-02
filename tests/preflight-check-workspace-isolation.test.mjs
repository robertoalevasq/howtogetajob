import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('preflight-check.mjs resolves data/applications.md and config/profile.yml from the invoking workspace, not the repo root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  mkdirSync(join(ws, 'config'), { recursive: true });
  // Workspace tracker has a row that does NOT exist in the repo root's real
  // data/applications.md (if any) — a hit here can only come from the
  // workspace's own file.
  writeFileSync(join(ws, 'data', 'applications.md'), [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-08-01 | Workspace-Isolation-Canary Corp | Canary Engineer | 4.0/5 | Applied | ❌ | [1](reports/001-x-2026-08-01.md) | |',
  ].join('\n'));
  // Workspace profile requires a clearance the repo root's real profile
  // (if any) does not — the gate can only fire from the workspace's file.
  writeFileSync(join(ws, 'config', 'profile.yml'), 'clearance:\n  status: "None"\n  accepts_sponsorship: false\n');

  try {
    const out = execFileSync('node', [
      join(REPO_ROOT, 'core', 'preflight-check.mjs'),
      '--company', 'Workspace-Isolation-Canary Corp', '--role', 'Canary Engineer',
      '--text', 'Requires an active Top Secret clearance.',
    ], { cwd: ws, encoding: 'utf-8' });
    const result = JSON.parse(out);

    assert.equal(result.duplicate.isDuplicate, true, 'dedup should hit the workspace tracker, not the repo root');
    assert.equal(result.duplicate.matchedRow.num, 1);
    assert.equal(result.gate.pass, false, 'clearance gate should fire from the workspace profile, not the repo root');
    assert.match(result.gate.reason, /clearance/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('preflight-check.mjs falls back to the invoking workspace default when no tracker/profile exists there (never silently reads the repo root instead)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  // Deliberately empty workspace — no data/, no config/.
  try {
    const out = execFileSync('node', [
      join(REPO_ROOT, 'core', 'preflight-check.mjs'),
      '--company', 'Anyone', '--role', 'Anything',
      '--text', 'Requires an active Top Secret clearance.',
    ], { cwd: ws, encoding: 'utf-8' });
    const result = JSON.parse(out);

    assert.equal(result.duplicate.isDuplicate, false, 'no tracker in the workspace -> no duplicate, not a crash');
    // No clearance.yml in the workspace -> profile defaults to {} -> the
    // clearance keyword still hard-stops via the documented absent-block default.
    assert.equal(result.gate.pass, false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
