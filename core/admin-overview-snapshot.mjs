/**
 * admin-overview-snapshot.mjs — gathers a cross-workspace snapshot for the
 * admin overview artifact: workspace roster, tracker stats, active-task
 * status, and token-usage/run-count history mined from Claude Code's own
 * local session transcripts.
 *
 * PRIVACY-CRITICAL: the transcript-parsing functions in this file extract
 * ONLY `timestamp`, `usage`, and Skill-tool-call `input.skill`/`input.args`
 * fields from each JSONL line — never any other field (message content,
 * tool results, file contents). See
 * docs/superpowers/specs/2026-09-02-admin-overview-design.md.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Enumerate every provisioned workspace under workspaces/.
 *
 * @param {string} [reposRoot] - Override for tests.
 * @returns {{slug: string, displayName: string, chatId: string|null, createdAt: string|null, dir: string}[]}
 */
export function listWorkspaces(reposRoot = ROOT) {
  const workspacesDir = join(reposRoot, 'workspaces');
  if (!existsSync(workspacesDir)) return [];
  const slugs = readdirSync(workspacesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const result = [];
  for (const slug of slugs) {
    const dir = join(workspacesDir, slug);
    const metaPath = join(dir, 'workspace.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      result.push({
        slug: meta.slug || slug,
        displayName: meta.display_name || slug,
        chatId: meta.chat_id || null,
        createdAt: meta.created_at || null,
        dir,
      });
    } catch {
      // corrupt/unreadable workspace.json — skip, don't crash the whole snapshot
    }
  }
  return result;
}

/**
 * Run core/stats.mjs against one workspace and return its parsed JSON, or
 * null if the script fails/produces unparseable output (never throws —
 * a broken workspace must not crash the whole snapshot).
 *
 * @param {string} wsDir - Absolute path to the workspace directory.
 * @returns {object|null}
 */
export function getTrackerStats(wsDir) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'core', 'stats.mjs')], {
      cwd: wsDir,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Run core/cycle-status.mjs --json against one workspace and return its
 * liveness classification. The script itself already handles "never run
 * yet" gracefully (prints {liveness: {state: 'no_run', ...}} and exits 0),
 * so the try/catch here only guards against a genuinely broken/corrupt
 * state file — never let one bad workspace crash the whole snapshot.
 *
 * @param {string} wsDir
 * @returns {{state: string, staleMs: number|null, lastUpdateAgo: string|null, step: object|null}}
 */
export function getActiveTaskStatus(wsDir) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'core', 'cycle-status.mjs'), '--json'], {
      cwd: wsDir,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const data = JSON.parse(out);
    return { ...data.liveness, step: data.step || null };
  } catch {
    return { state: 'no_run', staleMs: null, lastUpdateAgo: null, step: null };
  }
}
