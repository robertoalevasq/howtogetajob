import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoutingPrompt, buildOnboardingPrompt, dispatchOne, sendCannedReply, fanOutDispatches,
} from '../core/telegram-monitor.mjs';

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

test('dispatchOne calls invoke with the onboarding prompt and the dispatch cwd for an onboarding dispatch', async () => {
  const calls = [];
  const fakeInvoke = async (prompt, cwd) => { calls.push({ prompt, cwd }); };
  const dispatch = {
    chatId: '1', cwd: '/fake/workspace', kind: 'onboarding',
    messages: [{ chatId: '1', text: 'Alice' }], state: { currentStep: 'name' },
  };
  await dispatchOne(dispatch, fakeInvoke);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/fake/workspace');
  assert.match(calls[0].prompt, /modes\/telegram-onboarding\.md/);
});

test('dispatchOne calls invoke with the routing prompt and the dispatch cwd for a routing dispatch', async () => {
  const calls = [];
  const fakeInvoke = async (prompt, cwd) => { calls.push({ prompt, cwd }); };
  const dispatch = {
    chatId: '1', cwd: '/fake/workspace/alice', kind: 'routing',
    messages: [{ chatId: '1', text: '/status' }], state: null,
  };
  await dispatchOne(dispatch, fakeInvoke);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/fake/workspace/alice');
  assert.match(calls[0].prompt, /modes\/telegram\.md/);
});

test('sendCannedReply runs the telegram notify hook with forceEnabled — the repo root has no config/plugins.yml', async () => {
  // Without forceEnabled the enabled-gate skips the telegram manifest at
  // REPO_ROOT, runHook returns [], nothing throws, and every wrong-code reply
  // is silently dropped. That is the regression this asserts against.
  const calls = [];
  const fakeHook = async (kind, payload, opts) => { calls.push({ kind, payload, opts }); return []; };
  await sendCannedReply('491507842', 'Please enter your access code to continue.', fakeHook);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'notify');
  assert.equal(calls[0].opts.only, 'telegram');
  assert.equal(calls[0].opts.forceEnabled, true);
  assert.equal(calls[0].opts.dryRun, false);
  assert.equal(calls[0].opts.root, calls[0].opts.workspaceRoot);
  assert.equal(calls[0].payload.chatId, '491507842');
  assert.match(calls[0].payload.message, /access code/i);
});

test('sendCannedReply swallows a failing hook rather than breaking the poll loop', async () => {
  await quietErrors(async () => {
    await assert.doesNotReject(
      sendCannedReply('1', 'hi', async () => { throw new Error('network down'); }),
    );
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
