# DESIGN DOCUMENT
# Camera Discovery & Network Search Subsystem

| | |
|---|---|
| **Document ID** | DESIGN-LTS-CAM-01 |
| **Version** | 1.6 |
| **Status** | Active |
| **Date** | 2026-06-23 |
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

**`enrichDevice(ip, xaddr)` async flow:**

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

`enrichDeviceAutoScheme(ip, { onvifPort, onvifHttpsPort })` (2026-07-02, FR-CAM-074) — a second export, used only by `POST /api/cameras/probe-channels` (Channel Slot feature; `Design_Channel_Slot.md` §4.6), which has no device-asserted XAddr and must guess the scheme. Runs `enrichDevice()` on both `http://ip:onvifPort` (default 80) and `https://ip:onvifHttpsPort` (default 443) in parallel and returns whichever produced a non-empty result (Manufacturer/Model/profiles/MaxChannel>1), falling back to the HTTP result unchanged if neither did. `ONVIFDiscovery`'s own WS-Discovery scan below does **not** use this — its XAddr comes straight from the device's ProbeMatch response, so the scheme is already known.

**SOAP helper `soapPost(xaddr, body, redirectsLeft = 1)`:**
- Uses `http` or `https` module based on URL scheme.
- 4-second timeout (`HTTP_TIMEOUT`).
- Returns 401 as `AUTH_REQUIRED` error.
- `rejectUnauthorized: false` (self-signed certificates supported).
- **Same-host redirect following** (2026-07-02, FR-CAM-076): a `301`/`302`/`307`/`308` response whose `Location` header resolves to the *same* hostname as the request is followed, bounded to one hop — observed live: 192.168.214.37 force-redirects every ONVIF SOAP call on port 80 to HTTPS via nginx, and without this, every call there failed with a bare `HTTP 301`. A `Location` pointing at a **different** hostname is never followed (SSRF hardening — an ONVIF device's own redirect is trusted only to change its own scheme/port, not to redirect the request to an arbitrary third host).

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
| ONVIF SOAP auth required | `soapPost()` | Rejects with `AUTH_REQUIRED`; caught in `enrichDevice()` silently |
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
