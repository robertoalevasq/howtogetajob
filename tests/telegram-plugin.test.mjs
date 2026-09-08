import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import telegramPlugin from '../plugins/telegram/index.mjs';
import { buildCtx, computeForeignBoundChatIds } from '../plugins/_engine.mjs';

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

// Cross-tenant guard (added 2026-08-28) — found live: a real workspace's own
// config/plugins.yml chat_ids array (an intentional multi-device broadcast
// list, notify() sends to every entry) contained a DIFFERENT workspace's
// chat_id, so one candidate's /run results were delivered into someone
// else's Telegram chat. ctx.foreignBoundChatIds is how the engine tells this
// plugin which recipients are off-limits; these tests exercise the
// enforcement in isolation, without needing real workspace fixtures.

test('notify() refuses every chat_id in ctx.foreignBoundChatIds and sends nothing', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  const ctx = buildCtx(MANIFEST, {
    settings: { chat_ids: ['victim-chat'] },
    foreignBoundChatIds: new Set(['victim-chat']),
  });
  let fetchCalled = false;
  const result = await withFakeFetch([
    async () => { fetchCalled = true; return new Response('{}', { status: 200 }); },
  ], () => telegramPlugin.notify({ message: 'leaked results' }, ctx));
  assert.equal(fetchCalled, false, 'must not attempt any network send when every target is blocked');
  assert.equal(result.sent, false);
  assert.match(result.error, /victim-chat/);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('notify() sends only to the non-foreign chat_ids in a mixed list', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  const ctx = buildCtx(MANIFEST, {
    settings: { chat_ids: ['own-chat', 'victim-chat'] },
    foreignBoundChatIds: new Set(['victim-chat']),
  });
  const sentTo = [];
  const result = await withFakeFetch([
    async (url, opts) => {
      const body = JSON.parse(opts.body);
      sentTo.push(body.chat_id);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    },
  ], () => telegramPlugin.notify({ message: 'hi' }, ctx));
  assert.deepEqual(sentTo, ['own-chat']);
  assert.equal(result.sent, true);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('notify() applies the guard to an explicit payload.chatId override too, not just config', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  const ctx = buildCtx(MANIFEST, {
    settings: { chat_id: 'configured-chat' },
    foreignBoundChatIds: new Set(['override-chat']),
  });
  let fetchCalled = false;
  const result = await withFakeFetch([
    async () => { fetchCalled = true; return new Response('{}', { status: 200 }); },
  ], () => telegramPlugin.notify({ message: 'hi', chatId: 'override-chat' }, ctx));
  assert.equal(fetchCalled, false, 'an override must not bypass the guard');
  assert.equal(result.sent, false);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('notify() still sends normally when ctx.foreignBoundChatIds is empty (default, non-multi-tenant case)', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  const ctx = buildCtx(MANIFEST, { settings: { chat_id: 'configured-chat' } }); // no foreignBoundChatIds passed at all
  assert.ok(ctx.foreignBoundChatIds instanceof Set, 'ctx must always carry a Set, even when the caller passes nothing');
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

test('computeForeignBoundChatIds() finds a chat_id bound to a different workspace, excludes the current one', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-guard-test-'));
  try {
    const workspacesDir = join(root, 'workspaces');
    for (const [slug, chatId] of [['alice', 'chat-alice'], ['bob', 'chat-bob']]) {
      const dir = join(workspacesDir, slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ slug, chat_id: chatId }));
    }
    const foreignForAlice = computeForeignBoundChatIds(root, join(workspacesDir, 'alice'));
    assert.ok(foreignForAlice.has('chat-bob'), 'bob\'s chat_id must be foreign from alice\'s workspace');
    assert.ok(!foreignForAlice.has('chat-alice'), 'a workspace\'s own bound chat_id must never be foreign to itself');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ingest() self-heal for a stray active webhook (found live 2026-09-04: a
// webhook left active by something outside career-ops entirely permanently
// blocked getUpdates for the WHOLE hub — every workspace — until manually
// cleared, roughly a day of silent outage). See plugins/telegram/index.mjs's
// ingest() for the fix: catch this specific 409, call deleteWebhook, retry
// getUpdates once.

test('ingest() self-heals a "webhook is active" 409 by calling deleteWebhook and retrying getUpdates once', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  const ctx = buildCtx(MANIFEST, { settings: {} });
  ctx.dryRun = true;
  const urlsCalled = [];
  await withFakeFetch([
    async (url) => {
      urlsCalled.push(url);
      return new Response(JSON.stringify({
        ok: false, error_code: 409,
        description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
      }), { status: 409 });
    },
    async (url) => {
      urlsCalled.push(url);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    },
    async (url) => {
      urlsCalled.push(url);
      return new Response(JSON.stringify({
        ok: true,
        result: [{ update_id: 1, message: { message_id: 10, chat: { id: 'chat-1' }, text: '/status', date: 0, from: { username: 'ernesto' } } }],
      }), { status: 200 });
    },
  ], async () => {
    const result = await telegramPlugin.ingest(ctx);
    assert.equal(result.messages.length, 1, 'the retried getUpdates call\'s messages must come through');
    assert.equal(result.messages[0].text, '/status');
  });
  assert.equal(urlsCalled.length, 3);
  assert.match(urlsCalled[0], /getUpdates/);
  assert.match(urlsCalled[1], /deleteWebhook/);
  assert.match(urlsCalled[2], /getUpdates/);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('ingest() does NOT call deleteWebhook for a DIFFERENT 409 (e.g. a real concurrent poller) — just propagates it', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  const ctx = buildCtx(MANIFEST, { settings: {} });
  ctx.dryRun = true;
  const urlsCalled = [];
  await assert.rejects(
    withFakeFetch([
      async (url) => {
        urlsCalled.push(url);
        return new Response(JSON.stringify({
          ok: false, error_code: 409,
          description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
        }), { status: 409 });
      },
    ], () => telegramPlugin.ingest(ctx)),
    /terminated by other getUpdates request/,
  );
  assert.equal(urlsCalled.length, 1, 'must not attempt deleteWebhook for an unrelated 409');
  delete process.env.TELEGRAM_BOT_TOKEN;
});

test('computeForeignBoundChatIds() fails open to an empty set when workspaces/ does not exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-guard-test-'));
  try {
    const foreign = computeForeignBoundChatIds(root, root);
    assert.equal(foreign.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
