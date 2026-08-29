import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('config/profile.example.yml has targeting_mode defaulting to title_based', () => {
  const raw = readFileSync(join(ROOT, 'config', 'profile.example.yml'), 'utf-8');
  const parsed = yaml.load(raw);
  assert.equal(parsed.targeting_mode, 'title_based');
});

test('config/profile.example.yml does not ship an active (uncommented) target_industries example', () => {
  // The example must stay commented out — an uncommented example here would
  // silently make the seeded template industry_based for every new user.
  const raw = readFileSync(join(ROOT, 'config', 'profile.example.yml'), 'utf-8');
  const parsed = yaml.load(raw);
  assert.equal(parsed.target_industries, undefined);
});

test('templates/portals.example.yml does not ship an active (uncommented) industry_companies example', () => {
  const raw = readFileSync(join(ROOT, 'templates', 'portals.example.yml'), 'utf-8');
  const parsed = yaml.load(raw);
  assert.equal(parsed.industry_companies, undefined);
});
