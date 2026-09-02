// tests/ollama-delegate-fallback.test.mjs
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nollama-delegate.mjs — cloud/local fallback chain');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'core', 'ollama-delegate.mjs')).href);
  const originalFetch = globalThis.fetch;

  // 1. Cloud succeeds -> local is never called.
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  try {
    const result = await mod.callProvider(
      { base_url: 'https://ollama.com/v1', model: 'gpt-oss:20b', api_key_env: 'OLLAMA_API_KEY', timeout_ms: 5000 },
      { systemPrompt: 'sys', userContent: 'usr' },
    );
    if (result.ok && result.json.ok === true && calls === 1) pass('callProvider parses a successful JSON response');
    else fail(`callProvider success path => ${JSON.stringify(result)}`);
  } finally { globalThis.fetch = originalFetch; }

  // 2. Response wraps JSON in a markdown code fence -> still parsed.
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '```json\n{"wrapped":true}\n```' } }],
  }), { status: 200 });
  try {
    const result = await mod.callProvider(
      { base_url: 'https://ollama.com/v1', model: 'x', timeout_ms: 5000 },
      { systemPrompt: 'sys', userContent: 'usr' },
    );
    if (result.ok && result.json.wrapped === true) pass('callProvider salvages JSON wrapped in a markdown fence');
    else fail(`callProvider fenced-JSON handling => ${JSON.stringify(result)}`);
  } finally { globalThis.fetch = originalFetch; }

  // 3. Non-200 -> ok:false, never throws.
  globalThis.fetch = async () => new Response('server error', { status: 500 });
  try {
    const result = await mod.callProvider({ base_url: 'https://ollama.com/v1', model: 'x', timeout_ms: 5000 }, { systemPrompt: 's', userContent: 'u' });
    if (result.ok === false && /500/.test(result.error)) pass('callProvider reports a non-200 response as ok:false, not a throw');
    else fail(`callProvider HTTP-error handling => ${JSON.stringify(result)}`);
  } finally { globalThis.fetch = originalFetch; }

  // 4. Non-loopback "local" endpoint is refused when enforceLoopback is set.
  globalThis.fetch = async () => { fail('callProvider must not fetch a refused non-loopback endpoint'); return new Response('{}'); };
  try {
    const result = await mod.callProvider(
      { base_url: 'https://not-actually-local.example/v1', model: 'x', timeout_ms: 5000 },
      { systemPrompt: 's', userContent: 'u' },
      { enforceLoopback: true },
    );
    if (result.ok === false && /loopback/.test(result.error)) pass('callProvider refuses a non-loopback endpoint when enforceLoopback is set');
    else fail(`callProvider loopback guard => ${JSON.stringify(result)}`);
  } finally { globalThis.fetch = originalFetch; }

  // 5. delegate(): cloud fails, local succeeds -> local's result wins.
  let cloudCalled = false, localCalled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('ollama.com')) { cloudCalled = true; return new Response('down', { status: 503 }); }
    localCalled = true;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"explicit_date_mentioned":null,"relative_freshness_phrase":null,"staleness_phrase":null,"notes":""}' } }] }), { status: 200 });
  };
  try {
    const cfg = {
      ollama_cloud: { enabled: true, base_url: 'https://ollama.com/v1', model: 'gpt-oss:20b', timeout_ms: 5000 },
      ollama_local: { enabled: true, base_url: 'http://localhost:11434/v1', model: 'qwen2.5:14b', timeout_ms: 5000 },
      tasks: {},
    };
    const result = await mod.delegate('block-g-signals', 'some JD text', cfg);
    if (cloudCalled && localCalled && result.explicit_date_mentioned === null) {
      pass('delegate() falls back from cloud to local and returns the local result');
    } else {
      fail(`delegate() fallback => cloudCalled=${cloudCalled} localCalled=${localCalled} result=${JSON.stringify(result)}`);
    }
  } finally { globalThis.fetch = originalFetch; }

  // 6. delegate(): both providers fail -> throws with both errors named.
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const cfg = {
      ollama_cloud: { enabled: true, base_url: 'https://ollama.com/v1', model: 'x', timeout_ms: 5000 },
      ollama_local: { enabled: true, base_url: 'http://localhost:11434/v1', model: 'x', timeout_ms: 5000 },
      tasks: {},
    };
    let threw = null;
    try { await mod.delegate('comp-market-estimate', 'text', cfg); } catch (e) { threw = e; }
    if (threw && /ollama_cloud/.test(threw.message) && /ollama_local/.test(threw.message)) {
      pass('delegate() throws naming both failed providers when neither succeeds');
    } else {
      fail(`delegate() both-fail handling => ${threw?.message}`);
    }
  } finally { globalThis.fetch = originalFetch; }

  // 7. delegate(): task disabled in config -> throws without ever calling fetch.
  globalThis.fetch = async () => { fail('delegate() must not call fetch for a disabled task'); return new Response('{}'); };
  try {
    const cfg = { ollama_cloud: { enabled: true, base_url: 'https://ollama.com/v1', model: 'x' }, ollama_local: { enabled: false }, tasks: { risk_summary_draft: false } };
    let threw = null;
    try { await mod.delegate('risk-summary-draft', '{}', cfg); } catch (e) { threw = e; }
    if (threw && /disabled/.test(threw.message)) pass('delegate() refuses a task disabled in config/llm-provider.yml');
    else fail(`delegate() disabled-task handling => ${threw?.message}`);
  } finally { globalThis.fetch = originalFetch; }

  // 8. Unknown task -> throws immediately.
  let threwUnknown = null;
  try { await mod.delegate('not-a-real-task', 'x', { tasks: {} }); } catch (e) { threwUnknown = e; }
  if (threwUnknown && /unknown task/.test(threwUnknown.message)) pass('delegate() rejects an unrecognized task name');
  else fail(`delegate() unknown-task handling => ${threwUnknown?.message}`);

  // 9. Valid JSON that isn't an object (null / number / array) -> ok:false, so
  //    the fallback leg still gets its turn instead of a nonsense "success".
  for (const [label, body] of [['null', 'null'], ['a bare number', '123'], ['a top-level array', '["a","b"]']]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 });
    try {
      const result = await mod.callProvider(
        { base_url: 'https://ollama.com/v1', model: 'x', timeout_ms: 5000 },
        { systemPrompt: 's', userContent: 'u' },
      );
      if (result.ok === false && /non-object JSON/.test(result.error)) {
        pass(`callProvider rejects ${label} as a task result instead of accepting it as success`);
      } else {
        fail(`callProvider non-object handling (${label}) => ${JSON.stringify(result)}`);
      }
    } finally { globalThis.fetch = originalFetch; }
  }

  // 10. delegate(): cloud succeeds -> local is never called at all.
  globalThis.fetch = async (url) => {
    if (!String(url).includes('ollama.com')) {
      fail('delegate() must not call the local provider when cloud already succeeded');
      return new Response('{}', { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"from":"cloud"}' } }] }), { status: 200 });
  };
  try {
    const cfg = {
      ollama_cloud: { enabled: true, base_url: 'https://ollama.com/v1', model: 'gpt-oss:20b', timeout_ms: 5000 },
      ollama_local: { enabled: true, base_url: 'http://localhost:11434/v1', model: 'qwen2.5:14b', timeout_ms: 5000 },
      tasks: {},
    };
    const result = await mod.delegate('block-g-signals', 'some JD text', cfg);
    if (result.from === 'cloud') pass('delegate() returns the cloud result and skips the local leg entirely when cloud succeeds');
    else fail(`delegate() cloud-success routing => ${JSON.stringify(result)}`);
  } finally { globalThis.fetch = originalFetch; }
} catch (err) {
  fail(`ollama-delegate fallback tests crashed: ${err.stack || err.message}`);
}
