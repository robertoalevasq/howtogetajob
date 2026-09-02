import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nollama-delegate.mjs — provider config + loopback guard');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'core', 'ollama-delegate.mjs')).href);

  const missing = mod.loadProviderConfig(join(ROOT, 'this-file-does-not-exist.yml'));
  if (missing.ollama_cloud?.enabled === false && missing.ollama_local?.enabled === false) {
    pass('loadProviderConfig returns an all-disabled default when the config file is absent');
  } else {
    fail(`loadProviderConfig default => ${JSON.stringify(missing)}`);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'llm-provider-'));
  const cfgPath = join(tmpDir, 'llm-provider.yml');
  writeFileSync(cfgPath, [
    'ollama_cloud:',
    '  enabled: true',
    '  base_url: https://ollama.com/v1',
    '  model: gpt-oss:20b',
    '  api_key_env: OLLAMA_API_KEY',
    '  timeout_ms: 60000',
    'ollama_local:',
    '  enabled: true',
    '  base_url: http://localhost:11434/v1',
    '  model: qwen2.5:14b-instruct-q4_K_M',
    '  timeout_ms: 120000',
    'tasks:',
    '  comp_market_estimate: true',
    '  block_g_signals: true',
    '  risk_summary_draft: false',
  ].join('\n'));

  const loaded = mod.loadProviderConfig(cfgPath);
  if (loaded.ollama_cloud.model === 'gpt-oss:20b' && loaded.tasks.risk_summary_draft === false) {
    pass('loadProviderConfig parses a real config/llm-provider.yml file');
  } else {
    fail(`loadProviderConfig parsed => ${JSON.stringify(loaded)}`);
  }

  const badPath = join(tmpDir, 'bad.yml');
  writeFileSync(badPath, 'ollama_cloud: [this is not: a map');
  const bad = mod.loadProviderConfig(badPath);
  if (bad.ollama_cloud?.enabled === false) pass('loadProviderConfig falls back to the disabled default on invalid YAML instead of throwing');
  else fail(`loadProviderConfig invalid-yaml handling => ${JSON.stringify(bad)}`);

  rmSync(tmpDir, { recursive: true, force: true });

  if (mod.isLoopbackUrl('http://localhost:11434/v1') && mod.isLoopbackUrl('http://127.0.0.1:11434/v1') && !mod.isLoopbackUrl('https://ollama.com/v1')) {
    pass('isLoopbackUrl distinguishes localhost/127.0.0.1 from a remote host');
  } else {
    fail('isLoopbackUrl loopback detection regressed');
  }

  if (mod.isLoopbackUrl('not a url') === false) pass('isLoopbackUrl returns false (not a throw) for an unparseable URL');
  else fail('isLoopbackUrl should return false for garbage input');
} catch (err) {
  fail(`ollama-delegate config tests crashed: ${err.stack || err.message}`);
}
