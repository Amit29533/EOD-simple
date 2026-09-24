import { newId } from '../core/ids.mjs';

/**
 * Tables stored ONE ROW PER OBJECT instead of one object per table.
 *
 * The file and blob adapters keep each table as a single id-keyed object and
 * rewrite the whole thing on every write. That is fine for rows of a few
 * kilobytes, and ruinous for a table of recordings: a two-minute spoken answer
 * is ~320,000 base64 characters, a whole-bank paper holds 33 of them, so one
 * finished candidate adds ~10 MB. Kept on the response rows, that 10 MB rode
 * along on every exam request (the responses table is read per GET and lock,
 * and rewritten per lock), on every unrelated mutation of the file store (the
 * whole database is re-serialised: an admin login went from 5 ms to 210 ms
 * after ONE candidate), and on the assessor's detail payload (10 MB — past a
 * serverless function's 6 MB response cap, so the paper could not be opened).
 *
 * Rows of a table listed here are written and read individually: a file under
 * `<store>.rows/rows/<table>/<shard>/<id>.json`, a blob at `rows/<table>/<shard>/<id>`.
 * The `shard` is the column every read of the table filters by
 * (`assessment_id` for recordings), so listing one assessment's rows touches
 * one directory / one key prefix, never the other candidates' recordings.
 *
 * Ids are minted here as `<shard>/<random>` so that any later `get`, `update`
 * or `remove` by id can find the object without an index. Both halves are
 * validated (`SAFE`): they become path segments.
 *
 * `createRowTable(t, io)` builds the store methods over four primitives an
 * adapter provides — everything else (id rules, filters, duplicate checks,
 * timestamps) is shared so the two adapters cannot drift apart.
 */
export const ROW_TABLES = {
  // `key`: a column that is unique within the shard. When its value is
  // path-safe the row's id is `<shard>/<key>` — deterministic, so the one
  // read every lock makes (`list({ assessment_id, question_id })`) is a single
  // object fetch, never a scan of the candidate's other recordings.
  recordings: { shard: 'assessment_id', key: 'question_id' },
};
export const isRowTable = (t) => Object.hasOwn(ROW_TABLES, t);

/**
 * Tables stored ONE OBJECT PER SHARD: `shards/<table>/<shard>` holds every
 * row of one shard as an id-keyed map, and nothing else.
 *
 * `responses` is read and written once per exam step, always for one
 * assessment (every read filters by `assessment_id`). As one table object it
 * carried every paper ever taken — 37 KB per candidate, so a step at 100
 * papers read and rewrote 3.7 MB, and a step at 300 papers 11 MB, all of it
 * other candidates' answers. A per-assessment object makes a step cost one
 * paper regardless of how many exist, and takes the other candidates'
 * writes out of the compare-and-swap window (two candidates never write the
 * same object). Ids are `<shard>/<key>` as for row tables. Rows that were
 * stored in the old whole-table object are moved into their shard the first
 * time it is read (`legacy` hook below).
 */
export const SHARD_TABLES = {
  responses: { shard: 'assessment_id', key: 'question_id' },
};
export const isShardTable = (t) => Object.hasOwn(SHARD_TABLES, t);

/**
 * Columns stored OUTSIDE their table object, one object per row and column:
 * `columns/<table>/<id>/<column>` holds `{ value }`, and the row keeps a marker.
 *
 * An assessment row is small — status, cursor, timestamps — except for the
 * frozen paper (`snapshot_json`, ~90 KB for a whole-bank paper) and the report
 * (~40 KB), both written once and never edited. Inline they made the
 * assessments table object grow by ~130 KB per candidate, and that object is
 * read on every exam GET and rewritten on every `/next` for a cursor change of
 * a few bytes: 8.7 MB per step at 100 papers, 26 MB at 300. Detached, a step
 * moves the small rows only; the paper is fetched by id when a row is
 * `get`/`list`ed (and cached: write-once values never go stale). Rows written
 * before this existed keep their inline values until their next update, which
 * moves them out.
 */
export const DETACHED_COLUMNS = {
  assessments: ['snapshot_json', 'report_json'],
};

