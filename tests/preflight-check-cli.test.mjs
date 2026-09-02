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
