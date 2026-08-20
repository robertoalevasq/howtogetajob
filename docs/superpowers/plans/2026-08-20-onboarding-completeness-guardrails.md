# Onboarding Completeness & Tailoring Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop unedited template placeholder content and volunteered-but-dropped candidate information from surviving into a "ready to search" workspace, for both onboarding paths, and modestly deepen what Telegram onboarding captures without slowing down the required path.

**Architecture:** A deterministic `checkTemplateLeftovers(root)` check added to `core/doctor.mjs`'s existing checklist (WARN-level, runs for every workspace via `--json`'s `templateLeftovers` key) catches leftover template content by diffing against the live template files. `modes/telegram-onboarding.md` gets a confirm-before-write step, fuller CV reuse for `narrative.proof_points`, a self-correcting gate that calls the new check before binding, and one optional low-friction question for content a CV can't supply.

**Tech Stack:** Node.js (`.mjs`), `js-yaml` for YAML parsing, `node:test` + `node:assert/strict` for tests, `execFileSync` to spawn `doctor.mjs` as a subprocess (matches existing `tests/doctor-*.test.mjs` convention).

**Spec:** `docs/superpowers/specs/2026-08-20-onboarding-completeness-guardrails-design.md`

## Global Constraints

- `checkTemplateLeftovers` is **WARN-level only, never a hard failure** — matches `checkPrereq`'s existing treatment of user-layer content (spec: Component `core/doctor.mjs`).
- A blank/empty value (`""`, `[]`) **never** flags, regardless of what the template contains there — blank is an established, legitimate "no real answer yet" state (spec: Component `core/doctor.mjs`, Goals).
- Template files are always read from the **repo root** (`REPO_ROOT`, computed from `doctor.mjs`'s own real location), never from the `root`/`--target` argument being checked — `config/` is not junctioned into a workspace, so `config/profile.example.yml` is only reachable at the real repo root (confirmed live: `workspaces/roberto-2/config/` contains only `plugins.yml` and `profile.yml`, no example file).
- The Telegram-onboarding self-correction retry is capped at **exactly one** retry, then proceeds anyway and logs — never blocks completion on a residual gap (spec: Component `modes/telegram-onboarding.md` item 3, Error Handling).
- The confirm-before-write step's correction loop has **no retry cap** — it's an ordinary reply exchange with the person, not an autonomous self-correction loop (spec: Error Handling).
- The optional headline/strength answer is written **lightly polished, never embellished** — preserve every factual claim exactly as given, never add a claim/metric/descriptor the candidate didn't state (spec: Component `modes/telegram-onboarding.md` item 4, same "reformulate never fabricate" discipline as `core/AGENTS.md`'s Source-of-Truth Boundary).
- `data/onboarding-gaps.log` line format is exactly: `{ISO timestamp} chatId={chatId} slug={slug} fields={comma-separated file:field entries}` (spec: Component `modes/telegram-onboarding.md` item 3).

---

## Task 1: `checkTemplateLeftovers` — `config/profile.yml` and `portals.yml`

**Files:**
- Modify: `core/doctor.mjs`
- Create: `tests/doctor-template-leftovers.test.mjs`

**Interfaces:**
- Produces: `checkTemplateLeftovers(root)` — a function in `core/doctor.mjs` returning `Array<{ file: string, label: string, fix: string[] }>` (empty array = clean). Task 2 extends this same function with two more files' checks.
- Produces: a `REPO_ROOT` constant in `core/doctor.mjs` (`dirname(DOCTOR_DIR)`) — the repo root, used to resolve template files regardless of what `root`/`--target` points at. Task 2 reuses this same constant.
- Produces: `onboardingState(root)`'s `--json` payload gains a `templateLeftovers` key holding the array from `checkTemplateLeftovers(root)`.
- Produces: `main()`'s human-readable `checks[]` array gains one WARN entry per finding, via `...checkTemplateLeftovers(projectRoot).map((f) => ({ warn: true, label: f.label, fix: f.fix }))`.
- Consumes: nothing new — `doctor.mjs` already imports `yaml` from `js-yaml`, `existsSync`/`readFileSync`/`join`/`dirname` are already imported or trivially available.

- [ ] **Step 1: Write the failing tests**

Create `tests/doctor-template-leftovers.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = join(REPO_ROOT, 'core', 'doctor.mjs');

function runDoctorJson(targetDir) {
  const out = execFileSync('node', [DOCTOR, '--target', targetDir, '--json'], { encoding: 'utf-8' });
  return JSON.parse(out);
}

function yamlList(items) {
  return items.map((s) => `    - "${s}"`).join('\n');
}

function writeProfileYml(dir, overrides = {}) {
  mkdirSync(join(dir, 'config'), { recursive: true });
  const linkedin = overrides.linkedin ?? 'linkedin.com/in/janesmith';
  const github = overrides.github ?? 'github.com/janesmith';
  const twitter = overrides.twitter ?? 'https://x.com/janesmith';
  const primary = overrides.primary ?? ['Senior AI Engineer', 'Staff ML Engineer'];
  const superpowers = overrides.superpowers ?? [
    'End-to-end ML pipelines',
    'Fast prototyping (idea to prod in 2 weeks)',
    'Cross-functional communication',
  ];
  const proofPointsYaml = overrides.proofPointsTemplate
    ? `  proof_points:\n    - name: "Project Alpha"\n      url: "https://janesmith.dev/project-alpha"\n      hero_metric: "Reduced inference latency 40%"\n    - name: "Open Source Tool"\n      url: "https://github.com/janesmith/tool"\n      hero_metric: "2K+ GitHub stars"\n`
    : '  proof_points: []\n';
  const text = `candidate:\n  linkedin: "${linkedin}"\n  github: "${github}"\n  twitter: "${twitter}"\n\ntarget_roles:\n  primary:\n${yamlList(primary)}\n\nnarrative:\n  superpowers:\n${yamlList(superpowers)}\n${proofPointsYaml}`;
  writeFileSync(join(dir, 'config', 'profile.yml'), text);
}

function writePortalsYml(dir, positive) {
  const list = positive ?? [
    'AI', 'ML', 'LLM', 'Agent', 'Agentic', 'GenAI', 'Generative AI', 'NLP', 'LLMOps', 'MLOps', 'Voice AI', 'Conversational AI', 'Speech',
  ];
  writeFileSync(join(dir, 'portals.yml'), `title_filter:\n  positive:\n${yamlList(list)}\n`);
}

test('checkTemplateLeftovers flags candidate.linkedin/github/twitter still matching the template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writeProfileYml(dir); // defaults are the template's own values
    const state = runDoctorJson(dir);
    const labels = state.templateLeftovers.filter((f) => f.file === 'config/profile.yml').map((f) => f.label).join(' | ');
    assert.match(labels, /candidate\.linkedin/);
    assert.match(labels, /candidate\.github/);
    assert.match(labels, /candidate\.twitter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTemplateLeftovers flags target_roles.primary and narrative.superpowers still matching the template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writeProfileYml(dir, { linkedin: 'linkedin.com/in/realcandidate', github: '', twitter: '' });
    const state = runDoctorJson(dir);
    const labels = state.templateLeftovers.filter((f) => f.file === 'config/profile.yml').map((f) => f.label).join(' | ');
    assert.match(labels, /target_roles\.primary/);
    assert.match(labels, /narrative\.superpowers/);
    assert.doesNotMatch(labels, /candidate\.linkedin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTemplateLeftovers flags narrative.proof_points still matching the template\'s example projects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writeProfileYml(dir, { linkedin: 'linkedin.com/in/realcandidate', github: '', twitter: '', proofPointsTemplate: true });
    const state = runDoctorJson(dir);
    const labels = state.templateLeftovers.filter((f) => f.file === 'config/profile.yml').map((f) => f.label).join(' | ');
    assert.match(labels, /narrative\.proof_points/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTemplateLeftovers does not flag a correctly-filled profile.yml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writeProfileYml(dir, {
      linkedin: 'linkedin.com/in/realcandidate',
      github: '',
      twitter: '',
      primary: ['Data Analyst', 'Analytics Engineer'],
      superpowers: ['Dashboard delivery at scale'],
    });
    const state = runDoctorJson(dir);
    assert.equal(state.templateLeftovers.filter((f) => f.file === 'config/profile.yml').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTemplateLeftovers does not flag blank candidate fields (blank is legitimate, not a leftover)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writeProfileYml(dir, { linkedin: '', github: '', twitter: '', primary: ['Data Analyst'] });
    const state = runDoctorJson(dir);
    assert.equal(state.templateLeftovers.filter((f) => f.file === 'config/profile.yml').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTemplateLeftovers flags portals.yml title_filter.positive still matching the template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writePortalsYml(dir); // default = template's own list
    const state = runDoctorJson(dir);
    const found = state.templateLeftovers.find((f) => f.file === 'portals.yml');
    assert.ok(found, 'expected a portals.yml finding');
    assert.match(found.label, /title_filter\.positive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTemplateLeftovers does not flag a customized portals.yml title_filter.positive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writePortalsYml(dir, ['Data Analyst', 'Analytics Engineer', 'Business Analyst']);
    const state = runDoctorJson(dir);
    assert.equal(state.templateLeftovers.filter((f) => f.file === 'portals.yml').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/doctor-template-leftovers.test.mjs`
