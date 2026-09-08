import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTranscriptForEfficiency, classifySessionMode, computeEfficiencyFlags,
  buildLogRow, readLog, updateLog, FLAG_THRESHOLDS,
  loadDispatchLog, findClosestDispatch, resolveSessionMode,
} from '../core/token-efficiency-log.mjs';

function writeTranscript(dir, name, lines) {
  const filePath = join(dir, name);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

function usageLine(ts, usage, id = null) {
  return { type: 'assistant', timestamp: ts, message: { id, role: 'assistant', content: [], usage } };
}

function toolLine(ts, name, input = {}) {
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } };
}

// ── parseTranscriptForEfficiency ────────────────────────────────────────

test('parseTranscriptForEfficiency sums usage across lines, deduped by messageId', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-parse-'));
  try {
    const f = writeTranscript(dir, 'a.jsonl', [
      usageLine('2026-09-08T10:00:00.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }, 'msg_1'),
      // same messageId repeated (Claude Code writes one line per content block, repeating usage) — must not double count
      usageLine('2026-09-08T10:00:01.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }, 'msg_1'),
      usageLine('2026-09-08T10:05:00.000Z', { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }, 'msg_2'),
    ]);
    const result = parseTranscriptForEfficiency(f);
    assert.deepEqual(result.usage, { input: 30, output: 13, cacheRead: 300, cacheCreation: 0 });
    assert.equal(result.firstTs, '2026-09-08T10:00:00.000Z');
    assert.equal(result.lastTs, '2026-09-08T10:05:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseTranscriptForEfficiency tallies tool_use block names, never their input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-parse-'));
  try {
    const f = writeTranscript(dir, 'a.jsonl', [
      toolLine('2026-09-08T10:00:00.000Z', 'mcp__playwright__browser_snapshot'),
      toolLine('2026-09-08T10:00:01.000Z', 'mcp__playwright__browser_snapshot'),
      toolLine('2026-09-08T10:00:02.000Z', 'Bash', { command: 'rm -rf /secret-path-should-never-leak' }),
    ]);
    const result = parseTranscriptForEfficiency(f);
    assert.deepEqual(result.toolCounts, { mcp__playwright__browser_snapshot: 2, Bash: 1 });
    assert.ok(!JSON.stringify(result).includes('secret-path-should-never-leak'), 'privacy violation: tool input leaked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseTranscriptForEfficiency collects career-ops Skill call args, ignores other skills/tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-parse-'));
  try {
    const f = writeTranscript(dir, 'a.jsonl', [
      toolLine('2026-09-08T10:00:00.000Z', 'Skill', { skill: 'career-ops', args: 'cycle' }),
      toolLine('2026-09-08T10:00:01.000Z', 'Skill', { skill: 'superpowers:brainstorming', args: 'something' }),
    ]);
    const result = parseTranscriptForEfficiency(f);
    assert.deepEqual(result.careerOpsSkillArgs, ['cycle']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseTranscriptForEfficiency returns null for a missing or empty file', () => {
  assert.equal(parseTranscriptForEfficiency('/definitely/not/here.jsonl'), null);
  const dir = mkdtempSync(join(tmpdir(), 'tel-parse-'));
  try {
    const f = writeTranscript(dir, 'empty.jsonl', []);
    assert.equal(parseTranscriptForEfficiency(f), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseTranscriptForEfficiency skips malformed JSON lines without crashing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-parse-'));
  try {
    const filePath = join(dir, 'a.jsonl');
    writeFileSync(filePath, ['{not json', JSON.stringify(usageLine('2026-09-08T10:00:00.000Z', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }))].join('\n'));
    const result = parseTranscriptForEfficiency(filePath);
    assert.equal(result.usage.input, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── classifySessionMode ──────────────────────────────────────────────────

test('classifySessionMode returns no-skill-call when no career-ops skill args were found', () => {
  assert.equal(classifySessionMode([]), 'no-skill-call');
});

test('classifySessionMode classifies via the last career-ops skill call (reuses admin-overview-snapshot.mjs)', () => {
  assert.equal(classifySessionMode(['cycle', 'pdf reports/1-x.md']), 'pdf');
});

test('classifySessionMode picks up the apply fix from earlier this session', () => {
  assert.equal(classifySessionMode(['Route Telegram message per modes/telegram.md: /apply 939 from Ernesto.']), 'apply');
});

// ── computeEfficiencyFlags ────────────────────────────────────────────────

test('computeEfficiencyFlags flags high_snapshot_ratio when snapshots dominate targeted lookups', () => {
  const parsed = {
    usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    toolCounts: { mcp__playwright__browser_snapshot: FLAG_THRESHOLDS.SNAPSHOT_MIN_COUNT, mcp__playwright__browser_find: 1 },
  };
  assert.deepEqual(computeEfficiencyFlags(parsed), ['high_snapshot_ratio']);
});

test('computeEfficiencyFlags does not flag snapshot ratio below the minimum count', () => {
  const parsed = { usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, toolCounts: { mcp__playwright__browser_snapshot: FLAG_THRESHOLDS.SNAPSHOT_MIN_COUNT - 1 } };
  assert.deepEqual(computeEfficiencyFlags(parsed), []);
});

test('computeEfficiencyFlags flags no_subagent_delegation for heavy Playwright interaction with no Task/Agent call', () => {
  const parsed = {
    usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    toolCounts: { mcp__playwright__browser_click: FLAG_THRESHOLDS.PLAYWRIGHT_DELEGATION_MIN_ACTIONS },
  };
  assert.deepEqual(computeEfficiencyFlags(parsed), ['no_subagent_delegation']);
});

test('computeEfficiencyFlags does not flag delegation when a Task call is present', () => {
  const parsed = {
    usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    toolCounts: { mcp__playwright__browser_click: FLAG_THRESHOLDS.PLAYWRIGHT_DELEGATION_MIN_ACTIONS, Task: 1 },
  };
  assert.deepEqual(computeEfficiencyFlags(parsed), []);
});

test('computeEfficiencyFlags can return multiple flags at once', () => {
  const parsed = {
    usage: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 },
    toolCounts: { mcp__playwright__browser_snapshot: FLAG_THRESHOLDS.SNAPSHOT_MIN_COUNT, mcp__playwright__browser_click: FLAG_THRESHOLDS.PLAYWRIGHT_DELEGATION_MIN_ACTIONS },
  };
  assert.deepEqual(computeEfficiencyFlags(parsed).sort(), ['high_snapshot_ratio', 'no_subagent_delegation'].sort());
});

// ── loadDispatchLog / findClosestDispatch / resolveSessionMode ─────────────

function writeDispatchLog(dir, entries) {
  const p = join(dir, 'dispatch-log.jsonl');
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

test('loadDispatchLog parses entries, sorted oldest first, skipping malformed lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-dispatch-'));
  try {
    const p = join(dir, 'dispatch-log.jsonl');
    writeFileSync(p, [
      JSON.stringify({ dispatchedAt: '2026-09-08T12:00:00.000Z', chatId: '1', workspace: 'alice', command: 'apply' }),
      'not json',
      JSON.stringify({ dispatchedAt: '2026-09-08T10:00:00.000Z', chatId: '1', workspace: 'alice', command: 'scan' }),
    ].join('\n') + '\n');
    const entries = loadDispatchLog(p);
    assert.deepEqual(entries.map((e) => e.command), ['scan', 'apply']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDispatchLog returns [] for a missing file', () => {
  assert.deepEqual(loadDispatchLog('/definitely/not/here.jsonl'), []);
});

test('findClosestDispatch matches the nearest same-workspace entry within the window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-dispatch-'));
  try {
    const p = writeDispatchLog(dir, [
      { dispatchedAt: '2026-09-08T10:00:00.000Z', chatId: '1', workspace: 'alice', command: 'scan' },
      { dispatchedAt: '2026-09-08T10:01:00.000Z', chatId: '1', workspace: 'bob', command: 'apply' },
      { dispatchedAt: '2026-09-08T10:02:00.000Z', chatId: '1', workspace: 'alice', command: 'apply' },
    ]);
    const entries = loadDispatchLog(p);
    const match = findClosestDispatch(entries, 'alice', '2026-09-08T10:02:10.000Z');
    assert.equal(match.command, 'apply');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findClosestDispatch returns null when nothing is within the match window', () => {
  const entries = [{ dispatchedAt: '2026-09-08T10:00:00.000Z', chatId: '1', workspace: 'alice', command: 'scan' }];
  const match = findClosestDispatch(entries, 'alice', '2026-09-08T11:00:00.000Z'); // 1 hour away
  assert.equal(match, null);
});

test('findClosestDispatch returns null when no entry matches the workspace', () => {
  const entries = [{ dispatchedAt: '2026-09-08T10:00:00.000Z', chatId: '1', workspace: 'bob', command: 'scan' }];
  assert.equal(findClosestDispatch(entries, 'alice', '2026-09-08T10:00:01.000Z'), null);
});

test('resolveSessionMode prefers a real career-ops Skill call over the dispatch log', () => {
  const parsed = { firstTs: '2026-09-08T10:00:00.000Z', careerOpsSkillArgs: ['pdf'] };
  const dispatchEntries = [{ dispatchedAt: '2026-09-08T10:00:00.000Z', workspace: 'alice', command: 'scan' }];
  assert.equal(resolveSessionMode(parsed, 'alice', dispatchEntries), 'pdf');
});

test('resolveSessionMode falls back to the dispatch log when there was no Skill call', () => {
  const parsed = { firstTs: '2026-09-08T10:00:00.000Z', careerOpsSkillArgs: [] };
  const dispatchEntries = [{ dispatchedAt: '2026-09-08T10:00:05.000Z', workspace: 'alice', command: 'apply' }];
  assert.equal(resolveSessionMode(parsed, 'alice', dispatchEntries), 'apply');
});

test('resolveSessionMode falls back to no-skill-call when neither source has anything', () => {
  const parsed = { firstTs: '2026-09-08T10:00:00.000Z', careerOpsSkillArgs: [] };
  assert.equal(resolveSessionMode(parsed, 'alice', []), 'no-skill-call');
});

// ── buildLogRow ───────────────────────────────────────────────────────────

test('buildLogRow produces the documented column order with correct values', () => {
  const parsed = {
    firstTs: '2026-09-08T10:00:00.000Z', lastTs: '2026-09-08T10:07:00.000Z',
    usage: { input: 10, output: 5, cacheRead: 100, cacheCreation: 0 },
    toolCounts: { Task: 1 },
    careerOpsSkillArgs: ['pdf'],
  };
  const row = buildLogRow({ scope: 'workspace', slug: 'thomas-acosta', path: 'C:/x/2b9ee618-abc.jsonl' }, parsed);
  assert.deepEqual(row, [
    '2026-09-08', 'thomas-acosta', 'pdf', '2b9ee618-abc',
    '115', '10', '5', '100', '0',
    '7.0', JSON.stringify({ Task: 1 }), 'true', '',
  ]);
});

test('buildLogRow labels hub-scope files as workspace "hub"', () => {
  const parsed = { firstTs: '2026-09-08T10:00:00.000Z', lastTs: '2026-09-08T10:00:00.000Z', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, toolCounts: {}, careerOpsSkillArgs: [] };
  const row = buildLogRow({ scope: 'hub', slug: null, path: 'C:/x/session.jsonl' }, parsed);
  assert.equal(row[1], 'hub');
  assert.equal(row[2], 'no-skill-call');
});

// ── updateLog / readLog: incremental + idempotent + rebuild ────────────────

function makeFakeHub() {
  const reposRoot = join(mkdtempSync(join(tmpdir(), 'tel-repo-')), 'career-ops');
  mkdirSync(reposRoot, { recursive: true });
  const claudeHome = mkdtempSync(join(tmpdir(), 'tel-claude-'));
  const prefix = reposRoot.replace(/[:\\_]/g, '-');
  const hubDir = join(claudeHome, 'projects', prefix);
  mkdirSync(hubDir, { recursive: true });
  return { reposRoot, claudeHome, hubDir };
}

test('updateLog processes new transcripts and writes one row per session, header included', () => {
  const { reposRoot, claudeHome, hubDir } = makeFakeHub();
  const logPath = join(mkdtempSync(join(tmpdir(), 'tel-log-')), 'log.tsv');
  const cursorPath = join(mkdtempSync(join(tmpdir(), 'tel-cursor-')), 'cursor.json');
  try {
    writeTranscript(hubDir, 'session1.jsonl', [usageLine('2026-09-08T10:00:00.000Z', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    const result = updateLog({ reposRoot, claudeHome, logPath, cursorPath });
    assert.equal(result.processed, 1);
    assert.equal(result.totalRows, 1);
    const rows = readLog(logPath);
    assert.equal(rows.size, 1);
    assert.ok(rows.has('session1'));
    const raw = readFileSync(logPath, 'utf-8');
    assert.ok(raw.startsWith('date\tworkspace\tmode\tsession_id'));
  } finally {
    rmSync(dirname_safe(reposRoot), { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(dirname_safe(logPath), { recursive: true, force: true });
    rmSync(dirname_safe(cursorPath), { recursive: true, force: true });
  }
});

test('updateLog run twice without any transcript change reprocesses nothing (cursor holds)', () => {
  const { reposRoot, claudeHome, hubDir } = makeFakeHub();
  const logPath = join(mkdtempSync(join(tmpdir(), 'tel-log-')), 'log.tsv');
  const cursorPath = join(mkdtempSync(join(tmpdir(), 'tel-cursor-')), 'cursor.json');
  try {
    writeTranscript(hubDir, 'session1.jsonl', [usageLine('2026-09-08T10:00:00.000Z', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    updateLog({ reposRoot, claudeHome, logPath, cursorPath });
    const second = updateLog({ reposRoot, claudeHome, logPath, cursorPath });
    assert.equal(second.processed, 0);
    assert.equal(second.skippedUnchanged, 1);
    assert.equal(second.totalRows, 1);
  } finally {
    rmSync(dirname_safe(reposRoot), { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(dirname_safe(logPath), { recursive: true, force: true });
    rmSync(dirname_safe(cursorPath), { recursive: true, force: true });
  }
});

test('updateLog reprocesses (upserts, never duplicates) a session whose transcript grew', () => {
  const { reposRoot, claudeHome, hubDir } = makeFakeHub();
  const logPath = join(mkdtempSync(join(tmpdir(), 'tel-log-')), 'log.tsv');
  const cursorPath = join(mkdtempSync(join(tmpdir(), 'tel-cursor-')), 'cursor.json');
  try {
    const f = writeTranscript(hubDir, 'session1.jsonl', [usageLine('2026-09-08T10:00:00.000Z', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    updateLog({ reposRoot, claudeHome, logPath, cursorPath });

    // Simulate the session resuming and growing, with a bumped mtime.
    writeFileSync(f, [
      JSON.stringify(usageLine('2026-09-08T10:00:00.000Z', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })),
      JSON.stringify(usageLine('2026-09-08T11:00:00.000Z', { input_tokens: 50, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })),
    ].join('\n') + '\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(f, future, future);

    const result = updateLog({ reposRoot, claudeHome, logPath, cursorPath });
    assert.equal(result.processed, 1);
    assert.equal(result.totalRows, 1); // upserted, not duplicated
    const rows = readLog(logPath);
    assert.equal(rows.get('session1')[4], '110'); // total_tokens reflects the grown transcript
  } finally {
    rmSync(dirname_safe(reposRoot), { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(dirname_safe(logPath), { recursive: true, force: true });
    rmSync(dirname_safe(cursorPath), { recursive: true, force: true });
  }
});

test('updateLog classifies a no-Skill-call session via the dispatch log instead of leaving it no-skill-call', () => {
  const { reposRoot, claudeHome, hubDir } = makeFakeHub();
  const logPath = join(mkdtempSync(join(tmpdir(), 'tel-log-')), 'log.tsv');
  const cursorPath = join(mkdtempSync(join(tmpdir(), 'tel-cursor-')), 'cursor.json');
  const dispatchDir = mkdtempSync(join(tmpdir(), 'tel-dispatch-'));
  const dispatchLogPath = join(dispatchDir, 'dispatch-log.jsonl');
  try {
    // A headless routing session with real usage but NO Skill tool call —
    // exactly the common real-world case this whole feature exists for.
    writeTranscript(hubDir, 'session1.jsonl', [usageLine('2026-09-08T10:00:05.000Z', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    writeFileSync(dispatchLogPath, JSON.stringify({ dispatchedAt: '2026-09-08T10:00:00.000Z', chatId: '1', workspace: 'hub', command: 'apply' }) + '\n');

    updateLog({ reposRoot, claudeHome, logPath, cursorPath, dispatchLogPath });
    const row = readLog(logPath).get('session1');
    assert.equal(row[2], 'apply'); // mode column — resolved via the dispatch log, not left as no-skill-call
  } finally {
    rmSync(dirname_safe(reposRoot), { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(dirname_safe(logPath), { recursive: true, force: true });
    rmSync(dirname_safe(cursorPath), { recursive: true, force: true });
    rmSync(dispatchDir, { recursive: true, force: true });
  }
});

test('updateLog --rebuild reproduces the same rows from scratch, ignoring a stale cursor/log', () => {
  const { reposRoot, claudeHome, hubDir } = makeFakeHub();
  const logPath = join(mkdtempSync(join(tmpdir(), 'tel-log-')), 'log.tsv');
  const cursorPath = join(mkdtempSync(join(tmpdir(), 'tel-cursor-')), 'cursor.json');
  try {
    writeTranscript(hubDir, 'session1.jsonl', [usageLine('2026-09-08T10:00:00.000Z', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
    updateLog({ reposRoot, claudeHome, logPath, cursorPath });
    const before = readLog(logPath).get('session1');

    const rebuilt = updateLog({ reposRoot, claudeHome, logPath, cursorPath, rebuild: true });
    assert.equal(rebuilt.totalRows, 1);
    const after = readLog(logPath).get('session1');
    assert.deepEqual(after, before);
  } finally {
    rmSync(dirname_safe(reposRoot), { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(dirname_safe(logPath), { recursive: true, force: true });
    rmSync(dirname_safe(cursorPath), { recursive: true, force: true });
  }
});

function dirname_safe(p) {
  // best-effort cleanup helper — walks up two levels from a file path, or
  // returns the path itself if it's already a directory the mkdtemp created
  return p.replace(/[/\\][^/\\]+$/, '');
}
