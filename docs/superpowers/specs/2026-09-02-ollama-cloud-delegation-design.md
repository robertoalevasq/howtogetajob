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
5. **Ollama Cloud confirmed as the primary target.** Revisited after the user shared their hardware (Ryzen 5 3600, RTX 5060 Ti 8GB VRAM, 32GB RAM): well below the repo's documented minimum for a *full* A-G evaluation locally (32B+/16-24GB+ VRAM), but plausibly fine for these three narrow, single-JSON-object tasks. Final shape: **Ollama Cloud first, local Ollama on this machine as the fallback** when cloud is unreachable/rate-limited/fails — not the reverse, and not local-only.

## Architecture

```
Claude Code session (unchanged entry point: /career-ops pipeline, paste a URL, etc.)
  │
  ├─ modes/pipeline.md / modes/auto-pipeline.md (updated: new steps, detailed below)
  │     │
  │     ├─ node core/preflight-check.mjs <url-or-jd-file>   (LIGHT — pure script, zero LLM)
  │     │     → { liveness, dedup, gateResult, advertisedComp, locationNormalized }
  │     │
  │     ├─ [if gate passes] node core/ollama-delegate.mjs <task> --input <file>   (MEDIUM)
  │     │     1. try Ollama Cloud (config/llm-provider.yml → ollama_cloud)
  │     │     2. on failure, try local Ollama (→ ollama_local, e.g. qwen2.5:14b)
  │     │     3. on failure, exit non-zero — Claude does the task itself inline
  │     │     → strict JSON signal/draft object, treated as untrusted input
  │     │
  │     └─ modes/oferta.md (UNCHANGED) — Claude writes Blocks A-G, citing/verifying
  │           the preflight + delegate outputs where relevant, deciding everything
  │           Block B/C/G-verdict/E/F on its own judgment as it does today
  │
  └─ config/llm-provider.yml — endpoints/models/timeout/per-task toggles for both providers
```

`ollama-delegate.mjs` never runs standalone in this design (that's what `ollama-eval.mjs` is for) — it's always invoked from within the Claude-orchestrated flow, for one narrow task at a time.

**None of the three tasks send `cv.md` content.** `comp-market-estimate` needs only role/location/company; `block-g-signals` needs only the JD/company; `risk-summary-draft` needs Claude's own already-decided score/gaps/legitimacy facts, not raw CV text. So whichever provider handles a given call — Ollama Cloud or local — never sees the candidate's resume, only JD-derived text and Claude's own already-decided outputs. This is a meaningfully smaller exposure than the existing standalone `ollama-eval.mjs`/`openai-eval.mjs` scripts, which send the entire CV.

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

Each file is short and self-contained: what input it receives, what JSON shape to return, and the narrow scope of the task (explicitly *not* a verdict — e.g. `block-g-signals.md` states up front that it gathers evidence only, the Suspicious/Caution/Confidence call is never its job). `ollama-delegate.mjs` reads the task's file, appends the JD text (and any `preflight-check.mjs` output relevant to that task) as user content, then:

1. Calls `ollama_cloud`'s endpoint (`https://ollama.com/v1/chat/completions` by default) with the configured model.
2. On failure (timeout, non-200, malformed JSON), retries the same request against `ollama_local`'s endpoint (`http://localhost:11434/v1/...` by default) — same loopback-only safety guard `ollama-eval.mjs` already uses for local Ollama (refuses a non-localhost `ollama_local.base_url` unless explicitly overridden), since this leg is specifically meant to stay on-machine.
3. On failure of both, exits non-zero with the reason on stderr — the caller (Claude, per the mode-file instructions) treats this exactly like a missing WebSearch result: does the task itself inline instead.

Either leg parses `choices[0].message.content` as strict JSON (ignoring any `message.reasoning` field some cloud/reasoning models return) and exits 0 with that JSON on stdout.

This keeps the actual AI instructions reviewable and editable the same way `oferta.md` is, and — unlike the pre-existing `ollama-eval.mjs`/`openai-eval.mjs` scripts, which the user has not exercised against the current, customized `cv.md`/`_profile.md`/`oferta.md` and so cannot be assumed to still work correctly — these three task files are new, narrow, and testable in isolation before anything depends on them.

### `config/llm-provider.yml` (new)

```yaml
# Tried in order: ollama_cloud, then ollama_local, then Claude does the task inline.
ollama_cloud:
  enabled: true
  base_url: https://ollama.com/v1
  model: gpt-oss:20b
  api_key_env: OLLAMA_API_KEY
  timeout_ms: 60000

ollama_local:
  enabled: true
  base_url: http://localhost:11434/v1
  model: qwen2.5:14b-instruct-q4_K_M   # sized for 8GB VRAM; user-tunable
  timeout_ms: 120000

tasks:
  comp_market_estimate: true
  block_g_signals: true
  risk_summary_draft: true
```

Each `tasks.*` flag lets the user turn off one delegated task without touching mode files (it falls back straight to Claude doing it inline, skipping both providers). Setting either provider's `enabled: false` removes it from the fallback chain — e.g. `ollama_local.enabled: false` if the user doesn't want a pipeline run depending on their desktop being on. If both are `false` or missing, delegation is a no-op end to end.

Default cloud model is `gpt-oss:20b` rather than a larger cloud model — these are narrow, single-purpose extraction tasks (not a full A-G evaluation), so the smaller/faster model (confirmed working during design) is the sensible default. Default local model (`qwen2.5:14b-instruct-q4_K_M`) is picked for the same reason, sized to comfortably fit an 8GB-VRAM card at Q4 quantization; the user needs `ollama pull qwen2.5:14b-instruct-q4_K_M` (or their chosen alternative) done once, same setup step `ollama-eval.mjs`'s docs already describe.

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
| Ollama Cloud unreachable/timeout | `ollama-delegate.mjs` retries the same call against `ollama_local` (if enabled). |
| Local Ollama also unreachable/not running/timeout | Exits non-zero; Claude does that one sub-task itself inline, exactly as if the script didn't exist. Pipeline continues, nothing skipped. |
| Malformed/non-JSON model response (either provider) | Same fallback chain — treated as a failed leg, not a crash: cloud failure tries local, local failure (or a cloud-disabled config) falls back to Claude. |
| `config/llm-provider.yml` missing, or both providers `enabled: false` | Delegation is a no-op; `pipeline.md`'s instructions fall through to Claude doing every step directly (today's exact behavior). |
| `preflight-check.mjs` itself errors (e.g. bad URL) | Propagates as a normal script failure the mode file already knows how to handle (same pattern as `check-liveness.mjs` today) — never silently swallowed. |

