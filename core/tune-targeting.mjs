#!/usr/bin/env node
// @ts-check
// tune-targeting.mjs — zero-token analysis + apply tool for retargeting a
// workspace's title_filter against real scan results. Generalizes the manual
// analysis workflow used to retarget workspaces/thomas-acosta on 2026-09-03:
// bucket a scanned-title corpus by seniority/domain "signal words" to surface
// candidate exclusions, flag low-yield positive keywords, then (on approval)
// prune already-queued data/pipeline.md rows that match a finalized negative
// list — the same two steps done by hand with one-off .tmp/*.mjs scripts.
//
// Analysis only SUGGESTS. It never edits portals.yml itself — the candidate
// archetypes/keywords are a judgment call (this workspace's real fit, not a
// generic heuristic), same reasoning as every other zero-token gate in this
// repo (preflight-check.mjs, jd-skill-gap.mjs): the script gathers evidence,
// a human (or the agent, with the human's sign-off) decides.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { isMainModule } from './is-main.mjs';

// Built from what actually distinguished mismatches during the 2026-09-03
// thomas-acosta retarget: every one of ~280 false-positive "Account
// Executive" matches carried at least one of these. Not exhaustive — a
// starting heuristic to rank candidates for a human to confirm, not a
// silent auto-exclude list.
export const SENIORITY_SIGNAL_WORDS = [
  'Senior', 'Sr', 'Sr.', 'Enterprise', 'Strategic', 'Director', 'VP', 'Vice President',
  'Principal', 'Founding', 'Head of', 'Global', 'Named', 'Large Enterprise',
];
export const DOMAIN_SIGNAL_WORDS = [
  'Federal', 'SLED', 'Public Sector', 'Clinical', 'Pharmacy', 'Diagnostics',
  'Oncology', 'Toxicology', 'Surgical', 'DACH', 'LATAM',
];
export const ENTRY_SIGNAL_WORDS = [
  'Associate', 'Advocate', 'Representative', 'Coordinator', 'Assistant',
  'Trainee', 'Entry', 'Jr', 'Jr.', 'Junior',
];

/** Load the scanned-title corpus for a workspace: prefer the full-ATS-sweep
 * checkpoint (richer, has location), fall back to scan-history.tsv rows
 * still marked "added" (survives after a checkpoint is cleared on a clean
 * finish). Returns [{title, company, location}]. */
export function loadCorpus(wsDir) {
  const checkpointPath = `${wsDir}/data/cache/ats-full-checkpoint.json`;
  if (existsSync(checkpointPath)) {
    const cp = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
    return (cp.offers || []).map(o => ({ title: o.title, company: o.company, location: o.location || '' }));
  }
  const historyPath = `${wsDir}/data/scan-history.tsv`;
  if (!existsSync(historyPath)) return [];
  const lines = readFileSync(historyPath, 'utf-8').split('\n').slice(1).filter(Boolean);
  return lines
    .map(l => l.split('\t'))
    .filter(c => c[5] === 'added')
    .map(c => ({ title: c[3], company: c[4], location: c[6] || '' }));
}

function loadPortals(wsDir) {
  return load(readFileSync(`${wsDir}/portals.yml`, 'utf-8'));
}

function includesCi(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Core analysis: for each configured positive keyword, how many corpus
 * titles it matched and which signal words co-occurred (ranked by count).
 * Also flags positive keywords with zero matches (dead weight — costing a
 * scan cycle for nothing) and existing negative keywords with zero hits
 * (harmless but worth knowing they're not doing anything against this
 * corpus).
 */
export function analyze(wsDir) {
  const portals = loadPortals(wsDir);
  const positive = portals?.title_filter?.positive || [];
  const negative = portals?.title_filter?.negative || [];
  const corpus = loadCorpus(wsDir);

  const perKeyword = positive.map(kw => {
    const matches = corpus.filter(o => includesCi(o.title || '', kw));
    const signalCounts = {};
    for (const word of [...SENIORITY_SIGNAL_WORDS, ...DOMAIN_SIGNAL_WORDS]) {
      const n = matches.filter(m => includesCi(m.title, word)).length;
      if (n > 0) signalCounts[word] = n;
    }
    return { keyword: kw, matchCount: matches.length, signalCounts };
  });

  // Rank candidate exclusions across the WHOLE corpus (not per-keyword) —
  // a word worth excluding is one that shows up often regardless of which
  // positive keyword let the posting through.
  const candidateExclusions = {};
  for (const word of [...SENIORITY_SIGNAL_WORDS, ...DOMAIN_SIGNAL_WORDS]) {
    if (negative.some(n => n.toLowerCase() === word.toLowerCase())) continue; // already excluded
    const n = corpus.filter(o => includesCi(o.title || '', word)).length;
    if (n > 0) candidateExclusions[word] = n;
  }
  const rankedExclusions = Object.entries(candidateExclusions)
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => ({ word, count, pctOfCorpus: corpus.length ? +(count / corpus.length * 100).toFixed(1) : 0 }));

  const entrySignalHits = ENTRY_SIGNAL_WORDS
    .map(word => ({ word, count: corpus.filter(o => includesCi(o.title || '', word)).length }))
    .filter(h => h.count > 0)
    .sort((a, b) => b.count - a.count);

  const lowYield = perKeyword.filter(k => k.matchCount === 0).map(k => k.keyword);
  const deadNegatives = negative.filter(kw => corpus.filter(o => includesCi(o.title || '', kw)).length === 0);

  return {
    corpusSize: corpus.length,
    perKeyword,
    lowYieldPositiveKeywords: lowYield,
    candidateExclusions: rankedExclusions,
    entrySignalHits,
    deadNegativeKeywords: deadNegatives,
  };
}