const SAFE = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * Every object that lives outside its table object sits under one of these
 * roots, so its key never shares a path with a table's own key: the local
 * Netlify Blobs server (`netlify dev`) maps keys to files, and a file
 * `assessments` cannot coexist with a directory `assessments/…`. The same
 * key strings are used by both adapters (a file `<store>.rows/<key>.json`,
 * a blob `<key>`).
 */
export const KEY_ROOTS = { row: 'rows', shard: 'shards', column: 'columns' };

/**
 * @param {string} t table name (a key of ROW_TABLES)
 * @param {object} io
 *   read(key)  -> Promise<object|null>    the stored row, or null when absent
 *   write(key, row) -> Promise<void>      create or replace
 *   remove(key) -> Promise<boolean>       true when something was deleted
 *   keys(prefix) -> Promise<string[]>     every key under `prefix` (recursive)
 *   lock(fn) -> Promise<any>              serialise mutations (optional)
 */
export function createRowTable(t, io) {
  const { shard, key: natural } = ROW_TABLES[t];
  const lock = io.lock || ((fn) => fn());
  const badId = (id) => {
    const err = new Error(`Invalid id "${id}" for table "${t}"`);
    err.code = 'INVALID_ID';
    return err;
  };
  /** `<shard>/<random>`; a caller-supplied id must already have that shape. */
  const parseId = (id) => {
    if (typeof id !== 'string') return null;
    const slash = id.indexOf('/');
    if (slash <= 0) return null;
    const a = id.slice(0, slash);
    const b = id.slice(slash + 1);
    return SAFE.test(a) && SAFE.test(b) ? { shard: a, tail: b } : null;
  };
  const root = `${KEY_ROOTS.row}/${t}/`;
  const keyOf = (id) => `${root}${id}`;
  const idFor = (data) => {
    if (data.id !== undefined && data.id !== null && data.id !== '') {
      const parsed = parseId(data.id);
      if (!parsed || parsed.shard !== String(data[shard])) throw badId(data.id);
      return data.id;
    }
    const s = String(data[shard] ?? '');
    if (!SAFE.test(s)) {
      const err = new Error(`Table "${t}" requires a ${shard} to store a row under`);
      err.code = 'MISSING_SHARD';
      throw err;
    }
    const k = natural ? String(data[natural] ?? '') : '';
    return `${s}/${SAFE.test(k) ? k : newId()}`;
  };
  const duplicate = (id) => {
    const err = new Error(`Duplicate id "${id}" in table "${t}"`);
    err.code = 'DUPLICATE_ID';
    return err;
  };
  const idFromKey = (key) => (key.startsWith(root) ? key.slice(root.length) : null);
  const matches = (row, pairs) => pairs.every(([k, v]) => row[k] === v);

  const insertOne = async (data) => {
    const id = idFor(data);
    if (await io.read(keyOf(id))) throw duplicate(id);
    const rec = { ...data, id, created_at: data.created_at || new Date().toISOString() };
    await io.write(keyOf(id), rec);
    return { ...rec };
  };
  const updateOne = async (id, patch) => {
    if (!parseId(id)) return null;
    const current = await io.read(keyOf(id));
    if (!current) return null;
    const rec = { ...current, ...patch, id, updated_at: new Date().toISOString() };
    await io.write(keyOf(id), rec);
    return { ...rec };
  };
  const removeOne = async (id) => {
    if (!parseId(id)) return false;
    return io.remove(keyOf(id));
  };

  return {
    async list(filter = {}) {
      const pairs = Object.entries(filter).filter(([, v]) => v !== undefined && v !== null && v !== '');
      const byShard = pairs.find(([k]) => k === shard);
      // A filter on the shard column narrows the scan to one prefix; an
      // unsafe value cannot name any row.
      if (byShard && !SAFE.test(String(byShard[1]))) return [];
      // Shard + natural key both given and path-safe: the row can only live
      // under its deterministic id, so fetch that one object.
      const byKey = natural ? pairs.find(([k]) => k === natural) : null;
      if (byShard && byKey && SAFE.test(String(byKey[1]))) {
        const row = await io.read(keyOf(`${byShard[1]}/${byKey[1]}`));
        return row && matches(row, pairs) ? [{ ...row }] : [];
      }
      const prefix = byShard ? `${root}${byShard[1]}/` : root;
      const keys = await io.keys(prefix);
      const rows = [];
      for (const key of keys) {
        if (!idFromKey(key)) continue;
        const row = await io.read(key);
        if (row && matches(row, pairs)) rows.push({ ...row });
      }
      return rows;
    },
    async get(id) {
      if (!parseId(id)) return null;
      const row = await io.read(keyOf(id));
      return row ? { ...row } : null;
    },
    insert: (data) => lock(() => insertOne(data)),
    insertMany: (rows = []) => lock(async () => {
      const out = [];
      for (const data of rows) out.push(await insertOne(data));
      return out;
    }),
    update: (id, patch) => lock(() => updateOne(id, patch)),
    updateMany: (patches = []) => lock(async () => {
      const out = [];
      for (const { id, patch } of patches) out.push(await updateOne(id, patch));
      return out;
    }),
    remove: (id) => lock(() => removeOne(id)),
    removeMany: (ids = []) => lock(async () => {
      let n = 0;
      for (const id of ids) if (await removeOne(id)) n += 1;
      return n;
    }),
  };
}

