/**
 * reconcile-pipeline.test.mjs — workspace-root regression test for
 * reconcile-pipeline.mjs (#workspace-multitenancy).
 *
 * reconcile-pipeline.mjs used to derive its default data/pipeline.md,
 * data/batch-state.tsv, and reports/ paths from
 * `dirname(fileURLToPath(import.meta.url))` — this script's own install
 * directory. Under a provisioned workspace (`workspaces/{slug}/core` is a
 * symlink/junction back to this shared hub `core/`), Node resolves
 * import.meta.url THROUGH the symlink to the physical hub location
 * regardless of which workspace's symlink invoked the script — so the
 * default silently reconciled the HUB's own pipeline/batch-state instead of
 * the invoking workspace's, a live data-integrity bug across a
 * multi-tenant hub (see workspace-root.mjs).
 *
 * This suite exercises the DEFAULT path only (no --state/--pipeline
 * override) with CAREER_OPS_WORKSPACE pointed at an isolated temp
 * workspace, and asserts:
 *   1. the script operates on the temp workspace's own pipeline/batch-state/
 *      reports, not the real repo root's copies (which do exist on this
 *      hub — data/pipeline.md is real, so a regression here would silently
 *      mutate the hub's own tracked file, not just fail an assertion);
 *   2. the real repo root's data/pipeline.md is untouched, byte-for-byte,
 *      by a run scoped to the temp workspace.
 *
 * Run: node reconcile-pipeline.test.mjs
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'fs';
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
const SCRIPT = join(HERE, 'reconcile-pipeline.mjs');
const REPO_ROOT = dirname(HERE);
const REAL_PIPELINE = join(REPO_ROOT, 'data', 'pipeline.md');

console.log('\n--- reconcile-pipeline.mjs: workspace-root default (no --state/--pipeline override) ---');

// Snapshot the real repo's own data/pipeline.md — it genuinely exists on
// this hub, so if the fix regressed and the script fell back to resolving
// against its own install directory instead of CAREER_OPS_WORKSPACE, this
// run would silently rewrite the hub's real tracked file instead of the
// isolated temp workspace's copy.
const realPipelineExisted = existsSync(REAL_PIPELINE);
const realPipelineBefore = realPipelineExisted ? readFileSync(REAL_PIPELINE, 'utf-8') : null;

const wsDir = mkdtempSync(join(tmpdir(), 'reconcile-pipeline-ws-'));
try {
  mkdirSync(join(wsDir, 'data'), { recursive: true });
  mkdirSync(join(wsDir, 'reports'), { recursive: true });

  writeFileSync(join(wsDir, 'data', 'pipeline.md'), [
    '# Pipeline — Pending URLs',
    '',
    '## Pending',
    '',
    '- [ ] https://workspace-only.example/jobs/1 | WorkspaceOnlyCo | Engineer',
    '',
    '## Processed',
    '',
  ].join('\n'));

  writeFileSync(join(wsDir, 'data', 'batch-state.tsv'), [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1\thttps://workspace-only.example/jobs/1\tcompleted\t2026-01-01T00:00:00Z\t2026-01-01T00:05:00Z\t501\t4.2\t\t0',
    '',
  ].join('\n'));

  writeFileSync(join(wsDir, 'reports', '501-workspaceonlyco-2026-01-01.md'), [
    '# 501 - WorkspaceOnlyCo',
    '',
    '**Score:** 4.2/5',
    '**PDF:** Generated',
    '',
  ].join('\n'));

  // No --state/--pipeline flags: this exercises the DEFAULT resolution path,
  // scoped ONLY through CAREER_OPS_WORKSPACE — no CAREER_OPS_TRACKER-style
  // override exists for this script, so this is the only lever available.
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('node', [SCRIPT], {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: REPO_ROOT,
      env: { ...process.env, CAREER_OPS_WORKSPACE: wsDir },
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = (e.stdout || '') + (e.stderr || '');
  }

  ok('default run against CAREER_OPS_WORKSPACE exits 0', code === 0);
  ok('default run reports it found and reconciled the workspace batch-state (not "nothing to reconcile")',
    !/No batch-state\.tsv found/.test(stdout) && !/No pipeline\.md found/.test(stdout));
  ok('default run reports 1 entry moved Pendientes/Pending -> Procesadas/Processed', /1 processed entr/.test(stdout));

  const wsPipelineAfter = readFileSync(join(wsDir, 'data', 'pipeline.md'), 'utf-8');
  ok('the WORKSPACE pipeline.md now has the entry under Processed',
    /## Processed[\s\S]*501[\s\S]*workspace-only\.example\/jobs\/1/.test(wsPipelineAfter));
  ok('the WORKSPACE pipeline.md Pending section no longer lists the moved URL',
    !/## Pending\n\n- \[ \] https:\/\/workspace-only\.example/.test(wsPipelineAfter));

  // The real hub's own data/pipeline.md must be completely untouched by a run
  // scoped to the temp workspace.
  const realPipelineAfter = existsSync(REAL_PIPELINE) ? readFileSync(REAL_PIPELINE, 'utf-8') : null;
  ok('the REAL repo root data/pipeline.md existence is unchanged', existsSync(REAL_PIPELINE) === realPipelineExisted);
  ok('the REAL repo root data/pipeline.md content is byte-for-byte unchanged', realPipelineAfter === realPipelineBefore);
} finally {
  rmSync(wsDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
