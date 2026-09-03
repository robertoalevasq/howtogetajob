/**
 * admin-overview-render.mjs — pure JSON-to-HTML renderer for the admin
 * overview artifact. Reads a snapshot file (from admin-overview-snapshot.mjs)
 * and writes an HTML fragment (title + style + body content, no surrounding
 * <!doctype>/<html>/<head>/<body> tags) ready to hand to Claude's Artifact
 * tool, which wraps it in its own document skeleton at publish time. No
 * filesystem access beyond the two file arguments, no network access, no
 * LLM calls.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { isMainModule } from './is-main.mjs';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderWorkspaceRow(ws) {
  const total = ws.trackerStats?.tracker?.total ?? '—';
  const applied = ws.trackerStats?.funnel?.everApplied ?? '—';
  const chatBound = ws.chatId ? '✓' : '—';
  return `<tr>
    <td>${escapeHtml(ws.slug)}</td>
    <td>${escapeHtml(ws.displayName)}</td>
    <td>${escapeHtml(ws.createdAt)}</td>
    <td>${chatBound}</td>
    <td>${escapeHtml(total)}</td>
    <td>${escapeHtml(applied)}</td>
  </tr>`;
}

function renderActiveTaskRow(ws) {
  const t = ws.activeTask;
  if (t.state !== 'running' && t.state !== 'stalled') return '';
  const stepLabel = t.step?.label || t.step?.id || '—';
  return `<tr>
    <td>${escapeHtml(ws.slug)}</td>
    <td>${escapeHtml(t.state)}</td>
    <td>${escapeHtml(stepLabel)}</td>
    <td>${escapeHtml(t.lastUpdateAgo)}</td>
  </tr>`;
}

const MAX_DAYS_PER_WORKSPACE = 30;

// Sorted (alphabetically ascending) workspace-slug keys, each paired with its
// per-day keys sorted DESCENDING (most recent first — plain string sort
// works since day keys are YYYY-MM-DD) and capped to the most recent
// MAX_DAYS_PER_WORKSPACE, so output is stable across redeploys and doesn't
// grow unbounded as more days of history accumulate.
function sortedWorkspaceDayEntries(byWorkspace) {
  const slugs = Object.keys(byWorkspace).sort();
  return slugs.map((slug) => {
    const byDay = byWorkspace[slug];
    const days = Object.keys(byDay).sort().reverse().slice(0, MAX_DAYS_PER_WORKSPACE);
    return { slug, days: days.map((day) => [day, byDay[day]]) };
  });
}

function renderRunCountsSection(runCountsByWorkspace) {
  const rows = [];
  for (const { slug, days } of sortedWorkspaceDayEntries(runCountsByWorkspace)) {
    for (const [day, modes] of days) {
      for (const [mode, count] of Object.entries(modes)) {
        rows.push(`<tr><td>${escapeHtml(slug)}</td><td>${escapeHtml(day)}</td><td>${escapeHtml(mode)}</td><td>${escapeHtml(count)}</td></tr>`);
      }
    }
  }
  return rows.join('\n');
}

function renderTokenUsageSection(tokenUsageByWorkspace) {
  const rows = [];
  for (const { slug, days } of sortedWorkspaceDayEntries(tokenUsageByWorkspace)) {
    for (const [day, totals] of days) {
      const total = totals.input_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens + totals.output_tokens;
      rows.push(`<tr><td>${escapeHtml(slug)}</td><td>${escapeHtml(day)}</td><td>${escapeHtml(total.toLocaleString('en-US'))}</td></tr>`);
    }
  }
  return rows.join('\n');
}

/**
 * Render an HTML fragment (title + style + body content only — no
 * <!doctype>/<html>/<head>/<body> wrapper) from a snapshot object. This is
 * meant to be published via Claude's Artifact tool, which wraps whatever
 * content it's given in its OWN document skeleton at publish time; a
 * caller-supplied full document would nest inside that skeleton. Pure
 * function — no filesystem or network access.
 *
 * @param {object} snapshot - From admin-overview-snapshot.mjs's buildSnapshot().
 * @returns {string}
 */
export function renderHtml(snapshot) {
  const activeTaskRows = snapshot.workspaces.map(renderActiveTaskRow).filter(Boolean).join('\n');
  return `<title>career-ops admin overview</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fff; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
  th { background: #f5f5f5; }
  h2 { margin-top: 2rem; }
  .meta { color: #666; font-size: 0.85rem; }
</style>
<h1>career-ops admin overview</h1>
<p class="meta">Generated ${escapeHtml(snapshot.generatedAt)}</p>

<h2>Workspaces</h2>
<table>
<tr><th>Slug</th><th>Display name</th><th>Created</th><th>Telegram-bound</th><th>Evaluated</th><th>Applied</th></tr>
${snapshot.workspaces.map(renderWorkspaceRow).join('\n')}
</table>

<h2>Active tasks</h2>
${activeTaskRows
    ? `<table><tr><th>Workspace</th><th>State</th><th>Step</th><th>Last update</th></tr>${activeTaskRows}</table>`
    : '<p>No workspace currently has an in-progress task.</p>'}

<h2>Token usage by day</h2>
<table>
<tr><th>Workspace</th><th>Day</th><th>Total tokens</th></tr>
${renderTokenUsageSection(snapshot.tokenUsageByWorkspace)}
</table>

<h2>Run counts by day</h2>
<table>
<tr><th>Workspace</th><th>Day</th><th>Mode</th><th>Count</th></tr>
${renderRunCountsSection(snapshot.runCountsByWorkspace)}
</table>`;
}

async function main() {
  const [, , snapshotPath, outPath] = process.argv;
  if (!snapshotPath || !outPath) {
    console.error('Usage: node admin-overview-render.mjs <snapshot.json> <output.html>');
    return 1;
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  const html = renderHtml(snapshot);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf-8');
  console.log(`admin-overview-render: wrote ${outPath}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
