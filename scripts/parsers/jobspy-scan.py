#!/usr/bin/env python3
"""career-ops local parser wrapping python-jobspy (github.com/speedyapply/JobSpy).

Invoked by providers/local-parser.mjs (scan.mjs Level 0) as:
    python scripts/parsers/jobspy-scan.py --sites indeed,glassdoor,google,zip_recruiter,linkedin \
        --search-term "HRIS Analyst" --location "United States" --results-wanted 40

Contract (see providers/local-parser.mjs normalizeParserJob): print a single
JSON array to stdout, one object per posting, with at least `title` and a URL
field (`url`). Everything else (title_filter, location_filter, dedup, etc.) is
handled by scan.mjs downstream -- this script's only job is to fetch and shape
the data. Never print anything else to stdout; diagnostics go to stderr so
they don't corrupt the JSON scan.mjs parses.
"""
import argparse
import json
import math
import sys

# Windows spawns this script with no console attached (scan.mjs uses execFile,
# not a shell/PTY), so Python falls back to the system codepage (cp1252) for
# stdout/stderr instead of UTF-8. Job titles/company names routinely contain
# non-cp1252 characters (curly quotes, non-Latin scripts, macrons, etc.), and
# without this reconfigure the print() below crashes with UnicodeEncodeError
# and the whole scrape's results are lost. Python 3.7+.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def parse_args():
    p = argparse.ArgumentParser(description="JobSpy -> career-ops local-parser JSON bridge")
    p.add_argument("--sites", default="indeed,glassdoor,google,zip_recruiter",
                    help="Comma-separated JobSpy site_name values (indeed,linkedin,glassdoor,google,zip_recruiter,bayt,naukri,bdjobs)")
    p.add_argument("--search-term", required=True, help="Free-text search term passed to each site")
    p.add_argument("--google-search-term", default=None,
                    help="Google Jobs wants a more natural-language query; defaults to --search-term")
    p.add_argument("--location", default="United States")
    p.add_argument("--results-wanted", type=int, default=40, help="Per-site result cap")
    p.add_argument("--hours-old", type=int, default=None, help="Optional freshness window in hours")
    p.add_argument("--country-indeed", default="USA")
    return p.parse_args()


def clean(value):
    """NaN/None -> '', everything else -> str."""
    if value is None:
        return ""
    try:
        if isinstance(value, float) and math.isnan(value):
            return ""
    except TypeError:
        pass
    return str(value).strip()


def row_to_job(row):
    location_parts = [clean(row.get("city")), clean(row.get("state")), clean(row.get("country"))]
    location = ", ".join(p for p in location_parts if p) or clean(row.get("location"))
    if str(row.get("is_remote", "")).strip().lower() == "true" and "remote" not in location.lower():
        location = (location + " (Remote)").strip()

    job = {
        "title": clean(row.get("title")),
        "url": clean(row.get("job_url") or row.get("job_url_direct")),
        "company": clean(row.get("company")),
        "location": location,
    }
    posted = clean(row.get("date_posted"))
    if posted:
        job["postedAt"] = posted
    site = clean(row.get("site"))
    if site:
        job["_site"] = site
    return job


def main():
    args = parse_args()
    sites = [s.strip() for s in args.sites.split(",") if s.strip()]

    try:
        from jobspy import scrape_jobs
    except ImportError as exc:
        eprint(f"jobspy-scan: python-jobspy is not installed ({exc}). Run: python -m pip install -U python-jobspy")
        sys.exit(1)

    try:
        df = scrape_jobs(
            site_name=sites,
            search_term=args.search_term,
            google_search_term=args.google_search_term or args.search_term,
            location=args.location,
            results_wanted=args.results_wanted,
            hours_old=args.hours_old,
            country_indeed=args.country_indeed,
        )
    except Exception as exc:  # noqa: BLE001 - surface any scrape failure to stderr, exit non-zero
        eprint(f"jobspy-scan: scrape_jobs failed: {exc}")
        sys.exit(1)

    if df is None or len(df) == 0:
        print("[]")
        return

    jobs = [row_to_job(row) for _, row in df.iterrows()]
    jobs = [j for j in jobs if j["title"] and j["url"]]

    print(json.dumps(jobs, ensure_ascii=False))
    eprint(f"jobspy-scan: {len(jobs)} job(s) from {len(sites)} site(s) ({', '.join(sites)}) for '{args.search_term}' @ '{args.location}'")


if __name__ == "__main__":
    main()
