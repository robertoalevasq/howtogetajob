#!/usr/bin/env node
// @ts-check
// apply-browser-holder.mjs — a detached, long-lived process that keeps one
// real Playwright browser alive for one in-progress job application, so a
// candidate's later replies (each its own fresh `claude -p` dispatch, per
// core/telegram-monitor.mjs's architecture) can reconnect to the SAME
// browser via @playwright/mcp's --cdp-endpoint instead of launching a new
// one and re-authenticating/re-navigating from scratch every turn.
//
// One holder per {workspace, report} pair, never shared across candidates —
// see docs/superpowers/specs/2026-08-31-apply-persistent-browser-design.md's
// "Multi-tenancy isolation" section. The CDP endpoint binds to 127.0.0.1
// only: CDP access is full remote browser control, and this process must
// never be reachable from outside the machine it runs on.
//
// Usage: node apply-browser-holder.mjs --report <num> --workspace <path>
// (always spawned detached — see core/telegram-monitor.mjs's spawn call —
// so it outlives both the claude -p dispatch that triggered it and the
// daemon process itself).

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { withPipelineLock } from './pipeline-lock.mjs';
import { isMainModule } from './is-main.mjs';

/** @param {string} workspaceCwd */
export function browserSessionsStatePath(workspaceCwd) {
  return join(workspaceCwd, 'data', '.apply-browser-sessions.json');
}

/** @param {string} path @returns {Record<string, {endpoint: string, pid: number, createdAt: string}>} */
export function readBrowserSessions(path) {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** @param {string} path @param {Record<string, any>} sessions */
export function writeBrowserSessions(path, sessions) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sessions, null, 2));
}

// Reserve a free port ourselves rather than passing --remote-debugging-port=0
// to Chromium: we need to know the exact port in advance to query Chromium's
// own /json/version HTTP endpoint afterward and read back its real,
// Chrome-native CDP WebSocket URL. --remote-debugging-port=0 would still let
// Chromium pick a free port, but wouldn't tell us which one it picked.
async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Launch a real, remote-debuggable browser and record it in this workspace's
 * session-state file under `report`. Exposes Chromium's OWN native Chrome
 * DevTools Protocol endpoint (via its HTTP /json/version JSON response),
 * NOT Playwright's own launchServer()/wsEndpoint() protocol -- @playwright/mcp's
 * --cdp-endpoint flag calls chromium.connectOverCDP() internally, which
 * requires the genuine Chrome-native endpoint format
 * (ws://host:port/devtools/browser/{uuid}), not Playwright's internal
 * multiplexing-server format. Verified directly: connectOverCDP() fails
 * against a launchServer() wsEndpoint() value but succeeds against this one,
 * and session state (a navigated page, a JS global set on it) genuinely
 * persists across two independent connectOverCDP() connections to the same
 * endpoint -- the entire premise this feature depends on.
 *
 * @param {{report: string, workspaceCwd: string}} opts
 * @returns {Promise<{endpoint: string, browserServer: import('playwright').Browser}>}
 */
export async function launchHolder({ report, workspaceCwd }) {
  const port = await reserveFreePort();
  const browserServer = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  });
  // Chromium needs a brief moment after launch before its DevTools HTTP
  // endpoint is ready to answer -- a fixed short delay is simpler and more
  // than sufficient here (verified empirically with 500ms; use the same).
  await new Promise(r => setTimeout(r, 500));
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const { webSocketDebuggerUrl: endpoint } = await res.json();
  const statePath = browserSessionsStatePath(workspaceCwd);
  return withPipelineLock(statePath, () => {
    const sessions = readBrowserSessions(statePath);
    sessions[report] = { endpoint, pid: process.pid, createdAt: new Date().toISOString() };
    writeBrowserSessions(statePath, sessions);
    return { endpoint, browserServer };
  });
}

/** @param {string} workspaceCwd @param {string} report */
export function removeBrowserSession(workspaceCwd, report) {
  const path = browserSessionsStatePath(workspaceCwd);
  const sessions = readBrowserSessions(path);
  if (!(report in sessions)) return;
  delete sessions[report];
  writeBrowserSessions(path, sessions);
}

// Absolute lifetime cap for a holder process, NOT an activity-based idle
// timer: it is armed once at launch and never reset by CDP traffic, so a
// holder self-terminates this long after it started regardless of how busy
// the application has been. It exists only to stop an orphaned browser from
// running forever (see the spec's "Cleanup" section) and is a BACKSTOP: the
// documented mode-file cleanup triggers (Step 9 success, explicit skip, a
// hard-stop) are expected to remove the session first in the normal case —
// this only fires when every one of those was somehow missed.
//
// 4 hours, not the original 45 minutes: modes/apply.md's own account-creation
// flow documents an email-verification pause that can span "minutes to
// hours", so a 45-minute cap self-destructed during the exact wait this
// holder exists to survive. The value is chosen to comfortably exceed that
// documented window; genuine activity-based idle tracking was considered and
// deliberately rejected as disproportionate complexity for the benefit.
const DEFAULT_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/**
 * @param {string[]} argv - e.g. ['--report', '937', '--workspace', '/path']
 * @param {{launch?: typeof launchHolder, idleTimeoutMs?: number}} [opts]
 *   `launch` and `idleTimeoutMs` are injectable so tests never spawn a real
 *   browser or wait out the real DEFAULT_IDLE_TIMEOUT_MS lifetime cap.
 */
export async function runHolderCli(argv, opts = {}) {
  const launch = opts.launch || launchHolder;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const reportIdx = argv.indexOf('--report');
  const workspaceIdx = argv.indexOf('--workspace');
  const report = reportIdx !== -1 ? argv[reportIdx + 1] : null;
  const workspaceCwd = workspaceIdx !== -1 ? argv[workspaceIdx + 1] : null;
  if (!report || !workspaceCwd) {
    throw new Error('Usage: apply-browser-holder.mjs --report <num> --workspace <path>');
  }

  const { browserServer } = await launch({ report, workspaceCwd });

  let resolveStop;
  const stopped = new Promise(r => { resolveStop = r; });
  const timer = setTimeout(() => resolveStop(), idleTimeoutMs);
  const stopEarly = () => { clearTimeout(timer); resolveStop(); };
  process.on('SIGTERM', stopEarly);
  process.on('SIGINT', stopEarly);

  try {
    await stopped;
  } finally {
    try {
      await browserServer.close();
    } finally {
      process.off('SIGTERM', stopEarly);
      process.off('SIGINT', stopEarly);
      removeBrowserSession(workspaceCwd, report);
    }
  }
}

if (isMainModule(import.meta.url)) {
  runHolderCli(process.argv.slice(2)).catch(err => {
    console.error(`[apply-browser-holder] ${err.message}`);
    process.exitCode = 1;
  });
}
