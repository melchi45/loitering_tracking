'use strict';

/**
 * UMP Player RTSP-over-WebSocket bridge (`/StreamingServer`) — 2026-07-23.
 *
 * See docs/design/Design_UMP_Player_RTSP_over_WebSocket.md §4.2 for the full
 * design. Summary: `<ump-player>` opens a plain WebSocket (not Socket.IO) to
 * `ws(s)://<host>/StreamingServer<path>` and tunnels standard RTSP-over-TCP
 * interleaved framing (RFC 7826 §10.12) through it — the same framing a real
 * Wisenet camera's own `/StreamingServer` endpoint speaks. That means this
 * bridge does not need to parse RTSP beyond the very first request: it reads
 * the request line to identify the target camera (channelSlot embedded in
 * the RTSP URL, e.g. `rtsp://host/0/media.smp` -> channelSlot 0), performs
 * one RTSP Digest (MD5) challenge/response using that camera's own stored
 * RTSP credentials, then becomes a pure byte relay between the WebSocket and
 * a local TCP connection to MediaMTX.
 *
 * Which MediaMTX path it relays against (2026-07-24, see handleConnection()'s
 * auth-success handler): preferentially, the camera's own already-existing
 * MediaMTX-direct path (named by camera.id) — the same source WebRTC uses
 * when WEBRTC_ENGINE=mediamtx, published by mediamtxManager.addCameraPath()
 * for every webrtcEnabled camera regardless of any UMP viewer. That path is
 * fed by MediaMTX's own native (Go, non-GIL) RTSP client, so it doesn't
 * inherit ingest-daemon's per-camera GIL contention under heavy fleet load
 * (confirmed live: a WebRTC viewer on this path got a clean 30fps/<0.01%
 * loss while ingest-daemon's own read-rate counter for the same camera, over
 * the on-demand path below, showed 40-60% of true rate). Falls back to
 * ingest-daemon's on-demand rtsp-publish fan-out (add_rtsp_publish() /
 * `<channelSlot>/media.smp`) only when no such path exists yet (camera isn't
 * webrtcEnabled, or MediaMTX hasn't finished registering it) — in that
 * fallback case only, no camera ever gets a second RTSP session from this
 * bridge: MediaMTX is fed entirely by ingest-daemon's own already-open
 * session, so any number of simultaneous UMP viewers on the same camera
 * share the one MediaMTX publish.
 */

const crypto = require('crypto');
const net = require('net');
const { WebSocketServer } = require('ws');
const mediamtxManager = require('./mediamtxManager');

