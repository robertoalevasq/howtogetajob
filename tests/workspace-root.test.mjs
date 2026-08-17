import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceRoot } from '../core/workspace-root.mjs';

test('falls back to process.cwd() when CAREER_OPS_WORKSPACE is unset', () => {
  delete process.env.CAREER_OPS_WORKSPACE;
  assert.equal(workspaceRoot(), process.cwd());
});

test('uses CAREER_OPS_WORKSPACE when set', () => {
  process.env.CAREER_OPS_WORKSPACE = '/some/workspace/dir';
  try {
    assert.equal(workspaceRoot(), '/some/workspace/dir');
  } finally {
    delete process.env.CAREER_OPS_WORKSPACE;
  }
});
