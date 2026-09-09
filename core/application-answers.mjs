#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './is-main.mjs';

export const APPLICATION_ANSWERS_HEADING = '## Application Answers';

const VALID_STATES = new Set(['filled', 'submitted']);

// modes/apply.md Step 8: the reconciliation of newly-confirmed boilerplate
// answers into data/application-defaults.md was a prose "don't forget" step
// (Step 6c #6 / Step 8) and was found silently skipped in practice twice —
// once for report #029 (2026-09-08) and again for #028 hours later, in both
// cases because nothing forced it. This module runs it as a side effect of
// the already-mandatory application-answers.mjs call instead, so it can no
// longer be dropped by an agent simply forgetting a separate step.
//
// Explicit categories an entry's `boilerplateCategory` may declare (set by
// the caller from its own Step 6b reasoning — trusted over the label regex
// below, since a label like Workday's bare "Self Identify: Please check one
// of the boxes below" carries no keyword a regex could key off of).
export const BOILERPLATE_CACHE_CATEGORIES = new Set([
  'gender',
  'ethnicity',
  'veteran',
  'disability',
  'electronic-signature',
  'arbitration-terms',
  'ai-consent',
]);

// Company-specific by nature — Step 8 calls this out explicitly (a named
// recruiter/referral, or "have you worked here before" whose true answer
// differs per company). Never auto-cached; surfaced for the candidate to
// confirm manually if they want a *generic* default going forward.
export const BOILERPLATE_MANUAL_REVIEW_CATEGORIES = new Set([
  'how-did-you-hear',
  'previously-worked',
]);

// Label-text fallback for entries with no explicit boilerplateCategory tag.
// Deliberately conservative: only keywords unambiguous enough that a false
// positive is implausible. Never-cache wins over cache on a collision (e.g.
// "desired start date" must never match a cache pattern by accident).
const LABEL_CACHE_PATTERNS = [
  /gender/i,
  /race|ethnicit|hispanic|latino/i,
  /veteran/i,
  /disab/i,
  /electronic signature/i,
  /arbitration|terms\s*(?:and|&)\s*conditions|terms of (?:use|service)/i,
  /ai\s*(?:interview|transcription)|consent.*(?:record|transcri)/i,
];

const LABEL_MANUAL_REVIEW_PATTERNS = [
  /how did you hear/i,
  /previously worked|worked (?:here|at this company)|former employee|rehire/i,
];

const LABEL_NEVER_CACHE_PATTERNS = [
  /salary|compensation|desired pay|expected pay|pay rate/i,
  /start date|availability/i,
  /sponsor|work authoriz|visa/i,
  /why (?:this|are you interested)|motivat|cover letter/i,
];

/**
 * @param {string} label
 * @param {string} [explicitCategory] entry.boilerplateCategory, if the caller set one
 * @returns {'cache'|'manual-review'|'never'|'not-boilerplate'}
 */
export function classifyBoilerplateLabel(label, explicitCategory) {
  const text = String(label || '');
  if (LABEL_NEVER_CACHE_PATTERNS.some((re) => re.test(text))) return 'never';
  if (explicitCategory === 'skip') return 'never';
  if (explicitCategory && BOILERPLATE_CACHE_CATEGORIES.has(explicitCategory)) return 'cache';
  if (explicitCategory && BOILERPLATE_MANUAL_REVIEW_CATEGORIES.has(explicitCategory)) return 'manual-review';
  if (LABEL_MANUAL_REVIEW_PATTERNS.some((re) => re.test(text))) return 'manual-review';
  if (LABEL_CACHE_PATTERNS.some((re) => re.test(text))) return 'cache';
  return 'not-boilerplate';
}

