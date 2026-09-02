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
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { isMainModule } from './is-main.mjs';

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

export function walkJsonlFiles(dir) {
  const out = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        try {
          out.push(...walkJsonlFiles(full));
        } catch {
          // Skip inaccessible subdirectories; continue walking siblings
        }
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  } catch {
    // If the directory itself cannot be read, return whatever files we found so far
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
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    // If projects dir itself cannot be read, return empty (graceful degradation)
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const classification = classifyProjectDir(entry.name, prefix);
    if (classification.scope === 'other') continue;
    const dirPath = join(projectsDir, entry.name);
    try {
      for (const file of walkJsonlFiles(dirPath)) {
        results.push({ path: file, scope: classification.scope, slug: classification.slug || null });
      }
    } catch {
      // Skip a project dir that cannot be walked; continue with the next one
    }
  }
  return results;
}

/**
 * PRIVACY-CRITICAL: parse one .jsonl transcript file and extract ONLY
 * `timestamp`+`usage` (from lines carrying a top-level `usage` object) and
 * `timestamp`+Skill-tool-call `input.skill`/`input.args` (from `tool_use`
 * content blocks named "Skill"). Every other field on every line —
 * `message.content` text, other tool inputs/results, anything else — is
 * read only to locate these two shapes and is never copied into the
 * return value. A malformed line is skipped, never thrown.
 *
 * @param {string} filePath
 * @returns {{usageEntries: {timestamp: string, usage: object}[], skillCalls: {timestamp: string, skill: string, args: string}[]}}
 */
export function extractUsageAndSkillCalls(filePath) {
  const usageEntries = [];
  const skillCalls = [];
  if (!existsSync(filePath)) return { usageEntries, skillCalls };

  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { usageEntries, skillCalls };
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip, don't crash the whole file
    }
    const timestamp = entry.timestamp;
    if (!timestamp) continue;

    if (entry.usage && typeof entry.usage === 'object') {
      usageEntries.push({
        timestamp,
        usage: {
          input_tokens: entry.usage.input_tokens || 0,
          cache_creation_input_tokens: entry.usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: entry.usage.cache_read_input_tokens || 0,
          output_tokens: entry.usage.output_tokens || 0,
        },
      });
    }

    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === 'Skill' && block.input) {
          skillCalls.push({
            timestamp,
            skill: String(block.input.skill || ''),
            args: String(block.input.args || ''),
          });
        }
      }
    }
  }

  return { usageEntries, skillCalls };
}

// Ordered so a more specific pattern (e.g. "auto-pipeline") is checked
// before a broader one that could also match the same text. Best-effort
// only — this reads free-text prompt args, not a structured command, so
// anything not clearly matching one of these lands in 'unclassified'
// rather than being guessed into the wrong bucket.
const RUN_CLASSIFICATION_PATTERNS = [
  ['auto-pipeline', /auto-pipeline|evaluate this jd/i],
  ['cycle', /\bcycle mode\b/i],
  ['pipeline', /\bpipeline mode\b/i],
  ['scan', /\bscan mode\b/i],
  ['tracker', /\btracker mode\b/i],
  ['pdf', /\bpdf mode\b/i],
];

/**
 * Best-effort classification of a career-ops Skill invocation's free-text
 * `args` into a mode name, based on the same prompt patterns documented in
 * core/AGENTS.md's Skill Modes table. Never guesses: unrecognized text
 * returns 'unclassified' rather than being folded into the wrong bucket.
 *
 * @param {string} argsText
 * @returns {string}
 */
export function classifyRunFromArgs(argsText) {
  if (!argsText) return 'unclassified';
  for (const [name, pattern] of RUN_CLASSIFICATION_PATTERNS) {
    if (pattern.test(argsText)) return name;
  }
  return 'unclassified';
}

function dayKey(isoTimestamp) {
  return isoTimestamp.slice(0, 10); // "2026-08-31T..." -> "2026-08-31"
}

function bucketKeyFor(scope, slug, knownSlugs) {
  if (scope === 'hub') return 'hub';
  if (slug && knownSlugs.includes(slug)) return slug;
  return 'deleted-or-renamed';
}

