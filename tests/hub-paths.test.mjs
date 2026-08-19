import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { telegramOffsetPath, telegramDaemonLockPath, accessCodesPath, accessCodeAttemptsPath, onboardingDir, onboardingStatePath } from '../core/hub-paths.mjs';

// REPO_ROOT, not core/ itself: hub-paths.mjs lives at core/hub-paths.mjs
// (#workspace-multitenancy Task 1), and its two paths must land at the true
// repo-root data/ — the same locations they resolved to before Task 1's
// move, matching REPO_ROOT in telegram-monitor.mjs and discord-ticker.mjs.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// os.tmpdir() rather than a hardcoded '/tmp': on Windows, process.chdir('/tmp')
// throws ENOENT (no C:\tmp), so the portable temp dir is what actually proves
// "regardless of cwd" here — same intent as the brief's test, portable path.
const AWAY_FROM_REPO = tmpdir();

test('telegramOffsetPath resolves under the repo-root data/ regardless of cwd', () => {
  const original = process.cwd();
  process.chdir(AWAY_FROM_REPO);
  try {
    const p = telegramOffsetPath();
    assert.equal(p, join(REPO_ROOT, 'data', 'telegram-offset.json'));
  } finally {
    process.chdir(original);
  }
});

test('telegramDaemonLockPath resolves under the repo-root data/ regardless of cwd', () => {
  const original = process.cwd();
  process.chdir(AWAY_FROM_REPO);
  try {
    const p = telegramDaemonLockPath();
    assert.equal(p, join(REPO_ROOT, 'data', 'telegram-daemon'));
  } finally {
    process.chdir(original);
  }
});

test('paths are unaffected by CAREER_OPS_WORKSPACE', () => {
  process.env.CAREER_OPS_WORKSPACE = '/some/other/workspace';
  try {
    const p = telegramOffsetPath();
    assert.equal(p, join(REPO_ROOT, 'data', 'telegram-offset.json'));
  } finally {
    delete process.env.CAREER_OPS_WORKSPACE;
  }
});

test('accessCodesPath resolves under the repo-root data/ regardless of cwd', () => {
  const original = process.cwd();
  process.chdir(AWAY_FROM_REPO);
  try {
    assert.equal(accessCodesPath(), join(REPO_ROOT, 'data', 'access-codes.json'));
  } finally {
    process.chdir(original);
  }
});

test('accessCodeAttemptsPath resolves under the repo-root data/', () => {
  assert.equal(accessCodeAttemptsPath(), join(REPO_ROOT, 'data', 'access-code-attempts.json'));
});

test('onboardingDir and onboardingStatePath resolve under the repo-root data/onboarding/', () => {
  assert.equal(onboardingDir(), join(REPO_ROOT, 'data', 'onboarding'));
  assert.equal(onboardingStatePath('12345'), join(REPO_ROOT, 'data', 'onboarding', '12345.json'));
});

test('all four accept a repoRoot override for test isolation', () => {
  const fakeRoot = join(tmpdir(), 'fake-repo');
  assert.equal(accessCodesPath({ repoRoot: fakeRoot }), join(fakeRoot, 'data', 'access-codes.json'));
  assert.equal(accessCodeAttemptsPath({ repoRoot: fakeRoot }), join(fakeRoot, 'data', 'access-code-attempts.json'));
  assert.equal(onboardingDir({ repoRoot: fakeRoot }), join(fakeRoot, 'data', 'onboarding'));
  assert.equal(onboardingStatePath('99', { repoRoot: fakeRoot }), join(fakeRoot, 'data', 'onboarding', '99.json'));
});
