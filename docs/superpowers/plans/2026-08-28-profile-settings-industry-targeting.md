# Profile Settings Command + Industry-Based Targeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a candidate edit their profile settings (location, work mode, targeting, salary, sponsorship) after onboarding via a `/settings` Telegram command, and let a candidate target an industry instead of specific job titles — with cost-controlled evaluation so casting a wider net at scan time doesn't multiply full-evaluation spend.

**Architecture:** Two new `config/profile.yml` fields (`targeting_mode`, `target_industries`) and one new `portals.yml` block (`industry_companies`) drive a scan-time company-list merge in `scan.mjs` that bypasses the title filter for industry-sourced companies only. Every industry-sourced posting is tagged in `data/pipeline.md` and routed through the existing `triage` mode (unchanged rubric) before it's allowed into full A-F evaluation — reusing infrastructure instead of adding a new scoring dimension. `/settings` is a new Telegram command, menu-driven like `/status`/`/apply`, sharing one extracted portals-pruning routine with `telegram-onboarding.md` so a settings change can never leave scanning behavior out of sync with the stored value.

**Tech Stack:** Node.js (`.mjs`), YAML (`js-yaml`), Markdown mode-file prose (Telegram bot instructions), `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-28-profile-settings-industry-targeting-design.md`

## Global Constraints

