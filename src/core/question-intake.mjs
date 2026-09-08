/**
 * Validation and normalization for admin-authored questions - pure, no I/O.
 *
 * One code path serves both intake routes: the single "Add question" form and
 * the bulk spreadsheet import. That is deliberate - if the two validated
 * differently, an import could smuggle in a question the form would reject,
 * and the bank would hold rows the generator cannot use.
 *
 * The published bank (src/content/rsa-question-bank.mjs) is generated content
 * and never written to. Admin-authored questions live in the `bank_questions`
 * store table and are merged over the published set at read time, so an
 * import can never corrupt the shipped catalogue.
 */

// The duplicate check below and the serving-side allocator must agree on what
// "the same question" means: this module used to keep its own copy of the key
// function, which normalized dash and quote variants differently, so a prompt
// could pass the import check and then be silently merged (never served) by
// `uniqueBy`. Both now import the single rule from core/prompt-key.mjs.
import { promptKey } from './prompt-key.mjs';

export { promptKey };

/** Answer modes the generator understands. */
export const QUESTION_MODES = ['objective', 'open'];

/** Column aliases: what a human might title the column -> canonical field. */
const FIELD_ALIASES = {
  module: ['module', 'module_id', 'module_key', 'module_code'],
  family: ['family', 'question_family', 'family_name', 'sub_family'],
  family_id: ['family_id', 'familyid'],
  type: ['type', 'question_type', 'answer_type', 'kind'],
  prompt: ['prompt', 'question', 'question_text', 'stem', 'text', 'original_ecod_question'],
  correct: ['correct', 'correct_answer', 'answer', 'correct_option', 'key', 'answer_key'],
  rubric: ['rubric', 'expected_evidence', 'expected_evidence_ecod_designed', 'model_answer', 'guidance', 'evidence'],
  rationale: ['rationale', 'explanation', 'why', 'reason'],
  difficulty: ['difficulty', 'difficulty_1_5', 'level'],
  band: ['band', 'difficulty_band', 'seniority', 'grade'],
  minutes: ['minutes', 'suggested_minutes', 'time', 'duration', 'time_minutes'],
  tags: ['tags', 'tag', 'labels', 'keywords'],
  gap_tag: ['gap_tag', 'gap-tag'],
  probes: ['probes', 'follow_up_probes', 'follow_ups', 'followups', 'probing_questions'],
  red_flags: ['red_flags', 'redflags', 'warning_signs'],
  enrichment: ['enrichment', 'enrichment_prescription', 'development', 'learning'],
  mode: ['mode', 'assessment_mode', 'delivery', 'delivery_mode'],
  status: ['status', 'question_status'],
  randomizable: ['randomizable', 'randomization_eligible'],
};

/** Option columns: "Option A" / "A" / "option_1" all map to one option slot. */
const OPTION_PATTERNS = [
  /^option_?([a-h])$/, /^([a-h])$/, /^option_?(\d)$/, /^opt_?([a-h1-8])$/,
  /^choice_?([a-h1-8])$/, /^answer_?([a-h1-8])$/,
];

const LETTERS = 'abcdefgh';
const OPTION_MARKER = /\n\s*(?:[•▪●*·-]\s*)?([A-H])[.)]\s*/g;

/**
 * Some worksheet exports embed an objective question's answer options inside
 * the prompt cell rather than in separate Option A/B/C/D columns:
 *
 *   "Which response is most defensible?\n• A) ...\n• B) ...\n• C) ..."
 *
 * The published Question Bank workbook uses exactly this shape (see
 * scripts/extract-question-bank-from-xlsx.mjs). Return the stem and the parsed
 * options; anything that does not look like an objective marker is left alone
 * so an open question can never be silently split.
 */
export function splitEmbeddedOptions(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const markers = [...src.matchAll(OPTION_MARKER)];
  if (markers.length < 2) return { prompt: src.trim(), options: [] };

  const prompt = src.slice(0, markers[0].index).replace(/\s+$/, '').trim();
  const options = markers.map((m, i) => {
    const letter = m[1];
    const start = m.index + m[0].length;
    const end = markers[i + 1]?.index ?? src.length;
    return { id: letter.toLowerCase(), label: src.slice(start, end).trim() };
  });
  return { prompt, options };
}

/** Parse "Correct answer: A" (or "Correct answer is A") from a cell. */
export function correctFromCell(text) {
  const hit = /Correct answer\s*(?:is|:|=|\u2014|--)?\s*([A-H])/i.exec(String(text ?? ''));
  return hit ? hit[1].toLowerCase() : null;
}

