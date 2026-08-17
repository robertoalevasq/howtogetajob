// @ts-check
// workspace-root.mjs — resolves the root for USER-LAYER paths (data/,
// reports/, cv.md, config/, portals.yml, etc.). System-layer paths (templates/,
// providers/, plugins/) keep resolving off each script's own ROOT
// (dirname(fileURLToPath(import.meta.url))) unchanged — this helper is only
// for the paths that must land inside the CURRENT workspace.
//
// A future router always spawns claude -p with cwd set to the target
// workspace directory, so process.cwd() is correct by construction there.
// For a solo user running career-ops from the repo root as before workspaces
// existed, process.cwd() IS the repo root — identical behavior, no migration
// needed. CAREER_OPS_WORKSPACE is an explicit override for the rare case cwd
// isn't trustworthy (matches the CAREER_OPS_REPORTS_DIR-style overrides
// already used elsewhere in this codebase).

export function workspaceRoot() {
  return process.env.CAREER_OPS_WORKSPACE || process.cwd();
}
