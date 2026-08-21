#!/usr/bin/env node

/**
 * validate-script-references.mjs — structural coverage check for the
 * core/ script-path move (#workspace-multitenancy Task 1, 2026-08-15).
 *
 * Every core/*.mjs script is invoked by shell command from many places
 * across the repo's docs, CI workflows, and other prose — README files,
 * mode files, AGENTS.md, plugin skill.md docs, CI workflow YAML. A bare
 * `node {script}.mjs` reference in any of these is broken: none of these
 * scripts live at the repo root anymore, only under core/. Task 1's own
 * verification swept only the JS import graph between the moved files
 * themselves, never this class of reference — found live 2026-08-20 when
 * a Telegram acknowledgment silently failed because modes/telegram.md
 * still said `node plugins.mjs`.
 *
 * Run: node validate-script-references.mjs
 * Exit 0 = clean. Exit 1 = violations listed.
 */

import { execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ROOT is this script's own directory (core/) — used to enumerate sibling
// .mjs scripts. REPO_ROOT is one level up, the actual repo root `git
// ls-files` must run from.
const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(ROOT);

// Frozen historical records — never corrected retroactively to match
// current reality (same convention as this repo's own completed specs/plans
// generally; see AGENTS.md's Data Contract for the equivalent user-layer
// rule).
const EXCLUDE_PREFIXES = ['archive/', 'docs/superpowers/plans/', 'docs/superpowers/specs/'];

function isExcluded(file) {
  return EXCLUDE_PREFIXES.some((p) => file.startsWith(p));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let tracked;
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8' })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
} catch (err) {
  console.error('FAIL: git ls-files failed:', err.message);
  process.exit(1);
}

// An empty file list means this run could not inspect anything — reporting
// success would make the guard a no-op. Same failure class documented in
// validate-system-paths-coverage.mjs: a check that cannot look must fail,
// not pass.
if (tracked.length === 0) {
  console.error('FAIL: git ls-files returned no paths — this run could not inspect anything.');
  console.error('');
  console.error('Run this from the repository root. An empty listing usually means the');
  console.error('script was invoked from an untracked directory (a temp copy, a fixture');
  console.error('dir), where git reports nothing and the coverage check is meaningless.');
  process.exit(1);
}

let scripts;
try {
  scripts = readdirSync(ROOT).filter((f) => f.endsWith('.mjs'));
} catch (err) {
  console.error('FAIL: could not read core/ directory:', err.message);
  process.exit(1);
}
if (scripts.length === 0) {
  console.error('FAIL: no .mjs scripts found in core/ — this run could not inspect anything.');
  process.exit(1);
}

const scanFiles = tracked.filter(
  (f) => (f.endsWith('.md') || f.endsWith('.yml') || f.endsWith('.yaml')) && !isExcluded(f),
);

const violations = [];
for (const file of scanFiles) {
  let content;
  try {
    content = readFileSync(join(REPO_ROOT, file), 'utf-8');
  } catch {
    continue; // tracked but not present locally — nothing to scan
  }
  const lines = content.split(/\r?\n/);
  for (const script of scripts) {
    const esc = escapeRegExp(script);
    // Word-boundary-ish trailing guard (?![\w.-]) so "node scan.mjs" doesn't
    // false-match inside a longer token like "node scan.mjs2" or
    // "node scan.mjs-old". No guard is needed on the *preceding* side: the
    // literal substring "node scan.mjs" never occurs inside "node
    // core/scan.mjs" (there's "core/" in between), so a correctly-prefixed
    // reference can never trigger this pattern.
    const bareRe = new RegExp(`node ${esc}(?![\\w.-])`);
    const copsRe = new RegExp(`\\./cops node ${esc}(?![\\w.-])`);
    lines.forEach((line, idx) => {
      if (copsRe.test(line)) {
        violations.push(`${file}:${idx + 1}: bare './cops node ${script}' — should be './cops node core/${script}'`);
        return;
      }
      if (bareRe.test(line)) {
        violations.push(`${file}:${idx + 1}: bare 'node ${script}' — should be 'node core/${script}'`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`Found ${violations.length} stale bare script reference(s):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error('');
  console.error('Every core/*.mjs script moved out of the repo root (#workspace-multitenancy');
  console.error('Task 1, 2026-08-15) — prefix each reference with core/.');
  process.exit(1);
}

console.log(`OK: ${scanFiles.length} doc/CI files scanned against ${scripts.length} core/ scripts, no stale bare references`);
process.exit(0);
