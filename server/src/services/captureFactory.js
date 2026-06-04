'use strict';

/**
 * RTSP Capture Backend Factory
 *
 * CAPTURE_BACKEND env var:
 *   ffmpeg    — FFmpeg subprocess (default, widest OS/codec compatibility)
 *   gstreamer — GStreamer pipeline (lower latency, hardware decode via nvdec/vaapi)
 *   pyav      — Python PyAV sidecar (best CUDA utilisation, future GPU-inference path)
 *
 * All backends implement the same EventEmitter interface:
 *   events: 'frame' (Buffer), 'started', 'reconnecting', 'stats', 'warn', 'error'
 *   methods: start(), stop()
 */

const CAPTURE_BACKEND = (process.env.CAPTURE_BACKEND || 'ffmpeg').toLowerCase();

let _warnedOnce = false;

function createCapture(cameraId, rtspUrl, opts = {}) {
  switch (CAPTURE_BACKEND) {
    case 'gstreamer':
      return new (require('./gstreamerCapture'))(cameraId, rtspUrl, opts);
    case 'pyav':
      return new (require('./pyavCapture'))(cameraId, rtspUrl, opts);
    case 'ffmpeg':
      return new (require('./rtspCapture'))(cameraId, rtspUrl, opts);
    default:
      if (!_warnedOnce) {
        console.warn(`[CaptureFactory] Unknown CAPTURE_BACKEND="${CAPTURE_BACKEND}", falling back to ffmpeg`);
        _warnedOnce = true;
      }
      return new (require('./rtspCapture'))(cameraId, rtspUrl, opts);
  }
}

module.exports = { createCapture, CAPTURE_BACKEND };
