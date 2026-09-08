/**
 * token-efficiency-log.mjs — durable, transcript-derived log of per-session
 * token usage and efficiency signals, plus a report over it.
 *
 * Design principle: this log is never hand-maintained and never a second
 * source of truth. Every row is DERIVED from the same Claude Code session
 * transcripts admin-overview-snapshot.mjs already mines — `update` just
 * incrementally materializes that computation into data/token-efficiency-log.tsv
 * so repeated runs don't re-parse everything, and `--rebuild` regenerates the
 * whole log from scratch, byte-for-byte reproducible from the transcripts.
 * There is deliberately no live instrumentation added to any mode file: two
 * separate findings this session (Step 7b subagent-delegation compliance,
 * the application-defaults cache write) showed that a "please log this"
 * instruction buried in a mode file is easy to silently skip under a long
 * headless session. Mining the transcript is the only source that can't be
 * forgotten.
 *
 * PRIVACY: same discipline as admin-overview-snapshot.mjs's
 * extractUsageAndSkillCalls — only `timestamp`, `message.usage`, and tool_use
 * block NAMES (never their `input`/results, never message text) are read
 * from each transcript line. A tool-call tally counts occurrences of e.g.
 * "browser_snapshot" or "Bash", never what was typed or returned.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { isMainModule } from './is-main.mjs';
import { findHubTranscriptFiles, classifyRunFromArgs } from './admin-overview-snapshot.mjs';
import { dispatchLogPath } from './hub-paths.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

// A session's transcript is matched to the dispatch that spawned it by
// workspace + closest dispatchedAt-to-firstTs proximity, not an exact key —
// telegram-monitor.mjs doesn't learn the resulting transcript's session id
// (Claude Code assigns it internally), so timestamp proximity is the
// available join. This window bounds how far apart they're allowed to be;
// wider than a normal spawn delay but well short of two real dispatches for
// the same workspace colliding under createRoutingQueue's per-chat
// serialization.
const DISPATCH_MATCH_WINDOW_MS = 5 * 60 * 1000;

export const LOG_PATH = join(ROOT, '..', 'data', 'token-efficiency-log.tsv');
export const CURSOR_PATH = join(ROOT, '..', 'data', 'cache', 'token-efficiency-cursor.json');

const LOG_COLUMNS = [
  'date', 'workspace', 'mode', 'session_id',
  'total_tokens', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens',
  'duration_min', 'tool_call_counts', 'subagent_delegated', 'efficiency_flags',
];

// Heuristic thresholds for the efficiency_flags column. Named and exported so
// they're documented and independently testable/tunable, not magic numbers
// buried in a function body.
export const FLAG_THRESHOLDS = {
  // Found live 2026-09-07: a Workday apply session took 36 full browser_snapshot
  // calls where targeted browser_find/browser_evaluate would have answered the
  // same "did this field register" question far more cheaply.
  SNAPSHOT_MIN_COUNT: 5,
  // Playwright interaction volume above which Step 7b's mode file says the
  // fill MUST be delegated to a subagent, not run in the main context.
  PLAYWRIGHT_DELEGATION_MIN_ACTIONS: 10,
};

// A cache_read-vs-fresh-token ratio flag was tried and dropped (2026-09-08):
// checked against this hub's real 644-session history and found the ratio
// is dominated by how many turns a session had, not by anything resembling
// waste — even the MINIMUM ratio across every real session was 13.7, well
// above the threshold that seemed reasonable in the abstract. Every
// multi-turn session structurally looks this way (each turn resends the
// prior conversation via cheap cache_read), so no threshold would separate
// "grew too long" from "did completely normal multi-turn work." Total
// token cost — already surfaced via topSessions — is the real signal for
// "this session was expensive"; a ratio-based flag would just fire on
// nearly everything and train a reader to ignore the whole column.

const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent']);
const PLAYWRIGHT_ACTION_TOOL_NAMES = new Set([
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_fill_form',
  'mcp__playwright__browser_select_option',
]);

function totalUsageTokens(u) {
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
}

/**
 * Single-pass parse of one transcript file for efficiency-log purposes.
 * Returns null for a file with no usable content (missing, unreadable, or
 * carrying no usage entries at all).
 *
 * @param {string} filePath
 * @returns {{firstTs: string, lastTs: string, usage: {input:number,output:number,cacheRead:number,cacheCreation:number}, toolCounts: Object<string,number>, careerOpsSkillArgs: string[]} | null}
 */
