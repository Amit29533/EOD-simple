import { newId } from '../core/ids.mjs';
import { AUDIT_TABLE, trimAuditRows } from './audit-rotation.mjs';

/**
 * Zero-external-dependency store for the Netlify runtime (uses Netlify Blobs).
 * One blob per table. Suitable for the MVP scale; swap STORAGE=airtable or a
 * future SQL adapter as you grow - the rest of the app does not change.
 */
export async function createBlobsStore({ blobsModule = null } = {}) {
  let blobs = blobsModule;
  if (!blobs) {
    try { blobs = await import('@netlify/blobs'); }
    catch { throw new Error('STORAGE=blobs requires the @netlify/blobs package inside the Netlify runtime.'); }
  }
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

  // Per-table write lock to avoid concurrent read-modify-write races
  const locks = new Map();
  const withLock = (t, fn) => {
    const prev = locks.get(t) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(t, next.catch(() => {}));
    return next;
  };

  const readFresh = async (t) => {
    let rows = {};
    try { rows = (await store.get(t, { type: 'json' })) || {}; } catch { rows = {}; }
    return rows;
  };
  const readTable = async (t) => {
    if (UNCACHED.has(t)) return readFresh(t);
    const hit = cache.get(t);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    const rows = await readFresh(t);
    cache.set(t, { rows, at: Date.now() });
    return rows;
  };
  /**
   * Mutations always start from a fresh read, never from the TTL cache: a
   * read-modify-write over a stale copy silently drops whatever another
   * function instance wrote in the meantime (each deploy runs many instances
   * behind one blob store, and the per-process lock cannot span them).
   */
  const readForWrite = async (t) => {
    const rows = await readFresh(t);
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
      return withLock(t, async () => {
        const rows = await readForWrite(t);
        const id = data.id || newId();
        const rec = { ...data, id, created_at: data.created_at || new Date().toISOString() };
        rows[id] = rec;
        if (t === AUDIT_TABLE) trimAuditRows(rows);
        await writeTable(t, rows);
        return { ...rec };
      });
    },
    async insertMany(t, rows = []) {
      return withLock(t, async () => {
        const all = await readForWrite(t);
        const recs = rows.map((data) => {
          const id = data.id || newId();
          const rec = { ...data, id, created_at: data.created_at || new Date().toISOString() };
          all[id] = rec;
          return rec;
        });
        if (recs.length) {
          if (t === AUDIT_TABLE) trimAuditRows(all);
          await writeTable(t, all);
        }
        return recs.map((r) => ({ ...r }));
      });
    },
    async update(t, id, patch) {
      return withLock(t, async () => {
        const rows = await readForWrite(t);
        if (!rows[id]) return null;
        rows[id] = { ...rows[id], ...patch, id, updated_at: new Date().toISOString() };
        await writeTable(t, rows);
        return { ...rows[id] };
      });
    },
    /** Batch update in one blob write; see the json-file adapter for the contract. */
    async updateMany(t, patches = []) {
      return withLock(t, async () => {
        const rows = await readForWrite(t);
        let touched = 0;
        const out = patches.map(({ id, patch }) => {
          if (!rows[id]) return null;
          rows[id] = { ...rows[id], ...patch, id, updated_at: new Date().toISOString() };
          touched += 1;
          return { ...rows[id] };
        });
        if (touched) await writeTable(t, rows);
        return out;
      });
    },
    async remove(t, id) {
      return withLock(t, async () => {
        const rows = await readForWrite(t);
        if (!rows[id]) return false;
        delete rows[id];
        await writeTable(t, rows);
        return true;
      });
    },
  };
}
