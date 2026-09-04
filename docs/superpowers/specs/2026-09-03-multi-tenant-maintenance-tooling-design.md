# Multi-Tenant Maintenance Tooling — Design

**Status:** Approved, pending implementation plan
**Date:** 2026-09-03
**Author:** Roberto Alevás Vásquez (via Claude)

## Context

`docs/superpowers/specs/2026-08-15-workspace-multitenancy-core-design.md` and
`docs/superpowers/specs/2026-08-18-telegram-router-onboarding-design.md` built
and shipped the multi-tenancy core: `workspaces/{slug}/` directories with real
per-tenant User Layer files and directory junctions into a shared System
Layer (`core/`, `modes/`, `templates/`, `providers/`, `plugins/`, `docs/`),
plus the Telegram router, access-code gate, and conversational onboarding
flow that provisions a new workspace end-to-end.

This is a proactive checkup of that architecture now that it has been running
in production for four workspaces (`ernesto-vasquez`, `leonie`,
`roberto-vasquez`, `thomas-acosta`) rather than a response to any specific
incident.

**Empirical findings that shaped this design** (verified 2026-09-03, not
assumed):

- All 4 live workspaces' directory junctions were checked against
  `JUNCTION_DIRS`/`SYSTEM_PATHS` and match exactly.
  `core/validate-system-paths-coverage.mjs` passes (`OK: 1048 tracked files
  covered`).
- Because the shared System Layer is junctioned (not copied) into every
  workspace, any edit to `core/*.mjs` or `modes/*.md` is instantly live for
  every existing workspace with no sync step — this was the core design's
  whole point, and it is working as designed. **This is not a gap and this
  design does not touch it.**
- `provision-workspace.mjs --repair-all` already exists for the rare case a
  brand-new top-level System Layer directory is added after workspaces were
  already provisioned.
- The one real gap: `config/profile.yml` and `portals.yml` are **real,
  per-workspace files seeded once** from `config/profile.example.yml` /
  `templates/portals.example.yml` at onboarding time. Junctions cannot help
  here — these are genuine per-user data — so a field added to a template
  *after* a workspace already exists never reaches that workspace.
- `core/admin-overview-snapshot.mjs` already exports a `listWorkspaces(reposRoot)`
  helper (slug, displayName, chatId, createdAt, dir) used by the admin
  overview. Both new tools in this design reuse it rather than re-deriving
  the workspace list a third time.
- `core/telegram-monitor.mjs` already exports `sendCannedReply(chatId, text,
  hook)` — a hub-global-safe send path (works even before a workspace's own
  `config/plugins.yml` exists, via `forceEnabled: true` scoped to the
  telegram plugin) already proven in the wrong-code/lockout path. No new
  Telegram-sending code is needed for the broadcast tool below.
