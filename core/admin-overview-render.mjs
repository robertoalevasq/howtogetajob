/**
 * admin-overview-render.mjs — pure JSON-to-HTML renderer for the admin
 * overview artifact. Reads a snapshot file (from admin-overview-snapshot.mjs)
 * and writes a complete, ready-to-publish HTML document. No filesystem
 * access beyond the two file arguments, no network access, no LLM calls.
 */
import { readFileSync, writeFileSync } from 'fs';
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
  if (t.state === 'no_run') return '';
  const stepLabel = t.step?.label || t.step?.id || '—';
  return `<tr>
    <td>${escapeHtml(ws.slug)}</td>
    <td>${escapeHtml(t.state)}</td>
    <td>${escapeHtml(stepLabel)}</td>
    <td>${escapeHtml(t.lastUpdateAgo)}</td>
  </tr>`;
}

function renderRunCountsSection(runCountsByWorkspace) {
  const rows = [];
  for (const [slug, byDay] of Object.entries(runCountsByWorkspace)) {
    for (const [day, modes] of Object.entries(byDay)) {
      for (const [mode, count] of Object.entries(modes)) {
        rows.push(`<tr><td>${escapeHtml(slug)}</td><td>${escapeHtml(day)}</td><td>${escapeHtml(mode)}</td><td>${escapeHtml(count)}</td></tr>`);
      }
    }
  }
  return rows.join('\n');
}

function renderTokenUsageSection(tokenUsageByWorkspace) {
  const rows = [];
  for (const [slug, byDay] of Object.entries(tokenUsageByWorkspace)) {
    for (const [day, totals] of Object.entries(byDay)) {
      const total = totals.input_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens + totals.output_tokens;
      rows.push(`<tr><td>${escapeHtml(slug)}</td><td>${escapeHtml(day)}</td><td>${escapeHtml(total.toLocaleString())}</td></tr>`);
    }
  }
  return rows.join('\n');
}

/**
 * Render a complete HTML document from a snapshot object. Pure function —
 * no filesystem or network access.
 *
 * @param {object} snapshot - From admin-overview-snapshot.mjs's buildSnapshot().
 * @returns {string}
 */
export function renderHtml(snapshot) {
  const activeTaskRows = snapshot.workspaces.map(renderActiveTaskRow).filter(Boolean).join('\n');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>career-ops admin overview</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fff; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
  th { background: #f5f5f5; }
  h2 { margin-top: 2rem; }
  .meta { color: #666; font-size: 0.85rem; }
</style>
</head>
<body>
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
</table>
</body>
</html>`;
}

async function main() {
  const [, , snapshotPath, outPath] = process.argv;
  if (!snapshotPath || !outPath) {
    console.error('Usage: node admin-overview-render.mjs <snapshot.json> <output.html>');
    return 1;
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  const html = renderHtml(snapshot);
  writeFileSync(outPath, html, 'utf-8');
  console.log(`admin-overview-render: wrote ${outPath}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
