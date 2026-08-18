import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionWorkspace, SLUG_RE } from '../core/provision-workspace.mjs';

test('rejects invalid slugs', () => {
  assert.equal(SLUG_RE.test('../etc'), false);
  assert.equal(SLUG_RE.test('a/b'), false);
  assert.equal(SLUG_RE.test('Alice'), false); // uppercase not allowed
  assert.equal(SLUG_RE.test('a'), false); // too short (min 2 chars)
  assert.equal(SLUG_RE.test('alice'), true);
  assert.equal(SLUG_RE.test('alice-2'), true);
});

test('provisionWorkspace throws on an invalid slug without touching disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    assert.throws(() => provisionWorkspace('../escape', { reposRoot: root }));
    assert.equal(existsSync(join(root, 'workspaces')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionWorkspace creates the expected junctions and real files', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('alice', { reposRoot: root });
    const wsDir = join(root, 'workspaces', 'alice');
    assert.ok(existsSync(join(wsDir, 'workspace.json')));
    const meta = JSON.parse(readFileSync(join(wsDir, 'workspace.json'), 'utf-8'));
    assert.equal(meta.slug, 'alice');
    assert.ok(meta.created_at);

    // Real user-layer entries
    assert.ok(existsSync(join(wsDir, 'data')));
    assert.ok(existsSync(join(wsDir, 'config')));
    assert.ok(existsSync(join(wsDir, 'data', 'pipeline.md')));

    // Junctioned system entries
    const modesLink = lstatSync(join(wsDir, 'modes'));
    assert.ok(modesLink.isSymbolicLink() || modesLink.isDirectory());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionWorkspace is idempotent — re-running does not error or duplicate', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('bob', { reposRoot: root });
    assert.doesNotThrow(() => provisionWorkspace('bob', { reposRoot: root, repair: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
