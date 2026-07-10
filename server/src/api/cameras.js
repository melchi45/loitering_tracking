'use strict';

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { validateChannelSlot, nextFreeChannelSlot } = require('../services/channelSlotService');
const { querySunapiMaxChannel, querySunapiRtspPort, getDiscoveryService } = require('../services/discoveryService');
const { enrichDeviceAutoScheme } = require('../services/onvifDiscovery');
const { channelRtspUrl, defaultSunapiRtspUrl } = require('../utils/channelRtsp');

// POST /api/cameras/probe-channels — best-effort, both branches independently
// time-boxed so a hung/unreachable device can't stall the request indefinitely.
const PROBE_TIMEOUT_MS = 8000;
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const SERVER_MODE      = process.env.SERVER_MODE      || 'combined';
const CAPTURE_BACKEND  = (process.env.CAPTURE_BACKEND || 'ffmpeg').toLowerCase();
const WEBRTC_ENGINE    = (process.env.WEBRTC_ENGINE   || 'mediamtx').toLowerCase();

// ingest-daemon now supports RTP fan-out for mediasoup (mediasoupPort / mediasoupAudioPort).
// WebRTC availability is determined by the pipeline, not forced off here.
const FORCE_NO_WEBRTC  = false;

function normalizeRtspUrl(rtspUrl) {
  if (typeof rtspUrl !== 'string' || !rtspUrl.trim()) {
    return { ok: false, error: 'rtspUrl must be a non-empty string' };
  }

  let normalized = rtspUrl.trim();
  let correctedFromRtps = false;
  if (/^rtps:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^rtps:\/\//i, 'rtsp://');
    correctedFromRtps = true;
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_) {
    return { ok: false, error: 'rtspUrl must be a valid RTSP URL' };
  }

  if (parsed.protocol !== 'rtsp:') {
    return { ok: false, error: 'rtspUrl must start with rtsp://' };
  }

  return { ok: true, value: parsed.toString(), correctedFromRtps };
}

/**
 * Decides POST /api/cameras/probe-channels' combined maxChannel/protocol/profiles
 * result from this request's live SUNAPI + ONVIF probe results, with a final
 * fallback (2026-07-02, FR-CH-069) to the UDP Discovery registry's own already-
 * established MaxChannel when both live probes for *this specific request* came
 * back empty — a transient auth failure, wrong port, or an ONVIF scheme the dual
 * HTTP/HTTPS trial didn't happen to answer on shouldn't regress the operator-
 * facing result from "known N-channel NVR" back down to "single-channel/not
 * found" when the device's channel count was already independently confirmed by
 * an earlier scan. Pure/no I/O — extracted specifically so this decision logic
 * (including the fallback branch) can be unit-tested without a live server; see
 * test/api/channel_slot.test.js TC-CH-F-013/F-013b.
 * @param {{ onvifMax: number, onvifProfiles: Array, sunapiMax: number, sunapiProfiles: Array,
 *           knownDevice: object|null, baseRtspUrl: string|null|undefined }} params
 * @returns {{ maxChannel: number, supportSunapi: boolean, protocol: 'sunapi'|'onvif'|'none',
 *             profiles: Array, usedRegistryFallback: boolean }}
 */
