/**
 * The canonical identity of a question prompt.
 *
 * "Is this the same question as that one?" is asked in several places — the
 * allocator must never serve a question twice, the admin authoring/import path
 * must refuse a duplicate, and the catalogue sync must repair an existing copy
 * instead of adding a second one. Those checks have to agree, or a row the
 * importer accepts as distinct gets silently merged (and therefore dropped) at
 * serve time. So there is exactly one normalizer here, and every layer uses it.
 *
 * Lives on its own so both `core/question-selection.mjs` (serving) and
 * `core/question-intake.mjs` (authoring) can depend on the rule without either
 * depending on the other.
 */

/**
 * Strip a leading enumerator/label ("COMMON QUESTION —", "Q3:") from a prompt.
 * Labels are ALL-CAPS (or numeric) tags; the mixed-case lead-in of an ordinary
 * sentence ("A client gives you a vague requirement: …") is not a label, so it
 * is preserved. The body after the label is left exactly as typed, so healers
 * can compare it for equality against the published prompt. Shared by the
 * comparison key and the healers that de-label legacy rows copied before the
 * label was dropped from the published catalogue.
 */
export function stripPromptLabel(prompt) {
  return String(prompt ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/^[A-Z0-9][A-Z0-9 '/]{1,40}\s*[-\u2013\u2014\u2015\u2212:]\s+/, '')
    .trim();
}

/**
 * Normalized comparison key for a question prompt.
 *
 * Legacy stores can hold two copies of the *same* published question whose
 * prompts differ only by typography — curly vs straight quotes, en/em dashes,
 * spacing, letter case, or a leading label that a later catalogue revision
 * added (or an admin retyped without it). Exact-match dedupe lets both through,
 * so the candidate would be served the same question twice — once with the
 * microphone control, once without (the older copy predated `audio_required`).
 * Comparing normalized keys closes that gap; verified collision-free across the
 * published catalogue.
 */
export function promptKey(prompt) {
  return stripPromptLabel(prompt)
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
