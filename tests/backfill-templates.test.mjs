import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { findMissingKeyPaths, checkFile, applyFile } from '../core/backfill-templates.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-templates-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('findMissingKeyPaths finds a top-level key missing from the live doc', () => {
  const template = parseDocument('a: 1\nb: 2\n');
  const live = parseDocument('a: 1\n');
  const missing = findMissingKeyPaths(template.contents, live.contents);
  assert.deepEqual(missing, [['b']]);
});

test('findMissingKeyPaths finds a nested key missing without recursing past the missing point', () => {
  const template = parseDocument('narrative:\n  superpowers: []\n  deal_breakers: []\n');
  const live = parseDocument('narrative:\n  superpowers: []\n');
  const missing = findMissingKeyPaths(template.contents, live.contents);
  assert.deepEqual(missing, [['narrative', 'deal_breakers']]);
});

test('findMissingKeyPaths reports a whole missing subtree as one path, not per-leaf', () => {
  const template = parseDocument('location:\n  country: US\n  work_mode: remote\n');
  const live = parseDocument('a: 1\n');
  const missing = findMissingKeyPaths(template.contents, live.contents);
  assert.deepEqual(missing, [['location']]);
});

test('findMissingKeyPaths returns empty when live already has everything the template has', () => {
  const template = parseDocument('a: 1\nb: 2\n');
  const live = parseDocument('a: 1\nb: 2\nc: 3\n'); // live can have EXTRA keys, that is fine
  const missing = findMissingKeyPaths(template.contents, live.contents);
  assert.deepEqual(missing, []);
});

test('findMissingKeyPaths treats an existing falsy value as present, not missing', () => {
  const template = parseDocument('a: 1\n');
  const live = parseDocument('a: false\n');
  const missing = findMissingKeyPaths(template.contents, live.contents);
  assert.deepEqual(missing, []);
});

test('checkFile reports missing paths without writing anything', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: 1\n');
    writeFileSync(templatePath, 'a: 1\nb: 2\n');
    const before = readFileSync(livePath, 'utf8');
    const result = checkFile(livePath, templatePath);
    assert.deepEqual(result.missing, [['b']]);
    assert.equal(result.error, null);
    assert.equal(readFileSync(livePath, 'utf8'), before);
  });
});

test('checkFile returns no missing/no error when either file does not exist', () => {
  withTempDir((dir) => {
    const result = checkFile(join(dir, 'nope.yml'), join(dir, 'also-nope.yml'));
    assert.deepEqual(result.missing, []);
    assert.equal(result.error, null);
  });
});

test('checkFile reports a parse error instead of throwing on malformed YAML', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: [1, 2\n'); // unterminated flow sequence
    writeFileSync(templatePath, 'a: 1\n');
    const result = checkFile(livePath, templatePath);
    assert.deepEqual(result.missing, []);
    assert.ok(result.error);
  });
});

test('applyFile adds a missing top-level key and leaves existing content untouched', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: 1\n');
    writeFileSync(templatePath, 'a: 1\nb: 2\n');
    const written = applyFile(livePath, templatePath);
    assert.deepEqual(written, [['b']]);
    const result = parseDocument(readFileSync(livePath, 'utf8')).toJS();
    assert.deepEqual(result, { a: 1, b: 2 });
  });
});

test('applyFile adds a missing nested key under an existing parent, keeping sibling keys', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'narrative:\n  superpowers: [foo]\n');
    writeFileSync(templatePath, 'narrative:\n  superpowers: []\n  deal_breakers: [bar]\n');
    applyFile(livePath, templatePath);
    const result = parseDocument(readFileSync(livePath, 'utf8')).toJS();
    assert.deepEqual(result, { narrative: { superpowers: ['foo'], deal_breakers: ['bar'] } });
  });
});

test('applyFile never modifies an existing key, even one with a falsy value', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: false\nb: []\n');
    writeFileSync(templatePath, 'a: true\nb: [1, 2]\nc: 3\n');
    const written = applyFile(livePath, templatePath);
    assert.deepEqual(written, [['c']]);
    const result = parseDocument(readFileSync(livePath, 'utf8')).toJS();
    assert.deepEqual(result, { a: false, b: [], c: 3 });
  });
});

test('applyFile is idempotent — a second run finds nothing left to add', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: 1\n');
    writeFileSync(templatePath, 'a: 1\nb: 2\n');
    applyFile(livePath, templatePath);
    const secondRun = applyFile(livePath, templatePath);
    assert.deepEqual(secondRun, []);
  });
});

