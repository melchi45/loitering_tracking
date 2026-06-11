'use strict';

/**
 * mediasoup WebRTC engine — Audio + Video + DataChannel.
 *
 * Architecture:
 *   - One mediasoup Worker + Router (shared across all cameras and viewers)
 *   - Per-camera PlainTransports:
 *       videoPlain ← H.264 RTP from ingest-daemon UDP:{mediasoupPort}
 *       audioPlain ← Opus  RTP from ingest-daemon UDP:{mediasoupAudioPort}
 *   - Per-camera DirectTransport → DataProducer (App RTP / server-push events)
 *   - Per-browser-viewer: WebRtcTransport (enableSctp=true) + video Consumer
 *       + audio Consumer + DataConsumer (WHEP-style SDP exchange)
 *
 * Env vars consumed:
 *   SERVER_IP            — local IP announced to browsers in ICE candidates
 *   SERVER_PUBLIC_IP     — public IP announced (falls back to SERVER_IP)
 *   MEDIASOUP_MIN_PORT   — start of RTC UDP port range (default 40000)
 *   MEDIASOUP_MAX_PORT   — end of RTC UDP port range   (default 49999)
 *   INGEST_DAEMON_URL    — ingest-daemon base URL (default http://127.0.0.1:7070)
 *   MEDIAMTX_RTSP_PORT   — MediaMTX RTSP loopback port (default 8554)
 *   HTTP_PORT / PORT     — server HTTP port for callback URLs (default 3080)
 *   HTTPS_ENABLED        — 'true' to use HTTPS for callback URLs
 *   HTTPS_PORT           — server HTTPS port (default 3443)
 */

const mediasoup = require('mediasoup');
const http      = require('http');

const ENGINE_NAME       = 'mediasoup';
const ANNOUNCED_IP      = (process.env.SERVER_PUBLIC_IP || process.env.SERVER_IP || '127.0.0.1').trim();
const RTC_MIN_PORT      = parseInt(process.env.MEDIASOUP_MIN_PORT || '40000', 10);
const RTC_MAX_PORT      = parseInt(process.env.MEDIASOUP_MAX_PORT || '49999', 10);
const INGEST_DAEMON_URL = (process.env.INGEST_DAEMON_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');

const VIDEO_PT   = 96;
const AUDIO_PT   = 111;
const VIDEO_SSRC = 0x22334455;
const AUDIO_SSRC = 0x33445566;

// ── Singleton worker / router ─────────────────────────────────────────────────
let _worker = null;
let _router = null;
let _initP  = null;

// Per-camera state map
// cameraId → { videoPlain, videoProducer, audioPlain, audioProducer, directTransport, dataProducer }
const _cameras = new Map();

// ── ingest-daemon HTTP helpers ────────────────────────────────────────────────

function _ingestPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(INGEST_DAEMON_URL + path);
    const req  = http.request(
      {
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
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

// ── Router boot ───────────────────────────────────────────────────────────────

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
      {
        kind:      'audio',
        mimeType:  'audio/opus',
        clockRate: 48000,
        channels:  2,
      },
    ],
  });

  console.log(
    `[WebRTC][mediasoup] ready  announced=${ANNOUNCED_IP}  rtcPorts=${RTC_MIN_PORT}-${RTC_MAX_PORT}`
  );
  return _router;
}

function _closeCam(cam, cameraId) {
  if (!cam) return;
  if (cameraId) _ingestDelete(cameraId).catch(() => {});
  try { cam.videoProducer?.close(); }    catch (_) {}
  try { cam.audioProducer?.close(); }    catch (_) {}
  try { cam.dataProducer?.close(); }     catch (_) {}
  try { cam.videoPlain?.close(); }       catch (_) {}
  try { cam.audioPlain?.close(); }       catch (_) {}
  try { cam.directTransport?.close(); }  catch (_) {}
}

// ── Camera stream management ───────────────────────────────────────────────────

