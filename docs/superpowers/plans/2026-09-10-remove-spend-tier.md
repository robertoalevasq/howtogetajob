# Remove spend_tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the `spend_tier` concept from career-ops entirely and make every session — main orchestrating sessions included, not just delegated subagents — actually run on the cheapest model (Haiku 4.5 for Claude Code).

**Architecture:** A deletion pass across every file that reads, writes, or documents `spend_tier`, plus two small additive fixes that close the main-session model gap (`dispatchOne` always pinning Haiku, and a `.claude/settings.json` project-level `model` default). No new files, no new abstractions.

**Tech Stack:** Node.js (`.mjs`), Bash (`batch-runner.sh`), Markdown mode/doc files, YAML config.

**Spec:** `docs/superpowers/specs/2026-09-10-remove-spend-tier-design.md`

## Global Constraints

- Only the files this plan names are touched. Historical docs (`docs/superpowers/specs/*`, `docs/superpowers/plans/*` other than this one, `CHANGELOG.md`) and `test-fixtures/upgrade/state-v1.16|v1.18/config/profile.yml` are NEVER edited — they are a record of what was true when written, not live documentation (spec Section 10).
- No migration step touches an already-provisioned workspace's real `config/profile.yml` — an orphaned `spend_tier` key there is harmless once nothing reads it (spec Non-goals).
- Every mode-file/doc edit in this plan is given as an exact old-text anchor and exact new text — search for the anchor verbatim before editing; if it doesn't match exactly (whitespace included), stop and re-read the file rather than guessing at the closest match.
- The two Haiku-model spellings that appear in this codebase are both correct and NOT interchangeable: `haiku` (the CLI alias, used in `--model haiku` / `.claude/settings.json`'s `"model"` key / `telegram-monitor.mjs`'s `DEFAULT_MODEL`) and `claude-haiku-4-5` (the full model ID, used in `batch/batch-runner.sh` and its tests, matching the sibling `claude-sonnet-5`/`claude-opus-5` IDs already there). Use whichever one the surrounding code in that file already uses — never swap one file to the other file's spelling.

---

### Task 1: Foundational config & doc surface

**Files:**
- Modify: `modes/_shared.md` (the "Spend Tier (Model Routing)" section)
- Modify: `config/profile.example.yml` (the `spend_tier` comment block + key)
- Modify: `core/AGENTS.md` (Step 2 onboarding script)

