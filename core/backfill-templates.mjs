// @ts-check
// backfill-templates.mjs — additively syncs new fields from
// config/profile.example.yml and templates/portals.example.yml into an
// already-provisioned workspace's real config/profile.yml and portals.yml.
// Never modifies or removes an existing key, regardless of its value.
//
// Uses the `yaml` package's Document API (not js-yaml's dump()) because
// config/profile.example.yml is 75% comments and templates/portals.example.yml
// is 42% comments — a parse-then-dump round-trip would silently delete all
// of it. See docs/superpowers/specs/2026-09-03-multi-tenant-maintenance-tooling-design.md.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, isMap } from 'yaml';
import { isMainModule } from './is-main.mjs';
import { listWorkspaces } from './admin-overview-snapshot.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // core/'s parent = repo root

export const TEMPLATE_PAIRS = [
  { live: 'config/profile.yml', template: 'config/profile.example.yml' },
  { live: 'portals.yml', template: 'templates/portals.example.yml' },
];

/**
 * Key paths present in templateNode but absent from liveNode. Stops at the
 * shallowest missing point — a whole missing subtree is returned as one
 * path, never rebuilt key-by-key.
 * @param {import('yaml').Node} templateNode
 * @param {import('yaml').Node} liveNode
 * @param {string[]} path
 * @returns {string[][]}
 */
export function findMissingKeyPaths(templateNode, liveNode, path = []) {
  const missing = [];
  if (!isMap(templateNode)) return missing;
  for (const item of templateNode.items) {
    const key = /** @type {any} */ (item.key).value;
    const childPath = [...path, key];
    if (!isMap(liveNode) || !liveNode.has(key)) {
      missing.push(childPath);
    } else {
      missing.push(...findMissingKeyPaths(item.value, liveNode.get(key, true), childPath));
    }
  }
  return missing;
}

/**
 * Compare one (live, template) file pair. Never throws — a missing file or
 * a parse error is reported in the return value.
 * @returns {{ missing: string[][], error: string|null }}
 */
export function checkFile(liveFilePath, templateFilePath) {
  if (!existsSync(liveFilePath) || !existsSync(templateFilePath)) {
    return { missing: [], error: null };
  }
  let liveDoc, templateDoc;
  try {
    liveDoc = parseDocument(readFileSync(liveFilePath, 'utf8'));
    templateDoc = parseDocument(readFileSync(templateFilePath, 'utf8'));
  } catch (err) {
    return { missing: [], error: /** @type {Error} */ (err).message };
  }
  if (liveDoc.errors.length > 0) return { missing: [], error: String(liveDoc.errors[0]) };
  if (templateDoc.errors.length > 0) return { missing: [], error: String(templateDoc.errors[0]) };
  return { missing: findMissingKeyPaths(templateDoc.contents, liveDoc.contents), error: null };
}

/**
 * Write every missing key path from `checkFile` into the live file, cloned
 * from the template so its attached comments move along with it. No-op
 * (no write at all) when nothing is missing.
 * @returns {string[][]} paths written
 */
export function applyFile(liveFilePath, templateFilePath) {
  const { missing, error } = checkFile(liveFilePath, templateFilePath);
  if (error || missing.length === 0) return [];
  const liveDoc = parseDocument(readFileSync(liveFilePath, 'utf8'));
  const templateDoc = parseDocument(readFileSync(templateFilePath, 'utf8'));

  for (const path of missing) {
    const lastKey = path[path.length - 1];
    const parentPath = path.slice(0, -1);

    // Get parent maps from both documents
    let liveParentMap, templateParentMap;
    if (parentPath.length === 0) {
      // Top-level key
      liveParentMap = liveDoc.contents;
      templateParentMap = templateDoc.contents;
    } else {
      // Nested key - navigate to parent
      liveParentMap = liveDoc.getIn(parentPath, true);
      templateParentMap = templateDoc.getIn(parentPath, true);
    }

    // If parent is a map in both documents, copy the Pair from template to preserve comments
    if (isMap(liveParentMap) && isMap(templateParentMap)) {
      const templatePair = templateParentMap.items.find(item => item.key.value === lastKey);
      if (templatePair) {
        liveParentMap.items.push(templatePair);
        continue;
      }
    }

    // Fallback to setIn if parent isn't a map or Pair not found
    const node = templateDoc.getIn(path, true);
    liveDoc.setIn(path, node);
  }

  writeFileSync(liveFilePath, liveDoc.toString());
  return missing;
}

/** @returns {{ file: string, missing: string[][], error: string|null }[]} */
export function checkWorkspace(wsDir, reposRoot = ROOT) {
  return TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    ...checkFile(join(wsDir, live), join(reposRoot, template)),
  }));
}

/** @returns {{ file: string, written: string[][] }[]} */
export function applyWorkspace(wsDir, reposRoot = ROOT) {
  return TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    written: applyFile(join(wsDir, live), join(reposRoot, template)),
  }));
}

function formatPath(path) {
  return path.join('.');
}

function resolveTargets(argv, reposRoot) {
  if (argv.includes('--all')) {
    return listWorkspaces(reposRoot).map((w) => ({ slug: w.slug, dir: w.dir }));
  }
  const slug = argv.find((a) => !a.startsWith('--') && a !== reposRoot);
  if (!slug) return null;
  return [{ slug, dir: join(reposRoot, 'workspaces', slug) }];
}

async function main() {
  const argv = process.argv.slice(2);
  const rootIdx = argv.indexOf('--repos-root');
  const reposRoot = rootIdx !== -1 ? argv[rootIdx + 1] : ROOT;
  const cleanArgv = rootIdx !== -1 ? argv.filter((a, i) => i !== rootIdx && i !== rootIdx + 1) : argv;
  const jsonOut = cleanArgv.includes('--json');
  const apply = cleanArgv.includes('--apply');

  const targets = resolveTargets(cleanArgv, reposRoot);
  if (!targets) {
    console.error('Usage: node core/backfill-templates.mjs <slug> [--check|--apply] [--json] | --all [--check|--apply] [--json]');
    process.exit(1);
  }

  const results = targets.map(({ slug, dir }) => {
    if (!existsSync(dir)) return { slug, error: `no such workspace: ${slug}`, files: [] };
    const files = apply ? applyWorkspace(dir, reposRoot) : checkWorkspace(dir, reposRoot);
    return { slug, error: null, files };
  });

  const anyIssue = results.some((r) => r.error || r.files.some((f) => ((apply ? f.written : f.missing) || []).length > 0 || f.error));

  if (jsonOut) {
    console.log(JSON.stringify(results));
  } else {
    for (const r of results) {
      if (r.error) { console.log(`${r.slug}: ${r.error}`); continue; }
      const parts = r.files
        .filter((f) => ((apply ? f.written : f.missing) || []).length > 0)
        .map((f) => `${f.file} ${apply ? 'wrote' : 'missing'} ${(apply ? f.written : f.missing).map(formatPath).join(', ')}`);
      console.log(parts.length ? `${r.slug}: ${parts.join('; ')}` : `${r.slug}: up to date`);
    }
  }
  if (!apply && anyIssue) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ backfill-templates: ${err.message}`);
    process.exit(1);
  });
}
