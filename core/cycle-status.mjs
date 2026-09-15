#!/usr/bin/env node
// @ts-check
/**
 * cycle-status.mjs — real-time "where is this cycle run right now" file.
 *
 * A `/career-ops cycle` run can span hours with no way to check progress
 * except reading agent chatter or waiting on a Discord tick. This gives the
 * run a persisted, checkable-anytime status: current step, key counters,
 * timestamps — written to data/cache/cycle-status.json at the same
 * checkpoint moments modes/cycle.md already uses for Discord ticks.
 *
 * Unlike discord-ticker.mjs, this is purely observational: `update()` must
 * never throw and never blocks the run. A lock timeout or write failure is
 * logged to data/cycle-status.log and swallowed — losing one status update
 * is never a reason to fail the underlying pipeline work.
 *
 * Usage:
 *   node cycle-status.mjs reset                        # new run, zeroed counters
 *   node cycle-status.mjs update --file <patch.json>    # merge a JSON patch
 *   node cycle-status.mjs                                # human-readable render
 *   node cycle-status.mjs --json                         # raw file contents
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { acquireTrackerLock, writeFileAtomic } from './tracker-utils.mjs';
import { workspaceRoot } from './workspace-root.mjs';
import { isMainModule } from './is-main.mjs';

// Overridable for test isolation (same convention as discord-ticker.mjs /
// CAREER_OPS_REPORTS_DIR elsewhere in this repo). Falls back to the current
// workspace root (see #workspace-multitenancy Task 5/8), not this script's
// own directory — each user's cycle run must land in their own workspace.
export const STATUS_PATH = process.env.CAREER_OPS_CYCLE_STATUS
  || join(workspaceRoot(), 'data', 'cache', 'cycle-status.json');
export const LOCK_DIR = `${STATUS_PATH}.lock`;
export const LOG_PATH = process.env.CAREER_OPS_CYCLE_STATUS_LOG
  || join(workspaceRoot(), 'data', 'cycle-status.log');

const LOCK_TIMEOUT_MS = process.env.CAREER_OPS_CYCLE_STATUS_LOCK_TIMEOUT_MS
  ? Number(process.env.CAREER_OPS_CYCLE_STATUS_LOCK_TIMEOUT_MS)
  : 5_000;

// The 11 step ids from modes/cycle.md's own numbering, in order.
export const STEP_IDS = [
  '0-preflight', '1a-scan-tracked', '1b-scan-ats-full', '2-pipeline',
  '3-pdf-safety-net', '3.5-tracker-merge', '3.6-integrity', '4-summary',
  '5-deliver', 'done',
];

const EMPTY_COUNTERS = {
  scanTrackedFound: 0, scanTrackedNew: 0,
  scanAtsFullCompaniesSwept: 0, scanAtsFullCompaniesTotal: 0, scanAtsFullMatches: 0,
  pipelineUrlsPending: 0, pipelineUrlsProcessed: 0,
  pipelineWavesDone: 0, pipelineWavesTotal: 0,
  reportsWritten: 0, pdfsInline: 0, pdfsSafetyNet: 0,
};

function logLine(line) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()}\t${line}\n`);
  } catch {
    // Logging the failure is best-effort too — never let it throw further.
  }
}

function emptyState() {
  return {
    version: 1,
    runId: new Date().toISOString(),
    savedAt: new Date().toISOString(),
    step: { id: '0-preflight', label: 'Pre-flight', startedAt: new Date().toISOString() },
    counters: { ...EMPTY_COUNTERS },
    lastError: null,
    // Set by modes/cycle.md Step 2 on a clean batch-limit stop, or by
    // telegram-monitor.mjs's dispatchOne on a session-limit cutoff (see
    // docs/superpowers/specs/2026-09-10-cycle-checkpoint-resume-design.md).
    // Always null on a fresh run — reset() rebuilds this object from scratch.
    lastStopReason: null,
    resumeNotBefore: null,
  };
}

function loadState() {
  if (!existsSync(STATUS_PATH)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return emptyState();
    return {
      ...emptyState(),
      ...parsed,
      counters: { ...EMPTY_COUNTERS, ...(parsed.counters || {}) },
    };
  } catch {
    return emptyState();
  }
}

function saveState(state) {
  mkdirSync(dirname(STATUS_PATH), { recursive: true });
  writeFileAtomic(STATUS_PATH, JSON.stringify(state, null, 2));
}

/**
 * Deep-merge a patch into the current state: `step` replaces wholesale (a
 * checkpoint always knows its own full step object), `counters` merges
 * key-by-key (a checkpoint usually only knows a few counters), everything
 * else (lastError, etc.) replaces wholesale.
 *
 * @param {object} patch - Partial state, as written to the scratch file
 *   passed via `update --file`.
 * @param {{ lockTimeoutMs?: number }} [opts]
 * @returns {Promise<object>} The merged state that was (attempted to be) saved.
 */
