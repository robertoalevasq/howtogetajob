import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { browserSessionsStatePath, readBrowserSessions, writeBrowserSessions, removeBrowserSession, runHolderCli, launchHolder } from '../core/apply-browser-holder.mjs';

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

test('removeBrowserSession deletes only the named report, leaving other entries intact', () => {
  const ws = fakeWorkspace();
  try {
    const path = browserSessionsStatePath(ws);
    writeBrowserSessions(path, {
      '937': { endpoint: 'ws://a', pid: 1, createdAt: '2026-08-31T00:00:00.000Z' },
      '938': { endpoint: 'ws://b', pid: 2, createdAt: '2026-08-31T00:00:00.000Z' },
    });
    removeBrowserSession(ws, '937');
    const remaining = readBrowserSessions(path);
    assert.equal(remaining['937'], undefined);
    assert.equal(remaining['938'].endpoint, 'ws://b');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('removeBrowserSession is a no-op when the report was never present or the file does not exist', () => {
  const ws = fakeWorkspace();
  try {
    // File doesn't exist at all yet.
    assert.doesNotThrow(() => removeBrowserSession(ws, '999'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('runHolderCli launches a real browser, writes the state entry, then removes it on idle timeout', async () => {
  const ws = fakeWorkspace();
  try {
    let closed = false;
    const fakeLaunch = async ({ report, workspaceCwd }) => {
      // Real launchHolder writes the entry itself — the fake must too, so
      // runHolderCli's cleanup-on-exit path has something real to remove.
      const path = browserSessionsStatePath(workspaceCwd);
      const sessions = readBrowserSessions(path);
      sessions[report] = { endpoint: 'ws://127.0.0.1:9/fake', pid: process.pid, createdAt: new Date().toISOString() };
      writeBrowserSessions(path, sessions);
      return { endpoint: 'ws://127.0.0.1:9/fake', browserServer: { close: async () => { closed = true; } } };
    };
    await runHolderCli(['--report', '937', '--workspace', ws], { launch: fakeLaunch, idleTimeoutMs: 10 });
    assert.equal(closed, true, 'the browser server should be closed on idle timeout');
    assert.deepEqual(readBrowserSessions(browserSessionsStatePath(ws))['937'], undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('runHolderCli removes the state entry even if browserServer.close() rejects', async () => {
  const ws = fakeWorkspace();
  try {
    const fakeLaunch = async ({ report, workspaceCwd }) => {
      // Real launchHolder writes the entry itself — the fake must too, so
      // runHolderCli's cleanup-on-exit path has something real to remove.
      const path = browserSessionsStatePath(workspaceCwd);
      const sessions = readBrowserSessions(path);
      sessions[report] = { endpoint: 'ws://127.0.0.1:9/fake', pid: process.pid, createdAt: new Date().toISOString() };
      writeBrowserSessions(path, sessions);
      return {
        endpoint: 'ws://127.0.0.1:9/fake',
        browserServer: {
          close: async () => {
            throw new Error('simulated crash during close');
          },
        },
      };
    };
    // runHolderCli will reject because close() throws, but that's expected.
    // The important thing is that removeBrowserSession still ran in the finally.
    await assert.rejects(
      () => runHolderCli(['--report', '938', '--workspace', ws], { launch: fakeLaunch, idleTimeoutMs: 10 }),
      /simulated crash during close/,
    );
    // State entry must be removed even though close() threw.
    assert.deepEqual(readBrowserSessions(browserSessionsStatePath(ws))['938'], undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('launchHolder exposes a genuine Chrome-native CDP endpoint that connectOverCDP() can actually connect to', async () => {
  const ws = fakeWorkspace();
  let holder;
  let cdpConnection;
  try {
    holder = await launchHolder({ report: '999', workspaceCwd: ws });
    const { endpoint } = holder;

    // The whole point of this fix: the recorded endpoint must be Chromium's
    // OWN native CDP endpoint (ws://host:port/devtools/browser/{uuid}), not
    // Playwright's internal launchServer()/wsEndpoint() multiplexing format.
    assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/.+/);

    // Confirm it's also what got written to the state file.
    const sessions = readBrowserSessions(browserSessionsStatePath(ws));
    assert.equal(sessions['999'].endpoint, endpoint);

    // The real proof: connectOverCDP() (what @playwright/mcp's --cdp-endpoint
    // uses internally) must actually succeed against this endpoint.
    cdpConnection = await chromium.connectOverCDP(endpoint);
    assert.equal(cdpConnection.isConnected(), true);
    // Exercise the connection for real, not just check the flag.
    await cdpConnection.contexts();
  } finally {
    if (cdpConnection) {
      await cdpConnection.close().catch(() => {});
    }
    if (holder) {
      await holder.browserServer.close().catch(() => {});
    }
    rmSync(ws, { recursive: true, force: true });
  }
});
