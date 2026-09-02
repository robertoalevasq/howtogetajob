# Checkpoint & Resumption — Token Limit Recovery

When a mode runs for a long time and hits the token limit mid-execution, it can be resumed cleanly in a fresh turn using checkpoint markers and saved state.

## Quick Start (For Users)

If a mode is interrupted due to token limit:

**The mode automatically resumes where it left off in your next run — no action needed.**

When you run the mode again:
```
/career-ops cycle
```

The system:
1. **Detects** if a checkpoint file exists (e.g., `data/cache/cycle-status.json`)
2. **Checks** if it's fresh (less than 24 hours old)
3. **Checks** if the run is not already complete
4. **Emits** a clear message: `▶️  Resuming cycle at step "Pipeline Processing" (pipelineUrlsProcessed=150, pipelineUrlsPending=347)`
5. **Continues** from that exact step without re-running earlier work

No copy-paste, no manual recovery — just run the mode again and it picks up cleanly.

**Manual recovery (if needed):**

If you want to force a fresh start instead of resuming:
```bash
# Delete the checkpoint file to start fresh
rm data/cache/cycle-status.json
# Then run the mode normally
/career-ops cycle
```

**Check current status:**
```bash
node core/cycle-status.mjs    # For cycle mode — shows current step and progress
```

---

## For Mode Developers

### Adding Checkpoint Support to a Mode

Every long-running mode should:

1. **Detect checkpoint on startup** — check if the user's prompt contains `[CHECKPOINT: ...]`
2. **Load saved state** — parse the checkpoint and restore progress
3. **Write checkpoints regularly** — save state at every major milestone
4. **Generate resumption prompt** — emit a copy-paste-ready prompt if interrupted

### Step 1: Auto-Detect Checkpoint at Startup

In your mode's script or handler, use the checkpoint-startup utility to auto-detect from the filesystem:

```javascript
import { autoDetectCheckpoint, resumptionSummary } from './checkpoint-startup.mjs';

// For cycle mode:
const { checkpoint } = autoDetectCheckpoint('cycle', 'data/cache/cycle-status.json');

if (checkpoint) {
  const { mode, state } = checkpoint;
  console.log(resumptionSummary(mode, state));
  // Load state, resume work
} else {
  console.log('Starting fresh cycle run');
  // Normal startup flow
}
```

**How it works:**
- Checks if `data/cache/cycle-status.json` exists
- Verifies it's less than 24 hours old
- Verifies the previous run is not already complete
- Automatically loads and returns the state if all checks pass
- Returns `null` if file doesn't exist, is stale, or run completed

**Optional: Also check for explicit checkpoint marker in prompt**

If the user pastes an explicit `[CHECKPOINT: ...]` marker (the copy-paste-friendly format), detect that too:

```javascript
import { detectCheckpoint, autoDetectCheckpoint, resumptionSummary } from './checkpoint-startup.mjs';

const userPrompt = process.env.CLAUDE_PROMPT || '';

// First check for explicit checkpoint marker in prompt
let { checkpoint, cleanPrompt } = detectCheckpoint(userPrompt);

// If not found, check for auto-resumable checkpoint file
if (!checkpoint) {
  const result = autoDetectCheckpoint('cycle', 'data/cache/cycle-status.json');
  checkpoint = result.checkpoint;
}

if (checkpoint) {
  const { mode, state } = checkpoint;
  console.log(resumptionSummary(mode, state));
  // Continue with cleanPrompt (checkpoint marker stripped if present)
}
```

### Step 2: Write Checkpoints During Execution

At every major progress point (after processing a batch, completing a step, etc.), write state:

```javascript
import { generateResumptionPrompt } from './resumption-prompt.mjs';
import { writeFileSync } from 'fs';

// At a checkpoint moment:
const state = {
  step: { id: '2-pipeline', label: 'Pipeline Processing' },
  counters: {
    pipelineUrlsProcessed: 150,
    pipelineUrlsPending: 347,
  },
};

// Write to mode-specific checkpoint file (e.g., data/cache/pipeline-status.json)
writeFileSync('data/cache/pipeline-status.json', JSON.stringify(state, null, 2));
```

### Step 3: Generate Resumption Prompt Before Token Limit

When approaching the token limit, emit a ready-to-copy resumption prompt:

```javascript
import { generateResumptionPrompt } from './resumption-prompt.mjs';

// Before the session ends
const prompt = generateResumptionPrompt('pipeline', state);
console.log('\n' + prompt);
console.log('\nIf this run is interrupted, copy the [CHECKPOINT: ...] prompt above and paste it in a fresh turn to resume.\n');
```

---

## Checkpoint State Format

The checkpoint state is mode-specific. Here are examples:

### `cycle` Mode
```json
{
  "step": { "id": "2-pipeline", "label": "Pipeline Processing" },
  "counters": {
    "scanTrackedFound": 45,
    "scanAtsFullCompaniesSwept": 18500,
    "pipelineUrlsProcessed": 150,
    "pipelineUrlsPending": 347,
    "reportsWritten": 42,
    "pdfsSafetyNet": 3
  }
}
```

