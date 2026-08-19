import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBoundChatMap, readOnboardingState, writeOnboardingState, deleteOnboardingState,
  isLockedOut, recordWrongAttempt,
} from '../core/telegram-router.mjs';
import { provisionWorkspace } from '../core/provision-workspace.mjs';
import { accessCodeAttemptsPath } from '../core/hub-paths.mjs';

function fakeRepo() {
  return mkdtempSync(join(tmpdir(), 'career-ops-router-'));
}

test('buildBoundChatMap is empty when workspaces/ does not exist', () => {
  const repoRoot = fakeRepo();
  try {
    const map = buildBoundChatMap({ repoRoot });
    assert.equal(map.size, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildBoundChatMap maps only workspaces with a non-null chat_id', () => {
  const repoRoot = fakeRepo();
  try {
    provisionWorkspace('alice', { reposRoot: repoRoot, chatId: '111' });
    provisionWorkspace('bob', { reposRoot: repoRoot }); // chat_id stays null
    const map = buildBoundChatMap({ repoRoot });
    assert.equal(map.size, 1);
    assert.equal(map.get('111'), join(repoRoot, 'workspaces', 'alice'));
    assert.equal(map.has('bob'), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildBoundChatMap skips a workspace with corrupt workspace.json rather than throwing', () => {
  const repoRoot = fakeRepo();
  try {
    provisionWorkspace('alice', { reposRoot: repoRoot, chatId: '111' });
    const corruptDir = join(repoRoot, 'workspaces', 'corrupt');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'workspace.json'), 'not json{{{');
    const map = buildBoundChatMap({ repoRoot });
    assert.equal(map.get('111'), join(repoRoot, 'workspaces', 'alice'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('onboarding state round-trips: write, read, delete', () => {
  const repoRoot = fakeRepo();
  try {
    assert.equal(readOnboardingState('42', { repoRoot }), null);
    writeOnboardingState('42', { chatId: '42', currentStep: 'name' }, { repoRoot });
    assert.deepEqual(readOnboardingState('42', { repoRoot }), { chatId: '42', currentStep: 'name' });
    deleteOnboardingState('42', { repoRoot });
    assert.equal(readOnboardingState('42', { repoRoot }), null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('deleteOnboardingState on a chat with no state is a safe no-op', () => {
  const repoRoot = fakeRepo();
  try {
    assert.doesNotThrow(() => deleteOnboardingState('no-such-chat', { repoRoot }));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('isLockedOut is false with no attempt history', () => {
  const repoRoot = fakeRepo();
  try {
    assert.equal(isLockedOut('1', { repoRoot }), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('recordWrongAttempt locks out on the 5th attempt and resets the counter', () => {
  const repoRoot = fakeRepo();
  try {
    let result;
    for (let i = 0; i < 5; i++) result = recordWrongAttempt('1', { repoRoot });
    assert.equal(result.justLockedOut, true);
    assert.equal(isLockedOut('1', { repoRoot }), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('recordWrongAttempt does not lock out before the threshold', () => {
  const repoRoot = fakeRepo();
  try {
    for (let i = 0; i < 4; i++) recordWrongAttempt('1', { repoRoot });
    assert.equal(isLockedOut('1', { repoRoot }), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('lockout is per-chat — one chat locking out never affects another', () => {
  const repoRoot = fakeRepo();
  try {
    for (let i = 0; i < 5; i++) recordWrongAttempt('locked-chat', { repoRoot });
    assert.equal(isLockedOut('locked-chat', { repoRoot }), true);
    assert.equal(isLockedOut('other-chat', { repoRoot }), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('a lockout that has already expired is treated as not locked out', () => {
  const repoRoot = fakeRepo();
  try {
    for (let i = 0; i < 5; i++) recordWrongAttempt('1', { repoRoot });
    // Manually back-date the stored lockedUntil into the past.
    const path = accessCodeAttemptsPath({ repoRoot });
    const attempts = JSON.parse(readFileSync(path, 'utf-8'));
    attempts['1'].lockedUntil = new Date(Date.now() - 1000).toISOString();
    writeFileSync(path, JSON.stringify(attempts, null, 2));
    assert.equal(isLockedOut('1', { repoRoot }), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
