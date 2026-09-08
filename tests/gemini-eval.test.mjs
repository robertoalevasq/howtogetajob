// tests/gemini-eval.test.mjs — regression coverage for the workspace-symlink
// data-integrity bug: gemini-eval.mjs used to derive its ENTIRE `PATHS` object
// (including user-layer cv.md, _profile.md, config/profile.yml, reports/,
// data/applications.md, data/tracker-additions/) from
// `dirname(fileURLToPath(import.meta.url))` — a location Node resolves
// THROUGH a workspace's `core` symlink/junction back to the shared hub root.
// Under a real workspace dispatch (no CAREER_OPS_WORKSPACE override — that
// env var is a test-only / rare escape hatch, never set by live dispatches)
// this silently read/wrote the HUB ROOT's user data instead of the invoking
// workspace's own.
//
// The fix routes the user-layer paths through workspaceRoot()
// (core/workspace-root.mjs), which is process.env.CAREER_OPS_WORKSPACE ||
// process.cwd() — matching how the router actually spawns workspace
// dispatches (cwd set to the target workspace). System-layer paths
// (modes/_shared.md, modes/oferta.md) intentionally stay anchored to the
// script's own physical location, since every workspace's `modes` symlink
// points back at the same shared content anyway.
//
// This test proves the DEFAULT path (no CAREER_OPS_WORKSPACE set, only cwd
// distinguishes the workspace) by asserting the resolved lookup paths for
// missing user-layer files are scoped to the temp workspace, never the real
// repo root — while the system-layer files are still found (no warning).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('gemini-eval.mjs resolves cv.md / _profile.md / config/profile.yml off the workspace cwd, not the hub root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-gemini-ws-'));
  try {
    const env = { ...process.env, GEMINI_API_KEY: 'dummy-key-for-path-resolution-test-only' };
    delete env.CAREER_OPS_WORKSPACE;

    const result = spawnSync(process.execPath, [
      join(REPO_ROOT, 'core', 'gemini-eval.mjs'),
      '--no-save', '--no-compress',
      'Fake JD text for a path-resolution smoke test.',
    ], {
      cwd: ws, env, encoding: 'utf-8',
      timeout: 10_000, // readFile() warnings print synchronously long before
                        // the eventual (dummy-key) network call resolves/fails
    });

    const stderr = result.stderr || '';

    // System-layer files (modes/_shared.md, modes/oferta.md) must still be
    // found via the script's own physical location — no warning for these.
    assert.doesNotMatch(stderr, /modes\/_shared\.md not found at:/);
    assert.doesNotMatch(stderr, /modes\/oferta\.md not found at:/);

    // User-layer files don't exist in the fresh temp workspace, so readFile()
    // warns with the exact path it looked at — proving where it looked.
    assert.match(stderr, /cv\.md not found at: (.+)/);
    assert.match(stderr, /_profile\.md not found at: (.+)/);
    assert.match(stderr, /config\/profile\.yml not found at: (.+)/);

    const cvPath = stderr.match(/cv\.md not found at: (.+)/)[1].trim();
    const profilePath = stderr.match(/_profile\.md not found at: (.+)/)[1].trim();
    const profileYmlPath = stderr.match(/config\/profile\.yml not found at: (.+)/)[1].trim();

    for (const [label, p] of [['cv.md', cvPath], ['_profile.md', profilePath], ['config/profile.yml', profileYmlPath]]) {
      assert.ok(p.startsWith(ws), `expected ${label} lookup to be scoped to the temp workspace ${ws}, got: ${p}`);
      assert.ok(!p.startsWith(REPO_ROOT) || p.startsWith(ws), `${label} must not resolve to the shared hub repo root (${REPO_ROOT}), got: ${p}`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