**Interfaces:**
- Consumes: nothing (this is the first task; no earlier-task interfaces exist yet).
- Produces: the canonical replacement wording other mode files point to (`modes/_shared.md`'s new "## Model Routing" section, stating Claude Code always uses "Haiku 4.5"). Task 2 and Task 3 reference this exact phrase.

- [ ] **Step 1: Replace the Spend Tier section in `modes/_shared.md`**

Find this exact block (it starts at the `## Spend Tier (Model Routing)` heading and ends right before the `## Scoring System` heading):

```markdown
## Spend Tier (Model Routing)

`config/profile.yml` may set `spend_tier` to control which model evaluates offers. Read it once per session.

**Resolution:** Read `spend_tier` from `config/profile.yml`. If the key is absent, default to `standard` (back-compat for existing profiles). Any value other than the three below is treated as invalid -- fall back to `standard` and note the issue to the user once.

**Tier -> model mapping (the only place model/provider names appear in this logic, one row per CLI -- see the Headless / Batch Mode table in `AGENTS.md` for the canonical CLI list):**

| CLI | economy | standard | premium | Extended thinking |
|-----|---------|----------|---------|--------------------|
| Claude Code | Haiku 4.5 | Sonnet 5 | Opus 5 | off / off / adaptive |
| OpenCode | your CLI's cheapest/fastest available model | balanced model | most capable model | off / off / adaptive |
| Gemini CLI | your CLI's cheapest/fastest available model | balanced model | most capable model | off / off / adaptive |
| Copilot CLI | your CLI's cheapest/fastest available model | balanced model | most capable model | off / off / adaptive |
| Codex | your CLI's cheapest/fastest available model | balanced model | most capable model | off / off / adaptive |
| Qwen | your CLI's cheapest/fastest available model | balanced model | most capable model | off / off / adaptive |
| Antigravity CLI | your CLI's cheapest/fastest available model | balanced model | most capable model | off / off / adaptive |

The Claude Code row uses concrete model names because that lineup is well-established. The other rows intentionally avoid naming specific models -- nobody on this project can verify current model lineups for those CLIs with confidence, and a wrong specific guess routes users to a model that doesn't exist. If you actively use one of these CLIs and know its current cheapest/balanced/most-capable models, a follow-up PR filling in concrete names for that row is welcome.

Every other reference to tier elsewhere in the modes (batch.md, pipeline.md, etc.) MUST refer to it only as "the economy/standard/premium tier" or "the tier's model" -- never repeat a hardcoded model/provider name outside this table. This keeps the routing logic model-agnostic: if any CLI's mapping changes, only that row in this table needs to change.

**Output parity:** The model used for evaluation never changes the A-F report structure, headers, or sections. All three tiers produce an evaluation in the exact same format described below and in `modes/oferta.md`.
```

Replace it with:

```markdown
## Model Routing

career-ops always runs on the cheapest/fastest model available to whichever CLI is driving it -- for Claude Code, that's Haiku 4.5. There is no per-workspace choice and nothing to configure. Extended thinking stays off. Any mode file that needs to name the Claude Code model directly should say "Haiku 4.5" -- this is the only value that logic ever resolves to.
```

- [ ] **Step 2: Delete the `spend_tier` key from `config/profile.example.yml`**

Find this exact block:

```yaml
# Controls which model tier evaluates your offers. Valid values:
#   economy  -- cheapest/fastest model, no extended thinking. Best for high-volume scanning.
#   standard -- balanced model, no extended thinking. Default if this key is absent.
#   premium  -- most capable model, adaptive extended thinking. Best for high-stakes offers.
# See the tier -> model mapping table in modes/_shared.md.
spend_tier: standard

```

(note the trailing blank line — it is part of what you delete) and delete it entirely, so the comment block above it (`# followup_cadence: ...`) is followed directly by the next section's comment (`# (Optional) Visual theming...`) with exactly one blank line between them, matching the file's existing spacing convention elsewhere.

- [ ] **Step 3: Remove the tier question from `core/AGENTS.md`'s onboarding script**

Find this exact block:

```markdown
#### Step 2: Profile (required)
If `config/profile.yml` is missing, copy from `config/profile.example.yml` and ask:
> "I need a few details to personalize the system:
> - Your full name and email
> - Your location and timezone
> - What roles are you targeting? (e.g., 'Senior Backend Engineer', 'AI Product Manager')
> - Your salary target range
> - How much do you want to spend on model usage per evaluation? Three options:
>   - **economy** — cheapest and fastest, good for scanning lots of offers quickly
>   - **standard** — balanced cost and quality (default if you're not sure)
>   - **premium** — most capable model, best for offers you really care about
>
> I'll set everything up for you."

Fill in `config/profile.yml` (including `spend_tier`, default `standard`). Archetypes and targeting narrative go to `_profile.md` or `config/profile.yml` — never `modes/_shared.md`.
```

Replace it with:

```markdown
#### Step 2: Profile (required)
If `config/profile.yml` is missing, copy from `config/profile.example.yml` and ask:
> "I need a few details to personalize the system:
> - Your full name and email
> - Your location and timezone
> - What roles are you targeting? (e.g., 'Senior Backend Engineer', 'AI Product Manager')
> - Your salary target range
>
> I'll set everything up for you."

Fill in `config/profile.yml`. Archetypes and targeting narrative go to `_profile.md` or `config/profile.yml` — never `modes/_shared.md`.
```

- [ ] **Step 4: Verify no `spend_tier` reference remains in these three files**

Run: `grep -n "spend_tier" modes/_shared.md config/profile.example.yml core/AGENTS.md`
Expected: no output (grep exits 1, meaning no matches).

- [ ] **Step 5: Commit**

```bash
git add modes/_shared.md config/profile.example.yml core/AGENTS.md
git commit -m "$(cat <<'EOF'
refactor(config): remove spend_tier from shared routing doc, config schema, onboarding

career-ops always runs on the cheapest model now -- no per-workspace
tier choice. modes/_shared.md's routing table collapses to one
sentence; the onboarding script stops asking a question with only one
real answer.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Mode file prose edits (apply, cycle, batch, telegram-onboarding, batch-prompt)

**Files:**
- Modify: `modes/apply.md` (two spots: Step 7's account-creation prose, Step 7b's subagent dispatch)
- Modify: `modes/cycle.md` (Step 2: two bullets)
- Modify: `modes/batch.md` (the "Pre-screen gate" section)
- Modify: `modes/telegram-onboarding.md` (Step 4c)
- Modify: `batch/batch-prompt.md` (Step 1.5's mandatory-triage sentence)

**Interfaces:**
- Consumes: Task 1's `modes/_shared.md` wording ("Haiku 4.5" as the fixed Claude Code model).
- Produces: nothing new; `modes/pipeline.md` (Task 3) makes the same kind of edit independently.

- [ ] **Step 1: `modes/apply.md` — account-creation subagent pin**

Find this exact sentence fragment (it's inside a longer numbered item — match only this fragment):

```
the same subagent-delegated mechanical-fill approach Step 7b already uses for the main application form (pin `model` to the resolved `spend_tier`)
```

Replace with:

```
the same subagent-delegated mechanical-fill approach Step 7b already uses for the main application form (pin `model` to Haiku 4.5)
```

- [ ] **Step 2: `modes/apply.md` — Step 7b's own subagent dispatch line**

Find this exact line:

```
3. Spawn a subagent — pin `model` to the resolved `spend_tier` (per `modes/_shared.md`'s Spend Tier table; this is mechanical execution, not evaluative judgment) — and give it:
```

Replace with:

```
3. Spawn a subagent — pin `model` to Haiku 4.5 (this is mechanical execution, not evaluative judgment) — and give it:
```

- [ ] **Step 3: `modes/cycle.md` — delete the `spend_tier`-reading bullet in Step 2**

Find this exact block:

```markdown
- **Read `spend_tier` from `config/profile.yml`, and check `_custom.md`
  for a pre-screen override.** On `economy` tier, `pipeline.md`'s pre-screen
  gate is a no-op *by default* — every surviving URL goes straight to a full
  A-F evaluation, uncapped. `_custom.md` may already force the standard-tier
  gate to apply regardless of tier (a documented budget-conscious override) —
  if so, the volume risk below is already mitigated and there's nothing
  further to do here.
- **Never pause here for a large pending count.**
```

Replace with just:

```markdown
- **Never pause here for a large pending count.**
```

(i.e. delete the first bullet entirely, keep the second — the rest of that bullet's text, which continues after "Never pause here for a large pending count.", is unchanged).

- [ ] **Step 4: `modes/cycle.md` — delete the "resolve spend_tier once" bullet in Step 2**

Find this exact block:

```markdown
- **Resolve `spend_tier` once, at the start of Step 2**, per
  `modes/_shared.md`'s Spend Tier table, and use it for every inline
  evaluation this step performs.
- **Tracker writes go through TSV, never a direct edit to
```

Replace with just:

```markdown
- **Tracker writes go through TSV, never a direct edit to
```

(i.e. delete the "Resolve `spend_tier` once" bullet entirely; the "Tracker writes..." bullet that follows is unchanged and becomes the next bullet in the list).

- [ ] **Step 5: `modes/batch.md` — delete the entire tier-gated pre-screen gate section**

Find this exact block (from the `## Pre-screen gate` heading through the end of its own Discard log paragraph, ending right before the `## Files` heading):

```markdown
## Pre-screen gate (standard / premium tiers only)

Read `spend_tier` from `config/profile.yml` (see `modes/_shared.md` -- Spend Tier section; defaults to `standard` if absent).

- **`standard` or `premium` tier:** Before a worker runs the full A-F evaluation on a JD, run a cheap pre-screen pass using the tier's economy-equivalent model (see the mapping table in `modes/_shared.md`) against the candidate's North Star archetypes (`_profile.md`). If the JD is an obvious mismatch (wrong domain, wrong seniority band, disqualifying location/visa conflict), skip the full evaluation: mark the job `skipped` in `batch-state.tsv` with a one-line reason, and move to the next job.
- **`economy` tier:** No gate. The tier is already the cheapest available -- running a pre-screen on top of it adds latency without saving spend. Every job goes straight to the full evaluation.
- This gate only applies to batch/pipeline processing. It never applies to a single interactive evaluation (the user already decided the JD is worth a look by pasting/sharing it).

**Discard log (auditable):** Every posting the gate filters out MUST be logged with a one-line reason so pre-filtering is never a silent black box. Append one line to `batch/logs/discard.log` (create the file/dir if absent) in the format `{ISO8601 timestamp}\t{job id}\t{url}\t{reason}`, in addition to the `skipped` row already written to `batch-state.tsv`. This log is the visible, auditable record of what the gate discarded and why -- review it periodically to tune the North Star archetypes if the gate is too aggressive or too lax.

## Files
```

Replace with just:

```markdown
## Files
```

(i.e. delete the whole "Pre-screen gate" section — heading through its Discard log paragraph — keeping the `## Files` heading that follows. Unlike `modes/pipeline.md`, nothing else in `modes/batch.md` cross-references this section's Discard log format, so no relocation is needed here.)

- [ ] **Step 6: `modes/telegram-onboarding.md` — delete the spend_tier-setting item in Step 4c**

Find this exact block:

```markdown
2. Otherwise, write the reply to those fields **lightly polished, not verbatim and not embellished**: fix grammar/phrasing/conciseness for a professional tone, but preserve every factual claim exactly as given and never add a claim, metric, or descriptor the candidate didn't state — the same "keywords get reformulated, never fabricated" discipline `core/AGENTS.md`'s Source-of-Truth Boundary already requires everywhere else in this system (CV tailoring, cover letters), applied here to the candidate's own self-description instead of CV bullets. A single strength becomes a one-item `narrative.superpowers` list; multiple strengths in one reply split into separate list items, each polished the same way. The "how would you pitch yourself" half of the reply goes to `narrative.headline`.
3. Set `workspaces/{slug}/config/profile.yml`'s `spend_tier` to `economy` — no question asked; every candidate onboards on the cheapest tier by default (compute is shared across every tenant on one account, so `economy` is the safe unattended default) and can raise it later any time just by asking, in conversation.
4. Send: `One more optional thing — want progress updates in Discord too? Paste a webhook URL, or reply "skip".`
5. Advance `currentStep` to `discord`, save state.
```

Replace with:

```markdown
2. Otherwise, write the reply to those fields **lightly polished, not verbatim and not embellished**: fix grammar/phrasing/conciseness for a professional tone, but preserve every factual claim exactly as given and never add a claim, metric, or descriptor the candidate didn't state — the same "keywords get reformulated, never fabricated" discipline `core/AGENTS.md`'s Source-of-Truth Boundary already requires everywhere else in this system (CV tailoring, cover letters), applied here to the candidate's own self-description instead of CV bullets. A single strength becomes a one-item `narrative.superpowers` list; multiple strengths in one reply split into separate list items, each polished the same way. The "how would you pitch yourself" half of the reply goes to `narrative.headline`.
3. Send: `One more optional thing — want progress updates in Discord too? Paste a webhook URL, or reply "skip".`
4. Advance `currentStep` to `discord`, save state.
```

(i.e. delete item 3 about `spend_tier` entirely and renumber the two items that followed it, 4→3 and 5→4).

- [ ] **Step 7: `batch/batch-prompt.md` — drop the "regardless of spend_tier" qualifier**

Find this exact sentence:

```
Batch runs process large backlogs unattended, so every offer must be judged for depth before spending a full A-G evaluation on it. This step is mandatory regardless of `spend_tier` — running full A-G on obvious mismatches is the single biggest source of wasted batch spend.
```

Replace with:

```
Batch runs process large backlogs unattended, so every offer must be judged for depth before spending a full A-G evaluation on it. This step is mandatory — running full A-G on obvious mismatches is the single biggest source of wasted batch spend.
```

- [ ] **Step 8: Verify no `spend_tier` reference remains in these five files**

Run: `grep -n "spend_tier" modes/apply.md modes/cycle.md modes/batch.md modes/telegram-onboarding.md batch/batch-prompt.md`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add modes/apply.md modes/cycle.md modes/batch.md modes/telegram-onboarding.md batch/batch-prompt.md
git commit -m "$(cat <<'EOF'
refactor(modes): remove spend_tier references from apply/cycle/batch/onboarding

Pins apply.md's subagent dispatches directly to Haiku 4.5, drops
cycle.md's now-pointless spend_tier resolution steps, deletes
batch.md's tier-gated pre-screen gate (dead code once every tier is
economy), and stops onboarding from setting a field nothing reads
anymore.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `modes/pipeline.md` — pre-screen gate removal + workflow renumbering

This file needs more careful surgery than Task 2's files: its "Pre-screen gate" section is a lettered step (`d`) inside a numbered `## Workflow` list, and its Discard log paragraph is cross-referenced by two OTHER steps (the metadata pre-filter near the top, and the industry-triage step `c2`) for its logging format — so it moves rather than disappears.

**Files:**
- Modify: `modes/pipeline.md`

**Interfaces:**
- Consumes: Task 1's `modes/_shared.md` wording (not directly quoted here, but same "always Haiku" fact this file's deletions assume).
- Produces: nothing new.

- [ ] **Step 1: Drop the "regardless of spend_tier" sentence in the metadata pre-filter section**

Find this exact block:

```markdown
Log every filtered row to `data/discard.log` with a `metadata-prefilter:` prefix (distinguishable
from the post-fetch gate's `pre-screen mismatch:` prefix, so the two are auditable separately), and
mark it `- [x] #-- | {url} | skipped (metadata-prefilter: {reason})` in "Processed" — same format
the post-fetch gate already uses, no new Processed-line shape. Applies regardless of `spend_tier`:
it's saving fetch time, not tokens, so unlike the tier-gated pre-screen it runs the same way on
every tier.
```

Replace with:

```markdown
Log every filtered row to `data/discard.log` with a `metadata-prefilter:` prefix (distinguishable
from the post-fetch gate's `pre-screen mismatch:` prefix, so the two are auditable separately), and
mark it `- [x] #-- | {url} | skipped (metadata-prefilter: {reason})` in "Processed" — same format
the post-fetch gate already uses, no new Processed-line shape.
```

- [ ] **Step 2: Delete the "Pre-screen gate" section, but keep its Discard log paragraph as its own section**

Find this exact block (from the `## Pre-screen gate` heading through the end of its Discard log paragraph, immediately followed by the `## Workflow` heading):

```markdown
## Pre-screen gate (standard / premium tiers only)

Read `spend_tier` from `config/profile.yml` (see `modes/_shared.md` -- Spend Tier section; defaults to `standard` if absent).

- **`standard` or `premium` tier:** Before running the tier's cheap archetype pass below, write the extracted JD to a scratch file (e.g. `jds/{slug}.md`, reusing one if this URL already produced one this run) if it isn't already one, then run `node core/preflight-check.mjs --company "{company}" --role "{role}" --jd-file jds/{slug}.md` against it. If `gate.pass` is `false`, skip the LLM pass entirely and treat it as a pre-screen mismatch using `gate.reason` — no model call needed for a clearance or onsite-only hard stop the script already caught for free. If this script call fails (non-zero exit) for any reason, fall back to applying the same clearance/location judgment yourself as part of the tier's archetype pass below, and continue — never skip the gate because the script failed. Otherwise, run the existing cheap pre-screen pass using the tier's economy-equivalent model (see the mapping table in `modes/_shared.md`) against the candidate's North Star archetypes (`_profile.md`) for the softer, ambiguous fit judgment the script doesn't attempt. If that pass also finds an obvious mismatch, skip the full evaluation: mark it `- [x] #-- | {url} | skipped (pre-screen mismatch: {reason})` in "Processed" and continue to the next URL.
- **`economy` tier:** No gate. The tier is already the cheapest available. Every surviving pending URL goes straight to the full evaluation.
- This gate only applies to pipeline/batch processing. It never applies to a single interactive evaluation.

**Discard log (auditable):** Every posting the gate filters out MUST be logged with a one-line reason so pre-filtering is never a silent black box. Append one line to `data/discard.log` (create the file if absent) in the format `{ISO8601 timestamp}\t{url}\t{reason}` (three tab-separated fields — interactive pipeline mode has no batch job ID, so the `id` field is omitted here; batch mode's `batch/batch-runner.sh` uses a separate `batch/logs/discard.log` with a four-field format that includes the job ID), in addition to the `skipped` entry already written to "Processed" above. This log is the visible, auditable record of what the gate discarded and why -- review it periodically to tune the North Star archetypes if the gate is too aggressive or too lax.

## Workflow
```

Replace with:

```markdown
## Discard log (auditable)

Every posting a discard step below filters out MUST be logged with a one-line reason so pre-filtering is never a silent black box. Append one line to `data/discard.log` (create the file if absent) in the format `{ISO8601 timestamp}\t{url}\t{reason}` (three tab-separated fields — interactive pipeline mode has no batch job ID, so the `id` field is omitted here; batch mode's `batch/batch-runner.sh` uses a separate `batch/logs/discard.log` with a four-field format that includes the job ID), in addition to the `skipped` entry already written to "Processed" above. This log is the visible, auditable record of what gets discarded and why -- review it periodically to tune the North Star archetypes if a discard step is too aggressive or too lax.

## Workflow
```

(i.e. the tier-gated gate's three bullets are gone entirely; its Discard log paragraph survives as its own section, reworded from "the gate"/"the gate discarded" to the step-agnostic "a discard step below"/"gets discarded", since it now documents the shared format for the metadata-prefilter, industry-triage, AND the JD-extraction-failure discard paths — not one named gate).

- [ ] **Step 3: Delete lettered step `d` ("Pre-screen gate: apply the gate above...") from the `## Workflow` list**

Find this exact block:

```markdown
   c2. **Mandatory triage for industry-sourced URLs.** If this pending row carries the `| source: industry` labeled segment (see "Format of pipeline.md" above), run `modes/triage.md` against the already-extracted JD from step (b) — regardless of `spend_tier`. This is unconditional even at `economy` tier: the existing tier-gating on the Pre-screen gate below exists because `economy` is already the cheapest model, which has no bearing on whether a *first* cheap check ran at all — and for an industry-sourced URL, the title filter (every other URL's first cheap check) was deliberately skipped at scan time. `triage.md`'s rubric is unchanged; it reads only `_brief.md`, exactly as it does when invoked directly.
       - **FAIL/SKIP:** log the discard to `data/discard.log` (same three-field format the Pre-screen gate below uses) with the triage reason, mark `- [x] #-- | {url} | skipped (industry-triage: {reason})` in "Processed," and continue to the next URL. No `REPORT_NUM` is claimed.
       - **MARGINAL:** surface the one-line triage verdict to the user the same way the Pre-screen gate's own mismatch case is surfaced, and continue to the next URL without claiming a `REPORT_NUM` unless the user explicitly asks to proceed with this one.
       - **PASS:** continue to step (d) below as normal — note that the existing Pre-screen gate at step (d) still applies afterward per its own tier rules; triage and pre-screen are not mutually exclusive, they're sequential cheap-then-cheaper gates for this specific URL category.
   d. **Pre-screen gate**: apply the gate above (using the extracted JD). If the JD is an obvious mismatch, log the discard to `data/discard.log` (per the **Discard log** rule above — three fields, no job ID in interactive mode), mark it `- [x] #-- | {url} | skipped (pre-screen mismatch: {reason})` in "Processed", and continue to the next URL. No `REPORT_NUM` is claimed for discarded postings.
   d2. **Pre-gathered signals (optional, zero-risk).** If `config/llm-provider.yml` exists, run `node core/ollama-delegate.mjs comp-market-estimate --input jds/{slug}.md` and `node core/ollama-delegate.mjs block-g-signals --input jds/{slug}.md` (reuse the same JD scratch file step (d)'s `preflight-check.mjs` call already wrote — don't re-save it; if step (d) was skipped by tier, write the extracted JD to `jds/{slug}.md` here instead). Either call may fail (config absent, both providers down, task disabled) — that is expected and NOT an error: on any non-zero exit, simply proceed to step (f) without that pre-gathered input, exactly as the pipeline behaves today. On success, pass the returned JSON into step (f)'s evaluation as an extra input for Claude to verify and cite — never as a fact taken on faith, and never as a substitute for Block B/C or Block G's final tier verdict, which stay entirely Claude's judgment call.
```

Replace with:

```markdown
   c2. **Mandatory triage for industry-sourced URLs.** If this pending row carries the `| source: industry` labeled segment (see "Format of pipeline.md" above), run `modes/triage.md` against the already-extracted JD from step (b). This is unconditional — for an industry-sourced URL, the title filter (every other URL's first cheap check) was deliberately skipped at scan time, so this is the only cheap check it gets before a full evaluation. `triage.md`'s rubric is unchanged; it reads only `_brief.md`, exactly as it does when invoked directly.
       - **FAIL/SKIP:** log the discard to `data/discard.log` (same three-field format the **Discard log** section above uses) with the triage reason, mark `- [x] #-- | {url} | skipped (industry-triage: {reason})` in "Processed," and continue to the next URL. No `REPORT_NUM` is claimed.
       - **MARGINAL:** surface the one-line triage verdict to the user, and continue to the next URL without claiming a `REPORT_NUM` unless the user explicitly asks to proceed with this one.
       - **PASS:** continue to step (d) below as normal.
   d. **Pre-gathered signals (optional, zero-risk).** If `config/llm-provider.yml` exists, write the extracted JD (from step (b)) to `jds/{slug}.md` now if this URL hasn't already produced that scratch file this run, then run `node core/ollama-delegate.mjs comp-market-estimate --input jds/{slug}.md` and `node core/ollama-delegate.mjs block-g-signals --input jds/{slug}.md`. Either call may fail (config absent, both providers down, task disabled) — that is expected and NOT an error: on any non-zero exit, simply proceed to step (f) without that pre-gathered input, exactly as the pipeline behaves today. On success, pass the returned JSON into step (f)'s evaluation as an extra input for Claude to verify and cite — never as a fact taken on faith, and never as a substitute for Block B/C or Block G's final tier verdict, which stay entirely Claude's judgment call.
```

(i.e. the old lettered `d` "Pre-screen gate" step is gone entirely; the old `d2` "Pre-gathered signals" step is renamed to `d` and no longer branches on whether a now-nonexistent step skipped writing the JD file — it always writes it itself, reusing one if already present. Steps `e`, `f`, `g` that follow keep their existing letters unchanged — nothing else in this file references `d2` by name.)

- [ ] **Step 4: Delete the "Resolve spend_tier once" sentence from Workflow step 3**

Find this exact sentence (it's the last sentence of numbered Workflow step "3."):

```
**Resolve `spend_tier` once**, at the start of this loop, per `modes/_shared.md`'s Spend Tier table, and use it for every evaluation.
```

Delete this sentence (including the space before it that joined it to the previous sentence), so step 3 ends at the sentence immediately before it instead.

- [ ] **Step 5: Verify no `spend_tier` reference remains, and the workflow lettering is internally consistent**

Run: `grep -n "spend_tier" modes/pipeline.md`
Expected: no output.

Then read `modes/pipeline.md`'s `## Workflow` section once, top to bottom, and confirm: step `c2`'s "PASS" branch points to step `d`; the new step `d` is the pre-gathered-signals step; step `e` (claim `REPORT_NUM`) still follows it. No step references a step lettered `d2` anywhere.

- [ ] **Step 6: Commit**

```bash
git add modes/pipeline.md
git commit -m "$(cat <<'EOF'
refactor(pipeline): remove tier-gated pre-screen gate, renumber workflow

Deletes the standard/premium-only pre-screen gate (dead code once
every tier is economy, matching economy's existing behavior exactly).
Its Discard log paragraph survives as its own section since two other
steps (metadata pre-filter, industry triage) share its log format.
The old lettered step d2 becomes d now that d is free.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `core/telegram-monitor.mjs` — pin every dispatch kind to the default model

**Files:**
- Modify: `core/telegram-monitor.mjs:326-350` (rename `ONBOARDING_MODEL` to `DEFAULT_MODEL`, update its comment)
- Modify: `core/telegram-monitor.mjs:1049-1053` (`dispatchOne`'s model resolution)
- Test: `core/test-all.mjs` (new assertion block)

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `DEFAULT_MODEL` constant (value `'haiku'`) — no other file imports it; it's module-internal, referenced here only so its name is on record for later maintainers grepping the file.

- [ ] **Step 1: Write the failing test**

Open `core/test-all.mjs` and find this exact block (the end of the `checkForStalledCycle` test's catch clause, immediately followed by an unrelated inline test):

```javascript
  fail(`checkForStalledCycle coverage crashed: ${e.message}`);
}

const expandMode = readFile('modes/expand.md');
```

Insert a new test between the `}` and the `const expandMode = ...` line (i.e. right after the blank line that follows `}`), so the result reads:

```javascript
  fail(`checkForStalledCycle coverage crashed: ${e.message}`);
}

// dispatchOne pins every dispatch kind to the default (Haiku) model — not
// just onboarding. Before this fix, routing/cycle-resume dispatches (i.e.
// every real cycle/apply/pipeline run driven over Telegram) fell through to
// `undefined` and inherited the account default.
try {
  const { dispatchOne } = await import(pathToFileURL(join(ROOT, 'core', 'telegram-monitor.mjs')).href);
  const calls = [];
  const fakeInvoke = async (prompt, cwd, timeoutMs, model, extraArgs) => { calls.push(model); };
  const fakeResolveBrowserArgs = async () => [];
  const fakeLogDispatch = () => {};
  await dispatchOne({ kind: 'routing', cwd: '/fake', messages: [] }, fakeInvoke, fakeResolveBrowserArgs, fakeLogDispatch);
  await dispatchOne({ kind: 'cycle-resume', cwd: '/fake', messages: [] }, fakeInvoke, fakeResolveBrowserArgs, fakeLogDispatch);
  await dispatchOne({ kind: 'onboarding', cwd: '/fake', messages: [] }, fakeInvoke, fakeResolveBrowserArgs, fakeLogDispatch);
  if (calls.length === 3 && calls.every(m => m === 'haiku')) {
    pass('dispatchOne pins every dispatch kind (routing/cycle-resume/onboarding) to haiku');
  } else {
    fail(`dispatchOne did not pin every kind to haiku: ${JSON.stringify(calls)}`);
  }
} catch (e) { fail(`dispatchOne model-pin test crashed: ${e.message}`); }

const expandMode = readFile('modes/expand.md');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node core/test-all.mjs 2>&1 | grep -A2 "dispatchOne did not pin"`
Expected: a `FAIL` line reading `dispatchOne did not pin every kind to haiku: ["haiku",null,"haiku"]` — today only `onboarding` resolves `model` to `'haiku'`; `routing` and `cycle-resume` both resolve to `undefined`, which `JSON.stringify` renders as `null` inside an array. If the exact array contents differ from this prediction, that's fine — the important thing is the test reports FAIL, confirming it isn't vacuously passing before the fix.

- [ ] **Step 3: Rename `ONBOARDING_MODEL` to `DEFAULT_MODEL` and update its comment**

Find this exact block (around line 328):

```javascript
// Onboarding turns are pinned to the fastest model: reading a short reply,
// writing a few YAML/markdown fields, running a couple of deterministic CLI
// commands — none of it needs the account's default (heavier, unpinned)
// model, and onboarding turns are serialized (see fanOutDispatches), so
// every extra second here is a second the whole daemon can't poll for
// anyone else either. `routing` dispatches are deliberately left on
// whatever model the `claude` CLI defaults to (undefined below) — a bound
// chat's `cycle`/`apply`/etc. genuinely needs full capability.
const ONBOARDING_MODEL = 'haiku';
```

Replace with:

```javascript
// career-ops has no spend tiers -- every claude -p dispatch this daemon
// makes, onboarding included, always runs on the cheapest available model.
const DEFAULT_MODEL = 'haiku';
```

- [ ] **Step 4: Update the docstring comment that names the old constant**

Find this exact line (around line 350):

```javascript
 * `model`, when given, is passed as `--model <model>` — see ONBOARDING_MODEL.
```

Replace with:

```javascript
 * `model`, when given, is passed as `--model <model>` — see DEFAULT_MODEL.
```

- [ ] **Step 5: Fix `dispatchOne`'s model resolution**

Find this exact block (around line 1049):

```javascript
  // Only onboarding gets a bounded timeout and a pinned fast model — see
  // ONBOARDING_TIMEOUT_MS/ONBOARDING_MODEL's own comments. A routing
  // dispatch (cycle/apply/etc.) is unlimited and uses the account default.
  const timeoutMs = dispatch.kind === 'onboarding' ? ONBOARDING_TIMEOUT_MS : undefined;
  const model = dispatch.kind === 'onboarding' ? ONBOARDING_MODEL : undefined;
```

Replace with:

```javascript
  // Only onboarding gets a bounded timeout — see ONBOARDING_TIMEOUT_MS's own
  // comment. A routing dispatch (cycle/apply/etc.) is unlimited. Every
  // dispatch kind is pinned to the same model (DEFAULT_MODEL) -- career-ops
  // has no spend tiers, so there's no "account default" to fall through to.
  const timeoutMs = dispatch.kind === 'onboarding' ? ONBOARDING_TIMEOUT_MS : undefined;
  const model = DEFAULT_MODEL;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node core/test-all.mjs 2>&1 | grep "dispatchOne pins"`
Expected: `✅ dispatchOne pins every dispatch kind (routing/cycle-resume/onboarding) to haiku`

- [ ] **Step 7: Run the full suite to confirm no other test broke**

Run: `node core/test-all.mjs`
Expected: all tests pass (the summary line's failed count is 0).

- [ ] **Step 8: Commit**

```bash
git add core/telegram-monitor.mjs core/test-all.mjs
git commit -m "$(cat <<'EOF'
fix(telegram-monitor): pin every dispatch kind to the default model

dispatchOne only pinned onboarding dispatches to Haiku; routing and
cycle-resume dispatches -- i.e. every real cycle/apply/pipeline run
driven over Telegram -- fell through to the account default (observed
as Sonnet 5). Renames ONBOARDING_MODEL to DEFAULT_MODEL to match its
new scope and pins every dispatch kind to it unconditionally.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `.claude/settings.json` — project-level default model

**Files:**
- Modify: `.claude/settings.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing another task reads; this is a leaf config file. Task 8's final step names the operational follow-up (running `backfill-templates.mjs`) that propagates this file's change to already-provisioned workspaces — that is a post-merge action, not a step in this task.

- [ ] **Step 1: Add the `model` key**

Open `.claude/settings.json`. It currently starts:

```json
{
  "permissions": {
```

Change the first line only, so the file starts:

```json
{
  "model": "haiku",
  "permissions": {
```

Every other line in the file is unchanged.

- [ ] **Step 2: Verify the file is still valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json', 'utf-8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add .claude/settings.json
git commit -m "$(cat <<'EOF'
fix(settings): default this repo's Claude Code sessions to Haiku

Closes the last gap in main-session model routing: a user's own
interactive `claude` session in this repo (not just Telegram-dispatched
headless ones) now defaults to the cheapest model too. An explicit
--model flag, /model command, or ANTHROPIC_MODEL env var still
overrides this, per Claude Code's documented settings precedence.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `batch/batch-runner.sh` — collapse tier-based model resolution

**Files:**
- Modify: `batch/batch-runner.sh` (variable declarations, usage banner, `read_spend_tier`/`spend_tier_to_model`/`resolve_worker_model`, the launch-comment, the run-summary print)
- Modify: `core/test-all.mjs` (replace section 14's five assertions with two)
- Modify: `tests/helpers.mjs` (one stray comment)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolve_worker_model()` keeps its existing name and its existing output variable `RESOLVED_MODEL`, but replaces `RESOLVED_SPEND_TIER` (a string: `"override"` or a tier name) with `RESOLVED_OVERRIDE` (a boolean: `true`/`false`). Nothing outside this file reads either variable.

- [ ] **Step 1: Write the failing tests**

Open `core/test-all.mjs` and find the `// ── 14. BATCH SPEND TIER MODEL ROUTING ───────────────────────────` section header. Replace the ENTIRE section — from that header line through the end of the "invalid spend_tier value falls back to standard with a warning" try/catch block, i.e. everything up to (but not including) the `// ── 14b. BATCH PRE-SCREEN DISCARD LOG ────────────────────────────` header — with:

```javascript
// ── 14. BATCH DEFAULT MODEL ROUTING ──────────────────────────────

console.log('\n14. Batch default model routing');

// Helper: create a fully isolated tmp fixture for one model-routing sub-test.
// Each sub-test gets its own mkdtempSync so no batch-state.tsv from a prior
// sub-test can bleed in, regardless of OS-level I/O ordering on CI runners.
function makeBatchRunnerFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'co-batch-model-'));
  const batchDir = join(tmp, 'batch');
  // batch-runner.sh resolves batch-input.tsv (and other user-runtime paths)
  // under data/, one level up from its own script dir — see
  // #workspace-multitenancy Task 9.
  const dataDir = join(tmp, 'data');
  const fakeBin = join(tmp, 'bin');
  // merge-tracker.mjs/verify-pipeline.mjs live under core/ now
  // (#workspace-multitenancy Task 1), and batch-runner.sh's own invocations
  // were updated to `$PROJECT_DIR/core/<script>.mjs` to match (final-review
  // Critical 1) — the fixture stubs below must sit at the same depth or the
  // real batch-runner.sh can't find them.
  const coreDir = join(tmp, 'core');
  mkdirSync(batchDir, { recursive: true });
  mkdirSync(join(tmp, 'reports'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(coreDir, { recursive: true });

  writeFileSync(join(batchDir, 'batch-runner.sh'), readFileSync(join(ROOT, 'batch/batch-runner.sh'), 'utf-8').replace(/\r\n/g, '\n'));
  if (process.platform === 'win32') {
    try { execFileSync(getBash(), ['-c', 'chmod +x batch/batch-runner.sh'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(batchDir, 'batch-runner.sh')]);
  }
  writeFileSync(join(coreDir, 'merge-tracker.mjs'), 'console.log("merge fixture");\n');
  writeFileSync(join(coreDir, 'verify-pipeline.mjs'), 'console.log("verify fixture");\n');
  writeFileSync(join(coreDir, 'reconcile-pipeline.mjs'), 'console.log("reconcile fixture");\n');
  writeFileSync(join(coreDir, 'reserve-report-num.mjs'), 'console.log("1");\n');
  writeFileSync(join(batchDir, 'batch-prompt.md'), 'URL={{URL}}\nJD={{JD_FILE}}\nREPORT={{REPORT_NUM}}\n');
  writeFileSync(join(dataDir, 'batch-input.tsv'), [
    'id\turl\tsource\tnotes',
    '1\thttps://example.com/one\tfixture\t-',
  ].join('\n') + '\n');
  writeFileSync(join(fakeBin, 'claude'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$BATCH_ARG_FILE"',
    'exit 0',
  ].join('\n') + '\n');
  if (process.platform === 'win32') {
    try { execFileSync(getBash(), ['-c', 'chmod +x bin/claude'], { cwd: tmp }); } catch {}
  } else {
    execFileSync('chmod', ['+x', join(fakeBin, 'claude')]);
  }
  return { tmp, batchDir, fakeBin };
}

// no --model flag: always resolves to claude-haiku-4-5
try {
  const { tmp, batchDir, fakeBin } = makeBatchRunnerFixture();
  const argFile = join(tmp, 'claude-argv.txt');
  const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, BATCH_ARG_FILE: argFile };
  const out = run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1'], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] }) || '';
  const argv = existsSync(argFile) ? readFileSync(argFile, 'utf-8') : '';
  if (argv.includes('--model') && argv.includes('claude-haiku-4-5') && out.includes('Model: claude-haiku-4-5')) {
    pass('no --model flag defaults to claude-haiku-4-5');
  } else {
    fail(`default model routing broke: argv=${JSON.stringify(argv)}, out=${JSON.stringify(out.slice(-240))}`);
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) { fail(`Batch default model routing test crashed (default): ${e.message}`); }

// --model override still wins
try {
  const { tmp, batchDir, fakeBin } = makeBatchRunnerFixture();
  const argFile = join(tmp, 'claude-argv.txt');
  const env = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}`, BATCH_ARG_FILE: argFile };
  const overrideOut = run(getBash(), [toBashPath(join(batchDir, 'batch-runner.sh')), '--parallel', '1', '--model', 'claude-sonnet-5'], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] }) || '';
  const overrideArgv = existsSync(argFile) ? readFileSync(argFile, 'utf-8') : '';
  if (overrideArgv.includes('--model') && overrideArgv.includes('claude-sonnet-5') && !overrideArgv.includes('claude-haiku-4-5') && overrideOut.includes('explicit --model override')) {
    pass('--model override takes precedence over the default');
  } else {
    fail(`--model override did not win: argv=${JSON.stringify(overrideArgv)}, out=${JSON.stringify(overrideOut.slice(-240))}`);
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
} catch (e) { fail(`Batch default model routing test crashed (--model override): ${e.message}`); }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node core/test-all.mjs 2>&1 | grep -A2 "default model routing broke\|override did not win"`
Expected: at least one `FAIL` line — `batch-runner.sh` still reads `config/profile.yml`'s `spend_tier` today, and the fixture no longer writes that file, so `resolve_worker_model` falls back to its current `standard` default (`claude-sonnet-5`), not `claude-haiku-4-5`.

- [ ] **Step 3: Remove the now-unused `PROFILE_FILE` variable**

Find this exact line (around line 25):

```bash
PROFILE_FILE="$PROJECT_DIR/config/profile.yml"
```

Delete this line entirely (it will have no remaining reader after Step 5 below).

- [ ] **Step 4: Update the top-of-file variable declarations**

Find this exact block (around line 47):

```bash
MODEL=""  # explicit override; otherwise resolved from config/profile.yml spend_tier
RESOLVED_MODEL=""
RESOLVED_SPEND_TIER=""
```

Replace with:

```bash
MODEL=""  # explicit override; otherwise always the cheapest available model
RESOLVED_MODEL=""
RESOLVED_OVERRIDE=false
```

- [ ] **Step 5: Update the usage banner**

Find this exact line (around line 64):

```
Uses spend_tier from config/profile.yml unless --model overrides it.
```

Replace with:

```
Always uses the cheapest available Claude model (claude-haiku-4-5) unless --model overrides it.
```

Find this exact block (around line 80):

```
  --model NAME         Override the tier-resolved Claude model passed to
                       `claude -p --model` (otherwise uses config/profile.yml
                       spend_tier: economy/standard/premium; default standard)
```

Replace with:

```
  --model NAME         Override the default Claude model passed to
                       `claude -p --model` (otherwise always claude-haiku-4-5)
```

- [ ] **Step 6: Collapse `read_spend_tier`/`spend_tier_to_model`/`resolve_worker_model`**

Find this exact block (around line 311):

```bash
# Read spend_tier from config/profile.yml. Defaults to "standard" if the key
# is absent or invalid.
read_spend_tier() {
  local raw=""

  if [[ -f "$PROFILE_FILE" ]]; then
    raw=$(
      awk -F: '
        /^[[:space:]]*spend_tier[[:space:]]*:/ {
          value = substr($0, index($0, ":") + 1)
          print value
          exit
        }
      ' "$PROFILE_FILE"
    )
    raw="${raw%%#*}"
    raw="${raw//$'\r'/}"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    case "$raw" in
      \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
      \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
    esac
    raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  fi

  case "$raw" in
    economy|standard|premium)
      printf '%s\n' "$raw"
      ;;
    "")
      printf '%s\n' "standard"
      ;;
    *)
      echo "WARN: Invalid spend_tier \"$raw\" in ${PROFILE_FILE#"$PROJECT_DIR/"}; falling back to standard." >&2
      printf '%s\n' "standard"
      ;;
  esac
}

