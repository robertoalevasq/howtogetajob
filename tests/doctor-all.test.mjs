import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, checkAllWorkspaces, checkTelegramWebhook } from '../core/doctor-all.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-all-'));
  try {
    // doctor.mjs and its own template reads (config/profile.example.yml,
    // templates/portals.example.yml, modes/_profile.template.md,
    // modes/_brief.template.md) resolve off doctor.mjs's OWN real location,
    // not off --target — so the real repo's core/, config/, templates/,
    // modes/ must be reachable. Point doctor.mjs at the real files by
    // running it from the real REPO_ROOT and only pointing --target at the
    // fixture workspace directory (this is exactly how doctor.mjs is used
    // against a real workspaces/{slug}/ dir in production).
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('runDoctor returns parsed JSON for a workspace missing every prerequisite', () => {
  withTempRepo((dir) => {
    const wsDir = join(dir, 'empty-workspace');
    mkdirSync(wsDir, { recursive: true });
    const { doctor, error } = runDoctor(wsDir, REPO_ROOT);
    assert.equal(error, null);
    assert.equal(doctor.onboardingNeeded, true);
    assert.ok(doctor.missing.includes('cv.md'));
  });
});

test('runDoctor reports an error instead of throwing when doctor.mjs cannot run', () => {
  const { doctor, error } = runDoctor('/definitely/does/not/exist', '/also/does/not/exist');
  assert.equal(doctor, null);
  assert.ok(error);
});

test('checkAllWorkspaces marks a workspace unhealthy when doctor.mjs reports onboardingNeeded', () => {
  withTempRepo((dir) => {
    const wsDir = join(dir, 'workspaces', 'incomplete');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ slug: 'incomplete' }));

    const results = checkAllWorkspaces(dir, REPO_ROOT);
    assert.equal(results.length, 1);
    assert.equal(results[0].slug, 'incomplete');
    assert.equal(results[0].healthy, false);
    assert.equal(results[0].doctor.onboardingNeeded, true);
  });
});

test('checkAllWorkspaces one broken workspace does not suppress the others', () => {
  withTempRepo((dir) => {
    for (const slug of ['broken', 'other']) {
      const wsDir = join(dir, 'workspaces', slug);
      mkdirSync(wsDir, { recursive: true });
      writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ slug }));
    }
    const results = checkAllWorkspaces(dir, REPO_ROOT);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.slug).sort(), ['broken', 'other']);
  });
});

test('checkAllWorkspaces includes template-drift findings from backfill-templates.mjs', () => {
  withTempRepo((dir) => {
    const wsDir = join(dir, 'workspaces', 'drifted');
    mkdirSync(join(wsDir, 'config'), { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ slug: 'drifted' }));
    // A profile.yml missing a field that config/profile.example.yml (real
    // repo file) has — real repo template, so this WILL show drift.
    writeFileSync(join(wsDir, 'config', 'profile.yml'), 'candidate:\n  name: Test\n');

    const results = checkAllWorkspaces(dir, REPO_ROOT);
    const [result] = results;
    assert.ok(result.drift.some((d) => d.file === 'config/profile.yml' && d.missing.length > 0));
    assert.equal(result.healthy, false);
  });
});

// checkTelegramWebhook — hub-global detection of a stray webhook that blocks
// getUpdates polling for EVERY workspace (found live 2026-09-04, a whole
// hub silently stopped routing Telegram commands for roughly a day).

test('checkTelegramWebhook reports checked:false when the hub has no .env file', async () => {
  await withTempRepo(async (dir) => {
    const result = await checkTelegramWebhook(dir, async () => { throw new Error('must not fetch without a token'); });
    assert.equal(result.checked, false);
    assert.match(result.reason, /no \.env file/);
  });
});

test('checkTelegramWebhook reports checked:false when TELEGRAM_BOT_TOKEN is absent from .env', async () => {
  await withTempRepo(async (dir) => {
    writeFileSync(join(dir, '.env'), 'SOME_OTHER_KEY=value\n');
    const result = await checkTelegramWebhook(dir, async () => { throw new Error('must not fetch without a token'); });
    assert.equal(result.checked, false);
    assert.match(result.reason, /TELEGRAM_BOT_TOKEN/);
  });
});

test('checkTelegramWebhook reports healthy:true when no webhook is set', async () => {
  await withTempRepo(async (dir) => {
    writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=fake-token\n');
    const fakeFetch = async () => new Response(JSON.stringify({ ok: true, result: { url: '' } }), { status: 200 });
    const result = await checkTelegramWebhook(dir, fakeFetch);
    assert.equal(result.checked, true);
    assert.equal(result.healthy, true);
  });
});

test('checkTelegramWebhook flags an active webhook as unhealthy, with the URL and message surfaced', async () => {
  await withTempRepo(async (dir) => {
    writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=fake-token\n');
    const fakeFetch = async () => new Response(JSON.stringify({
      ok: true,
      result: { url: 'https://stuck-tunnel.example/hook', pending_update_count: 5, last_error_message: 'Connection reset by peer' },
    }), { status: 200 });
    const result = await checkTelegramWebhook(dir, fakeFetch);
    assert.equal(result.checked, true);
    assert.equal(result.healthy, false);
    assert.equal(result.webhookUrl, 'https://stuck-tunnel.example/hook');
    assert.equal(result.pendingUpdateCount, 5);
    assert.match(result.message, /blocks getUpdates polling for EVERY workspace/);
  });
});

test('checkTelegramWebhook reports checked:false, never throws, on a network failure', async () => {
  await withTempRepo(async (dir) => {
    writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=fake-token\n');
    const result = await checkTelegramWebhook(dir, async () => { throw new Error('ECONNRESET'); });
    assert.equal(result.checked, false);
    assert.match(result.reason, /ECONNRESET/);
  });
});

test('checkAllWorkspaces reports autoCopied templates in doctor output', () => {
  withTempRepo((dir) => {
    const wsDir = join(dir, 'workspaces', 'auto-copied');
    const modesDir = join(wsDir, 'modes');
    mkdirSync(modesDir, { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({ slug: 'auto-copied' }));
    // Create a modes/_profile.template.md so doctor.mjs can auto-copy it
    // when _profile.md is missing (which it is).
    writeFileSync(join(modesDir, '_profile.template.md'), '# Test profile template\n');

    const results = checkAllWorkspaces(dir, REPO_ROOT);
    const [result] = results;
    // doctor.mjs will have auto-copied _profile.md from the template,
    // so it should appear in autoCopied array.
    assert.ok(result.doctor?.autoCopied?.includes('_profile.md'));
  });
});
