/**
 * preflight-check.mjs — zero-LLM LIGHT gate for career-ops pipeline runs.
 *
 * Collapses two previously-duplicated LLM-prompt pre-screen gates
 * (modes/pipeline.md's metadata pre-filter, batch/batch-prompt.md's
 * Step 1.5) into one deterministic
 * script: dedup against the tracker, a clearance/onsite-vs-remote keyword
 * hard-stop check, and advertised-comp extraction from JD text.
 *
 * Deliberately narrow: "wrong professional domain" and any archetype-fit
 * judgment are NOT attempted here (too fuzzy for regex, high false-positive
 * risk) and remain Claude's ambiguous-judgment call, same as today. See
 * docs/superpowers/specs/2026-09-02-ollama-cloud-delegation-design.md.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isMainModule } from './is-main.mjs';
import { resolveColumns, parseTrackerRow, normalizeTextKey } from './tracker-parse.mjs';
import { workspaceRoot } from './workspace-root.mjs';

const CURRENCY_SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const CURRENCY_CODE_RE = '(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|SEK|NOK|DKK|PLN|INR|MXN)';

function parseAmount(numStr, unit) {
  let n = parseFloat(String(numStr).replace(/,/g, ''));
  if (unit && /^k$/i.test(unit)) n *= 1000;
  return n;
}

/**
 * Extract an advertised comp range literally stated in JD text — no market
 * research, no model call, just what the text says. Feeds the mandatory
 * "Advertised (JD)" row oferta.md's Block D already requires.
 *
 * @param {string} text
 * @returns {{range: string, low: number, high: number, currency: string|null, raw: string} | null}
 */
