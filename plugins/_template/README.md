# career-ops-plugin-{{NAME}}

A plugin for career-ops.

## What it does

TODO: one paragraph.

## Install

```bash
# Once it's in the career-ops registry:
node core/plugins.mjs add {{NAME}}

# Before listing (install directly from your repo at a pinned commit):
node core/plugins.mjs add <your-github-user>/career-ops-plugin-{{NAME}} --sha <40-hex-commit>
```

Then enable + consent:

```bash
node core/plugins.mjs enable {{NAME}}            # shows the capability card
node core/plugins.mjs enable {{NAME}} --confirm  # grants it
```

## Configure

- Secrets go in your `.env` (the names are in `manifest.json` → `requiredEnv`).
- Non-secret options go in `config/plugins.yml` under `plugins.{{NAME}}`.

## License

MIT
