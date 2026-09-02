import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getActiveTaskStatus } from '../core/admin-overview-snapshot.mjs';

test('getActiveTaskStatus reports no_run for a workspace that never ran cycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    const result = getActiveTaskStatus(root);
    assert.equal(result.state, 'no_run');
    assert.equal(result.staleMs, null);
    assert.equal(result.step, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getActiveTaskStatus reports done for a workspace with a completed cycle run', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    mkdirSync(join(root, 'data', 'cache'), { recursive: true });
    writeFileSync(join(root, 'data', 'cache', 'cycle-status.json'), JSON.stringify({
      version: 1,
      runId: '2026-01-01T00:00:00.000Z',
      savedAt: new Date().toISOString(),
      step: { id: 'done', label: 'Cycle complete' },
      counters: {},
      lastError: null,
    }));
    const result = getActiveTaskStatus(root);
    assert.equal(result.state, 'done');
    assert.equal(result.step.id, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getActiveTaskStatus reports running for a fresh in-progress cycle run', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-overview-'));
  try {
    mkdirSync(join(root, 'data', 'cache'), { recursive: true });
    writeFileSync(join(root, 'data', 'cache', 'cycle-status.json'), JSON.stringify({
      version: 1,
      runId: '2026-01-01T00:00:00.000Z',
      savedAt: new Date().toISOString(),
      step: { id: '2-pipeline', label: 'Pipeline Processing' },
      counters: { pipeline_pending: 5 },
      lastError: null,
    }));
    const result = getActiveTaskStatus(root);
    assert.equal(result.state, 'running');
    assert.equal(result.step.label, 'Pipeline Processing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getActiveTaskStatus never throws for a workspace directory that does not exist', () => {
  assert.doesNotThrow(() => getActiveTaskStatus('/definitely/does/not/exist/anywhere'));
});
