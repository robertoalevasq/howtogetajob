import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { makeDisposableWorkspace } from '../core/telegram-emulate.mjs';

test('makeDisposableWorkspace creates a workspace with junctions to the real core/modes and telegram disabled', () => {
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    assert.ok(existsSync(wsDir), 'workspace directory should exist');
    assert.ok(lstatSync(join(wsDir, 'core')).isSymbolicLink(), 'core should be a junction/symlink');
    assert.ok(lstatSync(join(wsDir, 'modes')).isSymbolicLink(), 'modes should be a junction/symlink');
    assert.ok(existsSync(join(wsDir, 'core', 'telegram-monitor.mjs')), 'core junction should reach the real repo files');
    assert.ok(existsSync(join(wsDir, 'cv.md')), 'a minimal cv.md should be seeded');
    assert.ok(existsSync(join(wsDir, 'config', 'profile.yml')), 'profile.yml should be seeded from the template');
    const plugins = yaml.load(readFileSync(join(wsDir, 'config', 'plugins.yml'), 'utf-8'));
    assert.equal(plugins.plugins.telegram.enabled, false, 'telegram must stay disabled in every disposable workspace');
    assert.ok(existsSync(join(wsDir, 'data', 'telegram-state.md')) === false, 'no telegram-state.md until a scenario seeds one');
  } finally {
    cleanup();
  }
  assert.ok(!existsSync(wsDir), 'cleanup() should remove the disposable workspace');
});

test('makeDisposableWorkspace writes a minimal portals.yml with zero tracked companies (fast Pass A)', () => {
  const { wsDir, cleanup } = makeDisposableWorkspace();
  try {
    const portals = yaml.load(readFileSync(join(wsDir, 'portals.yml'), 'utf-8'));
    assert.deepEqual(portals.tracked_companies, []);
    assert.deepEqual(portals.search_queries, []);
  } finally {
    cleanup();
  }
});
