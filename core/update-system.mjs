#!/usr/bin/env node

/**
 * update-system.mjs — Safe auto-updater for career-ops
 *
 * Updates ONLY system layer files (modes, scripts, dashboard, templates).
 * NEVER touches user data (cv.md, profile.yml, _profile.md, data/, reports/).
 *
 * Usage:
 *   node update-system.mjs check      # Check if update available
 *   node update-system.mjs apply      # Apply update (after user confirms)
 *   node update-system.mjs rollback   # Rollback last update
 *   node update-system.mjs dismiss    # Dismiss update check
 *
 * See DATA_CONTRACT.md for the full system/user layer definitions.
 */

import { execFileSync, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, rmSync, realpathSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Deliberately NOT `import { isMainModule } from './is-main.mjs'` — this file
// must stay self-loading with ZERO static relative imports (#1706): a
// pre-#1245 client's apply() self-reexec checks out ONLY update-system.mjs
// before re-executing it, so any static top-level relative import crashes
// that old→new jump with ERR_MODULE_NOT_FOUND (see the two "self-loading"
// tests in test-all.mjs). Same realpath fix as core/is-main.mjs
// (#workspace-multitenancy final-review Critical 2), inlined instead of
// imported for that reason.
function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

// NOTE: this file must stay *self-loading* — no static (top-level) relative
// imports. A pre-#1245 client's apply() self-reexec checks out ONLY
// update-system.mjs before re-execing the target updater, so a static top-level
// relative import here crashes that re-exec with ERR_MODULE_NOT_FOUND on the
// old→new jump, before the fuller checkout that would materialize the imported
// module ever runs (#1706). Local modules (e.g. the skill-entrypoints helper
// under scaffolder/) are instead pulled in lazily at their point of use, by
// which time the full update stage has already checked them out. The
// updater-migration and test-all suites enforce this invariant.

const __dirname = dirname(fileURLToPath(import.meta.url));
// This script now lives in core/, one directory below the repo root; ROOT is
// the actual repo root every SYSTEM_PATHS/USER_PATHS/BOOTSTRAP_PATHS entry
// (VERSION, dashboard/, .update-lock, modes/, core/, ...) is relative to
// (see #workspace-multitenancy Task 1).
const ROOT = dirname(__dirname);

// Matches a semver, with or without a leading `v` and an optional
// Release Please component prefix (e.g. `career-ops-v1.9.0` → `1.9.0`).
// Anchoring on `(?:^|-)` lets the releases-API fallback parse our tags,
// which Release Please always prefixes with the component name.
export const SEMVER_RE = /(?:^|-)v?(\d+\.\d+\.\d+)$/i;
// 120s: local git commands are normally instant, but a cloud-evicted working
// tree (iCloud "optimize storage", OneDrive dehydration) can stall a plain
// `git status` for a minute of pure I/O wait re-materializing files (#1393).
export const DEFAULT_GIT_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_GIT_TIMEOUT_MS, 120000);
export const DEFAULT_GIT_FETCH_TIMEOUT_MS = parsePositiveInt(
  process.env.CAREER_OPS_GIT_FETCH_TIMEOUT_MS,
  Math.max(DEFAULT_GIT_TIMEOUT_MS, 300000),
);
export const NPM_INSTALL_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_NPM_INSTALL_TIMEOUT_MS, 60000);
export const PLAYWRIGHT_INSTALL_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_PLAYWRIGHT_INSTALL_TIMEOUT_MS, 120000);
export const DASHBOARD_REBUILD_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_DASHBOARD_REBUILD_TIMEOUT_MS, 60000);
export const UPDATE_PATH_CHECKOUT_BUDGET_MS = parsePositiveInt(process.env.CAREER_OPS_UPDATE_PATH_CHECKOUT_BUDGET_MS, 5000);
export const REEXEC_BUFFER_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_REEXEC_BUFFER_TIMEOUT_MS, 60000);

