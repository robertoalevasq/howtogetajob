// Regression test for the "junctioned invocation silently no-ops" bug
// (final-review finding, Critical 2, 2026-08-15 workspace-multitenancy pass).
//
// Root cause: `isMain` guards compared `import.meta.url` (which Node
// resolves through a directory junction to the REAL file path) against
// `process.argv[1]` (which retains the LITERAL junctioned invocation path
// typed on the command line). Those never match when a script is invoked
// as `node core/<script>.mjs` from inside a workspaces/{slug}/ directory,
// where `core` is a junction back to the real core/ directory -- so
// `main()` never ran and the process exited 0 having silently done nothing.
//
// Every prior isolation test (see tests/doctor-workspace-isolation.test.mjs)
// invoked scripts via their ABSOLUTE real path
// (`join(REPO_ROOT, 'core', 'doctor.mjs')`), which happened to sidestep the
// junction entirely and never exercised the bug. This test deliberately
// invokes via the RELATIVE, junctioned path (`core/<script>.mjs`, cwd set
// inside the provisioned workspace) -- the exact invocation shape
// modes/*.md prose tells the agent to run -- and asserts real, non-empty,
// expected stdout instead of silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { provisionWorkspace } from '../core/provision-workspace.mjs';

function provisionThrowawayWorkspace() {
  const reposRoot = mkdtempSync(join(tmpdir(), 'career-ops-ismain-'));
  const wsDir = provisionWorkspace('ismain-test', { reposRoot });
  return { reposRoot, wsDir };
}

test('node core/stats.mjs produces real output when invoked from a junctioned workspace cwd', () => {
  const { reposRoot, wsDir } = provisionThrowawayWorkspace();
  try {
    const stdout = execFileSync('node', ['core/stats.mjs'], { cwd: wsDir, encoding: 'utf-8' });
    assert.notEqual(stdout.trim(), '', 'stats.mjs produced no output at all — main() likely never ran');
    const result = JSON.parse(stdout);
    assert.ok(result.metadata && result.metadata.generatedAt, 'expected a metadata.generatedAt field in stats.mjs JSON output');
    assert.equal(result.tracker.total, 0, 'fresh workspace should report an empty tracker');
  } finally {
    rmSync(reposRoot, { recursive: true, force: true });
  }
});

test('node core/plugins.mjs list produces real output when invoked from a junctioned workspace cwd', () => {
  const { reposRoot, wsDir } = provisionThrowawayWorkspace();
  try {
    const stdout = execFileSync('node', ['core/plugins.mjs', 'list'], { cwd: wsDir, encoding: 'utf-8' });
    assert.notEqual(stdout.trim(), '', 'plugins.mjs list produced no output at all — main() likely never ran');
    assert.match(stdout, /Discovered plugins:/, 'expected the standard plugins.mjs list header');
  } finally {
    rmSync(reposRoot, { recursive: true, force: true });
  }
});

test('node core/tracker.mjs export produces real output when invoked from a junctioned workspace cwd', () => {
  const { reposRoot, wsDir } = provisionThrowawayWorkspace();
  try {
    const stdout = execFileSync('node', ['core/tracker.mjs', 'export'], { cwd: wsDir, encoding: 'utf-8' });
    assert.notEqual(stdout.trim(), '', 'tracker.mjs export produced no output at all — main() likely never ran');
    assert.match(stdout, /# Applications Tracker/, 'expected the canonical tracker markdown header');
  } finally {
    rmSync(reposRoot, { recursive: true, force: true });
  }
});
