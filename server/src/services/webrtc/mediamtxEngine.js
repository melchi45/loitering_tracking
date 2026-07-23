'use strict';

/**
 * MediaMTX WebRTC engine — delegates to mediamtxManager.
 *
 * Uses the WHEP protocol: browser POSTs an SDP offer to /api/webrtc/whep/:cameraId,
 * which this engine proxies to MediaMTX at MEDIAMTX_WEBRTC_URL/{cameraId}/whep.
 * ICE media (UDP) flows directly between the browser and MediaMTX.
 *
 * YouTube cameras publish to MediaMTX at path yt/{cameraId} (not {cameraId}) —
 * the WHEP route resolves the correct path and passes it as negotiate()'s
 * mediamtxPath override so the WHEP request targets the path that actually
 * has a publisher.
 */

const mediamtxManager = require('../mediamtxManager');

const MEDIAMTX_WEBRTC = process.env.MEDIAMTX_WEBRTC_URL || 'http://127.0.0.1:8889';

const ENGINE_NAME = 'mediamtx';

async function addCameraStream(cameraId, rtspUrl) {
  return mediamtxManager.addCameraPath(cameraId, rtspUrl);
}

async function removeCameraStream(cameraId) {
  return mediamtxManager.removeCameraPath(cameraId);
}

async function waitForStreamReady(cameraId, maxWaitMs = 8000) {
  return mediamtxManager.waitForPathReady(cameraId, maxWaitMs);
}

async function negotiate(cameraId, sdpOffer, mediamtxPath) {
  const whepUrl = `${MEDIAMTX_WEBRTC}/${mediamtxPath || cameraId}/whep`;
  const upstream = await fetch(whepUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body:    sdpOffer,
  });
  const sdpAnswer = await upstream.text();
  const headers = {};
  for (const hdr of ['location', 'link', 'etag', 'access-control-expose-headers']) {
    const val = upstream.headers.get(hdr);
    if (val) headers[hdr] = val;
  }
  return { status: upstream.status, sdpAnswer, headers };
}

async function isHealthy() {
  return mediamtxManager.isHealthy();
}

function getEngineInfo() {
  const serverIp       = process.env.SERVER_IP        || '';
  const serverPublicIp = process.env.SERVER_PUBLIC_IP || '';
  const udpPort        = parseInt(process.env.MEDIAMTX_WEBRTC_UDP_PORT || '8189', 10);
  const iceCandidates  = [];
  if (serverIp) iceCandidates.push({ type: 'host', ip: serverIp,       port: udpPort, protocol: 'udp' });
  if (serverPublicIp && serverPublicIp !== serverIp) {
    iceCandidates.push({ type: 'host', ip: serverPublicIp, port: udpPort, protocol: 'udp' });
  }
  return {
    engine:       'mediamtx-whep',
    transportId:  'MediaMTX WHEP',
    iceCandidates,
    whepProxy:    '/api/webrtc/whep/:cameraId',
    udpPort,
  };
}

module.exports = { ENGINE_NAME, addCameraStream, removeCameraStream, waitForStreamReady, negotiate, isHealthy, getEngineInfo };
