import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decide } from '../core/hooks/guard-playwright-delegation.mjs';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'hooks', 'guard-playwright-delegation.mjs');

test('decide() denies when agent_id is absent (main session)', () => {
  const result = decide({ tool_name: 'mcp__playwright__browser_click' });
  assert.equal(result.exitCode, 2);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /Step 7b/);
});

test('decide() denies when agent_id is explicitly null', () => {
  const result = decide({ tool_name: 'mcp__playwright__browser_type', agent_id: null });
  assert.equal(result.exitCode, 2);
});

test('decide() denies on an empty payload object', () => {
  const result = decide({});
  assert.equal(result.exitCode, 2);
});

test('decide() denies on a null payload without throwing', () => {
  const result = decide(null);
  assert.equal(result.exitCode, 2);
});

test('decide() allows when agent_id is present (delegated subagent)', () => {
  const result = decide({ tool_name: 'mcp__playwright__browser_click', agent_id: 'agent-abc123' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, null);
});

test('script exits 2 and prints a deny JSON when stdin has no agent_id', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify({ tool_name: 'mcp__playwright__browser_fill_form' }),
    encoding: 'utf8',
  });
  assert.equal(proc.status, 2);
  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});

test('script exits 0 with no stdout when stdin has an agent_id', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify({ tool_name: 'mcp__playwright__browser_click', agent_id: 'agent-xyz' }),
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0);
  assert.equal(proc.stdout, '');
});

test('script fails open (exit 0) on malformed stdin instead of crashing or blocking', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: 'not valid json{{{',
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0);
});

test('script fails open (exit 0) on empty stdin', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: '',
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0);
});
