'use strict';

/**
 * BaseDatabase — abstract interface for all storage backends.
 *
 * To add a new backend (SQLite, Oracle, etc.):
 *   1. Create server/src/db/SqliteDatabase.js  extending BaseDatabase
 *   2. Override the abstract CRUD + lifecycle methods
 *   3. Register it in db/index.js (DB_TYPE=sqlite → SqliteDatabase)
 *
 * The prepare() shim provides backward-compat for any legacy SQL-style callers;
 * new code should call insert/update/delete/find/findOne/all directly.
 */
class BaseDatabase {
  constructor() {
    // ── Query statistics — shared by all backends ──────────────────────────
    this._counts = { inserts: 0, updates: 0, deletes: 0, finds: 0 };
    this._rates  = {
      insertsPerSec: 0, updatesPerSec: 0,
      deletesPerSec: 0, findsPerSec:   0, totalPerSec: 0,
    };
    this._lastSample   = { inserts: 0, updates: 0, deletes: 0, finds: 0 };
    this._lastSampleAt = Date.now();

    this._rateTimer = setInterval(() => this._sampleRates(), 2000);
    this._rateTimer.unref(); // don't prevent process exit
  }

  // ── Abstract CRUD (must be overridden by every subclass) ──────────────────

  /** Insert a new row. `row` must include an `id` field. */
  insert(table, row)      { _abstract(this, 'insert'); }

  /** Merge `data` into the row identified by `id`. */
  update(table, id, data) { _abstract(this, 'update'); }

  /** Remove the row identified by `id`. */
  delete(table, id)       { _abstract(this, 'delete'); }

  /** Return all rows where every key in `where` matches. */
  find(table, where = {}) { _abstract(this, 'find'); }

  /** Return the first matching row, or null. */
  findOne(table, where = {}) { _abstract(this, 'findOne'); }

  /** Return a shallow copy of every row in `table`. */
  all(table)              { _abstract(this, 'all'); }

  // ── Abstract lifecycle ────────────────────────────────────────────────────

  /** Async setup — connect, load initial data, etc. */
  async init() { _abstract(this, 'init'); }

  /** Flush pending writes synchronously (graceful shutdown). */
  flushNow() {}

  /** Release resources — connections, timers. */
  close() { clearInterval(this._rateTimer); }

  // ── Abstract metadata ─────────────────────────────────────────────────────

  /** Return the backend type string: 'json' | 'mongodb' | 'sqlite' | etc. */
  getMode() { _abstract(this, 'getMode'); }

  /** True when the backend is ready to accept writes. */
  isConnected() { return true; }

  getStats() {
    return {
      mode:       this.getMode(),
      connected:  this.isConnected(),
      rates:      { ...this._rates },
      cumulative: { ...this._counts },
    };
  }

  // ── Legacy SQLite-compat shims ─────────────────────────────────────────────

  pragma() { return this; }
  exec()   { return this; }

  /**
   * prepare(sql) — minimal SQL-like interface kept for backward compatibility.
   * Only INSERT and DELETE are supported; new code should use the CRUD methods.
   */
  prepare(sql) {
    const s = sql.trim().toLowerCase();
    const tblM = s.match(/(?:from|into|update|table)\s+(\w+)/);
    const table = tblM ? tblM[1] : null;
    if (!table) return _noop();

    const opts = {};
    const orderM = sql.match(/ORDER BY\s+(\w+)/i);
    if (orderM) opts.orderBy = orderM[1];
    const limitM = sql.match(/LIMIT\s+(\d+)/i);
    if (limitM) opts.limit = parseInt(limitM[1], 10);

    const self = this;
    return {
      all(params = {}) {
        let rows = self.find(table, params);
        if (opts.orderBy) rows.sort((a, b) => (a[opts.orderBy] > b[opts.orderBy] ? -1 : 1));
        if (opts.limit) rows = rows.slice(0, opts.limit);
        return rows;
      },
      get(params = {}) {
        return self.findOne(table, params);
      },
      run(params = {}) {
        if (s.startsWith('insert')) {
          self.insert(table, params);
          return { changes: 1, lastInsertRowid: params.id };
        }
        if (s.startsWith('delete')) {
          const removed = self.find(table, params);
          removed.forEach(r => self.delete(table, r.id));
          return { changes: removed.length };
        }
        return { changes: 0 };
      },
    };
  }

  // ── Internal stats helpers ────────────────────────────────────────────────

  _sampleRates() {
    const now = Date.now();
    const dt  = (now - this._lastSampleAt) / 1000;
    if (dt <= 0) return;
    const d = k => Math.max(0, Math.round((this._counts[k] - this._lastSample[k]) / dt));
    this._rates = {
      insertsPerSec: d('inserts'),
      updatesPerSec: d('updates'),
      deletesPerSec: d('deletes'),
      findsPerSec:   d('finds'),
      totalPerSec:   d('inserts') + d('updates') + d('deletes') + d('finds'),
    };
    this._lastSample   = { ...this._counts };
    this._lastSampleAt = now;
  }
}

function _abstract(instance, method) {
  throw new Error(`${instance.constructor.name}.${method}() is not implemented`);
}

function _noop() {
  return { all: () => [], get: () => null, run: () => ({ changes: 0 }) };
}

module.exports = BaseDatabase;
