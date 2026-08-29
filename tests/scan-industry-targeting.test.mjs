import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shouldSkipTitleFilter, isIndustrySourced, loadTargetingConfig, resolveScanCompanies,
  formatAgentHandoffLine,
} from '../core/scan.mjs';

// Resolves one industry_companies entry through the real production path, so
// every assertion below about a "legitimate" industry-sourced company is made
// against an object built exactly the way a real scan run builds it.
function resolveOneIndustryCompany(entry) {
  const [company] = resolveScanCompanies(
    { tracked_companies: [], industry_companies: { music: [entry] } },
    { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] },
  );
  return company;
}

test('shouldSkipTitleFilter requires BOTH the code-set industry marker and skip_title_filter: true', () => {
  // Legitimate case: the entry came through resolveScanCompanies()'s
  // industry_companies merge AND declares the flag.
  assert.equal(shouldSkipTitleFilter(resolveOneIndustryCompany({ name: 'Live Nation', skip_title_filter: true })), true);

  // An industry_companies entry that never declared the flag does not bypass.
  assert.equal(shouldSkipTitleFilter(resolveOneIndustryCompany({ name: 'Live Nation' })), false);

  // Raw YAML-shaped objects that never went through resolveScanCompanies()
  // carry no marker, so none of them bypasses the title filter.
  assert.equal(shouldSkipTitleFilter({ name: 'Acme', skip_title_filter: true }), false);
  assert.equal(shouldSkipTitleFilter({ name: 'Acme' }), false);
  assert.equal(shouldSkipTitleFilter({ name: 'Acme', skip_title_filter: 'true' }), false); // string, not boolean — must not coerce
  assert.equal(shouldSkipTitleFilter(null), false);
  assert.equal(shouldSkipTitleFilter(undefined), false);
});

// GLOBAL CONSTRAINT PIN (2026-08-28 final review, Finding 3): "skip_title_filter:
// true must only ever originate from an industry_companies-sourced entry — never
// appear on a hand-edited tracked_companies entry undetected." Before this,
// core/scan.mjs never called validate-portals.mjs, so a stray hand-added flag was
// silently honored — bypassing the title filter AND (since Task 5 reuses the same
// signal) tagging the company's postings `| source: industry`, routing them
// through the mandatory triage gate. Both effects are now gated on a marker only
// resolveScanCompanies() can set.
test('a hand-added skip_title_filter on a tracked_companies entry has no effect at scan time', () => {
  const strayEntry = { name: 'Acme', skip_title_filter: true };
  const portalsConfig = {
    tracked_companies: [strayEntry],
    industry_companies: { music: [{ name: 'Live Nation', skip_title_filter: true }] },
  };

  for (const targetingConfig of [
    { targetingMode: 'title_based', targetIndustrySlugs: [] },
    { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] },
  ]) {
    const resolved = resolveScanCompanies(portalsConfig, targetingConfig);
    const acme = resolved.find((c) => c.name === 'Acme');
    assert.ok(acme, 'the tracked_companies entry is still scanned');
    // Its title filter still applies...
    assert.equal(shouldSkipTitleFilter(acme), false);
    // ...and its postings are never tagged `| source: industry`, so they never
    // enter modes/pipeline.md's mandatory triage gate.
    assert.equal(isIndustrySourced(acme), false);
  }
});

test('isIndustrySourced is true only for entries resolveScanCompanies itself merged in', () => {
  assert.equal(isIndustrySourced(resolveOneIndustryCompany({ name: 'Live Nation', skip_title_filter: true })), true);
  // No YAML-writable key can forge the marker — it is a module-private Symbol.
  assert.equal(isIndustrySourced({ name: 'Acme', _industrySourced: true, industrySourced: true, skip_title_filter: true }), false);
  assert.equal(isIndustrySourced(null), false);
  assert.equal(isIndustrySourced(undefined), false);
});

test('the industry-sourced marker never leaks into any serialization of a company entry', () => {
  const company = resolveOneIndustryCompany({ name: 'Live Nation', skip_title_filter: true });
  assert.deepEqual(Object.keys(company), ['name', 'skip_title_filter']);
  assert.equal(JSON.stringify(company), '{"name":"Live Nation","skip_title_filter":true}');
});

