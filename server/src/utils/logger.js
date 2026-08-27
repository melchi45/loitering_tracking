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
 *   LOG_MAX_FILE_SIZE_MB=50     size (MB) at which the active log file is split
 *   LOG_MAX_FILES=10            max rotated/backdated log files kept before the
 *                               oldest (by mtime) is deleted
 *
 * These three (dir/maxFileSizeMB/maxFiles) are also runtime-adjustable via
 * setLogConfig() — Admin Dashboard → System persists them to the `settings`
 * table (services/logConfigService.js) and restores them on every boot. The
 * env vars above only seed the very first run.
 *
 * IMPORTANT: the actual file handle lives in whichever process calls
 * openLogFile() — in production that is the startServer.js SUPERVISOR
 * process, not the Express server process (index.js) where the Admin API
 * runs. setLogConfig() changes made from the Admin API only take effect on
 * the file itself once relayed to the supervisor via IPC — see
 * scripts/startServer.js's child.on('message', ...) handler.
 */

const fs   = require('fs');
const path = require('path');
const util = require('util');
const { getServerId } = require('./serverId');

// ─── Level constants ──────────────────────────────────────────────────────────

const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50, NONE: 100 };

// Resolve configured minimum level (default INFO)
const _levelStr = (process.env.LOG_LEVEL || 'INFO').toUpperCase().trim();
const MIN_LEVEL = LEVELS[_levelStr] ?? LEVELS.INFO;

// Runtime-adjustable level (starts at the configured value; changed via setLogLevel()).
let _runtimeMinLevel = MIN_LEVEL;

// ─── Configuration ────────────────────────────────────────────────────────────

const LOG_TO_FILE  = (process.env.LOG_TO_FILE ?? 'true').toLowerCase() !== 'false';
const FALLBACK_DIR = path.resolve(__dirname, '..', '..', 'logs');

const DEFAULT_MAX_FILE_SIZE_MB = 50;
const DEFAULT_MAX_FILES        = 10;

/**
 * Resolves the default log directory when no `dir`/`LOG_DIR` has been
 * configured. Follows this project's established precedence for OS-specific
 * path env vars — an OS-specific override wins over the general one (see
 * youtubeStreamService.js's findYtDlp(): YTDLP_BIN_WINDOWS/_LINUX checked
 * before the general YTDLP_BIN). Exported so logConfigService.js's
 * _seedFromEnv() uses this exact logic instead of duplicating the literal.
 * @returns {string}
 */
function _resolveDefaultLogDir() {
  const isWindows  = process.platform === 'win32';
  const osOverride = isWindows ? process.env.LOG_DIR_WINDOWS : process.env.LOG_DIR_LINUX;
  if (osOverride) return osOverride;
  if (process.env.LOG_DIR) return process.env.LOG_DIR;
  return isWindows ? 'C:\\ProgramData\\lts\\logs' : '/var/log/lts';
}

// Mutable at runtime via setLogConfig() — env vars only seed the first run.
// `dir` mirrors the old LOG_DIR constant; `maxFileSizeMB`/`maxFiles` drive
// size-based rotation (see _rotate()/_enforceMaxFiles() below).
let _cfg = {
  dir:           _resolveDefaultLogDir(),
  maxFileSizeMB: parseInt(process.env.LOG_MAX_FILE_SIZE_MB, 10) || DEFAULT_MAX_FILE_SIZE_MB,
  maxFiles:      parseInt(process.env.LOG_MAX_FILES, 10) || DEFAULT_MAX_FILES,
};

/** Returns a copy of the current runtime log config (dir/maxFileSizeMB/maxFiles). */
function getLogConfig() {
  return { ..._cfg };
}

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

let _logStream  = null;
let _logDate    = '';
let _logDir     = '';   // directory actually in use (may be FALLBACK_DIR)
let _logPath    = '';   // full path of the currently open file
let _fallback   = false; // true when _logDir === FALLBACK_DIR (configured dir failed)
let _currentSizeBytes = 0;

// Archived (rotated) files use this suffix so they never collide with the
// live per-day filename `lts-YYYY-MM-DD.log` that openLogFile()/_dateStr()
// produce — e.g. `lts-2026-08-26_143205123-1.log`.
const ARCHIVE_RE = /^lts-\d{4}-\d{2}-\d{2}(_\d{9}-\d+)?\.log$/;

function _dateStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}

// Monotonic counter appended to every archive name — a burst of rotations
// (e.g. a synchronous flood of ERROR lines) can hit _rotate() more than once
// within the same millisecond; time-of-day alone would let the second rename
// silently clobber the first archive file.
let _archiveSeq = 0;

