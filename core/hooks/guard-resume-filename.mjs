// core/hooks/guard-resume-filename.mjs
//
// PreToolUse hook for mcp__playwright__browser_file_upload (see the matcher
// registered in .claude/settings.json). Blocks an upload whose path is the
// canonical internal report PDF (output/{num}-{company-slug}-{date}.pdf)
// regardless of who is calling it — main session or a delegated subagent.
//
// This exists because modes/apply.md Step 7b item 2's prose instruction —
// rename the approved PDF to `.tmp/{candidate.full_name} - {Company}.pdf`
// before uploading, never the internal path — was silently skipped in
// practice. Confirmed live 2026-09-11 (report #023, HD Supply/Workday): the
// real ATS received `021-hdsupply-2026-09-04.pdf` directly, and the report's
// own Step 8 "Files used" section recorded "Not recorded" instead of the
// actual filename, so the gap wasn't even caught after the fact. Unlike
// guard-playwright-delegation.mjs (which checks WHO is calling), this checks
// WHAT is being uploaded — a subagent that correctly received delegation can
// still pass the wrong path.
//
// Fails OPEN (allow) on any error reading/parsing stdin, or when the payload
// carries no recognizable file paths — a bug in this script must never brick
// apply mode entirely, and it has nothing useful to check without a path.

import { isMainModule } from '../is-main.mjs';

// Matches the internal canonical resume PDF: output/{3-digit-num}-...pdf.
// Deliberately keyed on "lives under output/ with a report-number prefix" —
// the exact shape AGENTS.md's report numbering + PDF naming convention
// produces — rather than the full {num}-{slug}-{date} shape, so a template
// drift in slug/date formatting can't accidentally let a canonical path slip
// through unblocked. `(^|[\\/])` (not a bare `[\\/]`) so a BARE relative path
// with no leading separator -- e.g. `path.join('output', filename)`, which
// Node renders as `output/021-x.pdf` with nothing before "output" -- still
// matches; confirmed live 2026-09-14 that a mandatory leading separator let
// exactly this shape slip through undetected.
const CANONICAL_OUTPUT_PDF_RE = /(^|[\\/])output[\\/]\d{3}-[^\\/]*\.pdf$/i;

const DENY_REASON =
  'Uploading the internal report PDF (output/{num}-{company}-{date}.pdf) directly is blocked. ' +
  'Per modes/apply.md Step 7b item 2, copy the approved PDF to .tmp/{candidate.full_name} - {Company}.pdf ' +
  'first and upload that renamed copy instead — the ATS should never see the internal filename.';

/**
 * Pure decision logic — no stdin, no process.exit, so it's directly
 * testable. `payload` is the parsed PreToolUse hook JSON for a
 * browser_file_upload call. Denies only when at least one path in
 * `tool_input.paths` matches the canonical internal output/ PDF pattern;
 * allows everything else, including a payload with no readable paths at all
 * (nothing to check, so nothing to block).
 * @param {any} payload
 * @returns {{ exitCode: number, output: string|null }}
 */
export function decide(payload) {
  const paths = payload?.tool_input?.paths;
  const hasCanonicalPath = Array.isArray(paths) && paths.some(p => typeof p === 'string' && CANONICAL_OUTPUT_PDF_RE.test(p));

  if (!hasCanonicalPath) {
    return { exitCode: 0, output: null };
  }
  return {
    exitCode: 2,
    output: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON,
      },
    }),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // malformed/empty input — fail open, never block on our own bug
    return;
  }
  const { exitCode, output } = decide(payload);
  if (output) process.stdout.write(output);
  process.exit(exitCode);
}

if (isMainModule(import.meta.url)) {
  main();
}
