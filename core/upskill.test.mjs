/**
 * upskill.test.mjs — workspace-root regression test for upskill.mjs
 * (#workspace-multitenancy).
 *
 * upskill.mjs's APPS_FILE/CV_FILE/PROFILE_FILE used to be built straight from
 * this script's own install directory
 * (dirname(dirname(fileURLToPath(import.meta.url)))). Under a provisioned
 * workspace (workspaces/{slug}/core is a symlink/junction back to this shared
 * hub core/), Node resolves import.meta.url THROUGH the symlink to the
 * physical hub location regardless of which workspace's symlink invoked the
 * script — so the default silently analyzed the HUB's own tracker/cv/profile
 * instead of the invoking workspace's.
 *
 * This hub root genuinely has no cv.md, config/profile.yml, or
 * data/applications.md of its own (checked below), so a regression here
 * would surface as the CLI reporting "no tracker found" rather than
 * mutating anything — but that absence is exactly what makes this a clean
 * negative control: the run can only succeed at all if it is actually
 * resolving against CAREER_OPS_WORKSPACE, not this repo root.
 *
 * Run: node upskill.test.mjs
 */

import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'upskill.mjs');
const REPO_ROOT = dirname(HERE);

console.log('\n--- upskill.mjs: workspace-root default (aggregate mode, no path override exists for this script) ---');

// Confirm the hub root really has none of these — otherwise a regressed
// (unfixed) run could accidentally succeed against stale hub-root fixtures
// left by another test and this suite would give a false pass.
ok('sanity: repo root has no cv.md of its own', !existsSync(join(REPO_ROOT, 'cv.md')));
ok('sanity: repo root has no config/profile.yml of its own', !existsSync(join(REPO_ROOT, 'config/profile.yml')));
ok('sanity: repo root has no data/applications.md of its own', !existsSync(join(REPO_ROOT, 'data/applications.md')));

const wsDir = mkdtempSync(join(tmpdir(), 'upskill-ws-'));
try {
  mkdirSync(join(wsDir, 'data'), { recursive: true });
  mkdirSync(join(wsDir, 'reports'), { recursive: true });
  mkdirSync(join(wsDir, 'config'), { recursive: true });

  writeFileSync(join(wsDir, 'cv.md'), '# CV\n\nExperienced Python developer. Strong in AWS.\n');
  writeFileSync(join(wsDir, 'config/profile.yml'), 'name: Workspace Tester\n');

  writeFileSync(join(wsDir, 'data/applications.md'), [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 42 | 2026-01-01 | WorkspaceOnlyCo | Engineer | 2.5/5 | Evaluated | ❌ | [42](reports/042-workspaceonlyco-2026-01-01.md) |  |',
    '',
  ].join('\n'));

  writeFileSync(join(wsDir, 'reports/042-workspaceonlyco-2026-01-01.md'), [
    '# 042 - WorkspaceOnlyCo',
    '',
    '## Machine Summary',
    '',
    '```yaml',
    'score: 2.5',
    'hard_stops: []',
    'soft_gaps:',
    '  - "Missing Kubernetes experience"',
    '```',
    '',
  ].join('\n'));

  // No CLI flag exists to override APPS_FILE/CV_FILE/PROFILE_FILE for this
  // script — CAREER_OPS_WORKSPACE is the only lever. --min-reports 1 lets a
  // single fixture report satisfy the default minReports=5 gate.
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('node', [SCRIPT, '--min-reports', '1'], {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: REPO_ROOT,
      env: { ...process.env, CAREER_OPS_WORKSPACE: wsDir },
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = (e.stdout || '') + (e.stderr || '');
  }

  ok('default aggregate run against CAREER_OPS_WORKSPACE exits 0', code === 0);
  ok('default run does NOT report "no tracker found" (that would mean it resolved to the hub root, not the workspace)',
    !/No applications tracker found/.test(stdout));

  let result = null;
  try { result = JSON.parse(stdout); } catch { /* leave null; assertions below report it */ }

  ok('default run produced parseable JSON', result !== null);
  if (result) {
    const gapNames = (result.gaps || []).map(g => g.skill);
    ok('gap map includes Kubernetes (from the WORKSPACE report\'s soft_gaps)', gapNames.includes('Kubernetes'));
    ok('gap map does not include Python (known from the WORKSPACE cv.md, suppressed)', !gapNames.includes('Python'));
    ok('metadata.reportsScored reflects the workspace\'s 1 fixture report', result.metadata?.reportsScored === 1);
  }
} finally {
  rmSync(wsDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
