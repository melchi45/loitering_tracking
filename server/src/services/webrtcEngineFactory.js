'use strict';

/**
 * WebRTC Engine Factory
 *
 * Selects the WebRTC SFU/server backend based on the WEBRTC_ENGINE env variable.
 * All engines expose the same interface:
 *
 *   addCameraStream(cameraId, rtspUrl) → Promise<boolean>
 *   removeCameraStream(cameraId)       → Promise<void>
 *   waitForStreamReady(cameraId, ms)   → Promise<boolean>
 *   negotiate(cameraId, sdpOffer)      → Promise<{ status, sdpAnswer, headers }>
 *   isHealthy()                        → Promise<boolean>
 *   getEngineInfo()                    → object
 *
 * WEBRTC_ENGINE values:
 *   mediamtx  (default) — External MediaMTX process, WHEP protocol.
 *                          Requires MediaMTX to be running (npm run dev starts it).
 *   mediasoup           — mediasoup Node.js SFU (stub — not yet implemented).
 *   werift              — werift pure-TS WebRTC library (stub — not yet implemented).
 */

const WEBRTC_ENGINE = (process.env.WEBRTC_ENGINE || 'mediamtx').toLowerCase();

const VALID_ENGINES = ['mediamtx', 'mediasoup', 'werift'];
if (!VALID_ENGINES.includes(WEBRTC_ENGINE)) {
  console.warn(`[WebRTC] Unknown WEBRTC_ENGINE="${WEBRTC_ENGINE}", falling back to mediamtx`);
}

let _engine;

function getEngine() {
  if (_engine) return _engine;

  switch (WEBRTC_ENGINE) {
    case 'mediasoup':
      _engine = require('./webrtc/mediasoupEngine');
      break;
    case 'werift':
      _engine = require('./webrtc/weriftEngine');
      break;
    case 'mediamtx':
    default:
      _engine = require('./webrtc/mediamtxEngine');
  }

  console.log(`[WebRTC] Engine: ${_engine.ENGINE_NAME}`);
  return _engine;
}

module.exports = { getEngine, WEBRTC_ENGINE };
