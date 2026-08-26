'use strict';

/**
 * logConfigService.js — persists Admin Dashboard → System log storage path /
 * rotation settings (directory, max file size, max retained files) so they
 * survive a server restart.
 *
 * Storage: `settings` table (row id = 'logConfig'), same DB_TYPE-selected
 * backend (json/mongodb) as activeModelConfig.js / trackerConfig.js.
 *
 * The row is DB-mode-agnostic and shared across combined/streaming/analysis —
 * whichever process boots first seeds it from server/.env (LOG_DIR /
 * LOG_MAX_FILE_SIZE_MB / LOG_MAX_FILES); every later boot restores from here.
 *
 * NOTE: writing this row does NOT by itself change what gets written to disk.
 * The actual log file handle is owned by utils/logger.js, and in production
 * that module instance lives in the startServer.js supervisor process, not
 * this one. Callers must also push the value into utils/logger.js's
 * setLogConfig() (this process) and relay it over IPC to the supervisor —
 * see routes/admin.js and index.js's startup restore.
 */

const { getDB } = require('../db');
const logger = require('../utils/logger');

const SETTING_ID = 'logConfig';

let _cached = null; // lazy-initialised on first access

function _seedFromEnv() {
  return {
    dir:           process.env.LOG_DIR || '/var/log/lts',
    maxFileSizeMB: parseInt(process.env.LOG_MAX_FILE_SIZE_MB, 10) || 50,
    maxFiles:      parseInt(process.env.LOG_MAX_FILES, 10) || 10,
  };
}

function _getOrInit() {
  if (_cached !== null) return _cached;

  const db  = getDB();
  const row = db.findOne('settings', { id: SETTING_ID });

  if (row) {
    const { id, createdAt, updatedAt, ...cfg } = row;
    _cached = cfg;
    return _cached;
  }

  _cached = _seedFromEnv();
  db.insert('settings', { id: SETTING_ID, ..._cached });
  return _cached;
}

/** Persisted log storage config: { dir, maxFileSizeMB, maxFiles }. */
function getLogConfig() {
  return { ..._getOrInit() };
}

/** Merges `partial` into the persisted config and returns the updated value. Validation is the caller's responsibility (see routes/admin.js). */
function setLogConfig(partial) {
  _getOrInit();
  _cached = { ..._cached, ...partial };

  const db = getDB();
  const existing = db.findOne('settings', { id: SETTING_ID });
  if (existing) {
    db.update('settings', SETTING_ID, { ...partial });
  } else {
    db.insert('settings', { id: SETTING_ID, ..._cached });
  }
  return getLogConfig();
}

/**
 * Restores the persisted config into this process's own logger.js instance
 * (used for GET /admin/system/logs display + tailLogFile()) and, when
 * running under startServer.js (production — process.send present), relays
 * it to the supervisor process that actually owns the log file handle.
 * Safe to call from every SERVER_MODE — no mode-specific branching needed.
 */
function restoreOnBoot() {
  const cfg = getLogConfig();
  logger.setLogConfig(cfg);
  if (process.send) process.send({ type: 'lts:logConfig', payload: cfg });
  return cfg;
}

module.exports = { getLogConfig, setLogConfig, restoreOnBoot };
