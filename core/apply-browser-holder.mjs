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
import { withPipelineLock } from './pipeline-lock.mjs';

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

/**
 * Launch a real, remote-debuggable browser and record it in this workspace's
 * session-state file under `report`. Port 0 lets the OS assign a free port —
 * multiple holders (different reports, possibly different candidates) run
 * concurrently, so a fixed port would collide.
 *
 * @param {{report: string, workspaceCwd: string}} opts
 * @returns {Promise<{endpoint: string, browserServer: import('playwright').BrowserServer}>}
 */
export async function launchHolder({ report, workspaceCwd }) {
  const browserServer = await chromium.launchServer({
    headless: true,
    args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
  });
  const endpoint = browserServer.wsEndpoint();
  const statePath = browserSessionsStatePath(workspaceCwd);
  return withPipelineLock(statePath, () => {
    const sessions = readBrowserSessions(statePath);
    sessions[report] = { endpoint, pid: process.pid, createdAt: new Date().toISOString() };
    writeBrowserSessions(statePath, sessions);
    return { endpoint, browserServer };
  });
}
