import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { broadcast } from '../core/broadcast.mjs';

// `fn` is async here (unlike Task 1's/Task 3's sync `withTempDir`/`withTempRepo`
// helpers) — the `finally` must `await` it, otherwise rmSync would delete the
// temp dir before the async test body actually runs its assertions.
async function withTempRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'broadcast-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedWorkspace(root, slug, chatId) {
  const wsDir = join(root, 'workspaces', slug);
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ slug, chat_id: chatId }));
}

test('broadcast sends to every workspace with a bound chat_id', async () => {
  await withTempRoot(async (dir) => {
    seedWorkspace(dir, 'alice', '111');
    seedWorkspace(dir, 'bob', '222');
    const sentCalls = [];
    const send = async (chatId, text) => { sentCalls.push({ chatId, text }); };

    const { sent, skipped } = await broadcast('hello', { reposRoot: dir, send });
    assert.equal(sentCalls.length, 2);
    assert.deepEqual(sentCalls.map((c) => c.chatId).sort(), ['111', '222']);
    assert.equal(sent.length, 2);
    assert.equal(skipped.length, 0);
  });
});

test('broadcast skips a workspace with no chat_id bound yet, without erroring', async () => {
  await withTempRoot(async (dir) => {
    seedWorkspace(dir, 'alice', '111');
    seedWorkspace(dir, 'pending', null);
    const sentCalls = [];
    const send = async (chatId, text) => { sentCalls.push({ chatId, text }); };

    const { sent, skipped } = await broadcast('hello', { reposRoot: dir, send });
    assert.equal(sentCalls.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].slug, 'pending');
  });
});

test('broadcast --dry-run (dryRun: true) sends nothing', async () => {
  await withTempRoot(async (dir) => {
    seedWorkspace(dir, 'alice', '111');
    const sentCalls = [];
    const send = async (chatId, text) => { sentCalls.push({ chatId, text }); };

    const { sent } = await broadcast('hello', { reposRoot: dir, send, dryRun: true });
    assert.equal(sentCalls.length, 0);
    assert.equal(sent.length, 1); // reported as "would send" without calling send()
  });
});

test('broadcast counts a send that returns false as skipped, not sent', async () => {
  // This is the REAL failure signal: sendCannedReply catches internally and
  // returns false (missing bot token, unresolvable chat) — it does not throw.
  // Before this, every workspace with a chat_id landed in `sent` even when
  // nothing was delivered.
  await withTempRoot(async (dir) => {
    seedWorkspace(dir, 'alice', '111');
    seedWorkspace(dir, 'bob', '222');
    const send = async (chatId) => chatId !== '111';

    const { sent, skipped } = await broadcast('hello', { reposRoot: dir, send });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, '222');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].slug, 'alice');
    assert.match(skipped[0].reason, /send failed/i);
  });
});

test('broadcast continues to the next workspace if one send throws', async () => {
  // Defensive: the real send does not throw, but a caller-injected one can.
  await withTempRoot(async (dir) => {
    seedWorkspace(dir, 'alice', '111');
    seedWorkspace(dir, 'bob', '222');
    const send = async (chatId) => {
      if (chatId === '111') throw new Error('telegram down');
    };

    const { sent, skipped } = await broadcast('hello', { reposRoot: dir, send });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, '222');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].slug, 'alice');
    assert.match(skipped[0].reason, /telegram down/);
  });
});

test('broadcast treats a send resolving undefined as sent — only an explicit false is a failure', async () => {
  await withTempRoot(async (dir) => {
    seedWorkspace(dir, 'alice', '111');
    const send = async () => { /* resolves undefined */ };

    const { sent, skipped } = await broadcast('hello', { reposRoot: dir, send });
    assert.equal(sent.length, 1);
    assert.equal(skipped.length, 0);
  });
});
