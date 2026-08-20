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
  assert.match(
    content,
    /_profile\.md/,
    'must instruct customizing _profile.md\'s archetype tables from the collected target roles (found live 2026-08-20: a real onboarding run left the seeded generic AI/LLMOps archetypes in place, which drive real scoring per AGENTS.md)',
  );
  assert.match(
    content,
    /_brief\.md/,
    'must instruct filling in _brief.md from the collected roles/CV/location/salary data (found live 2026-08-20: a real onboarding run left it as entirely unfilled {placeholder} text, even though modes/triage.md reads it for every first-pass filtering decision)',
  );
  assert.match(
    content,
    /location_flexibility/,
    'must instruct capturing additional acceptable locations in compensation.location_flexibility, not just the one asked about for timezone (found live 2026-08-20: a real reply named four locations and only one survived into any file)',
  );
  assert.match(
    content,
    /profile_confirm/,
    'must document the profile_confirm state and a read-back/confirm step before writing any files (#onboarding-completeness-guardrails: closes the class of bug where a correctly-extracted-yet-incomplete answer, like the location_flexibility case above, would otherwise slip through undetected — the candidate is the one who notices a dropped detail, not a script)',
  );
  assert.match(
    content,
    /Reply "yes" to continue, or tell me what to fix/,
    'must send a read-back summary and wait for explicit confirmation before Step 4b writes any workspace files',
  );
  assert.match(
    content,
    /narrative\.proof_points.*derive|derive.*narrative\.proof_points/s,
    'must instruct auto-deriving narrative.proof_points from the CV\'s strongest quantified achievements, the same source _brief.md\'s Proof Points section already draws from — content already collected should be reused, not left blank by default (#onboarding-completeness-guardrails)',
  );
  assert.match(
    content,
    /doctor\.mjs --target workspaces\/\{slug\} --json/,
    'must run the doctor.mjs completeness check against the workspace before binding (#onboarding-completeness-guardrails)',
  );
  assert.match(
    content,
    /templateLeftovers/,
    'must inspect doctor.mjs\'s templateLeftovers field to decide whether to self-correct',
  );
  assert.match(
    content,
    /one retry|one bounded|bounded self-correction/i,
    'must cap the self-correction attempt at exactly one retry before proceeding anyway',
  );
  assert.match(
    content,
    /onboarding-gaps\.log/,
    'must log a residual gap to data/onboarding-gaps.log rather than blocking completion, matching this codebase\'s "flag, never silently hide" convention',
  );
});

test('modes/telegram-onboarding.md is registered in update-system.mjs SYSTEM_PATHS', () => {
  const updateSystemContent = readFileSync(join(ROOT, 'core', 'update-system.mjs'), 'utf-8');
  assert.match(updateSystemContent, /'modes\/telegram-onboarding\.md'/);
});