/**
 * Compare-and-swap loop shared by shard tables: `readVersioned(key)` gives
 * the object and the version (ETag) it was read at; `write(key, value,
 * { etag })` succeeds only if that version is still current (`etag === null`
 * = only if the key does not exist yet; `undefined` = the backend has no
 * versions, write unconditionally). A refused write re-reads and re-applies.
 */
const MAX_CAS_ATTEMPTS = 10;
const casPause = (attempt) => Math.min(400, Math.round(20 * 1.7 ** (attempt - 1))) + Math.floor(Math.random() * 40);
const conflict = (key, attempts) => {
  const err = new Error(`"${key}" was rewritten by another instance ${attempts} times in a row; giving up`);
  err.code = 'STORE_CONFLICT';
  return err;
};
const written = (res) => !(res && typeof res === 'object' && res.modified === false) && res !== false;

/**
 * @param {string} t table name (a key of SHARD_TABLES)
 * @param {object} io  the row-table primitives plus
 *   readVersioned(key) -> Promise<{ value: object|null, etag: string|null|undefined }>
 *   write(key, value, { etag }) -> Promise<boolean|{modified}|void>  false / modified:false = refused
 * @param {object} [legacy]  rows still stored in the old whole-table object:
 *   rows(shard) -> Promise<object[]>   the legacy rows of one shard
 *   drop(ids)   -> Promise<void>       remove them once the shard object holds them
 */
