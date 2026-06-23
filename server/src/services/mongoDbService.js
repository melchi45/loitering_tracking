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
 *   - Keep-alive ping every 5 s — logs connection state and round-trip latency.
 *   - On disconnect: automatic retry with linear back-off (3 s × attempt, max 30 s).
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

// ── Connection state ──────────────────────────────────────────────────────────
let _connected        = false;
let _uri              = null;
let _connectOpts      = null;
let _keepAliveTimer   = null;
let _retryTimer       = null;
let _retryCount       = 0;
let _listenersSet     = false;   // guards against duplicate event registration

const KEEPALIVE_MS  = 5000;   // ping interval
const RETRY_STEP_MS = 3000;   // linear back-off step
const RETRY_MAX_MS  = 30000;  // ceiling for retry delay

// ── Keep-alive ────────────────────────────────────────────────────────────────

function _startKeepAlive() {
  if (_keepAliveTimer) return;
  _keepAliveTimer = setInterval(async () => {
    const state = mongoose.connection.readyState;
    // 0=disconnected 1=connected 2=connecting 3=disconnecting
    const labels = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const label  = labels[state] ?? String(state);

    if (state === 1) {
      try {
        const t0 = Date.now();
        await mongoose.connection.db.command({ ping: 1 });
        console.log(`[MongoDB] keep-alive ✓ connected | ping ${Date.now() - t0}ms | URI: ${_uri}`);
      } catch (err) {
        console.warn(`[MongoDB] keep-alive ping 실패: ${err.message}`);
      }
    } else {
      console.warn(`[MongoDB] keep-alive — 상태: ${label} | URI: ${_uri}`);
    }
  }, KEEPALIVE_MS);
}

function _stopKeepAlive() {
  if (_keepAliveTimer) {
    clearInterval(_keepAliveTimer);
    _keepAliveTimer = null;
  }
}

// ── Retry ─────────────────────────────────────────────────────────────────────

function _cancelRetry() {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
  _retryCount = 0;
}

function _scheduleRetry() {
  if (_retryTimer) return;   // retry already queued
  if (_connected)  return;   // reconnected while we were deciding

  _retryCount++;
  const delay = Math.min(RETRY_STEP_MS * _retryCount, RETRY_MAX_MS);
  console.warn(
    `[MongoDB] 재연결 대기 #${_retryCount} — ${(delay / 1000).toFixed(0)}초 후 재시도 | URI: ${_uri}`
  );

  _retryTimer = setTimeout(async () => {
    _retryTimer = null;
    if (_connected) { _cancelRetry(); return; }

    console.log(`[MongoDB] 재연결 시도 #${_retryCount} | URI: ${_uri}`);
    try {
      await mongoose.connect(_uri, _connectOpts);
      // 성공 시 'reconnected' 이벤트가 발생해 _connected = true + _cancelRetry() 처리됨
    } catch (err) {
      console.error(`[MongoDB] 재연결 실패 #${_retryCount}: ${err.message}`);
      _scheduleRetry();   // next attempt
    }
  }, delay);
}

// ── Event listeners (singleton, registered once) ──────────────────────────────

function _attachListeners() {
  if (_listenersSet) return;
  _listenersSet = true;

  mongoose.connection.on('disconnected', () => {
    _connected = false;
    console.warn('[MongoDB] 연결 끊김 — 재연결 시도를 시작합니다');
    _scheduleRetry();
  });

  mongoose.connection.on('reconnected', () => {
    _connected = true;
    _cancelRetry();
    console.log(`[MongoDB] 재연결 성공 | URI: ${_uri}`);
  });

  mongoose.connection.on('error', (err) => {
    console.error('[MongoDB] 연결 오류:', err.message);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Connect to MongoDB.
 * Starts keep-alive pings and sets up disconnect-retry on success.
 * Throws on failure — caller (MongoDatabase.init) should propagate the error.
 * @param {string} uri       Full MongoDB connection URI
 * @param {string} [dbName]  Override database name (optional)
 */
async function connect(uri, dbName) {
  _uri = uri;
  _connectOpts = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS:          45000,
    heartbeatFrequencyMS:     10000,
    maxIdleTimeMS:            60000,
  };
  if (dbName) _connectOpts.dbName = dbName;

  _attachListeners();   // idempotent — safe to call every time
  await mongoose.connect(uri, _connectOpts);
  _connected = true;

  console.log(`[MongoDB] connected | URI: ${uri}`);
  _startKeepAlive();
}

/**
 * Disconnect from MongoDB (used in tests / graceful shutdown).
 */
async function disconnect() {
  _stopKeepAlive();
  _cancelRetry();
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
