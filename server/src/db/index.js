'use strict';

/**
 * db/index.js — Database factory + backward-compatible public API.
 *
 * Supported backends (DB_TYPE env var):
 *   json     → JsonDatabase   (default, no external dependency)
 *   mongodb  → MongoDatabase
 *
 * Adding a new backend:
 *   1. Create server/src/db/SqliteDatabase.js  extending BaseDatabase
 *   2. Add a case in _createBackend() below
 *   3. Set DB_TYPE=sqlite in server/.env
 *
 * Public API (unchanged from legacy db.js — all consumers work as-is):
 *   initDB()          → Promise<BaseDatabase>
 *   getDB()           → BaseDatabase
 *   getStorageMode()  → 'json' | 'mongodb' | …
 *   getDbStats()          → { mode, connected, rates, cumulative }
 *   getDbDetailedStats()  → Promise<{ ...getDbStats(), tables, totalRows, totalDataBytes, diskUsage }>
 *   flushNow()            → Promise<void>
 */

const JsonDatabase  = require('./JsonDatabase');
const MongoDatabase = require('./MongoDatabase');
const { backfillChannelSlots } = require('../services/channelSlotService');

let _db = null;

// One-time field-rename migration (2026-08-10): the RTSP-over-WebSocket streaming
// mode's boolean flag was renamed from `umpEnabled` to `rtspOverWebSocketEnabled`
// (see server/src/api/cameras.js's streamingModeToFlags()/deriveStreamingMode()).
// Only migrates cameras that still have the legacy field but not yet the new one —
// idempotent, safe to run on every startup. The stale `umpEnabled` key is left in
// place rather than unset — BaseDatabase.update() only supports $set-style merges,
// and MongoDatabase's upsert() (mongoDbService.js's findOneAndUpdate $set) silently
// drops `undefined` values instead of unsetting the field, so there's no reliable
// cross-backend way to actually remove it here. It's harmless dead data: no code
// reads `umpEnabled` after this migration runs.
function _migrateRtspOverWebSocketField(db) {
  const cameras = db.all('cameras');
  let migrated = 0;
  for (const cam of cameras) {
    if (cam.umpEnabled === undefined || cam.rtspOverWebSocketEnabled !== undefined) continue;
    db.update('cameras', cam.id, { rtspOverWebSocketEnabled: !!cam.umpEnabled });
    migrated++;
  }
  if (migrated > 0) {
    console.log(`[DB] Migrated umpEnabled -> rtspOverWebSocketEnabled for ${migrated} camera(s)`);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

function _createBackend(type) {
  switch (type) {
    case 'mongodb': return new MongoDatabase();
    case 'json':    return new JsonDatabase();
    default:
      console.warn(`[DB] Unknown DB_TYPE="${type}" — falling back to JSON`);
      return new JsonDatabase();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function initDB() {
  const type = (process.env.DB_TYPE || 'json').toLowerCase();

  if (type === 'mongodb') {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      // No URI — hard error: do NOT create lts.json when operator chose mongodb
      throw new Error('[DB] DB_TYPE=mongodb but MONGODB_URI is not set. Set MONGODB_URI in server/.env or change DB_TYPE=json.');
    }
    const backend = _createBackend('mongodb');
    // Init failure is a hard error — never fall back to JsonDatabase when DB_TYPE=mongodb.
    // Falling back would silently write all data to lts.json and corrupt the mongo dataset.
    await backend.init();
    _db = backend;
  } else {
    _db = _createBackend(type);
    await _db.init();
  }

  // Channel Slot backfill migration — runs once per startup, before any
  // camera-management API request can be accepted (NFR-CH-03). Idempotent.
  // See docs/design/Design_Channel_Slot.md §4.4.
  backfillChannelSlots(_db);
  _migrateRtspOverWebSocketField(_db);

  return _db;
}

function getDB() {
  if (!_db) throw new Error('[DB] Not initialised — call initDB() first');
  return _db;
}

function getStorageMode() {
  return _db ? _db.getMode() : 'unknown';
}

function getDbStats() {
  return _db
    ? _db.getStats()
    : { mode: 'unknown', connected: false, rates: {}, cumulative: {} };
}

async function getDbDetailedStats() {
  return _db
    ? _db.getDetailedStats()
    : { mode: 'unknown', connected: false, rates: {}, cumulative: {}, tables: [], totalRows: 0, totalDataBytes: 0, diskUsage: null };
}

async function flushNow() {
  if (_db) await _db.flushNow();
}

module.exports = { initDB, getDB, getStorageMode, getDbStats, getDbDetailedStats, flushNow };