export function parseTranscriptForEfficiency(filePath) {
  if (!existsSync(filePath)) return null;
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let firstTs = null;
  let lastTs = null;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const toolCounts = {};
  const careerOpsSkillArgs = [];
  const seenUsageMessageIds = new Set();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const timestamp = entry.timestamp;
    if (!timestamp) continue;
    if (firstTs === null || timestamp < firstTs) firstTs = timestamp;
    if (lastTs === null || timestamp > lastTs) lastTs = timestamp;

    const messageId = entry.message?.id ?? null;
    const u = entry.message?.usage;
    if (u && typeof u === 'object') {
      if (messageId == null || !seenUsageMessageIds.has(messageId)) {
        if (messageId != null) seenUsageMessageIds.add(messageId);
        usage.input += u.input_tokens || 0;
        usage.output += u.output_tokens || 0;
        usage.cacheRead += u.cache_read_input_tokens || 0;
        usage.cacheCreation += u.cache_creation_input_tokens || 0;
      }
    }

    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || !block.name) continue;
        toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
        if (block.name === 'Skill' && block.input?.skill && String(block.input.skill).includes('career-ops')) {
          careerOpsSkillArgs.push(String(block.input.args || ''));
        }
      }
    }
  }

  if (firstTs === null) return null;
  return { firstTs, lastTs, usage, toolCounts, careerOpsSkillArgs };
}

/**
 * Mode label for a parsed session: the LAST career-ops Skill call's args,
 * classified via admin-overview-snapshot.mjs's classifyRunFromArgs (reused,
 * not duplicated — includes the apply/apply-batch fix). 'no-skill-call' (not
 * 'unclassified') distinguishes "never invoked the Skill tool at all" from
 * "invoked it but the args didn't match a known mode" — a real, common case
 * for headless/Telegram-routed sessions where the mode is embedded in prose
 * rather than a Skill call. Deliberately does NOT fall back to scanning
 * message text for this case: that path was tried during this session's own
 * investigation and found unreliable (AGENTS.md's own documentation text,
 * always present in context, false-positives against loose prose patterns).
 *
 * @param {string[]} careerOpsSkillArgs
 * @returns {string}
 */
export function classifySessionMode(careerOpsSkillArgs) {
  if (careerOpsSkillArgs.length === 0) return 'no-skill-call';
  return classifyRunFromArgs(careerOpsSkillArgs[careerOpsSkillArgs.length - 1]);
}

/**
 * Reads telegram-monitor.mjs's dispatch-log.jsonl (see hub-paths.mjs's
 * dispatchLogPath) into an array, oldest first. Missing file or malformed
 * lines degrade to fewer/no entries, never a throw — this is a best-effort
 * secondary signal, not required for the log to function.
 *
 * @param {string} [logPath]
 * @returns {{dispatchedAt: string, chatId: string, workspace: string, command: string}[]}
 */
export function loadDispatchLog(logPath = dispatchLogPath()) {
  if (!existsSync(logPath)) return [];
  let raw;
  try {
    raw = readFileSync(logPath, 'utf-8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.dispatchedAt && entry?.workspace && entry?.command) entries.push(entry);
    } catch {
      continue;
    }
  }
  return entries.sort((a, b) => (a.dispatchedAt < b.dispatchedAt ? -1 : a.dispatchedAt > b.dispatchedAt ? 1 : 0));
}

/**
 * Finds the dispatch-log entry for `workspace` whose dispatchedAt is closest
 * to `firstTs`, within DISPATCH_MATCH_WINDOW_MS. Returns null if none is
 * close enough — a real, honest "we don't know" rather than guessing across
 * an implausible gap.
 *
 * @param {{dispatchedAt: string, workspace: string, command: string}[]} dispatchEntries
 * @param {string} workspace
 * @param {string} firstTs
 * @returns {{dispatchedAt: string, workspace: string, command: string} | null}
 */
