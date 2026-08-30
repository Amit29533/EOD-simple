/**
 * Paper ordering — shared by both test builders.
 *
 * `src/core/test-generation.mjs` (the module bank) and
 * `src/core/question-selection.mjs` (the role-based served set) both have to
 * answer the same question: in what order does a candidate meet the questions
 * that were drawn? A plain shuffle is not enough. With 30 objective and 20 open
 * questions, a uniform Fisher-Yates regularly produces runs of five or six MCQs
 * and three or four recorded answers back to back — measured on the shipped
 * banks: up to 7 in a row on a 50-question paper and 10 on the 110-question
 * served paper. That is the "all the open questions arrive together" problem in
 * a smaller wrapper.
 *
 * `interleave` spreads the smaller group evenly through the larger one, so:
 *
 *   - the group with fewer members NEVER appears twice in a row, and
 *   - the larger group's longest run is the smallest possible,
 *     ceil(larger / (smaller + 1)).
 *
 * For a 30 objective / 20 open paper that means no two open questions are ever
 * adjacent and at most two MCQs come together. Which questions those are, and
 * where the doubled-up MCQs land, is random — `rng` is injectable so tests are
 * reproducible and production passes Math.random.
 */

/**
 * Fisher-Yates over a copy. Guards against an rng returning values outside
 * [0, 1) so a bad injection cannot produce an out-of-range index.
 */
export function shuffle(items, rng = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const raw = Number(rng());
    const value = Number.isFinite(raw) ? Math.max(0, Math.min(1 - Number.EPSILON, raw)) : 0;
    const j = Math.floor(value * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Spread the smaller group evenly through the larger one.
 *
 * `group(item)` only says which of the two groups an item belongs to — for a
 * paper it is "is this an open question", and the helper knows nothing about
 * questions. The group that turns out to be *smaller* is the one spread out,
 * whichever side of the predicate it falls on, so the guarantee below holds
 * without the caller having to know the counts.
 *
 * Both groups are shuffled first, then the larger is dealt into
 * `smaller.length + 1` gaps whose sizes differ by at most one (the extra seats
 * go to randomly chosen gaps), with a smaller-group item between each pair of
 * gaps. Nothing is dropped and nothing is duplicated: the result is a
 * permutation of the input.
 */
export function interleave(items, group, rng = Math.random) {
  const rows = [...items];
  const flagged = shuffle(rows.filter((x) => group(x)), rng);
  const unflagged = shuffle(rows.filter((x) => !group(x)), rng);
  const [few, many] = flagged.length <= unflagged.length
    ? [flagged, unflagged]
    : [unflagged, flagged];
  if (!few.length || !many.length) return shuffle(rows, rng);

  // Deal the larger group into the gaps around the smaller one.
  const gaps = few.length + 1;
  const base = Math.floor(many.length / gaps);
  let extra = many.length % gaps;
  const sizes = new Array(gaps).fill(base);
  for (const slot of shuffle([...sizes.keys()], rng)) {
    if (extra <= 0) break;
    sizes[slot] += 1;
    extra -= 1;
  }

  const out = [];
  let mi = 0;
  let fi = 0;
  sizes.forEach((size, gap) => {
    for (let k = 0; k < size; k += 1) out.push(many[mi++]);
    if (gap < gaps - 1) out.push(few[fi++]);
  });
  return out;
}

/**
 * Length of the longest run of identical keys — what the guarantees above are
 * stated in terms of, so a test can assert them without restating the
 * algorithm. `keys` is the paper mapped to a comparable value (e.g. its type).
 */
export function maxRunLength(keys) {
  let longest = 0;
  let current = 0;
  let previous;
  for (const key of keys) {
    current = key === previous ? current + 1 : 1;
    previous = key;
    if (current > longest) longest = current;
  }
  return longest;
}

/** Longest run among the keys matching `key`. */
export function maxRunOf(keys, key) {
  return maxRunLength(keys.map((k) => (k === key ? key : Symbol('other'))));
}
