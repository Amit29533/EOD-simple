import { newId } from '../core/ids.mjs';
import { AUDIT_TABLE, trimAuditRows } from './audit-rotation.mjs';
import { createRowTable, isRowTable, createShardTable, isShardTable, SHARD_TABLES, createDetacher } from './row-tables.mjs';

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
   * Tables that are NEVER served from the cache or from an eventual read:
   *  - sessions: a stale copy is exactly what logs users out (401 right after
   *    a login handled by another instance);
   *  - assessments / responses: the exam's every decision — which question is
   *    live, whether its clock has run out, whether its row is already locked
   *    — is made from these reads before the write. A copy that is seconds
   *    (or, with eventual consistency, up to a minute) old on the instance
   *    that takes the next request re-serves a question that was just left
   *    behind, or ignores an autosave for the question actually on screen.
   * Reference tables (roles, questions, users, …) use a short TTL so
   * multi-instance deployments converge within a few seconds.
   */
  const CACHE_TTL_MS = 5000;
  const UNCACHED = new Set(['sessions', 'assessments', 'responses']);

  // Per-table write lock to avoid concurrent read-modify-write races
  const locks = new Map();
  const withLock = (t, fn) => {
    const prev = locks.get(t) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(t, next.catch(() => {}));
    return next;
  };

  /**
   * Netlify Blobs reads are *eventually* consistent by default: a read can
   * return the previous copy of a blob for up to a minute after a write, and
   * a function deploy runs many instances behind one store. A "fresh" read
   * that may be a minute stale is not fresh enough for a read-modify-write
   * (the next write would resurrect whatever the stale copy lacked), nor for
   * the sessions table (a login on one instance, then a 401 on the next). Those
   * reads ask for strong consistency. It is served from the uncached edge URL,
   * which the Netlify runtime provides; an environment without one (the SDK
   * throws `BlobsConsistencyError`) falls back to eventual reads once, and
   * stays there, rather than failing every request.
   */
  let strongReads = true;
  const readBlob = async (t, { strong = false } = {}) => {
    const opts = { type: 'json' };
    if (strong && strongReads) opts.consistency = 'strong';
    try {
      return await store.get(t, opts);
    } catch (err) {
      if (opts.consistency === 'strong' && err?.name === 'BlobsConsistencyError') {
        strongReads = false;
        return store.get(t, { type: 'json' });
      }
      throw err;
    }
  };
  /**
   * The blob AND the ETag it currently has, for a compare-and-swap write
   * (`{ value: null, etag: null }` when the blob does not exist). An SDK or
   * test double without `getWithMetadata` yields no ETag, and the write that
   * follows is then unconditional — the pre-CAS behaviour, never a failure.
   */
  const readBlobVersioned = async (t) => {
    if (typeof store.getWithMetadata !== 'function') return { value: await readBlob(t, { strong: true }), etag: undefined };
    const opts = { type: 'json' };
    if (strongReads) opts.consistency = 'strong';
    let res;
    try {
      res = await store.getWithMetadata(t, opts);
    } catch (err) {
      if (opts.consistency === 'strong' && err?.name === 'BlobsConsistencyError') {
        strongReads = false;
        res = await store.getWithMetadata(t, { type: 'json' });
      } else throw err;
    }
    if (!res) return { value: null, etag: null };
    return { value: res.data, etag: typeof res.etag === 'string' && res.etag ? res.etag : undefined };
  };
  /**
   * The current rows of a table — `{}` for a blob that does not exist yet
   * (the SDK answers `null` for a 404). A read that FAILS must throw, never
   * read as an empty table: every mutation below is a read-modify-write, so
   * a swallowed read error (`catch { rows = {} }`, as this used to be) turned
   * one transient blob-service hiccup into a table holding only the row that
   * was being written — a 50-answer paper collapsed to one row by the next
   * autosave — and a failed read on the query side made a login "invalid
   * credentials" instead of a retryable 500.
   */
  const readFresh = async (t, opts) => asTable(t, await readBlob(t, opts));
  /**
   * A table blob is an id-keyed plain object. Anything else — an array or a
   * scalar someone pasted into the Netlify UI — is not a table: inserting into
   * an array "succeeds" and the row vanishes on serialisation (string keys are
   * dropped), and a scalar throws on every write. Mirror the json-file
   * adapter: keep the foreign value under a `.corrupt-*` key and start the
   * table empty, loudly.
   */
  const corruptSaved = new Set();
  const asTable = (t, value) => {
    if (value === null || value === undefined) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (Array.isArray(value) && !value.length) return {};
    if (!corruptSaved.has(t)) {
      corruptSaved.add(t);
      const backup = `${t}.corrupt-${Date.now()}`;
      console.error(`[storage] blob "${t}" is not a table object (${Array.isArray(value) ? 'array' : typeof value}); keeping a copy as "${backup}" and starting empty`);
      store.setJSON(backup, value).catch(() => {});
    }
    return {};
  };
  const readTable = async (t) => {
    if (UNCACHED.has(t)) return readFresh(t, { strong: true });
    const hit = cache.get(t);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    const rows = await readFresh(t);
    cache.set(t, { rows, at: Date.now() });
    return rows;
  };
  /**
   * Mutations always start from a fresh, strongly consistent read, never from
   * the TTL cache: a read-modify-write over a stale copy silently drops
   * whatever another function instance wrote in the meantime (each deploy
   * runs many instances behind one blob store, and the per-process lock
   * cannot span them).
   */
  const readForWrite = async (t) => {
    const { value, etag } = await readBlobVersioned(t);
    // Not cached until the write lands: a mutation edits this object in
    // place, so caching it here meant a write that FAILED left the
    // un-persisted rows in the cache for the TTL — an insert whose setJSON
    // threw was still listed, an update that never reached the store read
    // back as applied, and a removed row read as gone while it still existed.
    return { rows: asTable(t, value), etag };
  };
  /**
   * Write a table back ONLY if nobody else wrote it since it was read.
   *
   * A deploy runs many function instances behind one store, and the
   * per-process lock above cannot reach across them. Two candidates locking
   * an answer at the same moment on two instances both read the `responses`
   * blob, each added their own row, and each wrote the whole blob back — the
   * second write silently erased the first candidate's answer; the same for
   * two cursor advances on `assessments` (one candidate was re-served a
   * question they had just left). Every blob carries an ETag: the write is
   * conditional on the ETag the read saw (`onlyIfMatch`), or on the blob not
   * existing yet (`onlyIfNew`), and a conflict (`modified: false`) makes the
   * caller re-read and re-apply. Returns false on such a conflict.
   */
  const casWrite = async (key, value, etag) => {
    const conditions = etag === undefined ? {} : etag === null ? { onlyIfNew: true } : { onlyIfMatch: etag };
    const res = await store.setJSON(key, value, conditions);
    return !(res && typeof res === 'object' && res.modified === false);
  };
  const writeTable = async (t, rows, etag) => {
    let ok;
    try {
      ok = await casWrite(t, rows, etag);
    } catch (err) {
      cache.delete(t); // whatever was cached is not what the store holds
      throw err;
    }
    if (!ok) {
      cache.delete(t);
      return false;
    }
    cache.set(t, { rows, at: Date.now() });
    return true;
  };
  /**
   * Run one read-modify-write of table `t` under the compare-and-swap rule.
   * `fn(rows)` mutates `rows` in place and returns `{ result, write }`; it is
   * re-run from a fresh read after a conflict (so it must derive everything
   * from `rows`, never from a previous attempt). Conflicts are the other
   * instances' successful writes, so a retry normally lands at once; a table
   * that is being written faster than this instance can re-read it gives up
   * after MAX_CAS_ATTEMPTS with STORE_CONFLICT, which the API answers as 503.
   */
  const MAX_CAS_ATTEMPTS = 10;
  // Exponential, jittered pause between attempts (≈20 ms → 400 ms cap): a
  // lone conflict retries at once; instances in lock-step spread out.
  const casPause = (attempt) => Math.min(400, Math.round(20 * 1.7 ** (attempt - 1))) + Math.floor(Math.random() * 40);
  const mutate = (t, fn) => withLock(t, async () => {
    for (let attempt = 1; ; attempt += 1) {
      const { rows, etag } = await readForWrite(t);
      const { result, write } = await fn(rows);
      if (!write) return result;
      if (await writeTable(t, rows, etag)) return result;
      if (attempt >= MAX_CAS_ATTEMPTS) {
        const err = new Error(`Table "${t}" was rewritten by another instance ${attempt} times in a row; giving up`);
        err.code = 'STORE_CONFLICT';
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, casPause(attempt)));
    }
  });
  // Same rule as the json-file adapter: rows live on a plain id-keyed object,
  // so only an OWN property is a row — `rows["constructor"]` is Object's
  // constructor, not a record — and a caller-supplied id must be a plain
  // string that is never "__proto__" (assigning it would swap the table's
  // prototype instead of adding a row).
  const rowOf = (rows, id) => (typeof id === 'string' && Object.hasOwn(rows, id) ? rows[id] : undefined);
  const idFor = (data) => (typeof data.id === 'string' && data.id && data.id !== '__proto__' ? data.id : newId());
  // An insert never overwrites an existing row (see the json-file adapter).
  const assertNew = (rows, id, t) => {
    if (Object.hasOwn(rows, id)) {
      const err = new Error(`Duplicate id "${id}" in table "${t}"`);
      err.code = 'DUPLICATE_ID';
      throw err;
    }
  };

  /**
   * Row tables (see row-tables.mjs): one blob per row at
   * `rows/<table>/<shard>/<id>` instead of one blob per table, so a recording
   * is uploaded once and never re-uploaded with every other recording on each
   * lock. Reads are strong for the same reason the exam tables are: a lock
   * re-reads the row it is about to replace. The same primitives carry shard
   * tables (`shards/responses/<assessment>`) and detached columns
   * (`columns/assessments/<id>/<column>`).
   */
  const rowIo = {
    read: (key) => readBlob(key, { strong: true }),
    readVersioned: (key) => readBlobVersioned(key),
    /** Unconditional unless `etag` is given (row tables); compare-and-swap for shard tables. */
    write: (key, row, { etag } = {}) => casWrite(key, row, etag),
    async remove(key) {
      if (!(await readBlob(key, { strong: true }))) return false;
      await store.delete(key);
      return true;
    },
    async keys(prefix) {
      const out = [];
      const page = await store.list({ prefix });
      for (const b of page?.blobs || []) out.push(b.key);
      return out;
    },
    lock: (fn) => withLock('__rows__', fn),
  };
  const rowTables = new Map();
  const rowTable = (t) => {
    if (!rowTables.has(t)) rowTables.set(t, createRowTable(t, rowIo));
    return rowTables.get(t);
  };
  /**
   * Shard tables (one blob per assessment for `responses`). Rows written by
   * an earlier version into the whole-table blob are folded into their shard
   * when that shard is read; once the old blob is seen empty it is not read
   * again for a minute, so the check costs nothing on a drained store.
   */
  const legacyOf = (t) => {
    let emptyUntil = 0;
    return {
      async rows(shardValue) {
        if (Date.now() < emptyUntil) return [];
        const all = Object.values(await readFresh(t, { strong: true }));
        if (!all.length) { emptyUntil = Date.now() + 60_000; return []; }
        const { shard } = SHARD_TABLES[t];
        return shardValue === null ? all : all.filter((r) => String(r[shard]) === shardValue);
      },
      drop: (ids) => mutate(t, (rows) => {
        let n = 0;
        for (const id of ids) if (Object.hasOwn(rows, id)) { delete rows[id]; n += 1; }
        return { result: n, write: n > 0 };
      }),
    };
  };
  const shardTables = new Map();
  const shardTable = (t) => {
    if (!shardTables.has(t)) shardTables.set(t, createShardTable(t, rowIo, legacyOf(t)));
    return shardTables.get(t);
  };
  /** Detached columns (the assessments paper and report) live in their own blobs. */
  const detachers = new Map();
  const detacher = (t) => {
    if (!detachers.has(t)) detachers.set(t, createDetacher(t, rowIo));
    return detachers.get(t);
  };

  return {
    kind: 'netlify-blobs',
    /**
     * Conditional row change: a response's natural-key shard or an assessment
     * cursor in the shared table. The pure decision is re-run after an ETag
     * conflict, so two instances cannot both advance the same quiz state.
     * Assessment results keep detached-column markers (the caller needs only
     * the small status/cursor fields, not the frozen paper).
     */
    changeRow(t, data, decide) {
      if (isShardTable(t)) return shardTable(t).change(data, decide);
      if (t !== 'assessments') throw new Error(`Table "${t}" does not support changeRow`);
      const id = data?.id;
      return mutate(t, async (rows) => {
        const prior = rowOf(rows, id);
        const patch = decide(prior ? { ...prior } : null);
        if (!prior || patch === undefined) {
          return { result: { row: prior ? { ...prior } : null, changed: false }, write: false };
        }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch))
          throw new TypeError('assessment changeRow requires a patch object');
        const rec = await detacher(t).split({ ...prior, ...patch, id, updated_at: new Date().toISOString() });
        rows[id] = rec;
        return { result: { row: { ...rec }, changed: true }, write: true };
      });
    },
    /**
     * `opts.detached === false` leaves detached columns (see row-tables.mjs
     * DETACHED_COLUMNS) as markers instead of fetching one blob per row — for
     * listings that only need the small columns.
     */
    async list(t, filter = {}, { detached = true } = {}) {
      if (isRowTable(t)) return rowTable(t).list(filter);
      if (isShardTable(t)) return shardTable(t).list(filter);
      const rowsObj = await readTable(t);
      let rows = Object.values(rowsObj);
      const keys = Object.entries(filter).filter(([, v]) => v !== undefined && v !== null && v !== '');
      if (keys.length) rows = rows.filter((r) => keys.every(([k, v]) => r[k] === v));
      rows = rows.map((r) => ({ ...r }));
      return detached && detacher(t).active ? detacher(t).attachAll(rows) : rows;
    },
    async get(t, id) {
      if (isRowTable(t)) return rowTable(t).get(id);
      if (isShardTable(t)) return shardTable(t).get(id);
      const row = rowOf(await readTable(t), id);
      return row ? detacher(t).attach({ ...row }) : null;
    },
    async insert(t, data) {
      if (isRowTable(t)) return rowTable(t).insert(data);
      if (isShardTable(t)) return shardTable(t).insert(data);
      // id and timestamp are fixed before the first attempt: a retry after a
      // conflict must write the same row, not a second one. Detached columns
      // are stored once, before the table write.
      const id = idFor(data);
      const rec = { ...data, id, created_at: data.created_at || new Date().toISOString() };
      const stored = await detacher(t).split(rec);
      return mutate(t, (rows) => {
        assertNew(rows, id, t);
        rows[id] = stored;
        if (t === AUDIT_TABLE) trimAuditRows(rows);
        return { result: { ...rec }, write: true };
      });
    },
    async insertMany(t, rows = []) {
      if (isRowTable(t)) return rowTable(t).insertMany(rows);
      if (isShardTable(t)) return shardTable(t).insertMany(rows);
      const ids = rows.map(idFor);
      const seen = new Set();
      for (const id of ids) {
        if (seen.has(id)) {
          const err = new Error(`Duplicate id "${id}" within one batch for table "${t}"`);
          err.code = 'DUPLICATE_ID';
          throw err;
        }
        seen.add(id);
      }
      const stamp = new Date().toISOString();
      const recs = rows.map((data, i) => ({ ...data, id: ids[i], created_at: data.created_at || stamp }));
      const stored = [];
      for (const rec of recs) stored.push(await detacher(t).split(rec));
      return mutate(t, (all) => {
        for (const id of ids) assertNew(all, id, t);
        for (const rec of stored) all[rec.id] = rec;
        if (recs.length && t === AUDIT_TABLE) trimAuditRows(all);
        return { result: recs.map((r) => ({ ...r })), write: recs.length > 0 };
      });
    },
    async update(t, id, patch) {
      if (isRowTable(t)) return rowTable(t).update(id, patch);
      if (isShardTable(t)) return shardTable(t).update(id, patch);
      const d = detacher(t);
      return mutate(t, async (rows) => {
        if (!rowOf(rows, id)) return { result: null, write: false };
        // split() also moves a legacy row's inline heavy columns out on its first update
        rows[id] = await d.split({ ...rows[id], ...patch, id, updated_at: new Date().toISOString() });
        return { result: await d.attach({ ...rows[id] }), write: true };
      });
    },
    /** Batch update in one blob write; see the json-file adapter for the contract. */
    async updateMany(t, patches = []) {
      if (isRowTable(t)) return rowTable(t).updateMany(patches);
      if (isShardTable(t)) return shardTable(t).updateMany(patches);
      const d = detacher(t);
      return mutate(t, async (rows) => {
        let touched = 0;
        const out = [];
        for (const { id, patch } of patches) {
          if (!rowOf(rows, id)) { out.push(null); continue; }
          rows[id] = await d.split({ ...rows[id], ...patch, id, updated_at: new Date().toISOString() });
          touched += 1;
          out.push(await d.attach({ ...rows[id] }));
        }
        return { result: out, write: touched > 0 };
      });
    },
    async remove(t, id) {
      if (isRowTable(t)) return rowTable(t).remove(id);
      if (isShardTable(t)) return shardTable(t).remove(id);
      const removed = await mutate(t, (rows) => {
        if (!rowOf(rows, id)) return { result: false, write: false };
        delete rows[id];
        return { result: true, write: true };
      });
      if (removed) await detacher(t).drop(id);
      return removed;
    },
    /** Batch delete in one blob write; see the json-file adapter for the contract. */
    async removeMany(t, ids = []) {
      if (isRowTable(t)) return rowTable(t).removeMany(ids);
      if (isShardTable(t)) return shardTable(t).removeMany(ids);
      const gone = [];
      const removed = await mutate(t, (rows) => {
        gone.length = 0;
        for (const id of ids) {
          if (!rowOf(rows, id)) continue;
          delete rows[id];
          gone.push(id);
        }
        return { result: gone.length, write: gone.length > 0 };
      });
      for (const id of gone) await detacher(t).drop(id);
      return removed;
    },
  };
}
