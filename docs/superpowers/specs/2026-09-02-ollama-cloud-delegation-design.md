# Ollama Cloud Task Delegation — Design

## Problem

The interactive `pipeline`/`auto-pipeline`/`oferta` flow spends Claude tokens on every step of an evaluation, including several that are either pure mechanical work (already scripted or scriptable) or narrow, low-judgment extraction (comp normalization, posting-freshness/jurisdiction signal-gathering) that a free hosted model can do adequately. The user wants to cut token usage on the mechanical/extraction layer while keeping every judgment-bearing step — CV citation, narrative fit, legitimacy verdicts, negotiation, tailoring, onboarding — in Claude, without changing how they interact with career-ops day to day.

## Goals

- Reduce Claude token spend on `pipeline`/`auto-pipeline` runs by moving LIGHT (mechanical) work to pure scripts and MEDIUM (narrow-extraction) work to Ollama Cloud.
- Zero change to the user's workflow: still one Claude Code session, still `/career-ops pipeline` / pasting a URL, same report/tracker/PDF output shape.
- Never let a delegated step's failure block or silently corrupt a pipeline run — Claude always has a same-session fallback.
- Never let a delegated step introduce a fabricated CV claim or an unreviewed legitimacy verdict — those stay Claude's call per `AGENTS.md`'s Source-of-Truth Boundary.

## Non-goals

- Not building a second agentic CLI session (OpenCode, etc.) — considered and explicitly rejected mid-design in favor of staying in one session (see Decision Log).
- Not touching `modes/oferta.md` or its scoring rubric — the new step is a pre-computation input, not a rubric change.
- Not adding scheduling/automation (cron, `/loop`, Task Scheduler) — out of scope, orthogonal to token delegation, already covered by an existing unrelated feature if the user wants it later.
- Not replacing or modifying the existing standalone `core/ollama-eval.mjs` / `core/openai-eval.mjs` / `core/openrouter-runner.mjs` / `core/gemini-eval.mjs` scripts — those remain the standalone, full-A-G, no-Claude-involved path documented in `docs/RUNNING_ON_A_BUDGET.md`. This design adds a different, narrower tool alongside them.
- Not delegating Block B (CV-citation/gaps), Block C (leveling/negotiation strategy), Blocks E/F, or Block G's final tier verdict.

## Current state (investigation summary)

One URL's path through `pipeline.md`, in order: metadata pre-filter (LLM prose) → liveness sweep (`core/check-liveness.mjs`, scripted) → JD-fetch-cache check (`core/jd-fetch-cache.mjs`, scripted) → JD extraction (Playwright/WebFetch/WebSearch) → industry-triage (conditional, LLM) → pre-screen gate (LLM prose, tier-gated) → reserve report number (scripted) → full A-F+Block G evaluation (`oferta.md`, LLM, the expensive step) → PDF build/generate (LLM content + scripted render) → tracker TSV write + `merge-tracker.mjs` (scripted).

Confirmed facts that shaped this design:

