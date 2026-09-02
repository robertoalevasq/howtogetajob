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

  // K-suffix written once, at the end of the range — it must apply to both ends.
  const c3b = mod.extractAdvertisedComp('$150-180K base salary');
  if (c3b && c3b.low === 150000 && c3b.high === 180000 && c3b.currency === 'USD') {
    pass('extractAdvertisedComp inherits a trailing K-suffix backward to the low end of the range');
  } else {
    fail(`extractAdvertisedComp trailing-K inheritance => ${JSON.stringify(c3b)}`);
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
