// tests/openai-eval.test.mjs — regression coverage for the workspace-symlink
// data-integrity bug: openai-eval.mjs used to derive its `PATHS` object
// (cv.md, config/profile.yml, reports/) from
// `dirname(dirname(fileURLToPath(import.meta.url)))` — a location Node
// resolves THROUGH a workspace's `core` symlink/junction back to the shared
// hub root. Under a real workspace dispatch (no CAREER_OPS_WORKSPACE override)
// this silently read the HUB ROOT's cv.md / profile instead of the invoking
// workspace's own.
//
// The fix routes the user-layer paths through workspaceRoot()
// (core/workspace-root.mjs); modes/_shared.md and modes/oferta.md
// intentionally stay anchored to the script's own physical location (every
// workspace's `modes` symlink points back at the same shared content anyway).
//
// This test proves the DEFAULT path (no CAREER_OPS_WORKSPACE set, only cwd
// distinguishes the workspace). It points --url at an unused loopback port so
// the endpoint+security guard (which only requires an API key for non-loopback
// hosts) is satisfied without a key, letting the script reach its readFile()
// calls — which warn with the exact path they looked at when a user-layer
// file is missing from the fresh temp workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('openai-eval.mjs resolves cv.md / config/profile.yml off the workspace cwd, not the hub root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-openai-ws-'));
  try {
    const env = { ...process.env };
    delete env.CAREER_OPS_WORKSPACE;
    delete env.OPENAI_API_KEY;

    const result = spawnSync(process.execPath, [
      join(REPO_ROOT, 'core', 'openai-eval.mjs'),
      '--no-save', '--no-compress',
      '--url', 'http://127.0.0.1:1', // loopback + nothing listening: skips the
                                      // API-key gate, fails fast once it tries
                                      // to actually call out (ECONNREFUSED)
      'Fake JD text for a path-resolution smoke test.',
    ], { cwd: ws, env, encoding: 'utf-8', timeout: 10_000 });

    const stderr = result.stderr || '';

    // System-layer files must still resolve via the script's own physical
    // location — no warning for these.
    assert.doesNotMatch(stderr, /modes\/_shared\.md not found at:/);
    assert.doesNotMatch(stderr, /modes\/oferta\.md not found at:/);

    // User-layer files don't exist in the fresh temp workspace.
    assert.match(stderr, /cv\.md not found at: (.+)/);
    assert.match(stderr, /config\/profile\.yml not found at: (.+)/);

    const cvPath = stderr.match(/cv\.md not found at: (.+)/)[1].trim();
    const profileYmlPath = stderr.match(/config\/profile\.yml not found at: (.+)/)[1].trim();

    for (const [label, p] of [['cv.md', cvPath], ['config/profile.yml', profileYmlPath]]) {
      assert.ok(p.startsWith(ws), `expected ${label} lookup to be scoped to the temp workspace ${ws}, got: ${p}`);
      assert.ok(!p.startsWith(REPO_ROOT) || p.startsWith(ws), `${label} must not resolve to the shared hub repo root (${REPO_ROOT}), got: ${p}`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
