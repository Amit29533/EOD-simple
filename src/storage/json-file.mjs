import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../core/ids.mjs';

/** Local JSON-file store. Used for development, demos and tests. Not for Netlify runtime. */
export function createJsonStore(file = 'data/ecod.json') {
  let db = { tables: {} };
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.tables && typeof parsed.tables === 'object') {
        db = parsed;
      } else if (parsed && typeof parsed === 'object') {
        // Legacy shape guard: if file contains only tables directly, wrap it
        db = { tables: parsed.tables || parsed };
      }
    } catch (err) {
      // Never silently wipe data on corruption: backup the bad file and start fresh
      try {
        const backup = `${file}.corrupt-${Date.now()}.bak`;
        fs.copyFileSync(file, backup);
        console.error(`[storage] JSON store corrupted, backed up to ${backup}:`, err.message);
      } catch {
        console.error('[storage] JSON store corrupted and backup failed:', err.message);
      }
      db = { tables: {} };
    }
  }
  if (!db.tables || typeof db.tables !== 'object') db.tables = {};

  // Simple in-process mutex to prevent read-modify-write races on concurrent requests.
  // Node's single-threaded event loop still interleaves async ops; without this,
  // two parallel inserts could read the same in-memory state and one overwrites the other on persist.
  let writeLock = Promise.resolve();
  const withLock = (fn) => {
    const run = () => fn();
    const p = writeLock.then(run, run);
    // Keep chain alive even if one op fails
    writeLock = p.catch(() => {});
    return p;
  };

  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file); // atomic-ish
  };
  const table = (t) => (db.tables[t] ||= {});

  return {
    kind: 'json-file',
    async list(t, filter = {}) {
      let rows = Object.values(table(t));
      const keys = Object.entries(filter).filter(([, v]) => v !== undefined && v !== null && v !== '');
      if (keys.length) rows = rows.filter((r) => keys.every(([k, v]) => r[k] === v));
      return rows.map((r) => ({ ...r }));
    },
    async get(t, id) {
      const r = table(t)[id];
      return r ? { ...r } : null;
    },
    async insert(t, data) {
      return withLock(() => {
        const id = data.id || newId();
        const rec = { ...data, id, created_at: data.created_at || new Date().toISOString() };
        table(t)[id] = rec;
        // Audit log rotation: keep max 2000 entries, trim oldest 500 when over
        if (t === 'audit_log') {
          const all = Object.values(table(t));
          if (all.length > 2000) {
            all.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
            const toDelete = all.slice(0, 500);
            for (const r of toDelete) delete table(t)[r.id];
          }
        }
        persist();
        return { ...rec };
      });
    },
    /**
     * Batch insert: one persist for the whole batch instead of one full-file
     * write per row. Bulk onboarding (hundreds of candidates + users) and bank
     * syncs are the hot paths — per-row persists made them O(n) file rewrites.
     * Same per-row semantics as insert() (id generated when absent, created_at
     * stamped), and result order matches the input order.
     */
    async insertMany(t, rows = []) {
      return withLock(() => {
        const recs = rows.map((data) => {
          const id = data.id || newId();
          const rec = { ...data, id, created_at: data.created_at || new Date().toISOString() };
          table(t)[id] = rec;
          return rec;
        });
        if (recs.length) persist();
        return recs.map((r) => ({ ...r }));
      });
    },
    async update(t, id, patch) {
      return withLock(() => {
        const rec = table(t)[id];
        if (!rec) return null;
        Object.assign(rec, patch, { id });
        rec.updated_at = new Date().toISOString();
        persist();
        return { ...rec };
      });
    },
    async remove(t, id) {
      return withLock(() => {
        if (!table(t)[id]) return false;
        delete table(t)[id];
        persist();
        return true;
      });
    },
  };
}
