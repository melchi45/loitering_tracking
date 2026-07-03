# Design — Dashboard Channel Slot

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Global Channel Slot Mapping for Cameras / YouTube Streams
**Version:** 1.15
**Date:** 2026-07-02

---

## 1. Overview

Adds a persistent, globally-unique `channelSlot` (1..`MAX_CHANNEL_NUM`) to every camera/YouTube-stream record, distinct from the existing NVR sub-channel `channelIndex`. The Streaming Dashboard grid renders by `channelSlot` instead of array order. The Add/Edit UI gains a dual channel-picker (stepper + group browser) and, for SUNAPI/ONVIF multi-channel sources, an NVR-channel switcher that also works post-add via persisted per-channel RTSP URLs.

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                         Node.js Server                                  │
│                                                                          │
│  server/.env: MAX_CHANNEL_NUM=512                                       │
│       │                                                                 │
│       ▼                                                                 │
│  services/channelSlotService.js                                         │
│    ├─ getMaxChannelNum()                                                │
│    ├─ validateChannelSlot(db, slot, excludeId?) → { ok, error? }        │
│    └─ backfillChannelSlots(db)  ← called once from db/index.js initDB() │
│                                                                          │
│  api/cameras.js                                                         │
│    ├─ POST /api/cameras   → validateChannelSlot() before insert         │
│    └─ PUT  /api/cameras/:id → validateChannelSlot() before update       │
│                                (now also accepts channelIndex)          │
│                                                                          │
│  services/discoveryService.js (SUNAPI)        }  already compute        │
│  services/onvifDiscovery.js   (ONVIF)         }  MaxChannel/profiles;   │
│    → client now persists these via POST body  }  no server change      │
│      (nvrProfiles generated client-side for      needed to the          │
│       SUNAPI via channelRtspUrl(), copied         discovery scan itself │
│       directly from resolved ONVIF profiles)                            │
│                                                                          │
│  routes/... GET /health → { ..., maxChannelNum }                        │
└──────────────────────────────┬───────────────────────────────────────┘
                                │ HTTP
┌──────────────────────────────▼───────────────────────────────────────┐
│                          React Client                                  │
│                                                                          │
│  components/ChannelSlotPicker.tsx  (new, shared)                        │
│    ├─ Stepper: [-][value][+]                                            │
│    └─ Group browser: </> paged grid of slot buttons (free/taken/sel.)   │
│                                                                          │
│  components/CameraList.tsx        → Add modal, RTSP + YouTube tabs      │
│  components/CameraEditModal.tsx   → Edit modal + NVR channel switch     │
│  components/DiscoveredCameraPanel.tsx → unchanged NVR add-flow,         │
│                                          now also builds nvrProfiles[]  │
│                                                                          │
│  components/CameraGrid.tsx        → renders by channelSlot lookup       │
│  App.tsx                          → channelOffset reinterpreted as      │
│                                       channel-group offset               │
│                                                                          │
│  stores/cameraStore.ts            → unchanged (shallow-merge updateCamera │
│                                       already sufficient)                │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Model

### 3.1 Camera record — new/changed fields

```javascript
{
  // ...existing fields unchanged...
  channelIndex: number | null,     // EXISTING — NVR physical sub-channel, 1-based, add-time only until now

  // NEW:
  channelSlot:   number | null,    // 1..MAX_CHANNEL_NUM, globally unique, dashboard grid position
  maxChannel:    number | null,    // total physical channels on the source NVR (from discovery)
  supportSunapi: boolean,          // true if discovered via SUNAPI (affects fallback RTSP resolution)
  nvrProfiles:   Array<{ channelIndex: number, rtspUrl: string }> | null,
                                    // per-channel RTSP URLs resolved at discovery/add-time;
                                    // used by Edit-screen NVR channel switch (FR-CH-042) —
                                    // avoids any live re-query of the device (no ONVIF auth wired)
}
```

`nvrProfiles` is populated at add-time only, two ways:
- **SUNAPI**: client generates one entry per channel `1..maxChannel` via `channelRtspUrl(baseRtspUrl, ch)` (deterministic regex substitution — no network call)
- **ONVIF**: client copies `{ channelIndex, rtspUrl }` directly from the already-resolved `profiles[]` array in the discovery response (server already calls `GetStreamUri` for each profile during `enrichDevice()`)

### 3.2 constants.js

No new DB table — `channelSlot` etc. live on the existing `cameras` table row (schemaless JSON/Mongo). No change to `ALL_TABLES`/`TABLE_ROW_CAPS`.

---

## 4. Backend Design

### 4.1 `services/channelSlotService.js` (new file)

```javascript
const MAX_CHANNEL_NUM_DEFAULT = 512;

function getMaxChannelNum() {
  const n = parseInt(process.env.MAX_CHANNEL_NUM, 10);
  return Number.isInteger(n) && n > 0 ? n : MAX_CHANNEL_NUM_DEFAULT;
}

/** Validates range + uniqueness. excludeId lets a camera's own PUT resubmit its current slot. */
function validateChannelSlot(db, channelSlot, excludeId = null) {
  const max = getMaxChannelNum();
  if (!Number.isInteger(channelSlot) || channelSlot < 1 || channelSlot > max) {
    return { ok: false, status: 400, error: `channelSlot must be between 1 and ${max}` };
  }
  const conflict = db.all('cameras').find(
    c => c.channelSlot === channelSlot && c.id !== excludeId
  );
  if (conflict) {
    return { ok: false, status: 409, error: `Channel slot ${channelSlot} is already assigned to camera "${conflict.name}"` };
  }
  return { ok: true };
}

/** Backfill: assign lowest free slot to any camera missing channelSlot, ascending createdAt order. Idempotent. */
function backfillChannelSlots(db) {
  const max = getMaxChannelNum();
  const cameras = db.all('cameras').sort((a, b) =>
    new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
  const used = new Set(cameras.filter(c => c.channelSlot != null).map(c => c.channelSlot));
  let next = 1;
  for (const cam of cameras) {
    if (cam.channelSlot != null) continue;
    while (used.has(next) && next <= max) next++;
    if (next > max) {
      console.warn(`[channelSlotService] No free channel slot for camera "${cam.name}" (${cam.id}) — MAX_CHANNEL_NUM=${max} exhausted`);
      continue;
    }
    db.update('cameras', cam.id, { channelSlot: next });
    used.add(next);
  }
}

/** Lowest free slot right now — used both by backfill and by POST /api/cameras
 *  when the request omits channelSlot entirely (API-level backward compatibility). */
function nextFreeChannelSlot(db) {
  const max = getMaxChannelNum();
  const used = new Set(db.all('cameras').filter(c => c.channelSlot != null).map(c => c.channelSlot));
  for (let slot = 1; slot <= max; slot++) if (!used.has(slot)) return slot;
  return null; // exhausted — validateChannelSlot() will reject null as out-of-range
}

module.exports = { getMaxChannelNum, validateChannelSlot, backfillChannelSlots, nextFreeChannelSlot };
```

### 4.2 `api/cameras.js` — POST handler (extended)

```javascript
const { validateChannelSlot, nextFreeChannelSlot } = require('../services/channelSlotService');

router.post('/', async (req, res) => {
  // ...existing name/rtspUrl/normalizeRtspUrl validation unchanged...
  const { channelIndex, maxChannel, supportSunapi, nvrProfiles } = req.body;
  let { channelSlot } = req.body;

  // Omitted channelSlot ⇒ auto-assign (backward compatible with pre-existing
  // integrations/tests that predate this feature, e.g. nvr_channel_discovery.test.js).
  // The Add Camera UI always sends an explicit value; this is an API-level fallback only.
  if (channelSlot === undefined) {
    channelSlot = nextFreeChannelSlot(db);
  }
  const check = validateChannelSlot(db, parseInt(channelSlot, 10));
  if (!check.ok) return res.status(check.status).json({ success: false, error: check.error });

  db.insert('cameras', {
    id, name, rtspUrl: normalizedRtsp.value,
    username, password, ip, mac, httpPort,
    channelIndex: channelIndex ? parseInt(channelIndex, 10) : null,
    channelSlot:  parseInt(channelSlot, 10),
    maxChannel:   maxChannel ? parseInt(maxChannel, 10) : null,
    supportSunapi: !!supportSunapi,
    nvrProfiles:  Array.isArray(nvrProfiles) ? nvrProfiles : null,
    status: 'offline',
  });
  // ...unchanged response...
});
```

The YouTube creation path (`server/src/api/youtubeStreams.js`) receives the same `channelSlot` treatment — same validation call, same required field — since `channelSlot` is a property of the dashboard mapping, not of the RTSP/YouTube distinction.

### 4.3 `api/cameras.js` — PUT handler (extended)

```javascript
router.put('/:id', async (req, res) => {
  const camera = db.findOne('cameras', { id: req.params.id });
  if (!camera) return res.status(404).json({ success: false, error: 'Camera not found' });

  const { name, rtspUrl, username, password, webrtcEnabled, channelSlot, channelIndex } = req.body;
  // ...existing rtspUrl normalization unchanged...

  if (channelSlot !== undefined) {
    const check = validateChannelSlot(db, parseInt(channelSlot, 10), camera.id);
    if (!check.ok) return res.status(check.status).json({ success: false, error: check.error });
  }

  const updates = { /* ...existing fields... */ };
  if (channelSlot  !== undefined) updates.channelSlot  = parseInt(channelSlot, 10);
  if (channelIndex !== undefined) updates.channelIndex = parseInt(channelIndex, 10);

  db.update('cameras', camera.id, updates);
  // ...unchanged response/restart logic — channelSlot/channelIndex changes do NOT
  //    set needsRestart; only rtspUrl/webrtcEnabled/credentials do (channelIndex
  //    changes ARE expected to arrive together with a new rtspUrl in the same PUT,
  //    which already triggers needsRestart via the existing rtspUrl comparison)...
});
```