### `pipeline` Mode
```json
{
  "pendingUrls": 347,
  "processedUrls": 150,
  "reportsWritten": 42,
  "description": "Processing pipeline.md"
}
```

### `scan-ats-full` Mode
```json
{
  "step": { "id": "1b-scan-ats", "label": "Full ATS Sweep" },
  "companiesSwept": 18500,
  "companiesTotal": 39000,
  "matchesFound": 245,
  "checkpointFile": "data/cache/ats-full-checkpoint.json"
}
```

---

## Checkpoint File Locations

- **cycle mode:** `data/cache/cycle-status.json` (via `cycle-status.mjs`)
- **scan-ats-full mode:** `data/cache/ats-full-checkpoint.json` (built-in to script)
- **pipeline mode:** `data/cache/pipeline-status.json` (if you add it)
- **apply/apply-batch modes:** `data/cache/apply-status.json` (if you add it)
- **Custom modes:** `data/cache/{mode-name}-status.json` (recommended pattern)

---

## Implementation Checklist

For each long-running mode:

- [ ] **Startup:** Call `detectCheckpoint(userPrompt)` and load state if present
- [ ] **Progress tracking:** Write checkpoint after every N items or major step boundary
- [ ] **Resumption:** Generate and emit resumption prompt before token limit
- [ ] **Documentation:** Update the mode's own `.md` file to explain checkpoint recovery
- [ ] **Testing:** Manually interrupt a run, verify checkpoint prompt is emitted, verify resumption works

---

## Tools & Utilities

| Utility | Purpose |
|---------|---------|
| `core/resumption-prompt.mjs` | Generate and parse checkpoint markers |
| `core/checkpoint-startup.mjs` | Detect and load checkpoints at mode startup |
| `core/cycle-status.mjs` | Real-time status tracking for `cycle` mode |
| `data/cache/cycle-status.json` | Cycle mode's persistent checkpoint file |

---

## Troubleshooting

**Q: I don't see a resumption prompt when interrupted.**
A: The mode may have completed more work than appeared in the final message. Check the checkpoint file directly:
```bash
node core/cycle-status.mjs          # For cycle
cat data/cache/pipeline-status.json # For pipeline
```

**Q: The checkpoint marker looks corrupted or invalid.**
A: The checkpoint uses base64-encoded JSON. If it appears malformed in the message, copy it exactly as-is (including all characters) and paste it in a fresh turn. The parser is resilient to whitespace and formatting.

**Q: I accidentally discarded the resumption prompt. Can I recover?**
A: If a checkpoint file exists on disk, you can manually generate a resumption prompt:
```bash
node core/resumption-prompt.mjs generate cycle --file data/cache/cycle-status.json
```

**Q: Resumption worked but skipped some work from the earlier run.**
A: This indicates the checkpoint state was incomplete. Verify that:
1. The checkpoint file was written at the correct milestone
2. The state object includes all required fields for your mode
3. The resumption logic correctly handles the state shape

---

## Example: Adding Checkpoints to `pipeline` Mode

```javascript
// At the top of the pipeline processing loop
import { detectCheckpoint } from './checkpoint-startup.mjs';
import { generateResumptionPrompt } from './resumption-prompt.mjs';

const { checkpoint, cleanPrompt } = detectCheckpoint(userPrompt);
let pendingUrls = [...]; // Load from pipeline.md
let processedUrls = [];

if (checkpoint) {
  // Resume from checkpoint
  const { state } = checkpoint;
  processedUrls.length = state.processedUrls || 0;
  console.log(`Resuming from ${state.processedUrls || 0} processed URLs`);
  userPrompt = cleanPrompt;  // Continue with any follow-up instructions
}

// Main loop
for (let i = processedUrls.length; i < pendingUrls.length; i++) {
  const url = pendingUrls[i];
  // ... evaluate URL ...
  processedUrls.push(url);

  // Checkpoint every 25 URLs
  if (processedUrls.length % 25 === 0) {
    const state = {
      processedUrls: processedUrls.length,
      pendingUrls: pendingUrls.length - processedUrls.length,
    };
    writeFileSync('data/cache/pipeline-status.json', JSON.stringify(state, null, 2));
  }

  // Check if approaching token limit (mode can detect this via some signal)
  if (shouldStopForTokenLimit()) {
    const state = {
      processedUrls: processedUrls.length,
      pendingUrls: pendingUrls.length - processedUrls.length,
    };
    const resumePrompt = generateResumptionPrompt('pipeline', state);
    console.log(resumePrompt);
    break;
  }
}
```

---

## See Also

- `modes/_shared.md` — Checkpoint system-wide rules
- `modes/cycle.md` — Example: cycle mode resumption
- `modes/pipeline.md` — Example: pipeline mode integration
