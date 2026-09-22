import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { newId } from '../core/ids.mjs';
import { AUDIT_TABLE, trimAuditRows } from './audit-rotation.mjs';
import { createRowTable, isRowTable, createShardTable, isShardTable, SHARD_TABLES, createDetacher } from './row-tables.mjs';

/** Local JSON-file store. Used for development, demos and tests. Not for Netlify runtime. */
export function createJsonStore(file = 'data/ecod.json') {
  let db = { tables: {} };
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.tables && typeof parsed.tables === 'object') {
        db = { tables: parsed.tables };
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

  /**
   * Multi-writer guard. The store keeps the whole database in memory and
   * rewrites the file on every mutation, so a SECOND process writing the same
   * file (the documented `npm run seed` sync while `npm start` is up; two
   * servers pointed at one DATA_FILE) used to be silently undone by this
   * process's next persist — a whole installed track vanished on the next
   * login. Every persist now stamps a fresh revision id at the very start of
   * the file (`{"rev":"…","tables":…}`); before serving or mutating, the
   * first few bytes are read back and, if the revision is not the one this
   * process last wrote or read, the file is re-read and the mutation lands on
   * top of the other writer's data. A file that cannot be re-read (someone
   * else mid-write) refuses the persist rather than clobber it. Files written
   * before the stamp existed fall back to an inode/size/mtime fingerprint.
   */
  const REV_HEADER = /^\{"rev":"([0-9a-f]{24})"/;
  const fingerprint = () => {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(40);
      const n = fs.readSync(fd, buf, 0, 40, 0);
      const rev = REV_HEADER.exec(buf.toString('utf8', 0, n))?.[1];
      if (rev) return `rev:${rev}`;
      const st = fs.fstatSync(fd);
      return `stat:${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return null; // no file (yet)
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  let seen = fingerprint();
  const stale = () => {
    const now = fingerprint();
    return now !== null && now !== seen;
  };
  const reload = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.tables && typeof parsed.tables === 'object') {
        db = { tables: parsed.tables };
        seen = fingerprint();
        return true;
      }
    } catch {
      // Half-written or unreadable: keep serving memory; persist() refuses
      // until the file settles into something readable.
    }
    return false;
  };
  const refresh = () => { if (stale()) reload(); };

  // Simple in-process mutex to prevent read-modify-write races on concurrent requests.
  // Node's single-threaded event loop still interleaves async ops; without this,
  // two parallel inserts could read the same in-memory state and one overwrites the other on persist.
  let writeLock = Promise.resolve();
  const withLock = (fn) => {
    // Pick up another writer's file before the duplicate checks and the
    // mutation itself run, so both see the current rows.
    const run = () => { refresh(); return fn(); };
    const p = writeLock.then(run, run);
    // Keep chain alive even if one op fails
    writeLock = p.catch(() => {});
    return p;
  };

  /**
   * Serialise the table BEFORE it is mutated, so a persist that fails (disk
   * full, read-only volume, EACCES) can put it back. The in-memory table used
   * to be edited first and persisted second: when the write threw, the caller
   * got the error but the process kept serving the un-persisted row — an
   * insert that never reached disk was listed, an update read back as applied
   * — until the next restart, when the data quietly reverted.
   */
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (stale()) {
      const err = new Error(`Refusing to overwrite ${file}: it was changed by another process since this one read it (restart, or run only one writer against a JSON store).`);
      err.code = 'STORE_STALE';
      throw err;
    }
    const rev = randomBytes(12).toString('hex');
    // A temp name private to this process and this write: with one shared
    // `<file>.tmp`, two processes persisting at the same instant truncated
    // each other's half-written temp file and one of them renamed the mixture
    // into place — a corrupt store, backed up and started fresh on the next
    // load. Distinct temp files make the worst case "last writer wins", never
    // a corrupt file.
    const tmp = `${file}.${process.pid}.${rev.slice(0, 8)}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ rev, tables: db.tables }));
      fs.renameSync(tmp, file); // atomic replace
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* never written */ }
      throw err;
    }
    seen = `rev:${rev}`;
  };
  /**
   * Run a mutation touching rows `ids` of table `t`, then persist; if the
   * persist fails, put exactly those rows back (the audit table is captured
   * whole, since its rotation can drop rows beyond the ones named).
   */
  const mutate = (t, ids, fn) => {
    const rows = table(t);
    const whole = t === AUDIT_TABLE ? JSON.stringify(rows) : null;
    const before = whole ? null
      : ids.map((id) => [id, Object.hasOwn(rows, id) ? JSON.stringify(rows[id]) : undefined]);
    const out = fn();
    try {
      persist();
    } catch (err) {
      if (whole) db.tables[t] = JSON.parse(whole);
      else for (const [id, json] of before) { if (json === undefined) delete rows[id]; else rows[id] = JSON.parse(json); }
      throw err;
    }
    return out;
  };
  const table = (t) => (db.tables[t] ||= {});
  // Rows are keyed by id on a plain object, so an id that names an
  // Object.prototype member ("__proto__", "constructor", "toString", …) used
  // to resolve to the inherited member instead of "no such row": a GET on it
  // returned a phantom record, and an update ran Object.assign against
  // Object.prototype itself — polluting every object in the process (all
  // later inserts inherited `id: "__proto__"` and silently vanished). Only an
  // OWN property is a row.
  const rowOf = (rows, id) => (typeof id === 'string' && Object.hasOwn(rows, id) ? rows[id] : undefined);
  // A caller may bring its own id (seeds, tests, catalogue installs), but it
  // must be a plain non-empty string and never "__proto__": assigning that
  // key would rewrite the table's prototype rather than add a row.
  const idFor = (data) => (typeof data.id === 'string' && data.id && data.id !== '__proto__' ? data.id : newId());
  // An insert is an insert: a caller-supplied id that is already a row must
  // not silently overwrite it (two authored bank questions racing for the same
  // sequential id used to leave one of them gone, both with a 201).
  const assertNew = (rows, id, t) => {
    if (Object.hasOwn(rows, id)) {
      const err = new Error(`Duplicate id "${id}" in table "${t}"`);
      err.code = 'DUPLICATE_ID';
      throw err;
    }
  };

  /**
   * Row tables, shard tables and detached columns (see row-tables.mjs) live
   * OUTSIDE the database file, one JSON file per object under
   * `<store>.rows/<key>.json` (`rows/recordings/<assessment>/<question>`,
   * `shards/responses/<assessment>`, `columns/assessments/<id>/<column>`), so
   * a recording or a paper is written once and never re-serialised with the
   * rest of the database — nor rewritten when anything else changes.
   */
  const rowsDir = `${file.replace(/\.json$/i, '')}.rows`;
  const rowPath = (key) => path.join(rowsDir, `${key}.json`);
  const rowIo = {
    async read(key) {
      try {
        return JSON.parse(fs.readFileSync(rowPath(key), 'utf8'));
      } catch (err) {
        if (err?.code !== 'ENOENT') console.error(`[storage] unreadable row file ${rowPath(key)}: ${err.message}`);
        return null;
      }
    },
    /** No versions on a file store: `etag` is accepted and ignored (one writer per store). */
    async readVersioned(key) {
      return { value: await this.read(key), etag: undefined };
    },
    async write(key, row) {
      const target = rowPath(key);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(row));
        fs.renameSync(tmp, target);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* never written */ }
        throw err;
      }
      return true;
    },
    async remove(key) {
      const target = rowPath(key);
      try { fs.unlinkSync(target); } catch (err) { if (err?.code === 'ENOENT') return false; throw err; }
      try { fs.rmdirSync(path.dirname(target)); } catch { /* not empty, or gone */ }
      return true;
    },
    /** Every row key under `prefix` (`<table>/` or `<table>/<shard>/`). */
    async keys(prefix) {
      const out = [];
      const walk = (dir, rel) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}${e.name}/`);
          else if (e.isFile() && e.name.endsWith('.json')) out.push(`${rel}${e.name.slice(0, -5)}`);
        }
      };
      walk(path.join(rowsDir, prefix), prefix);
      return out;
    },
    lock: withLock,
  };
  const rowTables = new Map();
  const rowTable = (t) => {
    if (!rowTables.has(t)) rowTables.set(t, createRowTable(t, rowIo));
    return rowTables.get(t);
  };
  /**
   * Shard tables (`responses`: one file per assessment under
   * `<store>.rows/shards/responses/<assessment_id>.json`). Rows an earlier version
   * kept in the database file move into their shard file the first time that
   * shard is read; the drop below runs inside the shard lock, so it persists
   * directly rather than through withLock.
   */
  const legacyOf = (t) => ({
    async rows(shardValue) {
      const all = Object.values(table(t));
      if (shardValue === null) return all;
      const { shard } = SHARD_TABLES[t];
      return all.filter((r) => String(r[shard]) === shardValue);
    },
    async drop(ids) {
      const present = ids.filter((id) => rowOf(table(t), id));
      if (!present.length) return;
      mutate(t, present, () => { for (const id of present) delete table(t)[id]; });
    },
  });
  const shardTables = new Map();
  const shardTable = (t) => {
    if (!shardTables.has(t)) shardTables.set(t, createShardTable(t, rowIo, legacyOf(t)));
    return shardTables.get(t);
  };
  /** Detached columns (the assessments paper and report) live in their own files. */
  const detachers = new Map();
  const detacher = (t) => {
    if (!detachers.has(t)) detachers.set(t, createDetacher(t, rowIo));
    return detachers.get(t);
  };

  return {
    kind: 'json-file',
    /**
     * `opts.detached === false` leaves detached columns (see row-tables.mjs
     * DETACHED_COLUMNS) as markers instead of reading one file per row — for
     * listings that only need the small columns.
     */
    async list(t, filter = {}, { detached = true } = {}) {
      if (isRowTable(t)) return rowTable(t).list(filter);
      if (isShardTable(t)) return shardTable(t).list(filter);
      refresh();
      let rows = Object.values(table(t));
      const keys = Object.entries(filter).filter(([, v]) => v !== undefined && v !== null && v !== '');
      if (keys.length) rows = rows.filter((r) => keys.every(([k, v]) => r[k] === v));
      rows = rows.map((r) => ({ ...r }));
      return detached && detacher(t).active ? detacher(t).attachAll(rows) : rows;
    },
    async get(t, id) {
      if (isRowTable(t)) return rowTable(t).get(id);
      if (isShardTable(t)) return shardTable(t).get(id);
      refresh();
      const r = rowOf(table(t), id);
      return r ? detacher(t).attach({ ...r }) : null;
    },
    async insert(t, data) {
      if (isRowTable(t)) return rowTable(t).insert(data);
      if (isShardTable(t)) return shardTable(t).insert(data);
      return withLock(async () => {
        const id = idFor(data);
        assertNew(table(t), id, t);
        const rec = { ...data, id, created_at: data.created_at || new Date().toISOString() };
        const stored = await detacher(t).split(rec);
        return mutate(t, [id], () => {
          table(t)[id] = stored;
          if (t === AUDIT_TABLE) trimAuditRows(table(t));
          return { ...rec };
        });
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
      if (isRowTable(t)) return rowTable(t).insertMany(rows);
      if (isShardTable(t)) return shardTable(t).insertMany(rows);
      return withLock(async () => {
        // Validate the whole batch before touching the table, so a duplicate
        // in row 40 does not leave rows 1-39 half-applied.
        const ids = rows.map(idFor);
        const seen = new Set();
        for (const id of ids) {
          assertNew(table(t), id, t);
          if (seen.has(id)) {
            const err = new Error(`Duplicate id "${id}" within one batch for table "${t}"`);
            err.code = 'DUPLICATE_ID';
            throw err;
          }
          seen.add(id);
        }
        if (!rows.length) return [];
        const stamp = new Date().toISOString();
        const recs = rows.map((data, i) => ({ ...data, id: ids[i], created_at: data.created_at || stamp }));
        const stored = [];
        for (const rec of recs) stored.push(await detacher(t).split(rec));
        return mutate(t, ids, () => {
          for (const rec of stored) table(t)[rec.id] = rec;
          // Rotation applies here too: a bulk audit insert that skipped it would
          // be a hole in the cap.
          if (t === AUDIT_TABLE) trimAuditRows(table(t));
          return recs.map((r) => ({ ...r }));
        });
      });
    },
    async update(t, id, patch) {
      if (isRowTable(t)) return rowTable(t).update(id, patch);
      if (isShardTable(t)) return shardTable(t).update(id, patch);
      const d = detacher(t);
      return withLock(async () => {
        const current = rowOf(table(t), id);
        if (!current) return null;
        // split() also moves a legacy row's inline heavy columns out on its first update
        const stored = await d.split({ ...current, ...patch, id, updated_at: new Date().toISOString() });
        const out = mutate(t, [id], () => {
          table(t)[id] = stored;
          return { ...stored };
        });
        return d.attach(out);
      });
    },
    /**
     * Batch update: one persist for the whole batch, mirroring insertMany.
     * `patches` is an ordered list of { id, patch }; the result mirrors it, with
     * null where the id was not found (same per-row contract as update()).
     */
    async updateMany(t, patches = []) {
      if (isRowTable(t)) return rowTable(t).updateMany(patches);
      if (isShardTable(t)) return shardTable(t).updateMany(patches);
      const d = detacher(t);
      return withLock(async () => {
        if (!patches.some(({ id }) => rowOf(table(t), id))) return patches.map(() => null);
        const stamp = new Date().toISOString();
        const prepared = [];
        for (const { id, patch } of patches) {
          const current = rowOf(table(t), id);
          prepared.push(current ? await d.split({ ...current, ...patch, id, updated_at: stamp }) : null);
        }
        const out = mutate(t, patches.map(({ id }) => id).filter((id) => typeof id === 'string'), () => {
          const rows = table(t);
          return prepared.map((rec) => {
            if (!rec) return null;
            rows[rec.id] = rec;
            return { ...rec };
          });
        });
        return Promise.all(out.map((rec) => (rec ? d.attach(rec) : null)));
      });
    },
    async remove(t, id) {
      if (isRowTable(t)) return rowTable(t).remove(id);
      if (isShardTable(t)) return shardTable(t).remove(id);
      const removed = await withLock(() => {
        if (!rowOf(table(t), id)) return false;
        return mutate(t, [id], () => {
          delete table(t)[id];
          return true;
        });
      });
      if (removed) await detacher(t).drop(id);
      return removed;
    },
    /**
     * Batch delete: one persist for the whole batch (a cascade used to pay a
     * whole-store rewrite per row). Returns how many rows were actually
     * removed; ids that are not present are skipped, as remove() does.
     */
    async removeMany(t, ids = []) {
      if (isRowTable(t)) return rowTable(t).removeMany(ids);
      if (isShardTable(t)) return shardTable(t).removeMany(ids);
      const gone = [];
      const removed = await withLock(() => {
        const present = ids.filter((id) => rowOf(table(t), id));
        if (!present.length) return 0;
        return mutate(t, present, () => {
          const rows = table(t);
          for (const id of present) {
            if (!rowOf(rows, id)) continue;
            delete rows[id];
            gone.push(id);
          }
          return gone.length;
        });
      });
      for (const id of gone) await detacher(t).drop(id);
      return removed;
    },
  };
}
