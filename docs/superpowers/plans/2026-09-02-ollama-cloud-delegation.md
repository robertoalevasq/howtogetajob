# Ollama Cloud Task Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude quietly offload three narrow, low-judgment sub-tasks in `pipeline`/`auto-pipeline`/`batch` runs (comp market estimate, posting-freshness signal, risk-summary drafting) to Ollama Cloud (with a local-Ollama fallback), and collapse three duplicated LLM pre-screen prompts into one deterministic script — with zero change to the user's workflow, output format, or `oferta.md`'s rubric.

**Architecture:** Two new scripts. `core/preflight-check.mjs` is a pure-Node, zero-LLM gate (dedup + clearance/location hard-stop keywords + advertised-comp regex extraction) called from mode-file prose instead of three separate LLM prompts doing the same judgment. `core/ollama-delegate.mjs` is invoked mid-conversation by Claude for exactly three tasks, each with its instructions in a `modes/delegate/*.md` file (not hardcoded JS); it tries Ollama Cloud, falls back to local Ollama, and on failure exits non-zero so Claude does the task itself inline. Neither script ever runs standalone or replaces the existing `ollama-eval.mjs`/`openai-eval.mjs` full-evaluation path.

**Tech Stack:** Node.js ESM (`.mjs`), `js-yaml` (already a dependency) for config parsing, native `fetch`, the project's no-framework test convention (`tests/*.test.mjs`, `pass`/`fail`/`ROOT` from `tests/helpers.mjs`, auto-discovered by `core/test-all.mjs`).

**Spec:** [docs/superpowers/specs/2026-09-02-ollama-cloud-delegation-design.md](../specs/2026-09-02-ollama-cloud-delegation-design.md)

## Global Constraints

