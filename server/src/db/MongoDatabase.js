'use strict';

const BaseDatabase = require('./BaseDatabase');
const { ALL_TABLES, TABLE_ROW_CAPS } = require('./constants');

// Tables whose MongoDB-side lifecycle is owned by snapshotArchiveService.js
// (date-based retention, image blob archived to storage/archive/ before
// deletion) instead of by the count-based cap below. Skipping the immediate
// cap-triggered Mongo delete here prevents a write burst from silently
// deleting images before the archive job ever sees them — the in-memory
// mirror is still trimmed for RAM safety, only the real Mongo delete is
// deferred to the archive job's own purge step.
const ARCHIVED_TABLES = new Set(['onvif_snapshots', 'detectionSnapshots']);

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
      // Trimming the in-memory mirror alone leaves the real MongoDB collection
      // growing unbounded forever (confirmed live 2026-07-20: detectionSnapshots
      // capped at 2000 in-memory but 7.27M documents / 38GB in MongoDB,
      // onvif_snapshots 2000 vs 242K / 40GB) — every table using TABLE_ROW_CAPS
      // was silently affected. Evicted ids are deleted from Mongo too via the
      // existing `id` unique index, so this stays cheap even on huge collections.
      const evictedIds = this._store[table].slice(0, this._store[table].length - cap).map(r => r.id).filter(Boolean);
      this._store[table] = this._store[table].slice(-cap);
      if (evictedIds.length > 0 && !ARCHIVED_TABLES.has(table)) this._persistEvictions(table, evictedIds);
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

  /**
   * Real per-collection row counts + disk footprint (data/storage/index
   * bytes), for the Admin Dashboard DB detail view. Deliberately bypasses the
   * in-memory `_store` mirror — that mirror is capped per TABLE_ROW_CAPS and
   * only reflects the cap, not the real MongoDB collection size (see the
   * insert() comment above re: the 2026-07-20 incident where the in-memory
   * cap masked collections that had grown to tens of GB).
   */
  async getDetailedStats() {
    const base = this.getStats();
    if (!this.isConnected()) {
      return { ...base, tables: [], totalRows: 0, totalDataBytes: 0, diskUsage: null };
    }

    const result = await this._mongo.getCollectionStats();
    if (!result) {
      return { ...base, tables: [], totalRows: 0, totalDataBytes: 0, diskUsage: null };
    }

    const tables = result.collections.map(c => ({
      name:         c.name,
      rowCount:     c.count,
      capRowCount:  TABLE_ROW_CAPS[c.name] ?? null,
      sizeBytes:    c.dataBytes,
      storageBytes: c.storageBytes,
      indexBytes:   c.indexBytes,
    })).sort((a, b) => b.storageBytes - a.storageBytes);

    const totalRows          = tables.reduce((s, t) => s + t.rowCount, 0);
    const totalDataBytes     = tables.reduce((s, t) => s + t.sizeBytes, 0);
    const totalStorageBytes  = tables.reduce((s, t) => s + t.storageBytes, 0);
    const totalIndexBytes    = tables.reduce((s, t) => s + t.indexBytes, 0);

    const db = result.dbStats;
    const storageBytes = db?.storageBytes ?? totalStorageBytes;
    const indexBytes   = db?.indexBytes   ?? totalIndexBytes;
    const dataBytes    = db?.dataBytes    ?? totalDataBytes;

    return {
      ...base,
      tables,
      totalRows,
      totalDataBytes,
      diskUsage: {
        storageBytes,
        indexBytes,
        fsUsedBytes:   db?.fsUsedBytes  ?? null,
        fsTotalBytes:  db?.fsTotalBytes ?? null,
        // Extra bytes on disk beyond raw data — indexes + WiredTiger
        // bookkeeping. Never negative even though compression can make
        // storageBytes < dataBytes for an individual collection.
        overheadBytes: Math.max(0, (storageBytes + indexBytes) - dataBytes),
      },
    };
  }

  /**
   * Delete every row whose `id` is in `ids` from MongoDB (and the in-memory
   * mirror, if present). Used by snapshotArchiveService.js after it has
   * durably written a batch to storage/archive/ — unlike delete(table, id)
   * this is batched via the `id` index so it stays cheap for large batches.
   */
  async deleteByIds(table, ids) {
    if (!ids || ids.length === 0) return 0;
    if (Array.isArray(this._store[table])) {
      const idSet = new Set(ids);
      this._store[table] = this._store[table].filter(r => !idSet.has(r.id));
    }
    if (!this.isConnected()) return 0;
    await this._mongo.removeWhere(table, { id: { $in: ids } });
    return ids.length;
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

  _persistEvictions(table, ids) {
    if (!this.isConnected()) return; // reconnect will not replay evictions — acceptable, cap re-enforces on next insert
    this._mongo.removeWhere(table, { id: { $in: ids } }).catch(e =>
      console.error(`[DB:mongo] cap eviction cleanup failed for ${table}:`, e.message)
    );
  }
}

function _match(row, where) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

module.exports = MongoDatabase;