function _archiveSuffix() {
  const n  = new Date();
  const hh = String(n.getHours()).padStart(2, '0');
  const mm = String(n.getMinutes()).padStart(2, '0');
  const ss = String(n.getSeconds()).padStart(2, '0');
  const ms = String(n.getMilliseconds()).padStart(3, '0');
  _archiveSeq += 1;
  return `${hh}${mm}${ss}${ms}-${_archiveSeq}`;
}

function _tryOpen(dir, dateStr) {
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `lts-${dateStr}.log`);
  // fs.createWriteStream(path) opens the underlying fd lazily/asynchronously —
  // under size-based rotation, a tight burst of writes can trigger a second
  // _rotate() before that async open completes, so fs.renameSync() would race
  // against a file that doesn't exist on disk yet (ENOENT). fs.openSync()
  // creates it synchronously first; handing the fd to createWriteStream makes
  // stream creation itself synchronous from the filesystem's point of view.
  const fd = fs.openSync(logPath, 'a');
  const existingSize = fs.fstatSync(fd).size;
  const stream = fs.createWriteStream(null, { fd, encoding: 'utf8' });
  stream.on('error', (err) => {
    process.stderr.write(`[Logger] Log write error: ${err.message}\n`);
    _logStream = null;
  });
  return { stream, logPath, existingSize };
}

/** Opens (or re-opens on midnight/size rotation) the daily log file. */
function openLogFile() {
  if (!LOG_TO_FILE) return;
  const dateStr = _dateStr();
  const dirs = [_cfg.dir, FALLBACK_DIR];
  for (const dir of dirs) {
    try {
      const { stream, logPath, existingSize } = _tryOpen(dir, dateStr);
      _logStream = stream;
      _logDate   = dateStr;
      _logDir    = dir;
      _logPath   = logPath;
      _fallback  = dir === FALLBACK_DIR && dir !== _cfg.dir;
      _currentSizeBytes = existingSize;
      process.stderr.write(`[Logger] Writing to ${logPath} (level=${_levelStr})\n`);
      return;
    } catch (err) {
      process.stderr.write(`[Logger] Cannot open ${dir}: ${err.message}${dir === _cfg.dir ? ' — trying fallback' : ''}\n`);
    }
  }
}

/** Deletes the oldest archived log files in _logDir beyond _cfg.maxFiles (the active file is never counted/deleted). */
function _enforceMaxFiles() {
  if (!_logDir) return;
  try {
    const entries = fs.readdirSync(_logDir)
      .filter(name => ARCHIVE_RE.test(name) && path.join(_logDir, name) !== _logPath)
      .map(name => {
        const p = path.join(_logDir, name);
        try { return { name, p, mtime: fs.statSync(p).mtimeMs }; } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    const excess = entries.length - _cfg.maxFiles;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(entries[i].p); } catch (err) {
        process.stderr.write(`[Logger] Failed to delete ${entries[i].p}: ${err.message}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[Logger] Failed to enforce max log files in ${_logDir}: ${err.message}\n`);
  }
}

/** Renames the current file to an archive name and opens a fresh active file. Used by both size- and manual-triggered rotation. */
function _rotate() {
  if (!_logStream || !_logPath) return;
  const oldPath = _logPath;
  const archivePath = oldPath.replace(/\.log$/, `_${_archiveSuffix()}.log`);
  _logStream.end();
  _logStream = null;
  try {
    fs.renameSync(oldPath, archivePath);
  } catch (err) {
    process.stderr.write(`[Logger] Failed to archive ${oldPath}: ${err.message}\n`);
  }
  openLogFile();
  _enforceMaxFiles();
}

/** Manually triggers a rotation right now, regardless of current file size. No-op if file logging is disabled or not yet open. */
function forceRotate() {
  if (!LOG_TO_FILE || !_logStream) return false;
  _rotate();
  return true;
}

/**
 * Updates the runtime log config (dir/maxFileSizeMB/maxFiles). Any subset of
 * keys may be provided; omitted keys keep their current value. If `dir`
 * changes, the active file is closed and a fresh one opened at the new
 * location (existing content is left in place, not moved).
 */
function setLogConfig(partial = {}) {
  const next = { ..._cfg };
  if (partial.dir !== undefined && partial.dir !== null && String(partial.dir).trim()) {
    next.dir = String(partial.dir).trim();
  }
  if (partial.maxFileSizeMB !== undefined && Number.isFinite(Number(partial.maxFileSizeMB))) {
    next.maxFileSizeMB = Math.max(1, Math.round(Number(partial.maxFileSizeMB)));
  }
  if (partial.maxFiles !== undefined && Number.isFinite(Number(partial.maxFiles))) {
    next.maxFiles = Math.max(1, Math.round(Number(partial.maxFiles)));
  }

  const dirChanged = next.dir !== _cfg.dir;
  _cfg = next;

  if (dirChanged && LOG_TO_FILE) {
    if (_logStream) { _logStream.end(); _logStream = null; }
    openLogFile();
  }
  _enforceMaxFiles();
  return getLogConfig();
}

/**
 * Returns current log storage stats: effective directory, fallback status,
 * the active file, and the archived files sorted newest-first — used by
 * GET /admin/system/logs.
 */
/**
 * Live write-capability probe for `dir` (mkdir + tiny temp-file write/unlink),
 * mirroring routes/admin.js's `_assertDirWritable()` but returning a result
 * object instead of throwing. Exists so GET /admin/system/logs can tell an
 * operator *right now* whether this process can actually write to the
 * configured directory — added after a real incident (2026-08-27, Windows
 * instance) where the Admin Dashboard showed no log content and nobody had
 * console/terminal access to the process to read the `[Logger] Cannot open
 * ...` diagnostic line that `openLogFile()` already prints on failure. This
 * makes that same failure visible from the dashboard itself.
 * @param {string} dir
 * @returns {{ writable: boolean, error: string|null }}
 */
function _probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.lts-write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return { writable: true, error: null };
  } catch (err) {
    return { writable: false, error: err.message };
  }
}

