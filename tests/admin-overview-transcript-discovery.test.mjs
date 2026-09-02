import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { hubProjectDirPrefix, classifyProjectDir, findHubTranscriptFiles } from '../core/admin-overview-snapshot.mjs';

test('hubProjectDirPrefix replaces colons, backslashes, and underscores with hyphens', () => {
  const prefix = hubProjectDirPrefix('C:\\Users\\thebo\\_vscode\\career-ops');
  assert.equal(prefix, 'C--Users-thebo--vscode-career-ops');
});

test('classifyProjectDir identifies the bare hub root, case-insensitively', () => {
  const prefix = 'C--Users-thebo--vscode-career-ops';
  assert.deepEqual(classifyProjectDir('C--Users-thebo--vscode-career-ops', prefix), { scope: 'hub' });
  assert.deepEqual(classifyProjectDir('c--Users-thebo--vscode-career-ops', prefix), { scope: 'hub' });
});

test('classifyProjectDir identifies a workspace project dir and extracts the slug', () => {
  const prefix = 'C--Users-thebo--vscode-career-ops';
  const result = classifyProjectDir('C--Users-thebo--vscode-career-ops-workspaces-alice', prefix);
  assert.deepEqual(result, { scope: 'workspace', slug: 'alice' });
});

test('classifyProjectDir is case-insensitive on the drive-letter prefix for workspace dirs too', () => {
  const prefix = 'C--Users-thebo--vscode-career-ops';
  const result = classifyProjectDir('c--Users-thebo--vscode-career-ops-workspaces-bob', prefix);
  assert.deepEqual(result, { scope: 'workspace', slug: 'bob' });
});

test('classifyProjectDir returns other for a project directory unrelated to this hub', () => {
  const prefix = 'C--Users-thebo--vscode-career-ops';
  const result = classifyProjectDir('C--Users-thebo-some-other-project', prefix);
  assert.deepEqual(result, { scope: 'other' });
});

test('findHubTranscriptFiles finds .jsonl files under hub and workspace project dirs, ignoring unrelated ones', () => {
  const reposRoot = join(mkdtempSync(join(tmpdir(), 'admin-overview-repo-')), 'career-ops');
  mkdirSync(reposRoot, { recursive: true });
  const claudeHome = mkdtempSync(join(tmpdir(), 'admin-overview-claude-'));
  try {
    const prefix = reposRoot.replace(/[:\\_]/g, '-');
    const hubDir = join(claudeHome, 'projects', prefix);
    const wsDir = join(claudeHome, 'projects', `${prefix}-workspaces-alice`);
    const otherDir = join(claudeHome, 'projects', 'totally-unrelated-project');
    mkdirSync(hubDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(hubDir, 'session1.jsonl'), '{}\n');
    writeFileSync(join(wsDir, 'session2.jsonl'), '{}\n');
    writeFileSync(join(otherDir, 'session3.jsonl'), '{}\n');
    // A subagent transcript nested one level deeper, matching the real layout observed on disk.
    mkdirSync(join(wsDir, 'subsession', 'subagents'), { recursive: true });
    writeFileSync(join(wsDir, 'subsession', 'subagents', 'agent1.jsonl'), '{}\n');

    const found = findHubTranscriptFiles(reposRoot, claudeHome);
    const scopes = found.map((f) => f.scope).sort();
    assert.deepEqual(scopes, ['hub', 'workspace', 'workspace']);
    const wsEntries = found.filter((f) => f.scope === 'workspace');
    assert.ok(wsEntries.every((e) => e.slug === 'alice'));
    assert.ok(!found.some((f) => f.path.includes('totally-unrelated-project')));
  } finally {
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(dirname(reposRoot), { recursive: true, force: true });
  }
});

test('findHubTranscriptFiles returns an empty array when ~/.claude/projects does not exist', () => {
  const claudeHome = mkdtempSync(join(tmpdir(), 'admin-overview-claude-empty-'));
  try {
    assert.deepEqual(findHubTranscriptFiles('/some/repo', claudeHome), []);
  } finally {
    rmSync(claudeHome, { recursive: true, force: true });
  }
});
