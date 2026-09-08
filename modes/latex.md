# Mode: latex — LaTeX/Overleaf CV Export

Export a tailored, ATS-optimized CV as a `.tex` file and compile it to PDF via `tectonic` or `pdflatex`.

## Pipeline

1. Read `cv.md` as source of truth
2. Read `config/profile.yml` for candidate identity and contact info
3. Ask the user for the JD if not already in context (text or URL)
4. Extract 15-20 keywords from the JD
5. Detect JD language → CV language (EN default)
6. Detect role archetype → adapt framing
7. Rewrite Professional Summary injecting JD keywords (same rules as `pdf` mode — NEVER invent skills)
8. Select top 3-4 most relevant projects for the offer, and populate `awards[]` from `cv.md`'s Awards / Honors section when it has entries that support the role (omit the key otherwise — the section is dropped, header included; never invent an award)
9. Reorder experience bullets by JD relevance
10. Inject keywords naturally into existing achievements
11. Build a JSON payload (see schema below) and write to `.tmp/cv-{candidate}-{company}.json`
12. Run: `node core/build-cv-latex.mjs .tmp/cv-{candidate}-{company}.json output/cv-{candidate}-{company}-{YYYY-MM-DD}.tex`
13. Run: `node core/generate-latex.mjs output/cv-{candidate}-{company}-{YYYY-MM-DD}.tex output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf`
    *(Replace `{candidate}`, `{company}`, `{YYYY-MM-DD}` with actual values.)*
14. **Verify JD-keyword coverage — measured, not estimated (2026-08-13):** `node core/verify-jd-coverage.mjs {jd-scratch-path} .tmp/cv-{candidate}-{company}.json --summary` (reuse the same JD scratch file Step 4's `jd-skill-gap.mjs` check already wrote — don't re-save it). Report the real percentage this prints, not a guess. If it flags `regressions` (a skill `cv.md` supports that didn't survive tailoring), consider adding one verbatim mention in a competency or bullet — never stack/repeat beyond that one occurrence (see the anti-keyword-stacking rule in `modes/pdf.md`). **If it flags a Competencies/Skills overlap (2026-09-03):** go back to Step 11 and rebuild the JSON payload per `modes/pdf.md` § "Core Competencies vs. Skills — no overlap" before compiling — fix-before-continue, same as any other verification failure.
15. Report: .tex path, .pdf path, file sizes, section count, keyword coverage % (from step 14, not self-estimated), and any Competencies/Skills overlap flagged

**Requires:** `tectonic` (preferred — `brew install tectonic`, auto-downloads packages) or `pdflatex` (MiKTeX / TeX Live) on PATH.

## Non-interactive invocation (for cycle Step-3 safety net)

Triggered by the `[HEADLESS]` marker (see AGENTS.md → "Headless Invocation Signal") being present in the received instructions, or by being invoked from within an already-running `cycle` Step 3 — not by guessing whether a live chat exists. When running non-interactively against an already-written report file (instead of a live user chat):

1. **Source the JD from the report, not from the user.** Read `reports/{num}-{slug}-{date}.md` (the target report already written by pipeline evaluation); its Blocks A/B/C already quote JD requirements, keywords, and role title verbatim. This is your ground truth — same source-of-truth discipline as everywhere in this system.
2. **Build the tailored JSON payload from the report + cv.md:**
   - Extract keywords from Block B and the Quick Fit section (already JD-aligned by the pipeline evaluator).
   - Reorder experience bullets by importance to *this specific report's* role (use Block A's CV-match assessment as your guide).
   - Select top 3-4 most relevant projects from `cv.md` (use Block A/B to decide relevance).
   - Build a competency grid (6-8 keywords) from Block B's North Star section, never inventing skills.
   - **Build `skills` from a different source than `competencies` (2026-09-03):** `competencies` is functional/thematic (see `modes/pdf.md` § "Core Competencies vs. Skills — no overlap"); `skills` is concrete tools/technologies/systems, grouped by category. When `cv.md` has one flat Skills line, don't split it across both fields — pull functional outcomes for `competencies` from Block B/Experience bullets, and reserve the flat Skills line's concrete nouns for `skills`. This step is easy to skip in a headless run because nothing upstream forces it — it was found missing live 2026-09-03 after a headless `cycle` run duplicated a candidate's entire flat Skills line across both sections on multiple reports.
