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
import { parseDocument, isMap, isScalar, YAMLMap } from 'yaml';
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

function formatPath(path) {
  return path.join('.');
}

/**
 * A live parent that holds no value at all — `narrative:` with nothing under
 * it, an explicit `narrative: null`, or a document with empty contents. The
 * `yaml` package models the first two as a Scalar whose `.value` is null, so
 * an `isMap` check alone can't tell them apart from a real scalar value.
 * @param {unknown} node
 */
function isNullNode(node) {
  return node === null || node === undefined || (isScalar(node) && node.value === null);
}

/**
 * Write every missing key path from `checkFile` into the live file, taking
 * the whole `Pair` node from the template document so its attached comments
 * move along with it. No-op (no write at all) when nothing is missing.
 *
 * **Never throws.** Two live-file shapes need explicit handling because a
 * plain `setIn` throws on both ("Expected YAML collection at X"):
 *   - the live parent is null (`narrative:` / `narrative: null`) where the
 *     template has a map — a null value carries no user data, so it is
 *     promoted to an empty map and the child Pair inserted there. Still
 *     additive-only: nothing the user wrote is lost.
 *   - the live parent is a real scalar or a sequence (`narrative: 1`) where
 *     the template has a map — a genuine type conflict that silently
 *     overwriting would destroy. That one path is skipped, reported in
 *     `conflicts`, and summarised in `error` so a human can resolve it.
 * @returns {{ written: string[][], conflicts: string[][], error: string|null }}
 */
export function applyFile(liveFilePath, templateFilePath) {
  const { missing, error } = checkFile(liveFilePath, templateFilePath);
  if (error) return { written: [], conflicts: [], error };
  if (missing.length === 0) return { written: [], conflicts: [], error: null };
  const liveDoc = parseDocument(readFileSync(liveFilePath, 'utf8'));
  const templateDoc = parseDocument(readFileSync(templateFilePath, 'utf8'));

  /** @type {string[][]} */ const written = [];
  /** @type {string[][]} */ const conflicts = [];

  for (const path of missing) {
    const lastKey = path[path.length - 1];
    const parentPath = path.slice(0, -1);

    // Get the parent node from both documents (parentPath always exists in the
    // live doc — findMissingKeyPaths stops at the shallowest missing point).
    const liveParent = parentPath.length === 0 ? liveDoc.contents : liveDoc.getIn(parentPath, true);
    const templateParent = parentPath.length === 0 ? templateDoc.contents : templateDoc.getIn(parentPath, true);

    // The template Pair (not just its value) is what carries the attached
    // comments we want to move across. findMissingKeyPaths only descends
    // through template maps, so this lookup normally always succeeds.
    const templatePair = isMap(templateParent)
      ? templateParent.items.find((item) => /** @type {any} */ (item.key).value === lastKey)
      : undefined;
    if (!templatePair) {
      conflicts.push(path);
      continue;
    }

    if (isMap(liveParent)) {
      liveParent.items.push(templatePair);
      written.push(path);
      continue;
    }

    if (isNullNode(liveParent)) {
      const promoted = new YAMLMap();
      // A comment sitting before a block map's FIRST key attaches to the map
      // node, not to that key's Pair — pushing Pairs alone would drop it. A
      // null live parent means every template child under it is missing, so
      // the promoted map is a faithful copy of the template's block and that
      // comment belongs on it. Nested parents only: at the document root the
      // equivalent comment is the template file's whole header, which is not
      // ours to graft onto someone's live file.
      if (parentPath.length > 0 && isMap(templateParent)) {
        promoted.commentBefore = templateParent.commentBefore;
        promoted.comment = templateParent.comment;
      }
      promoted.items.push(templatePair);
      if (parentPath.length === 0) liveDoc.contents = promoted;
      else liveDoc.setIn(parentPath, promoted);
      written.push(path);
      continue;
    }

    // Live parent holds a real value (scalar/sequence) where the template has
    // a map: not safe to overwrite, not possible to nest into. Needs a human.
    conflicts.push(path);
  }

  if (written.length > 0) writeFileSync(liveFilePath, liveDoc.toString());
  return {
    written,
    conflicts,
    error: conflicts.length
      ? `cannot backfill (live value is not a map): ${conflicts.map(formatPath).join(', ')}`
      : null,
  };
}

