import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutingPrompt, buildOnboardingPrompt, dispatchOne } from '../core/telegram-monitor.mjs';

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
