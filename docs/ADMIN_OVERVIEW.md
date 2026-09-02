# Admin Overview Artifact — Setup

Two scripts do all the work, zero LLM tokens:

```bash
node core/admin-overview-snapshot.mjs /tmp/admin-overview-snapshot.json
node core/admin-overview-render.mjs /tmp/admin-overview-snapshot.json /tmp/admin-overview.html
```

The first gathers workspace roster, tracker stats, active-task status, and
token-usage/run-count history (mined from `~/.claude/projects/`) into one
JSON file. The second turns that JSON into a complete HTML page. Neither
step needs Claude — they're both plain Node scripts.

## One-time: publish the artifact

In an interactive Claude Code session, run the two commands above, then ask
Claude to publish `/tmp/admin-overview.html` as an Artifact. Keep the
resulting URL — every future scheduled run redeploys to that same URL.

## Scheduled refresh (Windows Task Scheduler)

1. Open Task Scheduler → Create Task.
2. Trigger: whatever interval you want (e.g. every 30 minutes).
3. Action: Start a program.
   - Program: `claude`
   - Arguments:
     ```
     -p "[HEADLESS] This is a non-interactive, unattended invocation — no human is present to answer a question this turn, and there is no future turn to come back to: this is a single, one-shot invocation that ends when this response ends. Run `node core/admin-overview-snapshot.mjs .tmp/admin-overview-snapshot.json` then `node core/admin-overview-render.mjs .tmp/admin-overview-snapshot.json .tmp/admin-overview.html`, then republish the admin-overview Artifact (URL: <paste the URL from the one-time publish step above>) from the resulting .tmp/admin-overview.html file. Do not ask any questions. If either script fails, report the error in your final message and stop — do not attempt to publish a partial or fabricated snapshot."
     ```
   - Start in: the repo root (so the relative `.tmp/` paths resolve correctly).
4. If you use a subscription rather than an API key for this, generate a long-lived token once (`claude setup-token`) and set it as `CLAUDE_CODE_OAUTH_TOKEN` in the scheduled task's environment — see `docs/RUNNING_ON_A_BUDGET.md`'s "batch mode is the exception" section for why headless invocations need this.

## Known limitations (by design, not bugs)

- **Not truly real-time.** The page shows whatever was true as of the last scheduled run. If the machine is asleep or the task doesn't fire, the page goes stale — there's no live capability backing it.
- **Token-usage/run-count history only covers sessions launched with a workspace as the project root** (e.g. Telegram-triggered runs). Interactive hub-root sessions that happen to touch a workspace's files aren't attributed to that workspace's history.
- **Run classification is best-effort.** It's a keyword match against free-text prompt args, not a structured log — see the `unclassified` bucket in the rendered page for anything it couldn't confidently classify.
