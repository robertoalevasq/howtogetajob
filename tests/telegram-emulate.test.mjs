import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { makeDisposableWorkspace } from '../core/telegram-emulate.mjs';

test('makeDisposableWorkspace creates a workspace with junctions to the real core/modes and telegram disabled', () => {
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    assert.ok(existsSync(wsDir), 'workspace directory should exist');
    assert.ok(lstatSync(join(wsDir, 'core')).isSymbolicLink(), 'core should be a junction/symlink');
    assert.ok(lstatSync(join(wsDir, 'modes')).isSymbolicLink(), 'modes should be a junction/symlink');
    assert.ok(existsSync(join(wsDir, 'core', 'telegram-monitor.mjs')), 'core junction should reach the real repo files');
    assert.ok(existsSync(join(wsDir, 'cv.md')), 'a minimal cv.md should be seeded');
    assert.ok(existsSync(join(wsDir, 'config', 'profile.yml')), 'profile.yml should be seeded from the template');
    const plugins = yaml.load(readFileSync(join(wsDir, 'config', 'plugins.yml'), 'utf-8'));
    assert.equal(plugins.plugins.telegram.enabled, false, 'telegram must stay disabled in every disposable workspace');
    assert.ok(existsSync(join(wsDir, 'data', 'telegram-state.md')) === false, 'no telegram-state.md until a scenario seeds one');
  } finally {
    cleanup();
  }
  assert.ok(!existsSync(wsDir), 'cleanup() should remove the disposable workspace');
});

test('makeDisposableWorkspace writes a minimal portals.yml with zero tracked companies (fast Pass A)', () => {
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    const portals = yaml.load(readFileSync(join(wsDir, 'portals.yml'), 'utf-8'));
    assert.deepEqual(portals.tracked_companies, []);
    assert.deepEqual(portals.search_queries, []);
  } finally {
    cleanup();
  }
});

import { resolveDisambiguationHint } from '../core/telegram-monitor.mjs';
import { seedPendingConfirmations } from '../core/telegram-emulate.mjs';

test('seedPendingConfirmations writes a telegram-state.md the REAL resolveDisambiguationHint can parse', () => {
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    seedPendingConfirmations(wsDir,
      '[msg_id: 100] stage: question — Test question A — waiting since 2026-01-01\n' +
      '  report: 1\n' +
      '  job_url: https://example.com/a\n' +
      '  data: Test question A body\n\n' +
      '[msg_id: 200] stage: question — Test question B — waiting since 2026-01-01\n' +
      '  report: 2\n' +
      '  job_url: https://example.com/b\n' +
      '  data: Test question B body'
    );
    const dispatch = { chatId: '999000111', cwd: wsDir, kind: 'routing', messages: [{ chatId: '999000111', text: '1' }] };
    const hint = resolveDisambiguationHint(dispatch);
    assert.ok(hint, 'the real production parser should resolve this seeded state');
    assert.match(hint, /selects item 1: \[msg_id: 100\]/);
  } finally {
    cleanup();
  }
});

import { mkdtempSync as mkdtemp2, mkdirSync, writeFileSync as writeFile2, utimesSync, rmSync } from 'node:fs';
import { findLatestTranscript } from '../core/telegram-emulate.mjs';
import { hubProjectDirPrefix } from '../core/admin-overview-snapshot.mjs';
import { tmpdir } from 'node:os';

test('findLatestTranscript returns the newest matching transcript created at/after the given time', () => {
  const fakeClaudeHome = mkdtemp2(join(tmpdir(), 'career-ops-emulate-claudehome-'));
  const fakeTempRoot = mkdtemp2(join(tmpdir(), 'career-ops-emulate-reporoot-'));
  try {
    const prefix = hubProjectDirPrefix(fakeTempRoot);
    const projectDir = join(fakeClaudeHome, 'projects', `${prefix}-workspaces-test-candidate`);
    mkdirSync(projectDir, { recursive: true });

    const oldFile = join(projectDir, 'old-session.jsonl');
    const newFile = join(projectDir, 'new-session.jsonl');
    writeFile2(oldFile, '{}\n', 'utf-8');
    writeFile2(newFile, '{}\n', 'utf-8');
    const oldTime = new Date('2020-01-01T00:00:00Z');
    const newTime = new Date('2030-01-01T00:00:00Z');
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(newFile, newTime, newTime);

    const since = new Date('2025-01-01T00:00:00Z').getTime();
    const found = findLatestTranscript(fakeTempRoot, 'test-candidate', since, { claudeHome: fakeClaudeHome });
    assert.equal(found, newFile);
  } finally {
    rmSync(fakeClaudeHome, { recursive: true, force: true });
    rmSync(fakeTempRoot, { recursive: true, force: true });
  }
});

test('findLatestTranscript returns null when nothing matches', () => {
  const fakeClaudeHome = mkdtemp2(join(tmpdir(), 'career-ops-emulate-claudehome-empty-'));
  const fakeTempRoot = mkdtemp2(join(tmpdir(), 'career-ops-emulate-reporoot-empty-'));
  try {
    const found = findLatestTranscript(fakeTempRoot, 'test-candidate', Date.now(), { claudeHome: fakeClaudeHome });
    assert.equal(found, null);
  } finally {
    rmSync(fakeClaudeHome, { recursive: true, force: true });
    rmSync(fakeTempRoot, { recursive: true, force: true });
  }
});

import { readTranscriptToolUses, assertNoAgentToolUse, readPendingConfirmationBlock } from '../core/telegram-emulate.mjs';

function writeFakeTranscript(path, toolNames) {
  const lines = toolNames.map(name => JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] },
  }));
  writeFile2(path, lines.join('\n') + '\n', 'utf-8');
}

test('readTranscriptToolUses lists every tool_use name in a transcript', () => {
  const dir = mkdtemp2(join(tmpdir(), 'career-ops-emulate-transcript-'));
  try {
    const p = join(dir, 'session.jsonl');
    writeFakeTranscript(p, ['Read', 'Bash', 'Edit']);
    assert.deepEqual(readTranscriptToolUses(p), ['Read', 'Bash', 'Edit']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertNoAgentToolUse passes when no Agent/Task tool_use is present', () => {
  const dir = mkdtemp2(join(tmpdir(), 'career-ops-emulate-transcript-clean-'));
  try {
    const p = join(dir, 'session.jsonl');
    writeFakeTranscript(p, ['Read', 'Bash']);
    assert.doesNotThrow(() => assertNoAgentToolUse(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertNoAgentToolUse throws when an Agent tool_use is present', () => {
  const dir = mkdtemp2(join(tmpdir(), 'career-ops-emulate-transcript-dirty-'));
  try {
    const p = join(dir, 'session.jsonl');
    writeFakeTranscript(p, ['Read', 'Agent', 'Bash']);
    assert.throws(() => assertNoAgentToolUse(p), /Agent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readPendingConfirmationBlock returns the matching block, or null if absent', () => {
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    seedPendingConfirmations(wsDir,
      '[msg_id: 100] stage: question — A\n  data: {}\n\n[msg_id: 200] stage: question — B\n  data: {}'
    );
    const found = readPendingConfirmationBlock(wsDir, '100');
    assert.match(found, /\[msg_id: 100\] stage: question — A/);
    assert.equal(readPendingConfirmationBlock(wsDir, '999'), null);
  } finally {
    cleanup();
  }
});
