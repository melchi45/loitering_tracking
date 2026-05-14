'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(__dirname, '..', 'storage');

if (!fs.existsSync(STORAGE_PATH)) {
  fs.mkdirSync(STORAGE_PATH, { recursive: true });
}

const DB_PATH = path.join(STORAGE_PATH, 'lts.db');

let _db = null;

/**
 * Initialize the SQLite database and create all required tables.
 * @returns {Database} better-sqlite3 Database instance
 */
function initDB() {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      rtspUrl     TEXT NOT NULL,
      username    TEXT,
      password    TEXT,
      ip          TEXT,
      mac         TEXT,
      httpPort    INTEGER,
      status      TEXT NOT NULL DEFAULT 'offline',
      createdAt   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS zones (
      id               TEXT PRIMARY KEY,
      cameraId         TEXT NOT NULL,
      name             TEXT NOT NULL,
      polygon          TEXT NOT NULL,
      type             TEXT NOT NULL DEFAULT 'MONITOR',
      dwellThreshold   INTEGER NOT NULL DEFAULT 30,
      minDisplacement  INTEGER NOT NULL DEFAULT 50,
      reentryWindow    INTEGER NOT NULL DEFAULT 120,
      schedule         TEXT,
      active           INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (cameraId) REFERENCES cameras(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      cameraId   TEXT NOT NULL,
      objectId   TEXT NOT NULL,
      zoneId     TEXT,
      startTime  TEXT NOT NULL,
      endTime    TEXT,
      dwellTime  REAL,
      clipPath   TEXT,
      createdAt  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (cameraId) REFERENCES cameras(id) ON DELETE CASCADE,
      FOREIGN KEY (zoneId)   REFERENCES zones(id)   ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id           TEXT PRIMARY KEY,
      eventId      TEXT NOT NULL,
      cameraId     TEXT NOT NULL,
      objectId     TEXT NOT NULL,
      dwellTime    REAL,
      timestamp    TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (eventId)  REFERENCES events(id)  ON DELETE CASCADE,
      FOREIGN KEY (cameraId) REFERENCES cameras(id) ON DELETE CASCADE
    );
  `);

  return _db;
}

/**
 * Return the singleton DB instance (must call initDB() first).
 * @returns {Database}
 */
function getDB() {
  if (!_db) initDB();
  return _db;
}

module.exports = { initDB, getDB };