// System layer paths — ONLY these files get updated
export const SYSTEM_PATHS = [
  // .gitattributes governs how every other path below is written to disk, and
  // `apply` checks paths out one at a time in this order: if it landed later,
  // everything before it would be written under the old core.autocrlf setting
  // on an existing install, silently (once text=auto is live, git status stays
  // clean and only a second update would repair it).
  '.gitattributes',
  // #workspace-multitenancy Task 1 moved every root-level *.mjs script into
  // core/ so the whole directory can be junctioned into a workspace as one
  // unit. This single directory entry ships the entire tree; the individual
  // bare-filename entries that used to point at those scripts were removed
  // (a stale entry would fail the #2002 stale-manifest-entry guard in
  // updater-migration-tests.mjs).
  'core/',
  'modes/README.md',
  'modes/_shared.md',
  'modes/_portals-pruning.md',
  'modes/_writing.md',
  'modes/_profile.template.md',
  'modes/_custom.template.md',
  'modes/_brief.template.md',
  'modes/oferta.md',
  'modes/pdf.md',
  'modes/pdf/',
  'modes/cover.md',
  'modes/email.md',
  'modes/add.md',
  'modes/expand.md',
  'modes/scan.md',
  'modes/discover.md',
  'modes/batch.md',
  'modes/apply.md',
  'modes/apply-batch.md',
  'modes/auto-pipeline.md',
  'modes/cycle.md',
  'modes/telegram.md',
  'modes/telegram-onboarding.md',
  'modes/contacto.md',
  'modes/deep.md',
  'modes/ofertas.md',
  'modes/pipeline.md',
  'modes/triage.md',
  'modes/project.md',
  'modes/tracker.md',
  'modes/training.md',
  'modes/interview.md',
  'modes/interview-redflag.md',
  'modes/latex.md',
  'modes/latex-tex.md',
  'modes/followup.md',
  'modes/offer-prep.md',
  'modes/interview-prep.md',
  'modes/interview/',
  'templates/interview-prep-sessions/.gitkeep',
  'templates/interview-prep-sessions/README.md',
  'modes/patterns.md',
  'modes/titles.md',
  'modes/upskill.md',
  'modes/update.md',
  'modes/agent-inbox.md',
  'modes/reply-watch.md',
  'modes/outcome.md',
  'modes/delegate/',
  'modes/ar/',
  'modes/da/',
  'modes/de/',
  'modes/de/interview/',
  'modes/fr/',
  'modes/fr/interview/',
  'modes/hi/',
  'modes/es/',
  'modes/es/interview/',
  'modes/id/',
  'modes/it/',
  'modes/it/interview/',
  'modes/ja/',
  'modes/ko/',
  'modes/nl/',
  'modes/pl/',
  'modes/pt/',
  'modes/pt/interview/',
  'modes/ru/',
  'modes/tr/',
  'modes/ua/',
  'modes/heuristics/',
  'modes/regional/',
  'modes/zh/',
  'modes/zh/interview/',
  'modes/zh-TW/',
  'AGENTS.md',
  'CLAUDE.md',
  'CODEX.md',
  'OPENCODE.md',
  'core/AGENTS.md',
  'GEMINI.md',
  'KIMI.md',
  'lib/cli-flags.mjs',
  'lib/latex-escape.mjs',
  'lib/latex-content.mjs',
  'lib/context-budget.mjs',
  'lib/context-budget.test.mjs',
  'lib/golden-budget-analysis.mjs',
  'tracker-aliases.json',
  'providers/',
  'seeds/',
  'tests/',
  // doctor.mjs imports this one: an install that receives the new doctor
  // without it would crash on startup.
  'evals/',
  'tests/outcome.test.mjs',
  'batch/batch-prompt.md',
  'batch/batch-runner.sh',
  'batch/aggregate-tokens.mjs',
  'batch/README.md',
  'utils/token-tracker.mjs',
  'dashboard/',
  'templates/',
  'config/cv-facts.example.json',
  'fonts/',
  'examples/',
  'config/profile.example.yml',
  'config/llm-provider.example.yml',
  '.env.example',
  '.editorconfig',
  '.agents/',
  '.claude/skills/',
  '.cursor/skills/',
  '.opencode/skills/',
  '.opencode/commands/',
  '.claude-plugin/',
  '.qwen/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  '.kimi/skills/',
  'docs/',
  'templates/writing-samples/README.md',
  'VERSION',
  'DATA_CONTRACT.md',
  'ARCHITECTURE.md',
  'README.md',
  'README.ar.md',
  'README.cn.md',
  'README.da.md',
  'README.de.md',
  'README.es.md',
  'README.fr.md',
  'README.hi.md',
  'README.ja.md',
  'README.ko-KR.md',
  'README.pl.md',
  'README.pt-BR.md',
  'README.ru.md',
  'README.ta.md',
  'README.ua.md',
  'README.zh-TW.md',
  'README.tr.md',
  'CHANGELOG.md',
  'LEGAL_DISCLAIMER.md',
  'LICENSE',
  '.editorconfig',
  '.github/',
  'package.json',
  '.mcp.json',
  'archive/.gitkeep',
  'test/cv-templates.test.mjs',
  'test/cover-resolver.test.mjs',
  'test/pipeline-lock.test.mjs',
  'test/profile-photo.test.mjs',
  'templates/cv-template.zh-minimal.html',
  'test/zh-minimal-template.test.mjs',
  'test/cv-visual/',
  'scaffolder/',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'cops',
  'DOCKER.md',
  'plugins/',
  'plugins-registry/',
  'templates/plugins.example.yml',
  'opencode.example.json',
  'test-fixtures/',
  'telegram-daemon-wrapper.bat',
  'telegram-setup-scheduler.bat',
  'telegram-daemon-scheduler.bat',
  'scripts/parsers/jobspy-scan.py',
];