- No new scoring dimension — `triage.md`/`oferta.md`'s rubric is unchanged (spec Non-goals).
- No change to `scan-ats-full.mjs` — industry coverage comes entirely from the curated `industry_companies` list, not the full sweep (spec Non-goals).
- A candidate picks exactly one `targeting_mode` (`title_based` or `industry_based`) — no merged/both mode in this plan (spec Non-goals; spec Alternatives Considered explicitly defers this).
- `targeting_mode` absent from an existing profile must behave identically to `title_based` — zero behavior change for any candidate who doesn't opt in.
- `skip_title_filter: true` must only ever originate from an `industry_companies`-sourced entry — never appear on a hand-edited `tracked_companies` entry undetected (spec "Guardrail").
- Every `/settings` write goes through the same read-back-and-confirm pattern `telegram-onboarding.md` already uses — no silent writes (spec "/settings command").
- Reuse `discover` mode for resolving named companies to real ATS boards — never fabricate a company URL/ATS board (existing AGENTS.md Source-of-Truth Boundary, restated in spec's data model section).

---

## Task 1: Data model — schema additions

**Files:**
- Modify: `config/profile.example.yml` (add `targeting_mode`, `target_industries` near the existing `location:` block, following the pattern already used for `location.work_mode` at lines ~86-102)
- Modify: `templates/portals.example.yml` (add a commented-out `industry_companies` example block, following the existing commented `location_filter` example style at lines ~71-86)
- Test: `tests/profile-schema-industry-targeting.test.mjs` (new)

**Interfaces:**
- Produces: the exact YAML shape every later task reads —
  ```yaml
  # config/profile.yml
  targeting_mode: "title_based"  # "title_based" | "industry_based"
  target_industries:
    - name: "..."
      slug: "..."          # lowercase, hyphenated — matches an industry_companies key
      description: "..."
  ```
  ```yaml
  # portals.yml
  industry_companies:
    <slug>:
      - name: "..."
        # ...same shape as a tracked_companies entry (scan_method, ats, careers_url, api, etc.)
        skip_title_filter: true
  ```

- [ ] **Step 1: Add the `targeting_mode`/`target_industries` example block to `config/profile.example.yml`**

Open `config/profile.example.yml` and find the `location:` block (it currently ends with `needs_sponsorship: false` followed by the `work_mode` field added earlier this project). Add immediately after `work_mode`, still inside `location:`... actually these are top-level siblings to `location:`, not nested inside it — add as new top-level keys, placed right after the `location:` block closes and before `language:`:

```yaml
# ── Targeting Mode ──────────────────────────────────────────────────────────
#
# "title_based" (default) — scan by target_roles.primary keywords, as today.
# "industry_based" — scan a curated list of companies in target_industries
# below (portals.yml's industry_companies block) regardless of exact job
# title; modes/oferta.md's existing CV-match scoring decides real fit.
# Absent or "title_based" is identical to today's behavior — no candidate's
# scanning changes unless they explicitly opt into industry_based.
targeting_mode: "title_based"

# Only read when targeting_mode is "industry_based". Each slug must match a
# key under portals.yml's industry_companies block.
# target_industries:
#   - name: "Music & Concert Industry"
#     slug: "music"
#     description: "Radio, concerts, event venues, record labels, music advertising, record stores"
```

- [ ] **Step 2: Add the `industry_companies` example block to `templates/portals.example.yml`**

Find the existing `location_filter` commented example block (search for `# location_filter:`). Add a new commented block immediately after it:

```yaml
# -- Industry-based company list (optional) --
# Only scanned when config/profile.yml sets targeting_mode: "industry_based"
# and lists this slug under target_industries. Every entry here bypasses
# title_filter entirely (skip_title_filter: true) — evaluation-time CV-match
# scoring in modes/oferta.md decides real fit, not the job title. Build this
# list with `discover` mode (resolves real company names to real ATS boards,
# zero-token) — never write a careers_url/api value here that discover
# hasn't actually confirmed.
#
# industry_companies:
#   music:
#     - name: "Live Nation"
#       scan_method: api
#       ats: greenhouse
#       api: "https://boards-api.greenhouse.io/v1/boards/livenation/jobs"
#       skip_title_filter: true
#     - name: "Sony Music Entertainment"
#       scan_method: api
#       ats: greenhouse
#       api: "https://boards-api.greenhouse.io/v1/boards/sonymusic/jobs"
#       skip_title_filter: true
```

- [ ] **Step 3: Write a test confirming both example files parse and are internally consistent**

```js
// tests/profile-schema-industry-targeting.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('config/profile.example.yml has targeting_mode defaulting to title_based', () => {
  const raw = readFileSync(join(ROOT, 'config', 'profile.example.yml'), 'utf-8');
  const parsed = yaml.load(raw);
  assert.equal(parsed.targeting_mode, 'title_based');
});

test('config/profile.example.yml does not ship an active (uncommented) target_industries example', () => {
  // The example must stay commented out — an uncommented example here would
  // silently make the seeded template industry_based for every new user.
  const raw = readFileSync(join(ROOT, 'config', 'profile.example.yml'), 'utf-8');
  const parsed = yaml.load(raw);
  assert.equal(parsed.target_industries, undefined);
});

test('templates/portals.example.yml does not ship an active (uncommented) industry_companies example', () => {
  const raw = readFileSync(join(ROOT, 'templates', 'portals.example.yml'), 'utf-8');
  const parsed = yaml.load(raw);
  assert.equal(parsed.industry_companies, undefined);
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/profile-schema-industry-targeting.test.mjs`
Expected: 3 tests pass (they test the *shipped* state, so this doesn't follow the usual red-green TDD order — the files already exist correctly if Steps 1-2 were done right; this step is verifying that, not driving new production code).

- [ ] **Step 5: Commit**

```bash
git add config/profile.example.yml templates/portals.example.yml tests/profile-schema-industry-targeting.test.mjs
git commit -m "feat(profile): add targeting_mode/target_industries/industry_companies schema"
```

---

## Task 2: `scan.mjs` — resolve and merge industry companies, bypass title filter for them

**Files:**
- Modify: `core/scan.mjs` (add two new exported functions; wire them into the existing scan setup and per-job filter loop)
- Test: `tests/scan-industry-targeting.test.mjs` (new)

**Interfaces:**
- Consumes: `config/profile.yml`'s `targeting_mode`/`target_industries` (Task 1 shape), `portals.yml`'s `industry_companies` (Task 1 shape), the existing `getProfilePath()` helper (`core/scan.mjs:92`).
- Produces:
  - `export function shouldSkipTitleFilter(company)` → `boolean`
  - `export function loadTargetingConfig(profilePath = getProfilePath())` → `{ targetingMode: string, targetIndustrySlugs: string[] }`
  - `export function resolveScanCompanies(portalsConfig, targetingConfig)` → `Array<object>` (the merged company list to scan)

- [ ] **Step 1: Write the failing tests**

```js
// tests/scan-industry-targeting.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shouldSkipTitleFilter, loadTargetingConfig, resolveScanCompanies,
} from '../core/scan.mjs';

test('shouldSkipTitleFilter is true only when a company explicitly sets skip_title_filter: true', () => {
  assert.equal(shouldSkipTitleFilter({ name: 'Acme', skip_title_filter: true }), true);
  assert.equal(shouldSkipTitleFilter({ name: 'Acme' }), false);
  assert.equal(shouldSkipTitleFilter({ name: 'Acme', skip_title_filter: 'true' }), false); // string, not boolean — must not coerce
  assert.equal(shouldSkipTitleFilter(null), false);
  assert.equal(shouldSkipTitleFilter(undefined), false);
});

test('loadTargetingConfig defaults to title_based with no industries when the file is missing', () => {
  const result = loadTargetingConfig(join(tmpdir(), 'nonexistent-profile-xyz.yml'));
  assert.deepEqual(result, { targetingMode: 'title_based', targetIndustrySlugs: [] });
});

test('loadTargetingConfig defaults to title_based when targeting_mode is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-targeting-'));
  try {
    const p = join(dir, 'profile.yml');
    writeFileSync(p, 'location:\n  country: "United States"\n');
    assert.deepEqual(loadTargetingConfig(p), { targetingMode: 'title_based', targetIndustrySlugs: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTargetingConfig reads industry_based mode and target_industries slugs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-targeting-'));
  try {
    const p = join(dir, 'profile.yml');
    writeFileSync(p, [
      'targeting_mode: "industry_based"',
      'target_industries:',
      '  - name: "Music & Concert Industry"',
      '    slug: "music"',
      '    description: "Radio, concerts, venues"',
    ].join('\n'));
    assert.deepEqual(loadTargetingConfig(p), { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTargetingConfig ignores a malformed target_industries entry missing a slug', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-targeting-'));
  try {
    const p = join(dir, 'profile.yml');
    writeFileSync(p, [
      'targeting_mode: "industry_based"',
      'target_industries:',
      '  - name: "No slug here"',
      '  - name: "Has one"',
      '    slug: "music"',
    ].join('\n'));
    assert.deepEqual(loadTargetingConfig(p), { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveScanCompanies returns tracked_companies unchanged under title_based targeting', () => {
  const portalsConfig = {
    tracked_companies: [{ name: 'Acme' }],
    industry_companies: { music: [{ name: 'Live Nation', skip_title_filter: true }] },
  };
  const result = resolveScanCompanies(portalsConfig, { targetingMode: 'title_based', targetIndustrySlugs: [] });
  assert.deepEqual(result, [{ name: 'Acme' }]);
});

test('resolveScanCompanies merges only the candidate\'s own target_industries slugs under industry_based targeting', () => {
  const portalsConfig = {
    tracked_companies: [{ name: 'Acme' }],
    industry_companies: {
      music: [{ name: 'Live Nation', skip_title_filter: true }],
      film: [{ name: 'Warner Bros', skip_title_filter: true }],
    },
  };
  const result = resolveScanCompanies(portalsConfig, { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] });
  assert.deepEqual(result, [
    { name: 'Acme' },
    { name: 'Live Nation', skip_title_filter: true },
  ]);
});

test('resolveScanCompanies is safe when industry_companies or tracked_companies is absent/malformed', () => {
  assert.deepEqual(
    resolveScanCompanies({}, { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] }),
    []
  );
  assert.deepEqual(
    resolveScanCompanies({ tracked_companies: [{ name: 'Acme' }], industry_companies: 'not-an-object' }, { targetingMode: 'industry_based', targetIndustrySlugs: ['music'] }),
    [{ name: 'Acme' }]
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/scan-industry-targeting.test.mjs`
Expected: FAIL — `shouldSkipTitleFilter`/`loadTargetingConfig`/`resolveScanCompanies` are not exported from `core/scan.mjs` yet.

- [ ] **Step 3: Add the three functions to `core/scan.mjs`**

Add these right after the existing `loadReApplyWindows` function (the last of the `getProfilePath()`-consuming helpers, around line 795-820 depending on its exact length — search for `export function loadReApplyWindows` and insert after its closing brace):

```js
// A company entry explicitly opts out of the global title_filter — used
// exclusively by industry_companies entries (see resolveScanCompanies below),
// which cast a wider net on purpose and rely on full evaluation's CV-match
// scoring instead of a title keyword match. A plain tracked_companies entry
// should never set this; validate-portals.mjs warns if one does.
export function shouldSkipTitleFilter(company) {
  return company != null && company.skip_title_filter === true;
}

// Reads config/profile.yml's targeting_mode/target_industries (#2026-08-28
// profile-settings-industry-targeting). Same fail-open convention as
// loadCandidateCountry/loadReApplyWindows above: a missing file, missing
// field, or malformed profile all resolve to today's default behavior
// (title_based, no industries) rather than throwing.
export function loadTargetingConfig(profilePath = getProfilePath()) {
  if (!existsSync(profilePath)) return { targetingMode: 'title_based', targetIndustrySlugs: [] };
  try {
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    const targetingMode = raw.targeting_mode === 'industry_based' ? 'industry_based' : 'title_based';
    const targetIndustrySlugs = Array.isArray(raw.target_industries)
      ? raw.target_industries
          .map((entry) => (entry && typeof entry.slug === 'string' ? entry.slug.trim() : ''))
          .filter((slug) => slug.length > 0)
      : [];
    return { targetingMode, targetIndustrySlugs };
  } catch {
    return { targetingMode: 'title_based', targetIndustrySlugs: [] };
  }
}

// Merges portals.yml's tracked_companies with any industry_companies groups
// the candidate has opted into (targetingConfig.targetIndustrySlugs), per
// docs/superpowers/specs/2026-08-28-profile-settings-industry-targeting-design.md.
// Under title_based targeting (the default), this is byte-identical to
// reading tracked_companies alone — zero behavior change for every existing
// candidate who hasn't opted in.
export function resolveScanCompanies(portalsConfig, targetingConfig) {
  const tracked = Array.isArray(portalsConfig?.tracked_companies) ? portalsConfig.tracked_companies : [];
  if (targetingConfig?.targetingMode !== 'industry_based') return tracked;
  const industryCompanies = portalsConfig?.industry_companies;
  if (!industryCompanies || typeof industryCompanies !== 'object' || Array.isArray(industryCompanies)) return tracked;
  const slugs = Array.isArray(targetingConfig.targetIndustrySlugs) ? targetingConfig.targetIndustrySlugs : [];
  const industryEntries = slugs.flatMap((slug) => (Array.isArray(industryCompanies[slug]) ? industryCompanies[slug] : []));
  return [...tracked, ...industryEntries];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/scan-industry-targeting.test.mjs`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Wire `resolveScanCompanies`/`shouldSkipTitleFilter` into the real scan loop**

In `core/scan.mjs`, find the line (currently `core/scan.mjs:2101`):

```js
  const companies = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];
```

Replace with:

```js
  const targetingConfig = loadTargetingConfig();
  const companies = resolveScanCompanies(config, targetingConfig);
```

Then find the title-filter check inside the per-job loop (currently `core/scan.mjs:2291`):

```js
        if (!titleFilter(job.title)) {
          totalFilteredTitle++;
          continue;
        }
```

Replace with:

```js
        if (!shouldSkipTitleFilter(company) && !titleFilter(job.title)) {
          totalFilteredTitle++;
          continue;
        }
```

(`company` is already in scope at this point in the loop — confirmed by the existing `company.name`/`company._isBoard` references a few lines above it.)

- [ ] **Step 6: Run the full scan.mjs-related test suite to confirm no regression**

Run: `node --test tests/scan-industry-targeting.test.mjs && node core/test-all.mjs 2>&1 | tail -5`
Expected: new tests still pass; `test-all.mjs`'s existing scan.mjs-related checks (section 9 and others matched by `grep -n "scan.mjs" core/test-all.mjs`) still pass — no new failures beyond the pre-existing, unrelated `SYSTEM_PATHS` gap for `.mcp.json`/`archive/.gitkeep`.

- [ ] **Step 7: Commit**

```bash
git add core/scan.mjs tests/scan-industry-targeting.test.mjs
git commit -m "feat(scan): merge industry_companies into scan, bypass title filter for them"
```

---

## Task 3: `validate-portals.mjs` — structural validation

**Files:**
- Modify: `core/validate-portals.mjs`
- Test: `tests/validate-portals-industry.test.mjs` (new)

**Interfaces:**
- Consumes: `validatePortalsConfig(config, opts)` (existing, `core/validate-portals.mjs:127`), the `add(list, path, message)` helper (existing, `core/validate-portals.mjs:31`).
- Produces: no new exports — extends the existing `{ errors, warnings }` return shape with new warning/error paths (`industry_companies`, `industry_companies.<slug>[n]...`, `tracked_companies[n].skip_title_filter`).

- [ ] **Step 1: Write the failing tests**

```js
// tests/validate-portals-industry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePortalsConfig } from '../core/validate-portals.mjs';

test('a tracked_companies entry with skip_title_filter: true gets a warning (likely copy-paste mistake)', async () => {
  const { warnings } = await validatePortalsConfig({
    tracked_companies: [{ name: 'Acme', skip_title_filter: true }],
  });
  assert.ok(warnings.some((w) => w.path === 'tracked_companies[0].skip_title_filter'));
});

test('a plain tracked_companies entry with no skip_title_filter gets no such warning', async () => {
  const { warnings } = await validatePortalsConfig({
    tracked_companies: [{ name: 'Acme' }],
  });
  assert.ok(!warnings.some((w) => w.path === 'tracked_companies[0].skip_title_filter'));
});

test('industry_companies must be an object keyed by slug, not an array', async () => {
  const { errors } = await validatePortalsConfig({ industry_companies: [{ name: 'Acme' }] });
  assert.ok(errors.some((e) => e.path === 'industry_companies'));
});

test('each industry_companies[slug] value must be an array', async () => {
  const { errors } = await validatePortalsConfig({ industry_companies: { music: { name: 'not an array' } } });
  assert.ok(errors.some((e) => e.path === 'industry_companies.music'));
});

test('each industry_companies[slug] entry is validated the same way as a tracked_companies entry', async () => {
  const { errors } = await validatePortalsConfig({
    industry_companies: { music: [{ /* missing name */ careers_url: 'not a url' }] },
  });
  assert.ok(errors.some((e) => e.path === 'industry_companies.music[0].name'));
  assert.ok(errors.some((e) => e.path === 'industry_companies.music[0].careers_url'));
});

test('a valid industry_companies block with skip_title_filter: true entries produces no errors or warnings', async () => {
  const { errors, warnings } = await validatePortalsConfig({
    industry_companies: {
      music: [{ name: 'Live Nation', skip_title_filter: true, api: 'https://boards-api.greenhouse.io/v1/boards/livenation/jobs' }],
    },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/validate-portals-industry.test.mjs`
Expected: FAIL — none of these checks exist in `validatePortalsConfig` yet (the `skip_title_filter` warning test fails because no warning is produced; the `industry_companies` tests fail because nothing validates that key at all, so no errors are produced where the test expects them).

- [ ] **Step 3: Extract the per-company validation into a reusable function**

In `core/validate-portals.mjs`, the existing `tracked_companies` loop (`core/validate-portals.mjs:213-246`) validates one company object inline. Extract that per-entry validation into its own function so `industry_companies` entries can reuse it exactly, rather than duplicating the checks:

Find:
```js
  const seenEnabledNames = new Map();
  if (Array.isArray(companies)) {
    for (const [idx, company] of companies.entries()) {
      const base = `tracked_companies[${idx}]`;
      if (!isObject(company)) {
        add(errors, base, 'company entry must be an object');
        continue;
      }
      if (company.enabled === false) continue;

      if (typeof company.name !== 'string' || company.name.trim() === '') {
        add(errors, `${base}.name`, 'enabled company must have a non-empty string name');
      } else {
        const normalized = normalizeName(company.name);
        if (seenEnabledNames.has(normalized)) {
          add(warnings, `${base}.name`, `duplicate enabled company name also seen at ${seenEnabledNames.get(normalized)}`);
        } else {
          seenEnabledNames.set(normalized, `${base}.name`);
        }
      }

      validateUrl(company.careers_url, `${base}.careers_url`, errors);
      validateUrl(company.api, `${base}.api`, errors);

      if (company.provider !== undefined) {
        if (typeof company.provider !== 'string' || company.provider.trim() === '') {
          add(errors, `${base}.provider`, 'provider must be a non-empty string when set');
        } else if (!providerIds.has(company.provider)) {
          add(errors, `${base}.provider`, `unknown provider "${company.provider}"`);
        }
      }

      validateParser(company.parser, `${base}.parser`, errors);
    }
  }
```

Replace with (extracting the per-entry body into `validateCompanyEntry`, called once for `tracked_companies` and once per `industry_companies` slug):

```js
  // Shared per-entry validation for both tracked_companies and each
  // industry_companies[slug] array — same shape, same rules. seenEnabledNames
  // is scoped per call so a company legitimately appearing once in
  // tracked_companies and once under an industry slug isn't flagged as a
  // duplicate of itself.
  function validateCompanyEntry(company, base, seenEnabledNames) {
    if (!isObject(company)) {
      add(errors, base, 'company entry must be an object');
      return;
    }
    if (company.enabled === false) return;

    if (typeof company.name !== 'string' || company.name.trim() === '') {
      add(errors, `${base}.name`, 'enabled company must have a non-empty string name');
    } else {
      const normalized = normalizeName(company.name);
      if (seenEnabledNames.has(normalized)) {
        add(warnings, `${base}.name`, `duplicate enabled company name also seen at ${seenEnabledNames.get(normalized)}`);
      } else {
        seenEnabledNames.set(normalized, `${base}.name`);
      }
    }

    validateUrl(company.careers_url, `${base}.careers_url`, errors);
    validateUrl(company.api, `${base}.api`, errors);

    if (company.provider !== undefined) {
      if (typeof company.provider !== 'string' || company.provider.trim() === '') {
        add(errors, `${base}.provider`, 'provider must be a non-empty string when set');
      } else if (!providerIds.has(company.provider)) {
        add(errors, `${base}.provider`, `unknown provider "${company.provider}"`);
      }
    }

    validateParser(company.parser, `${base}.parser`, errors);

    // Found 2026-08-28: skip_title_filter is meant exclusively for
    // industry_companies entries (see below) — a plain tracked_companies
    // entry setting it is almost always a copy-paste mistake that silently
    // widens what that one company scans, undetected. Warn, don't error:
    // there's no way to be certain it's a mistake from structure alone.
    if (base.startsWith('tracked_companies') && company.skip_title_filter === true) {
      add(warnings, `${base}.skip_title_filter`, 'skip_title_filter is normally set only on an industry_companies-sourced entry — confirm this tracked_companies entry meant to bypass the title filter, not a copy-paste mistake');
    }
  }

  const seenEnabledNames = new Map();
  if (Array.isArray(companies)) {
    for (const [idx, company] of companies.entries()) {
      validateCompanyEntry(company, `tracked_companies[${idx}]`, seenEnabledNames);
    }
  }

  const industryCompanies = config.industry_companies;
  if (industryCompanies !== undefined) {
    if (!isObject(industryCompanies)) {
      add(errors, 'industry_companies', 'industry_companies must be an object keyed by industry slug when set');
    } else {
      for (const [slug, entries] of Object.entries(industryCompanies)) {
        const slugBase = `industry_companies.${slug}`;
        if (!Array.isArray(entries)) {
          add(errors, slugBase, `${slugBase} must be an array of company entries`);
          continue;
        }
        const seenForSlug = new Map();
        for (const [idx, company] of entries.entries()) {
          validateCompanyEntry(company, `${slugBase}[${idx}]`, seenForSlug);
        }
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/validate-portals-industry.test.mjs`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `node --test tests/*.test.mjs 2>&1 | tail -10`
Expected: all tests pass (177 + this task's 6 new + Task 1's 3 + Task 2's 8 = 194 total by this point), no regressions to any existing `validate-portals`-related test.

- [ ] **Step 6: Commit**

```bash
git add core/validate-portals.mjs tests/validate-portals-industry.test.mjs
git commit -m "feat(validate-portals): structurally validate industry_companies + flag stray skip_title_filter"
```

---

## Task 4: Shared portals-pruning routine

**Files:**
- Create: `modes/_portals-pruning.md`
- Modify: `modes/telegram-onboarding.md` (replace the inline pruning prose in Step 4b with a reference to the new shared file)

**Interfaces:**
- Produces: `modes/_portals-pruning.md` — a self-contained prose routine any mode can point candidates' agents at, taking as implicit inputs "the candidate's confirmed `target_roles.primary` / `location` / `work_mode` / `targeting_mode` / `target_industries`" and producing an updated `portals.yml`.

- [ ] **Step 1: Create `modes/_portals-pruning.md` with the extracted routine**

This is a direct extraction of `telegram-onboarding.md`'s existing Step 4b sub-step (currently lines 92-97), generalized to be callable from more than one place (onboarding today, `/settings` in Task 6) without naming "onboarding" or "Step 4b" anywhere in its own text:

```markdown
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
```

- [ ] **Step 2: Replace the inline pruning prose in `telegram-onboarding.md` with a reference**

In `modes/telegram-onboarding.md`, find the three bullet points currently at lines 95-97 (starting `- **Preferred path — toggle, don't delete:**` and ending with the `- **Either path, always:**` bullet). Replace all three bullets with:

```markdown
      - Run every applicable step of `modes/_portals-pruning.md` now, using the confirmed `target_roles.primary`, `location.*`, and (if industry-based) `target_industries` from this conversation as the triggering values — every step in that file applies here since this is a first-time setup, not an incremental change.
```

- [ ] **Step 3: Verify by careful reading — no automated test for this step**

This step is agent-instruction prose, not executable code (per this project's established convention — see `AGENTS.md`'s treatment of `modes/*.md` changes). Verify by reading:
1. `modes/_portals-pruning.md` in full — confirm it reads correctly standalone, with no reference to "onboarding," "Step 4b," or any other caller-specific context that would confuse a reader who arrived at it from `/settings` instead.
2. `modes/telegram-onboarding.md`'s Step 4b after the edit — confirm the replacement sentence still makes grammatical and contextual sense in place of the three bullets it replaced, and that "every step... applies here" is true (onboarding always has fresh `target_roles.primary`/`location`, so triggers 1-3 always fire; trigger 4 only fires if the candidate chose industry-based during onboarding, which the sentence's "if industry-based" qualifier already covers).

- [ ] **Step 4: Run the full test suite to confirm no regression**

Run: `node --test tests/*.test.mjs 2>&1 | tail -10`
Expected: all tests still pass — this task touches no executable code, so this is a pure regression check (in case any test does structural/content assertions against `telegram-onboarding.md`'s exact text — check `tests/telegram-onboarding-mode.test.mjs` specifically for any such assertion before assuming none exists).

- [ ] **Step 5: Commit**

```bash
git add modes/_portals-pruning.md modes/telegram-onboarding.md
git commit -m "refactor(onboarding): extract portals.yml pruning into a shared routine"
```

---

## Task 5: `pipeline.md` — industry-source tagging and mandatory triage gate

**Files:**
- Modify: `modes/pipeline.md`

**Interfaces:**
- Consumes: the `| source: industry` labeled segment convention this task introduces on `data/pipeline.md` pending rows (extending the existing `| posted:` / `| trust:` / `| note:` labeled-segment convention documented in `modes/pipeline.md`'s "Format of pipeline.md" section).
- Produces: an updated `data/pipeline.md` format contract, and a new branch in the per-URL processing loop.

- [ ] **Step 1: Document the new `| source: industry` labeled segment**

In `modes/pipeline.md`, find the "Format of pipeline.md" section's list of labeled segments (currently three: `| posted:`, `| trust:`, `| note:`, ending with "When more than one is present the order is `posted:` → `trust:` → `note:`."). Add a fourth:

```markdown
- `| source: industry` — written only when this URL was surfaced by an
  `industry_companies`-sourced scan (see `core/scan.mjs`'s `resolveScanCompanies()`
  and the profile-settings-industry-targeting design doc). Its presence is
  what tells the per-URL loop below to run `triage` mode before the normal
  pre-screen/full-evaluation path — a title-filtered URL never carries this
  segment, so a title-based candidate's processing is byte-identical to
  today.
```

And update the ordering sentence to: `"When more than one is present the order is `posted:` → `trust:` → `source:` → `note:`."`

- [ ] **Step 2: Add the scanner-side write of the tag**

In the same "Format of pipeline.md" section, after the `note:` bullet's example, add one sentence noting where this segment is populated from (so a reader knows it's not something the pipeline-processing loop itself invents):

```markdown
  `scan.mjs` writes this segment automatically for any offer sourced from a
  `resolveScanCompanies()`-merged `industry_companies` entry — nothing in
  `pipeline.md`'s own processing loop ever adds or removes it.
```

*(Note: this plan does not add code to `scan.mjs`'s pipeline-append path to literally write this segment — that is a real gap between this task's documentation and Task 2's code. Resolve it as part of this task, not deferred: see Step 3 below.)*

- [ ] **Step 3: Wire the tag into `scan.mjs`'s pipeline-append path**

`core/scan.mjs`'s `formatPipelineOffer(offer)` (currently at `core/scan.mjs:1540`) reads every optional labeled segment directly off the single `offer` object it's passed — `offer.note` for `note:`, `offer.postedAt` for `posted:`, and the trust fields via `formatTrustSegment(offer)` for `trust:` — never as separate function parameters. The current body (for reference — do not paste stale code over this if it has changed since this plan was written; re-read the live file first):

```js
export function formatPipelineOffer(offer) {
  const url = sanitizePipelineUrl(offer.url);
  const company = sanitizeMarkdownField(offer.company);
  const title = sanitizeMarkdownField(offer.title);
  const location = typeof offer.location === 'string' ? sanitizeMarkdownField(offer.location) : '';
  const compensation = formatCompensation(offer.salary);
  const base = `- [ ] ${url} | ${company} | ${title}`;
  let line = base;
  if (compensation) line = `${base} | ${location} | ${compensation}`;
  else if (location) line = `${base} | ${location}`;
  const posted = postedAtIsoDate(offer.postedAt);
  if (posted) line = `${line} | posted: ${posted}`;
  const trust = formatTrustSegment(offer);
  if (trust) line = `${line} | ${trust}`;
  const note = typeof offer.note === 'string' ? sanitizeMarkdownField(offer.note) : '';
  return note ? `${line} | note: ${note}` : line;
}
```

Add the `source:` segment the same way, between the `trust` block and the final `note` line (matching Step 1's `posted:` → `trust:` → `source:` → `note:` ordering):

```js
export function formatPipelineOffer(offer) {
  const url = sanitizePipelineUrl(offer.url);
  const company = sanitizeMarkdownField(offer.company);
  const title = sanitizeMarkdownField(offer.title);
  const location = typeof offer.location === 'string' ? sanitizeMarkdownField(offer.location) : '';
  const compensation = formatCompensation(offer.salary);
  const base = `- [ ] ${url} | ${company} | ${title}`;
  let line = base;
  if (compensation) line = `${base} | ${location} | ${compensation}`;
  else if (location) line = `${base} | ${location}`;
  const posted = postedAtIsoDate(offer.postedAt);
  if (posted) line = `${line} | posted: ${posted}`;
  const trust = formatTrustSegment(offer);
  if (trust) line = `${line} | ${trust}`;
  // Labeled industry-targeting source segment (#2026-08-28) — rides like
  // posted:/trust:/note:, emitted only when this offer's company came from
  // resolveScanCompanies()'s industry_companies merge (shouldSkipTitleFilter
  // is true for exactly that set and false for every ordinary
  // tracked_companies entry, so it doubles as the source-of-truth marker
  // here without needing a second, parallel flag threaded through).
  if (offer.source === 'industry') line = `${line} | source: industry`;
  const note = typeof offer.note === 'string' ? sanitizeMarkdownField(offer.note) : '';
  return note ? `${line} | note: ${note}` : line;
}
```

At the call site that builds each `offer` object before appending it to `data/pipeline.md` (search for where `formatPipelineOffer(` is actually invoked during a scan run, not in a test), set `offer.source = 'industry'` when `shouldSkipTitleFilter(company)` is true for the company that produced this offer — that flag (Task 2) is present on every entry that came through the `industry_companies` merge and absent from every ordinary `tracked_companies` entry, so it is the correct, already-available signal; do not introduce a second parallel flag to track the same fact.

- [ ] **Step 4: Write a test for the new `source:` segment**

Add directly to `core/test-all.mjs`, immediately after the existing `"scan.mjs formatPipelineOffer preserves an optional labeled note"` block (confirmed at `core/test-all.mjs:3114-3131` — each test in this section inline-constructs its own raw offer object literal per call, no shared fixture to reuse; follow that same style):

```js
// pipeline.md source segment (#2026-08-28 industry targeting): formatPipelineOffer
// tags an offer that came through resolveScanCompanies()'s industry_companies
// merge, so modes/pipeline.md's per-URL loop knows to run triage before full
// evaluation. Absent source is byte-identical to today's output.
const sourceIndustry = formatPipelineOffer({ url: 'https://x/10', company: 'Live Nation', title: 'Royalty Accountant', source: 'industry' });
const sourceAbsent = formatPipelineOffer({ url: 'https://x/11', company: 'Acme', title: 'PM' });
if (
  sourceIndustry === '- [ ] https://x/10 | Live Nation | Royalty Accountant | source: industry' &&
  !sourceAbsent.includes('| source:')
) {
  pass('scan.mjs formatPipelineOffer appends source: industry when given, omits it otherwise (#2026-08-28 industry targeting)');
} else {
  fail(`scan.mjs source segment wrong: "${sourceIndustry}" / "${sourceAbsent}"`);
}
```

- [ ] **Step 5: Run test-all.mjs to verify the new check passes**

Run: `node core/test-all.mjs 2>&1 | grep "source: industry"`
Expected: the new `pass()` line shown, no `fail()`.

- [ ] **Step 6: Add the mandatory-triage branch to the per-URL processing loop**

In `modes/pipeline.md`'s "Workflow" section, find item 2's sub-steps (currently `a.` through `g.`, covering JD-fetch-cache check through "Move from Pending to Processed"). Insert a new sub-step between the existing `c.` (inaccessible-URL handling) and `d.` (the existing Pre-screen gate):

```markdown
   c2. **Mandatory triage for industry-sourced URLs.** If this pending row carries the `| source: industry` labeled segment (see "Format of pipeline.md" above), run `modes/triage.md` against the already-extracted JD from step (b) — regardless of `spend_tier`. This is unconditional even at `economy` tier: the existing tier-gating on the Pre-screen gate below exists because `economy` is already the cheapest model, which has no bearing on whether a *first* cheap check ran at all — and for an industry-sourced URL, the title filter (every other URL's first cheap check) was deliberately skipped at scan time. `triage.md`'s rubric is unchanged; it reads only `_brief.md`, exactly as it does when invoked directly.
       - **FAIL/SKIP:** log the discard to `data/discard.log` (same three-field format the Pre-screen gate below uses) with the triage reason, mark `- [x] #-- | {url} | skipped (industry-triage: {reason})` in "Processed," and continue to the next URL. No `REPORT_NUM` is claimed.
       - **MARGINAL:** surface the one-line triage verdict to the user the same way the Pre-screen gate's own mismatch case is surfaced, and continue to the next URL without claiming a `REPORT_NUM` unless the user explicitly asks to proceed with this one.
       - **PASS:** continue to step (d) below as normal — note that the existing Pre-screen gate at step (d) still applies afterward per its own tier rules; triage and pre-screen are not mutually exclusive, they're sequential cheap-then-cheaper gates for this specific URL category.
```

- [ ] **Step 7: Verify by careful reading — no automated test for this mode-file step**

Read the full "Workflow" section after the edit, end to end, confirming: (1) the new `c2` step's placement makes the lettering/reading order unambiguous (c, c2, d, e, f, g); (2) a title-based candidate's pending rows (no `source:` segment) skip step `c2` entirely and reach step `d` exactly as before — zero behavior change; (3) the `PASS`/`MARGINAL`/`FAIL`/`SKIP` handling matches `triage.md`'s own verdict table exactly (re-read `modes/triage.md`'s "4. Verdict" section side by side to confirm no drift).

- [ ] **Step 8: Run the full test suite to confirm no regression**

Run: `node --test tests/*.test.mjs 2>&1 | tail -10 && node core/test-all.mjs 2>&1 | grep -E "❌|📊 Results"`
Expected: all `tests/*.test.mjs` pass; `test-all.mjs` shows only the pre-existing, unrelated `SYSTEM_PATHS` failure.

- [ ] **Step 9: Commit**

```bash
git add modes/pipeline.md core/scan.mjs core/test-all.mjs
git commit -m "feat(pipeline): tag industry-sourced URLs and gate them through triage before full eval"
```

---

## Task 6: `/settings` Telegram command

**Files:**
- Modify: `modes/telegram.md` (Step 2 classification table, new Step 3h, help text, `data/telegram-state.md` pending-confirmation stage vocabulary)
- Modify: `core/telegram-set-commands.mjs` (register `/settings` in the bot's command menu)

**Interfaces:**
- Consumes: `modes/_portals-pruning.md` (Task 4), `config/profile.yml`'s full schema including Task 1's new fields, the existing `data/telegram-state.md` pending-confirmation format documented in `modes/telegram.md`'s "State" section.
- Produces: two new pending-confirmation `stage` values — `settings-menu` (waiting for a number selecting which field to edit) and `settings-edit` (waiting for the new value of a specific field, with `data` carrying which field).

- [ ] **Step 1: Register `/settings` in the bot's command menu**

In `core/telegram-set-commands.mjs`, add to the `COMMANDS` array (after the `status` entry, before `help`):

```js
  { command: 'settings', description: 'View or change your profile settings' },
```

- [ ] **Step 2: Add `/settings` to `telegram.md`'s Step 2 classification table**

Find the table row `| \`/status\` | recognized command | Step 3f: report status |`. Add immediately after it:

```markdown
| `/settings` | recognized command | Step 3h: view/edit profile settings |
```

- [ ] **Step 3: Document the two new pending-confirmation stages**

In `modes/telegram.md`'s "State — `data/telegram-state.md`" section, find the `Pending Confirmations` comment block's stage list (`resume-approval|field-approval|submit-approval|batch-approval|question|edit-intent`). Add the two new stages to that list and document their `data` shape in the same comment, following the existing per-stage `data` documentation style:

```markdown
[msg_id: X] stage: resume-approval|field-approval|submit-approval|batch-approval|question|edit-intent|settings-menu|settings-edit — <short description> — waiting since <date>
```

And extend the `data:` field's documentation (the long parenthetical describing what `data` carries per stage) to add:

```markdown
for `settings-menu`, `data` is empty — the numbered menu itself is the message already sent, nothing further to carry; for `settings-edit`, `data` is the field key being edited (one of `location`, `work_mode`, `targeting`, `salary`, `sponsorship`) so a resumed session knows which field the reply is answering without re-parsing the menu
```

- [ ] **Step 4: Write Step 3h**

Insert this new section between the end of Step 3g (`One-shot, no pending confirmation — log to Recent Actions same as Step 3d/3f.`) and `### Step 4 — Confirm`:

```markdown
### Step 3h — View/edit profile settings

1. Read `config/profile.yml`. Build the numbered menu from whichever of these fields are present (a field with no real value yet — e.g. a fresh onboard that skipped the optional narrative step — is still listed, showing its current default):

   ```
   ⚙️ <b>Your Settings</b>

   1. Location: {location.city}, {location.country}
   2. Work mode: {location.work_mode, or "not set" if absent}
   3. Targeting: {"title-based — " + target_roles.primary.join(", ") if targeting_mode is title_based, else "industry-based — " + target_industries.map(i => i.name).join(", ")}
   4. Salary target: {compensation.target_range}
   5. Sponsorship: {"Needs sponsorship" if location.needs_sponsorship else "Not needed"}

   Reply with a number to change it, or "done".
   ```

2. Send it, store a pending confirmation with `stage: settings-menu`, advance and wait.
3. **On a numbered reply (1-5):**
   - `1` (Location): ask `Where are you based now? (city, state/country)` — on reply, update `location.city`/`location.timezone`/`location.country` (same inference rule `telegram-onboarding.md` Step 4b already uses: infer `country` only from an unambiguous city/country name in the reply, never guess). Send a read-back (`Got it — location is now {city}, {country}. Confirm?`), store `stage: settings-edit` with `data: "location"`, wait for "yes"/correction exactly like `telegram-onboarding.md` Step 4's own confirm loop. On confirmation, run `modes/_portals-pruning.md`'s location-triggered steps (its section 3) using the new location, then return to the Step 3h.1 menu.
   - `2` (Work mode): ask `Remote only, remote preferred, hybrid ok, or onsite ok?` — parse into one of the four `location.work_mode` enum values (same mapping `telegram-onboarding.md` Step 4's `answers.workMode` parsing already uses). Read back, confirm, write `location.work_mode`. On confirmation, run `modes/_portals-pruning.md`'s work-mode-triggered steps (its section 3) using the new value, then return to the menu.
   - `3` (Targeting): if currently `title_based`, ask `Add more target roles, or switch to industry-based targeting instead?` — a reply naming roles updates `target_roles.primary` (read back, confirm, run `_portals-pruning.md` sections 1-2); a reply indicating a switch to industry-based asks `What industry, and do you know specific companies in it? (name a few, or I can suggest some)` — on reply, set `targeting_mode: "industry_based"`, populate `target_industries` with the named industry (candidate supplies or confirms a `slug`), then run `_portals-pruning.md` section 4 to resolve companies via `discover` mode. If currently `industry_based`, offer the symmetric choice: add companies/industries, or switch back to `title_based` (switching back only changes `targeting_mode` — per `_portals-pruning.md` section 4's own note, `industry_companies` is left in place, not deleted). Read back and confirm before any write, same as every other field.
   - `4` (Salary): ask `What's your new target range?` — read back, confirm, write `compensation.target_range`/`compensation.minimum` (parse a walk-away floor from the reply if stated; otherwise leave `minimum` unchanged and say so in the read-back).
   - `5` (Sponsorship): ask `Do you need visa sponsorship now, or are you authorized?` — same non-inference rule as onboarding (never infer from location). Read back, confirm, write `location.visa_status`/`needs_sponsorship`/`authorized_in` exactly per `telegram-onboarding.md` Step 4b's existing instruction for this trio.
4. **On "done" (or equivalent) with `stage: settings-menu` pending:** clear the pending confirmation, reply `Settings unchanged.` or, if any field was actually edited earlier in this session, a one-line summary of what changed. No `_portals-pruning.md` run needed here — each field edit above already ran it inline at the moment of confirmation, not batched to the end.
5. **On a reply to `stage: settings-edit`:** resolve exactly like `telegram-onboarding.md` Step 4b's own confirm-or-correct loop — "yes"/equivalent proceeds with the write already described above per field; anything else is treated as a correction and re-asks the same field's question with the new input folded in, without advancing.
6. Log every completed edit to `data/telegram-state.md`'s Recent Actions, same convention as every other step in this file.
```

- [ ] **Step 5: Update the `/help` text**

In `modes/telegram.md`'s Step 3g help message, renumber the existing `<b>6. Quick replies</b>` section to `<b>7. Quick replies</b>` and insert before it:

```markdown
<b>6. Settings</b>
/settings — view or change your location, work mode, targeting, salary target, or sponsorship status
```

- [ ] **Step 6: Verify by careful reading — no automated test for this mode-file task**

Read `modes/telegram.md` end to end after all edits, confirming: (1) Step 3h's every branch (1-5, done, settings-edit reply) ends in either a wait-for-reply state or a return to the menu — no branch silently drops the candidate with no next step; (2) every write instruction in Step 3h correctly cross-references the exact `telegram-onboarding.md` Step 4/4b conventions it claims to reuse (re-read those steps side by side to confirm no drift, especially the sponsorship non-inference rule and the work-mode enum mapping); (3) the `_portals-pruning.md` calls in Step 3h name the correct section number for each trigger (location → section 3, work mode → section 3, targeting/roles → sections 1-2, industry switch → section 4) matching Task 4's actual section numbering.

- [ ] **Step 7: Run the full test suite to confirm no regression**

Run: `node --test tests/*.test.mjs 2>&1 | tail -10`
Expected: all pass — check `tests/telegram-monitor.test.mjs`/`tests/telegram-onboarding-mode.test.mjs` specifically in case either asserts something about `telegram.md`'s exact Step numbering or the `data/telegram-state.md` stage vocabulary that this task's additions could conflict with.

- [ ] **Step 8: Commit**

```bash
git add modes/telegram.md core/telegram-set-commands.mjs
git commit -m "feat(telegram): add /settings command for post-onboarding profile edits"
```

---

## Task 7: Final integration check

**Files:** none created/modified — verification only.

- [ ] **Step 1: Re-run the complete test suite**

Run: `node --test tests/*.test.mjs 2>&1 | tail -10`
Expected: all tests pass (baseline 177 + Task 1's 3 + Task 2's 8 + Task 3's 6 = 194 in `tests/*.test.mjs`; Task 5's 1 additional check lives in `core/test-all.mjs`'s own separate pass()/fail() counter, not this suite).

Run: `node core/test-all.mjs 2>&1 | grep -E "❌|📊 Results"`
Expected: only the pre-existing, unrelated `SYSTEM_PATHS` coverage gap for `.mcp.json`/`archive/.gitkeep` — nothing new.

- [ ] **Step 2: Spec-coverage self-review**

Re-read `docs/superpowers/specs/2026-08-28-profile-settings-industry-targeting-design.md` section by section against the tasks above:
- "Data model" → Task 1.
- "Scanning mechanism" → Task 2.
- "Guardrail" (skip_title_filter validation) → Task 3.
- "Cost control: mandatory triage gate" → Task 5.
- "`/settings` command" → Task 6.
- "Shared logic requirement" → Task 4.

Confirm no spec section is left without a corresponding task. If a gap is found, add a task before considering this plan complete rather than shipping a known gap silently.

- [ ] **Step 3: Manual walkthrough of the two `Open questions` the spec left unresolved**

The spec's "Open questions for the implementation plan" section named two items:
1. Company-suggestion UX when a candidate names an industry but few/no companies — resolved by Task 6 Step 4's Step 3h.3 wording (`"...do you know specific companies in it? (name a few, or I can suggest some)"` — offers both, doesn't force a choice).
2. Whether `verify-pipeline.mjs` should also flag a stray `skip_title_filter` — deliberately left as a future follow-up, not part of this plan (Task 3's `validate-portals.mjs` check already covers the structural case at config-write time, which is earlier and cheaper than a pipeline-run-time check would be).

Confirm both are addressed or explicitly deferred with reasoning, not silently dropped.

- [ ] **Step 4: No commit for this task** — it's verification-only; nothing here should produce a diff. If Step 2 surfaces a real gap, that gap gets its own task (renumber this to Task 8, or fold the fix into the task whose section it belongs to) before this plan is considered done.
