/**
 * token-efficiency-report.mjs — reads the durable data/token-efficiency-log.tsv
 * (never re-parses transcripts itself — run `node token-efficiency-log.mjs
 * update` first to bring the log current) and prints a breakdown: totals by
 * mode and workspace, the most expensive sessions, and every session that
 * tripped an efficiency flag (see token-efficiency-log.mjs's FLAG_THRESHOLDS).
 */
import { isMainModule } from './is-main.mjs';
import { readLog, LOG_PATH } from './token-efficiency-log.mjs';

const COLS = ['date', 'workspace', 'mode', 'session_id', 'total_tokens', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'duration_min', 'tool_call_counts', 'subagent_delegated', 'efficiency_flags'];
const IDX = Object.fromEntries(COLS.map((c, i) => [c, i]));

function parseArgs(args) {
  const opts = { sinceDays: null, workspace: null, summary: args.includes('--summary') };
  const sinceIdx = args.indexOf('--since');
  if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    const m = /^(\d+)d$/.exec(args[sinceIdx + 1]);
    if (m) opts.sinceDays = Number(m[1]);
  }
  const wsIdx = args.indexOf('--workspace');
  if (wsIdx !== -1 && args[wsIdx + 1]) opts.workspace = args[wsIdx + 1];
  return opts;
}

function filterRows(rows, opts) {
  let out = [...rows.values()];
  if (opts.sinceDays != null) {
    const cutoff = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString().slice(0, 10);
    out = out.filter((r) => r[IDX.date] >= cutoff);
  }
  if (opts.workspace) out = out.filter((r) => r[IDX.workspace] === opts.workspace);
  return out;
}

/** @param {string[][]} rows */
export function summarizeByKey(rows, keyIdx) {
  const totals = new Map();
  for (const r of rows) {
    const key = r[keyIdx];
    totals.set(key, (totals.get(key) || 0) + (Number(r[IDX.total_tokens]) || 0));
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

/** @param {string[][]} rows */
export function topSessions(rows, n = 10) {
  return [...rows]
    .sort((a, b) => (Number(b[IDX.total_tokens]) || 0) - (Number(a[IDX.total_tokens]) || 0))
    .slice(0, n);
}

/** @param {string[][]} rows */
export function flaggedSessions(rows) {
  return rows.filter((r) => r[IDX.efficiency_flags] && r[IDX.efficiency_flags].length > 0);
}

function fmtM(tokens) {
  return `${(tokens / 1e6).toFixed(2)}M`;
}

export function renderSummary(rows) {
  const lines = [];
  const grandTotal = rows.reduce((sum, r) => sum + (Number(r[IDX.total_tokens]) || 0), 0);
  lines.push(`${rows.length} session(s), ${fmtM(grandTotal)} tokens total`);

  lines.push('\nBy mode:');
  for (const [mode, tokens] of summarizeByKey(rows, IDX.mode)) {
    lines.push(`  ${mode.padEnd(25)} ${fmtM(tokens).padStart(8)}  (${((tokens / grandTotal) * 100).toFixed(1)}%)`);
  }

  lines.push('\nBy workspace:');
  for (const [ws, tokens] of summarizeByKey(rows, IDX.workspace)) {
    lines.push(`  ${ws.padEnd(25)} ${fmtM(tokens).padStart(8)}  (${((tokens / grandTotal) * 100).toFixed(1)}%)`);
  }

  lines.push('\nTop sessions by tokens:');
  for (const r of topSessions(rows, 10)) {
    lines.push(`  ${fmtM(Number(r[IDX.total_tokens])).padStart(8)}  ${r[IDX.date]}  ${r[IDX.workspace].padEnd(18)} ${r[IDX.mode].padEnd(20)} ${r[IDX.session_id]}`);
  }

  const flagged = flaggedSessions(rows);
  lines.push(`\nFlagged sessions (${flagged.length}):`);
  for (const r of flagged) {
    lines.push(`  ${r[IDX.date]}  ${r[IDX.workspace].padEnd(18)} ${r[IDX.session_id]}  [${r[IDX.efficiency_flags]}]  (${fmtM(Number(r[IDX.total_tokens]))})`);
  }

  return lines.join('\n');
}

export function runReport(args) {
  const opts = parseArgs(args);
  const rows = filterRows(readLog(), opts);

  if (rows.length === 0) {
    console.log(opts.summary
      ? `No sessions in the log matching that filter. Run "node token-efficiency-log.mjs update" first if ${LOG_PATH} doesn't exist yet.`
      : JSON.stringify({ sessions: [], note: `no matching rows in ${LOG_PATH}` }));
    return 0;
  }

  if (opts.summary) {
    console.log(renderSummary(rows));
    return 0;
  }

  const grandTotal = rows.reduce((sum, r) => sum + (Number(r[IDX.total_tokens]) || 0), 0);
  console.log(JSON.stringify({
    sessionCount: rows.length,
    totalTokens: grandTotal,
    byMode: Object.fromEntries(summarizeByKey(rows, IDX.mode)),
    byWorkspace: Object.fromEntries(summarizeByKey(rows, IDX.workspace)),
    topSessions: topSessions(rows, 10).map((r) => Object.fromEntries(COLS.map((c, i) => [c, r[i]]))),
    flaggedSessions: flaggedSessions(rows).map((r) => Object.fromEntries(COLS.map((c, i) => [c, r[i]]))),
  }, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runReport(process.argv.slice(2));
}
