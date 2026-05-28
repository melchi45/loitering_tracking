# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# WebRTC Media Gateway

| | |
|---|---|
| **Document ID** | SRS-LTS-WRTC-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_WebRTC_Media_Gateway.md |
| **Parent RFP** | rfp/RFP_WebRTC_Media_Gateway.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Media Codecs & RTP Ingestion](#3-functional-requirements--media-codecs--rtp-ingestion)
4. [Functional Requirements — Signaling Protocol](#4-functional-requirements--signaling-protocol)
5. [Functional Requirements — WebRTC Transport & SFU](#5-functional-requirements--webrtc-transport--sfu)
6. [Functional Requirements — DataChannel AI Events](#6-functional-requirements--datachannel-ai-events)
7. [Functional Requirements — Fallback & Feature Flag](#7-functional-requirements--fallback--feature-flag)
8. [Functional Requirements — Observability](#8-functional-requirements--observability)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Interface Requirements](#10-interface-requirements)
11. [Constraints & Assumptions](#11-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines verifiable functional requirements for the WebRTC Media Gateway of LTS-2026. Each requirement is identified by a unique FR-WRTC-NNN ID and is traceable to test cases in TC_WebRTC_Media_Gateway.md.

### 1.2 Scope

This document covers:
- mediasoup SFU Worker/Router/Transport/Producer/Consumer lifecycle
- RTP ingestion pipeline (yt-dlp → FFmpeg → mediasoup PlainTransport)
- WebRTC signaling via Socket.IO capabilities-exchange protocol
- Video (H.264), audio (Opus), and Application RTP track handling
- WebRTC DataChannel delivery of AI inference results
- `WEBRTC_ENABLED` feature flag and Socket.IO JPEG fallback
- `GET /api/webrtc/stats` and `GET /api/webrtc/capabilities` endpoints

Out of scope: simulcast/ABR, native mobile RTCPeerConnection, Phase 3 DataChannel AI path (deferred).

### 1.3 Definitions

| Term | Definition |
|---|---|
| SFU | Selective Forwarding Unit — mediasoup forwards RTP packets without re-encoding |
| PlainTransport | mediasoup transport that accepts unencrypted RTP/RTCP from a local FFmpeg process |
| WebRtcTransport | mediasoup transport that communicates with browsers using DTLS-SRTP |
| Producer | mediasoup entity that receives RTP from a source (FFmpeg) and makes it available for forwarding |
| Consumer | mediasoup entity that forwards Producer RTP to a specific WebRtcTransport (browser) |
| comedia | mediasoup PlainTransport option: auto-connects on receipt of the first RTP packet |
| RtpIngestion | LTS service that spawns dual-output FFmpeg and creates mediasoup PlainTransports |
| DTLS-SRTP | Datagram TLS + Secure RTP — mandatory media encryption for WebRTC |
| DataChannel | WebRTC channel for reliable or unreliable binary/UTF-8 message delivery alongside media |

---

## 2. System Overview

### 2.1 Component Dependencies

```
Camera RTSP Stream
  └─ RTSPCapture (ffmpeg → JPEG → AI inference)   [RETAINED for inference]
  └─ RtpIngestion (ffmpeg dual output)
       ├─ PlainTransport A — Video RTP (port pool +0/+1)
       │    └─ VideoProducer → mediasoup Router
       └─ PlainTransport B — Audio RTP (port pool +2/+3)
            └─ AudioProducer → mediasoup Router

WebRTCGateway (singleton)
  ├─ mediasoup Worker (rtcMinPort–rtcMaxPort)
  ├─ Router per cameraId (mediaCodecs: H264, Opus, PCMU, PCMA, VP8)
  ├─ _producers Map: cameraId → { video, audio }
  └─ getAllListenIps() → SERVER_IP or auto-detect

webrtcSignaling.js (Socket.IO event handlers)
  ├─ webrtc:getCapabilities → Router.rtpCapabilities
  ├─ webrtc:createTransport → WebRtcTransport (dtls + ice params)
  ├─ webrtc:connectTransport → transport.connect(dtlsParameters)
  ├─ webrtc:consume → Consumer[video + audio]
  ├─ webrtc:resumeConsumer → consumer.resume()
  └─ webrtc:leave → transport + consumer cleanup

Browser (mediasoup-client)
  └─ Device → RecvTransport → Consumer[video] + Consumer[audio]
       └─ <video> element via MediaStream
```

### 2.2 Startup Sequence

```
Server start
  1. WebRTCGateway.init() — creates mediasoup Worker
  2. RtpIngestion.start(camera) — FFmpeg spawned, PlainTransports created, Producers registered
  3. Browser connects via Socket.IO
  4. webrtc:getCapabilities → Router capabilities returned
  5. webrtc:createTransport → WebRtcTransport params returned
  6. ICE + DTLS handshake (see SRS-LTS-ICE-01)
  7. webrtc:consume → Consumers created (paused)
  8. webrtc:resumeConsumer → SRTP data begins flowing
  9. Browser renders <video> element
```

---

## 3. Functional Requirements — Media Codecs & RTP Ingestion

### FR-WRTC-001 — Supported Media Codecs

- The mediasoup Router must be created with the following `mediaCodecs`:
  - `audio/opus` 48 kHz 2-channel
  - `audio/PCMU` 8 kHz (G.711 µ-law)
  - `audio/PCMA` 8 kHz (G.711 A-law)
  - `video/H264` 90 kHz, `packetization-mode: 1`, `profile-level-id: 42e01f`, `level-asymmetry-allowed: 1`
  - `video/VP8` 90 kHz

### FR-WRTC-002 — H.264 Video Forwarding (Zero Transcode)

- The gateway must forward H.264 video RTP from each camera's RTSP session to subscribed browsers without re-encoding.
- FFmpeg must be invoked with `-c:v copy` for H.264 sources.
- Cameras streaming H.265 must be transcoded to H.264 via FFmpeg `-c:v libx264` before mediasoup injection.

### FR-WRTC-003 — Audio Transcoding

- Cameras with non-Opus audio (G.711 µ-law/A-law, AAC, G.722) must be transcoded to Opus 48 kHz mono via FFmpeg `-c:a libopus`.
- Cameras with Opus audio must use `-c:a copy`.
- Cameras without an audio track must continue to work without error (video-only operation).

### FR-WRTC-004 — RTP Port Allocation

- `RtpIngestion` must allocate 6 sequential ports per camera from a pool starting at 40000 (configurable via `WEBRTC_PORT_MIN`):
  - Offset +0: Video RTP
  - Offset +1: Video RTCP
  - Offset +2: Audio RTP
  - Offset +3: Audio RTCP
  - Offset +4: Application RTP (optional)
  - Offset +5: Application RTCP (optional)
- On port exhaustion (pool bounded by `WEBRTC_PORT_MAX`), an error must be raised.

### FR-WRTC-005 — PlainTransport comedia Mode

- mediasoup `PlainTransport` must be created with `comedia: true`.
- No explicit `transport.connect()` call is required; the transport auto-connects from the first incoming RTP packet.
- FFmpeg RTP output must target `127.0.0.1` only; local loopback binding is mandatory.

### FR-WRTC-006 — Application RTP Passthrough

- Application RTP tracks (payload types 96–127) detected in the camera SDP must be passed through as raw binary data via a mediasoup `DataProducer`.
- Unrecognized payload types must be buffered and forwarded without interpretation.
- Unrecognized payloads must not crash the server.

### FR-WRTC-007 — JPEG Tee for AI Inference

- `RtpIngestion` must run a dual-output FFmpeg process:
  - Output 1: RTP to mediasoup PlainTransport (video + audio)
  - Output 2: JPEG pipe to `RTSPCapture`-compatible AI inference path at 10 FPS
- The AI inference path must remain unchanged regardless of WebRTC state.

---

## 4. Functional Requirements — Signaling Protocol

### FR-WRTC-010 — Capabilities Exchange

- On `webrtc:getCapabilities` event from the client, the server must return the `Router.rtpCapabilities` for the requested `cameraId`.
- The Router must be created on demand via `webrtcGateway.getOrCreateRouter(cameraId)`.
- Concurrent calls for the same `cameraId` must await the same promise (creation lock via `_routerPending` Map).

### FR-WRTC-011 — Transport Creation

- On `webrtc:createTransport`, the server must create a `WebRtcTransport` with:
  - `listenIps` from `webrtcGateway.getListenIps()` (uses `SERVER_IP` or auto-detect)
  - `enableUdp: true`, `enableTcp: true`, `preferUdp: true`
- The response must include `{ id, iceParameters, iceCandidates, dtlsParameters, sctpParameters }`.
- Stale transports from the same `socket.id:cameraId` pair must be closed before creating a new one.

### FR-WRTC-012 — Transport Connection

- On `webrtc:connectTransport`, the server must call `transport.connect({ dtlsParameters })`.
- This completes the DTLS handshake; the ICE + DTLS path proceeds to `connected` state.

### FR-WRTC-013 — Consumer Creation

- On `webrtc:consume` with the client's `rtpCapabilities`, the server must create:
  - A `Consumer` for the video `Producer` (if present).
  - A `Consumer` for the audio `Producer` (if present).
- Both Consumers must be created in paused state.
- The response must include Consumer parameters for both video and audio.

### FR-WRTC-014 — Consumer Resume

- On `webrtc:resumeConsumer`, the server must call `consumer.resume()` for the specified consumer ID.
- After resume, SRTP data begins flowing to the browser.

### FR-WRTC-015 — Session Teardown

- On `webrtc:leave` or socket disconnect, the server must:
  1. Close all Consumers for that `socket.id:cameraId` pair.
  2. Close the `WebRtcTransport`.
  3. Not affect other browser connections to the same camera.

---

## 5. Functional Requirements — WebRTC Transport & SFU

### FR-WRTC-020 — Router Lifecycle

- One mediasoup `Router` per `cameraId` must be maintained in `WebRTCGateway._routers`.
- `deleteRouter(cameraId)` must close the Router, remove it from the map, and clear associated Producers.
- A closed Worker must set `gateway.enabled = false` and log a critical error.

### FR-WRTC-021 — Worker Configuration

- The mediasoup Worker must be created with:
  - `logLevel: 'warn'`
  - `rtcMinPort` from `WEBRTC_PORT_MIN` (default 40000)
  - `rtcMaxPort` from `WEBRTC_PORT_MAX` (default 49999)

### FR-WRTC-022 — Multi-Subscriber SFU Forwarding

- Multiple browser tabs subscribing to the same camera must all receive identical video without server re-encoding.
- Each subscriber gets its own `WebRtcTransport` and `Consumer` pair; the single `Producer` feeds all Consumers.

### FR-WRTC-023 — SERVER_IP Configuration

- When `SERVER_IP` is set in `server/.env`, mediasoup must use `{ ip: '0.0.0.0', announcedIp: SERVER_IP }` as the listen IP.
- When `SERVER_IP` is unset, `getAllListenIps()` must auto-detect by skipping Docker bridge interfaces (`docker`, `br-`, `virbr`, `veth`, `lo`, `tun`, `tap`, `dummy`, `bond`, `ovs` prefixes).
- Auto-detection must prefer private (RFC 1918) IPs over public IPs.
- If no usable interface is found, the fallback must be `127.0.0.1` with a warning log.

### FR-WRTC-024 — RTCP PLI / FIR Relay

- `RTCP PLI` (Picture Loss Indication) and `FIR` (Full Intra Request) keyframe requests from mediasoup must be forwarded back to the camera RTSP/RTP path.

---

## 6. Functional Requirements — DataChannel AI Events

### FR-WRTC-030 — DataChannel Message Types

- The WebRTC DataChannel must carry the following message types (UTF-8 JSON):
  - `detections` — per-frame bounding boxes and track IDs (unreliable, `maxRetransmits: 0`)
  - `loitering` — loitering event (reliable, ordered)
  - `fire` — fire/smoke alert (reliable, ordered)
  - `app-rtp` — raw application RTP payload passthrough
  - `stream-stats` — emitted every 5 seconds by server

### FR-WRTC-031 — Detection Message Schema

```json
{
  "type": "detections",
  "cameraId": "uuid",
  "frameId": 1234,
  "timestamp": 1716134400000,
  "frameWidth": 1920,
  "frameHeight": 1080,
  "objects": [{
    "trackId": 7,
    "classId": 0,
    "label": "person",
    "confidence": 0.91,
    "bbox": { "x": 120, "y": 80, "w": 64, "h": 180 },
    "loiteringSeconds": 12.4,
    "attributes": { "faceId": null, "clothColor": "blue", "hat": false, "mask": false }
  }]
}
```

### FR-WRTC-032 — Alert Message Delivery

- Alert messages (`loitering`, `fire`, `intrusion`) must use ordered reliable delivery.
- Detection messages must use `maxRetransmits: 0` to avoid head-of-line blocking.

### FR-WRTC-033 — DataChannel Injection Safety

- Incoming JSON must be parsed with `try/catch`; malformed messages must be logged, not executed.
- The `useWebRTC` hook must dispatch DataChannel messages to the existing Zustand store without requiring changes to downstream UI components.

---

## 7. Functional Requirements — Fallback & Feature Flag

### FR-WRTC-040 — WEBRTC_ENABLED Flag

- A `WEBRTC_ENABLED` environment variable in `server/.env` must control the active path:
  - `WEBRTC_ENABLED=false` — existing Socket.IO JPEG path unchanged; no WebRTC setup occurs.
  - `WEBRTC_ENABLED=true` — WebRTC path active; Socket.IO JPEG path runs in parallel until Phase 4 sign-off.

### FR-WRTC-041 — Socket.IO Backward Compatibility

- `camera:subscribe`, `detections`, and `loitering` Socket.IO events must remain active as fallback regardless of `WEBRTC_ENABLED` state.

### FR-WRTC-042 — Reconnect on ICE Failure

- When ICE connection fails, the UI must show a "Reconnect" button.
- Clicking Reconnect must re-initiate the full capabilities-exchange sequence.
- A 30-second connection timeout in `useWebRTC` must trigger reconnect logic.

---

## 8. Functional Requirements — Observability

### FR-WRTC-050 — Stats Endpoint

- `GET /api/webrtc/stats` must return valid JSON with per-camera stats:
  ```json
  {
    "cameras": {
      "<cameraId>": {
        "producerVideo": { "bitrate": 0, "packetsLost": 0 },
        "producerAudio": { "bitrate": 0 },
        "consumers": 0,
        "avgRttMs": 0
      }
    }
  }
  ```
- `producerVideo.bitrate` must be `> 0` for all active cameras.

### FR-WRTC-051 — Capabilities Endpoint

- `GET /api/webrtc/capabilities` must return mediasoup Router RTP capabilities for use by mediasoup-client `device.load()`.

---

## 9. Non-Functional Requirements

### FR-WRTC-060 — Latency

- Glass-to-glass latency (camera to browser) must be ≤ 300 ms on LAN.

### FR-WRTC-061 — Audio Overhead

- Audio overhead per camera must be ≤ 50 kbps (Opus).

### FR-WRTC-062 — Scale

- At least 16 cameras × 4 browser tabs must run simultaneously for 30 minutes at ≤ 70% CPU on a 4-core host.

### FR-WRTC-063 — Media Encryption

- DTLS-SRTP is mandatory; `chrome://webrtc-internals` must show no plaintext RTP.

### FR-WRTC-064 — Browser Compatibility

- Chrome ≥ 110, Firefox ≥ 110, Safari ≥ 16.4.

### FR-WRTC-065 — Camera Disconnect Recovery

- A camera disconnect must trigger graceful stream teardown.
- Automatic reconnection with exponential backoff must succeed within 30 seconds (matching `RETRY_DELAY` in `rtspCapture.js`).

---

## 10. Interface Requirements

### 10.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-WRTC-050 | GET | `/api/webrtc/stats` | Per-camera WebRTC health metrics |
| FR-WRTC-051 | GET | `/api/webrtc/capabilities` | Router RTP capabilities |

### 10.2 Socket.IO Signaling Events

| Event | Direction | Description |
|---|---|---|
| `webrtc:getCapabilities` | Client→Server | Request Router RTP capabilities |
| `webrtc:createTransport` | Client→Server | Create WebRtcTransport |
| `webrtc:connectTransport` | Client→Server | Send DTLS fingerprint |
| `webrtc:consume` | Client→Server | Send rtpCapabilities, get Consumer params |
| `webrtc:resumeConsumer` | Client→Server | Unpause Consumer; SRTP starts |
| `webrtc:leave` | Client→Server | Close transport and consumers |

### 10.3 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WEBRTC_ENABLED` | `false` | Enable WebRTC path |
| `SERVER_IP` | (auto) | Announced IP for mediasoup ICE candidates |
| `WEBRTC_PORT_MIN` | `40000` | mediasoup RTP/RTCP minimum port |
| `WEBRTC_PORT_MAX` | `49999` | mediasoup RTP/RTCP maximum port |
| `WEBRTC_LISTEN_IP` | `0.0.0.0` | Bind address for mediasoup WebRtcTransports |

---

## 11. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | `mediasoup` npm package must be installed; if absent, WebRTC is disabled gracefully |
| C-02 | FFmpeg ≥ 6.0 must be installed with `libopus` and `libx264` support |
| C-03 | Firewall must allow UDP 40000–49999 on the server host |
| C-04 | `SERVER_IP` must be set in `server/.env` for reliable ICE connectivity on multi-homed servers |
| C-05 | Per-stream JPEG inference path (`RTSPCapture`) is retained in parallel with WebRTC; both coexist |
| C-06 | `WebRTCGateway` is a module-level singleton exported as `module.exports = new WebRTCGateway()` |
| C-07 | DataChannel AI delivery (Phase 3) is deferred; Socket.IO remains the primary AI event path |
| C-08 | The `mediasoup-client` browser library is used on the client side; no raw `RTCPeerConnection` SDP endpoint is provided |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for WebRTC Media Gateway |