/** Map a spreadsheet row (already header-normalized) onto canonical fields. */
export function canonicalizeRow(row = {}) {
  const out = { options: [] };
  const seen = new Set();

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const value = row[alias];
      // A structured value is never text. `String({a:1})` is the literal
      // "[object Object]", which used to be stored as a prompt (and every such
      // row then looked identical to the duplicate check and the dedupe). Leave
      // the field unset so the required/length rules report it properly.
      if (value === undefined || value === null || typeof value === 'object') {
        // ...except a form's tags/probes list: an open-question form post has
        // no `options` array, so it is canonicalized as a sheet row, and its
        // list would otherwise be silently dropped. (Spreadsheets never
        // produce arrays, so this branch only ever fires for form posts.)
        if ((field === 'tags' || field === 'probes') && Array.isArray(value)
            && value.every((x) => x === undefined || x === null || typeof x === 'string' || typeof x === 'number')) {
          out[field] = value.filter((x) => x !== undefined && x !== null)
            .map((x) => String(x).trim()).filter(Boolean).join('\n');
          seen.add(alias);
          break;
        }
        continue;
      }
      if (String(value).trim() === '') continue;
      out[field] = String(value).trim();
      seen.add(alias);
      break;
    }
  }

  // Option columns, kept in slot order so "Correct = B" means the second one.
  const slots = new Map();
  for (const [key, value] of Object.entries(row)) {
    if (seen.has(key)) continue;
    for (const pattern of OPTION_PATTERNS) {
      const m = pattern.exec(key);
      if (!m) continue;
      const token = m[1].toLowerCase();
      const index = /\d/.test(token) ? Number(token) - 1 : LETTERS.indexOf(token);
      if (index >= 0 && String(value ?? '').trim()) slots.set(index, String(value).trim());
      break;
    }
  }
  out.options = [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([index, label]) => ({
    id: LETTERS[index] || String(index + 1),
    label,
  }));

  // The published Question Bank export stores options inline in the prompt
  // cell ("• A) ..."). If no option columns were used, recover them from the
  // prompt so a CSV exported from that workbook imports without reformatting.
  if (!out.options.length && out.prompt) {
    const embedded = splitEmbeddedOptions(out.prompt);
    if (embedded.options.length >= 2) {
      out.prompt = embedded.prompt;
      out.options = embedded.options;
    }
  }
  return out;
}

/**
 * Options are the only nested structure a question carries, and they arrive from
 * three directions: the admin form (JSON), a CSV grid, and the workbook
 * extraction script. So an entry may legitimately be null, a bare string, a
 * number, or an object whose label is numeric — and every consumer below assumes
 * `{ id, label }` with string values. Normalize once here rather than defending
 * at each use site (an unguarded `o.label.trim()` used to 500 the endpoint).
 */
export function sanitizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    // A structured id or label is dropped, not stringified: `String({…})`
    // would store the literal "[object Object]" as a served answer choice.
    // Numbers survive (a form can post `{id: 1}`), matching the legacy bank's
    // cleanOptions rule.
    if (!isScalar(o.id) || !isScalar(o.label)) continue;
    const label = String(o.label ?? '').trim();
    if (!label) continue;
    out.push({ id: String(o.id ?? '').trim(), label });
  }
  return out;
}

/** Plain scalar (or absent) — the only thing a text field may carry. */
function isScalar(v) {
  return v === undefined || v === null || typeof v === 'string' || typeof v === 'number';
}

/** `tags`/`probes` accept a delimited string or a list of plain scalars. */
function isStringList(v) {
  return typeof v === 'string'
    || (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'));
}

/** "B", "b", "2", "Option B", "b,c" -> ['b'] / ['b','c'] */
export function parseCorrect(raw, options = []) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const opts = sanitizeOptions(options);
  const byLabel = new Map(opts.map((o) => [o.label.toLowerCase(), o.id]));
  const ids = new Set(opts.map((o) => o.id));

  const picked = [];
  for (const token of text.split(/[,;/|]+|\s+and\s+/i)) {
    const t = token.trim().toLowerCase().replace(/^option\s*/, '').replace(/[.)]$/, '');
    if (!t) continue;
    if (ids.has(t)) { picked.push(t); continue; }
    if (/^\d+$/.test(t)) {
      const id = LETTERS[Number(t) - 1];
      if (ids.has(id)) picked.push(id);
      continue;
    }
    // Fall back to matching the answer text itself.
    const byText = byLabel.get(t) || byLabel.get(token.trim().toLowerCase());
    if (byText) picked.push(byText);
  }
  return [...new Set(picked)];
}

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const splitList = (value) => String(Array.isArray(value)
  // A form posts tags/probes as a real list; join with newlines (not commas)
  // so an element that itself contains a comma survives as one entry.
  ? value.filter((x) => x !== undefined && x !== null).map((x) => String(x).trim()).filter(Boolean).join('\n')
  : (value ?? ''))
  .split(/[\n;|]+|,(?![^(]*\))/) 
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Validate and normalize one question against the module/family taxonomy.
 *
 *   validateQuestion(input, { modules, families })
 *
 * Returns { ok: true, question } or { ok: false, errors: string[] }.
 * `modules` and `families` come from the published bank, so a question can
 * only ever be filed under a real module, and a family id is always rebuilt
 * as `<MODULE>:<slug>` - never trusted from the spreadsheet.
 */
