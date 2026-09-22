import { TABLES, overflowColumn } from './schema.mjs';

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
/**
 * Airtable caps every text cell (single line and long text alike) at 100,000
 * characters. The JSON columns (`snapshot_json`, `answer`, `report_json`, …)
 * are stored as long text, so a value past the cap cannot be written — and
 * Airtable's own 422 for it is generic. Refusing it here names the column and
 * fails the write before anything else in the batch is touched.
 */
export const AIRTABLE_TEXT_CELL_LIMIT = 100_000;
// First cell of a split value: `§ecod-split:3§{"…` — a JSON value never
// starts with `§`, so an unsplit cell can never be mistaken for a header.
const overflowHeader = (pieces) => `\u00a7ecod-split:${pieces}\u00a7`;
const OVERFLOW_HEADER_RE = /^\u00a7ecod-split:(\d+)\u00a7/;
const OVERFLOW_HEADER_MAX = overflowHeader(99).length;

export function createAirtableStore({ apiKey, baseId, apiUrl = 'https://api.airtable.com/v0' } = {}) {
  const key = apiKey ?? process.env.AIRTABLE_API_KEY;
  const base = baseId ?? process.env.AIRTABLE_BASE_ID;
  if (!key || !base) throw new Error('STORAGE=airtable requires AIRTABLE_API_KEY and AIRTABLE_BASE_ID');

  const jsonFields = (t) => TABLES[t]?.json || [];
  const flagFields = (t) => TABLES[t]?.flags || [];
  const overflowFor = (t, f) => TABLES[t]?.overflow?.[f] || 0;
  const tooLarge = (t, f, length) => {
    const err = new Error(`${t}.${f} is ${length} characters; Airtable stores at most ${AIRTABLE_TEXT_CELL_LIMIT} per cell`
      + (overflowFor(t, f) ? ` (${overflowFor(t, f) + 1} cells for this column).` : '.'));
    err.code = 'VALUE_TOO_LARGE';
    err.table = t;
    err.field = f;
    return err;
  };
  /**
   * A JSON column that outgrows one cell is split across its continuation
   * columns (`answer`, `answer__2`, …). The first piece is prefixed with a
   * header naming the piece count so a read knows to rejoin — and so a later,
   * smaller write needs no clearing of the continuation cells: without the
   * header they are simply ignored. Bases created before the continuation
   * columns existed keep working for every value that fits in one cell.
   */
  const splitOverflow = (t, f, text, out) => {
    const pieces = Math.ceil((text.length + OVERFLOW_HEADER_MAX) / AIRTABLE_TEXT_CELL_LIMIT);
    if (pieces - 1 > overflowFor(t, f)) throw tooLarge(t, f, text.length);
    const header = overflowHeader(pieces);
    const firstLen = AIRTABLE_TEXT_CELL_LIMIT - header.length;
    out[f] = header + text.slice(0, firstLen);
    for (let i = 1, at = firstLen; i < pieces; i += 1, at += AIRTABLE_TEXT_CELL_LIMIT) {
      out[overflowColumn(f, i + 1)] = text.slice(at, at + AIRTABLE_TEXT_CELL_LIMIT);
    }
  };
  const serialize = (t, data) => {
    const out = { ...data };
    for (const f of jsonFields(t)) {
      if (out[f] !== undefined && out[f] !== null && typeof out[f] === 'object') out[f] = JSON.stringify(out[f]);
    }
    for (const [f, v] of Object.entries(out)) {
      if (typeof v !== 'string' || v.length <= AIRTABLE_TEXT_CELL_LIMIT) continue;
      if (jsonFields(t).includes(f) && overflowFor(t, f)) splitOverflow(t, f, v, out);
      else throw tooLarge(t, f, v.length);
    }
    return out;
  };
  const joinOverflow = (fields, f, first) => {
    const m = OVERFLOW_HEADER_RE.exec(first);
    if (!m) return first;
    let text = first.slice(m[0].length);
    for (let i = 2; i <= Number(m[1]); i += 1) text += typeof fields[overflowColumn(f, i)] === 'string' ? fields[overflowColumn(f, i)] : '';
    return text;
  };
  const deserialize = (t, fields) => {
    const out = { ...fields };
    for (const f of jsonFields(t)) {
      const v = typeof out[f] === 'string' ? joinOverflow(fields, f, out[f]) : out[f];
      // Airtable long-text may come back with surrounding whitespace; a JSON
      // field is parsed when its trimmed text is a JSON container.
      const text = typeof v === 'string' ? v.trim() : v;
      if (typeof text === 'string' && (text.startsWith('{') || text.startsWith('['))) {
        try { out[f] = JSON.parse(text); } catch { out[f] = v; }
      }
      // Continuation cells are storage detail, never part of the record.
      for (let i = 2; i <= overflowFor(t, f) + 1; i += 1) delete out[overflowColumn(f, i)];
    }
    // A checkbox is `true` when set and simply ABSENT when not — Airtable never
    // returns `false`. The app reads these columns as tri-state (`=== false`
    // is "deactivated"/"locked"), so an omitted flag must come back as the
    // `false` that was written, or a deactivated user is treated as active.
    for (const f of flagFields(t)) if (out[f] !== true) out[f] = false;
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
  // `api()` maps 404 to null because a record-level path (get/update/remove of
  // an id) legitimately misses. A table-level path (list, insert) has no id to
  // miss: its 404 means the table — or the whole base — is not there, which
  // used to read as "no rows" on list and as a TypeError on insert.
  const missingTable = (t) => Object.assign(
    new Error(`Airtable table "${t}" was not found in base ${base} (404). Check AIRTABLE_BASE_ID and run "npm run airtable:setup" to create the missing tables.`),
    { code: 'TABLE_NOT_FOUND', table: t },
  );

  const adapter = {
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
        if (!page) throw missingTable(t);
        for (const rec of page.records || []) rows.push(recordToRow(t, rec));
        offset = page?.offset;
      } while (offset);
      return rows;
    },
    async get(t, id) {
      const rec = await api(`${encodeURIComponent(t)}/${encodeURIComponent(id)}`);
      return rec ? recordToRow(t, rec) : null;
    },
    /**
     * Airtable mints the record id, so a caller-supplied `id` is dropped. The
     * `created_at` stamp is the storage contract (json-file and blobs stamp it
     * too): every "newest first" list, the audit trail, the dashboard's recent
     * activity and the per-user session cap order rows by it, and this adapter
     * used to leave it blank unless the caller passed one — which nothing does.
     */
    async insert(t, data) {
      const { id: _ignored, created_at, ...fields } = data;
      const body = { typecast: true, records: [{ fields: { ...serialize(t, fields), created_at: created_at || new Date().toISOString() } }] };
      const out = await api(encodeURIComponent(t), { method: 'POST', body });
      if (!out) throw missingTable(t);
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
        const stamp = new Date().toISOString();
        const chunk = rows.slice(i, i + 10).map((data) => {
          const { id: _ignored, created_at, ...fields } = data;
          return { fields: { ...serialize(t, fields), created_at: created_at || stamp } };
        });
        const resp = await api(encodeURIComponent(t), {
          method: 'POST',
          body: { typecast: true, records: chunk },
        });
        if (!resp) throw missingTable(t);
        out.push(...(resp.records || []).map((rec) => recordToRow(t, rec)));
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
    /**
     * Batch update in Airtable's 10-record chunks (one PATCH per chunk instead
     * of one per row — the submit of a 50-question paper and the scoring of an
     * open set used to spend most of their time in Airtable's 5 req/s limit).
     * Same result contract as the other adapters' updateMany: caller order,
     * null for an id the table does not hold. Airtable rejects a whole chunk
     * when one id in it is unknown, so such a chunk falls back to per-row
     * updates rather than failing every row in it.
     */
    async updateMany(t, patches = []) {
      const out = [];
      for (let i = 0; i < patches.length; i += 10) {
        const chunk = patches.slice(i, i + 10);
        const stamp = new Date().toISOString();
        const records = chunk.map(({ id, patch }) => {
          const { id: _i, created_at: _c, ...fields } = patch || {};
          return { id, fields: { ...serialize(t, fields), updated_at: stamp } };
        });
        let resp;
        try {
          resp = await api(encodeURIComponent(t), { method: 'PATCH', body: { typecast: true, records } });
        } catch {
          resp = null;
        }
        const byId = new Map((resp?.records || []).map((rec) => [rec.id, recordToRow(t, rec)]));
        if (resp && byId.size === chunk.length) {
          out.push(...chunk.map(({ id }) => byId.get(id) ?? null));
          continue;
        }
        for (const { id, patch } of chunk) out.push(await adapter.update(t, id, patch));
      }
      return out;
    },
    async remove(t, id) {
      const out = await api(`${encodeURIComponent(t)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return !!out?.deleted;
    },
    /**
     * Batch delete: Airtable deletes up to 10 records per request
     * (`DELETE /{table}?records[]=…`), so a cascade costs ceil(n/10) calls
     * instead of n. A chunk that fails as a whole falls back to per-row
     * deletes so one bad id does not strand the rest of the cascade.
     */
    async removeMany(t, ids = []) {
      let removed = 0;
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = ids.slice(i, i + 10);
        const qs = chunk.map((id) => `records[]=${encodeURIComponent(id)}`).join('&');
        let resp;
        try {
          resp = await api(`${encodeURIComponent(t)}?${qs}`, { method: 'DELETE' });
        } catch {
          resp = null;
        }
        if (resp && Array.isArray(resp.records)) {
          removed += resp.records.filter((r) => r?.deleted).length;
          continue;
        }
        for (const id of chunk) {
          try {
            if (await adapter.remove(t, id)) removed += 1;
          } catch {
            // an id that is already gone: skipped, like the other adapters
          }
        }
      }
      return removed;
    },
  };
  return adapter;
}