Expected: every test FAILs — `state.templateLeftovers` is `undefined` (the key doesn't exist yet), so `.filter`/`.find` throw a TypeError.

- [ ] **Step 3: Read the current top of `core/doctor.mjs` to find the insertion points**

Read `core/doctor.mjs` around line 23 (where `DOCTOR_DIR` is defined) and around line 288-321 (the `USER_LAYER_PREREQS` array, a good landmark right before which to add the new function) and around line 470-484 (`main()`'s `checks` array) and around line 536-590 (`onboardingState(root)`).

- [ ] **Step 4: Add `REPO_ROOT` next to the existing `DOCTOR_DIR` constant**

In `core/doctor.mjs`, find:

```js
const DOCTOR_DIR = dirname(fileURLToPath(import.meta.url));
```

Replace with:

```js
const DOCTOR_DIR = dirname(fileURLToPath(import.meta.url));
// The actual repo root, one level above core/. Template files this script
// diffs against (config/profile.example.yml, templates/portals.example.yml,
// modes/_profile.template.md, modes/_brief.template.md) must always be read
// from HERE, never from `root`/`--target` — `config/` is not junctioned into
// a workspace (only config/profile.yml and config/plugins.yml are real
// there), so config/profile.example.yml is only reachable at the real repo
// root (#onboarding-completeness-guardrails).
const REPO_ROOT = dirname(DOCTOR_DIR);
```

- [ ] **Step 5: Add `checkTemplateLeftovers` just before `USER_LAYER_PREREQS`**

In `core/doctor.mjs`, find the comment block right before `const USER_LAYER_PREREQS = [`:

```js
// Single source of truth for the four user-layer prerequisites (the list
// AGENTS.md "First Run" documents). BOTH the human checklist (`checkPrereq`)
// and the machine-readable cold-start state (`onboardingState`) derive from
// THIS array, so they cannot drift. Paths use "/" and are split for join().
const USER_LAYER_PREREQS = [
```

Insert this new function immediately above that comment block:

```js
// Detects "this still matches the unedited template" for user-layer files
// seeded by provisioning (#onboarding-completeness-guardrails, found live
// 2026-08-20: five separate instances of unedited template/fabricated
// content surviving a real onboarding conversation because the mode's own
// instructions were narrower than what the templates actually contain).
// WARN-level only — a leftover value is weaker, not broken; never flags a
// blank value, since blank is an established "no real answer yet" state.
// Returns an array of findings (empty = clean), one entry per file/field
// that still byte-matches its template — self-maintaining, since it
// compares against the CURRENT template file, not a hardcoded string list.
function checkTemplateLeftovers(root) {
  const findings = [];

  // -- config/profile.yml vs config/profile.example.yml --
  const profilePath = join(root, 'config', 'profile.yml');
  const profileTemplatePath = join(REPO_ROOT, 'config', 'profile.example.yml');
  if (existsSync(profilePath) && existsSync(profileTemplatePath)) {
    let profile, template;
    try {
      profile = yaml.load(readFileSync(profilePath, 'utf8')) || {};
      template = yaml.load(readFileSync(profileTemplatePath, 'utf8')) || {};
    } catch {
      profile = null; template = null; // malformed YAML — other checks catch this, skip silently here
    }
    if (profile && template) {
      const scalarPaths = [['candidate', 'linkedin'], ['candidate', 'github'], ['candidate', 'twitter']];
      for (const path of scalarPaths) {
        const liveVal = path.reduce((o, k) => o?.[k], profile);
        const templateVal = path.reduce((o, k) => o?.[k], template);
        if (liveVal && templateVal && liveVal === templateVal) {
          findings.push({
            file: 'config/profile.yml',
            label: `config/profile.yml: candidate.${path[1]} still matches the unedited template value ("${templateVal}")`,
            fix: ["Fill in the real value, or set it to \"\" if the candidate doesn't have one."],
          });
        }
      }
      const arrayPaths = [['target_roles', 'primary'], ['narrative', 'superpowers'], ['narrative', 'proof_points']];
      for (const path of arrayPaths) {
        const liveVal = path.reduce((o, k) => o?.[k], profile);
        const templateVal = path.reduce((o, k) => o?.[k], template);
        if (Array.isArray(liveVal) && liveVal.length > 0 && Array.isArray(templateVal)
            && JSON.stringify(liveVal) === JSON.stringify(templateVal)) {
          findings.push({
            file: 'config/profile.yml',
            label: `config/profile.yml: ${path.join('.')} still matches the unedited template's example list`,
            fix: ['Replace with the candidate\'s real values, or [] if none apply yet.'],
          });
        }
      }
    }
  }

  // -- portals.yml vs templates/portals.example.yml --
  const portalsPath = join(root, 'portals.yml');
  const portalsTemplatePath = join(REPO_ROOT, 'templates', 'portals.example.yml');
  if (existsSync(portalsPath) && existsSync(portalsTemplatePath)) {
    let portals, portalsTemplate;
    try {
      portals = yaml.load(readFileSync(portalsPath, 'utf8')) || {};
      portalsTemplate = yaml.load(readFileSync(portalsTemplatePath, 'utf8')) || {};
    } catch {
      portals = null; portalsTemplate = null;
    }
    const liveTitles = portals?.title_filter?.positive;
    const templateTitles = portalsTemplate?.title_filter?.positive;
    if (Array.isArray(liveTitles) && liveTitles.length > 0 && Array.isArray(templateTitles)
        && JSON.stringify(liveTitles) === JSON.stringify(templateTitles)) {
      findings.push({
        file: 'portals.yml',
        label: 'portals.yml: title_filter.positive still matches the unedited template\'s example keywords',
        fix: ['Replace with keywords drawn from the candidate\'s actual target roles.'],
      });
    }
  }

  return findings;
}

