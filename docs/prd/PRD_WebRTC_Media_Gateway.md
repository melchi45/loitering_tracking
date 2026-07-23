# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# WebRTC Media Gateway (Video / Audio / Application RTP)

| | |
|---|---|
| **Document ID** | PRD-LTS-003 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_WebRTC_Media_Gateway.md (LTS-2026-003 v1.1) |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [Technical Requirements](#5-technical-requirements)
6. [API / Interface Contract](#6-api--interface-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

The WebRTC Media Gateway replaces the FFmpeg → JPEG → Socket.IO streaming path with a low-latency WebRTC delivery path. The system has evolved through two major implementations:

**현재 구현 (기본값 — `WEBRTC_ENGINE=mediamtx`)**: MediaMTX가 RTSP → WebRTC(WHEP) 변환을 직접 처리하며, 브라우저는 `http://<host>:8889/<cameraId>/whep`에서 H.264를 DTLS-SRTP로 직접 수신한다. mediasoup 의존성을 제거하여 ICE 연결 문제를 해소. AI 추론 결과(검출·배회·경보)는 현재 Socket.IO(`frameData`, `newAlert`)로 전달.

**레거시 경로 (`WEBRTC_ENGINE=mediasoup`)**: mediasoup SFU가 카메라 RTP를 PlainTransport로 수신 후 WebRtcTransport를 통해 브라우저에 전달. Audio/Application RTP 및 DataChannel 경로는 이 모드에서 정의됨. 실측상 영상 끊김/재생 불가가 반복 관측되어 현재 dormant 상태이며(코드는 삭제하지 않고 보존), §4.1의 PT=109 고정 방식은 이후 alt-PT Router 캐시 방식으로 대체되었다 — 최신 정확한 내용은 [PRD_WebRTC_Engine_Modes.md](PRD_WebRTC_Engine_Modes.md)를 참조.

**장기 목표**: Application RTP → WebRTC DataChannel 브리지로 AI 추론 결과를 Socket.IO 없이 브라우저에 전달 (→ M4 DataChannel, `Design_RTSP_WebRTC_Architecture.md §3.7` 참조).

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Forward H.264 video RTP from each camera's RTSP session to subscribed browsers via mediasoup without re-encoding (zero-transcode SFU forwarding).
- Receive audio RTP tracks from cameras and transcode non-Opus codecs to Opus 48 kHz via FFmpeg before mediasoup injection.
- Pass application RTP tracks (dynamic payload types 96–127) through a mediasoup DataProducer for future plugin consumption.
- Replace the Socket.IO `frame` / `detections` / `loitering` event model with WebRTC DataChannel delivery of AI inference results.
- Retain Socket.IO exclusively for mediasoup-client capabilities exchange and signaling; maintain backward-compatible Socket.IO JPEG fallback until full validation.
- Expose per-camera WebRTC health metrics at `GET /api/webrtc/stats`.

### 2.2 Non-Goals

- The DataChannel AI event path (Phase 3) is not in scope for the initial Phase 1/2 deployment; AI results continue to be delivered via Socket.IO until Phase 3 is complete.
- A raw `RTCPeerConnection` SDP offer/answer endpoint for non-mediasoup-client consumers (e.g., native mobile apps) is deferred.
- Per-stream adaptive bitrate (ABR/simulcast) is not in scope for this version.

---

## 3. User Personas

**Operator at Console** — Monitors multiple camera feeds simultaneously in a browser. Expects low-latency, hardware-decoded video with audio, and accurate bounding box overlays. Needs a mute button per camera and a Reconnect button when a connection fails.

**System Administrator** — Configures `SERVER_IP` and mediasoup port ranges in `.env`. Uses `GET /api/webrtc/stats` and `chrome://webrtc-internals` to diagnose connectivity issues.

**AI/Analytics Developer** — Relies on the DataChannel message schema to consume detection events and loitering alerts without changes to the existing Zustand store interface.

---

## 4. Functional Specification

### 4.1 Video Track

The gateway must forward the H.264 video RTP track from each camera to every subscribed browser session without re-encoding. Cameras that stream H.265 (HEVC) must be transcoded to H.264 via FFmpeg before mediasoup injection. The browser `<video>` element replaces the current `<img>` JPEG display and must render at the camera's native frame rate (up to 30 FPS). The AI inference pipeline (YOLOv8, ByteTrack) must continue to receive decoded frames; the `RtpIngestion` component tees the H.264 bitstream — one path to mediasoup, one path to the existing JPEG decoder for inference. RTCP PLI / FIR keyframe requests from mediasoup must be forwarded back to the camera via the RTSP/RTP path.

**RTP Payload Type Constraint (mediasoup mode)**: The mediasoup Router must be created with `preferredPayloadType: 109` for H.264 (not 108). mediasoup v3.19+ hard-pins the Consumer PT to the Router's `preferredPayloadType`. Edge browser assigns PT=109 to H264/CBP/pm=1; if the server answer carries PT=108, Edge discards all SRTP packets at the media layer, resulting in black video despite a successfully connected ICE/DTLS session. Chrome offers PT=108 but accepts PT=109 in the answer per RFC 8829 (JSEP).

**ICE Listen IP Constraint (mediasoup mode)**: The `WebRtcTransport` listenIps list must be built exclusively from `SERVER_IP` / `SERVER_PUBLIC_IP` environment variables — never from `os.networkInterfaces()`. Advertising all NIC IPs as ICE host candidates causes the browser's ICE agent to select the server's own public IP as a shared local candidate, routing SRTP in a loopback path back to the server process instead of delivering it to the browser.

### 4.2 Audio Track

The gateway must receive audio RTP from cameras that carry audio (G.711 µ-law/A-law, AAC, or G.722). Non-Opus codecs must be transcoded to Opus 48 kHz mono. Audio must be delivered to the browser alongside the video track. The operator UI must expose a per-camera mute button (implemented client-side via `track.enabled = false`). Cameras without an audio track must continue to work without error.

### 4.3 Application RTP Track

Application RTP tracks (payload types 96–127) detected in the camera's RTSP SDP must be passed through as raw binary data via a mediasoup DataProducer. Unknown payload types must be buffered and forwarded without interpretation; unrecognised payloads must not crash the server.

### 4.4 AI Inference DataChannel

AI inference results (detections, tracking IDs, loitering events, fire/smoke alerts) must be delivered over the WebRTC DataChannel rather than Socket.IO frame events. Each DataChannel message is a UTF-8 JSON string with a discriminating `type` field. Detection messages use `maxRetransmits: 0` (unreliable, UDP-like) to avoid head-of-line blocking. Alert messages (`loitering`, `fire`, `intrusion`) use ordered reliable delivery. The `useWebRTC` hook dispatches DataChannel messages to the existing Zustand store without requiring changes to downstream UI components.

### 4.5 RTP Ingestion Pipeline (per camera)

`RtpIngestion` spawns a dual-output FFmpeg process:
1. Video RTP → mediasoup PlainTransport loopback UDP port (H.264 copy, or libx264 transcode for H.265 cameras)
2. Audio RTP → mediasoup PlainTransport loopback UDP port (libopus transcode)
3. JPEG pipe → AI inference (existing path, 10 FPS, unchanged)

`RtpIngestion` allocates 6 sequential ports per camera from a pool starting at 40000:

| Offset | Use |
|---|---|
| +0 | Video RTP |
| +1 | Video RTCP |
| +2 | Audio RTP |
| +3 | Audio RTCP |
| +4 | Application RTP (optional) |
| +5 | Application RTCP (optional) |

mediasoup PlainTransports use `comedia: true` so no explicit `transport.connect()` call is needed; the transport auto-connects from the first incoming RTP packet.

### 4.6 Signaling

Signaling uses the mediasoup-client capabilities-exchange protocol over the existing Socket.IO connection. The sequence is:
1. `webrtc:getCapabilities` — client receives Router RTP capabilities and loads a Device.
2. `webrtc:createTransport` — server creates WebRtcTransport; client creates RecvTransport.
3. `webrtc:connectTransport` — client sends DTLS fingerprint; ICE + DTLS handshake proceeds.
4. `webrtc:consume` — server creates paused Consumers; client calls `transport.consume()`.
5. `webrtc:resumeConsumer` — server calls `consumer.resume()`; SRTP data begins flowing.
6. `webrtc:leave` — server closes transport and consumers.

Stale transports for the same socket:camera pair are closed before creating a new one.

### 4.7 Migration and Fallback

A feature flag `WEBRTC_ENABLED` in `server/.env` controls the path:
- `WEBRTC_ENABLED=false` — existing Socket.IO JPEG path unchanged.
- `WEBRTC_ENABLED=true` — WebRTC path active; Socket.IO JPEG path runs in parallel until Phase 4 sign-off.

---

## 5. Technical Requirements

### 5.1 Selected Stack

| Component | Version | Role |
|---|---|---|
| `mediasoup` | ^3.14 | SFU — Worker/Router/Transport/Producer/Consumer |
| `FFmpeg` | ≥ 6.0 | RTP ingestion, audio transcode, JPEG tee |
| `Socket.IO` | ^4.7 | Signaling (capabilities exchange, transport params) |
| `mediasoup-client` | latest | Browser-side Device / RecvTransport lifecycle |

No new npm packages are required on the client side; the browser uses native `RTCPeerConnection` APIs via mediasoup-client.

### 5.2 Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Glass-to-glass latency (camera to browser) | ≤ 300 ms on LAN |
| NFR-2 | Audio overhead per camera | ≤ 50 kbps (Opus) |
| NFR-3 | Concurrent camera streams × browser subscribers | ≥ 16 cameras × 4 tabs at ≤ 70% CPU (4-core host) |
| NFR-4 | Media encryption | DTLS-SRTP mandatory; no plaintext RTP to browsers |
| NFR-5 | Camera disconnect recovery | Exponential backoff reconnection; matches current `RETRY_DELAY` in `rtspCapture.js` |
| NFR-6 | Browser compatibility | Chrome ≥ 110, Firefox ≥ 110, Safari ≥ 16.4 |
| NFR-7 | Backward compatibility | Socket.IO `camera:subscribe` / `detections` / `loitering` events remain active as fallback |

### 5.3 SERVER_IP Configuration

`SERVER_IP` must be set in `server/.env`. mediasoup uses this value to announce ICE candidates to browsers. Without it, auto-detection on multi-homed servers can produce 16+ ICE candidates, causing 10–30 second connection delays.

```dotenv
SERVER_IP=192.168.90.186
```

Auto-detection (when `SERVER_IP` is unset) skips Docker bridge interfaces and announces only the first IPv4 address of each physical interface.

### 5.4 Port Configuration

```dotenv
WEBRTC_PORT_MIN=40000
WEBRTC_PORT_MAX=49999
WEBRTC_LISTEN_IP=0.0.0.0
```

Firewall must allow UDP 40000–49999 on the server.

### 5.5 Security

| Concern | Mitigation |
|---|---|
| Media encryption | DTLS-SRTP enforced by mediasoup |
| Signaling auth | Existing Socket.IO JWT applied to `webrtc:*` events |
| Local RTP | FFmpeg sends to `127.0.0.1` only; PlainTransport bound to loopback |
| Port exhaustion | Pool bounded by `WEBRTC_PORT_MAX`; allocation failure raises error |
| DataChannel injection | Incoming JSON parsed with try/catch; malformed messages logged, not executed |

### 5.6 File & Module Layout

```
server/src/
├── services/
│   ├── rtspCapture.js          RETAINED (JPEG pipe for AI inference)
│   ├── rtpIngestion.js         EXISTS: FFmpeg dual-output + PlainTransport (comedia=true)
│   ├── webrtcGateway.js        EXISTS: mediasoup Worker/Router pool; getAllListenIps()
│   ├── webrtcSession.js        DEFERRED: logic inlined in webrtcSignaling.js
│   └── pipelineManager.js      EXISTS: uses RtpIngestion; starts WebRTC path
├── socket/
│   ├── streamHandler.js        RETAINED
│   └── webrtcSignaling.js      EXISTS: capabilities-exchange protocol; stale transport cleanup
└── api/
    └── cameras.js              MODIFIED: /api/webrtc/stats planned Phase 4

client/src/
├── hooks/
│   ├── useWebRTC.ts            EXISTS: mediasoup-client Device lifecycle; 30s timeout; retry()
│   └── useCamera.ts            MODIFIED: delegates to useWebRTC when webrtcEnabled
└── components/
    ├── CameraView.tsx           EXISTS: <video> WebRTC; retry button; canvas overlay preserved
    └── VideoAnalyticsTab.tsx    EXISTS: WebRTC enable/disable toggle per camera
```

---

## 6. API / Interface Contract

### 6.1 Socket.IO Events (Signaling Plane)

| Event | Direction | Description |
|---|---|---|
| `webrtc:getCapabilities` | Client → Server | Request Router RTP capabilities; response injected into mediasoup Device |
| `webrtc:createTransport` | Client → Server | Create WebRtcTransport; response: `{ id, iceParameters, iceCandidates, dtlsParameters, sctpParameters }` |
| `webrtc:connectTransport` | Client → Server | Send DTLS fingerprint; server calls `transport.connect()` |
| `webrtc:consume` | Client → Server | Send `rtpCapabilities`; response: video and audio Consumer parameters |
| `webrtc:resumeConsumer` | Client → Server | Unpause consumer; SRTP data starts flowing |
| `webrtc:leave` | Client → Server | Close transport and consumers for this socket:camera pair |

### 6.2 REST Endpoints

```
GET /api/webrtc/stats
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

GET /api/webrtc/capabilities
  Response: mediasoup Router RTP capabilities
```

### 6.3 DataChannel Message Schema

All DataChannel messages are UTF-8 JSON with a `type` discriminator field.

**`detections`** (unreliable delivery, `maxRetransmits: 0`):
```jsonc
{
  "type": "detections",
  "cameraId": "uuid",
  "frameId": 1234,
  "timestamp": 1716134400000,
  "frameWidth": 1920, "frameHeight": 1080,
  "objects": [{
    "trackId": 7, "classId": 0, "label": "person", "confidence": 0.91,
    "bbox": { "x": 120, "y": 80, "w": 64, "h": 180 },
    "loiteringSeconds": 12.4,
    "attributes": { "faceId": null, "clothColor": "blue", "hat": false, "mask": false }
  }]
}
```

**`loitering`** (reliable ordered delivery):
```jsonc
{
  "type": "loitering",
  "cameraId": "uuid", "trackId": 7, "zoneId": "zone-uuid",
  "durationSeconds": 30.0, "thumbnail": "base64-jpeg-or-null",
  "timestamp": 1716134400000
}
```

**`fire`** (reliable ordered delivery):
```jsonc
{
  "type": "fire",
  "cameraId": "uuid", "confidence": 0.87,
  "bbox": { "x": 200, "y": 100, "w": 300, "h": 200 },
  "timestamp": 1716134400000
}
```

**`app-rtp`** (raw application RTP payload passthrough):
```jsonc
{
  "type": "app-rtp",
  "cameraId": "uuid", "payloadType": 102,
  "sequenceNumber": 4321, "timestamp": 12345678, "payload": "<base64>"
}
```

**`stream-stats`** (emitted every 5 seconds by server):
```jsonc
{
  "type": "stream-stats",
  "cameraId": "uuid",
  "videoBitrateKbps": 2048, "audioBitrateKbps": 32,
  "videoPacketLossRate": 0.001, "rttMs": 4.2,
  "timestamp": 1716134400000
}
```

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-1 | H.264 video from an RTSP camera is displayed in a browser `<video>` element via WebRTC with glass-to-glass latency ≤ 300 ms on LAN. |
| AC-2 | Bounding box canvas overlay continues to render correctly on top of the `<video>` element. |
| AC-3 | Audio from a camera with a G.711 audio track plays in the browser after Opus transcoding; cameras without audio continue to stream video normally. |
| AC-4 | A per-camera mute button suppresses audio client-side without restarting the WebRTC session. |
| AC-5 | N browser tabs subscribing to the same camera all receive identical video without server re-encoding. |
| AC-6 | When `WEBRTC_ENABLED=false`, the existing Socket.IO JPEG path is used and no WebRTC setup occurs. |
| AC-7 | When `SERVER_IP` is set correctly, `chrome://webrtc-internals` shows exactly 2 ICE candidates (1 UDP + 1 TCP). |
| AC-8 | When ICE connection fails, the UI shows a "Reconnect" button; clicking it re-initiates the capabilities-exchange sequence. |
| AC-9 | A camera disconnect triggers graceful stream teardown; automatic reconnection with exponential backoff succeeds within 30 seconds. |
| AC-10 | `GET /api/webrtc/stats` returns valid JSON with `producerVideo.bitrate > 0` for all active cameras. |
| AC-11 | 16 cameras × 4 browser tabs run simultaneously for 30 minutes at ≤ 70% CPU on a 4-core host. |
| AC-12 | DTLS-SRTP is used for all media delivery; `chrome://webrtc-internals` shows no plaintext RTP. |
| AC-13 | DataChannel `detections` messages dispatched to the Zustand store produce correct bounding box overlays without code changes to UI components. |
| AC-14 | Stale WebRTC transports from a previous browser connection to the same camera are closed when the client reconnects. |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Server-side WebRTC infrastructure: mediasoup Worker/Router, RtpIngestion, webrtcSignaling | Week 1–2 | 2026-05-22 | ✅ Done |
| M2 | Client-side WebRTC integration: useWebRTC hook, CameraView `<video>`, DataChannel dispatch | Week 3 | 2026-05-22 | ✅ Done |
| M5 | **MediaMTX WHEP 기본 경로**: ingest-daemon + `mediamtxManager.js` + WHEP 클라이언트; ICE 안정화 완료 | — | 2026-06-11 | ✅ Done |
| M3 | Audio & Application RTP DataChannel: codec detection, audio UI, app-rtp hook, DataChannel 브리지 (§3.7 참조) | TBD | - | ⏳ Pending |
| M4 | Hardening & observability: reconnection, RTCP PLI relay, port cleanup, load test, fallback flag | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Implement `WebRtcSession` service (currently inlined in `webrtcSignaling.js`)
- [ ] Complete `GET /api/webrtc/stats` endpoint (Phase 4)
- [ ] Implement Phase 3 audio codec detection via `ffprobe`; select `copy` for Opus cameras
- [ ] Implement Phase 3 application RTP track detection (`ffprobe -select_streams d`)
- [ ] Add audio UI: speaker icon, mute button, keyboard shortcut `M`
- [ ] Implement `onAppRtp` callback in `useWebRTC` hook for future plugin registration
- [ ] Implement RTCP PLI relay from mediasoup back to camera RTSP/RTP path
- [ ] Verify UDP port cleanup with `ss -u -a` integration test
- [ ] Perform load test: 16 cameras × 4 tabs; record CPU, RAM, packet loss
- [ ] Add `WEBRTC_ENABLED` feature flag documentation to `.env.example`
- [ ] Update README §5 (Architecture) and §16 (API Reference)
- [ ] Write `docs/webrtc-setup.md` covering SERVER_IP, port configuration, and firewall rules
- [ ] Remove Socket.IO JPEG emission and `maxHttpBufferSize: 10 MB` override after 1-week production soak

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for WebRTC Media Gateway |
| 1.1 | 2026-06-11 | LTS Engineering Team | §1 현재 구현(MediaMTX WHEP) 반영; §8 M5 추가(WHEP 완료), M3/M4 DataChannel 참조 추가; Status → Active |
| 1.2 | 2026-06-16 | LTS Engineering Team | §4.1 RTP PT=109 제약 및 ICE listenIps env-var 전용 제약 추가 (mediasoup 모드 Edge 검은 화면 + ICE loopback 근본 원인 명시) |
| 1.3 | 2026-07-23 | LTS Engineering Team | §1 레거시 경로 설명에 mediasoup dormant 상태 및 alt-PT 대체 사실 반영, `PRD_WebRTC_Engine_Modes.md`로 연결 |
