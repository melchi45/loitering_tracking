'use strict';

const http         = require('http');
const { EventEmitter } = require('events');

/**
 * Captures JPEG frames by polling the MediaMTX snapshot API.
 *
 *   GET http://localhost:{MEDIAMTX_API_PORT}/v3/paths/{cameraId}/get-snapshot
 *   → returns the latest decoded frame as JPEG binary
 *
 * Requires MediaMTX ≥ 1.2.0 with `api: yes` in mediamtx.yml.
 *
 * Advantages over ffmpeg-based capture:
 *   - No ffmpeg subprocess (~40 MB RAM saved per camera)
 *   - MediaMTX already decodes the video for WebRTC — we reuse that work
 *   - No stdout pipe buffer management or JPEG frame boundary parsing
 *   - Handles reconnects automatically (MediaMTX manages the camera connection)
 *
 * Implements the same EventEmitter interface as rtspCapture.js:
 *   events : 'frame'(Buffer), 'started', 'reconnecting', 'stats', 'warn', 'error'
 *   methods: start(), stop()
 */
class MediaMTXSnapshotCapture extends EventEmitter {
  /**
   * @param {string} cameraId   UUID path name in MediaMTX
   * @param {string} _rtspUrl   Unused — MediaMTX already manages the source
   * @param {object} opts
   * @param {number} [opts.fps=10]  Polling rate
   */
  constructor(cameraId, _rtspUrl, opts = {}) {
    super();
    this._cameraId = cameraId;
    this._fps      = Math.min(Math.max(opts.fps || 10, 1), 30);
    this._intervalMs = Math.round(1000 / this._fps);

    const apiUrl   = process.env.MEDIAMTX_API_URL || 'http://127.0.0.1:9997';
    const u        = new URL(apiUrl);
    this._apiHost  = u.hostname;
    this._apiPort  = parseInt(u.port, 10) || 9997;
    this._apiPath  = `/v3/paths/${encodeURIComponent(cameraId)}/get-snapshot`;

    this._running          = false;
    this._timer            = null;
    this._frameCount       = 0;
    this._consecutiveErr   = 0;
    this._statsTimer       = null;
    this._warned404        = false;
  }

  start() {
    if (this._running) return;
    this._running    = true;
    this._frameCount = 0;
    this._consecutiveErr = 0;
    this._warned404  = false;

    this.emit('started', {
      cmdline: `MediaMTX snapshot poll → http://${this._apiHost}:${this._apiPort}${this._apiPath} @${this._fps} fps`,
    });

    this._statsTimer = setInterval(() => {
      this.emit('stats', { cameraId: this._cameraId, frameCount: this._frameCount });
    }, 10_000).unref();

    this._tick();
  }

  stop() {
    this._running = false;
    if (this._timer)      { clearTimeout(this._timer);   this._timer = null; }
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _tick() {
    if (!this._running) return;
    const t0 = Date.now();
    this._grabFrame()
      .catch(() => {})
      .finally(() => {
        if (!this._running) return;
        const elapsed = Date.now() - t0;
        const wait    = Math.max(0, this._intervalMs - elapsed);
        this._timer   = setTimeout(() => this._tick(), wait);
      });
  }

  _grabFrame() {
    return new Promise((resolve) => {
      const opts = {
        hostname: this._apiHost,
        port:     this._apiPort,
        path:     this._apiPath,
        method:   'GET',
        timeout:  2000,
      };
      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 404) {
            // Path not registered yet or stream not started — emit once
            if (!this._warned404) {
              this._warned404 = true;
              this.emit('reconnecting', { attempt: 1, delay: this._intervalMs });
            }
            this._consecutiveErr++;
            return resolve();
          }
          if (res.statusCode !== 200) {
            this.emit('warn', { message: `Snapshot HTTP ${res.statusCode}` });
            this._consecutiveErr++;
            return resolve();
          }
          const buf = Buffer.concat(chunks);
          if (buf.length < 100) { resolve(); return; } // ignore empty frames
          // Reset warning state on first good frame
          this._warned404    = false;
          this._consecutiveErr = 0;
          this._frameCount++;
          this.emit('frame', buf);
          resolve();
        });
      });

      req.on('timeout', () => {
        req.destroy();
        this.emit('warn', { message: 'Snapshot request timeout — MediaMTX busy?' });
        this._consecutiveErr++;
        resolve();
      });

      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          this.emit('error', new Error(
            `MediaMTX API unreachable at ${this._apiHost}:${this._apiPort} — ` +
            'ensure MediaMTX is running and api: yes is set in mediamtx.yml'
          ));
          this._running = false;
        } else {
          this.emit('warn', { message: `Snapshot error: ${err.message}` });
          this._consecutiveErr++;
        }
        resolve();
      });

      req.end();
    });
  }
}

module.exports = MediaMTXSnapshotCapture;
