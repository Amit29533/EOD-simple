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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(pathname, { method = 'GET', body, query } = {}) {
    const url = new URL(`${apiUrl}/${base}/${pathname}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    // Airtable enforces ~5 requests/second; a bulk onboarding or bank sync
    // bursts past that and would fail the whole import on the first 429.
    // Retry rate-limits with backoff, bounded so a truly failing backend still
    // surfaces promptly. Only 429 is retried for writes: a 429 is rejected
    // *before* processing, while a 5xx/network failure after a POST may have
    // applied server-side — retrying that would double-insert. Reads also
    // retry 5xx/network errors (they cannot create duplicates).
    const idempotent = method === 'GET' || method === 'DELETE';
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) await sleep(250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 120));
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (!idempotent) throw err;
        lastError = err;
        continue;
      }
      if (res.status === 404) return null;
      if (res.status === 429 || (idempotent && res.status >= 500)) {
        lastError = new Error(`Airtable ${method} ${pathname} failed (${res.status})`);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Airtable ${method} ${pathname} failed (${res.status}): ${text.slice(0, 300)}`);
      }
      return res.json();
    }
    throw lastError instanceof Error ? lastError : new Error(`Airtable ${method} ${pathname} failed after retries`);
  }

  // Airtable formula injection hardening:
  // - field names are allowlisted to alphanumeric + underscore, dash
  // - string values escaped for single quotes and backslashes
  const SAFE_FIELD_RE = /^[a-zA-Z0-9_$-]{1,100}$/;
  const sanitizeField = (k) => {
    if (!SAFE_FIELD_RE.test(k)) throw new Error(`Unsafe field name: ${k}`);
    return k;
  };
  const formulaValue = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE()' : 'FALSE()';
    // Escape backslash and single quote, truncate to prevent abuse
    const s = String(v).slice(0, 1000).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `'${s}'`;
  };

  const toFormula = (filter) => {
    const parts = Object.entries(filter)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `{${sanitizeField(k)}} = ${formulaValue(v)}`);
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
    /**
     * Batch insert in Airtable's 10-record chunks. Same per-row semantics as
     * insert(); records come back in the order the API echoes (request order),
     * flattened across chunks so the caller's row order is preserved.
     */
    async insertMany(t, rows = []) {
      const out = [];
      for (let i = 0; i < rows.length; i += 10) {
        const chunk = rows.slice(i, i + 10).map((data) => {
          const { id: _ignored, created_at: _c, ...fields } = data;
          const row = { fields: serialize(t, fields) };
          if (data.created_at) row.fields.created_at = data.created_at;
          return row;
        });
        const resp = await api(encodeURIComponent(t), {
          method: 'POST',
          body: { typecast: true, records: chunk },
        });
        out.push(...(resp?.records || []).map((rec) => recordToRow(t, rec)));
      }
      return out;
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
