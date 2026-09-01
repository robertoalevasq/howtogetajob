import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserSessionsStatePath, readBrowserSessions, writeBrowserSessions } from '../core/apply-browser-holder.mjs';

function fakeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'career-ops-browser-holder-'));
}

test('browserSessionsStatePath resolves under {workspace}/data/.apply-browser-sessions.json', () => {
  const ws = fakeWorkspace();
  try {
    assert.equal(browserSessionsStatePath(ws), join(ws, 'data', '.apply-browser-sessions.json'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('readBrowserSessions returns {} when the file does not exist yet', () => {
  const ws = fakeWorkspace();
  try {
    const path = browserSessionsStatePath(ws);
    assert.deepEqual(readBrowserSessions(path), {});
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('writeBrowserSessions creates the data/ directory and persists entries; readBrowserSessions reads them back', () => {
  const ws = fakeWorkspace();
  try {
    const path = browserSessionsStatePath(ws);
    writeBrowserSessions(path, { '937': { endpoint: 'ws://127.0.0.1:9999/devtools/browser/abc', pid: 12345, createdAt: '2026-08-31T00:00:00.000Z' } });
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(raw['937'].pid, 12345);
    const reread = readBrowserSessions(path);
    assert.equal(reread['937'].endpoint, 'ws://127.0.0.1:9999/devtools/browser/abc');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
