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
const os        = require('os');

const ENGINE_NAME       = 'mediasoup';
const ANNOUNCED_IP      = (process.env.SERVER_PUBLIC_IP || process.env.SERVER_IP || '127.0.0.1').trim();

// Build the list of IPs mediasoup should bind and announce as ICE candidates.
// Only use explicitly configured SERVER_IP / SERVER_PUBLIC_IP to avoid advertising
// extra interfaces (e.g. 55.x.x.x public IPs) that the browser might use as loopback
// targets, causing ICE to complete on a path where mediasoup sends SRTP to itself.
function _getListenIps() {
  const ips = new Set();
  const serverIp     = (process.env.SERVER_IP        || '').trim();
  const serverPubIp  = (process.env.SERVER_PUBLIC_IP || '').trim();
  if (serverIp    && serverIp    !== '0.0.0.0') ips.add(serverIp);
  if (serverPubIp && serverPubIp !== '0.0.0.0') ips.add(serverPubIp);
  if (ANNOUNCED_IP  && ANNOUNCED_IP  !== '0.0.0.0') ips.add(ANNOUNCED_IP);
  const list = [...ips];
  if (list.length === 0) return [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }];
  return list.map(ip => ({ ip, announcedIp: ip }));
}
const RTC_MIN_PORT      = parseInt(process.env.MEDIASOUP_MIN_PORT || '40000', 10);
const RTC_MAX_PORT      = parseInt(process.env.MEDIASOUP_MAX_PORT || '49999', 10);
const INGEST_DAEMON_URL = (process.env.INGEST_DAEMON_URL || 'http://127.0.0.1:7070').replace(/\/$/, '');

const VIDEO_PT   = 96;
const AUDIO_PT   = 111;
// These SSRCs must match _MEDIASOUP_VIDEO_SSRC / _MEDIASOUP_AUDIO_SSRC in ingest_daemon.py.
// mediasoup requires ssrc (or rid/mid) in PlainTransport Producer encodings.
const VIDEO_SSRC = 0x22334455;  // 573785173 decimal
const AUDIO_SSRC = 0x33445566;  // 860116326 decimal

// ── Singleton worker / router ─────────────────────────────────────────────────
let _worker = null;
let _router = null;
let _initP  = null;

// Per-camera state map
// cameraId → { videoPlain, videoProducer, audioPlain, audioProducer, directTransport, dataProducer }
const _cameras = new Map();

