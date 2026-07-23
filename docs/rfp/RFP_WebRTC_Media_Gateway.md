# RFP — WebRTC Media Gateway (Video / Audio / Application RTP)
**Document ID**: LTS-2026-003  
**Version**: 1.1  
**Date**: 2026-05-19 (rev 2026-05-22)  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Implemented — Phase 1 & 2 complete

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-05-19 | Initial draft — SDP offer/answer signaling model |
| 1.1 | 2026-05-22 | §7.1 corrected to reflect mediasoup-client native protocol; §3.2 component status updated; §7.3 SERVER_IP guidance strengthened; §8.3 comedia=true noted; §15 Troubleshooting added |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Problem Statement — Current Architecture Limitations](#2-problem-statement--current-architecture-limitations)
3. [Proposed Architecture](#3-proposed-architecture)
4. [Technology Selection](#4-technology-selection)
5. [Functional Requirements](#5-functional-requirements)
6. [Non-Functional Requirements](#6-non-functional-requirements)
7. [API & Signaling Specification](#7-api--signaling-specification)
8. [RTP Ingestion Pipeline](#8-rtp-ingestion-pipeline)
9. [DataChannel Message Schema](#9-datachannel-message-schema)
10. [Implementation Plan & Milestones](#10-implementation-plan--milestones)
11. [File & Module Layout](#11-file--module-layout)
12. [Security Considerations](#12-security-considerations)
13. [Migration Strategy](#13-migration-strategy)
14. [Glossary](#14-glossary)
15. [Troubleshooting](#15-troubleshooting)

---

> **⚠️ 2026-07-23 정확성 안내**: 이 문서(§3, §7, §8, §11)가 서술하는 FFmpeg 듀얼 출력 + mediasoup-client capabilities-exchange(Socket.IO `webrtc:getCapabilities`/`webrtc:createTransport` 등) 아키텍처는 **실제로 구현되지 않았습니다**. 현재 코드는 ingest-daemon(Python PyAV) + WHEP 스타일 `negotiate()` 기반이며, `mediamtx`(기본값)와 `mediasoup` 두 엔진을 `WEBRTC_ENGINE`으로 선택합니다. 엔진 내부 동작의 정확한 최신 근거는 [RFP_WebRTC_Engine_Modes.md](RFP_WebRTC_Engine_Modes.md)와 [Design_WebRTC_Engine_Modes.md](../design/Design_WebRTC_Engine_Modes.md)를 참조하십시오. 이 문서는 M1~M5 로드맵(녹화·Playback·Re-ID 영속화 등) 참고용으로만 유효합니다.

## 1. Overview

The LTS-2026 system currently transports camera video to the React WebUI using a **FFmpeg → JPEG → Socket.IO** pipeline. This approach discards the audio and application RTP tracks present in most IP camera streams and incurs avoidable latency and bandwidth overhead from JPEG serialisation and base64 encoding.

This document specifies requirements for replacing that path with a **WebRTC Media Gateway** that:

- Accepts all three RTP track classes (Video, Audio, Application) from each camera's RTSP session.
- Delivers Video and Audio to browser `<video>` elements via native WebRTC media tracks (DTLS-SRTP encrypted, hardware-decoded in the browser).
- Delivers AI inference results (detections, loitering events, alerts) and camera metadata over a WebRTC **DataChannel** rather than via Socket.IO frame events.
- Retains Socket.IO exclusively for signaling (SDP offer/answer, ICE candidates) and for non-streaming REST-like events (camera management, discovery).

---

## 2. Problem Statement — Current Architecture Limitations

### 2.1 Current Data Flow

```
[IP Camera]
    │  RTSP (H.264 Video only — Audio ignored)
    ▼
[FFmpeg child process]   ← spawned per camera (rtspCapture.js)
    │  stdout: raw JPEG stream (image2pipe / mjpeg)
    ▼
[Node.js server]
    │  parse SOI/EOI markers, accumulate JPEG buffer
    │  jpegBuffer.toString('base64')
    ▼
[Socket.IO]  io.to(cameraId).emit('frame', { data: base64JPEG })
    ▼
[React WebUI]  <img src={`data:image/jpeg;base64,${frame}`} />
    + overlay canvas for bounding boxes from separate 'detections' event
```

### 2.2 Identified Limitations

| # | Limitation | Impact |
|---|---|---|
| L-1 | Audio RTP track is silently dropped by the `-vf` filter chain in `_buildArgs()` | No audio monitoring at the operator console |
| L-2 | Application RTP (metadata tracks from some cameras) is unavailable | Proprietary analytics payloads from WiseNet cameras lost |
| L-3 | JPEG + base64 encoding adds ~33 % bandwidth overhead vs native H.264 | Higher server CPU, higher WAN bandwidth cost |
| L-4 | Per-frame JPEG encode on server CPU blocks event loop slot for inference | Inference and streaming compete for the same process |
| L-5 | Socket.IO `maxHttpBufferSize` is set to 10 MB to accommodate large frames | Memory pressure at scale (many concurrent cameras) |
| L-6 | No DTLS/SRTP encryption between server and browser | Video data travels in cleartext over WebSocket |
| L-7 | Browser renders each frame from scratch as a `<img>` swap | No temporal compression; motion-JPEG artifacts at low bandwidth |
| L-8 | Latency: encode + base64 + TCP + decode adds 200–800 ms end-to-end | Unsuitable for real-time response use cases |

---

## 3. Proposed Architecture

### 3.1 High-Level Data Flow

```
[IP Camera]
    │  RTSP (Video H.264 + Audio G.711/AAC + Application RTP)
    ▼
┌──────────────────────────────────────────────────────────┐
│               RTP Ingestion Layer (per camera)           │
│                                                          │
│  FFmpeg / GStreamer pipeline                             │
│  ┌──────────────────────────────────┐                   │
│  │  -map 0:v  → RTP/H.264 UDP port │ ─→ mediasoup      │
│  │  -map 0:a  → RTP/Opus  UDP port │ ─→ PlainTransport │
│  │  -map 0:d? → RTP/App   UDP port │ ─→ (DataProducer) │
│  └──────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────┘
    │  RTP (local loopback UDP)
    ▼
┌──────────────────────────────────────────────────────────┐
│             mediasoup SFU (Node.js Worker)               │
│                                                          │
│  PlainTransport  ──► Router ──► WebRtcTransport          │
│  (RTP in from FFmpeg)          (DTLS-SRTP out to browser)│
│                                                          │
│  DataProducer (AI results) ──► DataConsumer              │
│  via SCTP DataChannel                                    │
└──────────────────────────────────────────────────────────┘
    │  WebRTC (ICE + DTLS-SRTP + SCTP)
    ▼
┌──────────────────────────────────────────────────────────┐
│                   React WebUI (Browser)                  │
│                                                          │
│  RTCPeerConnection                                       │
│  ├── ontrack: video → <video> element (H.264 HW decode)  │
│  ├── ontrack: audio → AudioContext / <audio>             │
│  └── ondatachannel: AI events (JSON) → canvas overlay   │
└──────────────────────────────────────────────────────────┘

Signaling plane (unchanged): Socket.IO
  client → server: 'webrtc:offer', 'webrtc:ice-candidate'
  server → client: 'webrtc:answer', 'webrtc:ice-candidate'
```

> **Implementation Note (v1.1)**: The deployed implementation uses the **mediasoup-client native protocol** (§7.1) instead of the SDP offer/answer model shown above. See §7.1 for the actual event sequence.

### 3.2 Component Responsibilities

| Component | File(s) | Status | Responsibility |
|---|---|---|---|
| `WebRTCGateway` | `server/src/services/webrtcGateway.js` | ✅ Implemented | Owns mediasoup Worker + Router pool; `getAllListenIps()` filters to physical-interface primary IPs, respects `SERVER_IP` env var |
| `RtpIngestion` | `server/src/services/rtpIngestion.js` | ✅ Implemented | Spawns FFmpeg per camera, allocates dynamic loopback UDP ports, creates PlainTransports with `comedia=true` |
| `webrtcSignaling` | `server/src/socket/webrtcSignaling.js` | ✅ Implemented | Socket.IO handler for mediasoup-client capabilities exchange (see §7.1); closes stale transports on reconnect |
| `useWebRTC` hook | `client/src/hooks/useWebRTC.ts` | ✅ Implemented | mediasoup-client Device lifecycle; ICE/DTLS failure → `state='failed'`; 30 s timeout; `retry()` function |
| `CameraView` | `client/src/components/CameraView.tsx` | ✅ Implemented | `<video>` for WebRTC mode; retry button when connection fails; canvas overlay preserved |
| `WebRtcSession` | `server/src/services/webrtcSession.js` | ⏳ Deferred | Per-tab session manager; functionality currently inlined in `webrtcSignaling.js` sessions Map |
| DataChannel (AI events) | — | ⏳ Phase 3 | AI inference results still delivered via Socket.IO; DataChannel planned for Phase 3 |

---

## 4. Technology Selection

### 4.1 Evaluated Options

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **mediasoup v3** | Native Node.js; supports H.264/Opus/G.711; PlainTransport for RTP injection; DataChannel (SCTP); production-grade SFU | Requires C++ native build (`mediasoup-worker` binary) | **Selected** |
| node-webrtc (wrtc) | Pure JS API | Unmaintained since 2022; no DataChannel relay; no multi-consumer SFU | Rejected |
| Janus Gateway | Feature-rich; RTSP plugin | Separate C process; IPC complexity; not Node.js-native | Deferred (fallback) |
| Pion (Go) | High performance | Requires sidecar Go service; extra operational surface | Deferred |
| GStreamer webrtcsink | Full pipeline control | Complex C library bindings; fragile in Node.js | Deferred |

### 4.2 Selected Stack

```
Server-side SFU:    mediasoup  ^3.14  (npm)
RTP injection:      FFmpeg  ≥ 6.0  (system binary, already present)
Audio transcoding:  FFmpeg -c:a libopus  (G.711 / AAC → Opus for WebRTC)
Signaling:          Socket.IO  ^4.7  (already in use — reused, no change)
Client-side:        Native RTCPeerConnection + WebRTC APIs (no extra npm pkg)
```

### 4.3 Why mediasoup

mediasoup acts as a **Selective Forwarding Unit (SFU)**: the server receives RTP from the camera and forwards SRTP to each subscribed browser without re-encoding. This means:

- **Zero re-encode** for video: H.264 bitstream from the camera is forwarded byte-for-byte.
- **Scalable**: N browser tabs subscribe to the same camera → one PlainTransport, N WebRtcTransports (fanout).
- **DataChannel**: mediasoup's `DataProducer`/`DataConsumer` carries AI inference results over SCTP, eliminating the need for a separate Socket.IO `frame` or `detections` emission.

---

## 5. Functional Requirements

### 5.1 Video Track (FR-V)

| ID | Requirement |
|---|---|
| FR-V-1 | The gateway MUST forward the H.264 video RTP track from each RTSP camera to every subscribed browser WebRTC session without re-encoding. |
| FR-V-2 | The gateway MUST support cameras that encode video as H.265 (HEVC) by transcoding to H.264 via FFmpeg before injection into mediasoup. |
| FR-V-3 | The browser `<video>` element MUST replace the current `<img>` JPEG display. The video MUST render at the camera's native frame rate (up to 30 FPS). |
| FR-V-4 | The AI inference pipeline (YOLOv8, ByteTrack) MUST continue to receive decoded frames. The `RtpIngestion` component MUST tee the H.264 bitstream: one path to mediasoup (forwarding) and one path to the existing FFmpeg JPEG decoder for inference. |
| FR-V-5 | Keyframe (IDR) request (RTCP PLI/FIR) MUST be forwarded from mediasoup back to the camera via the RTSP/RTP path to recover from packet loss. |
| FR-V-6 | The mediasoup Router MUST be configured with H.264 `preferredPayloadType: 109` (not 108). mediasoup v3.19+ pins the Consumer PT to the Router's `preferredPayloadType`; Edge browser assigns PT=109 to H264/42e01f/pm=1. Using PT=108 causes Edge to silently discard all received SRTP packets, yielding black video despite a fully established ICE/DTLS connection. Chrome tolerates PT=109 per RFC 8829 (JSEP). |
| FR-V-7 | The mediasoup `WebRtcTransport` listenIps MUST be derived exclusively from `SERVER_IP` / `SERVER_PUBLIC_IP` env vars. `os.networkInterfaces()` MUST NOT be used for this purpose. Including all NIC IPs as ICE host candidates causes the browser to select the server's public IP as its local candidate, forming a loopback ICE path that routes SRTP back to the server instead of the browser. |

### 5.2 Audio Track (FR-A)

| ID | Requirement |
|---|---|
| FR-A-1 | The gateway MUST receive the audio RTP track from cameras that carry one (G.711 µ-law, G.711 A-law, AAC, or G.722). |
| FR-A-2 | If the camera audio codec is not Opus, the gateway MUST transcode it to Opus 48 kHz mono via FFmpeg before mediasoup injection. |
| FR-A-3 | Audio MUST be deliverable to the browser `<audio>` element or the same `<video>` element as the second track. |
| FR-A-4 | The operator UI MUST expose a per-camera mute button. Muting MUST be implemented client-side (gain node / track.enabled = false) — no server-side change required. |
| FR-A-5 | Cameras that do not expose an audio track MUST continue to work normally; the absence of audio MUST NOT break the video stream. |

### 5.3 Application RTP Track (FR-AP)

| ID | Requirement |
|---|---|
| FR-AP-1 | The gateway MUST pass through any application RTP track (payload type 96–127, dynamic) found in the RTSP SDP as raw binary data via a mediasoup DataProducer. |
| FR-AP-2 | The React client MUST expose the raw application RTP payload via the DataChannel so that a future plugin can parse proprietary metadata (e.g., WiseNet analytics overlays). |
| FR-AP-3 | Unknown application payload types MUST be buffered and forwarded without interpretation; the system MUST NOT crash on unrecognised payload. |

### 5.4 AI Inference DataChannel (FR-DC)

| ID | Requirement |
|---|---|
| FR-DC-1 | The server MUST send AI inference results (detections, tracking IDs, loitering events, alerts) over the WebRTC DataChannel instead of Socket.IO `frame` / `detections` events. |
| FR-DC-2 | Each DataChannel message MUST be a UTF-8 JSON string conforming to the schema defined in §9. |
| FR-DC-3 | The DataChannel MUST use ordered delivery with a `maxRetransmits: 0` option (UDP-like) for `detections` messages to avoid head-of-line blocking. Alert messages (`loitering`, `fire`, `intrusion`) MUST use ordered reliable delivery. |
| FR-DC-4 | The React `useWebRTC` hook MUST dispatch DataChannel messages to the existing Zustand store, preserving the current store schema so that downstream UI components require no changes. |

### 5.5 Signaling (FR-S)

| ID | Requirement |
|---|---|
| FR-S-1 | SDP negotiation MUST use existing Socket.IO connection; no new HTTP endpoint is required for signaling. |
| FR-S-2 | ICE candidate trickle MUST be supported (`candidate` events exchanged after initial offer/answer). |
| FR-S-3 | ~~Server-side offer~~ **[v1.1 superseded]**: Deployed implementation uses mediasoup-client capabilities-exchange protocol (client-initiated). Browser receives tracks via Consumer/Producer model; recvonly behaviour enforced by `rtpCapabilities` filtering. |
| FR-S-4 | Re-negotiation (adding/removing cameras) MUST NOT require a full page reload. |

---

## 6. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | Latency | Glass-to-glass latency from camera capture to browser display MUST be ≤ 300 ms on LAN under normal load. |
| NFR-2 | Bandwidth | Video bitrate to the browser MUST match the camera bitrate (no upscaling). Audio overhead MUST be ≤ 50 kbps per camera (Opus). |
| NFR-3 | Scalability | A single Node.js server process MUST handle ≥ 16 concurrent camera streams, each with ≥ 4 simultaneous browser subscribers, without exceeding 70 % CPU on a 4-core host. |
| NFR-4 | Security | All media MUST be encrypted via DTLS-SRTP. Signaling over WSS (TLS). No plaintext RTP to browsers. |
| NFR-5 | Reliability | A camera disconnect MUST cause a graceful stream teardown (ice connection state `disconnected` / `failed`) and automatic reconnection with exponential backoff, matching the current `RETRY_DELAY` behaviour in `rtspCapture.js`. |
| NFR-6 | Compatibility | The `<video>` element MUST render in Chrome ≥ 110, Firefox ≥ 110, Safari ≥ 16.4 (all support H.264 in WebRTC). |
| NFR-7 | Backward compat | The existing Socket.IO `camera:subscribe` / `camera:unsubscribe` / `detections` / `loitering` events MUST remain functional as a fallback until the WebRTC path is fully validated. |
| NFR-8 | Observability | The server MUST expose metrics at `GET /api/webrtc/stats` per camera (active consumers, bitrate in/out, packet loss, RTT). |

---

## 7. API & Signaling Specification

### 7.1 Socket.IO Events (Signaling Plane)

> **v1.1 Correction**: The deployed implementation uses the **mediasoup-client native capabilities-exchange protocol**, not the SDP offer/answer model originally specified. FR-S-3 (server-side offer) is superseded. The mediasoup-client library handles SDP internally; the application layer exchanges RTP capabilities and transport parameters.

#### Actual Signaling Sequence (deployed)

```
── Step 1: Capabilities exchange ──────────────────────────────────────────
Client → Server:  webrtc:getCapabilities  { cameraId }
Server → Client:  callback({ ...routerRtpCapabilities })
  Server returns mediasoup Router RTP capabilities; client loads a Device.

── Step 2: Transport creation ─────────────────────────────────────────────
Client → Server:  webrtc:createTransport  { cameraId }
Server → Client:  callback({ id, iceParameters, iceCandidates,
                               dtlsParameters, sctpParameters })
  Server creates a WebRtcTransport, returns its ICE/DTLS params.
  Client creates a mediasoup-client RecvTransport from these params.
  Any stale transport for the same socket:camera pair is closed first.

── Step 3: DTLS connection ────────────────────────────────────────────────
Client → Server:  webrtc:connectTransport
                  { cameraId, transportId, dtlsParameters }
Server → Client:  callback({} | { error })
  Client sends its DTLS fingerprint; server calls transport.connect().
  ICE + DTLS handshake proceeds in the background.

── Step 4: Consumer creation ──────────────────────────────────────────────
Client → Server:  webrtc:consume
                  { cameraId, transportId, rtpCapabilities }
Server → Client:  callback({
    video?: { id, producerId, kind, rtpParameters },
    audio?: { id, producerId, kind, rtpParameters }
  })
  Server creates Consumers (paused) and returns their parameters.
  Client calls transport.consume(params) for each track.

── Step 5: Resume consumers ───────────────────────────────────────────────
Client → Server:  webrtc:resumeConsumer   { cameraId, consumerId }
  Fire-and-forget. Server calls consumer.resume().
  SRTP data starts flowing: mediasoup → browser.

── Teardown ───────────────────────────────────────────────────────────────
Client → Server:  webrtc:leave            { cameraId }
  Server closes transport + consumers for this socket:camera pair.
  Also triggered automatically on socket disconnect.
```

#### Legacy SDP Events (not implemented)

The `webrtc:subscribe` / `webrtc:answer` / `webrtc:ice-candidate` / `webrtc:offer` events described in v1.0 are **not implemented**. If a non-mediasoup-client (e.g., native mobile using raw RTCPeerConnection) is required in the future, a separate SDP-bridge endpoint may be added.

### 7.2 REST Endpoints

```
GET  /api/webrtc/stats
  Response: {
    cameras: {
      [cameraId]: {
        producerVideo: { bitrate: number, packetsLost: number },
        producerAudio: { bitrate: number },
        consumers:     number,
        avgRttMs:      number
      }
    }
  }

GET  /api/webrtc/capabilities
  Response: mediasoup Router RTP capabilities (used by advanced clients)
```

### 7.3 ICE / STUN Configuration

For LAN-only deployment, no STUN/TURN server is required. The mediasoup `WebRtcTransport` MUST be configured with:

```js
{
  listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.SERVER_IP }],
  enableUdp: true,
  enableTcp: true,   // fallback for firewalled environments
  preferUdp: true,
}
```

#### SERVER_IP — Critical Configuration Requirement

`SERVER_IP` **MUST** be set in `server/.env`. This is the single most important configuration item for WebRTC connectivity.

```dotenv
# server/.env
SERVER_IP=192.168.90.186   # IP address browsers use to reach this server
```

**Why this matters**: mediasoup announces ICE candidates to the browser. Each announced IP becomes an ICE candidate. On multi-homed servers (multiple IP aliases on one NIC), without `SERVER_IP` the server auto-detects IPs. In the worst case (8 aliases on eth1), this generates **16 ICE candidates** (8 × UDP + 8 × TCP). The browser tries all combinations, which can take 10–30 seconds. Users give up before ICE completes.

**Auto-detection behaviour** (when `SERVER_IP` is unset):
- Docker bridge interfaces (`docker0`, `br-*`, `veth*`) are skipped
- Only the **first IPv4 address** of each physical interface is announced (secondary aliases skipped)
- Private (RFC 1918) IPs are preferred over public IPs
- A warning is printed at startup

**Selection guide**:
| Browser location | Recommended `SERVER_IP` |
|---|---|
| Same machine as server | `127.0.0.1` or LAN IP |
| LAN (e.g., `192.168.90.x`) | Server's IP on that subnet (e.g., `192.168.90.186`) |
| External / WAN | Public IP or FQDN |

> **Symptom of wrong SERVER_IP**: UI shows "WebRTC Connecting…" indefinitely or "WebRTC Connection Failed" after 30 seconds.

---

## 8. RTP Ingestion Pipeline

### 8.1 FFmpeg Command (per camera)

The existing `RTSPCapture._buildArgs()` is replaced by a dual-output FFmpeg invocation that simultaneously:

1. Forwards RTP to mediasoup PlainTransport loopback ports.
2. Outputs a low-rate JPEG pipe for AI inference (10 FPS, identical to current).

```bash
ffmpeg \
  -rtsp_transport tcp \
  -stimeout 5000000 \
  -analyzeduration 1000000 \
  -probesize 1000000 \
  -i rtsp://<credentials>@<ip>/stream1 \
  \
  # ── Tee 1: Video RTP → mediasoup PlainTransport ──
  -map 0:v -c:v copy \
  -f rtp -srtp_out_suite AES_128_CM_SHA1_80 \
  rtp://127.0.0.1:<VIDEO_RTP_PORT> \
  \
  # ── Tee 2: Audio RTP → mediasoup PlainTransport (Opus transcode) ──
  -map 0:a -c:a libopus -b:a 32k -vbr on -application voip \
  -f rtp \
  rtp://127.0.0.1:<AUDIO_RTP_PORT> \
  \
  # ── Tee 3: JPEG pipe → AI inference (existing path, unchanged) ──
  -map 0:v \
  -vf fps=10,scale=640:-2 \
  -f image2pipe -vcodec mjpeg -q:v 5 \
  pipe:1
```

> **Note on H.265 cameras**: Add `-c:v libx264 -preset ultrafast -tune zerolatency` to Tee 1 when `ffprobe` reports `hevc` codec. Detected at stream open time; no operator configuration required.

### 8.2 Port Allocation

`RtpIngestion` maintains a monotonically incrementing port pool starting at `40000`. Each camera is assigned:

| Offset | Use |
|---|---|
| `base + 0` | Video RTP |
| `base + 1` | Video RTCP |
| `base + 2` | Audio RTP |
| `base + 3` | Audio RTCP |
| `base + 4` | Application RTP (optional) |
| `base + 5` | Application RTCP (optional) |

Ports are released to the pool when the camera pipeline stops.

### 8.3 mediasoup PlainTransport Setup (per camera)

```js
// See actual implementation in rtpIngestion.js
// v1.1: comedia=true used in production (mediasoup learns FFmpeg's source port from first RTP packet)
const videoTransport = await router.createPlainTransport({
  listenIp:  { ip: '127.0.0.1' },
  rtcpMux:   false,
  comedia:   true,   // auto-connect from first incoming RTP packet
});
// No explicit transport.connect() needed with comedia=true
const videoProducer = await videoTransport.produce({
  kind:          'video',
  rtpParameters: {
    codecs: [{ mimeType: 'video/H264', payloadType: 96,
               clockRate: 90000,
               parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f' } }],
    encodings: [{ ssrc: 1001 }],
  },
});
```

Analogous setup for audio (`kind: 'audio'`, `mimeType: 'audio/opus'`, `clockRate: 48000`, `channels: 2`).

### 8.4 Application RTP Track Detection

At stream open time, `rtpIngestion.js` calls:

```bash
ffprobe -v error -show_streams -select_streams d -of json rtsp://<url>
```

If any stream with `codec_type=data` is found, a third PlainTransport is created and the corresponding FFmpeg output added. If `ffprobe` returns no data stream (most cameras), the application RTP path is skipped silently.

---

## 9. DataChannel Message Schema

All DataChannel messages are UTF-8 JSON strings. The `type` field discriminates the message kind.

### 9.1 `detections` — AI Inference Results

Replaces Socket.IO `detections` event. Delivered unreliably (drop stale frames).

```jsonc
{
  "type": "detections",
  "cameraId": "uuid",
  "frameId": 1234,
  "timestamp": 1716134400000,   // ms epoch
  "frameWidth": 1920,
  "frameHeight": 1080,
  "objects": [
    {
      "trackId": 7,
      "classId": 0,
      "label": "person",
      "confidence": 0.91,
      "bbox": { "x": 120, "y": 80, "w": 64, "h": 180 },  // pixels, absolute
      "loiteringSeconds": 12.4,  // null if not loitering
      "attributes": {
        "faceId": "face-uuid-or-null",
        "clothColor": "blue",
        "hat": false,
        "mask": false
      }
    }
  ]
}
```

### 9.2 `loitering` — Loitering Alert

Delivered reliably (ordered SCTP). Replaces Socket.IO `loitering` event.

```jsonc
{
  "type": "loitering",
  "cameraId": "uuid",
  "trackId": 7,
  "zoneId": "zone-uuid",
  "durationSeconds": 30.0,
  "thumbnail": "base64-jpeg-or-null",   // small crop, optional
  "timestamp": 1716134400000
}
```

### 9.3 `fire` — Fire / Smoke Alert

```jsonc
{
  "type": "fire",
  "cameraId": "uuid",
  "confidence": 0.87,
  "bbox": { "x": 200, "y": 100, "w": 300, "h": 200 },
  "timestamp": 1716134400000
}
```

### 9.4 `app-rtp` — Raw Application RTP Payload

```jsonc
{
  "type": "app-rtp",
  "cameraId": "uuid",
  "payloadType": 102,
  "sequenceNumber": 4321,
  "timestamp": 12345678,
  "payload": "<base64>"
}
```

### 9.5 `stream-stats` — Periodic Stream Health

Emitted every 5 seconds by the server via DataProducer.

```jsonc
{
  "type": "stream-stats",
  "cameraId": "uuid",
  "videoBitrateKbps": 2048,
  "audioBitrateKbps": 32,
  "videoPacketLossRate": 0.001,
  "rttMs": 4.2,
  "timestamp": 1716134400000
}
```

---

## 10. Implementation Plan & Milestones

### Phase 1 — Server-Side WebRTC Infrastructure (Week 1–2)

| Task | File(s) | Details |
|---|---|---|
| P1-1 | Install mediasoup | `server/package.json` | `npm install mediasoup@^3.14` — confirm `mediasoup-worker` binary builds on target OS |
| P1-2 | `WebRTCGateway` service | `server/src/services/webrtcGateway.js` | Create mediasoup Worker (1 worker per 4 cores), Router per camera, expose `createRouter(cameraId)` / `getRouter(cameraId)` |
| P1-3 | `RtpIngestion` service | `server/src/services/rtpIngestion.js` | Port allocation, FFmpeg dual-output command, PlainTransport creation, VideoProducer + AudioProducer |
| P1-4 | Integrate with `PipelineManager` | `server/src/services/pipelineManager.js` | Replace `new RTSPCapture(...)` with `new RtpIngestion(...)`, retain JPEG pipe (Tee 3) for AI inference |
| P1-5 | `WebRtcSession` service | `server/src/services/webrtcSession.js` | WebRtcTransport per browser tab, Consumer creation (video + audio), DataProducer for AI events |
| P1-6 | Signaling handler | `server/src/socket/webrtcSignaling.js` | Socket.IO events: `webrtc:subscribe`, `webrtc:answer`, `webrtc:ice-candidate`, `webrtc:unsubscribe` |
| P1-7 | Stats endpoint | `server/src/api/cameras.js` | `GET /api/webrtc/stats` |

**Exit Criteria**: `ffprobe rtsp://…` and `curl /api/webrtc/stats` returns valid JSON; server-side unit tests pass.

---

### Phase 2 — Client-Side WebRTC Integration (Week 3)

| Task | File(s) | Details |
|---|---|---|
| P2-1 | `useWebRTC` hook | `client/src/hooks/useWebRTC.ts` | `RTCPeerConnection` lifecycle, `ontrack` (video + audio), `ondatachannel`, ICE trickle via Socket.IO |
| P2-2 | `CameraView` update | `client/src/components/CameraView.tsx` | Replace `<img src={frame} />` with `<video ref={videoRef} autoPlay muted playsInline />` + retain canvas overlay |
| P2-3 | DataChannel dispatch | `client/src/hooks/useWebRTC.ts` | Parse incoming JSON, route to existing Zustand store actions (`setDetections`, `addAlert`, etc.) — store schema unchanged |
| P2-4 | Audio controls | `client/src/components/CameraView.tsx` | Mute/unmute button; volume slider; AudioContext gain node |
| P2-5 | Fallback flag | `client/src/hooks/useCamera.ts` | If `RTCPeerConnection` not available or server sends `webrtc:unsupported`, fall back to Socket.IO JPEG path |
| P2-6 | `.env` configuration | `server/.env.example` | Add `SERVER_IP`, `WEBRTC_PORT_MIN=40000`, `WEBRTC_PORT_MAX=49999`, `WEBRTC_LISTEN_IP=0.0.0.0` |

**Exit Criteria**: Chrome DevTools > Media shows WebRTC video/audio tracks; DataChannel messages appear in console; bounding box canvas overlay still renders correctly.

---

### Phase 3 — Audio & Application RTP (Week 4)

| Task | File(s) | Details |
|---|---|---|
| P3-1 | Audio codec detection | `server/src/services/rtpIngestion.js` | `ffprobe` at open time; select `-c:a copy` for Opus cameras, `-c:a libopus` for all others |
| P3-2 | Application RTP track | `server/src/services/rtpIngestion.js` | `ffprobe -select_streams d`; create third PlainTransport; DataProducer for `app-rtp` messages |
| P3-3 | Audio UI | `client/src/components/CameraView.tsx` | Speaker icon; keyboard shortcut `M` for mute |
| P3-4 | `app-rtp` hook | `client/src/hooks/useWebRTC.ts` | Expose `onAppRtp` callback for future plugin registration |

**Exit Criteria**: Audio plays in browser from a camera that has audio; `app-rtp` DataChannel messages appear when camera supports application track.

---

### Phase 4 — Hardening & Observability (Week 5)

| Task | Details |
|---|---|
| P4-1 Reconnection | WebRtcTransport `ice-connection-state-change` → trigger RtpIngestion restart (matches current retry logic) |
| P4-2 RTCP PLI relay | mediasoup `Consumer.on('layerschange')` + send RTCP PLI to camera via RTSP RTCP port |
| P4-3 Port cleanup | Verify UDP sockets released on `camera:stop`; integration test with `ss -u -a` |
| P4-4 Load test | 16 cameras × 4 tabs; measure CPU, RAM, packet loss |
| P4-5 Socket.IO fallback | Feature flag `WEBRTC_ENABLED=true` in `.env`; when `false`, existing JPEG/Socket.IO path active |
| P4-6 Documentation | Update README §5 (Architecture), §16 (API Reference); add `docs/webrtc-setup.md` |

---

## 11. File & Module Layout

```
server/src/
├── services/
│   ├── rtspCapture.js          ← RETAINED (JPEG pipe for AI inference)
│   ├── rtpIngestion.js         ← ✅ EXISTS: FFmpeg dual-output + PlainTransport (comedia=true)
│   ├── webrtcGateway.js        ← ✅ EXISTS: mediasoup Worker/Router pool;
│   │                                        getAllListenIps() with interface filtering
│   ├── webrtcSession.js        ← ⏳ DEFERRED: logic inlined in webrtcSignaling.js
│   └── pipelineManager.js      ← ✅ EXISTS: uses RtpIngestion; starts WebRTC path
├── socket/
│   ├── streamHandler.js        ← RETAINED (camera:subscribe, discovery)
│   └── webrtcSignaling.js      ← ✅ EXISTS: capabilities-exchange protocol (§7.1);
│                                            stale-transport cleanup on reconnect;
│                                            DTLS state logging
└── api/
    └── cameras.js              ← MODIFIED (/api/webrtc/stats planned Phase 4)

client/src/
├── hooks/
│   ├── useCamera.ts            ← MODIFIED: delegates to useWebRTC when webrtcEnabled
│   ├── useWebRTC.ts            ← ✅ EXISTS: mediasoup-client Device lifecycle;
│   │                                        connectionstatechange failure handling;
│   │                                        30 s connection timeout; retry() function
│   └── useSocket.ts            ← UNCHANGED
└── components/
    ├── CameraView.tsx          ← ✅ EXISTS: <video> WebRTC; retry button on failure
    └── VideoAnalyticsTab.tsx   ← EXISTS: WebRTC enable/disable toggle per camera
```

---

## 12. Security Considerations

| Concern | Mitigation |
|---|---|
| Media encryption | DTLS-SRTP enforced by mediasoup; no plaintext RTP to browser |
| Signaling authentication | Existing Socket.IO auth token (JWT) applied to `webrtc:*` events |
| Local loopback RTP | FFmpeg sends to `127.0.0.1` only; bind mediasoup PlainTransport to loopback |
| Port exhaustion | Port pool bounded by `WEBRTC_PORT_MAX`; allocation failure raises error — no silent out-of-range use |
| ICE candidate leakage | `mDNS` candidates disabled; only `SERVER_IP` announced (no local IP exposure to browser) |
| DataChannel injection | Messages from DataChannel are parsed as JSON; malformed messages are caught and logged, not executed |

---

## 13. Migration Strategy

The migration follows a **side-by-side** approach with a feature flag to ensure zero disruption to the existing deployment:

```
WEBRTC_ENABLED=false  →  current behaviour unchanged (Socket.IO JPEG path)
WEBRTC_ENABLED=true   →  WebRTC path active; Socket.IO JPEG path runs in parallel
                          until Phase 4 sign-off, then JPEG emission removed
```

**Rollout sequence**:
1. Deploy Phase 1 + 2 with `WEBRTC_ENABLED=false` — no user impact.
2. Enable `WEBRTC_ENABLED=true` in staging; validate with all supported browsers.
3. Enable in production; monitor `/api/webrtc/stats` and browser WebRTC internals (`chrome://webrtc-internals`).
4. After 1-week soak: remove `JPEG` Socket.IO emission and the `maxHttpBufferSize: 10 MB` override.

---

## 14. Glossary

| Term | Definition |
|---|---|
| **SFU** | Selective Forwarding Unit — a media server that forwards RTP packets to subscribers without re-encoding |
| **PlainTransport** | mediasoup transport that receives unencrypted RTP from a local source (e.g., FFmpeg) |
| **WebRtcTransport** | mediasoup transport that carries DTLS-SRTP to a browser `RTCPeerConnection` |
| **DataChannel** | WebRTC SCTP channel for application data (non-media), used here for AI inference events |
| **DataProducer** | mediasoup object that injects data into a DataChannel |
| **DataConsumer** | mediasoup object that delivers DataChannel data to a specific browser transport |
| **DTLS-SRTP** | Datagram Transport Layer Security + Secure RTP — the encryption layer used in WebRTC media |
| **PLI** | Picture Loss Indication — RTCP message requesting a keyframe from the encoder |
| **ICE** | Interactive Connectivity Establishment — WebRTC mechanism for NAT traversal |
| **Trickle ICE** | Sending ICE candidates incrementally as they are discovered, rather than waiting for all candidates before signaling |

---

## 15. Troubleshooting

### 15.1 "WebRTC Connecting…" — Connection Stuck in Connecting State

| Cause | Diagnostic | Fix |
|---|---|---|
| `SERVER_IP` not set or wrong | Server startup log: `[WebRTCGateway] SERVER_IP not set — auto-detected: x.x.x.x` | Set correct `SERVER_IP` in `server/.env` (§7.3) |
| Browser cannot reach UDP 40000–49999 | `chrome://webrtc-internals` → ICE never reaches `connected` | Open firewall for UDP 40000–49999 on the server |
| Too many ICE candidates (multi-homed server) | `chrome://webrtc-internals` → 16 candidates instead of 2 | Set `SERVER_IP` to eliminate auto-detection |
| DTLS handshake failing | Server log: `[WebRTC] DTLS state: failed` | Sync system clock (`chronyc tracking`) |

### 15.2 "WebRTC Connection Failed" — Connection Failed

| Cause | Diagnostic | Fix |
|---|---|---|
| ICE timeout (30 s elapsed) | `connectionstatechange: failed` in server log | Fix `SERVER_IP` or open firewall; click "Reconnect" button |
| Camera not streaming | No `PlainTransports ready` log for the camera | Check RTSP URL; verify FFmpeg process running (`ps aux \| grep ffmpeg`) |
| mediasoup worker crashed | Worker log missing after startup | Restart server; check port conflicts on 40000–49999 |

### 15.3 Video Shows Black / No Image

| Cause | Diagnostic | Fix |
|---|---|---|
| ICE connected but SRTP not flowing | `chrome://webrtc-internals` → `packetsReceived` for video = 0 | Verify FFmpeg is sending RTP: `ss -ulnp \| grep mediasoup-worke` |
| Consumer is paused | No `consuming video track` log in browser console | Click "Reconnect" to recreate the session |
| SSRC mismatch | mediasoup Producer score remains 0 in server log | FFmpeg 3.4+ supports `-ssrc <n>` — verify `SSRC_VIDEO=1111` in `rtpIngestion.js` |

### 15.4 Checking Configuration After Change

```bash
# Verify SERVER_IP loaded and ICE candidate count
grep -i 'announcing IPs\|ICE candidates\|SERVER_IP' /tmp/lts-server.log | tail -5

# Expected with SERVER_IP set:
# [WebRTC][socketId] transport <id> created — 2 ICE candidates

# Check mediasoup worker
ps aux | grep mediasoup-worker

# Verify FFmpeg → mediasoup RTP flow
ss -ulnp | grep -E 'mediasoup|ffmpeg'
```

*RFP LTS-2026-003 — WebRTC Media Gateway | v1.1 | Updated 2026-05-22*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for WebRTC Media Gateway |
| 1.2 | 2026-06-16 | LTS Engineering Team | §5.1 FR-V-6/FR-V-7 추가 — mediasoup PT=109 H264 제약 및 ICE listenIps env-var 전용 요구사항 |
| 1.3 | 2026-07-23 | LTS Engineering Team | 문서 상단에 정확성 안내 추가 — 본 문서의 FFmpeg 듀얼출력/mediasoup-client 시그널링 아키텍처는 미구현이며, 실제 엔진 동작은 `RFP_WebRTC_Engine_Modes.md`/`Design_WebRTC_Engine_Modes.md` 참조 |