export function extractAdvertisedComp(text) {
  if (!text || typeof text !== 'string') return null;

  const symRe = /([$€£¥])\s?([\d,]+(?:\.\d+)?)\s?([kK])?\s?(?:-|–|—|to)\s?[$€£¥]?\s?([\d,]+(?:\.\d+)?)\s?([kK])?/;
  const symMatch = text.match(symRe);
  if (symMatch) {
    const [, sym, num1, unit1, num2, unit2] = symMatch;
    // A K-suffix written once anywhere in the range applies to both ends —
    // "$150-180K" means 150000-180000, not 150-180000.
    const low = parseAmount(num1, unit1 || unit2);
    const high = parseAmount(num2, unit2 || unit1);
    return {
      range: `${sym}${num1}${unit1 || unit2 || ''}-${sym}${num2}${unit2 || unit1 || ''}`,
      low, high,
      currency: CURRENCY_SYMBOLS[sym] || null,
      raw: symMatch[0].trim(),
    };
  }

  const codeRe = new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s?(?:-|–|—|to)\\s?([\\d,]+(?:\\.\\d+)?)\\s?(${CURRENCY_CODE_RE})`, 'i');
  const codeMatch = text.match(codeRe);
  if (codeMatch) {
    const [, num1, num2, currency] = codeMatch;
    return {
      range: `${num1}-${num2} ${currency.toUpperCase()}`,
      low: parseAmount(num1), high: parseAmount(num2),
      currency: currency.toUpperCase(),
      raw: codeMatch[0].trim(),
    };
  }

  return null;
}

/**
 * Check whether a company+role pair already has a tracker row, so a pipeline
 * run doesn't spend a full evaluation re-processing something already tracked.
 *
 * @param {{company: string, role: string}} candidate
 * @param {{applicationsPath?: string}} [opts]
 * @returns {{isDuplicate: boolean, matchedRow: {num: number, company: string, role: string, status: string} | null}}
 */
export function checkDuplicate({ company, role }, { applicationsPath } = {}) {
  const path = applicationsPath || join(workspaceRoot(), 'data', 'applications.md');
  const notFound = { isDuplicate: false, matchedRow: null };
  if (!existsSync(path)) return notFound;

  const companyKey = normalizeTextKey(company);
  const roleKey = normalizeTextKey(role);
  if (!companyKey || !roleKey) return notFound;

  const lines = readFileSync(path, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    if (normalizeTextKey(row.company) === companyKey && normalizeTextKey(row.role) === roleKey) {
      return { isDuplicate: true, matchedRow: { num: row.num, company: row.company, role: row.role, status: row.status } };
    }
  }
  return notFound;
}

const CLEARANCE_KEYWORDS_RE = /\b(top secret|ts\/sci|security clearance|active clearance|dod clearance|clearance required|secret clearance)\b/i;
const CLEARANCE_SCI_RE = /\bSCI\b/;   // case-sensitive: avoids matching "sci-fi" (which is virtually always lowercase); real clearance usage is uppercase
const ONSITE_KEYWORDS_RE = /\b(onsite only|on-site only|no remote|in-office only|must (?:be |work )?on-?site|5 days? (?:a week )?in (?:the )?office)\b/i;

/**
 * Deterministic hard-stop keyword gate: clearance the candidate can't meet,
 * or an explicit onsite-only requirement against a strictly remote-only
 * candidate. Deliberately narrow — see Global Constraints in the plan this
 * came from for what this does NOT attempt (domain-fit, archetype judgment).
 *
 * @param {string} text - JD text, or title+location metadata, to scan.
 * @param {{clearance?: {status?: string, accepts_sponsorship?: boolean}, location?: {work_mode?: string}}} [profile]
 * @returns {{pass: boolean, reason: string|null}}
 */
export function checkGate(text, profile = {}) {
  const clean = { pass: true, reason: null };
  if (!text) return clean;
  const p = profile || {};

  const clearanceMatch = text.match(CLEARANCE_KEYWORDS_RE) || text.match(CLEARANCE_SCI_RE);
  if (clearanceMatch) {
    const clearance = p.clearance || {};
    const status = clearance.status || 'None';
    const acceptsSponsorship = clearance.accepts_sponsorship === true;
    // Case/whitespace-insensitive: a profile written as `status: none` must
    // hard-stop identically to `status: None`. A safety check that silently
    // stops firing because of casing is worse than no check at all.
    if (String(status).trim().toLowerCase() === 'none' && !acceptsSponsorship) {
      return { pass: false, reason: `clearance mismatch: JD requires "${clearanceMatch[0]}", candidate clearance.status is "${status}" with no sponsorship` };
    }
  }

  if (p.location?.work_mode === 'remote_only') {
    const onsiteMatch = text.match(ONSITE_KEYWORDS_RE);
    if (onsiteMatch) {
      return { pass: false, reason: `location mismatch: JD requires "${onsiteMatch[0]}", candidate work_mode is "remote_only"` };
    }
  }

  return clean;
}

function parseArgs(argv) {
  const args = { company: null, role: null, text: '', jdFile: null, profile: null, applications: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--company') args.company = argv[++i];
    else if (argv[i] === '--role') args.role = argv[++i];
    else if (argv[i] === '--text') args.text = argv[++i];
    else if (argv[i] === '--jd-file') args.jdFile = argv[++i];
    else if (argv[i] === '--profile') args.profile = argv[++i];
    else if (argv[i] === '--applications') args.applications = argv[++i];
  }
  return args;
}

const USAGE = 'Usage: node preflight-check.mjs [--company <c> --role <r>] [--text <string>] [--jd-file <path>] [--profile <path>] [--applications <path>]\n'
  + '  Needs either --company AND --role (dedup + gate), or at least one of --text/--jd-file (gate only).';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Dedup needs company+role; the keyword gate and comp extraction need only
  // text. batch/batch-prompt.md's Step 1.5 runs before company/role are known,
  // so a gate-only call with just --jd-file is legitimate — but a call with
  // neither pairing has nothing to check at all.
  const canDedup = Boolean(args.company && args.role);
  const hasText = Boolean(args.text || args.jdFile);
  if (!canDedup && !hasText) {
    console.error(USAGE);
    return 1;
  }

  let text = args.text || '';
  if (args.jdFile) {
    if (!existsSync(args.jdFile)) {
      console.error(`❌  --jd-file not found: ${args.jdFile}`);
      return 1;
    }
    text += (text ? '\n' : '') + readFileSync(args.jdFile, 'utf-8');
  }

  const yaml = (await import('js-yaml')).default;
  const profilePath = args.profile || process.env.CAREER_OPS_PROFILE || join(workspaceRoot(), 'config', 'profile.yml');
  let profile = {};
  if (existsSync(profilePath)) {
    try {
      profile = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    } catch (err) {
      console.error(`⚠️  Could not parse ${profilePath}: ${err.message} — gate running with an empty profile.`);
    }
  }

  // `checked: false` means dedup was never attempted (no company/role given) —
  // deliberately distinct from "attempted and found nothing," so a caller can
  // never read a gate-only call as proof the role isn't already tracked.
  const duplicate = canDedup
    ? { ...checkDuplicate({ company: args.company, role: args.role }, { applicationsPath: args.applications }), checked: true }
    : { isDuplicate: false, matchedRow: null, checked: false };

  const result = {
    duplicate,
    gate: checkGate(text, profile),
    advertisedComp: extractAdvertisedComp(text),
  };
  console.log(JSON.stringify(result));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
