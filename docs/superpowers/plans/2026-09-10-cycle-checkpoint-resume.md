# Cycle-Mode Checkpointed Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap how large a single `cycle` mode Step 2 (pipeline evaluation) session can grow to, so no run can single-handedly exhaust the account's Claude Pro rolling session-limit quota the way two real 2026-09-09 runs did (Ernesto 42.0M raw tokens, Thomas 40.1M — both cut off mid-scan by `"You've hit your session limit"`).

**Architecture:** Step 2 stops cleanly after 20 URLs (a batch), releases the cycle lock, and ends its turn instead of running the whole backlog inline. `telegram-monitor.mjs`'s daemon gains a per-poll-iteration check across every bound workspace: is a `cycle` run stalled (lock free, status file not updated recently) with pending URLs left? If so, dispatch a continuation automatically — no human re-sends `/run`. A session-limit cutoff (as opposed to a clean batch stop) is detected separately, from the non-zero exit `dispatchOne` already catches today, and gates the resume until the account's own reported reset time has passed.

**Tech Stack:** Node.js (`.mjs`, no framework), this repo's own `test-all.mjs` test harness (custom `pass()`/`fail()` assertions, not Jest/Mocha), `Intl.DateTimeFormat` for timezone math (stdlib only, no new dependency).

**Spec:** `docs/superpowers/specs/2026-09-10-cycle-checkpoint-resume-design.md` (read the "Correction made during plan-writing" section first — it supersedes the original Architecture/Component sections below it in that same document).

## Global Constraints

- Three files touched, no others: `modes/cycle.md`, `core/cycle-status.mjs`, `core/telegram-monitor.mjs`.
- No new files, no new npm dependencies.
- `cycle-lock.mjs` and `cycle-status.mjs` gain **zero new exports** — used only through their existing CLI interfaces (`node <script> <command>`), invoked as subprocesses with `cwd` set to the target workspace directory.
- Every new function that isn't trivially pure must accept its side-effecting dependency (subprocess exec, clock, `buildBoundChatMap`) as an overridable parameter with a real default — matches this file's own existing convention (`dispatchOne(dispatch, invoke = invokeClaudeRoutingOnce, ...)`), and is what makes each piece testable without touching real files or spawning real processes.
- Every new function that could throw for an environmental reason (a missing status file, a malformed JSON patch, a subprocess failing) must swallow that error and log it, never let it propagate into `daemonLoop()`'s main loop or block real Telegram message handling — same defensive convention `cycle-status.mjs`'s own `update()` already documents.
- Run `node core/test-all.mjs` after every task and confirm `0 failed` before moving to the next task.

---

### Task 1: `cycle-status.mjs` schema — add `lastStopReason`/`resumeNotBefore`

**Files:**
- Modify: `core/cycle-status.mjs:69-78` (the `emptyState()` function)
- Test: `core/test-all.mjs` (new block, styled on existing `cycle-status.mjs` coverage in that file)

**Interfaces:**
- Produces: every state object returned by `loadState()`/`emptyState()`/`update()`/`reset()` now always has `lastStopReason: null | 'batch-limit' | 'session-limit'` and `resumeNotBefore: null | string` (an ISO timestamp) — consumed by Task 5's `checkForStalledCycle`.

- [ ] **Step 1: Modify `emptyState()`**

In `core/cycle-status.mjs`, change:

```javascript
function emptyState() {
  return {
    version: 1,
    runId: new Date().toISOString(),
    savedAt: new Date().toISOString(),
    step: { id: '0-preflight', label: 'Pre-flight', startedAt: new Date().toISOString() },
    counters: { ...EMPTY_COUNTERS },
    lastError: null,
  };
}
```

to:

```javascript
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
```

- [ ] **Step 2: Add a test for the new default fields and that `update()` can set them**

In `core/test-all.mjs`, find the section that already tests `cycle-status.mjs` (search for `cycle-status.mjs` — if none exists yet, add this block right after the `application-answers` test block added in a prior change, using the same `try { const { ... } = await import(pathToFileURL(join(ROOT, 'core', 'cycle-status.mjs')).href); ... } catch (e) { fail(...) }` pattern already used elsewhere in this file):

```javascript
try {
  const cycleStatusPath = pathToFileURL(join(ROOT, 'core', 'cycle-status.mjs')).href;
  const { update, reset } = await import(cycleStatusPath);
  const testStatusPath = join(ROOT, '.tmp-test-cycle-status.json');
  const testLogPath = join(ROOT, '.tmp-test-cycle-status.log');
  process.env.CAREER_OPS_CYCLE_STATUS = testStatusPath;
  process.env.CAREER_OPS_CYCLE_STATUS_LOG = testLogPath;
  try {
    await reset();
    const fresh = JSON.parse(readFileSync(testStatusPath, 'utf8'));
    if (fresh.lastStopReason === null && fresh.resumeNotBefore === null) {
      pass('cycle-status reset() defaults lastStopReason/resumeNotBefore to null');
    } else {
      fail(`cycle-status reset() did not default the new fields to null: ${JSON.stringify(fresh)}`);
    }

    const patched = await update({ lastStopReason: 'batch-limit', counters: { pipelineUrlsPending: 5 } });
    if (patched.lastStopReason === 'batch-limit' && patched.counters.pipelineUrlsPending === 5 && patched.resumeNotBefore === null) {
      pass('cycle-status update() sets lastStopReason and preserves resumeNotBefore=null alongside a counters merge');
    } else {
      fail(`cycle-status update() did not merge the new fields correctly: ${JSON.stringify(patched)}`);
    }

    const patchedAgain = await update({ lastStopReason: 'session-limit', resumeNotBefore: '2026-09-10T00:00:00.000Z' });
    if (patchedAgain.lastStopReason === 'session-limit' && patchedAgain.resumeNotBefore === '2026-09-10T00:00:00.000Z') {
      pass('cycle-status update() sets resumeNotBefore alongside lastStopReason');
    } else {
      fail(`cycle-status update() did not set resumeNotBefore: ${JSON.stringify(patchedAgain)}`);
    }
  } finally {
    delete process.env.CAREER_OPS_CYCLE_STATUS;
    delete process.env.CAREER_OPS_CYCLE_STATUS_LOG;
    try { unlinkSync(testStatusPath); } catch {}
    try { unlinkSync(testLogPath); } catch {}
  }
} catch (e) {
  fail(`cycle-status lastStopReason/resumeNotBefore coverage crashed: ${e.message}`);
}
```

