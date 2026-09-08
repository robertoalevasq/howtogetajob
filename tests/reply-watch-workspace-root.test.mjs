// tests/reply-watch-workspace-root.test.mjs — regression coverage for the
// workspace-symlink data-integrity bug in reply-watch.mjs: DEFAULT_CANDIDATES_PATH,
// APPS_FILE, and FOLLOWUPS_FILE all used to derive their workspace-data root
// from the script's own on-disk location (dirname(fileURLToPath(...))), which
// resolves THROUGH a workspace's `core` symlink/junction back to the shared
// hub root. Under a real workspace dispatch (no CAREER_OPS_TRACKER override —
// that env var is a test-only escape hatch, never set by live dispatches)
// this silently read/wrote the HUB ROOT's data instead of the invoking
// workspace's own.
//
// The fix routes all three through workspaceRoot() (core/workspace-root.mjs),
// which is process.env.CAREER_OPS_WORKSPACE || process.cwd() — matching how
// the router actually spawns workspace dispatches (cwd set to the target
// workspace). This test proves the DEFAULT path (no CAREER_OPS_TRACKER set),
// which is exactly the case existing tests never covered.
//
// The fixture is deliberately built so the matched reply's suggested tracker
// update equals the row's current status (Interview -> Interview) — no
// recommendation is generated, so the script never reaches its interactive
// confirmation prompt, keeping this test non-interactive without needing to
// fake stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('reply-watch.mjs defaults its candidates/tracker/followups paths to the workspace cwd, not the repo root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-reply-watch-ws-'));
  mkdirSync(join(ws, 'data'), { recursive: true });

  const trackerPath = join(ws, 'data', 'applications.md');
  writeFileSync(trackerPath,
    '# Applications Tracker\n\n'
    + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
    + '|---|------|---------|------|-------|--------|-----|--------|-------|\n'
    + '| 1 | 2026-06-01 | WorkspaceRootProbeCo | Backend Engineer | 4.2/5 | Interview | ❌ | [1](reports/1-x-2026-06-01.md) | — |\n');

  // A candidate that only matches a company/role present in the WORKSPACE
  // tracker. If reply-watch reads the wrong tracker (e.g. the hub root's,
  // which has no "WorkspaceRootProbeCo" row), this candidate matches nothing
  // and the header printed for it falls back to the sender/subject instead.
  const candidatesPath = join(ws, 'data', 'reply-candidates.json');
  writeFileSync(candidatesPath, JSON.stringify([
    {
      message_id: 'probe-1',
      from: 'hr@workspacerootprobeco-example.invalid',
      subject: 'WorkspaceRootProbeCo interview invitation',
      body_snippet: 'We would like to schedule an interview for the Backend Engineer position.',
      signal: 'interview_invite',
    },
  ], null, 2));

  // Deliberately no CAREER_OPS_TRACKER / CAREER_OPS_WORKSPACE set — this is
  // the real-world default path a live workspace dispatch actually takes:
  // only cwd distinguishes one workspace from another. No candidates-file
  // argv is passed either, so DEFAULT_CANDIDATES_PATH itself is exercised.
  const env = { ...process.env };
  delete env.CAREER_OPS_TRACKER;
  delete env.CAREER_OPS_WORKSPACE;

  try {
    const stdout = execFileSync(process.execPath, [join(REPO_ROOT, 'core', 'reply-watch.mjs')], {
      cwd: ws, env, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Proves APPS_FILE and DEFAULT_CANDIDATES_PATH both resolved into the
    // workspace: the match against the workspace-only company only succeeds
    // if both were read from `ws`, not the hub root.
    assert.match(stdout, /WorkspaceRootProbeCo — Backend Engineer/);
    assert.match(stdout, /Type: Interview/);

    // No status change was recommended (Interview -> Interview is a no-op),
    // so the script must not have reached its interactive confirmation.
    assert.doesNotMatch(stdout, /Apply recommended status updates/);

    // ensureCandidatesFile() must not have overwritten the fixture we placed
    // at the workspace's DEFAULT_CANDIDATES_PATH.
    const candidatesAfter = JSON.parse(readFileSync(candidatesPath, 'utf-8'));
    assert.equal(candidatesAfter[0].message_id, 'probe-1');

    // The real repo-root tracker (present in a provisioned checkout, absent
    // in a clean one) must never have been consulted or modified.
    const repoRootTrackerPath = join(REPO_ROOT, 'data', 'applications.md');
    if (existsSync(repoRootTrackerPath)) {
      const repoRootTracker = readFileSync(repoRootTrackerPath, 'utf-8');
      assert.doesNotMatch(repoRootTracker, /WorkspaceRootProbeCo/);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
