import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderHtml } from '../core/admin-overview-render.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sampleSnapshot() {
  return {
    generatedAt: '2026-09-02T12:00:00.000Z',
    workspaces: [
      {
        slug: 'alice', displayName: 'Alice', chatId: '123', createdAt: '2026-01-01',
        trackerStats: { tracker: { total: 5 }, funnel: { everApplied: 2 } },
        activeTask: { state: 'running', staleMs: 60000, lastUpdateAgo: '1m ago', step: { id: '2-pipeline', label: 'Pipeline Processing' } },
      },
      {
        slug: 'bob', displayName: 'Bob', chatId: null, createdAt: '2026-02-01',
        trackerStats: null,
        activeTask: { state: 'no_run', staleMs: null, lastUpdateAgo: null, step: null },
      },
    ],
    tokenUsageByWorkspace: {
      alice: { '2026-09-01': { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 } },
    },
    runCountsByWorkspace: {
      alice: { '2026-09-01': { pipeline: 2, unclassified: 1 } },
    },
  };
}

test('renderHtml includes every workspace slug and display name', () => {
  const html = renderHtml(sampleSnapshot());
  assert.match(html, /alice/);
  assert.match(html, /Alice/);
  assert.match(html, /bob/);
  assert.match(html, /Bob/);
});

test('renderHtml shows active-task state for a running workspace', () => {
  const html = renderHtml(sampleSnapshot());
  assert.match(html, /running/i);
  assert.match(html, /Pipeline Processing/);
});

test('renderHtml handles a workspace with null trackerStats without crashing', () => {
  const html = renderHtml(sampleSnapshot());
  assert.match(html, /bob/); // got this far without throwing
});

test('renderHtml surfaces the unclassified run-count bucket, never hiding it', () => {
  const html = renderHtml(sampleSnapshot());
  assert.match(html, /unclassified/i);
});

test('renderHtml produces a fragment (title/style/body only, no document wrapper) for the Artifact publish contract', () => {
  const html = renderHtml(sampleSnapshot());
  assert.match(html, /<title>career-ops admin overview<\/title>/);
  assert.doesNotMatch(html, /<!doctype/i);
  assert.doesNotMatch(html, /<html[\s>]/i);
  assert.doesNotMatch(html, /<head[\s>]/i);
  assert.doesNotMatch(html, /<body[\s>]/i);
});

test('renderActiveTaskRow excludes a "done" state — finished runs must not clutter the active-tasks view forever', () => {
  const snapshot = sampleSnapshot();
  snapshot.workspaces[0].activeTask = { state: 'done', staleMs: null, lastUpdateAgo: '2 days ago', step: { id: '4-pdf', label: 'PDF Generation' } };
  const html = renderHtml(snapshot);
  assert.doesNotMatch(html, /PDF Generation/);
});

test('renderHtml shows the empty-state message when every workspace is done/no_run, never a stale row', () => {
  const snapshot = sampleSnapshot();
  snapshot.workspaces[0].activeTask = { state: 'done', staleMs: null, lastUpdateAgo: '2 days ago', step: { id: '4-pdf', label: 'PDF Generation' } };
  snapshot.workspaces[1].activeTask = { state: 'no_run', staleMs: null, lastUpdateAgo: null, step: null };
  const html = renderHtml(snapshot);
  assert.match(html, /No workspace currently has an in-progress task/);
});

test('renderHtml still shows a row for a "stalled" state', () => {
  const snapshot = sampleSnapshot();
  snapshot.workspaces[0].activeTask = { state: 'stalled', staleMs: 999999, lastUpdateAgo: '1h ago', step: { id: '2-pipeline', label: 'Pipeline Processing' } };
  const html = renderHtml(snapshot);
  assert.match(html, /stalled/i);
  assert.match(html, /Pipeline Processing/);
});

