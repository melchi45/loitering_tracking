'use strict';

/**
 * MediaMTX path manager — registers/removes camera RTSP sources via the MediaMTX REST API.
 *
 * For each WebRTC-enabled camera, pipelineManager calls addCameraPath() so MediaMTX
 * pulls the RTSP stream and serves it as WebRTC via WHEP at:
 *   http://127.0.0.1:8889/{cameraId}/whep   (proxied by /api/webrtc/whep/:cameraId)
 *
 * API reference: https://bluenviron.github.io/mediamtx/#tag/paths
 */

const http = require('http');

const MEDIAMTX_API = process.env.MEDIAMTX_API_URL || 'http://127.0.0.1:9997';

/** Simple HTTP request helper (avoids external dependencies). */
function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port:     u.port || 9997,
      path:     u.pathname + u.search,
      method,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {},
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('MediaMTX API timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Register a camera's RTSP source as a MediaMTX path so it is published as WebRTC.
 * Non-fatal: logs a warning on failure so the JPEG/AI pipeline still runs.
 *
 * @param {string} cameraId  UUID used as the MediaMTX path name
 * @param {string} rtspUrl   Camera RTSP URL (may contain credentials)
 */
async function addCameraPath(cameraId, rtspUrl) {
  try {
    const body = JSON.stringify({
      source:            rtspUrl,
      sourceOnDemand:    false,
      overridePublisher: true,
    });

    // Try v3 API first (MediaMTX 1.0+), fall back to v2 on 404
    let res = await request('POST', `${MEDIAMTX_API}/v3/config/paths/add/${cameraId}`, body);
    if (res.status === 404) {
      res = await request('POST', `${MEDIAMTX_API}/v2/config/paths/add/${cameraId}`, body);
    }

    // 400 means the path already exists from a previous server run — patch it instead
    if (res.status === 400) {
      res = await request('PATCH', `${MEDIAMTX_API}/v3/config/paths/patch/${cameraId}`, body);
      if (res.status === 404) {
        res = await request('PATCH', `${MEDIAMTX_API}/v2/config/paths/patch/${cameraId}`, body);
      }
    }

    if (res.status >= 200 && res.status < 300) {
      console.log(`[MediaMTX] Path registered: /${cameraId}`);
      return true;
    }
    console.warn(`[MediaMTX] addCameraPath(${cameraId.slice(0,8)}) HTTP ${res.status}: ${res.body.slice(0,120)}`);
    return false;
  } catch (err) {
    console.warn(`[MediaMTX] addCameraPath(${cameraId.slice(0,8)}) failed (MediaMTX not running?): ${err.message}`);
    return false;
  }
}

/**
 * Remove a camera's MediaMTX path (called when a pipeline stops).
 * Non-fatal.
 *
 * @param {string} cameraId
 */
async function removeCameraPath(cameraId) {
  try {
    let res = await request('DELETE', `${MEDIAMTX_API}/v3/config/paths/delete/${cameraId}`);
    if (res.status === 404) {
      res = await request('DELETE', `${MEDIAMTX_API}/v2/config/paths/delete/${cameraId}`);
    }
    if (res.status >= 200 && res.status < 300) {
      console.log(`[MediaMTX] Path removed: /${cameraId}`);
    }
    // 404 means path was already gone — that's fine
  } catch (err) {
    console.warn(`[MediaMTX] removeCameraPath(${cameraId.slice(0,8)}) failed: ${err.message}`);
  }
}

/**
 * Poll the MediaMTX runtime path endpoint until the source is ready (upstream RTSP
 * connected) or the timeout expires.  Avoids the race where PyAV starts immediately
 * after path registration but MediaMTX hasn't finished its upstream pull handshake.
 *
 * @param {string} cameraId
 * @param {number} [maxWaitMs=8000]   Give up after this many ms (non-fatal).
 * @param {number} [pollMs=250]       How often to poll.
 * @returns {Promise<boolean>}        true = path became ready; false = timed out.
 */
async function waitForPathReady(cameraId, maxWaitMs = 8000, pollMs = 250) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', `${MEDIAMTX_API}/v3/paths/get/${cameraId}`);
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.ready === true) return true;
      }
    } catch (_) { /* MediaMTX not yet started — keep polling */ }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Check MediaMTX health.
 * @returns {Promise<boolean>}
 */
async function isHealthy() {
  try {
    const res = await request('GET', `${MEDIAMTX_API}/v3/config/global/get`);
    return res.status < 400;
  } catch {
    return false;
  }
}

module.exports = { addCameraPath, removeCameraPath, waitForPathReady, isHealthy };
