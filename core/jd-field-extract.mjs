#!/usr/bin/env node
/**
 * jd-field-extract.mjs — zero-token JD field extraction and hard-stop regex pre-checks
 *
 * After a JD fetch (via CLI extractor or Playwright), this script:
 * 1. Extracts structured fields (title, location, salary, etc.) via API (GH/Lever/Ashby) or regex (others)
 * 2. Runs regex hard-stop pre-checks (security clearances, experience floor)
 * 3. Returns a structured field bundle for Block A pre-population
 *
 * Input: {url, title, text} (the output shape of browser-extract.mjs --mode jd)
 * Output: {
 *   url, title, text,  // passthrough
 *   structured: {
 *     location, salary, postedAt, description,  // extracted fields
 *     hardStops: ["TS/SCI clearance required", "10+ years required"],  // triggering patterns
 *     hardStop: true/false  // whether to discard immediately
 *   }
 * }
 *
 * Hard-stop triggers (auto-discard before pre-screen LLM call):
 * - Security clearance requirements: TS/SCI, Top Secret, Secret, active clearance
 * - Experience floor exceeding entry/intermediate: 10+, 9+, 8+, 7+ years
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Regex patterns for hard-stop detection
 */
const HARD_STOP_PATTERNS = {
  clearance: [
    /TS\s*\/\s*SCI/i,
    /top\s+secret/i,
    /secret\s+clearance/i,
    /active\s+(?:security\s+)?clearance/i,
    /security\s+clearance\s+required/i,
    /(?:must|require)\s+(?:active\s+)?(?:TS|security|clearance)/i,
  ],
  experienceFloor: [
    /\b(\d{1,2})\+\s+years?\b/i,  // captures "10+ years", "8+ years", etc.
  ],
};

/**
 * Thresholds for hard-stop triggers
 */
const EXPERIENCE_FLOOR_THRESHOLD = 7;  // 7+, 8+, 9+, 10+ years triggers discard

/**
 * Regex patterns for field extraction (used when API-based extraction unavailable)
 */
const FIELD_PATTERNS = {
  salary: [
    /\$(\d{2,3})[,.]?(\d{3})?\s*(?:k|K)?\s*(?:(?:–|-|to)\s*\$(\d{2,3})[,.]?(\d{3})?(?:k|K)?)?/,
    /salary[:\s]+(?:\$)?(\d{2,3})k?\s*(?:(?:–|-|to)\s*(?:\$)?(\d{2,3})k?)?/i,
  ],
  location: [
    /(?:location|based in|office|remote)[:\s]*([A-Z]{2}|[\w\s]+(?:,\s*[A-Z]{2})?)/i,
  ],
  postedDate: [
    /(?:posted|posted on)[:\s]*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|[\w\s]+ago)/i,
  ],
};

/**
 * For Greenhouse, Lever, and Ashby, attempt to extract structured fields via their APIs.
 * This is zero-token (reuses the company data already available from scanning).
 */
async function extractViaApi(url) {
  try {
    if (url.includes('greenhouse.io') || url.includes('boards.greenhouse')) {
      return extractGreenhouseFields(url);
    }
    if (url.includes('lever.co')) {
      return extractLeverFields(url);
    }
    if (url.includes('ashbyhq.com')) {
      return extractAshbyFields(url);
    }
  } catch (e) {
    // API extraction failed; regex fallback will handle it
  }
  return null;
}

/**
 * Greenhouse posting URL → extract via job ID from URL structure
 * /jobs/{id} or /board/jobs/{id}
 */