## Security

The Ollama Cloud API key lives only in the user's local `.env` (gitignored), read via `config/llm-provider.yml`'s `api_key_env` indirection (same pattern `openai-eval.mjs` already uses for `OPENAI_API_KEY`). Never written to a report, tracker row, or any tracked file. As noted in Architecture above, **`cv.md` is never sent to either provider** for these three tasks — only JD-derived text and Claude's own already-decided facts. What does reach Ollama Cloud (a third-party hosted service) is scoped to that JD/role/company text; the local fallback leg keeps that same text entirely on-machine, and reuses `ollama-eval.mjs`'s existing loopback guard so a misconfigured `ollama_local.base_url` can't silently start sending it somewhere remote.

## Testing / validation

- Unit tests for `preflight-check.mjs`'s dedup and keyword-gate logic (mirroring existing test patterns in `core/test-all.mjs`'s suite), including the "inconclusive vs. conclusively empty" signal `jd-skill-gap.mjs` already establishes as the right shape for this kind of gate.
- `ollama-delegate.mjs` tested against mocked HTTP responses (malformed JSON, timeout, 200-with-reasoning-field) for both providers, plus the cloud-fails/local-succeeds and both-fail fallback paths, without requiring a live key or a running local Ollama in CI.
- One live manual run against the real Ollama Cloud key (already verified reachable during design) to confirm the three task prompts produce usable JSON from `gpt-oss:20b`.
- One live manual run with Ollama Cloud temporarily disabled to confirm the local fallback actually engages `ollama_local` and produces usable JSON from `qwen2.5:14b-instruct-q4_K_M` on the user's hardware — this is the leg with the most real uncertainty (untested model/task combination), so it should be checked before being trusted, not just assumed to work because the config supports it.
- `validate-script-references.mjs` run after the `pipeline.md`/`auto-pipeline.md`/`batch-prompt.md` edits, per `AGENTS.md`'s "two reference sweeps" rule, since this design does touch script-invocation prose in multiple mode files.

## Implementation deltas from this spec

Recorded after implementation (2026-09-02). These are deliberate simplifications found to be better while building, **not oversights** — the spec text above is left as originally written, and this section is authoritative where the two disagree.

- **`preflight-check.mjs` does not compose `check-liveness.mjs` or `jd-fetch-cache.mjs` internally.** The spec's CLI sketch (`--url <url>`, with `liveness` in the output object) had the script run liveness itself. The mode files already call `check-liveness.mjs` (pipeline's Liveness sweep) and `jd-fetch-cache.mjs` (step 2a) directly, at the right points in the flow and with their own result handling — wrapping them inside `preflight-check.mjs` would have been redundant indirection with two call paths to keep in sync. The shipped CLI is `--company`/`--role`/`--text`/`--jd-file`/`--profile`/`--applications`, and its output is `{ duplicate, gate, advertisedComp }`. `--company`/`--role` are optional as a pair: omitting them (as `batch/batch-prompt.md`'s Step 1.5 does, since company/role aren't extracted yet at that point) skips dedup and reports `duplicate.checked: false`, which means "not attempted" and must never be read as "not already tracked."
- **No `locationNormalized` output field.** Nothing downstream consumed it; the location signal that matters is already folded into `gate.reason` for the one case the script judges (an explicit onsite-only requirement against a `location.work_mode: remote_only` candidate).
- **Dedup checks `data/applications.md` only, not `data/scan-history.tsv`.** The tracker is the record of what has actually been evaluated; `scan-history.tsv` is the scanner's own dedup ledger and answers a different question ("did we already surface this URL?"), which `scan.mjs` already handles at its own layer.

**One caveat on "no behavior change to what gets filtered."** That claim (in `core/preflight-check.mjs` above) holds only because `modes/pipeline.md`'s Metadata pre-filter still instructs Claude to judge the pre-fetch title/location metadata for an unambiguously wrong professional domain, *in addition to* running the script. The script deliberately doesn't attempt domain fit (too fuzzy for reliable regex, high false-positive risk), and the original prose-based pre-filter caught three things pre-fetch, not two. Dropping that instruction would silently make domain-mismatched titles cost a Playwright fetch they never used to — a real regression against this spec's own claim. Keep the prose instruction alongside the script call.
