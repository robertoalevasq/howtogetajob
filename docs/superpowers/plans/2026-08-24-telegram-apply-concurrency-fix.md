# Telegram Apply Concurrency/Login-Gate/Cache-Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 2026-08-21 Telegram apply-flow incident by closing a same-chat concurrency gap in the daemon, adding a login/reachability preflight before any field content is generated, and making the boilerplate-answer cache reachable from both the Playwright and manual-paste field-discovery paths.

**Architecture:** A new, independently-testable routing-dispatch queue wraps `dispatchOne` in `core/telegram-monitor.mjs`, constructed once by the daemon loop and passed into every `fanOutDispatches()` call across poll cycles so its in-flight/queued state persists — this requires zero changes to `fanOutDispatches()` itself, preserving its existing tests untouched. Two `modes/apply.md` prose edits close the login-gate and cache-unification gaps identified in the incident.

**Tech Stack:** Node.js (`.mjs`, `node:test`/`node:assert/strict`), agent-instruction Markdown mode files.

**Spec:** `docs/superpowers/specs/2026-08-24-telegram-apply-concurrency-fix-design.md`

## Global Constraints

- No daemon concurrency-model rewrite beyond the same-chat gap — cross-chat non-blocking dispatch and the existing onboarding serialization stay exactly as they are today.
- No new external dependencies or services — the guard is in-process, in-memory, scoped to the daemon's own lifetime.
- No change to the three-gate human-confirmation model (resume-approval → field-approval → submit-approval).
- No change to `data/application-defaults.md`'s cacheable-category list (Step 6b's Field Matching Reference table) — only make the path to it uniform.
- Not a general daemon resilience overhaul — `dispatchOne()`'s existing spawn-failure retry and emergency-notification behavior are untouched.
- After each task: run `node core/test-all.mjs` and confirm no new failures.

---

### Task 1: Per-chat routing dispatch queue

**Files:**
- Modify: `core/telegram-monitor.mjs`
- Test: `tests/telegram-monitor.test.mjs`

**Interfaces:**
- Consumes: `dispatchOne(dispatch, invoke)` (existing, unchanged signature) as the real dispatch function to wrap.
- Produces: `createRoutingQueue()` — a new exported factory function, called with no arguments, returning a single function `wrappedDispatch(dispatch, realDispatch = dispatchOne)`. This returned function has the exact shape `fanOutDispatches()` already expects for its `dispatch` parameter: `(dispatch: object) => Promise<void>`, called as `dispatch(d)` for both `routing` and `onboarding` kinds — `wrappedDispatch` accepts an optional second argument only so tests can inject a fake `realDispatch`; `daemonLoop()` calls it with just one argument, matching `fanOutDispatches`'s existing call shape exactly.

The current `core/telegram-monitor.mjs` (read it in full before editing — some line numbers below may have shifted) has this shape:

```js
export async function fanOutDispatches(dispatches, dispatch = dispatchOne) {
  const log = (label, d, err) =>
    console.error(`[${new Date().toISOString()}] [telegram-monitor daemon] ${label} call failed for chat ${d.chatId} (already reported to the user): ${err.message}`);

  for (const d of dispatches) {
    if (d.kind === 'onboarding') continue;
    dispatch(d).catch(err => log('Routing', d, err));
  }
  for (const d of dispatches) {
    if (d.kind !== 'onboarding') continue;
    try {
      await dispatch(d);
    } catch (err) {
      log('Onboarding', d, err);
    }
  }
}
```

and `daemonLoop()` calls it fresh every poll iteration:

```js
async function daemonLoop() {
  // ... lock acquisition, shutdown handlers ...
  while (true) {
    try {
      const result = await pollTelegram(DAEMON_LONGPOLL_SECONDS);
      const messages = result.messages || [];
      logPollError(result);
      if (messages.length > 0) {
        const dispatches = await routeMessages(messages, { repoRoot: REPO_ROOT, sendReply: sendCannedReply });
        await fanOutDispatches(dispatches);
      }
    } catch (err) {
      // ...
    }
  }
}
```