export const APPLICATION_DEFAULTS_TEMPLATE = `# Application Defaults — boilerplate cache

Non-substantive answers reused across applications. Edit or delete any line anytime.

## EEO / Voluntary Disclosures
- Gender: ...
- Race/Ethnicity: ...
- Veteran status: ...
- Disability: ...

## Standard Answers
- How did you hear about us: ...
- Previously worked at this company: ...
- Electronic signature: ...
- Arbitration/terms agreements: ...
- AI interview/transcription consent: ...

## Custom Answers
<!-- appended as new recurring boilerplate fields are confirmed -->
`;

function normalizeLabelKey(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[:*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every existing "- Label: value" line anywhere in the file, keyed by
// normalized label text, so a new entry that already has *any* cached line
// (fixed-template or Custom Answers) is never duplicated. Matching is on the
// literal label text, not the category — two questions in the same category
// (e.g. a Yes/No "Hispanic or Latino?" vs. a multi-option "select your
// ethnicity" pick-list) are genuinely different fields with genuinely
// different cached values, and must stay separate entries.
// Only lines with a real (non-placeholder "...") value count as "already
// covered" — an unfilled template line like "- Electronic signature: ..."
// must not block a genuinely new confirmed answer from being cached.
function existingLabelKeys(defaultsText) {
  const keys = [];
  const re = /^- ([^:]+):\s*(.*)$/gm;
  let match;
  while ((match = re.exec(String(defaultsText || '')))) {
    const value = match[2].trim();
    if (value && value !== '...') keys.push(normalizeLabelKey(match[1]));
  }
  return keys;
}

// A close paraphrase of an already-cached label (e.g. "Gender" vs. "Please
// select your gender") is treated as the same field via substring
// containment. Genuinely different questions in the same category (the
// boolean "Hispanic or Latino?" vs. a multi-option ethnicity pick-list)
// share no common substring and are correctly kept as separate entries —
// see the module comment above existingLabelKeys.
function isAlreadyCovered(existingKeys, newKey) {
  return existingKeys.some((key) => key.length > 3 && (newKey.includes(key) || key.includes(newKey)));
}

/**
 * Reconciles newly-confirmed boilerplate answers from an Application
 * Answers snapshot into data/application-defaults.md. Additive only: never
 * overwrites an existing line (fixed-template or Custom Answers), never
 * auto-caches a manual-review or never-cache category.
 *
 * @param {string|null|undefined} defaultsText current file content, or nullish if the file doesn't exist yet
 * @param {object} snapshot normalized snapshot (see normalizeApplicationAnswersSnapshot)
 * @returns {{text: string|null, cached: {label:string,value:string}[], flagged: {label:string,value:string}[]}}
 *   `text` is null when nothing changed (nothing new to cache) and no file existed yet.
 */
export function reconcileApplicationDefaults(defaultsText, snapshot = {}) {
  const normalized = normalizeApplicationAnswersSnapshot(snapshot);
  const candidateEntries = [
    ...normalized.selections.map((e) => ({
      label: inline(pick(e, ['question', 'field', 'label', 'prompt'])),
      value: valueText(pick(e, ['selection', 'selected', 'answer', 'value', 'options'])),
      boilerplateCategory: e?.boilerplateCategory,
    })),
    ...normalized.fieldValues.map((e) => ({
      label: inline(pick(e, ['question', 'field', 'label', 'prompt'])),
      value: valueText(pick(e, ['answer', 'response', 'value', 'text'])),
      boilerplateCategory: e?.boilerplateCategory,
    })),
  ];

  const existingKeys = existingLabelKeys(defaultsText);
  const cached = [];
  const flagged = [];
  const newLines = [];

  for (const entry of candidateEntries) {
    if (!entry.label || !entry.value) continue;
    const classification = classifyBoilerplateLabel(entry.label, entry.boilerplateCategory);
    const key = normalizeLabelKey(entry.label);

    if (classification === 'manual-review') {
      flagged.push({ label: entry.label, value: entry.value });
      continue;
    }
    if (classification !== 'cache') continue;
    if (isAlreadyCovered(existingKeys, key)) continue;

    existingKeys.push(key);
    cached.push({ label: entry.label, value: entry.value });
    newLines.push(`- ${entry.label}: ${entry.value}`);
  }

  if (newLines.length === 0) {
    return { text: null, cached, flagged };
  }

  const base = defaultsText && String(defaultsText).trim()
    ? String(defaultsText).replace(/\r\n/g, '\n')
    : APPLICATION_DEFAULTS_TEMPLATE;

  const customHeading = /^## Custom Answers\s*$/m.exec(base);
  let text;
  if (customHeading) {
    const insertAt = customHeading.index + customHeading[0].length;
    const rest = base.slice(insertAt);
    const commentMatch = /^\s*\n<!--[^\n]*-->/.exec(rest);
    const afterComment = commentMatch ? insertAt + commentMatch[0].length : insertAt;
    text = `${base.slice(0, afterComment)}\n${newLines.join('\n')}${base.slice(afterComment)}`;
  } else {
    text = `${base.trimEnd()}\n\n## Custom Answers\n${newLines.join('\n')}\n`;
  }

  return { text: text.replace(/\n{3,}/g, '\n\n'), cached, flagged };
}

function inline(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function valueText(value) {
  if (Array.isArray(value)) return value.map(inline).filter(Boolean).join(', ');
  return String(value ?? '').trim();
}

function pick(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (Array.isArray(value)) {
      if (value.length > 0) return value;
      continue;
    }
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeState(state) {
  const normalized = inline(state || 'filled').toLowerCase();
  if (!VALID_STATES.has(normalized)) {
    throw new Error(`Application answer state must be one of: ${[...VALID_STATES].join(', ')}`);
  }
  return normalized;
}

function normalizeDate(date) {
  return inline(date || new Date().toISOString().slice(0, 10));
}

function quoteBlock(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '> Not recorded.';
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}

function qaLines(entries, { labelKeys, valueKeys, fallback }) {
  if (entries.length === 0) return ['- None captured.'];

  return entries.flatMap((entry, index) => {
    const label = inline(pick(entry, labelKeys)) || `${fallback} ${index + 1}`;
    const answer = pick(entry, valueKeys);
    return [
      `${index + 1}. **${label}**`,
      '',
      quoteBlock(answer),
      '',
    ];
  }).slice(0, -1);
}

function compactLines(entries, { labelKeys, valueKeys, fallback }) {
  if (entries.length === 0) return ['- None captured.'];

  return entries.map((entry, index) => {
    const label = inline(pick(entry, labelKeys)) || `${fallback} ${index + 1}`;
    const value = valueText(pick(entry, valueKeys)) || 'Not recorded';
    return `${index + 1}. **${label}:** ${value}`;
  });
}

function fileLines(entries) {
  if (entries.length === 0) return ['- None captured.'];

  return entries.map((entry, index) => {
    const label = inline(pick(entry, ['field', 'name', 'label', 'type'])) || `File ${index + 1}`;
    const file = inline(pick(entry, ['path', 'file', 'filename', 'url'])) || 'Not recorded';
    const version = inline(pick(entry, ['version', 'variant']));
    return `${index + 1}. **${label}:** ${version ? `${file} (${version})` : file}`;
  });
}

export function normalizeApplicationAnswersSnapshot(snapshot = {}) {
  return {
    date: normalizeDate(snapshot.date),
    state: normalizeState(snapshot.state),
    freeText: list(snapshot.freeText ?? snapshot.freeTextAnswers ?? snapshot.answers),
    selections: list(snapshot.selections ?? snapshot.selectedOptions),
    fieldValues: list(snapshot.fieldValues ?? snapshot.otherFields ?? snapshot.fields),
    files: list(snapshot.files ?? snapshot.uploads ?? snapshot.filesUsed),
  };
}

export function formatApplicationAnswersSection(snapshot = {}) {
  const normalized = normalizeApplicationAnswersSnapshot(snapshot);
  const lines = [
    APPLICATION_ANSWERS_HEADING,
    '',
    `**Date:** ${normalized.date}`,
    `**State:** ${normalized.state}`,
    '',
    '### Free-text answers',
    '',
    ...qaLines(normalized.freeText, {
      labelKeys: ['question', 'field', 'label', 'prompt'],
      valueKeys: ['answer', 'response', 'value', 'text'],
      fallback: 'Answer',
    }),
    '',
    '### Selections made',
    '',
    ...compactLines(normalized.selections, {
      labelKeys: ['question', 'field', 'label', 'prompt'],
      valueKeys: ['selection', 'selected', 'answer', 'value', 'options'],
      fallback: 'Selection',
    }),
    '',
    '### Other field values',
    '',
    ...compactLines(normalized.fieldValues, {
      labelKeys: ['question', 'field', 'label', 'prompt'],
      valueKeys: ['answer', 'response', 'value', 'text'],
      fallback: 'Field',
    }),
    '',
    '### Files used',
    '',
    ...fileLines(normalized.files),
  ];

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export function upsertApplicationAnswersSection(reportText, snapshot = {}) {
  const report = String(reportText ?? '').replace(/\r\n/g, '\n');
  const section = formatApplicationAnswersSection(snapshot).trimEnd();
  const heading = /^## Application Answers\s*$/m.exec(report);

  if (!heading) {
    return `${report.trimEnd()}\n\n${section}\n`;
  }

  const start = heading.index;
  const afterHeading = start + heading[0].length;
  const nextHeading = /^## .+$/m.exec(report.slice(afterHeading));
  const end = nextHeading ? afterHeading + nextHeading.index : report.length;
  const before = report.slice(0, start).trimEnd();
  const after = report.slice(end).trimStart();

  return [before, section, after].filter(Boolean).join('\n\n') + '\n';
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--no-reconcile') args.noReconcile = true;
    else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      args[arg.slice(2)] = value;
      i += 1;
    }
  }
  return args;
}

function usage() {
  return [
    'Usage: node application-answers.mjs --report <report.md> --input <answers.json> [--state filled|submitted] [--date YYYY-MM-DD] [--defaults <application-defaults.md>] [--no-reconcile]',
    '',
    'The input JSON may contain: freeText, selections, fieldValues, files, date, state.',
    'Each selections/fieldValues entry may also carry boilerplateCategory (see BOILERPLATE_CACHE_CATEGORIES) so',
    'confirmed boilerplate answers (EEO/demographic, e-signature, arbitration/terms, AI-consent) are cached into',
    'data/application-defaults.md automatically — additive only, never overwrites an existing cached line.',
    'Pass --no-reconcile to skip this (e.g. re-running against the same input).',
  ].join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.report || !args.input) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const inputText = args.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(resolve(args.input), 'utf-8');
  const input = JSON.parse(inputText);
  const snapshot = {
    ...input,
    date: args.date || input.date,
    state: args.state || input.state,
  };
  const reportPath = resolve(args.report);
  const updated = upsertApplicationAnswersSection(readFileSync(reportPath, 'utf-8'), snapshot);
  writeFileSync(reportPath, updated, 'utf-8');

  const normalized = normalizeApplicationAnswersSnapshot(snapshot);
  const result = { report: reportPath, date: normalized.date, state: normalized.state };

  if (!args.noReconcile) {
    const defaultsPath = resolve(args.defaults || 'data/application-defaults.md');
    const currentDefaults = existsSync(defaultsPath) ? readFileSync(defaultsPath, 'utf-8') : null;
    const { text, cached, flagged } = reconcileApplicationDefaults(currentDefaults, snapshot);
    if (text !== null) {
      writeFileSync(defaultsPath, text, 'utf-8');
    }
    result.defaultsCache = {
      path: defaultsPath,
      cached: cached.map((e) => e.label),
      flaggedForManualReview: flagged.map((e) => e.label),
    };
  }

  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