// Active Consumer registry: cameraId → Array<{ transport, videoConsumer, audioConsumer, created }>
// Used for per-connection diagnostics (bytesSent, paused state).
const _activeConsumers = new Map();

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
    console.error('[WebRTC][mediasoup] worker died — resetting and re-registering cameras');
    // Save camera list before clearing so we can restore streams after reboot
    const toRestore = [..._cameras.entries()]
      .filter(([, cam]) => cam.rtspUrl)
      .map(([id, cam]) => ({ id, rtspUrl: cam.rtspUrl }));
    _worker = null;
    _router = null;
    _initP  = null;
    for (const [id, cam] of _cameras.entries()) _closeCam(cam, id);
    _cameras.clear();
    if (toRestore.length > 0) {
      setTimeout(async () => {
        console.log(`[WebRTC][mediasoup] re-registering ${toRestore.length} cameras after worker restart`);
        for (const { id, rtspUrl } of toRestore) {
          try { await addCameraStream(id, rtspUrl); }
          catch (e) { console.error(`[WebRTC][mediasoup] re-register failed ${id.slice(0,8)}: ${e.message}`); }
        }
      }, 2000);
    }
  });

  // Edge offers PT=109=H264/42e01f/pm=1 (confirmed via client DB stats: inbound-rtp=0 at PT=108).
  // Chrome also offers PT=108=H264 but accepts the answer re-assigning PT=109=H264 (JSEP compliant).
  // mediasoup v3.19+ always uses the ROUTER's preferredPayloadType as the Consumer's PT —
  // SRTP arrives (candidate-pair bytesRx > 0) but Edge discards packets with mismatched PT,
  // leaving inbound-rtp.bytesReceived = 0 and black video.
  // PT=109 for H264 + PT=111 for Opus matches Edge's PT assignments and Chrome tolerates it.
  _router = await _worker.createRouter({
    mediaCodecs: [
      {
        kind:      'video',
        mimeType:  'video/H264',
        preferredPayloadType: 109,
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
        preferredPayloadType: 111,
        clockRate: 48000,
        channels:  2,
      },
    ],
  });

  const listenIps = _getListenIps().map(x => x.announcedIp).join(', ');
  console.log(
    `[WebRTC][mediasoup] ready  announcedIps=[${listenIps}]  rtcPorts=${RTC_MIN_PORT}-${RTC_MAX_PORT}`
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
      rtspUrl,
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
    // URI → numeric ID maps built from the browser's a=extmap lines.
    // We MUST echo back the same IDs in the answer; Chrome rejects any
    // reassignment (id X used for URI A in offer but URI B in answer).
    videoExtIds: {},   // uri → id
    audioExtIds: {},   // uri → id
    // PT values the browser assigned in its offer — used to build
    // browser-specific rtpCapabilities so the Consumer sends RTP
    // with PTs the browser has a decoder registered for.
    videoPt:    null,  // H264 payload type
    videoRtxPt: null,  // RTX payload type for H264
    audioPt:    null,  // Opus payload type
  };

  let section = 'session';
  // Collect rtpmap (pt → { kind, codec, clockRate }) and fmtp (pt → params)
  // for video and audio sections to derive browser PT assignments.
  const rtpmapByPt = {};
  const fmtpByPt   = {};

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

    // a=extmap:N[/dir] URI [attributes]
    if (line.startsWith('a=extmap:') && (section === 'video' || section === 'audio')) {
      const m = line.match(/^a=extmap:(\d+)(?:\/\S+)?\s+(\S+)/);
      if (m) {
        const id = parseInt(m[1], 10);
        const uri = m[2];
        if (section === 'video') result.videoExtIds[uri] = id;
        if (section === 'audio') result.audioExtIds[uri] = id;
      }
    }

    // Collect a=rtpmap lines in video/audio sections
    if ((section === 'video' || section === 'audio') && line.startsWith('a=rtpmap:')) {
      const m = line.match(/^a=rtpmap:(\d+)\s+([^/\s]+)\/(\d+)/);
      if (m) {
        rtpmapByPt[parseInt(m[1], 10)] = { kind: section, codec: m[2].toLowerCase() };
      }
    }

    // Collect a=fmtp lines in video/audio sections
    if ((section === 'video' || section === 'audio') && line.startsWith('a=fmtp:')) {
      const m = line.match(/^a=fmtp:(\d+)\s+(.+)/);
      if (m) fmtpByPt[parseInt(m[1], 10)] = m[2];
    }
  }

  // Determine the browser's H264 PT.
  // Priority: pm=1 + profile=42e01f (matches our router codec) > any pm=1 > any H264
  let h264CbpPm1Pt = null; // pm=1 + 42e01f — exact match for our router codec
  let h264Pm1Pt    = null; // any pm=1 H264 — fallback
  let h264AnyPt    = null; // any H264 — last resort
  for (const [ptStr, info] of Object.entries(rtpmapByPt)) {
    const pt = parseInt(ptStr, 10);
    if (info.kind === 'video' && info.codec === 'h264') {
      const params = fmtpByPt[pt] || '';
      const isPm1     = params.includes('packetization-mode=1');
      const isCbp42e  = params.includes('profile-level-id=42e01f');
      if (isPm1 && isCbp42e  && h264CbpPm1Pt === null) h264CbpPm1Pt = pt;
      else if (isPm1         && h264Pm1Pt    === null) h264Pm1Pt    = pt;
      else if (h264AnyPt     === null)                 h264AnyPt    = pt;
    }
  }
  result.videoPt = h264CbpPm1Pt ?? h264Pm1Pt ?? h264AnyPt;

  // Determine the browser's RTX PT associated with the chosen H264 PT
  if (result.videoPt !== null) {
    for (const [ptStr, info] of Object.entries(rtpmapByPt)) {
      const pt = parseInt(ptStr, 10);
      if (info.kind === 'video' && info.codec === 'rtx') {
        const aptMatch = (fmtpByPt[pt] || '').match(/apt=(\d+)/);
        if (aptMatch && parseInt(aptMatch[1], 10) === result.videoPt) {
          result.videoRtxPt = pt;
          break;
        }
      }
    }
  }

  // Determine the browser's Opus PT
  for (const [ptStr, info] of Object.entries(rtpmapByPt)) {
    if (info.kind === 'audio' && (info.codec === 'opus' || info.codec === 'multiopus')) {
      result.audioPt = parseInt(ptStr, 10);
      break;
    }
  }

  return result;
}