Because `fanOutDispatches()` is called fresh each loop iteration with its default `dispatch = dispatchOne`, there is no memory of a routing dispatch still running from a prior iteration — a second poll that finds new messages for the same already-busy chat fires a second, fully independent `claude -p` process for that chat. Both processes then race on reading/writing that workspace's `data/telegram-state.md`.

**Do not modify `fanOutDispatches()`'s own logic.** Its three existing tests (`'fanOutDispatches never runs two onboarding dispatches concurrently'`, `'fanOutDispatches keeps routing dispatches non-blocking...'`, `'fanOutDispatches logs and continues when an onboarding dispatch rejects'`) encode real invariants and must keep passing unmodified. Instead, add a new function that `daemonLoop()` constructs once (outside the `while (true)` loop, so its state survives across iterations) and passes as `fanOutDispatches`'s `dispatch` argument on every call.

- [ ] **Step 1: Write the failing tests**

Add these to `tests/telegram-monitor.test.mjs` (append after the existing tests; add `createRoutingQueue` to the existing `import { ... } from '../core/telegram-monitor.mjs';` line):

```js
test('createRoutingQueue: a second routing dispatch for the SAME chat while the first is in flight gets queued, not fired concurrently', async () => {
  const calls = [];
  let releaseFirst;
  const firstHeld = new Promise(r => { releaseFirst = r; });
  const fakeDispatch = async (d) => {
    calls.push({ chatId: d.chatId, messages: d.messages });
    if (calls.length === 1) await firstHeld;
  };

  const wrapped = createRoutingQueue();
  const first = wrapped({ chatId: 'alice', kind: 'routing', messages: ['m1'], cwd: '/repo/workspaces/alice', state: null }, fakeDispatch);
  // Second dispatch for the SAME chat arrives while the first is still in flight.
  const second = wrapped({ chatId: 'alice', kind: 'routing', messages: ['m2'], cwd: '/repo/workspaces/alice', state: null }, fakeDispatch);

  // Only one real dispatch call happened so far — the second was queued, not fired.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messages, ['m1']);

  releaseFirst();
  await first;
  await second; // resolves once the queued follow-up dispatch (fired internally) settles

  // The queued messages arrived as their own follow-up dispatch once the first settled.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].messages, ['m2']);
});

test('createRoutingQueue: messages queued during the first dispatch are NOT lost — they fire as one follow-up call, not dropped', async () => {
  const calls = [];
  let releaseFirst;
  const firstHeld = new Promise(r => { releaseFirst = r; });
  const fakeDispatch = async (d) => {
    calls.push([...d.messages]);
    if (calls.length === 1) await firstHeld;
  };

  const wrapped = createRoutingQueue();
  const first = wrapped({ chatId: 'bob', kind: 'routing', messages: ['m1'], cwd: '/repo/workspaces/bob', state: null }, fakeDispatch);
  // Three more batches arrive in quick succession while the first is still running.
  wrapped({ chatId: 'bob', kind: 'routing', messages: ['m2'], cwd: '/repo/workspaces/bob', state: null }, fakeDispatch);
  wrapped({ chatId: 'bob', kind: 'routing', messages: ['m3'], cwd: '/repo/workspaces/bob', state: null }, fakeDispatch);
  const fourth = wrapped({ chatId: 'bob', kind: 'routing', messages: ['m4'], cwd: '/repo/workspaces/bob', state: null }, fakeDispatch);

  releaseFirst();
  await first;
  await fourth;

  // Exactly 2 real dispatch calls: the first (m1), then ONE follow-up carrying
  // every message that queued up while the first was running (m2, m3, m4) —
  // never more than one extra call, never dropped.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['m1']);
  assert.deepEqual(calls[1], ['m2', 'm3', 'm4']);
});

test('createRoutingQueue: a DIFFERENT chat is never held up by another chat\'s in-flight dispatch', async () => {
  const events = [];
  let releaseAlice;
  const aliceHeld = new Promise(r => { releaseAlice = r; });
  const fakeDispatch = async (d) => {
    events.push(`start:${d.chatId}`);
    if (d.chatId === 'alice') await aliceHeld;
    events.push(`end:${d.chatId}`);
  };

  const wrapped = createRoutingQueue();
  const aliceDispatch = wrapped({ chatId: 'alice', kind: 'routing', messages: [], cwd: '/repo/workspaces/alice', state: null }, fakeDispatch);
  const bobDispatch = wrapped({ chatId: 'bob', kind: 'routing', messages: [], cwd: '/repo/workspaces/bob', state: null }, fakeDispatch);

  await bobDispatch;
  // Bob's dispatch fired and completed while Alice's is still held open — proves
  // the queue is per-chat, not a global serialization point.
  assert.deepEqual(events, ['start:alice', 'start:bob', 'end:bob']);

  releaseAlice();
  await aliceDispatch;
  assert.deepEqual(events, ['start:alice', 'start:bob', 'end:bob', 'end:alice']);
});

test('createRoutingQueue: onboarding-kind dispatches pass straight through, untouched by the queue', async () => {
  const calls = [];
  const fakeDispatch = async (d) => { calls.push(d.chatId); };
  const wrapped = createRoutingQueue();

  // Two onboarding dispatches for the SAME chatId, back to back — must both
  // fire immediately (no queueing), matching fanOutDispatches's own existing
  // sequential-await behavior for onboarding.
  await wrapped({ chatId: 'newbie', kind: 'onboarding', messages: [], cwd: '/repo', state: {} }, fakeDispatch);
  await wrapped({ chatId: 'newbie', kind: 'onboarding', messages: [], cwd: '/repo', state: {} }, fakeDispatch);

  assert.deepEqual(calls, ['newbie', 'newbie']);
});

test('createRoutingQueue: a rejected in-flight dispatch still drains its queued follow-up (queue state is not stuck on error)', async () => {
  const calls = [];
  let releaseFirst;
  const firstHeld = new Promise(r => { releaseFirst = r; });
  const fakeDispatch = async (d) => {
    calls.push([...d.messages]);
    if (calls.length === 1) {
      await firstHeld;
      throw new Error('claude exited 1');
    }
  };

  const wrapped = createRoutingQueue();
  const first = wrapped({ chatId: 'carol', kind: 'routing', messages: ['m1'], cwd: '/repo/workspaces/carol', state: null }, fakeDispatch);
  const second = wrapped({ chatId: 'carol', kind: 'routing', messages: ['m2'], cwd: '/repo/workspaces/carol', state: null }, fakeDispatch);

  releaseFirst();
  await assert.rejects(first, /claude exited 1/);
  await second; // the queued follow-up still fires despite the first rejecting

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['m2']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/telegram-monitor.test.mjs`
Expected: FAIL — `createRoutingQueue is not defined` (not yet exported from `core/telegram-monitor.mjs`).