- `doctor.mjs` already accepts `--target <path>` to run its full check
  against an arbitrary workspace directory instead of `cwd`. Its existing
  `checkTemplateLeftovers()` detects *unedited* values (a live field still
  byte-matching the template's example content) — a different concern from
  this design's backfill, which detects fields **structurally absent**
  from the live file entirely.

## Goals

- Existing workspaces automatically stay eligible to pick up new fields
  added to `config/profile.example.yml` / `templates/portals.example.yml`
  after they were provisioned, without an operator having to hand-edit each
  workspace's YAML or risk clobbering that person's own customizations.
- One command lets the operator (Roberto) check the health of every
  workspace at once, so a broken or out-of-date workspace is caught
  proactively rather than discovered when that user hits it.
- The operator can notify all bound Telegram users when a system change is
  worth telling them about, reusing the existing send path rather than
  building a new one.

## Non-goals

- Self-service / public onboarding, per-tenant billing, or any change aimed
  at scale beyond a small trusted circle (~20 people) — explicitly out of
  scope per this checkup's own framing.
- Automatic, unprompted triggering of any tool in this design off git
  commits or CI. All three are operator-invoked, matching this codebase's
  existing "flag, never auto-run" convention for maintenance scripts
  (`provision-workspace.mjs --repair-all` is the precedent).
- Backfilling `_profile.md` / `_brief.md` — these are free-form prose, not
  structured data, so "a field is structurally missing" doesn't apply to
  them. They stay covered by `doctor.mjs`'s existing leftover-content check.
- Any change to the junction/directory-junction mechanism itself, to
  `provision-workspace.mjs`'s existing behavior, or to the onboarding
  conversation flow — all confirmed working correctly and out of scope here.
- Two-way sync or conflict resolution for the backfilled fields — this is a
  one-directional, additive-only operation (template → live file), never
  the reverse.

## Architecture

### 1. Template-drift backfill (`core/backfill-templates.mjs`)

For a given workspace and a given (real file, template file) pair —
`(config/profile.yml, config/profile.example.yml)` and `(portals.yml,
templates/portals.example.yml)` — this walks the template's parsed YAML
recursively. For every key path present in the template:

- If the key path is **absent** from the live file at any depth, it is
  reported as missing (`--check`) or added with the template's value
  (`--apply`).
- If the key path **exists** in the live file already — regardless of its
  value, including `null`/`false`/an empty array — it is left untouched.
  This mirrors `provision-workspace.mjs --repair`'s additive-only
  philosophy for junctions: the tool only ever adds what's missing, never
  overwrites or removes. The flip side is worth stating plainly: a key a
  user *deliberately deleted* is structurally indistinguishable from one
  that was never set up, so `--apply` **will** re-add it — exactly as
  `--repair` recreates a junction someone deleted. That is a real limitation
  of a purely structural additive approach, not a protected use case:
  deleting a key is not a supported way to opt out of a field.
- **Type mismatches between the live value and the template's** are handled
  explicitly rather than crashing (a plain `setIn` throws "Expected YAML
  collection at X" on both shapes below):
  - Live parent holds **null** (`narrative:` with nothing under it, or an
    explicit `narrative: null`) where the template has a map: the null is
    promoted to an empty map and the template's child keys are inserted
    into it. A null carries no user data, so this is still additive-only.
    (Consequence: an explicit `null` opts out of a *leaf* key, which is
    left untouched, but not out of a *map*-valued one.)
  - Live parent holds a **real scalar or sequence** (`narrative: 1`) where
    the template has a map: a genuine type conflict. That path is skipped —
    never overwritten — and reported as an error for that file so a human
    resolves it. Sibling paths in the same file still apply normally.
- **Comments must survive.** `config/profile.example.yml` is 75% comments
  (259/346 lines) and `templates/portals.example.yml` is 42% comments
  (835/1976 lines) — real per-workspace files inherit that documentation.
  A plain parse-with-`js-yaml`-then-`yaml.dump()` round-trip would silently
  delete all of it; `core/fix-slugs.mjs` already treats exactly this
  problem as real enough to avoid (it edits `portals.yml` via raw text
  splicing rather than parse+dump, for the same reason). This design adds
  the `yaml` package (eemeli/yaml) as a new dependency and uses its
  `Document` API instead of `js-yaml`: `parseDocument()` on both the live
  file and the template, walk the template's `YAMLMap` structure to find
  key paths present in the template but absent from the live document
  (stopping at the shallowest missing point — a whole missing subtree is
  copied in one step, not rebuilt key-by-key), then `liveDoc.setIn(path,
  templateDoc.getIn(path, true).clone())` for each and `liveDoc.toString()`
  to write back. Because the inserted value is a cloned `yaml` Node (not a
  plain JS value), its attached comments move with it; everything else in
  the live document's CST is untouched, so existing comments and untouched
  values survive. Incidental formatting elsewhere in the file (e.g.
  flow-collection spacing) may be renormalized by the round-trip — the
  guarantee is comment and value preservation, not a byte-identical diff.

**CLI:**
```
node core/backfill-templates.mjs <slug> --check          # report only, exit 1 if anything missing
node core/backfill-templates.mjs <slug> --apply          # write missing keys
node core/backfill-templates.mjs --all --check           # every workspace via listWorkspaces()
node core/backfill-templates.mjs --all --apply
```

Output (`--check`, human-readable):
```
roberto-vasquez: config/profile.yml missing narrative.deal_breakers; portals.yml up to date
thomas-acosta: up to date
```

A `--json` flag mirrors `doctor.mjs`'s convention, for use by the health
check below.

### 2. Cross-workspace health check (`core/doctor-all.mjs`)

A thin aggregator, not a rewrite of `doctor.mjs`:

- Calls `listWorkspaces()` (imported from `admin-overview-snapshot.mjs`) to
  get every workspace's `slug` and `dir`.
- For each workspace, spawns `node core/doctor.mjs --json --target <dir>`
  (no changes needed to `doctor.mjs` itself — `--target` already exists)
  and `node core/backfill-templates.mjs <slug> --check --json` from part 1.
- Aggregates into one report per workspace: prereq status, `warnings`,
  `templateLeftovers` (unedited-value findings), and the new template-drift
  findings (structurally-missing fields) — plus a one-line summary such as
  `4/4 workspaces healthy` or `1 workspace needs attention: thomas-acosta
  (2 missing template fields)`.
- `--json` for scripting; a plain-text table by default.
- Never calls `applyWorkspace` — the two backfill target files
  (`config/profile.yml`, `portals.yml`) are only ever read here; writing
  them stays a deliberate, separate `backfill-templates.mjs --apply`
  invocation. **This does not extend to `doctor.mjs` itself**: `doctor.mjs
  --json`'s existing, pre-existing `onboardingState()` auto-copies
  `_profile.md`/`_custom.md`/`_brief.md` from their templates into the
  target directory whenever one is missing and its template is reachable —
  the same idempotent, one-time side effect any direct `doctor.mjs --json`
  invocation already has (including the mandatory AGENTS.md session-start
  check). `doctor-all.mjs` inherits this unchanged, since it must invoke
  `doctor.mjs` unmodified (no reusable export exists) rather than
  reimplementing its checks. It is never silent: `doctor.mjs`'s own
  `autoCopied` field is passed through in each workspace's aggregated
  result and surfaced in the human-readable summary line whenever
  non-empty.

### 3. "What's new" broadcast (`core/broadcast.mjs`)

- Calls `listWorkspaces()` to get every workspace's `chatId`.
- Sends the given message to each via the existing
  `sendCannedReply(chatId, text)` from `telegram-monitor.mjs` — reused
  as-is, no new Telegram-sending code.
- `--dry-run` lists the recipients (slug + display name) without sending,
  since this is a real one-to-many message to real people and deserves a
  preview step.
- Skips (and reports) any workspace whose `workspace.json` has no
  `chat_id` yet (mid-onboarding), rather than erroring the whole run.

**CLI:**
```
node core/broadcast.mjs "New: apply mode now supports persistent browser sessions." --dry-run
node core/broadcast.mjs "New: apply mode now supports persistent browser sessions."
```

## Data flow

```
config/profile.example.yml  ─┐
templates/portals.example.yml┴─► backfill-templates.mjs --check/--apply ──► workspaces/{slug}/{config/profile.yml,portals.yml}
                                              │
                                              ▼ (--json, consumed by)
workspaces/*/workspace.json ──► listWorkspaces() ──► doctor-all.mjs ──► aggregated health report (stdout/JSON)
                                              │
                                              └─► broadcast.mjs ──► sendCannedReply() ──► Telegram chat_id (per workspace)
```

## Error handling

- `backfill-templates.mjs`: a malformed live YAML file is reported as an
  error for that workspace and skipped (never partially written); does not
  abort an `--all` run — matches `doctor.mjs`'s existing per-check
  isolation.
- `doctor-all.mjs`: a single workspace's `doctor.mjs`/`backfill-templates.mjs`
  subprocess failing (non-zero exit, crash) is captured and reported as that
  workspace's status, not thrown — one broken workspace must never stop the
  aggregate report on the other N-1.
- `broadcast.mjs`: a single `sendCannedReply` failure (already reported
  in-band per `telegram-monitor.mjs`'s existing pattern, not a thrown
  exception) is logged per-recipient and does not stop the remaining sends.

## Testing

- `backfill-templates.mjs`: unit coverage for — a key missing at top level
  is added; a key missing in a nested map is added without disturbing
  sibling keys; an existing key (including falsy values) is never modified;
  `--check` reports without writing; `--apply` writes; malformed YAML is
  reported as an error, not thrown; **a live file's pre-existing comments
  and untouched keys survive a backfill write**
  (regression coverage for the comment-loss risk this design specifically
  avoids by using the `yaml` package instead of `js-yaml`).
- `doctor-all.mjs`: coverage that it aggregates N workspace fixtures
  correctly, that one failing workspace doesn't suppress the others'
  results, and that the summary line matches the per-workspace detail.
- `broadcast.mjs`: coverage that `--dry-run` sends nothing, that
  `sendCannedReply` is called once per workspace with a `chat_id`, that a
  workspace with no `chat_id` is skipped and reported rather than erroring.
- Existing `test-all.mjs` / fixture conventions (`seed-fixture.mjs`,
  `test-fixtures/`) extended for these three scripts rather than
  duplicated.

## Migration

None required. All three tools operate on the existing four workspaces as
they are today; running `backfill-templates.mjs --all --check` immediately
after this ships will report zero drift for all four (since no template
field has changed since their onboarding) and serves as the first
regression check that the tool works correctly on real data.