async function addCameraStream(cameraId, rtspUrl) {
  try {
    const router = await _ensureRouter();
    await removeCameraStream(cameraId);

    // ── Video PlainTransport ─────────────────────────────────────────────────
    const videoPlain = await router.createPlainTransport({
      listenIp: { ip: '127.0.0.1' },
      rtcpMux:  true,
      comedia:  true,
    });
    const videoPort = videoPlain.tuple.localPort;

    const videoProducer = await videoPlain.produce({
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

    // ── Audio PlainTransport ─────────────────────────────────────────────────
    const audioPlain = await router.createPlainTransport({
      listenIp: { ip: '127.0.0.1' },
      rtcpMux:  true,
      comedia:  true,
    });
    const audioPort = audioPlain.tuple.localPort;

    const audioProducer = await audioPlain.produce({
      kind: 'audio',
      rtpParameters: {
        codecs: [{
          mimeType:    'audio/opus',
          payloadType: AUDIO_PT,
          clockRate:   48000,
          channels:    2,
          parameters:  { minptime: 10, useinbandfec: 1 },
        }],
        encodings: [{ ssrc: AUDIO_SSRC }],
      },
    });

    // ── DirectTransport + DataProducer (App RTP data from camera) ────────────
    const directTransport = await router.createDirectTransport({ maxMessageSize: 262144 });

    const dataProducer = await directTransport.produceData({
      label:    `apprtp-${cameraId.slice(0, 8)}`,
      protocol: 'json',
      ordered:  false,
    });

    // ── Register with ingest-daemon ──────────────────────────────────────────
    const isHttps = (process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';
    const serverPort = isHttps
      ? (process.env.HTTPS_PORT || '3443')
      : (process.env.HTTP_PORT || process.env.PORT || '3080');
    const proto = isHttps ? 'https' : 'http';
    const base  = `${proto}://127.0.0.1:${serverPort}`;

    const status = await _ingestPost('/cameras', {
      id:                 cameraId,
      rtspUrl,
      callbackUrl:        `${base}/api/internal/frame/${cameraId}`,
      appRtpCallbackUrl:  `${base}/api/internal/apprtp/${cameraId}`,
      mediasoupPort:      videoPort,
      mediasoupAudioPort: audioPort,
    });

    if (status !== 200 && status !== 201) {
      throw new Error(`ingest-daemon returned HTTP ${status}`);
    }

    _cameras.set(cameraId, {
      videoPlain, videoProducer,
      audioPlain, audioProducer,
      directTransport, dataProducer,
    });

    console.log(
      `[WebRTC][mediasoup] ${cameraId.slice(0, 8)} ` +
      `video:${videoPort} audio:${audioPort} (ingest-daemon)`
    );
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
    if (!cam) return false;
    if (cam.videoProducer.score?.length > 0) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return _cameras.has(cameraId);
}

// ── Application RTP / server-push event forwarding ───────────────────────────

function sendAppRtp(cameraId, payload) {
  const cam = _cameras.get(cameraId);
  if (!cam?.dataProducer || cam.dataProducer.closed) return;
  try {
    const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
    cam.dataProducer.send(msg);
  } catch (_) {}
}

// ── SDP helpers ───────────────────────────────────────────────────────────────

function _parseOffer(sdp) {
  const lines = sdp.split(/\r?\n/);
  const result = {
    videoMid:    '0',
    audioMid:    '1',
    dataMid:     '2',
    fingerprint: { algorithm: 'sha-256', value: '' },
    hasAudio:    false,
    hasData:     false,
  };

  let section = 'session';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('m=video'))       { section = 'video'; continue; }
    if (line.startsWith('m=audio'))       { section = 'audio'; result.hasAudio = true; continue; }
    if (line.startsWith('m=application')) { section = 'data';  result.hasData  = true; continue; }
    if (line.startsWith('m='))            { section = 'other'; continue; }

    if (line.startsWith('a=fingerprint:') && !result.fingerprint.value) {
      const [algo, val] = line.slice('a=fingerprint:'.length).split(' ');
      result.fingerprint = { algorithm: algo, value: val };
    }

    if (line.startsWith('a=mid:')) {
      const mid = line.slice('a=mid:'.length);
      if (section === 'video') result.videoMid = mid;
      if (section === 'audio') result.audioMid = mid;
      if (section === 'data')  result.dataMid  = mid;
    }
  }
  return result;
}

function _buildAnswer({ parsed, transport, videoConsumer, audioConsumer, dataConsumer }) {
  const { iceParameters, iceCandidates, dtlsParameters, sctpParameters } = transport;
  const fp = dtlsParameters.fingerprints[dtlsParameters.fingerprints.length - 1];

  const candidateLines = iceCandidates.map(c =>
    `a=candidate:${c.foundation} 1 ${c.protocol.toLowerCase()} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`
  );

  // ── Video codec lines ──────────────────────────────────────────────────────
  const vParams   = videoConsumer.rtpParameters;
  const vCodec    = vParams.codecs.find(c => !c.mimeType.toLowerCase().includes('rtx'));
  const vRtx      = vParams.codecs.find(c =>  c.mimeType.toLowerCase().includes('rtx'));
  const vEnc      = vParams.encodings[0] || {};
  const vPTs      = vParams.codecs.map(c => c.payloadType).join(' ');

  const vCodecLines = [
    `a=rtpmap:${vCodec.payloadType} ${vCodec.mimeType.split('/')[1]}/${vCodec.clockRate}`,
  ];
  if (vCodec.parameters && Object.keys(vCodec.parameters).length) {
    const fmtp = Object.entries(vCodec.parameters).map(([k, v]) => `${k}=${v}`).join(';');
    vCodecLines.push(`a=fmtp:${vCodec.payloadType} ${fmtp}`);
  }
  if (vRtx) {
    vCodecLines.push(`a=rtpmap:${vRtx.payloadType} rtx/${vRtx.clockRate}`);
    vCodecLines.push(`a=fmtp:${vRtx.payloadType} apt=${vCodec.payloadType}`);
  }

  const vExtLines  = (vParams.headerExtensions || []).map(
    ext => `a=extmap:${ext.id} ${ext.uri}`
  );
  const vSsrcLines = [];
  if (vEnc.ssrc) {
    vSsrcLines.push(`a=ssrc:${vEnc.ssrc} cname:mediasoup`);
    if (vEnc.rtx?.ssrc && vRtx) {
      vSsrcLines.push(`a=ssrc:${vEnc.rtx.ssrc} cname:mediasoup`);
      vSsrcLines.push(`a=ssrc-group:FID ${vEnc.ssrc} ${vEnc.rtx.ssrc}`);
    }
  }

  // ── Audio section ──────────────────────────────────────────────────────────
  const aLines = [];
  if (audioConsumer) {
    const aParams = audioConsumer.rtpParameters;
    const aCodec  = aParams.codecs[0];
    const aEnc    = aParams.encodings[0] || {};
    aLines.push(
      `m=audio 9 UDP/TLS/RTP/SAVPF ${aCodec.payloadType}`,
      `c=IN IP4 ${ANNOUNCED_IP}`,
      'a=bundle-only',
      `a=mid:${parsed.audioMid}`,
      'a=recvonly',
      'a=rtcp-mux',
      `a=rtpmap:${aCodec.payloadType} opus/${aCodec.clockRate}/2`,
      `a=fmtp:${aCodec.payloadType} minptime=10;useinbandfec=1`,
    );
    if (aEnc.ssrc) aLines.push(`a=ssrc:${aEnc.ssrc} cname:mediasoup`);
  } else {
    aLines.push(
      `m=audio 0 UDP/TLS/RTP/SAVPF 0`,
      `c=IN IP4 0.0.0.0`,
      'a=bundle-only',
      `a=mid:${parsed.audioMid}`,
      'a=inactive',
    );
  }

  // ── DataChannel section (m=application) ───────────────────────────────────
  const dLines = [];
  if (dataConsumer && parsed.hasData) {
    const sctpPort = sctpParameters?.port || 5000;
    dLines.push(
      `m=application 9 UDP/DTLS/SCTP webrtc-datachannel`,
      `c=IN IP4 ${ANNOUNCED_IP}`,
      'a=bundle-only',
      `a=mid:${parsed.dataMid}`,
      `a=sctp-port:${sctpPort}`,
      `a=max-message-size:262144`,
    );
  }

  // ── BUNDLE group ───────────────────────────────────────────────────────────
  const bundleMids = [parsed.videoMid, parsed.audioMid];
  if (dLines.length) bundleMids.push(parsed.dataMid);

  const lines = [
    'v=0',
    `o=mediasoup 10000 10000 IN IP4 ${ANNOUNCED_IP}`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${bundleMids.join(' ')}`,
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',

    // ── Video ────────────────────────────────────────────────────────────────
    `m=video 7 UDP/TLS/RTP/SAVPF ${vPTs}`,
    `c=IN IP4 ${ANNOUNCED_IP}`,
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${iceParameters.usernameFragment}`,
    `a=ice-pwd:${iceParameters.password}`,
    'a=ice-options:trickle',
    `a=fingerprint:${fp.algorithm} ${fp.value}`,
    'a=setup:passive',
    `a=mid:${parsed.videoMid}`,
    'a=sendonly',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    ...vCodecLines,
    ...vExtLines,
    ...vSsrcLines,
    ...candidateLines,

    // ── Audio ────────────────────────────────────────────────────────────────
    ...aLines,

    // ── DataChannel ──────────────────────────────────────────────────────────
    ...dLines,
  ];

  return lines.join('\r\n') + '\r\n';
}

// ── WHEP negotiate ────────────────────────────────────────────────────────────

async function negotiate(cameraId, sdpOffer) {
  const cam = _cameras.get(cameraId);
  if (!cam) {
    return {
      status:    503,
      sdpAnswer: `Camera ${cameraId} is not streaming via mediasoup.`,
      headers:   {},
    };
  }

  try {
    const router = await _ensureRouter();
    const parsed = _parseOffer(sdpOffer);

    if (!parsed.fingerprint.value) {
      return { status: 400, sdpAnswer: 'Could not parse DTLS fingerprint from SDP offer', headers: {} };
    }

    // WebRtcTransport with SCTP enabled for DataChannel
    const transport = await router.createWebRtcTransport({
      listenIps:          [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
      enableUdp:          true,
      enableTcp:          true,
      preferUdp:          true,
      enableSctp:         true,
      numSctpStreams:      { OS: 1024, MIS: 1024 },
      maxSctpMessageSize: 262144,
    });

    await transport.connect({
      dtlsParameters: {
        role:         'client',
        fingerprints: [parsed.fingerprint],
      },
    });

    // Video Consumer
    const videoConsumer = await transport.consume({
      producerId:      cam.videoProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused:          false,
    });

    // Audio Consumer (non-fatal if audio hasn't started yet)
    let audioConsumer = null;
    if (!cam.audioProducer.closed) {
      audioConsumer = await transport.consume({
        producerId:      cam.audioProducer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused:          false,
      }).catch(() => null);
    }

    // DataConsumer (only if browser included m=application in offer)
    let dataConsumer = null;
    if (parsed.hasData && !cam.dataProducer.closed) {
      dataConsumer = await transport.consumeData({
        dataProducerId: cam.dataProducer.id,
      }).catch(() => null);
    }

    transport.on('dtlsstatechange', state => {
      if (state === 'failed' || state === 'closed') {
        try { transport.close(); } catch (_) {}
      }
    });

    const sdpAnswer = _buildAnswer({ parsed, transport, videoConsumer, audioConsumer, dataConsumer });

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
    announcedIp: ANNOUNCED_IP,
    rtcPorts:    `${RTC_MIN_PORT}-${RTC_MAX_PORT}`,
    cameras:     _cameras.size,
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
  sendAppRtp,
};
