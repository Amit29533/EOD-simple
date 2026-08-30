import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shuffle, interleave, maxRunLength, maxRunOf } from '../src/core/paper-order.mjs';

/** Deterministic rng so an ordering guarantee is never a coin toss. */
const seeded = (seed) => {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
};

/** The shape of a generated paper: 30 objective, 20 open. */
const paper = (objective, open) => [
  ...Array.from({ length: objective }, (_, i) => ({ id: `x${i}`, type: 'objective' })),
  ...Array.from({ length: open }, (_, i) => ({ id: `o${i}`, type: 'open' })),
];
const isOpen = (q) => q.type === 'open';
const typesOf = (rows) => rows.map((q) => q.type);

test('shuffle returns a permutation, leaving the source untouched', () => {
  const items = [1, 2, 3, 4, 5];
  const out = shuffle(items, seeded(3));
  assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(items, [1, 2, 3, 4, 5], 'the input array is not mutated');
});

test('the same seed shuffles identically, a different seed differently', () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  assert.deepEqual(shuffle(items, seeded(5)), shuffle(items, seeded(5)));
  assert.notDeepEqual(shuffle(items, seeded(5)), shuffle(items, seeded(6)));
});

test('interleave never puts two minority items back to back', () => {
  for (const seed of [1, 2, 3, 7, 42, 99, 4242]) {
    const out = interleave(paper(30, 20), isOpen, seeded(seed));
    assert.equal(maxRunOf(typesOf(out), 'open'), 1, `seed ${seed}`);
  }
});

test('interleave keeps the majority run as short as the mix allows', () => {
  // 30 objective spread over 21 gaps -> ceil(30/21) = 2 at most.
  for (const seed of [1, 7, 42, 99, 4242]) {
    const out = interleave(paper(30, 20), isOpen, seeded(seed));
    assert.equal(maxRunLength(typesOf(out)), 2, `seed ${seed}`);
  }
});

test('interleave holds the bound for a lopsided paper too', () => {
  // 82 objective, 28 open: ceil(82/29) = 3 objective in a row, never 2 opens.
  for (const seed of [1, 7, 42]) {
    const out = interleave(paper(82, 28), isOpen, seeded(seed));
    assert.equal(out.length, 110);
    assert.equal(maxRunOf(typesOf(out), 'open'), 1, `seed ${seed}`);
    assert.equal(maxRunLength(typesOf(out)), 3, `seed ${seed}`);
  }
});

test('interleave works when the "minority" is actually the larger group', () => {
  // More opens than objective items: the objective ones become the separators,
  // so they never repeat and the opens take the shortest possible runs.
  const out = interleave(paper(5, 12), isOpen, seeded(9));
  assert.equal(maxRunOf(typesOf(out), 'objective'), 1);
  assert.equal(maxRunLength(typesOf(out)), Math.ceil(12 / 6));
});

test('interleave is a permutation: nothing dropped, nothing duplicated', () => {
  const items = paper(30, 20);
  const out = interleave(items, isOpen, seeded(11));
  assert.equal(out.length, items.length);
  assert.deepEqual(out.map((q) => q.id).sort(), items.map((q) => q.id).sort());
});

test('interleave degrades gracefully when one group is empty', () => {
  const onlyOpen = paper(0, 6);
  assert.deepEqual(interleave(onlyOpen, isOpen, seeded(1)).map((q) => q.id).sort(),
    onlyOpen.map((q) => q.id).sort());
  const onlyObjective = paper(6, 0);
  assert.deepEqual(interleave(onlyObjective, isOpen, seeded(1)).map((q) => q.id).sort(),
    onlyObjective.map((q) => q.id).sort());
  assert.deepEqual(interleave([], isOpen, seeded(1)), []);
});

test('two papers from different seeds order the same questions differently', () => {
  const a = interleave(paper(30, 20), isOpen, seeded(1)).map((q) => q.id).join(',');
  const b = interleave(paper(30, 20), isOpen, seeded(2)).map((q) => q.id).join(',');
  assert.notEqual(a, b, 'the mix is random, only its spacing guarantee is fixed');
});

test('maxRunLength reports the longest run of identical keys', () => {
  assert.equal(maxRunLength(['a', 'a', 'b', 'a']), 2);
  assert.equal(maxRunLength(['a', 'b', 'c']), 1);
  assert.equal(maxRunLength([]), 0);
  assert.equal(maxRunOf(['a', 'b', 'b', 'a', 'a', 'a'], 'a'), 3);
  assert.equal(maxRunOf(['a', 'b', 'b', 'a'], 'b'), 2);
});
