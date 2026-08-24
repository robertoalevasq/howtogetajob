# Apply One-at-a-Time Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `modes/apply.md`'s field-collection flow so genuinely new questions are asked one at a time (pick-list when the field has real options) instead of batched into one bulk block, with a consolidated answered/missed summary as the review checkpoint before the form is filled.

**Architecture:** A new Step 6c (one-at-a-time collection loop) sits between the existing Step 6 (Analyze) and Step 7 (Generate). It reuses `modes/telegram.md`'s existing `stage: question` pending-confirmation pattern verbatim — no new state-machine type. Step 7's output changes from a single bulk block with inline `"Ask candidate: ..."` placeholders to a categorized summary (auto-filled / collected this run / generated / missed), since by the time Step 7 runs, Step 6c has already resolved every field that needed asking.

**Tech Stack:** Agent-instruction Markdown mode files (not executable code).

**Spec:** `docs/superpowers/specs/2026-08-24-apply-one-at-a-time-collection-design.md`

## Global Constraints

- No new `data/telegram-state.md` pending-confirmation stage type — every one-at-a-time question reuses the existing `stage: question` pattern.
- No change to the three-gate approval model (resume-approval → field-approval → submit-approval) or their ordering.
- No new cacheable categories added to Step 6b's Field Matching Reference table — only the interaction pattern for asking about an uncached field changes.
- No change to Step 7b's mechanical Playwright-fill logic.
- Step 5's preflight gates (blacklist, cross-channel, repeat-application, reachability, freshness) are untouched — this plan only restructures Step 6/6b/7's form-question collection.
- After each task: run `node core/test-all.mjs` and confirm no new failures (a known, pre-existing, unrelated failure — "SYSTEM_PATHS coverage gap: .mcp.json, archive/.gitkeep" — predates this plan and is not in scope).

---

### Task 1: `modes/apply.md` — Step 6 update, new Step 6c, Step 7 rewrite

**Files:**
- Modify: `modes/apply.md`

**Interfaces:**
- Produces: a new `## Step 6c — One-at-a-time question collection` section between Step 6b and Step 7, which `modes/telegram.md` (Task 2) references by name.
- Produces: Step 7's new output-format category names (`Auto-filled`, `Collected this run`, `Generated`, `Missed`), which `modes/telegram.md` (Task 2) must reference consistently instead of its current `auto-fill / proposed / needs-input` wording.

