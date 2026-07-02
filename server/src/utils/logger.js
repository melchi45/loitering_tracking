'use strict';

/**
 * LTS-2026 production logger.
 *
 * Features
 * ────────
 * • [YY-MM-DD HH:mm:ss.sss] [LEVEL] prefix on every line.
 * • Level-based filtering: DEBUG < INFO < WARNING < ERROR < CRITICAL < NONE.
 * • Auto-downgrades verbose ffmpeg / yt-dlp output to DEBUG level.
 * • User-configurable suppression patterns via LOG_FILTER_PATTERNS.
 * • Daily log file rotation in LOG_DIR (falls back to <server>/logs/).
 * • Socket.IO real-time relay via installSocketRelay(io) — admin log viewer.
 * • Runtime log level control via setLogLevel(level) / getLogLevel().
 *
 * Only loaded by startServer.js (production). devServer.js / direct node runs
 * do NOT load this module so development output is unaffected.
 *
 * Environment variables
 * ─────────────────────
 *   LOG_TO_FILE=true            enable file writing (default: true)
 *   LOG_DIR=/var/log/lts        primary log directory (fallback: <server>/logs/)
 *   LOG_LEVEL=INFO              minimum level: DEBUG|INFO|WARNING|ERROR|CRITICAL|NONE
 *   LOG_FILTER_PATTERNS=<csv>   comma-separated regex strings; matching lines are
 *                               suppressed regardless of level.
 *                               Example: \[hls @.*\] Skip,EXT-X-DATERANGE.*PREDICT
 */

const fs   = require('fs');
const path = require('path');
const util = require('util');

// ─── Level constants ──────────────────────────────────────────────────────────

const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50, NONE: 100 };

// Resolve configured minimum level (default INFO)
const _levelStr = (process.env.LOG_LEVEL || 'INFO').toUpperCase().trim();
const MIN_LEVEL = LEVELS[_levelStr] ?? LEVELS.INFO;

// Runtime-adjustable level (starts at the configured value; changed via setLogLevel()).
let _runtimeMinLevel = MIN_LEVEL;

// ─── Configuration ────────────────────────────────────────────────────────────

const LOG_TO_FILE  = (process.env.LOG_TO_FILE ?? 'true').toLowerCase() !== 'false';
const LOG_DIR      = process.env.LOG_DIR || '/var/log/lts';
const FALLBACK_DIR = path.resolve(__dirname, '..', '..', 'logs');

// ─── Filter patterns ──────────────────────────────────────────────────────────

// Lines matching these regexes are suppressed entirely (before level check).
// Populated from LOG_FILTER_PATTERNS env var (comma-separated regex strings).
const SUPPRESS_PATTERNS = (() => {
  const raw = (process.env.LOG_FILTER_PATTERNS || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    try { return new RegExp(s, 'i'); } catch { return null; }
  }).filter(Boolean);
})();

