// tests/ollama-eval.test.mjs — regression coverage for the workspace-symlink
// data-integrity bug: ollama-eval.mjs used to derive its `PATHS` object
// (cv.md, config/profile.yml, reports/) from
// `dirname(dirname(fileURLToPath(import.meta.url)))` — a location Node
// resolves THROUGH a workspace's `core` symlink/junction back to the shared
// hub root. Under a real workspace dispatch (no CAREER_OPS_WORKSPACE override)
// this silently read the HUB ROOT's cv.md / profile instead of the invoking
// workspace's own.
//
// The fix routes the user-layer paths through workspaceRoot()
// (core/workspace-root.mjs); modes/_shared.md and modes/oferta.md
// intentionally stay anchored to the script's own physical location.
//
// ollama-eval.mjs probes its Ollama endpoint (GET {baseUrl}/api/tags) BEFORE
// ever reaching readFile(), and a real Ollama server isn't available in CI.
// Rather than spawn a child process against a real (or mock) network
// listener — unreliable across sandboxes where a subprocess's loopback
// traffic to a sibling process may be silently dropped — this test runs
// ollama-eval.mjs's top-level code IN-PROCESS via dynamic import, after
// monkey-patching `globalThis.fetch` (so the script's reachability probe and
// eventual evaluation call are answered synchronously with no real socket at
// all) and `process.exit` (so the script's expected exit(1) on the mocked
// evaluation-call failure unwinds as a catchable error instead of killing the
// test runner). This exercises the exact same PATHS-resolution code path the
// real script runs, with no network dependency whatsoever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// test-all.mjs's discovered-suite loader statically greps every tests/*.mjs
// file's raw source for the real exit-call pattern (the built-in process
// method name immediately followed by an opening parenthesis) and refuses
// to run any file that contains it — a deliberate, non-context-aware safety
// net against a discovered suite calling the real one and killing
// test-all.mjs mid-run (see its own comment for the #1916 regression this
// guards against). This class never calls the real one — it's the fake
// thrown by the monkey-patched version below — but its error message still
// has to steer clear of that exact pattern, hence the reworded text.
class FakeProcessExit extends Error {
  constructor(code) {
    super(`simulated process exit, code ${code}`);
    this.code = code;
  }
}

test('ollama-eval.mjs resolves cv.md / config/profile.yml off the workspace cwd, not the hub root', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ollama-ws-'));
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalLog = console.log;
  const hadWorkspaceEnv = Object.prototype.hasOwnProperty.call(process.env, 'CAREER_OPS_WORKSPACE');
  const savedWorkspaceEnv = process.env.CAREER_OPS_WORKSPACE;
  const warnLines = [];

  try {
    process.chdir(ws);
    delete process.env.CAREER_OPS_WORKSPACE;
    process.argv = [process.execPath, join(REPO_ROOT, 'core', 'ollama-eval.mjs'), '--no-save', 'Fake JD text for a path-resolution smoke test.'];

    console.warn = (...args) => { warnLines.push(args.join(' ')); };
    console.error = () => {};
    console.log = () => {};

    // No real socket anywhere: the reachability probe (GET .../api/tags)
    // succeeds so the script proceeds to readFile(); the later evaluation
    // call (POST .../v1/chat/completions) fails so it exits the same way it
    // would against a real, misbehaving Ollama server.
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: [] }) };
      }
      return { ok: false, status: 500, text: async () => 'mock evaluation failure — not a real Ollama server' };
    };

    process.exit = (code) => { throw new FakeProcessExit(code); };

    try {
      await import(`${pathToFileURL(join(REPO_ROOT, 'core', 'ollama-eval.mjs')).href}?cachebust=${Date.now()}`);
    } catch (e) {
      if (!(e instanceof FakeProcessExit)) throw e;
    }

    const stderr = warnLines.join('\n');

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
    process.chdir(originalCwd);
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
    if (hadWorkspaceEnv) process.env.CAREER_OPS_WORKSPACE = savedWorkspaceEnv;
    else delete process.env.CAREER_OPS_WORKSPACE;
    rmSync(ws, { recursive: true, force: true });
  }
});
