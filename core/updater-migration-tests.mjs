#!/usr/bin/env node

/**
 * updater-migration-tests.mjs — source-level safety checks for update-system.
 *
 * Protects cross-version migrations where an older installed updater must fetch
 * newly introduced system paths without touching user data.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

// Read update-system.mjs relative to this script's own location, not
// process.cwd(): a bare 'update-system.mjs' only happened to work when both
// files sat at the repo root. Now that #workspace-multitenancy Task 1 moved
// them into core/ together, they must be addressed as siblings so this test
// (and the throwaway-copy run in test-all.mjs's Script Execution section)
// both resolve it correctly regardless of the caller's cwd.
const UPDATE_SYSTEM_PATH = fileURLToPath(new URL('./update-system.mjs', import.meta.url));

let passed = 0;
let failed = 0;

function pass(message) {
  console.log(`PASS ${message}`);
  passed++;
}

function fail(message) {
  console.error(`FAIL ${message}`);
  failed++;
}

let source = '';
try {
  source = readFileSync(UPDATE_SYSTEM_PATH, 'utf-8');
  pass('update-system.mjs is readable');
} catch (error) {
  fail(`update-system.mjs is readable: ${error.message}`);
  process.exit(1);
}

function extractArray(name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) {
    fail(`${name} array exists`);
    return [];
  }
  pass(`${name} array exists`);
  return Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g), (entry) => entry[1]);
}

const systemPaths = extractArray('SYSTEM_PATHS');
const userPaths = extractArray('USER_PATHS');
const bootstrapPaths = extractArray('BOOTSTRAP_PATHS');

// Every concrete (non-directory) manifest entry (SYSTEM_PATHS or
// BOOTSTRAP_PATHS) must exist in the working tree. A path deleted upstream
// but left in the manifest survives as a permanent `error: pathspec ...` in
// every user's upgrade output (#2002). Directory entries (trailing '/') are
// exempt: git checkout of a directory pathspec tolerates content drift
// inside it. Add an entry to ALLOWED_MISSING_ENTRIES only with a comment
// justifying why it may legitimately be absent.
const ALLOWED_MISSING_ENTRIES = new Set([]);
for (const [listName, entries] of [['SYSTEM_PATHS', systemPaths], ['BOOTSTRAP_PATHS', bootstrapPaths]]) {
  for (const entry of entries) {
    if (entry.endsWith('/')) continue;
    if (ALLOWED_MISSING_ENTRIES.has(entry)) continue;
    if (existsSync(entry)) {
      pass(`${listName} entry exists on disk: ${entry}`);
    } else {
      fail(`${listName} entry missing from tree (stale manifest entry, #2002): ${entry}`);
    }
  }
}

const requiredSystemPaths = [
  'modes/email.md',
  'modes/followup.md',
  'modes/interview.md',
  'modes/interview-prep.md',
  'modes/patterns.md',
  'modes/update.md',
  'modes/ar/',
  'modes/hi/',
  'modes/tr/',
  'modes/ua/',
  'batch/README.md',
  'examples/',
  'config/profile.example.yml',
  '.env.example',
  '.claude-plugin/',
  '.qwen/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  '.cursor/skills/',
  // #workspace-multitenancy Task 1: individual core/*.mjs scripts (including
  // tracker-columns-tests.mjs and updater-migration-tests.mjs, this file's
  // own former sentinels) are covered via this single directory entry now,
  // not by bare filenames — see SYSTEM_PATHS' 'core/' entry.
  'core/',
  'README.ar.md',
  'README.de.md',
  'README.hi.md',
  'README.ja.md',
  'README.ua.md',
  'CHANGELOG.md',
  // de-brand-personal-fork Task 3: CODE_OF_CONDUCT.md, GOVERNANCE.md,
  // SECURITY.md, SUPPORT.md, and TRADEMARK.md described upstream's own
  // community/governance structure and were deleted along with the rest of
  // the manifesto/governance feature; they were removed from SYSTEM_PATHS
  // too, so they no longer belong in this required-coverage list either.
];

const requiredBootstrapPaths = [
  '.agents/',
  '.cursor/skills/',
  '.opencode/skills/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  'providers/',
  // #workspace-multitenancy Task 1: these live under core/ now (BOOTSTRAP_PATHS
  // has no blanket 'core/' entry the way SYSTEM_PATHS does, so each bootstrap
  // file keeps its own prefixed entry).
  'core/liveness-browser.mjs',
  'core/role-matcher.mjs',
  'core/tracker-utils.mjs',
  'core/tracker-parse.mjs',
  'core/updater-migration-tests.mjs',
  'core/tracker-columns-tests.mjs',
];

for (const path of requiredSystemPaths) {
  if (systemPaths.includes(path)) pass(`SYSTEM_PATHS covers ${path}`);
  else fail(`SYSTEM_PATHS missing ${path}`);
}

for (const path of requiredBootstrapPaths) {
  if (bootstrapPaths.includes(path)) pass(`BOOTSTRAP_PATHS covers ${path}`);
  else fail(`BOOTSTRAP_PATHS missing ${path}`);
}

const twoPassManifestChecks = [
  {
    // de-brand-personal-fork Task 1: apply() no longer fetches/re-execs/merges
    // manifests from any upstream — it short-circuits with a disabled-state
    // error before any of that machinery runs. This checkout has no upstream
    // repo relationship, so the old cross-version fetch-and-migrate checks
    // below (re-exec guard, FETCH_HEAD manifest merge, scoped commit, stash
    // capture, #1998 verification) no longer apply to apply() and were
    // removed rather than asserting on dead code paths. rollback() and the
    // revertPaths()/removeAdditionsNotInHead() helpers it (and the #2015
    // rollback-behavior suite in test-all.mjs) still exercise directly are
    // unaffected and stay covered below.
    name: 'apply() short-circuits with a disabled-state error before any git/network call',
    pattern: /async function apply\(\) \{\s*throw new Error\('Auto-update is disabled for this instance/,
  },
  {
    name: 'check() short-circuits with a disabled status before any curl/network call',
    pattern: /status:\s*'disabled',\s*reason:\s*'auto-update is disabled for this instance/,
  },
  {
    name: 're-exec fallback still covers the skill-entrypoints import (#1245)',
    pattern: /REEXEC_FALLBACK_FILES\s*=\s*\[[^\]]*'scaffolder\/bin\/skill-entrypoints\.mjs'/,
  },
  {
    name: 'revertPaths uses git checkout HEAD (not just --) to reset index+worktree (#915)',
    pattern: /\b(?:git|runGit)\('checkout',\s*'HEAD',\s*'--'/,
  },
  {
    name: 'rollback commit is scoped to rollback paths, not bare commit (#915)',
    pattern: /git\('commit',\s*'-m',[^)]+'--',\s*\.\.\.rollbackPaths\)/,
  },
  {
    // existsSync on a pre-existing directory (docs/) would call it materialized
    // even when the target added files under it — the verification must recurse
    // into directory entries against FETCH_HEAD (#1998 CodeRabbit review).
    name: 'manifest verification recurses into directory entries via ls-tree (#1998)',
    pattern: /ls-tree', '-r', '--name-only', 'FETCH_HEAD'[\s\S]{0,400}?treeFiles\.some\(f => !existsSync/,
  },
  {
    // `git checkout HEAD -- docs/` restores tracked content but never removes
    // paths HEAD lacks, so files the update introduced under a directory
    // pathspec survived the rollback as staged additions (#2015).
    name: 'revertPaths clears additions HEAD lacks under a directory pathspec (#2015)',
    pattern: /removeAdditionsNotInHead\(p, protectedPaths, ctx\)/,
  },
  {
    name: 'removeAdditionsNotInHead only targets additions, never modifications (#2015)',
    pattern: /'--diff-filter=A'/,
  },
  {
    // The cleanup must not delete a file the user already had staged before the
    // update ran, only additions the update itself introduced (#2015 review).
    name: 'rollback cleanup skips pre-update staged paths (protectedPaths) (#2015)',
    pattern: /if \(protectedPaths\.has\(file\)\) continue;/,
  },
  {
    // -z output is NUL-delimited/unquoted, so a path with spaces or newlines is
    // not mangled by split('\n').trim() (#2015 review).
    name: 'rollback cleanup parses NUL-delimited git output (#2015)',
    pattern: /'--cached', '-z', '--name-only', '--diff-filter=A'[\s\S]*?added\.split\('\\0'\)\.filter/,
  },
  {
    // The worktree file is deleted only after git rm succeeds, so a failed
    // index removal never strands a staged addition with no file (#2015).
    name: 'rollback deletes the worktree copy only after a successful git rm (#2015)',
    pattern: /removed = true;[\s\S]{0,400}?if \(removed\) \{[\s\S]{0,80}?rmSync/,
  },
];

for (const check of twoPassManifestChecks) {
  if (check.pattern.test(source)) pass(check.name);
  else fail(check.name);
}

// #1706: update-system.mjs must be self-loading — no static (top-level) relative
// imports. A pre-#1245 client's apply() self-reexec checks out ONLY
// update-system.mjs before re-execing it, so any top-level `import ... from
// './...'` (or bare `import './...'`) crashes that re-exec with
// ERR_MODULE_NOT_FOUND on the old→new jump. Relative modules must be lazily
// `await import()`ed at their point of use instead.
const staticRelativeImport = /^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]\.[^'"]*['"]|^\s*import\s*['"]\.[^'"]*['"]/m;
if (staticRelativeImport.test(source)) {
  fail('update-system.mjs is self-loading — no static relative imports (#1706)');
} else {
  pass('update-system.mjs is self-loading — no static relative imports (#1706)');
}

for (const userPath of ['cv.md', 'config/profile.yml', '_profile.md', 'portals.yml', 'data/', 'reports/']) {
  if (userPaths.includes(userPath)) pass(`USER_PATHS protects ${userPath}`);
  else fail(`USER_PATHS missing ${userPath}`);
}

const allowedSystemUserOverlap = new Set([
  'writing-samples/README.md',
  // System-owned scaffold inside the user-layer interview-prep/ dir (#1242):
  // the updater ships these two, but never the real session files alongside them.
  'interview-prep/sessions/.gitkeep',
  'interview-prep/sessions/README.md',
]);
let hasSystemUserCollision = false;
for (const systemPath of systemPaths) {
  const overlapsUserPath = userPaths.some((userPath) => {
    if (allowedSystemUserOverlap.has(systemPath)) return false;
    return systemPath === userPath || systemPath.startsWith(userPath);
  });
  if (overlapsUserPath) {
    hasSystemUserCollision = true;
    fail(`SYSTEM_PATHS must not update user path ${systemPath}`);
  }
}
if (!hasSystemUserCollision) {
  pass('SYSTEM_PATHS does not collide with USER_PATHS');
}

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\n${passed} passed, ${failed} failed`);
