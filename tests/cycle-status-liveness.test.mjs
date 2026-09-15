// Regression tests for cycle-status.mjs's liveness verdict (#found-live-2026-08-27).
//
// The bug this guards: `render()` had a stall check, but `--json` emitted the
// raw stored record with no liveness field. modes/telegram.md Step 3f reads the
// JSON path and inferred "actively running" from `step.id !== 'done'`, so a
// /status query reported a cycle as running for ~7 hours after the process had
// died mid-`pass_b`. Both paths now answer from computeLiveness().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLiveness, STALL_AFTER_MS } from '../core/cycle-status.mjs';

const NOW = Date.parse('2026-08-27T23:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('a mid-run record that stopped checkpointing past the threshold reports stalled', () => {
  // The exact shape of today's incident: died during pass_b, never updated again.
  const state = { step: { id: 'pass_b', label: 'Full ATS sweep' }, savedAt: ago(7 * 60 * 60_000) };
  const liveness = computeLiveness(state, NOW);
  assert.equal(liveness.state, 'stalled');
  assert.equal(liveness.staleMs, 7 * 60 * 60_000);
  assert.match(liveness.lastUpdateAgo, /^7h 0m ago$/);
});

test('a mid-run record checkpointing recently reports running', () => {
  const state = { step: { id: 'pass_b', label: 'Full ATS sweep' }, savedAt: ago(60_000) };
  assert.equal(computeLiveness(state, NOW).state, 'running');
});

test('a completed run never reports stalled, however old it is', () => {
  // `done` is a terminal state — an ancient finished run is not a dead one, and
  // reporting it as stalled would send the candidate chasing a phantom failure.
  const state = { step: { id: 'done', label: 'Cycle complete' }, savedAt: ago(300 * 60 * 60_000) };
  assert.equal(computeLiveness(state, NOW).state, 'done');
});

test('the threshold boundary is exclusive — exactly at the limit is still running', () => {
  const atLimit = { step: { id: 'pass_b' }, savedAt: ago(STALL_AFTER_MS) };
  assert.equal(computeLiveness(atLimit, NOW).state, 'running');
  const pastLimit = { step: { id: 'pass_b' }, savedAt: ago(STALL_AFTER_MS + 1) };
  assert.equal(computeLiveness(pastLimit, NOW).state, 'stalled');
});

test('stalling is reported only after the lock is already reclaimable', () => {
  // cycle-lock.mjs treats a lock unrefreshed for 30 min as abandoned. The stall
  // threshold must stay LONGER than that, so "send /run to resume" is always
  // true when we say it — never advice that bounces off a still-held lock.
  const CYCLE_LOCK_STALE_MS = 30 * 60_000;
  assert.ok(
    STALL_AFTER_MS > CYCLE_LOCK_STALE_MS,
    `STALL_AFTER_MS (${STALL_AFTER_MS}) must exceed cycle-lock's stale window (${CYCLE_LOCK_STALE_MS})`
  );
});

test('a missing or unparseable record reports no_run rather than guessing', () => {
  assert.equal(computeLiveness(null, NOW).state, 'no_run');
  assert.equal(computeLiveness({}, NOW).state, 'no_run');
  assert.equal(computeLiveness({ step: { id: 'pass_b' }, savedAt: 'not-a-date' }, NOW).state, 'no_run');
});

// --- 'paused' (added 2026-09-15) -------------------------------------------
// Thomas Acosta's /status sequence: /run, then /status 14 minutes later saying
// "running" about an already-exited process, then /status again past the
// 40-minute window saying "stalled" — two contradictory answers with nothing
// changed between them but the clock. A clean batch-limit stop writes a fresh
// savedAt as its last act, so staleness alone can never see it.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a clean batch-limit stop reports paused, not running', () => {
  const state = { step: { id: '2-pipeline' }, savedAt: ago(14 * 60_000), lastStopReason: 'batch-limit' };
  assert.equal(computeLiveness(state, NOW).state, 'paused');
});

test('a session-limit cutoff also reports paused', () => {
  const state = { step: { id: '2-pipeline' }, savedAt: ago(60_000), lastStopReason: 'session-limit' };
  assert.equal(computeLiveness(state, NOW).state, 'paused');
});

test('a genuinely working run with no stop reason still reports running', () => {
  const state = { step: { id: '2-pipeline' }, savedAt: ago(60_000), lastStopReason: null };
  assert.equal(computeLiveness(state, NOW).state, 'running');
});

test('staleness still wins over a stop reason — a paused run left unresumed is stuck', () => {
  // With auto-resume working, a batch boundary is picked up within ~25s. Still
  // sitting there 3 hours later means the resume never happened: that is
  // stalled, and must not be reported as a healthy "queued to continue".
  const state = { step: { id: '2-pipeline' }, savedAt: ago(3 * 60 * 60_000), lastStopReason: 'batch-limit' };
  assert.equal(computeLiveness(state, NOW).state, 'stalled');
});

test('a completed run reports done even carrying a stop reason', () => {
  const state = { step: { id: 'done' }, savedAt: ago(60_000), lastStopReason: 'batch-limit' };
  assert.equal(computeLiveness(state, NOW).state, 'done');
});

test('THE STICKY BUG: a progress checkpoint clears a previous stop reason', async () => {
  // Before this fix update() spread the old state, so the batch-limit written
  // when batch 1 ended survived every later checkpoint — leaving a run that
  // was actively working batch 9 permanently labeled "paused".
  const statusPath = join(mkdtempSync(join(tmpdir(), 'cycle-sticky-')), 'cycle-status.json');
  process.env.CAREER_OPS_CYCLE_STATUS = statusPath;
  const mod = await import('../core/cycle-status.mjs?stickyStopReasonTest');

  await mod.update({ step: { id: '2-pipeline', label: 'Batch 1' }, lastStopReason: 'batch-limit' });
  assert.equal(mod.computeLiveness(JSON.parse(readFileSync(statusPath, 'utf8'))).state, 'paused');

  // The resumed batch checkpoints progress without mentioning lastStopReason.
  await mod.update({ step: { id: '2-pipeline', label: 'Batch 2' }, counters: { pipelineUrlsProcessed: 40 } });
  const after = JSON.parse(readFileSync(statusPath, 'utf8'));
  assert.equal(after.lastStopReason, null, 'a progress checkpoint must clear the stop reason');
  assert.equal(mod.computeLiveness(after).state, 'running');

  // An explicit stop reason in the patch is still honored.
  await mod.update({ step: { id: '2-pipeline', label: 'Batch 2' }, lastStopReason: 'batch-limit' });
  assert.equal(mod.computeLiveness(JSON.parse(readFileSync(statusPath, 'utf8'))).state, 'paused');

  // A patch with no step at all (counters-only) must not clear it either way.
  await mod.update({ counters: { reportsWritten: 1 } });
  assert.equal(JSON.parse(readFileSync(statusPath, 'utf8')).lastStopReason, 'batch-limit');
});
