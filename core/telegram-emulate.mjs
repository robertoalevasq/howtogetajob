// @ts-check
// telegram-emulate.mjs — v1 harness that runs REAL claude -p dispatches
// against synthetic Telegram input, in a disposable workspace, to catch the
// three routing bugs confirmed live 2026-09-11 through 2026-09-13 without
// needing a real candidate to hit them again. See
// docs/superpowers/specs/2026-09-14-telegram-routing-fixes-and-emulation-harness-design.md.
//
// Every scenario runs in a fresh os.tmpdir() directory -- no workspace under
// workspaces/ is ever touched. telegram.enabled stays false in every
// disposable workspace: the harness never needs a real bot token and never
// risks a real send; assertions read state files and session transcripts,
// never delivery confirmations.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { provisionWorkspace } from './provision-workspace.mjs';
import { findHubTranscriptFiles } from './admin-overview-snapshot.mjs';
import { dispatchOne, spawnCapturingTail, resolveClaudeCommand, createRoutingQueue } from './telegram-monitor.mjs';
import { isMainModule } from './is-main.mjs';

const MINIMAL_CV = `# Test Candidate

**Email:** test-candidate@example.com

## Experience

### Example Corp -- Remote

**Test Role**
January 2024 - Present

- Did representative work for harness-testing purposes only.

## Education

### Example University

**Bachelor of Science**
`;

/**
 * Creates a disposable, fully-junctioned test workspace (real core/modes
 * reachable exactly like a real workspace, telegram disabled, a minimal
 * portals.yml with zero tracked companies so Pass A stays fast) inside a
 * fresh temp directory. Nothing under the real repo's workspaces/ is ever
 * touched.
 *
 * @returns {{ wsDir: string, tempRoot: string, cleanup: () => void }}
 */
export function makeDisposableWorkspace() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'career-ops-emulate-'));
  const wsDir = provisionWorkspace('test-candidate', { reposRoot: tempRoot });

  writeFileSync(join(wsDir, 'cv.md'), MINIMAL_CV, 'utf-8');

  // provisionWorkspace seeds portals.yml from templates/portals.example.yml,
  // which ships ~100 demo tracked_companies -- fine for a real candidate,
  // needlessly slow for a harness scenario that only needs Step 0/early
  // Step 1 to be reachable quickly. Overwrite with the minimum valid shape
  // validate-portals.mjs accepts (no required top-level fields beyond
  // per-company checks, which only run against enabled companies).
  const portalsPath = join(wsDir, 'portals.yml');
  writeFileSync(portalsPath, yaml.dump({
    title_filter: { positive: ['Coordinator'], negative: [] },
    location_filter: [],
    tracked_companies: [],
    search_queries: [],
    industry_companies: [],
  }), 'utf-8');

  return {
    wsDir,
    tempRoot,
    // maxRetries/retryDelay (native fs.rmSync options, not a custom retry
    // loop): a scenario that kills its real claude -p process on timeout
    // (see runCycleDelegationScenario) can race Windows into still holding a
    // file lock under tempRoot after proc.kill() returns, while that
    // process's own spawned Bash-tool children finish tearing down --
    // confirmed live 2026-09-13 as an EPERM from this exact call. A plain
    // one-shot rmSync has no tolerance for that; this gives it a real (if
    // still bounded) grace period -- fs.rmSync's linear backoff means
    // maxRetries=10/retryDelay=300 sums to ~16.5s of total retry budget, not
    // 10*300ms. Even this can be exhausted by a slow-enough teardown, which
    // is why runCycleDelegationScenario also treats a residual cleanup()
    // failure as non-fatal rather than relying on this alone.
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }),
  };
}

const TELEGRAM_STATE_TEMPLATE = (pendingBlock) => `# Telegram State

## Pending Confirmations

${pendingBlock}

## Batch Queue

(none)

## Recent Actions

`;

/**
 * Writes data/telegram-state.md with the given raw pending-confirmation
 * block text (same `[msg_id: N] stage: ...` shape production code writes)
 * between the standard headers. `blocksText` is inserted verbatim -- callers
 * separate multiple blocks with a blank line, matching the real file format
 * `resolveDisambiguationHint()`/`resolveReportForDispatch()` already parse.
 *
 * @param {string} wsDir
 * @param {string} blocksText
 */
