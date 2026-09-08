#!/usr/bin/env node
/**
 * verify-jd-coverage.mjs — Post-tailoring JD-keyword coverage check.
 *
 * jd-skill-gap.mjs classifies JD requirements against cv.md ONCE, before
 * tailoring (see modes/pdf.md Step 4) — it never confirms the skills it
 * flagged existing/supportedByResume actually survived into the FINAL
 * tailored resume. This reuses jd-skill-gap.mjs's own exported matching
 * logic (extractJdSkills/classifySkillGaps — no reimplementation) against
 * the tailored CV JSON payload instead, so "keyword coverage %" becomes a
 * measured fact instead of the LLM's own self-estimate (added 2026-08-13).
 *
 * Also flags REGRESSIONS: a JD skill cv.md could support (existing or
 * supportedByResume, pre-tailoring) that didn't make it into the final
 * tailored text at all (gap, post-tailoring) — content that was available
 * but got paraphrased away or cut. The tailoring step should guarantee at
 * least one verbatim occurrence of each such skill survives (in a
 * competency or a bullet) — without reopening modes/pdf.md's existing
 * anti-keyword-stacking rule (line 111): guarantee presence once, never
 * stack/repeat beyond that.
 *
 * Also flags a COMPETENCIES/SKILLS OVERLAP (added 2026-09-03, found live):
 * `competencies` and `skills` are two different views of the candidate
 * (see modes/pdf.md § "Core Competencies vs. Skills — no overlap") but
 * nothing upstream previously enforced that they stay disjoint — a
 * candidate with one flat Skills line in cv.md could end up with the same
 * phrases duplicated across both sections (confirmed up to 88% overlap on
 * one real tailored resume). This is a measured fact the same way JD
 * coverage is, not left to the tailoring step's self-report.
 *
 * Usage:
 *   node verify-jd-coverage.mjs <jd-path> <tailored-cv-json-path> [--summary]
 *
 * <jd-path> is the same JD scratch file jd-skill-gap.mjs's own pre-tailoring
 * check already uses (modes/pdf.md Step 4: "write the JD to a scratch file
 * ... then node jd-skill-gap.mjs jds/{slug}.md --summary") — reuse it here,
 * don't re-save a second copy.
 */

import { readFileSync, existsSync } from 'fs';
import { extractJdSkills, classifySkillGaps, diagnoseExtraction } from './jd-skill-gap.mjs';

const CV_PATH = 'cv.md';

/**
 * Flatten a tailored CV JSON payload (modes/latex.md's documented schema)
 * down to the text-bearing fields a JD-keyword check can scan — dates,
 * URLs, org names, and award years carry no JD-keyword content.
 */
function cvJsonToText(cv) {
  const parts = [];
  if (cv.summary) parts.push(cv.summary);
  if (Array.isArray(cv.competencies)) parts.push(cv.competencies.join('. '));
  for (const exp of cv.experience || []) {
    for (const b of exp.bullets || []) parts.push(b);
  }
  for (const proj of cv.projects || []) {
    for (const b of proj.bullets || []) parts.push(b);
  }
  for (const sk of cv.skills || []) {
    if (sk.items) parts.push(sk.items);
  }
  return parts.join('\n');
}

