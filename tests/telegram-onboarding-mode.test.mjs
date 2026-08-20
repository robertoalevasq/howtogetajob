import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODE_PATH = join(ROOT, 'modes', 'telegram-onboarding.md');

test('modes/telegram-onboarding.md exists and covers the required conventions', () => {
  assert.ok(existsSync(MODE_PATH), 'modes/telegram-onboarding.md must exist');
  const content = readFileSync(MODE_PATH, 'utf-8');
  assert.match(content, /HEADLESS/, 'must declare itself HEADLESS like modes/telegram.md');
  assert.match(content, /AskUserQuestion/, 'must forbid AskUserQuestion');
  assert.match(content, /--chat-id/, 'must document the --chat-id notify convention');
  assert.match(content, /provision-workspace\.mjs/, 'must describe provisioning the workspace');
  assert.match(content, /\/restart/, 'must document the /restart escape hatch');
  assert.match(content, /workspace\.json/, 'must describe the final chat_id bind step');
  assert.match(content, /Discord/, 'must cover the optional Discord webhook step');
  assert.match(
    content,
    /narrative\.headline.*blank|blank.*narrative\.headline/s,
    'must explicitly instruct clearing the profile template\'s fabricated narrative example content (found live 2026-08-20: a real onboarding run left "Jane Smith"/"built and sold my SaaS" template placeholders in a candidate\'s actual profile.yml)',
  );
  assert.match(
    content,
    /title_filter\.positive/,
    'must instruct customizing portals.yml\'s title_filter.positive from the collected target roles (found live 2026-08-20: a real onboarding run left the seeded AI/ML-focused example keywords in place, so scanning would search for the wrong jobs entirely)',
  );
});

test('modes/telegram-onboarding.md is registered in update-system.mjs SYSTEM_PATHS', () => {
  const updateSystemContent = readFileSync(join(ROOT, 'core', 'update-system.mjs'), 'utf-8');
  assert.match(updateSystemContent, /'modes\/telegram-onboarding\.md'/);
});