```

Leave the `USER_LAYER_PREREQS` comment and array exactly as they were, immediately following.

- [ ] **Step 6: Wire the finding array into `main()`'s human-readable checks**

In `core/doctor.mjs`, find in `main()`:

```js
  const checks = [
    checkNodeVersion(),
    checkBillingSource(),
    checkDependencies(),
    await checkPlaywright(),
    checkPlaywrightMcp(projectRoot, activeCli),
    checkScanExtractor(projectRoot),
    ...USER_LAYER_PREREQS.map(checkPrereq),
    checkFonts(),
```

Replace with:

```js
  const checks = [
    checkNodeVersion(),
    checkBillingSource(),
    checkDependencies(),
    await checkPlaywright(),
    checkPlaywrightMcp(projectRoot, activeCli),
    checkScanExtractor(projectRoot),
    ...USER_LAYER_PREREQS.map(checkPrereq),
    ...checkTemplateLeftovers(projectRoot).map((f) => ({ warn: true, label: f.label, fix: f.fix })),
    checkFonts(),
```

- [ ] **Step 7: Wire the finding array into `onboardingState(root)`'s JSON payload**

In `core/doctor.mjs`, find in `onboardingState(root)`:

```js
  return {
    onboardingNeeded: missing.length > 0,
    missing,
    warnings,
    autoCopied,
    plugins,
    playwright_mcp: playwrightMcp,
    active_cli: activeCli,
    cli_source: cliSource,
  };
```

Replace with:

```js
  return {
    onboardingNeeded: missing.length > 0,
    missing,
    warnings,
    autoCopied,
    plugins,
    playwright_mcp: playwrightMcp,
    active_cli: activeCli,
    cli_source: cliSource,
    templateLeftovers: checkTemplateLeftovers(root),
  };
```

- [ ] **Step 8: Run the new tests, verify they pass**

Run: `node --test tests/doctor-template-leftovers.test.mjs`
Expected: PASS, all 7 tests.

- [ ] **Step 9: Run the full suite to check for regressions**

Run: `node core/test-all.mjs`
Expected: same pass count as baseline plus the 7 new tests, 0 failed. (Baseline going into this plan: 3160 passed, 0 failed.)

- [ ] **Step 10: Commit**

```bash
git add core/doctor.mjs tests/doctor-template-leftovers.test.mjs
git commit -m "$(cat <<'EOF'
feat: add doctor.mjs check for leftover template content (profile.yml, portals.yml)

First half of checkTemplateLeftovers (#onboarding-completeness-guardrails):
diffs config/profile.yml's candidate identity/narrative fields and
portals.yml's title_filter.positive against their live template files,
flagging only byte-identical (non-blank) matches. WARN-level, exposed
via doctor.mjs --json's new templateLeftovers key. _profile.md and
_brief.md coverage lands in the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `checkTemplateLeftovers` — `_profile.md` and `_brief.md`; interactive-path parity

**Files:**
- Modify: `core/doctor.mjs`
- Modify: `tests/doctor-template-leftovers.test.mjs`
- Modify: `core/AGENTS.md`

**Interfaces:**
- Consumes: `checkTemplateLeftovers(root)` and `REPO_ROOT` from Task 1 — extends the same function with two more file checks, appended to the same `findings` array before `return findings;`.
- Produces: nothing new consumed by later tasks — Tasks 3-6 only consume the `templateLeftovers` JSON key (already produced by Task 1), not this task's specific file checks directly.

- [ ] **Step 1: Write the failing tests**

Append to `tests/doctor-template-leftovers.test.mjs` (after the last existing test, before the final newline):

```js

function writeMinimalProfileMd(dir, { targetRolesSection, framingSection } = {}) {
  const section1 = targetRolesSection ?? `| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **AI Platform / LLMOps Engineer** | Evaluation, observability, reliability, pipelines | Someone who puts AI in production with metrics |
| **Agentic Workflows / Automation** | HITL, tooling, orchestration, multi-agent | Someone who builds reliable agent systems |`;
  const section2 = framingSection ?? `| If the role is... | Emphasize about you... | Proof point sources |
|-------------------|------------------------|---------------------|
| Platform / LLMOps | Production systems builder, observability, evals | article-digest.md + cv.md |`;
  const content = `# User Profile Context -- career-ops

## Your Target Roles

${section1}

## Your Adaptive Framing

${section2}

## Your Exit Narrative

Use the candidate's exit story from \`config/profile.yml\` to frame ALL content.
`;
  writeFileSync(join(dir, '_profile.md'), content);
}

test('checkTemplateLeftovers flags _profile.md tables still matching the template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writeMinimalProfileMd(dir); // defaults are byte-identical to the real template's own wording
    const state = runDoctorJson(dir);
    const found = state.templateLeftovers.filter((f) => f.file === '_profile.md');
    assert.equal(found.length, 2, 'expected both the Target Roles and Adaptive Framing tables to flag');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTemplateLeftovers does not flag a customized _profile.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writeMinimalProfileMd(dir, {
      targetRolesSection: `| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **Data Analyst** | Dashboards, BI reporting, stakeholder insight | Someone who turns raw data into decisions |`,
      framingSection: `| If the role is... | Emphasize about you... | Proof point sources |
|-------------------|------------------------|---------------------|
| Data Analyst | 15+ dashboards delivered for 5 departments | cv.md |`,
    });
    const state = runDoctorJson(dir);
    assert.equal(state.templateLeftovers.filter((f) => f.file === '_profile.md').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTemplateLeftovers flags _brief.md with unfilled {placeholder} text remaining', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writeFileSync(join(dir, '_brief.md'), `# {Your Name} — Triage Brief

<!-- Instructional comment mentioning {like this} is fine, it's inside the comment block -->

## Identity
{One line: seniority, discipline, years, location/timezone}

## Target Archetypes
| # | Archetype | What they buy (your proof) |
|---|-----------|----------------------------|
| 1 | **{Archetype name}** | {the capability/experience that makes you a fit} |
`);
    const state = runDoctorJson(dir);
    const found = state.templateLeftovers.find((f) => f.file === '_brief.md');
    assert.ok(found, 'expected a _brief.md finding');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTemplateLeftovers does not flag a fully-filled _brief.md, including "none specified yet" sections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-leftovers-'));
  try {
    writeFileSync(join(dir, '_brief.md'), `# Roberto Vasquez — Triage Brief

<!-- Instructional comment mentioning {like this} is fine, it's inside the comment block -->

## Identity
Associate Analytics Engineer — Tampa, FL.

## Target Archetypes
| # | Archetype | What they buy (your proof) |
|---|-----------|----------------------------|
| 1 | **Data Analyst** | 15+ dashboards delivered |

## Hard DQ Criteria — instant FAIL (< 3.0)
(none specified yet — add your own hard disqualifiers here)
`);
    const state = runDoctorJson(dir);
    assert.equal(state.templateLeftovers.filter((f) => f.file === '_brief.md').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify the four new ones fail**

Run: `node --test tests/doctor-template-leftovers.test.mjs`
Expected: the 4 new tests FAIL (no `_profile.md`/`_brief.md` handling exists yet in `checkTemplateLeftovers`); the 7 from Task 1 still PASS.

- [ ] **Step 3: Extend `checkTemplateLeftovers` with `_profile.md` and `_brief.md` checks**

In `core/doctor.mjs`, inside `checkTemplateLeftovers(root)`, find:

```js
  return findings;
}
```

Replace with (adding the markdown-section helper right above the function, and the two new blocks right before the existing `return findings;`):

First, add this helper function immediately above `function checkTemplateLeftovers(root) {`:

```js
// Extracts the raw text of a markdown section (everything between a `##`
// heading and the next `##` heading, or end of file), trimmed. Returns null
// if the heading isn't found. Used to diff _profile.md's example tables
// against the live template without needing a full markdown parser.
function extractMarkdownSection(content, heading) {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === heading);
  if (startIdx === -1) return null;
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^##\s/.test(l));
  const body = endIdx === -1 ? rest : rest.slice(0, endIdx);
  return body.join('\n').trim();
}
```

Then replace the function's closing `return findings;\n}` with:

```js
  // -- _profile.md vs modes/_profile.template.md --
  const profileMdPath = join(root, '_profile.md');
  const profileMdTemplatePath = join(REPO_ROOT, 'modes', '_profile.template.md');
  if (existsSync(profileMdPath) && existsSync(profileMdTemplatePath)) {
    const live = readFileSync(profileMdPath, 'utf8');
    const tmpl = readFileSync(profileMdTemplatePath, 'utf8');
    for (const heading of ['## Your Target Roles', '## Your Adaptive Framing']) {
      const liveSection = extractMarkdownSection(live, heading);
      const tmplSection = extractMarkdownSection(tmpl, heading);
      if (liveSection && tmplSection && liveSection === tmplSection) {
        findings.push({
          file: '_profile.md',
          label: `_profile.md: "${heading.replace('## ', '')}" section still matches the unedited template's example archetypes`,
          fix: ['Replace the example rows with the candidate\'s real target roles/archetypes and proof points.'],
        });
      }
    }
  }

  // -- _brief.md: unfilled {placeholder} text (this template marks its own
  // fill-in spots with {like this} syntax, so no template comparison is
  // needed — just scan for anything still bracketed outside the file's own
  // instructional HTML comment block). --
  const briefPath = join(root, '_brief.md');
  if (existsSync(briefPath)) {
    const live = readFileSync(briefPath, 'utf8');
    const withoutComments = live.replace(/<!--[\s\S]*?-->/g, '');
    const bracketPlaceholder = /\{[A-Za-z][^{}]*\}/;
    if (bracketPlaceholder.test(withoutComments)) {
      findings.push({
        file: '_brief.md',
        label: '_brief.md still contains unfilled {placeholder} text',
        fix: ['Fill in Identity, Target Archetypes, Proof Points, and Comp Strategy from the conversation; use plain "none specified yet" prose (not brackets) for genuinely-empty sections.'],
      });
    }
  }

  return findings;
}
```

- [ ] **Step 4: Run the tests, verify all pass**

Run: `node --test tests/doctor-template-leftovers.test.mjs`
Expected: PASS, all 11 tests (7 from Task 1 + 4 new).

- [ ] **Step 5: Add interactive-path parity to `core/AGENTS.md`**

Read `core/AGENTS.md` around its "Step 6: Ready" section. Find:

```
#### Step 6: Ready
Once all files exist, confirm:
```

Replace with:

```
#### Step 6: Ready
Once all files exist, re-run `node doctor.mjs --json` and check `templateLeftovers` — if it's non-empty, fix those fields the same way any other `doctor.mjs` warning gets fixed (a human is present on this path, so no self-correction loop is needed; just show and fix it) before continuing. Once clean, confirm:
```

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `node core/test-all.mjs`
Expected: same pass count as Task 1's baseline plus 4 more, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add core/doctor.mjs tests/doctor-template-leftovers.test.mjs core/AGENTS.md
git commit -m "$(cat <<'EOF'
feat: extend doctor.mjs template-leftover check to _profile.md and _brief.md

Second half of checkTemplateLeftovers (#onboarding-completeness-
guardrails): diffs _profile.md's two example archetype tables against
the live template, and scans _brief.md for any remaining {placeholder}
text (this template already marks its own fill-in spots that way, so
no template comparison is needed there). Also makes the existing
interactive onboarding path (core/AGENTS.md Step 6) re-run doctor.mjs
and check templateLeftovers before declaring "You're all set" — the
same protection Telegram onboarding will get in a later task, since
this check runs for every workspace via doctor.mjs, not just
Telegram-provisioned ones.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Confirm-before-write step in `modes/telegram-onboarding.md`

**Files:**
- Modify: `modes/telegram-onboarding.md`
- Modify: `tests/telegram-onboarding-mode.test.mjs`

**Interfaces:**
- Produces: a new `currentStep` value, `profile_confirm`, documented in the mode's "## State" section and used by the new "## Step 4b — Profile basics: write files" section. Tasks 4, 5, and 6 all modify content inside Step 4b (Task 4 edits the `narrative.proof_points` line inside sub-item `a`; Task 5 inserts a new sub-item between `c` and `d`; Task 6 changes sub-items `d`/`e` and adds a new `## Step 4c` section after Step 4b).
- Produces: Step 4b's file-writing sub-items are lettered `a` (profile.yml) / `b` (portals.yml) / `c` (`_profile.md`/`_brief.md`) / `d` (send spend-tier question) / `e` (advance `currentStep` to `discord`) — this exact lettering is what Task 4/5/6 modify by name.
- Consumes: nothing new from earlier tasks (this is the first mode-file task).

