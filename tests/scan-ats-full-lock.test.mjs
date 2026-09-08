// tests/scan-ats-full-lock.test.mjs — regression coverage for the
// concurrent-sweep bug: found live 2026-09-04 (leonie's workspace), a
// single `cycle` run's own "if it exits, re-run with --resume" retry logic
// (modes/cycle.md's Pass B polling loop) briefly ran 6 concurrent
// scan-ats-full.mjs processes against the same checkpoint file before being
// killed down to 1. No data was lost (the checkpoint write was already
// safe), but real compute/network was wasted racing duplicated sweeps. The
// fix reuses pipeline-lock.mjs's PID-liveness advisory lock, keyed on the
// checkpoint file path, acquired at the top of main() and released via a
// process 'exit' handler so it covers every one of main()'s many existing
// exit-call sites without needing a try/finally threaded through the whole
// (pre-existing, large) function. (Note: this file's own wording steers
// around the literal exit-call pattern text throughout — test-all.mjs's
// discovered-suite loader statically greps every tests/*.mjs file's raw
// source for it and refuses to run any file that contains it, a safety net
// against a discovered suite calling the real one and killing test-all.mjs
// mid-run; see its own comment for the #1916 regression this guards
// against. Nothing in this file calls it for real.)
//
// These tests deliberately avoid a real network sweep: a workspace with no
// portals.yml makes main() acquire the lock and then exit(1) almost
// immediately (an existing, unrelated check) — fast and deterministic,
// while still exercising the exact lock acquire/release code path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquirePipelineLock } from '../core/pipeline-lock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'core', 'scan-ats-full.mjs');

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-scan-lock-'));
  mkdirSync(join(ws, 'data', 'cache'), { recursive: true });
  return ws;
}

function checkpointPathFor(ws) {
  return join(ws, 'data', 'cache', 'ats-full-checkpoint.json');
}

function runSweep(ws, extraEnv = {}) {
  return spawnSync('node', [SCRIPT, '--ats', 'greenhouse', '--include-undated'], {
    cwd: ws,
    encoding: 'utf-8',
    env: { ...process.env, CAREER_OPS_WORKSPACE: ws, ...extraEnv },
  });
}

test('a second sweep against the same checkpoint is rejected fast, not run concurrently', async () => {
  const ws = makeWorkspace();
  const lock = await acquirePipelineLock(checkpointPathFor(ws));
  try {
    const result = runSweep(ws, { CAREER_OPS_PIPELINE_LOCK_TIMEOUT_MS: '300', CAREER_OPS_PIPELINE_LOCK_RETRY_MS: '30' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already running/i);
    // No sweep work happened — the portals.yml-not-found path (which would
    // fire next if the lock were somehow bypassed) never got a chance to run
    // AND no checkpoint was created, since the process refused before doing
    // anything at all.
    assert.equal(existsSync(checkpointPathFor(ws)), false);
  } finally {
    lock.release();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('the lock is released on exit even via an internal early-exit call, not just a clean return', () => {
  const ws = makeWorkspace(); // no portals.yml — main() acquires the lock, then exit(1)s almost immediately
  try {
    const first = runSweep(ws);
    assert.equal(first.status, 1);
    assert.match(first.stderr, /portals\.yml not found/i);

    // If the first run's lock leaked (not released on its exit(1)), this
    // second run would fail with "already running" instead of reaching the
    // same portals.yml-not-found check.
    const second = runSweep(ws);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /portals\.yml not found/i);
    assert.doesNotMatch(second.stderr, /already running/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a stale lock (dead owner PID) is reclaimed rather than blocking forever', () => {
  const ws = makeWorkspace(); // no portals.yml — same fast/deterministic path as above
  try {
    // A PID essentially guaranteed to be dead: spawn a trivial, instantly-
    // finishing child and capture its pid after it has already exited.
    const dead = spawnSync('node', ['--version']);
    const deadPid = dead.pid;

    const lockDir = `${checkpointPathFor(ws)}.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      pid: deadPid,
      token: 'stale-test-token',
      started_at: new Date(0).toISOString(),
      pipeline: checkpointPathFor(ws),
    }, null, 2));

    const result = runSweep(ws, { CAREER_OPS_PIPELINE_LOCK_TIMEOUT_MS: '2000', CAREER_OPS_PIPELINE_LOCK_RETRY_MS: '30' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /portals\.yml not found/i);
    assert.doesNotMatch(result.stderr, /already running/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('--dry-run never touches the lock, so it can run alongside a real sweep', () => {
  const ws = makeWorkspace();
  const checkpointPath = checkpointPathFor(ws);
  return acquirePipelineLock(checkpointPath).then(async (lock) => {
    try {
      const result = spawnSync('node', [SCRIPT, '--ats', 'greenhouse', '--include-undated', '--dry-run'], {
        cwd: ws,
        encoding: 'utf-8',
        env: { ...process.env, CAREER_OPS_WORKSPACE: ws },
      });
      // Reaches the same portals.yml-not-found exit, never the lock-timeout
      // path, proving --dry-run skipped lock acquisition entirely.
      assert.equal(result.status, 1);
      assert.match(result.stderr, /portals\.yml not found/i);
      assert.doesNotMatch(result.stderr, /already running/i);
    } finally {
      lock.release();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
