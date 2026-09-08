// tests/openrouter-runner.test.mjs — regression coverage for the
// workspace-symlink data-integrity bug: openrouter-runner.mjs used to derive
// its `ROOT` constant from `path.dirname(__dirname)` — a location Node
// resolves THROUGH a workspace's `core` symlink/junction back to the shared
// hub root — and fed EVERY repo-root-relative path (`.env`,
// `data/model-blacklist.json`, and every readFile/writeFile/fileExists call
// covering modes/, cv.md, config/, portals.yml, data/, reports/) off it.
// Under a real workspace dispatch (no CAREER_OPS_WORKSPACE override) this
// silently read/wrote the HUB ROOT's data instead of the invoking
// workspace's own.
//
// The fix routes ROOT through workspaceRoot() (core/workspace-root.mjs),
// which is process.env.CAREER_OPS_WORKSPACE || process.cwd() — matching how
// the router actually spawns workspace dispatches (cwd set to the target
// workspace). This is safe for modes/ too: every workspace's `modes` symlink
// points back at the same shared hub content either way.
//
// This test proves the DEFAULT path (no CAREER_OPS_WORKSPACE set, only cwd
// distinguishes the workspace) via the top-level, network-free
// `data/model-blacklist.json` load: running with no subcommand hits the
// `default:` (help) branch, which never calls loadFreeModels() / makes any
// network request, but the top-level `loadPersistedBlacklist()` call still
// runs unconditionally and logs the count it found — a directly observable,
// deterministic proof of which `data/` directory ROOT resolved to. The real
// hub root has no data/model-blacklist.json at all (confirmed), so any
// nonzero count in the output can only have come from the workspace-scoped
// temp fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('openrouter-runner.mjs resolves data/model-blacklist.json (and thus ROOT) off the workspace cwd, not the hub root', () => {
  const hubBlacklistPath = join(REPO_ROOT, 'data', 'model-blacklist.json');
  assert.ok(
    !existsSync(hubBlacklistPath),
    'precondition: the real hub root must not have data/model-blacklist.json — ' +
    'otherwise this test cannot distinguish "read the workspace fixture" from "read the hub root"'
  );

  const ws = mkdtempSync(join(tmpdir(), 'career-ops-openrouter-ws-'));
  try {
    mkdirSync(join(ws, 'data'), { recursive: true });
    writeFileSync(
      join(ws, 'data', 'model-blacklist.json'),
      JSON.stringify(['workspace-root-test/sentinel-model-a', 'workspace-root-test/sentinel-model-b'])
    );

    const env = { ...process.env };
    delete env.CAREER_OPS_WORKSPACE;

    // No subcommand -> falls into the `default:` (help) branch, which never
    // calls loadFreeModels() and makes no network request.
    const stdout = execFileSync(process.execPath, [
      join(REPO_ROOT, 'core', 'openrouter-runner.mjs'),
    ], { cwd: ws, env, encoding: 'utf-8', timeout: 10_000 });

    assert.match(
      stdout,
      /\[blacklist\] Loaded 2 pre-blacklisted model\(s\) from disk\./,
      `expected the workspace-scoped blacklist fixture (2 entries) to be loaded; got stdout:\n${stdout}`
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
