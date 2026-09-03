import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateHistory } from '../core/admin-overview-snapshot.mjs';

function writeTranscript(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-overview-agg-'));
  const filePath = join(dir, 'session.jsonl');
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, filePath };
}

test('aggregateHistory buckets token usage by workspace and by day', () => {
  const { dir, filePath } = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.000Z',
      message: { role: 'assistant', content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } } },
    { type: 'assistant', timestamp: '2026-08-31T14:00:00.000Z',
      message: { role: 'assistant', content: [], usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 15 } } },
    { type: 'assistant', timestamp: '2026-09-01T09:00:00.000Z',
      message: { role: 'assistant', content: [], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } },
  ]);
  try {
    const result = aggregateHistory([{ path: filePath, scope: 'workspace', slug: 'alice' }], ['alice']);
    const alice = result.tokenUsageByWorkspace.alice;
    assert.equal(alice['2026-08-31'].input_tokens, 30);
    assert.equal(alice['2026-08-31'].output_tokens, 20);
    assert.equal(alice['2026-09-01'].input_tokens, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateHistory buckets run counts by workspace, mode, and day, including unclassified', () => {
  const { dir, filePath } = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Skill', input: { skill: 'career-ops', args: 'Run career-ops pipeline mode for data/pipeline.md.' } },
    ] } },
    { type: 'assistant', timestamp: '2026-08-31T11:00:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Skill', input: { skill: 'career-ops', args: 'Telegram routing for received message.' } },
    ] } },
  ]);
  try {
    const result = aggregateHistory([{ path: filePath, scope: 'workspace', slug: 'alice' }], ['alice']);
    const alice = result.runCountsByWorkspace.alice['2026-08-31'];
    assert.equal(alice.pipeline, 1);
    assert.equal(alice.unclassified, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateHistory buckets a slug not in knownSlugs under "deleted-or-renamed", never dropped', () => {
  const { dir, filePath } = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.000Z',
      message: { role: 'assistant', content: [], usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } } },
  ]);
  try {
    const result = aggregateHistory([{ path: filePath, scope: 'workspace', slug: 'ghost-workspace' }], ['alice']);
    assert.ok(!('ghost-workspace' in result.tokenUsageByWorkspace));
    assert.equal(result.tokenUsageByWorkspace['deleted-or-renamed']['2026-08-31'].input_tokens, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateHistory buckets hub-scope files under "hub", separate from any workspace', () => {
  const { dir, filePath } = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.000Z',
      message: { role: 'assistant', content: [], usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } } },
  ]);
  try {
    const result = aggregateHistory([{ path: filePath, scope: 'hub', slug: null }], ['alice']);
    assert.equal(result.tokenUsageByWorkspace.hub['2026-08-31'].input_tokens, 7);
    assert.ok(!('alice' in result.tokenUsageByWorkspace) || Object.keys(result.tokenUsageByWorkspace.alice || {}).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateHistory dedupes token usage from duplicate JSONL lines sharing the same message.id', () => {
  // Claude Code writes one JSONL line per content block of a single
  // assistant API response, and every line repeats the SAME message.usage
  // and message.id. Summing naively double-counts a single real response.
  const { dir, filePath } = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.000Z',
      message: { id: 'msg_dup1', role: 'assistant', content: [],
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } } },
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.500Z',
      message: { id: 'msg_dup1', role: 'assistant', content: [],
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } } },
  ]);
  try {
    const result = aggregateHistory([{ path: filePath, scope: 'workspace', slug: 'alice' }], ['alice']);
    assert.equal(result.tokenUsageByWorkspace.alice['2026-08-31'].input_tokens, 100);
    assert.equal(result.tokenUsageByWorkspace.alice['2026-08-31'].output_tokens, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateHistory dedupes skill-call run counts from duplicate JSONL lines sharing the same message.id', () => {
  const { dir, filePath } = writeTranscript([
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.000Z', message: { id: 'msg_dup2', role: 'assistant', content: [
      { type: 'tool_use', name: 'Skill', input: { skill: 'career-ops', args: 'cycle' } },
    ] } },
    { type: 'assistant', timestamp: '2026-08-31T10:00:00.500Z', message: { id: 'msg_dup2', role: 'assistant', content: [
      { type: 'tool_use', name: 'Skill', input: { skill: 'career-ops', args: 'cycle' } },
    ] } },
  ]);
  try {
    const result = aggregateHistory([{ path: filePath, scope: 'workspace', slug: 'alice' }], ['alice']);
    assert.equal(result.runCountsByWorkspace.alice['2026-08-31'].cycle, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateHistory returns empty aggregates (not a throw) for an empty file list', () => {
  const result = aggregateHistory([], ['alice']);
  assert.deepEqual(result.tokenUsageByWorkspace, {});
  assert.deepEqual(result.runCountsByWorkspace, {});
});
