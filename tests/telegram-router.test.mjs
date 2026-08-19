import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBoundChatMap, readOnboardingState, writeOnboardingState, deleteOnboardingState,
  isLockedOut, recordWrongAttempt, routeMessages,
} from '../core/telegram-router.mjs';
import { provisionWorkspace } from '../core/provision-workspace.mjs';
import { accessCodeAttemptsPath } from '../core/hub-paths.mjs';
import { generateAccessCode, listAccessCodes } from '../core/access-code.mjs';

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

function msg(chatId, text) {
  return { chatId, text, messageId: 1, updateId: 1, date: 0, replyToMessageId: null, from: 'tester', isCommand: false };
}

test('routeMessages routes a bound chat to its workspace with kind "routing"', async () => {
  const repoRoot = fakeRepo();
  try {
    provisionWorkspace('alice', { reposRoot: repoRoot, chatId: '111' });
    const dispatches = await routeMessages([msg('111', '/status')], { repoRoot });
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].kind, 'routing');
    assert.equal(dispatches[0].cwd, join(repoRoot, 'workspaces', 'alice'));
    assert.equal(dispatches[0].chatId, '111');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('routeMessages groups multiple messages from the same bound chat into one dispatch', async () => {
  const repoRoot = fakeRepo();
  try {
    provisionWorkspace('alice', { reposRoot: repoRoot, chatId: '111' });
    const dispatches = await routeMessages([msg('111', 'a'), msg('111', 'b')], { repoRoot });
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].messages.length, 2);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('routeMessages splits messages from two different bound chats into two dispatches', async () => {
  const repoRoot = fakeRepo();
  try {
    provisionWorkspace('alice', { reposRoot: repoRoot, chatId: '111' });
    provisionWorkspace('bob', { reposRoot: repoRoot, chatId: '222' });
    const dispatches = await routeMessages([msg('111', 'a'), msg('222', 'b')], { repoRoot });
    assert.equal(dispatches.length, 2);
    const cwds = dispatches.map(d => d.cwd).sort();
    assert.deepEqual(cwds, [join(repoRoot, 'workspaces', 'alice'), join(repoRoot, 'workspaces', 'bob')].sort());
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('routeMessages resumes mid-onboarding with cwd = repo root when no slug is set yet', async () => {
  const repoRoot = fakeRepo();
  try {
    writeOnboardingState('999', { chatId: '999', slug: null, currentStep: 'name' }, { repoRoot });
    const dispatches = await routeMessages([msg('999', 'Alice')], { repoRoot });
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].kind, 'onboarding');
    assert.equal(dispatches[0].cwd, repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('routeMessages resumes mid-onboarding with cwd = the workspace once a slug is set', async () => {
  const repoRoot = fakeRepo();
  try {
    provisionWorkspace('alice', { reposRoot: repoRoot }); // no chat_id yet — unbound
    writeOnboardingState('999', { chatId: '999', slug: 'alice', currentStep: 'cv' }, { repoRoot });
    const dispatches = await routeMessages([msg('999', 'my resume text')], { repoRoot });
    assert.equal(dispatches[0].cwd, join(repoRoot, 'workspaces', 'alice'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('routeMessages redeems a valid code, starts onboarding, and dispatches to Claude', async () => {
  const repoRoot = fakeRepo();
  try {
    const entry = await generateAccessCode('for-carol', { repoRoot });
    const dispatches = await routeMessages([msg('333', entry.code)], { repoRoot });
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].kind, 'onboarding');
    assert.equal(dispatches[0].state.redeemedCode, entry.code);
    assert.equal(readOnboardingState('333', { repoRoot }).currentStep, 'name');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('routeMessages sends a canned reply and does not dispatch to Claude for a wrong code', async () => {
  const repoRoot = fakeRepo();
  try {
    const replies = [];
    const dispatches = await routeMessages(
      [msg('444', 'not-a-real-code')],
      { repoRoot, sendReply: async (chatId, text) => { replies.push({ chatId, text }); } },
    );
    assert.equal(dispatches.length, 0);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].chatId, '444');
    assert.match(replies[0].text, /access code/i);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('routeMessages drops messages silently once a chat is locked out — no reply, no dispatch', async () => {
  const repoRoot = fakeRepo();
  try {
    for (let i = 0; i < 5; i++) recordWrongAttempt('555', { repoRoot });
    const replies = [];
    const dispatches = await routeMessages(
      [msg('555', 'guess-again')],
      { repoRoot, sendReply: async (chatId, text) => { replies.push({ chatId, text }); } },
    );
    assert.equal(dispatches.length, 0);
    assert.equal(replies.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('routeMessages never redeems a code for a chat that is currently locked out', async () => {
  const repoRoot = fakeRepo();
  try {
    const entry = await generateAccessCode('for-dave', { repoRoot });
    for (let i = 0; i < 5; i++) recordWrongAttempt('666', { repoRoot });
    const dispatches = await routeMessages([msg('666', entry.code)], { repoRoot });
    assert.equal(dispatches.length, 0);
    const codes = await listAccessCodes({ repoRoot });
    assert.equal(codes.find(c => c.code === entry.code).status, 'pending');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
