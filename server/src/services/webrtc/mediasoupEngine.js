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

// HTTP timeout (ms) for calls to ingest-daemon. Without this, a slow/stuck
// ingest-daemon response leaves the request Promise pending forever — and
// since addCameraStream() awaits _ingestPost() before returning, that hang
// propagates all the way up through pipelineManager.startCamera()'s `finally`
// block never running, which leaves that camera's id stuck in the `_starting`
// guard Set permanently (see startCamera() in pipelineManager.js) — every
// future start attempt for that camera (auto-start on boot, watchdog restart,
// manual "stream/start") then silently no-ops for the rest of the process
// lifetime. Confirmed live: TID-A800 wedged this way after ingest-daemon had
// a brief HTTP responsiveness stall during a 13-camera startup burst — no
// error was ever logged because the request simply never settled. 8s matches
// the ingest-daemon-side worst-case cleanup budget (_join_threads timeout,
// see Design_RTSP_Capture_Backend.md §6.8) plus margin.
const INGEST_HTTP_TIMEOUT_MS = 8000;

// mediasoup Worker IPC (Node ↔ C++ child process) round-trips every
// Producer/Consumer/Transport getStats()/close() call through a channel that
// can wedge — the await then never resolves *nor* rejects, so a bare
// try/catch does nothing (2026-07-21, discovered via getProducerStats()
// hanging /api/webrtc/monitor indefinitely on a fresh restart, i.e. not just
// accumulated multi-hour state). Race every such call against this timeout
// so one wedged camera can't block the whole monitor endpoint.
const WORKER_IPC_TIMEOUT_MS = 3000;

function _withIpcTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${WORKER_IPC_TIMEOUT_MS}ms (worker IPC stall)`)), WORKER_IPC_TIMEOUT_MS)),
  ]);
}

function _ingestPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(INGEST_DAEMON_URL + path);
    const req  = http.request(
      {
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: INGEST_HTTP_TIMEOUT_MS,
      },
      res => { res.resume(); resolve(res.statusCode); }
    );
    req.on('timeout', () => req.destroy(new Error(`ingest-daemon POST ${path} timed out after ${INGEST_HTTP_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function _ingestDelete(cameraId) {
  return new Promise((resolve) => {
    const url = new URL(`${INGEST_DAEMON_URL}/cameras/${encodeURIComponent(cameraId)}`);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'DELETE', timeout: INGEST_HTTP_TIMEOUT_MS },
      res => {
        res.resume();
        // pipelineManager.stopCamera() also sends its own DELETE for the same
        // cameraId as a redundant safety net, so a non-2xx here isn't fatal on
        // its own — but it was previously silent, giving no signal at all when
        // *both* attempts failed and ingest-daemon kept reconnecting a deleted camera.
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.warn(`[WebRTC][mediasoup] ingest-daemon DELETE /cameras/${cameraId} → HTTP ${res.statusCode}`);
        }
        resolve(res.statusCode);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`ingest-daemon DELETE /cameras/${cameraId} timed out after ${INGEST_HTTP_TIMEOUT_MS}ms`)));
    req.on('error', (err) => {
      console.warn(`[WebRTC][mediasoup] ingest-daemon DELETE /cameras/${cameraId} failed: ${err.message}`);
      resolve(0);
    });
    req.end();
  });
}

// Short timeout (this is called synchronously inside WHEP negotiate() — a slow
// ingest-daemon shouldn't stall the whole handshake, sprop-parameter-sets is a
// nice-to-have for decode, not required for the connection itself to complete).
const INGEST_VIDEO_PARAMS_TIMEOUT_MS = 2000;

// Last-known-good video-params cache (2026-07-21, §self-caused-baseline-fallback)
// — confirmed live (133 occurrences in one day's log) that this 2s fetch
// routinely fails while ingest-daemon is busy processing several cameras'
// RTSP/AI/mux at once (250%+ CPU observed), and negotiate() re-runs this
// fetch on EVERY reconnect, not just once at pipeline start. Previously a
// failed fetch meant profileLevelId stayed null for that negotiation, and
// _buildAnswer() then fell through to the Producer's hardcoded
// Baseline/'42e01f' default (see addCameraStream()) — genuinely incompatible
// with these cameras' real High-Profile streams, causing partial decode
// (a handful of frames) then a stall. A camera's actual encoder profile
// does not change between reconnects, so once we've learned it successfully
// even once, there is no reason a later transient fetch failure should ever
// throw that knowledge away — cache the last successful result per camera
// and fall back to IT (not the Baseline default) when a given fetch fails.
const _lastKnownVideoParams = new Map(); // cameraId → { spropParameterSets, profileLevelId }

