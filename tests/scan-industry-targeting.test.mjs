import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shouldSkipTitleFilter, loadTargetingConfig, resolveScanCompanies,
} from '../core/scan.mjs';

test('shouldSkipTitleFilter is true only when a company explicitly sets skip_title_filter: true', () => {
  assert.equal(shouldSkipTitleFilter({ name: 'Acme', skip_title_filter: true }), true);
  assert.equal(shouldSkipTitleFilter({ name: 'Acme' }), false);
  assert.equal(shouldSkipTitleFilter({ name: 'Acme', skip_title_filter: 'true' }), false); // string, not boolean — must not coerce
  assert.equal(shouldSkipTitleFilter(null), false);
  assert.equal(shouldSkipTitleFilter(undefined), false);
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
