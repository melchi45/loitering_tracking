'use strict';

/**
 * mediasoup WebRTC engine.
 *
 * Architecture:
 *   - One mediasoup Worker + Router (shared across all cameras and viewers)
 *   - Per-camera: PlainTransport ← ffmpeg RTP (H.264 video only)
 *   - Per-browser-viewer: WebRtcTransport + Consumer (WHEP-style SDP exchange)
 *
 * Env vars consumed:
 *   SERVER_IP          — local IP announced to browsers in ICE candidates
 *   SERVER_PUBLIC_IP   — public IP announced (falls back to SERVER_IP)
 *   MEDIASOUP_MIN_PORT — start of RTC UDP port range (default 40000)
 *   MEDIASOUP_MAX_PORT — end of RTC UDP port range   (default 49999)
 */

const mediasoup = require('mediasoup');
const http      = require('http');

const ENGINE_NAME      = 'mediasoup';
const SERVER_IP        = (process.env.SERVER_IP || '127.0.0.1').trim();
const ANNOUNCED_IP     = (process.env.SERVER_PUBLIC_IP || process.env.SERVER_IP || '127.0.0.1').trim();
const RTC_MIN_PORT     = parseInt(process.env.MEDIASOUP_MIN_PORT || '40000', 10);
const RTC_MAX_PORT     = parseInt(process.env.MEDIASOUP_MAX_PORT || '49999', 10);
const INGEST_DAEMON_URL = (process.env.INGEST_DAEMON_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');

const VIDEO_PT   = 96;
const VIDEO_SSRC = 0x22334455;

// ── Singleton worker / router ─────────────────────────────────────────────────
let _worker = null;
let _router = null;
let _initP  = null;

// Per-camera state
const _cameras = new Map(); // cameraId → { producer, plainTransport }

// ── Go ingest daemon helpers ──────────────────────────────────────────────────

function _ingestPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(INGEST_DAEMON_URL + path);
    const req  = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { res.resume(); resolve(res.statusCode); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function _ingestDelete(cameraId) {
  return new Promise((resolve) => {
    const url = new URL(`${INGEST_DAEMON_URL}/cameras/${encodeURIComponent(cameraId)}`);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'DELETE' },
      res => { res.resume(); resolve(res.statusCode); }
    );
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function _ensureRouter() {
  if (_router && !_router.closed) return _router;
  if (_initP) return _initP;
  _initP = _boot().catch(err => { _initP = null; throw err; });
  return _initP;
}

async function _boot() {
  _worker = await mediasoup.createWorker({
    logLevel:   'warn',
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });

  _worker.on('died', () => {
    console.error('[WebRTC][mediasoup] worker died — resetting');
    _worker = null;
    _router = null;
    _initP  = null;
    for (const [id, cam] of _cameras.entries()) _closeCam(cam, id);
    _cameras.clear();
  });

  _router = await _worker.createRouter({
    mediaCodecs: [
      {
        kind:      'video',
        mimeType:  'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode':      1,
          'profile-level-id':        '42e01f',
          'level-asymmetry-allowed': 1,
        },
      },
    ],
  });

  console.log(
    `[WebRTC][mediasoup] ready  announced=${ANNOUNCED_IP}` +
    `  rtcPorts=${RTC_MIN_PORT}-${RTC_MAX_PORT}`
  );
  return _router;
}

function _closeCam(cam, cameraId) {
  if (!cam) return;
  if (cameraId) _ingestDelete(cameraId).catch(() => {});
  try { cam.producer?.close(); }       catch (_) {}
  try { cam.plainTransport?.close(); } catch (_) {}
}

// ── Camera stream management ───────────────────────────────────────────────────

async function addCameraStream(cameraId, rtspUrl) {
  try {
    const router = await _ensureRouter();
    await removeCameraStream(cameraId); // clean any prior state

    // PlainTransport: loopback RTP from ffmpeg
    const plainTransport = await router.createPlainTransport({
      listenIp: { ip: '127.0.0.1' },
      rtcpMux:  true,
      comedia:  true, // auto-detect remote address from first incoming RTP
    });
    const rtpPort = plainTransport.tuple.localPort;

    // Producer: expects H.264 / PT 96 / fixed SSRC from ffmpeg
    const producer = await plainTransport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [{
          mimeType:    'video/H264',
          payloadType: VIDEO_PT,
          clockRate:   90000,
          parameters: {
            'packetization-mode':      1,
            'profile-level-id':        '42e01f',
            'level-asymmetry-allowed': 1,
          },
        }],
        encodings: [{ ssrc: VIDEO_SSRC }],
      },
    });

    // Go ingest daemon: single RTSP connection → internal goroutine fan-out
    //   WebRTC goroutine: RTP → UDP → PlainTransport (rtpPort)
    //   AI goroutine:     H264 decode → JPEG → HTTP → Node.js /api/internal/frame/:id
    const serverPort = process.env.HTTP_PORT || process.env.PORT || 3080;
    const callbackUrl = `http://127.0.0.1:${serverPort}/api/internal/frame/${cameraId}`;
    const status = await _ingestPost('/cameras', {
      id:            cameraId,
      rtspUrl,
      mediasoupPort: rtpPort,
      callbackUrl,
    });
    if (status !== 200 && status !== 201) {
      throw new Error(`ingest-daemon returned HTTP ${status} for camera ${cameraId}`);
    }

    _cameras.set(cameraId, { producer, plainTransport });
    console.log(`[WebRTC][mediasoup] addCameraStream ${cameraId.slice(0, 8)} → RTP :${rtpPort} (ingest-daemon)`);
    return true;
  } catch (err) {
    console.error(`[WebRTC][mediasoup] addCameraStream failed: ${err.message}`);
    return false;
  }
}