3. **Write the payload to JSON** at `.tmp/cv-{candidate}-{company}.json` (fresh every time; never hardcode content as script literals).
4. **Compile to PDF:** exactly as Steps 12-13 above:
   - `node core/build-cv-latex.mjs .tmp/cv-{candidate}-{company}.json output/{num}-{company}-{YYYY-MM-DD}.tex`
   - `node core/generate-latex.mjs output/{num}-{company}-{YYYY-MM-DD}.tex output/{num}-{company}-{YYYY-MM-DD}.pdf`
5. **Verify — same as Step 14 above, never skipped for being headless:** `node core/verify-jd-coverage.mjs {jd-scratch-path} .tmp/cv-{candidate}-{company}.json --summary`. If it flags a Competencies/Skills overlap, rebuild the payload (step 2) and recompile (step 4) before treating this report's PDF as done — a `[HEADLESS]` invocation still has no one to catch the duplication later, so this is the only gate that will.

This ensures each report's PDF is truly tailored to its own evaluated role, not a hardcoded generic template.

## Language support

- **Localized section titles are fine.** The validator counts `\section{}` blocks instead of matching English titles, so a Spanish/French/German CV (e.g. `\section{Educación}`) validates normally.
- **CJK (Japanese / Chinese / Korean) is NOT supported on this path yet.** The template is a pdfLaTeX / Computer-Modern setup with no CJK font, so kana/kanji/hangul cannot render. `generate-latex.mjs` detects CJK characters and stops with guidance. For a Japanese CV, use `pdf` mode (HTML → PDF), which renders CJK via a `lang="ja"` font fallback.

## JSON Input Schema

Write a JSON file with this structure. `build-cv-latex.mjs` handles template merge and LaTeX escaping — no need to escape special characters yourself.

```json
{
  "name": "Jane Smith",
  "contact_line": "San Francisco, CA | +1 415 555 0100",
  "email": { "url": "jane@example.com", "display": "jane@example.com" },
  "linkedin": { "url": "https://linkedin.com/in/janesmith", "display": "linkedin.com/in/janesmith" },
  "github": { "url": "https://github.com/janesmith", "display": "github.com/janesmith" },
  "summary": "Personalized summary with JD keywords injected (honest vs cv.md).",
  "competencies": ["RAG Pipelines", "LLMOps", "Kubernetes & Docker"],
  "certifications": [
    { "title": "Certified Kubernetes Administrator", "org": "CNCF", "year": "2024" }
  ],
  "education": [
    {
      "institution": "University Name",
      "location": "City, State",
      "degree": "Bachelor of Science in Computer Science",
      "dates": "2018 - 2022",
      "coursework": ["Data Structures", "Algorithms", "Machine Learning"]
    }
  ],
  "experience": [
    {
      "company": "Company Name",
      "role": "Job Title",
      "location": "Remote",
      "dates": "June 2022 - Present",
      "bullets": [
        "Achievement bullet with JD keywords injected",
        "Another bullet with quantified impact"
      ]
    }
  ],
  "projects": [
    {
      "name": "Project Name",
      "context": "Tech stack summary for the project line",
      "dates": "",
      "bullets": [
        "What you built and what it does"
      ]
    }
  ],
  "awards": [
    { "title": "Gold Medal, International Olympiad in Informatics", "org": "IOI", "year": "2021" }
  ],
  "skills": [
    { "category": "Languages", "items": "Python, JavaScript, C++" },
    { "category": "Frameworks", "items": "FastAPI, React, PyTorch" }
  ]
}
```

### Field reference

