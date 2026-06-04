'use strict';

const path         = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter }     = require('events');

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

const RETRY_DELAY = 1000;

function resolveRuntimeOs() {
  const override = (process.env.SERVER_RUNTIME_OS || 'auto').trim().toLowerCase();
  if (override === 'windows' || override === 'win') return 'windows';
  if (override === 'linux') return 'linux';
  return process.platform === 'win32' ? 'windows' : 'linux';
}

function firstNonEmpty(candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function resolvePyavPythonBin() {
  const runtimeOs = resolveRuntimeOs();
  const pyavOsDefault = runtimeOs === 'windows'
    ? process.env.PYAV_PYTHON_BIN_WINDOWS
    : process.env.PYAV_PYTHON_BIN_LINUX;
  const pythonOsDefault = runtimeOs === 'windows'
    ? process.env.PYTHON_EXEC_WINDOWS
    : process.env.PYTHON_EXEC_LINUX;
  const fallback = runtimeOs === 'windows' ? 'python' : 'python3';

  return firstNonEmpty([
    process.env.PYAV_PYTHON_BIN,
    pyavOsDefault,
    process.env.PYTHON_EXEC,
    pythonOsDefault,
    process.env.PYTHON,
    fallback,
  ]);
}

const PYAV_PYTHON_BIN = resolvePyavPythonBin();
const PYAV_HW_ACCEL   = (process.env.PYAV_HW_ACCEL  || 'none').toLowerCase();
const SIDECAR_SCRIPT  = path.join(__dirname, '../python/pyav_capture.py');

// Check Python + PyAV availability once at startup
function _checkPython() {
  try {
    const r = spawnSync(PYAV_PYTHON_BIN, ['-c', 'import av, PIL; print("ok")'], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() === 'ok';
  } catch (_) {
    return false;
  }
}

const PYAV_AVAILABLE = _checkPython();

if (PYAV_AVAILABLE) {
  console.log(`[PyAVCapture] Python+PyAV ready (bin=${PYAV_PYTHON_BIN}, hw=${PYAV_HW_ACCEL})`);
} else {
  console.warn(`[PyAVCapture] Python/PyAV not available (bin=${PYAV_PYTHON_BIN}). Install: pip3 install av Pillow`);
}

/**
 * Captures JPEG frames from an RTSP stream using a Python PyAV sidecar process.
 *
 * Spawns: python3 pyav_capture.py <rtsp_url> <fps> <width> <hw_accel>
 * The Python script writes a continuous JPEG stream to stdout (same wire format
 * as FFmpeg image2pipe), which this class parses with the same SOI/EOI logic.
 *
 * Events: 'frame', 'started', 'reconnecting', 'stats', 'warn', 'error'
 */
class PyAVCapture extends EventEmitter {
  constructor(cameraId, rtspUrl, opts = {}) {
    super();
    this.cameraId = cameraId;
    this.rtspUrl  = rtspUrl;
    this.fps      = opts.fps   || 10;
    this.width    = opts.width || 640;

    this._proc       = null;
    this._running    = false;
    this._frameBuf   = Buffer.alloc(0);
    this._frameCount = 0;
    this._retryCount = 0;
    this._retryTimer = null;
    this._connected  = false;
  }

  start() {
    if (this._running) return;
    if (!PYAV_AVAILABLE) {
      this.emit('error', new Error(
        `Python/PyAV not available at "${PYAV_PYTHON_BIN}". ` +
        'Install dependencies: pip3 install av Pillow'
      ));
      return;
    }
    this._running    = true;
    this._retryCount = 0;
    this._connected  = false;
    this._spawn();
  }

  stop() {
    this._running = false;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._kill();
    this._frameBuf = Buffer.alloc(0);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _spawn() {
    if (!this._running) return;

    const args    = [SIDECAR_SCRIPT, this.rtspUrl, String(this.fps), String(this.width), PYAV_HW_ACCEL];
    const cmdline = `${PYAV_PYTHON_BIN} ${args.join(' ')}`;
    this.emit('started', { cameraId: this.cameraId, cmdline });

    const proc = spawn(PYAV_PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this._proc = proc;

    proc.stdout.on('data', (chunk) => this._onData(chunk));
    proc.stdout.on('error', () => {});

    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      const lines = stderrTail.split('\n');
      stderrTail  = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (/ERROR|error|Error|Failed|No route|Connection|401|Unauthorized/.test(t)) {
          this.emit('warn', { cameraId: this.cameraId, message: t });
        }
      }
    });

    proc.on('close', (code, signal) => {
      this._proc = null;
      if (!this._running) return;
      this.emit('warn', { cameraId: this.cameraId, message: `pyav_capture.py exited (code=${code} signal=${signal})` });
      this._scheduleRetry();
    });

    proc.on('error', (err) => {
      this._proc = null;
      if (!this._running) return;
      this.emit('warn', { cameraId: this.cameraId, message: `spawn error: ${err.message}` });
      if (err.code === 'ENOENT') {
        this._running = false;
        this.emit('error', new Error(`Python binary not found: "${PYAV_PYTHON_BIN}"`));
        return;
      }
      this._scheduleRetry();
    });
  }

  _kill() {
    if (this._proc) {
      try { this._proc.kill('SIGKILL'); } catch (_) {}
      this._proc = null;
    }
  }

  _onData(chunk) {
    if (!this._connected) {
      this._connected  = true;
      this._retryCount = 0;
    }
    this._frameBuf = Buffer.concat([this._frameBuf, chunk]);
    this._extractFrames();
  }

  _extractFrames() {
    while (true) {
      const soiIdx = this._indexOf(this._frameBuf, JPEG_SOI, 0);
      if (soiIdx === -1) {
        if (this._frameBuf.length > 2) this._frameBuf = this._frameBuf.slice(this._frameBuf.length - 2);
        break;
      }
      const eoiIdx = this._indexOf(this._frameBuf, JPEG_EOI, soiIdx + 2);
      if (eoiIdx === -1) break;

      const end   = eoiIdx + 2;
      const frame = Buffer.from(this._frameBuf.slice(soiIdx, end));
      this._frameBuf = this._frameBuf.slice(end);

      this._frameCount++;
      this.emit('frame', frame);
      if (this._frameCount % 100 === 0) {
        this.emit('stats', { cameraId: this.cameraId, frameCount: this._frameCount });
      }
    }
  }

  _indexOf(haystack, needle, offset) {
    const limit = haystack.length - needle.length;
    outer: for (let i = offset; i <= limit; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  _scheduleRetry() {
    if (!this._running) return;
    this._retryCount++;
    this._connected = false;
    this.emit('reconnecting', { cameraId: this.cameraId, attempt: this._retryCount, delay: RETRY_DELAY });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._frameBuf   = Buffer.alloc(0);
      this._spawn();
    }, RETRY_DELAY);
  }
}

module.exports = PyAVCapture;
