# DESIGN DOCUMENT
# WebRTC Media Gateway

| | |
|---|---|
| **Document ID** | DESIGN-LTS-WRTC-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_WebRTC_Media_Gateway.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Server-Side Design](#3-server-side-design)
4. [Client-Side Design](#4-client-side-design)
5. [Data Model](#5-data-model)
6. [API Design](#6-api-design)
7. [Sequence Diagrams](#7-sequence-diagrams)
8. [Configuration & Environment](#8-configuration--environment)
9. [Error Handling](#9-error-handling)

---

## 1. Architecture Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                    CAMERA (RTSP source)                            │
│             rtsp://<cam-ip>:554/stream                            │
└──────────────────────┬────────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────────┐
│                     SERVER (Node.js)                               │
│                                                                     │
│  RtpIngestion (per camera)                                         │
│   └─ FFmpeg (dual output)                                          │
│       ├─ Output A: RTP H.264 → 127.0.0.1:4000N (PlainTransport)  │
│       ├─ Output B: RTP Opus → 127.0.0.1:4000N+2 (PlainTransport) │
│       └─ Output C: JPEG pipe → RTSPCapture → AI inference          │
│                                                                     │
│  WebRTCGateway (singleton)                                         │
│   ├─ mediasoup Worker (PID, rtcMinPort–rtcMaxPort)                │
│   ├─ Router per cameraId (mediaCodecs: H264, Opus, PCMU, PCMA)    │
│   ├─ PlainTransport[video] (comedia=true) → VideoProducer          │
│   ├─ PlainTransport[audio] (comedia=true) → AudioProducer          │
│   └─ _producers Map: cameraId → { video, audio }                  │
│                                                                     │
│  webrtcSignaling.js (Socket.IO event handlers)                    │
│   ├─ webrtc:getCapabilities → router.rtpCapabilities               │
│   ├─ webrtc:createTransport → WebRtcTransport (ICE + DTLS params) │
│   ├─ webrtc:connectTransport → transport.connect(dtls)             │
│   ├─ webrtc:consume → paused Consumer[video + audio]              │
│   ├─ webrtc:resumeConsumer → consumer.resume()                    │
│   └─ webrtc:leave → transport.close() + consumer.close()          │
│                                                                     │
│  getAllListenIps()                                                  │
│   └─ SERVER_IP env or auto-detect (skip docker/veth/lo)           │
└──────────────────────┬────────────────────────────────────────────┘
                       │ ICE + DTLS-SRTP
                       │ UDP 40000–49999
┌──────────────────────▼────────────────────────────────────────────┐
│                    BROWSER (mediasoup-client)                       │
│                                                                     │
│  useWebRTC hook                                                     │
│   ├─ Device.load(routerRtpCapabilities)                            │
│   ├─ device.createRecvTransport(params + iceServers)              │
│   ├─ transport.consume(videoParams) → track → MediaStream          │
│   ├─ transport.consume(audioParams) → track → MediaStream          │
│   └─ DataChannel → dispatch to Zustand store                       │
│                                                                     │
│  CameraView.tsx                                                     │
│   ├─ <video> srcObject = MediaStream (WebRTC)                      │
│   └─ <canvas> overlay for bounding boxes                           │
└───────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── api/
│   │   │   └── cameras.js                 # /api/webrtc/stats planned
│   │   ├── services/
│   │   │   ├── webrtcGateway.js           # WebRTCGateway singleton
│   │   │   ├── rtpIngestion.js            # FFmpeg dual-output + PlainTransports
│   │   │   ├── pipelineManager.js         # Orchestrates RtpIngestion + WebRTC
│   │   │   └── rtspCapture.js             # RETAINED: JPEG pipe for AI inference
│   │   └── socket/
│   │       ├── streamHandler.js           # RETAINED: Socket.IO JPEG/detection events
│   │       └── webrtcSignaling.js         # capabilities-exchange protocol
│   └── package.json                       # mediasoup ^3.14 dependency
│
├── client/
│   └── src/
│       ├── hooks/
│       │   ├── useWebRTC.ts               # mediasoup-client Device lifecycle
│       │   └── useCamera.ts              # delegates to useWebRTC when webrtcEnabled
│       └── components/
│           ├── CameraView.tsx             # <video> WebRTC + canvas overlay
│           └── VideoAnalyticsTab.tsx      # WebRTC enable/disable toggle
│
├── docs/
│   ├── srs/SRS_WebRTC_Media_Gateway.md
│   ├── design/Design_WebRTC_Media_Gateway.md  ← this file
│   └── tc/TC_WebRTC_Media_Gateway.md
│
└── test/
    └── api/
        └── webrtc_gateway.test.js
```

---

## 3. Server-Side Design

### 3.1 WebRTCGateway (`server/src/services/webrtcGateway.js`)

**Responsibilities:**
- Create and manage the mediasoup Worker
- Provide per-camera Router instances (with creation locking)
- Register and retrieve video/audio Producers per camera
- Export `getListenIps()` using `SERVER_IP` or auto-detection

**State fields:**

| Field | Type | Purpose |
|---|---|---|
| `enabled` | boolean | True if Worker is alive |
| `_worker` | mediasoup.Worker or null | Single worker process |
| `_routers` | `Map<cameraId, Router>` | Per-camera routing |
| `_producers` | `Map<cameraId, {video, audio}>` | Video/audio Producer refs |
| `_routerPending` | `Map<cameraId, Promise<Router>>` | Creation lock (concurrent callers share one promise) |

**Key methods:**

| Method | Signature | Description |
|---|---|---|
| `init()` | `async () → void` | Create Worker; set `enabled = true` |
| `getOrCreateRouter(cameraId)` | `async (string) → Router` | Create or reuse Router; uses `_routerPending` lock |
| `getRouter(cameraId)` | `(string) → Router|null` | Fast-path lookup |
| `deleteRouter(cameraId)` | `(string) → void` | Close Router; clear producers |
| `registerProducers(id, video, audio)` | `(string, Producer, Producer) → void` | Store Producers |
| `unregisterProducers(cameraId)` | `(string) → void` | Remove Producers |
| `getProducers(cameraId)` | `(string) → {video,audio}` | Get Producers (nulls if absent) |
| `getListenIps()` | `() → ListenIp[]` | Return `[{ ip: '0.0.0.0', announcedIp }]` |
| `close()` | `async () → void` | Close all Routers + Worker |

**`getAllListenIps()` logic:**

```javascript
if (process.env.SERVER_IP) {
  return [{ ip: '0.0.0.0', announcedIp: SERVER_IP }];
}
// Auto-detect:
// 1. Iterate os.networkInterfaces()
// 2. Skip: docker, br-, virbr, veth, lo, tun, tap, dummy, bond, ovs
// 3. Take FIRST IPv4 per physical interface only
// 4. Separate private (RFC1918) vs public IPs
// 5. Return private IPs if any; else public IPs; else 127.0.0.1 + warn
```

### 3.2 webrtcSignaling.js Socket.IO Handlers

**Signaling sequence state per socket:cameraId pair:**

```
Socket connects
  │
  ├─ webrtc:getCapabilities
  │     → getOrCreateRouter(cameraId)
  │     ← router.rtpCapabilities
  │
  ├─ webrtc:createTransport
  │     → Check for stale transport (same socket:cam) → close it
  │     → router.createWebRtcTransport({ listenIps, enableUdp, enableTcp, preferUdp })
  │     ← { id, iceParameters, iceCandidates, dtlsParameters, sctpParameters }
  │
  ├─ webrtc:connectTransport
  │     → transport.connect({ dtlsParameters })
  │     ← ack
  │
  ├─ webrtc:consume
  │     → transport.consume({ producerId: videoProducer.id, rtpCapabilities })
  │     → transport.consume({ producerId: audioProducer.id, rtpCapabilities })
  │     ← { videoConsumer: params, audioConsumer: params }
  │
  ├─ webrtc:resumeConsumer
  │     → consumer.resume()
  │     ← ack (SRTP data begins)
  │
  └─ webrtc:leave OR socket disconnect
        → consumer[video].close()
        → consumer[audio].close()
        → transport.close()
```

**Stale transport cleanup:**
```javascript
// Before creating new transport for socket+camera:
const key = `${socket.id}:${cameraId}`;
const existingTransport = socketTransports.get(key);
if (existingTransport && !existingTransport.closed) {
  existingTransport.close();
}
```

### 3.3 mediasoup Media Codecs

```javascript
const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'audio', mimeType: 'audio/PCMU', clockRate: 8000 },
  { kind: 'audio', mimeType: 'audio/PCMA', clockRate: 8000 },
  {
    kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
];
```

---

## 4. Client-Side Design

### 4.1 useWebRTC Hook (`client/src/hooks/useWebRTC.ts`)

**State machine:**

```
idle
  → webrtcEnabled = true + cameraId provided
  → 'connecting'
      getCapabilities → device.load()
      createTransport → RecvTransport created
      connectTransport → DTLS fingerprint sent
      consume → Consumers created
      resumeConsumer → SRTP starts
  → 'connected'
      <video>.srcObject = MediaStream
  → 'failed' (ICE failure or 30s timeout)
      → show Reconnect button
      → user clicks Reconnect → retry() → 'connecting'
  → 'disconnected' (camera disconnect)
      → exponential backoff reconnect
```

**Key design points:**
- 30-second connection timeout: if `connectionState` never reaches `'connected'`, transition to `'failed'`.
- `retry()` function re-runs the full capabilities-exchange sequence from `'idle'`.
- `getIceServers()` called from `useWebRTCConfigStore` before transport creation.

### 4.2 CameraView.tsx Component

```
CameraView
  ├─ <video autoPlay muted playsInline>   ← WebRTC MediaStream
  ├─ <canvas>                              ← Bounding box overlay (preserved from JPEG path)
  ├─ Reconnect button (shown when failed)
  ├─ Mute button (client-side track.enabled = false)
  └─ Top-right overlay container (absolute top-2 right-2, flex-col)
       ├─ Row 1: [WebRTC badge] [ICE button]   ← WebRTC mode only
       └─ Row 2: [Zone button]                 ← Stacked below badge row
```

#### 4.2.1 Overlay Button Layout (v1.1 fix)

**문제**: WebRTC 카메라에서 `WebRTC badge + ICE` 버튼이 `absolute top-2 right-12`에, `Zone` 버튼이 `absolute top-2 right-2`에 독립 배치되어 멀티캠 환경(셀이 좁을 때)에서 두 버튼이 겹침.

**수정**: 두 버튼 그룹을 하나의 `absolute top-2 right-2 flex flex-col` 컨테이너로 통합.

```
┌─────────────────────────────────┐
│                    [WebRTC][ICE]│  ← Row 1: badge + ICE (WebRTC only)
│                         [Zone 2]│  ← Row 2: Zone button (stacked below)
│                                 │
│  ● CameraName  LIVE             │
└─────────────────────────────────┘
```

- JPEG(비WebRTC) 카메라: Zone 버튼만 `absolute top-2 right-2`에 단독 표시  
- WebRTC 카메라: `flex-col` 컨테이너로 묶어 ICE 버튼과 Zone 버튼이 세로로 정렬됨  
- `z-index: 10` 적용으로 캔버스 오버레이 위에 렌더링

---

## 5. Data Model

### 5.1 WebRTC Session (in-memory, per socket:camera)

```typescript
interface WebRtcSession {
  socketId:    string;
  cameraId:    string;
  transport:   WebRtcTransport;
  consumers:   { video: Consumer | null; audio: Consumer | null };
}
```

### 5.2 DataChannel Message Schemas

**detections** (unreliable, `maxRetransmits: 0`):
```json
{ "type": "detections", "cameraId": "uuid", "frameId": 1234,
  "timestamp": 1716134400000, "frameWidth": 1920, "frameHeight": 1080,
  "objects": [{ "trackId": 7, "classId": 0, "label": "person",
    "confidence": 0.91, "bbox": { "x": 120, "y": 80, "w": 64, "h": 180 },
    "loiteringSeconds": 12.4,
    "attributes": { "faceId": null, "clothColor": "blue", "hat": false, "mask": false } }] }
```

**loitering** (reliable, ordered):
```json
{ "type": "loitering", "cameraId": "uuid", "trackId": 7, "zoneId": "zone-uuid",
  "durationSeconds": 30.0, "thumbnail": "base64-or-null", "timestamp": 1716134400000 }
```

**stream-stats** (every 5s, reliable):
```json
{ "type": "stream-stats", "cameraId": "uuid",
  "videoBitrateKbps": 2048, "audioBitrateKbps": 32,
  "videoPacketLossRate": 0.001, "rttMs": 4.2, "timestamp": 1716134400000 }
```

---

## 6. API Design

### 6.1 REST Endpoints

```
GET /api/webrtc/stats
  Response 200:
  {
    "cameras": {
      "<cameraId>": {
        "producerVideo": { "bitrate": 2048000, "packetsLost": 0 },
        "producerAudio": { "bitrate": 32000 },
        "consumers": 2,
        "avgRttMs": 4.2
      }
    }
  }

GET /api/webrtc/capabilities
  Response 200: mediasoup Router RTP capabilities object
  (used by mediasoup-client device.load())
```

### 6.2 Socket.IO Signaling Events

```
webrtc:getCapabilities   { cameraId }                → router.rtpCapabilities
webrtc:createTransport   { cameraId }                → { id, iceParameters, iceCandidates, dtlsParameters, sctpParameters }
webrtc:connectTransport  { transportId, dtlsParameters } → ack
webrtc:consume           { cameraId, transportId, rtpCapabilities } → { videoConsumer, audioConsumer }
webrtc:resumeConsumer    { consumerId }              → ack
webrtc:leave             { cameraId }                → ack
```

---

## 7. Sequence Diagrams

### 7.1 Camera Pipeline Start (Server-Side)

```
PipelineManager          RtpIngestion          WebRTCGateway       FFmpeg
     │                        │                     │                │
     │─ startCamera(cam) ─────>│                     │                │
     │                        │─ getOrCreateRouter ─>│                │
     │                        │<── Router ───────────│                │
     │                        │─ createPlainTransport ─────────────>  │
     │                        │─ createProducer(video/audio) ─────── │
     │                        │─ registerProducers ──>│               │
     │                        │─ spawn FFmpeg ──────────────────────>│
     │                        │   (dual output: RTP + JPEG)           │
     │                        │<── PlainTransport auto-connect ───────│
     │                        │   (comedia=true, first RTP pkt)       │
     │<── pipeline ready ──────│                     │                │
```

### 7.2 Browser WebRTC Connection

```
Browser (useWebRTC)      Socket.IO            webrtcSignaling     WebRTCGateway
      │                     │                      │                   │
      │─ getCapabilities ───>│                      │                   │
      │                     │──────────────────────>│─ getOrCreateRouter│
      │<── rtpCapabilities ─│                      │<── Router ────────│
      │─ device.load() ─────│                      │                   │
      │─ createTransport ───>│                      │                   │
      │                     │──────────────────────>│─ createWebRtcTransport
      │<── transport params ─│                      │                   │
      │─ connectTransport ──>│                      │                   │
      │                     │──────────────────────>│─ transport.connect(dtls)
      │  [ICE + DTLS handshake proceeds]            │                   │
      │─ webrtc:consume ────>│                      │                   │
      │                     │──────────────────────>│─ transport.consume(video)
      │                     │                      │─ transport.consume(audio)
      │<── Consumer params ──│                      │                   │
      │─ resumeConsumer ────>│                      │                   │
      │                     │──────────────────────>│─ consumer.resume()
      │<── SRTP data ────────────────────────────────────────────────── │
      │  <video> renders     │                      │                   │
```

---

## 8. Configuration & Environment

### 8.1 mediasoup Worker Options

```javascript
{
  logLevel:   'warn',
  logTags:    ['rtp', 'srtp'],
  rtcMinPort: parseInt(process.env.WEBRTC_PORT_MIN || '40000'),
  rtcMaxPort: parseInt(process.env.WEBRTC_PORT_MAX || '49999'),
}
```

### 8.2 WebRtcTransport Options

```javascript
{
  listenIps:  gateway.getListenIps(),   // [{ ip: '0.0.0.0', announcedIp: SERVER_IP }]
  enableUdp:  true,
  enableTcp:  true,
  preferUdp:  true,
}
```

### 8.3 PlainTransport Options (RTP Ingestion)

```javascript
{
  listenIp: { ip: '127.0.0.1' },
  rtcpMux:  false,
  comedia:  true,   // auto-connect on first RTP packet received
}
```

### 8.4 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WEBRTC_ENABLED` | `false` | Enable WebRTC path |
| `SERVER_IP` | (auto) | Announced IP in ICE candidates |
| `WEBRTC_PORT_MIN` | `40000` | Lower bound of mediasoup RTP port pool |
| `WEBRTC_PORT_MAX` | `49999` | Upper bound of mediasoup RTP port pool |

---

## 9. Error Handling

| Scenario | Handler | Behavior |
|---|---|---|
| `mediasoup` not installed | `webrtcGateway.init()` | Log warning; `enabled = false`; WebRTC gracefully disabled |
| Worker process dies | `worker.on('died')` | Log critical; `enabled = false` |
| `SERVER_IP` not set | `getAllListenIps()` | Auto-detect with warning; fallback to `127.0.0.1` |
| Port pool exhausted | `createPlainTransport()` | Error propagated to `RtpIngestion`; pipeline fails with log |
| `webrtc:getCapabilities` with no router | `webrtcSignaling.js` | `getOrCreateRouter()` creates one lazily |
| ICE connection failure | `transport.iceState === 'failed'` | Client `useWebRTC` transitions to `'failed'`; shows Reconnect |
| 30s connection timeout | `useWebRTC` timeout | Transition to `'failed'`; call `retry()` on button click |
| Stale transport on reconnect | `webrtcSignaling.js` | Close existing before creating new (keyed by `socket:cam`) |
| Consumer creation fails | `webrtc:consume` handler | Emit error event to client; client transitions to `'failed'` |
| Camera disconnect | `RtpIngestion` | Producers closed; Consumers receive `producerclose` event; client triggers reconnect |
| DataChannel malformed JSON | `useWebRTC` handler | `try/catch`; log warning; do not dispatch to Zustand |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for WebRTC Media Gateway |
| 1.1 | 2026-05-29 | LTS Engineering Team | §4.2 CameraView overlay layout fix — WebRTC ICE button and Zone button overlap in multi-camera grid (resolved by merging into shared `flex-col` container) |
