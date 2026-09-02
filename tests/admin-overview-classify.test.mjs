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