export function createShardTable(t, io, legacy = null) {
  const { shard, key: natural } = SHARD_TABLES[t];
  const lock = io.lock || ((fn) => fn());
  const parseId = (id) => {
    if (typeof id !== 'string') return null;
    const slash = id.indexOf('/');
    if (slash <= 0) return null;
    const a = id.slice(0, slash);
    const b = id.slice(slash + 1);
    return SAFE.test(a) && SAFE.test(b) ? { shard: a, tail: b } : null;
  };
  const root = `${KEY_ROOTS.shard}/${t}/`;
  const keyOf = (s) => `${root}${s}`;
  const fail = (code, message) => { const err = new Error(message); err.code = code; return err; };
  const idFor = (data) => {
    const s = String(data[shard] ?? '');
    if (data.id !== undefined && data.id !== null && data.id !== '') {
      const parsed = parseId(data.id);
      if (!parsed || parsed.shard !== s) throw fail('INVALID_ID', `Invalid id "${data.id}" for table "${t}"`);
      return data.id;
    }
    if (!SAFE.test(s)) throw fail('MISSING_SHARD', `Table "${t}" requires a ${shard} to store a row under`);
    const k = natural ? String(data[natural] ?? '') : '';
    return `${s}/${SAFE.test(k) ? k : newId()}`;
  };
  const rowOf = (rows, id) => (typeof id === 'string' && Object.hasOwn(rows, id) ? rows[id] : undefined);
  const matches = (row, pairs) => pairs.every(([k, v]) => row[k] === v);

  /**
   * Fold any rows of shard `s` still sitting in the old whole-table object
   * into the shard object (re-keyed `<shard>/<key>`), then remove them from
   * the old object. Checked on every shard read, not only the first: an
   * instance of the previous version may write into the old object for a
   * few seconds after the new version starts. The adapter makes the check
   * cheap once the old object is empty.
   */
  const stamp = (r) => String(r.updated_at || r.created_at || '');
  const migrate = async (s, cur) => {
    const old = legacy ? await legacy.rows(s) : [];
    if (!old.length) return cur;
    const rows = { ...(cur.value || {}) };
    for (const row of old) {
      const k = natural ? String(row[natural] ?? '') : '';
      let id = `${s}/${SAFE.test(k) ? k : newId()}`;
      if (Object.hasOwn(rows, id)) {
        // the same question already in the shard: keep whichever was written last
        if (stamp(rows[id]) >= stamp(row)) continue;
      }
      rows[id] = { ...row, id };
    }
    if (written(await io.write(keyOf(s), rows, { etag: cur.value === null ? null : cur.etag }))) {
      try { await legacy.drop(old.map((r) => r.id)); } catch (err) {
        console.warn(`[storage] moved ${old.length} "${t}" rows of ${s} into their shard but could not remove the old copies: ${err.message}`);
      }
    }
    // whoever wrote last, this is the shard now (a refused write means another
    // instance got there first; the old rows are folded in on the next read)
    return io.readVersioned(keyOf(s));
  };
  const readShard = async (s) => {
    let cur = await io.readVersioned(keyOf(s));
    if (cur.value === undefined) cur = { value: null, etag: cur.etag ?? null };
    cur = await migrate(s, cur);
    if (cur.value === null || cur.value === undefined) return { value: {}, etag: cur.etag ?? null };
    return cur;
  };
  /** Read-modify-write one shard under compare-and-swap; `fn(rows)` returns `{ result, write }`. */
  const mutateShard = (s, fn) => lock(async () => {
    for (let attempt = 1; ; attempt += 1) {
      const { value, etag } = await readShard(s);
      const rows = value;
      const { result, write } = await fn(rows);
      if (!write) return result;
      // An emptied shard is written back as `{}` rather than deleted: a
      // delete cannot be made conditional, so it could erase a row another
      // instance added a moment ago.
      if (written(await io.write(keyOf(s), rows, { etag }))) return result;
      if (attempt >= MAX_CAS_ATTEMPTS) throw conflict(keyOf(s), attempt);
      await new Promise((resolve) => setTimeout(resolve, casPause(attempt)));
    }
  });
  const groupIds = (ids) => {
    const groups = new Map();
    for (const id of ids) {
      const parsed = parseId(id);
      if (!parsed) continue;
      if (!groups.has(parsed.shard)) groups.set(parsed.shard, []);
      groups.get(parsed.shard).push(id);
    }
    return groups;
  };
  const shardIds = async (s) => Object.keys((await readShard(s)).value);

  return {
    async list(filter = {}) {
      const pairs = Object.entries(filter).filter(([, v]) => v !== undefined && v !== null && v !== '');
      const byShard = pairs.find(([k]) => k === shard);
      if (byShard) {
        if (!SAFE.test(String(byShard[1]))) return [];
        const { value } = await readShard(String(byShard[1]));
        return Object.values(value).filter((r) => matches(r, pairs)).map((r) => ({ ...r }));
      }
      // No shard given: every shard (the app never does this; tests and tools do).
      const seen = new Set();
      const shards = [];
      for (const key of await io.keys(root)) {
        const s = key.slice(root.length).split('/')[0];
        if (s && SAFE.test(s) && !seen.has(s)) { seen.add(s); shards.push(s); }
      }
      if (legacy) for (const r of await legacy.rows(null)) { const s = String(r[shard] ?? ''); if (SAFE.test(s) && !seen.has(s)) { seen.add(s); shards.push(s); } }
      const out = [];
      for (const s of shards) {
        const { value } = await readShard(s);
        for (const r of Object.values(value)) if (matches(r, pairs)) out.push({ ...r });
      }
      return out;
    },
    async get(id) {
      const parsed = parseId(id);
      if (!parsed) return null;
      const row = rowOf((await readShard(parsed.shard)).value, id);
      return row ? { ...row } : null;
    },
    /**
     * Atomically change a natural-key row using the LATEST copy, not a row
     * the route read earlier. `decide(row|null)` is pure and synchronous; a
     * refused ETag write re-runs it against the winner's row. Return a patch
     * to insert/update, null to remove, or undefined to leave it as-is.
     *
     * The exam's autosave and /next both write the same response id. A plain
     * list → insert/update lets the loser of that race throw DUPLICATE_ID, or
     * worse, lets a late draft overwrite an already locked answer. This CAS
     * operation lets the draft skip a locked row and the lock use the newest
     * draft, whether the requests land on one instance or two.
     */
    change(data, decide) {
      const id = idFor(data);
      const s = parseId(id).shard;
      return mutateShard(s, (rows) => {
        const prior = rowOf(rows, id);
        const decision = decide(prior ? { ...prior } : null);
        if (decision === undefined || (decision === null && !prior)) {
          return { result: { row: prior ? { ...prior } : null, changed: false }, write: false };
        }
        if (decision === null) {
          delete rows[id];
          return { result: { row: null, changed: true }, write: true };
        }
        if (typeof decision !== 'object' || Array.isArray(decision))
          throw new TypeError('changeRow decision must be an object, null or undefined');
        const stamp = new Date().toISOString();
        const rec = prior
          ? { ...prior, ...decision, id, updated_at: stamp }
          : { ...data, ...decision, id, created_at: data.created_at || stamp };
        rec[shard] = s;
        if (natural) rec[natural] = data[natural];
        rows[id] = rec;
        return { result: { row: { ...rec }, changed: true }, write: true };
      });
    },
    insert(data) {
      const id = idFor(data);
      const rec = { ...data, id, created_at: data.created_at || new Date().toISOString() };
      return mutateShard(parseId(id).shard, (rows) => {
        if (Object.hasOwn(rows, id)) throw fail('DUPLICATE_ID', `Duplicate id "${id}" in table "${t}"`);
        rows[id] = rec;
        return { result: { ...rec }, write: true };
      });
    },
    async insertMany(list = []) {
      const stamp = new Date().toISOString();
      const recs = list.map((data) => { const id = idFor(data); return { ...data, id, created_at: data.created_at || stamp }; });
      const seen = new Set();
      for (const r of recs) {
        if (seen.has(r.id)) throw fail('DUPLICATE_ID', `Duplicate id "${r.id}" within one batch for table "${t}"`);
        seen.add(r.id);
      }
      const byShard = new Map();
      for (const r of recs) { const s = parseId(r.id).shard; if (!byShard.has(s)) byShard.set(s, []); byShard.get(s).push(r); }
      for (const [s, group] of byShard) {
        await mutateShard(s, (rows) => {
          for (const r of group) if (Object.hasOwn(rows, r.id)) throw fail('DUPLICATE_ID', `Duplicate id "${r.id}" in table "${t}"`);
          for (const r of group) rows[r.id] = r;
          return { result: null, write: true };
        });
      }
      return recs.map((r) => ({ ...r }));
    },
    update(id, patch) {
      const parsed = parseId(id);
      if (!parsed) return null;
      return mutateShard(parsed.shard, (rows) => {
        if (!rowOf(rows, id)) return { result: null, write: false };
        rows[id] = { ...rows[id], ...patch, id, updated_at: new Date().toISOString() };
        return { result: { ...rows[id] }, write: true };
      });
    },
    async updateMany(patches = []) {
      const out = new Array(patches.length).fill(null);
      const byShard = new Map();
      patches.forEach(({ id, patch }, i) => {
        const parsed = parseId(id);
        if (!parsed) return;
        if (!byShard.has(parsed.shard)) byShard.set(parsed.shard, []);
        byShard.get(parsed.shard).push({ id, patch, i });
      });
      for (const [s, group] of byShard) {
        await mutateShard(s, (rows) => {
          let touched = 0;
          for (const { id, patch, i } of group) {
            if (!rowOf(rows, id)) continue;
            rows[id] = { ...rows[id], ...patch, id, updated_at: new Date().toISOString() };
            out[i] = { ...rows[id] };
            touched += 1;
          }
          return { result: null, write: touched > 0 };
        });
      }
      return out;
    },
    remove(id) {
      const parsed = parseId(id);
      if (!parsed) return false;
      return mutateShard(parsed.shard, (rows) => {
        if (!rowOf(rows, id)) return { result: false, write: false };
        delete rows[id];
        return { result: true, write: true };
      });
    },
    async removeMany(ids = []) {
      let removed = 0;
      for (const [s, group] of groupIds(ids)) {
        removed += await mutateShard(s, (rows) => {
          let n = 0;
          for (const id of group) { if (!rowOf(rows, id)) continue; delete rows[id]; n += 1; }
          return { result: n, write: n > 0 };
        });
      }
      return removed;
    },
    /** Every row id of one shard (cascade deletes). */
    ids: shardIds,
  };
}

