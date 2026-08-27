'use strict';

/**
 * logConfigService.js — persists Admin Dashboard → System log storage path /
 * rotation settings (directory, max file size, max retained files) so they
 * survive a server restart.
 *
 * Storage: `settings` table, row id = `logConfig:<serverId>` (see §3A of
 * Design_Log_Rotation.md), same DB_TYPE-selected backend (json/mongodb) as
 * activeModelConfig.js / trackerConfig.js.
 *
 * Unlike activeModelConfig.js's row (which SHOULD be the same value across
 * every server sharing a DB — which AI model to run), `dir` names a path on
 * THIS process's own local filesystem. Keying the row by server instance
 * (SERVER_ID env var, defaulting to os.hostname()) means multiple physical
 * servers intentionally sharing one DB_TYPE=mongodb database each keep their
 * own independent config instead of overwriting each other's — see
 * serverId.js and Design_Log_Rotation.md §3A for the incident this fixes.
 *
 * Whichever process boots first (per its own serverId) seeds its row from
 * server/.env (LOG_DIR / LOG_MAX_FILE_SIZE_MB / LOG_MAX_FILES), unless a
 * pre-fix global row (id `logConfig`) already exists, in which case that is
 * adopted instead (one-time, read-only migration — see _getOrInit()).
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
const { getServerId } = require('../utils/serverId');

// Pre-v1.1 row id — every server used to share this one row. Kept only as a
// one-time migration source; new writes always go to the per-instance id.
const LEGACY_SETTING_ID = 'logConfig';

function _settingId() {
  return `logConfig:${getServerId()}`;
}

let _cached = null; // lazy-initialised on first access

function _seedFromEnv() {
  return {
    dir:           logger._resolveDefaultLogDir(),
    maxFileSizeMB: parseInt(process.env.LOG_MAX_FILE_SIZE_MB, 10) || 50,
    maxFiles:      parseInt(process.env.LOG_MAX_FILES, 10) || 10,
  };
}

function _stripRowMeta(row) {
  const { id, createdAt, updatedAt, ...cfg } = row;
  return cfg;
}

function _getOrInit() {
  if (_cached !== null) return _cached;

  const db = getDB();
  const id = _settingId();
  const row = db.findOne('settings', { id });

  if (row) {
    _cached = _stripRowMeta(row);
    return _cached;
  }

  // No row yet for this instance — adopt the pre-fix global row if one
  // exists (a deployment that ran the feature before per-instance scoping
  // shipped), rather than silently reverting to env defaults and discarding
  // an operator's prior configuration. The legacy row is left untouched.
  const legacy = db.findOne('settings', { id: LEGACY_SETTING_ID });
  _cached = legacy ? _stripRowMeta(legacy) : _seedFromEnv();
  db.insert('settings', { id, ..._cached });
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
  const id = _settingId();
  const existing = db.findOne('settings', { id });
  if (existing) {
    db.update('settings', id, { ...partial });
  } else {
    db.insert('settings', { id, ..._cached });
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
  // Visible in the log file itself (this runs on index.js/the child, whose
  // console output is piped to and written by the supervisor) — the final,
  // effective config after restoring any persisted Admin Dashboard override,
  // as opposed to startServer.js's own boot log which only shows its raw
  // env-seeded value before this restore happens.
  console.log(`[Logger] Restored config (${getServerId()}) — dir=${cfg.dir} maxFileSizeMB=${cfg.maxFileSizeMB} maxFiles=${cfg.maxFiles}`);
  return cfg;
}

// Last-known REAL state reported by the supervisor process (startServer.js)
// over the reverse IPC channel — null until a report arrives (no supervisor
// under npm run dev*, or none received yet). This is the only way this
// process can know what the actual file writer is doing, since this process
// never itself calls openLogFile() unless a dir change happens to occur
// during its own lifetime (see logger.js's getLogStats() header comment).
let _supervisorStatus = null;

function _handleSupervisorMessage(msg) {
  if (msg && typeof msg === 'object' && msg.type === 'lts:logStatus' && msg.payload) {
    _supervisorStatus = msg.payload;
  }
}

/**
 * Starts listening for status reports from the supervisor process and
 * requests an initial one. Call once during boot, after restoreOnBoot() (so
 * the request always fires after this listener is attached — Node's
 * IPC 'message' event has no replay for listeners added after the fact).
 * Harmless no-op under npm run dev* (process.send is undefined, so the
 * request is never sent and no report will ever arrive).
 */
function listenForSupervisorStatus() {
  process.on('message', _handleSupervisorMessage);
  if (process.send) process.send({ type: 'lts:logStatusRequest' });
}

/** Last-known real state reported by the supervisor, or null if none yet (see listenForSupervisorStatus()). */
function getSupervisorStatus() {
  return _supervisorStatus;
}

module.exports = { getLogConfig, setLogConfig, restoreOnBoot, listenForSupervisorStatus, getSupervisorStatus };
