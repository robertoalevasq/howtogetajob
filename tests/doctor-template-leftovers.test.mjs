import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = join(REPO_ROOT, 'core', 'doctor.mjs');

// Read the template's own current title_filter.positive list rather than a
// hardcoded snapshot, so this test can't drift out of sync with
// templates/portals.example.yml as that file is edited over time.
const PORTALS_TEMPLATE_POSITIVE = yaml.load(
  readFileSync(join(REPO_ROOT, 'templates', 'portals.example.yml'), 'utf8')
).title_filter.positive;

// Same anti-drift approach for _profile.md's example tables: extract them
// live from modes/_profile.template.md (mirrors extractMarkdownSection in
// core/doctor.mjs) rather than hardcoding a snapshot of its wording that
// would go stale the next time that template's example rows are edited.
function extractMarkdownSection(content, heading) {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === heading);
  if (startIdx === -1) return null;
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^##\s/.test(l));
  const body = endIdx === -1 ? rest : rest.slice(0, endIdx);
  return body.join('\n').trim();
}
const PROFILE_MD_TEMPLATE = readFileSync(join(REPO_ROOT, 'modes', '_profile.template.md'), 'utf8');
const PROFILE_TEMPLATE_TARGET_ROLES = extractMarkdownSection(PROFILE_MD_TEMPLATE, '## Your Target Roles');
const PROFILE_TEMPLATE_ADAPTIVE_FRAMING = extractMarkdownSection(PROFILE_MD_TEMPLATE, '## Your Adaptive Framing');

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
  const list = positive ?? PORTALS_TEMPLATE_POSITIVE;
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
    writeProfileYml(dir, {
      linkedin: '',
      github: '',
      twitter: '',
      primary: ['Data Analyst'],
      superpowers: ['Dashboard delivery at scale'],
    });
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

function writeMinimalProfileMd(dir, { targetRolesSection, framingSection } = {}) {
  // Defaults are read live from modes/_profile.template.md above (not
  // hardcoded), so they stay byte-identical to the real template's current
  // wording even as that file's example rows are edited over time.
  const section1 = targetRolesSection ?? PROFILE_TEMPLATE_TARGET_ROLES;
  const section2 = framingSection ?? PROFILE_TEMPLATE_ADAPTIVE_FRAMING;
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
