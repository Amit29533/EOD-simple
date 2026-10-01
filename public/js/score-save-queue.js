/** Serialize score writes; a stale comment save must never overwrite a newer mark. */
export function scoreSaveQueue(save, changed = () => {}) {
  const entries = new Map();
  let tail = Promise.resolve();
  const status = () => ({
    pending: [...entries.values()].filter((e) => e.pending).length,
    failed: [...entries.values()].filter((e) => e.error).length,
  });
  const enqueue = (value) => {
    const entry = { value: { ...value }, pending: true, error: null };
    entries.set(value.question_id, entry);
    changed(status());
    tail = tail.then(async () => {
      try { await save(entry.value); }
      catch (err) { entry.error = err; }
      finally {
        entry.pending = false;
        // Superseded entries cannot change the latest item's status.
        changed(status());
      }
    });
    return tail;
  };
  return {
    enqueue, status,
    async flush() {
      let observed;
      do { observed = tail; await observed; } while (observed !== tail);
      return status().failed === 0;
    },
    async retry() {
      for (const entry of [...entries.values()]) if (entry.error) enqueue(entry.value);
      await tail;
      return status().failed === 0;
    },
  };
}