export function validateQuestion(input = {}, { modules = [], families = [] } = {}) {
  const errors = [];
  // A form posts a canonical object (options already an array); a spreadsheet
  // row arrives flat, with option columns and aliased headers. Detect the
  // former by its structured `options`, and canonicalize everything else —
  // testing for `prompt` alone would misclassify a sheet row, which also has
  // one, and silently drop its options.
  const row = Array.isArray(input.options) ? input : canonicalizeRow(input);

  // ---- module ----------------------------------------------------------
  const moduleKey = String(row.module ?? '').trim().toUpperCase();
  const mod = modules.find((m) => m.key === moduleKey);
  if (!moduleKey) errors.push('Module is required.');
  else if (!mod) errors.push(`Unknown module "${moduleKey}".`);

  // ---- answer mode -----------------------------------------------------
  let type = String(row.type ?? '').trim().toLowerCase();
  if (['mcq', 'mcq_single', 'multiple choice', 'multiple_choice', 'objective', 'objective question'].includes(type)) type = 'objective';
  else if ([
    'open', 'text', 'open-ended', 'open_ended', 'non-objective', 'non_objective', 'scenario',
    'customer simulation', 'common question', 'architecture case', 'concept', 'deep dive',
    'incident', 'practical', 'migration', 'experience probe', 'discovery', 'communication',
  ].includes(type)) type = 'open';
  else if (!type) {
    // Infer from shape rather than rejecting: a row with options is objective.
    type = sanitizeOptions(row.options).length >= 2 ? 'objective' : 'open';
  }
  if (!QUESTION_MODES.includes(type)) errors.push(`Type must be "objective" or "open" (got "${row.type}").`);

  // ---- structured scalars ----------------------------------------------
  // Checked on the raw request, before canonicalization: a structured value is
  // a type error, not something to stringify and store (or silently drop, as
  // canonicalizeRow does for sheet rows — a form post naming no family should
  // hear about it rather than land in General). Lists stay lists: tags/probes
  // accept a delimited string or an array of plain scalars.
  const SCALAR_FIELDS = [
    ['module', 'Module'], ['family', 'Family'], ['family_id', 'Family id'], ['type', 'Type'],
    ['prompt', 'Prompt'], ['correct', 'Correct answer'], ['rubric', 'Rubric'],
    ['rationale', 'Rationale'], ['difficulty', 'Difficulty'], ['band', 'Band'],
    ['minutes', 'Minutes'], ['gap_tag', 'Gap tag'], ['red_flags', 'Red flags'],
    ['enrichment', 'Enrichment'], ['mode', 'Mode'],
  ];
  for (const [field, label] of SCALAR_FIELDS) {
    const v = input[field];
    if (v !== undefined && v !== null && !isScalar(v)) errors.push(`${label} must be plain text.`);
  }
  for (const [field, label] of [['tags', 'Tags'], ['probes', 'Probes']]) {
    const v = input[field];
    if (v !== undefined && v !== null && !isStringList(v)) errors.push(`${label} must be plain text.`);
  }

  // ---- prompt ----------------------------------------------------------
  const prompt = String(row.prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!prompt) errors.push('Prompt is required.');
  else if (prompt.length < 15) errors.push('Prompt is too short to be a real question.');
  else if (prompt.length > 2000) errors.push('Prompt is longer than 2000 characters.');

  // ---- family ----------------------------------------------------------
  // Scoped to the module: a family name alone is ambiguous because the same
  // name recurs across modules.
  const familyName = String(row.family ?? '').trim();
  let family = null;
  if (mod) {
    if (row.family_id) {
      family = families.find((f) => f.id === String(row.family_id).trim() && f.module === mod.key) || null;
      if (!family) errors.push(`Family "${row.family_id}" does not exist in module ${mod.key}.`);
    } else if (familyName) {
      const wanted = slug(familyName);
      family = families.find((f) => f.module === mod.key && (f.key === wanted || f.name.toLowerCase() === familyName.toLowerCase())) || null;
      // An unrecognized family name is not an error: it creates a new family
      // inside the module, which is how the taxonomy is meant to grow.
    }
  }

  // ---- type-specific ---------------------------------------------------
  const options = sanitizeOptions(row.options);
  let correct = [];
  let rubric = String(row.rubric ?? '').trim();

  if (type === 'objective') {
    if (options.length < 2) errors.push('An objective question needs at least two options.');
    if (options.length > 8) errors.push('An objective question cannot have more than eight options.');
    const labels = options.map((o) => o.label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) errors.push('Options must be distinct.');
    correct = Array.isArray(row.correct_option_ids) && row.correct_option_ids.length
      ? row.correct_option_ids.map((id) => String(id).toLowerCase())
      : parseCorrect(row.correct, options);
    if (!correct.length) {
      // The published workbook records the key in the probe/evidence cell
      // ("Correct answer: A; ...") rather than in a Correct column.
      const fromCell = correctFromCell(row.probes || row.rationale || row.rubric);
      if (fromCell && options.some((o) => o.id === fromCell)) correct.push(fromCell);
    }
    if (!correct.length) errors.push('A correct answer is required (e.g. "B").');
    else if (correct.some((id) => !options.some((o) => o.id === id))) {
      errors.push('The correct answer must be one of the options.');
    } else if (correct.length > 1) {
      errors.push('Exactly one correct answer is supported.');
    }
  } else if (type === 'open') {
    if (options.length) errors.push('An open question must not carry answer options.');
    if (!rubric) errors.push('An open question needs a rubric (expected evidence) for the assessor.');
    else if (rubric.length > 4000) rubric = rubric.slice(0, 4000);
  }

  if (errors.length) return { ok: false, errors };

  const familyKey = family ? family.key : (familyName ? slug(familyName) : 'general');
  const resolvedName = family ? family.name : (familyName || 'General');

  return {
    ok: true,
    question: {
      module: mod.key,
      family_id: `${mod.key}:${familyKey}`,
      family: resolvedName,
      type,
      prompt,
      difficulty: clampInt(row.difficulty, 1, 5, 4),
      band: /adv/i.test(row.band || '') ? 'Advanced'
        : /found|basic/i.test(row.band || '') ? 'Foundation' : 'Intermediate',
      mode: String(row.mode ?? '').trim() || 'Online assessment',
      minutes: clampInt(row.minutes, 1, 120, type === 'open' ? 5 : 2),
      status: 'Active',
      randomizable: !/^(no|false|0)$/i.test(String(row.randomizable ?? '').trim()),
      tags: splitList(row.tags).slice(0, 12),
      gap_tag: String(row.gap_tag ?? '').trim() || splitList(row.tags)[0] || resolvedName,
      red_flags: String(row.red_flags ?? '').trim().slice(0, 2000),
      enrichment: String(row.enrichment ?? '').trim().slice(0, 2000),
      ...(type === 'objective'
        ? {
            options,
            correct_option_ids: correct,
            rationale: String(row.rationale || row.probes || '').trim().slice(0, 2000),
            needs_option_review: options.length < 4,
          }
        : {
            probes: splitList(row.probes).slice(0, 8),
            rubric,
          }),
    },
  };
}

export const slug = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

/**
 * Validate a batch, reporting per-row outcomes rather than failing the whole
 * import on one bad row - an admin importing 200 questions needs to know
 * exactly which lines to fix, and the good rows should still land.
 *
 * Duplicate prompts are rejected against both the existing bank and earlier
 * rows in the same file, so re-importing a sheet is idempotent.
 */
export function validateBatch(rows = [], { modules = [], families = [], existingPrompts = [] } = {}) {
  const seen = new Set(existingPrompts.map(promptKey));
  const accepted = [];
  const rejected = [];
  const duplicates = [];

  rows.forEach((raw, index) => {
    const line = index + 2;      // +1 for 0-based, +1 for the header row
    const result = validateQuestion(raw, { modules, families });
    if (!result.ok) {
      rejected.push({ line, errors: result.errors, prompt: String(raw.prompt ?? raw.question ?? '').slice(0, 120) });
      return;
    }
    const key = promptKey(result.question.prompt);
    if (seen.has(key)) {
      duplicates.push({ line, prompt: result.question.prompt.slice(0, 120) });
      return;
    }
    seen.add(key);
    accepted.push({ line, question: result.question });
  });

  return { accepted, rejected, duplicates };
}
