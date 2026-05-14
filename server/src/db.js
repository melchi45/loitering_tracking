'use strict';

/**
 * Pure-JS JSON file-based database that mimics the better-sqlite3 API.
 * Uses synchronous file I/O to match better-sqlite3 behaviour.
 * Tables: cameras, zones, events, alerts
 */

const fs   = require('fs');
const path = require('path');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '..', 'storage');

if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true });

const DB_PATH = path.join(STORAGE_PATH, 'lts.json');

// ── In-memory store ──────────────────────────────────────────────────────────
let store = { cameras: [], zones: [], events: [], alerts: [] };

function load() {
  if (fs.existsSync(DB_PATH)) {
    try { store = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (_) {}
  }
  for (const t of ['cameras', 'zones', 'events', 'alerts']) {
    if (!Array.isArray(store[t])) store[t] = [];
  }
}

function persist() {
  fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
}

// ── SQL-like helpers ─────────────────────────────────────────────────────────
function matchRow(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

// ── Statement factory — mirrors better-sqlite3 prepare() ────────────────────
function makeStmt(table, op, opts = {}) {
  return {
    // SELECT
    all(params = {}) {
      const rows = store[table].filter(r => matchRow(r, params));
      if (opts.orderBy) rows.sort((a, b) => (a[opts.orderBy] > b[opts.orderBy] ? -1 : 1));
      if (opts.limit) return rows.slice(0, opts.limit);
      return rows;
    },
    get(params = {}) {
      return store[table].find(r => matchRow(r, params)) || null;
    },
    // INSERT / UPDATE / DELETE
    run(params = {}) {
      if (op === 'insert') {
        const now = new Date().toISOString();
        const row = { createdAt: now, ...params };
        store[table].push(row);
        persist();
        return { changes: 1, lastInsertRowid: row.id };
      }
      if (op === 'update') {
        const { _where, ...data } = params;
        let changes = 0;
        store[table] = store[table].map(r => {
          if (!matchRow(r, _where)) return r;
          changes++;
          return { ...r, ...data };
        });
        persist();
        return { changes };
      }
      if (op === 'delete') {
        const before = store[table].length;
        store[table] = store[table].filter(r => !matchRow(r, params));
        persist();
        return { changes: before - store[table].length };
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
    // Parse minimal SQL to determine table and operation
    const s = sql.trim().toLowerCase();

    // Detect table name
    const tableMatch = s.match(/(?:from|into|update|table)\s+(\w+)/);
    const table = tableMatch ? tableMatch[1] : null;

    if (!table || !store[table]) {
      return {
        all: () => [],
        get: () => null,
        run: () => ({ changes: 0 }),
      };
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

  // Direct table accessors (used by services that import db directly)
  _tables: store,

  // Shorthand helpers used by route handlers
  insert(table, row) {
    const now = new Date().toISOString();
    store[table].push({ createdAt: now, updatedAt: now, ...row });
    persist();
  },
  update(table, id, data) {
    store[table] = store[table].map(r =>
      r.id === id ? { ...r, ...data, updatedAt: new Date().toISOString() } : r
    );
    persist();
  },
  delete(table, id) {
    store[table] = store[table].filter(r => r.id !== id);
    persist();
  },
  find(table, where = {}) {
    return store[table].filter(r => matchRow(r, where));
  },
  findOne(table, where = {}) {
    return store[table].find(r => matchRow(r, where)) || null;
  },
  all(table) {
    return [...store[table]];
  },
};

function initDB() {
  load();
  return db;
}

function getDB() {
  return db;
}

module.exports = { initDB, getDB };
