'use strict';

const crypto = require('crypto');

/**
 * Per-camera secret used ONLY for the browser <-> rtspOverWebSocketServer.js
 * RTSP Digest handshake (server/src/services/rtspOverWebSocketServer.js's
 * verifyDigest()) — deliberately NOT the camera's real RTSP/SUNAPI password.
 * The browser never needs to know the actual device credential: this
 * server is what the browser authenticates to (not the camera itself), and
 * this server's own separate backend connection to the camera/MediaMTX
 * still uses the real stored camera.username/camera.password, entirely
 * server-side. See docs/design/Design_RTSP_Over_WebSocket.md §8.24.
 *
 * Lazily generated and persisted on first use (GET
 * /api/cameras/:id/rtsp-over-websocket-credentials, or a WS connection that
 * somehow reaches verifyDigest() before that endpoint was ever called) so
 * existing cameras don't need a migration.
 */
function getOrCreateRtspOverWebSocketSecret(db, camera) {
  if (camera.rtspOverWebSocketSecret) return camera.rtspOverWebSocketSecret;
  const secret = crypto.randomBytes(24).toString('hex');
  db.update('cameras', camera.id, { rtspOverWebSocketSecret: secret });
  camera.rtspOverWebSocketSecret = secret;
  return secret;
}

module.exports = { getOrCreateRtspOverWebSocketSecret };