const BOOTSTRAP_PATHS = [
  '.agents/',
  '.cursor/skills/',
  '.opencode/skills/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  '.kimi/skills/',
  'providers/',
  'core/liveness-browser.mjs',
  'core/tracker-links.mjs',
  'core/role-matcher.mjs',
  'core/tracker-utils.mjs',
  'core/tracker-parse.mjs',
  'tracker-aliases.json',
  'scaffolder/',
  'core/reserve-report-num.mjs',
  'core/updater-migration-tests.mjs',
  'core/validate-portals.mjs',
  'core/tracker-columns-tests.mjs',
  'plugins/',
  'core/plugins.mjs',
  'plugins-registry/',
  'core/plugin-install.mjs',
  'core/plugin-audit.mjs',
  'core/validate-plugin-registry.mjs',
  'templates/plugins.example.yml',
  'core/agent-inbox.mjs',
  'core/agent-inbox-tests.mjs',
];

// User layer paths — NEVER touch these (safety check)
const USER_PATHS = [
  'cv.md',
  'config/profile.yml',
  'config/llm-provider.yml',
  '_profile.md',
  '_custom.md',
  '_brief.md',
  'voice-dna.md',
  'portals.yml',
  'article-digest.md',
  'interview-prep/',
  'data/',
  'reports/',
  'output/',
  'jds/',
  'writing-samples/',
  'config/plugins.yml',
  'plugins.local/',
  'plugins.lock',
  'opencode.json',
  '.claude/settings.json',
  '.claude/hooks/',
  // Per-user workspace directories (multi-tenancy). Prefix match covers every
  // tracked scaffold file under any workspace (.gitkeep placeholders, seeded
  // real files like voice-dna.md/writing-samples/README.md) without needing
  // per-slug or per-file enumeration as new workspaces get provisioned.
  'workspaces/',
];

function parseVersionFile(raw) {
  // VERSION may carry a release-please marker, e.g. "1.6.0 # x-release-please-version".
  // Take the first whitespace-delimited token so the marker doesn't break semver parsing.
  return raw.trim().split(/\s+/)[0] || '';
}

