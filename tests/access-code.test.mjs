import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateAccessCode, listAccessCodes, revokeAccessCode, redeemAccessCode, getBotUsername,
} from '../core/access-code.mjs';
import { accessCodesPath, botIdentityCachePath } from '../core/hub-paths.mjs';

function fakeRepo() {
  return mkdtempSync(join(tmpdir(), 'career-ops-codes-'));
}

test('generateAccessCode produces a 24-char code from the expected charset, expiring in 7 days', async () => {
  const repoRoot = fakeRepo();
  try {
    const entry = await generateAccessCode('Alice', { repoRoot });
    assert.equal(entry.code.length, 24);
    assert.match(entry.code, /^[A-HJ-NP-Za-km-z2-9]{24}$/);
    assert.equal(entry.label, 'Alice');
    assert.equal(entry.redeemedBy, null);
    const days = (new Date(entry.expiresAt) - new Date(entry.createdAt)) / (24 * 60 * 60 * 1000);
    assert.ok(Math.abs(days - 7) < 0.01, `expected ~7 day expiry, got ${days}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('generateAccessCode persists to access-codes.json', async () => {
  const repoRoot = fakeRepo();
  try {
    const entry = await generateAccessCode(null, { repoRoot });
    const raw = JSON.parse(readFileSync(accessCodesPath({ repoRoot }), 'utf-8'));
    assert.equal(raw.length, 1);
    assert.equal(raw[0].code, entry.code);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('listAccessCodes categorizes pending/redeemed/expired correctly', async () => {
  const repoRoot = fakeRepo();
  try {
    const pending = await generateAccessCode('pending', { repoRoot });
    const toRedeem = await generateAccessCode('will-redeem', { repoRoot });
    await redeemAccessCode(toRedeem.code, 'chat1', { repoRoot });

    const codes = await listAccessCodes({ repoRoot });
    const byCode = Object.fromEntries(codes.map(c => [c.code, c]));
    assert.equal(byCode[pending.code].status, 'pending');
    assert.equal(byCode[toRedeem.code].status, 'redeemed');
    assert.equal(byCode[toRedeem.code].redeemedBy, 'chat1');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('revokeAccessCode force-expires a pending code, preventing later redemption', async () => {
  const repoRoot = fakeRepo();
  try {
    const entry = await generateAccessCode('revoke-me', { repoRoot });
    await revokeAccessCode(entry.code, { repoRoot });
    const redeemed = await redeemAccessCode(entry.code, 'chat1', { repoRoot });
    assert.equal(redeemed, null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('revokeAccessCode throws on an already-redeemed code', async () => {
  const repoRoot = fakeRepo();
  try {
    const entry = await generateAccessCode('r', { repoRoot });
    await redeemAccessCode(entry.code, 'chat1', { repoRoot });
    await assert.rejects(() => revokeAccessCode(entry.code, { repoRoot }), /already redeemed/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('revokeAccessCode throws on an unknown code', async () => {
  const repoRoot = fakeRepo();
  try {
    await assert.rejects(() => revokeAccessCode('not-a-real-code', { repoRoot }), /No such code/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('redeemAccessCode returns null for wrong text', async () => {
  const repoRoot = fakeRepo();
  try {
    await generateAccessCode('x', { repoRoot });
    const result = await redeemAccessCode('totally-wrong-guess', 'chat1', { repoRoot });
    assert.equal(result, null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('redeemAccessCode returns null for an already-redeemed code, even for a different chat', async () => {
  const repoRoot = fakeRepo();
  try {
    const entry = await generateAccessCode('x', { repoRoot });
    await redeemAccessCode(entry.code, 'chat1', { repoRoot });
    const second = await redeemAccessCode(entry.code, 'chat2', { repoRoot });
    assert.equal(second, null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('getBotUsername returns the cached value without calling fetch', async () => {
  const repoRoot = fakeRepo();
  const originalFetch = global.fetch;
  try {
    mkdirSync(join(repoRoot, 'data'), { recursive: true });
    writeFileSync(botIdentityCachePath({ repoRoot }), JSON.stringify({ username: 'CachedBot', cachedAt: new Date().toISOString() }));
    global.fetch = async () => { throw new Error('fetch should not be called when the cache is warm'); };
    const username = await getBotUsername({ repoRoot });
    assert.equal(username, 'CachedBot');
  } finally {
    global.fetch = originalFetch;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('getBotUsername fetches getMe, returns the username, and writes it to the cache', async () => {
  const repoRoot = fakeRepo();
  const originalFetch = global.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'fake-token-for-test';
    global.fetch = async (url) => {
      assert.ok(String(url).includes('fake-token-for-test'), 'should call getMe with the configured token');
      return { json: async () => ({ ok: true, result: { username: 'FreshBot', first_name: 'Job App Assistant' } }) };
    };
    const username = await getBotUsername({ repoRoot });
    assert.equal(username, 'FreshBot');
    const cached = JSON.parse(readFileSync(botIdentityCachePath({ repoRoot }), 'utf-8'));
    assert.equal(cached.username, 'FreshBot');
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('getBotUsername returns null (never throws) when no token is configured and .env has none either', async () => {
  const repoRoot = fakeRepo();
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const username = await getBotUsername({ repoRoot });
    assert.equal(username, null);
  } finally {
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('getBotUsername returns null (never throws) when the getMe call fails', async () => {
  const repoRoot = fakeRepo();
  const originalFetch = global.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'fake-token-for-test';
    global.fetch = async () => { throw new Error('simulated network failure'); };
    const username = await getBotUsername({ repoRoot });
    assert.equal(username, null);
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('concurrent redemption of the same code: exactly one wins', async () => {
  const repoRoot = fakeRepo();
  try {
    const entry = await generateAccessCode('race', { repoRoot });
    const [a, b] = await Promise.all([
      redeemAccessCode(entry.code, 'chatA', { repoRoot }),
      redeemAccessCode(entry.code, 'chatB', { repoRoot }),
    ]);
    const winners = [a, b].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one of the two concurrent redemptions should succeed');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
