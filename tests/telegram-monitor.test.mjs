import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutingPrompt } from '../core/telegram-monitor.mjs';

test('buildRoutingPrompt embeds the HEADLESS marker and the given messages as JSON', () => {
  const messages = [{ chatId: '1', text: '/status' }];
  const prompt = buildRoutingPrompt(messages);
  assert.match(prompt, /\[HEADLESS\]/);
  assert.match(prompt, /modes\/telegram\.md/);
  assert.ok(prompt.includes(JSON.stringify(messages, null, 2)));
});