function resolveProbeChannelsDecision({ onvifMax, onvifProfiles, sunapiMax, sunapiProfiles, knownDevice, baseRtspUrl }) {
  if (onvifMax > 1 && onvifProfiles.length > 0) {
    // Prefer ONVIF: real, verified per-channel RTSP URLs.
    return {
      maxChannel: onvifMax, supportSunapi: false, protocol: 'onvif',
      profiles: onvifProfiles.map((p) => ({ channelIndex: p.channelIndex, rtspUrl: p.rtspUrl })),
      usedRegistryFallback: false,
    };
  }
  if (sunapiMax > 1) {
    return { maxChannel: sunapiMax, supportSunapi: true, protocol: 'sunapi', profiles: sunapiProfiles, usedRegistryFallback: false };
  }
  if ((knownDevice?.MaxChannel || 1) > 1) {
    // Last-resort fallback: distinct from the cachedMaxChannel check further up
    // (FR-CH-065, gated on SupportSunapi to skip a redundant CGI round-trip
    // *before* querying) — this fires *after* both live probes already ran and
    // found nothing, regardless of which protocol the scan used to establish
    // the count.
    const maxChannel = knownDevice.MaxChannel;
    if (knownDevice.SupportSunapi) {
      const profiles = baseRtspUrl
        ? Array.from({ length: maxChannel }, (_, i) => i + 1)
            .map((ch) => ({ channelIndex: ch, rtspUrl: channelRtspUrl(baseRtspUrl, ch) }))
            .filter((p) => p.rtspUrl !== baseRtspUrl || p.channelIndex === 1)
        : [];
      return { maxChannel, supportSunapi: true, protocol: 'sunapi', profiles, usedRegistryFallback: true };
    }
    if (Array.isArray(knownDevice.profiles) && knownDevice.profiles.some((p) => p.rtspUrl)) {
      const profiles = knownDevice.profiles.filter((p) => p.rtspUrl).map((p) => ({ channelIndex: p.channelIndex, rtspUrl: p.rtspUrl }));
      return { maxChannel, supportSunapi: false, protocol: 'onvif', profiles, usedRegistryFallback: true };
    }
    // Only a bare channel count is known (no protocol-specific profile detail
    // carried over from the scan) — label as 'sunapi' since that's this
    // codebase's convention for "count known, profiles synthesized via path
    // substitution when a baseRtspUrl is available".
    return { maxChannel, supportSunapi: true, protocol: 'sunapi', profiles: [], usedRegistryFallback: true };
  }
  return { maxChannel: 1, supportSunapi: false, protocol: 'none', profiles: [], usedRegistryFallback: false };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('../services/pipelineManager')} pipelineManager
 * @param {import('../services/youtubeStreamService')|null} [youtubeSvc]
 * @returns {Router}
 */
