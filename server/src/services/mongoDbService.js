'use strict';

/**
 * mongoDbService.js
 *
 * MongoDB persistence adapter for the LTS-2026 storage layer.
 * Used when DB_TYPE=mongodb is set in .env.
 *
 * Design:
 *   - Provides the same table names as the JSON store
 *     (cameras, zones, events, alerts, faceGalleries, faceGalleryFaces, settings)
 *   - All documents use `id` (UUID string) as the logical primary key.
 *     MongoDB's own `_id` is kept but never exposed to the application layer.
 *   - Writes are async fire-and-forget from the caller's perspective.
 *   - On startup `loadAll()` hydrates the in-memory store.
 */

const mongoose = require('mongoose');

// ── Table names ──────────────────────────────────────────────────────────────
// Must match ALL_TABLES in db.js — every table written to MongoDB must also be
// loaded on startup, otherwise in-memory store is empty for that table after restart.
const TABLES = [
  'cameras',
  'zones',
  'events',
  'alerts',
  'faceGalleries',
  'faceGalleryFaces',
  'settings',
  'detectionSnapshots',
  'faceMatchHistory',
  'missing_persons',
  'missing_person_detections',
  'analysisEvents',
  'client_logs',
  'client_webrtc_stats',
  'onvif_events',
  'onvif_event_types',
  'detectionTracks',
  'users',
  'refresh_tokens',
  'audit_logs',
];

// Row limits applied when loading high-volume tables from MongoDB on startup.
// Mirrors TABLE_ROW_CAPS in db.js — load only the most recent N rows to keep
// startup fast and avoid exceeding in-memory caps.
const LOAD_LIMITS = {
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
  analysisEvents:            10000,
};

// ── Schema: flexible, identity keyed by `id` ────────────────────────────────
// strict:false lets us store any shape of document without pre-declaring every field.
// timestamps is disabled — db.js manages createdAt/updatedAt as ISO strings.
const flexSchema = new mongoose.Schema(
  { id: { type: String, required: true } },
  {
    strict: false,
    timestamps: false,
    minimize: false,
  },
);
flexSchema.index({ id: 1 }, { unique: true });

/** @type {Record<string, mongoose.Model>} */
const _models = {};

/** Get (or lazily create) the Mongoose model for a given table name. */
function model(table) {
  if (!_models[table]) {
    // Each table → its own MongoDB collection with the same name.
    _models[table] = mongoose.model(table, flexSchema.clone(), table);
  }
  return _models[table];
}

// ── Connection state ─────────────────────────────────────────────────────────
let _connected = false;

/**
 * Connect to MongoDB.
 * Throws on failure — caller should fall back to JSON mode.
 * @param {string} uri   Full MongoDB connection URI
 * @param {string} [dbName]  Override database name (optional)
 */
async function connect(uri, dbName) {
  const opts = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    heartbeatFrequencyMS: 10000,
    maxIdleTimeMS: 60000,
  };
  if (dbName) opts.dbName = dbName;

  await mongoose.connect(uri, opts);
  _connected = true;

  mongoose.connection.on('disconnected', () => {
    _connected = false;
    console.warn('[MongoDB] disconnected — writes will be buffered or lost until reconnect');
  });
  mongoose.connection.on('reconnected', () => {
    _connected = true;
    console.log('[MongoDB] reconnected');
  });
  mongoose.connection.on('error', (err) => {
    console.error('[MongoDB] connection error:', err.message);
  });

  console.log('[MongoDB] connected →', uri);
}

/**
 * Disconnect from MongoDB (used in tests / graceful shutdown).
 */
async function disconnect() {
  if (_connected) {
    await mongoose.disconnect();
    _connected = false;
  }
}

/**
 * Load all table data from MongoDB into plain JS arrays.
 * @returns {Promise<Record<string, Array>>}  Object keyed by table name.
 */
/** Convert any Date objects in a plain document to ISO strings. */
function normalizeDates(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

async function loadAll() {
  const result = {};
  for (const table of TABLES) {
    const limit = LOAD_LIMITS[table];
    // For high-volume tables load only the most recent N rows (sorted by createdAt desc)
    // to bound startup time and stay within in-memory row caps.
    const query = model(table).find({}).lean();
    if (limit) query.sort({ createdAt: -1 }).limit(limit);
    const docs = await query;
    // Strip internal Mongoose fields; normalize any legacy Date objects to ISO strings.
    result[table] = docs.map(({ _id, __v, ...rest }) => normalizeDates(rest));
  }
  return result;
}

/**
 * Upsert a single row by its `id` field.
 * Fire-and-forget safe — errors are logged, not thrown.
 * @param {string} table
 * @param {string} id
 * @param {object} row
 */
async function upsert(table, id, row) {
  if (!_connected) return;
  const { _id, __v, ...clean } = row;
  try {
    await model(table).findOneAndUpdate(
      { id },
      { $set: clean },
      { upsert: true, returnDocument: 'before' },
    );
  } catch (err) {
    console.error(`[MongoDB] upsert ${table}/${id} failed:`, err.message);
  }
}

/**
 * Delete a single row by its `id` field.
 * @param {string} table
 * @param {string} id
 */
async function remove(table, id) {
  if (!_connected) return;
  try {
    await model(table).deleteOne({ id });
  } catch (err) {
    console.error(`[MongoDB] remove ${table}/${id} failed:`, err.message);
  }
}

/**
 * Delete all rows matching a filter object.
 * @param {string} table
 * @param {object} filter   Field → value pairs (all must match)
 */
async function removeWhere(table, filter) {
  if (!_connected) return;
  try {
    await model(table).deleteMany(filter);
  } catch (err) {
    console.error(`[MongoDB] removeWhere ${table} failed:`, err.message);
  }
}

/** @returns {boolean} Whether MongoDB is currently connected */
function isConnected() {
  return _connected;
}

module.exports = {
  TABLES,
  connect,
  disconnect,
  loadAll,
  upsert,
  remove,
  removeWhere,
  isConnected,
};
