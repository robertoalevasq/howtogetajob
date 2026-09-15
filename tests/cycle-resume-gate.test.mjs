// Regression tests for checkForStalledCycle()'s resume gate (#found-live-2026-09-15).
//
// The bug this guards: the gate required THREE values an LLM writes by hand
// from prose in modes/cycle.md — step.id === '2-pipeline', a top-level
// lastStopReason === 'batch-limit', and counters.pipelineUrlsPending > 0. In
// the thomas-acosta workspace the checkpoint came out as step.id
// "step2-batch1", lastStopReason nested inside `counters`, and the backlog
// under `pending_total`. All three conditions missed, the daemon never
// dispatched a continuation, and 563 ready-to-evaluate URLs sat idle for 14
// hours — across a daemon restart that should have picked them up. Nothing in
// the suite covered checkForStalledCycle at all, which is how it shipped.
//
// The gate now counts the backlog from data/pipeline.md — the file a resumed
// batch actually consumes — so no agent-authored field name can disable it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForStalledCycle, countPendingPipelineUrls } from '../core/telegram-monitor.mjs';

const NOW = new Date('2026-09-15T15:00:00.000Z');

/** The exact malformed checkpoint found on disk in thomas-acosta on 2026-09-15. */
const THOMAS_STATUS = {
  version: 1,
  runId: '2026-09-15T01:14:01.042Z',
  savedAt: '2026-09-15T01:20:58.161Z',
  step: { id: 'step2-batch1', label: 'Pipeline Processing (Batch 1/17)' },
  counters: {
    pipelineUrlsPending: 0, // <- the real backlog went to `pending_total` instead
    pending: 2165,
    pending_total: 353,
    batch_limit: 20,
    lastStopReason: 'batch-limit', // <- belongs at the top level
  },
  lastError: null,
  lastStopReason: null,
  resumeNotBefore: null,
  liveness: { state: 'stalled', staleMs: 49_742_000, lastUpdateAgo: '13h 49m ago' },
};

/** A workspace on disk with a pipeline.md holding `pending` unprocessed rows. */
function makeWorkspace(pending, processed = 3) {
  const cwd = mkdtempSync(join(tmpdir(), 'cycle-resume-'));
  mkdirSync(join(cwd, 'data'), { recursive: true });
  const rows = [
    ...Array.from({ length: processed }, (_, i) => `- [x] #0${i} | https://example.com/done/${i} | evaluated`),
    ...Array.from({ length: pending }, (_, i) => `- [ ] https://example.com/pending/${i}`),
  ];
  writeFileSync(join(cwd, 'data', 'pipeline.md'), `# Pipeline — Pending URLs\n\n## Pending\n\n${rows.join('\n')}\n`);
  return cwd;
}

/**
 * Drive checkForStalledCycle with a fake exec: `cycle-lock.mjs status` and
 * `cycle-status.mjs --json` are the only two subprocesses it shells out to.
 */
function run({ cwd, status, lock = { held: false, stale: false }, trackers = {} }) {
  const dispatched = [];
  checkForStalledCycle(async (d) => { dispatched.push(d); }, {
    now: NOW,
    buildBoundChatMap: () => new Map([['8271178480', cwd]]),
    exec: (cmd) => Buffer.from(JSON.stringify(cmd.includes('cycle-lock') ? lock : status)),
    dispatchTracker: trackers.dispatchTracker || new Map(),
    progressTracker: trackers.progressTracker || new Map(),
  });
  return dispatched;
}

test('countPendingPipelineUrls counts only `- [ ]` rows', () => {
  assert.equal(countPendingPipelineUrls(makeWorkspace(7)), 7);
  assert.equal(countPendingPipelineUrls(makeWorkspace(0)), 0);
});

test('countPendingPipelineUrls returns 0 for a missing file rather than throwing', () => {
  // Fail closed: no provable backlog means no resume.
  assert.equal(countPendingPipelineUrls(mkdtempSync(join(tmpdir(), 'cycle-empty-'))), 0);
});

test('THE INCIDENT: a checkpoint with every field name wrong still resumes', () => {
  const dispatched = run({ cwd: makeWorkspace(563), status: THOMAS_STATUS });
  assert.equal(dispatched.length, 1, 'expected exactly one cycle-resume dispatch');
  assert.equal(dispatched[0].kind, 'cycle-resume');
  assert.equal(dispatched[0].chatId, '8271178480');
});