function camerasRouter(db, pipelineManager, youtubeSvc = null) {
  const router = Router();

  /**
   * GET /api/cameras
   * List all cameras with their current pipeline status.
   */
  router.get('/', (req, res) => {
    try {
      const cameras = db.all('cameras').sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
      const result = cameras.map((cam) => {
        const pipelineStatus = pipelineManager.getCameraStatus(cam.id);
        // YouTube cameras store bitrate in DB as bps; normalize to kbps for API consumers
        const bitrate = cam.type === 'youtube' && cam.bitrate
          ? Math.round(cam.bitrate / 1000)
          : cam.bitrate;
        return {
          ...cam,
          bitrate,
          password:       undefined, // Never expose password in list
          pipelineStatus: pipelineStatus || null,
          ...(FORCE_NO_WEBRTC && { webrtcEnabled: false }),
        };
      });
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/discover
   * Trigger UDP discovery broadcast. Results are sent via Socket.IO.
   * Returns an empty array immediately; real results arrive via 'discovery:result' socket event.
   */
  router.post('/discover', (req, res) => {
    try {
      if (SERVER_MODE === 'analysis') {
        return res.status(409).json({
          success: false,
          error: 'Camera discovery is disabled when SERVER_MODE=analysis',
        });
      }
      // Signal via Socket.IO to start discovery (handled in streamHandler)
      // The actual UDPDiscovery is kicked off by the client via socket event.
      // This REST endpoint exists as a convenience trigger.
      const io = req.app.get('io');
      if (io) {
        io.emit('discovery:trigger');
      }
      res.json({ success: true, data: [], message: 'Discovery started. Listen for discovery:result socket events.' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/probe-channels
   * On-demand SUNAPI + ONVIF MaxChannel re-detection for a single, already-known
   * IP — used by the manual Add Camera form (no prior discovery scan) and by
   * CameraEditModal's "Re-detect" button (existing cameras added before this
   * feature, or whose NVR channel count needs refreshing).
   *
   * Unlike the full network discovery scan, this targets exactly one IP and is
   * time-boxed (PROBE_TIMEOUT_MS) per protocol so a hung/unreachable device
   * can't stall the request. Both protocols are tried; SUNAPI can only report a
   * count — channel RTSP URLs are synthesized: if baseRtspUrl is given,
   * channelRtspUrl() substitutes the channel segment while preserving
   * whichever convention that URL already uses (`/profileN/` or `/N/H.264/`,
   * see docs/design/Design_Camera_Discovery.md); otherwise defaultSunapiRtspUrl()
   * guesses fresh using the `/N/H.264/` (0-based) convention and the
   * CGI-confirmed RTSP port (querySunapiRtspPort(), falls back to 554) — while
   * ONVIF's GetProfiles/GetStreamUri yields real per-channel RTSP URLs. ONVIF
   * profiles are preferred as the merged `profiles`/`protocol` when both
   * protocols report channels, since they carry actual verified URLs, but
   * both protocols' own results are always returned independently too (see
   * sunapiProfiles/onvifProfiles below) so the UI can show which protocol
   * resolved which channel's URL.
   *
   * Body: { ip, httpPort?, httpType?, onvifPort?, onvifHttpsPort?, username?, password?, baseRtspUrl?, cameraId? }
   *   onvifPort/onvifHttpsPort (2026-07-02): the ONVIF device_service XAddr is guessed
   *   (no WS-Discovery-asserted URL to go on for an on-demand single-IP probe), so both
   *   http://ip:onvifPort (default 80) and https://ip:onvifHttpsPort (default 443) are
   *   tried in parallel via enrichDeviceAutoScheme() — whichever scheme actually answers
   *   is used; a device's SUNAPI and ONVIF services do not always agree on scheme even
   *   on the same box (observed live: 192.168.214.37's SUNAPI CGI is HTTPS-only via an
   *   nginx redirect, but its ONVIF service answers on plain HTTP).
   *   cameraId (FR-CH-064): when set and username/password are omitted, the camera's
   *   own stored credentials are looked up server-side and used for the SUNAPI probe
   *   (the client never receives the password value — GET /api/cameras strips it).
   *   If no credentials are resolvable from any source (request body, camera record,
   *   RTSP_DEFAULT_* env), the SUNAPI probe is skipped entirely rather than attempted
   *   with no auth — see docs/design/Design_Channel_Slot.md §4.6b.
   * Response: { success, maxChannel, supportSunapi, protocol: 'sunapi'|'onvif'|'none', profiles: [{channelIndex, rtspUrl}],
   *             sunapiMaxChannel, onvifMaxChannel: number|null,
   *             sunapiProfiles: [{channelIndex, rtspUrl}], onvifProfiles: [{channelIndex, rtspUrl}],
   *             sunapiRtspPort: number|null }
   *   sunapiMaxChannel/onvifMaxChannel (FR-CH-066) report each protocol's own count
   *   independently of which one "won" as maxChannel/protocol above; onvifMaxChannel is
   *   null (not 1) when ONVIF never responded, vs. sunapiMaxChannel which is always a
   *   number (1 when not attempted/not detected — SUNAPI has no null case here).
   *   sunapiProfiles/onvifProfiles report each protocol's own per-channel RTSP URLs,
   *   same independence rule as above — lets the UI display both side by side instead
   *   of only the merged `profiles`. sunapiRtspPort is the CGI-confirmed RTSP port
   *   (network.cgi?msubmenu=portconf&action=view — requires admin auth, null when
   *   credentials unavailable/query failed; callers should assume 554 when null).
   */
  router.post('/probe-channels', async (req, res) => {
    try {
      const { ip, httpPort, httpType, onvifPort, onvifHttpsPort, username, password, baseRtspUrl, cameraId } = req.body;
      if (!ip || typeof ip !== 'string') {
        return res.status(400).json({ success: false, error: 'ip is required' });
      }

      // Re-probing an already-added camera (Edit modal's "Re-detect") never has the
      // password in hand client-side — GET /api/cameras strips it from every response
      // (see GET / and GET /:id above). Looking it up server-side by cameraId lets
      // Re-detect authenticate with the camera's own stored credentials without ever
      // exposing the password value to the client.
      const camera = cameraId ? db.findOne('cameras', { id: cameraId }) : null;
      const effectiveUsername = username || camera?.username || '';
      const effectivePassword = password || camera?.password || process.env.RTSP_DEFAULT_PASSWORD || '';
      const canAuthSunapi = !!(effectiveUsername && effectivePassword);

      // FR-CH-065: if this exact IP was already found by the background/manual UDP
      // Discovery scan (discoveryService.js — a completely separate mechanism from
      // this on-demand HTTP CGI probe), and that scan already reports a multi-channel
      // SUNAPI device, reuse it directly — no network round-trip, no credentials
      // needed at all. Falls through to the CGI query below when there's no cached
      // hit (nothing scanned yet, scan reported single-channel, or the discovery
      // service singleton hasn't been created because discovery is disabled).
      const discoverySvc = getDiscoveryService();
      const knownDevice  = discoverySvc ? discoverySvc.getByIp(ip) : null;
      const cachedMaxChannel = (knownDevice?.SupportSunapi && (knownDevice.MaxChannel || 1) > 1)
        ? knownDevice.MaxChannel
        : null;

      // The credential gate below only applies when probing a *specific, already-added*
      // camera (cameraId present — currently only CameraEditModal's "Re-detect" sends
      // this): if that camera's own record has no password on file (and neither does
      // the request or RTSP_DEFAULT_* env), we already know from its DB record that
      // this exact device has never authenticated, so attempting SUNAPI again is a
      // guaranteed-failure network round-trip — skip it. This does NOT apply to a
      // fresh, not-yet-added IP (Add-tab "Detect Channels", or the Found-tab panel's
      // Re-detect — neither sends cameraId, since neither has an added-camera DB
      // record to consult) — there we have no such prior signal, so the existing
      // best-effort unauthenticated attempt is kept (some devices do answer the
      // channel-list query without auth; see TC-CH-F-003).
      const skipSunapi = !!cameraId && !canAuthSunapi;

      console.debug(`[cameras][probe-channels] request ip=${ip} httpPort=${httpPort || '(default)'} httpType=${httpType ? 'https' : 'http'} onvifPort=${onvifPort || 80} auth=${canAuthSunapi ? 'yes' : 'no'}${cameraId ? ` cameraId=${cameraId}` : ''}${cachedMaxChannel ? ` cachedMaxChannel=${cachedMaxChannel}` : ''}`);

      let sunapiPromise;
      let sunapiRtspPortPromise;
      if (cachedMaxChannel) {
        console.debug(`[cameras][probe-channels] ip=${ip} using cached UDP Discovery MaxChannel=${cachedMaxChannel} — skipping SUNAPI CGI query entirely`);
        sunapiPromise = Promise.resolve(cachedMaxChannel);
        sunapiRtspPortPromise = Promise.resolve(null);
      } else if (skipSunapi) {
        console.debug(`[cameras][probe-channels] ip=${ip} skipping SUNAPI probe — camera ${cameraId} has no username/password on file (checked camera record, request body, RTSP_DEFAULT_* env)`);
        sunapiPromise = Promise.resolve(1);
        sunapiRtspPortPromise = Promise.resolve(null);
      } else {
        sunapiPromise = withTimeout(
          querySunapiMaxChannel(ip, httpPort, httpType, PROBE_TIMEOUT_MS / 2, effectiveUsername, effectivePassword),
          PROBE_TIMEOUT_MS,
          1,
        );
        // querySunapiRtspPort() requires admin auth (verified: HTTP 401 with no
        // credentials) and no-ops internally when username/password are blank,
        // so this is safe to fire unconditionally alongside the MaxChannel query.
        sunapiRtspPortPromise = withTimeout(
          querySunapiRtspPort(ip, httpPort, httpType, PROBE_TIMEOUT_MS / 2, effectiveUsername, effectivePassword),
          PROBE_TIMEOUT_MS,
          null,
        );
      }

      const [sunapiMax, sunapiRtspPort, onvifResult] = await Promise.all([
        sunapiPromise,
        sunapiRtspPortPromise,
        withTimeout(
          // Same effectiveUsername/effectivePassword the SUNAPI probe above uses
          // (request body → stored camera record → RTSP_DEFAULT_* env) — ONVIF's
          // soapPost() tries Basic first and retries with Digest on a Digest
          // challenge (FR-CAM-090), same as querySunapiMaxChannel()/
          // querySunapiRtspPort() already do for SUNAPI (FR-CAM-072/089).
          enrichDeviceAutoScheme(ip, { onvifPort, onvifHttpsPort, username: effectiveUsername, password: effectivePassword }),
          PROBE_TIMEOUT_MS,
          null,
        ),
      ]);

      const onvifMax = onvifResult?.MaxChannel || 1;
      const onvifProfiles = (onvifResult?.profiles || []).filter((p) => p.rtspUrl);

      // sunapiProfiles is computed independently of onvifProfiles/maxChannel
      // "winner" below (FR-CH-066/FR-CH-06x pattern: report both protocols'
      // own results, not just the merged view) — reuses the confirmed
      // baseRtspUrl's convention via channelRtspUrl() when a base URL is
      // known, otherwise synthesizes fresh via defaultSunapiRtspUrl() using
      // the CGI-confirmed sunapiRtspPort (falls back to 554 internally).
      const sunapiProfiles = sunapiMax > 1 || baseRtspUrl
        ? Array.from({ length: Math.max(sunapiMax, 1) }, (_, i) => i + 1)
            .map((ch) => ({
              channelIndex: ch,
              rtspUrl: baseRtspUrl
                ? channelRtspUrl(baseRtspUrl, ch)
                : defaultSunapiRtspUrl(ip, sunapiRtspPort, ch),
            }))
            .filter((p) => !baseRtspUrl || p.rtspUrl !== baseRtspUrl || p.channelIndex === 1)
        : [];

      console.debug(`[cameras][probe-channels] ip=${ip} SUNAPI maxChannel=${sunapiMax} rtspPort=${sunapiRtspPort ?? '(unconfirmed, default 554)'}; ONVIF maxChannel=${onvifResult ? onvifMax : '(no response/timeout)'}, profiles-with-rtsp=${onvifProfiles.length}`);

      const { maxChannel, supportSunapi, protocol, profiles, usedRegistryFallback } = resolveProbeChannelsDecision({
        onvifMax, onvifProfiles, sunapiMax, sunapiProfiles, knownDevice, baseRtspUrl,
      });
      if (usedRegistryFallback) {
        console.debug(`[cameras][probe-channels] ip=${ip} live SUNAPI+ONVIF probes found nothing this request — falling back to UDP Discovery's own MaxChannel=${maxChannel}`);
      }

      console.debug(`[cameras][probe-channels] ip=${ip} decision → protocol=${protocol}, maxChannel=${maxChannel}, profiles=${profiles.length}`);

      // FR-CH-068: this on-demand probe often has better information than the
      // registry does — e.g. UDP broadcast alone reports MaxChannel:1 (binary
      // field not parsed yet), but this probe just authenticated with a
      // device-specific credential and got a real answer from attributes.cgi.
      // Write the correction back into the shared discovery registry (if this
      // IP is in it at all) so every connected client's Found list/panel picks
      // it up going forward, not just this one request's response — otherwise
      // the fix only lives in this browser tab's local state until the next
      // full re-scan. Never lowers an existing value (see applyProbeResult()).
      if (discoverySvc) {
        discoverySvc.applyProbeResult(ip, {
          maxChannel,
          supportSunapi: sunapiMax > 1,
          sunapiMaxChannel: sunapiMax,
          onvifMaxChannel: onvifResult ? onvifMax : null,
        });
      }

      res.json({
        success: true, maxChannel, supportSunapi, protocol, profiles,
        // Per-protocol values, in addition to the combined maxChannel/protocol
        // above — lets the UI show what each protocol reported independently
        // instead of only the winning one (FR-CH-066). onvifMaxChannel is
        // null (not 1) when ONVIF never responded at all, distinguishing
        // "detected as single-channel" from "no data".
        sunapiMaxChannel: sunapiMax,
        onvifMaxChannel: onvifResult ? onvifMax : null,
        // Per-protocol RTSP URLs, independent of which protocol "won" as
        // profiles/protocol above — lets the UI show both a SUNAPI-derived
        // and an ONVIF-derived URL for the same channel side by side.
        sunapiProfiles,
        onvifProfiles: onvifProfiles.map((p) => ({ channelIndex: p.channelIndex, rtspUrl: p.rtspUrl })),
        // CGI-confirmed RTSP port (network.cgi?msubmenu=portconf&action=view),
        // or null when not queried/confirmed — callers should treat null as
        // "unconfirmed, SUNAPI default 554 applies" rather than an error.
        sunapiRtspPort,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras
   * Add a new camera.
   * Body: { name, rtspUrl, username?, password?, ip?, mac?, httpPort?, channelIndex?,
   *         channelSlot?, maxChannel?, supportSunapi?, nvrProfiles? }
   *
   * channelSlot (global dashboard grid position, 1..MAX_CHANNEL_NUM) is distinct
   * from channelIndex (NVR physical sub-channel). If omitted, the lowest free slot
   * is auto-assigned — kept optional for backward compatibility with pre-existing
   * integrations/tests that predate this feature; the Add Camera UI always sends
   * it explicitly. See docs/design/Design_Channel_Slot.md.
   */
  router.post('/', (req, res) => {
    try {
      const {
        name, rtspUrl, username, password, ip, mac, httpPort, channelIndex,
        maxChannel, supportSunapi, nvrProfiles, thermalSensorWidth, thermalSensorHeight,
      } = req.body;
      let { channelSlot } = req.body;
      if (!name || !rtspUrl) {
        return res.status(400).json({ success: false, error: 'name and rtspUrl are required' });
      }

      const normalizedRtsp = normalizeRtspUrl(rtspUrl);
      if (!normalizedRtsp.ok) {
        return res.status(400).json({ success: false, error: normalizedRtsp.error });
      }

      if (channelSlot === undefined || channelSlot === null || channelSlot === '') {
        channelSlot = nextFreeChannelSlot(db);
      } else {
        channelSlot = parseInt(channelSlot, 10);
      }
      const slotCheck = validateChannelSlot(db, channelSlot);
      if (!slotCheck.ok) {
        return res.status(slotCheck.status).json({ success: false, error: slotCheck.error });
      }

      const id = uuidv4();
      db.insert('cameras', {
        id, name, rtspUrl: normalizedRtsp.value,
        username:      username     || process.env.RTSP_DEFAULT_USERNAME || null,
        password:      password     || process.env.RTSP_DEFAULT_PASSWORD || null,
        ip:            ip           || null,
        mac:           mac          || null,
        httpPort:      httpPort     || null,
        channelIndex:  channelIndex ? parseInt(channelIndex, 10) : null,
        channelSlot,
        maxChannel:    maxChannel ? parseInt(maxChannel, 10) : null,
        supportSunapi: !!supportSunapi,
        nvrProfiles:   Array.isArray(nvrProfiles) ? nvrProfiles : null,
        thermalSensorWidth:  thermalSensorWidth  ? parseInt(thermalSensorWidth, 10)  : null,
        thermalSensorHeight: thermalSensorHeight ? parseInt(thermalSensorHeight, 10) : null,
        status:        'offline',
      });

      const camera = db.findOne('cameras', { id });
      res.status(201).json({
        success: true,
        data: { ...camera, password: undefined },
        warning: normalizedRtsp.correctedFromRtps ? 'rtps:// was corrected to rtsp:// automatically' : undefined,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/cameras/:id
   * Get details for a specific camera.
   */
  router.get('/:id', (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      const pipelineStatus = pipelineManager.getCameraStatus(camera.id);
      res.json({
        success: true,
        data: {
          ...camera,
          password:       undefined,
          pipelineStatus: pipelineStatus || null,
          ...(FORCE_NO_WEBRTC && { webrtcEnabled: false }),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * PUT /api/cameras/:id
   * Update camera config. Restarts the pipeline when rtspUrl, credentials, or
   * webrtcEnabled change so the new settings take effect immediately.
   */
  router.put('/:id', async (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      const {
        name, rtspUrl, username, password, webrtcEnabled, channelSlot, channelIndex,
        maxChannel, supportSunapi, nvrProfiles, thermalSensorWidth, thermalSensorHeight,
      } = req.body;
      let normalizedRtsp = null;
      if (rtspUrl !== undefined) {
        normalizedRtsp = normalizeRtspUrl(rtspUrl);
        if (!normalizedRtsp.ok) {
          return res.status(400).json({ success: false, error: normalizedRtsp.error });
        }
      }

      if (channelSlot !== undefined) {
        const slotCheck = validateChannelSlot(db, parseInt(channelSlot, 10), camera.id);
        if (!slotCheck.ok) {
          return res.status(slotCheck.status).json({ success: false, error: slotCheck.error });
        }
      }

      const updates = {};
      if (name          !== undefined) updates.name          = name;
      if (rtspUrl       !== undefined) updates.rtspUrl       = normalizedRtsp.value;
      if (username      !== undefined) updates.username      = username || null;
      if (password      !== undefined) updates.password      = password || null;
      if (webrtcEnabled !== undefined) updates.webrtcEnabled = !!webrtcEnabled;
      if (channelSlot   !== undefined) updates.channelSlot   = parseInt(channelSlot, 10);
      if (channelIndex  !== undefined) updates.channelIndex  = parseInt(channelIndex, 10);
      // maxChannel/supportSunapi/nvrProfiles: populated by POST /api/cameras/probe-channels
      // (SUNAPI/ONVIF re-detection) for cameras that predate this data or need a refresh.
      if (maxChannel    !== undefined) updates.maxChannel    = maxChannel ? parseInt(maxChannel, 10) : null;
      if (supportSunapi !== undefined) updates.supportSunapi = !!supportSunapi;
      if (nvrProfiles   !== undefined) updates.nvrProfiles   = Array.isArray(nvrProfiles) ? nvrProfiles : null;
      // Thermal sensor native resolution (e.g. 160x120) — used by ThermalOverlay to
      // calibrate onvif:temperature raw coordinates onto the actual video resolution.
      if (thermalSensorWidth  !== undefined) updates.thermalSensorWidth  = thermalSensorWidth  ? parseInt(thermalSensorWidth, 10)  : null;
      if (thermalSensorHeight !== undefined) updates.thermalSensorHeight = thermalSensorHeight ? parseInt(thermalSensorHeight, 10) : null;

      db.update('cameras', camera.id, updates);
      const updated = db.findOne('cameras', { id: camera.id });

      // Only restart pipeline when a value that actually affects the stream changed.
      // Checking presence (webrtcEnabled !== undefined) was wrong — CameraEditModal
      // always sends webrtcEnabled, causing a ByteTracker reset on every save.
      const needsRestart =
        (rtspUrl       !== undefined && normalizedRtsp.value    !== camera.rtspUrl) ||
        (webrtcEnabled !== undefined && !!webrtcEnabled        !== !!camera.webrtcEnabled) ||
        (username      !== undefined && (username || null)     !== camera.username) ||
        (password      !== undefined && (password || null)     !== camera.password);

      // Respond immediately so the browser does not time out while waiting for
      // ONNX model load / RTSP negotiation (can take several seconds).
      res.json({
        success: true,
        data: { ...updated, password: undefined },
        restarted: needsRestart,
        warning: normalizedRtsp?.correctedFromRtps ? 'rtps:// was corrected to rtsp:// automatically' : undefined,
      });

      if (needsRestart && updated.status !== 'idle') {
        setImmediate(async () => {
          try {
            await pipelineManager.stopCamera(camera.id);
            await pipelineManager.startCamera(updated);
          } catch (e) {
            console.error('[cameras] pipeline restart error:', e.message);
          }
        });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/:id/stream/reconnect
   * Stop the current pipeline and start fresh (double-click or post-edit reconnect).
   */
  router.post('/:id/stream/reconnect', async (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      res.json({ success: true, message: 'Reconnecting', cameraId: camera.id });
      setImmediate(async () => {
        try {
          await pipelineManager.stopCamera(camera.id);
          await pipelineManager.startCamera(camera);
        } catch (e) {
          console.error('[cameras] reconnect error:', e.message);
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * DELETE /api/cameras/:id
   * Remove a camera and stop its stream.
   * For YouTube virtual cameras, also stops the yt-dlp/ffmpeg pipeline.
   */
  router.delete('/:id', async (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      // Stop the YouTube stream service first (kills yt-dlp + ffmpeg, removes from memory)
      if (camera.type === 'youtube' && youtubeSvc) {
        try {
          await youtubeSvc.stopStream(camera.id);
        } catch (stopErr) {
          // Entry not in memory map (never started, or already removed).
          // Still guarantee pipeline and DB are cleaned up so the camera doesn't
          // resurface on the next server restart via restoreFromDB().
          if (stopErr.code !== 'NOT_FOUND') {
            console.warn(`[cameras] DELETE ${camera.id}: stopStream error — ${stopErr.message}`);
          }
          try { await pipelineManager.stopCamera(camera.id); } catch {}
          try { db.delete('cameras', camera.id); } catch {}
        }
      } else {
        await pipelineManager.stopCamera(camera.id);
        db.delete('cameras', camera.id);
      }

      res.json({ success: true, message: 'Camera removed' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/:id/ai/toggle
   * Toggle AI inference on/off for a camera without restarting the pipeline.
   */
  router.post('/:id/ai/toggle', (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      const newValue = camera.aiEnabled === false ? true : false; // default is true, so toggle
      db.update('cameras', camera.id, { aiEnabled: newValue });
      pipelineManager.setAiEnabled(camera.id, newValue);

      res.json({ success: true, aiEnabled: newValue });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/:id/stream/start
   * Start the processing pipeline for a camera.
   */
  router.post('/:id/stream/start', async (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      await pipelineManager.startCamera(camera);
      res.json({ success: true, message: 'Pipeline started', cameraId: camera.id });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/cameras/:id/stream/stop
   * Stop the processing pipeline for a camera.
   */
  router.post('/:id/stream/stop', async (req, res) => {
    try {
      const camera = db.findOne('cameras', { id: req.params.id });
      if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

      await pipelineManager.stopCamera(camera.id);
      res.json({ success: true, message: 'Pipeline stopped', cameraId: camera.id });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = camerasRouter;
// Attached as a property (not a default-export change) so require('./api/cameras')
// still works as a bare factory function for index.js's existing usage, while
// tests can also reach the pure decision function directly (no live server needed).
module.exports.resolveProbeChannelsDecision = resolveProbeChannelsDecision;
