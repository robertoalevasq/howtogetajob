import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { renderHubControl } from '../core/render-hub-control.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeWorkspace(root, slug, overrides = {}) {
  const wsDir = join(root, 'workspaces', slug);
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({
    slug, chat_id: '123', display_name: slug, created_at: '2026-01-01', ...overrides,
  }));
  return wsDir;
}

test('renderHubControl embeds the snapshot and leaves no unreplaced placeholder', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-control-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'hub-control-claude-'));
  try {
    makeWorkspace(root, 'alice');
    const { html, snapshot } = renderHubControl(root, claudeHome);
    assert.equal(snapshot.workspaces.length, 1);
    assert.doesNotMatch(html, /__SNAPSHOT_JSON__/);
    assert.match(html, /"slug":"alice"/);
    assert.match(html, /<title>Hub Control<\/title>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});

test('renderHubControl neutralizes a literal "</script" in workspace data so it cannot close the JSON tag early', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-control-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'hub-control-claude-'));
  try {
    makeWorkspace(root, 'alice', { display_name: '</script><script>alert(1)</script>' });
    const { html } = renderHubControl(root, claudeHome);
    assert.doesNotMatch(html, /<\/script><script>alert\(1\)/);
    // the escaped form must still carry the original text for JSON.parse to recover it
    assert.match(html, /alert\(1\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});

test('end-to-end: rendering a snapshot built from a transcript with secret conversation content never leaks that content into the HTML', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-control-e2e-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'hub-control-e2e-claude-'));
  try {
    const secretText = 'THIS-IS-PRIVATE-CONVERSATION-CONTENT-SHOULD-NEVER-APPEAR-IN-HTML';
    makeWorkspace(root, 'alice');

    const prefix = root.replace(/[:\\_]/g, '-');
    const transcriptDir = join(claudeHome, 'projects', `${prefix}-workspaces-alice`);
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, 'session.jsonl'), JSON.stringify({
      type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: secretText }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
      },
    }) + '\n');

    const { html, snapshot } = renderHubControl(root, claudeHome);
    assert.ok(
      snapshot.tokenUsageByWorkspace?.alice && Object.keys(snapshot.tokenUsageByWorkspace.alice).length > 0,
      'SANITY CHECK FAILED: transcript ingestion did not run (no token usage data for alice)'
    );
    assert.ok(!html.includes(secretText), 'PRIVACY VIOLATION: transcript conversation content leaked into rendered HTML');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});

test('CLI writes rendered HTML to the given output path', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'hub-control-cli-'));
  const outPath = join(outDir, 'output.html');
  try {
    execFileSync(process.execPath, [
      join(REPO_ROOT, 'core', 'render-hub-control.mjs'), outPath,
    ], { encoding: 'utf-8' });
    assert.ok(existsSync(outPath));
    assert.match(readFileSync(outPath, 'utf-8'), /<title>Hub Control<\/title>/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
