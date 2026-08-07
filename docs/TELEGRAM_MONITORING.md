# Telegram Monitoring — Headless Polling Setup

## Overview

`telegram-monitor.mjs` is a **minimal Claude entry point** for Telegram polling that eliminates token waste on empty results.

**How it works:**
1. **Polls Telegram headlessly** via `node telegram-poll.mjs poll` (zero tokens, pure Node.js)
2. **Exits silently if no messages** (zero Claude context loaded)
3. **Invokes Claude routing** only when messages exist (Steps 2-6 of `modes/telegram.md`)

**Before:** `/career-ops telegram mode Step 1 (poll)` invoked through Claude repeatedly → loaded AGENTS.md, mode files, etc. every time → wasted tokens on empty polls.

**After:** `telegram-monitor.mjs` polls headlessly → only invokes Claude when it matters.

## Quick Setup (Windows Task Scheduler)

### Automatic Setup
```bash
# As Administrator in the career-ops directory:
telegram-setup-scheduler.bat
```

This creates a recurring task `CareerOps-Telegram-Poll` that runs every 5 minutes.

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
    node telegram-monitor.mjs
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
$ node telegram-monitor.mjs
$ echo $?
0  # Exit silently
```

**Messages arrive (Claude routing invoked):**
```bash
$ node telegram-monitor.mjs
[Claude would route 1 message(s) via modes/telegram.md Steps 2-6]
{"status": "routing", "message_count": 1}
```

## CLI Commands

```bash
# Poll once (exits silently if empty)
node telegram-monitor.mjs

# Reset polling offset (same as telegram-poll.mjs reset)
node telegram-monitor.mjs --reset

# Manual poll via telegram-poll.mjs (also exits silently if empty)
node telegram-poll.mjs poll
```

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
- Verify `.env` has `TELEGRAM_BOT_TOKEN` set
- Verify `config/plugins.yml` has `telegram.enabled: true` and `telegram.chat_id` set
- Run `node telegram-poll.mjs poll` manually to test — should return `{"messages": []}`

### "Node not found" error
- Ensure Node.js is installed and `node` is in PATH
- Restart your computer after installing Node.js to update PATH

## For macOS/Linux

Replace the batch file with a cron job:

```bash
# Edit crontab
crontab -e

# Add this line (runs every 5 minutes):
*/5 * * * * cd /path/to/career-ops && node telegram-monitor.mjs
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
ExecStart=/usr/bin/node telegram-monitor.mjs

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

- **`telegram-monitor.mjs`**: Entry point that decides whether to invoke Claude
- **`telegram-poll.mjs`**: Thin CLI wrapper around the Telegram plugin's `ingest` hook
- **`plugins/telegram/index.mjs`**: Telegram Bot API integration (fetches messages, preserves command signals)
- **`modes/telegram.md`**: Full routing logic (Steps 2-6, invoked only when messages exist)

## See Also

- `modes/telegram.md` — Full mode specification, routing rules, stateful confirmation handling
- `plugins/telegram/skill.md` — Telegram plugin API docs
- `telegram-poll.mjs` — Headless polling CLI

