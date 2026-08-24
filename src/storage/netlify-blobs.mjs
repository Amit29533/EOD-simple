import { newId } from '../core/ids.mjs';

/**
 * Zero-external-dependency store for the Netlify runtime (uses Netlify Blobs).
 * One blob per table. Suitable for the MVP scale; swap STORAGE=airtable or a
 * future SQL adapter as you grow - the rest of the app does not change.
 */
export async function createBlobsStore() {
  let blobs;
  try { blobs = await import('@netlify/blobs'); }
  catch { throw new Error('STORAGE=blobs requires the @netlify/blobs package inside the Netlify runtime.'); }
  const store = blobs.getStore('ecod');
  const cache = new Map();

  const readTable = async (t) => {
    if (cache.has(t)) return cache.get(t);
    let rows = {};
    try { rows = (await store.get(t, { type: 'json' })) || {}; } catch { rows = {}; }
    cache.set(t, rows);
    return rows;
  };
  const writeTable = async (t, rows) => {
    await store.setJSON(t, rows);
    cache.set(t, rows);
  };

  return {
    kind: 'netlify-blobs',
    async list(t, filter = {}) {
      const rowsObj = await readTable(t);
      let rows = Object.values(rowsObj);
      const keys = Object.entries(filter).filter(([, v]) => v !== undefined && v !== null && v !== '');
      if (keys.length) rows = rows.filter((r) => keys.every(([k, v]) => r[k] === v));
      return rows.map((r) => ({ ...r }));
    },
    async get(t, id) {
      const rows = await readTable(t);
      return rows[id] ? { ...rows[id] } : null;
    },
    async insert(t, data) {
      const rows = await readTable(t);
      const id = data.id || newId();
      const rec = { ...data, id, created_at: data.created_at || new Date().toISOString() };
      rows[id] = rec;
      await writeTable(t, rows);
      return { ...rec };
    },
    async update(t, id, patch) {
      const rows = await readTable(t);
      if (!rows[id]) return null;
      rows[id] = { ...rows[id], ...patch, id, updated_at: new Date().toISOString() };
      await writeTable(t, rows);
      return { ...rows[id] };
    },
    async remove(t, id) {
      const rows = await readTable(t);
      if (!rows[id]) return false;
      delete rows[id];
      await writeTable(t, rows);
      return true;
    },
  };
}