async function removeCameraStream(cameraId) {
  const cam = _cameras.get(cameraId);
  if (!cam) return;
  _cameras.delete(cameraId);
  _closeCam(cam, cameraId);
}

async function waitForStreamReady(cameraId, maxWaitMs = 8000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const cam = _cameras.get(cameraId);
    if (!cam || cam.producer.closed) return false;
    if (cam.producer.score && cam.producer.score.length > 0) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  // Return true if camera entry still exists (ffmpeg may have just started)
  return _cameras.has(cameraId);
}

// ── SDP helpers ───────────────────────────────────────────────────────────────

function _parseOffer(sdp) {
  const lines = sdp.split(/\r?\n/);
  const result = {
    videoMid:    '0',
    audioMid:    '1',
    fingerprint: { algorithm: 'sha-256', value: '' },
    hasAudio:    false,
  };

  let section = 'session';
  let gotVideoMid = false;
  let gotAudioMid = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('m=video')) { section = 'video'; continue; }
    if (line.startsWith('m=audio')) { section = 'audio'; result.hasAudio = true; continue; }
    if (line.startsWith('m='))      { section = 'other'; continue; }

    if (line.startsWith('a=fingerprint:') && !result.fingerprint.value) {
      const parts = line.slice('a=fingerprint:'.length).split(' ');
      result.fingerprint = { algorithm: parts[0], value: parts[1] };
    }

    if (line.startsWith('a=mid:')) {
      const mid = line.slice('a=mid:'.length);
      if (section === 'video' && !gotVideoMid) { result.videoMid = mid; gotVideoMid = true; }
      if (section === 'audio' && !gotAudioMid) { result.audioMid = mid; gotAudioMid = true; }
    }
  }
  return result;
}

