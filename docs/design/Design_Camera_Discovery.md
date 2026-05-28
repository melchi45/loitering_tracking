# DESIGN DOCUMENT
# Camera Discovery & Network Search Subsystem

| | |
|---|---|
| **Document ID** | DESIGN-LTS-CAM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
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
│   │       GetProfiles → GetStreamUri (up to 4 profiles)          │
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
```

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
3. GetProfiles at mediaUrl → parse <Profiles> blocks
   → per profile: token, name, encoding, width, height, fps
4. GetStreamUri for each profile (max 4)
   → rtspUrl per profile; first non-empty = device rtspUrl
5. Fallback: rtspUrl = "rtsp://<ip>:554/"
```

**SOAP helper `soapPost(xaddr, body)`:**
- Uses `http` or `https` module based on URL scheme.
- 4-second timeout (`HTTP_TIMEOUT`).
- Returns 401 as `AUTH_REQUIRED` error.
- `rejectUnauthorized: false` (self-signed certificates supported).

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
  SupportSunapi:  boolean;
  SupportOnvif:   boolean;
  SupportPTZ?:    boolean;
  rtspUrl?:       string;
  profiles?:      OnvifProfile[];
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

| Parameter | Value |
|---|---|
| Send target | 255.255.255.255 (broadcast) |
| Send port | 7701 |
| Receive port | 7711 |
| Packet size | 160 bytes (fixed magic packet) |
| Extended response | ≥ 261 bytes |

---

## 8. Error Handling

| Scenario | Handler | Behavior |
|---|---|---|
| UDP socket error | `udp.on('error', ...)` | Log warning; call `_onProtocolDone()`; UDP instance nulled |
| ONVIF socket error | `onvif.on('error', ...)` | Log warning; `_cleanup()`; emit `'error'`; call `_onProtocolDone()` |
| Device with empty IP | `mapUDPDevice()` | Return `null`; skipped in `_runScan()` |
| ONVIF SOAP auth required | `soapPost()` | Rejects with `AUTH_REQUIRED`; caught in `enrichDevice()` silently |
| ONVIF SOAP timeout | `soapPost()` | Rejects with `Timeout`; caught in `enrichDevice()` silently |
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
