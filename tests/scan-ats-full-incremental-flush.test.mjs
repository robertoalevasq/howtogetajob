// tests/scan-ats-full-incremental-flush.test.mjs — a multi-source sweep must
// deliver an already-completed source's matches to pipeline.md even when a
// LATER source in the same run hits the resolver-outage breaker and the run
// never reaches the end.
//
// Found live 2026-09-11 (thomas-acosta): Greenhouse/Lever/Ashby completed and
// sat on 460+ real matches while Workday alone (12,884 companies) was still a
// third of the way through, and a /run cut off before Workday finished threw
// all of it away every time -- pipeline.md never saw a single one, because
// appendToPipeline() was only ever called once, at the very end of main().
//
// Driven end-to-end in a child process (same rationale as
// scan-ats-full-outage-checkpoint.test.mjs): the fix is the interaction
// between the per-source completion path, the outage breaker's early break,
// and the incremental flush -- only a whole run exercises the sequence. The
// child's global fetch is replaced before scan-ats-full.mjs loads: Greenhouse
// URLs get a real-shaped, always-succeeding fake response; Lever URLs throw a
// resolver-level error (code: EAI_AGAIN) so the run's own outage breaker trips
// exactly the way a real DNS failure would, with no real network involved.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, run, formatRunFailure, NODE, ROOT } from './helpers.mjs';

console.log('\nscan-ats-full — incremental pipeline flush across sources (BACKLOG: undelivered matches on a cut-off sweep)');

const GREENHOUSE_COMPANIES = 3;
// Comfortably above RESOLVER_FAILURE_LIMIT (50, see scan-ats-full.mjs) so the
// breaker trips with lever companies still unscanned.
const LEVER_COMPANIES = 60;
const CHECKPOINT_REL = join('data', 'cache', 'ats-full-checkpoint.json');
const PIPELINE_REL = join('data', 'pipeline.md');

/**
 * Build a sandbox cwd for a two-source (greenhouse, lever) sweep where
 * greenhouse always "succeeds" (fake job data) and lever always fails with a
 * resolver-level error.
 *
 * @returns {string} Sandbox directory.
 */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-flush-'));
  // "Director" so the fake greenhouse job titles below pass the title filter.
  writeFileSync(join(dir, 'portals.yml'), 'title_filter:\n  positive:\n    - director\n', 'utf-8');

  mkdirSync(join(dir, 'data', 'cache', 'ats-companies'), { recursive: true });
  writeFileSync(
    join(dir, 'data', 'cache', 'ats-companies', 'greenhouse.json'),
    JSON.stringify(Array.from({ length: GREENHOUSE_COMPANIES }, (_, i) => `flush-gh-${i}`)),
    'utf-8',
  );
  writeFileSync(
    join(dir, 'data', 'cache', 'ats-companies', 'lever.json'),
    JSON.stringify(Array.from({ length: LEVER_COMPANIES }, (_, i) => `flush-lv-${i}`)),
    'utf-8',
  );

  const scanUrl = pathToFileURL(join(ROOT, 'core', 'scan-ats-full.mjs')).href;
  // Fresh Response-like object per call -- a real fetch Response's body can
  // only be consumed once, and fetchWithTimeout always calls res.json()
  // (never res.text() on the success path), so only .ok/.json() need to work.
  writeFileSync(join(dir, 'launch.mjs'), `
const GREENHOUSE_COMPANIES = ${GREENHOUSE_COMPANIES};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const href = typeof url === 'string' ? url : url.toString();
  const ghMatch = href.match(/boards-api\\.greenhouse\\.io\\/v1\\/boards\\/(flush-gh-\\d+)\\/jobs/);
  if (ghMatch) {
    const slug = ghMatch[1];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jobs: [{
          id: slug,
          title: 'Director of Sandbox Testing',
          absolute_url: 'https://job-boards.greenhouse.io/' + slug + '/jobs/1',
          location: { name: 'Remote' },
          first_published: new Date().toISOString(),
        }],
      }),
      text: async () => '',
      headers: { get: () => null },
    };
  }
  if (href.includes('jobs.lever.co') || href.includes('api.lever.co')) {
    const err = new Error('getaddrinfo EAI_AGAIN jobs.lever.co');
    err.code = 'EAI_AGAIN';
    err.syscall = 'getaddrinfo';
    throw err;
  }
  return originalFetch(url, opts);
};
process.argv[1] = ${JSON.stringify(join(ROOT, 'core', 'scan-ats-full.mjs'))};
await import(${JSON.stringify(scanUrl)});
`, 'utf-8');
  return dir;
}