| Field | Type | Source |
|-------|------|--------|
| `name` | string | `profile.yml → candidate.full_name` |
| `contact_line` | string | Phone / City, State / Visa — built from profile.yml |
| `email.url` | string | Email for `\href{mailto:...}` (sanitized via sanitizeUrl, not LaTeX-escaped) |
| `email.display` | string | Display text for the email link |
| `linkedin.url` | string | Full URL with scheme for `\href{}` (sanitized via sanitizeUrl, not LaTeX-escaped) |
| `linkedin.display` | string | Display text only (no scheme) |
| `github.url` | string | Full URL with scheme for `\href{}` (sanitized via sanitizeUrl, not LaTeX-escaped) |
| `github.display` | string | Display text only (no scheme) |
| `summary` | string | Optional — personalized summary with keywords. Omit or leave empty to drop the Professional Summary section entirely (no bare header left behind). |
| `competencies` | string[] | Optional — 6-8 keyword phrases, rendered as a 3-column bullet grid. Omit or leave empty to drop the Core Competencies section entirely. |
| `certifications[]` | object | Optional — `title`, `org` (optional), `year` (optional). Omit or leave empty to drop the Certifications section entirely. |
| `education[].institution` | string | From cv.md Education |
| `education[].location` | string | Institution location |
| `education[].degree` | string | Degree name |
| `education[].dates` | string | Date range |
| `education[].coursework` | string[] | Optional — generates a coursework line if present |
| `experience[].company` | string | From cv.md Experience |
| `experience[].role` | string | Job title |
| `experience[].location` | string | Work location |
| `experience[].dates` | string | Date range |
| `experience[].bullets` | string[] | Reordered and keyword-injected achievement bullets |
| `projects[].name` | string | From cv.md Projects |
| `projects[].context` | string | Tech stack — appears next to project name |
| `projects[].dates` | string | Date range (or empty) |
| `projects[].bullets` | string[] | Selected project achievements |
| `awards[].title` | string | Award name, from cv.md Awards / Honors |
| `awards[].org` | string | Optional — issuing body, rendered after the title |
| `awards[].year` | string | Optional — year, right-aligned |
| `skills[].category` | string | Skill category name (e.g. "Languages", "Frameworks") |
| `skills[].items` | string | Comma-separated skills in that category |

## LaTeX Escaping (handled by the script)

`build-cv-latex.mjs` automatically escapes all user-supplied text before insertion:

| Character | Escape |
|-----------|--------|
| `&` | `\&` |
| `%` | `\%` |
| `$` | `\$` |
| `#` | `\#` |
| `_` | `\_` |
| `{` | `\{` |
| `}` | `\}` |
| `~` | `\textasciitilde{}` |
| `^` | `\textasciicircum{}` |
| `\` | `\textbackslash{}` |
| `±` | `$\pm$` |
| `→` | `$\rightarrow$` |

**Exception:** URLs inside `\href{}` are NOT escaped by the LaTeX escaper, but `sanitizeUrl()` still validates the scheme (mailto/http/https) and removes dangerous characters to prevent injection.

## ATS Rules (same as pdf mode)

- Single-column layout (enforced by template)
- Standard section headers: Education, Work Experience, Personal Projects, Awards & Honors, Technical Skills
- Optional sections (Personal Projects, Education, Awards & Honors) are dropped entirely — header included — when their array is empty or absent
- UTF-8, machine-readable via `\pdfgentounicode=1`
- Keywords distributed: first bullet of each role, skills section
- No images, no graphics, no color in body text

## Keyword Injection Strategy

Same ethical rules as `modes/pdf.md`:
- NEVER add skills the candidate doesn't have
- Only reformulate existing experience using JD vocabulary
- Examples:
  - JD says "RAG pipelines" → reword "LLM workflows with retrieval" to "RAG pipeline design"
  - JD says "MLOps" → reword "observability, evals" to "MLOps and observability"
- **Never stack a keyword next to a phrase that already says the same thing** — e.g. "HR compliance verifications via HR compliance and regulatory verification" repeats the same concept three ways in one bullet. Replace the original wording with the JD term, don't add it alongside. See `modes/pdf.md`'s Keyword injection strategy section for the full failure examples and the per-bullet/whole-CV read-back check.
- **`competencies` and `skills` must never overlap** — same anti-stacking discipline, applied across sections instead of within one bullet. See `modes/pdf.md` § "Core Competencies vs. Skills — no overlap" for the full rule (this is a shared schema between the HTML and LaTeX renderers, so the rule applies identically here). Step 14's `verify-jd-coverage.mjs` check below flags a violation automatically — treat it as a fix-before-continue, not an optional cleanup.

## Overleaf Compatibility

The generated `.tex` file uses only standard CTAN packages (no custom or bundled dependencies):

- `latexsym`, `fullpage`, `titlesec`, `marvosym`, `color`, `verbatim`, `enumitem`
- `hyperref`, `fancyhdr`, `babel`, `tabularx`, `fontawesome5`, `multicol`, `glyphtounicode`

Upload the `.tex` file directly to Overleaf — compiles with no extra configuration.
