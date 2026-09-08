---
name: career-ops-dashboard
description: Generate or refresh "Hub Control" — a cross-workspace admin dashboard (workspace roster, tracker stats, token usage, run activity) for every provisioned career-ops workspace — and publish/update it as a Claude Artifact. Use when asked to create, generate, refresh, update, regenerate, or rebuild the career-ops dashboard, hub overview, or admin dashboard.
---

This is the hub owner's cross-tenant admin view — see
`docs/superpowers/specs/2026-09-02-admin-overview-design.md` for the original
design. Data gathering (`core/admin-overview-snapshot.mjs`) is zero-LLM,
privacy-scoped Node — it extracts only `timestamp`/`usage`/skill-args fields
from local session transcripts, never conversation content. This skill's job
is to turn that data into a published Artifact page, and to keep updating the
*same* Artifact on repeat runs rather than spawning duplicates.

There are two renderers over the same snapshot data — don't confuse them:

- `core/admin-overview-render.mjs` — the plain table-only fallback from the
  original design (still tested in `tests/admin-overview-render.test.mjs`).
- `core/render-hub-control.mjs` + `templates/hub-control-template.html` —
  the richer "Hub Control" dashboard this skill drives (stat tiles,
  per-workspace cards, token-usage bars, run-activity chart). Built with the
  `artifact-design` and `dataviz` skills.

## Steps

1. **Render fresh HTML** — run from the repo root (works regardless of cwd,
   paths resolve off the script's own location):

   ```bash
   node core/render-hub-control.mjs
   ```

   Writes `data/cache/hub-control.html` (gitignored, generated) from a fresh
   `buildSnapshot()` call. Pass an explicit output path as `argv[2]` to write
   elsewhere.

2. **Check for a previously published URL** — read `data/dashboard-artifact.json`
   at the repo root (gitignored, hub-level state — same tier as
   `data/telegram-bot-identity.json`). If it exists and has a `url` field,
   this is a refresh, not a first publish.

3. **Publish** with the `Artifact` tool:
   - `file_path`: `data/cache/hub-control.html`
   - `favicon`: `📡`
   - `title`: the file already carries `<title>Hub Control</title>`, so this
     is optional
   - `description`: one sentence, e.g. "Cross-workspace snapshot of tracker
     stats, token usage, and run activity across every provisioned career-ops
     workspace."
   - `url`: the value from step 2, if one exists — **this is what makes it an
     update instead of a new artifact.** Omit only on a genuine first
     publish.

4. **Persist the URL** — write (or update) `data/dashboard-artifact.json`
   with the URL the publish call returned, plus a timestamp:

   ```json
   { "url": "https://claude.ai/code/artifact/...", "publishedAt": "2026-09-04T12:00:00.000Z" }
   ```

   so the *next* run of this skill — in this session or a future one — knows
   to update rather than duplicate.

5. **Report the link** to whoever asked (or, in a `[HEADLESS]` invocation,
   just log it — no one is present to click it live).

## When to touch the template vs. just re-render

Steps 1-5 above are a pure data refresh — the template
(`templates/hub-control-template.html`) doesn't change, so there's no need
to reload `artifact-design`/`dataviz` for a routine "regenerate the
dashboard" request.

Only reload those skills if the user asks to change the dashboard's *design*
(new sections, different layout, different palette) — then edit
`templates/hub-control-template.html` directly (it still contains the
`__SNAPSHOT_JSON__` placeholder consumed by `core/render-hub-control.mjs`;
don't remove it) and re-run steps 1-5 to publish the new look. If you add or
remove fields the template reads, sanity-check
`tests/render-hub-control.test.mjs` still passes:

```bash
node --test tests/render-hub-control.test.mjs
```

## Gotchas

- **The snapshot is a point-in-time capture, not live.** The published page
  has no runtime capabilities (no `db`, no auto-refresh) — it shows whatever
  was true when step 1 ran. Re-run the whole flow to refresh; don't tell the
  user it updates itself.
- **`</script` inside workspace data.** The snapshot is embedded in a
  `<script type="application/json">` tag and parsed via `textContent`, so
  quotes/backslashes/unicode line separators need no escaping — but a
  literal `</script` sequence (e.g. inside a workspace's `display_name`)
  would still close the tag early. `render-hub-control.mjs` already
  neutralizes this (`escapeForScriptTag`); don't bypass it by hand-editing
  the rendered HTML.
- **"Hub" and "deleted-or-renamed" aren't job-seeker workspaces.** `hub` is
  the hub owner's own dev/build sessions on this repo; `deleted-or-renamed`
  is transcript history whose workspace slug no longer matches a currently
  provisioned one. The template already labels both distinctly (dashed
  border, a "system"/"archived" tag) — keep that distinction if you touch
  the design.
- **New workspaces need no code change.** `buildSnapshot()` enumerates
  `workspaces/*/workspace.json` fresh on every call — provisioning a new
  workspace (e.g. via `telegram-onboarding`) makes it appear on the next
  render automatically.

## Troubleshooting

- **`render-hub-control.mjs` throws "missing the __SNAPSHOT_JSON__
  placeholder"**: someone edited `templates/hub-control-template.html` and
  removed the placeholder comment/tag. Restore
  `<script type="application/json" id="snapshot-data">__SNAPSHOT_JSON__</script>`.
- **A workspace is missing from the dashboard**: check it actually has a
  `workspace.json` (not just a directory) under `workspaces/` —
  `listWorkspaces()` skips directories without one, same as
  `core/admin-overview-snapshot.mjs` always has.