test('renderHtml sorts days within a workspace in descending order and caps to the most recent 30', () => {
  const snapshot = sampleSnapshot();
  const byDay = {};
  for (let i = 1; i <= 32; i++) {
    const day = `2026-01-${String(i).padStart(2, '0')}`;
    byDay[day] = { input_tokens: i, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  }
  snapshot.tokenUsageByWorkspace = { alice: byDay };
  const html = renderHtml(snapshot);
  const tokenSection = html.slice(html.indexOf('<h2>Token usage by day</h2>'), html.indexOf('<h2>Run counts by day</h2>'));

  // The two oldest days (Jan 1 and Jan 2) must be excluded — only the most
  // recent 30 of 32 days render.
  assert.doesNotMatch(tokenSection, /2026-01-01/);
  assert.doesNotMatch(tokenSection, /2026-01-02/);
  assert.match(tokenSection, /2026-01-03/);
  assert.match(tokenSection, /2026-01-32/);

  // Days must render in descending order (most recent first).
  const idx32 = tokenSection.indexOf('2026-01-32');
  const idx03 = tokenSection.indexOf('2026-01-03');
  assert.ok(idx32 >= 0 && idx03 >= 0 && idx32 < idx03, 'expected 2026-01-32 to render before 2026-01-03 (descending order)');
});

test('CLI reads a snapshot JSON file and writes rendered HTML to the given output path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-overview-render-'));
  try {
    const snapshotPath = join(dir, 'snapshot.json');
    const outPath = join(dir, 'output.html');
    writeFileSync(snapshotPath, JSON.stringify(sampleSnapshot()));
    execFileSync(process.execPath, [
      join(REPO_ROOT, 'core', 'admin-overview-render.mjs'), snapshotPath, outPath,
    ], { encoding: 'utf-8' });
    assert.ok(existsSync(outPath));
    const html = readFileSync(outPath, 'utf-8');
    assert.match(html, /alice/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: rendering a snapshot built from a transcript with secret conversation content never leaks that content into the HTML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-overview-e2e-'));
  const claudeHome = mkdtempSync(join(tmpdir(), 'admin-overview-e2e-claude-'));
  try {
    const secretText = 'THIS-IS-PRIVATE-CONVERSATION-CONTENT-SHOULD-NEVER-APPEAR-IN-HTML';
    const wsDir = join(dir, 'workspaces', 'alice');
    mkdirSync(join(wsDir, 'data', 'cache'), { recursive: true });
    writeFileSync(join(wsDir, 'workspace.json'), JSON.stringify({
      slug: 'alice', chat_id: '123', display_name: 'Alice', created_at: '2026-01-01',
    }));

    const prefix = dir.replace(/[:\\_]/g, '-');
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

    const snapshotPath = join(dir, 'snapshot.json');
    const outPath = join(dir, 'output.html');
    execFileSync(process.execPath, [
      join(REPO_ROOT, 'core', 'admin-overview-snapshot.mjs'), snapshotPath,
    ], { encoding: 'utf-8', env: { ...process.env, CAREER_OPS_ADMIN_OVERVIEW_REPO_ROOT: dir, CAREER_OPS_ADMIN_OVERVIEW_CLAUDE_HOME: claudeHome } });

    // Sanity check: verify the snapshot actually ingested transcript data (proves the risky code path ran)
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    assert.ok(
      snapshot.tokenUsageByWorkspace?.alice && Object.keys(snapshot.tokenUsageByWorkspace.alice).length > 0,
      'SANITY CHECK FAILED: transcript ingestion did not run (no token usage data for alice)'
    );

    execFileSync(process.execPath, [
      join(REPO_ROOT, 'core', 'admin-overview-render.mjs'), snapshotPath, outPath,
    ], { encoding: 'utf-8' });

    const html = readFileSync(outPath, 'utf-8');
    assert.ok(!html.includes(secretText), 'PRIVACY VIOLATION: transcript conversation content leaked into rendered HTML');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});
