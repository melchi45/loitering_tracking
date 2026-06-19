'use strict';

/**
 * IngestDaemonCapture — passive capture backend for the Python/Go ingest daemon.
 *
 * Instead of spawning a subprocess, this backend simply waits for JPEG frames
 * pushed by the external ingest daemon via HTTP POST to /api/internal/frame/:cameraId.
 * Frames are injected by calling injectFrame(jpegBuffer) on this instance.
 *
 * Implements the same EventEmitter interface as rtspCapture / pyavCapture:
 *   events: 'frame'(Buffer), 'started', 'reconnecting', 'stats', 'warn', 'error'
 *   methods: start(), stop(), injectFrame(buffer)
 */

const EventEmitter = require('events');

class IngestDaemonCapture extends EventEmitter {
  constructor(cameraId, rtspUrl, opts = {}) {
    super();
    this._cameraId = cameraId;
    this._rtspUrl  = rtspUrl;
    this._fps      = opts.fps || 10;
    this._running  = false;
    this._frameCount = 0;
    this._statsTimer  = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.emit('started', { cmdline: `ingest-daemon (${this._rtspUrl})` });

    // Periodic stats heartbeat every 5 s
    this._statsTimer = setInterval(() => {
      this.emit('stats', { frameCount: this._frameCount });
    }, 5000);
  }

  stop() {
    this._running = false;
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  }

  /** Called by pipelineManager.onIngestFrame — injects a JPEG buffer into the pipeline. */
  injectFrame(jpegBuffer) {
    if (!this._running) return;
    this._frameCount++;
    this.emit('frame', jpegBuffer);
  }
}

module.exports = IngestDaemonCapture;
