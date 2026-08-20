# Onboarding Completeness & Tailoring Guardrails — Design

**Status:** Approved, pending implementation plan
**Date:** 2026-08-20
**Author:** Roberto Alevás Vásquez (via Claude)

## Context

A live end-to-end test of Telegram onboarding (`modes/telegram-onboarding.md`,
built by `docs/superpowers/specs/2026-08-18-telegram-router-onboarding-design.md`)
surfaced five real gaps during a manual post-onboarding audit, all fixed
individually this session, all sharing one root cause: the mode's
instructions were narrower than what a real conversation actually contains,
so unedited template placeholder content or volunteered candidate
information silently survived into the finished workspace:

1. `config/profile.yml`'s `candidate.linkedin/github/twitter` and
   `narrative.*` fields kept the template's fabricated "Jane Smith"/fake
   SaaS-exit content — the instruction said "fill in target roles, location,
   salary" and never mentioned these other fields.
2. `config/profile.example.yml`'s `cover_letter.primary_domain`/
   `language_learning` shipped active (not commented-out) with fake example
   data — a template-level bug, not specific to Telegram.
3. `portals.yml`'s `title_filter.positive` kept the template's AI/ML-focused
   example keywords, meaning scanning would search for the wrong jobs
   entirely.
4. `_profile.md` and `_brief.md` — both seeded from templates by
   provisioning exactly like `portals.yml` — were never touched at all.
   `_profile.md`'s archetype tables (which drive real scoring per
   `core/AGENTS.md`) stayed generic AI/LLMOps content; `_brief.md` (read by
   `modes/triage.md` on every first-pass filtering decision) stayed 100%
   unfilled `{placeholder}` text.
5. A reply naming four acceptable locations ("Tampa, anywhere in
   California, Chicago, Pittsburgh") only had the one asked about for
   timezone purposes captured anywhere — `compensation.location_flexibility`
   stayed blank, silently dropping real information the candidate gave.

Each was fixed by hand, one at a time, by re-reading the finished workspace
field-by-field against what the conversation actually contained. That
process doesn't scale to future onboardings of people who aren't the system
operator, and nothing currently stops a sixth instance of the same failure
class. Separately, the resulting profiles are noticeably thinner than an
established user's (`workspaces/roberto/`'s `_profile.md` and `_custom.md`
are 13KB/27KB of accumulated customization vs. a fresh onboarding's ~5KB of
mostly generic template scaffolding) — some of that gap is inherent (Ernesto
accumulated his over weeks of ongoing use, not a single 5-minute setup
conversation), but part of it is content Telegram onboarding could
reasonably capture and currently doesn't.

This spec covers two complementary fixes: a deterministic completeness
guardrail that catches the first failure class (leftover template/fabricated
content) objectively, and a small set of conversation and content changes
that close the specific information-loss and shallow-profile gaps found.

## Goals

- Nothing that still byte-matches an unedited template's placeholder value
  survives to a bound, "ready to search" workspace — for both the Telegram
  onboarding path and the existing interactive/manual path in
  `core/AGENTS.md`.
- A reply naming more than one relevant fact (e.g. multiple acceptable
  locations) doesn't lose everything but the first one asked about.
- The two structured, high-value fields a CV genuinely can't answer
  (a professional headline, a self-described top strength) get an
  optional, skippable chance to be captured — without adding required
  turns to a flow already tuned for speed.
- Content already available (the CV's own strongest quantified
  achievements) gets used more fully before asking the candidate to repeat
  themselves in a new question.
- Any residual gap the guardrail can't self-correct is visible to the
  operator afterward, without blocking or confusing the person being
  onboarded.

## Non-goals

- Matching an established user's full depth of customization
  (`_custom.md`'s house rules, `_brief.md`'s hard disqualifiers and
  priority-company overrides, `_profile.md`'s exit story) at onboarding
  time. These need lived preferences or a real story a first conversation
  can't responsibly front-load without fabricating — the completion
  message invites filling these in over time instead.
- Making Telegram onboarding as deep as `core/AGENTS.md`'s full interactive
  "Get to know the user" question set (superpower, what excites/drains you,
  deal-breakers, best achievement, published work). That directly conflicts
  with this session's earlier speed feedback; only the two fields a CV
  can't substitute for (headline, top strength) get an optional question.
- A general-purpose "content quality" or "how good is this CV" grader.
  The guardrail detects **unedited template leftovers**, a narrow,
  deterministic, false-positive-resistant signal — it does not evaluate
  whether filled-in content is well-written or complete in some broader
  sense.

## Architecture

Two independent mechanisms, each addressing a different failure class
found in the audit:

**Guardrail A — deterministic completeness check**, added to
`core/doctor.mjs`, catches "this still matches the unedited template."
Runs for every workspace, on every `doctor.mjs` invocation, regardless of
which onboarding path produced it — so it protects the interactive flow
and guards against future template drift, not just Telegram onboarding.

**Guardrail B — conversational changes**, entirely inside
`modes/telegram-onboarding.md`: a read-back/confirm step before any file is
written (closes the information-loss class, which a template diff
structurally cannot catch — a wrong-but-different-from-template value never
flags), one optional low-friction question for headline/top-strength, and
fuller use of CV content already collected for `narrative.proof_points`.

The two are independent: A would still be worth having even if B didn't
exist (it also protects the interactive path and catches drift), and B
closes bugs A can't detect by design (extraction/omission, not leftover
templates).

