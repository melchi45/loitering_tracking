# DESIGN DOCUMENT
# Camera Discovery & Network Search Subsystem

| | |
|---|---|
| **Document ID** | DESIGN-LTS-CAM-01 |
| **Version** | 1.15 |
| **Status** | Active |
| **Date** | 2026-07-03 |
| **Parent SRS** | srs/SRS_Camera_Discovery.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Server-Side Design](#3-server-side-design)
4. [Data Model](#4-data-model)
5. [API Design](#5-api-design)
6. [Sequence Diagrams](#6-sequence-diagrams)
7. [Configuration & Environment](#7-configuration--environment)
8. [Error Handling](#8-error-handling)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                    LAN (Broadcast / Multicast)                    │
│                                                                    │
│   Hanwha/WiseNet cameras   ONVIF cameras (any vendor)            │
│        │ UDP :7711                  │ UDP :3702                  │
└────────┼───────────────────────────┼───────────────────────────-─┘
         │                           │
┌────────▼───────────────────────────▼───────────────────────────-─┐
│                         Server (Node.js)                          │
│                                                                    │
│  DiscoveryService (singleton)                                     │
│   ├─ UDPDiscovery (WiseNet)                                       │
│   │   ├─ send broadcast 255.255.255.255:7701 (magic packet)       │
│   │   ├─ listen :7711 (responses)                                 │
│   │   └─ emit 'device' events → mapUDPDevice() → DeviceInfo       │
│   │                                                                │
│   ├─ ONVIFDiscovery                                               │
│   │   ├─ send SOAP Probe 239.255.255.250:3702 (multicast)         │
│   │   ├─ receive ProbeMatch responses                             │
│   │   ├─ emit basic DeviceInfo immediately                        │
│   │   └─ enrichDevice() async:                                    │
│   │       GetDeviceInformation → GetCapabilities →                │
│   │       GetVideoSources → GetProfiles → GetStreamUri (up to 16) │
│   │                                                                │
│   ├─ _known: Map<deviceKey, DeviceInfo>   (registry)             │
│   ├─ _ipIndex: Map<IP, deviceKey>         (cross-protocol dedup)  │
│   ├─ _upsert(device) → mergeDevices()                            │
│   └─ _emit() → io.emit('discovery:result', { device })           │
│                                                                    │
│  Socket.IO                                                         │
│   ├─ emit 'discovery:result'  { device }                         │
│   ├─ emit 'discovery:scanning' { scanning, count }               │
│   ├─ emit 'discovery:cleared' {}                                  │
│   └─ emit 'discovery:error'  { message }                         │
│                                                                    │
│  REST API (camerasRouter)                                         │
│   ├─ POST /api/cameras/discover   → emit discovery:trigger        │
│   ├─ GET  /api/cameras            → list all cameras              │
│   ├─ POST /api/cameras            → add camera                   │
│   ├─ GET  /api/cameras/:id        → get camera                   │
│   ├─ PUT  /api/cameras/:id        → update + restart              │
│   ├─ DELETE /api/cameras/:id      → remove + stop pipeline        │
│   └─ POST /api/cameras/:id/stream/* → pipeline control           │
└───────────────────────────────────────────────────────────────────┘
                         │
┌────────────────────────▼──────────────────────────────────────────┐
│                  CLIENT (React + Socket.IO)                        │
│  DiscoveredCameraPanel.tsx                                        │
│   ├─ listen 'discovery:result'    → add/update device list        │
│   ├─ listen 'discovery:scanning'  → update scan status badge      │
│   └─ listen 'discovery:cleared'   → clear device list            │
│  discoveryStore.ts                                                 │
│   └─ Zustand store: devices[], scanning, count                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── api/
│   │   │   └── cameras.js                 # REST router for /api/cameras
│   │   ├── services/
│   │   │   ├── discoveryService.js        # DiscoveryService orchestrator
│   │   │   └── onvifDiscovery.js          # ONVIFDiscovery class
│   │   └── utils/
│   │       └── udpDiscovery.js            # getUDPDiscovery() loader
│   └── submodules/
│       └── WiseNetChromeIPInstaller/
│           └── nodejs/
│               └── udpDiscovery.js        # WiseNet UDP discovery driver
│
├── client/
│   └── src/
│       ├── components/
│       │   └── DiscoveredCameraPanel.tsx  # Discovery results UI panel
│       └── stores/
│           └── discoveryStore.ts          # Zustand: devices, scanning state
│
├── docs/
│   ├── prd/PRD_Camera_Discovery.md
│   ├── rfp/RFP_Camera_Discovery.md
│   ├── srs/SRS_Camera_Discovery.md
│   ├── design/Design_Camera_Discovery.md  ← this file
│   └── tc/TC_Camera_Discovery.md
│
└── test/
    └── api/
        └── camera_discovery.test.js
```

---

## 3. Server-Side Design

### 3.1 DiscoveryService (`server/src/services/discoveryService.js`)

**Responsibilities:**
- Orchestrate concurrent WiseNet UDP and ONVIF WS-Discovery scans
- Maintain the unified device registry
- Push events to all connected Socket.IO clients
- Provide `hydrate(socket)` for new client connections

**Key constants:**

| Constant | Value | Purpose |
|---|---|---|
| `SCAN_TIMEOUT` | 10000 ms | Duration of each scan window |
| `SCAN_INTERVAL` | 15000 ms | Pause between scan cycles |

**State fields:**

| Field | Type | Purpose |
|---|---|---|
| `_io` | Socket.IO server | Broadcast target |
| `_timer` | Timeout or null | Inter-scan pause timer |
| `_udpDisc` | UDPDiscovery or null | Active UDP discovery instance |
| `_onvifDisc` | ONVIFDiscovery or null | Active ONVIF discovery instance |
| `_known` | `Map<string, DeviceInfo>` | Unified device registry (key = `deviceKey(device)`) |
| `_ipIndex` | `Map<string, string>` | IP → deviceKey index for cross-protocol dedup |
| `_scanning` | boolean | True while at least one protocol is running |
| `_pendingDone` | number | Countdown: 2 at scan start; reaches 0 when both protocols done |

**Key methods:**

| Method | Signature | Description |
|---|---|---|
| `start()` | `() → void` | Begin first scan cycle |
| `stop()` | `() → void` | Stop all discovery; clear timers |
| `rescan()` | `() → void` | Clear registry + emit `discovery:cleared` + restart |
| `hydrate(socket)` | `(Socket) → void` | Replay `_known` to newly connected client |
| `_runScan()` | `() → void` | Start both UDP and ONVIF concurrently |
| `_upsert(device)` | `(DeviceInfo) → DeviceInfo` | Merge into registry; return merged entry |
| `_emit(device)` | `(DeviceInfo) → void` | `io.emit('discovery:result', { device })` |
| `_onProtocolDone()` | `() → void` | Decrement `_pendingDone`; schedule next scan when both done |

**`_upsert()` logic:**

```
Given incoming device:
  1. Compute key = deviceKey(device)
  2. Look up _ipIndex.get(device.IPAddress) → existingKeyByIp
  3. If existingKeyByIp exists AND ≠ key:
       a. Get existing = _known.get(existingKeyByIp)
       b. merged = mergeDevices(existing, incoming)
       c. _known.set(existingKeyByIp, merged)        ← use original key
       d. _ipIndex.set(IP, existingKeyByIp)           ← update IP index
       e. Return merged
  4. Else:
       a. prev = _known.get(key) (may be undefined)
       b. merged = prev ? mergeDevices(prev, incoming) : incoming
       c. _known.set(key, merged)
       d. _ipIndex.set(IP, key)
       e. Return merged
```

**`mergeDevices()` rules:**

```javascript
// Source badge
if (existing.source !== incoming.source) merged.source = 'both';

// Fill empty string fields only
for key in ['Model','Manufacturer','MACAddress','FirmwareVersion',
            'SerialNumber','Gateway','SubnetMask','URL']:
  if (!merged[key] && incoming[key]) merged[key] = incoming[key];

// rtspUrl: incoming wins unless it's the bare fallback
fallback = `rtsp://${incoming.IPAddress}:554/`;
if (incoming.rtspUrl && (incoming.rtspUrl !== fallback || !merged.rtspUrl))
  merged.rtspUrl = incoming.rtspUrl;

// Capabilities: OR
if (incoming.SupportSunapi) merged.SupportSunapi = true;
if (incoming.SupportOnvif)  merged.SupportOnvif  = true;

// Profiles: take longer list
if (incoming.profiles?.length > merged.profiles?.length)
  merged.profiles = incoming.profiles;

// MaxChannel: take the larger value from either protocol
merged.MaxChannel = Math.max(existing.MaxChannel || 1, incoming.MaxChannel || 1);
```

**MaxChannel enrichment flow:**

1. **ONVIF NVR**: `enrichDevice()` derives `MaxChannel` from `GetVideoSources` (2026-07-02, FR-CAM-075 — see §3.2's "GetVideoSources" note below), falling back to the distinct-`SourceToken` count from `GetProfiles` (FR-CAM-060) when `GetVideoSources` is unavailable. `profiles.length` alone is never used (would over-count single-channel cameras exposing separate main/sub profiles).
2. **WiseNet UDP NVR**: After `mapUDPDevice()` (MaxChannel=1 default), `querySunapiMaxChannel()` is called asynchronously (2 s timeout):
   - Queries `GET /stw-cgi/attributes.cgi/attributes` (2026-07-02: corrected — `media.cgi?msubmenu=channellist` and `system.cgi?msubmenu=systeminfo` are not real SUNAPI CGI paths and never returned data) → response is XML; parses the `value` attribute at `<group name="System"><category name="Limit"><attribute name="MaxChannel" .../>` (matches the vendor SUNAPI IP Installer's own `System/Limit/MaxChannel` query path — see `submodules/WiseNetChromeIPInstaller/media/ump/Network/http/attributes.js`)
   - **SUNAPI Digest auth** (2026-07-02, FR-CAM-072): the initial request always tries HTTP Basic first (or no `Authorization` header at all, if no credentials are configured). Some SUNAPI firmware (an nginx-fronted iPolis build was the concrete case: `WWW-Authenticate: Digest qop="auth", realm="iPolis_..."`) rejects Basic outright and 401s regardless of whether the password is correct — this is a scheme mismatch, not a bad credential. When the `401`/`403` response's `WWW-Authenticate` header advertises `Digest` and credentials are available, `querySunapiMaxChannel()` computes an RFC 7616 Digest response (MD5, `qop=auth` when offered) and retries exactly once with it before giving up. A `Basic`-only challenge, or a Digest retry that still 401s (i.e. a genuinely wrong password), falls through to the existing "resolves 1" behavior unchanged.
   - **SUNAPI HTTPS self-signed certificate** (2026-07-02, FR-CAM-073): when the SUNAPI web UI is HTTPS-only, the query used Node's default TLS validation and failed with `self-signed certificate` before ever reaching the auth layer above — on-prem cameras/NVRs almost universally ship self-signed certs, and `onvifDiscovery.js`'s own HTTPS SOAP client already sets `rejectUnauthorized: false` for this exact reason. `querySunapiMaxChannel()` was simply missing the equivalent option; now sets it too. This only affects certificate trust, not authentication — FR-CAM-068/072's credential checks are unchanged.
   - Returns 1 on any failure (auth required — Basic-challenged or Digest-retry-failed —, timeout, network error, attribute not found)
   - If `> 1`, device is re-upserted and re-emitted via `discovery:result`
3. **mergeDevices**: When UDP and ONVIF discover the same NVR, `MaxChannel = max(udp, onvif)` — the richer value wins.

### 3.1a SUNAPI RTSP URL resolution (2026-07-02, FR-CAM-077~080)

**Two path conventions, both real** — a survey of this deployment's own camera DB records found two distinct SUNAPI/Wisenet per-channel RTSP path shapes in active use:

| Convention | Example | Observed on |
|---|---|---|
| `/profileN/` (1-based) | `rtsp://192.168.214.32:10030/profile1/media.smp` | TID-A800 (thermal/radiometric encoder) |
| `/N/H.264/` (0-based channel segment) | `rtsp://192.168.214.40/0/H.264/media.smp` | Every other camera surveyed (192.168.214.34/35/37/39/40) |

`channelRtspUrl(baseUrl, channel)` (`server/src/utils/channelRtsp.js`, client twin `client/src/utils/channelRtsp.ts`) previously only recognized the first — the second, actually more common, convention silently no-op'd (returned the URL unchanged) whenever a channel-switch was attempted against it. Fixed by detecting which shape `baseUrl` already uses and substituting only within that shape; the `channel` parameter stays 1-based at every call site regardless of convention — only the `/N/H.264/` case translates it to `channel - 1` when writing the URL segment. A companion helper, `defaultSunapiRtspUrl(ip, rtspPort, channel)`, synthesizes a fresh URL using the `/N/H.264/` convention when there is no `baseUrl` at all to pattern-match against (e.g. probing a bare IP that hasn't been added yet).

**RTSP port confirmation** (FR-CAM-079) — `defaultSunapiRtspUrl()`'s port defaults to the SUNAPI standard `554`, but the *actual* configured port can differ (see the 192.168.214.32 finding below). `querySunapiRtspPort()` (`discoveryService.js`, new — parallels `querySunapiMaxChannel()`'s auth handling) confirms it via:

```
GET /stw-cgi/network.cgi?msubmenu=portconf&action=view
```

Unlike `attributes.cgi` (XML), this CGI action returns **plain `key=value` text, one pair per line**:
```
FixedPorts=3702,49152
UsedPorts=
HTTPPort=80
HTTPSPort=443
WebSessionTimeout=10
RTSPPort=554
RTSPTimeout=60s
```
`querySunapiRtspPort()` extracts `RTSPPort`. This endpoint requires admin auth (verified live: `HTTP 401` with no credentials) — the function short-circuits to `null` immediately when no username/password is available from any source, without a network round-trip, mirroring FR-CH-064's cameraId-scoped credential gate. Verified live via `curl --digest` against two real devices before implementation (not merely assumed — see the FR-CAM-062a precedent of a previously-documented endpoint that turned out not to exist at all):

| Camera | `RTSPPort` reported | Camera's own stored `rtspUrl` port |
|---|---|---|
| 192.168.214.32 (TID-A800) | `554` | `10030` (!) |
| 192.168.214.37 | `554` | (matches — no `baseRtspUrl` port override) |

192.168.214.32's mismatch is a real, pre-existing data quality finding — the port saved in this camera's DB record is stale/incorrect relative to what the device itself now reports. This feature surfaces the discrepancy (a Re-detect against this camera will compute the correct `554`-based URL) but does not silently overwrite an already-saved camera's `rtspUrl` — the operator must Re-detect and Save, consistent with the Edit modal's existing "stage then save" pattern (§5.4 `docs/design/Design_Channel_Slot.md`).

**SUNAPI CGI redirect following** (FR-CAM-077) — `sunapiRequest()` (the shared GET helper both `querySunapiMaxChannel()` and `querySunapiRtspPort()` use) now follows one same-host `301`/`302`/`307`/`308` redirect, exactly mirroring `soapPost()`'s FR-CAM-076 fix on the ONVIF side — the same nginx-forced HTTP→HTTPS behavior observed on 192.168.214.37 applies to its SUNAPI web port too. A cross-host redirect target is never contacted (SSRF hardening, same rule as FR-CAM-076).

**`probe-channels` response additions** (FR-CAM-080, see §5.3) — `sunapiProfiles`/`onvifProfiles` report each protocol's own per-channel URLs independently (mirrors the existing `sunapiMaxChannel`/`onvifMaxChannel` independent-reporting convention, `docs/srs/SRS_Channel_Slot.md` FR-CH-066), and `sunapiRtspPort` surfaces the confirmed port (or `null`). The client (`DiscoveredCameraPanel.tsx`, `CameraEditModal.tsx`) displays both protocols' URLs side by side so an operator can see which protocol (if either) actually resolved a given channel.

### 3.1b UDP discovery extended-field bounds checking + Device Type (2026-07-02, FR-CAM-081)

Vendor spec accessed directly (SUNAPI IP Installer §3.4.2 Response, `http://55.101.56.209:8080/site/SUNAPI/SUNAPI_ipinstaller.html#_response`) confirms `MaxChannel`/`Nonce` are real UDP response fields, but **conditional** — only present "When nVersion 0x08 is supported," inserted between `nUploadPort`/`SpeakerType` and `nNetworkMode`. Raw-capturing and byte-diffing two real devices on this network (192.168.214.37, an IP shared by two physical cameras — see §8's troubleshooting note) showed both send an identical, fixed 262-byte packet with no room for these conditional fields at all — not a missed byte offset, a genuinely absent field for this firmware generation. `_parseResponse()` itself (`submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js`) still doesn't parse this conditional field even when present — remains a real TODO, now needs a live device with `nVersion 0x08` set to verify against, rather than blocked on missing spec data.

**Bounds-checking bug found and fixed along the way**: the parser's existing extended-field block (`alias`, `chDeviceNameNew`, `modelType`, `version`, `httpType`, `nHttpsPort`, `noPassword`) was gated by one blanket `if (b.length >= 261)` check for the whole block — the 262-byte packets above numerically satisfy this (262 ≥ 261) despite having only 1 trailing byte, 71 short of the 72 the block needs. `rb(n)`/`bytes2int(rb(1))`/`r16()` silently return `0`/`''` on an out-of-bounds `subarray()` read (only `r8()`'s direct `b[i]` indexing naturally yields `undefined`), so `modelType` came back as a false-but-defined `0x00` ("Camera") — indistinguishable from a genuine Device Type 0. Fixed by gating each field on the actual remaining byte count *in sequence*, stopping at the first field that doesn't fit (a later field's nominal size fitting in what's left doesn't mean its offset is valid if an earlier field in the chain was already cut short).

**Device Type display**: `mapUDPDevice()` now also exposes `DeviceType` — a human-readable label for `Type` (`raw.modelType`) via `DEVICE_TYPE_LABELS` (0x00 Camera, 0x01 Encoder, 0x02 Decoder, 0x03 Recorder, 0x04 IOBox, 0x05 NetworkSpeaker, 0x06 NetworkMic, 0x07 LEDBox, 0x08 EmergencyBell, 0x09 AccessController — per the same vendor spec section). `undefined` when the field wasn't present in the response at all (post-fix — not `"Camera"`). `mergeDevices()` fills in `Type`/`DeviceType` from whichever protocol has it (UDP-only field, never set by ONVIF) without overwriting an existing value; `Type` uses a plain `!= null` check rather than the existing string-oriented `hasMeaningful()` helper, since `hasMeaningful()`'s `String(v || '')` coercion treats numeric `0` (a real, meaningful Device Type) as empty. Displayed as a new "Type" row in `DiscoveredCameraPanel.tsx`'s Device info section, alongside Model/Manufacturer.

### 3.1c "IP Scan for SUNAPI" protocol — fallback parity (2026-07-02, FR-CAM-082)

**Protocol reference**: SUNAPI IP Installer spec §3.4 "IP Scan for SUNAPI" (IPv4) — `http://55.101.56.209:8080/site/SUNAPI/SUNAPI_ipinstaller.html#_ip_scan_for_sunapi` — is the authoritative source for the broadcast discovery protocol both implementations below speak: a fixed-format UDP request broadcast to `255.255.255.255:7701` (`DEF_REQ_SCAN_EX = 6` is the documented request opcode field value at byte 0), with devices replying unicast to the sender on port `7711`. §3.4.1 defines the request layout, §3.4.2 the response layout (base fields identical to §3.1a/§3.1b above; `Nonce`/`MaxChannel` conditionally present per FR-CAM-081).

**Two parser implementations, now at parity**: `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js` (used when the git submodule is initialised) and `server/src/utils/udpDiscovery.js`'s `UDPDiscoveryFallback` (self-contained, used otherwise). Before this pass, the fallback was an **ONVIF-XML-only stub** — despite binding to the WiseNet-specific ports (7701/7711) and its class name, `_parseResponse()` `toString('utf8')`'d the response and regex-extracted ONVIF-style XML tags (`MACAddress`, `Model`, `XAddrs`), which cannot match a real WiseNet binary response at all. A deployment without the submodule initialised (`git submodule update --init` never run) could not discover any SUNAPI/WiseNet camera, silently — no error, just zero results, indistinguishable from "no cameras on the LAN."

**Fix**: `UDPDiscoveryFallback` now implements the same binary parser as the submodule byte-for-byte (including the FR-CAM-081 bounds-check fix), broadcasting the identical captured request packet (duplicated as a local constant — no dependency on the submodule being present). Verified two ways:
1. **Parity**: both parsers produce byte-identical field values against the same captured 262-byte response (`test/api/nvr_channel_discovery.test.js` TC-H-028/029).
2. **Live**: `UDPDiscoveryFallback` run standalone against this network's real broadcast domain discovered all 13 known cameras on the 192.168.214.x subnet, matching model names/ports exactly.

A subtle bug caught during implementation: `ntohs()`'s `big` parameter is misleadingly named — per the submodule's own comment, `big=true` actually means the wire format is **little-endian** (low byte first) for that field, not big-endian. An initial reimplementation inverted this, producing a plausible-looking but wrong port number (only caught by the parity test against a real captured packet, not by structural/shape checks alone) — a reminder that endianness bugs can silently produce "valid-shaped" wrong data and need a byte-exact fixture to catch, not just type/range assertions.

**Request opcode investigation (informational, not adopted as of this writing — superseded 2026-07-03, see §3.1e)**: §3.4.1 documents the request opcode as `nMode=6` (`DEF_REQ_SCAN_EX`), but both implementations' captured broadcast packet uses `nMode=1` (an earlier/legacy opcode, undocumented in this spec revision). A live side-by-side test broadcasting both opcodes on this network found: (a) this project's actual camera fleet replies identically regardless of which opcode is sent (their firmware doesn't distinguish `SCAN`/`SCAN_EX`); (b) sending `nMode=6` additionally drew responses from a much larger and largely unrelated portion of the network, including address ranges with no apparent relationship to this project's camera subnet — a network-scope/hygiene observation independent of this codebase, not investigated further. Given (a), there is no discovery benefit to switching from `nMode=1` for this fleet, and (b) is reason for caution rather than adoption — the existing, proven `nMode=1` request was kept as the implementation default in both parsers **at the time**. §3.1e records the subsequent decision to switch the default to `nMode=6` anyway, with the old packet kept as an immediate rollback path.

### 3.1d nMode-driven parsing + supported_protocol/no_password offset fix (2026-07-03, FR-CAM-083/084)

**Two customer-reported findings against Annex A**, investigated directly against the vendor's full spec page (`http://55.101.56.209:8080/site/SUNAPI/SUNAPI_ipinstaller.html`, specifically §3.2/§3.3's `DATAPACKET_V4`/`DATAPACKET_V4_EXT` byte tables, §3.4.2/§4.4.2's field-by-field response description — the customer's cited "§4.4.2/`_response_5`" — Table 1/2's `nMode` enum, and Annex A §5.1's authoritative C structs):

**1. `supported_protocol`/`no_password` offset bug (FR-CAM-083)**. Annex A's `DATAPACKET_EXT_IPv4_T`/`DATAPACKET_EXT_IPv6_T` end with two adjacent 1-byte fields: `supported_protocol` then `no_password`. `_parseResponse()`'s extended-block tail read only one byte at that position, into `noPassword` — meaning it silently consumed the byte belonging to `supported_protocol`, and the real trailing `no_password` byte was never read at all. Because both are 1-byte fields at the very end of the struct, this off-by-one didn't produce an out-of-bounds error — it produced a plausible-looking, still-in-range value that just happened to be one field early. Fixed by adding a distinct `supportedProtocol` read between `nHttpsPort` and `noPassword`, matching the struct order exactly. `mapUDPDevice()` now also surfaces the raw byte as `SupportedProtocol` — undecoded (the spec documents it as a bitmask: `0x01: SVNP, 0x02: SUNAPI1.0, 0x04: SUNAPI2.0, 0x08: SUNAPI2.3.1+, 0x10: SVP`, but this system has no present use for individual bit meaning, only for defensive round-tripping — decoding can be added later if a concrete need arises).

**2. `nMode`-driven parsing, not length-driven (FR-CAM-084)**. §3.4.2 (IPv4)/§4.4.2 (IPv6) both document `nMode = 12` (`DEF_RES_SCAN_EXT`) as *the* response mode that carries the extended field block — the response's own `nMode` byte is the authoritative signal for which wire format follows, not an inference from how many bytes happen to be in the buffer. Table 1/2 additionally define ten other `nMode` values (`DEF_REQ_SCAN_EXT=6`, `DEF_REQ_APPLY_EXT=7`, `DEF_REQ_SCAN_RSA=8`, `DEF_REQ_APPLY_PASSWORD=9`, `DEF_RES_SCAN_RSA=13`, `DEF_RES_APPLY_EXT=23`, `DEF_RES_APPLY_PASSWORD_ERR=24`, `DEF_RES_APPLY_PASSWORD=25`, `DEF_RES_PASSWORD_ERR=33`, `DEF_RES_ROUTER_CONN_ERR=66`, `DEF_RES_APPLY_ERR=77`) belonging to entirely different exchanges (§3.5 RSA key exchange for uninitialized devices, §3.6/§3.7 password-apply) — each with its own incompatible wire struct (e.g. `tagRsaScanResponse`, which replaces the DDNS/alias/model-type tail with a `MaxPasswordLen`+`Payload` blob).

Every device actually surveyed on this network's LAN responds with `nMode = 11` — a value absent from Table 1/2 entirely (undocumented in this spec revision, consistent with the already-known `nMode=1` request-opcode discrepancy, FR-CAM-082's non-goal note). Per Annex A's `DATAPACKET_IPv4_T` (the base, non-`_EXT` struct), this base-mode response has no room for the extended block at any length — only a single trailing `reserved3` byte after `ddns_url` (accounting for the real captured packets' exact length: 261 common-header bytes + 1 = 262).

**Fix — two-stage `nMode` dispatch, replacing the pure length-based heuristic**:

```js
const NMODE = {
  DEF_REQ_SCAN_EXT: 6,  DEF_REQ_APPLY_EXT: 7,        DEF_REQ_SCAN_RSA: 8,
  DEF_REQ_APPLY_PASSWORD: 9,
  DEF_RES_SCAN_EXT: 12, DEF_RES_SCAN_RSA: 13,        DEF_RES_APPLY_EXT: 23,
  DEF_RES_APPLY_PASSWORD_ERR: 24, DEF_RES_APPLY_PASSWORD: 25,
  DEF_RES_PASSWORD_ERR: 33, DEF_RES_ROUTER_CONN_ERR: 66, DEF_RES_APPLY_ERR: 77,
};
const NON_SCAN_RESPONSE_MODES = new Set([
  NMODE.DEF_RES_SCAN_RSA, NMODE.DEF_RES_APPLY_EXT, NMODE.DEF_RES_APPLY_PASSWORD_ERR,
  NMODE.DEF_RES_APPLY_PASSWORD, NMODE.DEF_RES_PASSWORD_ERR,
  NMODE.DEF_RES_ROUTER_CONN_ERR, NMODE.DEF_RES_APPLY_ERR,
]);

result.nMode = r8();
if (NON_SCAN_RESPONSE_MODES.has(result.nMode)) return null;  // stage 1: not an IP-Scan response at all

// ...base fields parsed as before...

let extendedOk = result.nMode === NMODE.DEF_RES_SCAN_EXT;    // stage 2: extended block iff nMode says so
```

Stage 1 bails out before reading a single further byte with the IP-Scan layout — these other exchanges' structs diverge immediately after the shared `mode`/`packet_id`/`mac_addr`/`ipset` prefix, so continuing to read them as an IP-Scan response would produce plausible-but-wrong `chDeviceName`/`nHttpPort`/etc. from unrelated struct fields. Stage 2 replaces the previous `let extendedOk = true` (pure length-check start state, FR-CAM-081) with a mode-gated start state; the FR-CAM-081 per-field remaining-byte-count check remains active *inside* that gate as defense against a genuinely truncated `nMode=12` packet, but is no longer, by itself, sufficient evidence that the extended block is present.

Applied identically to both `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js` and `server/src/utils/udpDiscovery.js`'s `UDPDiscoveryFallback` (parity requirement, FR-CAM-082 extended to this dispatch too).

**Acceptance / verification**: `test/api/nvr_channel_discovery.test.js` TC-H-027/030 were updated to force `nMode=12` on their "genuinely extended" synthetic fixtures (previously they reused the real capture's own `nMode=11` prefix, which — under the new mode-gate — would no longer parse the extended block at all, since length alone is no longer sufficient). TC-H-031/032 (new) prove the opposite case: an `nMode=11` packet padded to the full 334-byte extended length still yields all extended fields `undefined`. TC-H-033/034 (new) prove the non-scan-mode bail-out returns `null` for all seven documented non-scan `nMode` values, for both parser implementations.

### 3.1e Request/Response classes + request opcode switched to `nMode=6` (2026-07-03)

**Request/Response classes**: `submodules/WiseNetChromeIPInstaller/nodejs/request.js` (`UdpRequest`) and `response.js` (`UdpResponse`) implement §3.2 "SendData Format for SUNAPI" and §3.3 "RecvData Format for SUNAPI" directly from the vendor spec's field table (`http://55.101.56.209:8080/site/SUNAPI/SUNAPI_ipinstaller.html#_senddata_format_for_sunapi` / `#_recvdata_format_for_sunapi`) as one shared 334-byte `DATAPACKET_V4_EXT` field layout (`FIELDS`, exported from `request.js` and re-imported by `response.js`) — a single source of truth so the send-side and receive-side definitions of the struct cannot drift apart.

- `UdpRequest` defaults to `nMode = DEF_REQ_SCAN_EXT (6)`, a freshly generated `chPacketID` (local MAC + random bytes, per §3.2's own field description: "unique ID derived from MAC address of PC and random value"), and every other field left at its §3.4.1-documented "Unused" value (zero-filled). Any field can be overridden via the constructor, e.g. `new UdpRequest({ nMode: 1 })`.
- `UdpResponse.parse(buf, rinfo)` decodes a response buffer per §3.3: the base fields (`nMode`..`chDDNS`) unconditionally, and the tail block (`chAlias`..`nPasswordStatus`) only when `nMode === DEF_RES_SCAN_EXT (12)` **and** enough bytes remain for each field in sequence (same per-field bounds-check discipline as §3.1b/FR-CAM-081, applied independently of `_parseResponse()`). Any other documented response `nMode` (13/23/24/25/33/66/77 — RSA key exchange, password-apply) returns `null`.
- `UdpResponse` also has a `toString()` — a one-line `name=value` dump of every §3.3 field, prefixed with the sender's address — which `parse()` logs via `console.log()` on every successful parse, purely for visibility during live discovery runs.

**Request opcode switched to `nMode=6` (supersedes §3.1c's "not adopted" note)**: `udpDiscovery.js`'s `_sendDiscovery()` now builds and sends `new UdpRequest({ nMode: NMODE.DEF_REQ_SCAN_EXT })` instead of the historical hardcoded `DISCOVERY_PACKET` (`nMode=1`) constant. The old constant is kept in the file, **commented out rather than deleted**, as the immediate rollback if `nMode=6`'s broader-network-response behavior (§3.1c) proves disruptive on some deployment's network — restoring it is a one-line change (uncomment the `Buffer.from(...)` and the `this._socket.send(DISCOVERY_PACKET, ...)` call, or pass `{ nMode: 1 }` to `UdpRequest`).

The socket's `'message'` handler independently verifies the documented §3.4.1/§3.4.2 request/response contract — a `DEF_REQ_SCAN_EXT` (6) request should draw a `DEF_RES_SCAN_EXT` (12) response — by running every inbound packet through `UdpResponse.parse()` in parallel with the existing `_parseResponse()` call, emitting a `'scanExtConfirmed'` event when `response.nMode === NMODE.DEF_RES_SCAN_EXT`. This is a verification signal only: `'device'` (backed by `_parseResponse()`/`mapUDPDevice()`) remains the event that actually drives discovery results, unchanged by this switch. **Live-verified** (not just loopback) against this network's real camera fleet: `node index.js` broadcasts the `nMode=6` request and receives real `nMode=12` responses from multiple live devices, each correctly parsed end to end (`chIP`/`chMac`/`rtspUrl`/etc.).

**`reserved2`/`reserved3` offset bug (found and fixed while validating `UdpResponse` against `_parseResponse()`)**: §3.2/§3.3's own field tables (transcribed verbatim into `FIELDS` initially) omit two 1-byte fields that Annex A §5.1's authoritative `DATAPACKET_(EXT_)IPv4_T` C structs *do* include — `reserved2` right after `device_name`/`chDeviceName`, and `reserved3` right after `https_mode`/`nHttpMode` — both of which `_parseResponse()` already read (and discarded) correctly, matching real hardware. Building `FIELDS` from the vendor's summary table alone (without cross-checking Annex A) reproduced exactly the class of gap FR-CAM-083 already hit once for `supported_protocol`/`no_password`: every `UdpResponse` field from `nHttpPort` onward came out shifted by one byte and silently plausible-but-wrong (e.g. `nHttpPort` decoded as `20596` instead of the real device's `80`), until a direct side-by-side comparison against `_parseResponse()` on the same captured packet caught it. `FIELDS` now includes both reserved fields (334 bytes total, matching the project's already-established 334-byte extended-packet length from FR-CAM-081's test fixtures); `UdpResponse.parse()` and `_parseResponse()` were verified to produce identical values for every base and extended field, on both a real captured packet and this network's live traffic.

### 3.1f `protocol.js` shared constants, server-side fallback removal, RTSP port field bug, Digest auth robustness (2026-07-03)

**`protocol.js`**: `submodules/WiseNetChromeIPInstaller/nodejs/protocol.js` is a new module holding every constant `request.js`/`response.js`/`udpDiscovery.js` need — `SEND_PORT`/`RECEIVE_PORT`/`BROADCAST_ADDR`, the 334-byte `FIELDS` table (§3.1e), the full request+response `NMODE` enum (previously duplicated three ways: `request.js` had the request-side subset, `response.js` the response-side subset, `udpDiscovery.js` both merged again), `NON_SCAN_RESPONSE_MODES`, and newly-added response-field enums transcribed from §3.4.2's prose: `NVERSION` (bitmask: `CANNOT_CHANGE_HTTPS_PORT_IN_WEBPAGE=0x01`, `CAN_CHANGE_HTTPS_PORT_IN_WEBPAGE=0x02`, `SUPPORT_NEW_MODEL_NAME=0x04`, `SUPPORT_PASSWORD_VERIFICATION_DIGEST=0x08`, plus a `hasVersionFlag()` helper), `NETWORK_MODE` (`STATIC/DHCP/PPPOE`), `DEVICE_TYPE` (0x00 Camera..0x09 AccessController, matching `discoveryService.js`'s existing `DEVICE_TYPE_LABELS`), `HTTP_MODE` (`HTTP/HTTPS`), `SUPPORTED_PROTOCOL` (bitmask: `SVNP/SUNAPI_1_0/SUNAPI_2_0/SUNAPI_2_3_1_ABOVE/SVP`, plus `hasSupportedProtocol()`), and `PASSWORD_STATUS` (`HAS_PASSWORD=0x00`, `NO_PASSWORD=0x01` — note the field name `nPasswordStatus`/`no_password` is the inverse of what it sounds like). `UdpResponse` exposes all of these as static properties and `hasVersionFlag()`/`hasSupportedProtocol()` instance methods.

**`server/src/utils/udpDiscovery.js` fully replaced — no more inline fallback**: The file's `SUBMODULE_CANDIDATES` path-detection logic and the ~300-line `UDPDiscoveryFallback` class (independent socket/parsing implementation, historical record in §3.1c) are both gone. The file is now a ~20-line re-export of `wisenet-chrome-ip-installer` (see below), whichever install path (git submodule or npm) provides it:

```js
const { UDPDiscovery, SEND_PORT, RECEIVE_PORT, BROADCAST_ADDR, RESPONSE_MODE_SCAN_EXT, NMODE, NON_SCAN_RESPONSE_MODES }
  = require('wisenet-chrome-ip-installer/nodejs/udpDiscovery');
function getUDPDiscovery() { return UDPDiscovery; }
module.exports = { getUDPDiscovery, UDPDiscovery, SEND_PORT, RECEIVE_PORT, BROADCAST_ADDR, RESPONSE_MODE_SCAN_EXT, NMODE, NON_SCAN_RESPONSE_MODES };
```

`wisenet-chrome-ip-installer` — `submodules/WiseNetChromeIPInstaller`'s `nodejs-udp-discovery` branch, added as an `optionalDependencies` entry in `server/package.json` (`"git+https://github.com/melchi45/WiseNetChromeIPInstaller.git#nodejs-udp-discovery"`), fetched by ordinary `npm install` — no separate `git submodule update --init` step required. `optionalDependencies` (not `dependencies`) so a failed/skipped install of this one package doesn't abort `npm install` for the rest of the server. Making this installable at all required adding a **root-level `package.json`** to that repo (previously only `nodejs/package.json` existed; npm's git-dependency installer requires a `package.json` at the repo root to recognize it as a package at all — `npm install` failed with `ENOENT` before this was added). That root `package.json` sets `"private": true` (mixes Chrome-extension assets with the Node.js port, not meant for public registry publish), `"main": "nodejs/udpDiscovery.js"`, and `"files": ["nodejs"]` — verified live that `files` is honored even for a git dependency (not just registry `npm publish`), so only `nodejs/` (~72KB) installs into `node_modules`, not the Chrome extension's ~1.5MB of unrelated assets (`ump-player.js`, images, `key.pem`, etc.).

Removing the inline fallback was a deliberate tradeoff, not a default: `UDPDiscoveryFallback` existed specifically so WiseNet discovery kept working when the git submodule wasn't initialized (real incident on record, FR-CAM-082 — a deployment without `git submodule update --init` silently discovered zero SUNAPI cameras). The team weighed this against duplication cost (the fallback had already drifted once — an endianness bug caught only by a parity test, §3.1c) and concluded the npm `optionalDependencies` path is a strictly better second line of defense than a second full implementation: it's satisfied by the same `npm install` every dev/CI/deploy workflow already runs, with no extra step to forget. The counter-risk — `wisenet-chrome-ip-installer` is hosted in a *private* GitHub repo, and this session hit real, repeated authentication failures (expired token, wrong-account token, eventual `git-credential-store` resolution) trying to push to it — was raised explicitly before removal and accepted as a known tradeoff.

**RTSP port field bug (`nTcpPort`/`nPort` are not the RTSP port)**: `_parseResponse()`'s `result.rtspUrl` used to be `` `rtsp://${chIP}:${nTcpPort || 554}/...` ``, and `discoveryService.js`'s `mapUDPDevice()` used to fall back to `raw.nPort` for the same purpose. Both are wrong per §3.2/§3.3's own field descriptions: `nTcpPort` is "Port number to get stream via tcp. This port is valid only if Client uses VNP" (a legacy WiseNet protocol, not RTSP/SUNAPI) and `nPort` is "HTTP port for web-connection" (confirmed live: real devices report `443` there, their HTTPS web port). **No field in this UDP response reliably carries the real RTSP port at all.** Fixed in both places to default straight to SUNAPI's documented standard (`554`) — the confirmed real port, when it differs, comes only from `querySunapiRtspPort()`'s CGI query (§3.1a), never from the UDP broadcast response. This is user-visible: `mapUDPDevice()`'s `Port` field is shown in `DiscoveredCameraPanel.tsx` labeled "RTSP Port" and feeds `defaultSunapiRtspUrl()`. This bug is almost certainly the root cause of the discrepancy already on record in §3.1a/Camera_Discovery_Guide.md §3 ("192.168.214.32 stores port `10030` in its DB record, but the device itself reports `RTSPPort=554`") — `10030` was never a real RTSP port, just whatever `nTcpPort` happened to contain on that capture.

**SUNAPI CGI Digest auth detection robustness**: `querySunapiMaxChannel()` and `querySunapiRtspPort()` (both in `discoveryService.js`) retry with Digest when a 401/403's `WWW-Authenticate` header advertises it (FR-CAM-072) — the detection regex was `/^Digest\s/i`, anchored to the start of the string. When a server sends more than one `WWW-Authenticate` header, Node joins them with `", "` (e.g. `Basic realm="x", Digest realm="y", qop="auth", nonce="..."`), and the anchored regex misses Digest whenever it isn't the first scheme listed. Changed to `/\bDigest\b/i` (word-boundary match). Since this widens what counts as a Digest challenge, `buildDigestAuthHeader()` was also hardened to scope its `realm`/`nonce`/`qop`/`opaque` parameter extraction to the substring *after* the first `Digest` token (`challenge.replace(/^[\s\S]*?\bDigest\b\s*/i, '')`) rather than the full challenge string — otherwise a combined header would risk extracting Basic's `realm` instead of Digest's. Verified with a synthetic combined-header fixture: detection now fires, and the built `Authorization` header correctly contains the Digest-scheme `realm`, not the Basic-scheme one.

**`MaxChannel`/`Nonce` conditional fields — `MaxChannel` now implemented (§3.1h below), `Nonce` still not**: §3.4.2's field table never lists `nMulticastPort` or `chPassword` by name in the response — those rows are replaced by `MaxChannel` and `Nonce` respectively, both captioned "When nVersion 0x08 is supported." Positionally this reads as: those two fixed-size slots (`nMulticastPort`, 2 bytes at offset 130; `chPassword`, 20 bytes at offset 85) are reinterpreted when the device declares `nVersion` bit `0x08` (`SUPPORT_PASSWORD_VERIFICATION_DIGEST`) — the same pattern already documented for `nUploadPort`/`SpeakerType` (§3.2's table). Annex A's C struct can't express a conditional reinterpretation of a fixed field (it just types the slots `multicast_port`/`password` unconditionally), so this isn't a contradiction, just something Annex A's struct-level view can't represent. Every device captured on this network so far has `nVersion & 0x08 === 0` (in fact no captured device even sends a `nVersion` field — see below), so the spec's own condition is unverifiable here; §3.1h implements `MaxChannel` against a different, verifiable condition instead. `Nonce`/`chPassword` remains unimplemented — no comparably verifiable trigger condition identified yet.

**`nVersion` endianness — investigated, not changed**: `nVersion` is the one field read big-endian (`UINT16_BE_FIELDS`) while every other multi-byte field is little-endian. Real captured values (3328, 3072, 1288) were checked against both readings' bit patterns for the four documented `NVERSION` flags: the current BE reading leaves 2 of 3 samples with all four flags off (implausible for modern firmware), while a hypothetical LE reading makes 2 of 3 samples plausible but makes the third *worse* (sets undocumented high bits). Neither reading cleanly explains all three samples — inconclusive with a 3-sample size, and Annex A explicitly types `version` as a single `unsigned short` (matching the current 2-byte BE implementation, which the pre-existing legacy parser also always used without prior complaint). Left unchanged pending either a larger sample or a device whose actual HTTPS-port-changeability is independently known to correlate against.

### 3.1h UDP discovery `MaxChannel` derivation from `nMulticastPort` (2026-07-03, FR-CAM-091)

Implements the `MaxChannel` half of §3.1f's "still not implemented" note above, using `nMode` instead of `nVersion 0x08` as the trigger condition (the latter is unverifiable on this network — see above).

**`UdpResponse.MaxChannel` getter** (`response.js`):
```js
get MaxChannel() {
  return this.nMode === NMODE.DEF_RES_SCAN_EXT ? this.nMulticastPort : undefined;
}
```
`nMulticastPort` is a **base field** — decoded unconditionally regardless of `nMode`, same as before this change. This getter adds a second, conditional *interpretation* of that already-decoded value; it does not change when or how `nMulticastPort` itself is parsed, and needs no extended-tail bytes to be present.

**`_parseResponse()` adapter** (`udpDiscovery.js`) surfaces this as `nMaxChannel` (matching this adapter's `n`-prefix convention for its other raw numeric wire fields — `nPort`, `nHttpPort`, `nMulticastPort`, etc. — as distinct from `UdpResponse`'s own un-prefixed `MaxChannel` getter name):
```js
nMaxChannel: r.MaxChannel,
```

**`mapUDPDevice()`** (`discoveryService.js`) already had a forward-compatible expression referencing a `raw.MaxChannel` field that `_parseResponse()` never actually set (§3.1f's note, and FR-CAM-081's Document History) — updated to reference the now-real field:
```js
MaxChannel: raw.nMaxChannel > 1 ? raw.nMaxChannel : 1,
```
No other logic changed; `SunapiMaxChannel`'s parallel expression was updated identically.

**Verification and remaining gap**: TC-H-040 (`test/api/nvr_channel_discovery.test.js`) confirms the *mechanism* — a real 262-byte captured packet (`nMode=11`, base mode) yields `MaxChannel`/`nMaxChannel: undefined` and `mapUDPDevice().MaxChannel: 1`; the identical bytes with only the `nMode` byte overwritten to `12` yield `MaxChannel`/`nMaxChannel` equal to the decoded `nMulticastPort` (10050 in the fixture) and `mapUDPDevice().MaxChannel: 10050`. No device sending a genuine `nMode=12` response has been captured on this network, so whether a real device's `nMulticastPort`-as-`MaxChannel` value is actually a sane channel count (as opposed to, say, a real multicast port number that happens to be `> 1`) remains unconfirmed — the credential-gated SUNAPI CGI fallback (`querySunapiMaxChannel()`, §3.1) stays in place as a secondary/cross-check source, not superseded by this.

### 3.2 ONVIFDiscovery (`server/src/services/onvifDiscovery.js`)

**State machine:**

```
Initial
  → start() called
  → UDP socket bound → multicast join → Probe sent
  → Receiving ProbeMatch messages → emit 'device' (basic)
  → enrichDevice() async → emit 'device' (enriched)
  → PROBE_TIMEOUT → _cleanup() → emit 'done'
  OR
  → socket error → emit 'error' → _cleanup()
```

**Key methods:**

| Method | Description |
|---|---|
| `start()` | Bind UDP socket, join multicast, send Probe, set 8s timer |
| `stop()` | Set `_running=false`, cleanup socket and timer, emit `'done'` |
| `_makeDevice(ip, xaddr, epRef)` | Build basic DeviceInfo with `source: 'onvif'` |
| `_cleanup()` | Clear timer, close socket |

**`enrichDevice(ip, xaddr, credentials = null)` async flow:**

```
1. GetDeviceInformation → Manufacturer, Model, FirmwareVersion, SerialNumber
2. GetCapabilities(Category: Media) → media service XAddr
3. GetVideoSources at mediaUrl (2026-07-02, FR-CAM-075) → VideoSources[].token list
   → authoritative physical-channel enumeration (VideoSource_0, VideoSource_1, ...),
     independent of whether GetProfiles exposes a profile for every channel
4. GetProfiles at mediaUrl → parse <Profiles> blocks
   → per profile: token, name, encoding, width, height, fps, sourceToken
   → channelIndex = sourceToken's position in step 3's token list (falls back to
     insertion-order-within-GetProfiles when step 3 returned nothing)
5. GetStreamUri for each profile (max 16)
   → rtspUrl per profile; first non-empty (channel 1) = device rtspUrl
6. Fallback: rtspUrl = "rtsp://<ip>:554/"
7. MaxChannel = step 3's token count, or step 4's distinct-sourceToken count as fallback, or 1
```

Every step's `soapPost()` call is given the same `credentials` (2026-07-03, FR-CAM-090, see §3.2a below) — `{ username, password }` or `null` for the historical unauthenticated behavior.

`enrichDeviceAutoScheme(ip, { onvifPort, onvifHttpsPort, username, password })` (2026-07-02, FR-CAM-074; `username`/`password` added 2026-07-03, FR-CAM-090) — a second export, used only by `POST /api/cameras/probe-channels` (Channel Slot feature; `Design_Channel_Slot.md` §4.6), which has no device-asserted XAddr and must guess the scheme. Runs `enrichDevice()` on both `http://ip:onvifPort` (default 80) and `https://ip:onvifHttpsPort` (default 443) in parallel, passing the same credentials to both, and returns whichever produced a non-empty result (Manufacturer/Model/profiles/MaxChannel>1), falling back to the HTTP result unchanged if neither did. `ONVIFDiscovery`'s own WS-Discovery scan below does **not** need this second export — its XAddr comes straight from the device's ProbeMatch response, so the scheme is already known — but it does pass its own `credentials` to `enrichDevice()` (§3.2a).

**SOAP helper `soapPost(xaddr, body, credentials = null, redirectsLeft = 1)`** (signature changed 2026-07-03, FR-CAM-090 — was `soapPost(xaddr, body, redirectsLeft = 1)`):
- Uses `http` or `https` module based on URL scheme.
- 4-second timeout (`HTTP_TIMEOUT`).
- Sends `Authorization: Basic ...` when `credentials` is given; retries once with a computed HTTP Digest header on a Digest challenge (§3.2a).
- Returns 401 as `AUTH_REQUIRED` error (after the Digest retry, if one was attempted).
- `rejectUnauthorized: false` (self-signed certificates supported).
- **Same-host redirect following** (2026-07-02, FR-CAM-076): a `301`/`302`/`307`/`308` response whose `Location` header resolves to the *same* hostname as the request is followed, bounded to one hop — observed live: 192.168.214.37 force-redirects every ONVIF SOAP call on port 80 to HTTPS via nginx, and without this, every call there failed with a bare `HTTP 301`. A `Location` pointing at a **different** hostname is never followed (SSRF hardening — an ONVIF device's own redirect is trusted only to change its own scheme/port, not to redirect the request to an arbitrary third host). The `credentials`/`Authorization` header, if any, is carried unchanged through the redirect.

### 3.2a ONVIF SOAP client Basic→Digest auth fallback (2026-07-03, FR-CAM-090)

Same problem, same fix shape as §3.1f's SUNAPI CGI Digest robustness, applied to the ONVIF side: some devices front their ONVIF `device_service` behind an HTTP server (e.g. nginx) that gates the endpoint with Basic or Digest auth before the request ever reaches the ONVIF SOAP handler — `soapPost()` previously never sent an `Authorization` header at all, so any such device's ONVIF probe always failed with `AUTH_REQUIRED` even when correct credentials were available elsewhere in the same request (the SUNAPI probe already had them via FR-CAM-068/072).

**Shared `buildDigestAuthHeader()`**: moved from `discoveryService.js` into a new `server/src/utils/digestAuth.js` (also exporting `challengesDigest()`, the `/\bDigest\b/i` combined-header-aware check from FR-CAM-089) — both `discoveryService.js`'s SUNAPI client and `onvifDiscovery.js`'s ONVIF client now share one MD5/RFC 7616 implementation instead of drifting independently. `discoveryService.js` still re-exports `buildDigestAuthHeader` unchanged (existing direct-require callers, e.g. TC-H-036, are unaffected).

**`soapPost()` restructured into two layers**:
```js
// Low-level: one HTTP request + same-host redirect follow, given a complete
// Authorization header value (or none).
function soapRequest(xaddr, body, authHeader, redirectsLeft) { /* ... */ }

// Auth orchestration: Basic first, Digest-on-challenge retry.
function soapPost(xaddr, body, credentials = null, redirectsLeft = 1) {
  const basicAuthHeader = credentials?.username && credentials?.password
    ? 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')
    : null;
  return soapRequest(xaddr, body, basicAuthHeader, redirectsLeft).catch((err) => {
    if (err.message !== 'AUTH_REQUIRED' || !credentials?.username || !challengesDigest(err.wwwAuthenticate)) throw err;
    const digestHeader = buildDigestAuthHeader(err.wwwAuthenticate, 'POST', uri, credentials.username, credentials.password);
    return soapRequest(xaddr, body, digestHeader, redirectsLeft);
  });
}
```
`soapRequest()`'s `401` rejection carries the raw `WWW-Authenticate` value on `err.wwwAuthenticate` so `soapPost()` can inspect it without a second network round-trip. Exactly one Digest retry is attempted, mirroring FR-CAM-072/089's "one retry, then genuinely fail" semantics — a wrong password still 401s the Digest attempt too, so this cannot mask bad credentials.

**Credential plumbing**: `enrichDevice(ip, xaddr, credentials)` passes the same `credentials` to all five `soapPost()` calls (§3.2's flow). `enrichDeviceAutoScheme()` builds `credentials` from its new `username`/`password` options. `ONVIFDiscovery`'s constructor accepts `username`/`password` options defaulting to `RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD` env vars (same defaults FR-CAM-068 already uses for SUNAPI) and passes them to every `enrichDevice()` call in its ProbeMatch handler (§3.2's state machine). `server/src/api/cameras.js`'s `POST /api/cameras/probe-channels` (`Design_Channel_Slot.md` §4.6) now passes its already-resolved `effectiveUsername`/`effectivePassword` (request body → stored camera record → env default, FR-CH-064) to `enrichDeviceAutoScheme()` as well — previously only the SUNAPI probe on that same route received them.

**Scope**: this is HTTP-transport-layer Basic/Digest only — it does **not** implement ONVIF's own SOAP-level WS-Security (`wsse:UsernameToken`/`PasswordDigest` inside `<s:Header>`). A device that requires WS-Security specifically (rather than gating at the HTTP layer) is unaffected; `enrichDevice()` still swallows that failure per-step and returns partial/`MaxChannel: 1` data. See `Design_Channel_Slot.md` §7 Limitations.

**Verification**: TC-H-037~039b (`test/api/nvr_channel_discovery.test.js`) — a mock ONVIF SOAP server enforcing real RFC 7616 Digest verification (not just "was an Authorization header sent") confirms: Basic-accepting devices authenticate on the first attempt (TC-H-037); Digest-only devices (401 any Basic attempt) succeed via the computed retry (TC-H-038); a wrong password still fails even after the retry (TC-H-039); and omitting `credentials` entirely reproduces the pre-FR-CAM-090 behavior unchanged (TC-H-039b).

### 3.3 camerasRouter (`server/src/api/cameras.js`)

**Route summary with key behaviors:**

| Route | Special Behavior |
|---|---|
| `POST /discover` | Emits `discovery:trigger` via `req.app.get('io')`; returns immediately |
| `POST /` | Generates UUID; persists to DB; returns 201 |
| `GET /` | Enriches each camera with `pipelineManager.getCameraStatus()`; normalizes YouTube bitrate bps→kbps |
| `PUT /:id` | Only restarts pipeline when `rtspUrl`, `webrtcEnabled`, `username`, or `password` actually changed |
| `DELETE /:id` | Delegates to `youtubeSvc.stopStream()` for YouTube cameras; else stops pipeline + deletes record |
| `POST /:id/ai/toggle` | Toggles `aiEnabled` without restarting pipeline |

**Pipeline restart condition (PUT):**
```javascript
const needsRestart =
  (rtspUrl !== undefined && rtspUrl !== camera.rtspUrl) ||
  (webrtcEnabled !== undefined && !!webrtcEnabled !== !!camera.webrtcEnabled) ||
  (username !== undefined && (username || null) !== camera.username) ||
  (password !== undefined && (password || null) !== camera.password);
```

---

## 4. Data Model

### 4.1 DeviceInfo (in-memory)

```typescript
interface DeviceInfo {
  id:             string;         // deviceKey composite
  source:         'udp' | 'onvif' | 'both';
  IPAddress:      string;
  MACAddress:     string;         // uppercase, colon-separated (may be empty for ONVIF-only)
  Port:           number;         // RTSP port (554)
  HttpPort:       number;
  HttpsPort:      number;
  HttpType:       boolean;        // true = HTTPS-only device
  Gateway:        string;
  SubnetMask:     string;
  Manufacturer:   string;
  Model:          string;
  FirmwareVersion?: string;
  SerialNumber?:  string;
  Channel?:       number;         // currently selected channel (1-based, default 1)
  MaxChannel?:    number;         // total channel count; >1 indicates NVR/DVR
  SupportSunapi:  boolean;
  SupportOnvif:   boolean;
  SupportPTZ?:    boolean;
  rtspUrl?:       string;
  profiles?:      OnvifProfile[]; // ONVIF stream profiles; index = channel-1 for NVRs
  URL?:           string;         // DDNS URL (WiseNet UDP only)
  xaddr?:         string;         // ONVIF device service endpoint
  epRef?:         string;         // ONVIF EndpointReference
}

interface OnvifProfile {
  token:     string;
  name:      string;
  encoding:  string;    // "H264" | "H265" | "MJPEG"
  width:     number;
  height:    number;
  fps:       number;
  rtspUrl:   string;
}
```

### 4.2 Camera Record (database)

```
id          UUID v4       Primary key
name        string        Display name
rtspUrl     string        Full RTSP URL
username    string|null   RTSP credential
password    string|null   RTSP credential (never returned in API responses)
ip          string|null   IP address
mac         string|null   MAC address
httpPort    number|null   HTTP port
status      string        'offline' | 'live' | other pipeline states
type        string|null   'youtube' for virtual cameras
aiEnabled   boolean       AI inference enabled (default true)
webrtcEnabled boolean     WebRTC enabled for this camera
createdAt   ISO-8601
updatedAt   ISO-8601
```

---

## 5. API Design

### 5.1 Camera Discovery Endpoint

```
POST /api/cameras/discover
  → 200: { success: true, data: [], message: "Discovery started. Listen for discovery:result socket events." }
  → 500: { success: false, error: string }
```

### 5.2 Camera CRUD

```
GET /api/cameras
  → 200: { success: true, data: CameraWithPipelineStatus[] }
  CameraWithPipelineStatus: { ...camera, password: undefined, pipelineStatus: object|null }

POST /api/cameras
  Body: { name: string, rtspUrl: string, username?: string, password?: string, ip?: string, mac?: string, httpPort?: number }
  → 201: { success: true, data: Camera }          (password excluded)
  → 400: { success: false, error: 'name and rtspUrl are required' }
  → 500: { success: false, error: string }

GET /api/cameras/:id
  → 200: { success: true, data: CameraWithPipelineStatus }
  → 404: { success: false, error: 'Camera not found' }

PUT /api/cameras/:id
  Body: { name?, rtspUrl?, username?, password?, webrtcEnabled? }
  → 200: { success: true, data: Camera, restarted: boolean }
  → 404: { success: false, error: 'Camera not found' }

DELETE /api/cameras/:id
  → 200: { success: true, message: 'Camera removed' }
  → 404: { success: false, error: 'Camera not found' }

POST /api/cameras/:id/stream/reconnect
POST /api/cameras/:id/stream/start
POST /api/cameras/:id/stream/stop
  → 200: { success: true, message: string, cameraId: string }
  → 404: { success: false, error: 'Camera not found' }

POST /api/cameras/:id/ai/toggle
  → 200: { success: true, aiEnabled: boolean }
  → 404: { success: false, error: 'Camera not found' }
```

### 5.3 On-demand channel probe (2026-07-02, FR-CAM-080)

```
POST /api/cameras/probe-channels
  Body: { ip, httpPort?, httpType?, onvifPort?, onvifHttpsPort?, username?, password?, baseRtspUrl?, cameraId? }
  → 200: {
      success: true,
      maxChannel: number, supportSunapi: boolean, protocol: 'sunapi'|'onvif'|'none',
      profiles: NvrProfile[],                    // merged "winner" — unchanged, see FR-CAM-066
      sunapiMaxChannel: number, onvifMaxChannel: number|null,   // FR-CH-066
      sunapiProfiles: NvrProfile[], onvifProfiles: NvrProfile[],  // FR-CAM-080 — new
      sunapiRtspPort: number|null,                                 // FR-CAM-079 — new
    }
  → 400: { success: false, error: 'ip is required' }
```

Full detection-flow design (SUNAPI/ONVIF probe orchestration, credential-gating, discovery-cache reuse) lives in `docs/design/Design_Channel_Slot.md` §4.6 (the endpoint itself is shared by both the Channel Slot NVR-channel switcher and this document's URL-resolution work — see §3.1a above for what changed in this pass). `sunapiProfiles`/`onvifProfiles`/`sunapiRtspPort` are the new fields; `sunapiProfiles` is populated even when `baseRtspUrl` is omitted (uses `defaultSunapiRtspUrl()`, §3.1a) — previously this left `profiles` empty in that case whenever ONVIF didn't also report channels.

---

## 6. Sequence Diagrams

### 6.1 UDP Discovery Cycle

```
DiscoveryService        UDPDiscovery         Network           Socket.IO Clients
      │                      │                  │                      │
      │─ _runScan() ─────────>│                  │                      │
      │  emit scanning:true ──────────────────────────────────────────>│
      │                      │─ send broadcast →│                      │
      │                      │<── device resp ──│                      │
      │<── 'device' (raw) ───│                  │                      │
      │─ mapUDPDevice() ─────│                  │                      │
      │─ _upsert(device) ────│                  │                      │
      │─ _emit(merged) ───────────────────────────────────────────────>│
      │                      │  (repeat per device)                     │
      │<── 'done' ───────────│                  │                      │
      │─ _onProtocolDone() ──│                  │                      │
      │  (if both done)      │                  │                      │
      │  emit scanning:false ──────────────────────────────────────────>│
      │─ setTimeout(SCAN_INTERVAL) ────────────────────────────────────│
```

### 6.2 ONVIF Discovery with Enrichment

```
DiscoveryService     ONVIFDiscovery      Camera ONVIF     Socket.IO
      │                   │                   │               │
      │─ onvif.start() ──>│                   │               │
      │                   │─ Probe multicast →│               │
      │                   │<── ProbeMatch ────│               │
      │                   │─ _makeDevice() ───│               │
      │<── 'device' (basic)                   │               │
      │─ _upsert(basic)   │                   │               │
      │─ _emit(merged) ────────────────────────────────────>  │
      │                   │─ enrichDevice() async:            │
      │                   │    GetDeviceInformation ─────────>│
      │                   │<── Manufacturer/Model ────────────│
      │                   │    GetProfiles ──────────────────>│
      │                   │<── profile list ──────────────────│
      │                   │    GetStreamUri × N ─────────────>│
      │                   │<── rtspUrl × N ───────────────────│
      │<── 'device' (enriched)                                │
      │─ _upsert(enriched)│                   │               │
      │─ _emit(merged) ────────────────────────────────────>  │
```

### 6.3 Client Hydration on Connect

```
Browser         Socket.IO Server     DiscoveryService
    │                  │                   │
    │─ connect ────────>│                   │
    │                  │─ hydrate(socket) ─>│
    │                  │                   │─ for each in _known:
    │<── discovery:result { device } ───────│
    │<── discovery:result { device } ───────│ (one per device)
    │<── discovery:scanning { scanning, count }
    │                  │                   │
    │  (now has full device list)
```

---

## 7. Configuration & Environment

### 7.1 Discovery Service Constants

```javascript
const SCAN_TIMEOUT  = 10000; // ms — each scan window
const SCAN_INTERVAL = 15000; // ms — pause between scans
```

### 7.2 ONVIF Constants

```javascript
const ONVIF_MULTICAST_ADDR = '239.255.255.250';
const ONVIF_MULTICAST_PORT = 3702;
const PROBE_TIMEOUT  = 8000; // ms — wait for probe responses
const HTTP_TIMEOUT   = 4000; // ms — per SOAP call
```

### 7.3 WiseNet UDP Packet Specification

**프로토콜 파라미터 (SUNAPI IP Installer 원본과 일치)**

| Parameter | Value |
|---|---|
| Send target | `255.255.255.255` (broadcast) |
| Send port | `7701` — 카메라 수신 포트 |
| Receive port | `7711` — 서버 수신 포트 |
| Discovery 패킷 | 고정 바이너리 magic packet (257 bytes) |
| 기본 응답 | 261 bytes |
| 확장 응답 | ≥ 261 bytes (신형 펌웨어 포함) |

**레퍼런스:** `submodules/WiseNetChromeIPInstaller/scripts/socket.js` (Chrome 확장 원본 소스)  
**Node.js 포트:** `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js`

#### 응답 패킷 바이너리 레이아웃

기본 261 bytes (공통 필드):

| 오프셋 | 크기 | 필드명 | 타입 | 설명 |
|--------|------|--------|------|------|
| 0 | 1 | `nMode` | uint8 | 패킷 모드 |
| 1 | 18 | `chPacketId` | bytes | 패킷 식별자 |
| 19 | 18 | `chMac` | ASCII (null-term) | MAC 주소 (예: `00:09:18:XX:XX:XX`) |
| 37 | 16 | `chIP` | ASCII (null-term) | IP 주소 |
| 53 | 16 | `chSubnetMask` | ASCII (null-term) | 서브넷 마스크 |
| 69 | 16 | `chGateway` | ASCII (null-term) | 게이트웨이 IP |
| 85 | 20 | `chPassword` | ASCII (null-term) | 기본 패스워드 |
| 105 | 1 | `isSupportSunapi` | uint8 | `1`=SUNAPI 지원 |
| 106 | 2 | `nPort` | uint16 LE | RTSP 포트 (기본 554) |
| 108 | 1 | `nStatus` | uint8 | 장치 상태 |
| 109 | 10 | `chDeviceName` | ASCII (null-term) | 장치명 (짧은 버전) |
| 119 | 1 | `Reserved2` | bytes | 예약 |
| 120 | 2 | `nHttpPort` | uint16 LE | HTTP 포트 (기본 80) |
| 122 | 2 | `nDevicePort` | uint16 LE | Device 서비스 포트 |
| 124 | 2 | `nTcpPort` | uint16 LE | TCP(RTSP) 포트 |
| 126 | 2 | `nUdpPort` | uint16 LE | UDP 포트 |
| 128 | 2 | `nUploadPort` | uint16 LE | 업로드 포트 |
| 130 | 2 | `nMulticastPort` | uint16 LE | 멀티캐스트 포트 |
| 132 | 1 | `nNetworkMode` | uint8 | 네트워크 모드 |
| 133 | 128 | `DDNSURL` | ASCII (null-term) | DDNS 호스트명 |

확장 필드 (오프셋 261~, 패킷 길이 ≥ 261일 때):

| 오프셋 | 크기 | 필드명 | 타입 | 설명 |
|--------|------|--------|------|------|
| 261 | 32 | `alias` | ASCII (null-term) | 별칭 |
| 293 | 32 | `chDeviceNameNew` | ASCII (null-term) | 장치명 (전체) — UI 표시에 우선 사용 |
| 325 | 1 | `modelType` | uint8 | 장치 모델 ID |
| 326 | 2 | `version` | uint16 BE | 펌웨어 버전 |
| 328 | 1 | `httpType` | uint8 | `0`=HTTP, `1`=HTTPS |
| 329 | 1 | `Reserved3` | bytes | 예약 |
| 330 | 2 | `nHttpsPort` | uint16 LE | HTTPS 포트 (기본 443) |
| 332 | 1 | `noPassword` | uint8 | 비밀번호 없음 플래그 |

> **포트 엔디언**: 모든 포트 필드(version 제외)는 **리틀엔디언** (바이트 스왑 필요).  
> `version`만 빅엔디언 (스왑 없음).

#### 편의 URL 생성 (`discoveryService.js` `mapUDPDevice()`)

```
httpType === 0 → rtspUrl = rtsp://{chIP}:{nTcpPort}/profile1/media.smp
httpType === 1 → rtspUrl = rtsp://{chIP}:{nTcpPort}/profile1/media.smp
url           = {http|https}://{chIP}:{nHttpPort|nHttpsPort}
```

`/profile1/media.smp` 경로는 WiseNet Profile S 카메라 기본 스트림 경로입니다.

#### 원본 구현(SUNAPI)과 Node.js 포트 비교

| 항목 | SUNAPI 원본 (`scripts/socket.js`) | Node.js 포트 | 비고 |
|------|------|------|------|
| 포트 (7701/7711) | ✓ | ✓ | 동일 |
| Discovery 패킷 | ✓ | ✓ | 동일 hex blob |
| 응답 패킷 필드·오프셋 | ✓ | ✓ | 모든 필드 일치 |
| 포트 엔디언 (LE) | `ntohs(v, true)` | `r16(true)` | 동일 |
| `version` 엔디언 (BE) | `ntohs(v)` (big=undefined) | `r16(false)` | 동일 |
| DDNSURL 디코딩 | `Uint16Array` → UTF-16 | `latin1` | ASCII URL에서 동일 동작 |
| `chDeviceNameNew` 정리 | regex 제어문자 제거 | 첫 null-byte에서 절단 | 결과 동일 |

#### 서브모듈 vs 인라인 폴백

`server/src/utils/udpDiscovery.js`는 두 구현 중 가용한 것을 자동 선택합니다:

| 구현 | 파일 | Discovery 패킷 | 대상 카메라 |
|------|------|------|------|
| **서브모듈 (우선)** | `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js` | WiseNet 바이너리 magic packet | Hanwha/WiseNet 전용 |
| **인라인 폴백** | `server/src/utils/udpDiscovery.js` (`UDPDiscoveryFallback`) | ONVIF XML Probe | 범용 ONVIF — WiseNet 카메라 탐색 불가 |

> **서브모듈 초기화 필수:** WiseNet/Hanwha 카메라를 탐색하려면 반드시 실행:
> ```bash
> git submodule update --init submodules/WiseNetChromeIPInstaller
> ```
> 서브모듈이 없으면 폴백 사용 시 WiseNet 카메라가 응답해도 탐색되지 않습니다.

---

## 8. Error Handling

| Scenario | Handler | Behavior |
|---|---|---|
| UDP socket error | `udp.on('error', ...)` | Log warning; call `_onProtocolDone()`; UDP instance nulled |
| ONVIF socket error | `onvif.on('error', ...)` | Log warning; `_cleanup()`; emit `'error'`; call `_onProtocolDone()` |
| Device with empty IP | `mapUDPDevice()` | Return `null`; skipped in `_runScan()` |
| ONVIF SOAP auth required, no `credentials` given, or `Basic`-only challenge, or Digest retry also fails | `soapPost()` | Rejects with `AUTH_REQUIRED`; caught in `enrichDevice()` silently |
| ONVIF SOAP auth required (401), `Digest` challenge, `credentials` available | `soapPost()` | One authenticated retry with a computed RFC 7616 Digest response (2026-07-03, FR-CAM-090) — see §3.2a |
| ONVIF SOAP timeout | `soapPost()` | Rejects with `Timeout`; caught in `enrichDevice()` silently |
| ONVIF SOAP 301/302/307/308 redirect, same host | `soapPost()` | Follows once (2026-07-02, FR-CAM-076); a second redirect or a cross-host redirect is not followed |
| ONVIF GetVideoSources failure (any reason) | `enrichDevice()` | Caught silently; `videoSourceTokens=[]`, MaxChannel falls back to GetProfiles' SourceToken count (2026-07-02, FR-CAM-075) |
| On-demand probe: ONVIF answers on only one of HTTP/HTTPS | `enrichDeviceAutoScheme()` | Uses whichever scheme's result is non-empty (2026-07-02, FR-CAM-074); falls back to the HTTP result if neither is |
| SUNAPI MaxChannel auth required (401/403), `Basic` challenge or Digest retry also fails | `querySunapiMaxChannel()` | Resolves 0; default MaxChannel=1 retained |
| SUNAPI MaxChannel auth required (401/403), `Digest` challenge, credentials available | `querySunapiMaxChannel()` | One authenticated retry with a computed RFC 7616 Digest response (2026-07-02, FR-CAM-072) — see §"SUNAPI Digest auth" below |
| SUNAPI MaxChannel HTTPS self-signed certificate | `querySunapiMaxChannel()` | Connects anyway (`rejectUnauthorized: false`, 2026-07-02, FR-CAM-073) — auth (Basic/Digest) still applies on top |
| SUNAPI MaxChannel timeout / network error | `querySunapiMaxChannel()` | Resolves 0 within 2 s; default MaxChannel=1 retained |
| stray `_onProtocolDone()` after `stop()` | Check `!this._scanning` | Return immediately; prevents timer re-arm |
| `_pendingDone` underflow | Guard `_pendingDone <= 0` | Reset to 0; prevents negative count |
| Camera DB insert failure | `camerasRouter` catch | HTTP 500 with error message |
| Camera not found | `camerasRouter` checks | HTTP 404 with 'Camera not found' |
| Pipeline restart failure | `pipelineManager.startCamera()` | HTTP 500 via try/catch in PUT handler |
| SUNAPI CGI (`sunapiRequest()`) 301/302/307/308 redirect, same host | `sunapiRequest()` | Follows once (2026-07-02, FR-CAM-077); a second redirect or a cross-host redirect is not followed |
| SUNAPI RTSP port CGI (`network.cgi?msubmenu=portconf&action=view`) — no credentials, auth rejected, timeout, or `RTSPPort` missing/unparseable | `querySunapiRtspPort()` | Resolves `null`; caller (`defaultSunapiRtspUrl()`) falls back to SUNAPI default port 554 (2026-07-02, FR-CAM-079) |
| `channelRtspUrl()` — `baseUrl` matches neither the `/profileN/` nor `/N/H.264/` convention | `channelRtspUrl()` | Returns `baseUrl` unchanged (no-op, unresolved) — unchanged contract, now checked against two shapes instead of one (2026-07-02, FR-CAM-078) |
| UDP discovery extended fields (`alias`/`chDeviceNameNew`/`modelType`/...) — packet too short for the full block | `_parseResponse()` | Each field left `undefined` from the first one that doesn't fit onward (2026-07-02, FR-CAM-081) — previously silently defaulted to `0`/`''`, indistinguishable from real data |
| **Duplicate IP on the LAN** — two physical devices answer WiseNet UDP discovery from the same IP (observed live: 192.168.214.37, two different MACs/models) | N/A — network misconfiguration, not a code defect | Not auto-detected or resolved by software; whichever device the OS's ARP cache currently resolves that IP to is the one any HTTP-based query (SUNAPI CGI, ONVIF) actually reaches, which can silently change between requests. Diagnose via a raw UDP discovery capture (multiple distinct `chMac` values for one `chIP`) and `arp -n <ip>`/`ip neigh show <ip>`; fix by assigning the conflicting device a unique IP — see `docs/ops/Camera_Discovery_Guide.md` §5 |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Camera Discovery |
| 1.1 | 2026-06-23 | LTS Engineering Team | §7.3 WiseNet UDP 패킷 바이너리 레이아웃 상세화 — SUNAPI IP Installer 원본과 1:1 비교, 서브모듈 vs 인라인 폴백 차이점, 서브모듈 초기화 주의사항 추가 |
| 1.2 | 2026-06-23 | LTS Engineering Team | MaxChannel 지원 추가 — ONVIF NVR profiles.length 기반 MaxChannel 도출, SUNAPI best-effort 쿼리, mergeDevices max 병합, DiscoveredCameraPanel 채널 선택 UI |
| 1.3 | 2026-07-02 | LTS Engineering Team | §3.1 SUNAPI MaxChannel 쿼리 엔드포인트 정정 — 존재하지 않는 CGI 경로(`media.cgi?msubmenu=channellist`, `system.cgi?msubmenu=systeminfo`) 대신 실제 엔드포인트 `GET /stw-cgi/attributes.cgi/attributes` (XML, group=System/category=Limit/attribute=MaxChannel) 사용하도록 수정 |
| 1.4 | 2026-07-02 | LTS Engineering Team | §3.1 "SUNAPI Digest auth" 추가, §8 오류 처리표 갱신 — `querySunapiMaxChannel()`가 Basic만 지원해 Digest를 요구하는 SUNAPI 펌웨어에서 정상 자격증명도 401로 거부되던 문제 수정 (FR-CAM-072), RFC 7616 Digest 재시도 추가 |
| 1.5 | 2026-07-02 | LTS Engineering Team | §3.1 "SUNAPI HTTPS self-signed certificate" 추가, §8 오류 처리표 갱신 — `querySunapiMaxChannel()`가 HTTPS 접속 시 자체 서명 인증서를 거부하던 문제 수정 (FR-CAM-073, `onvifDiscovery.js`는 이미 동일 처리 중이었음) |
| 1.6 | 2026-07-02 | LTS Engineering Team | §3.1/§3.2/§8 갱신 — MaxChannel/channelIndex를 GetProfiles 대신 GetVideoSources 기반으로 우선 도출(FR-CAM-075), 온디맨드 probe가 ONVIF HTTP/HTTPS 양쪽을 병렬 시도(`enrichDeviceAutoScheme()`, FR-CAM-074), ONVIF SOAP 클라이언트가 동일 호스트 리다이렉트 1회 추적(FR-CAM-076); §"MaxChannel enrichment flow" §1의 오래된 `profiles.length` 서술 정정 |
| 1.7 | 2026-07-02 | LTS Engineering Team | §3.1a 신규 추가 — `channelRtspUrl()`이 `/profileN/`·`/N/H.264/` 두 SUNAPI 컨벤션을 모두 인식하도록 확장(FR-CAM-078, 실 DB 조사로 후자가 이 네트워크 다수임을 확인), `querySunapiRtspPort()` 신규 추가(FR-CAM-079, `network.cgi?msubmenu=portconf&action=view` 평문 응답, 192.168.214.32/.37 실측 검증 — .32는 저장된 rtspUrl 포트(10030)와 CGI 확인 포트(554)가 불일치함을 발견), `sunapiRequest()`도 동일 호스트 리다이렉트 1회 추적(FR-CAM-077, FR-CAM-076의 SUNAPI측 대응); §5.3 신규 추가 — `probe-channels` 응답 필드 문서화(`sunapiProfiles`/`onvifProfiles`/`sunapiRtspPort`, FR-CAM-080); §8 오류 처리표 3행 추가 |
| 1.8 | 2026-07-02 | LTS Engineering Team | §3.1b 신규 추가 — 벤더 SUNAPI IP Installer 스펙 §3.4.2를 사용자가 직접 제공해 UDP Discovery의 MaxChannel/Nonce 조건부 필드(nVersion 0x08 지원 기기 한정)를 실측 검증(192.168.214.37 두 대 raw 패킷 byte-diff — 262바이트 고정 응답으로 해당 필드 자체가 없음을 확인), 그 과정에서 발견한 확장 필드 파싱 bounds-check 버그 수정(`modelType` 등이 짧은 패킷에서 거짓 `0` 반환하던 문제, FR-CAM-081), `DeviceType` 사람이 읽을 수 있는 라벨 필드 신규 노출 및 Found 패널 표시; §8 오류 처리표에 2행 추가(bounds-check 수정, 중복 IP 트러블슈팅) |
| 1.9 | 2026-07-02 | LTS Engineering Team | §3.1c 신규 추가 — 벤더 스펙 §3.4 "IP Scan for SUNAPI" 정식 문서화, `UDPDiscoveryFallback`(`server/src/utils/udpDiscovery.js`)이 그동안 ONVIF XML 전용 스텁이었던 것을 실제 WiseNet 바이너리 프로토콜 구현으로 교체(서브모듈과 byte-for-byte parity, FR-CAM-082) — 서브모듈 미초기화 시 SUNAPI 카메라를 아예 탐색 못 하던 조용한 결함 수정, 구현 중 `ntohs()` big/little-endian 플래그 역혼동 버그도 발견·수정. nMode=6(SCAN_EX) 요청 옵코드 실측 조사 결과(정보성, 채택 안 함) 기록 |
| 1.10 | 2026-07-03 | LTS Engineering Team | §3.1d 신규 추가 — Annex A 구조체 대조로 발견된 `supported_protocol`/`no_password` 오프셋 버그 수정(FR-CAM-083), 그리고 벤더 스펙 Table 1/2의 `nMode` enum 전체를 분석해 `_parseResponse()`를 2단계 dispatch(non-scan 모드 즉시 `null` 반환 → scan 모드만 기존 파싱 진행, 확장 필드 블록은 `nMode===12`로 게이트)로 재구성(FR-CAM-084) — 이전에는 확장 필드 존재 여부를 순전히 남은 바이트 수로만 판단했음 |
| 1.11 | 2026-07-03 | LTS Engineering Team | §3.1e 신규 추가 — `request.js`(`UdpRequest`)/`response.js`(`UdpResponse`) 클래스가 §3.2/§3.3의 332바이트 `DATAPACKET_V4_EXT` 구조체를 필드 테이블 하나로 공유 구현; `_sendDiscovery()`의 요청 옵코드를 `nMode=1`(레거시, 이제 주석 처리로 보존)에서 `nMode=6`(`DEF_REQ_SCAN_EXT`, 스펙 문서화값)로 전환 — §3.1c의 "채택 안 함" 결정을 뒤집음; 소켓 `'message'` 핸들러가 `UdpResponse.parse()`로 `nMode=12`(`DEF_RES_SCAN_EXT`) 응답 수신을 독립 검증하는 `'scanExtConfirmed'` 이벤트 추가 |
| 1.12 | 2026-07-03 | LTS Engineering Team | §3.1e 갱신 — `UdpResponse.parse()`를 `_parseResponse()`와 실측 비교해 §3.2/§3.3 필드 테이블이 Annex A 대비 누락한 `reserved2`(chDeviceName 뒤)/`reserved3`(nHttpMode 뒤) 1바이트씩을 발견·수정(FIELDS 332→334바이트) — 수정 전에는 nHttpPort 이후 모든 필드가 1바이트씩 밀려 그럴듯하지만 잘못된 값(예: nHttpPort=20596)을 반환했음; 두 파서가 실제 캡처 패킷과 라이브 네트워크 트래픽 모두에서 필드 단위로 완전히 일치함을 검증; `UdpResponse.toString()`/`parse()` 자동 콘솔 로깅 추가; 실제 카메라 6대 대상 `nMode=6→12` 왕복 라이브 검증 완료 기록 |
| 1.13 | 2026-07-03 | LTS Engineering Team | §3.1f 신규 추가 — `protocol.js` 신설(포트·FIELDS·NMODE 단일 소스화, `NVERSION`/`NETWORK_MODE`/`DEVICE_TYPE`/`HTTP_MODE`/`SUPPORTED_PROTOCOL`/`PASSWORD_STATUS` 신규 상수); `server/src/utils/udpDiscovery.js`의 서브모듈 탐지 로직·인라인 폴백(`UDPDiscoveryFallback`) 완전 제거, `wisenet-chrome-ip-installer` npm `optionalDependencies`(WiseNetChromeIPInstaller 저장소 루트 `package.json` 신설로 설치 가능하게 함) 재노출로 대체; RTSP 포트 필드 버그 수정(`nTcpPort`/`nPort`는 RTSP 포트가 아님 — SUNAPI 표준 554로 고정, `docs/ops/Camera_Discovery_Guide.md` §3의 기존 불일치 기록의 근본 원인으로 추정); SUNAPI CGI Digest Auth 감지 정규식을 단어 경계 매칭으로 보강(`buildDigestAuthHeader()`도 콤바인드 헤더 대응); `MaxChannel`/`Nonce` 조건부 필드·`nVersion` 엔디언 추가 조사(둘 다 실측 증거 불충분으로 미채택, 근거 기록) |
| 1.14 | 2026-07-03 | LTS Engineering Team | §3.2a 신규 추가 — ONVIF SOAP 클라이언트(`soapPost()`)가 HTTP Basic 시도 후 Digest 챌린지 시 재시도하도록 확장(FR-CAM-090, FR-CAM-072/089의 ONVIF측 대응); `buildDigestAuthHeader()`/`challengesDigest()`를 `server/src/utils/digestAuth.js`로 이동해 `discoveryService.js`와 공유(`discoveryService.js`는 하위호환 re-export 유지); `enrichDevice()`/`enrichDeviceAutoScheme()`/`ONVIFDiscovery` 생성자에 `credentials`/`username`+`password` 옵션 추가, `POST /api/cameras/probe-channels`가 SUNAPI 프로브에 쓰던 `effectiveUsername`/`effectivePassword`를 ONVIF 프로브에도 전달하도록 수정; §8 오류 처리표 갱신; `Design_Channel_Slot.md` §4.6f/§7의 "ONVIF는 무인증" 관련 서술을 HTTP Basic/Digest 지원 반영으로 갱신(SOAP 레벨 WS-Security는 여전히 미구현임을 명시); TC-H-037~039b 추가(RFC 7616 검증 포함 mock 서버) |
| 1.15 | 2026-07-03 | LTS Engineering Team | §3.1h 신규 추가 — UDP Discovery `MaxChannel`을 확장 스캔 응답(`nMode=12`, DEF_RES_SCAN_EXT)의 `nMulticastPort` 값에서 도출(FR-CAM-091) — §3.1f가 미구현으로 남겨둔 부분, 벤더 스펙의 `nVersion 0x08` 조건 대신 이 네트워크에서 검증 가능한 `nMode` 조건 사용. `UdpResponse`(response.js)에 `MaxChannel` getter, `_parseResponse()`(udpDiscovery.js)가 `nMaxChannel`로 노출(다른 raw 숫자 필드와 동일한 `n` 접두사), `mapUDPDevice()`가 이전엔 존재하지 않던 `raw.MaxChannel`을 참조하던 자리를 실제로 채워지는 `raw.nMaxChannel`로 갱신. §3.1f의 "MaxChannel/Nonce 미구현" 단락도 갱신(MaxChannel만 구현됨, Nonce는 계속 미구현); TC-H-040 추가(합성 픽스처로 파싱 메커니즘 검증 — 진짜 nMode=12 기기는 여전히 미포착) |
