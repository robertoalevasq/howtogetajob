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
