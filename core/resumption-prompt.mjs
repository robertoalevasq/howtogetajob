#!/usr/bin/env node
// @ts-check
/**
 * resumption-prompt.mjs — Generate copy-paste resumption prompts for token-limit recovery.
 *
 * When a mode hits the token limit mid-execution, this utility generates a
 * self-contained prompt that the user can copy-paste into a fresh turn to
 * resume cleanly from the last checkpoint.
 *
 * Structure:
 *   [CHECKPOINT: {mode}|{encodedState}]
 *   Resume {mode}: continue from {description}
 *
 * The checkpoint marker is machine-readable; the description is human-friendly
 * so the user knows where they left off without inspecting the state.
 *
 * Usage (in a mode or script about to hit token limit):
 *   const { generateResumptionPrompt } = await import('./resumption-prompt.mjs');
 *   const prompt = generateResumptionPrompt('cycle', { step: '2-pipeline', counters: {...} });
 *   console.log(prompt);
 *
 * Usage (as a consumer — in a mode's entrypoint):
 *   const { parseCheckpoint, isCheckpointMarked } = await import('./resumption-prompt.mjs');
 *   if (isCheckpointMarked(userPrompt)) {
 *     const { mode, state } = parseCheckpoint(userPrompt);
 *     // Load state and resume
 *   }
 */

import { isMainModule } from './is-main.mjs';

/**
 * Generate a human-friendly description of the checkpoint state.
 *
 * @param {string} mode - The mode name (e.g., 'cycle', 'pipeline', 'scan-ats-full')
 * @param {object} state - The checkpoint state (shape varies by mode)
 * @returns {string} A one-line human description
 */
export function describeCheckpoint(mode, state) {
  if (mode === 'cycle' || mode === 'scan-ats-full') {
    const step = state.step?.label || state.step?.id || 'unknown step';
    return `${step}`;
  }
  if (mode === 'pipeline') {
    const pending = state.pendingUrls || 0;
    const processed = state.processedUrls || 0;
    return `${processed} processed, ${pending} remaining`;
  }
  if (mode === 'apply' || mode === 'apply-batch') {
    const applied = state.applicationsSubmitted || 0;
    const pending = state.applicationsPending || 0;
    return `${applied} submitted, ${pending} pending`;
  }
  // Generic fallback
  return state.description || 'unknown progress';
}

/**
 * Generate a resumption prompt from a checkpoint state.
 *
 * Encodes the state as base64 JSON, compact to fit in a copy-paste.
 * The resulting prompt is a single paragraph suitable for pasting directly
 * into a fresh chat turn.
 *
 * @param {string} mode - The mode name
 * @param {object} state - The checkpoint state
 * @returns {string} A copy-paste-ready prompt string
 */
export function generateResumptionPrompt(mode, state) {
  const encoded = Buffer.from(JSON.stringify(state)).toString('base64');
  const description = describeCheckpoint(mode, state);
  return `[CHECKPOINT: ${mode}|${encoded}]\nResume ${mode}: continue from ${description}`;
}

/**
 * Check if a prompt contains a checkpoint marker.
 *
 * @param {string} prompt - The raw user prompt
 * @returns {boolean} True if the prompt starts with [CHECKPOINT: ...]
 */
export function isCheckpointMarked(prompt) {
  return /^\s*\[CHECKPOINT:\s*\w+\|/.test(prompt);
}

/**
 * Parse a checkpoint marker from a prompt.
 *
 * @param {string} prompt - The raw user prompt containing [CHECKPOINT: ...]
 * @returns {{mode: string, state: object, rawMarker: string} | null}
 *   Returns {mode, state, rawMarker} on success, or null if parsing fails.
 */
export function parseCheckpoint(prompt) {
  const match = prompt.match(/\[CHECKPOINT:\s*(\w+)\|([A-Za-z0-9+/=]+)\]/);
  if (!match) return null;

  const mode = match[1];
  const encoded = match[2];
  const rawMarker = match[0];

  try {
    const state = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    return { mode, state, rawMarker };
  } catch (e) {
    // Invalid base64 or invalid JSON
    return null;
  }
}

/**
 * Strip the checkpoint marker from a prompt, leaving the rest intact.
 *
 * @param {string} prompt - The raw user prompt
 * @returns {string} The prompt with [CHECKPOINT: ...] and trailing newline removed
 */
export function stripCheckpoint(prompt) {
  return prompt.replace(/\[CHECKPOINT:\s*\w+\|[A-Za-z0-9+/=]+\]\s*\n?/, '').trim();
}

/**
 * CLI: generate a resumption prompt from command-line args or a JSON file.
 *
 * Usage:
 *   node resumption-prompt.mjs generate cycle --state '{"step":{"id":"2-pipeline"}}'
 *   node resumption-prompt.mjs generate cycle --file /path/to/state.json
 *   node resumption-prompt.mjs parse "[CHECKPOINT: cycle|...]"
 */
async function main() {
  const [, , cmd, mode, ...rest] = process.argv;

  if (cmd === 'generate') {
    if (!mode) {
      console.error('Usage: node resumption-prompt.mjs generate <mode> [--state JSON | --file PATH]');
      process.exit(1);
    }

    let state = {};
    const stateIdx = rest.indexOf('--state');
    const fileIdx = rest.indexOf('--file');

    if (stateIdx !== -1 && rest[stateIdx + 1]) {
      try {
        state = JSON.parse(rest[stateIdx + 1]);
      } catch (e) {
        console.error(`Invalid JSON in --state: ${e.message}`);
        process.exit(1);
      }
    } else if (fileIdx !== -1 && rest[fileIdx + 1]) {
      try {
        const { readFileSync } = await import('fs');
        state = JSON.parse(readFileSync(rest[fileIdx + 1], 'utf8'));
      } catch (e) {
        console.error(`Failed to read --file: ${e.message}`);
        process.exit(1);
      }
    }

    const prompt = generateResumptionPrompt(mode, state);
    console.log(prompt);
  } else if (cmd === 'parse') {
    if (!mode || !mode.startsWith('[CHECKPOINT:')) {
      console.error('Usage: node resumption-prompt.mjs parse "[CHECKPOINT: ...]"');
      process.exit(1);
    }
    // Reconstruct the full marker from remaining args (in case it was split by shell)
    const fullMarker = [mode, ...rest].join(' ');
    const parsed = parseCheckpoint(fullMarker);
    if (!parsed) {
      console.error('Invalid checkpoint marker');
      process.exit(1);
    }
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    console.error('Usage: node resumption-prompt.mjs [generate <mode>|parse] ...');
    process.exit(1);
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`❌ resumption-prompt: ${err.message}`);
    process.exit(1);
  });
}
