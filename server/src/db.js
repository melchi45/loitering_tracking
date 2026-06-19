'use strict';

/**
 * db.js — In-memory JSON store with optional MongoDB write-through.
 *
 * Storage modes (controlled by DB_TYPE in .env):
 *   DB_TYPE=json     (default) — read/write storage/lts.json (async, debounced).
 *   DB_TYPE=mongodb  — on startup load from MongoDB; ALL writes go to MongoDB only.
 *                      lts.json is loaded on startup as warm-start fallback but
 *                      never written during normal operation.
 *                      If MongoDB disconnects, writes fall back to JSON automatically.
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
const ALL_TABLES = ['cameras', 'zones', 'events', 'alerts', 'faceGalleries', 'faceGalleryFaces', 'settings', 'detectionSnapshots', 'faceMatchHistory', 'missing_persons', 'missing_person_detections', 'analysisEvents', 'client_logs', 'client_webrtc_stats', 'onvif_events', 'onvif_event_types', 'detectionTracks', 'users', 'refresh_tokens', 'audit_logs'];

let store = {};
ALL_TABLES.forEach(t => { store[t] = []; });

// ── Optional MongoDB service (lazy-loaded when DB_TYPE=mongodb) ──────────────
/** @type {import('./services/mongoDbService') | null} */
let mongoSvc = null;

function _isMongo() {
  return process.env.DB_TYPE === 'mongodb' && mongoSvc !== null && mongoSvc.isConnected();
}

// ── JSON persistence (DB_TYPE=json only) ─────────────────────────────────────
function loadFromJson() {
  if (fs.existsSync(DB_PATH)) {
    try { store = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (_) {}
  }
  for (const t of ALL_TABLES) {
    if (!Array.isArray(store[t])) store[t] = [];
  }
}

const TEMP_DB_PATH = DB_PATH + '.tmp';

// Debounce: write at most once per 2 s to avoid event-loop pressure during
// rapid inserts (e.g. detectionSnapshots during live streaming).
const PERSIST_DEBOUNCE_MS = 2000;
let   _persistTimer   = null;
let   _persistPending = false;
let   _writingJson    = false; // one async write at a time

function persistJson() {
  _persistPending = true;
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer   = null;
    _persistPending = false;
    _flushJson().catch(err => console.error('[DB] persist error:', err.message));
  }, PERSIST_DEBOUNCE_MS);
}

// Max rows kept in-memory per table. Oldest records are evicted when the cap is
// exceeded. Prevents unbounded memory growth during extended JSON-mode operation.
const TABLE_ROW_CAPS = {
  events:                    20000,
  alerts:                    10000,
  detectionSnapshots:         2000,
  faceMatchHistory:           5000,
  missing_person_detections:  5000,
  client_logs:               10000,
  client_webrtc_stats:        5000,
  onvif_events:              50000,
  detectionTracks:           10000,
  refresh_tokens:            10000,
  audit_logs:                10000,
};

// Tables excluded from the JSON fallback write when MongoDB is (or was) the primary store.
// These are high-volume transactional tables whose base64/binary payloads can reach
// 20–100 MB when serialized — skipping them avoids event-loop stalls during fallback
// writes and keeps lts.json small. Config and identity tables (cameras, zones, users…)
// are always included so the server can restart cleanly without MongoDB.
const JSON_FALLBACK_SKIP = new Set([
  'detectionSnapshots',
  'client_logs',
  'client_webrtc_stats',
  'onvif_events',
  'detectionTracks',
  'analysisEvents',
  'faceMatchHistory',
  'missing_person_detections',
  'events',
  'audit_logs',
]);

/**
 * Async atomic write: serialize store → .tmp, then rename to final path.
 * Only called when DB_TYPE=json (or MongoDB has disconnected as fallback).
 * Non-blocking: uses fs.promises so the event loop is never stalled.
 */
async function _flushJson() {
  if (_writingJson) return; // concurrent write already in progress
  _writingJson = true;
  try {
    // Skip high-volume tables in fallback mode to avoid event-loop stalls.
    const payload = process.env.DB_TYPE === 'mongodb'
      ? Object.fromEntries(Object.entries(store).filter(([t]) => !JSON_FALLBACK_SKIP.has(t)))
      : store;
    const json = JSON.stringify(payload, null, 2);
    await fs.promises.writeFile(TEMP_DB_PATH, json);
    await fs.promises.rename(TEMP_DB_PATH, DB_PATH);
  } catch (err) {
    console.error('[DB] JSON persist error:', err.message);
    try { await fs.promises.unlink(TEMP_DB_PATH); } catch (_) {}
  } finally {
    _writingJson = false;
  }
}

/**
 * Flush any pending write immediately (graceful shutdown — sync is acceptable here).
 * Skips if an async _flushJson() is already mid-flight to avoid .tmp file collision.
 */
function flushNow() {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  if (_persistPending) {
    _persistPending = false;
    if (_writingJson) return; // async write in progress — it will complete on its own
    try {
      const payload = process.env.DB_TYPE === 'mongodb'
        ? Object.fromEntries(Object.entries(store).filter(([t]) => !JSON_FALLBACK_SKIP.has(t)))
        : store;
      fs.writeFileSync(TEMP_DB_PATH, JSON.stringify(payload, null, 2));
      fs.renameSync(TEMP_DB_PATH, DB_PATH);
    } catch (err) {
      console.error('[DB] flushNow persist error:', err.message);
      try { if (fs.existsSync(TEMP_DB_PATH)) fs.unlinkSync(TEMP_DB_PATH); } catch (_) {}
    }
  }
}

