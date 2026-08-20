# Telegram Monitoring — Headless Polling Setup

## Overview

`telegram-monitor.mjs` is a **minimal Claude entry point** for Telegram polling that eliminates token waste on empty results.

**How it works:**
1. **Polls Telegram headlessly** via `node core/telegram-poll.mjs poll` (zero tokens, pure Node.js)
2. **Exits silently if no messages** (zero Claude context loaded)
3. **Invokes Claude routing** only when messages exist (Steps 2-6 of `modes/telegram.md`)

**Before:** `/career-ops telegram mode Step 1 (poll)` invoked through Claude repeatedly → loaded AGENTS.md, mode files, etc. every time → wasted tokens on empty polls.

**After:** `telegram-monitor.mjs` polls headlessly → only invokes Claude when it matters.

## Quick Setup (Windows Task Scheduler)

### Automatic Setup (Recommended)

**Option 1: Run the batch file (easiest)**
```bash
# IMPORTANT: Run as Administrator
# 1. Open Command Prompt (cmd.exe)
# 2. Right-click → "Run as Administrator"
# 3. cd C:\Users\{username}\OneDrive\Documents\_vscode\career-ops
# 4. telegram-setup-scheduler.bat

# Or from PowerShell (run as Administrator):
cd "c:\Users\thebo\OneDrive\Documents\_vscode\career-ops"
& ".\telegram-setup-scheduler.bat"
```

**Option 2: Run the direct schtasks command (if batch fails)**
```bash
# From Command Prompt or PowerShell (run as Administrator):
schtasks /create /tn "CareerOps-Telegram-Poll" /tr "node c:\Users\thebo\OneDrive\Documents\_vscode\career-ops\telegram-monitor.mjs" /sc minute /mo 5 /rl highest /f
```

Both create a recurring task `CareerOps-Telegram-Poll` that runs every 5 minutes.

### Manual Setup
1. Open **Task Scheduler** (search "Task Scheduler" in Windows Start menu)
2. Right-click **Task Scheduler Library** → **Create Basic Task**
3. Name: `CareerOps-Telegram-Poll`
4. Trigger: **Repeat every 5 minutes, indefinitely**
5. Action:
   - Program/script: `node.exe`
   - Arguments: `C:\path\to\your\career-ops\telegram-monitor.mjs`
   - Start in: `C:\path\to\your\career-ops`
6. Click **Create**

The task will now run every 5 minutes in the background.

## How It Works

### Polling Flow
```
[Task Scheduler] every 5 min
         ↓
    node core/telegram-monitor.mjs
         ↓
    telegram-poll.mjs (headless, zero tokens)
         ↓
    JSON: {"messages": []}
         ↓
    Empty? → Exit silently (done, zero tokens)
    Messages? → Invoke Claude routing
```

### Example

**No messages (0 tokens spent):**
```bash
$ node core/telegram-monitor.mjs
$ echo $?
0  # Exit silently
```

**Messages arrive (Claude routing invoked):**
```bash
$ node core/telegram-monitor.mjs
# spawns `claude -p "<routing prompt>"` and waits for it to finish — inherits
# stdout/stderr, so Claude's own tool-call output streams through directly.
# A cycle-trigger message holds this process open for the full run duration.
```

## Multi-Tenant Access (Access Codes + Onboarding)

