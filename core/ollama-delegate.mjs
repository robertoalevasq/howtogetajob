#!/usr/bin/env node
/**
 * ollama-delegate.mjs — narrow, single-task delegate calls for career-ops.
 *
 * Unlike ollama-eval.mjs/openai-eval.mjs (which run a FULL A-G evaluation
 * standalone, with no Claude involved), this script handles exactly one
 * small, evidence-gathering task per call, invoked BY Claude mid-pipeline.
 * See docs/superpowers/specs/2026-09-02-ollama-cloud-delegation-design.md.
 *
 * Usage:
 *   node core/ollama-delegate.mjs <task> --input <file>
 *   task: comp-market-estimate | block-g-signals | risk-summary-draft
 *
 * Fallback chain: ollama_cloud -> ollama_local -> exit non-zero (caller does
 * the task itself). Never hangs, never crashes the caller's pipeline.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { isMainModule } from './is-main.mjs';

try {
  const { config } = await import('dotenv');
  config();
} catch { /* dotenv optional */ }

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const DISABLED_CONFIG = { ollama_cloud: { enabled: false }, ollama_local: { enabled: false }, tasks: {} };

/**
 * @returns {string} Path to the user's provider config, overridable for tests.
 */
export function providerConfigPath() {
  return process.env.CAREER_OPS_LLM_PROVIDER_CONFIG || join(ROOT, 'config', 'llm-provider.yml');
}

/**
 * Load config/llm-provider.yml, falling back to an all-disabled config when
 * the file is absent or invalid — delegation is opt-in, so a fresh checkout
 * (or a syntax error) must behave exactly like today, never throw.
 *
 * @param {string} [path]
 * @returns {object}
 */
export function loadProviderConfig(path = providerConfigPath()) {
  if (!existsSync(path)) return DISABLED_CONFIG;
  try {
    const parsed = yaml.load(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : DISABLED_CONFIG;
  } catch (err) {
    console.error(`⚠️  Could not parse ${path}: ${err.message} — delegation disabled for this call.`);
    return DISABLED_CONFIG;
  }
}

/**
 * Loopback-only guard, same rule ollama-eval.mjs already applies to a local
 * Ollama endpoint: a non-localhost "local" URL is refused unless explicitly
 * allowed, so a misconfigured base_url can't silently start sending JD text
 * somewhere remote under a name that promises it stays on-machine.
 *
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isLoopbackUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

const TASKS = {
  'comp-market-estimate': 'comp-market-estimate.md',
  'block-g-signals': 'block-g-signals.md',
  'risk-summary-draft': 'risk-summary-draft.md',
};

/**
 * Call one OpenAI-compatible chat-completions endpoint and parse the
 * response as strict JSON, salvaging a markdown-fenced JSON body if the
 * model wrapped it in one.
 *
 * @param {object} providerCfg - One of config.ollama_cloud / config.ollama_local.
 * @param {{systemPrompt: string, userContent: string}} messages
 * @param {{enforceLoopback?: boolean}} [opts] - Set true for the local leg.
 * @returns {Promise<{ok: true, json: object} | {ok: false, error: string}>}
 */
export async function callProvider(providerCfg, { systemPrompt, userContent }, { enforceLoopback = false } = {}) {
  const baseUrl = (providerCfg.base_url || '').replace(/\/$/, '');
  if (!baseUrl) return { ok: false, error: 'no base_url configured' };

  if (enforceLoopback && !isLoopbackUrl(baseUrl) && process.env.OLLAMA_ALLOW_REMOTE !== '1') {
    return { ok: false, error: `refusing non-loopback local endpoint: ${baseUrl} (set OLLAMA_ALLOW_REMOTE=1 to override)` };
  }

  const apiKey = providerCfg.api_key_env ? process.env[providerCfg.api_key_env] : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const timeoutMs = providerCfg.timeout_ms || 60000;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: providerCfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        stream: false,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: false, error: 'empty response' };

    let json;
    try {
      json = JSON.parse(content);
    } catch {
      const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) {
        try { json = JSON.parse(fenced[1]); } catch { /* fall through */ }
      }
      if (!json) return { ok: false, error: `non-JSON response: ${content.slice(0, 200)}` };
    }
    return { ok: true, json };
  } catch (err) {
    if (err.name === 'TimeoutError') return { ok: false, error: `timed out after ${timeoutMs}ms` };
    return { ok: false, error: err.message };
  }
}

/**
 * Run one delegated task through the ollama_cloud -> ollama_local fallback
 * chain, reading the task's instructions from modes/delegate/*.md.
 *
 * @param {string} task - One of the TASKS keys.
 * @param {string} inputText - The JD/role text (and any preflight output) to send.
 * @param {object} [config] - Provider config; defaults to loadProviderConfig().
 * @returns {Promise<object>} The parsed JSON result from whichever provider succeeded.
 * @throws {Error} When the task is unknown, disabled, or both providers fail.
 */
export async function delegate(task, inputText, config = loadProviderConfig()) {
  const taskFile = TASKS[task];
  if (!taskFile) throw new Error(`unknown task: ${task}`);

  const taskKey = task.replace(/-/g, '_');
  if (config.tasks && config.tasks[taskKey] === false) {
    throw new Error(`task "${task}" is disabled in config/llm-provider.yml`);
  }

  const promptPath = join(ROOT, 'modes', 'delegate', taskFile);
  if (!existsSync(promptPath)) throw new Error(`missing task instructions: ${promptPath}`);
  const systemPrompt = readFileSync(promptPath, 'utf-8').trim();

  const attempts = [];
  for (const providerName of ['ollama_cloud', 'ollama_local']) {
    const providerCfg = config[providerName];
    if (!providerCfg || providerCfg.enabled === false) continue;
    const result = await callProvider(
      providerCfg,
      { systemPrompt, userContent: inputText },
      { enforceLoopback: providerName === 'ollama_local' },
    );
    if (result.ok) return result.json;
    attempts.push(`${providerName}: ${result.error}`);
  }

  throw new Error(`all providers failed for task "${task}": ${attempts.join('; ') || 'no provider enabled'}`);
}

async function main() {
  const [, , task, ...rest] = process.argv;
  const inputIdx = rest.indexOf('--input');
  const inputPath = inputIdx !== -1 ? rest[inputIdx + 1] : null;

  if (!task || !TASKS[task] || !inputPath) {
    console.error('Usage: node ollama-delegate.mjs <task> --input <file>');
    console.error(`  task: ${Object.keys(TASKS).join(' | ')}`);
    return 1;
  }
  if (!existsSync(inputPath)) {
    console.error(`❌  Input file not found: ${inputPath}`);
    return 1;
  }

  try {
    const inputText = readFileSync(inputPath, 'utf-8');
    const json = await delegate(task, inputText);
    console.log(JSON.stringify(json));
    return 0;
  } catch (err) {
    console.error(`❌  ${err.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
