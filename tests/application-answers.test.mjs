import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatApplicationAnswersSection } from '../core/application-answers.mjs';

// ── resume/CV file-entry guard (2026-09-11 fix) ──
//
// Report #023 (HD Supply) went out with "Resume/CV: Not recorded" in its
// Files-used section because a missing path silently rendered as a
// placeholder instead of failing the write. A resume/CV entry always has a
// real filename to record per apply.md Step 7b — this must throw, not degrade.

test('formatApplicationAnswersSection throws when a Resume/CV file entry has no path', () => {
  assert.throws(
    () => formatApplicationAnswersSection({ files: [{ label: 'Resume/CV' }] }),
    /Resume\/CV.*no path/,
  );
});

test('formatApplicationAnswersSection throws for a "CV" label with no path (case-insensitive, no slash needed)', () => {
  assert.throws(
    () => formatApplicationAnswersSection({ files: [{ field: 'cv upload' }] }),
    /cv upload/,
  );
});

test('formatApplicationAnswersSection does NOT throw when the Resume/CV entry has a real path', () => {
  const section = formatApplicationAnswersSection({
    files: [{ label: 'Resume/CV', path: 'Thomas Acosta - HD Supply.pdf' }],
  });
  assert.match(section, /Thomas Acosta - HD Supply\.pdf/);
});

test('formatApplicationAnswersSection throws for an accented "Résumé" label with no path (diacritics must not evade the guard)', () => {
  assert.throws(
    () => formatApplicationAnswersSection({ files: [{ label: 'Résumé' }] }),
    /Résumé.*no path/,
  );
});

test('formatApplicationAnswersSection still writes "Not recorded" for a non-resume file entry with no path (unaffected)', () => {
  const section = formatApplicationAnswersSection({
    files: [{ label: 'Portfolio link' }],
  });
  assert.match(section, /Portfolio link:\*\* Not recorded/);
});

test('formatApplicationAnswersSection with no files at all still renders "None captured" (unaffected)', () => {
  const section = formatApplicationAnswersSection({});
  assert.match(section, /### Files used\n\n- None captured\./);
});
