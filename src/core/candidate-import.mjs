/**
 * Bulk candidate + portal-user import from a spreadsheet.
 *
 * One validation path serves both the dry run and the commit, so the report
 * an admin sees is exactly what gets written. Each row becomes a candidate
 * record and — when `create_users` is on — a linked `candidate`-role portal
 * user. Usernames given in the sheet are used verbatim (when valid), blank
 * ones are derived from the email/name and made collision-free
 * deterministically; passwords in the sheet are used as-is, blank ones are
 * generated so the admin can hand credentials out. Plaintext passwords are
 * returned exactly once, in the commit response — they are never retrievable
 * afterwards (only the scrypt hash is stored).
 */

import { randomBytes } from 'node:crypto';

/** Printable alphabet for generated passwords (no 0/O/1/l lookalikes). */
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The columns the import understands, in the order the template lists them. */
export const CANDIDATE_IMPORT_COLUMNS = [
  { key: 'Name', required: true, note: 'Full name of the candidate' },
  { key: 'Email', required: false, note: 'Also used to derive a blank username' },
  { key: 'Phone', required: false, note: '' },
  { key: 'Current title', required: false, note: '' },
  { key: 'Years of experience', required: false, note: '0-50' },
  { key: 'Location', required: false, note: '' },
  { key: 'Source', required: false, note: 'Referral, partner, inbound…' },
  { key: 'Target role', required: false, note: 'Name, key or id of an assessment track' },
  { key: 'Pipeline stage', required: false, note: 'e.g. Intake, Role Mapping, Assessment' },
  { key: 'Username', required: false, note: 'Portal login; generated when blank' },
  { key: 'Password', required: false, note: 'Portal login; generated when blank' },
  { key: 'Notes', required: false, note: 'Internal, admin-only' },
];

/** Header aliases: what a human might title the column -> canonical field. */
const FIELD_ALIASES = {
  name: ['name', 'full_name', 'candidate_name', 'fullname', 'candidate'],
  email: ['email', 'email_address', 'mail'],
  phone: ['phone', 'mobile', 'phone_number', 'contact_number'],
  current_title: ['current_title', 'title', 'job_title', 'designation'],
  years_experience: ['years_experience', 'years_of_experience', 'experience_years', 'years', 'yoe'],
  location: ['location', 'city', 'base_location'],
  source: ['source', 'referral_source', 'origin'],
  target_role: ['target_role', 'role', 'role_name', 'track', 'assessment_track', 'target_role_name'],
  stage: ['stage', 'pipeline_stage', 'pipeline_stage_key'],
  username: ['username', 'user_name', 'login', 'user_id'],
  password: ['password', 'portal_password', 'initial_password'],
  notes: ['notes', 'internal_notes', 'note', 'comments'],
};

/** Map a spreadsheet row (already header-normalized) onto canonical fields. */
export function canonicalizeCandidateRow(row = {}) {
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (row[alias] !== undefined && String(row[alias]).trim() !== '') {
        out[field] = String(row[alias]).trim();
        break;
      }
    }
  }
  return out;
}

/**
 * Resolve a collision-free username from an explicit value or the row's
 * email/name. Deterministic given the same `used` set, so the dry-run preview
 * and the commit always agree on the logins that will be created.
 */
export function resolveUsername({ email = '', name = '' } = {}, used = new Set()) {
  const source = String(email || '').split('@')[0] || String(name || '');
  let base = source
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 40);
  if (base.length < 3) base = 'candidate';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  for (;;) {
    const suffix = String(n);
    const next = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!used.has(next)) {
      used.add(next);
      return next;
    }
    n += 1;
  }
}

