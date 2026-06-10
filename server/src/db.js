'use strict';

/**
 * db.js — In-memory JSON store with optional MongoDB write-through.
 *
 * Storage modes (controlled by DB_TYPE in .env):
 *   DB_TYPE=json     (default) — read/write storage/lts.json synchronously.
 *   DB_TYPE=mongodb  — on startup load from MongoDB; writes go to MongoDB
 *                      (async, fire-and-forget) AND to JSON as hot-standby.
 *
 * The in-memory store is always the source of truth for synchronous reads,
 * keeping the existing synchronous API unchanged for all route handlers.
 *
 * Tables: cameras, zones, events, alerts, faceGalleries, faceGalleryFaces
 */

const fs   = require('fs');
const path = require('path');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '..', 'storage');

if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true });

const DB_PATH = path.join(STORAGE_PATH, 'lts.json');

// ── In-memory store ──────────────────────────────────────────────────────────
const ALL_TABLES = ['cameras', 'zones', 'events', 'alerts', 'faceGalleries', 'faceGalleryFaces', 'settings', 'detectionSnapshots', 'faceMatchHistory', 'missing_persons', 'missing_person_detections', 'analysisEvents'];

let store = {};
ALL_TABLES.forEach(t => { store[t] = []; });

// ── Optional MongoDB service (lazy-loaded when DB_TYPE=mongodb) ──────────────
/** @type {import('./services/mongoDbService') | null} */
let mongoSvc = null;

function _isMongo() {
  return process.env.DB_TYPE === 'mongodb' && mongoSvc !== null && mongoSvc.isConnected();
}

