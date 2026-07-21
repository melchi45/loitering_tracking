'use strict';

const fs   = require('fs');
const path = require('path');
const BaseDatabase = require('./BaseDatabase');
const { ALL_TABLES, TABLE_ROW_CAPS, LEGACY_MIGRATIONS } = require('./constants');

const PERSIST_DEBOUNCE_MS = 2000;

// getDetailedStats() re-stringifies every table to measure its byte size —
// cheap for most tables but detectionSnapshots/onvif_snapshots carry base64
// image blobs, so re-running it on every Admin Dashboard poll would burn CPU
// for no new information. Cache the result for a few seconds instead.
const DETAILED_STATS_CACHE_MS = 8000;

class JsonDatabase extends BaseDatabase {
  constructor() {
    super();
    this._store   = {};
    this._path    = null; // resolved in init()
    this._tmpPath = null;
    this._persistTimer   = null;
    this._persistPending = false;
    this._writing        = false;
    this._detailedStatsCache   = null;
    this._detailedStatsCachedAt = 0;
    ALL_TABLES.forEach(t => { this._store[t] = []; });
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  getMode() { return 'json'; }
  isConnected() { return true; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init() {
    const storagePath = process.env.STORAGE_PATH
      ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
      : path.resolve(__dirname, '..', '..', 'storage');

    if (!fs.existsSync(storagePath)) fs.mkdirSync(storagePath, { recursive: true });

    this._path    = path.join(storagePath, 'lts.json');
    this._tmpPath = this._path + '.tmp';

    this._loadFromDisk();
    this._runLegacyMigrations(storagePath);

    console.log('[DB] Storage mode: JSON (', this._path, ')');
  }

  flushNow() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    // Also flush when async write is in progress (_writing) because that write
    // began before the latest inserts and may not include them.  We use a
    // separate .sync.tmp path to avoid colliding with the in-flight async write.
    if (!this._persistPending && !this._writing) return;
    this._persistPending = false;
    const syncTmp = this._tmpPath + '.sync';
    try {
      fs.writeFileSync(syncTmp, JSON.stringify(this._store, null, 2));
      fs.renameSync(syncTmp, this._path);
    } catch (err) {
      console.error('[DB:json] flushNow error:', err.message);
      try { if (fs.existsSync(syncTmp)) fs.unlinkSync(syncTmp); } catch (_) {}
    }
  }

  close() {
    super.close();
    this.flushNow();
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
    this._schedulePersist();
  }

  update(table, id, data) {
    this._counts.updates++;
    if (!Array.isArray(this._store[table])) return;
    this._store[table] = this._store[table].map(r => {
      if (r.id !== id) return r;
      return { ...r, ...data, updatedAt: new Date().toISOString() };
    });
    this._schedulePersist();
  }

  delete(table, id) {
    this._counts.deletes++;
    if (!Array.isArray(this._store[table])) return;
    this._store[table] = this._store[table].filter(r => r.id !== id);
    this._schedulePersist();
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
   * Per-table row counts + byte sizes, plus whole-file disk usage, for the
   * Admin Dashboard DB detail view. "Overhead" here is the gap between the
   * pretty-printed file on disk and the sum of each table's minified byte
   * size — i.e. how much of lts.json is JSON.stringify(…, null, 2)
   * indentation/whitespace rather than actual data.
   */
  async getDetailedStats() {
    const now = Date.now();
    if (this._detailedStatsCache && (now - this._detailedStatsCachedAt) < DETAILED_STATS_CACHE_MS) {
      return this._detailedStatsCache;
    }

    const tables = ALL_TABLES.map(name => {
      const rows = Array.isArray(this._store[name]) ? this._store[name] : [];
      return {
        name,
        rowCount:    rows.length,
        capRowCount: TABLE_ROW_CAPS[name] ?? null,
        sizeBytes:   Buffer.byteLength(JSON.stringify(rows)),
      };
    }).sort((a, b) => b.sizeBytes - a.sizeBytes);

    const totalRows      = tables.reduce((s, t) => s + t.rowCount, 0);
    const totalDataBytes = tables.reduce((s, t) => s + t.sizeBytes, 0);

    let fileSizeBytes = null;
    try { fileSizeBytes = fs.statSync(this._path).size; } catch (_) { /* not yet persisted */ }

    const result = {
      ...this.getStats(),
      tables,
      totalRows,
      totalDataBytes,
      diskUsage: {
        path:          this._path,
        fileSizeBytes,
        overheadBytes: fileSizeBytes != null ? Math.max(0, fileSizeBytes - totalDataBytes) : null,
      },
    };

    this._detailedStatsCache    = result;
    this._detailedStatsCachedAt = now;
    return result;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _loadFromDisk() {
    if (fs.existsSync(this._path)) {
      try {
        this._store = JSON.parse(fs.readFileSync(this._path, 'utf8'));
      } catch (_) {}
    }
    for (const t of ALL_TABLES) {
      if (!Array.isArray(this._store[t])) this._store[t] = [];
    }
  }

  _runLegacyMigrations(storagePath) {
    for (const { table, file, key, idField } of LEGACY_MIGRATIONS) {
      if (this._store[table].length > 0) continue;
      const legacyPath = path.join(storagePath, file);
      if (!fs.existsSync(legacyPath)) continue;
      try {
        const raw  = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        const rows = raw[key];
        if (Array.isArray(rows) && rows.length > 0) {
          // If idField is specified, map the alternate key to `id`
          this._store[table] = idField
            ? rows.map(r => ({ ...r, id: r.id ?? r[idField] }))
            : rows;
          console.log(`[DB:json] Migrated ${rows.length} rows: ${file} → ${table}`);
        }
      } catch (e) {
        console.warn(`[DB:json] Migration from ${file} failed:`, e.message);
      }
    }
  }

  _schedulePersist() {
    this._persistPending = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      // Do NOT clear _persistPending here — clear it only inside _flushAsync so
      // that a concurrent flushNow() call cannot see false and skip the write
      // while an async write is still in progress.
      this._flushAsync().catch(e => console.error('[DB:json] persist error:', e.message));
    }, PERSIST_DEBOUNCE_MS);
  }

  async _flushAsync() {
    if (this._writing) return;
    this._writing = true;
    this._persistPending = false; // cleared here, after acquiring the write lock
    try {
      await fs.promises.writeFile(this._tmpPath, JSON.stringify(this._store, null, 2));
      await fs.promises.rename(this._tmpPath, this._path);
    } catch (err) {
      console.error('[DB:json] async flush error:', err.message);
      try { await fs.promises.unlink(this._tmpPath); } catch (_) {}
    } finally {
      this._writing = false;
    }
  }
}

function _match(row, where) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

module.exports = JsonDatabase;
