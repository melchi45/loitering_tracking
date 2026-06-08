'use strict';

/**
 * RTSP Capture Backend Factory
 *
 * CAPTURE_BACKEND env var:
 *   ffmpeg    — FFmpeg subprocess reads directly from the camera RTSP URL.
 *               Default; widest OS/codec compatibility.
 *   mediamtx  — MediaMTX holds the single RTSP connection to the camera.
 *               Browser WebRTC (WHEP) consumes it directly from MediaMTX.
 *               AI frame extraction uses the backend selected by
 *               MEDIAMTX_FRAME_BACKEND (default: ffmpeg).
 *               Requires MediaMTX to be running.
 *   gstreamer — GStreamer pipeline (lower latency, hardware decode via nvdec/vaapi)
 *   pyav      — Python PyAV sidecar (best CUDA utilisation, future GPU-inference path)
 *
 * MEDIAMTX_FRAME_BACKEND env var (only used when CAPTURE_BACKEND=mediamtx):
 *   ffmpeg    — FFmpeg subprocess reads from MediaMTX local RTSP (default)
 *   gstreamer — GStreamer reads from MediaMTX local RTSP (no ffmpeg process)
 *   pyav      — Python PyAV reads from MediaMTX local RTSP (no ffmpeg process)
 *
 * All backends implement the same EventEmitter interface:
 *   events: 'frame' (Buffer), 'started', 'reconnecting', 'stats', 'warn', 'error'
 *   methods: start(), stop()
 */

const CAPTURE_BACKEND       = (process.env.CAPTURE_BACKEND        || 'ffmpeg').toLowerCase();
const MEDIAMTX_FRAME_BACKEND = (process.env.MEDIAMTX_FRAME_BACKEND || 'ffmpeg').toLowerCase();

let _warnedOnce = false;

function _createByName(name, cameraId, rtspUrl, opts) {
  switch (name) {
    case 'gstreamer': return new (require('./gstreamerCapture'))(cameraId, rtspUrl, opts);
    case 'pyav':      return new (require('./pyavCapture'))(cameraId, rtspUrl, opts);
    default:          return new (require('./rtspCapture'))(cameraId, rtspUrl, opts);
  }
}

function createCapture(cameraId, rtspUrl, opts = {}) {
  switch (CAPTURE_BACKEND) {
    case 'mediamtx':
      // rtspUrl is already set to rtsp://127.0.0.1:{port}/{cameraId} by pipelineManager.
      // Use MEDIAMTX_FRAME_BACKEND to select the actual frame-extraction implementation.
      return _createByName(MEDIAMTX_FRAME_BACKEND, cameraId, rtspUrl, opts);
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
