import { state } from '../../app.js';

/** Shared by the admin screens: metadata access and small utilities. */
export const M = () => state.meta;
// Kept as a fallback for cached/static bootstrap payloads from before the
// allocation cap was published. The API is the source of truth when available.
const FALLBACK_MAX_ASSESSMENT_QUESTIONS = 50;
export const maxAssessmentQuestions = () => Math.max(
  1,
  Number(M()?.maxAssessmentQuestions) || FALLBACK_MAX_ASSESSMENT_QUESTIONS,
);

export function refresh() {
  const evt = new HashChangeEvent('hashchange');
  window.dispatchEvent(evt);
}
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ==================== Question bank: modules & families ==================== */
/**
 * MODULE -> FAMILY view of the finalized question bank, plus the fixed shape of
 * a generated paper.
 *
 * Modules are the top level; each expands to the families inside it. A family
 * is the unit a new question is added to, and because a family name repeats
 * across modules ("Advanced Technical Judgment" is in all ten technical ones)
 * every family is addressed by its module-scoped id, `<MODULE>:<slug>`.
 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.onload = () => {
      const out = String(reader.result || '');
      resolve(out.slice(out.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * One CSV cell: quoted, inner quotes doubled, and a leading formula trigger
 * (`=`, `+`, `-`, `@`, tab, CR) neutralised with an apostrophe. The values in
 * the credentials sheet come from an uploaded spreadsheet — a name cell of
 * `=HYPERLINK(...)` or `=cmd|' /C ...'!A0` used to be written verbatim and
 * evaluated by Excel/LibreOffice on the admin's machine when they opened the
 * download. A prefixed cell reads as literal text; the apostrophe is visible
 * but nothing is lost, whereas the spreadsheet would otherwise show `#NAME?`.
 */
export function csvCell(v) {
  let text = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Save text to the user's machine without a server round-trip. */
export function downloadText(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
