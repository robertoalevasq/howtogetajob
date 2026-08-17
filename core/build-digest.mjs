#!/usr/bin/env node
/**
 * build-digest.mjs — Deterministic Discord/Telegram match-digest builder.
 *
 * Added 2026-08-13 after two real cycle runs delivered the same match
 * content in two visibly different wordings — the digest was 100%
 * LLM-composed prose following `_custom.md`'s spec, which constrains
 * content/mechanics but was never rigid enough to guarantee identical
 * structure run to run. This replaces that with a two-step flow:
 *
 *   1. `scaffold` — reads this run's tracker-addition TSVs + each match's
 *      report file, emits a structured JSON record per match. The TSV's own
 *      `notes` column (written at evaluation time, with full JD context
 *      already in front of the model) is used as the default fit-reason —
 *      already a real, considered one-liner, not a placeholder.
 *   2. `render` — takes that JSON (optionally with `--reasons <path>` to
 *      override specific reasons with a refined version) and deterministically
 *      renders the exact Discord or Telegram text: same tier markers, same
 *      angle-bracket URL wrapping, same chunking thresholds, same mandatory
 *      closing line, every single run.
 *
 * The LLM's only remaining judgment call is optionally refining a reason
 * line — everything else (which matches qualify, what order, exact
 * formatting) is now mechanical.
 *
 * Usage:
 *   node build-digest.mjs scaffold --tsv <path> [--tsv <path> ...] [--min-score 3.5]
 *   node build-digest.mjs render --input <scaffold.json> --platform discord|telegram [--reasons <reasons.json>]
 */

import { readFileSync, existsSync } from 'fs';

const MIN_SCORE_DEFAULT = 3.5;
const STRONG_THRESHOLD = 4.0;
const DISCORD_CHAR_LIMIT = 2000;
const TELEGRAM_CHAR_LIMIT = 4096;
const DISCORD_CLOSING_LINE = '📌 Read-only digest — reply in Telegram to apply, skip, or request a PDF.';
// Slash-only (2026-08-15) — every action here is a recognized /command,
// not a free-text phrase; see modes/telegram.md Step 2 for why.
const TELEGRAM_CLOSING_BLOCK =
  'Reply with: <code>/apply {report#}</code> to apply, <code>/applyall</code> to batch, ' +
  '<code>/pdf {report#}</code> for a single resume, or <code>/help</code> for everything I can do.';

function parseArgs(argv) {
  const args = { tsvPaths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tsv') args.tsvPaths.push(argv[++i]);
    else if (a === '--min-score') args.minScore = Number(argv[++i]);
    else if (a === '--input') args.input = argv[++i];
    else if (a === '--platform') args.platform = argv[++i];
    else if (a === '--reasons') args.reasons = argv[++i];
  }
  return args;
}

/** Parse one tracker-addition TSV line into its 9 documented columns. */
function parseTsvRow(line) {
  const cols = line.split('\t');
  if (cols.length < 9) return null;
  const [num, date, company, role, status, score, pdf, report, notes] = cols;
  return { num, date, company, role, status, score, pdf, report, notes: notes || '' };
}

/** Extract the JD URL from a report file's `**URL:**` header line. */
function extractReportUrl(reportPath) {
  if (!existsSync(reportPath)) return null;
  const text = readFileSync(reportPath, 'utf8');
  const m = text.match(/^\*\*URL:\*\*\s*(\S+)/m);
  return m ? m[1] : null;
}

function tierFor(score) {
  return score >= STRONG_THRESHOLD ? 'STRONG' : 'WORTH A LOOK';
}

