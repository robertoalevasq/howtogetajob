import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('doctor.mjs --json reports the workspace cwd is missing cv.md, not the repo root state', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  try {
    const output = execFileSync('node', [join(REPO_ROOT, 'core', 'doctor.mjs'), '--json'], { cwd: ws, encoding: 'utf-8' });
    const result = JSON.parse(output);
    assert.equal(result.onboardingNeeded, true);
    assert.ok(result.missing.includes('cv.md'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