export function seedPendingConfirmations(wsDir, blocksText) {
  writeFileSync(join(wsDir, 'data', 'telegram-state.md'), TELEGRAM_STATE_TEMPLATE(blocksText), 'utf-8');
}

/**
 * Finds the newest .jsonl session transcript belonging to the given
 * disposable workspace slug, created at or after `sinceMs`. Reuses
 * findHubTranscriptFiles() (admin-overview-snapshot.mjs) rather than a
 * second implementation of Claude Code's project-directory naming.
 *
 * @param {string} tempRoot - the disposable workspace's temp root (NOT the wsDir itself -- same value passed as reposRoot to provisionWorkspace()).
 * @param {string} slug - the workspace slug used with provisionWorkspace() (e.g. 'test-candidate').
 * @param {number} sinceMs - epoch ms; only transcripts modified at/after this instant are considered.
 * @param {{ claudeHome?: string }} [opts] - claudeHome override for tests; defaults to ~/.claude.
 * @returns {string | null}
 */
export function findLatestTranscript(tempRoot, slug, sinceMs, opts = {}) {
  const all = findHubTranscriptFiles(tempRoot, opts.claudeHome);
  const matching = all
    .filter(f => f.scope === 'workspace' && f.slug === slug)
    .map(f => ({ path: f.path, mtimeMs: statSync(f.path).mtimeMs }))
    .filter(f => f.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matching.length > 0 ? matching[0].path : null;
}

/**
 * Every tool_use name found anywhere in a session transcript, in order of
 * appearance. Reads line-by-line JSONL, same shape used throughout this
 * codebase's own transcript-mining code (see admin-overview-snapshot.mjs).
 *
 * @param {string} transcriptPath
 * @returns {string[]}
 */
export function readTranscriptToolUses(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
  const names = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c.type === 'tool_use' && typeof c.name === 'string') names.push(c.name);
    }
  }
  return names;
}

/**
 * Throws if the transcript ever calls the Agent or Task tool -- the
 * mechanical check for the 2026-09-13 /run delegation bug (see cycle.md's
 * top-of-file warning, Task 1 of this plan).
 *
 * @param {string} transcriptPath
 */
export function assertNoAgentToolUse(transcriptPath) {
  const names = readTranscriptToolUses(transcriptPath);
  const offenders = names.filter(n => n === 'Agent' || n === 'Task');
  if (offenders.length > 0) {
    throw new Error(`Expected no Agent/Task tool_use in ${transcriptPath}, found ${offenders.length}: ${offenders.join(', ')}`);
  }
}

/**
 * Returns the raw `[msg_id: N] stage: ... ...` block text for one pending
 * confirmation from a workspace's current data/telegram-state.md, or null
 * if that msg_id isn't currently pending. Used to assert a specific item
 * was resolved (block disappears) while a sibling item was untouched (block
 * survives unchanged).
 *
 * @param {string} wsDir
 * @param {string} msgId
 * @returns {string | null}
 */
export function readPendingConfirmationBlock(wsDir, msgId) {
  if (!/^\d+$/.test(String(msgId))) return null;
  const statePath = join(wsDir, 'data', 'telegram-state.md');
  if (!existsSync(statePath)) return null;
  const content = readFileSync(statePath, 'utf-8');
  const afterHeader = content.split('## Pending Confirmations')[1];
  if (!afterHeader) return null;
  const section = afterHeader.split('## Batch Queue')[0];
  const re = new RegExp(`(\\[msg_id: ${msgId}\\][\\s\\S]*?)(?=\\n\\[msg_id: |$)`);
  const m = re.exec(section.trim());
  return m ? m[1].trim() : null;
}

const TEST_CHAT_ID = '999000111';

/**
 * Scenario 1: seeds 2 pending `stage: question` items, sends the bare digit
 * "1", and asserts the real routing dispatch resolved it to the FIRST item
 * (msg_id 100) while leaving the second (msg_id 200) untouched -- the
 * mechanical check for the 2026-09-12 disambiguation-mapping bug.
 *
 * @returns {Promise<{ name: string, passed: boolean, detail: string }>}
 */