function cmdScaffold(args) {
  const minScore = Number.isFinite(args.minScore) ? args.minScore : MIN_SCORE_DEFAULT;
  const records = [];

  for (const tsvPath of args.tsvPaths) {
    if (!existsSync(tsvPath)) { console.error(`TSV not found, skipping: ${tsvPath}`); continue; }
    const line = readFileSync(tsvPath, 'utf8').trim();
    if (!line) continue;
    const row = parseTsvRow(line);
    if (!row) { console.error(`Malformed TSV row, skipping: ${tsvPath}`); continue; }

    const score = parseFloat(row.score);
    if (!Number.isFinite(score) || score < minScore) continue;

    // Report link column is `[num](reports/...)` — extract the path.
    const linkMatch = row.report.match(/\(([^)]+)\)/);
    const reportPath = linkMatch ? linkMatch[1].replace(/^\.\.\//, '') : null;
    const url = reportPath ? extractReportUrl(reportPath) : null;

    records.push({
      reportNum: row.num,
      company: row.company,
      role: row.role,
      score,
      tier: tierFor(score),
      url: url || '(URL not found in report)',
      reportPath,
      reason: row.notes.trim(),
    });
  }

  // Highest score first — matches the existing top-matches table convention.
  records.sort((a, b) => b.score - a.score);
  console.log(JSON.stringify(records, null, 2));
}

function chunkLines(lines, limit) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (currentLen + lineLen > limit && current.length > 0) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function renderDiscord(records) {
  const lines = records.map(r => {
    const tierEmoji = r.tier === 'STRONG' ? '🟢' : '🟡';
    return `${tierEmoji} **${r.company}**\n${r.role} • ${r.score}/5 • <${r.url}>\n_${r.reason}_`;
  });
  const chunks = chunkLines(lines, DISCORD_CHAR_LIMIT - DISCORD_CLOSING_LINE.length - 20);
  return chunks.map((chunk, i) => {
    const footer = i === chunks.length - 1 ? `\n\n${DISCORD_CLOSING_LINE}` : '';
    return chunk.join('\n\n') + footer;
  });
}

function renderTelegram(records) {
  const lines = records.map(r => {
    const tierTag = r.tier === 'STRONG' ? '<b>[STRONG]</b>' : '<b>[WORTH A LOOK]</b>';
    return `${tierTag} ${r.company} — ${r.role} — ${r.score}/5\n${r.url}\n${r.reason}`;
  });
  const chunks = chunkLines(lines, TELEGRAM_CHAR_LIMIT - TELEGRAM_CLOSING_BLOCK.length - 20);
  return chunks.map((chunk, i) => {
    const header = chunks.length > 1 ? `(Part ${i + 1}/${chunks.length})\n\n` : '';
    const footer = i === chunks.length - 1 ? `\n\n${TELEGRAM_CLOSING_BLOCK}` : '';
    return header + chunk.join('\n\n') + footer;
  });
}

function cmdRender(args) {
  if (!args.input || !existsSync(args.input)) {
    console.error('Usage: node build-digest.mjs render --input <scaffold.json> --platform discord|telegram [--reasons <reasons.json>]');
    process.exit(1);
  }
  if (args.platform !== 'discord' && args.platform !== 'telegram') {
    console.error('--platform must be "discord" or "telegram"');
    process.exit(1);
  }

  let records = JSON.parse(readFileSync(args.input, 'utf8'));
  if (records.length === 0) {
    console.log(JSON.stringify({ messages: [], note: 'zero qualifying matches — skip delivery entirely per _custom.md' }));
    return;
  }

  if (args.reasons && existsSync(args.reasons)) {
    const overrides = JSON.parse(readFileSync(args.reasons, 'utf8'));
    records = records.map(r => (overrides[r.reportNum] ? { ...r, reason: overrides[r.reportNum] } : r));
  }

  const messages = args.platform === 'discord' ? renderDiscord(records) : renderTelegram(records);
  console.log(JSON.stringify({ messages }, null, 2));
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (cmd === 'scaffold') return cmdScaffold(args);
  if (cmd === 'render') return cmdRender(args);

  console.error('Usage:\n  node build-digest.mjs scaffold --tsv <path> [--tsv <path> ...] [--min-score 3.5]\n  node build-digest.mjs render --input <scaffold.json> --platform discord|telegram [--reasons <reasons.json>]');
  process.exit(1);
}

main();
