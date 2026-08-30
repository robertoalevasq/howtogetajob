// Regression coverage for core/telegram-poll.mjs's parseCommand() recognized
// list. Found live 2026-08-30: /settings was fully implemented in
// modes/telegram.md (Step 3h, two review rounds) but 'settings' was never
// added to this array, so parseCommand() returned isCommand: false for it —
// the entire feature was unreachable, silently falling through to the
// generic "unrecognized" nudge every time a candidate sent /settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../core/telegram-poll.mjs';

test('parseCommand recognizes every command modes/telegram.md documents routing on', () => {
  // Keep this list in sync with modes/telegram.md's Step 2 classification
  // table — each row there that says "recognized command" must have its
  // command here, or the routing table is describing dead code.
  const documented = ['run', 'cycle', 'scan', 'apply', 'applyall', 'pdf', 'editpdf', 'status', 'settings', 'help', 'yes', 'no', 'skip', 'cancel'];
  for (const cmd of documented) {
    const result = parseCommand(`/${cmd}`);
    assert.equal(result.isCommand, true, `/${cmd} should be recognized`);
    assert.equal(result.command, cmd);
  }
});

test('parseCommand still rejects an unrecognized slash command', () => {
  const result = parseCommand('/notarealcommand');
  assert.equal(result.isCommand, false);
  assert.equal(result.command, null);
});