export async function runDigitDisambiguationScenario() {
  const name = 'digit-disambiguation';
  const { wsDir, cleanup } = makeDisposableWorkspace();
  seedPendingConfirmations(wsDir,
    '[msg_id: 100] stage: question — Test question A — waiting since 2026-01-01\n' +
    '  report: 1\n  job_url: https://example.com/a\n  data: Test question A body\n\n' +
    '[msg_id: 200] stage: question — Test question B — waiting since 2026-01-01\n' +
    '  report: 2\n  job_url: https://example.com/b\n  data: Test question B body'
  );
  const before100 = readPendingConfirmationBlock(wsDir, '100');
  const before200 = readPendingConfirmationBlock(wsDir, '200');

  await dispatchOne({
    chatId: TEST_CHAT_ID, cwd: wsDir, kind: 'routing',
    messages: [{ chatId: TEST_CHAT_ID, messageId: 300, text: '1', date: Math.floor(Date.now() / 1000), replyToMessageId: null, from: 'Harness', isCommand: false }],
  });

  const after100 = readPendingConfirmationBlock(wsDir, '100');
  const after200 = readPendingConfirmationBlock(wsDir, '200');
  const item1Changed = after100 !== before100;
  const item2Untouched = after200 === before200;
  const passed = item1Changed && item2Untouched;
  const baseDetail = passed ? 'item 1 changed, item 2 untouched' : `item1Changed=${item1Changed} item2Untouched=${item2Untouched} (before100=${JSON.stringify(before100)}, after100=${JSON.stringify(after100)}, before200=${JSON.stringify(before200)}, after200=${JSON.stringify(after200)})`;
  const result = { name, passed, detail: passed ? baseDetail : `${baseDetail} (workspace left at ${wsDir} for inspection)` };
  if (result.passed) cleanup();
  return result;
}

/**
 * Scenario 2: sends a single dispatch carrying 3 `/status` messages for the
 * same chat through createRoutingQueue() (telegram-monitor.mjs) -- the same
 * per-chat queue production code uses to serialize same-chat routing -- and
 * asserts 3 SEPARATE session transcripts were created, one per message. This
 * is the mechanical check for the 2026-09-12 message-batching bug: the bug
 * was the queue collapsing multiple queued messages into one combined
 * dispatch instead of draining them one at a time, so the scenario has to
 * exercise the queue itself (not just call dispatchOne() directly per
 * message) to be capable of catching a regression of it. `/status` is used
 * because it is documented as one-shot with no pending confirmation
 * (modes/telegram.md Step 3f). This is a real end-to-end run (3 real
 * claude -p dispatches) -- not fast, not side-effect-free.
 *
 * @returns {Promise<{ name: string, passed: boolean, detail: string }>}
 */
export async function runRapidFireBurstScenario() {
  const name = 'rapid-fire-burst';
  const { wsDir, tempRoot, cleanup } = makeDisposableWorkspace();
  const makeMsg = (id) => ({ chatId: TEST_CHAT_ID, messageId: id, text: '/status', date: Math.floor(Date.now() / 1000), replyToMessageId: null, from: 'Harness', isCommand: true });
  const queue = createRoutingQueue();
  await queue({ chatId: TEST_CHAT_ID, cwd: wsDir, kind: 'routing', messages: [makeMsg(400), makeMsg(401), makeMsg(402)] }, dispatchOne);
  const all = findHubTranscriptFiles(tempRoot);
  const matching = all.filter(f => f.scope === 'workspace' && f.slug === 'test-candidate');
  const passed = matching.length === 3;
  const baseDetail = passed ? '3 separate transcripts found' : `expected 3 transcripts, found ${matching.length}`;
  const result = { name, passed, detail: passed ? baseDetail : `${baseDetail} (workspace left at ${wsDir} for inspection)` };
  if (result.passed) cleanup();
  return result;
}

const CYCLE_DELEGATION_TIMEOUT_MS = 180_000; // 3 minutes -- enough to reach
// Step 0 pre-flight + the start of Step 1 with zero tracked companies
// (see makeDisposableWorkspace's minimal portals.yml); Pass B's full ATS
// sweep is multi-hour BY DESIGN regardless of config, so this scenario can
// only observe the early part of a /run dispatch -- a deliberate, documented
// limitation, not an oversight. Whether the call completes or times out,
// whatever transcript exists by then is what gets asserted against.
//
// The spec's full assertion for this scenario is two-part: (a) no Agent/Task
// tool-use, and (b) the cycle-lock is not left held-and-stale afterward. Only
// (a) is implemented below. (b) is intentionally NOT implemented: this
// scenario deliberately kills the dispatch at this timeout, and a
// deliberately-killed run legitimately leaves its cycle-lock held (nothing
// ran the Step 0 release path) -- asserting lock-not-stale here would fail
// against expected behavior of this bounded-kill design, not a real bug.