Since 2026-08-20, one running daemon can serve several people, each with their own `workspaces/{slug}/` (own `cv.md`, tracker, reports — see `docs/superpowers/specs/2026-08-15-workspace-multitenancy-core-design.md`). `core/telegram-router.mjs` classifies every incoming message *before* any Claude invocation: a chat already bound to a workspace (via `workspace.json`'s `chat_id`) routes normally through `modes/telegram.md`; an unbound chat is either mid-onboarding or being asked for an access code.

**Inviting someone new:**
```bash
node core/access-code.mjs generate --label "Alice"
```
Send them the printed code however you like (text, Signal, etc. — never over Telegram itself, since the whole point is proving they're someone you actually invited). They message the bot, send the code as their first message, and `modes/telegram-onboarding.md` walks them through name → CV → profile → optional Discord webhook → done. Codes expire after 7 days if never redeemed; `node core/access-code.mjs list` shows pending/redeemed/expired, `revoke <code>` kills an unused one early.

Five wrong codes from the same chat triggers a 1-hour silent lockout (no reply, no LLM cost) — this is automatic, nothing to configure.

**Migrating an existing single-tenant setup onto this:** if you were running career-ops before this system existed, your own `chat_id` needs one manual bind so the router recognizes you:
```bash
node core/provision-workspace.mjs --bind-chat <your-slug> <your-chat-id>
```
Find your chat_id by messaging `@userinfobot` on Telegram. This is a one-time step — `workspace.json`'s `chat_id` is checked fresh on every poll after that.

## CLI Commands

```bash
# Poll once (exits silently if empty)
node core/telegram-monitor.mjs

# Reset polling offset (same as telegram-poll.mjs reset)
node core/telegram-monitor.mjs --reset

# Manual poll via telegram-poll.mjs (also exits silently if empty)
node core/telegram-poll.mjs poll
```

## Manual Task Execution (Windows)

If you need to run the Telegram monitor immediately without waiting for the scheduled 5-minute interval:

```powershell
# As Administrator, in PowerShell:
schtasks /change /tn "CareerOps-Telegram-Poll" /enable
schtasks /run /tn "CareerOps-Telegram-Poll"

# To verify it ran, check the last run time:
schtasks /query /tn "CareerOps-Telegram-Poll" /v
```

**Note:** You must run PowerShell/Command Prompt **as Administrator** for these commands to work. If you see "Access is denied", right-click PowerShell and select "Run as administrator."

If the task doesn't exist yet, first run:
```bash
telegram-setup-scheduler.bat
```
(as Administrator in the career-ops directory)

## Monitoring

### Check if the task is running
Open Task Scheduler, find `CareerOps-Telegram-Poll`, and check its last run time.

### View logs (optional)
Enable task history:
1. Task Scheduler → **View** → **Show History** (check the box)
2. Expand the task to see when it ran and if there were errors

### Disable temporarily
```bash
schtasks /change /tn "CareerOps-Telegram-Poll" /disable
```

### Re-enable
```bash
schtasks /change /tn "CareerOps-Telegram-Poll" /enable
```

### Delete the task
```bash
schtasks /delete /tn "CareerOps-Telegram-Poll" /f
```

## Token Cost Comparison

### Before (polling through Claude Code)

Invoked every 5 minutes via `/career-ops telegram mode Step 1 (poll)`:
- Each poll loads AGENTS.md, modes/telegram.md, plugins/telegram/* → ~5-10k tokens
- Empty poll: 5-10k tokens wasted
- 288 polls/day (every 5 min) × 5k = **~1.4M tokens/day wasted**

### After (headless monitoring)

Invoked every 5 minutes via `telegram-monitor.mjs`:
- Each poll is pure Node.js (zero tokens)
- Empty poll: 0 tokens
- When messages arrive: Claude invoked for routing (~5-10k tokens)
- If 5 messages/day: 5 × 5k = **25k tokens/day for routing only**

**Savings: ~1.38M tokens/day** (if idle with no incoming messages)

## Troubleshooting

### Task doesn't run
- Check that you ran `telegram-setup-scheduler.bat` as Administrator
- Verify the path to `node.exe` is correct (should be in PATH if Node.js installed via installer)
- Check Task Scheduler logs for errors

### Task runs but messages not routed
- Verify the **repo root's own** `.env` has `TELEGRAM_BOT_TOKEN` set — this is hub-global (shared by every workspace), not per-workspace, and must live at the repo root specifically, not inside any `workspaces/{slug}/`.
- Run `node core/telegram-poll.mjs poll` manually from the repo root to test — should return `{"messages": []}` with **no `error` field**. An `error` field (even with an empty `messages` array) means something's actually wrong — read it, it's specific (e.g. `TELEGRAM_BOT_TOKEN not set`).
- If your own messages specifically aren't routing (a stranger's would still hit the access-code gate correctly), your `chat_id` may not be bound yet — see "Migrating an existing single-tenant setup" above.
- Sends failing (replies never arrive, but polling works): run `node core/plugins.mjs run telegram notify "test" --dry-run` from inside your own `workspaces/{slug}/` directory — should print `would send to Telegram chats ...`. A "not enabled" or "missing TELEGRAM_BOT_TOKEN" error here means the repo-root `.env` issue above.

### "Node not found" error
- Ensure Node.js is installed and `node` is in PATH
- Restart your computer after installing Node.js to update PATH

## For macOS/Linux

Replace the batch file with a cron job:

```bash
# Edit crontab
crontab -e

# Add this line (runs every 5 minutes):
*/5 * * * * cd /path/to/career-ops && node core/telegram-monitor.mjs
```

Then save and exit. Cron will handle scheduling automatically.

For systemd timer (alternative):
```bash
# Create /etc/systemd/system/telegram-monitor.service
[Unit]
Description=Career-Ops Telegram Monitor
After=network.target

[Service]
Type=oneshot
WorkingDirectory=/path/to/career-ops
ExecStart=/usr/bin/node core/telegram-monitor.mjs

# Create /etc/systemd/system/telegram-monitor.timer
[Unit]
Description=Run Telegram Monitor Every 5 Minutes
Requires=telegram-monitor.service

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-monitor.timer
```

## Architecture Notes

- **`telegram-monitor.mjs`**: Entry point — polls, classifies (via `telegram-router.mjs`), and dispatches one Claude invocation per chat group; bound-chat dispatches run non-blocking, onboarding dispatches are serialized and time-bounded
- **`telegram-router.mjs`**: Zero-token, deterministic classification of every message by chat_id — bound, mid-onboarding, redeeming a code, or wrong-code/locked-out — before any Claude invocation
- **`access-code.mjs`**: One-time access-code registry (`generate`/`list`/`revoke`), consumed by the router on redemption
- **`telegram-poll.mjs`**: Thin CLI wrapper around the Telegram plugin's `ingest` hook — hub-global (see "Multi-Tenant Access" above)
- **`plugins/telegram/index.mjs`**: Telegram Bot API integration (fetches messages, preserves command signals)
- **`modes/telegram.md`**: Full routing logic for a bound chat (Steps 2-6, invoked only when messages exist)
- **`modes/telegram-onboarding.md`**: The conversational setup flow for an unbound chat that just redeemed a code

## See Also

- `modes/telegram.md` — Full mode specification, routing rules, stateful confirmation handling
- `modes/telegram-onboarding.md` — Onboarding conversation specification
- `docs/superpowers/specs/2026-08-18-telegram-router-onboarding-design.md` — Router/access-code/onboarding design
- `plugins/telegram/skill.md` — Telegram plugin API docs
- `telegram-poll.mjs` — Headless polling CLI

