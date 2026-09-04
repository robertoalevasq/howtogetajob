// @ts-check
// doctor-all.mjs — runs doctor.mjs's prerequisite/leftover check AND
// backfill-templates.mjs's template-drift check against every provisioned
// workspace in one pass, so a broken or out-of-date workspace is caught
// before its user hits it. Never calls applyWorkspace — the two backfill
// target files (config/profile.yml, portals.yml) are only ever read here;
// applying a fix stays a deliberate, separate `backfill-templates.mjs --apply`
// invocation. This does NOT extend to doctor.mjs itself: doctor.mjs's
// existing onboardingState() auto-copies missing _profile.md/_custom.md/
// _brief.md from their templates — the same idempotent, one-time side effect
// any direct `doctor.mjs --json` call already has. It's never silent:
// doctor.mjs's own `autoCopied` field is passed through per-workspace and
// surfaced below whenever non-empty.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';
import { listWorkspaces } from './admin-overview-snapshot.mjs';
import { checkWorkspace } from './backfill-templates.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Run `node core/doctor.mjs --json --target <dir>` and parse its output.
 * Never throws — a crash or non-JSON output is reported as { error }.
 * @returns {{ doctor: object|null, error: string|null }}
 */
export function runDoctor(dir, reposRoot = ROOT) {
  try {
    const out = execFileSync('node', [join(reposRoot, 'core', 'doctor.mjs'), '--json', '--target', dir], { encoding: 'utf8' });
    return { doctor: JSON.parse(out), error: null };
  } catch (err) {
    return { doctor: null, error: /** @type {Error} */ (err).message };
  }
}

/**
 * @returns {{ slug: string, healthy: boolean, doctor: object|null, drift: object[], error: string|null }[]}
 */
export function checkAllWorkspaces(workspacesRoot = ROOT, reposRoot = ROOT) {
  return listWorkspaces(workspacesRoot).map(({ slug, dir }) => {
    const { doctor, error: doctorError } = runDoctor(dir, reposRoot);
    let drift = [];
    let driftError = null;
    try {
      drift = checkWorkspace(dir, reposRoot).filter((f) => f.missing.length > 0 || f.error);
    } catch (err) {
      driftError = /** @type {Error} */ (err).message;
    }
    const error = doctorError || driftError || null;
    const healthy = !error
      && Boolean(doctor)
      && !doctor.onboardingNeeded
      && doctor.templateLeftovers.length === 0
      && drift.length === 0;
    return { slug, healthy, doctor, drift, error };
  });
}

function summarize(results) {
  const healthyCount = results.filter((r) => r.healthy).length;
  const unhealthy = results.filter((r) => !r.healthy);
  const summary = `${healthyCount}/${results.length} workspaces healthy`;
  return unhealthy.length === 0 ? summary : `${summary} — needs attention: ${unhealthy.map((r) => r.slug).join(', ')}`;
}

async function main() {
  const jsonOut = process.argv.includes('--json');
  const results = checkAllWorkspaces();
  if (jsonOut) {
    console.log(JSON.stringify({ workspaces: results, summary: summarize(results) }));
  } else {
    for (const r of results) {
      if (r.error) { console.log(`${r.slug}: ERROR — ${r.error}`); }
      else if (r.healthy) { console.log(`${r.slug}: ok`); }
      else {
        const issues = [];
        if (r.doctor?.onboardingNeeded) issues.push(`missing: ${r.doctor.missing.join(', ')}`);
        if (r.doctor?.templateLeftovers?.length) issues.push(`${r.doctor.templateLeftovers.length} template-leftover warning(s)`);
        if (r.drift.length) issues.push(`template drift in ${r.drift.map((d) => d.file).join(', ')}`);
        console.log(`${r.slug}: ${issues.join('; ')}`);
      }
      if (r.doctor?.autoCopied?.length) console.log(`  → auto-copied ${r.doctor.autoCopied.join(', ')} from templates`);
    }
    console.log(summarize(results));
  }
  if (results.some((r) => !r.healthy)) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ doctor-all: ${err.message}`);
    process.exit(1);
  });
}