# Tier -> model mapping. Keep in sync with the table in modes/_shared.md.
spend_tier_to_model() {
  case "$1" in
    economy) echo "claude-haiku-4-5" ;;
    premium) echo "claude-opus-5" ;;
    standard|*) echo "claude-sonnet-5" ;;
  esac
}

# Resolve the model to pass to `claude -p --model`. --model always wins.
resolve_worker_model() {
  if [[ -n "$MODEL" ]]; then
    RESOLVED_MODEL="$MODEL"
    RESOLVED_SPEND_TIER="override"
    return 0
  fi

  RESOLVED_SPEND_TIER="$(read_spend_tier)"
  RESOLVED_MODEL="$(spend_tier_to_model "$RESOLVED_SPEND_TIER")"
}
```

Replace with:

```bash
# Resolve the model to pass to `claude -p --model`. --model always wins;
# otherwise every batch run uses the cheapest available model.
resolve_worker_model() {
  if [[ -n "$MODEL" ]]; then
    RESOLVED_MODEL="$MODEL"
    RESOLVED_OVERRIDE=true
    return 0
  fi

  RESOLVED_MODEL="claude-haiku-4-5"
  RESOLVED_OVERRIDE=false
}
```

- [ ] **Step 7: Update the launch-site comment**

Find this exact block (around line 559):

```bash
  # Launch claude -p worker.
  # The model is resolved once per run from spend_tier unless --model was
  # passed. Building the command in an array keeps quoting safe regardless.
