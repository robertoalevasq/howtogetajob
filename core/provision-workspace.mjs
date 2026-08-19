// @ts-check
// provision-workspace.mjs — creates or repairs a workspaces/{slug}/ directory:
// real files for User Layer content, whole-directory junctions for System
// Layer content. See docs/superpowers/specs/2026-08-15-workspace-multitenancy-core-design.md.
//
// The junction list below is deliberately NOT "every SYSTEM_PATHS entry" —
// most SYSTEM_PATHS entries are standalone docs (README.md, LICENSE, etc.)
// nothing reads relative to a workspace's cwd at runtime; a script that needs
// a shared system file resolves it via its OWN ROOT (real location), not the
// workspace's directory listing. This list is only the directories genuinely
// dereferenced by workspace-relative operations (mode prose invoking
// `node core/scan.mjs`, Claude reading `modes/oferta.md` via a bare relative
// Read call, etc).

import { existsSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync, readFileSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // core/'s parent = repo root

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

// Fixed set of top-level System Layer directories genuinely dereferenced by
// workspace-relative operations. See the module doc comment above for why
// this is not "every SYSTEM_PATHS entry."
export const JUNCTION_DIRS = [
  'core', 'modes', 'templates', 'providers', 'plugins', 'plugins-registry',
  'docs', 'dashboard', 'fonts', 'examples', 'lib', 'batch',
  '.agents', '.claude/skills', '.cursor/skills', '.opencode/skills',
  '.opencode/commands', '.grok/skills', '.kimi/skills',
  '.antigravitycli/skills', '.qwen', '.claude-plugin',
];

// User Layer real directories created empty (seeded on demand, not templated).
const REAL_EMPTY_DIRS = [
  'data', 'reports', 'output', 'jds', 'interview-prep', 'writing-samples',
  'config',
];

// { destination relative to workspace root, template relative to repo root }
const SEEDED_FILES = [
  { target: 'config/profile.yml', template: 'config/profile.example.yml' },
  { target: 'config/plugins.yml', template: 'templates/plugins.example.yml' },
  { target: 'portals.yml', template: 'templates/portals.example.yml' },
  { target: '_profile.md', template: 'modes/_profile.template.md' },
  { target: '_custom.md', template: 'modes/_custom.template.md' },
  { target: '_brief.md', template: 'modes/_brief.template.md' },
  { target: 'interview-prep/sessions/.gitkeep', template: 'templates/interview-prep-sessions/.gitkeep' },
  { target: 'interview-prep/sessions/README.md', template: 'templates/interview-prep-sessions/README.md' },
  { target: 'writing-samples/README.md', template: 'templates/writing-samples/README.md' },
];

const PIPELINE_SKELETON = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

## Pending

## Processed
`;

const APPLICATIONS_SKELETON = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

function junctionType() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

/** Create a junction/symlink at wsDir/name pointing at repoRoot/name, if it doesn't already exist. */
function ensureJunction(repoRoot, wsDir, relDir) {
  const target = join(repoRoot, ...relDir.split('/'));
  const linkPath = join(wsDir, ...relDir.split('/'));
  if (existsSync(linkPath)) return false; // already present — repair no-ops here
  mkdirSync(dirname(linkPath), { recursive: true });
  if (!existsSync(target)) return false; // source doesn't exist in this repo (e.g. optional dir) — skip
  symlinkSync(target, linkPath, junctionType());
  return true;
}

function seedFile(repoRoot, wsDir, target, template) {
  const targetPath = join(wsDir, ...target.split('/'));
  const templatePath = join(repoRoot, ...template.split('/'));
  if (existsSync(targetPath)) return false;
  mkdirSync(dirname(targetPath), { recursive: true });
  if (!existsSync(templatePath)) return false;
  copyFileSync(templatePath, targetPath);
  return true;
}

/**
 * @param {string} slug
 * @param {{ reposRoot?: string, chatId?: string, displayName?: string, repair?: boolean }} [opts]
 */
export function provisionWorkspace(slug, opts = {}) {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid workspace slug "${slug}" — must match ${SLUG_RE}`);
  }
  const repoRoot = opts.reposRoot || ROOT;
  const wsDir = join(repoRoot, 'workspaces', slug);
  mkdirSync(wsDir, { recursive: true });

  // Junction/seed SOURCES are System Layer content and always resolve off the
  // real script location (ROOT) — never off repoRoot/opts.reposRoot, which
  // only relocates where the workspace itself gets created (test isolation).
  // See "Path resolution rule" in the design doc: system-asset joins keep
  // resolving off ROOT unchanged, independent of workspace placement.
  for (const dir of JUNCTION_DIRS) ensureJunction(ROOT, wsDir, dir);

  for (const dir of REAL_EMPTY_DIRS) {
    const p = join(wsDir, dir);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  for (const { target, template } of SEEDED_FILES) seedFile(ROOT, wsDir, target, template);

  const pipelinePath = join(wsDir, 'data', 'pipeline.md');
  if (!existsSync(pipelinePath)) writeFileSync(pipelinePath, PIPELINE_SKELETON, 'utf-8');

  const trackerPath = join(wsDir, 'data', 'applications.md');
  if (!existsSync(trackerPath)) writeFileSync(trackerPath, APPLICATIONS_SKELETON, 'utf-8');

  const metaPath = join(wsDir, 'workspace.json');
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, JSON.stringify({
      slug,
      chat_id: opts.chatId || null,
      display_name: opts.displayName || slug,
      created_at: new Date().toISOString().slice(0, 10),
    }, null, 2), 'utf-8');
  }

  return wsDir;
}