export async function update(patch, opts = {}) {
  const timeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  try {
    const lock = await acquireTrackerLock(LOCK_DIR, { timeoutMs });
    try {
      const state = loadState();
      const merged = {
        ...state,
        ...patch,
        savedAt: new Date().toISOString(),
        counters: { ...state.counters, ...(patch.counters || {}) },
      };
      if (patch.step) merged.step = patch.step;
      // A progress checkpoint implicitly clears any previous stop reason: a
      // run cannot be both stopped and advancing. Without this, the spread
      // above makes lastStopReason sticky forever — the batch-limit written
      // when batch 1 ended would still be there mid-batch-9, so nothing
      // downstream could tell "paused at a boundary" from "working".
      if (patch.step && !('lastStopReason' in patch)) {
        merged.lastStopReason = null;
        merged.resumeNotBefore = null;
      }
      saveState(merged);
      return merged;
    } finally {
      lock.release();
    }
  } catch (err) {
    // Purely observational — never let a status-file problem affect the run.
    logLine(`update failed (swallowed, run continues): ${err.message}`);
    return null;
  }
}

/** Start a fresh run: new runId, zeroed counters. Never throws. */
export async function reset() {
  try {
    const lock = await acquireTrackerLock(LOCK_DIR, { timeoutMs: LOCK_TIMEOUT_MS });
    try {
      saveState(emptyState());
    } finally {
      lock.release();
    }
  } catch (err) {
    logLine(`reset failed (swallowed): ${err.message}`);
  }
}

