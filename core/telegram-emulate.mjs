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

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { provisionWorkspace } from './provision-workspace.mjs';

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
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
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