test('resolveScanCompanies never mutates the parsed portals.yml objects it reads', () => {
  // YAML anchors (&anchor/*ref) can put the SAME object under both
  // tracked_companies and industry_companies; marking in place would silently
  // promote the tracked_companies occurrence too.
  const shared = { name: 'Live Nation', skip_title_filter: true };
  const portalsConfig = { tracked_companies: [shared], industry_companies: { music: [shared] } };
  resolveScanCompanies(portalsConfig, { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] });
  assert.equal(isIndustrySourced(shared), false);
});

test('formatAgentHandoffLine annotates an industry-sourced company so the manual scan path knows to skip title_filter', () => {
  const plain = formatAgentHandoffLine({ company: 'Acme', method: 'websearch', query: 'acme jobs' });
  assert.equal(plain, '  • Acme (websearch) — acme jobs');
  const industry = formatAgentHandoffLine({ company: 'The Fillmore', method: 'websearch', query: '', industrySourced: true });
  assert.ok(industry.includes('[industry-sourced — skip title_filter, tag `source: industry`]'), industry);
});

test('loadTargetingConfig defaults to title_based with no industries when the file is missing', () => {
  const result = loadTargetingConfig(join(tmpdir(), 'nonexistent-profile-xyz.yml'));
  assert.deepEqual(result, { targetingMode: 'title_based', targetIndustrySlugs: [] });
});

test('loadTargetingConfig defaults to title_based when targeting_mode is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-targeting-'));
  try {
    const p = join(dir, 'profile.yml');
    writeFileSync(p, 'location:\n  country: "United States"\n');
    assert.deepEqual(loadTargetingConfig(p), { targetingMode: 'title_based', targetIndustrySlugs: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTargetingConfig reads industry_based mode and target_industries slugs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-targeting-'));
  try {
    const p = join(dir, 'profile.yml');
    writeFileSync(p, [
      'targeting_mode: "industry_based"',
      'target_industries:',
      '  - name: "Music & Concert Industry"',
      '    slug: "music"',
      '    description: "Radio, concerts, venues"',
    ].join('\n'));
    assert.deepEqual(loadTargetingConfig(p), { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTargetingConfig ignores a malformed target_industries entry missing a slug', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-targeting-'));
  try {
    const p = join(dir, 'profile.yml');
    writeFileSync(p, [
      'targeting_mode: "industry_based"',
      'target_industries:',
      '  - name: "No slug here"',
      '  - name: "Has one"',
      '    slug: "music"',
    ].join('\n'));
    assert.deepEqual(loadTargetingConfig(p), { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveScanCompanies returns tracked_companies unchanged under title_based targeting', () => {
  const portalsConfig = {
    tracked_companies: [{ name: 'Acme' }],
    industry_companies: { music: [{ name: 'Live Nation', skip_title_filter: true }] },
  };
  const result = resolveScanCompanies(portalsConfig, { targetingMode: 'title_based', targetIndustrySlugs: [] });
  assert.deepEqual(result, [{ name: 'Acme' }]);
});

test('resolveScanCompanies merges only the candidate\'s own target_industries slugs under industry_based targeting', () => {
  const portalsConfig = {
    tracked_companies: [{ name: 'Acme' }],
    industry_companies: {
      music: [{ name: 'Live Nation', skip_title_filter: true }],
      film: [{ name: 'Warner Bros', skip_title_filter: true }],
    },
  };
  const result = resolveScanCompanies(portalsConfig, { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] });
  assert.deepEqual(result, [
    { name: 'Acme' },
    { name: 'Live Nation', skip_title_filter: true },
  ]);
});

test('resolveScanCompanies is safe when industry_companies or tracked_companies is absent/malformed', () => {
  assert.deepEqual(
    resolveScanCompanies({}, { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] }),
    []
  );
  assert.deepEqual(
    resolveScanCompanies({ tracked_companies: [{ name: 'Acme' }], industry_companies: 'not-an-object' }, { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] }),
    [{ name: 'Acme' }]
  );
});
