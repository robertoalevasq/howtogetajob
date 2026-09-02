import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\npreflight-check.mjs — CLI');

const scriptPath = join(ROOT, 'core', 'preflight-check.mjs');

// Hermetic fixtures: without these the CLI reads the real config/profile.yml and
// data/applications.md, so the assertions below would depend on whatever the
// machine running the suite happens to have tracked or configured.
const fixtureDir = mkdtempSync(join(tmpdir(), 'preflight-cli-'));
const emptyProfilePath = join(fixtureDir, 'empty-profile.yml');
writeFileSync(emptyProfilePath, 'name: Test Candidate\n');
const emptyTrackerPath = join(fixtureDir, 'applications.md');
writeFileSync(emptyTrackerPath, [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
].join('\n'));

try {
  try {
    const out1 = execFileSync(NODE, [
      scriptPath, '--company', 'Acme Corp', '--role', 'Backend Engineer',
      '--text', 'We are looking for a backend engineer. Competitive pay.',
      '--profile', emptyProfilePath, '--applications', emptyTrackerPath,
    ], { encoding: 'utf-8' });
    const json1 = JSON.parse(out1);
    if (json1.gate?.pass === true && json1.duplicate?.isDuplicate === false && json1.duplicate?.checked === true && json1.advertisedComp === null) {
      pass('CLI prints a clean-pass JSON verdict for a plain JD with no comp/clearance/dup signal');
    } else {
      fail(`CLI clean-pass output => ${out1}`);
    }
  } catch (err) {
    fail(`CLI clean-pass run crashed: ${err.stderr?.toString() || err.message}`);
  }

  try {
    const jdPath = join(fixtureDir, 'jd.txt');
    writeFileSync(jdPath, 'Requires an active TS/SCI clearance. Salary $150,000 - $200,000.');
    const profilePath = join(fixtureDir, 'clearance-profile.yml');
    writeFileSync(profilePath, 'clearance:\n  status: "None"\n  accepts_sponsorship: false\n');

    const out2 = execFileSync(NODE, [
      scriptPath, '--company', 'Beta Inc', '--role', 'Cleared Engineer',
      '--jd-file', jdPath, '--profile', profilePath, '--applications', emptyTrackerPath,
    ], { encoding: 'utf-8' });
    const json2 = JSON.parse(out2);
    if (json2.gate?.pass === false && json2.advertisedComp?.low === 150000) {
      pass('CLI reads --jd-file and --profile, hard-stops on clearance, still extracts comp');
    } else {
      fail(`CLI clearance+comp output => ${out2}`);
    }
  } catch (err) {
    fail(`CLI clearance+comp run crashed: ${err.stderr?.toString() || err.message}`);
  }

  // Gate-only call: batch/batch-prompt.md's Step 1.5 runs before company/role
  // are known, so --jd-file alone must work and must say dedup wasn't attempted.
  try {
    const jdPath = join(fixtureDir, 'gate-only-jd.txt');
    writeFileSync(jdPath, 'Senior Platform Engineer. Base salary $150-180K plus equity.');
    const out3 = execFileSync(NODE, [
      scriptPath, '--jd-file', jdPath, '--profile', emptyProfilePath,
    ], { encoding: 'utf-8' });
    const json3 = JSON.parse(out3);
    if (json3.duplicate?.checked === false && json3.duplicate?.isDuplicate === false
        && json3.gate?.pass === true && json3.advertisedComp?.low === 150000 && json3.advertisedComp?.high === 180000) {
      pass('CLI runs gate-only with just --jd-file, reporting duplicate.checked === false');
    } else {
      fail(`CLI gate-only output => ${out3}`);
    }
  } catch (err) {
    fail(`CLI gate-only run crashed: ${err.stderr?.toString() || err.message}`);
  }

  try {
    execFileSync(NODE, [scriptPath], { encoding: 'utf-8' });
    fail('CLI should exit non-zero when it is given nothing to check');
  } catch (err) {
    if (err.status === 1) pass('CLI exits 1 with a usage error when given neither --company/--role nor --text/--jd-file');
    else fail(`CLI missing-flags exit code => ${err.status}`);
  }

  // --company without --role (and no text) is still nothing to check.
  try {
    execFileSync(NODE, [scriptPath, '--company', 'Acme Corp'], { encoding: 'utf-8' });
    fail('CLI should exit non-zero for --company with no --role and no JD text');
  } catch (err) {
    if (err.status === 1) pass('CLI exits 1 when --company is given without --role and without any JD text');
    else fail(`CLI half-dedup-args exit code => ${err.status}`);
  }
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