- **No subagents anywhere in this path.** `pipeline.md`, `_shared.md`, and `_custom.md` explicitly forbid `Agent(...)` fan-out for bulk/inline evaluation. This design does not change that — delegation happens via a plain `node` script call, not a Task/Agent spawn.
- **The pre-screen/mismatch gate is prompt-duplicated three times** (pipeline.md's metadata pre-filter, pipeline.md's post-fetch pre-screen gate, batch-prompt.md's Step 1.5) with no backing script, despite being pure keyword/policy matching against `config/profile.yml`.
- **Blocks A-F and G are narrative-and-citation-heavy**, not JSON-shaped. Block B requires exact `cv.md` line citation; Block G explicitly forbids "naive keyword matching" for its verdict. Both are squarely inside `AGENTS.md`'s anti-fabrication rule, which is why they stay in Claude.
- **`jd-skill-gap.mjs`** is an existing precedent for zero-LLM structured classification against `cv.md`, including an explicit "inconclusive vs. conclusively empty" distinction worth reusing as a pattern.
- **Ollama Cloud is OpenAI-compatible.** Verified live: `https://ollama.com/v1/chat/completions` with `Authorization: Bearer <key>` returns a standard OpenAI-shaped chat-completion response (including `usage` token counts) against models like `gpt-oss:120b`, `deepseek-v4-pro`, `glm-5.3`. `core/openai-eval.mjs`'s existing fetch pattern already works against this endpoint with zero code changes — only env vars differ. The new script in this design reuses that same request shape.

## Decision log (why the shape is what it is)

1. **Ollama-eval.mjs's "old" pattern rejected as the delivery mechanism.** The user does not want a static one-shot script that replaces an entire evaluation; they want Claude Code's own agentic behavior preserved, with specific sub-steps quietly backed by a cheaper model.
2. **A separate OpenCode+Ollama session was considered and rejected** — it would require running a second program, which contradicts "don't change how things currently work."
3. **Landed on: single Claude Code session, Claude calls a new script mid-conversation for specific narrow tasks, reads back JSON, continues.** No new program for the user, no workflow change, same report/tracker output.
4. **Scheduling/automation dropped from scope** — orthogonal to the token-delegation goal; already exists as an unrelated feature if wanted later.
5. **Ollama Cloud confirmed as the target** (not local Ollama) — no local-hardware fallback needed in config.

## Architecture

```
Claude Code session (unchanged entry point: /career-ops pipeline, paste a URL, etc.)
  │
  ├─ modes/pipeline.md / modes/auto-pipeline.md (updated: new steps, detailed below)
  │     │
  │     ├─ node core/preflight-check.mjs <url-or-jd-file>   (LIGHT — pure script, zero LLM)
  │     │     → { liveness, dedup, gateResult, advertisedComp, locationNormalized }
  │     │
  │     ├─ [if gate passes] node core/ollama-delegate.mjs <task> --input <file>   (MEDIUM — Ollama Cloud)
  │     │     → strict JSON signal/draft object, treated as untrusted input
  │     │
  │     └─ modes/oferta.md (UNCHANGED) — Claude writes Blocks A-G, citing/verifying
  │           the preflight + delegate outputs where relevant, deciding everything
  │           Block B/C/G-verdict/E/F on its own judgment as it does today
  │
  └─ config/llm-provider.yml — endpoint/model/timeout/per-task toggles
```

`ollama-delegate.mjs` never runs standalone in this design (that's what `ollama-eval.mjs` is for) — it's always invoked from within the Claude-orchestrated flow, for one narrow task at a time.

## Task categorization

**LIGHT — pure scripts, zero LLM (`core/preflight-check.mjs`, new; composes existing + new logic):**

| Task | Status |
|---|---|
| Liveness check | Exists (`core/check-liveness.mjs`) — called, not reimplemented |
| JD fetch-cache lookup | Exists (`core/jd-fetch-cache.mjs`) — called, not reimplemented |
| Dedup against tracker/scan-history | New |
| Clearance/location/seniority keyword gate | New — collapses the three currently-duplicated LLM-prompt versions (pipeline.md metadata pre-filter, pipeline.md pre-screen gate, batch-prompt.md Step 1.5) into one deterministic script, called from all three call sites |
| Advertised-comp extraction (regex, JD-stated numbers only) | New — feeds the mandatory "Advertised (JD)" row `oferta.md` Block D already requires; output field `advertisedComp`, distinct from the Ollama market-estimate task below (no model call, no market knowledge, just what the JD text literally states) |

**MEDIUM — delegate to Ollama Cloud (`core/ollama-delegate.mjs`, new; signal-gathering only, never a verdict):**

| Task | What it returns | Fabrication risk |
|---|---|---|
| `comp-market-estimate` | A market-number estimate (drawn from the model's training data, not the JD) that Claude labels explicitly as an estimate — same role `ollama-eval.mjs`'s existing Block D handling plays today | Low — Claude still writes the "Advertised (JD)" verbatim row itself from `advertisedComp` (LIGHT, regex); this task only ever supplies the market-comparison number, never the advertised figure |
| `block-g-signals` | Structured findings for the *mechanical* Block G checks: posting-freshness parse, jurisdiction-term-table matches against `templates/*.yml`, benefits-terminology/location-tag mismatches | Low — pattern matches Claude still reviews before citing |
| `risk-summary-draft` | A draft `risk_summary` bullet list from inputs Claude has already decided (score, gaps, legitimacy signals) | None — Claude edits/approves before it reaches the report; never Claude's source of the underlying facts |

**HEAVY — stays in Claude, unchanged:**

Block B (CV citation/gaps), Block C (leveling/negotiation), Block G's final tier verdict, Blocks E/F, ambiguous pre-screen calls, cover letters, interview prep, negotiation, tailoring, onboarding.

## New files

### `core/preflight-check.mjs`

CLI: `node core/preflight-check.mjs --url <url> [--jd-file <path>]`. Runs liveness (delegates to existing script), dedup (new — checks `data/applications.md` + `data/scan-history.tsv`), and the keyword gate (new) in one pass; exits with a JSON verdict `{ liveness, duplicate, gateResult: {pass|fail, reason}, compExtract, locationNormalized }`. `modes/pipeline.md`'s existing "Metadata pre-filter," "Liveness sweep," and "Pre-screen gate" sections are rewritten to call this script instead of describing the logic in prose three times; `batch/batch-prompt.md`'s Step 1.5 does the same. No behavior change to what gets filtered — same conservative hard-stop bar, same `data/discard.log` format — only the mechanism moves from three prompts to one script.

### `core/ollama-delegate.mjs`

CLI: `node core/ollama-delegate.mjs <task> --input <file>` where `<task>` is one of `comp-market-estimate`, `block-g-signals`, `risk-summary-draft`. Reads `config/llm-provider.yml` for endpoint/model/key-env-var/timeout.

**Instructions live in markdown, not hardcoded JS strings** — same convention every other career-ops mode already follows. Each task has a corresponding file under `modes/delegate/`:

- `modes/delegate/comp-market-estimate.md`
- `modes/delegate/block-g-signals.md`
- `modes/delegate/risk-summary-draft.md`

Each file is short and self-contained: what input it receives, what JSON shape to return, and the narrow scope of the task (explicitly *not* a verdict — e.g. `block-g-signals.md` states up front that it gathers evidence only, the Suspicious/Caution/Confidence call is never its job). `ollama-delegate.mjs` reads the task's file, appends the JD text (and any `preflight-check.mjs` output relevant to that task) as user content, calls `https://ollama.com/v1/chat/completions` (or whatever `config/llm-provider.yml` names), parses `choices[0].message.content` as strict JSON (ignoring any `message.reasoning` field some cloud models return), and exits 0 with that JSON on stdout. On any failure (timeout, non-200, malformed JSON) exits non-zero with the reason on stderr — the caller (Claude, per the mode-file instructions) treats this exactly like a missing WebSearch result: does the task itself inline instead.

This keeps the actual AI instructions reviewable and editable the same way `oferta.md` is, and — unlike the pre-existing `ollama-eval.mjs`/`openai-eval.mjs` scripts, which the user has not exercised against the current, customized `cv.md`/`_profile.md`/`oferta.md` and so cannot be assumed to still work correctly — these three task files are new, narrow, and testable in isolation before anything depends on them.

### `config/llm-provider.yml` (new)

```yaml
ollama_cloud:
  enabled: true
  base_url: https://ollama.com/v1
  model: gpt-oss:20b
  api_key_env: OLLAMA_API_KEY
  timeout_ms: 60000
  tasks:
    comp_market_estimate: true
    block_g_signals: true
    risk_summary_draft: true
```

Each `tasks.*` flag lets the user turn off one delegated task without touching mode files. `enabled: false` at the top level disables delegation entirely (every task falls back to Claude doing it inline, i.e. today's exact behavior). Default model is `gpt-oss:20b` rather than a larger cloud model — these are narrow, single-purpose extraction tasks (not a full A-G evaluation), so the smaller/faster model (confirmed working during design) is the sensible default; `model` is user-tunable per the config above.

### `.env` / `.env.example`

Add `OLLAMA_API_KEY=` to `.env.example` alongside the existing provider keys. Actual key goes in the user's gitignored `.env`, never in `config/llm-provider.yml` or any tracked file.

## Integration points (exact insertion, no `oferta.md` change)

- **`modes/pipeline.md`**: "Metadata pre-filter," "Liveness sweep," and "Pre-screen gate" sections rewritten to call `core/preflight-check.mjs` (replacing the duplicated prose logic, same filtering behavior). New sub-step inserted between step (d) (pre-screen gate) and step (e)/(f) (reserve report number / full evaluation): "run `node core/ollama-delegate.mjs comp-market-estimate` and `block-g-signals` against the extracted JD; pass their JSON output into the Step (f) evaluation as pre-gathered candidate signals for Claude to verify and cite." `oferta.md` itself is not touched — it receives richer inputs, not new instructions.
- **`modes/auto-pipeline.md`**: same delegate calls inserted between Step 0.6 (blacklist gate) and Step 1 (A-G Evaluation).
- **`batch/batch-prompt.md`**: Step 1.5's prose gate calls `core/preflight-check.mjs` instead of restating the clearance-keyword list inline.
- **`modes/_custom.md`**: new short section documenting the LIGHT/MEDIUM/HEAVY split so future sessions don't re-derive it.

## Error handling

| Failure | Behavior |
|---|---|
| Ollama Cloud unreachable/timeout | `ollama-delegate.mjs` exits non-zero; Claude does that one sub-task itself inline, exactly as if the script didn't exist. Pipeline continues, nothing skipped. |
| Malformed/non-JSON model response | Same as above — treated as a failed delegate call, not a crash. |
| `config/llm-provider.yml` missing or `enabled: false` | Delegation is a no-op; `pipeline.md`'s instructions fall through to Claude doing every step directly (today's exact behavior). |
| `preflight-check.mjs` itself errors (e.g. bad URL) | Propagates as a normal script failure the mode file already knows how to handle (same pattern as `check-liveness.mjs` today) — never silently swallowed. |

## Security

The Ollama Cloud API key lives only in the user's local `.env` (gitignored), read via `config/llm-provider.yml`'s `api_key_env` indirection (same pattern `openai-eval.mjs` already uses for `OPENAI_API_KEY`). Never written to a report, tracker row, or any tracked file. `cv.md` and JD text are sent to Ollama Cloud (a third-party hosted service) for the three delegated tasks only — this is a materially smaller exposure than the existing `ollama-eval.mjs`/`openai-eval.mjs` standalone path, which already sends the same data plus the full `oferta.md` rubric text.

## Testing / validation

- Unit tests for `preflight-check.mjs`'s dedup and keyword-gate logic (mirroring existing test patterns in `core/test-all.mjs`'s suite), including the "inconclusive vs. conclusively empty" signal `jd-skill-gap.mjs` already establishes as the right shape for this kind of gate.
- `ollama-delegate.mjs` tested against a mocked HTTP response (malformed JSON, timeout, 200-with-reasoning-field) without requiring a live key in CI.
- One live manual run against the real Ollama Cloud key (already verified reachable during design) to confirm the three task prompts produce usable JSON from `gpt-oss:20b`.
- `validate-script-references.mjs` run after the `pipeline.md`/`auto-pipeline.md`/`batch-prompt.md` edits, per `AGENTS.md`'s "two reference sweeps" rule, since this design does touch script-invocation prose in multiple mode files.
