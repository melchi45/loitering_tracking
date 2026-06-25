'use strict';

const BaseDatabase = require('./BaseDatabase');
const { ALL_TABLES, TABLE_ROW_CAPS } = require('./constants');

/**
 * MongoDatabase — MongoDB backend for LTS-2026.
 *
 * Uses an in-memory mirror store for synchronous reads (keeps the API
 * contract identical to JsonDatabase). All writes go to MongoDB immediately
 * as async fire-and-forget; the in-memory mirror is updated first so reads
 * are never blocked.
 *
 * When MongoDB disconnects, writes are held in-memory only until reconnect.
 * lts.json is never touched by this backend.
 */
class MongoDatabase extends BaseDatabase {
  constructor() {
    super();
    // In-memory mirror — source of truth for synchronous reads
    this._store = {};
    ALL_TABLES.forEach(t => { this._store[t] = []; });

    this._mongo           = null; // mongoDbService singleton
    this._connected       = false;
    this._fallbackLogged  = false;
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  getMode() { return 'mongodb'; }

  isConnected() {
    return this._connected && this._mongo !== null && this._mongo.isConnected();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init() {
    const uri    = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB_NAME || undefined;

    if (!uri) throw new Error('MONGODB_URI is not set');

    this._mongo = require('../services/mongoDbService');
    await this._mongo.connect(uri, dbName);
    this._connected = true;

    const snapshot = await this._mongo.loadAll();
    for (const table of ALL_TABLES) {
      // Accept the MongoDB snapshot as-is — empty arrays are valid (new deployment).
      // Never seed from lts.json to avoid stale local data contaminating shared MongoDB.
      if (Array.isArray(snapshot[table])) {
        this._store[table] = snapshot[table];
      }
    }
    console.log('[DB] Storage mode: MongoDB (all writes go to MongoDB only)');
  }

  flushNow() {
    // MongoDB writes are async fire-and-forget — nothing to flush synchronously.
  }

  close() {
    super.close();
    this._connected = false;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  insert(table, row) {
    this._counts.inserts++;
    const now = new Date().toISOString();
    const record = { createdAt: now, updatedAt: now, ...row };
    if (!Array.isArray(this._store[table])) this._store[table] = [];
    this._store[table].push(record);
    const cap = TABLE_ROW_CAPS[table];
    if (cap && this._store[table].length > cap) {
      this._store[table] = this._store[table].slice(-cap);
    }
    this._persist('upsert', table, record.id, record);
  }

  update(table, id, data) {
    this._counts.updates++;
    if (!Array.isArray(this._store[table])) return;
    let updated = null;
    this._store[table] = this._store[table].map(r => {
      if (r.id !== id) return r;
      updated = { ...r, ...data, updatedAt: new Date().toISOString() };
      return updated;
    });
    if (updated) this._persist('upsert', table, id, updated);
  }

  delete(table, id) {
    this._counts.deletes++;
    if (!Array.isArray(this._store[table])) return;
    this._store[table] = this._store[table].filter(r => r.id !== id);
    this._persist('remove', table, id, null);
  }

  find(table, where = {}) {
    this._counts.finds++;
    if (!Array.isArray(this._store[table])) return [];
    return this._store[table].filter(r => _match(r, where));
  }

  findOne(table, where = {}) {
    this._counts.finds++;
    if (!Array.isArray(this._store[table])) return null;
    return this._store[table].find(r => _match(r, where)) || null;
  }

  all(table) {
    this._counts.finds++;
    if (!Array.isArray(this._store[table])) return [];
    return [...this._store[table]];
  }

  /**
   * Override: query MongoDB directly for tables that are NOT fully hydrated
   * in the in-memory store at startup (e.g. onvif_snapshots, whose frameData
   * blobs make loading all rows into RAM impractical).
   *
   * Falls back to the synchronous in-memory find() when MongoDB is offline
   * or for tables that ARE fully in-memory (works correctly either way).
   */
  async queryAsync(table, where = {}, sort = {}, limit = null) {
    if (this.isConnected()) {
      try {
        return await this._mongo.findDirect(table, where, sort, limit);
      } catch (e) {
        console.error(`[DB:mongo] queryAsync ${table} failed, falling back to memory:`, e.message);
      }
    }
    // Fallback: in-memory (may be empty for non-hydrated tables when offline)
    return super.queryAsync(table, where, sort, limit);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _persist(op, table, id, row) {
    if (this.isConnected()) {
      this._fallbackLogged = false;
      if (op === 'remove') {
        this._mongo.remove(table, id).catch(e =>
          console.error('[DB:mongo] remove failed:', e.message)
        );
      } else {
        this._mongo.upsert(table, id, row).catch(e =>
          console.error('[DB:mongo] upsert failed:', e.message)
        );
      }
      return;
    }
    // Disconnected: hold in-memory only — no JSON fallback
    if (!this._fallbackLogged) {
      console.error('[DB:mongo] Disconnected — writes held in-memory until reconnect (no JSON fallback)');
      this._fallbackLogged = true;
    }
  }
}

function _match(row, where) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

module.exports = MongoDatabase;
