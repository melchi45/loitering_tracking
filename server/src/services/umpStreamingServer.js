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
 * RTSP credentials, then relays between the WebSocket and a local TCP
 * connection to MediaMTX. That relay is near-transparent — RTSP text and
 * non-video interleaved channels pass through as opaque bytes — except for
 * one deliberate exception (2026-07-24, see classifyVideoRtpPacket() et al.
 * above _connectBackend()): the video track's RTP channel (H.264 or H.265,
 * whichever the DESCRIBE response's SDP declares) is held back (non-keyframe
 * slices dropped) until the first keyframe passes, since MediaMTX doesn't
 * wait for one before serving a newly-connected reader and <ump-player>
 * would otherwise spend the rest of the current GOP throwing "SPS payload
 * is not available" (mediaRouter.js:spsParse) on undecodable mid-GOP slices.
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

// --- Video keyframe gating (H.264/H.265, 2026-07-24) ---
// A new UMP WS viewer opens a brand-new MediaMTX RTSP reader session
// (_connectBackend below); MediaMTX does not wait for the next keyframe
// before serving a new reader — it forwards whatever the live GOP is doing
// "now". Since this bridge used to be a pure byte relay with no RTP
// awareness, <ump-player> would receive non-keyframe slices with no
// SPS/PPS (or VPS/SPS/PPS for H.265) cached yet and throw repeated "SPS
// payload is not available" (mediaRouter.js:spsParse, errorCode 772) until
// the encoder's next GOP boundary arrived. The functions below parse just
// enough of RTSP-over-TCP interleaved framing (RFC 7826 §10.12) and
// RTP/H.264 (RFC 6184) or RTP/H.265 (RFC 7798) — whichever the DESCRIBE
// response's SDP declares — to hold back non-keyframe video packets until
// the first keyframe (or an aggregate packet containing one) passes
// through, then the connection reverts to a plain relay for good. Every
// failure mode here (video codec not confirmed H264/H265, channel mapping
// not resolved, gate timeout) fails OPEN — this is a noise/latency
// optimization, never a hard requirement for playback.
const KEYFRAME_GATE_TIMEOUT_MS = 4000;
const MAX_PENDING_RTSP_TEXT_BYTES = 1024 * 1024;

// NAL unit types (ITU-T H.264 Annex B) that carry a non-IDR coded slice —
// these are what must be held back pre-keyframe.
const H264_NON_IDR_SLICE_TYPES = new Set([1, 2, 3, 4, 19, 20]);

/** Pulls one complete RTSP response (header block + Content-Length body, if
 * any) off the front of `buf`. Returns null if `buf` doesn't yet hold a full
 * response — the caller should wait for more data and retry. `raw` is the
 * exact original bytes (forwarded verbatim); `headerText`/`body` are decoded
 * only for inspection (CSeq/Transport/SDP parsing). */
function extractRtspResponseText(buf) {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const headerText = buf.slice(0, headerEnd).toString('utf8');
  const contentLength = parseInt(parseHeader(headerText, 'Content-Length') || '0', 10) || 0;
  const total = headerEnd + 4 + contentLength;
  if (buf.length < total) return null;
  return {
    raw: buf.slice(0, total),
    headerText,
    body: buf.slice(headerEnd + 4, total).toString('utf8'),
    consumed: total,
  };
}

/** Finds the video media block in a DESCRIBE response's SDP body and
 * returns its `a=control:` value (used to match this track's later SETUP
 * request) plus which codec its rtpmap declares — `'H264'` or `'H265'`.
 * Returns null for no video block, or a codec that is neither (e.g. MJPEG) —
 * either disables gating, since the NAL parsing below is codec-specific. */