function _buildAnswer({ videoMid, audioMid, hasAudio, transport, consumer }) {
  const { iceParameters, iceCandidates, dtlsParameters } = transport;
  const { rtpParameters } = consumer;

  const fp        = dtlsParameters.fingerprints[dtlsParameters.fingerprints.length - 1];
  const mainCodec = rtpParameters.codecs.find(c => !c.mimeType.toLowerCase().includes('rtx'));
  const rtxCodec  = rtpParameters.codecs.find(c =>  c.mimeType.toLowerCase().includes('rtx'));
  const encoding  = rtpParameters.encodings[0] || {};

  const payloadTypes = rtpParameters.codecs.map(c => c.payloadType).join(' ');

  const codecLines = [
    `a=rtpmap:${mainCodec.payloadType} ${mainCodec.mimeType.split('/')[1]}/${mainCodec.clockRate}`,
  ];
  if (mainCodec.parameters && Object.keys(mainCodec.parameters).length > 0) {
    const fmtp = Object.entries(mainCodec.parameters).map(([k, v]) => `${k}=${v}`).join(';');
    codecLines.push(`a=fmtp:${mainCodec.payloadType} ${fmtp}`);
  }
  if (rtxCodec) {
    codecLines.push(`a=rtpmap:${rtxCodec.payloadType} rtx/${rtxCodec.clockRate}`);
    codecLines.push(`a=fmtp:${rtxCodec.payloadType} apt=${mainCodec.payloadType}`);
  }

  const extLines = (rtpParameters.headerExtensions || []).map(
    ext => `a=extmap:${ext.id} ${ext.uri}`
  );

  const ssrcLines = [];
  if (encoding.ssrc) {
    ssrcLines.push(`a=ssrc:${encoding.ssrc} cname:mediasoup`);
    ssrcLines.push(`a=ssrc:${encoding.ssrc} msid:mediasoup-video mediasoup-video-track`);
    ssrcLines.push(`a=ssrc:${encoding.ssrc} mslabel:mediasoup-video`);
    ssrcLines.push(`a=ssrc:${encoding.ssrc} label:mediasoup-video-track`);
    if (encoding.rtx?.ssrc && rtxCodec) {
      ssrcLines.push(`a=ssrc:${encoding.rtx.ssrc} cname:mediasoup`);
      ssrcLines.push(`a=ssrc-group:FID ${encoding.ssrc} ${encoding.rtx.ssrc}`);
    }
  }

  const candidateLines = iceCandidates.map(c =>
    `a=candidate:${c.foundation} 1 ${c.protocol.toLowerCase()} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`
  );

  const bundleMids = hasAudio ? `${videoMid} ${audioMid}` : videoMid;

  const lines = [
    'v=0',
    `o=mediasoup 10000 10000 IN IP4 ${ANNOUNCED_IP}`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${bundleMids}`,
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',

    // ── video ───────────────────────────────────────────────────────────────
    `m=video 7 UDP/TLS/RTP/SAVPF ${payloadTypes}`,
    `c=IN IP4 ${ANNOUNCED_IP}`,
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${iceParameters.usernameFragment}`,
    `a=ice-pwd:${iceParameters.password}`,
    'a=ice-options:trickle',
    `a=fingerprint:${fp.algorithm} ${fp.value}`,
    'a=setup:passive',
    `a=mid:${videoMid}`,
    'a=sendonly',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    ...codecLines,
    ...extLines,
    ...ssrcLines,
    ...candidateLines,
  ];

  // ── audio: bundle-only, inactive ──────────────────────────────────────────
  if (hasAudio) {
    lines.push(
      `m=audio 9 UDP/TLS/RTP/SAVPF 111`,
      `c=IN IP4 ${ANNOUNCED_IP}`,
      'a=bundle-only',
      `a=mid:${audioMid}`,
      'a=inactive',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1'
    );
  }

  return lines.join('\r\n') + '\r\n';
}

// ── WHEP negotiate ────────────────────────────────────────────────────────────

async function negotiate(cameraId, sdpOffer) {
  const cam = _cameras.get(cameraId);
  if (!cam) {
    return {
      status:    503,
      sdpAnswer: `Camera ${cameraId} is not streaming via mediasoup. Start the camera first.`,
      headers:   {},
    };
  }

  try {
    const router = await _ensureRouter();
    const parsed = _parseOffer(sdpOffer);

    if (!parsed.fingerprint.value) {
      return { status: 400, sdpAnswer: 'Could not parse DTLS fingerprint from SDP offer', headers: {} };
    }

    // Create a WebRtcTransport for this browser viewer
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    // Provide the browser's DTLS fingerprint so mediasoup can verify the handshake
    await transport.connect({
      dtlsParameters: {
        role:         'client', // browser is DTLS client (we answer with a=setup:passive)
        fingerprints: [parsed.fingerprint],
      },
    });

    // Create a Consumer: router bridges Producer → Consumer across transports
    const consumer = await transport.consume({
      producerId:      cam.producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused:          false,
    });

    // Clean up when browser disconnects
    transport.on('dtlsstatechange', state => {
      if (state === 'failed' || state === 'closed') {
        try { transport.close(); } catch (_) {}
      }
    });

    const sdpAnswer = _buildAnswer({
      videoMid: parsed.videoMid,
      audioMid: parsed.audioMid,
      hasAudio: parsed.hasAudio,
      transport,
      consumer,
    });

    return { status: 201, sdpAnswer, headers: {} };
  } catch (err) {
    console.error(`[WebRTC][mediasoup] negotiate [${cameraId.slice(0, 8)}]: ${err.message}`);
    return { status: 503, sdpAnswer: err.message, headers: {} };
  }
}

// ── Health / info ─────────────────────────────────────────────────────────────

async function isHealthy() {
  try {
    await _ensureRouter();
    return !_worker?.closed && !_router?.closed;
  } catch {
    return false;
  }
}

function getEngineInfo() {
  return {
    engine:      'mediasoup',
    transportId: `mediasoup-sfu  rtcPorts=${RTC_MIN_PORT}-${RTC_MAX_PORT}`,
    iceCandidates: [],
    whepProxy:   '/api/webrtc/whep/:cameraId',
    announcedIp: ANNOUNCED_IP,
  };
}

module.exports = {
  ENGINE_NAME,
  addCameraStream,
  removeCameraStream,
  waitForStreamReady,
  negotiate,
  isHealthy,
  getEngineInfo,
};