- [ ] **Step 1: Write the failing test assertions**

In `tests/telegram-onboarding-mode.test.mjs`, inside the first test (`modes/telegram-onboarding.md exists and covers the required conventions`), add these two assertions right after the existing `location_flexibility` assertion (before the test's closing `});`):

```js
  assert.match(
    content,
    /profile_confirm/,
    'must document the profile_confirm state and a read-back/confirm step before writing any files (#onboarding-completeness-guardrails: closes the class of bug where a correctly-extracted-yet-incomplete answer, like the location_flexibility case above, would otherwise slip through undetected — the candidate is the one who notices a dropped detail, not a script)',
  );
  assert.match(
    content,
    /Reply "yes" to continue, or tell me what to fix/,
    'must send a read-back summary and wait for explicit confirmation before Step 4b writes any workspace files',
  );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/telegram-onboarding-mode.test.mjs`
Expected: FAIL — neither string exists in the mode file yet.

- [ ] **Step 3: Update the "## State" section's `currentStep` enum**

In `modes/telegram-onboarding.md`, find:

```
`currentStep` is one of: `name`, `cv`, `profile`, `discord`, `done`. This mode reads the state, processes the new message against `currentStep`, writes the answer into a real file as soon as it's given (never held only in memory), advances `currentStep`, and re-saves the state — except at `done`, where the state file is deleted instead (see Step 6).
```

Replace with:

```
`currentStep` is one of: `name`, `cv`, `profile`, `profile_confirm`, `profile_narrative`, `discord`, `done`. This mode reads the state, processes the new message against `currentStep`, writes the answer into a real file as soon as it's given (never held only in memory), advances `currentStep`, and re-saves the state — except at `done`, where the state file is deleted instead (see Step 6).
```

- [ ] **Step 4: Replace "## Step 4 — Profile basics" with the split parse/confirm + write-files sections**

In `modes/telegram-onboarding.md`, find the entire block starting at `## Step 4 — Profile basics` and ending right before `## Step 5 — Spend tier + Discord webhook (optional)` (i.e. everything from the `## Step 4` heading through the line `6. Advance \`currentStep\` to \`discord\`, save state (the spend-tier reply is handled inline in Step 5, since it's the same logical question set — \`currentStep\` only needs to distinguish "waiting on roles/location/salary" from "waiting on discord/skip").`).

Replace that entire block with:

```markdown
## Step 4 — Profile basics: parse and confirm

On receiving the roles/location/salary reply:

1. Parse the three answers (best-effort natural-language extraction — if something's ambiguous, ask a single focused follow-up rather than guessing, then continue once answered). If the reply names more than one acceptable location (found live 2026-08-20: a real reply named four — "Tampa, anywhere in California, Chicago, Pittsburgh" — and only the one asked about for timezone purposes made it into any file, silently dropping the other three), identify which is primary (ask if it isn't already clear) and keep the rest as a separate list for the flexibility note Step 4b writes.
2. Store the parsed answers in `answers.roles`, `answers.primaryLocation`, `answers.otherLocations` (array, may be empty), and `answers.salary` — this is the source Step 4b writes from, so nothing needs re-parsing after confirmation.
3. Send a read-back so the candidate — not a script — is the one who notices a dropped detail (this is what would have caught the four-locations case at the source):
   `Got it — here's what I have:\nRoles: {roles}\nPrimary location: {primaryLocation}{, also open to: {otherLocations} — only if otherLocations is non-empty}\nTarget comp: {salary}\n\nReply "yes" to continue, or tell me what to fix.`
4. Advance `currentStep` to `profile_confirm`, save state. Do not write any workspace files yet — Step 4b does that, only after confirmation.

## Step 4b — Profile basics: write files

On receiving the `profile_confirm` reply:

1. If it's a correction (not "yes"/equivalent): re-parse the correction against the stored `answers.*` (update only what changed), re-send the same read-back format as Step 4's item 3 with the corrected values, stay on `profile_confirm` (don't advance). No retry cap here — this is an ordinary back-and-forth with the person, not a self-correction loop.
2. Once confirmed ("yes" or equivalent):
   a. Copy `config/profile.example.yml` (the repo-root template — a bare relative path is correct here, the session cwd *is* the repo root) into `workspaces/{slug}/config/profile.yml` if it isn't already the seeded template (it already is, from `--from-name`'s provisioning step). Edit it in full — the seeded copy is the *example* template verbatim, and every one of its example values is fabricated content about a fictional person ("Jane Smith," a fake LinkedIn/GitHub, an invented "built and sold my SaaS" story). Leaving any of it in place is exactly the fabrication this system's own non-negotiable rule (AGENTS.md → Source-of-Truth Boundary) exists to prevent — it must never survive onboarding:
      - `target_roles`/`compensation.target_range`/`compensation.minimum`: fill from the confirmed `answers.roles`/`answers.salary`.
      - `location.city`/`location.timezone`: fill from the confirmed `answers.primaryLocation`.
      - `compensation.location_flexibility`: if `answers.otherLocations` is non-empty, a plain-language note naming them (e.g. `"Tampa is home base; also open to relocating to California, Chicago, or Pittsburgh"`) — never leave it blank when the candidate named more than one place. Blank (`""`) only when `answers.otherLocations` is empty.
      - `candidate.email`/`candidate.phone`/`candidate.linkedin`/`candidate.portfolio_url`/`candidate.github`: fill from whatever the pasted CV (Step 3) actually contains — if the CV has no GitHub link, for example, set `github: ""`, never leave the template's `github.com/janesmith`.
      - `candidate.twitter`: blank (`""`) unless the CV explicitly gives one — never leave the template's placeholder.
      - `narrative.headline`, `narrative.exit_story`: blank (`""`) — nothing in this conversation asks for these, so there is no real answer to put here, only the template's fabricated one to remove.
      - `narrative.superpowers`, `narrative.proof_points`: empty arrays (`[]`) for the same reason.
   b. Edit `workspaces/{slug}/portals.yml`'s `title_filter.positive` list (found live 2026-08-20: this drives what job postings scanning actually searches for, and the seeded template ships it pre-filled with AI/ML-focused example keywords — "GenAI," "LLMOps," "Agentic," etc. — that match nothing for a candidate targeting an unrelated field, silently making every scan return zero relevant results). Replace the seeded list with keywords drawn directly from `target_roles.primary` (the same roles just written to `profile.yml` above) plus their obvious close synonyms (e.g. targeting "Data Analyst" → also add "Data Analytics," "Business Intelligence," "BI Analyst" — stay close to what was actually said, never invent an unrelated specialty). Leave `title_filter.negative` and `seniority_boost` as seeded — tuning those further is a reasonable thing to leave for the candidate to refine later through normal conversation, not something onboarding needs to guess at.
   c. Edit `workspaces/{slug}/_profile.md` and `workspaces/{slug}/_brief.md` (found live 2026-08-20: both are seeded from `modes/_profile.template.md`/`modes/_brief.template.md` by provisioning, exactly like `portals.yml`, and neither was otherwise touched by this mode — left alone, `_profile.md`'s "Your Target Roles"/"Your Adaptive Framing" tables ship generic AI/LLMOps example archetypes that drive real scoring per `core/AGENTS.md`'s "Archetypes / targeting → `_profile.md`", and `_brief.md` — read by `modes/triage.md` on every first-pass filtering decision — ships as entirely unfilled `{placeholder}` text):
      - `_profile.md`: replace the "Your Target Roles" and "Your Adaptive Framing" tables' example rows with the candidate's actual `target_roles.primary`/`archetypes` (from profile.yml, above) and proof points drawn only from what their CV (Step 3) actually contains. Leave the rest of the file (negotiation scripts, comp/location scoring guidance) as seeded — it's generic instructions to the agent, not a factual claim about the candidate, so it isn't fabrication.
      - `_brief.md`: fill in Identity, Target Archetypes, Proof Points, and Comp Strategy from the same roles/CV/location/salary data already collected in this conversation. For sections with no real answer yet (Hard DQ Criteria, Soft Red Flags, Priority Override List), leave an explicit "none yet" rather than inventing one — same convention the seeded `_custom.md` already uses for its own empty sections.
   d. Send: `Last setup choice — how much do you want to spend on model usage per evaluation?\n💰 economy — cheapest/fastest, good for scanning lots of offers\n⚖️ standard — balanced (most people pick this)\n💎 premium — most capable, best for offers you really care about\n\nReply with one word.`
   e. Advance `currentStep` to `discord`, save state.
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `node --test tests/telegram-onboarding-mode.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `node core/test-all.mjs`
Expected: same pass count as Task 2's total plus 2 more, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add modes/telegram-onboarding.md tests/telegram-onboarding-mode.test.mjs
git commit -m "$(cat <<'EOF'
feat: add confirm-before-write step to Telegram onboarding's profile basics

(#onboarding-completeness-guardrails) Splits the old single "Step 4 —
Profile basics" into Step 4 (parse + read-back the roles/location/
salary reply, wait for "yes") and Step 4b (write files only once
confirmed). This is what would have caught the location_flexibility
bug found live 2026-08-20 at the source: the candidate, not a script,
is the one who notices a dropped detail. A correction re-parses and
re-sends the summary with no retry cap, since it's an ordinary
back-and-forth with the person.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `narrative.proof_points` auto-derivation from the CV

**Files:**
- Modify: `modes/telegram-onboarding.md`
- Modify: `tests/telegram-onboarding-mode.test.mjs`

**Interfaces:**
- Consumes: Step 4b's sub-item `a` from Task 3 — modifies only the `narrative.superpowers`/`narrative.proof_points` line inside it.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing test assertion**

In `tests/telegram-onboarding-mode.test.mjs`, add after the two assertions added in Task 3:

```js
  assert.match(
    content,
    /narrative\.proof_points.*derive|derive.*narrative\.proof_points/s,
    'must instruct auto-deriving narrative.proof_points from the CV\'s strongest quantified achievements, the same source _brief.md\'s Proof Points section already draws from — content already collected should be reused, not left blank by default (#onboarding-completeness-guardrails)',
  );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/telegram-onboarding-mode.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Update Step 4b sub-item `a`'s narrative line**

In `modes/telegram-onboarding.md`, find:

```
      - `narrative.headline`, `narrative.exit_story`: blank (`""`) — nothing in this conversation asks for these, so there is no real answer to put here, only the template's fabricated one to remove.
      - `narrative.superpowers`, `narrative.proof_points`: empty arrays (`[]`) for the same reason.
```

Replace with:

```
      - `narrative.headline`, `narrative.exit_story`: blank (`""`) — nothing in this conversation asks for these, so there is no real answer to put here, only the template's fabricated one to remove.
      - `narrative.superpowers`: blank (`[]`) for now.
      - `narrative.proof_points`: derive 2-3 entries from the CV's (Step 3) strongest **quantified** achievements — the same kind of content `_brief.md`'s Proof Points section below already draws from (e.g. "15+ dashboards delivered for 5 departments," "91% accuracy classification model"). Use the template's `{name, url, hero_metric}` shape; omit `url` (leave `""`) when the CV doesn't give one for that achievement. Never invent a metric the CV doesn't state — this is content already collected in Step 3, reused more fully, not a new claim.
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test tests/telegram-onboarding-mode.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `node core/test-all.mjs`
Expected: same pass count as Task 3's total plus 1 more, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add modes/telegram-onboarding.md tests/telegram-onboarding-mode.test.mjs
git commit -m "$(cat <<'EOF'
feat: auto-derive narrative.proof_points from the CV during onboarding

(#onboarding-completeness-guardrails) narrative.proof_points was left
blank on the reasoning that "nothing in this conversation asks for
this" — but it doesn't need a new question, since it's the same
quantified-achievement content _brief.md's Proof Points section
already pulls from the CV. Reuses content already collected instead
of leaving a field blank that didn't need to be.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Completeness-check gate with bounded self-correction and gap logging

**Files:**
- Modify: `modes/telegram-onboarding.md`
- Modify: `tests/telegram-onboarding-mode.test.mjs`

**Interfaces:**
- Consumes: `doctor.mjs --target <dir> --json`'s `templateLeftovers` key, produced by Task 1/2.
- Consumes: Step 4b's sub-items `c`/`d`/`e` from Task 3 — inserts a new sub-item between `c` and `d`, relettering the trailing two from `d`/`e` to `e`/`f`.
- Produces: `data/onboarding-gaps.log` line format (documented here, used only by this mode — no other task reads it).

- [ ] **Step 1: Write the failing test assertions**

In `tests/telegram-onboarding-mode.test.mjs`, add after the assertion added in Task 4:

```js
  assert.match(
    content,
    /doctor\.mjs --target workspaces\/\{slug\} --json/,
    'must run the doctor.mjs completeness check against the workspace before binding (#onboarding-completeness-guardrails)',
  );
  assert.match(
    content,
    /templateLeftovers/,
    'must inspect doctor.mjs\'s templateLeftovers field to decide whether to self-correct',
  );
  assert.match(
    content,
    /one retry|one bounded|bounded self-correction/i,
    'must cap the self-correction attempt at exactly one retry before proceeding anyway',
  );
  assert.match(
    content,
    /onboarding-gaps\.log/,
    'must log a residual gap to data/onboarding-gaps.log rather than blocking completion, matching this codebase\'s "flag, never silently hide" convention',
  );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/telegram-onboarding-mode.test.mjs`
Expected: FAIL — none of these strings exist yet.

- [ ] **Step 3: Insert the completeness-check sub-item into Step 4b**

In `modes/telegram-onboarding.md`, find (this is Step 4b's sub-items `c` through `e`, as they stand after Task 3):

```
   c. Edit `workspaces/{slug}/_profile.md` and `workspaces/{slug}/_brief.md` (found live 2026-08-20: both are seeded from `modes/_profile.template.md`/`modes/_brief.template.md` by provisioning, exactly like `portals.yml`, and neither was otherwise touched by this mode — left alone, `_profile.md`'s "Your Target Roles"/"Your Adaptive Framing" tables ship generic AI/LLMOps example archetypes that drive real scoring per `core/AGENTS.md`'s "Archetypes / targeting → `_profile.md`", and `_brief.md` — read by `modes/triage.md` on every first-pass filtering decision — ships as entirely unfilled `{placeholder}` text):
      - `_profile.md`: replace the "Your Target Roles" and "Your Adaptive Framing" tables' example rows with the candidate's actual `target_roles.primary`/`archetypes` (from profile.yml, above) and proof points drawn only from what their CV (Step 3) actually contains. Leave the rest of the file (negotiation scripts, comp/location scoring guidance) as seeded — it's generic instructions to the agent, not a factual claim about the candidate, so it isn't fabrication.
      - `_brief.md`: fill in Identity, Target Archetypes, Proof Points, and Comp Strategy from the same roles/CV/location/salary data already collected in this conversation. For sections with no real answer yet (Hard DQ Criteria, Soft Red Flags, Priority Override List), leave an explicit "none yet" rather than inventing one — same convention the seeded `_custom.md` already uses for its own empty sections.
   d. Send: `Last setup choice — how much do you want to spend on model usage per evaluation?\n💰 economy — cheapest/fastest, good for scanning lots of offers\n⚖️ standard — balanced (most people pick this)\n💎 premium — most capable, best for offers you really care about\n\nReply with one word.`
   e. Advance `currentStep` to `discord`, save state.
```

Replace with:

```
   c. Edit `workspaces/{slug}/_profile.md` and `workspaces/{slug}/_brief.md` (found live 2026-08-20: both are seeded from `modes/_profile.template.md`/`modes/_brief.template.md` by provisioning, exactly like `portals.yml`, and neither was otherwise touched by this mode — left alone, `_profile.md`'s "Your Target Roles"/"Your Adaptive Framing" tables ship generic AI/LLMOps example archetypes that drive real scoring per `core/AGENTS.md`'s "Archetypes / targeting → `_profile.md`", and `_brief.md` — read by `modes/triage.md` on every first-pass filtering decision — ships as entirely unfilled `{placeholder}` text):
      - `_profile.md`: replace the "Your Target Roles" and "Your Adaptive Framing" tables' example rows with the candidate's actual `target_roles.primary`/`archetypes` (from profile.yml, above) and proof points drawn only from what their CV (Step 3) actually contains. Leave the rest of the file (negotiation scripts, comp/location scoring guidance) as seeded — it's generic instructions to the agent, not a factual claim about the candidate, so it isn't fabrication.
      - `_brief.md`: fill in Identity, Target Archetypes, Proof Points, and Comp Strategy from the same roles/CV/location/salary data already collected in this conversation. For sections with no real answer yet (Hard DQ Criteria, Soft Red Flags, Priority Override List), leave an explicit "none yet" rather than inventing one — same convention the seeded `_custom.md` already uses for its own empty sections.
   d. Run the completeness check: `node core/doctor.mjs --target workspaces/{slug} --json` and read `.templateLeftovers` from its output. If it's a non-empty array: re-edit the flagged fields/files using data already in this conversation (no new question to the candidate — this is self-correction against information already gathered, not a wait on a reply), then re-run the same command once. If `.templateLeftovers` is still non-empty after that one retry: proceed anyway (never leave a real person stuck mid-setup on an internal QA issue), but append one line to `data/onboarding-gaps.log` (hub-global, repo root — create the file if it doesn't exist) in this exact format: `{ISO timestamp} chatId={chatId} slug={slug} fields={comma-separated file:field entries from the still-flagged findings}`. This is one bounded retry, never more — matches this codebase's existing "flag, never silently hide" convention (`data/blacklist.md`, agent-inbox) rather than looping indefinitely.
   e. Send: `Last setup choice — how much do you want to spend on model usage per evaluation?\n💰 economy — cheapest/fastest, good for scanning lots of offers\n⚖️ standard — balanced (most people pick this)\n💎 premium — most capable, best for offers you really care about\n\nReply with one word.`
   f. Advance `currentStep` to `discord`, save state.