export function findClosestDispatch(dispatchEntries, workspace, firstTs) {
  const target = new Date(firstTs).getTime();
  let best = null;
  let bestDelta = Infinity;
  for (const entry of dispatchEntries) {
    if (entry.workspace !== workspace) continue;
    const delta = Math.abs(new Date(entry.dispatchedAt).getTime() - target);
    if (delta <= DISPATCH_MATCH_WINDOW_MS && delta < bestDelta) {
      best = entry;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * The mode label actually written to a log row: trusts a career-ops Skill
 * call when one exists (classifySessionMode's normal path), and only falls
 * back to the deterministic dispatch-log correlation (findClosestDispatch)
 * when there was none — a real Skill call is always the more direct signal
 * when both are available. Falls through to 'no-skill-call' when neither
 * source has anything (e.g. a session predating this feature, or one never
 * routed through telegram-monitor.mjs at all).
 *
 * @param {ReturnType<typeof parseTranscriptForEfficiency>} parsed
 * @param {string} workspace
 * @param {ReturnType<typeof loadDispatchLog>} dispatchEntries
 * @returns {string}
 */
export function resolveSessionMode(parsed, workspace, dispatchEntries) {
  if (parsed.careerOpsSkillArgs.length > 0) return classifySessionMode(parsed.careerOpsSkillArgs);
  const dispatch = findClosestDispatch(dispatchEntries, workspace, parsed.firstTs);
  return dispatch ? dispatch.command : 'no-skill-call';
}

/**
 * Efficiency flags for one parsed session, per FLAG_THRESHOLDS. Returns a
 * (possibly empty) array of flag names — never throws on missing/zero counts.
 *
 * @param {{usage: object, toolCounts: Object<string,number>}} parsed
 * @returns {string[]}
 */
export function computeEfficiencyFlags(parsed) {
  const flags = [];
  const tc = parsed.toolCounts;
  const snapshots = tc['mcp__playwright__browser_snapshot'] || 0;
  const targeted = (tc['mcp__playwright__browser_find'] || 0) + (tc['mcp__playwright__browser_evaluate'] || 0);
  if (snapshots >= FLAG_THRESHOLDS.SNAPSHOT_MIN_COUNT && targeted < snapshots) {
    flags.push('high_snapshot_ratio');
  }

  const playwrightActions = [...PLAYWRIGHT_ACTION_TOOL_NAMES].reduce((sum, name) => sum + (tc[name] || 0), 0);
  const delegated = [...SUBAGENT_TOOL_NAMES].some((name) => (tc[name] || 0) > 0);
  if (playwrightActions >= FLAG_THRESHOLDS.PLAYWRIGHT_DELEGATION_MIN_ACTIONS && !delegated) {
    flags.push('no_subagent_delegation');
  }

  return flags;
}

function tsvEscape(v) {
  return String(v).replace(/\t/g, ' ').replace(/\n/g, ' ');
}

/**
 * Build one log row (an array of column-ordered strings, per LOG_COLUMNS)
 * for a discovered transcript file + its parse result.
 *
 * @param {{scope: 'hub'|'workspace', slug: string|null, path: string}} fileInfo
 * @param {ReturnType<typeof parseTranscriptForEfficiency>} parsed
 * @param {ReturnType<typeof loadDispatchLog>} [dispatchEntries]
 * @returns {string[]}
 */
export function buildLogRow(fileInfo, parsed, dispatchEntries = []) {
  const total = parsed.usage.input + parsed.usage.output + parsed.usage.cacheRead + parsed.usage.cacheCreation;
  const durationMin = (new Date(parsed.lastTs) - new Date(parsed.firstTs)) / 60000;
  const workspace = fileInfo.scope === 'hub' ? 'hub' : (fileInfo.slug || 'unknown');
  const mode = resolveSessionMode(parsed, workspace, dispatchEntries);
  const delegated = [...SUBAGENT_TOOL_NAMES].some((name) => (parsed.toolCounts[name] || 0) > 0);
  const flags = computeEfficiencyFlags(parsed);
  const sessionId = basename(fileInfo.path).replace(/\.jsonl$/, '');

  return [
    parsed.firstTs.slice(0, 10),
    workspace,
    mode,
    sessionId,
    String(Math.round(total)),
    String(parsed.usage.input),
    String(parsed.usage.output),
    String(parsed.usage.cacheRead),
    String(parsed.usage.cacheCreation),
    durationMin.toFixed(1),
    tsvEscape(JSON.stringify(parsed.toolCounts)),
    String(delegated),
    flags.join(','),
  ];
}

/** Reads the existing log (if any) into a Map keyed by session_id. */
export function readLog(logPath = LOG_PATH) {
  const rows = new Map();
  if (!existsSync(logPath)) return rows;
  const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines.slice(1)) { // skip header
    const cols = line.split('\t');
    if (cols.length !== LOG_COLUMNS.length) continue; // malformed row — skip, never crash
    rows.set(cols[3], cols); // session_id is column index 3
  }
  return rows;
}

function writeLog(rows, logPath = LOG_PATH) {
  mkdirSync(dirname(logPath), { recursive: true });
  const sorted = [...rows.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const lines = [LOG_COLUMNS.join('\t'), ...sorted.map((r) => r.join('\t'))];
  writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');
}

function readCursor(cursorPath = CURSOR_PATH) {
  try {
    return JSON.parse(readFileSync(cursorPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeCursor(cursor, cursorPath = CURSOR_PATH) {
  mkdirSync(dirname(cursorPath), { recursive: true });
  writeFileSync(cursorPath, JSON.stringify(cursor, null, 2), 'utf-8');
}

/**
 * Incrementally (re)builds the log: any transcript file that's new or whose
 * mtime advanced since the last recorded cursor gets (re)parsed, and its row
 * is upserted by session_id — never duplicated. `rebuild: true` ignores the
 * cursor and existing log entirely, reprocessing every discovered file from
 * scratch (the recovery path; the result is byte-for-byte what a from-empty
 * run produces, since every row is purely transcript-derived).
 *
 * @param {{reposRoot?: string, claudeHome?: string, logPath?: string, cursorPath?: string, dispatchLogPath?: string, rebuild?: boolean}} [opts]
 * @returns {{processed: number, skippedUnchanged: number, totalRows: number}}
 */
export function updateLog(opts = {}) {
  const reposRoot = opts.reposRoot ?? join(ROOT, '..');
  const claudeHome = opts.claudeHome ?? join(homedir(), '.claude');
  const logPath = opts.logPath ?? LOG_PATH;
  const cursorPath = opts.cursorPath ?? CURSOR_PATH;
  const rebuild = !!opts.rebuild;
  const dispatchEntries = loadDispatchLog(opts.dispatchLogPath);

  const files = findHubTranscriptFiles(reposRoot, claudeHome);
  const cursor = rebuild ? {} : readCursor(cursorPath);
  const rows = rebuild ? new Map() : readLog(logPath);

  let processed = 0;
  let skippedUnchanged = 0;

  for (const file of files) {
    let mtimeMs;
    try {
      mtimeMs = statSync(file.path).mtimeMs;
    } catch {
      continue; // vanished between discovery and stat — skip, not fatal
    }
    if (!rebuild && cursor[file.path] === mtimeMs) {
      skippedUnchanged++;
      continue;
    }

    const parsed = parseTranscriptForEfficiency(file.path);
    cursor[file.path] = mtimeMs;
    if (!parsed) continue; // no usable content — cursor still advances so we don't re-scan it every time

    const row = buildLogRow(file, parsed, dispatchEntries);
    rows.set(row[3], row); // upsert by session_id
    processed++;
  }

  writeLog(rows, logPath);
  writeCursor(cursor, cursorPath);
  return { processed, skippedUnchanged, totalRows: rows.size };
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'update') {
    const rebuild = rest.includes('--rebuild');
    const result = updateLog({ rebuild });
    console.log(`token-efficiency-log update: ${result.processed} session(s) processed, ${result.skippedUnchanged} unchanged/skipped, ${result.totalRows} total row(s) in ${LOG_PATH}`);
    return 0;
  }
  // report lives in its own script (token-efficiency-report.mjs), not
  // forwarded from here — that script already imports readLog/LOG_PATH from
  // this one, so dynamically importing it back from here would be a
  // circular import between the two files (confirmed live: it hung the
  // process with an "unsettled top-level await" warning rather than
  // running cleanly).
  console.error('Usage: node token-efficiency-log.mjs update [--rebuild]');
  console.error('For a report over the log, run: node token-efficiency-report.mjs [--since Nd] [--workspace slug] [--summary]');
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