```

Replace with:

```bash
  # Launch claude -p worker.
  # The model is resolved once per run -- always claude-haiku-4-5 unless
  # --model was passed. Building the command in an array keeps quoting safe
  # regardless.
```

- [ ] **Step 8: Update the run-summary print**

Find this exact block (around line 961):

```bash
  if [[ "$RESOLVED_SPEND_TIER" == "override" ]]; then
    echo "Model: $RESOLVED_MODEL (explicit --model override)"
  else
    echo "Model: $RESOLVED_MODEL (spend_tier=${RESOLVED_SPEND_TIER})"
  fi
```

Replace with:

```bash
  if [[ "$RESOLVED_OVERRIDE" == true ]]; then
    echo "Model: $RESOLVED_MODEL (explicit --model override)"
  else
    echo "Model: $RESOLVED_MODEL"
  fi
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node core/test-all.mjs 2>&1 | grep "default model routing\|override.*precedence"`
Expected:
```
✅ no --model flag defaults to claude-haiku-4-5
✅ --model override takes precedence over the default
```

- [ ] **Step 10: Fix the stray comment in `tests/helpers.mjs`**

Find this exact sentence fragment (around line 109-111):

```
// exit 127. run() converts that to null, the caller does `|| ''`, and the
// assertion reports an empty argv -- which reads as a routing bug in the code
// under test rather than a missing shell. That is what all five spend_tier
// tests were doing on a machine where Git Bash was installed the whole time
// (#2344).
```

Replace with:

```
// exit 127. run() converts that to null, the caller does `|| ''`, and the
// assertion reports an empty argv -- which reads as a routing bug in the code
// under test rather than a missing shell. That is what the batch-runner
// model-routing tests were doing on a machine where Git Bash was installed
// the whole time (#2344).
```

- [ ] **Step 11: Run the full suite to confirm nothing else broke**

Run: `node core/test-all.mjs`
Expected: all tests pass (the summary line's failed count is 0).

- [ ] **Step 12: Verify no `spend_tier` reference remains**

Run: `grep -n "spend_tier" batch/batch-runner.sh`
Expected: no output.

- [ ] **Step 13: Commit**

```bash
git add batch/batch-runner.sh core/test-all.mjs tests/helpers.mjs
git commit -m "$(cat <<'EOF'
refactor(batch-runner): collapse tier-based model resolution to a constant