## Component: `core/doctor.mjs` — `checkTemplateLeftovers(root)`

New function added to the existing `checks[]` array, same `{pass, warn,
label, fix}` shape every other check already uses. **WARN-level, never a
hard failure** — matching how `checkPrereq` already treats user-layer
content as advisory, not blocking. A workspace with residual leftovers is
still usable; it's just weaker than it should be.

Two detection modes, chosen per file based on how each template already
marks its own placeholders:

**Template-equality diff** (`config/profile.yml`, `portals.yml`,
`_profile.md`): for a short, fixed list of candidate-identity
fields/sections, compare the workspace's live value against the
**current** template file's value at that same spot:

| File | Checked path/section |
|------|----------------------|
| `config/profile.yml` | `candidate.linkedin`, `candidate.github`, `candidate.twitter`, `target_roles.primary`, `narrative.superpowers`, `narrative.proof_points` |
| `portals.yml` | `title_filter.positive` |
| `_profile.md` | "Your Target Roles" table, "Your Adaptive Framing" table |

A value is flagged only if it's **byte-identical to the template's
current placeholder value**. A blank string or empty array never flags —
blank is an already-established, legitimate "no real answer yet" state
(e.g. `narrative.headline: ""` is correct, not a bug). This makes the
check self-maintaining: if a template's wording changes later, the check
adapts automatically, with no hardcoded string list to remember to update.

**Placeholder-bracket regex** (`_brief.md` only): this template already
marks its own fill-in spots with `{like this}` syntax. A regex for any
remaining `{...}` outside the file's own instructional HTML comment block
(`<!-- ... -->`) catches leftover placeholders directly — no template
comparison needed, and it's naturally immune to future wording changes in
the template's prose.

**`--json` output:** `doctor.mjs`'s existing `--json` payload
(`onboardingState()`) gains a new key, `templateLeftovers`: an array of
`{ file, label, fix }` for any WARN-level findings from this check, empty
when clean. This reuses the existing `--target <dir>` override (already
used by the test suite to point `doctor.mjs` at a simulated environment),
so Telegram onboarding can run:

```bash
node core/doctor.mjs --target workspaces/{slug} --json
```

and read `.templateLeftovers` directly, without parsing human-readable
console output.

**Interactive path parity:** `core/AGENTS.md`'s "Step 6: Ready" now
re-runs `node doctor.mjs` before declaring "You're all set," the same way
Telegram onboarding does (below) — a human is present on that path, so any
WARN just surfaces the same way every other `doctor.mjs` warning already
does today; no retry/self-correction logic is needed there.

## Component: `modes/telegram-onboarding.md` changes

