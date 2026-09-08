// tests/admin-overview-classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunFromArgs } from '../core/admin-overview-snapshot.mjs';

test('classifyRunFromArgs recognizes pipeline mode', () => {
  assert.equal(classifyRunFromArgs('Run career-ops pipeline mode for data/pipeline.md.'), 'pipeline');
});

test('classifyRunFromArgs recognizes cycle mode', () => {
  assert.equal(classifyRunFromArgs('Run the career-ops cycle mode: scan, then pipeline, then top-match PDFs.'), 'cycle');
});

test('classifyRunFromArgs recognizes scan mode', () => {
  assert.equal(classifyRunFromArgs('Run the career-ops scan mode and summarize new matches.'), 'scan');
});

test('classifyRunFromArgs recognizes a JD/URL evaluation as auto-pipeline', () => {
  assert.equal(classifyRunFromArgs('Evaluate this JD with career-ops auto-pipeline: https://company.com/jobs/123'), 'auto-pipeline');
});

test('classifyRunFromArgs recognizes tracker mode', () => {
  assert.equal(classifyRunFromArgs('Run the career-ops tracker mode and summarize the current statuses.'), 'tracker');
});

test('classifyRunFromArgs recognizes pdf mode', () => {
  assert.equal(classifyRunFromArgs('Run the career-ops pdf mode for the latest evaluated role.'), 'pdf');
});

test('classifyRunFromArgs returns unclassified for text matching no known pattern, never a wrong guess', () => {
  assert.equal(classifyRunFromArgs('Telegram routing for received message: "Yes" from Ernesto (chatId 8859195406, messageId 395). Route per modes/telegram.md Steps 2-6.'), 'unclassified');
});

test('classifyRunFromArgs returns unclassified for empty/missing text', () => {
  assert.equal(classifyRunFromArgs(''), 'unclassified');
});

// Real Skill tool-call args are slash-command style bare mode tokens, not
// the prose EXAMPLE prompts documented in core/AGENTS.md.
test('classifyRunFromArgs recognizes a bare mode token', () => {
  assert.equal(classifyRunFromArgs('cycle'), 'cycle');
});

test('classifyRunFromArgs recognizes a bare mode token with trailing args', () => {
  assert.equal(classifyRunFromArgs('pdf reports/484-company-2026-08-03.md'), 'pdf');
});

test('classifyRunFromArgs recognizes apply-batch without colliding with batch', () => {
  assert.equal(classifyRunFromArgs('apply-batch'), 'apply-batch');
  assert.equal(classifyRunFromArgs('batch'), 'batch');
});

// Real Telegram-router dispatches are prose, not a bare leading token — e.g.
// "Route Telegram message per modes/telegram.md: /apply 939 from Ernesto
// (chatId 88...)". Found live 2026-09-08: every one of these fell through to
// 'unclassified' because the prose fallback list had no apply entry at all,
// which hid apply's real token cost inside 'unclassified' workspace-wide.
test('classifyRunFromArgs recognizes a prose-embedded /apply command with a report number', () => {
  assert.equal(
    classifyRunFromArgs('Route Telegram message per modes/telegram.md: /apply 939 from Ernesto (chatId 8859195406, messageId 605).'),
    'apply'
  );
});

test('classifyRunFromArgs recognizes a prose-embedded /apply-batch command', () => {
  assert.equal(
    classifyRunFromArgs('Route Telegram message per modes/telegram.md: /apply-batch from Ernesto.'),
    'apply-batch'
  );
});

// A bare mention of the mode name in running prose (not a literal slash
// command) must NOT match — this is exactly the false-positive class found
// live during investigation: modes/apply.md's own doc text ("`apply` mode's
// account-creation flow") and file paths like "modes/apply.md" or
// "data/.apply-secrets.json" get pulled into context/tool-result text
// constantly and must never be misread as a real invocation.
test('classifyRunFromArgs does not misclassify a file-path or doc mention of apply', () => {
  assert.equal(classifyRunFromArgs('See modes/apply.md Step 5-alt item 7 and data/.apply-secrets.json for details.'), 'unclassified');
  assert.equal(classifyRunFromArgs("The `apply` mode's account-creation flow always stops for consent."), 'unclassified');
});