read_spend_tier/spend_tier_to_model/the profile.yml awk-parse all go
away -- resolve_worker_model now always resolves claude-haiku-4-5
unless --model overrides it. Replaces the five tier-branching
test-all.mjs assertions with two (default, override).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `docs/RUNNING_ON_A_BUDGET.md` rewrite

**Files:**
- Modify: `docs/RUNNING_ON_A_BUDGET.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Replace Section 2**

Find this exact block:

```markdown
## 2. Pick Your Spend Tier

Before diving into CLI configuration, know that career-ops has a built-in knob for controlling evaluation cost: the `spend_tier` setting in [`config/profile.yml`](../config/profile.example.yml). It controls which model tier your CLI uses to evaluate offers — no provider setup required.

| Tier | Behaviour |
|------|-----------|
| **economy** | Cheapest/fastest model, no extended thinking. Best for high-volume scanning. |
| **standard** | Balanced model, no extended thinking. Default if the key is absent. |
| **premium** | Most capable model, adaptive extended thinking. Best for high-stakes offers. |

The **economy** tier is the high-volume scanning choice — it processes the most offers per dollar. On **standard** and **premium**, a pre-screen gate automatically trims batch spend by skipping obvious mismatches before the full evaluation runs.

Set it once in your profile:

```yaml
# config/profile.yml
spend_tier: standard
```