// Build mediasoup RTP capabilities using the browser's PT assignments from its SDP offer.
// transport.consume() uses preferredPayloadType to set the Consumer's codec PT, so the
// SDP answer and outgoing RTP both use PTs the browser already registered decoders for.
function _buildBrowserRtpCapabilities(parsed, routerCaps) {
  if (parsed.videoPt === null && parsed.audioPt === null) return routerCaps;

  const caps = JSON.parse(JSON.stringify(routerCaps));

  // Update primary codec PTs
  for (const codec of caps.codecs) {
    if (codec.kind === 'video' && /h264/i.test(codec.mimeType) && parsed.videoPt !== null) {
      codec.preferredPayloadType = parsed.videoPt;
    }
    if (codec.kind === 'audio' && /opus/i.test(codec.mimeType) && parsed.audioPt !== null) {
      codec.preferredPayloadType = parsed.audioPt;
    }
  }

  // Update RTX PT and apt to match the new H264 PT.
  // mediasoup's getConsumerRtpParameters matches RTX codecs by apt=primaryPT —
  // if apt still points to the old PT the RTX entry will be silently dropped.
  if (parsed.videoPt !== null) {
    const origH264Pt = routerCaps.codecs.find(
      c => c.kind === 'video' && /h264/i.test(c.mimeType)
    )?.preferredPayloadType;

    for (const codec of caps.codecs) {
      if (
        codec.kind === 'video' &&
        /rtx/i.test(codec.mimeType) &&
        codec.parameters?.apt === origH264Pt
      ) {
        if (parsed.videoRtxPt !== null) codec.preferredPayloadType = parsed.videoRtxPt;
        codec.parameters = { ...codec.parameters, apt: parsed.videoPt };
        break;
      }
    }
  }

  // Remap header extension preferredIds to match the browser's offer.
  // mediasoup v3.19 sends RTP using the Consumer's headerExtension preferredIds.
  // If these don't match the browser's offer extmap IDs, the browser can't find
  // the MID extension in incoming RTP → BUNDLE demux fails → all RTP is dropped.
  const allExtIds = { ...parsed.videoExtIds, ...parsed.audioExtIds };
  for (const ext of (caps.headerExtensions || [])) {
    const browserId = allExtIds[ext.uri];
    if (browserId !== undefined) {
      ext.preferredId = browserId;
    }
  }

  return caps;
}