async function extractGreenhouseFields(url) {
  const jobIdMatch = url.match(/\/jobs\/(\d+)/);
  if (!jobIdMatch) return null;

  const jobId = jobIdMatch[1];
  try {
    const resp = await fetch(`https://boards.greenhouse.io/api/v1/jobs?ids=${jobId}`, {
      headers: { 'User-Agent': 'career-ops' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const job = data.jobs?.[0];
    if (!job) return null;

    return {
      location: job.location?.name || null,
      salary: formatSalaryRange(job.compensation),
      postedAt: job.published_at || null,
      description: null,  // full description is in the JD text already
    };
  } catch {
    return null;
  }
}

/**
 * Lever posting URL → extract via job ID
 */
async function extractLeverFields(url) {
  const jobIdMatch = url.match(/\/jobs\/[\w-]+\/([a-f0-9\-]+)/);
  if (!jobIdMatch) return null;

  const jobId = jobIdMatch[1];
  try {
    const resp = await fetch(`https://api.lever.co/v0/postings?mode=posting&posting_id=${jobId}`, {
      headers: { 'User-Agent': 'career-ops' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const posting = data.data?.[0];
    if (!posting) return null;

    return {
      location: posting.location?.name || null,
      salary: formatSalaryRange(posting.salary),
      postedAt: posting.createdAt || null,
      description: posting.descriptionPlain || null,
    };
  } catch {
    return null;
  }
}

/**
 * Ashby posting URL → extract via job ID
 */
async function extractAshbyFields(url) {
  const jobIdMatch = url.match(/\/([a-f0-9\-]+)(?:\?|$)/);
  if (!jobIdMatch) return null;

  const jobId = jobIdMatch[1];
  try {
    const resp = await fetch(`https://api.ashbyhq.com/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'career-ops' },
      body: JSON.stringify({
        query: `query { job(id: "${jobId}") { title location salary description } }`,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const job = data.data?.job;
    if (!job) return null;

    return {
      location: job.location || null,
      salary: job.salary || null,  // typically already formatted at Ashby
      postedAt: null,  // Ashby doesn't expose posted date in simple form
      description: job.description || null,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback regex-based field extraction from JD text
 */
function extractViaRegex(text) {
  if (!text || typeof text !== 'string') {
    return { location: null, salary: null, postedAt: null, description: null };
  }

  const lower = text.toLowerCase();

  // Salary extraction
  let salary = null;
  for (const pattern of FIELD_PATTERNS.salary) {
    const match = text.match(pattern);
    if (match) {
      salary = match[0];
      break;
    }
  }

  // Location extraction (simplified — look for state codes)
  let location = null;
  const locMatch = text.match(/\b([A-Z]{2})\b/);
  if (locMatch) {
    location = locMatch[1];
  }

  // Posted date extraction
  let postedAt = null;
  for (const pattern of FIELD_PATTERNS.postedDate) {
    const match = text.match(pattern);
    if (match) {
      postedAt = match[1];
      break;
    }
  }

  return { location, salary, postedAt, description: null };
}

/**
 * Format salary range into readable string
 */
function formatSalaryRange(salaryObj) {
  if (!salaryObj) return null;
  if (typeof salaryObj === 'string') return salaryObj;
  const { min, max, currency } = salaryObj;
  if (!min && !max) return null;
  const sym = currency === 'USD' || !currency ? '$' : currency;
  if (min && max) return `${sym}${min}k – ${sym}${max}k`;
  if (min) return `${sym}${min}k+`;
  if (max) return `${sym}${max}k`;
  return null;
}

/**
 * Run hard-stop regex checks
 */
function detectHardStops(text) {
  if (!text || typeof text !== 'string') return [];

  const stops = [];

  // Clearance checks
  for (const pattern of HARD_STOP_PATTERNS.clearance) {
    const match = text.match(pattern);
    if (match) {
      stops.push(`Security clearance: ${match[0]}`);
    }
  }

  // Experience floor checks
  for (const pattern of HARD_STOP_PATTERNS.experienceFloor) {
    const match = text.match(pattern);
    if (match) {
      const years = parseInt(match[1], 10);
      if (years >= EXPERIENCE_FLOOR_THRESHOLD) {
        stops.push(`Experience floor: ${match[0]}`);
      }
    }
  }

  return stops;
}

/**
 * Main export: extract fields and check for hard stops
 */
export async function extractJdFields(jdObject) {
  if (!jdObject || !jdObject.url) {
    return {
      ...jdObject,
      structured: { hardStop: false, hardStops: [] },
    };
  }

  const { url, title, text } = jdObject;

  // Attempt API-based extraction first
  let structured = await extractViaApi(url);

  // Fallback to regex extraction
  if (!structured) {
    structured = extractViaRegex(text);
  }

  // Run hard-stop checks
  const hardStops = detectHardStops(text);
  const hardStop = hardStops.length > 0;

  return {
    url,
    title,
    text,
    structured: {
      ...structured,
      hardStops,
      hardStop,
    },
  };
}

/**
 * CLI entrypoint for testing: node jd-field-extract.mjs <url> <title> <text>
 */
const isMainModule = process.argv[1] && process.argv[1].endsWith('jd-field-extract.mjs');
if (isMainModule) {
  const [, , url, title, text] = process.argv;
  if (!url) {
    console.error(JSON.stringify({ error: 'usage: jd-field-extract.mjs <url> <title> <text>' }));
    process.exit(1);
  }

  extractJdFields({ url, title: title || '', text: text || '' })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => {
      console.error(JSON.stringify({ error: err.message, stack: err.stack }));
      process.exit(1);
    });
}