/** Convert a display name into a lowercase slug candidate (no dedup check). */
export function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'candidate';
}

/**
 * Slugify `name`, then dedupe against existing workspaces/ (appending
 * -2, -3, ... on collision). Always returns a slug satisfying SLUG_RE.
 *
 * @param {string} name
 * @param {{ reposRoot?: string }} [opts]
 */
export function resolveAvailableSlug(name, opts = {}) {
  const repoRoot = opts.reposRoot || ROOT;
  const workspacesDir = join(repoRoot, 'workspaces');
  let base = slugify(name);
  if (base.length < 2) base = `${base}0`; // SLUG_RE requires 2+ chars
  const existing = new Set(
    existsSync(workspacesDir)
      ? readdirSync(workspacesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
      : [],
  );
  if (!existing.has(base)) return base;
  let n = 2;
  let candidate;
  do {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    n++;
  } while (existing.has(candidate));
  return candidate;
}

/**
 * Set workspaces/{slug}/workspace.json's chat_id — the ONLY sanctioned way
 * to bind a chat to a workspace, per the router/onboarding design. Enforces
 * one-workspace-per-chat and one-chat-per-workspace. Idempotent when
 * re-binding the same slug to the same chat it's already bound to.
 *
 * @param {string} slug
 * @param {string|number} chatId
 * @param {{ reposRoot?: string }} [opts]
 */
export function bindWorkspaceChat(slug, chatId, opts = {}) {
  const repoRoot = opts.reposRoot || ROOT;
  const workspacesDir = join(repoRoot, 'workspaces');
  const metaPath = join(workspacesDir, slug, 'workspace.json');
  if (!existsSync(metaPath)) {
    throw new Error(`workspace "${slug}" does not exist — provision it first`);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  const chatIdStr = String(chatId);
  if (meta.chat_id && meta.chat_id !== chatIdStr) {
    throw new Error(`workspace "${slug}" is already bound to a different chat`);
  }

  const siblingSlugs = readdirSync(workspacesDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== slug)
    .map(e => e.name);
  for (const sibling of siblingSlugs) {
    const siblingMetaPath = join(workspacesDir, sibling, 'workspace.json');
    if (!existsSync(siblingMetaPath)) continue;
    let siblingMeta;
    try {
      siblingMeta = JSON.parse(readFileSync(siblingMetaPath, 'utf-8'));
    } catch {
      continue; // unreadable/corrupt sibling — not this function's job to repair
    }
    if (siblingMeta.chat_id === chatIdStr) {
      throw new Error(`chat is already bound to a different workspace ("${sibling}")`);
    }
  }

  meta.chat_id = chatIdStr;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * Re-run provisionWorkspace(slug, { repair: true }) for every existing
 * workspaces/{slug}/ directory, so a newly-added JUNCTION_DIRS entry gets
 * picked up by every already-provisioned workspace without a full re-provision.
 *
 * @param {{ reposRoot?: string }} [opts]
 * @returns {string[]} slugs that were repaired
 */
export function repairAllWorkspaces(opts = {}) {
  const repoRoot = opts.reposRoot || ROOT;
  const workspacesDir = join(repoRoot, 'workspaces');
  if (!existsSync(workspacesDir)) return [];
  const slugs = readdirSync(workspacesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const repaired = [];
  for (const slug of slugs) {
    provisionWorkspace(slug, { reposRoot: repoRoot, repair: true });
    repaired.push(slug);
  }
  return repaired;
}

async function main() {
  const [, , first, ...rest] = process.argv;
  if (first === '--repair-all') {
    const repaired = repairAllWorkspaces({});
    console.log(`repaired ${repaired.length} workspace(s): ${repaired.join(', ')}`);
    return;
  }
  if (first === '--from-name') {
    const name = rest.join(' ');
    if (!name.trim()) { console.error('Usage: node provision-workspace.mjs --from-name "<display name>"'); process.exit(1); }
    const slug = resolveAvailableSlug(name);
    provisionWorkspace(slug, { displayName: name });
    console.log(slug);
    return;
  }
  if (first === '--bind-chat') {
    const [slug, chatId] = rest;
    if (!slug || !chatId) { console.error('Usage: node provision-workspace.mjs --bind-chat <slug> <chatId>'); process.exit(1); }
    try {
      bindWorkspaceChat(slug, chatId);
      console.log(`bound: ${slug} <- chat ${chatId}`);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    return;
  }
  if (!first) {
    console.error('Usage: node provision-workspace.mjs <slug> [--repair] | node provision-workspace.mjs --repair-all');
    process.exit(1);
  }
  const repair = rest.includes('--repair');
  const wsDir = provisionWorkspace(first, { repair });
  console.log(`workspace ready: ${wsDir}`);
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`❌ provision-workspace: ${err.message}`);
    process.exit(1);
  });
}