// ── JSON persistence ─────────────────────────────────────────────────────────
function loadFromJson() {
  if (fs.existsSync(DB_PATH)) {
    try { store = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (_) {}
  }
  for (const t of ALL_TABLES) {
    if (!Array.isArray(store[t])) store[t] = [];
  }
}

const TEMP_DB_PATH = DB_PATH + '.tmp';

/**
 * Write full store to lts.json using an atomic temp-file-then-rename pattern.
 * This prevents a partially-written (corrupt) file if the process is killed
 * mid-write.  Debounced to at most once every PERSIST_DEBOUNCE_MS to avoid
 * blocking the event loop when many rows are inserted in rapid succession
 * (e.g., detectionSnapshots during live streaming).
 */
const PERSIST_DEBOUNCE_MS = 2000; // write at most once per 2 s
let   _persistTimer = null;
let   _persistPending = false;

function persistJson() {
  _persistPending = true;
  if (_persistTimer) return;            // already scheduled — just flag & exit
  _persistTimer = setTimeout(() => {
    _persistTimer  = null;
    _persistPending = false;
    _flushJson();
  }, PERSIST_DEBOUNCE_MS);
}

// Tables safe to omit from the JSON backup when MongoDB holds them — these are
// high-volume write streams that can exceed V8's JSON string limit and are
// already durably stored in MongoDB.
const MONGO_ONLY_TABLES = new Set([
  'events', 'alerts', 'detectionSnapshots', 'faceMatchHistory', 'missing_person_detections',
]);

// Max rows kept in-memory per table. Oldest records are evicted when the cap is
// exceeded. Prevents unbounded memory growth when MongoDB is unavailable (DB_TYPE=json
// fallback) and the process runs for an extended period.
const TABLE_ROW_CAPS = {
  events:                    20000,
  alerts:                    10000,
  detectionSnapshots:         2000,
  faceMatchHistory:           5000,
  missing_person_detections:  5000,
};

/** Synchronous atomic write: write to .tmp, then rename to final path. */
function _flushJson() {
  try {
    // When MongoDB is active, skip large transactional tables to stay under V8's
    // ~512 MB JSON string limit. Config tables (cameras, zones, …) are always included.
    const payload = _isMongo()
      ? Object.fromEntries(Object.entries(store).filter(([t]) => !MONGO_ONLY_TABLES.has(t)))
      : store;
    fs.writeFileSync(TEMP_DB_PATH, JSON.stringify(payload, null, 2));
    fs.renameSync(TEMP_DB_PATH, DB_PATH);
  } catch (err) {
    console.error('[DB] JSON persist error:', err.message);
    // Clean up temp file if it was created
    try { if (fs.existsSync(TEMP_DB_PATH)) fs.unlinkSync(TEMP_DB_PATH); } catch (_) {}
  }
}

/** Flush any pending write immediately (call on graceful shutdown). */
function flushNow() {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  if (_persistPending) {
    _persistPending = false;
    _flushJson();
  }
}

// ── Row-level persistence dispatcher ─────────────────────────────────────────
/**
 * Called after every in-memory mutation.
 * Writes to MongoDB (async) when connected; always writes JSON backup.
 */
function afterWrite(table, id, row, op) {
  if (_isMongo()) {
    if (op === 'delete') {
      mongoSvc.remove(table, id).catch(e => console.error('[DB] mongo remove:', e.message));
    } else {
      mongoSvc.upsert(table, id, row).catch(e => console.error('[DB] mongo upsert:', e.message));
    }
  }
  // JSON is always written (serves as warm standby / offline fallback)
  persistJson();
}

/**
 * Called when a WHERE-based delete removes multiple rows.
 * Re-syncs the whole table in MongoDB.
 */
function afterDeleteWhere(table, removedIds) {
  if (_isMongo()) {
    removedIds.forEach(id =>
      mongoSvc.remove(table, id).catch(e => console.error('[DB] mongo removeWhere:', e.message))
    );
  }
  persistJson();
}

// ── SQL-like helpers ─────────────────────────────────────────────────────────
function matchRow(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

// ── Statement factory — mirrors better-sqlite3 prepare() ────────────────────
function makeStmt(table, op, opts = {}) {
  return {
    all(params = {}) {
      const rows = store[table].filter(r => matchRow(r, params));
      if (opts.orderBy) rows.sort((a, b) => (a[opts.orderBy] > b[opts.orderBy] ? -1 : 1));
      if (opts.limit) return rows.slice(0, opts.limit);
      return rows;
    },
    get(params = {}) {
      return store[table].find(r => matchRow(r, params)) || null;
    },
    run(params = {}) {
      if (op === 'insert') {
        const now = new Date().toISOString();
        const row = { createdAt: now, ...params };
        store[table].push(row);
        afterWrite(table, row.id, row, 'insert');
        return { changes: 1, lastInsertRowid: row.id };
      }
      if (op === 'update') {
        const { _where, ...data } = params;
        let changes = 0;
        store[table] = store[table].map(r => {
          if (!matchRow(r, _where)) return r;
          changes++;
          const updated = { ...r, ...data };
          afterWrite(table, updated.id, updated, 'update');
          return updated;
        });
        return { changes };
      }
      if (op === 'delete') {
        const removed = store[table].filter(r => matchRow(r, params));
        store[table] = store[table].filter(r => !matchRow(r, params));
        afterDeleteWhere(table, removed.map(r => r.id));
        return { changes: removed.length };
      }
      return { changes: 0 };
    },
  };
}

// ── Public DB object ─────────────────────────────────────────────────────────
const db = {
  pragma() { return this; },
  exec() { return this; },

  prepare(sql) {
    const s = sql.trim().toLowerCase();
    const tableMatch = s.match(/(?:from|into|update|table)\s+(\w+)/);
    const table = tableMatch ? tableMatch[1] : null;

    if (!table || !store[table]) {
      return { all: () => [], get: () => null, run: () => ({ changes: 0 }) };
    }

    const opts = {};
    const orderMatch = sql.match(/ORDER BY\s+(\w+)/i);
    if (orderMatch) opts.orderBy = orderMatch[1];
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) opts.limit = parseInt(limitMatch[1]);

    if (s.startsWith('select'))  return makeStmt(table, 'select', opts);
    if (s.startsWith('insert'))  return makeStmt(table, 'insert', opts);
    if (s.startsWith('update'))  return makeStmt(table, 'update', opts);
    if (s.startsWith('delete'))  return makeStmt(table, 'delete', opts);

    return { all: () => [], get: () => null, run: () => ({ changes: 0 }) };
  },

  _tables: store,

  // ── Shorthand helpers used by route handlers ─────────────────────────────
  insert(table, row) {
    const now = new Date().toISOString();
    const inserted = { createdAt: now, updatedAt: now, ...row };
    store[table].push(inserted);
    // Prevent unbounded in-memory growth for high-volume transactional tables.
    // Oldest records are dropped first; MongoDB / snapshotService handle durable retention.
    const cap = TABLE_ROW_CAPS[table];
    if (cap && store[table].length > cap) store[table] = store[table].slice(-cap);
    afterWrite(table, inserted.id, inserted, 'insert');
  },
  update(table, id, data) {
    store[table] = store[table].map(r => {
      if (r.id !== id) return r;
      const updated = { ...r, ...data, updatedAt: new Date().toISOString() };
      afterWrite(table, id, updated, 'update');
      return updated;
    });
  },
  delete(table, id) {
    store[table] = store[table].filter(r => r.id !== id);
    afterWrite(table, id, null, 'delete');
  },
  find(table, where = {}) {
    return store[table].filter(r => matchRow(r, where));
  },
  findOne(table, where = {}) {
    return store[table].find(r => matchRow(r, where)) || null;
  },
  all(table) {
    return [...store[table]];
  },
};

// ── Initialisation ───────────────────────────────────────────────────────────
/**
 * Initialise the database.
 *
 * - Always loads lts.json first (warm start / fallback).
 * - If DB_TYPE=mongodb and MONGODB_URI is set, connects to MongoDB and
 *   replaces in-memory data with the MongoDB snapshot.
 *   Falls back silently to JSON-only if MongoDB is unreachable.
 *
 * @returns {Promise<typeof db>}
 */
async function initDB() {
  loadFromJson(); // always: warm start from JSON

  if (process.env.DB_TYPE === 'mongodb') {
    const uri    = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB_NAME || undefined;

    if (!uri) {
      console.warn('[DB] DB_TYPE=mongodb but MONGODB_URI is not set — falling back to JSON');
    } else {
      try {
        mongoSvc = require('./services/mongoDbService');
        await mongoSvc.connect(uri, dbName);

        const snapshot = await mongoSvc.loadAll();
        // Merge: MongoDB data takes precedence over the JSON snapshot
        for (const table of ALL_TABLES) {
          if (Array.isArray(snapshot[table]) && snapshot[table].length > 0) {
            store[table] = snapshot[table];
          }
          // If MongoDB collection is empty and JSON has data, keep JSON data
          // and schedule a one-time sync to MongoDB
          else if (store[table].length > 0) {
            console.log(`[DB] MongoDB ${table} empty — seeding from JSON (${store[table].length} rows)`);
            const rows = [...store[table]];
            rows.forEach(row =>
              mongoSvc.upsert(table, row.id, row).catch(e =>
                console.error('[DB] seed upsert error:', e.message)
              )
            );
          }
        }
        console.log('[DB] Storage mode: MongoDB (JSON as hot-standby backup)');
        // Sync JSON with the MongoDB snapshot so the hot-standby is up-to-date
        // even if the server crashed before the last debounced write completed.
        _flushJson();
      } catch (err) {
        console.warn('[DB] MongoDB connection failed — falling back to JSON:', err.message);
        mongoSvc = null;
      }
    }
  } else {
    console.log('[DB] Storage mode: JSON (', DB_PATH, ')');
  }

  return db;
}

function getDB() {
  return db;
}

/** Returns the active storage mode: 'mongodb' | 'json' */
function getStorageMode() {
  return _isMongo() ? 'mongodb' : 'json';
}

module.exports = { initDB, getDB, getStorageMode, flushNow };

