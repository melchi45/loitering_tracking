'use strict';

const fs   = require('fs');
const path = require('path');
const BaseDatabase = require('./BaseDatabase');
const { ALL_TABLES, TABLE_ROW_CAPS, LEGACY_MIGRATIONS } = require('./constants');

const PERSIST_DEBOUNCE_MS = 2000;

class JsonDatabase extends BaseDatabase {
  constructor() {
    super();
    this._store   = {};
    this._path    = null; // resolved in init()
    this._tmpPath = null;
    this._persistTimer   = null;
    this._persistPending = false;
    this._writing        = false;
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
    if (!this._persistPending) return;
    this._persistPending = false;
    if (this._writing) return; // async write in flight — let it finish
    try {
      fs.writeFileSync(this._tmpPath, JSON.stringify(this._store, null, 2));
      fs.renameSync(this._tmpPath, this._path);
    } catch (err) {
      console.error('[DB:json] flushNow error:', err.message);
      try { if (fs.existsSync(this._tmpPath)) fs.unlinkSync(this._tmpPath); } catch (_) {}
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
    for (const { table, file, key } of LEGACY_MIGRATIONS) {
      if (this._store[table].length > 0) continue;
      const legacyPath = path.join(storagePath, file);
      if (!fs.existsSync(legacyPath)) continue;
      try {
        const raw  = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        const rows = raw[key];
        if (Array.isArray(rows) && rows.length > 0) {
          this._store[table] = rows;
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
      this._persistTimer   = null;
      this._persistPending = false;
      this._flushAsync().catch(e => console.error('[DB:json] persist error:', e.message));
    }, PERSIST_DEBOUNCE_MS);
  }

  async _flushAsync() {
    if (this._writing) return;
    this._writing = true;
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
