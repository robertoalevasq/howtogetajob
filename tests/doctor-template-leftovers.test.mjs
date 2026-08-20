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