// Lines matching ANY of these patterns are downgraded to DEBUG level.
// Covers verbose ffmpeg / yt-dlp diagnostic output that is not an error.
const DEBUG_DOWNGRADE_PATTERNS = [
  /\[[a-z0-9_-]+\s*@\s*0x[0-9a-f]+\]/i,  // ffmpeg component: [hls @ 0x...], [mp4 @ 0x...]
  /^(?:EXT-X-|#EXT-X-)/,                  // raw HLS playlist tags
  /BoxTemperatureReading/,                 // thermal radiometry readings — high-frequency, debug only
  /\[internalApi\]\[(ONVIF(\/XML)?|logstring)\]/, // ONVIF metadata per-packet debug logs — high-frequency
                                            // (matches [ONVIF], [ONVIF/XML], and [logstring] — the three
                                            // `src`/tag variants internalApi.js actually emits; the old
                                            // /\[ONVIF\]/-only pattern missed [ONVIF/XML] and [logstring])
  /^<\?xml version=/,                     // raw ONVIF MetadataStream XML declaration line (first line
                                            // of the multi-line console.debug() dump above)
  /^\s*raw\(\d+B\):/,                     // "  raw(806B):" prefix line from the same dump
  /tt:MetadataStream/,                    // raw ONVIF MetadataStream XML fragments
  /App RTP #\d+:/,                        // ingest-daemon per-500-packet App RTP progress
];

// ─── Level detection ──────────────────────────────────────────────────────────

// Keyword-based level detection applied to child-process output lines.
// Order matters: most specific / highest priority first.
const LEVEL_KEYWORDS = [
  { level: 'CRITICAL', re: /\b(critical|fatal)\b/i },
  { level: 'ERROR',    re: /\b(error|err\b|failed|failure|exception|traceback)\b/i },
  { level: 'WARNING',  re: /\b(warn(ing)?|wrn\b)\b/i },
  { level: 'DEBUG',    re: /\b(debug|dbg\b|verbose)\b/i },
];

function _detectLevel(line) {
  // High-severity keywords always override downgrade rules
  for (const { level, re } of LEVEL_KEYWORDS.slice(0, 3)) {
    if (re.test(line)) return level;
  }
  // Downgrade ffmpeg / yt-dlp verbose lines to DEBUG
  if (DEBUG_DOWNGRADE_PATTERNS.some(re => re.test(line))) return 'DEBUG';
  // Remaining keyword checks (DEBUG keyword)
  if (LEVEL_KEYWORDS[3].re.test(line)) return 'DEBUG';
  return 'INFO';
}

function _isSuppressed(line) {
  return SUPPRESS_PATTERNS.some(re => re.test(line));
}

// ─── Timestamp ────────────────────────────────────────────────────────────────

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

let _logStream = null;
let _logDate   = '';

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

/** Opens (or re-opens on midnight rotation) the daily log file. */
function openLogFile() {
  if (!LOG_TO_FILE) return;
  const dateStr = _dateStr();
  for (const dir of [LOG_DIR, FALLBACK_DIR]) {
    try {
      const { stream, logPath } = _tryOpen(dir, dateStr);
      _logStream = stream;
      _logDate   = dateStr;
      process.stderr.write(`[Logger] Writing to ${logPath} (level=${_levelStr})\n`);
      return;
    } catch (err) {
      process.stderr.write(`[Logger] Cannot open ${dir}: ${err.message}${dir === LOG_DIR ? ' — trying fallback' : ''}\n`);
    }
  }
}

function _writeToFile(line) {
  if (!LOG_TO_FILE || !_logStream) return;
  const today = _dateStr();
  if (today !== _logDate) {
    _logStream.end();
    _logStream = null;
    _logDate   = '';
    openLogFile();
  }
  if (_logStream) _logStream.write(line + '\n');
}

// ─── Socket.IO real-time relay ────────────────────────────────────────────────

// Must be >= the largest option in client/src/components/AdminLogPanel.tsx
// MAX_LINES_OPTIONS, or the admin UI's "Max Lines" setting becomes
// unsatisfiable for source=server (buffer runs out before the UI cap does).
const LOG_BUFFER_MAX = 2000;
const _recentLogs    = [];   // circular buffer for GET /admin/logs/recent

function _bufferLog(entry) {
  _recentLogs.push(entry);
  if (_recentLogs.length > LOG_BUFFER_MAX) _recentLogs.shift();
}

/** Returns a snapshot of the in-memory log ring buffer (up to LOG_BUFFER_MAX entries). */
function getRecentLogs() {
  return [..._recentLogs];
}

/** Changes the minimum log level for Socket.IO relay at runtime. Returns false if level is invalid. */
function setLogLevel(level) {
  const num = LEVELS[(level || '').toUpperCase()];
  if (num == null) return false;
  _runtimeMinLevel = num;
  return true;
}

/** Returns the current effective log level string (DEBUG/INFO/WARNING/ERROR/CRITICAL/NONE). */
function getLogLevel() {
  return Object.keys(LEVELS).find(k => LEVELS[k] === _runtimeMinLevel) || 'INFO';
}

/**
 * Installs a thin Socket.IO relay layer on top of the current console methods.
 * Called from index.js after `io` is created.
 *
 * Works in both dev mode (unpatched console) and prod mode (patchConsole already
 * applied in the startServer.js parent process).
 *
 * Each console call produces a { ts, level, msg, t } entry that is:
 *  1. Added to the in-memory ring buffer (getRecentLogs).
 *  2. Broadcast via Socket.IO `server:log` event to all connected sockets.
 *
 * Also handles the `admin:subscribe-logs` socket event to flush buffered entries
 * to a newly connected admin client.
 */
function installSocketRelay(io) {
  const origLog   = console.log;
  const origInfo  = console.info;
  const origWarn  = console.warn;
  const origError = console.error;
  const origDebug = console.debug;

  function _relay(level, args) {
    if (LEVELS[level] < _runtimeMinLevel) return;
    const ts  = formatTs();
    const msg = util.formatWithOptions({ colors: false }, ...args);
    if (_isSuppressed(msg)) return;
    const entry = { ts, level, msg, t: Date.now() };
    _bufferLog(entry);
    io.emit('server:log', entry);
  }

  console.log   = (...a) => { origLog(...a);   _relay('INFO',     a); };
  console.info  = (...a) => { origInfo(...a);  _relay('INFO',     a); };
  console.warn  = (...a) => { origWarn(...a);  _relay('WARNING',  a); };
  console.error = (...a) => { origError(...a); _relay('ERROR',    a); };
  console.debug = (...a) => { origDebug(...a); _relay('DEBUG',    a); };

  // Flush buffered logs to a newly connected admin client on explicit subscribe request
  io.on('connection', (socket) => {
    socket.on('admin:subscribe-logs', () => {
      _recentLogs.forEach(e => socket.emit('server:log', e));
    });
  });
}

// ─── Log-file tail utility ────────────────────────────────────────────────────

/**
 * Reads the current daily log file and returns the last `limit` lines
 * optionally filtered by a source prefix (e.g. '[Ingest]', '[MediaMTX]').
 *
 * Used by GET /admin/logs/recent?source=ingest for ingest-daemon log polling.
 *
 * @param {Object} opts
 * @param {string|null} opts.prefix  — filter lines containing this string, or null for all
 * @param {number}      opts.limit   — max lines to return (default 200)
 * @returns {{ ts: string, level: string, msg: string, t: number }[]}
 */
function tailLogFile({ prefix = null, limit = 200 } = {}) {
  const dirs = [LOG_DIR, FALLBACK_DIR];
  const date = _dateStr();
  for (const dir of dirs) {
    const p = path.join(dir, `lts-${date}.log`);
    try {
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf8');
      let lines = content.split('\n').filter(Boolean);
      if (prefix) lines = lines.filter(l => l.includes(prefix));
      if (lines.length > limit) lines = lines.slice(-limit);
      // Parse formatted log lines: [YY-MM-DD HH:mm:ss.sss] [LEVEL] rest…
      const RE = /^(\[\d{2}-\d{2}-\d{2}\s[\d:.]+\])\s+\[(DEBUG|INFO|WARNING|ERROR|CRITICAL)\]\s+(.*)$/s;
      return lines.map(l => {
        const m = l.match(RE);
        if (m) return { ts: m[1], level: m[2], msg: m[3], t: 0 };
        return { ts: '', level: 'INFO', msg: l, t: 0 };
      });
    } catch (_) { /* try next dir */ }
  }
  return [];
}

// ─── Console patch ────────────────────────────────────────────────────────────

/**
 * Replaces console.log/info/warn/error/debug with level-aware, timestamped
 * variants that also write to the log file.
 */
function patchConsole() {
  function _emit(stream, level, ...args) {
    if (LEVELS[level] < MIN_LEVEL) return;
    const ts   = formatTs();
    const msg  = util.formatWithOptions({ colors: false }, ...args);
    if (_isSuppressed(msg)) return;
    const line = `${ts} [${level}] ${msg}`;
    stream.write(line + '\n');
    _writeToFile(line);
  }

  console.debug = (...a) => _emit(process.stdout, 'DEBUG',    ...a);
  console.log   = (...a) => _emit(process.stdout, 'INFO',     ...a);
  console.info  = (...a) => _emit(process.stdout, 'INFO',     ...a);
  console.warn  = (...a) => _emit(process.stderr, 'WARNING',  ...a);
  console.error = (...a) => _emit(process.stderr, 'ERROR',    ...a);
}

// ─── Child-process line relay ─────────────────────────────────────────────────

/**
 * Returns a `data` event handler that:
 *  1. Buffers and splits incoming bytes into complete lines.
 *  2. Detects log level from line content.
 *  3. Suppresses lines below MIN_LEVEL or matching SUPPRESS_PATTERNS.
 *  4. Prepends [timestamp] [LEVEL] (and optional prefix) to each line.
 *  5. Writes to outStream and the daily log file.
 *
 * @param {string}             prefix    — e.g. '[MediaMTX]', '[Ingest]', ''
 * @param {NodeJS.WriteStream} outStream — process.stdout or process.stderr
 */
function makeLineRelay(prefix, outStream) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop(); // keep last incomplete line
    for (const line of parts) {
      if (!line) continue;
      if (_isSuppressed(line)) continue;
      const level = _detectLevel(line);
      if (LEVELS[level] < MIN_LEVEL) continue;
      const ts  = formatTs();
      const out = prefix
        ? `${ts} [${level}] ${prefix} ${line}`
        : `${ts} [${level}] ${line}`;
      outStream.write(out + '\n');
      _writeToFile(out);
    }
  };
}

module.exports = {
  formatTs,
  openLogFile,
  patchConsole,
  makeLineRelay,
  installSocketRelay,
  setLogLevel,
  getLogLevel,
  getRecentLogs,
  tailLogFile,
};
