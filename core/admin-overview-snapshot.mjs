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
import { homedir } from 'os';

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

/**
 * Compute this hub's Claude-Code-style encoded path prefix, used to find
 * this hub's own project directories under ~/.claude/projects/. Claude Code
 * encodes a launch path by replacing ':', '\\', and '_' with '-' while
 * preserving case — and has been observed emitting both upper- and
 * lower-case drive letters for the same hub across different sessions, so
 * callers must match against this prefix case-insensitively.
 *
 * @param {string} [reposRoot]
 * @returns {string}
 */
export function hubProjectDirPrefix(reposRoot = ROOT) {
  return reposRoot.replace(/[:\\_]/g, '-');
}

const WORKSPACE_MARKER = '-workspaces-';

/**
 * Given one ~/.claude/projects/ directory name, determine whether it
 * belongs to this hub's own root, one of its workspaces, or an unrelated
 * project on the same machine.
 *
 * @param {string} dirName
 * @param {string} prefix - From hubProjectDirPrefix().
 * @returns {{scope: 'hub'} | {scope: 'workspace', slug: string} | {scope: 'other'}}
 */
export function classifyProjectDir(dirName, prefix) {
  const lowerDir = dirName.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerDir === lowerPrefix) return { scope: 'hub' };
  const markerLower = (lowerPrefix + WORKSPACE_MARKER);
  if (!lowerDir.startsWith(markerLower)) return { scope: 'other' };
  const slug = dirName.slice((prefix + WORKSPACE_MARKER).length);
  if (!slug) return { scope: 'other' };
  return { scope: 'workspace', slug };
}

function walkJsonlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * Find every .jsonl transcript file under ~/.claude/projects/ that belongs
 * to this hub (its own root, or one of its workspaces) — never files from
 * unrelated projects on the same machine. Searches recursively, since
 * subagent transcripts live one level deeper (observed real layout:
 * "{project-dir}/{sessionId}/subagents/{agentId}.jsonl").
 *
 * @param {string} [reposRoot]
 * @param {string} [claudeHome] - Override for tests; defaults to `~/.claude`.
 * @returns {{path: string, scope: 'hub'|'workspace', slug: string|null}[]}
 */
export function findHubTranscriptFiles(reposRoot = ROOT, claudeHome = join(homedir(), '.claude')) {
  const projectsDir = join(claudeHome, 'projects');
  if (!existsSync(projectsDir)) return [];
  const prefix = hubProjectDirPrefix(reposRoot);
  const results = [];
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const classification = classifyProjectDir(entry.name, prefix);
    if (classification.scope === 'other') continue;
    const dirPath = join(projectsDir, entry.name);
    for (const file of walkJsonlFiles(dirPath)) {
      results.push({ path: file, scope: classification.scope, slug: classification.slug || null });
    }
  }
  return results;
}
