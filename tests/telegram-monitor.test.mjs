import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildRoutingPrompt, buildOnboardingPrompt, dispatchOne, sendCannedReply, fanOutDispatches, createRoutingQueue,
  resolveReportForDispatch, resolveBrowserMcpArgs, checkCdpAlive,
  createPollErrorLogger, shouldAlertOperator, maybeAlertOperator, deriveDispatchCommand,
} from '../core/telegram-monitor.mjs';
import { writeBrowserSessions, browserSessionsStatePath, launchHolder } from '../core/apply-browser-holder.mjs';

/** Run `fn` with console.error muted (these paths log deliberately). */
async function quietErrors(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test('buildRoutingPrompt embeds the HEADLESS marker and the given messages as JSON', () => {
  const messages = [{ chatId: '1', text: '/status' }];
  const prompt = buildRoutingPrompt(messages);
  assert.match(prompt, /\[HEADLESS\]/);
  assert.match(prompt, /modes\/telegram\.md/);
  assert.ok(prompt.includes(JSON.stringify(messages, null, 2)));
});

test('buildOnboardingPrompt embeds the chatId, the --chat-id convention, and the current state', () => {
  const dispatch = {
    chatId: '42',
    cwd: '/fake/repo',
    kind: 'onboarding',
    messages: [{ chatId: '42', text: 'Alice' }],
    state: { chatId: '42', slug: null, currentStep: 'name' },
  };
  const prompt = buildOnboardingPrompt(dispatch);
  assert.match(prompt, /\[HEADLESS\]/);
  assert.match(prompt, /modes\/telegram-onboarding\.md/);
  assert.match(prompt, /--chat-id 42/);
  assert.ok(prompt.includes(JSON.stringify(dispatch.state, null, 2)));
  assert.ok(prompt.includes(JSON.stringify(dispatch.messages, null, 2)));
});

test('dispatchOne calls invoke with the onboarding prompt, the dispatch cwd, a bounded timeout, and the fast model for an onboarding dispatch', async () => {
  const calls = [];
  const fakeInvoke = async (prompt, cwd, timeoutMs, model) => { calls.push({ prompt, cwd, timeoutMs, model }); };
  const dispatch = {
    chatId: '1', cwd: '/fake/workspace', kind: 'onboarding',
    messages: [{ chatId: '1', text: 'Alice' }], state: { currentStep: 'name' },
  };
  await dispatchOne(dispatch, fakeInvoke);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/fake/workspace');
  assert.match(calls[0].prompt, /modes\/telegram-onboarding\.md/);
  assert.equal(calls[0].timeoutMs, 10 * 60 * 1000);
  assert.equal(calls[0].model, 'haiku');
});

test('dispatchOne calls invoke with the routing prompt, the dispatch cwd, NO timeout, and the pinned default model for a routing dispatch', async () => {
  const calls = [];
  const fakeInvoke = async (prompt, cwd, timeoutMs, model) => { calls.push({ prompt, cwd, timeoutMs, model }); };
  const dispatch = {
    chatId: '1', cwd: '/fake/workspace/alice', kind: 'routing',
    messages: [{ chatId: '1', text: '/status' }], state: null,
  };
  await dispatchOne(dispatch, fakeInvoke, undefined, () => {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/fake/workspace/alice');
  assert.equal(calls[0].model, 'haiku');
  assert.match(calls[0].prompt, /modes\/telegram\.md/);
  assert.equal(calls[0].timeoutMs, undefined);
});

// ── dispatch logging (deriveDispatchCommand + dispatchOne's logDispatch call) ──

test('deriveDispatchCommand maps a recognized task-starting command to its mode', () => {
  assert.equal(deriveDispatchCommand([{ text: '/apply 939' }]), 'apply');
  assert.equal(deriveDispatchCommand([{ text: '/applyall' }]), 'apply-batch');
  assert.equal(deriveDispatchCommand([{ text: '/scan' }]), 'scan');
  assert.equal(deriveDispatchCommand([{ text: '/run' }]), 'cycle');
  assert.equal(deriveDispatchCommand([{ text: '/pdf 42' }]), 'pdf');
  assert.equal(deriveDispatchCommand([{ text: '/editpdf 42' }]), 'pdf');
  assert.equal(deriveDispatchCommand([{ text: '/status' }]), 'status');
  assert.equal(deriveDispatchCommand([{ text: '/settings' }]), 'settings');
  assert.equal(deriveDispatchCommand([{ text: '/help' }]), 'help');
});

test('deriveDispatchCommand labels a confirmation-reply command (yes/no/skip/cancel) as "reply", not a mode', () => {
  // The router can't know what these are answering without doing the actual
  // routing work (reading telegram-state.md's pending confirmations) —
  // that's deliberately left to the dispatched session, not guessed here.
  assert.equal(deriveDispatchCommand([{ text: '/yes' }]), 'reply');
  assert.equal(deriveDispatchCommand([{ text: '/skip' }]), 'reply');
});

test('deriveDispatchCommand labels free text and a pasted URL as "reply"', () => {
  assert.equal(deriveDispatchCommand([{ text: '1' }]), 'reply');
  assert.equal(deriveDispatchCommand([{ text: 'https://boards.greenhouse.io/acme/jobs/1' }]), 'reply');
});

test('deriveDispatchCommand takes the first recognized command across multiple queued messages', () => {
  assert.equal(deriveDispatchCommand([{ text: 'hello' }, { text: '/scan' }, { text: '/pdf 1' }]), 'scan');
});

test('deriveDispatchCommand returns "reply" for an empty or missing messages array', () => {
  assert.equal(deriveDispatchCommand([]), 'reply');
  assert.equal(deriveDispatchCommand(undefined), 'reply');
});

test('dispatchOne calls logDispatch with the derived command for a routing dispatch, before invoke', async () => {
  const order = [];
  const fakeInvoke = async () => { order.push('invoke'); };
  const fakeLogDispatch = (dispatch, command) => { order.push({ logDispatch: command, chatId: dispatch.chatId }); };
  const dispatch = { chatId: '7', cwd: '/fake/workspace/alice', kind: 'routing', messages: [{ text: '/scan' }], state: null };
  await dispatchOne(dispatch, fakeInvoke, undefined, fakeLogDispatch);
  assert.deepEqual(order, [{ logDispatch: 'scan', chatId: '7' }, 'invoke']);
});

test('dispatchOne never calls logDispatch for an onboarding dispatch', async () => {
  const fakeInvoke = async () => {};
  let called = false;
  const fakeLogDispatch = () => { called = true; };
  const dispatch = { chatId: '7', cwd: '/fake/workspace', kind: 'onboarding', messages: [{ text: 'Alice' }], state: { currentStep: 'name' } };
  await dispatchOne(dispatch, fakeInvoke, undefined, fakeLogDispatch);
  assert.equal(called, false);
});

test('sendCannedReply runs the telegram notify hook with forceEnabled — the repo root has no config/plugins.yml', async () => {
  // Without forceEnabled the enabled-gate skips the telegram manifest at
  // REPO_ROOT, runHook returns [], nothing throws, and every wrong-code reply
  // is silently dropped. That is the regression this asserts against.
  const calls = [];
  const fakeHook = async (kind, payload, opts) => {
    calls.push({ kind, payload, opts });
    return [{ id: 'telegram', ok: true, result: { sent: true, chats: [{ chatId: payload.chatId, sent: true }] } }];
  };
  const ok = await sendCannedReply('491507842', 'Please enter your access code to continue.', fakeHook);

  assert.equal(ok, true, 'a delivered message must report success to callers like broadcast.mjs');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'notify');
  assert.equal(calls[0].opts.only, 'telegram');
  assert.equal(calls[0].opts.forceEnabled, true);
  assert.equal(calls[0].opts.dryRun, false);
  assert.equal(calls[0].opts.root, calls[0].opts.workspaceRoot);
  assert.equal(calls[0].payload.chatId, '491507842');
  assert.match(calls[0].payload.message, /access code/i);
});

test('sendCannedReply logs when notify() reports an in-band failure (sent: false) instead of throwing', async () => {
  // notify() reports a missing token / unresolvable chat as { sent: false,
  // error: '...' } inside an ok:true result, not by throwing — a bare
  // try/catch around the hook call can't see this. Assert the failure is
  // actually logged instead of silently treated as delivered.
  const fakeHook = async () => [{ id: 'telegram', ok: true, result: { sent: false, error: 'TELEGRAM_BOT_TOKEN not set' } }];
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  let ok;
  try {
    ok = await sendCannedReply('491507842', 'hi', fakeHook);
  } finally {
    console.error = original;
  }
  // Logging alone is not enough: broadcast.mjs has to be able to tell this
  // apart from a real send, and the only channel for that is the return value.
  assert.equal(ok, false);
  assert.ok(logged.length > 0, 'expected a logged failure');
  assert.match(logged[0], /did not send/);
  assert.match(logged[0], /TELEGRAM_BOT_TOKEN not set/);
});

test('sendCannedReply swallows a failing hook rather than breaking the poll loop, and reports false', async () => {
  await quietErrors(async () => {
    const promise = sendCannedReply('1', 'hi', async () => { throw new Error('network down'); });
    await assert.doesNotReject(promise);
    // Swallowed, but not invisible — the caller still learns it failed.
    assert.equal(await promise, false);
  });
});

test('fanOutDispatches never runs two onboarding dispatches concurrently', async () => {
  const events = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fakeDispatch = async (d) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    events.push(`start:${d.chatId}`);
    await new Promise(r => setTimeout(r, 10));
    events.push(`end:${d.chatId}`);
    inFlight--;
  };

  await fanOutDispatches([
    { chatId: 'a', kind: 'onboarding', messages: [], state: {}, cwd: '/repo' },
    { chatId: 'b', kind: 'onboarding', messages: [], state: {}, cwd: '/repo' },
  ], fakeDispatch);

  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b']);
  assert.equal(maxInFlight, 1);
});

test('fanOutDispatches keeps routing dispatches non-blocking and fires them before awaiting onboarding', async () => {
  const events = [];
  let releaseRouting;
  const routingHeld = new Promise(r => { releaseRouting = r; });
  const fakeDispatch = async (d) => {
    events.push(`start:${d.chatId}`);
    if (d.kind === 'routing') await routingHeld; // never resolves before we assert
    events.push(`end:${d.chatId}`);
  };

  await fanOutDispatches([
    { chatId: 'bound', kind: 'routing', messages: [], state: null, cwd: '/repo/workspaces/alice' },
    { chatId: 'newbie', kind: 'onboarding', messages: [], state: {}, cwd: '/repo' },
  ], fakeDispatch);

  // fanOutDispatches resolved while the routing dispatch is still in flight —
  // that is the whole point of leaving bound chats un-awaited.
  assert.deepEqual(events, ['start:bound', 'start:newbie', 'end:newbie']);
  releaseRouting();
});

test('fanOutDispatches logs and continues when an onboarding dispatch rejects', async () => {
  const seen = [];
  await quietErrors(() => fanOutDispatches([
    { chatId: 'a', kind: 'onboarding', messages: [], state: {}, cwd: '/repo' },
    { chatId: 'b', kind: 'onboarding', messages: [], state: {}, cwd: '/repo' },
  ], async (d) => {
    seen.push(d.chatId);
    if (d.chatId === 'a') throw new Error('claude exited 1');
  }));
  assert.deepEqual(seen, ['a', 'b']);
});

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

function fakeWorkspaceWithState(pendingBlock) {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-report-resolve-'));
  mkdirSync(join(ws, 'data'), { recursive: true });
  writeFileSync(join(ws, 'data', 'telegram-state.md'), [
    '# Telegram State',
    '',
    '## Pending Confirmations',
    pendingBlock,
    '',
    '## Batch Queue',
    '(none)',
  ].join('\n'));
  return ws;
}

test('resolveReportForDispatch resolves a fresh "/apply {report}" command directly from the message text', () => {
  const dispatch = { chatId: '1', cwd: '/fake/does-not-need-to-exist', kind: 'routing', messages: [{ chatId: '1', text: '/apply 937' }], state: null };
  assert.equal(resolveReportForDispatch(dispatch), '937');
});

test('resolveReportForDispatch resolves from telegram-state.md when exactly one confirmation is pending', () => {
  const ws = fakeWorkspaceWithState(
    '[msg_id: 398] stage: field-approval — NRECA, report 937 — Self Identify (5 of 6)\n  report: 937\n  job_url: https://example.com\n  data: {}',
  );
  try {
    const dispatch = { chatId: '1', cwd: ws, kind: 'routing', messages: [{ chatId: '1', text: 'yes' }], state: null };
    assert.equal(resolveReportForDispatch(dispatch), '937');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveReportForDispatch still resolves /yes, /no, /skip, /cancel as confirmation replies, not as commands starting new work', () => {
  const ws = fakeWorkspaceWithState(
    '[msg_id: 398] stage: field-approval — NRECA, report 937 — Self Identify (5 of 6)\n  report: 937\n  job_url: https://example.com\n  data: {}',
  );
  try {
    for (const text of ['/yes', '/no', '/skip', '/cancel']) {
      const dispatch = { chatId: '1', cwd: ws, kind: 'routing', messages: [{ chatId: '1', text }], state: null };
      assert.equal(resolveReportForDispatch(dispatch), '937', `${text} should still resolve the pending confirmation's report`);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveReportForDispatch returns null when zero confirmations are pending', () => {
  const ws = fakeWorkspaceWithState('(none)');
  try {
    const dispatch = { chatId: '1', cwd: ws, kind: 'routing', messages: [{ chatId: '1', text: 'yes' }], state: null };
    assert.equal(resolveReportForDispatch(dispatch), null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveReportForDispatch returns null when MULTIPLE confirmations are pending (ambiguous)', () => {
  const ws = fakeWorkspaceWithState(
    '[msg_id: 100] stage: question — first\n  report: 100\n  job_url: https://example.com\n  data: {}\n' +
    '[msg_id: 200] stage: question — second\n  report: 200\n  job_url: https://example.com\n  data: {}',
  );
  try {
    const dispatch = { chatId: '1', cwd: ws, kind: 'routing', messages: [{ chatId: '1', text: 'yes' }], state: null };
    assert.equal(resolveReportForDispatch(dispatch), null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveReportForDispatch returns null for a command unrelated to apply', () => {
  const dispatch = { chatId: '1', cwd: '/fake', kind: 'routing', messages: [{ chatId: '1', text: '/status' }], state: null };
  assert.equal(resolveReportForDispatch(dispatch), null);
});

// The pending-confirmation fallback used to fire for ANY message text: with
// one confirmation pending for report 937, all four of these resolved to 937
// (verified live before the fix), silently pinning an unrelated command's
// dispatch to that application's persistent browser.
for (const text of ['/status', '/run', '/scan', 'https://boards.greenhouse.io/x/jobs/123']) {
  test(`resolveReportForDispatch does NOT resolve a single pending confirmation for ${text}`, () => {
    const ws = fakeWorkspaceWithState(
      '[msg_id: 398] stage: field-approval — NRECA, report 937 — Self Identify (5 of 6)\n  report: 937\n  job_url: https://example.com\n  data: {}',
    );
    try {
      const dispatch = { chatId: '1', cwd: ws, kind: 'routing', messages: [{ chatId: '1', text }], state: null };
      assert.equal(resolveReportForDispatch(dispatch), null);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
}

test('resolveReportForDispatch still resolves an explicit "/apply {report}" even though it IS a recognized command', () => {
  // The command guard only gates the pending-confirmation FALLBACK — the
  // explicit /apply {report} match above it must keep working.
  const ws = fakeWorkspaceWithState('(none)');
  try {
    const dispatch = { chatId: '1', cwd: ws, kind: 'routing', messages: [{ chatId: '1', text: '/apply 937' }], state: null };
    assert.equal(resolveReportForDispatch(dispatch), '937');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveReportForDispatch resolves the pending confirmation when ANY message in the batch is a free-text reply', () => {
  const ws = fakeWorkspaceWithState(
    '[msg_id: 398] stage: field-approval — NRECA, report 937 — Self Identify (5 of 6)\n  report: 937\n  job_url: https://example.com\n  data: {}',
  );
  try {
    const dispatch = {
      chatId: '1', cwd: ws, kind: 'routing',
      messages: [{ chatId: '1', text: '/status' }, { chatId: '1', text: 'yes' }],
      state: null,
    };
    assert.equal(resolveReportForDispatch(dispatch), '937');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('checkCdpAlive returns true against a REAL holder endpoint and false once that browser is gone', async () => {
  // Deliberately unmocked, against a real launched browser: every other
  // liveness test injects a fake checkCdpAlive, which is exactly why a wrong
  // connection API (chromium.connect() against a Chrome-native CDP URL, which
  // only times out) shipped undetected.
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-cdp-alive-'));
  let holder;
  try {
    holder = await launchHolder({ report: '937', workspaceCwd: ws });
    assert.equal(await checkCdpAlive(holder.endpoint), true);

    const deadEndpoint = holder.endpoint;
    await holder.browserServer.close();
    holder = null;
    assert.equal(await checkCdpAlive(deadEndpoint), false);
    assert.equal(await checkCdpAlive('ws://127.0.0.1:1/devtools/browser/nope'), false);
  } finally {
    if (holder) await holder.browserServer.close().catch(() => {});
    rmSync(ws, { recursive: true, force: true });
  }
});

function fakeWorkspaceDir() {
  return mkdtempSync(join(tmpdir(), 'career-ops-mcp-args-'));
}

test('resolveBrowserMcpArgs returns [] (no override) when report is null', async () => {
  const args = await resolveBrowserMcpArgs(null, '/fake', {});
  assert.deepEqual(args, []);
});

test('resolveBrowserMcpArgs reuses a live existing session, verified by BOTH pid and CDP checks', async () => {
  const ws = fakeWorkspaceDir();
  try {
    writeBrowserSessions(browserSessionsStatePath(ws), {
      '937': { endpoint: 'ws://127.0.0.1:1/fake', pid: 4242, createdAt: '2026-08-31T00:00:00.000Z' },
    });
    const args = await resolveBrowserMcpArgs('937', ws, {
      checkPidAlive: async (pid) => pid === 4242,
      checkCdpAlive: async (endpoint) => endpoint === 'ws://127.0.0.1:1/fake',
      spawnHolder: async () => { throw new Error('should not spawn — a live session already exists'); },
    });
    assert.equal(args.length, 3);
    assert.equal(args[0], '--mcp-config');
    assert.equal(args[2], '--strict-mcp-config');
    const config = JSON.parse(args[1]);
    assert.deepEqual(config.mcpServers.playwright.args, ['@playwright/mcp@latest', '--cdp-endpoint', 'ws://127.0.0.1:1/fake']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveBrowserMcpArgs treats a dead PID as gone, deletes the stale entry, and spawns fresh', async () => {
  const ws = fakeWorkspaceDir();
  try {
    writeBrowserSessions(browserSessionsStatePath(ws), {
      '937': { endpoint: 'ws://127.0.0.1:1/stale', pid: 9999, createdAt: '2026-08-31T00:00:00.000Z' },
    });
    let spawned = false;
    const args = await resolveBrowserMcpArgs('937', ws, {
      checkPidAlive: async () => false, // dead
      checkCdpAlive: async () => { throw new Error('should not even check CDP once the PID check already failed'); },
      spawnHolder: async () => { spawned = true; },
      waitForEndpoint: async () => 'ws://127.0.0.1:2/fresh',
    });
    assert.equal(spawned, true);
    assert.equal(JSON.parse(args[1]).mcpServers.playwright.args[2], 'ws://127.0.0.1:2/fresh');
    // The stale entry must be gone from the state file (not left for the
    // NEXT lookup to trip over again).
    const remaining = (await import('../core/apply-browser-holder.mjs')).readBrowserSessions(browserSessionsStatePath(ws));
    assert.equal(remaining['937'], undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveBrowserMcpArgs treats a failed CDP connection as gone even when the PID is alive (PID recycling)', async () => {
  const ws = fakeWorkspaceDir();
  try {
    writeBrowserSessions(browserSessionsStatePath(ws), {
      '937': { endpoint: 'ws://127.0.0.1:1/stale', pid: 4242, createdAt: '2026-08-31T00:00:00.000Z' },
    });
    let spawned = false;
    await resolveBrowserMcpArgs('937', ws, {
      checkPidAlive: async () => true, // a DIFFERENT process happens to reuse this PID
      checkCdpAlive: async () => false, // but it's not actually our browser
      spawnHolder: async () => { spawned = true; },
      waitForEndpoint: async () => 'ws://127.0.0.1:2/fresh',
    });
    assert.equal(spawned, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveBrowserMcpArgs spawns a fresh holder when no entry exists yet', async () => {
  const ws = fakeWorkspaceDir();
  try {
    let spawnedWith = null;
    const args = await resolveBrowserMcpArgs('937', ws, {
      spawnHolder: async (opts) => { spawnedWith = opts; },
      waitForEndpoint: async () => 'ws://127.0.0.1:3/brand-new',
    });
    assert.deepEqual(spawnedWith, { report: '937', workspaceCwd: ws });
    assert.equal(JSON.parse(args[1]).mcpServers.playwright.args[2], 'ws://127.0.0.1:3/brand-new');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveBrowserMcpArgs falls back to [] (no override) if spawning or waiting for the endpoint fails', async () => {
  const ws = fakeWorkspaceDir();
  try {
    const args = await quietErrors(() => resolveBrowserMcpArgs('937', ws, {
      spawnHolder: async () => {},
      waitForEndpoint: async () => { throw new Error('holder never wrote its endpoint in time'); },
    }));
    assert.deepEqual(args, []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('dispatchOne resolves and threads browser-session extraArgs for a ROUTING dispatch with a resolvable report', async () => {
  const calls = [];
  const fakeInvoke = async (prompt, cwd, timeoutMs, model, extraArgs) => { calls.push({ cwd, extraArgs }); };
  const dispatch = {
    chatId: '1', cwd: '/fake/workspace/alice', kind: 'routing',
    messages: [{ chatId: '1', text: '/apply 937' }], state: null,
  };
  await dispatchOne(dispatch, fakeInvoke, async () => ['--mcp-config', '{"fake":true}', '--strict-mcp-config'], () => {});
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].extraArgs, ['--mcp-config', '{"fake":true}', '--strict-mcp-config']);
});

test('dispatchOne passes an empty extraArgs array for an ONBOARDING dispatch — never resolves a browser session for onboarding', async () => {
  const calls = [];
  const fakeInvoke = async (prompt, cwd, timeoutMs, model, extraArgs) => { calls.push({ extraArgs }); };
  const dispatch = {
    chatId: '1', cwd: '/fake/workspace', kind: 'onboarding',
    messages: [{ chatId: '1', text: 'Alice' }], state: { currentStep: 'name' },
  };
  let resolveBrowserCalled = false;
  await dispatchOne(dispatch, fakeInvoke, async () => { resolveBrowserCalled = true; return []; });
  assert.equal(calls[0].extraArgs.length, 0);
  assert.equal(resolveBrowserCalled, false, 'onboarding never needs a browser session — resolving one would be wasted work on the hot path for every onboarding message');
});

// createPollErrorLogger — collapsing a run of identical poll-failure lines
// (found live 2026-09-04: a stuck webhook produced 21,190 consecutive
// byte-identical 409 lines over roughly a day with no alert of any kind).

test('createPollErrorLogger logs the first occurrence of a message immediately and returns streak 1', () => {
  const logged = [];
  const log = createPollErrorLogger((msg) => logged.push(msg));
  const streak = log('webhook is active');
  assert.equal(streak, 1);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /webhook is active/);
});

test('createPollErrorLogger suppresses repeats of the SAME message except every 20th, but keeps counting the streak', () => {
  const logged = [];
  const log = createPollErrorLogger((msg) => logged.push(msg));
  let lastStreak;
  for (let i = 0; i < 25; i++) lastStreak = log('webhook is active');
  assert.equal(lastStreak, 25, 'streak keeps counting even while logging is suppressed');
  // One line for the first occurrence, one more at the 20th repeat.
  assert.equal(logged.length, 2);
  assert.match(logged[1], /repeated 20x/);
});

test('createPollErrorLogger logs immediately and resets the streak when the message CHANGES', () => {
  const logged = [];
  const log = createPollErrorLogger((msg) => logged.push(msg));
  log('webhook is active');
  log('webhook is active');
  const streak = log('terminated by setWebhook request'); // the real transition event
  assert.equal(streak, 1, 'a genuinely new error must never be swallowed as a repeat');
  assert.equal(logged.length, 2);
  assert.match(logged[1], /terminated by setWebhook request/);
});

test('createPollErrorLogger: passing a falsy message resets the streak', () => {
  const logged = [];
  const log = createPollErrorLogger((msg) => logged.push(msg));
  log('webhook is active');
  log('webhook is active');
  const resetStreak = log(null);
  assert.equal(resetStreak, 0);
  const streak = log('webhook is active');
  assert.equal(streak, 1, 'streak must start over, not continue from before the reset');
});

// shouldAlertOperator / maybeAlertOperator

test('shouldAlertOperator is false below the threshold', () => {
  for (let i = 0; i < 12; i++) assert.equal(shouldAlertOperator(i), false);
});

test('shouldAlertOperator fires at the threshold, then again every repeat interval, never in between', () => {
  assert.equal(shouldAlertOperator(12), true);
  for (let i = 13; i < 72; i++) assert.equal(shouldAlertOperator(i), false, `must not fire again at ${i}`);
  assert.equal(shouldAlertOperator(72), true);
});

test('maybeAlertOperator does nothing when no operator chat_id is configured, even past threshold', async () => {
  let sent = false;
  await maybeAlertOperator(50, 'some error', null, async () => { sent = true; });
  assert.equal(sent, false);
});

test('maybeAlertOperator does nothing below threshold even with a configured chat_id', async () => {
  let sent = false;
  await maybeAlertOperator(3, 'some error', 'operator-chat', async () => { sent = true; });
  assert.equal(sent, false);
});

test('maybeAlertOperator sends to the operator chat_id once past threshold, including the error text', async () => {
  const calls = [];
  await maybeAlertOperator(12, 'webhook is active', 'operator-chat', async (chatId, text) => { calls.push({ chatId, text }); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, 'operator-chat');
  assert.match(calls[0].text, /webhook is active/);
});