function _buildAnswer({ parsed, transport, videoConsumer, audioConsumer, dataConsumer, cameraId = '' }) {
  const streamId = `lts-${cameraId ? cameraId.slice(0, 8) : 'mediasoup'}`;
  const { iceParameters, iceCandidates, dtlsParameters, sctpParameters } = transport;
  // Prefer sha-256 — Chrome/Firefox reject sha-224. Fall back to the last entry.
  const fp = dtlsParameters.fingerprints.find(f => f.algorithm === 'sha-256')
          || dtlsParameters.fingerprints[dtlsParameters.fingerprints.length - 1];

  const candidateLines = iceCandidates.map(c => {
    let line = `a=candidate:${c.foundation} 1 ${c.protocol.toLowerCase()} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`;
    if (c.tcpType) line += ` tcptype ${c.tcpType}`;
    return line;
  });

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

  // Use the browser's extension IDs from the offer (not mediasoup's internal IDs).
  // Chrome rejects setRemoteDescription if the answer assigns an ID to a different
  // URI than the offer used for that same ID ("RTP extension ID reassignment").
  const vExtLines = (vParams.headerExtensions || [])
    .filter(ext => parsed.videoExtIds[ext.uri] !== undefined)
    .map(ext => `a=extmap:${parsed.videoExtIds[ext.uri]} ${ext.uri}`);
  // Include a=ssrc for the video track.
  // RTX is disabled so only one SSRC exists — no Unified Plan dual-ssrc issue.
  // The browser uses SSRC as a fallback BUNDLE demux key when the MID extension
  // is absent or its extension ID doesn't match, preventing dropped RTP packets.
  const vSsrcLines = vEnc.ssrc ? [`a=ssrc:${vEnc.ssrc} cname:mediasoup`] : [];
  // a=msid associates the video track with a stream so event.streams[0] is populated
  // in the browser's ontrack handler. Without this Chrome sets event.streams = [].
  const vMsidLine = `a=msid:${streamId} video`;

  // ── Audio section ──────────────────────────────────────────────────────────
  const aLines = [];
  if (audioConsumer) {
    const aParams  = audioConsumer.rtpParameters;
    const aCodec   = aParams.codecs[0];
    const aEnc     = aParams.encodings[0] || {};
    const aExtLines = (aParams.headerExtensions || [])
      .filter(ext => parsed.audioExtIds[ext.uri] !== undefined)
      .map(ext => `a=extmap:${parsed.audioExtIds[ext.uri]} ${ext.uri}`);
    aLines.push(
      `m=audio 9 UDP/TLS/RTP/SAVPF ${aCodec.payloadType}`,
      `c=IN IP4 ${ANNOUNCED_IP}`,
      'a=bundle-only',
      `a=mid:${parsed.audioMid}`,
      'a=sendonly',
      'a=rtcp-mux',
      `a=rtpmap:${aCodec.payloadType} opus/${aCodec.clockRate}/2`,
      `a=fmtp:${aCodec.payloadType} minptime=10;useinbandfec=1`,
      ...aExtLines,
      `a=msid:${streamId} audio`,
    );
    if (aEnc.ssrc) aLines.push(`a=ssrc:${aEnc.ssrc} cname:mediasoup`);
  } else if (parsed.hasAudio) {
    // Reject audio (offer had m=audio but we have no audio Consumer yet)
    aLines.push(
      `m=audio 0 UDP/TLS/RTP/SAVPF 0`,
      `c=IN IP4 0.0.0.0`,
      'a=bundle-only',
      `a=mid:${parsed.audioMid}`,
      'a=inactive',
    );
  }

  // ── DataChannel section (m=application) ───────────────────────────────────
  // SDP answer must have the same number of m-sections as the offer.
  // If the offer contains m=application but we cannot create a DataConsumer,
  // reject it with port=0 rather than omitting the section (omission = invalid SDP).
  const dLines = [];
  if (parsed.hasData) {
    if (dataConsumer) {
      const sctpPort = sctpParameters?.port || 5000;
      dLines.push(
        `m=application 9 UDP/DTLS/SCTP webrtc-datachannel`,
        `c=IN IP4 ${ANNOUNCED_IP}`,
        'a=bundle-only',
        `a=mid:${parsed.dataMid}`,
        `a=sctp-port:${sctpPort}`,
        `a=max-message-size:262144`,
      );
    } else {
      dLines.push(
        `m=application 0 UDP/DTLS/SCTP webrtc-datachannel`,
        `c=IN IP4 0.0.0.0`,
        'a=bundle-only',
        `a=mid:${parsed.dataMid}`,
        'a=inactive',
      );
    }
  }

  // ── BUNDLE group (only include non-rejected mids) ─────────────────────────
  const bundleMids = [parsed.videoMid];
  if (audioConsumer) bundleMids.push(parsed.audioMid);
  if (dataConsumer && parsed.hasData) bundleMids.push(parsed.dataMid);

  const lines = [
    'v=0',
    `o=mediasoup 10000 10000 IN IP4 ${ANNOUNCED_IP}`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${bundleMids.join(' ')}`,
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',

    // ── Video ────────────────────────────────────────────────────────────────
    `m=video 9 UDP/TLS/RTP/SAVPF ${vPTs}`,
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
    vMsidLine,
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

    // Log browser ICE candidates so we can diagnose network connectivity issues.
    const browserCands = sdpOffer.match(/a=candidate:[^\r\n]+/g) || [];
    const browserIPs = [...new Set(browserCands.map(c => { const m = c.match(/\d+\.\d+\.\d+\.\d+/g); return m ? m[0] : null; }).filter(Boolean))];
    console.log(`[WebRTC][mediasoup] WHEP [${cameraId.slice(0,8)}] browser-IPs=[${browserIPs.join(', ') || 'none-gathered'}]`);
    console.log(
      `[WebRTC][mediasoup] WHEP [${cameraId.slice(0,8)}]` +
      ` browser H264-PT=${parsed.videoPt} RTX-PT=${parsed.videoRtxPt} Opus-PT=${parsed.audioPt}`
    );

    // WebRtcTransport with SCTP enabled for DataChannel.
    // listenIps includes all non-docker server IPs so the browser can reach it
    // regardless of which network segment it's on.
    const transport = await router.createWebRtcTransport({
      listenIps:          _getListenIps(),
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

    // mediasoup v3.19+ derives the Consumer's PT from the router's consumable PT
    // (ignoring preferredPayloadType in the passed rtpCapabilities). The router
    // Build capabilities that remap extension IDs to match the browser's offer.
    // mediasoup v3.19 sends RTP using Consumer.rtpParameters.headerExtensions[].preferredId.
    // If these don't match the browser's a=extmap IDs, the browser can't find the MID
    // extension in incoming RTP → BUNDLE demux fails → all packets dropped, no inbound-rtp.
    // Note: v3.19+ derives codec PT from the ROUTER's preferredPayloadType (ignoring
    // preferredPayloadType in passed caps) — hence the router is configured with PT=109.
    // RTX is disabled: the auto-assigned RTX PT would conflict with other browser codecs.
    const browserCaps = _buildBrowserRtpCapabilities(parsed, router.rtpCapabilities);

    // Video Consumer
    const videoConsumer = await transport.consume({
      producerId:      cam.videoProducer.id,
      rtpCapabilities: browserCaps,
      paused:          false,
      enableRtx:       false,
    });

    // Audio Consumer (non-fatal if audio hasn't started yet)
    let audioConsumer = null;
    if (!cam.audioProducer.closed) {
      audioConsumer = await transport.consume({
        producerId:      cam.audioProducer.id,
        rtpCapabilities: browserCaps,
        paused:          false,
        enableRtx:       false,
      }).catch(() => null);
    }

    // DataConsumer (only if browser included m=application in offer)
    let dataConsumer = null;
    if (parsed.hasData && !cam.dataProducer.closed) {
      dataConsumer = await transport.consumeData({
        dataProducerId: cam.dataProducer.id,
      }).catch(() => null);
    }

    // Close transport on ICE/DTLS failure AND after a max lifetime.
    // Without the lifetime limit, browsers that never complete ICE leave zombie
    // transports that accumulate and eventually kill the worker process.
    const _closeTransport = () => { if (!transport.closed) try { transport.close(); } catch (_) {} };

    const TRANSPORT_MAX_LIFETIME_MS = 90_000; // 90s: covers ICE (30s offer timeout) + DTLS
    const lifetimeTimer = setTimeout(_closeTransport, TRANSPORT_MAX_LIFETIME_MS);

    let disconnectTimer = null;
    transport.on('icestatechange', state => {
      console.log(`[WebRTC][mediasoup] ICE [${cameraId.slice(0,8)}]: ${state}`);
      if (state === 'failed') {
        setTimeout(_closeTransport, 1000);
      } else if (state === 'connected' || state === 'completed') {
        clearTimeout(lifetimeTimer);
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
      } else if (state === 'disconnected') {
        // Browser navigated away or network hiccup. Give it 15s to reconnect
        // before closing so the browser can resume; if it doesn't, clean up.
        disconnectTimer = setTimeout(_closeTransport, 15_000);
      }
    });
    transport.on('dtlsstatechange', async state => {
      console.log(`[WebRTC][mediasoup] DTLS [${cameraId.slice(0,8)}]: ${state}`);
      if (state === 'failed' || state === 'closed') { clearTimeout(lifetimeTimer); _closeTransport(); }
      if (state === 'connected' && videoConsumer) {
        // Log Consumer send stats 3 s after DTLS connects to confirm SRTP is flowing.
        setTimeout(async () => {
          try {
            const vStats = await videoConsumer.getStats();
            const outbound = vStats.find(s => s.type === 'outbound-rtp');
            const vPaused = videoConsumer.paused;
            const vProdPaused = videoConsumer.producerPaused;
            console.log(
              `[WebRTC][mediasoup] Consumer-diag [${cameraId.slice(0,8)}]` +
              ` bytesSent=${outbound?.byteCount ?? 0}` +
              ` pkts=${outbound?.packetCount ?? 0}` +
              ` paused=${vPaused} producerPaused=${vProdPaused}` +
              ` consumerClosed=${videoConsumer.closed}`
            );
          } catch (e) {
            console.log(`[WebRTC][mediasoup] Consumer-diag [${cameraId.slice(0,8)}] err: ${e.message}`);
          }
        }, 3000);
      }
    });
    transport.on('routerclose', () => clearTimeout(lifetimeTimer));
    if (videoConsumer) {
      videoConsumer.on('score', score =>
        console.log(`[WebRTC][mediasoup] vScore [${cameraId.slice(0,8)}]:`, JSON.stringify(score))
      );
    }

    // Register in active consumer registry for monitor inspection.
    const _entry = { transport, videoConsumer, audioConsumer, cameraId, created: Date.now() };
    if (!_activeConsumers.has(cameraId)) _activeConsumers.set(cameraId, []);
    _activeConsumers.get(cameraId).push(_entry);
    transport.observer.once('close', () => {
      const list = _activeConsumers.get(cameraId);
      if (list) {
        const idx = list.indexOf(_entry);
        if (idx !== -1) list.splice(idx, 1);
        if (list.length === 0) _activeConsumers.delete(cameraId);
      }
    });

    const sdpAnswer = _buildAnswer({ parsed, transport, videoConsumer, audioConsumer, dataConsumer, cameraId });
    console.log(`[WebRTC][mediasoup] negotiate OK [${cameraId.slice(0,8)}] audio=${!!audioConsumer} data=${!!dataConsumer}`);

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

async function getProducerStats() {
  const result = {};
  for (const [cameraId, cam] of _cameras.entries()) {
    try {
      const vStats = cam.videoProducer?.closed ? null : await cam.videoProducer.getStats();
      const aStats = cam.audioProducer?.closed ? null : await cam.audioProducer.getStats();
      const vRx = vStats ? vStats.reduce((s, x) => s + (x.byteCount || 0), 0) : 0;
      const aRx = aStats ? aStats.reduce((s, x) => s + (x.byteCount || 0), 0) : 0;

      // Consumer send stats (per active browser viewer)
      const consumers = _activeConsumers.get(cameraId) || [];
      const consumerStats = await Promise.all(consumers.map(async entry => {
        try {
          const cs = entry.videoConsumer?.closed ? [] : await entry.videoConsumer.getStats();
          const out = cs.find(s => s.type === 'outbound-rtp');
          return {
            bytesSent:      out?.byteCount     ?? 0,
            pktsSent:       out?.packetCount   ?? 0,
            paused:         entry.videoConsumer?.paused         ?? null,
            producerPaused: entry.videoConsumer?.producerPaused ?? null,
            closed:         entry.videoConsumer?.closed         ?? null,
            iceState:       entry.transport?.iceState           ?? null,
            dtlsState:      entry.transport?.dtlsState          ?? null,
            ageSec:         Math.round((Date.now() - entry.created) / 1000),
          };
        } catch { return { error: 'stats-err' }; }
      }));

      // Transport-level stats to verify if PlainTransport is receiving packets
      // (distinct from Producer stats which count after SSRC/PT routing)
      const aTransStats = cam.audioPlain?.closed ? [] : await cam.audioPlain.getStats().catch(() => []);
      const aTransRx = aTransStats.reduce((s, x) => s + (x.bytesReceived || x.byteCount || 0), 0);
      result[cameraId.slice(0, 8)] = {
        videoPort:        cam.videoPlain?.tuple?.localPort,
        audioPort:        cam.audioPlain?.tuple?.localPort,
        videoBytesRx:     vRx,
        audioBytesRx:     aRx,
        audioTransportRx: aTransRx,
        videoScore:       cam.videoProducer?.score,
        audioScore:       cam.audioProducer?.score,
        viewers:          consumerStats,
      };
    } catch (e) {
      result[cameraId.slice(0, 8)] = { error: e.message };
    }
  }
  return result;
}

// Re-register all active cameras with the ingest-daemon (e.g., after daemon restart).
// The daemon loses its camera registry on restart; this restores it using the current
// PlainTransport ports held in _cameras, so video+audio RTP resume without restarting
// the main server process.
async function reregisterAllWithIngest() {
  const isHttps = (process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';
  const serverPort = isHttps
    ? (process.env.HTTPS_PORT || '3443')
    : (process.env.HTTP_PORT || process.env.PORT || '3080');
  const proto = isHttps ? 'https' : 'http';
  const base  = `${proto}://127.0.0.1:${serverPort}`;

  const results = {};
  for (const [cameraId, cam] of _cameras.entries()) {
    try {
      const videoPort = cam.videoPlain?.tuple?.localPort;
      const audioPort = cam.audioPlain?.tuple?.localPort;
      const status = await _ingestPost('/cameras', {
        id:                 cameraId,
        rtspUrl:            cam.rtspUrl,
        callbackUrl:        `${base}/api/internal/frame/${cameraId}`,
        appRtpCallbackUrl:  `${base}/api/internal/apprtp/${cameraId}`,
        mediasoupPort:      videoPort,
        mediasoupAudioPort: audioPort,
      });
      results[cameraId] = { ok: status === 200 || status === 201, status, videoPort, audioPort };
    } catch (e) {
      results[cameraId] = { ok: false, error: e.message };
    }
  }
  return results;
}

module.exports = {
  ENGINE_NAME,
  addCameraStream,
  removeCameraStream,
  waitForStreamReady,
  negotiate,
  isHealthy,
  getEngineInfo,
  getProducerStats,
  reregisterAllWithIngest,
  sendAppRtp,
};
