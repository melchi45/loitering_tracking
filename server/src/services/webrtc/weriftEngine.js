'use strict';

/**
 * werift WebRTC engine — stub implementation.
 *
 * Full implementation requires:
 *   1. npm install werift  (in server/)
 *   2. An RTCPeerConnection per camera (Node.js-side)
 *   3. RTP ingestion from the RTSP stream (ffmpeg -f rtp or GStreamer rtpbin)
 *   4. Custom WHEP-compatible signaling endpoint
 *
 * Until implemented, all WebRTC connections will be refused with HTTP 501.
 * Set WEBRTC_ENGINE=mediamtx in .env to use the default engine.
 */

const ENGINE_NAME = 'werift';

let _warned = false;
function _warnNotImplemented() {
  if (_warned) return;
  _warned = true;
  console.warn(
    '[WebRTC][werift] werift engine is not yet implemented. ' +
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
    sdpAnswer: 'werift engine is not yet implemented. Set WEBRTC_ENGINE=mediamtx.',
    headers:   {},
  };
}

async function isHealthy() {
  return false;
}

function getEngineInfo() {
  return {
    engine:       'werift',
    transportId:  'werift (not yet implemented)',
    iceCandidates: [],
  };
}

module.exports = { ENGINE_NAME, addCameraStream, removeCameraStream, waitForStreamReady, negotiate, isHealthy, getEngineInfo };
