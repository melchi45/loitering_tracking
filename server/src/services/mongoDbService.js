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
const TABLES = [
  'cameras',
  'zones',
  'events',
  'alerts',
  'faceGalleries',
  'faceGalleryFaces',
  'settings',       // single-document settings (face tracking state etc.)
];

// ── Schema: flexible, identity keyed by `id` ────────────────────────────────
// strict:false lets us store any shape of document without pre-declaring every field.
const flexSchema = new mongoose.Schema(
  { id: { type: String, required: true } },
  {
    strict: false,
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
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
    socketTimeoutMS: 30000,
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
async function loadAll() {
  const result = {};
  for (const table of TABLES) {
    const docs = await model(table).find({}).lean();
    // Strip internal Mongoose fields before handing to the application layer
    result[table] = docs.map(({ _id, __v, ...rest }) => rest);
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
      { upsert: true, new: false },
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
