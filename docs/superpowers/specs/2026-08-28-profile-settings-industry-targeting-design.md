# Profile Settings Command + Industry-Based Targeting — Design

**Date:** 2026-08-28
**Status:** Approved for planning

## Problem

Two related gaps, both surfaced by real candidates using the live Telegram bot:

1. **No way to change profile settings after onboarding.** Location, work-mode preference (remote/hybrid/onsite), target roles, salary target, and sponsorship status are all set once during `telegram-onboarding.md` and then frozen — a candidate who changes their mind (e.g. "I was remote-only, now I'm open to hybrid") has no path back into their own config short of a fresh onboarding or a human hand-editing `config/profile.yml`.
2. **No way to target by industry instead of job title.** A candidate who knows they want to work in a specific industry (e.g. Music & Concerts — radio, venues, record labels, music advertising, record stores) but doesn't know which exact job titles to search for has no way to express that. Today's scanning is entirely title-keyword-driven (`portals.yml`'s `title_filter`), which structurally can't help someone whose search criterion is "does my experience fit *this employer*," not "does this title match my search terms."

Both gaps involve the same underlying data (the candidate's own targeting preferences) and the same delivery surface (Telegram), so they're one coordinated piece of work, not two unrelated ones.

## Goals

- A candidate can inspect and edit their own profile settings via a Telegram command, with the same read-back-and-confirm discipline `telegram-onboarding.md` already uses — no silent writes.
- A candidate can choose to target an industry instead of specific job titles, and have the system evaluate their real fit against whatever a matching employer has posted, regardless of exact title.
- Switching either setting actually changes scanning behavior — not just the stored value. (This is the "clean up contradicting instructions" requirement: `portals.yml`'s scan configuration must never silently drift from what `config/profile.yml` says the candidate wants.)
- Industry-based targeting must not blow up evaluation cost. Casting a wider net at scan time cannot mean paying a full A-F evaluation (thousands of tokens, WebSearch calls) for every posting an industry employer has open, most of which will be obviously irrelevant departments.

## Non-goals

- No new scoring dimension. `triage.md`/`oferta.md`'s existing rubric (archetype fit, comp, location, CV match, red flags) is unchanged. Industry targeting is entirely a *scanning* concern — which companies get scanned, and which cheap gate runs before an expensive one — not a new evaluation concept.
- No change to `scan-ats-full.mjs` (the 40K-company full sweep). It stays title-keyword-driven exactly as today. Industry-based candidates get their coverage from the curated company list described below, not from loosening the full sweep.
- No general "both title and industry, merged" mode. A candidate picks one targeting mode. (If real usage later shows demand for "both," that's a follow-up, not part of this work — see Alternatives Considered.)
- `/settings` does not expose every field in `config/profile.yml` — only the ones onboarding itself collects and that plausibly change over time (location, work mode / targeting mode, target roles or industries, salary target, sponsorship). Narrative fields (`_profile.md`'s exit story, superpowers, etc.) stay a conversational edit, not a menu item.

## Data model

### `config/profile.yml` — two new fields

```yaml
targeting_mode: "title_based"   # "title_based" (default, existing behavior unchanged) | "industry_based"

target_industries:               # only read when targeting_mode: industry_based
  - name: "Music & Concert Industry"
    slug: "music"                # matches the key under portals.yml's industry_companies
    description: "Radio, concerts, event venues, record labels, music advertising, record stores"
```

`target_roles`/`archetypes` are untouched and keep their current meaning under `title_based`. Nothing about an existing profile's behavior changes by these fields' mere presence with defaults — `targeting_mode` absent is treated identically to `"title_based"`.

### `portals.yml` — one new top-level block

```yaml
industry_companies:
  music:                          # keyed by the same slug as target_industries
    - name: "Live Nation"
      scan_method: api
      ats: greenhouse
      # ...same shape as tracked_companies entries today
    - name: "Sony Music Entertainment"
      ...
```

Built the same way `tracked_companies` entries are today: via `discover` mode resolving a named company to its real ATS board. Onboarding/`/settings` asks the candidate to name a few companies they know in the industry (or the agent suggests well-known ones for a common industry), then `discover` does the resolution — zero-token, already-existing capability, no new research infrastructure.

## Scanning mechanism

`core/scan.mjs` applies `title_filter` as a single global filter to every `tracked_companies` entry (confirmed by reading the code: `core/scan.mjs:2291`, `if (!titleFilter(job.title)) { ...continue; }`, with `company` in scope at that call site). The fix is one new optional per-entry flag, honored at exactly that call site:

```js
if (!company.skip_title_filter && !titleFilter(job.title)) {
  totalFilteredTitle++;
  continue;
}
```

Every entry generated under `industry_companies` is written with `skip_title_filter: true`. This is the only code change scanning needs — the scan loop already iterates `tracked_companies`; at scan-config-resolution time (where `scan.mjs` currently builds `companies` from `config.tracked_companies`, `core/scan.mjs:2101`), `industry_companies[slug]` entries are concatenated into that same array — not a second, parallel scan path — for whichever `slug`(s) appear in `config/profile.yml`'s `target_industries` when `targeting_mode: industry_based`. `scan.mjs` already reads `config/profile.yml` for unrelated reasons (`getProfilePath()`, used today for `location.country`/work-authorization checks — see `core/scan.mjs:92`), so reading `targeting_mode`/`target_industries` from the same already-loaded file is not a new coupling.

**Guardrail (the "cleanup" requirement):** `skip_title_filter` must only ever be set by the industry-company-list-building code path (onboarding / `/settings` / `discover`-driven), never appear on a hand-edited `tracked_companies` entry by accident. `verify-portals.mjs` (the existing structural validator) gets one new check: `skip_title_filter: true` outside of an `industry_companies`-sourced entry is flagged as a warning, not silently honored — so a title-based candidate's scan behavior can never regress from a copy-paste mistake.

## Cost control: mandatory triage gate for industry-sourced postings

**Original design risk (caught during review, not shipped):** routing every industry-company posting straight to full A-F evaluation once the title filter is bypassed would mean paying a full evaluation (WebSearch calls, tens of thousands of tokens) to determine that a Legal Counsel or Warehouse Associate posting at Live Nation isn't a fit — which a much cheaper check could have caught.

**Fix:** reuse `triage.md` exactly as it exists today — no changes to its rubric. `_brief.md`'s "Target Archetypes" table already asks for the candidate's real functional skills, not job titles (e.g. "Data Analyst," "Business Analyst" — capability descriptions, not employer-specific title strings), so triage's existing "archetype fit" scoring already answers "does this candidate's real skillset fit this specific JD," independent of which industry the employer is in. No new dimension needed.

`pipeline.md`'s per-URL loop gets one new branch: a pending URL tagged as sourced from `industry_companies` (see tagging below) runs `triage` mode **before** the existing Pre-screen gate / full evaluation step, **regardless of `spend_tier`** — the existing tier-gate reasoning ("economy is already the cheapest model, no need for a second cheap pass") doesn't apply here, because the problem industry mode introduces isn't which model runs a check, it's that the title filter — the *first* cheap check every other posting gets — was deliberately skipped for these entries. Only `PASS` proceeds automatically to full evaluation; `MARGINAL` surfaces to the candidate the same way `pipeline.md` already handles a marginal pre-screen result; `FAIL`/`SKIP` are discarded silently, same as today's low-score discard convention.

**Tagging mechanism:** `pipeline.md`'s pending-URL format already supports labeled segments (`| posted:`, `| trust:`, `| note:`). A new `| source: industry` labeled segment, written only by the industry-company scan path, lets the per-URL loop distinguish "came from a title-filtered source, title filter already did the cheap work" from "came from an industry scan, needs triage first" — title-based candidates see zero behavior change, since their pending entries never carry this tag.

## `/settings` command

New Telegram command, routed and confirmed the same way `/status`/`/apply` are today (`telegram.md` Step 2 classification table + a new Step, e.g. 3h).

```
/settings

1. Location: Tampa, FL
2. Work mode: remote_only
3. Targeting: title-based — Data Analyst, Analytics Engineer
4. Salary target: $80K+
5. Sponsorship: Not needed

Reply with a number to change it, or "done".
```

- Reply `2` → `Remote only, hybrid ok, or onsite ok?` → confirm → write `location.work_mode`.
- Reply `3` on a title-based profile → `Add more target roles, or switch to industry-based targeting instead?` — switching triggers the company-list-building flow (name a few companies or accept suggestions → `discover` resolves them → written to `industry_companies` with `skip_title_filter: true`).
- Reply `3` on an industry-based profile → offers switching back to title-based, or editing the industry/company list.
- Every write goes through the same read-back-and-confirm pattern onboarding uses (`telegram-onboarding.md` Step 4's convention) — no silent writes, ever.
- After each field edit, return to the numbered menu (or "anything else? reply a number or 'done'").

**Shared logic requirement (the other half of "cleanup"):** `telegram-onboarding.md` Step 4b's `title_filter`/`location_filter`/`tracked_companies` pruning logic is extracted into one routine that both onboarding and `/settings` call. Today it lives inline in onboarding's own prose; duplicating it into `/settings`'s own instructions (even with the best intentions) risks the two copies drifting apart over time. A candidate changing `work_mode` or `targeting_mode` via `/settings` must trigger the *same* `portals.yml` update onboarding would have made if that had been their answer from the start — otherwise the profile value changes but scanning silently keeps doing what it did before, which is exactly the kind of contradiction this work is meant to close.

## Alternatives considered

- **Individual field commands** (`/setlocation`, `/setworkmode`, ...) instead of one menu-driven `/settings`: faster for a single quick change, but more commands to register/document/maintain, and less discoverable for a candidate who doesn't remember the exact field name. Rejected in favor of the menu, per direct user preference.
- **Keyword-expand `title_filter` with functional terms** instead of a curated company list, for industry targeting: simpler to build (no `discover`-mode resolution step), but doesn't specifically target the named industry's employers — a broad functional net over the *entire* scan universe risks both missing the point (still title-driven) and drowning in unrelated matches. Rejected.
- **"Both title and industry, merged"** targeting: more coverage for a candidate who wants it, but no real user has asked for it yet, and it complicates the tagging/gating logic (a posting could now be sourced from both a title-filtered *and* an industry path simultaneously) for a case that's speculative. Left as a clean future extension — `targeting_mode` as an enum rather than independent booleans keeps this option open without building it now.

## Open questions for the implementation plan

- Exact wording/UX for the `discover`-driven company suggestion flow when a candidate names an industry but few/no specific companies (should the agent proactively research and suggest well-known employers, or always wait for the candidate to name some first?).
- Whether `verify-pipeline.mjs`'s existing integrity sweep should also flag a `tracked_companies` entry with `skip_title_filter: true` that *isn't* under `industry_companies` (belt-and-suspenders beyond `verify-portals.mjs`'s own check).