**1. Confirm-before-write step** (new, inserted right after parsing the
roles/location/salary reply, before Step 4's file edits begin): send a
one-message summary of what was extracted —

> `Got it — here's what I have: Roles: {roles}. Primary location: {city} (also open to: {others, if any}). Target comp: {range}. Reply "yes" to continue, or tell me what to fix.`

— and wait for confirmation before writing anything. A correction
re-parses and re-sends the summary; no retry cap needed here, it's an
ordinary back-and-forth with the person, not a self-correction loop. This
mirrors `modes/telegram.md`'s existing confirm-before-write pattern for
`/apply` (resume → form fields → final review, each requiring an explicit
yes) — the same discipline already established elsewhere in this exact
codebase, applied earlier in the flow. This is what would have caught gap
5 (locations) at the source: the candidate, not a script, is the one who
notices "wait, you dropped three of my four locations."

**2. `narrative.proof_points` auto-derivation** (Step 4 addition, no new
question): after converting the CV in Step 3, extract 2-3 of its most
quantified achievements (the same source `_brief.md`'s Proof Points
section already draws from — e.g. "15+ dashboards delivered for 5
departments," "91% accuracy classification model") into
`narrative.proof_points`, using the template's existing `{name,
hero_metric}` shape. Content already collected, reused more fully — no
added conversation turn.

**3. Completeness check + bounded self-correction** (end of Step 4,
before advancing to the spend-tier question): run

```bash
node core/doctor.mjs --target workspaces/{slug} --json
```

and inspect `.templateLeftovers`. If non-empty: re-edit the flagged
fields/files using data already in the conversation (no new question to
the candidate — this is self-correction against information already
gathered, not a wait on a reply), then re-run the same check once. If
still non-empty after that one retry: proceed anyway (never leave a real
person stuck mid-setup on an internal QA issue) but append one line to
`data/onboarding-gaps.log` (hub-global, repo root, gitignored like the
rest of `data/`):

```
2026-08-20T13:04:00Z chatId=491507842 slug=roberto-2 fields=_profile.md:target-roles-table
```

Matches this codebase's established "flag, never silently hide" data
convention (`data/blacklist.md`, agent-inbox) — visible to the operator on
request, never surfaced to or blocking the candidate.

**4. Optional headline/strength question** (new, after the confirm step,
before the spend-tier question): send —

> `One more optional thing — in a line or two, how would you pitch yourself professionally, and what's your #1 strength that sets you apart? Reply "skip" to finish now — you can always tell me more later.`

If skipped: leave `narrative.headline`/`narrative.superpowers` blank
(today's behavior, still correct — no fabrication). If answered: write it
to those fields **lightly polished, not verbatim and not embellished** —
fix grammar/phrasing/conciseness for a professional tone, but preserve
every factual claim exactly as given and never add a claim, metric, or
descriptor the candidate didn't state. This is the same "keywords get
reformulated, never fabricated" discipline `core/AGENTS.md`'s Source-of-
Truth Boundary already requires everywhere else in this system (CV
tailoring, cover letters) — applied here to a candidate's own self-
description instead of CV bullets. A single strength becomes a
one-item `narrative.superpowers` list; multiple strengths in one reply
split into separate list items, each polished the same way.

**5. Completion message addendum:** one line before/after the existing
fixed help text (`modes/telegram.md` Step 3g's block, still quoted
verbatim, never duplicated) inviting ongoing enrichment for whatever's
still deliberately blank:

> `The more you tell me about yourself over time, the smarter this gets — just message me anytime.`

## Data Flow

```
Step 3 (CV) ─→ Step 3.5 (roles/location/salary) ─→ CONFIRM (new)
                                                        │ yes
                                                        ▼
                                    Step 4: write profile.yml, portals.yml,
                                    _profile.md, _brief.md (incl. auto-
                                    derived proof_points)
                                                        │
                                                        ▼
                                    doctor.mjs --target ... --json
                                                        │
                                          ┌── clean ────┴──── leftovers ──┐
                                          │                               ▼
                                          │                    self-correct once,
                                          │                    re-check
                                          │                               │
                                          │                  ┌─ clean ────┴─ still flagged ─┐
                                          │                  │                               ▼
                                          │                  │                  log to onboarding-gaps.log
                                          ▼                  ▼                               │
                                          └──────────────────┴───────────────────────────────┘
                                                                        │
                                                                        ▼
                                          OPTIONAL headline/strength question (new)
                                                                        │
                                                                        ▼
                                          Step 5 (spend tier + Discord) → Step 6 (bind, finish)
```

## Error Handling

- `doctor.mjs --target ... --json` failing to run at all (unexpected
  crash, not a content warning) is treated like any other Step 4 tool
  failure per the mode's existing "Error handling" section: send the
  standard `⚠️ Something went wrong` message, leave `currentStep`
  unchanged, stop the turn. It does not fall through to "proceed anyway"
  — that fallback is specifically for a *clean run that still found
  leftovers*, not for the check itself failing to execute.
- The confirm step's correction loop has no retry cap (unlike the
  self-correction retry) because it's bounded by the same person
  answering, not by an autonomous loop — if they keep correcting, that's
  legitimate back-and-forth, not a stuck process.
- The optional headline/strength question follows the same "skip" pattern
  already established for the Discord webhook question — no new escape
  hatch needed.

## Testing

- `core/doctor.mjs`'s test suite gains cases for `checkTemplateLeftovers`:
  an unedited-template workspace flags all four files; a correctly-filled
  workspace (the now-fixed `roberto-2`) flags nothing; a workspace with
  legitimately-blank fields (empty `narrative.headline`, empty
  `_brief.md` sections written as "none specified yet" prose, no bracket
  placeholders) flags nothing — proving blank isn't mistaken for
  leftover.
- A `--json` test confirms the `templateLeftovers` key appears with the
  right shape for both a clean and a dirty `--target` workspace.
- `tests/telegram-onboarding-mode.test.mjs` gains assertions that the mode
  file documents: the confirm-before-write step, the `doctor.mjs`
  completeness check + one bounded retry + `data/onboarding-gaps.log`
  format, the optional headline/strength question with its "skip"
  default, the "reformulate never fabricate" polishing constraint, and
  `narrative.proof_points` auto-derivation from the CV.
- `core/AGENTS.md`'s own test coverage (if any references Step 6) gains
  an assertion that it now re-runs `doctor.mjs` before the "You're all
  set" message.
