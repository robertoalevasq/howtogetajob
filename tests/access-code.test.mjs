import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateAccessCode, listAccessCodes, revokeAccessCode, redeemAccessCode,
} from '../core/access-code.mjs';
import { accessCodesPath } from '../core/hub-paths.mjs';

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
