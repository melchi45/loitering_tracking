'use strict';

const ffmpeg = require('fluent-ffmpeg');
const { EventEmitter } = require('events');

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;

/**
 * Captures frames from an RTSP stream using FFmpeg.
 * Emits 'frame' with a JPEG Buffer for each decoded frame,
 * 'error' on unrecoverable failures, and 'stats' every 100 frames.
 */
class RTSPCapture extends EventEmitter {
  /**
   * @param {string} cameraId  Unique camera identifier
   * @param {string} rtspUrl   Full RTSP URL
   * @param {object} [options]
   * @param {number} [options.fps=10]
   * @param {number} [options.width=640]
   * @param {number} [options.height=640]
   */
  constructor(cameraId, rtspUrl, options = {}) {
    super();
    this.cameraId = cameraId;
    this.rtspUrl = rtspUrl;
    this.fps = options.fps || 10;
    this.width = options.width || 640;
    this.height = options.height || 640;
    this._process = null;
    this._running = false;
    this._frameBuffer = Buffer.alloc(0);
    this._frameCount = 0;
    this._retryCount = 0;
    this._retryTimer = null;
  }

  /** Start capturing frames. Idempotent — does nothing if already running. */
  start() {
    if (this._running) return;
    this._running = true;
    this._retryCount = 0;
    this._spawnProcess();
  }

  /** Stop capturing and clean up resources. */
  stop() {
    this._running = false;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._process) {
      try {
        this._process.kill('SIGKILL');
      } catch (_) {}
      this._process = null;
    }
    this._frameBuffer = Buffer.alloc(0);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _spawnProcess() {
    if (!this._running) return;

    const cmd = this._buildFFmpegCommand();

    cmd.on('start', (cmdline) => {
      this.emit('started', { cameraId: this.cameraId, cmdline });
    });

    // Capture raw process stdout for JPEG extraction
    cmd.on('error', (err) => {
      if (!this._running) return;
      this.emit('warn', { cameraId: this.cameraId, message: err.message });
      this._scheduleRetry();
    });

    cmd.on('end', () => {
      if (!this._running) return;
      this._scheduleRetry();
    });

    // fluent-ffmpeg exposes the underlying ChildProcess via _ffmpegProc
    // We pipe raw output manually by accessing the stdio stream
    const proc = cmd.pipe(); // returns a PassThrough stream with stdout data

    if (!proc) {
      // Fallback: spawn via ffmpeg directly
      this._spawnViaNativeStream(cmd);
      return;
    }

    this._process = { kill: (sig) => cmd.kill(sig) };

    proc.on('data', (chunk) => {
      this._onData(chunk);
    });

    proc.on('error', (err) => {
      if (!this._running) return;
      this.emit('warn', { cameraId: this.cameraId, message: err.message });
    });
  }

  _spawnViaNativeStream(cmd) {
    // fluent-ffmpeg internal: access _ffmpegProc after running
    cmd.on('start', () => {
      // _ffmpegProc is set internally; capture it right after spawn
      setImmediate(() => {
        const proc = cmd._ffmpegProc;
        if (!proc || !proc.stdout) return;
        this._process = proc;
        proc.stdout.on('data', (chunk) => this._onData(chunk));
        proc.stdout.on('error', () => {});
      });
    });
    cmd.run();
  }

  _buildFFmpegCommand() {
    return ffmpeg(this.rtspUrl)
      .inputOptions([
        '-rtsp_transport', 'tcp',
        '-stimeout', '5000000',
        '-analyzeduration', '1000000',
        '-probesize', '1000000',
      ])
      .videoFilters(`fps=${this.fps},scale=${this.width}:${this.height}`)
      .outputOptions([
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '5',
      ])
      .noAudio();
  }

  _onData(chunk) {
    this._frameBuffer = Buffer.concat([this._frameBuffer, chunk]);
    this._extractFrames();
  }

  _extractFrames() {
    while (true) {
      // Find SOI marker
      const soiIdx = this._indexOfBuffer(this._frameBuffer, JPEG_SOI, 0);
      if (soiIdx === -1) {
        // No SOI found — discard everything except last 2 bytes (partial marker)
        if (this._frameBuffer.length > 2) {
          this._frameBuffer = this._frameBuffer.slice(this._frameBuffer.length - 2);
        }
        break;
      }

      // Find EOI marker after SOI
      const eoiIdx = this._indexOfBuffer(this._frameBuffer, JPEG_EOI, soiIdx + 2);
      if (eoiIdx === -1) break; // Wait for more data

      const frameEnd = eoiIdx + 2;
      const jpegFrame = Buffer.from(this._frameBuffer.slice(soiIdx, frameEnd));
      this._frameBuffer = this._frameBuffer.slice(frameEnd);

      this._frameCount++;
      this.emit('frame', jpegFrame);

      if (this._frameCount % 100 === 0) {
        this.emit('stats', { cameraId: this.cameraId, frameCount: this._frameCount });
      }
    }
  }

  _indexOfBuffer(haystack, needle, offset = 0) {
    for (let i = offset; i <= haystack.length - needle.length; i++) {
      let found = true;
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) { found = false; break; }
      }
      if (found) return i;
    }
    return -1;
  }

  _scheduleRetry() {
    if (!this._running) return;
    if (this._retryCount >= MAX_RETRIES) {
      this._running = false;
      this.emit('error', new Error(
        `RTSPCapture(${this.cameraId}): max retries (${MAX_RETRIES}) exceeded`
      ));
      return;
    }
    const delay = BASE_RETRY_DELAY_MS * Math.pow(2, this._retryCount);
    this._retryCount++;
    this.emit('reconnecting', { cameraId: this.cameraId, attempt: this._retryCount, delay });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._frameBuffer = Buffer.alloc(0);
      this._spawnProcess();
    }, delay);
  }
}

module.exports = RTSPCapture;
