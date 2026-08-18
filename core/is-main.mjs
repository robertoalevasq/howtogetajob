// Shared "is this file the one Node was invoked to run" check.
//
// The naive `import.meta.url === pathToFileURL(process.argv[1]).href` (or any
// of its resolve()/fileURLToPath() variants) compares a REAL path (Node
// resolves import.meta.url through symlinks/junctions to the actual file)
// against a LITERAL path (process.argv[1] keeps exactly what was typed on
// the command line). Those never match when the script is invoked through a
// directory junction -- e.g. `cd workspaces/roberto && node core/stats.mjs`,
// where `core` is a junction back to the real core/ directory. The guard
// silently evaluates to false, `main()` never runs, and the process exits 0
// having done nothing -- indistinguishable from success in a log (see
// core/AGENTS.md's "Headless Invocation Signal" section for the same failure
// class in a different guise).
//
// Fix: resolve BOTH sides to their real, on-disk path before comparing.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} importMetaUrl - pass `import.meta.url` from the caller.
 * @returns {boolean} true when this module is the one Node was launched to run.
 */
export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
