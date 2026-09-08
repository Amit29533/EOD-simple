/**
 * Keyed async mutex for read-modify-write routes.
 *
 * The exam routes (`/next`, `/answers`, `/integrity`, `/phase`, `/submit`)
 * all read an assessment, compute, then write it back. Two requests in flight
 * at once used to interleave: parallel integrity events lost increments,
 * racing advances created duplicate response rows, and racing allocations of
 * the same track double-booked the candidate. Serializing per key (one
 * assessment, one candidate+role pair) makes each of those atomic.
 *
 * This is a per-process lock: it makes a single server correct. A serverless
 * deployment runs many instances behind one store, where a cross-instance
 * race can still slip through — last-writer-wins there, same as before, just
 * far narrower. True conditional writes would need adapter support.
 */
const chains = new Map();

export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked = next.catch(() => {});
  chains.set(key, tracked);
  // The map must not grow with every assessment ever touched: drop the entry
  // once the chain drains (only if nothing newer queued behind it).
  tracked.then(() => {
    if (chains.get(key) === tracked) chains.delete(key);
  });
  return next;
}
