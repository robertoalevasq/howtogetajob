import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('ollama-delegate.mjs resolves config/llm-provider.yml from the invoking workspace, not the repo root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  mkdirSync(join(ws, 'config'), { recursive: true });
  // A config that disables the one task this test invokes -- if the script
  // read the repo root's config (or the no-config default) instead of this
  // workspace's file, it would NOT see this disabled flag and would attempt
  // a real network call instead of failing fast with "disabled in config".
  writeFileSync(join(ws, 'config', 'llm-provider.yml'), [
    'ollama_cloud:',
    '  enabled: false',
    'ollama_local:',
    '  enabled: false',
    'tasks:',
    '  comp_market_estimate: false',
  ].join('\n'));

  const inputFile = join(ws, 'input.txt');
  writeFileSync(inputFile, 'Staff Backend Engineer, Berlin, hybrid.');

  try {
    let threw = null;
    try {
      execFileSync('node', [
        join(REPO_ROOT, 'core', 'ollama-delegate.mjs'), 'comp-market-estimate', '--input', inputFile,
      ], { cwd: ws, encoding: 'utf-8' });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'the CLI should exit non-zero because the workspace config disables this task');
    assert.match(String(threw.stderr), /disabled/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('ollama-delegate.mjs treats a workspace with no config/llm-provider.yml as fully disabled (no crash, no network attempt)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'career-ops-ws-'));
  const inputFile = join(ws, 'input.txt');
  writeFileSync(inputFile, 'Staff Backend Engineer, Berlin, hybrid.');

  try {
    let threw = null;
    try {
      execFileSync('node', [
        join(REPO_ROOT, 'core', 'ollama-delegate.mjs'), 'comp-market-estimate', '--input', inputFile,
      ], { cwd: ws, encoding: 'utf-8' });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'no config in the workspace -> both providers disabled -> non-zero exit');
    assert.match(String(threw.stderr), /all providers failed|no provider enabled/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
