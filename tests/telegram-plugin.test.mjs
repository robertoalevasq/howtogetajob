import { test } from 'node:test';
import assert from 'node:assert/strict';
import telegramPlugin from '../plugins/telegram/index.mjs';
import { buildCtx } from '../plugins/_engine.mjs';

const MANIFEST = {
  id: 'telegram',
  requiredEnv: ['TELEGRAM_BOT_TOKEN'],
  optionalEnv: [],
  allowedHosts: ['api.telegram.org'],
  allowsLocalhost: false,
};

function withFakeFetch(responses, fn) {
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, opts) => {
    const handler = responses[Math.min(call, responses.length - 1)];
    call++;
    return handler(String(url), opts);
  };
  return fn().finally(() => { globalThis.fetch = original; });
}

test('notify() sends to payload.chatId, overriding ctx.settings entirely', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  const ctx = buildCtx(MANIFEST, { settings: { chat_id: 'configured-chat' } });
  const sentTo = [];
  await withFakeFetch([
    async (url, opts) => {
      const body = JSON.parse(opts.body);
      sentTo.push(body.chat_id);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    },
  ], () => telegramPlugin.notify({ message: 'hi', chatId: 'override-chat' }, ctx));
  assert.deepEqual(sentTo, ['override-chat']);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('notify() falls back to ctx.settings.chat_id when no override is given', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  const ctx = buildCtx(MANIFEST, { settings: { chat_id: 'configured-chat' } });
  const sentTo = [];
  await withFakeFetch([
    async (url, opts) => {
      const body = JSON.parse(opts.body);
      sentTo.push(body.chat_id);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    },
  ], () => telegramPlugin.notify({ message: 'hi' }, ctx));
  assert.deepEqual(sentTo, ['configured-chat']);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('ingest() no longer filters by chat_id — a message from an unconfigured chat still comes through', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  const ctx = buildCtx(MANIFEST, { settings: { chat_id: 'configured-chat' } });
  ctx.dryRun = true; // avoid persisting a real offset file for this test
  await withFakeFetch([
    async () => new Response(JSON.stringify({
      ok: true,
      result: [{
        update_id: 1,
        message: { message_id: 10, chat: { id: 'stranger-chat' }, text: 'hello', date: 0, from: { username: 'stranger' } },
      }],
    }), { status: 200 }),
  ], async () => {
    const result = await telegramPlugin.ingest(ctx);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].chatId, 'stranger-chat');
  });
  delete process.env.TELEGRAM_BOT_TOKEN;
});
