import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractUsageAndSkillCalls } from '../core/admin-overview-snapshot.mjs';

function writeFixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-overview-transcript-'));
  const filePath = join(dir, 'session.jsonl');
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, filePath };
}

test('extractUsageAndSkillCalls pulls timestamp+usage from assistant message lines', () => {
  const { dir, filePath } = writeFixture([
    {
      type: 'assistant', timestamp: '2026-08-31T17:21:28.588Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'some secret conversation content' }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
      },
    },
  ]);
  try {
    const result = extractUsageAndSkillCalls(filePath);
    assert.equal(result.usageEntries.length, 1);
    assert.equal(result.usageEntries[0].timestamp, '2026-08-31T17:21:28.588Z');
    assert.deepEqual(result.usageEntries[0].usage, { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractUsageAndSkillCalls pulls skill+args from Skill tool-call lines', () => {
  const { dir, filePath } = writeFixture([
    {
      type: 'assistant', timestamp: '2026-08-31T17:22:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'career-ops', args: 'Run career-ops pipeline mode for data/pipeline.md.' } }],
      },
    },
  ]);
  try {
    const result = extractUsageAndSkillCalls(filePath);
    assert.equal(result.skillCalls.length, 1);
    assert.equal(result.skillCalls[0].timestamp, '2026-08-31T17:22:00.000Z');
    assert.equal(result.skillCalls[0].skill, 'career-ops');
    assert.equal(result.skillCalls[0].args, 'Run career-ops pipeline mode for data/pipeline.md.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractUsageAndSkillCalls ignores tool calls that are not Skill', () => {
  const { dir, filePath } = writeFixture([
    {
      type: 'assistant', timestamp: '2026-08-31T17:23:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    },
  ]);
  try {
    const result = extractUsageAndSkillCalls(filePath);
    assert.equal(result.skillCalls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractUsageAndSkillCalls skips a malformed JSON line instead of crashing the whole file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-overview-transcript-'));
  const filePath = join(dir, 'session.jsonl');
  writeFileSync(filePath, [
    '{not valid json at all',
    JSON.stringify({
      type: 'assistant', timestamp: '2026-08-31T17:24:00.000Z',
      message: {
        role: 'assistant',
        content: [],
        usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 },
      },
    }),
  ].join('\n') + '\n');
  try {
    const result = extractUsageAndSkillCalls(filePath);
    assert.equal(result.usageEntries.length, 1);
    assert.equal(result.usageEntries[0].timestamp, '2026-08-31T17:24:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractUsageAndSkillCalls returns empty arrays (not a throw) for a nonexistent file', () => {
  const result = extractUsageAndSkillCalls('/definitely/does/not/exist.jsonl');
  assert.deepEqual(result, { usageEntries: [], skillCalls: [] });
});

test('extractUsageAndSkillCalls never includes message content anywhere in its return value', () => {
  const secretText = 'THIS-IS-PRIVATE-CONVERSATION-CONTENT-12345';
  const { dir, filePath } = writeFixture([
    {
      type: 'assistant', timestamp: '2026-08-31T17:25:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: secretText }],
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
      },
    },
  ]);
  try {
    const result = extractUsageAndSkillCalls(filePath);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(secretText), 'privacy violation: message content leaked into extraction result');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