```

- [ ] **Step 4: Add the check-crash-vs-check-found-leftovers distinction to "## Error handling"**

In `modes/telegram-onboarding.md`, find:

```
## Error handling

If a step's tool call fails (a write error, `provision-workspace.mjs` exiting non-zero), do not fabricate progress — send `⚠️ Something went wrong on my end — could you resend that last message?`, leave `currentStep` unchanged, and stop this turn. The next message retries the same step.
```

Replace with:

```
## Error handling

If a step's tool call fails (a write error, `provision-workspace.mjs` exiting non-zero), do not fabricate progress — send `⚠️ Something went wrong on my end — could you resend that last message?`, leave `currentStep` unchanged, and stop this turn. The next message retries the same step. This applies to Step 4b's `doctor.mjs` completeness check crashing/erroring outright too — that's a tool failure like any other. It does **not** apply to a clean `doctor.mjs` run that finds real `templateLeftovers`: that case is handled entirely inside Step 4b (one self-correction retry, then proceed and log), never by this generic "resend the last message" path, since there's no last message to resend — the candidate never sees this check happen at all unless it changes what gets written.
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `node --test tests/telegram-onboarding-mode.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `node core/test-all.mjs`
Expected: same pass count as Task 4's total plus 4 more, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add modes/telegram-onboarding.md tests/telegram-onboarding-mode.test.mjs
git commit -m "$(cat <<'EOF'
feat: gate Telegram onboarding on doctor.mjs's template-leftover check

(#onboarding-completeness-guardrails) Before sending the spend-tier
question, Step 4b now runs `doctor.mjs --target workspaces/{slug}
--json` and checks templateLeftovers. Any finding gets one bounded
self-correction retry using data already in the conversation; still
flagged after that, onboarding proceeds anyway (never blocks a real
person on an internal QA issue) but logs one line to
data/onboarding-gaps.log for the operator to review later — matching
this codebase's "flag, never silently hide" convention.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Optional headline/strength question and completion-message addendum

**Files:**
- Modify: `modes/telegram-onboarding.md`
- Modify: `tests/telegram-onboarding-mode.test.mjs`

**Interfaces:**
- Consumes: Step 4b's sub-items `e`/`f` from Task 5 — replaces them, moving the spend-tier-send/discord-advance logic into a new "## Step 4c" section.
- Produces: a new `profile_narrative` `currentStep` value (added to the "## State" enum, alongside `profile_confirm` from Task 3) and a new "## Step 4c — Professional headline (optional)" section, inserted between "## Step 4b" and "## Step 5".

- [ ] **Step 1: Write the failing test assertions**

In `tests/telegram-onboarding-mode.test.mjs`, add after the assertions added in Task 5:

```js
  assert.match(
    content,
    /profile_narrative/,
    'must document the profile_narrative state for the optional headline/strength question (#onboarding-completeness-guardrails)',
  );
  assert.match(
    content,
    /pitch yourself professionally/,
    'must ask an optional, skippable question for narrative.headline/narrative.superpowers — a CV can\'t answer these, only the candidate can',
  );
  assert.match(
    content,
    /Reply "skip" to finish now/,
    'the optional headline/strength question must be clearly skippable, same pattern as the Discord webhook question',
  );
  assert.match(
    content,
    /lightly polished|light(ly)? polish/i,
    'an answered headline/strength reply must be lightly polished for grammar/tone, never left verbatim-unedited nor embellished',
  );
  assert.match(
    content,
    /never add a claim|never embellish|not embellished/i,
    'must explicitly forbid adding any claim, metric, or descriptor the candidate didn\'t state when polishing the headline/strength answer — same reformulate-never-fabricate discipline as the rest of this system',
  );
  assert.match(
    content,
    /message me anytime|tell me more.*anytime|anytime.*tell me more/i,
    'the completion message must invite ongoing enrichment for whatever is still deliberately left blank',
  );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/telegram-onboarding-mode.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Update the "## State" section's `currentStep` enum again**

