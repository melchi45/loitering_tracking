'use strict';
/**
 * snapshotArchiveService.js — date-based retention for image-carrying tables
 *
 * MongoDB has no automatic space reclamation and (until 2026-07-20) the
 * TABLE_ROW_CAPS count cap only trimmed the in-memory mirror, not the real
 * collection — onvif_snapshots/detectionSnapshots grew to 78GB combined and
 * filled the root disk. TABLE_ROW_CAPS is now enforced against MongoDB too
 * (see MongoDatabase.js), but a pure count cap still means a write burst can
 * delete an image before anyone gets to look at it. This service instead
 * enforces a date-based window (SNAPSHOT_ARCHIVE_RETENTION_DAYS): once a row
 * ages past the window it is appended to a local NDJSON file (full document,
 * including the image blob) under storage/archive/<table>/<date>.ndjson and
 * only then deleted from MongoDB — nothing is dropped without being written
 * to disk first. MongoDatabase.js exempts these two tables from its own
 * count-cap deletion (ARCHIVED_TABLES) so this service is the sole owner of
 * their MongoDB lifecycle.
 *
 * MongoDB-only: JsonDatabase's in-memory array already IS the persisted
 * store, so its own TABLE_ROW_CAPS trim is equivalent to this by construction.
 */

const fs   = require('fs');
const path = require('path');
const { getDB, getStorageMode } = require('../db');

const ARCHIVED_TABLES   = ['onvif_snapshots', 'detectionSnapshots'];
const RETENTION_DAYS    = Math.max(1, parseInt(process.env.SNAPSHOT_ARCHIVE_RETENTION_DAYS || '1', 10));
const RUN_INTERVAL_MS   = 60 * 60 * 1000; // hourly — cheap no-op when nothing has aged out yet
const BATCH_SIZE        = 500;            // rows per queryAsync/delete round, bounds memory for large blobs

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(process.cwd(), 'storage');
const ARCHIVE_ROOT = path.join(STORAGE_PATH, 'archive');

function _dayBucket(record) {
  const iso = record.createdAt || record.timestamp || new Date().toISOString();
  return String(iso).slice(0, 10); // YYYY-MM-DD
}

function _appendBatch(table, rows) {
  const byDay = new Map();
  for (const row of rows) {
    const day = _dayBucket(row);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  }
  const dir = path.join(ARCHIVE_ROOT, table);
  fs.mkdirSync(dir, { recursive: true });
  for (const [day, dayRows] of byDay) {
    const lines = dayRows.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(path.join(dir, `${day}.ndjson`), lines);
  }
}

async function _archiveTable(table, mongoDbService) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const db = getDB();
  let totalArchived = 0;

  for (;;) {
    const rows = await db.queryAsync(table, { createdAt: { $lt: cutoff } }, { createdAt: 1 }, BATCH_SIZE);
    if (!rows || rows.length === 0) break;

    try {
      _appendBatch(table, rows);
    } catch (err) {
      console.error(`[SnapshotArchive] failed to write ${table} batch to disk, aborting this run:`, err.message);
      break; // never delete from Mongo unless the archive write actually succeeded
    }

    const ids = rows.map(r => r.id).filter(Boolean);
    await db.deleteByIds(table, ids);
    totalArchived += rows.length;

    if (rows.length < BATCH_SIZE) break; // last batch
  }

  if (totalArchived > 0) {
    console.log(`[SnapshotArchive] ${table}: archived+purged ${totalArchived} row(s) older than ${RETENTION_DAYS}d`);
    const freed = await mongoDbService.compact(table);
    if (freed > 0) {
      console.log(`[SnapshotArchive] ${table}: compact reclaimed ${(freed / 1024 / 1024).toFixed(1)}MB`);
    }
  }
}

async function runOnce() {
  if (getStorageMode() !== 'mongodb') return; // JsonDatabase's cap trim already covers this
  const mongoDbService = require('./mongoDbService');
  if (!mongoDbService.isConnected()) return;

  for (const table of ARCHIVED_TABLES) {
    try {
      await _archiveTable(table, mongoDbService);
    } catch (err) {
      console.error(`[SnapshotArchive] ${table} run failed:`, err.message);
    }
  }
}

let _timer = null;

/** Start the hourly archive+purge loop. Idempotent — safe to call once at server boot. */
function start() {
  if (_timer) return;
  runOnce().catch(err => console.error('[SnapshotArchive] initial run failed:', err.message));
  _timer = setInterval(() => {
    runOnce().catch(err => console.error('[SnapshotArchive] run failed:', err.message));
  }, RUN_INTERVAL_MS);
  _timer.unref();
  console.log(`[SnapshotArchive] started — retention=${RETENTION_DAYS}d tables=[${ARCHIVED_TABLES.join(', ')}] archive dir=${ARCHIVE_ROOT}`);
}

module.exports = { start, runOnce };
