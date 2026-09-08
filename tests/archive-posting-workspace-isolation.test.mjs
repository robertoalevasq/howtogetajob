import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Regression test for the workspace-multitenancy bug: archive-posting.mjs
// used to derive its jds/ and data/pipeline.md root from
// dirname(dirname(fileURLToPath(import.meta.url))), which resolves THROUGH
// a workspace's core/ symlink to the shared hub root regardless of which
// workspace invoked it. Run with cwd set to a throwaway workspace and NO
// CAREER_OPS_WORKSPACE override (the exact default-path case the bug lived
// in) — --dry-run --pipeline needs no Playwright browser, so it exercises
// the path resolution alone. The repo root that hosts this dev checkout has
// its OWN real, unrelated data/pipeline.md (gitignored user-layer content) —
// a canary URL that can only appear if the workspace's own pipeline.md,
// not that file, was read.
test('archive-posting.mjs --pipeline resolves data/pipeline.md from the invoking workspace cwd, not the repo root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  const canaryUrl = 'https://example.com/jobs/workspace-isolation-canary-999';
  writeFileSync(join(ws, 'data', 'pipeline.md'), [
    '# Pipeline',
    '',
    `- [ ] ${canaryUrl} | Workspace-Isolation-Canary Corp | Canary Engineer`,
    '',
  ].join('\n'));

  try {
    const out = execFileSync('node', [
      join(REPO_ROOT, 'core', 'archive-posting.mjs'), '--dry-run', '--pipeline',
    ], { cwd: ws, encoding: 'utf-8' });

    assert.match(out, /Archiving 1 posting\(s\) to jds\//);
    assert.ok(out.includes(canaryUrl), 'expected the workspace pipeline.md canary URL in the dry-run output');
    assert.ok(out.includes('Workspace-Isolation-Canary Corp'), 'expected the workspace pipeline.md canary company in the dry-run output');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