function localVersion() {
  const vPath = join(ROOT, 'VERSION');
  return existsSync(vPath) ? parseVersionFile(readFileSync(vPath, 'utf-8')) : '0.0.0';
}

function updateBackupBranchName(version, date = new Date()) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `backup-pre-update-${version}-${stamp}`;
}

function backupTimestamp(branchName) {
  const match = branchName.match(/-(\d{8}T\d{6}Z)$/);
  if (!match) return 0;
  const [date, time] = match[1].split('T');
  return Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`,
  ) || 0;
}

function newestBackupBranch(branches) {
  const branchList = branches.split('\n').map(b => b.trim()).filter(Boolean);
  if (branchList.length === 0) return null;

  // Prefer timestamped backup branches created by current versions. Older
  // backups are still accepted below for rollback compatibility.
  const timestamped = branchList
    .map(branch => ({ branch, timestamp: backupTimestamp(branch) }))
    .filter(entry => entry.timestamp > 0)
    .sort((a, b) => b.timestamp - a.timestamp);

  return timestamped[0]?.branch || branchList[0];
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function gitTimeoutMs(args) {
  return args[0] === 'fetch' ? DEFAULT_GIT_FETCH_TIMEOUT_MS : DEFAULT_GIT_TIMEOUT_MS;
}

export function reexecTimeoutMs(updatePathCount = SYSTEM_PATHS.length + BOOTSTRAP_PATHS.length) {
  return Math.max(
    120000,
    DEFAULT_GIT_FETCH_TIMEOUT_MS +
      DEFAULT_GIT_TIMEOUT_MS * 3 +
      UPDATE_PATH_CHECKOUT_BUDGET_MS * Math.max(0, updatePathCount) +
      NPM_INSTALL_TIMEOUT_MS +
      PLAYWRIGHT_INSTALL_TIMEOUT_MS +
      DASHBOARD_REBUILD_TIMEOUT_MS +
      REEXEC_BUFFER_TIMEOUT_MS,
  );
}

function describeGitCommand(args) {
  return `git ${args.join(' ')}`;
}

function isTimeoutLikeError(err) {
  return err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM';
}

function timeoutSeconds(timeout) {
  return Math.round(timeout / 1000);
}

function gitTimeoutEnvVar(args) {
  return args[0] === 'fetch' ? 'CAREER_OPS_GIT_FETCH_TIMEOUT_MS' : 'CAREER_OPS_GIT_TIMEOUT_MS';
}

export function gitIn(root, ...args) {
  const timeout = gitTimeoutMs(args);
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8', timeout }).trim();
  } catch (err) {
    if (isTimeoutLikeError(err)) {
      throw new Error(`${describeGitCommand(args)} timed out after ${timeoutSeconds(timeout)}s. If your network is slow, retry or set ${gitTimeoutEnvVar(args)} to a larger value.`);
    }
    throw err;
  }
}

function git(...args) {
  return gitIn(ROOT, ...args);
}

/**
 * git(), but with the child's stderr piped instead of inherited.
 *
 * execFileSync inherits stderr by default, so a command whose failure is
 * expected and handled still prints git's raw error to the console. Use this
 * where a non-zero exit is a normal outcome the caller reports itself.
 *
 * @param {...string} args - git arguments.
 * @returns {string} Trimmed stdout.
 */
function gitQuiet(...args) {
  const timeout = gitTimeoutMs(args);
  try {
    return execFileSync('git', args, {
      cwd: ROOT, encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (isTimeoutLikeError(err)) {
      throw new Error(`${describeGitCommand(args)} timed out after ${timeoutSeconds(timeout)}s. If your network is slow, retry or set ${gitTimeoutEnvVar(args)} to a larger value.`);
    }
    throw err;
  }
}

function gitStatusEntries() {
  const status = git('status', '--porcelain');
  if (!status) return [];

  return status.split('\n')
    .filter(Boolean)
    .map(line => ({
      code: line.slice(0, 2),
      path: line.slice(3),
    }));
}

export function extractArrayFromSource(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) return [];
  return Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g), (entry) => entry[1]);
}

// Files the self-reexec stage must check out so the TARGET update-system.mjs
// loads without a missing-module crash. This is the entry plus its only known
// local import — a defensive fallback list, kept and covered by a dedicated
// test (updater-migration-tests.mjs) even though apply()'s self-reexec that
// once consumed it was gutted by de-brand-personal-fork Task 1.
const REEXEC_FALLBACK_FILES = ['core/update-system.mjs', 'scaffolder/bin/skill-entrypoints.mjs'];

// Extracts static relative import/export specifiers ('./x.mjs', '../y.mjs')
// from ESM source. Bare ('node:fs') and package ('js-yaml') specifiers are
// ignored — only on-disk relative modules need to exist before re-exec.
export function relativeImportSpecifiers(source) {
  const specs = new Set();
  const fromRe = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = fromRe.exec(source))) specs.add(match[1]);
  while ((match = bareRe.exec(source))) specs.add(match[1]);
  return [...specs].filter((spec) => spec.startsWith('.'));
}

function repoPath(root, path) {
  return join(root, ...path.split('/'));
}

export function prepareMaterializedSkillEntrypointsForStage(paths, root = ROOT) {
  const prepared = [];
  for (const path of paths) {
    const entry = gitIn(root, 'ls-files', '-s', '--', path);
    if (!entry) continue;

    const mode = entry.split(/\s+/, 1)[0];
    if (mode === '120000') {
      gitIn(root, 'rm', '--cached', '-f', '--', path);
    }
    prepared.push(path);
  }
  return prepared;
}

export function revertPaths(paths, protectedPaths = new Set(), ctx = {}) {
  const runGit = ctx.git || git;
  const root = ctx.root || ROOT;
  if (paths.length === 0) return;
  // Must restore from HEAD, not from the index (#915 bug 1). After
  // `git checkout FETCH_HEAD -- <path>` the index already holds the new
  // content, so `git checkout -- <path>` (index→worktree) is a no-op.
  // `git checkout HEAD -- <path>` resets both the index and the worktree
  // to the pre-update commit, which is the correct rollback target.
  for (const p of paths) {
    try {
      runGit('checkout', 'HEAD', '--', p);
    } catch (err) {
      const pathspec = p.endsWith('/') ? p.slice(0, -1) : p;
      // Only remove if the path genuinely doesn't exist in HEAD.
      // Other errors (permissions, corrupt refs) should re-throw.
      let existsInHead = true;
      try { runGit('cat-file', '-e', `HEAD:${pathspec}`); } catch { existsInHead = false; }
      if (existsInHead) throw err;
      // Path was newly introduced by the update — remove it so the
      // working tree is consistent with HEAD.
      try { runGit('rm', '-r', '-f', '--ignore-unmatch', '--', pathspec); } catch { /* ignore */ }
      try { rmSync(join(root, pathspec), { recursive: true, force: true }); } catch { /* already gone */ }
    }
    // A directory pathspec that exists in HEAD checks out cleanly above, so the
    // catch never runs — but `git checkout HEAD -- docs/` only restores files
    // HEAD already knows about. Files the update introduced *under* that
    // directory are not in HEAD, so they survive the rollback as staged
    // additions and the tree is left dirtier than before the update (#2015).
    removeAdditionsNotInHead(p, protectedPaths, ctx);
  }
}

/**
 * Delete files staged as additions relative to HEAD under a pathspec.
 *
 * Complements `git checkout HEAD -- <path>`, which restores tracked content but
 * never removes paths HEAD does not contain. Only additions are considered, so
 * a user file that merely changed is untouched.
 *
 * @param {string} pathspec - SYSTEM_PATHS entry (file or directory).
 * @param {Set<string>} protectedPaths - Paths already dirty/staged BEFORE the
 *   update ran; never deleted, so a rollback cannot destroy the user's own
 *   pre-existing staged work under a system pathspec (#2015).
 * @param {{git?: typeof git, root?: string}} [ctx] - Testability seam: the git
 *   runner (defaults to the module `git`, bound to ROOT) and the working-tree
 *   root used for filesystem deletes. Production always uses the defaults; only
 *   the behavioral rollback test overrides them to drive a throwaway repo.
 */
export function removeAdditionsNotInHead(pathspec, protectedPaths = new Set(), ctx = {}) {
  const runGit = ctx.git || git;
  const root = ctx.root || ROOT;
  const spec = pathspec.endsWith('/') ? pathspec.slice(0, -1) : pathspec;
  let added = '';
  try {
    // -z: NUL-delimited, unquoted output, so paths containing spaces or even
    // newlines survive intact — `split('\n').trim()` would mangle them.
    added = runGit('diff', '--cached', '-z', '--name-only', '--diff-filter=A', 'HEAD', '--', spec);
  } catch {
    // No HEAD yet, or an unreadable pathspec — nothing safe to clean up.
    return;
  }
  for (const file of added.split('\0').filter(Boolean)) {
    // Never touch something the user already had staged before the update —
    // only additions THIS update introduced (#2015 review: no data loss).
    if (protectedPaths.has(file)) continue;
    let removed = false;
    try {
      runGit('rm', '-f', '--ignore-unmatch', '--', file);
      removed = true;
    } catch {
      // Index removal failed (lock/permission). Leave both the index entry AND
      // the worktree file in place and keep rolling back the rest — deleting
      // the worktree copy now would strand a staged addition with no file.
      console.error(`Rollback: could not unstage ${file}; leaving it untouched.`);
    }
    if (removed) {
      try { rmSync(join(root, file), { force: true }); } catch { /* already gone */ }
    }
  }
}

function addPaths(paths) {
  if (paths.length === 0) return;
  git('add', '--', ...paths);
}

function dashboardGoSourcesChanged() {
  try {
    const changed = git('diff', '--name-only', 'HEAD', '--', 'dashboard');
    return changed
      .split('\n')
      .some(path => path.startsWith('dashboard/') && path.endsWith('.go'));
  } catch {
    return false;
  }
}

function rebuildDashboardBinaryIfNeeded() {
  if (!dashboardGoSourcesChanged()) return;

  try {
    execFileSync('go', ['build', '-o', 'career-dashboard', '.'], {
      cwd: join(ROOT, 'dashboard'),
      timeout: DASHBOARD_REBUILD_TIMEOUT_MS,
      stdio: 'pipe',
    });
    console.log('dashboard binary rebuilt');
  } catch {
    console.log('dashboard binary rebuild skipped -- run: cd dashboard && go build -o career-dashboard . manually');
  }
}

// ── CHECK ───────────────────────────────────────────────────────

async function check() {
  // Respect dismiss flag
  if (existsSync(join(ROOT, '.update-dismissed'))) {
    console.log(JSON.stringify({ status: 'dismissed' }));
    return;
  }

  // This instance has no upstream repo configured to update from — see
  // de-brand-personal-fork plan. check()/apply() both short-circuit here
  // rather than fetching from a repo this checkout has no relationship to.
  console.log(JSON.stringify({ status: 'disabled', reason: 'auto-update is disabled for this instance (no upstream repo configured)' }));
  return;
}

// ── APPLY ───────────────────────────────────────────────────────

async function apply() {
  throw new Error('Auto-update is disabled for this instance (no upstream repo configured). See core/AGENTS.md for how this fork relates to the original project.');
}

// ── ROLLBACK ────────────────────────────────────────────────────

function rollback() {
  // Find most recent backup branch
  try {
    const branches = git('for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/backup-pre-update-*');
    const latest = newestBackupBranch(branches);

    if (!latest) {
      console.error('No backup branches found. Nothing to rollback.');
      process.exit(1);
    }

    console.log(`Rolling back to: ${latest}`);

    // Checkout system files from backup branch.
    //
    // Two failure modes for `git checkout` here:
    //   (a) the path didn't exist in the backup branch — the apply()
    //       that produced this backup was on an older version that
    //       didn't track this path yet. Rollback must DELETE the path
    //       so the working tree mirrors the backup state.
    //   (b) anything else — propagate so we don't silently leave the
    //       working tree in a partially-restored state.
    //
    // Limitation: `git checkout <ref> -- <dir>` restores blobs from
    // the backup tree but doesn't remove files that were added INSIDE
    // an already-tracked directory between backup and rollback. Rolling
    // back per-file via `git diff --name-status <backup>` would catch
    // that but is a larger change; tracked separately if it ever bites.
    const restored = [];
    const removed = [];
    for (const path of SYSTEM_PATHS) {
      try {
        git('checkout', latest, '--', path);
        restored.push(path);
      } catch (err) {
        const pathspec = path.endsWith('/') ? path.slice(0, -1) : path;
        let existedInBackup = true;
        try {
          git('cat-file', '-e', `${latest}:${pathspec}`);
        } catch {
          existedInBackup = false;
        }
        if (existedInBackup) {
          throw err;
        }
        // Path was introduced by a later apply() — remove it so the
        // tree truly matches the backup. `git rm` stages the deletion
        // for tracked files; `rmSync` cleans up the untracked-but-
        // on-disk case (e.g. an apply() that crashed between checkout
        // and commit, leaving the path untracked locally).
        git('rm', '-r', '-f', '--ignore-unmatch', '--', pathspec);
        try {
          rmSync(join(ROOT, pathspec), { recursive: true, force: true });
        } catch {
          // Already gone, or not present on disk — fine.
        }
        removed.push(pathspec);
      }
    }

    if (restored.length > 0) addPaths(restored);
    const rollbackPaths = [...restored, ...removed];
    try {
      // Scope the commit to the rollback paths (#915 bug 2). A bare
      // `git commit` would sweep unrelated staged files into the rollback.
      if (rollbackPaths.length > 0) {
        git('commit', '-m', `chore: rollback system files from ${latest}`, '--', ...rollbackPaths);
      }
    } catch {
      // Tolerate any commit failure here — the common case is the
      // "nothing to commit" no-op when the working tree already
      // matched the backup (e.g. user ran rollback twice). This
      // mirrors apply()'s broad-catch in the commit step; narrowing
      // to a specific git-error string is fragile and would diverge
      // from that pattern. Genuine setup problems (hooks, signing,
      // disk full) will resurface on the next normal git operation.
    }

    console.log(`Rollback complete. Restored ${restored.length} path(s) from ${latest}, removed ${removed.length} path(s) added after the backup.`);
    console.log('Your data (CV, profile, tracker, reports) was not affected.');
  } catch (err) {
    console.error('Rollback failed:', err.message);
    process.exit(1);
  }
}

// ── DISMISS ─────────────────────────────────────────────────────

function dismiss() {
  writeFileSync(join(ROOT, '.update-dismissed'), new Date().toISOString());
  console.log('Update check dismissed. Run "node update-system.mjs check" or say "check for updates" to re-enable.');
}

// ── MAIN ────────────────────────────────────────────────────────

// Only run the CLI when executed directly, so importing this module
// (e.g. from test-all.mjs to exercise SEMVER_RE) does not trigger a
// live update check.
if (isMainModule(import.meta.url)) {
  const cmd = process.argv[2] || 'check';

  try {
    switch (cmd) {
      case 'check': await check(); break;
      case 'apply': await apply(); break;
      case 'rollback': rollback(); break;
      case 'dismiss': dismiss(); break;
      default:
        console.log('Usage: node update-system.mjs [check|apply|rollback|dismiss]');
        process.exit(1);
    }
  } catch (err) {
    // Subcommands now `throw` on aborts so their outer `finally` blocks
    // run (e.g. apply() must release `.update-lock`). Print a clean
    // message here instead of letting Node spit out a stack trace.
    console.error(err.message || err);
    process.exit(1);
  }
}
