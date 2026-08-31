// Regression coverage for core/telegram-monitor.mjs's spawnCapturingTail().
//
// Found live 2026-08-30: a candidate's routing-failure notification said
// only "claude -p routing exited 1" — the real cause (a Claude session
// usage limit, with a stated reset time) streamed past on stdout/stderr via
// stdio:'inherit' with nothing capturing it, so the error message thrown by
// invokeClaudeRoutingOnce carried no useful information for the candidate.
// spawnCapturingTail replaces the 'inherit' pipe with one that both echoes
// output live (so the daemon's own console/log still sees everything) and
// captures a tail of it for the thrown error on a non-zero exit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnCapturingTail } from '../core/telegram-monitor.mjs';

// Runs the current node binary with -e so these tests need no fixture files
// and work identically on any platform this suite runs on.
const NODE = process.execPath;

test('spawnCapturingTail resolves on a clean exit', async () => {
  await assert.doesNotReject(() => spawnCapturingTail(NODE, ['-e', 'process.exitCode=0']));
});

test('spawnCapturingTail includes a real stderr snippet in the rejection on non-zero exit', async () => {
  await assert.rejects(
    () => spawnCapturingTail(NODE, ['-e', 'console.error("You have hit your session limit, resets 3:40pm"); process.exitCode=1;'], { exitErrorPrefix: 'claude -p routing exited' }),
    (err) => {
      assert.match(err.message, /^claude -p routing exited 1: /);
      assert.match(err.message, /session limit/);
      return true;
    },
  );
});

test('spawnCapturingTail includes a real stdout snippet in the rejection on non-zero exit', async () => {
  await assert.rejects(
    () => spawnCapturingTail(NODE, ['-e', 'console.log("plain stdout reason"); process.exitCode=2;']),
    (err) => {
      assert.match(err.message, /^process exited 2: /);
      assert.match(err.message, /plain stdout reason/);
      return true;
    },
  );
});

test('spawnCapturingTail falls back to a bare exit-code message when the process produced no output', async () => {
  await assert.rejects(
    () => spawnCapturingTail(NODE, ['-e', 'process.exitCode=3;']),
    (err) => {
      assert.equal(err.message, 'process exited 3');
      return true;
    },
  );
});

test('spawnCapturingTail caps the captured tail at a few hundred characters, not the full output', async () => {
  await assert.rejects(
    () => spawnCapturingTail(NODE, ['-e', 'console.error("x".repeat(5000)); process.exitCode=1;']),
    (err) => {
      // "process exited 1: " prefix + at most a few hundred captured chars —
      // nowhere near the full 5000-char output, so a candidate-facing
      // notification never turns into a multi-KB dump.
      assert.ok(err.message.length < 500, `expected a capped message, got ${err.message.length} chars`);
      return true;
    },
  );
});

test('spawnCapturingTail marks a spawn-level failure (bad command) with spawnFailed', async () => {
  await assert.rejects(
    () => spawnCapturingTail('this-command-does-not-exist-xyz', []),
    (err) => {
      assert.equal(err.spawnFailed, true);
      return true;
    },
  );
});

test('spawnCapturingTail rejects with timedOut and a custom message when the process exceeds timeoutMs', async () => {
  await assert.rejects(
    () => spawnCapturingTail(NODE, ['-e', 'setTimeout(() => {}, 5000)'], {
      timeoutMs: 50,
      timeoutErrorMessage: (ms) => `claude -p timed out after ${ms}ms`,
    }),
    (err) => {
      assert.equal(err.timedOut, true);
      assert.equal(err.message, 'claude -p timed out after 50ms');
      return true;
    },
  );
});

test('spawnCapturingTail still echoes output live to this process\'s own stdout/stderr', async () => {
  const originalWrite = process.stdout.write;
  let echoed = '';
  process.stdout.write = (chunk, ...rest) => {
    echoed += chunk.toString();
    return originalWrite.call(process.stdout, chunk, ...rest);
  };
  try {
    await spawnCapturingTail(NODE, ['-e', 'console.log("echoed-marker-12345")']);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(echoed, /echoed-marker-12345/);
});