const MEDIAMTX_RTSP_PORT = parseInt(process.env.MEDIAMTX_RTSP_PORT, 10) || 8554;
const INGEST_DAEMON_URL = (process.env.INGEST_DAEMON_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');
const REALM = 'lts-ump';
const MAX_AUTH_ATTEMPTS = 3;
const BACKEND_CONNECT_TIMEOUT_MS = 5000;

// Per-camera concurrent UMP viewer refcount — drives the on-demand
// ingest-daemon rtsp-publish fan-out start/stop (§4.1/§5-3 of the design doc).
// Only ever touched from this module; no cross-process/cross-worker sharing
// needed since a single Node process owns this WS server.
const _viewerCounts = new Map(); // cameraId -> count

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

async function _startFanout(cameraId, channelSlot) {
  try {
    const resp = await fetch(`${INGEST_DAEMON_URL}/cameras/${encodeURIComponent(cameraId)}/rtsp-publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelSlot }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`ingest-daemon responded ${resp.status}`);
  } catch (err) {
    console.warn(`[UmpStreamingServer][${cameraId.slice(0, 8)}] rtsp-publish start failed: ${err.message}`);
  }
}

async function _stopFanout(cameraId) {
  try {
    const resp = await fetch(`${INGEST_DAEMON_URL}/cameras/${encodeURIComponent(cameraId)}/rtsp-publish`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`ingest-daemon responded ${resp.status}`);
  } catch (err) {
    console.warn(`[UmpStreamingServer][${cameraId.slice(0, 8)}] rtsp-publish stop failed: ${err.message}`);
  }
}

/** Resolves once the fan-out is confirmed started for the first viewer; a no-op
 * (immediate resolve) for the 2nd+ concurrent viewer of the same camera. */
async function _acquireViewer(cameraId, channelSlot) {
  const next = (_viewerCounts.get(cameraId) || 0) + 1;
  _viewerCounts.set(cameraId, next);
  if (next === 1) await _startFanout(cameraId, channelSlot);
}

async function _releaseViewer(cameraId) {
  const next = (_viewerCounts.get(cameraId) || 1) - 1;
  if (next <= 0) {
    _viewerCounts.delete(cameraId);
    await _stopFanout(cameraId);
  } else {
    _viewerCounts.set(cameraId, next);
  }
}

function parseRtspRequestLine(text) {
  const firstLine = (text.split('\r\n')[0] || '').trim();
  const m = firstLine.match(/^([A-Z_]+)\s+(\S+)\s+RTSP\/[\d.]+$/);
  return m ? { method: m[1], uri: m[2] } : null;
}

function parseHeader(text, name) {
  const m = text.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
}

/** channelSlot is the first numeric path segment of the RTSP URL. The client
 * uses <ump-player device="nvr">, whose generateRTSPURL() builds
 * "LiveChannel/<channel>/media.smp" (or "PlaybackChannel/"/"BackupChannel/"
 * for other modes) — a non-numeric prefix precedes the channel number, so
 * this searches for the first numeric segment anywhere in the path rather
 * than anchoring to the start (device="camera" mode, which puts the channel
 * first, still matches the same way). */
function extractChannelSlot(uri) {
  let pathname = uri;
  try { pathname = new URL(uri).pathname; } catch { /* not a full URL — use as-is */ }
  const m = pathname.match(/\/(\d+)(?:\/|$)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseDigestAuthorization(text) {
  const header = parseHeader(text, 'Authorization');
  if (!header || !/^Digest/i.test(header)) return null;
  const out = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(header))) out[m[1]] = m[2];
  return out;
}

/** Rewrites an outgoing (client -> backend) RTSP request line's URI to target
 * MediaMTX instead of the camera's own hostname, leaving every other line
 * untouched. <ump-player device="nvr"> builds a base URI once from the
 * `channel`/`profile_number`/etc. attributes (e.g. "rtsp://<hostname>/
 * LiveChannel/<channel>/media.smp/profile=<n>") — that base has no relation
 * to the path ingest-daemon actually published on MediaMTX
 * (`<channelSlot>/media.smp`), so it must be replaced for MediaMTX to
 * recognize the request.
 *
 * OPTIONS/DESCRIBE reuse that base verbatim, but SETUP appends a track-
 * specific suffix on top of it (rtspClient.js's CommandConstructor builds
 * SETUP as `<ContentBase or base-URI> + requestURL`, where requestURL is a
 * track identifier parsed out of the DESCRIBE response's SDP) — confirmed
 * live (2026-07-23): blindly replacing the *entire* URI with the fixed
 * MediaMTX target (discarding that suffix) made every SETUP request
 * identical to the DESCRIBE one, which MediaMTX rejects with "invalid SETUP
 * path".
 *
 * Two distinct client behaviors were observed for that suffix, so both must
 * be handled:
 *  1. A prefix-preserving swap of `clientBaseUri` (the camera's own base URI,
 *     the only base the client has before it ever hears from MediaMTX).
 *  2. The client instead builds SETUP from the DESCRIBE response's own
 *     `Content-Base` header — which is MediaMTX's *own* base URI, forwarded
 *     to the client unmodified (backend -> client messages are never
 *     rewritten). That already-correct URI (confirmed live: "rtsp://
 *     127.0.0.1:{port}/{channelSlot}/media.smp/trackID=0") does NOT start
 *     with `clientBaseUri`, so it used to fall through to the "no known
 *     prefix" full-replacement branch — silently re-discarding the track
 *     suffix and reproducing the exact same "invalid SETUP path" bug this
 *     function exists to fix. Checking `targetUri` first (a no-op pass-
 *     through when the client already got it right) fixes this.
 */
function rewriteRequestUri(text, clientBaseUri, targetUri) {
  const idx = text.indexOf('\r\n');
  const firstLine = idx === -1 ? text : text.slice(0, idx);
  const rest = idx === -1 ? '' : text.slice(idx);
  const m = firstLine.match(/^([A-Z_]+)\s+(\S+)(\s+RTSP\/[\d.]+)\s*$/);
  if (!m) return text; // not a request line — forward unchanged, defensively
  const [, method, uri, suffix] = m;
  let newUri;
  if (targetUri && uri.startsWith(targetUri)) {
    newUri = uri; // client already built this from MediaMTX's own Content-Base — leave as-is
  } else if (clientBaseUri && uri.startsWith(clientBaseUri)) {
    newUri = targetUri + uri.slice(clientBaseUri.length);
  } else {
    newUri = targetUri;
  }
  return `${method} ${newUri}${suffix}${rest}`;
}

function buildRtspResponse(statusCode, statusText, cseq, extraHeaders = '') {
  return `RTSP/1.0 ${statusCode} ${statusText}\r\nCSeq: ${cseq}\r\n${extraHeaders}\r\n`;
}

/** Simple-mode RTSP Digest (no qop) — rtspClient.js's DigestGenerator falls back
 * to this exact scheme whenever the server's challenge omits qop/algorithm/opaque
 * (see submodules/ump-player/app/media/ump/Util/digestGenerator.js Digest()),
 * which is deliberate here: it avoids needing server-side nc/cnonce session state
 * for what is, in effect, an internal loopback-adjacent relay. */
function verifyDigest(auth, method, camera, nonce) {
  if (!auth || !auth.username || !auth.nonce || !auth.uri || !auth.response) return false;
  if (auth.nonce !== nonce) return false;
  if (auth.username !== (camera.username || '')) return false;
  const ha1 = md5(`${camera.username || ''}:${REALM}:${camera.password || ''}`);
  const ha2 = md5(`${method}:${auth.uri}`);
  const expected = md5(`${ha1}:${auth.nonce}:${ha2}`);
  return expected === auth.response;
}

function _connectBackend(cb) {
  const sock = net.connect({ host: '127.0.0.1', port: MEDIAMTX_RTSP_PORT });
  const timer = setTimeout(() => {
    sock.destroy();
    cb(new Error('backend connect timeout'));
  }, BACKEND_CONNECT_TIMEOUT_MS);
  sock.once('connect', () => { clearTimeout(timer); cb(null, sock); });
  sock.once('error', (err) => { clearTimeout(timer); cb(err); });
}

function handleConnection(ws, db) {
  let state = 'awaiting-auth'; // -> 'relaying'
  let nonce = null;
  let attempts = 0;
  let camera = null;
  let channelSlot = null;
  let clientBaseUri = null; // the client's own base URI (e.g. ".../LiveChannel/3/media.smp/profile=1"), captured from its first request
  let backendTargetUri = null; // rtsp://127.0.0.1:{MEDIAMTX_RTSP_PORT}/{channelSlot}/media.smp, or /{camera.id} — see usedIngestFanout below
  let backendSocket = null;
  let pendingRelay = [];
  let closed = false;
  let acquirePromise = null;
  // 2026-07-24: true only when this connection actually asked ingest-daemon
  // to open its on-demand rtsp-publish fan-out (see the auth-success handler
  // below) — set to false when an existing MediaMTX-direct path (the same
  // source WebRTC uses) was reused instead, so cleanup() knows not to call
  // _releaseViewer() for a viewer that was never acquired.
  let usedIngestFanout = false;

  const challenge = (cseq) => {
    nonce = crypto.randomBytes(16).toString('hex');
    attempts += 1;
    if (attempts > MAX_AUTH_ATTEMPTS) { ws.close(1008, 'too many auth attempts'); return; }
    ws.send(Buffer.from(buildRtspResponse(401, 'Unauthorized', cseq,
      `WWW-Authenticate: Digest realm="${REALM}", nonce="${nonce}"\r\n`)));
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (backendSocket) { try { backendSocket.destroy(); } catch { /* already gone */ } backendSocket = null; }
    if (acquirePromise && camera && usedIngestFanout) {
      const cameraId = camera.id;
      acquirePromise.then(() => _releaseViewer(cameraId)).catch(() => {});
    }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);

  // Client -> backend relay: rewrite the RTSP request-line URI (see
  // rewriteRequestUri() above) before forwarding — client-originated
  // messages are always RTSP text (never binary RTP/RTCP), so this is safe
  // to apply uniformly to everything this bridge sends toward MediaMTX.
  const relayToBackend = (rawData) => {
    const original = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
    const rewrittenText = rewriteRequestUri(original, clientBaseUri, backendTargetUri);
    if (rewrittenText !== original) {
      console.log(`[UmpStreamingServer][${camera?.id?.slice(0, 8)}] rewrote request line "${original.split('\r\n')[0]}" -> "${rewrittenText.split('\r\n')[0]}"`);
    }
    const rewritten = Buffer.from(rewrittenText, 'utf8');
    if (backendSocket && !backendSocket.destroyed) backendSocket.write(rewritten);
    else pendingRelay.push(rewritten);
  };

  ws.on('message', (data) => {
    if (state === 'relaying') {
      relayToBackend(data);
      return;
    }

    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    console.log(`[UmpStreamingServer] message (${data.length}B): ${text.slice(0, 300).replace(/\r\n/g, ' | ')}`);
    const reqLine = parseRtspRequestLine(text);
    if (!reqLine) {
      console.warn(`[UmpStreamingServer] close 1002: first line did not parse as an RTSP request — "${text.split('\r\n')[0]}"`);
      ws.close(1002, 'invalid RTSP request');
      return;
    }
    const cseq = parseHeader(text, 'CSeq') || '1';

    if (channelSlot === null) {
      channelSlot = extractChannelSlot(reqLine.uri);
      if (channelSlot === null) {
        console.warn(`[UmpStreamingServer] close 1008: no numeric channel segment found in URI "${reqLine.uri}"`);
        ws.close(1008, 'no channel in request URI');
        return;
      }
      camera = db.all('cameras').find((c) => c.channelSlot === channelSlot);
      if (!camera) {
        console.warn(`[UmpStreamingServer] close 1008: no camera has channelSlot=${channelSlot} (parsed from URI "${reqLine.uri}")`);
        ws.send(Buffer.from(buildRtspResponse(404, 'Not Found', cseq)));
        ws.close(1008, 'unknown channel');
        return;
      }
      clientBaseUri = reqLine.uri;
      backendTargetUri = `rtsp://127.0.0.1:${MEDIAMTX_RTSP_PORT}/${channelSlot}/media.smp`;
      console.log(`[UmpStreamingServer][${camera.id.slice(0, 8)}] matched channelSlot=${channelSlot} -> ${backendTargetUri} (client base "${clientBaseUri}")`);
    }

    const auth = parseDigestAuthorization(text);
    if (!auth || !nonce || !verifyDigest(auth, reqLine.method, camera, nonce)) {
      if (auth) {
        console.warn(`[UmpStreamingServer][${camera.id.slice(0, 8)}] digest verification failed (attempt ${attempts + 1}/${MAX_AUTH_ATTEMPTS}) — ` +
          `received username="${auth.username}" nonce="${auth.nonce}" uri="${auth.uri}" response="${auth.response}", ` +
          `expected nonce="${nonce}", expected camera.username="${camera.username || ''}" ` +
          `(camera has password: ${camera.password ? 'yes' : 'NO — empty/unset'})`);
      }
      challenge(cseq);
      return;
    }
    console.log(`[UmpStreamingServer][${camera.id.slice(0, 8)}] digest auth OK — switching to relay`);

    // Authenticated — switch to pure byte relay against local MediaMTX.
    state = 'relaying';
    // 2026-07-24: prefer an already-existing MediaMTX-direct path for this
    // camera (the same source WebRTC uses when WEBRTC_ENGINE=mediamtx —
    // mediamtxManager.addCameraPath() registers one per webrtcEnabled camera,
    // named by camera.id) over asking ingest-daemon to open a second,
    // redundant direct-to-camera RTSP session and re-publish it through
    // add_rtsp_publish(). Confirmed live (2026-07-24): ingest-daemon's own
    // Python process, juggling many concurrent cameras' RTSP read + AI decode
    // on one GIL, measurably falls behind a camera's true frame rate (a
    // WebRTC viewer on the SAME camera at the SAME time, sourced from
    // MediaMTX's own Go/non-GIL RTSP pull, reported a clean 30fps with
    // <0.01% packet loss while ingest-daemon's own read-rate counter for that
    // camera showed ~40-60% of true rate). A short (400ms) readiness probe
    // here is cheap and only matters for webrtcEnabled cameras that already
    // have this path; anything else falls back to the on-demand fan-out
    // exactly as before.
    acquirePromise = (async () => {
      const directPathReady = await mediamtxManager.waitForPathReady(camera.id, 400, 100);
      if (directPathReady) {
        backendTargetUri = `rtsp://127.0.0.1:${MEDIAMTX_RTSP_PORT}/${camera.id}`;
        console.log(`[UmpStreamingServer][${camera.id.slice(0, 8)}] reusing existing MediaMTX-direct path -> ${backendTargetUri} (bypassing ingest-daemon fan-out)`);
        return;
      }
      usedIngestFanout = true;
      await _acquireViewer(camera.id, channelSlot);
    })();
    acquirePromise.then(async () => {
      if (closed) return; // cleanup() already chained the matching release
      let pathReady = true;
      if (usedIngestFanout) {
        // Race: _acquireViewer() only waits for ingest-daemon's HTTP response to
        // POST /rtsp-publish (its own av.open() call returning), not for MediaMTX
        // to actually recognize the path as publishing — confirmed live
        // (2026-07-23): MediaMTX resolved the path name correctly but replied
        // "no stream is available on path '<channelSlot>/media.smp'" and closed
        // the connection within ~10ms of DESCRIBE arriving. Reuses the exact
        // same wait-for-ready pattern pipelineManager.js already relies on for
        // other MediaMTX paths (mediamtxManager.waitForPathReady()).
        const mediaMtxPathName = `${channelSlot}/media.smp`;
        pathReady = await mediamtxManager.waitForPathReady(mediaMtxPathName, 8000, 250);
        if (!pathReady) {
          console.warn(`[UmpStreamingServer][${camera.id.slice(0, 8)}] MediaMTX path "${mediaMtxPathName}" not ready after 8s`);
        }
      }
      if (closed) return;
      _connectBackend((err, sock) => {
        if (closed) { try { sock?.destroy(); } catch { /* ignore */ } return; }
        if (err || ws.readyState !== ws.OPEN) {
          try { sock?.destroy(); } catch { /* ignore */ }
          ws.close(1011, 'backend unavailable');
          return;
        }
        backendSocket = sock;
        for (const chunk of pendingRelay) backendSocket.write(chunk);
        pendingRelay = [];
        backendSocket.on('data', (chunk) => { if (ws.readyState === ws.OPEN) ws.send(chunk); });
        backendSocket.on('close', () => ws.close());
        backendSocket.on('error', () => ws.close());
        // Forward this authenticated request — URI rewritten to MediaMTX's actual
        // path (see rewriteRequestUri()); MediaMTX ignores the Authorization
        // header itself, and everything after this is a dumb relay (still through
        // relayToBackend() for every later message, so the URI keeps getting
        // rewritten on subsequent DESCRIBE/SETUP/PLAY/... requests too).
        backendSocket.write(Buffer.from(rewriteRequestUri(text, clientBaseUri, backendTargetUri), 'utf8'));
      });
    }).catch(() => {});
  });
}

/**
 * Attaches the /StreamingServer WS bridge to an existing HTTP(S) server.
 * Uses `noServer: true` + a manual 'upgrade' listener filtered by path prefix
 * so it coexists with Socket.IO's own upgrade handling on the same server —
 * Socket.IO already ignores upgrade requests whose path doesn't match its own
 * `/socket.io/` default, so no conflict.
 */
function attachUmpStreamingServer(httpServer, db) {
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/StreamingServer')) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  wss.on('connection', (ws) => handleConnection(ws, db));
  console.log('[UmpStreamingServer] /StreamingServer WS bridge attached');
  return wss;
}

module.exports = { attachUmpStreamingServer };
