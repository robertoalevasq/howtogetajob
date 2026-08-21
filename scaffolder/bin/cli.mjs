#!/usr/bin/env node
// career-ops scaffolder — one-command install.
// Clones the repo at the latest release tag and installs dependencies.
// It deliberately does NOT create cv.md / config/profile.yml / portals.yml:
// the agent runs a conversational onboarding on first launch (see AGENTS.md
// "First Run — Onboarding"), which is triggered precisely by those files
// being absent. Pre-creating them from the examples would suppress that
// onboarding and leave the user with placeholder data.
//
// This installer is disabled for this personal fork — it has no upstream
// repo to clone from. See de-brand-personal-fork plan.

const USAGE = `career-ops — set up an AI job search workspace.

Usage:
  npx career-ops init [folder]    Create a new workspace (default: ./career-ops)

After setup, open your AI coding tool inside the folder and paste a job offer.
Docs: https://github.com/santifer/career-ops`;

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  const [cmd] = process.argv.slice(2);

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }
  if (cmd !== "init") die(`Unknown command "${cmd}".\n${USAGE}`);

  console.error("This installer is disabled for this personal fork — it has no upstream repo to install from. If you're looking for the original project, see https://github.com/santifer/career-ops.");
  process.exit(1);
}

main().catch((err) => die(err?.message || String(err)));
