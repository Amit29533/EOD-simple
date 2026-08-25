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
  const store = blobs.getStore(
  process.env.NETLIFY_SITE_ID && process.env.NETLIFY_AUTH_TOKEN
    ? { name: 'ecod', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN }
    : 'ecod'
);
  const cache = new Map(); // table -> { rows, at }
  /**
   * Sessions are NEVER served from cache: a stale in-memory copy is exactly
   * what logs users out (401 right after login). They are always read fresh
   * from blobs. Other tables use a short TTL so multi-instance deployments
   * converge within a few seconds instead of serving forever-stale data.
   */
  const CACHE_TTL_MS = 5000;
  const UNCACHED = new Set(['sessions']);

  const readTable = async (t) => {
    if (UNCACHED.has(t)) {
      let rows = {};
      try { rows = (await store.get(t, { type: 'json' })) || {}; } catch { rows = {}; }
      return rows;
    }
    const hit = cache.get(t);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    let rows = {};
    try { rows = (await store.get(t, { type: 'json' })) || {}; } catch { rows = {}; }
    cache.set(t, { rows, at: Date.now() });
    return rows;
  };
  const writeTable = async (t, rows) => {
    await store.setJSON(t, rows);
    cache.set(t, { rows, at: Date.now() });
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
