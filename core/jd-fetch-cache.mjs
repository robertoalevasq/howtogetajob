// @ts-check
/**
 * jd-fetch-cache.mjs — short-TTL cache of full page text captured while
 * already visiting a URL for another reason (liveness check, scan's Level 1
 * Playwright fallback), so a later step that needs the same page's JD text
 * doesn't have to open a second Playwright tab to the same URL.
 *
 * Confirmed by direct read of liveness-browser.mjs: the liveness checker's
 * Playwright rung already captures the FULL visible page text
 * (`document.body.innerText`, not a truncated liveness-only snippet) for
 * every URL it visits. modes/pipeline.md's JD-extraction step then opened a
 * second Playwright tab to the same URL moments later, purely to re-fetch
 * content already sitting in memory during the same run. This cache removes
 * that duplicate fetch for every URL that survives the liveness sweep.
 *
 * Quality-neutral by construction: a cache hit is the same real fetch, not a
 * summary or a guess — evaluations built from it are grounded exactly the
 * way AGENTS.md's source-of-truth rules already require. The TTL exists so a
 * hit can never be older than a posting could plausibly have changed within.
 *
 * set() is purely additive/best-effort and never throws — a cache-write
 * failure must never break the liveness check or scan step that's calling it
 * for its own primary purpose.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { acquireTrackerLock, writeFileAtomic } from './tracker-utils.mjs';

// This script now lives in core/, one directory below the repo root; ROOT is
// the actual repo root that data/ lives under (see
// #workspace-multitenancy Task 1).
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Resolved lazily (function, not a frozen top-level const) rather than once
// at import time: this module is a transitive dependency of
// liveness-browser.mjs, which test-all.mjs imports directly in its own
// inline tests — if the path were baked in at first import, whichever test
// file happens to trigger that first import would permanently fix the path
// for the rest of the process (ES modules are cached process-wide), and a
// later test file's env-var override would silently never take effect.
// Reading process.env fresh on every call sidesteps that ordering entirely.
export function cachePath() {
  return process.env.CAREER_OPS_JD_FETCH_CACHE
    || join(ROOT, 'data', 'cache', 'jd-fetch-cache.json');
}
export function lockDir() {
  return `${cachePath()}.lock`;
}
export function logPath() {
  return process.env.CAREER_OPS_JD_FETCH_CACHE_LOG
    || join(ROOT, 'data', 'jd-fetch-cache.log');
}

// 2 hours: long enough to cover a single cycle run's liveness-sweep-to-
// evaluation gap, short enough that a posting can't have materially changed.
function ttlMs() {
  return process.env.CAREER_OPS_JD_FETCH_CACHE_TTL_MS
    ? Number(process.env.CAREER_OPS_JD_FETCH_CACHE_TTL_MS)
    : 2 * 60 * 60 * 1000;
}

function lockTimeoutMs() {
  return process.env.CAREER_OPS_JD_FETCH_CACHE_LOCK_TIMEOUT_MS
    ? Number(process.env.CAREER_OPS_JD_FETCH_CACHE_LOCK_TIMEOUT_MS)
    : 5_000;
}

function logLine(line) {
  try {
    const path = logPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()}\t${line}\n`);
  } catch {
    // Best-effort logging — never let it throw further.
  }
}

/**
 * Normalize a URL to a stable cache key: strips the fragment (never sent to
 * the server, never affects content) and a single trailing slash, so
 * `https://x.com/job/1` and `https://x.com/job/1/` and
 * `https://x.com/job/1#apply` all hit the same entry.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

function loadAll() {
  const path = cachePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist a page's captured text for later reuse. Never throws — a failure
 * here (lock contention, disk issue) is logged and swallowed, since this is
 * always a secondary side-effect of a call whose primary purpose (liveness
 * classification, scan discovery) must not be affected by it.
 *
 * @param {string} url
 * @param {{ bodyText: string, source: 'liveness'|'scan', structured?: object }} entry
 * @returns {Promise<boolean>} Whether the write succeeded.
 */
export async function setCachedJd(url, entry) {
  if (!url || !entry || typeof entry.bodyText !== 'string' || !entry.bodyText.trim()) return false;
  const path = cachePath();
  try {
    const lock = await acquireTrackerLock(lockDir(), { timeoutMs: lockTimeoutMs() });
    try {
      const all = loadAll();
      const cached = {
        bodyText: entry.bodyText,
        source: entry.source || 'unknown',
        fetchedAt: new Date().toISOString(),
      };
      // Include optional structured field if provided (from jd-field-extract.mjs)
      if (entry.structured && typeof entry.structured === 'object') {
        cached.structured = entry.structured;
      }
      all[normalizeUrl(url)] = cached;
      mkdirSync(dirname(path), { recursive: true });
      writeFileAtomic(path, JSON.stringify(all, null, 2));
      return true;
    } finally {
      lock.release();
    }
  } catch (err) {
    logLine(`set(${url}) failed (swallowed): ${err.message}`);
    return false;
  }
}

/**
 * Read a cached entry if present and still within TTL.
 *
 * @param {string} url
 * @returns {{ bodyText: string, source: string, fetchedAt: string } | null}
 */
export function getCachedJd(url) {
  const all = loadAll();
  const hit = all[normalizeUrl(url)];
  if (!hit) return null;
  const ageMs = Date.now() - new Date(hit.fetchedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > ttlMs()) return null;
  return hit;
}

/**
 * CLI: `node jd-fetch-cache.mjs get <url>` — prints the cached entry as JSON
 * and exits 0 on a hit, or exits 1 with nothing on stdout on a miss/stale
 * entry. Kept deliberately simple (one verb, one arg) so a mode file can
 * check a cache hit without constructing an inline `node -e` one-liner.
 */
async function main() {
  const [, , cmd, url] = process.argv;
  if (cmd === 'get' && url) {
    const hit = getCachedJd(url);
    if (hit) {
      console.log(JSON.stringify(hit));
      process.exit(0);
    }
    process.exit(1);
  }
  console.error('Usage: node jd-fetch-cache.mjs get <url>');
  process.exit(1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}
