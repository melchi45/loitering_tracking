'use strict';

const { spawn, spawnSync } = require('child_process');
const { EventEmitter }     = require('events');

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

const RETRY_DELAY = 1000; // ms — fixed 1-second retry interval, unlimited attempts

// ── ffmpeg version detection ────────────────────────────────────────────────
// Ubuntu 18.04 = ffmpeg 3.4  → use -stimeout (µs) for RTSP socket timeout
// Ubuntu 20.04 = ffmpeg 4.2  → -timeout works as AVOption; -stimeout still ok
// Ubuntu 22.04 = ffmpeg 4.4  → same
// Ubuntu 24.04 = ffmpeg 6.1  → -timeout preferred; -stimeout deprecated
// Ubuntu 26.04 = ffmpeg 7.x  → -stimeout removed; -timeout only
// The flag must be placed BEFORE -i to take effect as an input AVOption.
function _detectFfmpegMajor() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    const m = (r.stdout || '').match(/ffmpeg version (\d+)/);
    return m ? parseInt(m[1], 10) : 4;
  } catch (_) {
    return 4; // safe default
  }
}

const FFMPEG_MAJOR = _detectFfmpegMajor();

// -stimeout was removed in ffmpeg 7.0; -timeout was broken as global in 3.x
const RTSP_TIMEOUT_ARGS = FFMPEG_MAJOR < 4
  ? ['-stimeout', '5000000']   // ffmpeg 3.x (Ubuntu 18.04)
  : ['-timeout',  '5000000'];  // ffmpeg 4+ (Ubuntu 20.04+)

/**
 * Captures JPEG frames from an RTSP stream using a direct ffmpeg child process.
 *
 * Events:
 *   'frame'        (jpegBuffer: Buffer)
 *   'started'      ({ cameraId, cmdline })
 *   'reconnecting' ({ cameraId, attempt, delay })
 *   'stats'        ({ cameraId, frameCount })
 *   'warn'         ({ cameraId, message })
 *   'error'        (Error)  — unrecoverable, max retries exceeded
 */
class RTSPCapture extends EventEmitter {
  /**
   * @param {string} cameraId
   * @param {string} rtspUrl  Full RTSP URL (credentials already embedded if needed)
   * @param {object} [opts]
   * @param {number} [opts.fps=10]
   * @param {number} [opts.width=640]
   */
  constructor(cameraId, rtspUrl, opts = {}) {
    super();
    this.cameraId = cameraId;
    this.rtspUrl  = rtspUrl;
    this.fps      = opts.fps   || 10;
    this.width    = opts.width || 640;

    this._proc        = null;
    this._running     = false;
    this._frameBuf    = Buffer.alloc(0);
    this._frameCount  = 0;
    this._retryCount  = 0;
    this._retryTimer  = null;
    this._connected   = false;
    this._generation  = 0;  // incremented each _spawn(); stale close events are ignored
  }

  /** Start capturing. Idempotent. */
  start() {
    if (this._running) return;
    this._running    = true;
    this._retryCount = 0;
    this._connected  = false;
    this._spawn();
  }

  /** Stop capturing and kill the ffmpeg process. */
  stop() {
    this._running = false;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._kill();
    this._frameBuf = Buffer.alloc(0);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _buildArgs() {
    return [
      // Input options
      '-rtsp_transport', 'tcp',
      // Normalize broken source timestamps from some RTSP cameras.
      '-fflags',         '+genpts+igndts',
      ...RTSP_TIMEOUT_ARGS,            // -stimeout (ffmpeg 3.x) or -timeout (ffmpeg 4+)
      '-analyzeduration','1000000',
      '-probesize',      '1000000',
      '-i',              this.rtspUrl,
      // Keep pipeline real-time by dropping late frames instead of buffering.
      // Video filter: limit fps + scale to width, preserve aspect ratio
      '-vf',             `fps=${this.fps},scale=${this.width}:-2`,
      // Output: raw JPEG stream to stdout
      '-f',              'image2pipe',
      '-vcodec',         'mjpeg',
      '-q:v',            '5',
      'pipe:1',
    ];
  }

  _spawn() {
    if (!this._running) return;

    const args    = this._buildArgs();
    const cmdline = `ffmpeg ${args.join(' ')}`;
    this.emit('started', { cameraId: this.cameraId, cmdline });

    const gen  = ++this._generation;
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this._proc = proc;

    // Per-process stdout-stall watchdog: kill FFmpeg if connected but no data
    // arrives for 15 s. Fires a normal 'close' event which triggers _scheduleRetry().
    const STDOUT_STALL_MS = 15_000;
    let lastDataAt = null;
    let stallTimer = null;
    const scheduleStallCheck = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!this._running || this._proc !== proc) return;
        if (lastDataAt !== null && Date.now() - lastDataAt > STDOUT_STALL_MS) {
          this.emit('warn', { cameraId: this.cameraId, message: 'stdout stall — killing FFmpeg' });
          try { proc.kill('SIGKILL'); } catch (_) {}
        } else {
          scheduleStallCheck();
        }
      }, STDOUT_STALL_MS);
    };

    // ── stdout → JPEG frame extraction ──────────────────────────────────────
    proc.stdout.on('data', (chunk) => {
      lastDataAt = Date.now();
      if (stallTimer === null) scheduleStallCheck(); // arm watchdog on first data
      this._onData(chunk);
    });
    proc.stdout.on('error', () => {});   // pipe closed during kill — suppress

    // ── stderr → log lines ──────────────────────────────────────────────────
    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      const lines  = stderrTail.split('\n');
      stderrTail   = lines.pop();      // hold incomplete line
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        // Emit progress and errors; suppress routine codec/format spam
        if (/frame=|fps=|Error|error|No such|Invalid|Unable|Connection refused|Authentication|401/.test(t)) {
          this.emit('warn', { cameraId: this.cameraId, message: t });
        }
      }
    });

    // ── process exit ────────────────────────────────────────────────────────
    proc.on('close', (code, signal) => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      // Guard against stale close events from a SIGKILL'd proc when stop()+start()
      // is called in rapid succession (e.g. frame watchdog). Without this check,
      // the old proc's close fires after the new proc is already running, nulling
      // out this._proc and scheduling an extra retry — causing orphaned processes.
      if (this._generation !== gen) return;
      this._proc = null;
      if (!this._running) return;
      this.emit('warn', {
        cameraId: this.cameraId,
        message: `ffmpeg exited (code=${code} signal=${signal})`,
      });
      this._scheduleRetry();
    });

    proc.on('error', (err) => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      if (this._generation !== gen) return;
      this._proc = null;
      if (!this._running) return;
      this.emit('warn', { cameraId: this.cameraId, message: `spawn error: ${err.message}` });
      // ENOENT = ffmpeg not installed — retrying will never succeed; stop immediately.
      if (err.code === 'ENOENT') {
        this._running = false;
        this.emit('error', new Error('ffmpeg not found. Install ffmpeg to enable RTSP capture.'));
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
      this._retryCount = 0;   // reset counter on successful connection
    }
    this._frameBuf = Buffer.concat([this._frameBuf, chunk]);
    this._extractFrames();
  }

  _extractFrames() {
    while (true) {
      const soiIdx = this._indexOf(this._frameBuf, JPEG_SOI, 0);
      if (soiIdx === -1) {
        if (this._frameBuf.length > 2) {
          this._frameBuf = this._frameBuf.slice(this._frameBuf.length - 2);
        }
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

module.exports = RTSPCapture;