/** Case/punctuation-insensitive normalization for phrase comparison. */
function normPhrase(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Flags competency phrases that also appear (verbatim or as a substring of
 * a skills.items entry) in the skills section — see the module doc comment.
 * Never throws on malformed/missing fields; a payload with no competencies
 * or no skills simply has nothing to overlap.
 *
 * @param {object} cv - tailored CV JSON payload (modes/latex.md schema)
 * @returns {{ overlapping: string[], pct: number }}
 */
export function checkCompetencySkillOverlap(cv) {
  const competencies = Array.isArray(cv.competencies) ? cv.competencies : [];
  if (!competencies.length) return { overlapping: [], pct: 0 };

  const skillItems = [];
  for (const sk of cv.skills || []) {
    if (!sk || !sk.items) continue;
    const raw = Array.isArray(sk.items) ? sk.items : String(sk.items).split(',');
    for (const item of raw) {
      const n = normPhrase(item);
      if (n) skillItems.push(n);
    }
  }
  if (!skillItems.length) return { overlapping: [], pct: 0 };

  const skillItemSet = new Set(skillItems);
  const skillsBlob = ` ${skillItems.join(' | ')} `;

  const overlapping = competencies.filter(c => {
    const nc = normPhrase(c);
    if (!nc) return false;
    // Exact match against a single skills.items entry, or the competency
    // phrase appears whole within the joined skills blob (handles a skills
    // category that lists several comma-separated items as one entry).
    return skillItemSet.has(nc) || skillsBlob.includes(` ${nc} `) || skillsBlob.includes(`|${nc} `) || skillsBlob.includes(` ${nc}|`);
  });

  return { overlapping, pct: Math.round((overlapping.length / competencies.length) * 100) };
}

function main() {
  const [, , jdPath, cvJsonPath, ...flags] = process.argv;
  const summary = flags.includes('--summary');

  if (!jdPath || !cvJsonPath) {
    console.error('Usage: node verify-jd-coverage.mjs <jd-path> <tailored-cv-json-path> [--summary]');
    process.exit(1);
  }
  if (!existsSync(jdPath)) { console.error(`JD file not found: ${jdPath}`); process.exit(1); }
  if (!existsSync(cvJsonPath)) { console.error(`Tailored CV JSON not found: ${cvJsonPath}`); process.exit(1); }

  const jdText = readFileSync(jdPath, 'utf8');
  const jdSkills = extractJdSkills(jdText);
  const diag = diagnoseExtraction(jdText, jdSkills);
  if (diag) {
    const out = { ok: false, reason: diag.reason, message: diag.message };
    console.log(summary ? `JD-coverage: inconclusive — ${diag.message}` : JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const cv = JSON.parse(readFileSync(cvJsonPath, 'utf8'));
  const tailoredText = cvJsonToText(cv);
  const post = classifySkillGaps(jdSkills, tailoredText);

  // Pre-tailoring baseline (cv.md), when available, to detect regressions —
  // a skill cv.md could support that didn't survive into the tailored text.
  let regressions = [];
  if (existsSync(CV_PATH)) {
    const pre = classifySkillGaps(jdSkills, readFileSync(CV_PATH, 'utf8'));
    const preSupported = new Set([...pre.existing, ...pre.supportedByResume]);
    regressions = post.gap.filter(skill => preSupported.has(skill));
  }

  const total = jdSkills.length;
  const covered = post.existing.length + post.supportedByResume.length;
  const coveragePct = total > 0 ? Math.round((covered / total) * 100) : null;

  const overlap = checkCompetencySkillOverlap(cv);

  const output = {
    ok: true,
    totalJdSkills: total,
    covered,
    coveragePct,
    existing: post.existing,
    supportedByResume: post.supportedByResume,
    gap: post.gap,
    regressions, // supported by cv.md pre-tailoring, missing from the final tailored text
    competencySkillOverlap: overlap, // { overlapping: string[], pct: number } — see modes/pdf.md § "Core Competencies vs. Skills — no overlap"
  };

  if (summary) {
    console.log(`JD-coverage: ${coveragePct}% (${covered}/${total})`);
    if (post.gap.length) console.log(`Not in final resume at all (true gaps): ${post.gap.join(', ')}`);
    if (regressions.length) console.log(`⚠ Available in cv.md but dropped during tailoring: ${regressions.join(', ')} — consider a verbatim mention.`);
    if (overlap.overlapping.length) console.log(`⚠ Competencies/Skills overlap (${overlap.pct}%): ${overlap.overlapping.join(', ')} — these appear in both sections; competencies should be functional/thematic, skills should be concrete tools/systems. Fix before continuing (see modes/pdf.md § "Core Competencies vs. Skills — no overlap").`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

main();