`unlinkSync` is already imported from `'fs'` at the top of `core/test-all.mjs` (line 28) — no import changes needed for this test.

- [ ] **Step 3: Run the test**

Run: `node core/test-all.mjs 2>&1 | grep -E "cycle-status|Results:"`
Expected: the three new `pass(...)` lines above, and the final `Results:` line shows the same failure count as before this task (0, if the suite was clean before).

- [ ] **Step 4: Commit**

```bash
git add core/cycle-status.mjs core/test-all.mjs
git commit -m "feat(cycle-status): add lastStopReason/resumeNotBefore to state schema

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `parseSessionLimitReset` — pure timezone-aware reset-time parser

**Files:**
- Modify: `core/telegram-monitor.mjs` (add near the top-level function definitions, e.g. right before `buildRoutingPrompt`)
- Test: `core/test-all.mjs`

**Interfaces:**
- Produces: `export function parseSessionLimitReset(text, now = new Date()) -> Date` — consumed by Task 3's `applySessionLimitStatus`.

- [ ] **Step 1: Add the function**

In `core/telegram-monitor.mjs`, add this above `buildRoutingPrompt` (keep it near the other prompt/parsing helpers):

```javascript
// Converts a wall-clock time in a named IANA zone (e.g. "7:50pm",
// "America/New_York") to the correct UTC instant for a specific calendar
// date, using only Intl (no new dependency). Standard offset-correction
// trick: guess the UTC instant assuming zero offset, ask Intl what that
// guess actually renders as in the target zone, then correct by the
// difference — this re-derives the real offset for THIS specific date, so
// it's correct across a DST transition rather than assuming a fixed offset.
function zonedTimeToUtcMs(year, month, day, hour, minute, tz) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcGuess)).map(p => [p.type, p.value]));
  const hourPart = parts.hour === '24' ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hourPart, Number(parts.minute), Number(parts.second));
  return utcGuess - (asIfUtc - utcGuess);
}

/**
 * Parses the "You've hit your session limit · resets 7:50pm (America/New_York)"
 * message Claude Code's CLI injects when a headless `claude -p` turn gets cut
 * off by the account's rolling usage quota (documented 2026-08-30 in
 * spawnCapturingTail()'s own comment). Returns the next UTC instant at/after
 * `now` matching that wall-clock time in that zone. Falls back to `now + 1
 * hour` if the text doesn't match this exact shape — a changed message
 * format must never turn into an immediate retry loop against a quota that
 * hasn't actually reset yet.
 *
 * @param {string} text
 * @param {Date} [now]
 * @returns {Date}
 */
