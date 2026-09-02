import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionWorkspace, SLUG_RE, JUNCTION_DIRS, repairAllWorkspaces } from '../core/provision-workspace.mjs';
import { slugify, resolveAvailableSlug, bindWorkspaceChat } from '../core/provision-workspace.mjs';

test('rejects invalid slugs', () => {
  assert.equal(SLUG_RE.test('../etc'), false);
  assert.equal(SLUG_RE.test('a/b'), false);
  assert.equal(SLUG_RE.test('Alice'), false); // uppercase not allowed
  assert.equal(SLUG_RE.test('a'), false); // too short (min 2 chars)
  assert.equal(SLUG_RE.test('alice'), true);
  assert.equal(SLUG_RE.test('alice-2'), true);
});

test('provisionWorkspace throws on an invalid slug without touching disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    assert.throws(() => provisionWorkspace('../escape', { reposRoot: root }));
    assert.equal(existsSync(join(root, 'workspaces')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionWorkspace creates the expected junctions and real files', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('alice', { reposRoot: root });
    const wsDir = join(root, 'workspaces', 'alice');
    assert.ok(existsSync(join(wsDir, 'workspace.json')));
    const meta = JSON.parse(readFileSync(join(wsDir, 'workspace.json'), 'utf-8'));
    assert.equal(meta.slug, 'alice');
    assert.ok(meta.created_at);

    // Real user-layer entries
    assert.ok(existsSync(join(wsDir, 'data')));
    assert.ok(existsSync(join(wsDir, 'config')));
    assert.ok(existsSync(join(wsDir, 'data', 'pipeline.md')));

    // Junctioned system entries
    const modesLink = lstatSync(join(wsDir, 'modes'));
    assert.ok(modesLink.isSymbolicLink() || modesLink.isDirectory());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionWorkspace is idempotent — re-running does not error or duplicate', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('bob', { reposRoot: root });
    assert.doesNotThrow(() => provisionWorkspace('bob', { reposRoot: root, repair: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repairAllWorkspaces adds a junction for a directory introduced after initial provisioning', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    // Simulate a brand-new top-level System Layer directory that didn't exist
    // in JUNCTION_DIRS at provisioning time: hold back an existing, real
    // entry ('examples') and add it back after provisioning, rather than
    // fabricating a directory under `root`. ensureJunction's SOURCE always
    // resolves off the real repo ROOT (see provision-workspace.mjs's own
    // comment on that call) — reposRoot only relocates where the workspace
    // itself is created — so a directory that exists only under the fake
    // `root` would never get linked; it has to be something real at ROOT.
    const originalDirs = [...JUNCTION_DIRS];
    const heldBackIndex = JUNCTION_DIRS.indexOf('examples');
    assert.notEqual(heldBackIndex, -1, 'expected "examples" in JUNCTION_DIRS to hold back for this test');
    try {
      JUNCTION_DIRS.splice(heldBackIndex, 1);
      provisionWorkspace('carol', { reposRoot: root });
      assert.equal(existsSync(join(root, 'workspaces', 'carol', 'examples')), false);

      JUNCTION_DIRS.push('examples');
      repairAllWorkspaces({ reposRoot: root });
      assert.ok(existsSync(join(root, 'workspaces', 'carol', 'examples')));
    } finally {
      JUNCTION_DIRS.length = 0;
      JUNCTION_DIRS.push(...originalDirs);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('slugify lowercases, strips accents/punctuation, and collapses to hyphens', () => {
  assert.equal(slugify('Alice Chen'), 'alice-chen');
  assert.equal(slugify('José García'), 'jose-garcia');
  assert.equal(slugify("O'Brien!!!"), 'o-brien');
});

test('slugify falls back to "candidate" for an empty/unusable name', () => {
  assert.equal(slugify(''), 'candidate');
  assert.equal(slugify('!!!'), 'candidate');
});

test('resolveAvailableSlug returns the base slug when unused', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    assert.equal(resolveAvailableSlug('Alice Chen', { reposRoot: root }), 'alice-chen');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveAvailableSlug dedupes with a numeric suffix on collision', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('alice-chen', { reposRoot: root });
    assert.equal(resolveAvailableSlug('Alice Chen', { reposRoot: root }), 'alice-chen-2');
    provisionWorkspace('alice-chen-2', { reposRoot: root });
    assert.equal(resolveAvailableSlug('Alice Chen', { reposRoot: root }), 'alice-chen-3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveAvailableSlug pads a 1-character slugified name to satisfy SLUG_RE', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    const slug = resolveAvailableSlug('X', { reposRoot: root });
    assert.ok(SLUG_RE.test(slug), `expected "${slug}" to satisfy SLUG_RE`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindWorkspaceChat sets chat_id on an unbound workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('alice', { reposRoot: root });
    bindWorkspaceChat('alice', '111', { reposRoot: root });
    const meta = JSON.parse(readFileSync(join(root, 'workspaces', 'alice', 'workspace.json'), 'utf-8'));
    assert.equal(meta.chat_id, '111');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindWorkspaceChat is idempotent when re-binding the same slug to the same chat', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('alice', { reposRoot: root });
    bindWorkspaceChat('alice', '111', { reposRoot: root });
    assert.doesNotThrow(() => bindWorkspaceChat('alice', '111', { reposRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindWorkspaceChat throws when the workspace is already bound to a different chat', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('alice', { reposRoot: root });
    bindWorkspaceChat('alice', '111', { reposRoot: root });
    assert.throws(() => bindWorkspaceChat('alice', '222', { reposRoot: root }), /already bound/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindWorkspaceChat throws when the chat is already bound to a different workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('alice', { reposRoot: root });
    provisionWorkspace('bob', { reposRoot: root });
    bindWorkspaceChat('alice', '111', { reposRoot: root });
    assert.throws(() => bindWorkspaceChat('bob', '111', { reposRoot: root }), /already bound to a different workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindWorkspaceChat throws for a nonexistent slug', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    assert.throws(() => bindWorkspaceChat('ghost', '111', { reposRoot: root }), /does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bindWorkspaceChat throws on an invalid slug without touching disk', () => {
  // modes/telegram-onboarding.md Step 6 binds using state.slug, written during
  // an LLM-driven conversation over untrusted input — the slug must be
  // validated before any path is built from it (mirrors the same guard on
  // provisionWorkspace above).
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    assert.throws(() => bindWorkspaceChat('../escape', '111', { reposRoot: root }), /invalid workspace slug/);
    assert.throws(() => bindWorkspaceChat('a/b', '111', { reposRoot: root }), /invalid workspace slug/);
    assert.equal(existsSync(join(root, 'workspaces')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionWorkspace seeds config/llm-provider.yml from the example template', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  try {
    provisionWorkspace('carol', { reposRoot: root });
    const seeded = join(root, 'workspaces', 'carol', 'config', 'llm-provider.yml');
    assert.ok(existsSync(seeded));
    const content = readFileSync(seeded, 'utf-8');
    assert.match(content, /ollama_cloud:/);
    assert.match(content, /ollama_local:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionWorkspace seeds OLLAMA_API_KEY into the new workspace\'s own .env from the hub-level default', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  const original = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = 'hub-default-test-key';
  try {
    provisionWorkspace('dave', { reposRoot: root });
    const envPath = join(root, 'workspaces', 'dave', '.env');
    assert.ok(existsSync(envPath));
    const content = readFileSync(envPath, 'utf-8');
    assert.match(content, /^OLLAMA_API_KEY=hub-default-test-key$/m);
  } finally {
    if (original === undefined) delete process.env.OLLAMA_API_KEY; else process.env.OLLAMA_API_KEY = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionWorkspace never overwrites a workspace\'s own existing OLLAMA_API_KEY with the hub default', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  const original = process.env.OLLAMA_API_KEY;
  process.env.OLLAMA_API_KEY = 'hub-default-test-key';
  try {
    const wsDir = join(root, 'workspaces', 'erin');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, '.env'), 'OLLAMA_API_KEY=erins-own-key\n');
    provisionWorkspace('erin', { reposRoot: root, repair: true });
    const content = readFileSync(join(wsDir, '.env'), 'utf-8');
    assert.match(content, /^OLLAMA_API_KEY=erins-own-key$/m);
    assert.doesNotMatch(content, /hub-default-test-key/);
  } finally {
    if (original === undefined) delete process.env.OLLAMA_API_KEY; else process.env.OLLAMA_API_KEY = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisionWorkspace does not write an OLLAMA_API_KEY line at all when no hub default is set', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-root-'));
  const original = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  try {
    provisionWorkspace('frank', { reposRoot: root });
    const envPath = join(root, 'workspaces', 'frank', '.env');
    // No hub default and no pre-existing .env — provisioning must not
    // fabricate an empty "OLLAMA_API_KEY=" line (seedEnvKey no-ops on falsy value).
    if (existsSync(envPath)) {
      assert.doesNotMatch(readFileSync(envPath, 'utf-8'), /OLLAMA_API_KEY=/);
    }
  } finally {
    if (original === undefined) delete process.env.OLLAMA_API_KEY; else process.env.OLLAMA_API_KEY = original;
    rmSync(root, { recursive: true, force: true });
  }
});