function formatDuration(ms) {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

// A run that hasn't checkpointed in this long is treated as dead, not slow.
// Deliberately LONGER than cycle-lock.mjs's own 30-minute STALE_MS, so by the
// time anything reports "stalled" the lock is already reclaimable — i.e. the
// advice "send /run to resume" is always actually true when we give it.
// Progress checkpoints fire far more often than this during a healthy run.
export const STALL_AFTER_MS = 40 * 60_000;

/**
 * Liveness verdict for a status record — the single source of truth shared by
 * `render()` and `--json`.
 *
 * Added 2026-08-27: `render()` had carried this stall check since it was
 * written, but `--json` emitted the raw file with no liveness field at all.
 * `modes/telegram.md` Step 3f reads the JSON path and so told the candidate a
 * cycle was "actively running" for seven hours after the process had died —
 * faithfully, because `step.id` was still `pass_b`. Both paths now answer from
 * this one function so they can never disagree again.
 *
 * 'paused' added 2026-09-15: a clean batch-limit stop writes a FRESH savedAt
 * as its last act before exiting, so a dead-but-recent run read as 'running'
 * for up to 40 minutes. Thomas Acosta hit exactly this — `/run`, then
 * `/status` 14 minutes later reporting "running" about a process that had
 * already exited, then `/status` again past the window reporting "stalled",
 * with nothing having changed in between but the clock. lastStopReason
 * answers it directly and without a timer, now that update() stops carrying
 * a stale one forward.
 *
 * @param {{step?: {id?: string}, savedAt?: string, lastStopReason?: string|null}} state
 * @param {number} [now] - injectable clock for tests.
 * @returns {{state: 'no_run'|'running'|'paused'|'stalled'|'done', staleMs: number|null, lastUpdateAgo: string|null}}
 */
export function computeLiveness(state, now = Date.now()) {
  if (!state || !state.savedAt) return { state: 'no_run', staleMs: null, lastUpdateAgo: null };
  const savedMs = new Date(state.savedAt).getTime();
  if (!Number.isFinite(savedMs)) return { state: 'no_run', staleMs: null, lastUpdateAgo: null };
  const staleMs = now - savedMs;
  const lastUpdateAgo = formatDuration(staleMs);
  if (state.step?.id === 'done') return { state: 'done', staleMs, lastUpdateAgo };
  // Staleness still wins: a run that stopped cleanly and then sat unresumed
  // past the stall window is stuck, whatever its stop reason says.
  if (staleMs > STALL_AFTER_MS) return { state: 'stalled', staleMs, lastUpdateAgo };
  if (state.lastStopReason === 'batch-limit' || state.lastStopReason === 'session-limit') {
    return { state: 'paused', staleMs, lastUpdateAgo };
  }
  return { state: 'running', staleMs, lastUpdateAgo };
}

/** Human-readable render of the current status (or "no run" if the file is absent). */
export function render() {
  if (!existsSync(STATUS_PATH)) return 'No cycle run has recorded status yet.';
  const state = loadState();
  const staleMs = Date.now() - new Date(state.savedAt).getTime();
  const liveness = computeLiveness(state);
  const note = liveness.state === 'stalled' ? '  ⚠️  stalled? no update in 40m+'
    : liveness.state === 'paused' ? `  ⏸  paused (${state.lastStopReason}) — auto-resume queued`
    : '';
  const lines = [
    `cycle run ${state.runId}`,
    `step: ${state.step.label || state.step.id} (updated ${formatDuration(staleMs)})${note}`,
    '',
    'counters:',
    ...Object.entries(state.counters).map(([k, v]) => `  ${k}: ${v}`),
  ];
  if (state.lastError) {
    lines.push('', `last error (${state.lastError.step || '?'} @ ${state.lastError.at || '?'}): ${state.lastError.message}`);
  }
  return lines.join('\n');
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'reset') {
    await reset();
    console.log('cycle-status: reset — next update starts a fresh run.');
  } else if (cmd === 'update') {
    const idx = rest.indexOf('--file');
    if (idx === -1 || !rest[idx + 1]) {
      console.error('Usage: node cycle-status.mjs update --file <patch.json>');
      process.exit(1);
    }
    const patchFile = resolve(rest[idx + 1]);
    if (!existsSync(patchFile)) {
      console.error(`--file not found: ${patchFile}`);
      process.exit(1);
    }
    let patch;
    try {
      patch = JSON.parse(readFileSync(patchFile, 'utf8'));
    } catch (e) {
      console.error(`--file is not valid JSON: ${e.message}`);
      process.exit(1);
    }
    // Validate on the CLI path only — update() itself stays non-throwing by
    // contract (see this file's header). A checkpoint is written by an LLM
    // following prose in modes/cycle.md, so an invented step.id or a
    // lastStopReason buried in `counters` is a real, observed failure mode
    // (2026-09-15, thomas-acosta: "step2-batch1" + counters.lastStopReason).
    // Rejecting here tells the agent the legal values in the same turn.
    const errs = [];
    if (patch?.step && !STEP_IDS.includes(patch.step.id)) {
      errs.push(`step.id "${patch.step.id}" is not a known step — use one of: ${STEP_IDS.join(', ')}`);
    }
    if (patch?.counters && 'lastStopReason' in patch.counters) {
      errs.push('lastStopReason belongs at the TOP LEVEL of the patch, not inside counters');
    }
    for (const key of Object.keys(patch?.counters || {})) {
      if (!(key in EMPTY_COUNTERS)) {
        errs.push(`unknown counter "${key}" — use one of: ${Object.keys(EMPTY_COUNTERS).join(', ')}`);
      }
    }
    if (errs.length) {
      console.error(`❌ cycle-status: invalid patch, nothing written.\n  - ${errs.join('\n  - ')}`);
      process.exit(1);
    }
    await update(patch);
    console.log('cycle-status: updated.');
  } else if (!cmd || cmd === '--json') {
    if (cmd === '--json') {
      // Emit the stored record PLUS a computed `liveness` block. Consumers
      // (modes/telegram.md Step 3f) must branch on liveness.state, never infer
      // "running" from step.id alone — a dead run's step.id stays frozen at
      // whatever it was when the process died (found live 2026-08-27).
      if (!existsSync(STATUS_PATH)) {
        console.log(JSON.stringify({ liveness: computeLiveness(null) }, null, 2));
      } else {
        const state = loadState();
        console.log(JSON.stringify({ ...state, liveness: computeLiveness(state) }, null, 2));
      }
    } else {
      console.log(render());
    }
  } else {
    console.error('Usage: node cycle-status.mjs [reset|update --file <patch.json>|--json]');
    process.exit(1);
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main().catch((err) => {
    // Even the CLI wrapper never throws for a status problem — but a truly
    // unexpected error (e.g. a bug in this script) still surfaces loudly.
    console.error(`❌ cycle-status: ${err.message}`);
    process.exit(1);
  });
}
