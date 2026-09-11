// core/hooks/guard-playwright-delegation.mjs
//
// PreToolUse hook for the mutating Playwright interaction tools (see the
// matcher registered in .claude/settings.json). Blocks the call when it
// originates in the main Claude Code session (no `agent_id` in the hook
// payload) and allows it when it originates inside a delegated subagent
// (`agent_id` present).
//
// This exists because modes/apply.md Step 7b's prose instruction to
// delegate Playwright form-filling to a subagent was silently skipped in
// practice, twice, even after a stronger warning was added to that step —
// see docs/superpowers/specs/2026-09-08-apply-playwright-delegation-guard-design.md.
//
// Fails OPEN (allow) on any error reading/parsing stdin: a bug in this
// script must never brick apply mode entirely. A regression here is still
// visible, just at the cost/observability layer instead of as a hard block
// — see core/token-efficiency-log.mjs's `no_subagent_delegation` flag.

import { isMainModule } from '../is-main.mjs';

const DENY_REASON =
  'Direct Playwright interaction from the main session is blocked. Delegate this to a subagent per modes/apply.md Step 7b — spawn a subagent with the field-fill task instead of calling browser tools directly from the main flow.';

/**
 * Pure decision logic — no stdin, no process.exit, so it's directly
 * testable. `payload` is the parsed PreToolUse hook JSON. Allows only when
 * `payload.agent_id` is present (a delegated subagent); denies on anything
 * else, including a falsy payload — `main()` never passes one (it fails
 * open on a JSON parse error before calling this), but a direct/test caller
 * can, and the deny-by-default here still applies.
 * @param {any} payload
 * @returns {{ exitCode: number, output: string|null }}
 */
export function decide(payload) {
  if (payload && payload.agent_id) {
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
