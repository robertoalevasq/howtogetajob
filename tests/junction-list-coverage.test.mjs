import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUNCTION_DIRS } from '../core/provision-workspace.mjs';
import { SYSTEM_PATHS } from '../core/update-system.mjs';

// Top-level SYSTEM_PATHS directories that deliberately have NO JUNCTION_DIRS
// counterpart. Each entry here was individually investigated (see comments)
// to confirm nothing reads it relative to a workspace's cwd at runtime — the
// bar JUNCTION_DIRS itself documents for inclusion. This is the allowlist
// the brief's own assertion message anticipates ("If it's a standalone
// doc/config directory nothing reads relative to a workspace cwd, add it to
// this test's own allowlist instead"); keep every entry justified so a
// future reader can tell a deliberate exclusion from an oversight.
const ALLOWED_MISSING = new Set([
  // Reached only via a static ES import inside core/scan-ats-full.mjs:47
  // (`import { SEED_SOURCES, toPortalEntry } from '../seeds/vc-portfolios.mjs'`).
  // Node resolves a static import specifier relative to the importing
  // module's real file location, transparent through junctions — never
  // relative to process.cwd() — so this is already correctly reachable from
  // any workspace with zero junction needed. Same script-internal
  // ROOT-relative resolution already relied on elsewhere in this plan for
  // templates/, providers/, plugins/.
  'seeds',
  // Reached via ROOT-relative constants, not workspace-relative ones:
  // core/eval-golden.mjs:33 (`const GOLDEN_DIR = join(ROOT, '..', 'evals',
  // 'golden');`) and lib/golden-budget-analysis.mjs:24 (`const GOLDEN_DIR =
  // join(ROOT, 'evals', 'golden');`). Both resolve evals/ relative to the
  // importing module's own real file location (via ROOT/import.meta.url),
  // transparent through junctions — never relative to process.cwd() — the
  // same mechanism that already justifies the seeds/ entry above.
  'evals',
  // The test suite itself, run from the repo root during development —
  // never from within a workspace.
  'tests',
  // Fixtures for the test suite above — same reasoning.
  'test-fixtures',
  // CI workflow config, never read by any runtime script.
  '.github',
  // Exclusively referenced by core/test-all.mjs (ROOT-relative resolution,
  // e.g. join(ROOT, 'scaffolder/bin/skill-entrypoints.mjs')) and the
  // dormant core/updater-migration-tests.mjs — dev/CI tooling only, never
  // dereferenced relative to a workspace cwd.
  'scaffolder',
]);

test('every top-level directory-shaped SYSTEM_PATHS entry has a JUNCTION_DIRS counterpart (or a justified allowlist exemption)', () => {
  const topLevelDirs = new Set(
    SYSTEM_PATHS
      .filter((p) => p.endsWith('/'))
      .map((p) => p.replace(/\/$/, ''))
      .filter((p) => !p.includes('/')) // top-level only, not nested like modes/ar/
  );
  const known = new Set(JUNCTION_DIRS);
  const missing = [...topLevelDirs].filter((d) => !known.has(d) && !ALLOWED_MISSING.has(d));
  assert.deepEqual(missing, [],
    `New top-level system directory(ies) added to SYSTEM_PATHS without a JUNCTION_DIRS entry in provision-workspace.mjs: ${missing.join(', ')}. ` +
    `If the new directory is genuinely dereferenced by workspace-relative operations, add it to JUNCTION_DIRS. ` +
    `If it's a standalone doc/config directory nothing reads relative to a workspace cwd, add it (with a reasoning comment) to this test's own ALLOWED_MISSING allowlist instead.`);

  // Guard the allowlist itself: every entry must still be absent from
  // JUNCTION_DIRS and still be a real top-level SYSTEM_PATHS directory. If a
  // future change adds one of these to JUNCTION_DIRS (making the allowlist
  // entry redundant) or removes it from SYSTEM_PATHS (making the entry
  // stale), fail loudly so the allowlist doesn't quietly rot.
  const staleAllowlistEntries = [...ALLOWED_MISSING].filter(
    (d) => known.has(d) || !topLevelDirs.has(d)
  );
  assert.deepEqual(staleAllowlistEntries, [],
    `ALLOWED_MISSING in this test contains stale entries no longer needed: ${staleAllowlistEntries.join(', ')}. ` +
    `Either they were added to JUNCTION_DIRS (remove from this allowlist) or removed from SYSTEM_PATHS (remove from this allowlist).`);
});
