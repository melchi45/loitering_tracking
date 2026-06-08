'use strict';

/**
 * RTSP Capture Backend Factory
 *
 * CAPTURE_BACKEND env var:
 *   mediamtx  (recommended) — MediaMTX manages the camera connection.
 *               Browser WebRTC (WHEP) is served directly from MediaMTX.
 *               AI frame extraction polls the MediaMTX snapshot API by default
 *               (no ffmpeg subprocess). Override with MEDIAMTX_FRAME_BACKEND.
 *               Requires MediaMTX ≥ 1.2.0, api: yes in mediamtx.yml.
 *
 *   ffmpeg    — FFmpeg subprocess connects directly to the camera RTSP URL.
 *               Default when CAPTURE_BACKEND is not set. Widest codec/OS compat.
 *
 *   gstreamer — GStreamer pipeline (lower latency, hardware decode via nvdec/vaapi).
 *               Requires gstreamer1.0-tools + gstreamer1.0-plugins-*.
 *
 *   pyav      — Python PyAV sidecar (best CUDA utilisation, GPU-inference path).
 *               Requires: pip3 install av Pillow
 *
 * MEDIAMTX_FRAME_BACKEND env var (only used when CAPTURE_BACKEND=mediamtx):
 *   snapshot  — Poll MediaMTX REST snapshot API. No subprocess. (default)
 *               GET http://localhost:{MEDIAMTX_API_PORT}/v3/paths/{id}/get-snapshot
 *   ffmpeg    — FFmpeg reads from MediaMTX local RTSP re-publish.
 *   gstreamer — GStreamer reads from MediaMTX local RTSP (GPU hw-decode).
 *   pyav      — Python PyAV reads from MediaMTX local RTSP.
 *
 * All backends expose the same EventEmitter interface:
 *   events: 'frame'(Buffer), 'started', 'reconnecting', 'stats', 'warn', 'error'
 *   methods: start(), stop()
 */

const CAPTURE_BACKEND        = (process.env.CAPTURE_BACKEND        || 'ffmpeg').toLowerCase();
const MEDIAMTX_FRAME_BACKEND = (process.env.MEDIAMTX_FRAME_BACKEND || 'snapshot').toLowerCase();

let _warnedOnce = false;

function _createByName(name, cameraId, rtspUrl, opts) {
  switch (name) {
    case 'snapshot':  return new (require('./mediamtxSnapshotCapture'))(cameraId, rtspUrl, opts);
    case 'gstreamer': return new (require('./gstreamerCapture'))(cameraId, rtspUrl, opts);
    case 'pyav':      return new (require('./pyavCapture'))(cameraId, rtspUrl, opts);
    default:          return new (require('./rtspCapture'))(cameraId, rtspUrl, opts);
  }
}

function createCapture(cameraId, rtspUrl, opts = {}) {
  switch (CAPTURE_BACKEND) {
    case 'mediamtx':
      // pipelineManager already set rtspUrl = rtsp://127.0.0.1:{MEDIAMTX_RTSP_PORT}/{cameraId}
      // but the snapshot backend ignores rtspUrl (it polls the REST API instead).
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