test('applyFile preserves the live file\'s pre-existing comments byte-for-byte outside the inserted key', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, '# a real user comment explaining this field\na: 1\n');
    writeFileSync(templatePath, '# a real user comment explaining this field\na: 1\n# template docs for b\nb: 2\n');
    applyFile(livePath, templatePath);
    const after = readFileSync(livePath, 'utf8');
    assert.match(after, /# a real user comment explaining this field/);
    assert.match(after, /# template docs for b/);
  });
});

test('applyFile makes no write at all when nothing is missing', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'a: 1\n');
    writeFileSync(templatePath, 'a: 1\n');
    const before = readFileSync(livePath, 'utf8');
    const written = applyFile(livePath, templatePath);
    assert.deepEqual(written, []);
    assert.equal(readFileSync(livePath, 'utf8'), before);
  });
});

test('applyFile preserves nested key comments from the template', () => {
  withTempDir((dir) => {
    const livePath = join(dir, 'live.yml');
    const templatePath = join(dir, 'template.yml');
    writeFileSync(livePath, 'narrative:\n  superpowers: [foo]\n');
    writeFileSync(templatePath, 'narrative:\n  superpowers: []\n  # docs for deal_breakers\n  deal_breakers: [bar]\n');
    applyFile(livePath, templatePath);
    const after = readFileSync(livePath, 'utf8');
    assert.match(after, /# docs for deal_breakers/);
    const result = parseDocument(after).toJS();
    assert.deepEqual(result, { narrative: { superpowers: ['foo'], deal_breakers: ['bar'] } });
  });
});

// CLI tests

// Matches the established pattern in tests/doctor-workspace-isolation.test.mjs
// and tests/doctor-template-leftovers.test.mjs: join() off a REPO_ROOT
// resolved via fileURLToPath, not a raw file:// URL pathname (which carries
// a leading "/" before the drive letter on Windows, e.g. "/C:/Users/...").
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO_ROOT, 'core', 'backfill-templates.mjs');

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
    return { stdout, status: 0 };
  } catch (err) {
    return { stdout: err.stdout?.toString() ?? '', status: err.status };
  }
}

test('CLI --check reports missing fields and exits 1 when something is missing', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'workspaces', 'alice', 'config'), { recursive: true });
    writeFileSync(join(dir, 'workspaces', 'alice', 'config', 'profile.yml'), 'a: 1\n');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'profile.example.yml'), 'a: 1\nb: 2\n');
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'portals.example.yml'), 'x: 1\n');

    const { stdout, status } = runCli(['alice', '--check', '--json', '--repos-root', dir]);
    const [result] = JSON.parse(stdout);
    assert.equal(result.slug, 'alice');
    assert.ok(result.files.find((f) => f.file === 'config/profile.yml').missing.length > 0);
    assert.equal(status, 1);
  });
});

test('CLI --apply writes missing fields and exits 0', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'workspaces', 'alice', 'config'), { recursive: true });
    writeFileSync(join(dir, 'workspaces', 'alice', 'config', 'profile.yml'), 'a: 1\n');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'profile.example.yml'), 'a: 1\nb: 2\n');
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'portals.example.yml'), 'x: 1\n');

    const { status } = runCli(['alice', '--apply', '--repos-root', dir]);
    assert.equal(status, 0);
    const after = readFileSync(join(dir, 'workspaces', 'alice', 'config', 'profile.yml'), 'utf8');
    assert.match(after, /b: 2/);
  });
});

test('CLI --all --check --json covers every workspace via listWorkspaces()', () => {
  withTempDir((dir) => {
    for (const slug of ['alice', 'bob']) {
      mkdirSync(join(dir, 'workspaces', slug, 'config'), { recursive: true });
      writeFileSync(join(dir, 'workspaces', slug, 'config', 'profile.yml'), 'a: 1\n');
      writeFileSync(join(dir, 'workspaces', slug, 'workspace.json'), JSON.stringify({ slug }));
    }
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'profile.example.yml'), 'a: 1\nb: 2\n');
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'portals.example.yml'), 'x: 1\n');

    const { stdout } = runCli(['--all', '--check', '--json', '--repos-root', dir]);
    const results = JSON.parse(stdout);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.slug).sort(), ['alice', 'bob']);
  });
});

test('CLI reports an unknown slug without crashing', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'workspaces'), { recursive: true });
    const { stdout, status } = runCli(['ghost', '--check', '--json', '--repos-root', dir]);
    const [result] = JSON.parse(stdout);
    assert.ok(result.error);
    assert.equal(status, 1);
  });
});