- [ ] **Step 3: Implement `createRoutingQueue`**

Add this function to `core/telegram-monitor.mjs`, near `fanOutDispatches` (read the file's current import list first — no new imports are needed, this uses only plain JS `Map`/`Promise`):

```js
/**
 * Per-chat routing-dispatch queue. Wraps a real dispatch function (normally
 * `dispatchOne`) so that a chat already mid-dispatch never gets a second,
 * concurrent `claude -p` process fired for it — closing the same-chat
 * concurrency gap `fanOutDispatches()`'s own non-blocking design left open
 * (see its block comment on `daemonLoop()`). A new message for a chat
 * already in flight is queued instead of dispatched immediately; once the
 * in-flight call settles (resolve OR reject), any queued messages fire as
 * exactly one follow-up dispatch, carrying every message that queued up in
 * the meantime — never more than one extra call per settle, never dropped.
 *
 * Call this ONCE, outside the daemon's poll loop, and pass the returned
 * function as `fanOutDispatches`'s `dispatch` argument on every iteration —
 * its state (which chats are in flight, what's queued) must survive across
 * poll cycles to do anything, which is exactly why this can't live inside
 * `fanOutDispatches()` itself (a fresh call each iteration would have no
 * memory of the previous one).
 *
 * `onboarding`-kind dispatches pass straight through untouched — they're
 * already serialized across the whole daemon by `fanOutDispatches()`'s own
 * sequential-await loop, which has no same-chat race to close.
 *
 * @returns {(dispatch: {chatId: string, kind: 'routing'|'onboarding', messages: any[], cwd: string, state: object|null}, realDispatch?: (d: any) => Promise<void>) => Promise<void>}
 */
export function createRoutingQueue() {
  const inFlight = new Set();
  const queued = new Map(); // chatId -> messages[] accumulated while in flight

  return function wrappedDispatch(dispatch, realDispatch = dispatchOne) {
    if (dispatch.kind !== 'routing') return realDispatch(dispatch);

    const { chatId } = dispatch;
    if (inFlight.has(chatId)) {
      const existing = queued.get(chatId) || [];
      queued.set(chatId, existing.concat(dispatch.messages));
      return Promise.resolve();
    }

    inFlight.add(chatId);
    const run = d => realDispatch(d).finally(() => {
      const pending = queued.get(chatId);
      if (pending && pending.length > 0) {
        queued.delete(chatId);
        return run({ ...d, messages: pending });
      }
      inFlight.delete(chatId);
    });
    return run(dispatch);
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/telegram-monitor.test.mjs`
Expected: PASS — all tests, including the 5 new ones and the pre-existing ones (unmodified, still green).

- [ ] **Step 5: Wire it into the daemon loop**

In `core/telegram-monitor.mjs`, find `daemonLoop()` (read its current content — the lock-acquisition and shutdown-handler code above the `while (true)` loop is unrelated and must stay as-is). Add the queue's construction once, before the loop, and pass it into every `fanOutDispatches()` call inside the loop:

```js
async function daemonLoop() {
  let lock;
  try {
    lock = await acquirePipelineLock(DAEMON_LOCK_PATH, { timeoutMs: 2000 });
  } catch (err) {
    console.error(`[telegram-monitor daemon] Could not acquire ${DAEMON_LOCK_PATH} — is another daemon instance already running? (${err.message})`);
    process.exit(1);
  }

  const shutdown = signal => {
    console.log(`[${new Date().toISOString()}] [telegram-monitor daemon] ${signal} received, releasing lock and exiting.`);
    lock.release();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log(`[${new Date().toISOString()}] [telegram-monitor daemon] Started — long-polling every ${DAEMON_LONGPOLL_SECONDS}s.`);

  // Constructed once, outside the loop, so its per-chat in-flight/queued
  // state survives across poll iterations — see createRoutingQueue()'s own
  // doc comment for why this can't be recreated each iteration.
  const routeDispatch = createRoutingQueue();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await pollTelegram(DAEMON_LONGPOLL_SECONDS);
      const messages = result.messages || [];
      logPollError(result);
      if (messages.length > 0) {
        const dispatches = await routeMessages(messages, { repoRoot: REPO_ROOT, sendReply: sendCannedReply });
        await fanOutDispatches(dispatches, routeDispatch);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [telegram-monitor daemon] Error: ${err.message} — retrying in 5s`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
```

The only change from the current code: the new `const routeDispatch = createRoutingQueue();` line before the loop, and passing `routeDispatch` as `fanOutDispatches`'s second argument instead of relying on its `dispatch = dispatchOne` default. **Do not change the single-poll (`main()`) non-daemon path** — it calls `dispatchOne` directly in its own loop (`for (const dispatch of dispatches) { await dispatchOne(dispatch); }`), which already fully serializes every dispatch (no concurrency to fix there — see the "Two ways to run this" doc comment at the top of the file: the scheduled single-poll mode has no long-running loop to unblock in the first place).

- [ ] **Step 6: Run the full test suite**

Run: `node core/test-all.mjs`
Expected: no new failures beyond whatever pre-existing, unrelated ones the suite already reports (check the summary line's pass/fail counts against a baseline run before this task if unsure).

- [ ] **Step 7: Commit**

```bash
git add core/telegram-monitor.mjs tests/telegram-monitor.test.mjs
git commit -m "fix: serialize same-chat Telegram routing dispatches to close a concurrency gap"
```

---

### Task 2: `modes/apply.md` — login-gate preflight and cache-path unification

**Files:**
- Modify: `modes/apply.md`

**Interfaces:**
- Consumes: nothing from Task 1 (independent, prose-only change to a different file).
- Produces: nothing later tasks depend on programmatically — this is the plan's other independent fix.

Read the current `modes/apply.md` in full before editing (it may have drifted slightly from the excerpts below since spec-writing time) — apply both edits below to whatever the real current Step 1/5/6/6b text is, preserving its exact surrounding structure and numbering.

- [ ] **Step 1: Add the reachability/login-gate check to Step 5 (PREFLIGHT gate)**

Find Step 5's existing lead-in checks — currently three bolded sub-checks appear before the numbered `1. Read the visible URL...` list: **Blacklist check (#1742)**, **Cross-channel check (#1596)**, **Repeat-application ATS profile check (#1920)**. Add a new one immediately after the Repeat-application check and before the numbered list, matching their exact style:

```markdown
**Reachability check (form gated behind login/CAPTCHA):** before generating any field content (Step 6 onward), confirm the real application form is actually visible — not hidden behind a "sign in," "create an account," CAPTCHA, or equivalent wall that blocks reading the actual fields. This check runs as part of Step 1 (DETECT)'s own page read, and its result gates everything from here forward:

1. If the page/form IS reachable (no gate detected, or the candidate has already signed in and shared what they see), proceed with the rest of this preflight and Steps 6-7 as normal.
2. If the page/form is NOT reachable — an authentication wall, CAPTCHA, or similar blocks the real fields — **stop immediately, in this same turn, before Step 6 runs.** Do not construct a field-approval preview from the JD text plus generic ATS-category guesses; a preview built from guesses and presented as something to approve is misleading even when labeled speculative, since the candidate has no way to tell which parts are real without the actual form in front of them. Instead, tell the candidate plainly what's blocking access and offer exactly two paths forward:
   - They sign in (or create an account) themselves, in their own browser, then share the real questions — screenshot or paste — the same way Step 1's "Without Playwright" branch already works.
   - They skip this application for now; nothing is lost, and the tailored resume (already built and approved before the form was ever touched, per `modes/telegram.md` Step 3b) is unaffected.
3. This check is a hard gate, not a warning — unlike Step 5b/5c/5d below, which surface information and let the candidate decide how to proceed, a login/CAPTCHA wall means there is nothing real yet to generate content from, so there is no "proceed anyway" option here.
```

- [ ] **Step 2: Cross-reference the new check from Step 1 (DETECT)**

Find Step 1's two branches ("**With Playwright:**" and "**Without Playwright:**"). Immediately after the "**With Playwright:**" branch's existing text ("Take a snapshot of the active page. Read title, URL, and visible content."), add one sentence pointing to the new gate so a reader following Step 1 in order knows this check exists before reaching Step 5:

```markdown
**With Playwright:** Take a snapshot of the active page. Read title, URL, and visible content. If the snapshot shows an authentication wall, CAPTCHA, or similar gate instead of the real form, see Step 5's Reachability check below — do not proceed to Step 6 from here.
```

Leave the "**Without Playwright:**" branch's existing three bullets (screenshot / paste questions / say company+role) untouched — that branch is itself one of the two paths the new Reachability check already offers once a login gate is detected, so it needs no additional cross-reference.

- [ ] **Step 3: Unify the cache path in Step 6 (Analyze)**

Find Step 6's opening line: `Identify ALL visible form questions:` followed by the bulleted field-type list (Free text fields, Dropdowns, Yes/No, Salary fields, Upload fields). Add one sentence immediately after that opening line, before the bullet list, making explicit that this step runs the same way regardless of source:

```markdown
Identify ALL visible form questions — whether they came from a live Playwright DOM read (Step 1's "With Playwright" branch) or from the candidate's own pasted/screenshotted text (Step 1's "Without Playwright" branch, including the path Step 5's Reachability check routes to when a form is login-gated). Both sources feed the exact same classification and caching logic below — a boilerplate-category question doesn't get asked twice just because this particular application went through the manual path instead of Playwright, or vice versa.
```

- [ ] **Step 4: Reinforce the same point in Step 6b's own text**

Find Step 6b's opening paragraph (starts "Some form fields are pure administrivia..."). Add one sentence at the end of that paragraph:

```markdown
Some form fields are pure administrivia — the same answer on every application, regardless of company or role (EEO/demographic self-identification, veteran/disability status, "how did you hear about us," "previously worked here," standard legal-acknowledgment checkboxes, electronic signature). Re-deriving or re-confirming these on every run wastes both the candidate's attention and tokens. This applies identically whether the question list in this run came from Playwright or from a manually relayed question — the cache doesn't care which path found the question, only what the question is.
```

- [ ] **Step 5: Verify the edits read coherently**

Read the full modified Step 1, Step 5, Step 6, and Step 6b sections top to bottom. Confirm: no duplicate/contradictory instructions, the new Reachability check's numbering doesn't collide with Step 5's existing numbered list (it's a separate lead-in block, matching the style of the three existing lead-in checks — it should NOT be folded into the `1. Read the visible URL...` numbered list), and Step 5's final line ("Do not continue to Step 6 until this preflight is resolved.") still correctly covers the new check too (it does, structurally, since the new check is one more part of "this preflight").

- [ ] **Step 6: Run the full test suite**

Run: `node core/test-all.mjs`
Expected: no new failures. If any existing test asserts specific line numbers, exact section text, or a specific count of Step 5 sub-checks in `modes/apply.md`, it will need updating to match the new content — search for one first: `grep -rn "modes/apply.md" tests/ core/test-all.mjs` (or equivalent) before assuming none exists.

- [ ] **Step 7: Commit**

```bash
git add modes/apply.md
git commit -m "fix: require a reachability preflight before generating field content, unify the boilerplate cache path"
```

---

### Task 3: Final verification

**Files:** none modified (verification only) — unless Step 6's test-all.mjs check in either prior task surfaced something deferred, in which case fix it here and note why it wasn't caught earlier.

**Interfaces:**
- Consumes: the complete state of Task 1 and Task 2.
- Produces: the plan's exit criteria.

- [ ] **Step 1: Full test suite, one more time, against the complete combined state**

```bash
node --test tests/telegram-monitor.test.mjs
node core/test-all.mjs
```
Expected: both clean. This re-run matters because Task 1 and Task 2 were verified independently — this confirms nothing about their combination broke (they touch different files, so this is a low-risk check, but it's the plan's actual exit gate, not either task's own in-task run).

- [ ] **Step 2: Manual walkthrough of the fix against the original incident**

Re-read the 2026-08-21 transcript's sequence against the new code/prose:
1. Candidate approves the tailored resume ("yes" at 2:06 PM) → Step 3b of `modes/telegram.md` proceeds to run `apply` mode's Steps 1-7.
2. `apply` mode's new Step 5 Reachability check would have caught the Workday login wall here — at Step 1/5, before ever reaching Step 6/7 — rather than after generating a full speculative field-approval preview. Confirm this by reading the new Step 5 text and tracing that Step 6 is genuinely unreachable from Step 1 without passing through Step 5's gate first (per the existing "Do not continue to Step 6 until this preflight is resolved" line).
3. If the candidate had sent a follow-up message while the freshness-reevaluation was still running (the actual trigger for the 8/21 pile-up), `createRoutingQueue()` would now hold that message until the in-flight dispatch settles, then fire exactly one follow-up dispatch with it — no second concurrent `claude -p` process, no duplicate/conflicting warning messages, no lost pending-confirmation state. Confirm this by re-reading Task 1's own tests, which directly assert this scenario.

This step produces no code change — it's a documented sanity check that the three fixes, read together, actually close the gap the incident exposed. Note the outcome in the task's own commit message (see Step 3 below) or as a one-line comment if anything looks incomplete — if something DOES look incomplete, that's a real finding: fix it before calling this task done, don't just note it and move on.

- [ ] **Step 3: Commit (only if Step 1 or Step 2 required a fix)**

```bash
git add -A
git commit -m "fix: address gaps found in final verification of the telegram apply concurrency fix"
```
If Steps 1-2 found nothing to fix, there's nothing to commit here — this task is verification-only.