// ── DB query statistics ───────────────────────────────────────────────────────
const _dbCounts = { inserts: 0, updates: 0, deletes: 0, finds: 0 };
let   _dbRates  = { insertsPerSec: 0, updatesPerSec: 0, deletesPerSec: 0, findsPerSec: 0, totalPerSec: 0 };
let   _dbLastSample   = { inserts: 0, updates: 0, deletes: 0, finds: 0 };
let   _dbLastSampleAt = Date.now();

const _dbRateTimer = setInterval(() => {
  const now = Date.now();
  const dt  = (now - _dbLastSampleAt) / 1000;
  if (dt > 0) {
    const d = (k) => Math.max(0, Math.round((_dbCounts[k] - _dbLastSample[k]) / dt));
    _dbRates = {
      insertsPerSec: d('inserts'),
      updatesPerSec: d('updates'),
      deletesPerSec: d('deletes'),
      findsPerSec:   d('finds'),
      totalPerSec:   d('inserts') + d('updates') + d('deletes') + d('finds'),
    };
    _dbLastSample   = { ..._dbCounts };
    _dbLastSampleAt = now;
  }
}, 2000);
_dbRateTimer.unref();

// ── Row-level persistence dispatcher ─────────────────────────────────────────
/**
 * Called after every in-memory mutation.
 * - MongoDB mode: write to MongoDB only (no JSON backup).
 * - JSON mode: schedule debounced JSON write.
 * If MongoDB disconnects mid-session, _isMongo() returns false and writes
 * automatically fall back to JSON until the connection is restored.
 */
let _jsonFallbackLogged = false;

function afterWrite(table, id, row, op) {
  if (op === 'delete') {
    _dbCounts.deletes++;
  } else if (op === 'insert') {
    _dbCounts.inserts++;
  } else {
    _dbCounts.updates++;
  }

  if (_isMongo()) {
    _jsonFallbackLogged = false;
    if (op === 'delete') {
      mongoSvc.remove(table, id).catch(e => console.error('[DB] mongo remove:', e.message));
    } else {
      mongoSvc.upsert(table, id, row).catch(e => console.error('[DB] mongo upsert:', e.message));
    }
    return; // MongoDB is the sole persistent store — skip JSON
  }
  if (process.env.DB_TYPE === 'mongodb' && !_jsonFallbackLogged) {
    console.warn('[DB] MongoDB not connected — falling back to lts.json until reconnect');
    _jsonFallbackLogged = true;
  }
  persistJson();
}

/**
 * Called when a WHERE-based delete removes multiple rows.
 */
function afterDeleteWhere(table, removedIds) {
  _dbCounts.deletes += removedIds.length;

  if (_isMongo()) {
    removedIds.forEach(id =>
      mongoSvc.remove(table, id).catch(e => console.error('[DB] mongo removeWhere:', e.message))
    );
    return; // MongoDB is the sole persistent store — skip JSON
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
    _dbCounts.finds++;
    return store[table].filter(r => matchRow(r, where));
  },
  findOne(table, where = {}) {
    _dbCounts.finds++;
    return store[table].find(r => matchRow(r, where)) || null;
  },
  all(table) {
    _dbCounts.finds++;
    return [...store[table]];
  },
};

// ── Initialisation ───────────────────────────────────────────────────────────
/**
 * Initialise the database.
 *
 * - Always loads lts.json first as warm-start fallback.
 * - If DB_TYPE=mongodb and MONGODB_URI is set, connects to MongoDB and
 *   replaces in-memory data with the MongoDB snapshot.
 *   Falls back silently to JSON-only if MongoDB is unreachable.
 *
 * @returns {Promise<typeof db>}
 */
// Legacy separate JSON files used before db.js unified them.
// Migrated on first startup when the table is empty in lts.json.
const LEGACY_MIGRATIONS = [
  { table: 'users',          file: 'users.json',  key: 'users' },
  { table: 'refresh_tokens', file: 'tokens.json', key: 'refreshTokens' },
  { table: 'audit_logs',     file: 'audit.json',  key: 'events' },
];

async function initDB() {
  loadFromJson(); // always: warm start from JSON (fallback snapshot)

  // One-time migration: load from legacy separate JSON files if tables are empty
  for (const { table, file, key } of LEGACY_MIGRATIONS) {
    if (store[table].length === 0) {
      const legacyPath = path.join(STORAGE_PATH, file);
      if (fs.existsSync(legacyPath)) {
        try {
          const raw  = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
          const rows = raw[key];
          if (Array.isArray(rows) && rows.length > 0) {
            store[table] = rows;
            console.log(`[DB] Migrated ${rows.length} rows: ${file} → ${table} (original file kept)`);
          }
        } catch (e) {
          console.warn(`[DB] Migration from ${file} failed:`, e.message);
        }
      }
    }
  }

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
          // If MongoDB collection is empty and JSON has data, seed MongoDB from JSON
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
        console.log('[DB] Storage mode: MongoDB (all writes go to MongoDB only)');
        // lts.json is no longer written during normal operation in MongoDB mode.
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

/** Returns DB query statistics (rates/sec and cumulative counts). */
function getDbStats() {
  return {
    mode:      _isMongo() ? 'mongodb' : 'json',
    connected: _isMongo(),
    rates:     { ..._dbRates },
    cumulative: { ..._dbCounts },
  };
}

module.exports = { initDB, getDB, getStorageMode, getDbStats, flushNow };