test('a well-formed checkpoint still resumes — no regression on the happy path', () => {
  const status = {
    ...THOMAS_STATUS,
    step: { id: '2-pipeline', label: 'Pipeline Processing (Batch 1/17)' },
    counters: { pipelineUrlsPending: 563 },
    lastStopReason: 'batch-limit',
  };
  assert.equal(run({ cwd: makeWorkspace(563), status }).length, 1);
});

test('an empty pipeline.md never resumes, whatever the counters claim', () => {
  // counters said 353 pending; the file is the authority, and it is empty.
  assert.equal(run({ cwd: makeWorkspace(0), status: THOMAS_STATUS }).length, 0);
});

test('a finished run never resumes', () => {
  const status = { ...THOMAS_STATUS, step: { id: 'done', label: 'Cycle complete' } };
  assert.equal(run({ cwd: makeWorkspace(563), status }).length, 0);
});

test('a workspace that has never run a cycle never resumes', () => {
  // cycle-status.mjs --json emits only a liveness block when no file exists —
  // no runId. Without this guard, any workspace whose scan left pending URLs
  // would get an unrequested cycle dispatched at it.
  const status = { liveness: { state: 'no_run', staleMs: null, lastUpdateAgo: null } };
  assert.equal(run({ cwd: makeWorkspace(563), status }).length, 0);
});

test('a live run holding a fresh lock is left alone', () => {
  const dispatched = run({ cwd: makeWorkspace(563), status: THOMAS_STATUS, lock: { held: true, stale: false } });
  assert.equal(dispatched.length, 0);
});

test('a stale lock is treated as abandoned and resumes', () => {
  const dispatched = run({ cwd: makeWorkspace(563), status: THOMAS_STATUS, lock: { held: true, stale: true } });
  assert.equal(dispatched.length, 1);
});

test('a session-limit cutoff waits for resumeNotBefore, then resumes', () => {
  const cwd = makeWorkspace(563);
  const notYet = { ...THOMAS_STATUS, lastStopReason: 'session-limit', resumeNotBefore: '2026-09-15T18:00:00.000Z' };
  assert.equal(run({ cwd, status: notYet }).length, 0, 'must not resume before the reset time');
  const passed = { ...notYet, resumeNotBefore: '2026-09-15T14:00:00.000Z' };
  assert.equal(run({ cwd, status: passed }).length, 1, 'must resume once the reset time has passed');
});

test('no-progress guard: a resume that does not shrink the backlog stops re-dispatching', () => {
  const cwd = makeWorkspace(563);
  const trackers = { progressTracker: new Map(), dispatchTracker: new Map() };
  // First poll dispatches and records the backlog it dispatched against.
  assert.equal(run({ cwd, status: THOMAS_STATUS, trackers }).length, 1);
  // Second poll (debounce cleared, e.g. >10min later): the batch achieved
  // nothing, so re-dispatching would burn `claude -p` calls forever.
  trackers.dispatchTracker.clear();
  assert.equal(run({ cwd, status: THOMAS_STATUS, trackers }).length, 0);
  // A batch that DID make progress is dispatched again.
  trackers.dispatchTracker.clear();
  assert.equal(run({ cwd: makeWorkspace(543), status: THOMAS_STATUS, trackers }).length, 1);
});

test('no-progress guard resets when a fresh /run mints a new runId', () => {
  const cwd = makeWorkspace(563);
  const trackers = { progressTracker: new Map(), dispatchTracker: new Map() };
  assert.equal(run({ cwd, status: THOMAS_STATUS, trackers }).length, 1);
  trackers.dispatchTracker.clear();
  assert.equal(run({ cwd, status: THOMAS_STATUS, trackers }).length, 0);
  trackers.dispatchTracker.clear();
  const freshRun = { ...THOMAS_STATUS, runId: '2026-09-15T16:00:00.000Z' };
  assert.equal(run({ cwd, status: freshRun, trackers }).length, 1, 'a new run clears the block');
});

test('the debounce still suppresses a second dispatch within the window', () => {
  const cwd = makeWorkspace(563);
  const trackers = { progressTracker: new Map(), dispatchTracker: new Map() };
  assert.equal(run({ cwd, status: THOMAS_STATUS, trackers }).length, 1);
  assert.equal(run({ cwd, status: THOMAS_STATUS, trackers }).length, 0);
});
