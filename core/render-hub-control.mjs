/**
 * render-hub-control.mjs — builds a fresh cross-workspace snapshot (via
 * admin-overview-snapshot.mjs's buildSnapshot()) and injects it into
 * templates/hub-control-template.html, producing a ready-to-publish HTML
 * file for the "Hub Control" admin dashboard Artifact.
 *
 * This is a second, richer renderer alongside admin-overview-render.mjs
 * (which stays as the plain table-only fallback documented in the original
 * admin-overview design). Both consume the same buildSnapshot() output, so
 * neither can regress the privacy-critical guarantee that only
 * timestamp/usage/skill-args fields ever leave a session transcript — that
 * guarantee lives in buildSnapshot() itself, not in either renderer.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildSnapshot } from './admin-overview-snapshot.mjs';
import { isMainModule } from './is-main.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_PATH = join(ROOT, 'templates', 'hub-control-template.html');
const DEFAULT_OUT = join(ROOT, 'data', 'cache', 'hub-control.html');

// The snapshot is embedded in a <script type="application/json"> tag (parsed
// via textContent, not evaluated as JS), so the only character sequence that
// can break the page is a literal "</script" closing the tag early — quotes,
// backslashes, and U+2028/U+2029 all pass through textContent safely and need
// no escaping here.
function escapeForScriptTag(json) {
  return json.replace(/<\/script/gi, '<\\/script');
}

/**
 * @param {string} [reposRoot] - Override for tests.
 * @param {string} [claudeHome] - Override for tests.
 * @returns {{html: string, snapshot: object}}
 */
export function renderHubControl(reposRoot = ROOT, claudeHome) {
  const snapshot = buildSnapshot(reposRoot, claudeHome);
  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  const json = escapeForScriptTag(JSON.stringify(snapshot));
  if (!template.includes('__SNAPSHOT_JSON__')) {
    throw new Error(`${TEMPLATE_PATH} is missing the __SNAPSHOT_JSON__ placeholder`);
  }
  const html = template.replace('__SNAPSHOT_JSON__', json);
  return { html, snapshot };
}

async function main() {
  const outPath = process.argv[2] || DEFAULT_OUT;
  const { html, snapshot } = renderHubControl();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf-8');
  console.log(`render-hub-control: wrote ${outPath} (${snapshot.workspaces.length} workspace(s))`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
