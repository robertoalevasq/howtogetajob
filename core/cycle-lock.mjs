#!/usr/bin/env node
/**
 * cycle-lock.mjs — prevents two `cycle` invocations (however triggered —
 * Telegram daemon, a manual `claude -p` run, any future trigger) from
 * running concurrently and duplicating work/deliveries.
 *
 * Added 2026-08-13 after a manual reproduction test overlapped a real
 * Telegram-triggered cycle run — both independently swept the same ~39K
 * companies and delivered duplicate Discord/Telegram notifications for the
 * same matches. No data corrupted (atomic report reservation + file-based
 * dedup held), but real compute and duplicate notifications were wasted.
 *
 * Unlike pipeline-lock.mjs's PID-liveness model (right for guarding a
 * single persistent process holding an in-memory handle — see
 * telegram-monitor.mjs's daemon lock), a `cycle` run spans many separate OS
 * processes across potentially many hours: there's no single PID to check
 * liveness against. This uses heartbeat-refresh staleness instead — the
 * lock stays valid as long as something refreshes it periodically
 * (cycle.md's own Progress Reporting checkpoints already fire every ~25
 * URLs or at each Pass boundary, far more often than the staleness window),
 * and becomes reclaimable once nothing has refreshed it in a while (a
 * genuinely dead or crashed run).
 *
 * Usage:
 *   node cycle-lock.mjs acquire   # Step 0 — before Step 1 starts
 *   node cycle-lock.mjs refresh   # at every Progress Reporting checkpoint
 *   node cycle-lock.mjs release   # end of Step 5 (or as soon as a run stops)
 *   node cycle-lock.mjs status    # check without acquiring
 *
 * Every command prints one JSON line and exits 0 — never throws on a lock
 * conflict, so a caller can always parse the result and branch cleanly.
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { workspaceRoot } from './workspace-root.mjs';

// Overridable for override-consistency with the rest of the codebase
// (#workspace-multitenancy Task 8). Falls back to the current workspace
// root, not a bare cwd-relative literal — each user's cycle lock must land
// in their own workspace.
const LOCK_DIR = process.env.CAREER_OPS_CYCLE_LOCK
  || join(workspaceRoot(), 'data', 'cycle.lock');
const OWNER_PATH = `${LOCK_DIR}/owner.json`;
// Generous on purpose: real checkpoints refresh far more often than this
// (every ~25 URLs, every Pass boundary) — this window only needs to be
// short enough to recover from a genuinely crashed run in a reasonable
// time, not tuned to normal operating cadence.
const STALE_MS = 30 * 60 * 1000;

function readOwner() {
  try {
    return JSON.parse(readFileSync(OWNER_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function isStale(owner) {
  if (!owner) return true;
  const last = new Date(owner.lastRefreshedAt || owner.startedAt).getTime();
  return Number.isFinite(last) ? (Date.now() - last) > STALE_MS : true;
}

function acquire() {
  mkdirSync(dirname(LOCK_DIR), { recursive: true });

  if (existsSync(LOCK_DIR)) {
    const owner = readOwner();
    if (!isStale(owner)) {
      console.log(JSON.stringify({
        acquired: false,
        reason: 'a cycle run is already in progress',
        startedAt: owner?.startedAt ?? null,
        lastRefreshedAt: owner?.lastRefreshedAt ?? null,
      }));
      return;
    }
    // Stale — nothing has refreshed it in STALE_MS, treat as abandoned by a
    // crashed/interrupted run and reclaim it.
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }

  try {
    mkdirSync(LOCK_DIR);
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Lost a race to acquire — another invocation got here first.
      console.log(JSON.stringify({ acquired: false, reason: 'lost acquisition race' }));
      return;
    }
    throw err;
  }

  const now = new Date().toISOString();
  writeFileSync(OWNER_PATH, JSON.stringify({ token: randomUUID(), startedAt: now, lastRefreshedAt: now }, null, 2));
  console.log(JSON.stringify({ acquired: true }));
}

function refresh() {
  const owner = readOwner();
  if (!owner) {
    console.log(JSON.stringify({ refreshed: false, error: 'no lock held — acquire was never called or it was already released' }));
    return;
  }
  owner.lastRefreshedAt = new Date().toISOString();
  writeFileSync(OWNER_PATH, JSON.stringify(owner, null, 2));
  console.log(JSON.stringify({ refreshed: true }));
}

function release() {
  if (existsSync(LOCK_DIR)) rmSync(LOCK_DIR, { recursive: true, force: true });
  console.log(JSON.stringify({ released: true }));
}

function status() {
  if (!existsSync(LOCK_DIR)) {
    console.log(JSON.stringify({ held: false }));
    return;
  }
  const owner = readOwner();
  console.log(JSON.stringify({ held: true, stale: isStale(owner), ...owner }));
}

const cmd = process.argv[2];
if (cmd === 'acquire') acquire();
else if (cmd === 'refresh') refresh();
else if (cmd === 'release') release();
else if (cmd === 'status') status();
else {
  console.error('Usage: node cycle-lock.mjs <acquire|refresh|release|status>');
  process.exit(1);
}
