# Portals.yml Scan-Universe Pruning

Shared by `modes/telegram-onboarding.md` and `modes/telegram.md`'s `/settings`
command — whenever a candidate's title-based targeting (`target_roles.primary`),
location (`location.city`/`location.country`/`location_flexibility`), work mode
(`location.work_mode`), or targeting mode (`targeting_mode`/`target_industries`)
changes, `portals.yml` must be brought back into sync in the same turn. A
candidate's *profile* changing without their *scan* changing to match is a
silent contradiction — the candidate believes they've updated their search,
but nothing about what actually gets scanned reflects it.

Run every applicable step below whenever any of the triggering fields above
changes. Skip a step only when its own trigger field didn't change.

## 1. `title_filter.positive` (triggers on `target_roles.primary` changing, title_based only)

Replace the list with keywords drawn directly from the new `target_roles.primary`
plus their obvious close synonyms (e.g. targeting "Data Analyst" → also add
"Data Analytics," "Business Intelligence," "BI Analyst" — stay close to what
was actually said, never invent an unrelated specialty). Leave `title_filter.negative`
and `seniority_boost` untouched — those are a separate, ongoing refinement, not
something a targeting change should reset.

## 2. `tracked_companies` / `search_queries` pruning (triggers on `target_roles.primary` changing, title_based only)

**Preferred path — toggle, don't delete:** for each `tracked_companies` entry
whose `scan_method: websearch` carries a hardcoded `scan_query` with no keyword
overlapping the new `target_roles.primary`, set `enabled: false` — that query
can never surface a matching title, so leaving it on only burns a WebSearch
call every run for zero possible yield. Same for any `search_queries` entry
whose `query:` keywords don't overlap the new `target_roles.primary`.
`enabled: false` keeps entries available if targeting changes again later, so
prefer it whenever the edit is practical within the current dispatch's
time/token budget.

**Fallback path — replace, don't leave bloat:** if toggling every mismatched
entry individually isn't practical in this dispatch (a large seeded or
previously-grown list), replacing `tracked_companies`/`search_queries` with a
small, freshly-written set is an accepted alternative — carry forward any
*existing* entry that already matches the new `target_roles.primary` (checked
against its real, already-validated URL/`api:`/`scan_query`, never invented),
and write new `search_queries` entries in the file's own existing format,
scoped to the new `target_roles.primary`, using only real ATS `site:` patterns
already demonstrated elsewhere in the file. `tracked_companies: []` is a
correct, honest outcome when nothing existing matches — don't hand-pick a
curated replacement company list to fill it; that needs verified real ATS
URLs, which is `discover` mode's job, not this routine's.

## 3. `location_filter` (triggers on location or work_mode changing)

If the candidate's location names a specific country/region rather than
"anywhere"/"global remote," write an active `location_filter` block
(`always_allow`/`allow`/`block`) matching their actual policy — `portals.yml`
ships this block commented out by default, and it costs nothing to add, so
never skip it once a specific location is known.

If `location.work_mode` is `remote_only` or `remote_preferred`, include
`"Remote"` in `always_allow` regardless of what else is listed there — the
block's own "empty location → pass" default means scan-level filtering can't
fully enforce a remote-only policy on postings with no location metadata at
all; the evaluation-time cap in `modes/oferta.md` Block A ("Unstated work
mode") is what actually enforces that case. This step only keeps the scan
from needlessly dropping postings that *are* correctly tagged remote.

Skip this step only if the candidate's `target_roles.primary` is genuinely
industry-agnostic/global-remote in a way where no specific `location_filter`
would add signal.

## 4. `industry_companies` (triggers on `targeting_mode` becoming `industry_based`, or `target_industries` changing while already industry_based)

For each slug in the candidate's `target_industries` that doesn't yet have a
corresponding `industry_companies.<slug>` entry in `portals.yml` (or whose
existing entry needs new companies added): ask the candidate to name a few
companies they know in that industry, or suggest well-known employers if they
have none in mind. Resolve every named/suggested company to a real ATS board
via `discover` mode (zero-token, already-verifies-liveness) — never write a
`careers_url`/`api` value that `discover` hasn't actually confirmed. Append
the resolved entries under `industry_companies.<slug>` with `skip_title_filter: true`
set on each one. If `targeting_mode` is switching *away* from `industry_based`,
leave `industry_companies` in place untouched (cheap to keep, no scan cost
while `targeting_mode` is `title_based` — see `core/scan.mjs`'s
`resolveScanCompanies()`, which only reads it under `industry_based`) so
switching back later doesn't require rebuilding the list.