export function parseSessionLimitReset(text, now = new Date()) {
  const match = /session limit.*?resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/is.exec(String(text || ''));
  if (!match) return new Date(now.getTime() + 60 * 60 * 1000);
  const [, hourStr, minStr, ampm, tz] = match;
  let hour = Number(hourStr) % 12;
  if (ampm.toLowerCase() === 'pm') hour += 12;
  const minute = Number(minStr);

  const dateParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).map(p => [p.type, p.value])
  );
  let candidateMs = zonedTimeToUtcMs(Number(dateParts.year), Number(dateParts.month), Number(dateParts.day), hour, minute, tz);
  if (candidateMs <= now.getTime()) {
    // Already passed today in that zone — the next occurrence is tomorrow's
    // date IN THAT ZONE (re-derive the offset for that date too, rather than
    // just adding 24h, since a DST transition can make that wrong).
    const tomorrow = new Date(candidateMs + 24 * 60 * 60 * 1000);
    const tomorrowParts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(tomorrow).map(p => [p.type, p.value])
    );
    candidateMs = zonedTimeToUtcMs(Number(tomorrowParts.year), Number(tomorrowParts.month), Number(tomorrowParts.day), hour, minute, tz);
  }
  return new Date(candidateMs);
}
```

- [ ] **Step 2: Write the failing test**

Add to `core/test-all.mjs` (a new `try` block, or extend the one from Task 1 if it's still open — either is fine):

```javascript
try {
  const { parseSessionLimitReset } = await import(pathToFileURL(join(ROOT, 'core', 'telegram-monitor.mjs')).href);

  const sameDayText = "You've hit your session limit · resets 7:50pm (America/New_York)";
  const sameDayResult = parseSessionLimitReset(sameDayText, new Date('2026-09-08T23:31:37.580Z'));
  if (sameDayResult.toISOString() === '2026-09-08T23:50:00.000Z') {
    pass('parseSessionLimitReset resolves a same-day reset time correctly (real observed case)');
  } else {
    fail(`parseSessionLimitReset same-day case wrong: got ${sameDayResult.toISOString()}, expected 2026-09-08T23:50:00.000Z`);
  }

  const rollsToTomorrow = parseSessionLimitReset("You've hit your session limit · resets 3:00am (America/New_York)", new Date('2026-09-08T23:31:37.580Z'));
  if (rollsToTomorrow.toISOString() === '2026-09-09T07:00:00.000Z') {
    pass('parseSessionLimitReset rolls to the next day when the target time already passed today');
  } else {
    fail(`parseSessionLimitReset roll-to-tomorrow case wrong: got ${rollsToTomorrow.toISOString()}, expected 2026-09-09T07:00:00.000Z`);
  }

  const postDstTransition = parseSessionLimitReset("You've hit your session limit · resets 9:00pm (America/New_York)", new Date('2026-11-01T20:00:00.000Z'));
  if (postDstTransition.toISOString() === '2026-11-02T02:00:00.000Z') {
    pass('parseSessionLimitReset uses the correct post-DST-transition UTC offset (EST, not stale EDT)');
  } else {
    fail(`parseSessionLimitReset DST case wrong: got ${postDstTransition.toISOString()}, expected 2026-11-02T02:00:00.000Z (would be 2026-11-02T01:00:00.000Z with a stale fixed EDT offset — that wrong value means the DST bug is back)`);
  }

  const unparseable = parseSessionLimitReset('some unrelated crash text', new Date('2026-01-01T00:00:00.000Z'));
  if (unparseable.toISOString() === '2026-01-01T01:00:00.000Z') {
    pass('parseSessionLimitReset falls back to now+1h on unparseable text');
  } else {
    fail(`parseSessionLimitReset fallback case wrong: got ${unparseable.toISOString()}, expected 2026-01-01T01:00:00.000Z`);
  }
} catch (e) {
  fail(`parseSessionLimitReset coverage crashed: ${e.message}`);
}
```

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `node core/test-all.mjs 2>&1 | grep -E "parseSessionLimitReset|Results:"`
Before Step 1's function exists: FAIL (`parseSessionLimitReset coverage crashed`, since the import destructure would be `undefined`).
After Step 1: all four `pass(...)` lines, `Results:` shows 0 failed.

- [ ] **Step 4: Commit**

```bash
git add core/telegram-monitor.mjs core/test-all.mjs
git commit -m "feat(telegram-monitor): add parseSessionLimitReset timezone-aware parser

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `applySessionLimitStatus` — detect and record a session-limit cutoff