/** A fresh, home-typing-friendly password (always 15+ chars, mixed case + digits). */
export function generatePassword() {
  const bytes = randomBytes(12);
  let body = '';
  for (let i = 0; i < bytes.length; i += 1) {
    body += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return `Ecod-${body}`;
}

/**
 * Validate one spreadsheet row.
 *
 * `ctx` carries the taxonomies and collision sets:
 *   roles, stages, createUsers, existingCandidates, existingUsernames,
 *   usedUsernames, seenEmails, seenNames
 *
 * Returns { ok, duplicate, errors, candidate }. `candidate` is the normalized
 * record (including `username`/`password` when a portal user is wanted); a
 * duplicate row carries the reason but nothing is written.
 */
export function validateCandidateRow(raw = {}, ctx = {}) {
  const row = canonicalizeCandidateRow(raw);
  const errors = [];
  const candidate = {};

  candidate.name = String(row.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!candidate.name) errors.push('Name is required.');

  candidate.email = String(row.email ?? '').trim().slice(0, 200);
  candidate.phone = String(row.phone ?? '').trim().slice(0, 60);
  candidate.current_title = String(row.current_title ?? '').trim().slice(0, 120);
  candidate.location = String(row.location ?? '').trim().slice(0, 120);
  candidate.source = String(row.source ?? '').trim().slice(0, 120);
  candidate.notes = String(row.notes ?? '').trim().slice(0, 4000);

  const years = String(row.years_experience ?? '').trim();
  if (years) {
    const n = Number(years);
    if (!Number.isFinite(n) || n < 0 || n > 50) {
      errors.push('Years of experience must be a number between 0 and 50.');
    } else {
      candidate.years_experience = n;
    }
  }

  const roleRaw = String(row.target_role ?? '').trim();
  if (roleRaw) {
    const role = (ctx.roles || []).find((r) =>
      [r.id, r.key, r.name].some((v) => String(v ?? '').toLowerCase() === roleRaw.toLowerCase()));
    if (!role) errors.push(`Unknown target role "${roleRaw}".`);
    else {
      candidate.target_role_id = role.id;
      candidate.target_role = role.name; // display name for the preview
    }
  }

  const stageRaw = String(row.stage ?? '').trim();
  if (stageRaw) {
    const hit = (ctx.stages || []).find((s) =>
      s.key.toLowerCase() === stageRaw.toLowerCase() || s.label.toLowerCase() === stageRaw.toLowerCase());
    if (!hit) errors.push(`Unknown pipeline stage "${stageRaw}".`);
    else candidate.stage = hit.key;
  }

  let username = null;
  let password = null;
  if (ctx.createUsers) {
    username = String(row.username ?? '').trim().toLowerCase();
    if (username && !/^[a-z0-9._-]{3,}$/.test(username)) {
      errors.push('Username must be 3+ characters: a-z 0-9 . _ -');
      username = null;
    }
    password = String(row.password ?? '').trim();
    if (password && password.length < 8) errors.push('Password must be at least 8 characters.');
  }

  // Duplicate candidates: same email, or same name when the row has none.
  // Usernames collide too — they are the portal login and must stay unique.
  let duplicateReason = null;
  const emailKey = candidate.email.toLowerCase();
  const nameKey = candidate.name.toLowerCase();
  if (emailKey) {
    if ((ctx.existingEmails || new Set()).has(emailKey)) {
      duplicateReason = 'A candidate with this email already exists.';
    } else if ((ctx.seenEmails || new Map()).has(emailKey)) {
      duplicateReason = 'This email appears earlier in the same sheet.';
    }
  } else if (nameKey) {
    if ((ctx.existingNames || new Set()).has(nameKey)) {
      duplicateReason = 'A candidate with this name already exists.';
    } else if ((ctx.seenNames || new Map()).has(nameKey)) {
      duplicateReason = 'This name appears earlier in the same sheet.';
    }
  }
  if (!duplicateReason && ctx.createUsers && username) {
    if ((ctx.existingUsernames || new Set()).has(username)) {
      duplicateReason = 'This username already exists.';
    } else if ((ctx.usedUsernames || new Set()).has(username)) {
      duplicateReason = 'This username appears earlier in the same sheet.';
    }
  }

  if (duplicateReason) return { ok: false, duplicate: true, errors: [duplicateReason], candidate };
  if (errors.length) return { ok: false, duplicate: false, errors, candidate };

  // Commit-time availability check: accepted rows consume their username so a
  // later row — whether it repeats an explicit login or derives the same one —
  // can never be handed an already-taken name. Generated passwords are fresh
  // each run and only ever surfaced in the commit response.
  if (ctx.createUsers) {
    candidate.username = username || resolveUsername(
      { email: candidate.email, name: candidate.name },
      ctx.usedUsernames,
    );
    ctx.usedUsernames?.add(candidate.username);
    candidate.password = password || generatePassword();
  }

  return { ok: true, duplicate: false, errors: [], candidate };
}

/**
 * Validate a batch, reporting per-row outcomes rather than failing the whole
 * import on one bad row — an admin importing hundreds of candidates needs to
 * know exactly which lines to fix, and the good rows should still land.
 * Duplicates are reported separately (already in the directory, or earlier in
 * the same file) so re-uploading a sheet is idempotent.
 */
export function validateCandidateBatch(rows = [], ctx = {}) {
  const existingCandidates = ctx.existingCandidates || [];
  const existingUsernames = new Set(ctx.existingUsernames || []);
  const usedUsernames = new Set(existingUsernames);
  const existingEmails = new Set(existingCandidates
    .map((c) => String(c.email || '').trim().toLowerCase()).filter(Boolean));
  const existingNames = new Set(existingCandidates
    .map((c) => String(c.name || '').trim().toLowerCase()).filter(Boolean));
  const seenEmails = new Map();
  const seenNames = new Map();

  const accepted = [];
  const rejected = [];
  const duplicates = [];

  rows.forEach((raw, index) => {
    const line = index + 2; // +1 for 0-based, +1 for the header row
    const result = validateCandidateRow(raw, {
      ...ctx,
      existingUsernames, existingEmails, existingNames, usedUsernames, seenEmails, seenNames,
    });
    if (!result.ok && result.duplicate) {
      duplicates.push({ line, errors: result.errors, name: result.candidate.name || '' });
      return;
    }
    if (!result.ok) {
      rejected.push({ line, errors: result.errors, name: result.candidate.name || '' });
      return;
    }
    // Accepted rows join the seen sets so an in-file repeat is caught.
    if (result.candidate.email) seenEmails.set(result.candidate.email.toLowerCase(), line);
    else seenNames.set(result.candidate.name.toLowerCase(), line);
    accepted.push({ line, candidate: result.candidate });
  });

  return { accepted, rejected, duplicates };
}

/** A downloadable CSV template: header row + one example row of each shape. */
export function candidateImportTemplateCsv() {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const header = CANDIDATE_IMPORT_COLUMNS.map((c) => c.key);
  const examples = [
    ['Asha Sharma', 'asha.sharma@example.com', '+91 90000 00000', 'Data Engineer', '8',
      'Bengaluru', 'Referral', 'Resident Solutions Architect (RSA)', 'Candidate Intake',
      'asha.sharma', 'Onboard-2026!', 'Strong Delta Lake background'],
    ['Bilal Khan', 'bilal.khan@example.com', '', 'Solutions Architect', '12',
      'Dubai', 'Inbound', '', 'Role Mapping', '', '', ''],
  ];
  return [header, ...examples].map((r) => r.map(esc).join(',')).join('\n');
}