- Never modify `modes/oferta.md` or its scoring rubric.
- Every new script must be callable independently via `node core/<script>.mjs` — no subagents, matching `_shared.md`'s "no `Agent(...)` fan-out" rule.
- Follow existing script conventions exactly: JSDoc on exported functions, the `isMainModule(import.meta.url)` guard for CLI entry (from `core/is-main.mjs`), optional `dotenv` load wrapped in `try/catch`, `ROOT` resolved as `dirname(dirname(fileURLToPath(import.meta.url)))` (scripts live one level below repo root, in `core/`).
- Tests live in `tests/*.test.mjs`, dynamically imported via `pathToFileURL(join(ROOT, 'core', '<file>')).href` — no test-runner registration needed, `core/test-all.mjs` auto-discovers them.
- Secrets only in `.env` (already gitignored) — never in `config/llm-provider.yml` or any other tracked file.
- `config/llm-provider.yml` is a user-layer file (gitignored, like `config/profile.yml`); ship `config/llm-provider.example.yml` as the tracked template, matching the `profile.yml`/`profile.example.yml` pattern.
- The feature is fully opt-in: with `config/llm-provider.yml` absent (or both providers `enabled: false`), every `pipeline`/`auto-pipeline`/`batch` run must behave byte-identically to today.
- **Scope correction from the design spec:** `templates/jurisdiction-prohibited-content.yml` (and the sibling `immigration-status-requirements.yml`/`agency-licensing.yml`) explicitly documents "No script reads this file at runtime... never naive keyword/regex matching." The `block-g-signals` delegate task is therefore narrowed to posting-freshness parsing only (a genuinely mechanical, zero-judgment check) — it does NOT attempt jurisdiction/legal/benefits-terminology/agency-licensing matching, which stays entirely in Claude as before. This tightens delegation scope; it does not touch anything the user approved being off-limits (Block G's verdict was already excluded).
- **Scope correction from the design spec:** the deterministic keyword gate in `preflight-check.mjs` covers only clearance and explicit onsite-vs-remote_only hard stops — not "wrong professional domain," which is too fuzzy for reliable regex and stays with Claude's existing ambiguous-judgment pass (already categorized HEAVY in the spec).

---

### Task 1: `preflight-check.mjs` — dedup + advertised-comp extraction

**Files:**
- Create: `core/preflight-check.mjs`
- Test: `tests/preflight-check-dedup.test.mjs`

**Interfaces:**
- Produces: `export function extractAdvertisedComp(text: string): {range: string, low: number, high: number, currency: string|null, raw: string} | null`
- Produces: `export function checkDuplicate({company: string, role: string}, opts?: {applicationsPath?: string}): {isDuplicate: boolean, matchedRow: {num: number, company: string, role: string, status: string} | null}`
- Consumes (from `core/tracker-parse.mjs`, already exists): `resolveColumns(lines: string[])`, `parseTrackerRow(line: string, colmap): object|null`, `normalizeTextKey(value: string): string`

- [ ] **Step 1: Write the failing tests**

```js
// tests/preflight-check-dedup.test.mjs
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\npreflight-check.mjs — dedup + advertised-comp extraction');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'core', 'preflight-check.mjs')).href);

  // extractAdvertisedComp
  const c1 = mod.extractAdvertisedComp('Salary: $150,000 - $200,000 per year, plus equity');
  if (c1 && c1.low === 150000 && c1.high === 200000 && c1.currency === 'USD') {
    pass('extractAdvertisedComp reads a $-symbol range');
  } else {
    fail(`extractAdvertisedComp $ range => ${JSON.stringify(c1)}`);
  }

  const c2 = mod.extractAdvertisedComp('Compensation: 180000-220000 USD annually');
  if (c2 && c2.low === 180000 && c2.high === 220000 && c2.currency === 'USD') {
    pass('extractAdvertisedComp reads a currency-code range');
  } else {
    fail(`extractAdvertisedComp code range => ${JSON.stringify(c2)}`);
  }

  const c3 = mod.extractAdvertisedComp('$150K-$180K base');
  if (c3 && c3.low === 150000 && c3.high === 180000 && c3.currency === 'USD') {
    pass('extractAdvertisedComp expands K-suffixed amounts');
  } else {
    fail(`extractAdvertisedComp K-suffix => ${JSON.stringify(c3)}`);
  }

  const c4 = mod.extractAdvertisedComp('We offer a competitive salary and great benefits.');
  if (c4 === null) pass('extractAdvertisedComp returns null when no comp is stated');
  else fail(`extractAdvertisedComp should be null, got ${JSON.stringify(c4)}`);

  if (mod.extractAdvertisedComp('') === null && mod.extractAdvertisedComp(null) === null) {
    pass('extractAdvertisedComp handles empty/null input');
  } else {
    fail('extractAdvertisedComp should return null for empty/null input');
  }

  // checkDuplicate — against a throwaway fixture tracker file
  const tmpDir = mkdtempSync(join(tmpdir(), 'preflight-dedup-'));
  const fixturePath = join(tmpDir, 'applications.md');
  writeFileSync(fixturePath, [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-08-01 | Acme Corp | Senior Backend Engineer | 4.2/5 | Applied | ✅ | [1](reports/001-acme-corp-2026-08-01.md) | |',
  ].join('\n'));

  try {
    const dupHit = mod.checkDuplicate({ company: 'Acme Corp', role: 'Senior Backend Engineer' }, { applicationsPath: fixturePath });
    if (dupHit.isDuplicate && dupHit.matchedRow?.num === 1) {
      pass('checkDuplicate finds an existing company+role row');
    } else {
      fail(`checkDuplicate should have matched row 1, got ${JSON.stringify(dupHit)}`);
    }

    const dupCase = mod.checkDuplicate({ company: 'ACME CORP.', role: 'senior backend engineer' }, { applicationsPath: fixturePath });
    if (dupCase.isDuplicate) pass('checkDuplicate matches case/punctuation-insensitively');
    else fail(`checkDuplicate should be case/punctuation-insensitive, got ${JSON.stringify(dupCase)}`);

    const noDup = mod.checkDuplicate({ company: 'Beta Inc', role: 'Product Manager' }, { applicationsPath: fixturePath });
    if (!noDup.isDuplicate && noDup.matchedRow === null) pass('checkDuplicate returns false for a genuinely new company+role');
    else fail(`checkDuplicate false positive: ${JSON.stringify(noDup)}`);

    const missingFile = mod.checkDuplicate({ company: 'Beta Inc', role: 'PM' }, { applicationsPath: join(tmpDir, 'does-not-exist.md') });
    if (!missingFile.isDuplicate) pass('checkDuplicate returns false (not a crash) when applications.md is absent');
    else fail('checkDuplicate should not throw or false-positive on a missing tracker file');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
} catch (err) {
  fail(`preflight-check dedup tests crashed: ${err.stack || err.message}`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/preflight-check-dedup.test.mjs`
Expected: crashes with "Cannot find module" or similar — `core/preflight-check.mjs` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```js
// core/preflight-check.mjs
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
import { isMainModule } from './is-main.mjs';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/preflight-check-dedup.test.mjs`
Expected: every `pass(...)` line prints, no `fail(...)` lines.

- [ ] **Step 5: Commit**

```bash
git add core/preflight-check.mjs tests/preflight-check-dedup.test.mjs
git commit -m "feat: add dedup + advertised-comp extraction to preflight-check.mjs"
```

---

### Task 2: `preflight-check.mjs` — clearance/location keyword gate

**Files:**
- Modify: `core/preflight-check.mjs`
- Test: `tests/preflight-check-gate.test.mjs`

**Interfaces:**
- Consumes: nothing new from other tasks (self-contained function in the same file as Task 1)
- Produces: `export function checkGate(text: string, profile?: {clearance?: {status?: string, accepts_sponsorship?: boolean}, location?: {work_mode?: string}}): {pass: boolean, reason: string|null}` — consumed by Task 3's CLI and by the mode-file edits in Tasks 8-9

- [ ] **Step 1: Write the failing tests**

```js
// tests/preflight-check-gate.test.mjs
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\npreflight-check.mjs — clearance/location keyword gate');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'core', 'preflight-check.mjs')).href);

  // Clearance hard stop
  const g1 = mod.checkGate('Must hold an active TS/SCI clearance.', { clearance: { status: 'None', accepts_sponsorship: false } });
  if (g1.pass === false && /clearance/.test(g1.reason)) pass('checkGate hard-stops on unsponsored clearance mismatch');
  else fail(`checkGate clearance hard-stop => ${JSON.stringify(g1)}`);

  // Clearance mentioned but sponsorship accepted -> soft, not a hard stop
  const g2 = mod.checkGate('Must hold an active Secret clearance.', { clearance: { status: 'None', accepts_sponsorship: true } });
  if (g2.pass === true) pass('checkGate does not hard-stop when candidate accepts clearance sponsorship');
  else fail(`checkGate should pass with accepts_sponsorship=true => ${JSON.stringify(g2)}`);

  // No clearance language at all
  const g3 = mod.checkGate('We are looking for a backend engineer.', { clearance: { status: 'None', accepts_sponsorship: false } });
  if (g3.pass === true) pass('checkGate passes when the JD mentions no clearance requirement');
  else fail(`checkGate false positive on clean JD => ${JSON.stringify(g3)}`);

  // Missing clearance profile block entirely -> never crash, never false-positive
  const g4 = mod.checkGate('Requires an active Top Secret clearance.', {});
  if (g4.pass === false) pass('checkGate defaults an absent clearance block to "None" and still hard-stops');
  else fail(`checkGate with no clearance block => ${JSON.stringify(g4)}`);

  // Onsite vs. remote_only hard stop
  const g5 = mod.checkGate('This is an onsite only role, 5 days in office required.', { location: { work_mode: 'remote_only' } });
  if (g5.pass === false && /location/.test(g5.reason)) pass('checkGate hard-stops onsite-only JD against remote_only candidate');
  else fail(`checkGate onsite hard-stop => ${JSON.stringify(g5)}`);

  // Onsite language but candidate has no strict remote requirement
  const g6 = mod.checkGate('This is an onsite only role.', { location: { work_mode: 'no_preference' } });
  if (g6.pass === true) pass('checkGate does not flag onsite-only JDs for a candidate with no_preference');
  else fail(`checkGate should pass with no_preference => ${JSON.stringify(g6)}`);

  // Empty text / empty profile — never throws
  const g7 = mod.checkGate('', {});
  const g8 = mod.checkGate('Some JD text.', undefined);
  if (g7.pass === true && g8.pass === true) pass('checkGate handles empty text and missing profile without throwing');
  else fail(`checkGate empty-input handling => ${JSON.stringify(g7)} / ${JSON.stringify(g8)}`);
} catch (err) {
  fail(`preflight-check gate tests crashed: ${err.stack || err.message}`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/preflight-check-gate.test.mjs`
Expected: crashes — `mod.checkGate is not a function`.

- [ ] **Step 3: Add the implementation**

Append to `core/preflight-check.mjs` (below `checkDuplicate`):

```js
const CLEARANCE_KEYWORDS_RE = /\b(top secret|ts\/sci|\bsci\b|security clearance|active clearance|dod clearance|clearance required|secret clearance)\b/i;
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

  const clearanceMatch = text.match(CLEARANCE_KEYWORDS_RE);
  if (clearanceMatch) {
    const clearance = p.clearance || {};
    const status = clearance.status || 'None';
    const acceptsSponsorship = clearance.accepts_sponsorship === true;
    if (status === 'None' && !acceptsSponsorship) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/preflight-check-gate.test.mjs`
Expected: all `pass(...)`, no `fail(...)`.

- [ ] **Step 5: Commit**

```bash
git add core/preflight-check.mjs tests/preflight-check-gate.test.mjs
git commit -m "feat: add deterministic clearance/location keyword gate to preflight-check.mjs"
```

---

### Task 3: `preflight-check.mjs` — CLI wiring

**Files:**
- Modify: `core/preflight-check.mjs`
- Test: `tests/preflight-check-cli.test.mjs`

**Interfaces:**
- Consumes: `extractAdvertisedComp`, `checkDuplicate`, `checkGate` (Tasks 1-2, same file)
- Produces: CLI contract used by Tasks 8-9's mode-file edits — `node core/preflight-check.mjs --company <c> --role <r> [--text <string>] [--jd-file <path>] [--profile <path>]` prints one JSON line to stdout: `{ duplicate: {isDuplicate, matchedRow}, gate: {pass, reason}, advertisedComp: {...}|null }` and exits 0 on success, exits 1 only on a genuine usage/script error (missing required flags, unreadable file) — a failed *gate* is reported in the JSON, never via exit code, so callers always get a JSON verdict to act on.

- [ ] **Step 1: Write the failing test**

```js
// tests/preflight-check-cli.test.mjs
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\npreflight-check.mjs — CLI');

const scriptPath = join(ROOT, 'core', 'preflight-check.mjs');

try {
  const out1 = execFileSync(NODE, [
    scriptPath, '--company', 'Acme Corp', '--role', 'Backend Engineer',
    '--text', 'We are looking for a backend engineer. Competitive pay.',
  ], { encoding: 'utf-8' });
  const json1 = JSON.parse(out1);
  if (json1.gate?.pass === true && json1.duplicate?.isDuplicate === false && json1.advertisedComp === null) {
    pass('CLI prints a clean-pass JSON verdict for a plain JD with no comp/clearance/dup signal');
  } else {
    fail(`CLI clean-pass output => ${out1}`);
  }
} catch (err) {
  fail(`CLI clean-pass run crashed: ${err.stderr?.toString() || err.message}`);
}

try {
  const tmpDir = mkdtempSync(join(tmpdir(), 'preflight-cli-'));
  const jdPath = join(tmpDir, 'jd.txt');
  writeFileSync(jdPath, 'Requires an active TS/SCI clearance. Salary $150,000 - $200,000.');
  const profilePath = join(tmpDir, 'profile.yml');
  writeFileSync(profilePath, 'clearance:\n  status: "None"\n  accepts_sponsorship: false\n');

  const out2 = execFileSync(NODE, [
    scriptPath, '--company', 'Beta Inc', '--role', 'Cleared Engineer',
    '--jd-file', jdPath, '--profile', profilePath,
  ], { encoding: 'utf-8' });
  const json2 = JSON.parse(out2);
  if (json2.gate?.pass === false && json2.advertisedComp?.low === 150000) {
    pass('CLI reads --jd-file and --profile, hard-stops on clearance, still extracts comp');
  } else {
    fail(`CLI clearance+comp output => ${out2}`);
  }
  rmSync(tmpDir, { recursive: true, force: true });
} catch (err) {
  fail(`CLI clearance+comp run crashed: ${err.stderr?.toString() || err.message}`);
}

try {
  execFileSync(NODE, [scriptPath], { encoding: 'utf-8' });
  fail('CLI should exit non-zero when required flags are missing');
} catch (err) {
  if (err.status === 1) pass('CLI exits 1 with a usage error when --company/--role are missing');
  else fail(`CLI missing-flags exit code => ${err.status}`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/preflight-check-cli.test.mjs`
Expected: fails — no `main()`/CLI entry exists yet, script currently does nothing when run directly.

- [ ] **Step 3: Add the CLI**

Append to `core/preflight-check.mjs`:

```js
function parseArgs(argv) {
  const args = { company: null, role: null, text: '', jdFile: null, profile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--company') args.company = argv[++i];
    else if (argv[i] === '--role') args.role = argv[++i];
    else if (argv[i] === '--text') args.text = argv[++i];
    else if (argv[i] === '--jd-file') args.jdFile = argv[++i];
    else if (argv[i] === '--profile') args.profile = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.company || !args.role) {
    console.error('Usage: node preflight-check.mjs --company <c> --role <r> [--text <string>] [--jd-file <path>] [--profile <path>]');
    process.exit(1);
  }

  let text = args.text || '';
  if (args.jdFile) {
    if (!existsSync(args.jdFile)) {
      console.error(`❌  --jd-file not found: ${args.jdFile}`);
      process.exit(1);
    }
    text += (text ? '\n' : '') + readFileSync(args.jdFile, 'utf-8');
  }

  const yaml = (await import('js-yaml')).default;
  const profilePath = args.profile || join(ROOT, 'config', 'profile.yml');
  let profile = {};
  if (existsSync(profilePath)) {
    try {
      profile = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    } catch (err) {
      console.error(`⚠️  Could not parse ${profilePath}: ${err.message} — gate running with an empty profile.`);
    }
  }

  const result = {
    duplicate: checkDuplicate({ company: args.company, role: args.role }),
    gate: checkGate(text, profile),
    advertisedComp: extractAdvertisedComp(text),
  };
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
```

Remove the unused `loadProfileYaml` stub written above — it was superseded by the inline `js-yaml` load in `main()`; do not leave dead code in the file. (This note is here because the first draft of this step is easy to over-write — the final file should NOT contain `loadProfileYaml`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/preflight-check-cli.test.mjs`
Expected: all `pass(...)`, no `fail(...)`.

- [ ] **Step 5: Confirm no dead code**

Re-read the final `core/preflight-check.mjs`: it should contain exactly `extractAdvertisedComp`, `checkDuplicate`, `checkGate`, `parseArgs`, and `main` — no unused helper functions.

- [ ] **Step 6: Commit**

```bash
git add core/preflight-check.mjs tests/preflight-check-cli.test.mjs
git commit -m "feat: add preflight-check.mjs CLI wiring"
```

---

### Task 4: Config scaffolding — `llm-provider.example.yml`, `.gitignore`, `.env.example`

**Files:**
- Create: `config/llm-provider.example.yml`
- Modify: `.gitignore`
- Modify: `.env.example`

**Interfaces:**
- Produces: the exact YAML shape Task 6/7's `loadProviderConfig()` expects: `{ ollama_cloud: {enabled, base_url, model, api_key_env, timeout_ms}, ollama_local: {enabled, base_url, model, timeout_ms}, tasks: {comp_market_estimate, block_g_signals, risk_summary_draft} }`

- [ ] **Step 1: Create the example config**

```yaml
# config/llm-provider.example.yml
# career-ops — Ollama Cloud task delegation config.
# Copy this file to config/llm-provider.yml to enable it:
#   cp config/llm-provider.example.yml config/llm-provider.yml
# Absent file = the feature is a complete no-op: every pipeline/auto-pipeline
# run behaves exactly like it always has, with Claude doing every step itself.
#
# Tried in order per delegated task: ollama_cloud, then ollama_local, then
# Claude does the task itself inline. See
# docs/superpowers/specs/2026-09-02-ollama-cloud-delegation-design.md.

ollama_cloud:
  enabled: true
  base_url: https://ollama.com/v1
  model: gpt-oss:20b
  api_key_env: OLLAMA_API_KEY   # set OLLAMA_API_KEY in your .env — never put the key here
  timeout_ms: 60000

ollama_local:
  enabled: true
  base_url: http://localhost:11434/v1
  model: qwen2.5:14b-instruct-q4_K_M   # sized for ~8GB VRAM; change to whatever you've pulled
  timeout_ms: 120000

# Per-task on/off switches. Set any to false to keep that one task in Claude
# even when a provider above is enabled.
tasks:
  comp_market_estimate: true
  block_g_signals: true
  risk_summary_draft: true
```

- [ ] **Step 2: Gitignore the user's real copy**

Edit `.gitignore` — in the "User config and customization (never auto-updated)" block (currently listing `config/profile.yml`, `config/cv-facts.json`, `config/benchmarks.yml`, `portals.yml`, `_profile.md`, `_custom.md`, `_brief.md`), add one line:

```
config/llm-provider.yml
```

- [ ] **Step 3: Add the API key slot to `.env.example`**

Edit `.env.example` — after the existing "OpenAI-compatible eval" section, add:

```dotenv
# ── Ollama Cloud delegation (ollama-delegate.mjs) ────────────────────────────
# Required only if config/llm-provider.yml exists with ollama_cloud.enabled: true.
# Free API key: https://ollama.com
# OLLAMA_API_KEY=your_ollama_cloud_key_here
```

- [ ] **Step 4: Verify no test regresses**

Run: `node core/test-all.mjs --quick`
Expected: still green — a new example config + gitignore/env entries touch nothing existing tests assert on. (If any test enumerates `.env.example` keys or `.gitignore` patterns exactly, confirm it isn't broken by the addition; none currently do as of this plan's writing.)

- [ ] **Step 5: Commit**

```bash
git add config/llm-provider.example.yml .gitignore .env.example
git commit -m "feat: add llm-provider.example.yml config scaffold for Ollama Cloud delegation"
```

---

### Task 5: Delegate task instruction files

**Files:**
- Create: `modes/delegate/comp-market-estimate.md`
- Create: `modes/delegate/block-g-signals.md`
- Create: `modes/delegate/risk-summary-draft.md`

**Interfaces:**
- Produces: the exact system-prompt text `ollama-delegate.mjs` (Task 6-7) reads verbatim and sends as the `system` message for each task.

- [ ] **Step 1: Write `modes/delegate/comp-market-estimate.md`**

```markdown
# Delegate task: comp-market-estimate

You are a narrow data-extraction assistant for career-ops, a job-search tool. You are NOT writing an evaluation, a recommendation, or a verdict — only a market compensation estimate, which the calling system will label as an estimate and combine with other facts it already knows.

## Input

You will receive: role title, seniority level, location (city/country or "remote"), and company (name, or "unknown" if not given). You do NOT receive the candidate's resume — never assume any candidate facts.

## Task

Using your training-data knowledge of market compensation, estimate a plausible total-compensation range for this role/location/seniority combination, in the role's stated or most likely currency.

## Output — strict JSON only, no prose, no markdown fences

```json
{
  "estimated_range_low": <number>,
  "estimated_range_high": <number>,
  "currency": "<ISO 4217 code>",
  "basis": "<one short sentence: what role/location/seniority comparison you used>",
  "confidence": "low" | "medium" | "high"
}
```

If you cannot produce a reasonable estimate (unfamiliar role, insufficient location detail), return:

```json
{ "estimated_range_low": null, "estimated_range_high": null, "currency": null, "basis": "insufficient information", "confidence": "low" }
```

Never return anything other than this JSON object.
```

- [ ] **Step 2: Write `modes/delegate/block-g-signals.md`**

```markdown
# Delegate task: block-g-signals

You are a narrow evidence-gathering assistant for career-ops. You are gathering ONE mechanical signal for a human (or a more capable model) to review — you are never deciding a posting's legitimacy tier (High Confidence / Proceed with Caution / Suspicious). That verdict is explicitly out of scope for you.

**Do not attempt jurisdiction, legal, benefits-terminology, agency-licensing, or immigration-requirement matching.** Those require nuanced agent judgment against specific legal source tables and are handled elsewhere — attempting them here would risk a wrong "naive keyword match" the calling system explicitly avoids relying on.

## Input

You will receive the full job description text, and optionally a `posted:` date if the platform provided one.

## Task

Determine the posting's apparent freshness from its own text: does it mention an explicit posting/updated date, relative freshness language ("posted today", "3 days ago", "actively hiring"), or staleness language ("this position may no longer be available", "applications closed")? Report only what the text literally says — do not infer beyond it.

## Output — strict JSON only, no prose, no markdown fences

```json
{
  "explicit_date_mentioned": "<YYYY-MM-DD or null>",
  "relative_freshness_phrase": "<verbatim phrase found, or null>",
  "staleness_phrase": "<verbatim phrase found, or null>",
  "notes": "<one short sentence, or empty string>"
}
```

Never return anything other than this JSON object.
```

- [ ] **Step 3: Write `modes/delegate/risk-summary-draft.md`**

```markdown
# Delegate task: risk-summary-draft

You are a narrow drafting assistant for career-ops. A more capable model has already decided a job evaluation's score, gaps, and legitimacy tier — your only job is to turn those ALREADY-DECIDED facts into a short, readable bullet list. You are not deciding anything, adding any new fact, or second-guessing the inputs you're given.

## Input

You will receive JSON with the decided facts: `{ score, top_gaps: string[], legitimacy_tier, hard_stops: string[] }`.

## Task

Write 2-4 short bullet points summarizing the risk profile of this application, using ONLY the facts given — never invent a gap, number, or concern not present in the input.

## Output — strict JSON only, no prose, no markdown fences

```json
{ "risk_summary_bullets": ["<bullet 1>", "<bullet 2>", "..."] }
```

Never return anything other than this JSON object.
```

- [ ] **Step 4: Verify the files are plain, valid markdown**

Run: `node -e "require('fs').readFileSync('modes/delegate/comp-market-estimate.md','utf8'); require('fs').readFileSync('modes/delegate/block-g-signals.md','utf8'); require('fs').readFileSync('modes/delegate/risk-summary-draft.md','utf8'); console.log('ok')"`
Expected: prints `ok` (just confirms the three files exist and are readable — no markdown linter in this repo).

- [ ] **Step 5: Commit**

```bash
git add modes/delegate/comp-market-estimate.md modes/delegate/block-g-signals.md modes/delegate/risk-summary-draft.md
git commit -m "feat: add delegate task instruction files (modes/delegate/)"
```

---

### Task 6: `ollama-delegate.mjs` — provider config + loopback guard

**Files:**
- Create: `core/ollama-delegate.mjs`
- Test: `tests/ollama-delegate-config.test.mjs`

**Interfaces:**
- Produces: `export function providerConfigPath(): string`, `export function loadProviderConfig(path?: string): object`, `export function isLoopbackUrl(baseUrl: string): boolean` — consumed by Task 7's `callProvider`/`delegate`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/ollama-delegate-config.test.mjs
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nollama-delegate.mjs — provider config + loopback guard');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'core', 'ollama-delegate.mjs')).href);

  const missing = mod.loadProviderConfig(join(ROOT, 'this-file-does-not-exist.yml'));
  if (missing.ollama_cloud?.enabled === false && missing.ollama_local?.enabled === false) {
    pass('loadProviderConfig returns an all-disabled default when the config file is absent');
  } else {
    fail(`loadProviderConfig default => ${JSON.stringify(missing)}`);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'llm-provider-'));
  const cfgPath = join(tmpDir, 'llm-provider.yml');
  writeFileSync(cfgPath, [
    'ollama_cloud:',
    '  enabled: true',
    '  base_url: https://ollama.com/v1',
    '  model: gpt-oss:20b',
    '  api_key_env: OLLAMA_API_KEY',
    '  timeout_ms: 60000',
    'ollama_local:',
    '  enabled: true',
    '  base_url: http://localhost:11434/v1',
    '  model: qwen2.5:14b-instruct-q4_K_M',
    '  timeout_ms: 120000',
    'tasks:',
    '  comp_market_estimate: true',
    '  block_g_signals: true',
    '  risk_summary_draft: false',
  ].join('\n'));

  const loaded = mod.loadProviderConfig(cfgPath);
  if (loaded.ollama_cloud.model === 'gpt-oss:20b' && loaded.tasks.risk_summary_draft === false) {
    pass('loadProviderConfig parses a real config/llm-provider.yml file');
  } else {
    fail(`loadProviderConfig parsed => ${JSON.stringify(loaded)}`);
  }

  const badPath = join(tmpDir, 'bad.yml');
  writeFileSync(badPath, 'ollama_cloud: [this is not: a map');
  const bad = mod.loadProviderConfig(badPath);
  if (bad.ollama_cloud?.enabled === false) pass('loadProviderConfig falls back to the disabled default on invalid YAML instead of throwing');
  else fail(`loadProviderConfig invalid-yaml handling => ${JSON.stringify(bad)}`);

  rmSync(tmpDir, { recursive: true, force: true });

  if (mod.isLoopbackUrl('http://localhost:11434/v1') && mod.isLoopbackUrl('http://127.0.0.1:11434/v1') && !mod.isLoopbackUrl('https://ollama.com/v1')) {
    pass('isLoopbackUrl distinguishes localhost/127.0.0.1 from a remote host');
  } else {
    fail('isLoopbackUrl loopback detection regressed');
  }

  if (mod.isLoopbackUrl('not a url') === false) pass('isLoopbackUrl returns false (not a throw) for an unparseable URL');
  else fail('isLoopbackUrl should return false for garbage input');
} catch (err) {
  fail(`ollama-delegate config tests crashed: ${err.stack || err.message}`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/ollama-delegate-config.test.mjs`
Expected: crashes — `core/ollama-delegate.mjs` doesn't exist yet.

- [ ] **Step 3: Write the implementation (config + guard only)**

```js
#!/usr/bin/env node
/**
 * ollama-delegate.mjs — narrow, single-task delegate calls for career-ops.
 *
 * Unlike ollama-eval.mjs/openai-eval.mjs (which run a FULL A-G evaluation
 * standalone, with no Claude involved), this script handles exactly one
 * small, evidence-gathering task per call, invoked BY Claude mid-pipeline.
 * See docs/superpowers/specs/2026-09-02-ollama-cloud-delegation-design.md.
 *
 * Usage:
 *   node core/ollama-delegate.mjs <task> --input <file>
 *   task: comp-market-estimate | block-g-signals | risk-summary-draft
 *
 * Fallback chain: ollama_cloud -> ollama_local -> exit non-zero (caller does
 * the task itself). Never hangs, never crashes the caller's pipeline.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { isMainModule } from './is-main.mjs';

try {
  const { config } = await import('dotenv');
  config();
} catch { /* dotenv optional */ }

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const DISABLED_CONFIG = { ollama_cloud: { enabled: false }, ollama_local: { enabled: false }, tasks: {} };

/**
 * @returns {string} Path to the user's provider config, overridable for tests.
 */
export function providerConfigPath() {
  return process.env.CAREER_OPS_LLM_PROVIDER_CONFIG || join(ROOT, 'config', 'llm-provider.yml');
}

/**
 * Load config/llm-provider.yml, falling back to an all-disabled config when
 * the file is absent or invalid — delegation is opt-in, so a fresh checkout
 * (or a syntax error) must behave exactly like today, never throw.
 *
 * @param {string} [path]
 * @returns {object}
 */
export function loadProviderConfig(path = providerConfigPath()) {
  if (!existsSync(path)) return DISABLED_CONFIG;
  try {
    const parsed = yaml.load(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : DISABLED_CONFIG;
  } catch (err) {
    console.error(`⚠️  Could not parse ${path}: ${err.message} — delegation disabled for this call.`);
    return DISABLED_CONFIG;
  }
}

/**
 * Loopback-only guard, same rule ollama-eval.mjs already applies to a local
 * Ollama endpoint: a non-localhost "local" URL is refused unless explicitly
 * allowed, so a misconfigured base_url can't silently start sending JD text
 * somewhere remote under a name that promises it stays on-machine.
 *
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isLoopbackUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/ollama-delegate-config.test.mjs`
Expected: all `pass(...)`, no `fail(...)`.

- [ ] **Step 5: Commit**

```bash
git add core/ollama-delegate.mjs tests/ollama-delegate-config.test.mjs
git commit -m "feat: add ollama-delegate.mjs provider config loading + loopback guard"
```

---

### Task 7: `ollama-delegate.mjs` — cloud→local fallback chain + CLI

**Files:**
- Modify: `core/ollama-delegate.mjs`
- Test: `tests/ollama-delegate-fallback.test.mjs`

**Interfaces:**
- Consumes: `loadProviderConfig`, `isLoopbackUrl` (Task 6, same file); `modes/delegate/*.md` (Task 5)
- Produces: `export async function callProvider(providerCfg: object, messages: {systemPrompt: string, userContent: string}, opts?: {enforceLoopback?: boolean}): Promise<{ok: true, json: object} | {ok: false, error: string}>`, `export async function delegate(task: string, inputText: string, config?: object): Promise<object>` (throws on total failure), and the final CLI contract: `node core/ollama-delegate.mjs <task> --input <file>` — prints the resolved JSON to stdout and exits 0, or prints an error to stderr and exits 1.

- [ ] **Step 1: Write the failing tests**

```js
// tests/ollama-delegate-fallback.test.mjs
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nollama-delegate.mjs — cloud/local fallback chain');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'core', 'ollama-delegate.mjs')).href);
  const originalFetch = globalThis.fetch;

  // 1. Cloud succeeds -> local is never called.
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  try {
    const result = await mod.callProvider(
      { base_url: 'https://ollama.com/v1', model: 'gpt-oss:20b', api_key_env: 'OLLAMA_API_KEY', timeout_ms: 5000 },
      { systemPrompt: 'sys', userContent: 'usr' },
    );
    if (result.ok && result.json.ok === true && calls === 1) pass('callProvider parses a successful JSON response');
    else fail(`callProvider success path => ${JSON.stringify(result)}`);
  } finally { globalThis.fetch = originalFetch; }

  // 2. Response wraps JSON in a markdown code fence -> still parsed.
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '```json\n{"wrapped":true}\n```' } }],
  }), { status: 200 });
  try {
    const result = await mod.callProvider(
      { base_url: 'https://ollama.com/v1', model: 'x', timeout_ms: 5000 },
      { systemPrompt: 'sys', userContent: 'usr' },
    );
    if (result.ok && result.json.wrapped === true) pass('callProvider salvages JSON wrapped in a markdown fence');
    else fail(`callProvider fenced-JSON handling => ${JSON.stringify(result)}`);
  } finally { globalThis.fetch = originalFetch; }

  // 3. Non-200 -> ok:false, never throws.
  globalThis.fetch = async () => new Response('server error', { status: 500 });
  try {
    const result = await mod.callProvider({ base_url: 'https://ollama.com/v1', model: 'x', timeout_ms: 5000 }, { systemPrompt: 's', userContent: 'u' });
    if (result.ok === false && /500/.test(result.error)) pass('callProvider reports a non-200 response as ok:false, not a throw');
    else fail(`callProvider HTTP-error handling => ${JSON.stringify(result)}`);
  } finally { globalThis.fetch = originalFetch; }

  // 4. Non-loopback "local" endpoint is refused when enforceLoopback is set.
  globalThis.fetch = async () => { fail('callProvider must not fetch a refused non-loopback endpoint'); return new Response('{}'); };
  try {
    const result = await mod.callProvider(
      { base_url: 'https://not-actually-local.example/v1', model: 'x', timeout_ms: 5000 },
      { systemPrompt: 's', userContent: 'u' },
      { enforceLoopback: true },
    );
    if (result.ok === false && /loopback/.test(result.error)) pass('callProvider refuses a non-loopback endpoint when enforceLoopback is set');
    else fail(`callProvider loopback guard => ${JSON.stringify(result)}`);
  } finally { globalThis.fetch = originalFetch; }

  // 5. delegate(): cloud fails, local succeeds -> local's result wins.
  let cloudCalled = false, localCalled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('ollama.com')) { cloudCalled = true; return new Response('down', { status: 503 }); }
    localCalled = true;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"explicit_date_mentioned":null,"relative_freshness_phrase":null,"staleness_phrase":null,"notes":""}' } }] }), { status: 200 });
  };
  try {
    const cfg = {
      ollama_cloud: { enabled: true, base_url: 'https://ollama.com/v1', model: 'gpt-oss:20b', timeout_ms: 5000 },
      ollama_local: { enabled: true, base_url: 'http://localhost:11434/v1', model: 'qwen2.5:14b', timeout_ms: 5000 },
      tasks: {},
    };
    const result = await mod.delegate('block-g-signals', 'some JD text', cfg);
    if (cloudCalled && localCalled && result.explicit_date_mentioned === null) {
      pass('delegate() falls back from cloud to local and returns the local result');
    } else {
      fail(`delegate() fallback => cloudCalled=${cloudCalled} localCalled=${localCalled} result=${JSON.stringify(result)}`);
    }
  } finally { globalThis.fetch = originalFetch; }

  // 6. delegate(): both providers fail -> throws with both errors named.
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const cfg = {
      ollama_cloud: { enabled: true, base_url: 'https://ollama.com/v1', model: 'x', timeout_ms: 5000 },
      ollama_local: { enabled: true, base_url: 'http://localhost:11434/v1', model: 'x', timeout_ms: 5000 },
      tasks: {},
    };
    let threw = null;
    try { await mod.delegate('comp-market-estimate', 'text', cfg); } catch (e) { threw = e; }
    if (threw && /ollama_cloud/.test(threw.message) && /ollama_local/.test(threw.message)) {
      pass('delegate() throws naming both failed providers when neither succeeds');
    } else {
      fail(`delegate() both-fail handling => ${threw?.message}`);
    }
  } finally { globalThis.fetch = originalFetch; }

  // 7. delegate(): task disabled in config -> throws without ever calling fetch.
  globalThis.fetch = async () => { fail('delegate() must not call fetch for a disabled task'); return new Response('{}'); };
  try {
    const cfg = { ollama_cloud: { enabled: true, base_url: 'https://ollama.com/v1', model: 'x' }, ollama_local: { enabled: false }, tasks: { risk_summary_draft: false } };
    let threw = null;
    try { await mod.delegate('risk-summary-draft', '{}', cfg); } catch (e) { threw = e; }
    if (threw && /disabled/.test(threw.message)) pass('delegate() refuses a task disabled in config/llm-provider.yml');
    else fail(`delegate() disabled-task handling => ${threw?.message}`);
  } finally { globalThis.fetch = originalFetch; }

  // 8. Unknown task -> throws immediately.
  let threwUnknown = null;
  try { await mod.delegate('not-a-real-task', 'x', { tasks: {} }); } catch (e) { threwUnknown = e; }
  if (threwUnknown && /unknown task/.test(threwUnknown.message)) pass('delegate() rejects an unrecognized task name');
  else fail(`delegate() unknown-task handling => ${threwUnknown?.message}`);
} catch (err) {
  fail(`ollama-delegate fallback tests crashed: ${err.stack || err.message}`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/ollama-delegate-fallback.test.mjs`
Expected: crashes — `mod.callProvider`/`mod.delegate` are not functions yet.

- [ ] **Step 3: Add the fallback chain + CLI**

Append to `core/ollama-delegate.mjs`:

```js
const TASKS = {
  'comp-market-estimate': 'comp-market-estimate.md',
  'block-g-signals': 'block-g-signals.md',
  'risk-summary-draft': 'risk-summary-draft.md',
};

/**
 * Call one OpenAI-compatible chat-completions endpoint and parse the
 * response as strict JSON, salvaging a markdown-fenced JSON body if the
 * model wrapped it in one.
 *
 * @param {object} providerCfg - One of config.ollama_cloud / config.ollama_local.
 * @param {{systemPrompt: string, userContent: string}} messages
 * @param {{enforceLoopback?: boolean}} [opts] - Set true for the local leg.
 * @returns {Promise<{ok: true, json: object} | {ok: false, error: string}>}
 */
export async function callProvider(providerCfg, { systemPrompt, userContent }, { enforceLoopback = false } = {}) {
  const baseUrl = (providerCfg.base_url || '').replace(/\/$/, '');
  if (!baseUrl) return { ok: false, error: 'no base_url configured' };

  if (enforceLoopback && !isLoopbackUrl(baseUrl) && process.env.OLLAMA_ALLOW_REMOTE !== '1') {
    return { ok: false, error: `refusing non-loopback local endpoint: ${baseUrl} (set OLLAMA_ALLOW_REMOTE=1 to override)` };
  }

  const apiKey = providerCfg.api_key_env ? process.env[providerCfg.api_key_env] : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const timeoutMs = providerCfg.timeout_ms || 60000;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: providerCfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        stream: false,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: false, error: 'empty response' };

    let json;
    try {
      json = JSON.parse(content);
    } catch {
      const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) {
        try { json = JSON.parse(fenced[1]); } catch { /* fall through */ }
      }
      if (!json) return { ok: false, error: `non-JSON response: ${content.slice(0, 200)}` };
    }
    return { ok: true, json };
  } catch (err) {
    if (err.name === 'TimeoutError') return { ok: false, error: `timed out after ${timeoutMs}ms` };
    return { ok: false, error: err.message };
  }
}

/**
 * Run one delegated task through the ollama_cloud -> ollama_local fallback
 * chain, reading the task's instructions from modes/delegate/*.md.
 *
 * @param {string} task - One of the TASKS keys.
 * @param {string} inputText - The JD/role text (and any preflight output) to send.
 * @param {object} [config] - Provider config; defaults to loadProviderConfig().
 * @returns {Promise<object>} The parsed JSON result from whichever provider succeeded.
 * @throws {Error} When the task is unknown, disabled, or both providers fail.
 */
export async function delegate(task, inputText, config = loadProviderConfig()) {
  const taskFile = TASKS[task];
  if (!taskFile) throw new Error(`unknown task: ${task}`);

  const taskKey = task.replace(/-/g, '_');
  if (config.tasks && config.tasks[taskKey] === false) {
    throw new Error(`task "${task}" is disabled in config/llm-provider.yml`);
  }

  const promptPath = join(ROOT, 'modes', 'delegate', taskFile);
  if (!existsSync(promptPath)) throw new Error(`missing task instructions: ${promptPath}`);
  const systemPrompt = readFileSync(promptPath, 'utf-8').trim();

  const attempts = [];
  for (const providerName of ['ollama_cloud', 'ollama_local']) {
    const providerCfg = config[providerName];
    if (!providerCfg || providerCfg.enabled === false) continue;
    const result = await callProvider(
      providerCfg,
      { systemPrompt, userContent: inputText },
      { enforceLoopback: providerName === 'ollama_local' },
    );
    if (result.ok) return result.json;
    attempts.push(`${providerName}: ${result.error}`);
  }

  throw new Error(`all providers failed for task "${task}": ${attempts.join('; ') || 'no provider enabled'}`);
}

async function main() {
  const [, , task, ...rest] = process.argv;
  const inputIdx = rest.indexOf('--input');
  const inputPath = inputIdx !== -1 ? rest[inputIdx + 1] : null;

  if (!task || !TASKS[task] || !inputPath) {
    console.error('Usage: node ollama-delegate.mjs <task> --input <file>');
    console.error(`  task: ${Object.keys(TASKS).join(' | ')}`);
    process.exit(1);
  }
  if (!existsSync(inputPath)) {
    console.error(`❌  Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const inputText = readFileSync(inputPath, 'utf-8');
  try {
    const json = await delegate(task, inputText);
    console.log(JSON.stringify(json));
    process.exit(0);
  } catch (err) {
    console.error(`❌  ${err.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/ollama-delegate-fallback.test.mjs`
Expected: all `pass(...)`, no `fail(...)`.

- [ ] **Step 5: Commit**

```bash
git add core/ollama-delegate.mjs tests/ollama-delegate-fallback.test.mjs
git commit -m "feat: add ollama-delegate.mjs cloud/local fallback chain + CLI"
```

---

### Task 8: Wire `preflight-check.mjs` into `pipeline.md` and `batch-prompt.md`

**Files:**
- Modify: `modes/pipeline.md`
- Modify: `batch/batch-prompt.md`

**Interfaces:**
- Consumes: `preflight-check.mjs`'s CLI contract from Task 3 (`--company`, `--role`, `--text`/`--jd-file`, JSON output `{duplicate, gate, advertisedComp}`)

- [ ] **Step 1: Edit `modes/pipeline.md`'s Metadata pre-filter section**

In `modes/pipeline.md`, replace this paragraph (currently lines 14-20):

```
Judge each row carrying title/location metadata against the same conservative hard-stop bar the
post-fetch pre-screen gate uses (`config/profile.yml` archetypes/clearance/location — see
`_custom.md`'s tiered-report-depth rule): missing required clearance stated in the title, an
unambiguously wrong professional domain in the title, or an explicit onsite-only location
conflicting with a hard remote requirement. This is deliberately conservative and only fires on the
same unambiguous-mismatch bar the post-fetch gate uses — a bare `- [ ] {url}` row with no
title/location metadata has nothing to judge and falls through unchanged, same as before.
```

with:

```
For each row carrying title/location metadata, run `node core/preflight-check.mjs --company "{company}" --role "{title}" --text "{title} {location}"` (a bare `- [ ] {url}` row with no title/location metadata has nothing to check and falls through unchanged, same as before). This deterministic, zero-token check catches the two unambiguous hard stops a script can judge safely: a clearance requirement the candidate's `config/profile.yml` `clearance.status`/`accepts_sponsorship` can't meet, and an explicit onsite-only requirement against a `location.work_mode: remote_only` candidate. If `gate.pass` is `false`, treat it as a metadata-prefilter mismatch using `gate.reason`. A "wrong professional domain" judgment call is NOT attempted by the script (too fuzzy for reliable regex) and is not part of this pre-fetch pass — it's still caught later by the post-fetch pre-screen gate's archetype judgment below, same as today.
```

- [ ] **Step 2: Edit `modes/pipeline.md`'s Pre-screen gate section**

Replace this line (currently line 47):

```
- **`standard` or `premium` tier:** Before running the full A-F evaluation on a pending URL that survived the liveness sweep, run a cheap pre-screen pass using the tier's economy-equivalent model (see the mapping table in `modes/_shared.md`) against the candidate's North Star archetypes (`_profile.md`). If the JD is an obvious mismatch, skip the full evaluation: mark it `- [x] #-- | {url} | skipped (pre-screen mismatch: {reason})` in "Processed" and continue to the next URL.
```

with:

```
- **`standard` or `premium` tier:** Before running the tier's cheap archetype pass below, run `node core/preflight-check.mjs --company "{company}" --role "{role}" --jd-file <extracted JD file>` against the already-extracted JD text. If `gate.pass` is `false`, skip the LLM pass entirely and treat it as a pre-screen mismatch using `gate.reason` — no model call needed for a clearance or onsite-only hard stop the script already caught for free. Otherwise, run the existing cheap pre-screen pass using the tier's economy-equivalent model (see the mapping table in `modes/_shared.md`) against the candidate's North Star archetypes (`_profile.md`) for the softer, ambiguous fit judgment the script doesn't attempt. If that pass also finds an obvious mismatch, skip the full evaluation: mark it `- [x] #-- | {url} | skipped (pre-screen mismatch: {reason})` in "Processed" and continue to the next URL.
```

- [ ] **Step 3: Edit `batch/batch-prompt.md` Step 1.5**

Replace this line (currently line 106):

```
   **Clearance gate specifically:** Search the JD for keywords: "Secret", "Top Secret", "TS/SCI", "SCI", "TS", "security clearance", "active clearance", "DoD clearance", "clearance required". If any clearance is mentioned, read `config/profile.yml` → `clearance.status` and `clearance.accepts_sponsorship`:
   - If candidate's `clearance.status` is "None" AND `clearance.accepts_sponsorship` is false → this is a HARD STOP
   - If candidate's `clearance.status` is "None" AND `clearance.accepts_sponsorship` is true → soft gate (not a hard stop; proceed to full evaluation, note the requirement in Block A)
```

with:

```
   **Clearance gate specifically:** Run `node core/preflight-check.mjs --company "{company}" --role "{role}" --jd-file <extracted JD file>` — it searches the JD for clearance keywords and checks them against `config/profile.yml` → `clearance.status`/`clearance.accepts_sponsorship` deterministically, with zero tokens. If `gate.pass` is `false` and `gate.reason` mentions clearance, this is a HARD STOP. If the JD mentions clearance but `gate.pass` is `true` (candidate accepts sponsorship), this is a soft gate — not a hard stop; proceed to full evaluation and note the requirement in Block A.
```

- [ ] **Step 4: Run the reference-sweep guard**

Run: `node core/validate-script-references.mjs`
Expected: exits 0 — every `node core/preflight-check.mjs` reference just added resolves to a real file (it does, from Task 3).

- [ ] **Step 5: Commit**

```bash
git add modes/pipeline.md batch/batch-prompt.md
git commit -m "feat: wire preflight-check.mjs into pipeline.md and batch-prompt.md pre-screen gates"
```

---

### Task 9: Wire `ollama-delegate.mjs` into `pipeline.md` and `auto-pipeline.md`

**Files:**
- Modify: `modes/pipeline.md`
- Modify: `modes/auto-pipeline.md`

**Interfaces:**
- Consumes: `ollama-delegate.mjs`'s CLI contract from Task 7 (`node core/ollama-delegate.mjs <task> --input <file>`)

- [ ] **Step 1: Insert a new sub-step into `modes/pipeline.md`'s per-URL workflow**

In `modes/pipeline.md`'s "Workflow" section, between step `d.` (Pre-screen gate) and step `e.` (Claim the next sequential `REPORT_NUM`), insert:

```
   d2. **Pre-gathered signals (optional, zero-risk).** If `config/llm-provider.yml` exists, run `node core/ollama-delegate.mjs comp-market-estimate --input <JD file>` and `node core/ollama-delegate.mjs block-g-signals --input <JD file>`. Either call may fail (config absent, both providers down, task disabled) — that is expected and NOT an error: on any non-zero exit, simply proceed to step (f) without that pre-gathered input, exactly as the pipeline behaves today. On success, pass the returned JSON into step (f)'s evaluation as an extra input for Claude to verify and cite — never as a fact taken on faith, and never as a substitute for Block B/C or Block G's final tier verdict, which stay entirely Claude's judgment call.
```

- [ ] **Step 2: Insert the equivalent step into `modes/auto-pipeline.md`**

In `modes/auto-pipeline.md`, between "Step 0.6 — Blacklist gate" and "Step 1 — A-G Evaluation", insert a new section:

```markdown
## Step 0.7 — Pre-gathered signals (optional, zero-risk)

If `config/llm-provider.yml` exists, run `node core/ollama-delegate.mjs comp-market-estimate --input <JD file>` and `node core/ollama-delegate.mjs block-g-signals --input <JD file>` against the JD extracted in Step 0. Either call may fail (config absent, both providers down, task disabled) — that is expected and NOT an error: on any non-zero exit, proceed to Step 1 without that input, exactly as this mode behaves today. On success, pass the returned JSON into Step 1's evaluation as an extra input for Claude to verify and cite — never as a fact taken on faith, and never as a substitute for Block B/C or Block G's final tier verdict, which stay entirely Claude's judgment call. `oferta.md` itself is unchanged by this step; it simply receives a richer input.
```

- [ ] **Step 3: Run the reference-sweep guard**

Run: `node core/validate-script-references.mjs`
Expected: exits 0.

- [ ] **Step 4: Run the full suite**

Run: `node core/test-all.mjs --quick`
Expected: green — mode-file prose edits don't touch executable code paths, but this confirms nothing else regressed.

- [ ] **Step 5: Commit**

```bash
git add modes/pipeline.md modes/auto-pipeline.md
git commit -m "feat: wire ollama-delegate.mjs pre-gathered signals into pipeline.md and auto-pipeline.md"
```

---

### Task 10: Document the delegation split in `modes/_custom.md`

**Files:**
- Create (if absent): `modes/_custom.md` (copied from `modes/_custom.template.md`)
- Modify: `modes/_custom.md`

**Interfaces:**
- None — documentation only, read by future Claude sessions, not by any script.

- [ ] **Step 1: Create `modes/_custom.md` if it doesn't exist**

Check: does `modes/_custom.md` exist? If not, copy `modes/_custom.template.md` to `modes/_custom.md` verbatim (matching the same auto-copy convention `doctor.mjs` already uses for this file) — it is gitignored (user layer), so this is a local file creation, not a tracked-file commit.

```bash
test -f modes/_custom.md || cp modes/_custom.template.md modes/_custom.md
```

- [ ] **Step 2: Add the delegation-rules section**

Edit `modes/_custom.md`, adding a new section (after "House Rules", before "Custom Workflows" — or at the end if the file's structure differs from the template):

```markdown
## Ollama Cloud Task Delegation

When `config/llm-provider.yml` exists (see `config/llm-provider.example.yml`), pipeline/auto-pipeline/batch runs delegate three narrow tasks to Ollama Cloud (falling back to local Ollama, then to me doing it myself):

- **LIGHT (always local, zero LLM):** `core/preflight-check.mjs` — dedup against the tracker, a deterministic clearance/onsite-vs-remote keyword hard-stop, and advertised-comp regex extraction. Replaces three previously-duplicated LLM pre-screen prompts. Called automatically per `modes/pipeline.md`'s Metadata pre-filter and Pre-screen gate sections, and `batch/batch-prompt.md`'s Step 1.5.
- **MEDIUM (delegate to Ollama Cloud/local via `core/ollama-delegate.mjs`):**
  - `comp-market-estimate` and `block-g-signals` (posting-freshness parsing only — no jurisdiction/legal-template matching, which stays with me): called automatically per `modes/pipeline.md`'s per-URL workflow (step d2) and `modes/auto-pipeline.md`'s Step 0.7, before the A-G evaluation starts.
  - `risk-summary-draft` (formatting already-decided facts into bullets, never deciding new ones): this one has no automatic call site in a mode file — after I've decided an evaluation's score, top gaps, and Block G legitimacy tier, and I'm about to write the report's risk-summary prose, I optionally run `node core/ollama-delegate.mjs risk-summary-draft --input <file with {score, top_gaps, legitimacy_tier, hard_stops} as JSON>` and use its `risk_summary_bullets` as a drafting aid — editing freely, never citing a bullet that adds a fact beyond what I already decided. If the call fails or `config/llm-provider.yml` is absent, I just write the risk summary myself, exactly as today.
- **HEAVY (always me, never delegated):** Block B CV-citation/gaps, Block C leveling/negotiation, Block G's final legitimacy verdict, Blocks E/F, ambiguous pre-screen calls, cover letters, interview prep, negotiation, tailoring, onboarding.

`modes/oferta.md` and its scoring rubric are never touched by this — delegated output is always a pre-computed input I verify and cite, never a fact or verdict I take on faith. See `docs/superpowers/specs/2026-09-02-ollama-cloud-delegation-design.md` for the full design.
```

- [ ] **Step 3: Sanity-check the file is well-formed**

Run: `node -e "require('fs').readFileSync('modes/_custom.md','utf8'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 4: Confirm the file stays untracked**

Run: `git status --porcelain modes/_custom.md`
Expected: no output (the file is gitignored per `.gitignore`'s existing `_custom.md` entry — confirm it does NOT show as untracked-and-stageable; if it does, stop and re-check `.gitignore` before proceeding, since this file must never be committed).

- [ ] **Step 5: No commit for this task**

`modes/_custom.md` is gitignored user-layer content — there is nothing to commit. This task's deliverable is the local file itself, verified in Steps 3-4.

---

### Task 11: Full-suite validation + live smoke test

**Files:**
- None created/modified — this task only runs verification.

**Interfaces:**
- None.

- [ ] **Step 1: Run the full automated test suite**

Run: `node core/test-all.mjs`
Expected: `🟢 All tests passed — safe to push/merge`. If anything fails, fix it before continuing — do not proceed to Step 2 with a red suite.

- [ ] **Step 2: Run the script-reference validator explicitly**

Run: `node core/validate-script-references.mjs`
Expected: exits 0. (Already run in Tasks 8-9, but the full suite in Step 1 may have touched other files — re-confirm here as the final gate.)

- [ ] **Step 3: Live smoke test against Ollama Cloud (manual, requires the user's real key)**

This step needs a real `OLLAMA_API_KEY` in `.env` and `config/llm-provider.yml` copied from the example — neither is committed, so this step is run interactively, not by CI. Ask the user (or run it yourself if `.env`/`config/llm-provider.yml` are already in place) to execute:

```bash
cp config/llm-provider.example.yml config/llm-provider.yml   # if not already done
echo 'This is a Staff Backend Engineer role in Berlin, Germany, hybrid, at a Series B fintech startup.' > /tmp/smoke-jd.txt
node core/ollama-delegate.mjs comp-market-estimate --input /tmp/smoke-jd.txt
node core/ollama-delegate.mjs block-g-signals --input /tmp/smoke-jd.txt
```

Expected: both calls print a single JSON line to stdout (per each task's schema in `modes/delegate/*.md`) and exit 0. Report the actual output — do not assume success without seeing it, since this is the one leg (`gpt-oss:20b` producing usable JSON for these exact prompts) that hasn't been exercised anywhere in the automated suite.

- [ ] **Step 4: Live smoke test of the local fallback (manual, optional)**

If the user wants to verify the local-Ollama leg specifically (requires `ollama serve` running locally with `qwen2.5:14b-instruct-q4_K_M` pulled, or their chosen alternative model set in `config/llm-provider.yml`):

```bash
OLLAMA_CLOUD_DISABLED_FOR_TEST=1 node -e "
const mod = await import('./core/ollama-delegate.mjs');
const cfg = mod.loadProviderConfig();
cfg.ollama_cloud.enabled = false;
const result = await mod.delegate('block-g-signals', require('fs').readFileSync('/tmp/smoke-jd.txt', 'utf-8'), cfg);
console.log(JSON.stringify(result));
"
```

Expected: prints JSON from the local model. If it fails, that's useful signal about whether `qwen2.5:14b-instruct-q4_K_M` (or the user's chosen local model) is adequate for this task on their hardware — report the actual error rather than assuming the config is wrong.

- [ ] **Step 5: Final commit (if Steps 3-4 required any fixes)**

Only if the live smoke tests surfaced a bug fixed along the way:

```bash
git add -A
git commit -m "fix: address issues found during Ollama Cloud delegation smoke test"
```

If nothing needed fixing, there is nothing to commit for this task — Task 11 is a verification gate, not a code change.