**Files:**
- Modify: `core/telegram-monitor.mjs` (add the function; wire it into `dispatchOne`'s existing `catch` block)
- Test: `core/test-all.mjs`

**Interfaces:**
- Consumes: `parseSessionLimitReset(text, now)` from Task 2.
- Produces: `export function applySessionLimitStatus(errMessage, cwd, opts = {}) -> boolean` (`opts.exec`, `opts.now`, `opts.tmpPath` all overridable for tests) — called from `dispatchOne`'s catch block; also usable standalone by Task 5's tests.

- [ ] **Step 1: Add the imports this function needs**

At the top of `core/telegram-monitor.mjs`, find this existing import line:

```javascript
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
```

Change it to:

```javascript
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
```

Find:

```javascript
import { resolve, dirname, join, basename } from 'path';
```

Leave unchanged (`join` is already imported). Add a new import line right after it:

```javascript
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
```

- [ ] **Step 2: Add `CYCLE_STATUS_MJS`/`CYCLE_LOCK_MJS` absolute path constants**

Right after the existing `const REPO_ROOT = dirname(ROOT);` line, add:

```javascript
// Absolute paths, not bare filenames — a relative 'cycle-status.mjs' resolved
// against an arbitrary workspace cwd is exactly the class of bug the
// notifyRoutingFailure() pluginsMjs comment above already documents (2026-08-28
// incident: a bare relative script path resolved wrong against dispatch.cwd).
const CYCLE_STATUS_MJS = join(ROOT, 'cycle-status.mjs');
const CYCLE_LOCK_MJS = join(ROOT, 'cycle-lock.mjs');
```

- [ ] **Step 3: Add `applySessionLimitStatus`**

Add this function right after `parseSessionLimitReset` (from Task 2):

```javascript
/**
 * If `errMessage` is a session-limit cutoff message, records it on the
 * target workspace's cycle-status.json (lastStopReason + the parsed reset
 * time) via cycle-status.mjs's existing `update --file` CLI, invoked with
 * `cwd` so it resolves that workspace's own state file. Never throws —
 * this is purely observational bookkeeping riding along an already-failed
 * dispatch; a bug here must never mask or replace the real error handling
 * dispatchOne already does.
 *
 * @param {string} errMessage
 * @param {string} cwd - the workspace directory the failed dispatch ran in.
 * @param {{exec?: Function, now?: Date, tmpPath?: string}} [opts]
 * @returns {boolean} true if a session-limit cutoff was detected and recorded.
 */
export function applySessionLimitStatus(errMessage, cwd, opts = {}) {
  if (!/session limit/i.test(String(errMessage || ''))) return false;
  try {
    const exec = opts.exec || execSync;
    const resumeNotBefore = parseSessionLimitReset(errMessage, opts.now || new Date()).toISOString();
    const tmpPath = opts.tmpPath || join(tmpdir(), `cycle-status-patch-${randomUUID()}.json`);
    writeFileSync(tmpPath, JSON.stringify({ lastStopReason: 'session-limit', resumeNotBefore }));
    try {
      exec(`node "${CYCLE_STATUS_MJS}" update --file "${tmpPath}"`, { cwd, stdio: 'pipe' });
    } finally {
      try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    }
    return true;
  } catch (err) {
    console.error(`[telegram-monitor] applySessionLimitStatus failed (swallowed): ${err.message}`);
    return false;
  }
}
```

- [ ] **Step 4: Wire it into `dispatchOne`'s existing catch block**

Find (inside `dispatchOne`):

```javascript
  try {
    await invoke(prompt, dispatch.cwd, timeoutMs, model, extraArgs);
  } catch (err) {
    if (err.spawnFailed) {
      console.error(`[telegram-monitor] Spawn failed (${err.message}) — retrying once...`);
      try {
        await invoke(prompt, dispatch.cwd, timeoutMs, model, extraArgs);
        return;
      } catch (retryErr) {
        console.error(`[telegram-monitor] Retry also failed (${retryErr.message}) — sending emergency notification.`);
        notifyRoutingFailure(retryErr.message, dispatch);
        throw retryErr;
      }
    }
    console.error(`[telegram-monitor] Routing failed (${err.message}) — sending emergency notification.`);
    notifyRoutingFailure(err.message, dispatch);
    throw err;
  }
```

Replace with (two one-line additions, right after each existing `notifyRoutingFailure` call):

```javascript
  try {
    await invoke(prompt, dispatch.cwd, timeoutMs, model, extraArgs);
  } catch (err) {
    if (err.spawnFailed) {
      console.error(`[telegram-monitor] Spawn failed (${err.message}) — retrying once...`);
      try {
        await invoke(prompt, dispatch.cwd, timeoutMs, model, extraArgs);
        return;
      } catch (retryErr) {
        console.error(`[telegram-monitor] Retry also failed (${retryErr.message}) — sending emergency notification.`);
        notifyRoutingFailure(retryErr.message, dispatch);
        applySessionLimitStatus(retryErr.message, dispatch.cwd);
        throw retryErr;
      }
    }
    console.error(`[telegram-monitor] Routing failed (${err.message}) — sending emergency notification.`);
    notifyRoutingFailure(err.message, dispatch);
    applySessionLimitStatus(err.message, dispatch.cwd);
    throw err;
  }
```

- [ ] **Step 5: Write the test**

Add to `core/test-all.mjs`:

```javascript
try {
  const { applySessionLimitStatus } = await import(pathToFileURL(join(ROOT, 'core', 'telegram-monitor.mjs')).href);

  const calls = [];
  const fakeExec = (cmd, opts) => { calls.push({ cmd, opts }); return ''; };
  const detected = applySessionLimitStatus(
    "claude -p routing exited 1: You've hit your session limit · resets 7:50pm (America/New_York)",
    '/fake/workspace',
    { exec: fakeExec, now: new Date('2026-09-08T23:31:37.580Z') }
  );
  if (detected && calls.length === 1 && calls[0].opts.cwd === '/fake/workspace' && calls[0].cmd.includes('cycle-status.mjs') && calls[0].cmd.includes('update --file')) {
    pass('applySessionLimitStatus detects a session-limit cutoff and calls cycle-status.mjs update with the right cwd');
  } else {
    fail(`applySessionLimitStatus did not behave as expected: detected=${detected}, calls=${JSON.stringify(calls)}`);
  }

  const notDetectedCalls = [];
  const notDetected = applySessionLimitStatus('some other routing failure entirely', '/fake/workspace', { exec: (cmd, opts) => { notDetectedCalls.push(cmd); return ''; } });
  if (notDetected === false && notDetectedCalls.length === 0) {
    pass('applySessionLimitStatus is a no-op for a non-session-limit error message');
  } else {
    fail(`applySessionLimitStatus should not have fired for an unrelated error: detected=${notDetected}, calls=${JSON.stringify(notDetectedCalls)}`);
  }

  const throwingExec = () => { throw new Error('cycle-status.mjs not found'); };
  let threw = false;
  try {
    applySessionLimitStatus("session limit · resets 7:50pm (America/New_York)", '/fake/workspace', { exec: throwingExec });
  } catch {
    threw = true;
  }
  if (!threw) {
    pass('applySessionLimitStatus swallows an exec failure instead of throwing');
  } else {
    fail('applySessionLimitStatus let an exec failure propagate — this must never break dispatchOne\'s real error handling');
  }
} catch (e) {
  fail(`applySessionLimitStatus coverage crashed: ${e.message}`);
}
```

- [ ] **Step 6: Run the tests**

Run: `node core/test-all.mjs 2>&1 | grep -E "applySessionLimitStatus|Results:"`
Expected: three `pass(...)` lines, `Results:` shows 0 failed.

- [ ] **Step 7: Commit**

```bash
git add core/telegram-monitor.mjs core/test-all.mjs
git commit -m "feat(telegram-monitor): detect session-limit cutoffs in dispatchOne's catch block

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `buildCycleResumePrompt` + `dispatchOne` wiring for `kind: 'cycle-resume'`

**Files:**
- Modify: `core/telegram-monitor.mjs`
- Test: `core/test-all.mjs`

**Interfaces:**
- Consumes: the existing `KNOWN_PATHS_PRIMER` constant.
- Produces: `export function buildCycleResumePrompt(dispatch) -> string`; `dispatchOne` recognizes `dispatch.kind === 'cycle-resume'` — consumed by Task 5's `checkForStalledCycle`, which constructs dispatches of this kind.

- [ ] **Step 1: Add `buildCycleResumePrompt`**

Add this function right after `buildOnboardingPrompt` in `core/telegram-monitor.mjs`:

```javascript
/**
 * Build the `claude -p` prompt for an automatic cycle-run continuation —
 * dispatched by checkForStalledCycle(), never by a real Telegram message.
 * Deliberately NOT routed through buildRoutingPrompt/modes/telegram.md's
 * message classification: a synthetic continuation isn't a candidate's
 * message to classify, it's an instruction to resume exactly one specific
 * mode at exactly one specific step.
 */
export function buildCycleResumePrompt(dispatch) {
  return `[HEADLESS] This is a non-interactive, unattended invocation — no human is present to answer a question this turn, and there is no future turn to come back to: this is a single, one-shot invocation that ends when this response ends. Apply every documented non-interactive/headless default in AGENTS.md and the mode files. Never pause to ask a question and wait for a reply. Never background a step and defer finishing it to "later" — if you start something that isn't done yet, wait for it synchronously, right now, before ending your response.

${KNOWN_PATHS_PRIMER}

A previous \`cycle\` run's Step 2 (pipeline evaluation) stopped after reaching its per-invocation batch limit, or after a session-limit cutoff that has now passed — data/pipeline.md and data/cache/cycle-status.json both still hold this run's real, current state. Resume modes/cycle.md at Step 2 directly: re-acquire the cycle lock (node core/cycle-lock.mjs acquire), continue processing whatever is still "Pending" in data/pipeline.md exactly as Step 2 already describes, and carry on into Step 3 onward once the backlog (or this batch) is done. Do NOT restart Step 0 or Step 1 — the scan/lock/preflight steps already ran for this run and their output (the pipeline backlog itself) is what you are continuing from.

Never use AskUserQuestion — this is a headless continuation with no candidate reply pending. Return a brief summary of what this batch did.`;
}
```

- [ ] **Step 2: Wire the new kind into `dispatchOne`**

Find:

```javascript
  const prompt = dispatch.kind === 'onboarding'
    ? buildOnboardingPrompt(dispatch)
    : buildRoutingPrompt(dispatch.messages);
```

Replace with:

```javascript
  const prompt = dispatch.kind === 'onboarding'
    ? buildOnboardingPrompt(dispatch)
    : dispatch.kind === 'cycle-resume'
    ? buildCycleResumePrompt(dispatch)
    : buildRoutingPrompt(dispatch.messages);
```

- [ ] **Step 3: Write the test**

Add to `core/test-all.mjs` (extend the existing `buildRoutingPrompt`/`buildOnboardingPrompt` test block from the earlier `for (const [name, prompt] of ...)` loop by adding a third entry, or add a standalone block):

```javascript
try {
  const { buildCycleResumePrompt } = await import(pathToFileURL(join(ROOT, 'core', 'telegram-monitor.mjs')).href);
  const resumePrompt = buildCycleResumePrompt({ chatId: '123', cwd: '/fake/workspace' });
  if (
    resumePrompt.startsWith('[HEADLESS]') &&
    resumePrompt.includes('Known paths') &&
    resumePrompt.includes('Resume modes/cycle.md at Step 2 directly') &&
    resumePrompt.includes('Do NOT restart Step 0 or Step 1')
  ) {
    pass('buildCycleResumePrompt instructs resuming cycle.md Step 2 directly, not restarting from Step 0');
  } else {
    fail(`buildCycleResumePrompt missing expected content:\n${resumePrompt.slice(0, 400)}`);
  }
} catch (e) {
  fail(`buildCycleResumePrompt coverage crashed: ${e.message}`);
}
```

- [ ] **Step 4: Run the test**

Run: `node core/test-all.mjs 2>&1 | grep -E "buildCycleResumePrompt|Results:"`
Expected: the `pass(...)` line, `Results:` shows 0 failed.

- [ ] **Step 5: Commit**

```bash
git add core/telegram-monitor.mjs core/test-all.mjs
git commit -m "feat(telegram-monitor): add buildCycleResumePrompt + cycle-resume dispatch kind

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `checkForStalledCycle` + daemon loop wiring

**Files:**
- Modify: `core/telegram-monitor.mjs`
- Test: `core/test-all.mjs`

**Interfaces:**
- Consumes: `buildBoundChatMap({repoRoot})` from `telegram-router.mjs`; `CYCLE_STATUS_MJS`/`CYCLE_LOCK_MJS` from Task 3; the `routeDispatch` function `daemonLoop()` already constructs via `createRoutingQueue()`; dispatches of `kind: 'cycle-resume'` (Task 4).
- Produces: `export function checkForStalledCycle(routeDispatch, opts = {}) -> void`, called once per `daemonLoop()` iteration.

- [ ] **Step 1: Import `buildBoundChatMap`**

Find:

```javascript
import { routeMessages } from './telegram-router.mjs';
```

Replace with:

```javascript
import { routeMessages, buildBoundChatMap } from './telegram-router.mjs';
```

- [ ] **Step 2: Add `checkForStalledCycle`**

Add this function right after `buildCycleResumePrompt` (from Task 4):

```javascript
/**
 * Runs once per daemonLoop() poll iteration. For every workspace bound to a
 * Telegram chat, checks whether that workspace has a cycle run that stopped
 * (lock released) with pending pipeline URLs still left, and if so, whether
 * it's safe to resume yet — then dispatches a continuation through the same
 * routeDispatch queue real Telegram messages already go through (so a
 * resume for a chat can never race a real incoming message for that same
 * chat). Every per-workspace step is independently guarded: a workspace
 * whose lock/status check fails for any reason (missing file, malformed
 * JSON, a killed subprocess) is skipped, not fatal to the rest of the loop.
 *
 * @param {(dispatch: any) => Promise<void>} routeDispatch - from createRoutingQueue().
 * @param {{exec?: Function, buildBoundChatMap?: Function, now?: Date}} [opts]
 */
export function checkForStalledCycle(routeDispatch, opts = {}) {
  try {
    const exec = opts.exec || execSync;
    const buildMap = opts.buildBoundChatMap || buildBoundChatMap;
    const now = (opts.now || new Date()).getTime();

    for (const [chatId, cwd] of buildMap({ repoRoot: REPO_ROOT })) {
      let lockStatus;
      try {
        lockStatus = JSON.parse(exec(`node "${CYCLE_LOCK_MJS}" status`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
      } catch {
        continue; // can't determine lock state for this workspace right now — try again next poll
      }
      if (lockStatus.held) continue; // a run is already active (or was, very recently) — nothing to do

      let status;
      try {
        status = JSON.parse(exec(`node "${CYCLE_STATUS_MJS}" --json`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
      } catch {
        continue;
      }
      if (status?.liveness?.state !== 'stalled') continue;
      if (!status.counters || !(status.counters.pipelineUrlsPending > 0)) continue;

      if (status.lastStopReason === 'session-limit') {
        const resumeAt = Date.parse(status.resumeNotBefore);
        if (Number.isFinite(resumeAt) && now < resumeAt) continue; // not yet — check again next poll
      }

      routeDispatch({ chatId, cwd, kind: 'cycle-resume', messages: [] }).catch(err =>
        console.error(`[telegram-monitor] cycle-resume dispatch failed for chat ${chatId}: ${err.message}`));
    }
  } catch (err) {
    console.error(`[telegram-monitor] checkForStalledCycle failed (swallowed): ${err.message}`);
  }
}
```

- [ ] **Step 3: Wire it into `daemonLoop()`**

Find (inside the `while (true) { try { ... } ... }` block):

```javascript
      if (messages.length > 0) {
        const dispatches = await routeMessages(messages, { repoRoot: REPO_ROOT, sendReply: sendCannedReply });
        // Routing fired non-blocking, onboarding awaited one at a time —
        // see fanOutDispatches() and this function's block comment above.
        // routeDispatch additionally serializes same-chat routing dispatches
        // across poll iterations — see createRoutingQueue().
        await fanOutDispatches(dispatches, routeDispatch);
      }
      // No sleep between iterations on a clean poll: the long-poll itself
      // already paced this call out over up to DAEMON_LONGPOLL_SECONDS.
```

Replace with:

```javascript
      if (messages.length > 0) {
        const dispatches = await routeMessages(messages, { repoRoot: REPO_ROOT, sendReply: sendCannedReply });
        // Routing fired non-blocking, onboarding awaited one at a time —
        // see fanOutDispatches() and this function's block comment above.
        // routeDispatch additionally serializes same-chat routing dispatches
        // across poll iterations — see createRoutingQueue().
        await fanOutDispatches(dispatches, routeDispatch);
      }
      // Runs every iteration (not gated on messages.length) — a stalled
      // cycle run needs to resume even during a stretch with no incoming
      // Telegram traffic at all. Synchronous and fast (a couple of tiny
      // subprocess calls per bound workspace); never throws.
      checkForStalledCycle(routeDispatch);
      // No sleep between iterations on a clean poll: the long-poll itself
      // already paced this call out over up to DAEMON_LONGPOLL_SECONDS.
```

- [ ] **Step 4: Write the test**

Add to `core/test-all.mjs`:

```javascript
try {
  const { checkForStalledCycle } = await import(pathToFileURL(join(ROOT, 'core', 'telegram-monitor.mjs')).href);

  function runScenario(lockHeld, statusJson, now) {
    const dispatched = [];
    const routeDispatch = (dispatch) => { dispatched.push(dispatch); return Promise.resolve(); };
    const exec = (cmd) => {
      if (cmd.includes('cycle-lock.mjs')) return JSON.stringify({ held: lockHeld });
      if (cmd.includes('cycle-status.mjs')) return JSON.stringify(statusJson);
      throw new Error(`unexpected exec: ${cmd}`);
    };
    const buildBoundChatMapStub = () => new Map([['555', '/fake/workspace']]);
    checkForStalledCycle(routeDispatch, { exec, buildBoundChatMap: buildBoundChatMapStub, now: now || new Date('2026-09-10T12:00:00.000Z') });
    return dispatched;
  }

  const lockedCase = runScenario(true, { liveness: { state: 'stalled' }, counters: { pipelineUrlsPending: 10 } });
  if (lockedCase.length === 0) {
    pass('checkForStalledCycle never dispatches when the cycle lock is held');
  } else {
    fail(`checkForStalledCycle dispatched despite a held lock: ${JSON.stringify(lockedCase)}`);
  }

  const notStalledCase = runScenario(false, { liveness: { state: 'running' }, counters: { pipelineUrlsPending: 10 } });
  if (notStalledCase.length === 0) {
    pass('checkForStalledCycle never dispatches for a run that is still actively running');
  } else {
    fail(`checkForStalledCycle dispatched for a running (not stalled) run: ${JSON.stringify(notStalledCase)}`);
  }

  const nothingPendingCase = runScenario(false, { liveness: { state: 'stalled' }, counters: { pipelineUrlsPending: 0 } });
  if (nothingPendingCase.length === 0) {
    pass('checkForStalledCycle never dispatches when there are zero pending URLs left');
  } else {
    fail(`checkForStalledCycle dispatched with nothing pending: ${JSON.stringify(nothingPendingCase)}`);
  }

  const batchLimitCase = runScenario(false, { liveness: { state: 'stalled' }, counters: { pipelineUrlsPending: 10 }, lastStopReason: 'batch-limit', resumeNotBefore: null });
  if (batchLimitCase.length === 1 && batchLimitCase[0].kind === 'cycle-resume' && batchLimitCase[0].cwd === '/fake/workspace' && batchLimitCase[0].chatId === '555') {
    pass('checkForStalledCycle dispatches immediately for a clean batch-limit stop');
  } else {
    fail(`checkForStalledCycle did not dispatch correctly for a batch-limit stop: ${JSON.stringify(batchLimitCase)}`);
  }

  const sessionLimitNotYetCase = runScenario(false,
    { liveness: { state: 'stalled' }, counters: { pipelineUrlsPending: 10 }, lastStopReason: 'session-limit', resumeNotBefore: '2026-09-10T13:00:00.000Z' },
    new Date('2026-09-10T12:00:00.000Z'));
  if (sessionLimitNotYetCase.length === 0) {
    pass('checkForStalledCycle withholds dispatch until resumeNotBefore has passed');
  } else {
    fail(`checkForStalledCycle dispatched before resumeNotBefore: ${JSON.stringify(sessionLimitNotYetCase)}`);
  }

  const sessionLimitElapsedCase = runScenario(false,
    { liveness: { state: 'stalled' }, counters: { pipelineUrlsPending: 10 }, lastStopReason: 'session-limit', resumeNotBefore: '2026-09-10T11:00:00.000Z' },
    new Date('2026-09-10T12:00:00.000Z'));
  if (sessionLimitElapsedCase.length === 1 && sessionLimitElapsedCase[0].kind === 'cycle-resume') {
    pass('checkForStalledCycle dispatches once resumeNotBefore has passed');
  } else {
    fail(`checkForStalledCycle did not dispatch after resumeNotBefore elapsed: ${JSON.stringify(sessionLimitElapsedCase)}`);
  }

  // Matches Ernesto's real 2026-09-09 stopped state (see the design doc's Testing section).
  const ernestoReplay = runScenario(false,
    { liveness: { state: 'stalled' }, counters: { pipelineUrlsPending: 47 }, lastStopReason: 'session-limit', resumeNotBefore: '2026-09-10T12:05:00.000Z' },
    new Date('2026-09-10T12:00:00.000Z'));
  const ernestoReplayLater = runScenario(false,
    { liveness: { state: 'stalled' }, counters: { pipelineUrlsPending: 47 }, lastStopReason: 'session-limit', resumeNotBefore: '2026-09-10T12:05:00.000Z' },
    new Date('2026-09-10T12:06:00.000Z'));
  if (ernestoReplay.length === 0 && ernestoReplayLater.length === 1) {
    pass('checkForStalledCycle behavioral replay: withholds then correctly resumes a synthetic Ernesto-shaped stalled state');
  } else {
    fail(`checkForStalledCycle behavioral replay failed: before=${JSON.stringify(ernestoReplay)}, after=${JSON.stringify(ernestoReplayLater)}`);
  }

  const brokenExecCase = (() => {
    const dispatched = [];
    const routeDispatch = (dispatch) => { dispatched.push(dispatch); return Promise.resolve(); };
    const exec = () => { throw new Error('subprocess exploded'); };
    checkForStalledCycle(routeDispatch, { exec, buildBoundChatMap: () => new Map([['555', '/fake/workspace']]) });
    return dispatched;
  })();
  if (brokenExecCase.length === 0) {
    pass('checkForStalledCycle never throws and never dispatches when a workspace check itself fails');
  } else {
    fail(`checkForStalledCycle should have skipped a workspace whose check threw: ${JSON.stringify(brokenExecCase)}`);
  }
} catch (e) {
  fail(`checkForStalledCycle coverage crashed: ${e.message}`);
}
```

- [ ] **Step 5: Run the tests**

Run: `node core/test-all.mjs 2>&1 | grep -E "checkForStalledCycle|Results:"`
Expected: seven `pass(...)` lines, `Results:` shows 0 failed.

- [ ] **Step 6: Commit**

```bash
git add core/telegram-monitor.mjs core/test-all.mjs
git commit -m "feat(telegram-monitor): auto-resume a stalled cycle run from the daemon poll loop

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `modes/cycle.md` Step 2 — the batch boundary itself

**Files:**
- Modify: `modes/cycle.md:326-335` (the "No subagent fan-out" bullet in Step 2)
- Test: `core/test-all.mjs`

**Interfaces:**
- Consumes: nothing new (this is prose read by Claude when it executes `cycle` mode — the actual "code" here is the instructions themselves, verified by content assertions + a behavioral replay, matching how the last three fixes in this session were verified).

- [ ] **Step 1: Add the batch-boundary bullet**

In `modes/cycle.md`, find:

```
- **No subagent fan-out — process inline, sequentially.** Per `_custom.md`'s
  "No-subagent inline processing for bulk pipeline evaluation" House Rule,
  which explicitly covers `cycle`'s pipeline step: evaluate the pending
  backlog directly in this orchestrating turn, one URL at a time, with no
  `Agent(...)` calls. This is a deliberate token-cost and headless-reliability
  tradeoff (no per-URL context-load repeat, and a headless/Telegram-triggered
  run has no permission path for an unreviewed `Agent` call) — sequential
  processing on a large sweep is expected to take a while; that is fine.
  `pipeline.md`'s own "3+ pending URLs → launch agents in parallel" text does
  not apply here — see the corrected note in `modes/pipeline.md`.
```

Add immediately after it (still inside Step 2's bullet list):

```
- **Batch boundary: stop after 20 URLs, resume automatically — this is not the "never pause" rule above.** That rule is about never *stopping to ask a human* for a decision; a batch-boundary stop asks nothing of anyone and resumes on its own, so it doesn't conflict with it. A single Step 2 session accumulating every evaluation from a large backlog in one growing context is what makes a big sweep expensive against this account's own rolling Claude Pro session-limit quota — not against a metered dollar bill, but the quota is real and has already been exhausted mid-run twice (2026-09-09; see `docs/superpowers/specs/2026-09-10-cycle-checkpoint-resume-design.md`). Track a counter starting at 0 for this Step 2 invocation; increment it after each URL finishes (evaluated, pre-screened out, or errored — every one counts, not just full A-F evaluations). On reaching 20:
  1. Write a `cycle-status.mjs` checkpoint exactly as any other checkpoint in this step already does, adding `lastStopReason: "batch-limit"` to that same patch object.
  2. `node core/cycle-lock.mjs release` — a batch-limit stop is a controlled, safe-to-resume-immediately pause, not a crash or a true end-of-run, so it releases the lock the same way a normal completion does. This is what lets the automatic continuation below actually start.
  3. Write the Step 4 partial summary (identical shape to a full completion, just scoped to what this batch did — no new summary format) and end the turn. Do not proceed to Step 3 — a continuation reaches Step 3 onward once the full backlog (across however many batches it takes) is actually done.
  `telegram-monitor.mjs`'s daemon detects a released lock plus a stalled run with pending URLs still left, and dispatches the next batch on its own — no `/run` from the candidate needed. A session-limit cutoff (as opposed to this clean batch boundary) is detected and handled entirely outside this mode file, in `telegram-monitor.mjs`'s `dispatchOne` — there is nothing further to do here for that case.
```

- [ ] **Step 2: Write the content-assertion test**

Add to `core/test-all.mjs`, near the other `modes/cycle.md` content checks if any exist, or as a standalone block using the established `readFile('modes/cycle.md')` pattern:

```javascript
const cycleModeForBatchCheck = readFile('modes/cycle.md');
if (
  cycleModeForBatchCheck.includes('Batch boundary: stop after 20 URLs, resume automatically') &&
  cycleModeForBatchCheck.includes('lastStopReason: "batch-limit"') &&
  cycleModeForBatchCheck.includes('node core/cycle-lock.mjs release') &&
  cycleModeForBatchCheck.includes('this is not the "never pause" rule above')
) {
  pass('cycle mode Step 2 has the batch-boundary checkpoint (stop, release lock, resume automatically)');
} else {
  fail('cycle mode Step 2 missing the batch-boundary checkpoint instructions');
}
```

- [ ] **Step 3: Run the test**

Run: `node core/test-all.mjs 2>&1 | grep -E "batch-boundary|Results:"`
Expected: the `pass(...)` line, `Results:` shows 0 failed.

- [ ] **Step 4: Behavioral replay (matches how the prior three fixes in this session were verified)**

Dispatch a general-purpose subagent as a dry-run verification exercise (no real Playwright/cycle-lock calls — read-only): give it the hypothetical "you are running modes/cycle.md Step 2, you've just finished URL #20 of a 60-URL backlog" and ask it to state, based on what it reads in the file, exactly what it would do next. Confirm its answer names all three sub-steps (cycle-status checkpoint with `lastStopReason: "batch-limit"`, `cycle-lock.mjs release`, partial Step 4 summary + end turn) rather than continuing to URL #21.

- [ ] **Step 5: Commit**

```bash
git add modes/cycle.md core/test-all.mjs
git commit -m "feat(cycle): stop Step 2 after 20 URLs instead of running the whole backlog inline

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Full suite + spec coverage check

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full suite**

Run: `node core/test-all.mjs`
Expected: `📊 Results: N passed, 0 failed` (N = the pre-existing count from before this plan, plus every new `pass(...)` added across Tasks 1-6).

- [ ] **Step 2: Cross-check against the design doc's own Testing section**

Re-read `docs/superpowers/specs/2026-09-10-cycle-checkpoint-resume-design.md`'s "Testing" section and confirm each bullet has a corresponding task above:
- Reset-time parser incl. DST-boundary case → Task 2.
- `checkForStalledCycle` decision logic across all six named states → Task 5 (7 scenarios covering all six named states plus one error-resilience case).
- Behavioral replay of a synthetic Ernesto-shaped stalled state → Task 5's `ernestoReplay`/`ernestoReplayLater` scenario.
- Live confirmation (a real `cycle` run over 20 URLs shows up as multiple smaller sessions in `data/token-efficiency-log.tsv`) → not a task in this plan; this is a production observation to make after the next real `cycle` run ships, noted here so it isn't forgotten.

- [ ] **Step 3: Report the live-confirmation follow-up to the user**

This plan's code is fully tested, but the design's actual real-world payoff (smaller sessions in `token-efficiency-log.tsv`) can only be confirmed after a real `cycle` run exceeds 20 pending URLs post-rollout. Flag this to the user as a "check back after the next real cycle run" item rather than closing the loop silently.
