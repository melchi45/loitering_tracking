'use strict';

/**
 * LTS-2026 production logger.
 *
 * • Prefixes every console.log/info/warn/error call with [YY-MM-DD HH:mm:ss.sss].
 * • Writes the same lines to a daily log file under LOG_DIR (default: /var/log/lts).
 *   Falls back to <server_root>/logs/ when /var/log/lts is not writable.
 * • makeLineRelay(prefix, outStream) — relays a child-process stdout/stderr data
 *   chunk through the same timestamp + file-write pipeline.
 *
 * Activated by loading this module at the top of startServer.js.
 * Index.js (spawned as a child) does NOT load this module; its stdio is piped
 * through startServer.js's relay functions so timestamps are added there.
 *
 * Environment variables:
 *   LOG_TO_FILE=true        — enable log file writing (default: true in production)
 *   LOG_DIR=/var/log/lts    — primary log directory
 */

const fs   = require('fs');
const path = require('path');
const util = require('util');

const LOG_TO_FILE    = (process.env.LOG_TO_FILE ?? 'true').toLowerCase() !== 'false';
const LOG_DIR        = process.env.LOG_DIR || '/var/log/lts';
const FALLBACK_DIR   = path.resolve(__dirname, '..', '..', 'logs');

let _logStream = null;
let _logDate   = '';  // 'YYYY-MM-DD' of the currently open file

// ─── Timestamp ───────────────────────────────────────────────────────────────

function formatTs() {
  const n  = new Date();
  const yy = String(n.getFullYear()).slice(2);
  const mo = String(n.getMonth() + 1).padStart(2, '0');
  const dd = String(n.getDate()).padStart(2, '0');
  const hh = String(n.getHours()).padStart(2, '0');
  const mm = String(n.getMinutes()).padStart(2, '0');
  const ss = String(n.getSeconds()).padStart(2, '0');
  const ms = String(n.getMilliseconds()).padStart(3, '0');
  return `[${yy}-${mo}-${dd} ${hh}:${mm}:${ss}.${ms}]`;
}

// ─── Log-file management ─────────────────────────────────────────────────────

function _dateStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}

function _tryOpen(dir, dateStr) {
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `lts-${dateStr}.log`);
  const stream  = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
  stream.on('error', (err) => {
    process.stderr.write(`[Logger] Log write error: ${err.message}\n`);
    _logStream = null;
  });
  return { stream, logPath };
}

/**
 * Opens (or re-opens on date change) the daily log file.
 * Called once at startup and lazily on each write when the date changes.
 */
function openLogFile() {
  if (!LOG_TO_FILE) return;
  const dateStr = _dateStr();
  for (const dir of [LOG_DIR, FALLBACK_DIR]) {
    try {
      const { stream, logPath } = _tryOpen(dir, dateStr);
      _logStream = stream;
      _logDate   = dateStr;
      // Use raw write so this banner line is not double-processed
      process.stderr.write(`[Logger] Writing to ${logPath}\n`);
      return;
    } catch (err) {
      process.stderr.write(`[Logger] Cannot open ${dir}: ${err.message}${dir === LOG_DIR ? ' — trying fallback' : ''}\n`);
    }
  }
}

function _writeToFile(line) {
  if (!LOG_TO_FILE || !_logStream) return;
  // Daily rotation: reopen if date changed since last write
  const today = _dateStr();
  if (today !== _logDate) {
    _logStream.end();
    _logStream = null;
    _logDate   = '';
    openLogFile();
  }
  if (_logStream) _logStream.write(line + '\n');
}

// ─── Console patch ───────────────────────────────────────────────────────────

function patchConsole() {
  function _emit(stream, ...args) {
    const ts   = formatTs();
    const msg  = util.formatWithOptions({ colors: false }, ...args);
    const line = `${ts} ${msg}`;
    stream.write(line + '\n');
    _writeToFile(line);
  }

  console.log   = (...a) => _emit(process.stdout, ...a);
  console.info  = (...a) => _emit(process.stdout, ...a);
  console.warn  = (...a) => _emit(process.stderr, ...a);
  console.error = (...a) => _emit(process.stderr, ...a);
  console.debug = (...a) => _emit(process.stdout, ...a);
}

// ─── Child-process line relay ─────────────────────────────────────────────────

/**
 * Returns a `data` event handler that:
 *   1. Splits the chunk into complete lines (buffering the last incomplete line).
 *   2. Prepends a timestamp (and optional prefix) to each line.
 *   3. Writes to outStream and the log file.
 *
 * @param {string} prefix     — e.g. '[MediaMTX]', '[Ingest]', '' for main server
 * @param {NodeJS.WriteStream} outStream — process.stdout or process.stderr
 */
function makeLineRelay(prefix, outStream) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop(); // last element is the incomplete line (or '')
    for (const line of parts) {
      if (!line) continue;
      const ts  = formatTs();
      const out = prefix ? `${ts} ${prefix} ${line}` : `${ts} ${line}`;
      outStream.write(out + '\n');
      _writeToFile(out);
    }
  };
}

module.exports = { formatTs, openLogFile, patchConsole, makeLineRelay };