/**
 * Aggregate token-usage and run-count history across a set of discovered
 * transcript files (from findHubTranscriptFiles), bucketed by workspace
 * slug and by day. A file whose slug no longer matches any workspace in
 * `knownSlugs` is bucketed under 'deleted-or-renamed' rather than dropped
 * or mis-attributed. Hub-root-scoped files bucket under 'hub'.
 *
 * @param {{path: string, scope: 'hub'|'workspace', slug: string|null}[]} files
 * @param {string[]} knownSlugs - Slugs of currently-provisioned workspaces (from listWorkspaces).
 * @returns {{tokenUsageByWorkspace: Object<string, Object<string, {input_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number, output_tokens: number}>>, runCountsByWorkspace: Object<string, Object<string, Object<string, number>>>}}
 */
export function aggregateHistory(files, knownSlugs) {
  const tokenUsageByWorkspace = {};
  const runCountsByWorkspace = {};

  for (const file of files) {
    const bucket = bucketKeyFor(file.scope, file.slug, knownSlugs);
    const { usageEntries, skillCalls } = extractUsageAndSkillCalls(file.path);

    if (!tokenUsageByWorkspace[bucket]) tokenUsageByWorkspace[bucket] = {};
    for (const { timestamp, usage } of usageEntries) {
      const day = dayKey(timestamp);
      if (!tokenUsageByWorkspace[bucket][day]) {
        tokenUsageByWorkspace[bucket][day] = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
      }
      const dayTotals = tokenUsageByWorkspace[bucket][day];
      dayTotals.input_tokens += usage.input_tokens;
      dayTotals.cache_creation_input_tokens += usage.cache_creation_input_tokens;
      dayTotals.cache_read_input_tokens += usage.cache_read_input_tokens;
      dayTotals.output_tokens += usage.output_tokens;
    }

    if (!runCountsByWorkspace[bucket]) runCountsByWorkspace[bucket] = {};
    for (const { timestamp, skill, args } of skillCalls) {
      if (!skill.includes('career-ops')) continue; // only career-ops invocations count as a "run"
      const day = dayKey(timestamp);
      const mode = classifyRunFromArgs(args);
      if (!runCountsByWorkspace[bucket][day]) runCountsByWorkspace[bucket][day] = {};
      runCountsByWorkspace[bucket][day][mode] = (runCountsByWorkspace[bucket][day][mode] || 0) + 1;
    }
  }

  return { tokenUsageByWorkspace, runCountsByWorkspace };
}

/**
 * Assemble the full cross-workspace snapshot: roster (with tracker stats
 * and active-task status inlined per workspace) plus token-usage/run-count
 * history aggregated from this hub's Claude Code session transcripts.
 *
 * @param {string} [reposRoot] - Override for tests.
 * @param {string} [claudeHome] - Override for tests; defaults to `~/.claude`.
 * @returns {object}
 */
export function buildSnapshot(reposRoot = ROOT, claudeHome = join(homedir(), '.claude')) {
  const workspaces = listWorkspaces(reposRoot).map((ws) => ({
    ...ws,
    trackerStats: getTrackerStats(ws.dir),
    activeTask: getActiveTaskStatus(ws.dir),
  }));
  const knownSlugs = workspaces.map((ws) => ws.slug);
  const files = findHubTranscriptFiles(reposRoot, claudeHome);
  const { tokenUsageByWorkspace, runCountsByWorkspace } = aggregateHistory(files, knownSlugs);

  return {
    generatedAt: new Date().toISOString(),
    workspaces,
    tokenUsageByWorkspace,
    runCountsByWorkspace,
  };
}

async function main() {
  const [, , outPath] = process.argv;
  if (!outPath) {
    console.error('Usage: node admin-overview-snapshot.mjs <output.json>');
    return 1;
  }
  const reposRoot = process.env.CAREER_OPS_ADMIN_OVERVIEW_REPO_ROOT || ROOT;
  const claudeHome = process.env.CAREER_OPS_ADMIN_OVERVIEW_CLAUDE_HOME || join(homedir(), '.claude');
  const snapshot = buildSnapshot(reposRoot, claudeHome);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`admin-overview-snapshot: wrote ${outPath} (${snapshot.workspaces.length} workspace(s))`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
