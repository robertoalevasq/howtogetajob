import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePortalsConfig } from '../core/validate-portals.mjs';

test('a tracked_companies entry with skip_title_filter: true gets a warning (likely copy-paste mistake)', async () => {
  const { warnings } = await validatePortalsConfig({
    tracked_companies: [{ name: 'Acme', skip_title_filter: true }],
  });
  assert.ok(warnings.some((w) => w.path === 'tracked_companies[0].skip_title_filter'));
});

test('a plain tracked_companies entry with no skip_title_filter gets no such warning', async () => {
  const { warnings } = await validatePortalsConfig({
    tracked_companies: [{ name: 'Acme' }],
  });
  assert.ok(!warnings.some((w) => w.path === 'tracked_companies[0].skip_title_filter'));
});

test('industry_companies must be an object keyed by slug, not an array', async () => {
  const { errors } = await validatePortalsConfig({ industry_companies: [{ name: 'Acme' }] });
  assert.ok(errors.some((e) => e.path === 'industry_companies'));
});

test('each industry_companies[slug] value must be an array', async () => {
  const { errors } = await validatePortalsConfig({ industry_companies: { music: { name: 'not an array' } } });
  assert.ok(errors.some((e) => e.path === 'industry_companies.music'));
});

test('each industry_companies[slug] entry is validated the same way as a tracked_companies entry', async () => {
  const { errors } = await validatePortalsConfig({
    industry_companies: { music: [{ /* missing name */ careers_url: 'not a url' }] },
  });
  assert.ok(errors.some((e) => e.path === 'industry_companies.music[0].name'));
  assert.ok(errors.some((e) => e.path === 'industry_companies.music[0].careers_url'));
});

test('a valid industry_companies block with skip_title_filter: true entries produces no errors or warnings', async () => {
  const { errors, warnings } = await validatePortalsConfig({
    industry_companies: {
      music: [{ name: 'Live Nation', skip_title_filter: true, api: 'https://boards-api.greenhouse.io/v1/boards/livenation/jobs' }],
    },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
