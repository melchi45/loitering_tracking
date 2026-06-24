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

module.exports = { formatTs, openLogFile, patchConsole, makeLineRelay };
