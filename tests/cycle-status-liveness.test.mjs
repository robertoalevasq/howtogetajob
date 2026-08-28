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
