import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../core/ids.mjs';

/** Local JSON-file store. Used for development, demos and tests. Not for Netlify runtime. */
export function createJsonStore(file = 'data/ecod.json') {
  let db = { tables: {} };
  if (fs.existsSync(file)) {
    try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = { tables: {} }; }
  }
  if (!db.tables) db.tables = {};

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
      const id = data.id || newId();
      const rec = { ...data, id, created_at: data.created_at || new Date().toISOString() };
      table(t)[id] = rec;
      persist();
      return { ...rec };
    },
    async update(t, id, patch) {
      const rec = table(t)[id];
      if (!rec) return null;
      Object.assign(rec, patch, { id });
      rec.updated_at = new Date().toISOString();
      persist();
      return { ...rec };
    },
    async remove(t, id) {
      if (!table(t)[id]) return false;
      delete table(t)[id];
      persist();
      return true;
    },
  };
}
