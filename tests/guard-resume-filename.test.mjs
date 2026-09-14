import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decide } from '../core/hooks/guard-resume-filename.mjs';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'hooks', 'guard-resume-filename.mjs');

test('decide() denies a canonical internal output PDF path (Unix separators)', () => {
  const result = decide({ tool_input: { paths: ['/repo/workspaces/thomas-acosta/output/023-hdsupply-2026-09-04.pdf'] } });
  assert.equal(result.exitCode, 2);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /Step 7b/);
});

test('decide() denies a canonical internal output PDF path (Windows separators)', () => {
  const result = decide({ tool_input: { paths: ['C:\\repo\\workspaces\\thomas-acosta\\output\\023-hdsupply-2026-09-04.pdf'] } });
  assert.equal(result.exitCode, 2);
});

test('decide() denies when the canonical path is one of several paths', () => {
  const result = decide({ tool_input: { paths: ['/tmp/cover-letter.pdf', '/repo/workspaces/x/output/080-destinationknot-2026-09-11.pdf'] } });
  assert.equal(result.exitCode, 2);
});

test('decide() allows a renamed .tmp/ human-facing filename', () => {
  const result = decide({ tool_input: { paths: ['/repo/workspaces/thomas-acosta/.tmp/Thomas Acosta - HD Supply.pdf'] } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, null);
});

test('decide() allows an output/ file that does not follow the {num}- prefix convention', () => {
  const result = decide({ tool_input: { paths: ['/repo/workspaces/x/output/cover-letter.pdf'] } });
  assert.equal(result.exitCode, 0);
});

test('decide() allows when paths is missing entirely', () => {
  const result = decide({ tool_input: {} });
  assert.equal(result.exitCode, 0);
});

test('decide() allows when tool_input is missing entirely', () => {
  const result = decide({});
  assert.equal(result.exitCode, 0);
});

test('decide() allows on a null payload without throwing', () => {
  const result = decide(null);
  assert.equal(result.exitCode, 0);
});

test('decide() denies a bare relative canonical path with no leading separator (e.g. path.join("output", filename))', () => {
  const result = decide({ tool_input: { paths: ['output/021-hdsupply-2026-09-04.pdf'] } });
  assert.equal(result.exitCode, 2);
});

test('decide() denies a bare relative canonical path with Windows separators, no leading separator', () => {
  const result = decide({ tool_input: { paths: ['output\\021-hdsupply-2026-09-04.pdf'] } });
  assert.equal(result.exitCode, 2);
});

test('decide() still allows a path where "output" is part of a different folder name (no false positive from anchoring)', () => {
  const result = decide({ tool_input: { paths: ['myoutput/021-hdsupply-2026-09-04.pdf'] } });
  assert.equal(result.exitCode, 0);
});

test('decide() allows an empty paths array', () => {
  const result = decide({ tool_input: { paths: [] } });
  assert.equal(result.exitCode, 0);
});

test('script exits 2 and prints a deny JSON for a canonical path on stdin', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify({ tool_input: { paths: ['/repo/workspaces/x/output/007-acme-2026-01-01.pdf'] } }),
    encoding: 'utf8',
  });
  assert.equal(proc.status, 2);
  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});

test('script exits 0 with no stdout for a renamed .tmp/ path', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: JSON.stringify({ tool_input: { paths: ['/repo/workspaces/x/.tmp/Jane Doe - Acme.pdf'] } }),
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0);
  assert.equal(proc.stdout, '');
});

test('script fails open (exit 0) on malformed stdin instead of crashing or blocking', () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0);
  assert.equal(proc.stdout, '');
});