function parseSdpVideoTrack(sdpBody) {
  const lines = sdpBody.split(/\r?\n/);
  let inVideo = false;
  let control = null;
  let codec = null;
  for (const line of lines) {
    if (/^m=video\b/.test(line)) { inVideo = true; continue; }
    if (/^m=/.test(line)) { if (inVideo) break; continue; }
    if (!inVideo) continue;
    const rtpmap = line.match(/^a=rtpmap:\d+\s+([\w-]+)\//i);
    if (rtpmap) {
      if (/^H264$/i.test(rtpmap[1])) codec = 'H264';
      else if (/^(H265|HEVC)$/i.test(rtpmap[1])) codec = 'H265';
    }
    const ctrl = line.match(/^a=control:(\S+)/i);
    if (ctrl) control = ctrl[1];
  }
  return (control && codec) ? { control, codec } : null;
}

/** Reads the RTP fixed header (RFC 3550 §5.1) and returns the payload that
 * follows it (CSRC list + optional extension header skipped). Returns null
 * if the packet is too short to hold what it claims to. */
function rtpPayload(packet) {
  if (packet.length < 12) return null;
  const cc = packet[0] & 0x0f;
  let offset = 12 + cc * 4;
  if (packet.length < offset) return null;
  const hasExtension = (packet[0] & 0x10) !== 0;
  if (hasExtension) {
    if (packet.length < offset + 4) return null;
    const extWords = packet.readUInt16BE(offset + 2);
    offset += 4 + extWords * 4;
  }
  return packet.length > offset ? packet.slice(offset) : null;
}

/** Classifies one H.264-over-RTP packet for the keyframe gate: whether it
 * should be forwarded while the gate is still closed, and whether seeing it
 * means the gate can now open (an IDR was found). Single NAL, FU-A
 * fragments, and STAP-A aggregates are handled — RTP's other aggregation
 * types (STAP-B/MTAP16/MTAP24) are vanishingly rare on IP cameras and fall
 * through to "always forward, never opens the gate" like SEI/unknown
 * types: harmless either way, since forwarding a packet the gate doesn't
 * recognize never blocks it from eventually opening on a later one. */
function classifyH264RtpPacket(packet) {
  const payload = rtpPayload(packet);
  if (!payload || payload.length === 0) return { forward: true, opensGate: false };
  const nalType = payload[0] & 0x1f;

  if (nalType === 24) { // STAP-A aggregate — scan entries for an embedded IDR
    let off = 1;
    let sawIdr = false;
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off);
      off += 2;
      if (off + size > payload.length) break;
      if ((payload[off] & 0x1f) === 5) sawIdr = true;
      off += size;
    }
    return { forward: true, opensGate: sawIdr };
  }
  if (nalType === 28) { // FU-A fragment — original NAL type lives in the FU header byte
    if (payload.length < 2) return { forward: true, opensGate: false };
    const fragType = payload[1] & 0x1f;
    if (H264_NON_IDR_SLICE_TYPES.has(fragType)) return { forward: false, opensGate: false };
    return { forward: true, opensGate: fragType === 5 };
  }
  if (H264_NON_IDR_SLICE_TYPES.has(nalType)) return { forward: false, opensGate: false };
  return { forward: true, opensGate: nalType === 5 };
}

// H.265/HEVC (RFC 7798) uses a completely different NAL layout from H.264:
// a 2-byte NAL header (type is bits 1-6 of the first byte, not the low 5
// bits of a 1-byte header), a different VCL/non-VCL type numbering, and
// different aggregation (AP, type 48) / fragmentation (FU, type 49) packet
// shapes. Types 0-15 are non-IRAP coded slices (TRAIL/TSA/STSA/RADL/RASL and
// the reserved range) — these must be held back pre-gate exactly like
// H.264's non-IDR slice types. Types 16-23 are IRAP pictures (BLA/IDR/CRA
// and reserved IRAP) — any of these is a valid decode-from-here point, so
// seeing one opens the gate.
function isH265NonIrapVcl(nalType) { return nalType <= 15; }
function isH265Irap(nalType) { return nalType >= 16 && nalType <= 23; }

/** classifyH264RtpPacket()'s H.265 counterpart — same gate contract (forward
 * while gate is closed? does this packet open the gate?), same handling of
 * single NAL / fragmented / aggregated packets, just with H.265's NAL
 * layout and type numbers instead of H.264's. */