function printSummary(result) {
  console.log(`Corpus: ${result.corpusSize} scanned titles\n`);
  console.log('Per-keyword yield:');
  for (const k of result.perKeyword) {
    const flag = k.matchCount === 0 ? '  ⚠ zero matches — dead weight' : '';
    console.log(`  ${String(k.matchCount).padStart(4)}  ${k.keyword}${flag}`);
    const sig = Object.entries(k.signalCounts).sort((a, b) => b[1] - a[1]);
    if (sig.length) console.log(`         co-occurring: ${sig.map(([w, n]) => `${w}(${n})`).join(', ')}`);
  }
  if (result.candidateExclusions.length) {
    console.log('\nCandidate exclusions (ranked by corpus-wide frequency):');
    for (const c of result.candidateExclusions.slice(0, 15)) {
      console.log(`  ${String(c.count).padStart(4)}  ${c.word}  (${c.pctOfCorpus}% of corpus)`);
    }
  }
  if (result.entrySignalHits.length) {
    console.log('\nEntry-level signal words already present in real results:');
    for (const e of result.entrySignalHits) console.log(`  ${String(e.count).padStart(4)}  ${e.word}`);
  }
  if (result.deadNegativeKeywords.length) {
    console.log(`\nExisting negative keywords with zero hits in this corpus (harmless, just inert here): ${result.deadNegativeKeywords.join(', ')}`);
  }
  console.log('\nThis is a suggestion, not an edit — portals.yml is unchanged. Review, then apply the ones that make sense by hand or via `prune`.');
}

/**
 * Remove already-queued data/pipeline.md Pending rows matching any of the
 * given (finalized, human-approved) negative keywords, and mark the
 * corresponding data/scan-history.tsv rows skipped_title so they don't
 * silently look "added" in the audit trail. title_filter only applies at
 * scan time — this is what makes a portals.yml edit retroactive for
 * postings already sitting in the inbox.
 */
export function prune(wsDir, negativeKeywords) {
  const pipelinePath = `${wsDir}/data/pipeline.md`;
  const historyPath = `${wsDir}/data/scan-history.tsv`;
  const lines = readFileSync(pipelinePath, 'utf-8').split('\n');
  const kept = [];
  const removedUrls = [];
  for (const line of lines) {
    const m = line.match(/^- \[ \] (\S+) \| ([^|]+) \| ([^|]+)/);
    if (!m) { kept.push(line); continue; }
    const [, url, , title] = m;
    const hit = negativeKeywords.some(kw => includesCi(title.trim(), kw));
    if (hit) removedUrls.push(url); else kept.push(line);
  }
  writeFileSync(pipelinePath, kept.join('\n'), 'utf-8');

  let updated = 0;
  if (existsSync(historyPath)) {
    const removedSet = new Set(removedUrls);
    const hLines = readFileSync(historyPath, 'utf-8').split('\n');
    const newLines = hLines.map((row, idx) => {
      if (idx === 0 || !row.trim()) return row;
      const cols = row.split('\t');
      if (removedSet.has(cols[0]) && cols[5] === 'added') { cols[5] = 'skipped_title'; updated++; return cols.join('\t'); }
      return row;
    });
    writeFileSync(historyPath, newLines.join('\n'), 'utf-8');
  }
  return { removed: removedUrls.length, historyRowsUpdated: updated };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const wsFlagIdx = rest.indexOf('--workspace');
  const wsDir = wsFlagIdx !== -1 ? rest[wsFlagIdx + 1] : '.';

  if (cmd === 'analyze') {
    const result = analyze(wsDir);
    if (rest.includes('--summary')) printSummary(result);
    else console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (cmd === 'prune') {
    const negIdx = rest.indexOf('--negative');
    if (negIdx === -1) { console.error('Usage: node tune-targeting.mjs prune --negative "kw1,kw2,kw3" [--workspace <path>]'); process.exit(1); }
    const negativeKeywords = rest[negIdx + 1].split(',').map(s => s.trim()).filter(Boolean);
    const result = prune(wsDir, negativeKeywords);
    console.log(`removed ${result.removed} pending entries; updated ${result.historyRowsUpdated} scan-history rows to skipped_title`);
    return;
  }
  console.error('Usage: node tune-targeting.mjs analyze [--summary] [--workspace <path>]\n       node tune-targeting.mjs prune --negative "kw1,kw2" [--workspace <path>]');
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch(err => { console.error(`❌ tune-targeting: ${err.message}`); process.exit(1); });
}