function getLogStats() {
  // Scan the *effective* directory even when this process never opened a
  // file handle there itself. The Admin API child process only calls
  // openLogFile() opportunistically — when a dir change happens to occur
  // during its own process lifetime (see setLogConfig()) — so _logDir/_logPath
  // can legitimately stay empty on the child for its entire lifetime even
  // while the supervisor process is actively writing real files at _cfg.dir.
  // Falling back to _cfg.dir (already what `effectiveDir` reported) keeps the
  // Admin Dashboard accurate regardless of which process actually owns the
  // live write handle. See Design_Log_Rotation.md §3C.
  const scanDir    = _logDir || _cfg.dir;
  const activeName = `lts-${_dateStr()}.log`;
  const activePath = _logPath || (scanDir ? path.join(scanDir, activeName) : '');

  const files = [];
  let totalBytes = 0;
  if (scanDir) {
    try {
      for (const name of fs.readdirSync(scanDir)) {
        if (!ARCHIVE_RE.test(name)) continue;
        const p = path.join(scanDir, name);
        if (p === activePath) continue;
        try {
          const st = fs.statSync(p);
          files.push({ name, sizeBytes: st.size, mtime: st.mtimeMs });
          totalBytes += st.size;
        } catch (_) { /* skip unreadable file */ }
      }
    } catch (_) { /* dir unreadable */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  let currentFile = null;
  if (_logPath) {
    // This process owns the open stream — _currentSizeBytes is tracked
    // incrementally, cheaper than a stat() on every GET.
    currentFile = { name: path.basename(_logPath), sizeBytes: _currentSizeBytes };
  } else if (scanDir) {
    // Never opened here — read the real on-disk size directly so the
    // dashboard reflects what the actual writer (e.g. the supervisor) has
    // produced, instead of always reporting "no active file".
    try {
      const st = fs.statSync(activePath);
      currentFile = { name: path.basename(activePath), sizeBytes: st.size };
    } catch (_) { /* not written yet today, or dir unreadable — leave null */ }
  }

  const probe = scanDir
    ? _probeWritable(scanDir)
    : { writable: false, error: 'No directory configured' };

  return {
    config: getLogConfig(),
    effectiveDir: scanDir,
    fallbackActive: _fallback,
    ipcAvailable: !!process.send,
    serverId: getServerId(),
    dirWritable: probe.writable,
    dirWriteError: probe.error,
    currentFile,
    files,
    totalFiles: files.length,
    totalBytes: totalBytes + (currentFile ? currentFile.sizeBytes : 0),
  };
}

function _writeToFile(line) {
  if (!LOG_TO_FILE || !_logStream) return;
  const today = _dateStr();
  if (today !== _logDate) {
    _logStream.end();
    _logStream = null;
    _logDate   = '';
    openLogFile();
    _enforceMaxFiles();
  }
  if (_logStream) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for the trailing \n
    _logStream.write(line + '\n');
    _currentSizeBytes += bytes;
    if (_currentSizeBytes >= _cfg.maxFileSizeMB * 1024 * 1024) {
      _rotate();
    }
  }
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
  const dirs = [_cfg.dir, FALLBACK_DIR];
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
  getLogConfig,
  setLogConfig,
  getLogStats,
  forceRotate,
  _resolveDefaultLogDir,
};