export const JSON_TEMPLATE_PAIRS = [
  { live: '.claude/settings.json', template: '.claude/settings.json' },
];

/**
 * Identity key for a JSON array item, used to decide whether a template
 * item already exists in a live array. Hook-matcher objects (which carry a
 * `matcher` field) are identified by that field, since two hook entries for
 * the same matcher are the same registration even if their command differs
 * — this never overwrites an existing entry's command, only skips adding a
 * duplicate. Everything else (plain strings in permissions.allow, etc.) is
 * identified by exact value.
 * @param {any} item
 */
function jsonItemIdentity(item) {
  if (item && typeof item === 'object' && !Array.isArray(item) && 'matcher' in item) {
    return `matcher:${item.matcher}`;
  }
  return `value:${JSON.stringify(item)}`;
}

/**
 * Key paths (and, for arrays, groups of missing items) present in
 * templateValue but absent from liveValue. Mirrors findMissingKeyPaths's
 * "stop at the shallowest missing point" rule for objects. For arrays,
 * diffs item-by-item using jsonItemIdentity so a template array can gain
 * new entries without ever touching an existing live entry. Never reports
 * a path where live already holds a scalar value, even a different one —
 * additive-only, same as the YAML side.
 * @param {any} templateValue
 * @param {any} liveValue
 * @param {string[]} path
 * @returns {{path: string[], value: any, arrayAppend?: boolean}[]}
 */
export function findMissingJsonPaths(templateValue, liveValue, path = []) {
  const missing = [];
  if (Array.isArray(templateValue)) {
    if (!Array.isArray(liveValue)) {
      if (templateValue.length > 0) missing.push({ path, value: templateValue, arrayAppend: true });
      return missing;
    }
    const liveIdentities = new Set(liveValue.map(jsonItemIdentity));
    const newItems = templateValue.filter((item) => !liveIdentities.has(jsonItemIdentity(item)));
    if (newItems.length > 0) missing.push({ path, value: newItems, arrayAppend: true });
    return missing;
  }
  if (templateValue && typeof templateValue === 'object') {
    if (liveValue === undefined) {
      missing.push({ path, value: templateValue });
      return missing;
    }
    if (typeof liveValue !== 'object' || liveValue === null || Array.isArray(liveValue)) {
      return missing; // existing scalar/array where object expected — never overwrite
    }
    for (const key of Object.keys(templateValue)) {
      const childPath = [...path, key];
      if (!(key in liveValue)) {
        missing.push({ path: childPath, value: templateValue[key] });
      } else {
        missing.push(...findMissingJsonPaths(templateValue[key], liveValue[key], childPath));
      }
    }
    return missing;
  }
  return missing; // scalar template value: never overwrite an existing live value
}

/**
 * Compare one (live, template) JSON file pair. Never throws — a missing
 * file or a parse error is reported in the return value. Same return shape
 * as checkFile so callers can treat YAML and JSON pairs identically.
 * @returns {{ missing: string[][], error: string|null }}
 */
export function checkJsonFile(liveFilePath, templateFilePath) {
  if (!existsSync(liveFilePath) || !existsSync(templateFilePath)) {
    return { missing: [], error: null };
  }
  let liveValue, templateValue;
  try {
    liveValue = JSON.parse(readFileSync(liveFilePath, 'utf8'));
    templateValue = JSON.parse(readFileSync(templateFilePath, 'utf8'));
  } catch (err) {
    return { missing: [], error: /** @type {Error} */ (err).message };
  }
  const entries = findMissingJsonPaths(templateValue, liveValue);
  return { missing: entries.map((e) => e.path), error: null };
}

/**
 * Write every missing key/array-item from checkJsonFile into the live file.
 * No-op (no write at all) when nothing is missing. Same return shape as
 * applyFile, minus `conflicts` — a JSON type conflict (live scalar where
 * template wants an object) is silently skipped, same non-destructive rule,
 * without needing YAML's richer conflict reporting for this simpler shape.
 * @returns {{ written: string[][], error: string|null }}
 */