/**
 * Detached columns of one table (see DETACHED_COLUMNS). Built over the same
 * primitives as row tables; `split` stores the heavy values and returns the
 * row with markers in their place, `attach` puts the values back.
 */
const MARK = '$detached';
const CACHE_MAX = 64;
export const isDetachedMarker = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && v[MARK] === true;
export function createDetacher(t, io) {
  const cols = DETACHED_COLUMNS[t] || [];
  const keyOf = (id, col) => `${KEY_ROOTS.column}/${t}/${id}/${col}`;
  // Write-once values by key, bounded: the paper a candidate is sitting is
  // attached on every GET/next of that exam and never changes.
  const cache = new Map();
  const remember = (k, v) => {
    cache.delete(k);
    cache.set(k, v);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };
  const detachable = (row) => cols.length > 0 && row && typeof row === 'object' && SAFE.test(String(row.id));
  return {
    active: cols.length > 0,
    columns: cols,
    /** Store the heavy columns of `row` in their own objects; returns the row to keep in the table. */
    async split(row) {
      if (!detachable(row)) return row;
      let out = row;
      for (const col of cols) {
        const v = row[col];
        if (v === undefined || v === null || isDetachedMarker(v)) continue;
        const k = keyOf(row.id, col);
        await io.write(k, { value: v });
        remember(k, v);
        if (out === row) out = { ...row };
        out[col] = { [MARK]: true };
      }
      return out;
    },
    /** The full row: markers replaced by the stored values (null if one is missing). */
    async attach(row) {
      if (!row || !cols.length) return row;
      let out = row;
      for (const col of cols) {
        if (!isDetachedMarker(row[col])) continue;
        const k = keyOf(row.id, col);
        let v;
        if (cache.has(k)) v = cache.get(k);
        else {
          const stored = await io.read(k);
          v = stored && typeof stored === 'object' && 'value' in stored ? stored.value : null;
          if (stored) remember(k, v);
        }
        if (out === row) out = { ...row };
        out[col] = v;
      }
      return out;
    },
    /** `attach` for many rows, a few at a time. */
    async attachAll(rows, concurrency = 8) {
      if (!cols.length) return rows;
      const out = new Array(rows.length);
      let next = 0;
      const worker = async () => {
        while (next < rows.length) {
          const i = next;
          next += 1;
          out[i] = await this.attach(rows[i]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
      return out;
    },
    /** Remove the detached objects of a deleted row. */
    async drop(id) {
      if (!cols.length || !SAFE.test(String(id))) return;
      for (const col of cols) {
        const k = keyOf(id, col);
        cache.delete(k);
        try { await io.remove(k); } catch (err) {
          console.warn(`[storage] could not remove ${k}: ${err.message}`);
        }
      }
    },
  };
}