/**
 * Run one sandboxed sweep to completion.
 *
 * @param {string} dir - Sandbox directory.
 * @param {string[]} [extraArgs=[]] - Additional scanner flags.
 * @returns {string|null} Trimmed stdout, or null when the child failed.
 */
function sweep(dir, extraArgs = []) {
  return run(NODE, [join(dir, 'launch.mjs'), '--ats', 'greenhouse,lever', '--json', ...extraArgs], {
    cwd: dir,
    env: { ...process.env, CAREER_OPS_DNS_LOOKUPS_PER_MIN: '0' },
    timeout: 120_000,
  });
}

{
  const dir = makeSandbox();
  try {
    const out = sweep(dir);
    const pipelinePath = join(dir, PIPELINE_REL);
    const cpPath = join(dir, CHECKPOINT_REL);

    if (out === null) {
      fail(`sweep did not complete${formatRunFailure()}`);
    } else {
      const result = JSON.parse(out);
      if (result.stoppedByOutage !== true) {
        fail(`expected lever's resolver failures to trip the outage breaker, got stoppedByOutage=${result.stoppedByOutage}`);
      } else {
        pass('lever resolver failures tripped the outage breaker, stopping the sweep before it reached completion');
      }

      if (!existsSync(pipelinePath)) {
        fail('pipeline.md was never created -- greenhouse\'s completed offers never reached it');
      } else {
        const pipelineContent = readFileSync(pipelinePath, 'utf-8');
        const flushedCount = (pipelineContent.match(/job-boards\.greenhouse\.io\/flush-gh-\d+\/jobs\/1/g) || []).length;
        if (flushedCount === GREENHOUSE_COMPANIES) {
          pass(`all ${GREENHOUSE_COMPANIES} greenhouse offers reached pipeline.md even though the sweep was cut off by lever's outage (the bug this fixes)`);
        } else {
          fail(`expected ${GREENHOUSE_COMPANIES} greenhouse offers in pipeline.md, found ${flushedCount} -- incremental flush did not deliver a completed source's matches`);
        }
      }

      if (!existsSync(cpPath)) {
        fail('outage stop deleted its own checkpoint -- --resume has nothing to read');
      } else {
        const cp = JSON.parse(readFileSync(cpPath, 'utf-8'));
        if (typeof cp.mergedThroughIndex === 'number' && cp.mergedThroughIndex > 0) {
          pass(`checkpoint records mergedThroughIndex=${cp.mergedThroughIndex} (what's already been flushed)`);
        } else {
          fail(`checkpoint's mergedThroughIndex is ${cp.mergedThroughIndex} -- a --resume can't tell what was already flushed`);
        }

        // --- --resume must not re-flush (duplicate) what greenhouse already delivered ---
        const resumed = sweep(dir, ['--resume']);
        if (resumed === null) {
          fail(`--resume after the outage stop failed${formatRunFailure()}`);
        } else if (!existsSync(pipelinePath)) {
          fail('pipeline.md no longer exists after --resume');
        } else {
          const resumedContent = readFileSync(pipelinePath, 'utf-8');
          const resumedFlushedCount = (resumedContent.match(/job-boards\.greenhouse\.io\/flush-gh-\d+\/jobs\/1/g) || []).length;
          if (resumedFlushedCount === GREENHOUSE_COMPANIES) {
            pass(`--resume did not re-flush greenhouse's already-delivered offers (still exactly ${GREENHOUSE_COMPANIES} in pipeline.md, not duplicated)`);
          } else {
            fail(`expected still exactly ${GREENHOUSE_COMPANIES} greenhouse offers after --resume (no duplication), found ${resumedFlushedCount}`);
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