The actual model behind each tier depends on your CLI. See the mapping table in [`modes/_shared.md`](../modes/_shared.md) for the full breakdown.

---
```

Replace with:

```markdown
## 2. career-ops Already Defaults to the Cheapest Model

Before diving into CLI configuration, know that career-ops has no tier to pick: it always routes to the cheapest/fastest model available to whichever CLI is driving it — Haiku 4.5 for Claude Code — with no provider setup required and nothing to configure. See [`modes/_shared.md`](../modes/_shared.md) for the one-line policy statement.

---
```

- [ ] **Step 2: Fix the one sentence in Section 2b that credits the removed tier/gate**

Find this exact sentence:

```
- **Plan limits are windows, not balances.** On a subscription you get rolling usage windows rather than a credit balance, so a heavy scan can pause you until the window resets. `spend_tier: economy` and the pre-screen gate above exist precisely to make high-volume days cheaper.
```

Replace with:

```
- **Plan limits are windows, not balances.** On a subscription you get rolling usage windows rather than a credit balance, so a heavy scan can pause you until the window resets. career-ops already defaults to the cheapest model for exactly this reason.
```

- [ ] **Step 3: Verify no `spend_tier` reference remains**

Run: `grep -n "spend_tier" docs/RUNNING_ON_A_BUDGET.md`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add docs/RUNNING_ON_A_BUDGET.md
git commit -m "$(cat <<'EOF'
docs(budget): rewrite the spend-tier section, no tier to pick anymore

career-ops always runs the cheapest model now -- the budget guide's
"pick your tier" section becomes a one-line statement of that fact.
The rest of the doc (non-Claude-Code CLI routing, local-model
tradeoffs, the worked cost example) is unrelated and untouched.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Final verification sweep

This task has no code of its own — it's the check that every earlier task's deletions actually add up to "spend_tier is gone everywhere it should be, and nowhere it shouldn't."

**Files:** none modified.

**Interfaces:** none.

- [ ] **Step 1: Repo-wide grep for `spend_tier`**

Run: `grep -rln "spend_tier" --include="*.md" --include="*.mjs" --include="*.sh" --include="*.yml" --exclude-dir=workspaces --exclude-dir=archive --exclude-dir=".tmp-script-test-*" --exclude-dir=node_modules --exclude-dir=.git .`

(The exclusions matter: `workspaces/*/config/profile.yml` is real, untracked per-candidate user data that legitimately still has the key — see Global Constraints — and `archive/`/`.tmp-script-test-*` are untracked historical/scratch content unrelated to this plan. Without excluding them, the raw grep also lists several `workspaces/*/config/profile.yml` files and an `archive/2026-08-03-adhoc-batch-pipeline/` batch config — none of that is a defect; it's just noise this command should not be reading in the first place.)

Expected output is EXACTLY this set of files (order may vary) — every one is an explicitly out-of-scope historical document or fixture per the spec's Section 10 and this plan's Global Constraints, not a live-behavior file:

```
./CHANGELOG.md
./docs/superpowers/plans/2026-08-18-telegram-router-onboarding.md
./docs/superpowers/plans/2026-08-25-workday-account-creation.md
./docs/superpowers/plans/2026-08-28-profile-settings-industry-targeting.md
./docs/superpowers/specs/2026-08-28-profile-settings-industry-targeting-design.md
./docs/superpowers/specs/2026-09-02-admin-overview-design.md
./docs/superpowers/specs/2026-09-08-apply-playwright-delegation-guard-design.md
./docs/superpowers/specs/2026-09-10-remove-spend-tier-design.md
./test-fixtures/upgrade/state-v1.16/config/profile.yml
./test-fixtures/upgrade/state-v1.18/config/profile.yml
```

(`docs/superpowers/plans/2026-09-10-remove-spend-tier.md` — this plan itself — will also match, since it necessarily quotes the old text it's replacing; that's expected and fine. Two other historical plan docs — `docs/superpowers/plans/2026-08-20-onboarding-completeness-guardrails.md` and `docs/superpowers/plans/2026-09-02-ollama-cloud-delegation.md` — discuss tier names in prose but don't happen to contain the literal string `spend_tier`, so they won't appear in this grep's output; that's fine too, they're equally out of scope and equally untouched.)

If any file OTHER than the ones listed above (and this plan file) appears, stop — an earlier task's edit was incomplete. Re-open that file, find the remaining reference, and fix it following the same pattern as the task that was supposed to cover it (Tasks 1-3, 6-7 above) before continuing.

- [ ] **Step 2: Run the full test suite one more time**

Run: `node core/test-all.mjs`
Expected: all tests pass (the summary line's failed count is 0).

- [ ] **Step 3: Record the required post-merge operational step**

This step is documentation, not code — there is nothing to commit for it, because `workspaces/*` is gitignored and does not exist inside this branch's worktree. Once this plan's branch is merged back into the checkout that has real provisioned workspaces on disk (per `core/AGENTS.md`'s `SYSTEM_FILE_COPIES` rule, triggered by Task 5's `.claude/settings.json` change), run:

```bash
node core/backfill-templates.mjs --all --apply
```

from that checkout's repo root. This propagates the new `"model": "haiku"` key in `.claude/settings.json` to every already-provisioned workspace. Until this runs, an already-provisioned workspace's own `.claude/settings.json` keeps its old content (no `model` key), so a user's interactive `claude` session there stays on the account default — the daemon-driven (Telegram) path is unaffected either way, since Task 4's `dispatchOne` fix does not depend on this file.

No commit for this step — surface it to whoever runs `finishing-a-development-branch` for this plan's branch, so they run it right after the merge.
