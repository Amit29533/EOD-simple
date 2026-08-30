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

/** Answer modes the generator understands. */
export const QUESTION_MODES = ['objective', 'open'];

/** Column aliases: what a human might title the column -> canonical field. */
const FIELD_ALIASES = {
  module: ['module', 'module_id', 'module_key', 'module_code'],
  family: ['family', 'question_family', 'family_name', 'sub_family'],
  family_id: ['family_id', 'familyid'],
  type: ['type', 'question_type', 'answer_type', 'kind'],
  prompt: ['prompt', 'question', 'question_text', 'stem', 'text'],
  correct: ['correct', 'correct_answer', 'answer', 'correct_option', 'key'],
  rubric: ['rubric', 'expected_evidence', 'model_answer', 'guidance', 'evidence'],
  rationale: ['rationale', 'explanation', 'why', 'reason'],
  difficulty: ['difficulty', 'level'],
  band: ['band', 'seniority', 'grade'],
  minutes: ['minutes', 'time', 'duration', 'time_minutes'],
  tags: ['tags', 'tag', 'labels', 'keywords', 'gap_tag'],
  probes: ['probes', 'follow_ups', 'followups', 'probing_questions'],
  red_flags: ['red_flags', 'redflags', 'warning_signs'],
  enrichment: ['enrichment', 'development', 'learning'],
  mode: ['mode', 'delivery', 'delivery_mode'],
};

/** Option columns: "Option A" / "A" / "option_1" all map to one option slot. */
const OPTION_PATTERNS = [
  /^option_?([a-h])$/, /^([a-h])$/, /^option_?(\d)$/, /^opt_?([a-h1-8])$/,
  /^choice_?([a-h1-8])$/, /^answer_?([a-h1-8])$/,
];

const LETTERS = 'abcdefgh';

/** Map a spreadsheet row (already header-normalized) onto canonical fields. */
export function canonicalizeRow(row = {}) {
  const out = { options: [] };
  const seen = new Set();

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (row[alias] !== undefined && String(row[alias]).trim() !== '') {
        out[field] = String(row[alias]).trim();
        seen.add(alias);
        break;
      }
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
  return out;
}

/** "B", "b", "2", "Option B", "b,c" -> ['b'] / ['b','c'] */
export function parseCorrect(raw, options = []) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const byLabel = new Map(options.map((o) => [o.label.toLowerCase(), o.id]));
  const ids = new Set(options.map((o) => o.id));

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

const splitList = (value) => String(value ?? '')
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
  if (['mcq', 'mcq_single', 'multiple choice', 'multiple_choice', 'objective'].includes(type)) type = 'objective';
  else if (['open', 'text', 'open-ended', 'open_ended', 'non-objective', 'non_objective', 'scenario'].includes(type)) type = 'open';
  else if (!type) {
    // Infer from shape rather than rejecting: a row with options is objective.
    type = (row.options || []).length >= 2 ? 'objective' : 'open';
  }
  if (!QUESTION_MODES.includes(type)) errors.push(`Type must be "objective" or "open" (got "${row.type}").`);

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
  const options = (row.options || []).filter((o) => String(o.label ?? '').trim());
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
      randomizable: true,
      tags: splitList(row.tags).slice(0, 12),
      gap_tag: splitList(row.tags)[0] || resolvedName,
      red_flags: String(row.red_flags ?? '').trim().slice(0, 2000),
      enrichment: String(row.enrichment ?? '').trim().slice(0, 2000),
      ...(type === 'objective'
        ? {
            options,
            correct_option_ids: correct,
            rationale: String(row.rationale ?? '').trim().slice(0, 2000),
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

/** Comparison key for duplicate detection: typography-insensitive. */
export function promptKey(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