/**
 * Scenario 3: sends `/run` with a bounded real dispatch (timeoutMs =
 * CYCLE_DELEGATION_TIMEOUT_MS) and asserts the resulting transcript never
 * calls the Agent/Task tool -- the mechanical check for the 2026-09-13
 * subagent-delegation bug (see Task 1's warning). A timeout is an EXPECTED
 * outcome here, not a failure -- see the constant's own comment for why a
 * full cycle can never finish inside a bounded test window, and for why the
 * spec's cycle-lock half of this assertion is intentionally not checked here.
 *
 * @returns {Promise<{ name: string, passed: boolean, detail: string }>}
 */
export async function runCycleDelegationScenario() {
  const name = 'cycle-delegation';
  const { wsDir, tempRoot, cleanup } = makeDisposableWorkspace();
  const startMs = Date.now();
  const boundedInvoke = (prompt, cwd, _timeoutMs, model, extraArgs) => {
    const { cmd, shell } = resolveClaudeCommand();
    const args = model ? ['-p', prompt, '--model', model, ...extraArgs] : ['-p', prompt, ...extraArgs];
    return spawnCapturingTail(cmd, args, {
      cwd, shell, timeoutMs: CYCLE_DELEGATION_TIMEOUT_MS,
      exitErrorPrefix: 'claude -p routing exited',
      timeoutErrorMessage: (ms) => `claude -p timed out after ${ms}ms`,
    });
  };

  try {
    await dispatchOne({
      chatId: TEST_CHAT_ID, cwd: wsDir, kind: 'routing',
      messages: [{ chatId: TEST_CHAT_ID, messageId: 500, text: '/run', date: Math.floor(Date.now() / 1000), replyToMessageId: null, from: 'Harness', isCommand: true }],
    }, boundedInvoke);
  } catch (err) {
    if (!err.timedOut) throw err; // a timeout is expected (see constant comment); anything else is a real failure
  }

  const transcriptPath = findLatestTranscript(tempRoot, 'test-candidate', startMs);
  let result;
  if (!transcriptPath) {
    result = { name, passed: false, detail: 'no transcript found for the /run dispatch' };
  } else {
    try {
      assertNoAgentToolUse(transcriptPath);
      result = { name, passed: true, detail: `no Agent/Task tool_use in ${transcriptPath}` };
    } catch (err) {
      result = { name, passed: false, detail: err.message };
    }
  }

  if (result.passed) {
    // A killed real claude -p (see proc.kill() in spawnCapturingTail, invoked
    // via the timeout path above) can still be tearing down its own spawned
    // Bash-tool child processes on Windows, holding a file lock under
    // tempRoot well past cleanup()'s own maxRetries/retryDelay budget --
    // confirmed live 2026-09-13 as an EPERM. Unlike scenarios 1/2 (which
    // never kill a real process and so should never legitimately hit this),
    // a leftover, still-locked temp dir here is disposable-workspace hygiene
    // for the OS to eventually reclaim, never a reason to discard an
    // already-decided passing result.
    try { cleanup(); } catch (err) {
      console.error(`[telegram-emulate] cleanup() failed for ${tempRoot} (leftover temp dir from a killed claude -p, non-fatal): ${err.message}`);
    }
  } else {
    result = { ...result, detail: `${result.detail} (workspace left at ${wsDir} for inspection)` };
  }
  return result;
}

/**
 * Runs all 3 scenarios in sequence (never parallel -- each spawns real
 * claude -p processes and this keeps output/failures easy to attribute),
 * prints a pass/fail summary, and exits non-zero if any scenario failed.
 */
export async function main() {
  const scenarios = [runDigitDisambiguationScenario, runRapidFireBurstScenario, runCycleDelegationScenario];
  const results = [];
  for (const scenario of scenarios) {
    console.log(`Running ${scenario.name}...`);
    try {
      results.push(await scenario());
    } catch (err) {
      results.push({ name: scenario.name, passed: false, detail: `threw: ${err.message}` });
    }
  }
  console.log('\n=== telegram-emulate results ===');
  let anyFailed = false;
  for (const r of results) {
    console.log(`${r.passed ? '✅' : '❌'} ${r.name}: ${r.detail}`);
    if (!r.passed) anyFailed = true;
  }
  if (anyFailed) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
}