### 4.4 Startup migration wiring — `server/src/db/index.js`

```javascript
// After the DB backend is initialized and LEGACY_MIGRATIONS have run:
const { backfillChannelSlots } = require('../services/channelSlotService');
backfillChannelSlots(db);
```

Runs synchronously before `initDB()` resolves, so no camera-management API request can race the migration (NFR-CH-03).

### 4.5 `GET /health` extension

```javascript
// server/src/index.js (or wherever /health is defined)
const { getMaxChannelNum } = require('./services/channelSlotService');

app.get('/health', (req, res) => {
  res.json({ ...existingFields, maxChannelNum: getMaxChannelNum() });
});
```

### 4.6 `POST /api/cameras/probe-channels` (new, 2026-07-02)

Added after the initial ship because both the manual "Add Camera" form and editing a pre-existing camera have no discovery-scan data to draw on — the discovery-only NVR channel UI (§4.2's `channelIndex`/`maxChannel`/`nvrProfiles` fields) was reachable only via `DiscoveredCameraPanel.tsx`. This endpoint lets either screen trigger a one-off, single-IP probe on demand.

```javascript
// api/cameras.js
const { querySunapiMaxChannel } = require('../services/discoveryService');
const { enrichDevice }          = require('../services/onvifDiscovery'); // now exported
const { channelRtspUrl }        = require('../utils/channelRtsp');       // server-side twin of the client util

const PROBE_TIMEOUT_MS = 8000;
function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise(r => setTimeout(() => r(fallback), ms))]);
}

router.post('/probe-channels', async (req, res) => {
  const { ip, httpPort, httpType, onvifPort, username, password, baseRtspUrl } = req.body;
  if (!ip) return res.status(400).json({ success: false, error: 'ip is required' });

  const [sunapiMax, onvifResult] = await Promise.all([
    withTimeout(querySunapiMaxChannel(ip, httpPort, httpType, PROBE_TIMEOUT_MS / 2, username, password), PROBE_TIMEOUT_MS, 1),
    withTimeout(enrichDevice(ip, `http://${ip}:${onvifPort || 80}/onvif/device_service`), PROBE_TIMEOUT_MS, null),
  ]);

  // ONVIF preferred when it has verified per-channel RTSP URLs (GetStreamUri);
  // SUNAPI's URLs are a synthesized guess (channelRtspUrl() path substitution).
  const onvifProfiles = (onvifResult?.profiles || []).filter(p => p.rtspUrl);
  if ((onvifResult?.MaxChannel || 1) > 1 && onvifProfiles.length > 0) {
    return res.json({ success: true, maxChannel: onvifResult.MaxChannel, supportSunapi: false,
      protocol: 'onvif', profiles: onvifProfiles.map(p => ({ channelIndex: p.channelIndex, rtspUrl: p.rtspUrl })) });
  }
  if (sunapiMax > 1) {
    const profiles = baseRtspUrl
      ? Array.from({ length: sunapiMax }, (_, i) => i + 1).map(ch => ({ channelIndex: ch, rtspUrl: channelRtspUrl(baseRtspUrl, ch) }))
      : [];
    return res.json({ success: true, maxChannel: sunapiMax, supportSunapi: true, protocol: 'sunapi', profiles });
  }
  res.json({ success: true, maxChannel: 1, supportSunapi: false, protocol: 'none', profiles: [] });
});
```

**Why `enrichDevice(ip, guessedXAddr)` instead of a full WS-Discovery round-trip**: WS-Discovery is a multicast broadcast that finds *all* devices on the subnet and cannot be targeted at one IP. Most ONVIF devices (Hanwha, Axis, Dahua, Hikvision) respond at the conventional `/onvif/device_service` path regardless of how their XAddr was originally discovered, so guessing that path for a known IP works in practice without needing a scan. This reuses `enrichDevice()` completely unchanged — same best-effort behavior as the full discovery flow, including (2026-07-03, FR-CAM-090) the HTTP Basic→Digest fallback when credentials are available; still no SOAP-level WS-Security auth (see §7 Limitations).

**Why independent per-protocol timeouts**: `enrichDevice()` makes up to ~19 sequential SOAP calls (`GetDeviceInformation`, `GetCapabilities`, `GetProfiles`, up to 16× `GetStreamUri`), each with its own 4s cap inside `onvifDiscovery.js` — for a fully unresponsive device this could otherwise take over a minute before the HTTP response returns, unacceptable for a synchronous "click to detect" button. `withTimeout()` bounds the whole ONVIF attempt (and, separately, the whole SUNAPI attempt) to `PROBE_TIMEOUT_MS` (8s) each, run in parallel via `Promise.all`, so the endpoint's worst case is ~8s, not minutes.

**PUT /api/cameras/:id also gained `maxChannel`/`supportSunapi`/`nvrProfiles`** (§4.3) so a Re-detect result from the Edit modal can be persisted — previously these three fields were insert-only.

### 4.6a DEBUG-level discovery logging (2026-07-02, FR-CH-063)

`querySunapiMaxChannel()` and `enrichDevice()` fail *silently* by design — a single unreachable protocol falls back to `1`/best-effort partial data rather than rejecting the whole probe (§4.6's "why independent per-protocol timeouts" rationale extends to failure handling too). That's correct behavior for the response the client sees, but it left no way to answer "why did Detect Channels/Re-detect find nothing" — was it the wrong port, rejected auth, a timeout, or a genuinely single-channel device? All four collapse to the same `{ maxChannel: 1, protocol: 'none' }` shape client-side (§5.4a already covers the client-rendering half of this ambiguity; this section covers the server-observability half).

Fix: `console.debug()` calls added at each decision point, gated by the existing production logger (`utils/logger.js`) — a no-op unless `LOG_LEVEL=DEBUG`, so default-configuration log volume is unaffected even though this same code fires from the background WS-Discovery scan (`ONVIFDiscovery` class), not just on-demand probes.

```javascript
// services/discoveryService.js — one line per SUNAPI path attempted
console.debug(`[Discovery][SUNAPI] querying ${scheme}://${ip}:${port} auth=${authHeader ? 'yes' : 'no'} timeoutMs=${timeoutMs}`);
// ...per path: console.debug(`[Discovery][SUNAPI] ${ip} ${path} → HTTP ${res.statusCode}, MaxChannel=${parsed || '(not reported)'}`);
//              console.debug(`[Discovery][SUNAPI] ${ip} ${path} → timeout after ${timeoutMs}ms`);
//              console.debug(`[Discovery][SUNAPI] ${ip} ${path} → connection error: ${err.message}`);

// services/onvifDiscovery.js — one line per SOAP call inside enrichDevice()
console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} — starting probe at ${xaddr}`);
// ...GetDeviceInformation / GetCapabilities / GetProfiles / GetStreamUri: success or `catch (err) { console.debug(...) }`
console.debug(`[ONVIFDiscovery][enrichDevice] ${ip} result → MaxChannel=${result.MaxChannel}, profiles=${result.profiles.length} (${resolvedUriCount} with resolved RTSP URI)`);

// api/cameras.js — request/decision bookends around the Promise.all in §4.6
console.debug(`[cameras][probe-channels] request ip=${ip} httpPort=${httpPort || '(default)'} httpType=${httpType ? 'https' : 'http'} onvifPort=${onvifPort || 80} auth=${username ? 'yes' : 'no'}`);
console.debug(`[cameras][probe-channels] ip=${ip} SUNAPI maxChannel=${sunapiMax}; ONVIF maxChannel=${onvifMax}, profiles-with-rtsp=${onvifProfiles.length}`);
console.debug(`[cameras][probe-channels] ip=${ip} decision → protocol=${protocol}, maxChannel=${maxChannel}, profiles=${profiles.length}`);
```

**Credential handling**: only whether `username`/`password` were supplied is logged (`auth=yes|no`), never the values — same rule as the existing "no RTSP URL credentials in logs" security rule (CLAUDE.md 보안 규칙), extended here to the SUNAPI Basic-Auth header used by `querySunapiMaxChannel()`.

**Why `console.debug()` and not `console.log()` with a `[DEBUG]` string tag**: `utils/logger.js`'s production `patchConsole()` maps `console.debug` directly to DEBUG-level output (gated by `LEVELS.DEBUG < MIN_LEVEL`); `console.log` is always INFO regardless of message content unless it happens to match one of the ffmpeg/yt-dlp `DEBUG_DOWNGRADE_PATTERNS`. Using the dedicated function is the only way to get real level-gating rather than relying on incidental keyword matching.