Read the current `modes/apply.md` in full before editing (it may have drifted slightly from the excerpts below since spec-writing time). All three edits below sit in the same contiguous region of the file (Step 6 through Step 7's output format) — make them together, then read the whole region back to confirm it flows as one coherent sequence.

- [ ] **Step 1: Update Step 6's `needs_candidate_confirmation` contract and its closing paragraph**

Find Step 6's `needs_candidate_confirmation` bullet (inside the "For each field, preserve the application form contract" list) — currently:

```markdown
- `needs_candidate_confirmation`: `yes` for legal, demographic, work authorization, visa, relocation, salary, disability, veteran, sponsorship, background-check, or self-identification questions unless the answer is explicitly present in `config/profile.yml` **or already cached as a boilerplate default in `data/application-defaults.md`** (see Step 6b — administrivia categories only; salary and anything role-specific are never cached)
```

Replace with:

```markdown
- `needs_candidate_confirmation`: `yes` for legal, demographic, work authorization, visa, relocation, salary, disability, veteran, sponsorship, background-check, or self-identification questions unless the answer is explicitly present in `config/profile.yml`, already cached as a boilerplate default in `data/application-defaults.md` (see Step 6b — administrivia categories only; salary and anything role-specific are never cached), or already answered earlier in this same conversation (e.g. the same field surfaced twice via an edit-loop or a re-scan — reuse that answer, never ask twice in one run)
```

Then find Step 6's closing paragraph — currently:

```markdown
Never invent answers for legal, demographic, work-authorization, visa/sponsorship, salary, disability, veteran, background-check, relocation, or self-identification fields. If the answer is not present in `config/profile.yml`, not already cached per Step 6b, or not in visible context, mark it as needing candidate confirmation and provide the safest question to ask the candidate.
```

Replace with:

```markdown
Never invent answers for legal, demographic, work-authorization, visa/sponsorship, salary, disability, veteran, background-check, relocation, or self-identification fields. Every field marked `needs_candidate_confirmation: yes` here goes to Step 6c, one at a time — never batched into a single bulk question, and never answered on the candidate's behalf.
```

- [ ] **Step 2: Insert the new Step 6c between Step 6b and Step 7**

Find the boundary between Step 6b's closing template code block (ends with `​```` right after `## Custom Answers` / `<!-- appended as new recurring boilerplate fields are confirmed -->`) and the `## Step 7 — Generate responses` heading. Insert this new section between them:

```markdown
## Step 6c — One-at-a-time question collection

Every field Step 6 marked `needs_candidate_confirmation: yes` and Step 6b couldn't resolve from the cache reaches this step. Ask about them one at a time — never as a batch, never folded into Step 7's summary output. This is the same "stop, ask, resume from exactly this point" pattern this mode already uses for a Step 5/5b/5c/5d/5e preflight question; `modes/telegram.md` routes each one through its existing `stage: question` pending confirmation, with no special handling needed beyond what that mechanism already does.

1. Take the next unresolved field marked `needs_candidate_confirmation: yes` (skip any already resolved by Step 6's cache/profile/session-answered checks — this step only ever sees what's left after those).
2. **If the field has visible `options` (select/radio/checkbox)**: present them as a numbered pick-list — e.g. "1) Option A  2) Option B  3) Option C — reply with a number, or 'skip'." Never ask this kind of field as open-ended free text when the real options are already known; a pick-list answer is faster for the candidate and guaranteed to be a value the form accepts.
3. **If the field has no fixed options** (free text, a number, a yes/no with no visible option list): ask it directly, in plain language, the safest phrasing for what's actually being asked — same tone this mode already uses for a Step 5b knock-out warning or a Step 5e freshness question.
4. Stop and wait for the reply (Telegram: this is a `stage: question` pending confirmation; interactively: a normal conversational pause).
5. **On a "skip" reply** (or a clear equivalent — "skip this," "not now," "n/a"): mark this field as missed, do not ask again this run, move to the next unresolved field. This is not treated as an ambiguous or rejected reply — it is a deliberate, explicit skip.
6. **On any other reply**: treat it as the answer. If the field is a boilerplate category (per Step 6b's list), cache it immediately per Step 6b #3 so it's never asked again on a future application. If the reply doesn't clearly answer the question asked (e.g. it reads as a question back, or an unrelated comment), ask one clarifying follow-up for this same field before moving on — never guess, never silently skip an unclear reply.
7. Repeat from step 1 until every field Step 6 flagged has been resolved (answered or explicitly skipped). Then continue to Step 7.

Never re-ask a field already resolved earlier in this same run, including one resolved by an answer to a *different* field's clarifying follow-up if that answer happens to also cover it (e.g. a candidate volunteering their veteran status while answering a different demographic question) — Step 6's "already answered earlier in this conversation" check applies here too, checked fresh before every question in this loop, not just once at the start.
```

- [ ] **Step 3: Rewrite Step 7's opening and output format**

Find Step 7's opening line — currently:

```markdown
## Step 7 — Generate responses

For each question, generate the response following:
```

Replace with:

```markdown
## Step 7 — Generate responses

By this point, every field Step 6 flagged as needing candidate confirmation has already been resolved — answered or explicitly skipped — by Step 6c. This step generates everything else (JD- and role-specific content Step 6c never touches: motivation/fit free text, salary within the profile's target range, anything else generated fresh from the report) and then produces ONE consolidated summary of the whole form, combining every source: cache/profile auto-fills, Step 6c's freshly-collected answers, this step's own fresh generation, and Step 6c's missed list. This summary is the review checkpoint — nothing gets filled (Step 7b) until it's approved.

For each JD-/role-specific question, generate the response following:
```

Then find Step 7's `**Output format:**` code block — currently:

````markdown
**Output format:**

```text
## Responses for [Company] — [Role]

Based on: Report #NNN | Score: X.X/5 | Archetype: [type]

---

### 1. [Exact form question]
> [Response ready for copy-paste, or "Ask candidate: ..." if the field needs confirmation]

### 2. [Next question]
> [Response]

...

---

Notes:
- [Any observations about the role, changes, etc.]
- [Personalization suggestions the candidate should review]
```
````

Replace with:

````markdown
**Output format:**

```text
## Responses for [Company] — [Role]

Based on: Report #NNN | Score: X.X/5 | Archetype: [type]

---

### Auto-filled (cache / profile)
- [Field]: [value]

### Collected this run
- [Field]: [value confirmed via Step 6c]

### Generated
- [Exact form question]
  > [Response ready for copy-paste]

### Missed
- [Field] — skipped in Step 6c; leave blank, finish manually before submitting.

---

Notes:
- [Any observations about the role, changes, etc.]
- [Personalization suggestions the candidate should review]
```
````

Omit any of the four categories entirely (heading and all) if it has no entries this run — an application with nothing missed should not show an empty "Missed" heading.

- [ ] **Step 4: Read the full Step 6 through Step 7 region back**

Read `modes/apply.md` from Step 6's heading through the end of Step 7's output format code block, top to bottom. Confirm: no duplicate/contradictory instructions, Step 6c is correctly positioned between Step 6b's template and Step 7's heading, Step 7's new opening correctly describes Step 6c as already having run, and the output format's four category names are used consistently (no leftover reference to the old "Ask candidate: ..." convention or the old numbered-question format anywhere in this region).

- [ ] **Step 5: Run the test suite**

Run: `node core/test-all.mjs`

Expected: no new failures beyond the one known pre-existing `SYSTEM_PATHS coverage gap: .mcp.json, archive/.gitkeep`. If any existing test asserts specific content/structure in `modes/apply.md` (check first: `grep -rn "modes/apply.md" tests/ core/test-all.mjs`), update it to match the new content in this same task.

- [ ] **Step 6: Commit**

```bash
git status
git diff --cached --stat
git commit --only modes/apply.md -m "feat: ask genuinely new application questions one at a time, summarize before filling"
```

---

### Task 2: `modes/telegram.md` — Step 3b clarifying updates

**Files:**
- Modify: `modes/telegram.md`

**Interfaces:**
- Consumes: Task 1's new `## Step 6c — One-at-a-time question collection` section name and Step 7's new category names (`Auto-filled`, `Collected this run`, `Generated`, `Missed`).
- Produces: nothing later tasks depend on.

Read the current `modes/telegram.md` Step 3b in full before editing (it may have drifted slightly since spec-writing time).

- [ ] **Step 1: Update Step 3b step 4's cross-reference**

Find Step 3b's numbered step 4 — currently:

```markdown
4. **Any point where `apply` mode would stop and ask the candidate something** (a Step 5 mismatch, a Step 5b knock-out warning, a Step 5e freshness-guard prompt, an ambiguous field in Step 6) becomes a `stage: question` pending confirmation instead of an in-session question: send the question text to Telegram, store it, and end this poll cycle. Resume from the same point once a reply arrives (Step 4).
```

Replace with:

```markdown
4. **Any point where `apply` mode would stop and ask the candidate something** (a Step 5 mismatch, a Step 5b knock-out warning, a Step 5e freshness-guard prompt, or one of Step 6c's one-at-a-time field questions) becomes a `stage: question` pending confirmation instead of an in-session question: send the question text to Telegram, store it, and end this poll cycle. Resume from the same point once a reply arrives (Step 4). A single application can produce a *sequence* of these — Step 6c asks its unresolved fields one at a time, so expect several `stage: question` round-trips in a row for one report before Step 5's next output (the field-approval message below) ever fires. Each one is independent and unremarkable; nothing about handling it differs from a single Step 5 preflight question.
```

- [ ] **Step 2: Update Step 3b step 5's category names**

Find Step 3b's numbered step 5 — currently:

```markdown
5. Once Step 7 produces the proposed field→value mapping, send it as the field-approval message (keep under 4000 chars — split into auto-fill / proposed / needs-input if longer, matching `apply` mode's own Step 7 output format), with a trailing `Reply "yes" to continue, "no" to skip, or tell me what to change.` hint — `apply` mode's own Step 7 format has no such line (it's written for an interactive session with no gate), so this mode adds it. Store a `stage: field-approval` pending confirmation with the report number, job URL, and the full mapping as JSON.
```

Replace with:

```markdown
5. Once Step 7 produces its consolidated summary — every field Step 6c already resolved, plus Step 7's own fresh generation, plus anything missed — send it as the field-approval message (keep under 4000 chars — split by `apply` mode's own Step 7 output-format categories, Auto-filled / Collected this run / Generated / Missed, if longer), with a trailing `Reply "yes" to continue, "no" to skip, or tell me what to change.` hint — `apply` mode's own Step 7 format has no such line (it's written for an interactive session with no gate), so this mode adds it. Store a `stage: field-approval` pending confirmation with the report number, job URL, and the full summary as JSON.
```

- [ ] **Step 3: Read Step 3b back in full**

Read the whole of Step 3b (steps 0 through 6) top to bottom. Confirm the two edits read coherently with the surrounding unchanged steps — step 4's mention of Step 6c and step 5's category names should feel like a natural continuation, not a jarring insertion.

- [ ] **Step 4: Run the test suite**

Run: `node core/test-all.mjs`

Expected: no new failures beyond the known pre-existing one. Check first whether any existing test asserts specific content/structure in `modes/telegram.md` before assuming none exists.

- [ ] **Step 5: Commit**

```bash
git status
git diff --cached --stat
git commit --only modes/telegram.md -m "docs: reflect apply mode's one-at-a-time question loop in the telegram wrapper"
```

---

### Task 3: Final verification

**Files:** none modified (verification only) — unless Step 1 or 2 below surfaces something genuinely incomplete, in which case fix it here, scoped, with proper staging.

**Interfaces:**
- Consumes: the complete state of Task 1 and Task 2.
- Produces: the plan's exit criteria.

- [ ] **Step 1: Full test suite, against the complete combined state**

```bash
node core/test-all.mjs
```

Expected: no new failures beyond the known pre-existing `SYSTEM_PATHS coverage gap: .mcp.json, archive/.gitkeep`.

- [ ] **Step 2: Manual walkthrough — does the new flow actually behave as designed?**

Read `modes/apply.md`'s Step 6 → Step 6c → Step 7 sequence and `modes/telegram.md`'s Step 3b top to bottom, together, and trace a hypothetical application with 3 boilerplate fields (one already cached, two genuinely new) plus 1 salary field (JD-specific, never cached) through the whole sequence:

1. Step 6 classifies all 4 fields; the cached one resolves immediately, the 2 new boilerplate fields and the salary field are NOT resolved yet.
2. Step 6c asks about the 2 new boilerplate fields one at a time (pick-list if they have options), caching each confirmed answer. The salary field is JD-specific — confirm it does NOT get asked by Step 6c (Step 6b #4's "never cache" rule for salary should mean Step 6 never even flags it `needs_candidate_confirmation` for Step 6c to pick up — verify this reasoning holds by re-reading Step 6b's existing behavior for salary).
3. Step 7 generates the salary answer fresh from the report + profile, and produces the summary: cached field under "Auto-filled," the 2 newly-answered fields under "Collected this run," salary under "Generated," nothing under "Missed" (all 4 resolved in this example).
4. In Telegram: this produces 2 `stage: question` round-trips (one per new boilerplate field) followed by one `stage: field-approval` message containing the 4-field summary — trace this against Step 3b's updated steps 4-5.

This step produces no code change — it's a documented sanity check that the two tasks, read together, actually implement the design coherently. If something looks incomplete or contradictory during this trace, that's a real finding: fix it before calling this task done, don't just note it and move on.

- [ ] **Step 3: Re-check against the 2026-08-21 incident, per the spec's own Testing section**

Confirm the new Step 6c doesn't interact with or weaken Step 5's Reachability check (added by an earlier, separate plan) — Step 6c only ever runs after Step 5's entire preflight (including Reachability) has already resolved, since Step 6 (which feeds Step 6c) only runs once Step 5 is cleared. This should be a one-line confirmation, not a design change — Step 5 and Step 6c operate on fully disjoint parts of the flow.

- [ ] **Step 4: Commit (only if Step 1 or 2 required a fix)**

```bash
git status
git diff --cached --stat
git commit --only <specific files> -m "fix: address gaps found in final verification of the one-at-a-time collection flow"
```

If Steps 1-3 found nothing to fix, there's nothing to commit here — this task is verification-only.
