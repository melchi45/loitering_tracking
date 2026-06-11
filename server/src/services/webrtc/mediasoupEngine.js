'use strict';

/**
 * mediasoup WebRTC engine — stub implementation.
 *
 * Full implementation requires:
 *   1. npm install mediasoup  (in server/)
 *   2. A mediasoup Worker + Router per camera
 *   3. PlainTransport to ingest the RTSP/RTP stream from ffmpeg/GStreamer
 *   4. WebRtcTransport for browser-facing WHEP/DTLS signaling
 *
 * Until implemented, all WebRTC connections will be refused with HTTP 501.
 * Set WEBRTC_ENGINE=mediamtx in .env to use the default engine.
 */

const ENGINE_NAME = 'mediasoup';

let _warned = false;
function _warnNotImplemented() {
  if (_warned) return;
  _warned = true;
  console.warn(
    '[WebRTC][mediasoup] mediasoup engine is not yet implemented. ' +
    'WebRTC streams will be unavailable. Set WEBRTC_ENGINE=mediamtx to restore WebRTC.'
  );
}

async function addCameraStream(cameraId, _rtspUrl) {
  _warnNotImplemented();
  return false;
}

async function removeCameraStream(_cameraId) {}

async function waitForStreamReady(_cameraId, _maxWaitMs) {
  return false;
}

async function negotiate(_cameraId, _sdpOffer) {
  return {
    status:    501,
    sdpAnswer: 'mediasoup engine is not yet implemented. Set WEBRTC_ENGINE=mediamtx.',
    headers:   {},
  };
}

async function isHealthy() {
  return false;
}

function getEngineInfo() {
  return {
    engine:       'mediasoup',
    transportId:  'mediasoup (not yet implemented)',
    iceCandidates: [],
  };
}

module.exports = { ENGINE_NAME, addCameraStream, removeCameraStream, waitForStreamReady, negotiate, isHealthy, getEngineInfo };