**All three UI entry points share this logging** since they all call the same `POST /api/cameras/probe-channels` (Add modal's "Detect Channels" §5.3, Edit modal's "Re-detect" §5.4, Found-tab panel's "Re-detect" §5.2a) — no per-caller distinction is logged beyond the request parameters each sends (e.g. the Found-tab panel supplies `username`/`password` from the original scan per §5.2a, the Add-tab now supplies discovery-sourced `httpPort`/`httpType` per §5.3a fix).

### 4.6b Skip the SUNAPI probe for an added camera with no resolvable password (2026-07-02, FR-CH-064)

§4.6a's DEBUG logging surfaced something an operator hadn't been able to see before: repeated `[Discovery][SUNAPI] ... connection error: connect ECONNREFUSED ip:80` lines every time "Re-detect" was clicked against a specific camera — one that was added with no username/password on file at all. `querySunapiMaxChannel()` was still being invoked unconditionally on every probe, regardless of whether the caller had any way to authenticate — for a camera whose own DB record already says "no password," that network attempt is a guaranteed failure known in advance, not a genuine unknown worth trying.

**Fix, scoped narrowly**: the credential gate only fires when the request carries a `cameraId` — i.e., only for `CameraEditModal.tsx`'s "Re-detect," the one caller re-probing a specific *already-added* camera whose DB record is the authoritative source of "does this device have a password." Requests with no `cameraId` (Add modal's "Detect Channels" against a fresh, not-yet-added IP; the Found-tab panel's "Re-detect") are **not gated** — those callers have no DB record to consult, and FR-CH-045's original design intentionally tries an unauthenticated SUNAPI request in that case since some devices do respond without auth (TC-CH-F-003 tests exactly this and would break if the gate applied unconditionally).

```javascript
// api/cameras.js — inside POST /probe-channels, before the Promise.all
const camera = cameraId ? db.findOne('cameras', { id: cameraId }) : null;
const effectiveUsername = username || camera?.username || '';
const effectivePassword = password || camera?.password || process.env.RTSP_DEFAULT_PASSWORD || '';
const canAuthSunapi = !!(effectiveUsername && effectivePassword);

// Only gate when re-probing a *specific* already-added camera (cameraId present) —
// a fresh IP with no DB record keeps the original best-effort unauthenticated attempt.
const skipSunapi = !!cameraId && !canAuthSunapi;

const sunapiPromise = skipSunapi
  ? Promise.resolve(1)
  : withTimeout(querySunapiMaxChannel(ip, httpPort, httpType, PROBE_TIMEOUT_MS / 2, effectiveUsername, effectivePassword), PROBE_TIMEOUT_MS, 1);
```

**Why the camera's password can't come from the client directly**: `GET /api/cameras` and `GET /api/cameras/:id` both strip `password` from every response (`password: undefined` — see §4.2/`api/cameras.js` list/get handlers), so `CameraEditModal.tsx` never has the value to send even if it wanted to. `CameraEditModal.tsx`'s `handleRedetectChannels()` (§5.4) now sends `cameraId: camera.id` instead, and the server resolves the actual stored credentials itself via `db.findOne('cameras', { id: cameraId })` — the password value is used in-process for the SUNAPI HTTP request and never round-trips back to the client.

**Interaction with `RTSP_DEFAULT_PASSWORD`** (the site-wide default credential env var, `docs/srs/SRS_Camera_Discovery.md`): a camera relying on that env var instead of its own per-camera `password` field is *not* affected by the gate — `effectivePassword` resolves from the env var, `canAuthSunapi` is true, and the probe proceeds exactly as before. The gate only fires when literally no password is resolvable from any of the three sources.

### 4.6c Same credential gate for the background/manual discovery scan (2026-07-02, BR-10 / `discoveryService.js`, `streamHandler.js`)

§4.6b's fix only touches `POST /api/cameras/probe-channels` (the Detect/Re-detect buttons). A second, independent call site had the identical unguarded pattern: `discoveryService.js`'s `_runScan()` (the automatic background WS-Discovery + UDP scan) and `streamHandler.js`'s Socket.IO-triggered manual rescan handler both called `querySunapiMaxChannel()` unconditionally for every device reporting `SupportSunapi`, regardless of whether any credential was configured anywhere — on auth-required firmware, a guaranteed-failure network round-trip per device per scan cycle (not just per button click).

This call site can't use §4.6b's per-camera `cameraId` lookup — these devices are freshly *discovered*, not yet added, so there is no `cameras` DB record to consult. The applicable credential source here is a *site-wide* one instead: `RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD` (the same env vars `querySunapiMaxChannel()`'s own default parameters already fall back to — see `docs/srs/SRS_Camera_Discovery.md`).

```javascript
// services/discoveryService.js
function hasConfiguredSunapiCredentials() {
  return !!(process.env.RTSP_DEFAULT_USERNAME && process.env.RTSP_DEFAULT_PASSWORD);
}
module.exports = { getDiscoveryService, mapUDPDevice, querySunapiMaxChannel, hasConfiguredSunapiCredentials };

// _runScan()'s udp.on('device', ...) handler:
// Primary source: mapUDPDevice() derives MaxChannel from the UDP binary response itself
// (no network round-trip). Secondary/fallback: the CGI query, now double-gated —
// only when the primary source didn't already find MaxChannel > 1, AND only when
// real credentials are configured.
if (device.SupportSunapi && device.MaxChannel <= 1 && hasConfiguredSunapiCredentials()) {
  const maxCh = await querySunapiMaxChannel(device.IPAddress, device.HttpPort, device.HttpType);
  // ...
}
```

```javascript
// socket/streamHandler.js — the Socket.IO-triggered manual "rescan" handler had
// the exact same unguarded call; fixed identically (same condition, same import
// of hasConfiguredSunapiCredentials from discoveryService.js):
if (device.SupportSunapi && device.MaxChannel <= 1 && hasConfiguredSunapiCredentials()) {
  const maxCh = await querySunapiMaxChannel(device.IPAddress, device.HttpPort, device.HttpType);
  // ...
}
```

**`mapUDPDevice()`'s `MaxChannel` field — forward-compatible placeholder**: ideally `MaxChannel` would be read directly out of the UDP discovery binary response (genuinely zero network round-trips, not just zero *unauthenticated* ones), matching how `HttpPort`/`HttpType`/etc. are already parsed from that same response (§ "WiseNet/Hanwha UDP Discovery" in the `camera-stream-setup` skill). This was investigated but not completed in this pass — the current binary parser (`submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js` and the inline `utils/udpDiscovery.js` fallback) stops decoding at byte 333 and doesn't expose a channel-count field; the two single-byte `Reserved2`/`Reserved3` gaps in that range are candidates, but confirming the real offset requires the SUNAPI IP Installer protocol spec (not available in this environment). `mapUDPDevice()` is written forward-compatible in the meantime — `MaxChannel: raw.MaxChannel > 1 ? raw.MaxChannel : 1` — so wiring in the real field later is a one-line parser change; until then, the gated CGI fallback above (§4.6c) remains the only automatic multi-channel detection path, and it correctly does nothing when no site-wide credentials are configured.

### 4.6d probe-channels reuses a cached UDP Discovery result before querying SUNAPI CGI (2026-07-02, FR-CH-065)

Raised in code review: `sunapiMax` in §4.6's handler comes from `querySunapiMaxChannel()` — an HTTP CGI query targeted at one known IP — which is a **completely separate mechanism** from the UDP Discovery broadcast scan (`discoveryService.js`'s `_runScan()`/`mapUDPDevice()`). `probe-channels` never consulted the scan's own cached results even when the exact IP had already been found by it, so Detect/Re-detect would always pay for a fresh CGI round-trip (and, per §4.6b, sometimes skip it and just report single-channel) even when the answer was already sitting in the discovery service's in-memory cache.

**Fix**: `DiscoveryService` gains a synchronous, no-I/O lookup:

```javascript
// services/discoveryService.js
getByIp(ip) {
  const key = this._ipIndex.get(ip);
  return key ? (this._known.get(key) ?? null) : null;
}
```

`POST /api/cameras/probe-channels` calls it before deciding whether to run the CGI query at all:

```javascript
// api/cameras.js
const discoverySvc = getDiscoveryService();  // no `io` arg — reuses the existing
                                              // singleton if the scan is already running;
                                              // returns null if discovery was never started
const knownDevice  = discoverySvc ? discoverySvc.getByIp(ip) : null;
const cachedMaxChannel = (knownDevice?.SupportSunapi && (knownDevice.MaxChannel || 1) > 1)
  ? knownDevice.MaxChannel
  : null;

if (cachedMaxChannel) {
  sunapiPromise = Promise.resolve(cachedMaxChannel);   // no network call at all
} else if (skipSunapi) {                                // §4.6b's credential gate
  sunapiPromise = Promise.resolve(1);
} else {
  sunapiPromise = withTimeout(querySunapiMaxChannel(...), PROBE_TIMEOUT_MS, 1);
}
```

**Precedence**: the cache check runs *before* §4.6b's credential gate — a cache hit needs no credentials at all (the scan already established the channel count), whereas the credential gate only matters once we've fallen through to actually calling `querySunapiMaxChannel()`. The rest of the handler (ONVIF preference, profile synthesis from `baseRtspUrl`) is unchanged — `sunapiMax` simply arrives pre-resolved instead of freshly queried.

**Scope note**: this only covers the SUNAPI side. `enrichDevice()` (ONVIF SOAP) still runs fresh on every `probe-channels` call even when `knownDevice.profiles` might already have usable data — left as-is since the reported issue was specifically about `sunapiMax`; reusing cached ONVIF profiles too would be a natural follow-up but changes the ONVIF-preferred-over-SUNAPI precedence logic (§4.6, FR-CH-047) and wasn't requested.

**Why this doesn't regress FR-CH-045's "no discovery scan required" guarantee**: `probe-channels` still works with zero prior scanning — `getDiscoveryService()` returns `null` (or a singleton with an empty cache) when no scan has ever run, in which case `knownDevice` is `null` and behavior is identical to before this change (falls straight through to the CGI query / credential gate).

---

### 4.6e Edit modal's "Re-detect" forwards unsaved form credentials, not just the DB record (2026-07-02)

§4.6b's `skipSunapi` gate reads the camera's *persisted* `username`/`password` via `cameraId` lookup — correct for a camera whose credentials are already saved, but it produced a confusing dead end for the opposite case: an operator opens `CameraEditModal.tsx` on a camera added with no credentials on file, types a `username`/`password` into the RTSP form fields, then clicks "Re-detect" *before* clicking "Save." The DB record still has no password at that point (Save hasn't run yet), so the gate fires exactly as designed and the probe is skipped — but from the operator's point of view they *just entered* the correct credentials and the server is (apparently) still saying "no username/password on file." The debug log (§4.6a) is technically accurate but the UX reads as broken.

**Fix**: `handleRedetectChannels()` (`CameraEditModal.tsx`) now also sends the RTSP form's current `username`/`password` state in the request body, in addition to `cameraId`:

```typescript
// CameraEditModal.tsx — handleRedetectChannels()
body: JSON.stringify({
  ip,
  httpPort:    camera.httpPort || undefined,
  baseRtspUrl: camera.rtspUrl,
  // Forward whatever's typed into the form this session — covers editing
  // credentials and clicking Re-detect before Save. Falsy ('') falls back
  // to the DB record server-side, so this is safe to send unconditionally.
  username:    rtspForm.username || undefined,
  password:    rtspForm.password || undefined,
  cameraId:    camera.id,
}),
```

No server-side change was needed: §4.6's handler already resolves credentials as `username || camera?.username` / `password || camera?.password`, i.e. request-body values take priority over the `cameraId`-looked-up DB record. Sending the form fields unconditionally is safe — an untouched field is `''` (falsy), which correctly falls through to the persisted camera record exactly as before this fix.

**Remaining, intentional limitation**: this only helps within the *current* modal session. If the operator types credentials, clicks Re-detect (now works), but closes the modal without clicking Save, nothing is persisted — the next time the modal is opened, `rtspForm.username`/`password` reset to `''` (§5.4's form only ever initializes them blank, since `GET /api/cameras` never returns the stored password) and the DB-record gate applies again until Save is clicked. This is consistent with the rest of the Edit form's "stage then save" pattern (§5.4) and was not considered a defect.

### 4.6f Per-protocol MaxChannel — `SunapiMaxChannel`/`OnvifMaxChannel` tracked separately from the merged value (2026-07-02, FR-CH-066)

> Requested directly: "Dashboard의 우측 카메라 FOUND 정보에 SUNAPI의 정보에서 MaxChannel 정보를 표시해줘" (show SUNAPI's own MaxChannel info in the Found panel). The existing `{MaxChannel} CH` badge (§5.2a) already displayed a channel count once `> 1`, but that value is the *merged* result of `mergeDevices()`'s `Math.max(sunapi, onvif)` — there was no way to see what each protocol individually reported, which matters for diagnosing e.g. a device where ONVIF resolves real per-channel RTSP URLs (`GetStreamUri`) but SUNAPI only synthesizes them via path substitution (§4.6, `channelRtspUrl()`), or vice versa.

Every code path that determines a channel count now also records it under a protocol-specific field name, alongside (not replacing) the existing merged `MaxChannel`:

```javascript
// services/discoveryService.js — mapUDPDevice()
SunapiMaxChannel: supportSunapi ? (raw.MaxChannel > 1 ? raw.MaxChannel : 1) : undefined,

// services/discoveryService.js — _runScan()'s UDP handler, on a successful
// CGI fallback query (same fix applied to streamHandler.js's manual rescan):
if (maxCh > 1) {
  device.MaxChannel = maxCh;
  device.SunapiMaxChannel = maxCh;   // NEW
  ...
}

// services/discoveryService.js — mergeDevices(): each protocol's field is its
// own independent Math.max(), never cross-contaminated (only that protocol's
// own code path ever sets it):
const sunapiCh = Math.max(existing.SunapiMaxChannel || 0, incoming.SunapiMaxChannel || 0);
if (sunapiCh > 0) merged.SunapiMaxChannel = sunapiCh;
const onvifCh = Math.max(existing.OnvifMaxChannel || 0, incoming.OnvifMaxChannel || 0);
if (onvifCh > 0) merged.OnvifMaxChannel = onvifCh;

// services/onvifDiscovery.js — enrichDevice()
result.MaxChannel = sourceTokenOrder.size > 0 ? sourceTokenOrder.size : 1;
result.OnvifMaxChannel = result.MaxChannel;   // NEW — alias, protocol-specific name
```

`POST /api/cameras/probe-channels` (§4.6) now also returns `sunapiMaxChannel` (a number — the SUNAPI probe's own count) and `onvifMaxChannel` (a number, or `null` specifically when the ONVIF probe never got a response at all, vs. a genuine single-channel result) alongside the existing `maxChannel`/`protocol`/`profiles` response shape, which is unchanged for backward compatibility:

```javascript
res.json({
  success: true, maxChannel, supportSunapi, protocol, profiles,
  sunapiMaxChannel: sunapiMax,
  onvifMaxChannel: onvifResult ? onvifMax : null,
});
```

`enrichDevice()` never throws (every SOAP step is independently try/caught — see §"XML helpers" and the function body), so `onvifResult` is `null` here only via the `withTimeout()` wrapper's timeout fallback (§4.6's `PROBE_TIMEOUT_MS`), not from a rejected promise — a genuinely-reached-but-uncooperative ONVIF device still resolves to a valid (if mostly-empty) result object with `OnvifMaxChannel: 1`.

See §5.2b for the client display of these two new fields.

### 4.6g `querySunapiMaxChannel()` now supports HTTP Digest auth, not just Basic (2026-07-02, BR-11)

**Symptom**: probing a real camera (192.168.214.32, correct `admin`/`<password>` credentials verified independently — camera's own web UI login accepted them) still logged `[Discovery][SUNAPI] ... → HTTP 401 (auth rejected)` on every attempt, indistinguishable from a genuinely wrong password.

**Root cause**: `querySunapiMaxChannel()` only ever sent `Authorization: Basic base64(user:pass)`. This device's SUNAPI CGI is fronted by nginx and responds to *any* request with `WWW-Authenticate: Digest qop="auth", realm="iPolis_...", nonce="..."` — it does not accept Basic auth at all, so the request 401s before the password is even checked against that scheme. Confirmed independently with `curl --digest -u admin:<password> http://<ip>/stw-cgi/attributes.cgi/attributes` → `HTTP 200`, `MaxChannel=2`. This is a known, fairly common embedded-HTTP-server pattern (RFC 7616) — not specific to this one device; any SUNAPI firmware built the same way was silently reported as single-channel/no-response by every caller of this function (on-demand probe-channels, background/manual discovery scan).

**Fix**: `querySunapiMaxChannel()` (`discoveryService.js`) still tries Basic first (one round-trip, no regression for firmware that does accept it) — but now, on a 401/403 whose `WWW-Authenticate` header advertises `Digest`, it computes an RFC 7616 Digest response (`buildDigestAuthHeader()`, MD5, `qop=auth` when offered) and retries once with the computed `Authorization: Digest ...` header, before giving up:

```javascript
// services/discoveryService.js
if ((res.statusCode === 401 || res.statusCode === 403) && username && password) {
  const challenge = res.headers['www-authenticate'] || '';
  if (/^Digest\s/i.test(challenge)) {
    const digestHeader = buildDigestAuthHeader(challenge, 'GET', path, username, password);
    const res2 = await sunapiRequest(proto, ip, port, path, timeoutMs, {
      Accept: 'application/xml, text/xml, */*',
      Authorization: digestHeader,
    });
    if (res2.statusCode === 200) return parseSunapiMaxChannel(ip, path, res2.statusCode, res2.body);
    // still 401 on the Digest retry → genuinely bad credentials, not a scheme mismatch
  }
}
```

A camera that rejects a truly wrong password still 401s the Digest retry too — this only removes the false negative for the *scheme* mismatch, it does not weaken the credential check. HTTP request/response handling was refactored into two small helpers (`sunapiRequest()`, `parseSunapiMaxChannel()`) shared by both the Basic and Digest attempts, replacing the single inline `new Promise()` — behavior for the no-credentials and Basic-accepted paths is unchanged.

**Verification**: `test/api/probe_camera_maxchannel.js` (new diagnostic script, not part of the automated TC-ID suite — requires a real reachable camera) exercises `querySunapiMaxChannel()`/`enrichDevice()` directly against a live device with no server/DB required. Run against 192.168.214.32 before this fix: `HTTP 401 (auth rejected)`, `maxChannel=1`. After: `HTTP 401, Basic rejected — retrying with Digest` → `HTTP 200, MaxChannel=2` → `protocol=sunapi maxChannel=2`.

**Follow-on fix, same session — self-signed TLS certificate rejected on the HTTPS SUNAPI path**: probing a second camera (192.168.214.37, `--https` since its HTTP:80 redirects to HTTPS:443 via nginx) surfaced a related but distinct failure: `connection error: self-signed certificate`. `sunapiRequest()`'s `https.get()` call used Node's default TLS validation, which rejects the self-signed certificate that on-prem IP cameras/NVRs almost universally ship with — this has nothing to do with FR-CH-067's Digest fix above, it's a separate transport-layer problem that only manifests for cameras whose SUNAPI web UI is HTTPS-only. `onvifDiscovery.js`'s own HTTPS SOAP client already sets `rejectUnauthorized: false` for exactly this reason (line ~133, predates this session) — `sunapiRequest()` was simply missing the same option. Fix: added `rejectUnauthorized: false` to the request options in `sunapiRequest()`. After the fix, 192.168.214.37 resolved cleanly via Digest+HTTPS to `HTTP 200, MaxChannel=1` (a genuinely single-channel device — this camera's correct result, not a bug). This only affects transport trust (accepting the LAN device's self-signed cert); it does not skip authentication — Digest/Basic credential checks still apply on top.

**Scope note (updated 2026-07-03)**: at the time of this fix, ONVIF's `enrichDevice()`/`soapPost()` sent no auth at all, so the ONVIF branch's `AUTH_REQUIRED` failures on this device were expected, not evidence of a credential problem. FR-CAM-090 (Design_Camera_Discovery.md §3.1g) later wired the same Basic→Digest HTTP fallback into `soapPost()` — see §7's Limitations table entry, now scoped to the remaining SOAP-level WS-Security gap only.

### 4.6h `probe-channels` writes a corrected MaxChannel back into the discovery registry (2026-07-02, FR-CH-068)

**Motivating scenario, same device as §4.6g**: 192.168.214.32's background UDP scan reports `MaxChannel: 1` (the binary broadcast field isn't parsed yet — §4.6f's forward-compatible placeholder). §4.6f added "SUNAPI MaxCh"/"ONVIF MaxCh" rows to the Found-tab detail panel, and with §4.6g's Digest fix, clicking "Re-detect" against this device with its real credentials now correctly resolves `MaxChannel: 2` via `attributes.cgi` — but only the panel's own local `redetected` React state reflected it. Closing the panel, or just glancing at the compact sidebar list without opening it, still showed the stale `1CH` badge, because nothing wrote the correction back into `DiscoveryService`'s shared `_known` registry that the sidebar list (and the store `useDiscoveryStore`) actually reads from.

**Fix**: added `DiscoveryService.prototype.applyProbeResult(ip, patch)`:

```javascript
// services/discoveryService.js
applyProbeResult(ip, patch) {
  const key = this._ipIndex.get(ip);
  const existing = key ? this._known.get(key) : null;
  if (!existing) return null;   // nothing to correct — this only updates known entries

  const updated = { ...existing };
  if (patch.supportSunapi) updated.SupportSunapi = true;
  if (typeof patch.sunapiMaxChannel === 'number' && patch.sunapiMaxChannel > (existing.SunapiMaxChannel || 0))
    updated.SunapiMaxChannel = patch.sunapiMaxChannel;
  if (typeof patch.onvifMaxChannel === 'number' && patch.onvifMaxChannel > (existing.OnvifMaxChannel || 0))
    updated.OnvifMaxChannel = patch.onvifMaxChannel;
  if (typeof patch.maxChannel === 'number' && patch.maxChannel > (existing.MaxChannel || 1))
    updated.MaxChannel = patch.maxChannel;

  const unchanged = /* all four fields identical to existing */;
  if (unchanged) return null;   // avoid a spurious broadcast for a no-op probe

  this._known.set(key, updated);
  this._emit(updated);          // io.emit('discovery:result', { device: updated })
  return updated;
}
```

`POST /api/cameras/probe-channels` (`api/cameras.js`) calls this right before building its own JSON response, using the same `sunapiMax`/`onvifResult`/`maxChannel` values it already computed for §4.6f's response fields:

```javascript
if (discoverySvc) {
  discoverySvc.applyProbeResult(ip, {
    maxChannel,
    supportSunapi: sunapiMax > 1,
    sunapiMaxChannel: sunapiMax,
    onvifMaxChannel: onvifResult ? onvifMax : null,
  });
}
```

**Why "raise-only, never lower"**: mirrors `mergeDevices()`'s existing philosophy (§"Merge helpers") — a probe result *lower* than what's already known doesn't disprove the higher value (could be a flaky response, a temporary auth hiccup, or simply a less-capable protocol path this time), so it's silently ignored rather than regressing the registry. This also means `applyProbeResult()` never conflicts with FR-CH-065's cache-reuse check (§4.6d) — a cache hit already *is* the highest known value, so a subsequent probe (which would just re-confirm the same cached number) is a guaranteed no-op here, not a source of registry churn.

**Why this needed no client-side changes at all**: `App.tsx` passes `useDiscoveryStore`'s `selected` field as `DiscoveredCameraPanel`'s `camera` prop, and `CameraList.tsx`'s existing `discovery:result` socket handler already calls `addOrUpdate(data.device)` — which both appends/replaces the list entry *and* refreshes `selected` when the ids match (`discoveryStore.ts`'s `addOrUpdate`). So the `_emit()` above is all that's needed: the sidebar list badge and, if the panel happens to be open on that device, its "SUNAPI MaxCh"/"ONVIF MaxCh" rows (§5.2b) both pick up the correction automatically through the same pipe that already delivers live scan results — no new client code, no new socket event.

**Scope**: this applies uniformly to all three `probe-channels` callers (Add's "Detect Channels," Edit's "Re-detect," Found's "Re-detect") — whichever one happens to probe an IP the registry already knows about benefits every other client's view of that device, not just the one that ran the probe. It does not create new registry entries — an IP the scan has never seen has nothing to correct, and `probe-channels` remains usable standalone for such IPs exactly as before (§4.6).

### 4.6i `probe-channels` falls back to the registry's own MaxChannel when this request's live probes both find nothing (2026-07-02, FR-CH-069)

**Reported symptom**: "attributes.cgi 또는 ONVIF의 VideoSource를 검색하지 못한 경우 SUNAPI UDP Discovery의 MaxChannel을 사용해야 하는데 그렇지 않아 MaxChannel이 다시 1로 설정된다" — when a probe's live SUNAPI CGI query and ONVIF `GetVideoSources`/`GetProfiles` query both fail to determine a channel count on a given request, the response regressed to `maxChannel: 1, protocol: 'none'` even when the background/manual UDP Discovery scan had already established a higher count for that exact IP.

**Root cause**: §4.6's decision block only ever consulted *this request's own* live `sunapiMax`/`onvifMax` results — `knownDevice` (the same `DiscoveryService.getByIp(ip)` lookup §4.6d already uses) was read earlier in the handler only to compute `cachedMaxChannel` (§4.6d, gated on `SupportSunapi` and used to *skip* the live SUNAPI query *before* it runs), and separately by §4.6h to *write into* the registry *after* a successful probe — neither existing use covers "the live re-query for this one request came back empty, but the registry already has a better answer, so use that instead of reporting `1`." A transient auth failure, the wrong port, or (with §4.6g/FR-CAM-074's dual-scheme ONVIF trial) a scheme the device didn't happen to answer on this time would all silently discard a channel count the operator had already confirmed in an earlier session.

**Fix**: the entire `maxChannel`/`protocol`/`profiles` decision (§4.6's `if (onvifMax > 1 ...) else if (sunapiMax > 1 ...)` block) was extracted into a pure, exported function — `resolveProbeChannelsDecision({ onvifMax, onvifProfiles, sunapiMax, sunapiProfiles, knownDevice, baseRtspUrl })` (`api/cameras.js`) — with a third branch added:

```javascript
// api/cameras.js
function resolveProbeChannelsDecision({ onvifMax, onvifProfiles, sunapiMax, sunapiProfiles, knownDevice, baseRtspUrl }) {
  if (onvifMax > 1 && onvifProfiles.length > 0) { /* ONVIF wins — unchanged from §4.6 */ }
  if (sunapiMax > 1) { /* SUNAPI wins — unchanged from §4.6 */ }
  if ((knownDevice?.MaxChannel || 1) > 1) {
    // NEW: both live probes above found nothing this request, but the registry
    // already knows better — reuse it instead of falling through to 'none'.
    const maxChannel = knownDevice.MaxChannel;
    if (knownDevice.SupportSunapi) {
      // synthesize profiles via channelRtspUrl() against baseRtspUrl, same as
      // the live-SUNAPI-success path
    } else if (knownDevice.profiles?.some(p => p.rtspUrl)) {
      // reuse the registry's own cached ONVIF profiles directly
    } // else: bare count only, profiles: []
    return { maxChannel, protocol: knownDevice.SupportSunapi ? 'sunapi' : 'onvif', ... };
  }
  return { maxChannel: 1, protocol: 'none', profiles: [] }; // unchanged fallback
}
```

`router.post('/probe-channels', ...)` now just calls this function and logs a distinct debug line when the new branch fires (`usedRegistryFallback` flag in the return value).

**Precedence, and why this doesn't conflict with §4.6d/§4.6h**: §4.6d's `cachedMaxChannel` still runs *first*, before either live query — a `SupportSunapi`-flagged cache hit skips the live SUNAPI CGI call entirely, so `sunapiMax` is already the cached value by the time this new branch would even be considered (making it a no-op in that case, not a conflict). §4.6h's registry write-back still runs *after* this decision, using whatever `maxChannel`/`protocol` this function returned — if the new fallback branch fired, that just means the write-back is re-affirming a value the registry already had (a no-op per §4.6h's raise-only rule), not overwriting anything.

**Why a general fallback, not `SupportSunapi`-gated like §4.6d**: §4.6d's cache reuse is specifically "skip a redundant SUNAPI CGI round-trip when a SUNAPI-flagged scan already answered" — narrowly scoped to one protocol, before querying. This fallback is deliberately broader: it fires regardless of which protocol the *original* scan used to establish the count (SUNAPI or ONVIF), because from the operator's point of view the question is simply "does this on-demand probe's `maxChannel` result reflect everything already known about this device," not "did SUNAPI specifically re-confirm it."

**Verification**: extracting the decision into `resolveProbeChannelsDecision()` makes the new branch (and the three pre-existing branches) unit-testable without a live server — `test/api/channel_slot.test.js` TC-CH-F-013 (registry SUNAPI fallback + profile synthesis), TC-CH-F-013b (registry ONVIF-only fallback, reusing cached profiles), TC-CH-F-013c (no registry entry, or registry itself single-channel → unchanged `none` result), TC-CH-F-013d (a successful *live* probe still wins over the registry value — this fallback only fires when live results are genuinely empty, never overrides a working live answer).

## 5. Frontend Design

### 5.1 `types/index.ts` — `Camera` interface extension

```typescript
export interface Camera {
  // ...existing fields, PLUS previously-missing server fields now declared...
  channelIndex?:   number | null;
  channelSlot?:    number | null;
  maxChannel?:     number | null;
  supportSunapi?:  boolean;
  nvrProfiles?:    { channelIndex: number; rtspUrl: string }[] | null;
  httpPort?:       number | null;
  // (username/password intentionally NOT added — server never returns password,
  //  and username is write-only from the client's perspective for this feature)
}
```

### 5.2 `components/ChannelSlotPicker.tsx` (new, shared)

```typescript
interface ChannelSlotPickerProps {
  value:        number | null;
  onChange:     (slot: number) => void;
  maxChannelNum: number;             // from GET /health, cached in a small hook/store
  takenSlots:   Map<number, string>; // channelSlot → camera name, excludes the camera being edited
  pageSize?:    number;              // default: current dashboard layout's `channels`, else 16
}

export function ChannelSlotPicker({ value, onChange, maxChannelNum, takenSlots, pageSize = 16 }: ChannelSlotPickerProps) {
  const [page, setPage] = useState(() => Math.floor(((value ?? 1) - 1) / pageSize));
  const totalPages = Math.ceil(maxChannelNum / pageSize);
  const pageStart  = page * pageSize + 1;
  const pageEnd    = Math.min(pageStart + pageSize - 1, maxChannelNum);

  // Stepper — clamped increment/decrement, keeps `page` in sync when value moves out of view
  // Group grid — one button per slot in [pageStart, pageEnd], disabled if takenSlots.has(slot)
  // Both mutate the same `value` via onChange(slot)
}
```

Used by both `CameraList.tsx` (Add modal) and `CameraEditModal.tsx` (Edit modal). `takenSlots` is derived once from the `cameras` Zustand store (`Map` built via `useMemo`), filtering out the camera being edited when in Edit mode.

### 5.2a `DiscoveredCameraPanel.tsx` — "Re-detect" for already-discovered devices (2026-07-02)

The Found-tab discovery scan (UDP SUNAPI broadcast + ONVIF WS-Discovery, §2) already resolves `MaxChannel`/`SupportSunapi`/`profiles` for a device once, at scan time. This is a **different** code path from §4.6/§5.3's on-demand probe: the manual Add form has no discovery data to draw on at all, whereas here the panel is displaying a device the scan already found. "Re-detect" exists for when that scan result may be stale or incomplete (channel count changed since the scan, or the scan's best-effort SUNAPI/ONVIF query timed out) — it lets the operator force one fresh `POST /api/cameras/probe-channels` call before adding, without leaving the panel or re-running a full network scan.

```typescript
const [redetecting, setRedetecting]     = useState(false);
const [redetectError, setRedetectError] = useState('');
const [redetected, setRedetected]       = useState<ProbeChannelsResult | null>(null);

// "effective" values merge a fresh redetect() result over the scan's original fields —
// same pattern as CameraEditModal.tsx's effectiveMaxChannel (§5.4)
const effectiveMaxChannel    = redetected?.maxChannel ?? camera.MaxChannel ?? 1;
const effectiveSupportSunapi = redetected?.supportSunapi ?? camera.SupportSunapi ?? false;

const handleRedetectChannels = async () => {
  // POST /api/cameras/probe-channels — unlike the Add-tab probe, this call already knows
  // the device's httpPort/httpType/username/password from the discovery scan (camera.HttpPort,
  // camera.HttpType, camera.Username, camera.Password), so it doesn't hit the port-80/HTTP
  // default-guessing failure mode described in §5.3a.
  const res = await fetch('/api/cameras/probe-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ip: camera.IPAddress,
      httpPort: camera.HttpType ? camera.HttpsPort : camera.HttpPort,
      httpType: camera.HttpType,
      username: camera.Username,
      password: camera.Password,
      baseRtspUrl: camera.rtspUrl,
    }),
  });
  // ... setRedetected(result) on success; result.profiles take priority in resolveRtspUrl()
};
```

`resolveRtspUrl()` checks `redetected?.profiles` first, then falls back to the scan's original `camera.profiles`, then SUNAPI path-substitution — same three-tier resolution order as elsewhere in this feature, with the freshest data source given first priority. The "Re-detect" button sits next to the manual channel-count override input in the Channels row; a result message below it reports the outcome (`{protocol}CH confirmed` or `no multi-channel NVR found, scan result unchanged`), following the same three-way (not-yet-attempted / attempted-empty / attempted-populated) state pattern as §5.4a to avoid the "button does nothing" defect.

### 5.2b Per-protocol MaxChannel rows — "SUNAPI MaxCh" / "ONVIF MaxCh" (2026-07-02, FR-CH-066)

Two new rows in the Device info section, alongside the existing "SUNAPI: Yes/No" and "ONVIF: Yes/No" badges (server-side fields documented in §4.6f):

```typescript
const effectiveSunapiMaxChannel = redetected?.sunapiMaxChannel ?? camera.SunapiMaxChannel;
const effectiveOnvifMaxChannel  = redetected?.onvifMaxChannel  ?? camera.OnvifMaxChannel;
```

```tsx
<Row label="SUNAPI">     <Badge ok={!!camera.SupportSunapi} label="Yes" /></Row>
<Row label="SUNAPI MaxCh">{effectiveSunapiMaxChannel != null ? `${effectiveSunapiMaxChannel} CH` : 'not detected'}</Row>
<Row label="ONVIF">       <Badge ok={!!camera.SupportOnvif} label="Yes" /></Row>
<Row label="ONVIF MaxCh"> {effectiveOnvifMaxChannel != null ? `${effectiveOnvifMaxChannel} CH` : 'not detected'}</Row>
```

Unlike the existing merged `{effectiveMaxChannel} CH` badge (§5.2a) — which is conditionally rendered only when `> 1` — these two rows are **always** rendered, showing the literal text "not detected" when the corresponding field is `undefined`/`null` rather than disappearing. This distinguishes "this protocol was never queried, or queried and got no response" from "queried and confirmed genuinely single-channel" (`1 CH`), a distinction the pre-existing conditional badge couldn't make (both cases rendered nothing).

Since `redetected` (a fresh `POST /api/cameras/probe-channels` result, §5.2a) is checked first, clicking "Re-detect" updates both rows live in the same panel session, same as the existing `effectiveMaxChannel`/`effectiveSupportSunapi` pattern — no additional wiring needed beyond reading the two new response fields.

### 5.3 `CameraList.tsx` — Add modal integration

- New `channelSlot` state in the add-camera form, initialized via a `useEffect` that computes the lowest free slot from `cameras` once the modal opens
- `<ChannelSlotPicker>` rendered in both RTSP and YouTube tabs (shared state — the value carries over if the operator switches tabs before submitting)
- On submit, `channelSlot` included in the `POST /api/cameras` (or `POST /api/streams/youtube`) body; a `409`/`400` response is caught and shown as an inline error banner in the modal, matching the existing error-banner pattern already used for RTSP validation errors
- **RTSP tab only** — "Detect Channels" button (2026-07-02): parses `new URL(form.rtspUrl).hostname` and calls `POST /api/cameras/probe-channels` with that IP plus the entered Username/Password. A `maxChannel > 1` result renders a `CH 1..maxChannel` button grid (same visual pattern as `DiscoveredCameraPanel.tsx`); selecting a channel updates `form.rtspUrl` to the resolved per-channel URL when the response includes one. The detection result (`maxChannel`, `supportSunapi`, `profiles`) is included in the `POST /api/cameras` body so a manually-added camera ends up with the same NVR metadata as one added via discovery.

### 5.3a Bug fix — "Detect Channels" reported single-channel despite a successful prior UDP SUNAPI Discovery (2026-07-02)

**Symptom**: an operator ran UDP SUNAPI Discovery (Found tab), confirming the device supports SUNAPI with a multi-channel NVR, then manually pasted the same camera's RTSP URL into the Add Camera form (RTSP tab) and clicked "Detect Channels" — it always reported "No multi-channel NVR detected — single-channel camera," and asked why the probe re-runs discovery at all instead of reusing the already-known result.

**Root cause**: `handleDetectChannels()` only ever sent `{ ip, username, password, baseRtspUrl }` to `POST /api/cameras/probe-channels` — it never forwarded `httpPort`/`httpType`. Server-side, `querySunapiMaxChannel()` (`discoveryService.js`) defaults to port 80/HTTP whenever `httpPort`/`httpType` are omitted (§4.6). If the camera's actual SUNAPI web port differs from 80 or is HTTPS-only — information the UDP discovery scan for the exact same IP already captured (`DiscoveredCamera.HttpPort`/`HttpsPort`/`HttpType`) — the SUNAPI query silently fails (`querySunapiMaxChannel` returns `1` on any connection/timeout/auth error, no exception surfaced) and the ONVIF branch's guessed `device_service` XAddr on the wrong port fails the same way. The two "detection" paths (Found-tab discovery vs. manual Add-tab probe) were fully independent; probe-channels never consulted the already-collected discovery data for a matching IP.

**Fix**: `handleDetectChannels()` (`CameraList.tsx`) now looks up a matching entry in the discovery store (`discovered.find(d => d.IPAddress === ip)`) before calling probe-channels, and — when found — forwards its `HttpPort`/`HttpsPort` (whichever applies per `HttpType`), `HttpType`, and stored `Username`/`Password` (used as fallback when the Add form's own credential fields are blank):
```typescript
const known = discovered.find((d) => d.IPAddress === ip);
const knownHttpPort = known ? (known.HttpType ? known.HttpsPort : known.HttpPort) : undefined;
// → probe-channels body: { ip, httpPort: knownHttpPort, httpType: known?.HttpType, username: form.username || known?.Username, ... }
```
This does not change `POST /api/cameras/probe-channels` itself — it remains usable standalone for IPs with no prior discovery (per §4.6's original intent) — it only stops the Add-tab probe from throwing away port/scheme information the client already has for a known IP.

**Known remaining gap**: `Camera.httpType` is not persisted (only `httpPort`), so `CameraEditModal.tsx`'s "Re-detect" (§5.4) still cannot recall whether a saved camera's SUNAPI port is HTTP or HTTPS — it always probes HTTP. Fixing this requires adding an `httpType` column end-to-end (db schema, `POST/PUT /api/cameras`, `DiscoveredCameraPanel.tsx`'s add payload) and is left as a follow-up.

### 5.4 `CameraEditModal.tsx` — Edit integration

- `<ChannelSlotPicker>` pre-populated from `camera.channelSlot`
- "NVR Channel" section — **always rendered** (2026-07-02 revision), not gated on `camera.maxChannel`, so it can offer detection even for cameras with no persisted NVR metadata:
  ```typescript
  // profiles/supportSunapi/baseRtspUrl are parameters (not read off `camera` directly)
  // so the same function works for persisted data AND a fresh redetect result:
  function resolveNvrChannelRtsp(
    profiles: NvrProfile[] | null | undefined, supportSunapi: boolean,
    baseRtspUrl: string, targetChannel: number,
  ): string | null {
    const fromProfile = profiles?.find(p => p.channelIndex === targetChannel);
    if (fromProfile) return fromProfile.rtspUrl;
    if (supportSunapi && baseRtspUrl) {
      const substituted = channelRtspUrl(baseRtspUrl, targetChannel); // shared util, see 5.6
      return substituted !== baseRtspUrl ? substituted : null;        // null ⇒ could not resolve
    }
    return null;
  }

  // "effective" values merge a fresh redetect() result over the camera's persisted fields:
  const effectiveMaxChannel    = redetected?.maxChannel ?? camera.maxChannel ?? 1;
  const effectiveProfiles      = redetected?.profiles ?? camera.nvrProfiles ?? null;
  const effectiveSupportSunapi = redetected?.supportSunapi ?? camera.supportSunapi ?? false;
  const hasNvrChannels = !isYoutube && effectiveMaxChannel > 1;
  ```
  Buttons `CH 1..effectiveMaxChannel`; a button whose `resolveNvrChannelRtsp()` returns `null` is rendered disabled with a tooltip ("RTSP could not be resolved for this channel"). Selecting a resolvable channel updates local form state (`channelIndex`, `rtspUrl` preview) but does not PATCH until the modal's Save is pressed, consistent with the rest of the Edit form's "stage then save" pattern.
- **"Re-detect" button** (always visible, next to the NVR Channel heading): calls `POST /api/cameras/probe-channels` using the IP parsed from the RTSP form's current `rtspUrl` field value (falling back to `camera.ip`/`camera.rtspUrl` only when the form field is empty or unparseable — since 2026-07-02, §5.4b), `camera.httpPort`, `cameraId: camera.id` (2026-07-02, FR-CH-064), and — since 2026-07-02, §4.6e — the RTSP form's current `username`/`password` field values. `cameraId` lets the server resolve the camera's own *persisted* `username`/`password` for the SUNAPI probe server-side when the form fields are blank, since the client never has the stored password value (§4.6b); the form-field values (when non-blank) take priority over that DB lookup, so credentials typed but not yet saved this session can still be used for the probe (§4.6e). A successful result populates `redetected` state, which immediately flows into `effectiveMaxChannel`/`effectiveProfiles`/`effectiveSupportSunapi` above — the channel grid appears in the same modal session, no reopen needed. `redetected` (if set) is included in the `PUT /api/cameras/:id` body on Save (`maxChannel`, `supportSunapi`, `nvrProfiles`); if the operator never clicks Re-detect, these three fields are omitted from the PUT and the camera's existing persisted values are left untouched.

### 5.4a Bug fix — Re-detect appeared to do nothing (2026-07-02, FR-CH-049a)

**Symptom**: an operator clicked "Re-detect" against a camera with no persisted NVR data and reported no visible change — "clicking the button does nothing."

**Root cause**: the render logic only had two branches:
```typescript
// BEFORE — buggy
{!hasNvrChannels && !redetectError && (
  <p>No NVR channel data yet — click Re-detect to query SUNAPI/ONVIF for this camera's IP.</p>
)}
{hasNvrChannels && ( /* channel button grid */ )}
```
`hasNvrChannels` is `effectiveMaxChannel > 1`. When a Re-detect request completes successfully but reports `maxChannel: 1` (device unreachable → `protocol: 'none'`, single-channel camera, or an ONVIF NVR behind authentication this client cannot pass — see §7), `hasNvrChannels` stays `false` and `redetectError` stays empty (the request *succeeded*, it just found nothing) — so the exact same "click Re-detect..." prompt renders both **before** the first click and **after** a completed-but-empty detection. Nothing in the DOM changes, which is indistinguishable from the click handler not firing at all.

**Fix**: split the "no channels" case into two, keyed off whether `redetected` (the in-session probe result, distinct from `null`/never-set) exists:
```typescript
// AFTER — fixed
{!hasNvrChannels && !redetectError && !redetected && (
  <p>No NVR channel data yet — click Re-detect to query SUNAPI/ONVIF for this camera's IP.</p>
)}
{!hasNvrChannels && !redetectError && redetected && (
  <p>Re-detect ran ({redetected.protocol === 'none' ? 'no SUNAPI/ONVIF response' : redetected.protocol.toUpperCase()}) —
     single-channel or no multi-channel NVR found at this camera's IP.</p>
)}
{hasNvrChannels && ( /* channel button grid, unchanged */ )}
```
This is a pure client-side rendering fix — `handleRedetectChannels()` and the `POST /api/cameras/probe-channels` request/response cycle were already correct; the request was firing and returning a valid result the whole time, it just had no rendering path for "succeeded with an empty result."

**General lesson** (see also `react-dashboard-dev` skill): any async action button whose result can legitimately be empty needs a three-way state (not-yet-attempted / attempted-and-empty / attempted-and-populated), not a two-way boolean gate — a two-way gate makes "empty result" and "not yet tried" render identically, which reads as "broken" to the user.

### 5.4b Bug fix — Re-detect ignored the unsaved RTSP URL/IP edit in the form (2026-07-02)

**Symptom**: an operator edits the "RTSP URL" field in `CameraEditModal.tsx` (e.g. correcting a wrong IP or port) and clicks "Re-detect" *before* Save — the probe still queries the camera's old, persisted address, not the one just typed in.

**Root cause**: `handleRedetectChannels()` derived both the probe `ip` and the `baseRtspUrl` request field from `camera.ip`/`camera.rtspUrl` (the saved camera record), never from `rtspForm.rtspUrl` (the live, possibly-edited form field). §4.6e (above) had already fixed this same class of bug for `username`/`password` — those two fields were wired to `rtspForm` — but the RTSP URL field itself was missed, so "Re-detect should test the full set of unsaved changes" only actually covered credentials, not the address.

**Fix**: derive `ip` by parsing the hostname out of `rtspForm.rtspUrl.trim() || camera.rtspUrl` first, falling back to the persisted `camera.ip` only if that parse fails (empty/invalid URL); `baseRtspUrl` sent to the server is the same resolved value, not `camera.rtspUrl` directly:
```typescript
// AFTER — fixed
const currentRtspUrl = rtspForm.rtspUrl.trim() || camera.rtspUrl;
let ip = '';
try { ip = new URL(currentRtspUrl).hostname; } catch { /* fall through to camera.ip */ }
if (!ip) ip = camera.ip || '';
// ...
body: JSON.stringify({ ip, httpPort: camera.httpPort || undefined, baseRtspUrl: currentRtspUrl, ... })
```
`camera.httpPort` is left as-is — the Edit modal has no separate editable HTTP-port field (SUNAPI probing port is not exposed in this form), so there is no unsaved value to prefer there.

**General lesson**: when a "stage then save" form has an on-demand test/probe action (Re-detect, validate, dry-run), every field the probe reads must come from the live form state, not the entity's persisted snapshot — wiring only *some* of the edited fields (as §4.6e did for credentials) leaves the button silently testing a stale mix of old and new values, which is easy to miss because the request still succeeds, it just answers the wrong question.

### 5.5 `CameraGrid.tsx` — channel-slot-keyed rendering

Replaces the three raw array-index reads (equal-grid cell, featured-layout main cells, featured-layout sub cells) with a single shared lookup built once per render:

```typescript
const camerasBySlot = useMemo(() => {
  const m = new Map<number, Camera>();
  for (const c of cameras) if (c.channelSlot != null) m.set(c.channelSlot, c);
  return m;
}, [cameras]);

// groupStart replaces startIndex: it is (channelGroup * pageSize), 0-based arithmetic
// over 1-based channelSlot values, e.g. group 1 (0-indexed) with pageSize=16 covers
// channelSlot 17..32 → groupStart = 16, cell idx 0 shows channelSlot 17 (groupStart+idx+1)

// Equal-grid cell:
const cam = camerasBySlot.get(groupStart + idx + 1) ?? null;
// cam === null → render <EmptyChannelCell slot={groupStart + idx + 1} />

// Featured layout main/sub cells: same lookup, same groupStart+offset arithmetic,
// contiguous across main+sub within the current group (main cells first, as before)
```

`EmptyChannelCell` is a new small presentational component: dashed border, channel number, "Unassigned" label — visually distinct from `CameraView`'s existing offline-camera state (which still shows the camera name/last-seen info).

### 5.6 `channelRtspUrl()` — promoted to a shared util

Formerly a private function inside `DiscoveredCameraPanel.tsx`. Moved to `client/src/utils/channelRtsp.ts` so `DiscoveredCameraPanel.tsx`, `CameraEditModal.tsx` (§5.4), and `CameraList.tsx` (§5.3, error tooltip logic) import the same implementation. A **server-side twin** (`server/src/utils/channelRtsp.js`, identical logic, kept in sync manually) exists for `POST /api/cameras/probe-channels` (§4.6), which needs to synthesize SUNAPI per-channel URLs server-side before returning them to the client. No behavior change from the pre-existing function — pure relocation plus one intentional duplication across the client/server boundary.

### 5.7 `App.tsx` — channel-group paging

```typescript
// Was: channelOffset (array offset into `cameras`), clamped to cameras.length
// Now: channelGroup (0-based group index over 1..maxChannelNum), clamped to totalGroups

const pageSize    = LAYOUT_DEFS.find(d => d.id === layout)!.channels;
const maxChannelNum = useHealthConfig().maxChannelNum;   // from GET /health, see 5.8
const totalGroups = Math.ceil(maxChannelNum / pageSize);
const [channelGroup, setChannelGroup] = useState(0);

const groupStart = channelGroup * pageSize;   // passed to <CameraGrid groupStart={groupStart} />
const canPrev = channelGroup > 0;
const canNext = channelGroup < totalGroups - 1;
// Desktop < > buttons and mobile swipe both mutate channelGroup, clamped to [0, totalGroups-1]
// Label: `Channel Group ${channelGroup + 1} of ${totalGroups} (CH ${groupStart + 1}–${Math.min(groupStart + pageSize, maxChannelNum)})`
```

`CameraGrid`'s `startIndex` prop is renamed `groupStart` (breaking rename, both call sites in `App.tsx` updated in the same change) to make the semantic shift from "array offset" to "channel-space offset" explicit in the codebase, not just in comments.

### 5.8 `maxChannelNum` availability on the client

Added to the same `GET /health` fetch `App.tsx` already performs on mount for `serverMode` (`App.tsx:636-647` per prior research) — one extra field read off the same response, no new request. Exposed via a tiny derived value passed down as a prop (no new Zustand store needed; it is set once at startup and does not change during a session, matching how `serverMode` itself is already handled).

---

## 6. Migration & Rollout Sequencing

1. Server-side `channelSlotService.js` + `POST`/`PUT` validation + `GET /health` field ship together
2. `backfillChannelSlots()` wired into `db/index.js` startup — runs automatically on next deploy, before any camera API traffic is accepted
3. Client changes (picker, grid rendering, App.tsx paging) ship in the same release as the server changes — a client build older than the server would still work for viewing (grid falls back to legacy array order only if `channelSlot` is entirely absent from the API response shape, which cannot happen post-migration) but would not have the picker UI; there is no supported mixed-version deployment for this feature, consistent with how this monorepo ships client+server together

---

## 7. Limitations

| Limitation | Rationale |
|---|---|
| `POST /api/cameras/probe-channels`'s ONVIF probe still sends no SOAP-level WS-Security (`wsse:UsernameToken`) authentication | `onvifDiscovery.js` `soapPost()` now tries HTTP Basic and retries with HTTP Digest when challenged (2026-07-03, FR-CAM-090/Design_Camera_Discovery.md §3.1g), using the same `effectiveUsername`/`effectivePassword` the SUNAPI probe already resolves — this covers devices that gate their ONVIF endpoint at the HTTP layer (e.g. an nginx front-end). A device that instead requires a `wsse:UsernameToken`/`PasswordDigest` element inside the SOAP `<s:Header>` itself (ONVIF's own spec-native auth scheme) is unaffected — `enrichDevice()` still swallows that failure and returns `MaxChannel: 1`. Implementing WS-Security is a separate, larger gap, still out of scope here |
| Edit-screen channel switching (both persisted `nvrProfiles` and a fresh Re-detect) never issues a live per-click device query | Selecting a channel button always resolves from already-known data (`nvrProfiles` array or path-substitution) — this is intentional (§4.6's rationale: bounding worst-case latency to one Re-detect click, not one query per channel button click) |
| ONVIF's guessed `/onvif/device_service` XAddr is a convention, not a guarantee | A minority of ONVIF devices expose their device service at a non-standard path; for those, `POST /api/cameras/probe-channels` falls through to the SUNAPI branch (or reports `protocol: 'none'`) even though the device may in fact be ONVIF-capable |
| `channelSlot` gaps are never auto-compacted | Channel Slot is a stable identity (like a physical BNC port number), not a dense array index — this is intentional, not a limitation to "fix" |
| Lowering `MAX_CHANNEL_NUM` below in-use slots does not retroactively unassign them | Avoids silently breaking an operator's existing dashboard layout from a config change alone |
| No bulk/CSV channel assignment | Out of scope per RFP §"Out of Scope" |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-02 | 초기 작성 |
| 1.1 | 2026-07-02 | §4.6 `POST /api/cameras/probe-channels` 신규 추가 (SUNAPI+ONVIF 즉시 감지, per-protocol 타임박스), §5.3/5.4 수동 Add "Detect Channels"·Edit "Re-detect" 버튼 반영, §5.6 서버측 channelRtsp.js 트윈 명시, §7 제한사항 갱신 |
| 1.2 | 2026-07-02 | §5.4a 추가 — Re-detect가 무반응처럼 보이던 버그의 근본원인·수정 내용 기록 (2-way 게이트 → 3-way 상태 전환) |
| 1.3 | 2026-07-02 | §5.3a 추가 — Add 모달 "Detect Channels"가 UDP SUNAPI Discovery로 이미 확보한 httpPort/httpType을 재사용하지 않고 기본값(80/HTTP)으로 blind 재탐지하다 조용히 실패하던 버그 기록 및 수정 (discoveryStore IP 매칭으로 재사용) |
| 1.4 | 2026-07-02 | §5.2a 신규 추가 — `DiscoveredCameraPanel.tsx`의 기 구현된 "Re-detect" 기능(코드 주석이 참조하던 미작성 섹션)을 문서화, §4.6/§5.3의 Add-tab 온디맨드 probe와의 차이 명시 |
| 1.5 | 2026-07-02 | §4.6a 신규 추가 — probe-channels가 SUNAPI/ONVIF discovery 데이터를 DEBUG 레벨로 로그하도록 추가 (FR-CH-063), 자격증명 비노출 원칙 명시 |
| 1.6 | 2026-07-02 | §4.6b 신규 추가 — cameraId 있는 요청(Edit Re-detect)에 한해 카메라 레코드에 비밀번호가 없으면 SUNAPI probe 자체를 생략 (FR-CH-064), §5.4에 cameraId 파라미터 반영 |
| 1.7 | 2026-07-02 | §4.6c 신규 추가 — 백그라운드/수동 rescan(discoveryService.js·streamHandler.js)의 SUNAPI CGI 조회도 동일한 자격증명 게이팅 적용 (FR-CH-040a/040b, BR-10), UDP 바이너리 파싱 미완 사유 기록 |
| 1.8 | 2026-07-02 | §4.6d 신규 추가 — probe-channels가 SUNAPI CGI 쿼리 전에 UDP Discovery 캐시(`DiscoveryService.getByIp()`)를 먼저 확인하도록 수정 (FR-CH-065) — sunapiMax가 실제로는 UDP Discovery 결과가 아니라는 코드 리뷰 지적에서 시작 |
| 1.9 | 2026-07-02 | §4.6e 신규 추가 — Edit 모달 "Re-detect"가 저장 전 폼에 입력된 username/password도 probe-channels 요청에 함께 전송하도록 수정 (기존엔 cameraId만 보내 DB에 저장된 credential만 사용 가능 — Save 전 재탐지 시 "no username/password on file"이 계속 표시되던 문제), §5.4 Re-detect 서술 갱신 |
| 1.10 | 2026-07-02 | §4.6f/§5.2b 신규 추가 — SUNAPI/ONVIF 각 프로토콜의 MaxChannel을 병합된 값과 별개로 추적·노출 (`SunapiMaxChannel`/`OnvifMaxChannel` 필드, probe-channels 응답 확장, Found 상세 패널에 항상 표시되는 두 행) (FR-CH-066) — Found 패널에 SUNAPI MaxChannel을 표시해 달라는 요청에 따라 도입 |
| 1.11 | 2026-07-02 | §4.6g 신규 추가 — `querySunapiMaxChannel()`가 HTTP Basic 인증만 지원해 Digest 인증을 요구하는 SUNAPI 펌웨어(nginx 기반 iPolis 등)에서 정상 자격증명도 계속 401로 거부되던 버그 수정 (BR-11) — 실 카메라(192.168.214.32)로 검증한 `curl --digest` 결과 자격증명 자체는 정상이었음이 확인되어 원인 특정, RFC 7616 Digest(qop=auth) 응답 계산·재시도 추가. 신규 진단 스크립트 `test/api/probe_camera_maxchannel.js` 추가 |
| 1.12 | 2026-07-02 | §4.6g에 후속 수정 추가 — 두 번째 실 카메라(192.168.214.37, HTTPS-only SUNAPI)로 검증 중 `self-signed certificate` 오류 발견, `sunapiRequest()`에 `rejectUnauthorized: false` 누락(`onvifDiscovery.js`는 동일 사유로 이미 적용돼 있었음)이 원인임을 특정해 수정 |
| 1.13 | 2026-07-02 | §5.4b 신규 추가 — Edit 모달 "Re-detect"가 저장 전 RTSP URL/IP 수정은 반영하지 않고 여전히 카메라의 저장된 주소로 probe하던 버그 수정 (§4.6e는 username/password만 폼 값을 사용하도록 고쳤고 RTSP URL 필드는 누락돼 있었음) — `handleRedetectChannels()`가 `rtspForm.rtspUrl`에서 IP를 파싱하도록 변경, §5.4 Re-detect 서술 갱신 |
| 1.14 | 2026-07-02 | §4.6h 신규 추가 — probe-channels 결과가 discovery 레지스트리 값보다 높으면 `DiscoveryService.applyProbeResult()`로 레지스트리를 갱신하고 discovery:result 재브로드캐스트 (FR-CH-068) — UDP=1/attributes.cgi=2로 확인된 실 카메라(192.168.214.32)에서 Re-detect 정정이 패널을 닫으면 사라지던 문제 수정, 클라이언트 코드 변경 불필요(기존 addOrUpdate() 소켓 파이프 재사용) |
| 1.15 | 2026-07-02 | §4.6i 신규 추가 — probe-channels가 이번 요청의 라이브 SUNAPI+ONVIF 쿼리 모두 실패했을 때 discovery 레지스트리에 이미 알려진 MaxChannel로 폴백해야 함 (FR-CH-069) — attributes.cgi/GetVideoSources를 못 찾으면 MaxChannel이 다시 1로 되돌아가던 문제 리포트로 도입. 결정 로직을 `resolveProbeChannelsDecision()`(순수 함수)으로 추출해 `test/api/channel_slot.test.js` TC-CH-F-013~013d로 자동화 |
