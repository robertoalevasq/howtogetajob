import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeByKey, topSessions, flaggedSessions, renderSummary } from '../core/token-efficiency-report.mjs';

// Column order per token-efficiency-log.mjs's LOG_COLUMNS:
// date, workspace, mode, session_id, total_tokens, input, output, cache_read,
// cache_creation, duration_min, tool_call_counts, subagent_delegated, efficiency_flags
function row({ date = '2026-09-08', workspace = 'ws', mode = 'apply', sessionId = 's1', total = 1000, flags = '' } = {}) {
  return [date, workspace, mode, sessionId, String(total), '0', '0', '0', '0', '1.0', '{}', 'false', flags];
}

test('summarizeByKey totals tokens grouped by the given column, sorted descending', () => {
  const rows = [row({ mode: 'apply', total: 100 }), row({ mode: 'pdf', total: 500 }), row({ mode: 'apply', total: 200 })];
  const result = summarizeByKey(rows, 2); // mode column
  assert.deepEqual(result, [['pdf', 500], ['apply', 300]]);
});

test('topSessions returns the N highest total_tokens rows, sorted descending', () => {
  const rows = [row({ sessionId: 'a', total: 10 }), row({ sessionId: 'b', total: 999 }), row({ sessionId: 'c', total: 50 })];
  const top = topSessions(rows, 2);
  assert.deepEqual(top.map((r) => r[3]), ['b', 'c']);
});

test('flaggedSessions returns only rows with a non-empty efficiency_flags column', () => {
  const rows = [row({ sessionId: 'clean', flags: '' }), row({ sessionId: 'flagged', flags: 'high_snapshot_ratio' })];
  const result = flaggedSessions(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0][3], 'flagged');
});

test('renderSummary produces readable output with mode/workspace breakdowns and flagged sessions', () => {
  const rows = [
    row({ mode: 'apply', workspace: 'thomas-acosta', total: 40_000_000, flags: 'high_snapshot_ratio,no_subagent_delegation', sessionId: 'big-one' }),
    row({ mode: 'pdf', workspace: 'thomas-acosta', total: 1_000_000, sessionId: 'small-one' }),
  ];
  const out = renderSummary(rows);
  assert.match(out, /2 session\(s\), 41\.00M tokens total/);
  assert.match(out, /By mode:/);
  assert.match(out, /apply/);
  assert.match(out, /By workspace:/);
  assert.match(out, /thomas-acosta/);
  assert.match(out, /Top sessions by tokens:/);
  assert.match(out, /big-one/);
  assert.match(out, /Flagged sessions \(1\):/);
  assert.match(out, /high_snapshot_ratio,no_subagent_delegation/);
});

test('renderSummary handles zero flagged sessions cleanly', () => {
  const rows = [row({ flags: '' })];
  const out = renderSummary(rows);
  assert.match(out, /Flagged sessions \(0\):/);
});