export function applyJsonFile(liveFilePath, templateFilePath) {
  if (!existsSync(liveFilePath) || !existsSync(templateFilePath)) {
    return { written: [], error: null };
  }
  let liveValue, templateValue;
  try {
    liveValue = JSON.parse(readFileSync(liveFilePath, 'utf8'));
    templateValue = JSON.parse(readFileSync(templateFilePath, 'utf8'));
  } catch (err) {
    return { written: [], error: /** @type {Error} */ (err).message };
  }
  const entries = findMissingJsonPaths(templateValue, liveValue);
  if (entries.length === 0) return { written: [], error: null };

  for (const { path, value, arrayAppend } of entries) {
    let target = liveValue;
    for (const key of path.slice(0, -1)) {
      if (typeof target[key] !== 'object' || target[key] === null || Array.isArray(target[key])) {
        target[key] = {};
      }
      target = target[key];
    }
    const lastKey = path[path.length - 1];
    if (arrayAppend) {
      if (!Array.isArray(target[lastKey])) target[lastKey] = [];
      target[lastKey].push(...value);
    } else {
      target[lastKey] = value;
    }
  }
  writeFileSync(liveFilePath, JSON.stringify(liveValue, null, 2) + '\n');
  return { written: entries.map((e) => e.path), error: null };
}

/** @returns {{ file: string, missing: string[][], error: string|null }[]} */
export function checkWorkspace(wsDir, reposRoot = ROOT) {
  const yamlResults = TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    ...checkFile(join(wsDir, live), join(reposRoot, template)),
  }));
  const jsonResults = JSON_TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    ...checkJsonFile(join(wsDir, live), join(reposRoot, template)),
  }));
  return [...yamlResults, ...jsonResults];
}

/** @returns {{ file: string, written: string[][], conflicts?: string[][], error: string|null }[]} */
export function applyWorkspace(wsDir, reposRoot = ROOT) {
  const yamlResults = TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    ...applyFile(join(wsDir, live), join(reposRoot, template)),
  }));
  const jsonResults = JSON_TEMPLATE_PAIRS.map(({ live, template }) => ({
    file: live,
    ...applyJsonFile(join(wsDir, live), join(reposRoot, template)),
  }));
  return [...yamlResults, ...jsonResults];
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
    // Per-target isolation: whatever one workspace hits (an unwritable file, a
    // surprise from the yaml package) becomes that workspace's own `error` and
    // never aborts the remaining targets of an --all run. This is the spec's
    // explicit error-isolation requirement.
    try {
      const files = apply ? applyWorkspace(dir, reposRoot) : checkWorkspace(dir, reposRoot);
      return { slug, error: null, files };
    } catch (err) {
      return { slug, error: /** @type {Error} */ (err).message, files: [] };
    }
  });

  // Exit code semantics: an error is always a failure. Missing fields are a
  // failure for --check (that is what --check is for) but NOT for --apply —
  // there, writing them is the success case.
  const anyError = results.some((r) => r.error || r.files.some((f) => f.error));
  const anyMissing = !apply && results.some((r) => r.files.some((f) => (f.missing || []).length > 0));

  if (jsonOut) {
    console.log(JSON.stringify(results));
  } else {
    for (const r of results) {
      if (r.error) { console.log(`${r.slug}: ${r.error}`); continue; }
      const parts = [];
      for (const f of r.files) {
        const paths = (apply ? f.written : f.missing) || [];
        if (paths.length > 0) parts.push(`${f.file} ${apply ? 'wrote' : 'missing'} ${paths.map(formatPath).join(', ')}`);
        // Without this a file-level error printed nothing at all, so the run
        // said "up to date" while still exiting 1.
        if (f.error) parts.push(`${f.file} ERROR: ${f.error}`);
      }
      console.log(parts.length ? `${r.slug}: ${parts.join('; ')}` : `${r.slug}: up to date`);
    }
  }
  if (anyError || anyMissing) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ backfill-templates: ${err.message}`);
    process.exit(1);
  });
}