In `modes/telegram-onboarding.md`, find (as left by Task 3):

```
`currentStep` is one of: `name`, `cv`, `profile`, `profile_confirm`, `profile_narrative`, `discord`, `done`. This mode reads the state, processes the new message against `currentStep`, writes the answer into a real file as soon as it's given (never held only in memory), advances `currentStep`, and re-saves the state — except at `done`, where the state file is deleted instead (see Step 6).
```

This line already includes `profile_narrative` (added preemptively in Task 3's replacement text) — verify it's present; no further edit needed here. If for any reason it's missing, add `profile_narrative` between `profile_confirm` and `discord` in the enum list.

- [ ] **Step 4: Replace Step 4b's trailing sub-items and insert the new Step 4c**

In `modes/telegram-onboarding.md`, find (Step 4b's sub-items `e`/`f`, as left by Task 5):

```
   e. Send: `Last setup choice — how much do you want to spend on model usage per evaluation?\n💰 economy — cheapest/fastest, good for scanning lots of offers\n⚖️ standard — balanced (most people pick this)\n💎 premium — most capable, best for offers you really care about\n\nReply with one word.`
   f. Advance `currentStep` to `discord`, save state.

## Step 5 — Spend tier + Discord webhook (optional)
```

Replace with:

```
   e. Send: `One more optional thing — in a line or two, how would you pitch yourself professionally, and what's your #1 strength that sets you apart? Reply "skip" to finish now — you can always tell me more later.`
   f. Advance `currentStep` to `profile_narrative`, save state.

## Step 4c — Professional headline (optional)

On receiving the `profile_narrative` reply:

1. If it's "skip" (or equivalent): leave `workspaces/{slug}/config/profile.yml`'s `narrative.headline` (`""`) and `narrative.superpowers` (`[]`) as Step 4b left them — this is still correct, not a gap, exactly like the Discord webhook being skippable.
2. Otherwise, write the reply to those fields **lightly polished, not verbatim and not embellished**: fix grammar/phrasing/conciseness for a professional tone, but preserve every factual claim exactly as given and never add a claim, metric, or descriptor the candidate didn't state — the same "keywords get reformulated, never fabricated" discipline `core/AGENTS.md`'s Source-of-Truth Boundary already requires everywhere else in this system (CV tailoring, cover letters), applied here to the candidate's own self-description instead of CV bullets. A single strength becomes a one-item `narrative.superpowers` list; multiple strengths in one reply split into separate list items, each polished the same way. The "how would you pitch yourself" half of the reply goes to `narrative.headline`.
3. Send: `Last setup choice — how much do you want to spend on model usage per evaluation?\n💰 economy — cheapest/fastest, good for scanning lots of offers\n⚖️ standard — balanced (most people pick this)\n💎 premium — most capable, best for offers you really care about\n\nReply with one word.`
4. Advance `currentStep` to `discord`, save state (the spend-tier reply is handled inline in Step 5, since it's the same logical question set — `currentStep` only needs to distinguish "waiting on the headline/skip reply" from "waiting on discord/skip").

## Step 5 — Spend tier + Discord webhook (optional)
```

- [ ] **Step 5: Add the completion-message addendum to Step 6**

In `modes/telegram-onboarding.md`, find:

```
3. Send the completion message, followed immediately by `modes/telegram.md` Step 3g's exact help text (read it from that file — never duplicate/paraphrase it here, since it drifts):
   > `✅ All set! You're ready to search. Here's what I can do:`
4. Nothing further happens in this turn — the *next* message from this chat will be picked up by `core/telegram-router.mjs` as a bound chat and routed through `modes/telegram.md` normally.
```

Replace with:

```
3. Send the completion message, followed immediately by `modes/telegram.md` Step 3g's exact help text (read it from that file — never duplicate/paraphrase it here, since it drifts):
   > `✅ All set! You're ready to search. Here's what I can do:`
   Then send one more short message inviting ongoing enrichment for whatever's still deliberately blank (exit story, hard disqualifiers, priority companies, and headline/superpowers if Step 4c was skipped):
   > `The more you tell me about yourself over time, the smarter this gets — just message me anytime.`
4. Nothing further happens in this turn — the *next* message from this chat will be picked up by `core/telegram-router.mjs` as a bound chat and routed through `modes/telegram.md` normally.
```

- [ ] **Step 6: Add a non-fabrication bullet to "## What this mode never does"**

In `modes/telegram-onboarding.md`, find:

```
- Never invents CV content, skills, or achievements not present in what the candidate actually pasted — same non-fabrication discipline as every other content-generating mode in this system.
```

Replace with:

```
- Never invents CV content, skills, or achievements not present in what the candidate actually pasted — same non-fabrication discipline as every other content-generating mode in this system. The same rule applies to Step 4c's optional headline/strength question: polishing the candidate's own words for grammar and tone is fine, adding a claim, metric, or descriptor they didn't state is not.
```

- [ ] **Step 7: Run the test, verify it passes**

Run: `node --test tests/telegram-onboarding-mode.test.mjs`
Expected: PASS.

- [ ] **Step 8: Run the full suite to check for regressions**

Run: `node core/test-all.mjs`
Expected: same pass count as Task 5's total plus 6 more, 0 failed.

- [ ] **Step 9: Manually re-verify `modes/telegram-onboarding.md` reads correctly end-to-end**

Read the full file once more after all six tasks. Confirm: the `## State` section's `currentStep` enum lists all seven values in the order they actually occur (`name, cv, profile, profile_confirm, profile_narrative, discord, done`); Step 4 → Step 4b → Step 4c → Step 5 → Step 6 flow in that order with no orphaned reference to a step that no longer exists; Step 4b's sub-items are lettered `a` through `f` with no gaps or duplicates.

- [ ] **Step 10: Commit**

```bash
git add modes/telegram-onboarding.md tests/telegram-onboarding-mode.test.mjs
git commit -m "$(cat <<'EOF'
feat: add optional headline/strength question to Telegram onboarding

(#onboarding-completeness-guardrails) New Step 4c asks one optional,
skippable question for the two profile fields a CV structurally can't
answer — a professional headline and a self-described top strength.
An actual answer is written lightly polished (grammar/tone only),
never embellished with an unstated claim — same discipline already
required for CV tailoring. Skipping leaves those fields blank, same
as today. The completion message also now invites ongoing enrichment
for whatever's still deliberately left blank, since closing that gap
fully isn't something a 5-minute setup conversation should attempt.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** Guardrail A (doctor.mjs mechanism, `--json` shape, WARN semantics, interactive-path parity) → Tasks 1-2. Guardrail B (confirm step, proof_points reuse, completeness gate + retry + log, optional question + polishing, completion addendum) → Tasks 3-6. Every numbered item in the spec's "Component" sections has a corresponding task step above.
- **Blank-never-flags rule:** exercised explicitly in Task 1's "does not flag blank candidate fields" test and Task 2's "none specified yet" test — both must keep passing through every later task, since nothing after Task 2 touches `checkTemplateLeftovers` itself.
- **State machine consistency:** `profile_confirm` (Task 3) and `profile_narrative` (Task 6) are both declared in the same enum line Task 3 first edits; Task 6's Step 3 is a verification step, not a blind re-edit, specifically to avoid double-inserting `profile_narrative` if Task 3's implementer already included it as instructed.
- **No task references a section a later task hasn't created yet** — Task 4 touches only Step 4b sub-item `a` (exists since Task 3); Task 5 touches Step 4b sub-items `c`-`e` (exist since Task 3, or `e` as renumbered — wait, Task 5 finds `c`/`d`/`e` as Task 3 left them, before any Task 4 edit to `a`, which is unaffected — confirmed no conflict); Task 6 touches Step 4b's `e`/`f` as Task 5 left them. Verified in order top-to-bottom above.
