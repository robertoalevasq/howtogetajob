#!/usr/bin/env node
// @ts-check
/**
 * checkpoint-startup.mjs — Checkpoint detection and loading for mode entrypoints.
 *
 * When a mode starts, check if the user's prompt contains a [CHECKPOINT: ...]
 * marker. If so, parse it, load the state, and return it along with a sanitized
 * prompt (checkpoint marker stripped).
 *
 * Usage (in a mode's script or handler):
 *   import { detectCheckpoint } from './checkpoint-startup.mjs';
 *
 *   const { checkpoint, cleanPrompt } = detectCheckpoint(userPrompt);
 *   if (checkpoint) {
 *     const { mode, state } = checkpoint;
 *     console.log(`Resuming ${mode} from step ${state.step.id}`);
 *     // Load state, re-acquire locks if needed, resume work
 *   } else {
 *     console.log('Starting fresh');
 *     // Normal startup flow
 *   }
 *
 * The checkpoint state is mode-specific — callers must know what state shape
 * to expect for their mode.
 */

import { parseCheckpoint, stripCheckpoint, isCheckpointMarked } from './resumption-prompt.mjs';

/**
 * Detect and parse checkpoint marker from a prompt.
 *
 * @param {string} prompt - The raw user prompt, possibly containing [CHECKPOINT: ...]
 * @returns {{checkpoint: {mode: string, state: object} | null, cleanPrompt: string}}
 *   Returns both the parsed checkpoint (if present) and the prompt with marker stripped.
 */
export function detectCheckpoint(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return { checkpoint: null, cleanPrompt: prompt || '' };
  }

  if (!isCheckpointMarked(prompt)) {
    return { checkpoint: null, cleanPrompt: prompt };
  }

  const parsed = parseCheckpoint(prompt);
  if (!parsed) {
    // Marker present but unparseable — treat as error but don't crash
    console.warn('⚠️  Checkpoint marker present but could not parse — starting fresh');
    return { checkpoint: null, cleanPrompt: stripCheckpoint(prompt) };
  }

  const { mode, state } = parsed;
  const cleanPrompt = stripCheckpoint(prompt);

  return {
    checkpoint: { mode, state },
    cleanPrompt,
  };
}

/**
 * Log resumption info in a standardized format for all modes.
 *
 * @param {string} mode - The mode name
 * @param {object} state - The checkpoint state (mode-specific)
 * @returns {string} A formatted log line for console output
 */
export function resumptionSummary(mode, state) {
  const step = state.step?.label || state.step?.id || 'unknown';
  const counters = Object.entries(state.counters || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `▶️  Resuming ${mode} at step "${step}"${counters ? ` (${counters})` : ''}`;
}

/**
 * CLI: parse a checkpoint from a prompt string (for testing/debugging).
 *
 * Usage:
 *   node checkpoint-startup.mjs detect "[CHECKPOINT: cycle|...]"
 *   node checkpoint-startup.mjs detect "[CHECKPOINT: cycle|...] Additional instructions here"
 */
async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'detect') {
    const prompt = rest.join(' ');
    if (!prompt) {
      console.error('Usage: node checkpoint-startup.mjs detect "<prompt-with-checkpoint>"');
      process.exit(1);
    }

    const { checkpoint, cleanPrompt } = detectCheckpoint(prompt);
    if (checkpoint) {
      console.log(`✅ Checkpoint detected: mode=${checkpoint.mode}`);
      console.log('Parsed state:');
      console.log(JSON.stringify(checkpoint.state, null, 2));
      console.log('\nClean prompt (without checkpoint marker):');
      console.log(cleanPrompt);
    } else {
      console.log('❌ No checkpoint marker found in prompt');
      console.log('Prompt remains:');
      console.log(prompt);
    }
  } else {
    console.error('Usage: node checkpoint-startup.mjs detect "<prompt-with-checkpoint>"');
    process.exit(1);
  }
}

const [, , cmd] = process.argv;
if (cmd === 'detect' || cmd === '--test') {
  main().catch((err) => {
    console.error(`❌ checkpoint-startup: ${err.message}`);
    process.exit(1);
  });
}