function classifyH265RtpPacket(packet) {
  const payload = rtpPayload(packet);
  if (!payload || payload.length < 2) return { forward: true, opensGate: false };
  const nalType = (payload[0] >> 1) & 0x3f;

  if (nalType === 48) { // Aggregation Packet (RFC 7798 §4.4.2) — assumes no DONL field
    let off = 2; // skip the AP's own 2-byte NAL header
    let sawIrap = false;
    while (off + 2 <= payload.length) {
      const size = payload.readUInt16BE(off);
      off += 2;
      if (off + size > payload.length || size < 2) break;
      const innerType = (payload[off] >> 1) & 0x3f;
      if (isH265Irap(innerType)) sawIrap = true;
      off += size;
    }
    return { forward: true, opensGate: sawIrap };
  }
  if (nalType === 49) { // Fragmentation Unit (RFC 7798 §4.4.3) — 2-byte NAL header + 1-byte FU header
    if (payload.length < 3) return { forward: true, opensGate: false };
    const fragType = payload[2] & 0x3f;
    if (isH265NonIrapVcl(fragType)) return { forward: false, opensGate: false };
    return { forward: true, opensGate: isH265Irap(fragType) };
  }
  if (isH265NonIrapVcl(nalType)) return { forward: false, opensGate: false };
  return { forward: true, opensGate: isH265Irap(nalType) };
}

/** Dispatches to the codec-specific classifier the keyframe gate needs —
 * `videoCodec` comes from the DESCRIBE response's SDP (parseSdpVideoTrack())
 * and is only ever `'H264'` or `'H265'` by the time gating is enabled (see
 * handleBackendResponse() in handleConnection() below), so this never falls
 * through silently for a codec neither classifier understands. */
