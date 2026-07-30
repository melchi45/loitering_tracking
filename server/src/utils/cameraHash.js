'use strict';

/**
 * Deterministic cameraId → bucket-index hash, shared by every subsystem that
 * splits cameras across a fixed-size pool of workers/processes (mediasoup
 * Worker pool — see webrtc/mediasoupEngine.js §6.31 — and the ingest-daemon
 * multi-process fleet — see services/ingestDaemonPool.js §6.45). Extracted
 * so both pools use the exact same, well-understood hash rather than two
 * independently-drifting copies.
 */

function hashCameraId(cameraId) {
  let h = 0;
  for (let i = 0; i < cameraId.length; i++) h = (h * 31 + cameraId.charCodeAt(i)) | 0;
  return h;
}

// `undefined`/empty cameraId (e.g. a generic liveness probe with no specific
// camera in mind) always lands on bucket 0 rather than hashing garbage.
function indexForCamera(cameraId, modulus) {
  if (!cameraId) return 0;
  return Math.abs(hashCameraId(cameraId)) % modulus;
}

module.exports = { hashCameraId, indexForCamera };
