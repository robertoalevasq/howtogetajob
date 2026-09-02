/**
 * preflight-check.mjs — zero-LLM LIGHT gate for career-ops pipeline runs.
 *
 * Collapses three previously-duplicated LLM-prompt pre-screen gates
 * (modes/pipeline.md's metadata pre-filter, modes/pipeline.md's post-fetch
 * pre-screen gate, batch/batch-prompt.md's Step 1.5) into one deterministic
 * script: dedup against the tracker, a clearance/onsite-vs-remote keyword
 * hard-stop check, and advertised-comp extraction from JD text.
 *
 * Deliberately narrow: "wrong professional domain" and any archetype-fit
 * judgment are NOT attempted here (too fuzzy for regex, high false-positive
 * risk) and remain Claude's ambiguous-judgment call, same as today. See
 * docs/superpowers/specs/2026-09-02-ollama-cloud-delegation-design.md.
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveColumns, parseTrackerRow, normalizeTextKey } from './tracker-parse.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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
    const low = parseAmount(num1, unit1);
    const high = parseAmount(num2, unit2 || unit1);
    return {
      range: `${sym}${num1}${unit1 || ''}-${sym}${num2}${unit2 || unit1 || ''}`,
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
  const path = applicationsPath || join(ROOT, 'data', 'applications.md');
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