function classifyVideoRtpPacket(videoCodec, packet) {
  return videoCodec === 'H265' ? classifyH265RtpPacket(packet) : classifyH264RtpPacket(packet);
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

  // Keyframe gate state (see classifyVideoRtpPacket() et al. above) —
  // populated by inspecting the DESCRIBE/SETUP request-response pairs as
  // they pass through, then consulted only while relaying interleaved
  // video-channel frames.
  let videoControl = null;       // this track's a=control: value, from the DESCRIBE response SDP
  let videoCodec = null;         // 'H264' | 'H265' | null (null = codec not confirmed, gating stays off)
  let videoRtpChannel = null;    // interleaved channel number carrying this track's RTP (not RTCP)
  let gatingEnabled = false;     // true once videoRtpChannel is known — false = plain relay (fail open)
  let gateOpen = false;          // true once the first IDR has passed, or the gate timed out
  let gateDeadline = 0;
  const pendingCseqMethod = new Map();   // CSeq -> request method, to match backend responses
  const pendingSetupIsVideo = new Map(); // CSeq -> whether that SETUP targeted the video track

  const recordOutgoingRequest = (text) => {
    const reqLine = parseRtspRequestLine(text);
    if (!reqLine) return;
    const cseq = parseHeader(text, 'CSeq');
    if (!cseq) return;
    pendingCseqMethod.set(cseq, reqLine.method);
    if (reqLine.method === 'SETUP') {
      pendingSetupIsVideo.set(cseq, !!(videoControl && reqLine.uri.includes(videoControl)));
    }
  };

  const handleBackendResponse = (headerText, body) => {
    const cseq = parseHeader(headerText, 'CSeq');
    const method = cseq ? pendingCseqMethod.get(cseq) : null;
    if (cseq) pendingCseqMethod.delete(cseq);

    if (method === 'DESCRIBE' && body && !videoControl) {
      const track = parseSdpVideoTrack(body);
      if (track) {
        videoControl = track.control;
        videoCodec = track.codec;
      }
      return;
    }
    if (method === 'SETUP' && cseq) {
      const isVideoSetup = pendingSetupIsVideo.get(cseq);
      pendingSetupIsVideo.delete(cseq);
      if (isVideoSetup && videoCodec) {
        const transport = parseHeader(headerText, 'Transport');
        const m = transport && transport.match(/interleaved=(\d+)-(\d+)/);
        if (m) {
          videoRtpChannel = parseInt(m[1], 10);
          gatingEnabled = true;
          gateOpen = false;
          gateDeadline = Date.now() + KEYFRAME_GATE_TIMEOUT_MS;
          console.log(`[UmpStreamingServer][${camera?.id?.slice(0, 8)}] ${videoCodec} video RTP interleaved channel=${videoRtpChannel} — gating relay until first IDR (timeout ${KEYFRAME_GATE_TIMEOUT_MS}ms)`);
        }
      }
    }
  };

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
    recordOutgoingRequest(rewrittenText);
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

        // Backend -> client relay. Unlike relayToBackend() above (always RTSP
        // text), this direction carries both RTSP text responses AND, once
        // PLAY succeeds, RTSP-over-TCP interleaved binary frames ($<channel>
        // <2-byte length><payload>) — so it has to be demultiplexed instead
        // of forwarded as opaque chunks. Every frame/response is inspected
        // just enough to (a) learn the video track's interleaved RTP channel
        // from the DESCRIBE/SETUP exchange and (b) hold back that channel's
        // non-IDR H.264 packets until the keyframe gate opens (see the block
        // of functions above _connectBackend()); everything else — the other
        // channel(s), RTCP, and all RTSP text — is forwarded untouched.
        let backendBuf = Buffer.alloc(0);
        backendSocket.on('data', (chunk) => {
          backendBuf = backendBuf.length ? Buffer.concat([backendBuf, chunk]) : chunk;

          for (;;) {
            if (backendBuf.length === 0) break;

            if (backendBuf[0] === 0x24) { // '$' — interleaved binary frame
              if (backendBuf.length < 4) break;
              const channel = backendBuf[1];
              const len = backendBuf.readUInt16BE(2);
              const total = 4 + len;
              if (backendBuf.length < total) break;
              const frame = backendBuf.slice(0, total);
              backendBuf = backendBuf.slice(total);

              if (gatingEnabled && !gateOpen && channel === videoRtpChannel) {
                if (Date.now() > gateDeadline) {
                  gateOpen = true;
                  console.warn(`[UmpStreamingServer][${camera?.id?.slice(0, 8)}] no IDR within ${KEYFRAME_GATE_TIMEOUT_MS}ms — releasing gate anyway`);
                } else {
                  const { forward, opensGate } = classifyVideoRtpPacket(videoCodec, frame.slice(4));
                  if (opensGate) gateOpen = true;
                  if (!forward) continue; // pre-keyframe non-IDR slice — drop
                }
              }
              if (ws.readyState === ws.OPEN) ws.send(frame);
              continue;
            }

            // Text mode — an RTSP response (OPTIONS/DESCRIBE/SETUP/PLAY/...).
            const parsed = extractRtspResponseText(backendBuf);
            if (!parsed) {
              if (backendBuf.length > MAX_PENDING_RTSP_TEXT_BYTES) {
                // Not a well-formed RTSP response after 1MB — something is off
                // in a way this bridge doesn't understand. Fail open: stop
                // trying to parse framing for the rest of this connection
                // rather than stalling or growing the buffer unbounded.
                console.warn(`[UmpStreamingServer][${camera?.id?.slice(0, 8)}] backend stream did not resolve to a complete RTSP response after ${backendBuf.length}B — disabling keyframe gating and relaying raw`);
                if (ws.readyState === ws.OPEN) ws.send(backendBuf);
                backendBuf = Buffer.alloc(0);
                gatingEnabled = false;
              }
              break;
            }
            backendBuf = backendBuf.slice(parsed.consumed);
            handleBackendResponse(parsed.headerText, parsed.body);
            if (ws.readyState === ws.OPEN) ws.send(parsed.raw);
          }
        });
        backendSocket.on('close', () => ws.close());
        backendSocket.on('error', () => ws.close());
        // Forward this authenticated request — URI rewritten to MediaMTX's actual
        // path (see rewriteRequestUri()); MediaMTX ignores the Authorization
        // header itself, and everything after this is a dumb relay (still through
        // relayToBackend() for every later message, so the URI keeps getting
        // rewritten on subsequent DESCRIBE/SETUP/PLAY/... requests too).
        const initialRequest = rewriteRequestUri(text, clientBaseUri, backendTargetUri);
        recordOutgoingRequest(initialRequest);
        backendSocket.write(Buffer.from(initialRequest, 'utf8'));
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

module.exports = {
  attachUmpStreamingServer,
  // Exported for unit testing only (./umpStreamingServer.test.js) — pure
  // functions, no connection/socket state, safe to call directly.
  extractRtspResponseText,
  parseSdpVideoTrack,
  rtpPayload,
  classifyH264RtpPacket,
  classifyH265RtpPacket,
  classifyVideoRtpPacket,
};
