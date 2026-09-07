import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../core/ids.mjs';
import { AUDIT_TABLE, trimAuditRows } from './audit-rotation.mjs';

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
        if (t === AUDIT_TABLE) trimAuditRows(table(t));
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
        // Rotation applies here too: a bulk audit insert that skipped it would
        // be a hole in the cap.
        if (recs.length && t === AUDIT_TABLE) trimAuditRows(table(t));
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
    /**
     * Batch update: one persist for the whole batch, mirroring insertMany.
     * `patches` is an ordered list of { id, patch }; the result mirrors it, with
     * null where the id was not found (same per-row contract as update()).
     */
    async updateMany(t, patches = []) {
      return withLock(() => {
        const rows = table(t);
        let touched = 0;
        const out = patches.map(({ id, patch }) => {
          const rec = rows[id];
          if (!rec) return null;
          Object.assign(rec, patch, { id });
          rec.updated_at = new Date().toISOString();
          touched += 1;
          return { ...rec };
        });
        if (touched) persist();
        return out;
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