function _ingestGetVideoParams(cameraId) {
  return new Promise((resolve) => {
    const url = new URL(`${INGEST_DAEMON_URL}/cameras/${encodeURIComponent(cameraId)}/video-params`);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', timeout: INGEST_VIDEO_PARAMS_TIMEOUT_MS },
      res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Polls GET /cameras/:id/video-params until ingest-daemon reports the RTSP
// probe is done (ready:true) or a budget expires (2026-07-20, §6.25). This
// runs once at addCameraStream() time (pipeline start), not on the
// low-latency WHEP negotiate() path, so a multi-second budget is acceptable —
// ingest-daemon needs to complete its own RTSP DESCRIBE/stream-open first,
// which this call's own POST /cameras just triggered.
const VIDEO_CODEC_POLL_BUDGET_MS   = 5000;
const VIDEO_CODEC_POLL_INTERVAL_MS = 300;
function _pollVideoCodec(cameraId) {
  const deadline = Date.now() + VIDEO_CODEC_POLL_BUDGET_MS;
  return (async function poll() {
    for (;;) {
      const params = await _ingestGetVideoParams(cameraId);
      if (params?.ready) return params;
      if (Date.now() >= deadline) return null;
      await new Promise(r => setTimeout(r, VIDEO_CODEC_POLL_INTERVAL_MS));
    }
  })();
}

// Builds the video Producer's rtpParameters (2026-07-20, §6.25). Always
// H.264 — mediasoup 3.21.x has no H.265 support at all (confirmed against
// both the installed version and the latest published 3.21.2; see the
// router mediaCodecs comment above), so there is no second branch to select
// dynamically. Kept as its own function (rather than inlined) because
// _pollVideoCodec()'s result is still used to log a clear diagnostic when a
// camera turns out to be HEVC, even though the Producer itself can't adapt.
function _buildVideoRtpParameters() {
  return {
    codecs: [{
      mimeType:    'video/H264',
      payloadType: VIDEO_PT,
      clockRate:   90000,
      parameters: {
        'packetization-mode':      1,
        // Must match the router's mediaCodecs declaration above (2026-07-16,
        // §6.13/§6.21) — a mismatch here is exactly what caused "no
        // compatible media codecs" when only one side was patched to the
        // real value. See the router declaration's comment for why this is
        // '640033' (Level 5.1) and not '640028' (Level 4.0, too small for
        // this fleet's higher-resolution cameras).
        'profile-level-id':        '640033',
        'level-asymmetry-allowed': 1,
      },
    }],
    encodings: [{ ssrc: VIDEO_SSRC }],
  };
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
    // Alt-PT routers/pipelines (2026-07-20, §6.26) live on the same dead
    // Worker — stale either way; self-heal lazily on each camera's next
    // negotiate() against the new worker/router, no need to actively rebuild.
    for (const id of _altPipelines.keys()) _closeAltPipelines(id);
    _ptRouters.clear();
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

  // (2026-07-16, §6.14) PT=109 was previously assumed to be Edge's plain-H264 PT,
  // matching what its own offer allegedly used ("Edge offers PT=109=H264/42e01f/pm=1").
  // Direct inspection of a real Chrome offer's rtpmap/fmtp lines shows the actual
  // pattern is: PT=108 → H264/pm=1/42e01f (the real primary codec), PT=109 → rtx
  // apt=108 (retransmission wrapper for PT 108, NOT H264 itself). mediasoup's Consumer
  // PT is fixed at Router registration (getConsumableRtpParameters() in ortc.js reads
  // caps.codecs[].preferredPayloadType at Producer-creation time — the per-negotiate
  // remoteRtpCapabilities argument only filters compatible codecs, it never changes the
  // outgoing PT), so answering with PT=109="H264" made every browser's receiver apply
  // RTX-unwrap logic to plain H264 payload: SRTP/transport bytes arrived fine
  // (bytesReceived > 0) but the jitter buffer never assembled a frame
  // (framesReceived=0, jitterBufferEmittedCount=0, framesDecoded=0) — confirmed via
  // getStats() on a real WHEP session. Since Edge is also Chromium-based and shares
  // the same underlying codec-enumeration order, the original "Edge needs 109" finding
  // was most likely the same RTX-entry misread, not a genuine cross-browser conflict.
  // Using PT=108 (Chrome's own primary-H264 PT, never used as any RTX apt= target)
  // should be safe for both. If a real Edge client is later confirmed broken by this,
  // the fix is per-browser dynamic Producer selection (two Router codec entries + two
  // PlainTransport/Producer pairs, picked via _parseOffer().videoPt at negotiate time)
  // rather than reverting to a single static PT that collides with Chrome's RTX mapping.
  // RTX (2026-07-16, §6.17) — do NOT add a manual `video/rtx` entry to
  // mediaCodecs: mediasoup's ortc.generateRouterRtpCapabilities() rejects any
  // user-supplied RTX codec with "media codec not supported [mimeType:
  // video/rtx]" (confirmed live — it broke _ensureRouter() for every camera).
  // RTX is generated AUTOMATICALLY for every video codec here, using the next
  // free PT from mediasoup's internal DynamicPayloadTypes order
  // ([100,101,...,127,96,97,98,99] minus whatever preferredPayloadType values
  // are already claimed). Confirmed live that letting it land wherever that
  // leaves it (PT=100, since 108/111 are claimed) is actively harmful, not
  // just ineffective: PT=100 is Chrome's OWN offer slot for VP9, so Chrome
  // keeps its own interpretation of incoming PT=100 packets (same class of
  // PT-vocabulary collision as the §6.13 H264 fix) — retransmits landed on a
  // dead codec instead of recovering the NACKed packet, and a 90s WHEP
  // session got WORSE (nackCount 303→525, stall coverage roughly doubled)
  // with RTX "on" at that PT than with RTX off entirely. Fix: burn 8 unused,
  // harmless placeholder audio codec entries on PT 100-107 first (none of
  // these are ever offered to a real Consumer — no Producer uses them, and
  // _buildAnswer() only serializes the video/audio Consumer's own consumable
  // codecs, not the router's full codec list) so the H264 entry's own
  // auto-generated RTX pair is forced onto PT=109 — the exact slot Chrome's
  // own offer already uses for H264-RTX (confirmed via a real Chrome offer's
  // rtpmap/fmtp: PT=109 apt=108).
  const _rtxPtReservations = [
    { mimeType: 'audio/PCMU',  clockRate: 8000  },
    { mimeType: 'audio/PCMA',  clockRate: 8000  },
    { mimeType: 'audio/G722',  clockRate: 8000  },
    { mimeType: 'audio/iLBC',  clockRate: 8000  },
    { mimeType: 'audio/SILK',  clockRate: 24000 },
    { mimeType: 'audio/SILK',  clockRate: 16000 },
    { mimeType: 'audio/SILK',  clockRate: 12000 },
    { mimeType: 'audio/SILK',  clockRate: 8000  },
  ].map((c, i) => ({ kind: 'audio', preferredPayloadType: 100 + i, ...c }));

  _router = await _worker.createRouter({
    mediaCodecs: [
      ..._rtxPtReservations,
      {
        kind:      'video',
        mimeType:  'video/H264',
        preferredPayloadType: 108,
        clockRate: 90000,
        parameters: {
          'packetization-mode':      1,
          // High Profile (2026-07-16, §6.13) — was '42e01f' (Baseline). Real
          // cameras in this fleet send profile_idc=0x64 (High), confirmed by
          // parsing their actual SPS (see ingest_daemon.py's
          // _parse_h264_sps_pps / GET /cameras/:id/video-params). Declaring
          // Baseline here while every real Producer is High Profile is not
          // just cosmetically wrong — transport.consume() checks Producer vs.
          // Consumer-capabilities profile compatibility, and Baseline↔High is
          // a genuine incompatibility (not just a level difference
          // level-asymmetry-allowed can paper over), which is why an earlier
          // per-camera-accurate attempt at the *Consumer* capabilities layer
          // (without also fixing this Producer-side default) failed outright
          // with "no compatible media codecs". This must stay in sync with
          // the Producer's own parameters in addCameraStream() below.
          //
          // Level 5.1, was Level 4.0 (2026-07-16, §6.21) — the '28' (Level 4.0,
          // MaxFS 8192 macroblocks) byte was never revisited after the profile
          // byte fix above, but real camera SPS parsed by ingest_daemon.py show
          // level_idc up to 0x32 (Level 5.0) for the fleet's higher-resolution
          // units: TID-A800 (2560×1920 = 19200 MBs) and TNM-C2712T Ch1
          // (2048×1536 = 12288 MBs) BOTH exceed Level 4.0's 8192 MaxFS cap
          // outright, while every low-res camera that decoded fine all session
          // stayed under it — a level declaration a standards-conformant
          // decoder is entitled to enforce when sizing its DPB/decode buffers,
          // and the exact resolution-correlated split (small cameras always
          // fine, large cameras never decode a single frame despite healthy
          // RTP delivery) observed on the real dashboard all session. '33'
          // (Level 5.1, MaxFS 36864) covers every camera currently in the
          // fleet with headroom; level-asymmetry-allowed=1 already lets the
          // browser accept a level higher than what IT offered, so this only
          // needs to be correct on our (sending) side.
          'profile-level-id':        '640033',
          'level-asymmetry-allowed': 1,
        },
      },
      // NOTE (2026-07-20, §6.25) — an H.265/'video/H265' entry was added here
      // and reverted the same day. mediasoup 3.21.0 (and 3.21.2, the latest
      // published version at the time) has NO H.265 support at all — its own
      // supportedRtpCapabilities.js lists only VP8/VP9/H264/AV1 as valid video
      // mimeTypes, confirmed by inspecting the installed package and a fresh
      // `npm pack mediasoup@3.21.2` download. transport.produce() rejects any
      // 'video/H265' rtpParameters outright with "media codec not supported
      // [mimeType:video/H265]" — confirmed live, it broke addCameraStream()
      // for every HEVC camera in the fleet. This is not fixable from this
      // codebase; it requires either the cameras being reconfigured to stream
      // H.264 instead, or a mediasoup release that adds H.265 support. See
      // design doc §6.25 for the full writeup and the ingest-daemon-side
      // codec-detection work (kept — genuinely useful for diagnosing which
      // cameras are affected) that this depended on.
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

// ── Per-PT alternate Router/pipeline cache (2026-07-20, §6.26) ───────────────
//
// mediasoup permanently fixes a Producer's outgoing video payload type to
// whatever the Router declared at boot — confirmed by reading ortc.js's
// getConsumableRtpParameters()/getConsumerRtpParameters() directly. The
// per-negotiate remoteRtpCapabilities argument (built by
// _buildBrowserRtpCapabilities()) only filters which codecs are considered
// compatible; it can never change the transmitted PT, despite this file's
// earlier comments assuming otherwise. A browser's own SDP offer assigns
// H.264 whatever PT its own codec-enumeration happens to land on that
// session — NOT stable even between Chrome and Edge on the same machine,
// confirmed live: Edge offered PT=108 and played; Chrome (same session)
// offered PT=109 and produced framesDecoded=0 forever despite healthy
// bytesReceived, because Chrome's own offer never associated PT 108 with
// H.264 at all — packets arrived and were counted at the transport layer,
// but no decoder ever bound to them.
//
// The only spec-correct fix (RFC 3264 §6.1 — the answer must use PT numbers
// the offer actually used) is to have a Router, and therefore a Producer
// chain, that was built declaring EXACTLY the PT the current browser
// offered — there is no way to retrofit an existing Producer to a different
// PT. Rather than pre-guessing which PTs might occur (fragile — silently
// wrong the moment a browser update shifts its codec order), this is built
// lazily: the FIRST negotiate() that sees a given videoPt creates a
// dedicated Router + per-camera Producer set for it; every later
// negotiate() (any camera, any viewer) that shares that PT reuses it. A
// given PT is a near-deterministic function of browser+OS+version, not
// random per-connection, so this stays small and stable in practice without
// ever needing to hardcode which values to expect.
//
// PT=108 (DEFAULT_VIDEO_PT) keeps using the existing shared `_router` /
// `_cameras` map unchanged — zero extra cost for whatever fraction of
// viewers happen to match it. Only a genuinely different PT triggers this
// additional machinery.

const DEFAULT_VIDEO_PT = 108;

// mediasoup's own DynamicPayloadTypes free-list order (ortc.js
// generateRouterRtpCapabilities()) — RTX for a video codec is auto-assigned
// via dynamicPayloadTypes.shift() at the moment that codec entry is
// processed, so explicitly claiming (via harmless placeholder audio codec
// entries earlier in the mediaCodecs array) every value that would otherwise
// be picked before the desired target forces RTX to land exactly there. Same
// trick as the static _rtxPtReservations above, generalized to an arbitrary
// target instead of the one hardcoded case.
const _DYNAMIC_PT_ORDER = [];
for (let pt = 100; pt <= 127; pt++) _DYNAMIC_PT_ORDER.push(pt);
for (let pt = 96;  pt <= 99;  pt++) _DYNAMIC_PT_ORDER.push(pt);

function _computeRtxPlaceholderPts(claimedPts, targetRtxPt) {
  const placeholders = [];
  for (const pt of _DYNAMIC_PT_ORDER) {
    if (pt === targetRtxPt) break;
    if (!claimedPts.has(pt)) placeholders.push(pt);
  }
  return placeholders;
}

// videoPt → Promise<Router>, cached/idempotent.
const _ptRouters = new Map();

function _ensurePtRouter(videoPt, videoRtxPt) {
  if (videoPt === DEFAULT_VIDEO_PT) return _ensureRouter();
  if (_ptRouters.has(videoPt)) return _ptRouters.get(videoPt);
  const p = _bootPtRouter(videoPt, videoRtxPt).catch(err => { _ptRouters.delete(videoPt); throw err; });
  _ptRouters.set(videoPt, p);
  return p;
}

async function _bootPtRouter(videoPt, videoRtxPt) {
  await _ensureRouter(); // guarantees _worker exists — Routers share one Worker
  // Opus MUST be claimed before the RTX-placeholder computation below, not
  // just excluded from it conceptually — mediasoup's real free-list walk
  // only skips a PT once something EARLIER in the mediaCodecs array explicitly
  // claimed it. If videoRtxPt sorts after AUDIO_PT (111) in dynamic-PT order
  // (observed live: Chrome offered RTX-PT=114 this session), leaving Opus
  // for later would let mediasoup's own auto-RTX claim 111 by mistake.
  const claimed = new Set([videoPt, AUDIO_PT]);
  const mediaCodecs = [
    { kind: 'audio', mimeType: 'audio/opus', preferredPayloadType: AUDIO_PT, clockRate: 48000, channels: 2 },
  ];
  // Force H264's auto-RTX onto the browser's own actually-offered RTX PT when
  // known — best-effort only (unlike the primary codec, an RTX mismatch just
  // degrades loss recovery, it doesn't block decode entirely — negotiate()
  // disables RTX on the Consumer instead of guessing when this isn't known).
  if (videoRtxPt != null && !claimed.has(videoRtxPt)) {
    for (const pt of _computeRtxPlaceholderPts(claimed, videoRtxPt)) {
      mediaCodecs.push({ kind: 'audio', mimeType: 'audio/PCMU', clockRate: 8000, preferredPayloadType: pt });
      claimed.add(pt);
    }
  }
  mediaCodecs.push({
    kind:      'video',
    mimeType:  'video/H264',
    preferredPayloadType: videoPt,
    clockRate: 90000,
    parameters: {
      'packetization-mode':      1,
      'profile-level-id':        '640033',
      'level-asymmetry-allowed': 1,
    },
  });

  const router = await _worker.createRouter({ mediaCodecs });
  console.log(`[WebRTC][mediasoup] alt-PT router ready videoPt=${videoPt}${videoRtxPt != null ? ` rtxPt=${videoRtxPt}` : ' (rtxPt unknown — RTX disabled for this PT)'}`);
  return router;
}

// ── Per-camera alternate pipeline cache (paired with the PT-router above) ───
// cameraId → Map<videoPt, Promise<{ router, videoPlain, videoProducer, directTransport, dataProducer }>>
// Deliberately no audio Producer here (2026-07-20, §6.26 — out of scope: no
// confirmed audio PT mismatch has been observed, unlike video's repeatedly
// reproduced framesDecoded=0 failures). Alt-PT viewers get working video +
// the App RTP data channel; audio is silently omitted rather than risking
// the same class of bug in a path with no evidence it's broken. Revisit if
// audio decode failures are ever actually reported.
const _altPipelines = new Map();

function _ensureAltPipeline(cameraId, videoPt, videoRtxPt) {
  const cam = _cameras.get(cameraId);
  if (!cam) return Promise.reject(new Error(`Camera ${cameraId} is not streaming via mediasoup.`));
  if (!_altPipelines.has(cameraId)) _altPipelines.set(cameraId, new Map());
  const camAlt = _altPipelines.get(cameraId);
  if (camAlt.has(videoPt)) return camAlt.get(videoPt);
  const p = _buildAltPipeline(cameraId, cam, videoPt, videoRtxPt).catch(err => { camAlt.delete(videoPt); throw err; });
  camAlt.set(videoPt, p);
  return p;
}

async function _buildAltPipeline(cameraId, cam, videoPt, videoRtxPt) {
  const router = await _ensurePtRouter(videoPt, videoRtxPt);

  const videoPlain = await router.createPlainTransport({
    listenInfo: { protocol: 'udp', ip: '127.0.0.1', recvBufferSize: 8 * 1024 * 1024 },
    rtcpMux:  true,
    comedia:  true,
  });
  const videoPort = videoPlain.tuple.localPort;
  const videoProducer = await videoPlain.produce({
    kind: 'video',
    rtpParameters: _buildVideoRtpParameters(),
  });
  // Tell ingest-daemon to fan this camera's already-flowing video RTP out to
  // this new destination too — no second RTSP session (see
  // ingest_daemon.py's add_video_fanout() docstring).
  const status = await _ingestPost(`/cameras/${cameraId}/video-fanout`, { port: videoPort });
  if (status !== 200) {
    throw new Error(`ingest-daemon video-fanout registration returned HTTP ${status}`);
  }

  let directTransport = null, dataProducer = null;
  if (!cam.videoOnly) {
    directTransport = await router.createDirectTransport({ maxMessageSize: 262144 });
    dataProducer = await directTransport.produceData({
      label:    `apprtp-${cameraId.slice(0, 8)}-pt${videoPt}`,
      protocol: 'json',
      ordered:  false,
    });
  }

  console.log(`[WebRTC][mediasoup] alt-pipeline ready [${cameraId.slice(0, 8)}] videoPt=${videoPt} video:${videoPort}`);
  return { router, videoPlain, videoProducer, directTransport, dataProducer };
}

function _closeAltPipelines(cameraId) {
  const camAlt = _altPipelines.get(cameraId);
  if (!camAlt) return;
  for (const pPromise of camAlt.values()) {
    pPromise.then(alt => {
      try { alt.videoProducer?.close(); }    catch (_) {}
      try { alt.videoPlain?.close(); }       catch (_) {}
      try { alt.dataProducer?.close(); }     catch (_) {}
      try { alt.directTransport?.close(); }  catch (_) {}
    }).catch(() => {});
  }
  _altPipelines.delete(cameraId);
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

async function addCameraStream(cameraId, rtspUrl, appRtpRtspUrl = undefined, captureFps = 0, opts = {}) {
  // videoOnly (2026-07-15): skips the audio PlainTransport and the App RTP
  // DirectTransport/DataProducer entirely, so ingest-daemon only opens the AI +
  // video RTP RTSP sessions for this camera (2 instead of 4). For cameras whose
  // RTSP server cannot reliably sustain the full fan-out (confirmed live against
  // TID-A800/192.168.214.32, which kept stalling every ~30-120s even after halving
  // its registrations from 2→1 and enabling multi-threaded AI decode — ICMP ping to
  // the camera showed zero packet loss, so the remaining bottleneck is the camera's
  // own concurrent-RTSP-session capacity, not our decode speed or the network path).
  const { videoOnly = false } = opts;
  // Build-then-swap (2026-07-16, §6.12) — this used to call removeCameraStream()
  // FIRST, deleting the camera's existing (possibly still-working) entry from
  // _cameras before attempting to build the replacement. If anything after that
  // point failed — most commonly _ingestPost() timing out while ingest-daemon
  // was degraded (see Design_RTSP_Capture_Backend.md §6.11/§6.12) — the function
  // returned false, but the camera was now PERMANENTLY gone from _cameras until
  // the next successful watchdog cycle: every subsequent WHEP negotiate() call
  // hit "Camera X is not streaming via mediasoup" (503), and any browser session
  // that already had a Consumer open saw it silently stop delivering bytes
  // forever (its Producer/PlainTransport had already been closed). Confirmed
  // live: GET /api/webrtc/monitor's producerStats came back completely empty
  // ({}) while pipelineManager still reported every camera as running=true.
  // Now the new transports/producers/ingest-daemon registration are built
  // first; the old entry is only removed after the new one is confirmed
  // working, and any partially-built new resources are torn down on failure
  // instead of ever touching the old (still good) registration.
  const oldCam = _cameras.get(cameraId);
  // Declared here (not inside the try block) so the catch block's failure-path
  // cleanup can reach whatever got partially built before the throw.
  let videoPlain = null, videoProducer = null;
  let audioPlain = null, audioProducer = null, audioPort = null;
  let directTransport = null, dataProducer = null;
  try {
    const router = await _ensureRouter();

    // ── Video PlainTransport ─────────────────────────────────────────────────
    // recvBufferSize (2026-07-16, §6.18) — `cat /proc/net/snmp | grep Udp:`
    // showed RcvbufErrors in the tens of millions system-wide: the kernel UDP
    // socket buffer (default ~208KB, net.core.rmem_default) overflows and
    // silently drops packets during a burst — exactly what a single H.264
    // keyframe for a 5MP camera (TID-A800, 2560×1920) produces as a tight
    // train of UDP datagrams. This explained the packet-loss/framesDecoded-
    // stall pattern for every high-resolution camera even over localhost
    // (ingest-daemon → this PlainTransport, zero real network involved) —
    // confirmed correlated with resolution: the one camera that never showed
    // any loss all session (768×576) produces far smaller keyframe bursts.
    // listenIp (deprecated) has no buffer-size option; listenInfo does.
    // 8MB is well under net.core.rmem_max (16MB measured) so the kernel
    // actually honors the request instead of silently capping it.
    videoPlain = await router.createPlainTransport({
      listenInfo: { protocol: 'udp', ip: '127.0.0.1', recvBufferSize: 8 * 1024 * 1024 },
      rtcpMux:  true,
      comedia:  true,
    });
    const videoPort = videoPlain.tuple.localPort;

    videoProducer = await videoPlain.produce({
      kind: 'video',
      rtpParameters: _buildVideoRtpParameters(),
    });

    // ── Audio PlainTransport (skipped when videoOnly) ─────────────────────────
    if (!videoOnly) {
      audioPlain = await router.createPlainTransport({
        // Opus bitrate is tiny next to video, but keep the same larger buffer
        // for consistency — see the video PlainTransport comment above.
        listenInfo: { protocol: 'udp', ip: '127.0.0.1', recvBufferSize: 8 * 1024 * 1024 },
        rtcpMux:  true,
        comedia:  true,
      });
      audioPort = audioPlain.tuple.localPort;

      audioProducer = await audioPlain.produce({
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
    }

    // ── DirectTransport + DataProducer (App RTP data, skipped when videoOnly) ─
    if (!videoOnly) {
      directTransport = await router.createDirectTransport({ maxMessageSize: 262144 });

      dataProducer = await directTransport.produceData({
        label:    `apprtp-${cameraId.slice(0, 8)}`,
        protocol: 'json',
        ordered:  false,
      });
    }

    // ── Register with ingest-daemon ──────────────────────────────────────────
    const isHttps = (process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';
    const serverPort = isHttps
      ? (process.env.HTTPS_PORT || '3443')
      : (process.env.HTTP_PORT || process.env.PORT || '3080');
    const proto = isHttps ? 'https' : 'http';
    const base  = `${proto}://127.0.0.1:${serverPort}`;

    // mediasoupPort (video RTP fan-out) is deliberately OMITTED here and
    // registered lazily instead (2026-07-20, §6.27) — see the block after
    // the ingest-daemon POST succeeds. Live evidence: once §6.26's alt-PT
    // pipeline existed, essentially every real viewer landed on a non-108
    // PT (Chrome), leaving this DEFAULT pipeline's video Producer wired up
    // but unwatched — ingest-daemon was still muxing every packet to it
    // anyway, doubling the per-camera CPU cost on the io thread that must
    // never be delayed (see module docstring), for a destination nobody
    // consumed. `/proc/net/snmp`'s UDP RcvbufErrors was climbing in real
    // time under this load. Only registering the fan-out once a browser
    // actually negotiates at PT=108 (mirroring exactly how alt-PT
    // pipelines already work) removes that wasted work in the now-common
    // case where the default PT goes unused, at zero cost to the case
    // where it IS used (first negotiate() just pays one extra idempotent
    // HTTP round trip, tracked via cam.videoFanoutRegistered afterward).
    const ingestBody = {
      id:                 cameraId,
      rtspUrl,
      callbackUrl:        `${base}/api/internal/frame/${cameraId}`,
    };
    if (!videoOnly) {
      ingestBody.appRtpCallbackUrl  = `${base}/api/internal/apprtp/${cameraId}`;
      ingestBody.mediasoupAudioPort = audioPort;
      // When rtspUrl is a MediaMTX loopback URL, pass the original camera URL as
      // appRtpRtspUrl so the ingest-daemon App RTP thread can access ONVIF data
      // tracks that MediaMTX does not re-publish.
      if (appRtpRtspUrl) ingestBody.appRtpRtspUrl = appRtpRtspUrl;
    }
    // Per-camera FPS target — ingest daemon uses time-based throttling when set.
    const _captureFps = captureFps || parseInt(process.env.CAPTURE_FPS, 10) || 0;
    if (_captureFps > 0) ingestBody.captureFps = _captureFps;

    const status = await _ingestPost('/cameras', ingestBody);

    if (status !== 200 && status !== 201) {
      throw new Error(`ingest-daemon returned HTTP ${status}`);
    }

    // Re-register any existing alt-PT pipelines' video fan-out (2026-07-20,
    // §6.26) — ingest-daemon's CameraManager.add() always creates a brand-new
    // CameraSession object on every /cameras POST (confirmed in
    // ingest_daemon.py), which loses the previous session's
    // _video_fanout_ports list. Without this, a viewer already connected via
    // an alt-PT pipeline would silently stop receiving video on the next
    // reconnect/crash-recovery/worker-died cycle, with nothing surfacing the
    // failure. Fire-and-forget: this camera's DEFAULT pipeline is already
    // confirmed working at this point, and a slow/failed alt re-fanout only
    // affects viewers on that specific non-default PT, not the whole camera.
    const camAlt = _altPipelines.get(cameraId);
    if (camAlt) {
      for (const pPromise of camAlt.values()) {
        pPromise.then(alt => {
          const port = alt.videoPlain?.tuple?.localPort;
          if (port) _ingestPost(`/cameras/${cameraId}/video-fanout`, { port }).catch(() => {});
        }).catch(() => {});
      }
    }
    // Same idea for the DEFAULT pipeline's own fan-out (2026-07-20, §6.27) —
    // its registration is now lazy too (see the ingestBody comment above), so
    // if a PREVIOUS registration had already established that PT=108 is
    // actually in use, that fact needs to survive this reconnect the same
    // way alt-PT pipelines do, or an existing PT=108 viewer would silently
    // go dark on the next reconnect/crash-recovery cycle.
    const videoFanoutRegistered = !!oldCam?.videoFanoutRegistered;
    if (videoFanoutRegistered) {
      _ingestPost(`/cameras/${cameraId}/video-fanout`, { port: videoPort }).catch(() => {});
    }

    // Diagnostic only (2026-07-20, §6.25) — fire-and-forget, does NOT gate
    // Producer creation (which is always H.264; see _buildVideoRtpParameters()
    // comment — mediasoup itself has no H.265 support to select into). Lets
    // operators see in the log, per camera, exactly why WebRTC playback won't
    // work if the camera turns out to stream HEVC, without adding the ~5s
    // worst-case RTSP-probe latency to every single camera add/reconnect.
    _pollVideoCodec(cameraId).then(videoParams => {
      if (videoParams?.codec === 'hevc') {
        console.warn(`[WebRTC][mediasoup] ${cameraId.slice(0, 8)} camera streams H.265/HEVC — mediasoup has no H.265 support, WebRTC playback cannot work for this camera until it's reconfigured to H.264 (see design doc §6.25)`);
      } else if (videoParams?.codec && videoParams.codec !== 'h264') {
        console.warn(`[WebRTC][mediasoup] ${cameraId.slice(0, 8)} camera codec is ${videoParams.codec} (neither h264 nor hevc) — WebRTC playback cannot work for this camera`);
      }
      // Opportunistically warm _lastKnownVideoParams (see its comment) —
      // this poll already retries for up to 5s, far more robust than
      // negotiate()'s own single-shot 2s fetch, so the FIRST WHEP
      // negotiation for this camera can hit a warm cache instead of racing
      // ingest-daemon fresh.
      if (videoParams?.ready && videoParams.spropParameterSets) {
        _lastKnownVideoParams.set(cameraId, {
          spropParameterSets: videoParams.spropParameterSets,
          profileLevelId:     videoParams.profileLevelId,
        });
      }
    }).catch(() => {});

    // New registration confirmed working — swap it in, THEN tear down the old
    // one. ingest-daemon's own POST /cameras handler already replaced the old
    // RTSP session in place (CameraManager.add()), so the old mediasoup-side
    // resources are closed WITHOUT another _ingestDelete() call here.
    _cameras.set(cameraId, {
      rtspUrl,
      appRtpRtspUrl,
      captureFps: _captureFps,
      videoOnly,
      videoFanoutRegistered,
      videoPlain, videoProducer,
      audioPlain, audioProducer,
      directTransport, dataProducer,
    });
    if (oldCam) {
      try { oldCam.videoProducer?.close(); }   catch (_) {}
      try { oldCam.audioProducer?.close(); }   catch (_) {}
      try { oldCam.dataProducer?.close(); }    catch (_) {}
      try { oldCam.videoPlain?.close(); }      catch (_) {}
      try { oldCam.audioPlain?.close(); }      catch (_) {}
      try { oldCam.directTransport?.close(); } catch (_) {}
    }

    console.log(
      `[WebRTC][mediasoup] ${cameraId.slice(0, 8)} ` +
      `video:${videoPort}${videoOnly ? ' (video-only)' : ` audio:${audioPort}`} (ingest-daemon)`
    );
    return true;
  } catch (err) {
    console.error(`[WebRTC][mediasoup] addCameraStream failed: ${err.message}`);
    // Tear down whatever NEW resources got partially built — the old (still
    // registered, still in _cameras) camera is untouched, so viewers already
    // connected to it keep working instead of being silently orphaned.
    try { videoProducer?.close(); }    catch (_) {}
    try { audioProducer?.close(); }    catch (_) {}
    try { dataProducer?.close(); }     catch (_) {}
    try { videoPlain?.close(); }       catch (_) {}
    try { audioPlain?.close(); }       catch (_) {}
    try { directTransport?.close(); }  catch (_) {}
    return false;
  }
}

async function removeCameraStream(cameraId) {
  const cam = _cameras.get(cameraId);
  if (!cam) return;
  _cameras.delete(cameraId);
  _closeCam(cam, cameraId);
  _closeAltPipelines(cameraId);
  _lastKnownVideoParams.delete(cameraId);
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
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const cam = _cameras.get(cameraId);
  if (cam?.dataProducer && !cam.dataProducer.closed) {
    try { cam.dataProducer.send(msg); } catch (_) {}
  }
  // Alt-PT pipelines (2026-07-20, §6.26) carry their own DataProducer on a
  // separate Router — a viewer connected via one of those needs the same App
  // RTP events broadcast there too, not just on the default pipeline.
  const camAlt = _altPipelines.get(cameraId);
  if (camAlt) {
    for (const pPromise of camAlt.values()) {
      pPromise.then(alt => {
        if (alt.dataProducer && !alt.dataProducer.closed) {
          try { alt.dataProducer.send(msg); } catch (_) {}
        }
      }).catch(() => {});
    }
  }
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

function _buildAnswer({ parsed, transport, videoConsumer, audioConsumer, dataConsumer, cameraId = '', spropParameterSets = null, profileLevelId = null }) {
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

  // mediasoup's Consumer.rtpParameters getter returns utils.clone(...) on every
  // access (see node_modules/mediasoup/node/lib/Consumer.js) — a fresh object
  // each time, so mutating an earlier `.rtpParameters` access (e.g. right after
  // transport.consume()) has zero effect here; `vParams` above is itself
  // already a brand-new clone. The only way to actually get an extra fmtp
  // parameter into the answer is to merge it into THIS clone, right before it
  // gets serialized below.
  if (spropParameterSets) {
    vCodec.parameters = vCodec.parameters || {};
    vCodec.parameters['sprop-parameter-sets'] = spropParameterSets;
  }
  // The Producer was created with a hardcoded profile-level-id ('42e01f' =
  // Baseline) before ingest-daemon had even connected to probe the camera's
  // actual SPS — confirmed live (2026-07-16, §6.13) that real cameras send
  // High Profile (profile_idc 0x64) and other non-Baseline profiles, and a
  // browser decoder initialized against a profile-level-id that doesn't match
  // the bitstream it actually receives can refuse to produce a single decoded
  // frame (framesDecoded stuck at 0) despite otherwise-healthy RTP delivery.
  // Override with the real value parsed from the camera's own SPS.
  if (profileLevelId) {
    vCodec.parameters = vCodec.parameters || {};
    vCodec.parameters['profile-level-id'] = profileLevelId;
  }

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
    // Reject audio (offer had m=audio but we have no audio Consumer yet — e.g.
    // Camera.webrtcVideoOnly). a=bundle-only was dropped here (2026-07-16,
    // §6.15) — this mid is NOT listed in a=group:BUNDLE below (only bundled
    // mids are, and a rejected section with no Consumer never joins the
    // group), so claiming bundle-only while being absent from the group is a
    // self-contradictory SDP: this mid says "my transport is the bundle
    // tag's" but isn't part of any announced bundle. Confirmed live that this
    // exact inconsistency (not the fingerprint line itself, which was already
    // valid) made Chrome reject the WHOLE answer with the confusing "Called
    // with SDP without DTLS fingerprint" error. A rejected (port=0) section
    // needs no transport attributes at all — inactive + port=0 is sufficient.
    aLines.push(
      `m=audio 0 UDP/TLS/RTP/SAVPF 0`,
      `c=IN IP4 0.0.0.0`,
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
      // Same bundle-only inconsistency as the rejected audio section above.
      dLines.push(
        `m=application 0 UDP/DTLS/SCTP webrtc-datachannel`,
        `c=IN IP4 0.0.0.0`,
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
    const parsed = _parseOffer(sdpOffer);

    if (!parsed.fingerprint.value) {
      return { status: 400, sdpAnswer: 'Could not parse DTLS fingerprint from SDP offer', headers: {} };
    }

    // Log browser ICE candidates so we can diagnose network connectivity issues.
    const browserCands = sdpOffer.match(/a=candidate:[^\r\n]+/g) || [];
    const browserIPs = [...new Set(browserCands.map(c => { const m = c.match(/\d+\.\d+\.\d+\.\d+/g); return m ? m[0] : null; }).filter(Boolean))];
    console.log(`[WebRTC][mediasoup] WHEP [${cameraId.slice(0,8)}] browser-IPs=[${browserIPs.join(', ') || 'none-gathered'}]`);

    // Route to the PT-matched Router/pipeline (2026-07-20, §6.26) — see the
    // big comment above _bootPtRouter() for why this exists: mediasoup fixes
    // a Producer's outgoing PT permanently at Router-registration time, so
    // matching THIS browser's actual offered PT requires selecting (or
    // lazily building) a Router that declared exactly that PT, not patching
    // capabilities after the fact. Falls back to the shared default pipeline
    // if the offer had no recognizable H.264 entry at all (defensive —
    // negotiate() would fail downstream anyway in that case).
    const targetVideoPt = parsed.videoPt ?? DEFAULT_VIDEO_PT;
    let router, videoProducer, audioProducer, dataProducer, rtxMatched;
    if (targetVideoPt === DEFAULT_VIDEO_PT) {
      router        = await _ensureRouter();
      videoProducer = cam.videoProducer;
      audioProducer = cam.audioProducer;
      dataProducer  = cam.dataProducer;
      rtxMatched    = true; // default router's RTX PT (109) is the historically-confirmed common case
      // Lazy fan-out registration (2026-07-20, §6.27) — see the ingestBody
      // comment in addCameraStream(): the default pipeline's video Producer
      // is always created, but ingest-daemon isn't told to mux RTP into it
      // until a browser actually negotiates at PT=108. Fire-and-forget from
      // the SDP-answer-latency perspective (don't await), but mark it
      // registered synchronously so a second concurrent negotiate() for the
      // same camera doesn't fire a redundant POST.
      if (!cam.videoFanoutRegistered) {
        cam.videoFanoutRegistered = true;
        const port = cam.videoPlain?.tuple?.localPort;
        if (port) _ingestPost(`/cameras/${cameraId}/video-fanout`, { port }).catch(() => { cam.videoFanoutRegistered = false; });
      }
    } else {
      const alt     = await _ensureAltPipeline(cameraId, targetVideoPt, parsed.videoRtxPt);
      router        = alt.router;
      videoProducer = alt.videoProducer;
      audioProducer = null; // alt pipelines carry video + data only — see _altPipelines comment
      dataProducer  = alt.dataProducer;
      rtxMatched    = parsed.videoRtxPt != null;
    }
    console.log(
      `[WebRTC][mediasoup] WHEP [${cameraId.slice(0,8)}]` +
      ` browser H264-PT=${parsed.videoPt} RTX-PT=${parsed.videoRtxPt} Opus-PT=${parsed.audioPt}` +
      ` (pipeline: ${targetVideoPt === DEFAULT_VIDEO_PT ? 'default' : `alt-PT ${targetVideoPt}`})`
    );

    // WebRtcTransport with SCTP enabled for DataChannel.
    // listenIps includes all non-docker server IPs so the browser can reach it
    // regardless of which network segment it's on.
    const transport = await router.createWebRtcTransport({
      // listenInfos instead of the deprecated listenIps (2026-07-20, §6.27) —
      // only listenInfos entries carry recvBufferSize/sendBufferSize; the
      // deprecated listenIps form (confirmed by reading Router.js directly)
      // gets auto-expanded into listenInfos WITHOUT those fields, silently
      // leaving every WebRtcTransport's UDP/TCP sockets at the OS default
      // (~208KB, confirmed via `sysctl net.core.rmem_default` — well under
      // the 16MB ceiling `net.core.rmem_max` already allows). PlainTransport
      // already got this fix in §6.18 for the ingest-daemon→mediasoup hop;
      // WebRtcTransport (the actual browser-facing hop) never did. 2MB per
      // socket, not the PlainTransports' 8MB — this is per-VIEWER, not
      // per-camera, so it doesn't scale as favorably with connection count.
      // Manually replicates Router.js's own listenIps→listenInfos expansion
      // (one entry per IP × enabled protocol, UDP preferred first to match
      // preferUdp:true below) since providing listenInfos directly skips
      // that automatic conversion entirely.
      listenInfos: _getListenIps().flatMap(({ ip, announcedIp }) => [
        { protocol: 'udp', ip, announcedAddress: announcedIp, recvBufferSize: 2 * 1024 * 1024, sendBufferSize: 2 * 1024 * 1024 },
        { protocol: 'tcp', ip, announcedAddress: announcedIp, recvBufferSize: 2 * 1024 * 1024, sendBufferSize: 2 * 1024 * 1024 },
      ]),
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

    // mediasoup derives the Consumer's codec PT from the SELECTED router's own
    // preferredPayloadType, not from the capabilities passed here (confirmed
    // by reading ortc.js directly — see the big comment above _bootPtRouter()
    // for the full story) — which is exactly why `router` above is now chosen
    // to already declare targetVideoPt. This call still matters for the
    // header-extension remap: mediasoup sends RTP using Consumer.rtpParameters
    // .headerExtensions[].preferredId, and if those don't match the browser's
    // own a=extmap IDs, the browser can't find the MID extension in incoming
    // RTP → BUNDLE demux fails → all packets dropped, no inbound-rtp at all.
    const browserCaps = _buildBrowserRtpCapabilities(parsed, router.rtpCapabilities);

    // Fetch the camera's real SPS/PPS (2026-07-16, §6.13) for the SDP answer's
    // sprop-parameter-sets (see _buildAnswer()). profile-level-id is NOT
    // patched into browserCaps here — an earlier version of this fix set
    // browserCaps' video codec parameters to the camera's actual
    // profile-level-id (e.g. '64001f', High Profile) right before
    // transport.consume(), which made mediasoup's Producer (still declared as
    // Baseline '42e01f' — see addCameraStream()) vs. Consumer-capabilities
    // profile MISMATCH badly enough that mediasoup's internal H.264
    // profile-compatibility check rejected the negotiation outright ("no
    // compatible media codecs"). Baseline vs High are genuinely incompatible
    // profiles per RFC 6184's compatibility rules, not just a level
    // difference `level-asymmetry-allowed` can paper over. The real fix is
    // the STATIC default declared at Producer-creation time (see
    // VIDEO_CODEC_PARAMETERS / addCameraStream()), since the Producer is
    // created before ingest-daemon has even connected to probe the camera's
    // actual profile — there is no per-camera value available yet at that
    // point.
    // mediasoup has no H.265 support at all (2026-07-20, §6.25 — see the
    // router mediaCodecs comment), so an hevc camera's video-params are only
    // ever used for the diagnostic warning in addCameraStream(), never here.
    const videoParams = await _ingestGetVideoParams(cameraId);
    let spropParameterSets = null;
    let profileLevelId     = null;
    if (videoParams?.ready && videoParams.spropParameterSets) {
      spropParameterSets = videoParams.spropParameterSets;
      profileLevelId     = videoParams.profileLevelId;
      _lastKnownVideoParams.set(cameraId, { spropParameterSets, profileLevelId });
    } else if (videoParams?.ready && videoParams.codec && videoParams.codec !== 'h264') {
      console.warn(`[WebRTC][mediasoup] [${cameraId.slice(0,8)}] camera video codec is ${videoParams.codec}, not h264 — mediasoup has no H.265 support, playback cannot work for this camera`);
    } else {
      // See _lastKnownVideoParams' comment above — this fetch fails often
      // enough under load that falling all the way back to the Producer's
      // Baseline/'42e01f' default (genuinely incompatible with these
      // cameras' real High-Profile streams) would otherwise happen on a
      // meaningful fraction of ordinary reconnects, not just cold starts.
      const cached = _lastKnownVideoParams.get(cameraId);
      if (cached) {
        spropParameterSets = cached.spropParameterSets;
        profileLevelId     = cached.profileLevelId;
        console.warn(`[WebRTC][mediasoup] [${cameraId.slice(0,8)}] video-params fetch failed (ready=${videoParams?.ready}) — reusing last-known-good profile-level-id=${profileLevelId}`);
      } else {
        console.warn(`[WebRTC][mediasoup] [${cameraId.slice(0,8)}] video-params not available yet (ready=${videoParams?.ready}) — SDP answer will have no sprop-parameter-sets`);
      }
    }

    // Video Consumer — enableRtx (2026-07-16, §6.17; made conditional
    // 2026-07-20, §6.26) lets mediasoup replay lost packets from its own send
    // buffer on NACK, independent of the passthrough Producer. Only enabled
    // when this router's RTX PT is known to match what the browser's own
    // offer actually uses (rtxMatched, computed above) — enabling it against
    // a PT the browser never associated with H264-RTX is the exact "actively
    // harmful, not just ineffective" collision class documented on the
    // default router's RTX comment (retransmits landing on a codec the
    // browser interprets differently made loss recovery WORSE than RTX off).
    const videoConsumer = await transport.consume({
      producerId:      videoProducer.id,
      rtpCapabilities: browserCaps,
      paused:          false,
      enableRtx:       rtxMatched,
    });
    // A viewer joining mid-GOP only receives P-frames referencing an I-frame it
    // never saw — undecodable, so the browser reports bytesReceived growing but
    // framesDecoded stuck at 0 (confirmed live: "No decoder" in Chrome's Media
    // panel / vFrames=0 despite vBytesRx in the millions). requestKeyFrame()
    // is the standard mediasoup call for this; it can only help if the PLI it
    // sends actually reaches something that can act on it (see caveat below).
    videoConsumer.requestKeyFrame().catch(() => {});

    // Audio Consumer (non-fatal if audio hasn't started yet, camera is
    // videoOnly, or this negotiation landed on an alt-PT pipeline — those
    // don't carry an audio Producer at all, see _altPipelines comment)
    let audioConsumer = null;
    if (audioProducer && !audioProducer.closed) {
      audioConsumer = await transport.consume({
        producerId:      audioProducer.id,
        rtpCapabilities: browserCaps,
        paused:          false,
        enableRtx:       false,
      }).catch(() => null);
    }

    // DataConsumer (only if browser included m=application in offer, and camera isn't videoOnly)
    let dataConsumer = null;
    if (parsed.hasData && dataProducer && !dataProducer.closed) {
      dataConsumer = await transport.consumeData({
        dataProducerId: dataProducer.id,
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
      // vScore throttling (2026-07-21) — mediasoup emits 'score' on every
      // recalculation, including harmless 9↔10 flicker under normal jitter;
      // with several concurrent streams this produced 10+ log lines/sec of
      // pure noise (confirmed live) and the console.log + file-write cost
      // itself adds load on an already CPU-constrained shared server. Only
      // log when score.score actually moves by a meaningful margin from the
      // last logged value — small flicker is suppressed, real degradation
      // (or recovery from it) still gets logged.
      const VSCORE_LOG_DELTA = 2;
      let lastLoggedVScore = -1;
      videoConsumer.on('score', score => {
        if (lastLoggedVScore >= 0 && Math.abs(score.score - lastLoggedVScore) < VSCORE_LOG_DELTA) return;
        lastLoggedVScore = score.score;
        console.log(`[WebRTC][mediasoup] vScore [${cameraId.slice(0,8)}]:`, JSON.stringify(score));
      });
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

    const sdpAnswer = _buildAnswer({ parsed, transport, videoConsumer, audioConsumer, dataConsumer, cameraId, spropParameterSets, profileLevelId });
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
      const vStats = cam.videoProducer && !cam.videoProducer.closed
        ? await _withIpcTimeout(cam.videoProducer.getStats(), `[${cameraId.slice(0, 8)}] videoProducer.getStats()`) : null;
      const aStats = cam.audioProducer && !cam.audioProducer.closed
        ? await _withIpcTimeout(cam.audioProducer.getStats(), `[${cameraId.slice(0, 8)}] audioProducer.getStats()`) : null;
      const vRx = vStats ? vStats.reduce((s, x) => s + (x.byteCount || 0), 0) : 0;
      const aRx = aStats ? aStats.reduce((s, x) => s + (x.byteCount || 0), 0) : 0;

      // Consumer send stats (per active browser viewer)
      const consumers = _activeConsumers.get(cameraId) || [];
      const consumerStats = await Promise.all(consumers.map(async entry => {
        try {
          const cs = entry.videoConsumer?.closed
            ? [] : await _withIpcTimeout(entry.videoConsumer.getStats(), `[${cameraId.slice(0, 8)}] videoConsumer.getStats()`);
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
        } catch (e) { return { error: e.message || 'stats-err' }; }
      }));

      // Transport-level stats to verify if PlainTransport is receiving packets
      // (distinct from Producer stats which count after SSRC/PT routing)
      const aTransStats = cam.audioPlain && !cam.audioPlain.closed
        ? await _withIpcTimeout(cam.audioPlain.getStats(), `[${cameraId.slice(0, 8)}] audioPlain.getStats()`).catch(() => []) : [];
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
      const reregBody = {
        id:                 cameraId,
        rtspUrl:            cam.rtspUrl,
        callbackUrl:        `${base}/api/internal/frame/${cameraId}`,
        appRtpCallbackUrl:  `${base}/api/internal/apprtp/${cameraId}`,
        mediasoupAudioPort: audioPort,
      };
      // mediasoupPort stays conditional on videoFanoutRegistered (2026-07-20,
      // §6.27) — see addCameraStream()'s ingestBody comment for why the
      // default pipeline's video fan-out is lazy; re-registering it
      // unconditionally here would undo that saving on every ingest-daemon
      // restart, which is exactly the path `npm run ingest:restart` drives.
      if (cam.videoFanoutRegistered) reregBody.mediasoupPort = videoPort;
      if (cam.appRtpRtspUrl) reregBody.appRtpRtspUrl = cam.appRtpRtspUrl;
      if (cam.captureFps > 0) reregBody.captureFps = cam.captureFps;
      const status = await _ingestPost('/cameras', reregBody);
      // Re-register alt-PT pipelines' video fan-out too (2026-07-20, §6.27) —
      // ingest-daemon's restart wipes ALL CameraSession state, so any alt-PT
      // viewer (the now-common case per §6.26's live evidence) would
      // silently go dark after `npm run ingest:restart` without this,
      // mirroring the same re-registration addCameraStream() does on a
      // per-camera reconnect.
      const camAlt = _altPipelines.get(cameraId);
      if (camAlt) {
        for (const pPromise of camAlt.values()) {
          pPromise.then(alt => {
            const port = alt.videoPlain?.tuple?.localPort;
            if (port) _ingestPost(`/cameras/${cameraId}/video-fanout`, { port }).catch(() => {});
          }).catch(() => {});
        }
      }
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
