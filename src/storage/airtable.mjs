import { newId } from '../core/ids.mjs';
import { TABLES } from './schema.mjs';

/**
 * Airtable REST adapter. Activate with:
 *   STORAGE=airtable
 *   AIRTABLE_API_KEY=pat...   (personal access token, data.records read/write)
 *   AIRTABLE_BASE_ID=app...
 * AIRTABLE_API_URL is overridable for tests (mock server).
 *
 * Generic CRUD over RECORDS ONLY - business logic stays identical to every
 * other adapter, so migrating to Postgres later means writing one more file
 * like this one.
 */
export function createAirtableStore({ apiKey, baseId, apiUrl = 'https://api.airtable.com/v0' } = {}) {
  const key = apiKey ?? process.env.AIRTABLE_API_KEY;
  const base = baseId ?? process.env.AIRTABLE_BASE_ID;
  if (!key || !base) throw new Error('STORAGE=airtable requires AIRTABLE_API_KEY and AIRTABLE_BASE_ID');

  const jsonFields = (t) => TABLES[t]?.json || [];
  const serialize = (t, data) => {
    const out = { ...data };
    for (const f of jsonFields(t)) {
      if (out[f] !== undefined && out[f] !== null && typeof out[f] === 'object') out[f] = JSON.stringify(out[f]);
    }
    return out;
  };
  const deserialize = (t, fields) => {
    const out = { ...fields };
    for (const f of jsonFields(t)) {
      const v = out[f];
      if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
        try { out[f] = JSON.parse(v); } catch { /* keep raw */ }
      }
    }
    return out;
  };

  async function api(pathname, { method = 'GET', body, query } = {}) {
    const url = new URL(`${apiUrl}/${base}/${pathname}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Airtable ${method} ${pathname} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  const formulaValue = (v) =>
    typeof v === 'number' ? String(v)
    : typeof v === 'boolean' ? (v ? 'TRUE()' : 'FALSE()')
    : `'${String(v).replace(/'/g, "\\'")}'`;

  const toFormula = (filter) => {
    const parts = Object.entries(filter)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `{${k}} = ${formulaValue(v)}`);
    if (!parts.length) return undefined;
    return parts.length === 1 ? parts[0] : `AND(${parts.join(', ')})`;
  };

  const recordToRow = (t, rec) => ({ ...deserialize(t, rec.fields || {}), id: rec.id });

  return {
    kind: 'airtable',
    async list(t, filter = {}) {
      const rows = [];
      let offset;
      do {
        const query = { pageSize: '100' };
        const f = toFormula(filter);
        if (f) query.filterByFormula = f;
        if (offset) query.offset = offset;
        const page = await api(encodeURIComponent(t), { query });
        for (const rec of page?.records || []) rows.push(recordToRow(t, rec));
        offset = page?.offset;
      } while (offset);
      return rows;
    },
    async get(t, id) {
      const rec = await api(`${encodeURIComponent(t)}/${encodeURIComponent(id)}`);
      return rec ? recordToRow(t, rec) : null;
    },
    async insert(t, data) {
      const { id: _ignored, created_at: _c, ...fields } = data;
      const body = { typecast: true, records: [{ fields: serialize(t, fields) }] };
      if (data.created_at) body.records[0].fields.created_at = data.created_at;
      const out = await api(encodeURIComponent(t), { method: 'POST', body });
      return recordToRow(t, out.records[0]);
    },
    async update(t, id, patch) {
      const { id: _i, created_at: _c, ...fields } = patch;
      const out = await api(`${encodeURIComponent(t)}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { typecast: true, fields: { ...serialize(t, fields), updated_at: new Date().toISOString() } },
      });
      return out ? recordToRow(t, out) : null;
    },
    async remove(t, id) {
      const out = await api(`${encodeURIComponent(t)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return !!out?.deleted;
    },
  };
}
