# RFP — WebRTC Media Gateway (Video / Audio / Application RTP)
**Document ID**: LTS-2026-003
**Version**: 2.0
**Date**: 2026-05-19 (rev 2026-07-23)
**Project**: Loitering Detection & Tracking System (LTS-2026)
**Status**: Active — Implemented, differently than originally specified (see §2)

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-05-19 | Initial draft — SDP offer/answer signaling model |
| 1.1 | 2026-05-22 | §7.1 corrected to reflect mediasoup-client native protocol; §3.2 component status updated; §7.3 SERVER_IP guidance strengthened; §8.3 comedia=true noted; §15 Troubleshooting added |
| 1.2 | 2026-06-16 | §5.1 FR-V-6/FR-V-7 추가 — mediasoup PT=109 H264 제약 및 ICE listenIps env-var 전용 요구사항 |
| 1.3 | 2026-07-23 | 정확성 안내만 추가(구조 변경 없음) |
| 2.0 | 2026-07-23 | **전면 재작성** — v1.x가 서술한 FFmpeg 듀얼출력 + mediasoup-client Socket.IO capabilities-exchange 아키텍처는 실제로 구현되지 않았음이 확인됨. 실제 코드(ingest-daemon + WHEP 단일 엔드포인트 + Socket.IO 하이브리드 전달)를 기준으로 전 섹션 재작성 |

---

## Table of Contents

1. [Overview](#1-overview)
2. [What Changed From the Original Plan](#2-what-changed-from-the-original-plan)
3. [Current Architecture](#3-current-architecture)
4. [Technology Decisions](#4-technology-decisions)
5. [Functional Requirements](#5-functional-requirements)
6. [Non-Functional Requirements](#6-non-functional-requirements)
7. [API & Signaling Specification](#7-api--signaling-specification)
8. [Delivery Model — WebRTC / Socket.IO / DataChannel](#8-delivery-model--webrtc--socketio--datachannel)
9. [File & Module Layout](#9-file--module-layout)
10. [Security Considerations](#10-security-considerations)
11. [Glossary](#11-glossary)
12. [Troubleshooting](#12-troubleshooting)
13. [Related Documents](#13-related-documents)

---

## 1. Overview

LTS-2026 delivers camera video/audio to the browser over WebRTC and delivers AI inference results (detections, loitering events, alerts) over Socket.IO — these are two independent, permanently-coexisting delivery planes, not a migration from one to the other. This document specifies the actual contract of that "Media Gateway": the WHEP signaling endpoint, the Socket.IO event set, and how Application RTP (ONVIF metadata) crosses both planes.

Engine-internal detail (how `mediamtx` vs `mediasoup` each implement WHEP under the hood) is **out of scope here** and lives in [Design_WebRTC_Engine_Modes.md](../design/Design_WebRTC_Engine_Modes.md) and the [RFP/PRD/SRS/TC/ops _WebRTC_Engine_Modes](.) doc set — this document covers only the client-facing contract that stays identical across both engines.

---

## 2. What Changed From the Original Plan

v1.x of this RFP specified an architecture that was **never built**:

| Planned (v1.x) | Actually built |
|---|---|
| FFmpeg spawned per camera, dual-output to mediasoup PlainTransport + JPEG pipe | **ingest-daemon** (Python PyAV) opens a single RTSP session per camera and fans out to JPEG/H.264 RTP/Opus RTP/App RTP — no FFmpeg in this path at all (`.claude/CLAUDE.md` 수집 레이어 아키텍처 원칙) |
| Socket.IO `webrtc:getCapabilities` / `webrtc:createTransport` / `webrtc:connectTransport` / `webrtc:consume` / `webrtc:resumeConsumer` / `webrtc:leave` capabilities-exchange signaling | A single **WHEP** endpoint, `POST /api/webrtc/whep/:cameraId` — one SDP offer in, one SDP answer out. No Socket.IO signaling events exist for WebRTC negotiation (verified: zero `webrtc:offer`/`webrtc:answer`/`webrtc:ice-candidate`/`webrtc:getCapabilities` handlers anywhere in the codebase). |
| AI inference results (`detections`, `loitering`, `fire`) delivered over a WebRTC DataChannel, replacing Socket.IO | **Never happened.** `detections`/`loitering`/`fire:alert`/`alert:new`/etc. are emitted over Socket.IO unconditionally, regardless of `WEBRTC_ENGINE` or whether a camera uses WebRTC at all (`pipelineManager.js`). The DataChannel that exists today (mediasoup mode only) carries a completely different payload — raw Application RTP (ONVIF), not AI events. See §8. |
| Single engine (mediasoup) | Two implemented engines selectable via `WEBRTC_ENGINE` — `mediamtx` (default, active) and `mediasoup` (implemented, currently dormant — see [RFP_WebRTC_Engine_Modes.md](RFP_WebRTC_Engine_Modes.md)) |
| `WEBRTC_ENABLED` global feature flag | Per-camera `webrtcEnabled` field (set at add/edit time via `/api/cameras`) — there is no global on/off switch |
| Socket.IO JPEG `frame` event kept "in parallel" with WebRTC during a soak period, then removed | JPEG `frame` emission is **conditionally suppressed** per camera — `pipelineManager.js` sends it only `if (!ctx.useWebRTC)`. A WebRTC-enabled camera never sends JPEG frames; a non-WebRTC camera never stops. This is a permanent per-camera branch, not a temporary parallel-run migration state. |

This section exists so a future reader does not waste time trying to find `webrtcGateway.js`, `rtpIngestion.js`, or `webrtcSession.js` — none of these files exist. The equivalent responsibilities are covered by `pipelineManager.js`, `webrtcEngineFactory.js`, `webrtc/mediamtxEngine.js`, `webrtc/mediasoupEngine.js`, and `ingest-daemon/ingest_daemon.py`.

---

## 3. Current Architecture

```
[IP Camera]  RTSP (H.264/H.265 video, optional audio, optional App RTP)
    │
    ▼
┌────────────────────────────────────────────────────────────────┐
│ ingest-daemon (Python PyAV) — single RTSP session per camera    │
│   ├─ JPEG (10 fps)      → POST /api/internal/frame/:cameraId    │
│   ├─ H.264 RTP          → active WebRTC engine (mediamtx via    │
│   │                        MediaMTX loopback, or mediasoup via  │
│   │                        PlainTransport UDP — engine-specific)│
│   ├─ Opus RTP (passthrough or transcoded on a dedicated thread) │
│   └─ App RTP (ONVIF)    → POST /api/internal/apprtp/:cameraId   │
└────────────────────────────────────────────────────────────────┘
    │                                              │
    ▼ (webrtcEnabled=true)                         ▼ (webrtcEnabled=false)
┌───────────────────────────┐          ┌─────────────────────────────┐
│ Active WebRTC engine       │          │ Socket.IO `frame` (JPEG,     │
│ (mediamtx | mediasoup —    │          │  annotated with bbox overlay)│
│  selected by WEBRTC_ENGINE)│          └─────────────────────────────┘
└─────────────┬──────────────┘
              │ POST /api/webrtc/whep/:cameraId  (SDP offer → SDP answer)
              ▼
       [Browser <video>]  (ICE/DTLS/SRTP media, engine-specific transport)

── Independent of the above, unconditionally, for every camera ──
server (pipelineManager.js)
  ├─ Socket.IO `detections` / `loitering` / `fire:alert` / `alert:new` / ...
  └─ App RTP (ONVIF): Socket.IO `appRtp` (raw) + `onvif:event`/`onvif:temperature` (parsed)
                        + WebRTC DataChannel (mediasoup mode only, redundant with `appRtp`)
```

Detail on the RTSP ingestion fan-out itself (ports, health, YouTube sources) is covered by [RFP_RTSP_WebRTC_Architecture.md](RFP_RTSP_WebRTC_Architecture.md). Detail on what happens inside "active WebRTC engine" per engine is covered by [RFP_WebRTC_Engine_Modes.md](RFP_WebRTC_Engine_Modes.md).

---

## 4. Technology Decisions

### 4.1 Why a single WHEP endpoint instead of custom Socket.IO signaling

The client must work identically whether `WEBRTC_ENGINE` is `mediamtx` or `mediasoup`. Standardizing on **WHEP** (`POST .../whep/:cameraId`, SDP-offer-in/SDP-answer-out) means:
- `mediamtx` needs no custom server code beyond a byte-for-byte proxy to MediaMTX's own native WHEP endpoint (`mediamtxEngine.js`).
- `mediasoup` implements a `negotiate(cameraId, sdpOffer)` function that mimics the same WHEP contract on top of its Router/Transport/Producer/Consumer model (`mediasoupEngine.js`).
- The client (`useWebRTC.ts`) contains **zero** engine-specific branching — it only knows about the WHEP endpoint.

This was chosen over the originally-planned mediasoup-client capabilities-exchange protocol (§2) because that protocol is inherently mediasoup-specific and would have blocked the mediamtx engine from ever existing without a second, parallel signaling implementation.

### 4.2 Why ingest-daemon instead of FFmpeg dual-output

Covered in depth in [RFP_RTSP_WebRTC_Architecture.md](RFP_RTSP_WebRTC_Architecture.md) §4.1.3. Summary: a single PyAV session per camera avoids the "one camera, N concurrent RTSP clients" failure mode that many consumer/NVR cameras cannot sustain, and gives one process authority over frame pacing across all four fan-out destinations (JPEG/video RTP/audio RTP/App RTP).

### 4.3 Why AI events stay on Socket.IO permanently

The original plan (§2) intended to migrate `detections`/`loitering`/alerts onto the WebRTC DataChannel to reduce Socket.IO load. This was never implemented and is **not planned** — Socket.IO already fans these events out to `camera:subscribe` rooms cheaply, alerts must reach clients regardless of whether that camera has WebRTC enabled at all (JPEG-only cameras still need `loitering`/`alert:new`), and duplicating the delivery mechanism per-engine would have reintroduced the exact coupling problem §4.1 avoided.

---

## 5. Functional Requirements

### 5.1 Signaling (FR-WRTC-001~009)

| ID | Requirement |
|---|---|
| FR-WRTC-001 | The gateway MUST expose exactly one signaling endpoint, `POST /api/webrtc/whep/:cameraId`, accepting `Content-Type: application/sdp` with the raw SDP offer as the body. |
| FR-WRTC-002 | The endpoint MUST dispatch to the currently configured `WEBRTC_ENGINE`'s `negotiate(cameraId, sdpOffer)` implementation and return that engine's SDP answer, HTTP status, and WHEP-relevant headers (`Location`, `Link`, `ETag`) unchanged to the client. |
| FR-WRTC-003 | An empty or missing SDP body MUST return HTTP 400 before any engine is invoked. |
| FR-WRTC-004 | If the active engine throws or is unreachable, the endpoint MUST return HTTP 503 with `{ error }`, never a 5xx from an unhandled exception. |
| FR-WRTC-005 | No other WebRTC signaling channel (Socket.IO events, a second HTTP endpoint) MAY exist — this is enforced by absence, not by a runtime guard: the codebase must not reintroduce `webrtc:offer`/`webrtc:answer`/`webrtc:ice-candidate` handlers. |

### 5.2 Video Delivery (FR-WRTC-010~019)

| ID | Requirement |
|---|---|
| FR-WRTC-010 | Video MUST be forwarded from the camera's H.264 RTP stream to the browser without server-side re-encoding, regardless of active engine. |
| FR-WRTC-011 | The browser `<video>` element MUST receive the stream via `ontrack`; the client MUST synthesize a `MediaStream` when the SDP answer omits `a=msid` (observed with mediasoup). |
| FR-WRTC-012 | A camera with `webrtcEnabled=false` MUST instead deliver annotated JPEG frames via the Socket.IO `frame` event at the pipeline's configured FPS — this is a permanent per-camera mode, not a fallback-on-failure path. |
| FR-WRTC-013 | Engine-specific codec/payload-type negotiation detail (H.264 profile, payload type matching) is governed by [SRS_WebRTC_Engine_Modes.md](../srs/SRS_WebRTC_Engine_Modes.md), not by this document. |

### 5.3 Audio Delivery (FR-WRTC-020~029)

| ID | Requirement |
|---|---|
| FR-WRTC-020 | For cameras that carry an audio track, the gateway MUST deliver audio to the browser alongside video. |
| FR-WRTC-021 | If the camera's audio codec is already Opus, ingest-daemon MUST pass it through unmodified (pure RTP mux, no decode/encode). |
| FR-WRTC-022 | If the camera's audio codec is not Opus, ingest-daemon MUST transcode it to Opus on a dedicated worker thread separate from the main RTSP I/O thread, so a slow transcode cannot stall video/AI frame delivery. |
| FR-WRTC-023 | Cameras without an audio track MUST continue to stream video normally with no error. |
| FR-WRTC-024 | The client MUST provide a per-camera mute control that toggles `videoRef.current.muted` client-side, requiring no server round-trip or renegotiation. |

### 5.4 Application RTP / ONVIF (FR-WRTC-030~039)

| ID | Requirement |
|---|---|
| FR-WRTC-030 | ingest-daemon MUST extract Application RTP packets from the camera's RTSP session and POST them to `POST /api/internal/apprtp/:cameraId` as `{ pt, timestamp, seq, payload }`. |
| FR-WRTC-031 | The server MUST parse ONVIF `MetadataStream` XML from that payload into structured events (`{ topic, topicType, topicLabel, severity, state, items, ... }`) and broadcast them via Socket.IO `onvif:event` (persisted) or `onvif:temperature` (thermal, not persisted). |
| FR-WRTC-032 | Independently of §FR-WRTC-031, the server MUST also broadcast the raw, unparsed packet via Socket.IO `appRtp` to all connected clients — this path exists for consumers that need the raw payload rather than the parsed event. |
| FR-WRTC-033 | When `WEBRTC_ENGINE=mediasoup`, the same raw packet MUST additionally be forwarded to that camera's mediasoup `DataProducer` for delivery over the WebRTC DataChannel — this is a redundant delivery of the same data as FR-WRTC-032, not a distinct payload. |
| FR-WRTC-034 | When `WEBRTC_ENGINE=mediamtx`, no DataChannel path exists; FR-WRTC-032's Socket.IO `appRtp` is the only delivery mechanism. |
| FR-WRTC-035 | The client MUST de-duplicate FR-WRTC-032 and FR-WRTC-033 by `seq` when both are present (mediasoup mode only). |
| FR-WRTC-036 | Unrecognized ONVIF payloads MUST be logged and skipped, never crash the server. |

### 5.5 AI Event Delivery (FR-WRTC-040~049)

| ID | Requirement |
|---|---|
| FR-WRTC-040 | `detections`, `loitering`, `fire:alert`, `alert:new`, `snapshot:new`, `face_match`, and related AI/event Socket.IO messages MUST be emitted unconditionally for every camera, independent of `webrtcEnabled` or `WEBRTC_ENGINE`. |
| FR-WRTC-041 | These events MUST NOT be moved to, or duplicated onto, a WebRTC DataChannel — see §4.3 for rationale. Any future proposal to do so must update this RFP first. |
| FR-WRTC-042 | The client MUST join/leave the correct `camera:subscribe`/`camera:unsubscribe` Socket.IO room independent of whether that camera is rendered via `<video>` (WebRTC) or `<img>`(JPEG `frame`). |

### 5.6 Diagnostics (FR-WRTC-050~059)

| ID | Requirement |
|---|---|
| FR-WRTC-050 | `POST /api/webrtc/ice-test` MUST report the health and identity of the currently active engine (`{ testId, engine, ... }` on success; `{ error, engine, hint }` with HTTP 503 on failure). |
| FR-WRTC-051 | `GET /api/webrtc/ice-config` MUST return `{ stunUrls, turns }`, sourced from the `settings` DB table (seeded from `.env` on first read). |
| FR-WRTC-052 | `GET /api/webrtc/monitor` MUST be restricted to `NODE_ENV=development` or localhost requests, returning HTTP 403 otherwise. |
| FR-WRTC-053 | `GET /api/capabilities` is an **AI module** capability map (`{ ai, status }`) and MUST NOT be conflated with WebRTC codec/engine capabilities — no such endpoint exists today. |

---

## 6. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-WRTC-001 | Latency | Glass-to-glass latency (camera to browser) SHOULD be low enough for real-time security monitoring; no fixed millisecond SLA is currently measured/enforced in code — treat any specific number as aspirational, not verified. |
| NFR-WRTC-002 | Media encryption | All WebRTC media MUST use DTLS-SRTP; the WHEP signaling endpoint itself SHOULD run over HTTPS in production (`HTTPS_ENABLED=true`). |
| NFR-WRTC-003 | Reliability | A camera disconnect MUST cause a graceful teardown and automatic reconnect with backoff, mirroring `ingest-daemon`'s own reconnect behavior — not FFmpeg's `RETRY_DELAY`, which no longer applies to this path. |
| NFR-WRTC-004 | Backward compatibility | Socket.IO `camera:subscribe`/`detections`/`loitering`/alert events MUST remain fully functional for every camera regardless of WebRTC state (this is not a deprecated fallback — see §4.3). |
| NFR-WRTC-005 | Engine parity | The client MUST require zero code changes when `WEBRTC_ENGINE` is switched between `mediamtx` and `mediasoup` (verified by the shared WHEP contract, §4.1). |

---

## 7. API & Signaling Specification

### 7.1 WHEP Negotiation (the only signaling path)

```
Client → Server:  POST /api/webrtc/whep/:cameraId
                   Content-Type: application/sdp
                   Body: <SDP offer>

Server → Client:   HTTP 200/201
                    Content-Type: application/sdp
                    Location / Link / ETag headers (WHEP spec, forwarded from engine)
                    Body: <SDP answer>

                   — or, on engine failure —

                    HTTP 503  { "error": "WebRTC engine \"<engine>\" unreachable: <message>" }
```

Client flow (`useWebRTC.ts`): create `RTCPeerConnection` with recvonly video+audio transceivers → create a `DataChannel('init')` purely to force `m=application` into the offer (so a DataChannel is negotiable if the active engine provides one) → `createOffer()`/`setLocalDescription()` → wait up to ~2 s for host ICE candidates, filtering out `srflx`/`relay` (LAN-only deployment assumption) → `POST` the offer to the WHEP endpoint above → `setRemoteDescription(answer)`.

### 7.2 REST Endpoints

```
POST /api/webrtc/ice-test
  → 200 { testId, engine, ...engineInfo }        (engine healthy)
  → 503 { error, engine, hint }                  (engine unreachable)

DELETE /api/webrtc/ice-test/:testId
  → 200 { ok: true }                             (no-op; nothing to clean up)

GET /api/webrtc/ice-config
  → 200 { stunUrls: string[], turns: [{url, username, credential}] }

GET /api/webrtc/monitor        (dev-only / localhost-only)
  → 200 { serverMode, webrtcEngine, webrtc: {engine, ok}, pipelines, producerStats }
  → 403 { error: "monitor endpoint is dev-only" }   (other requesters)
```

There is no `GET /api/webrtc/stats` and no `GET /api/webrtc/capabilities` — both were planned in v1.x and never implemented; `ice-test`/`ice-config`/`monitor` above are the actual observability surface.

### 7.3 SERVER_IP / Engine-Specific ICE Configuration

ICE candidate configuration differs meaningfully between engines (mediamtx uses `mediamtx.yml`; mediasoup uses `SERVER_IP`/`SERVER_PUBLIC_IP`). See [ops/WebRTC_Engine_Modes_Guide.md](../ops/WebRTC_Engine_Modes_Guide.md) §6 for the authoritative environment-variable table — do not duplicate it here.

---

## 8. Delivery Model — WebRTC / Socket.IO / DataChannel

This is the section most likely to be misread from v1.x, so it is stated explicitly:

| Payload | Delivery mechanism | Condition |
|---|---|---|
| Video + audio (raw media) | WebRTC (WHEP, engine-specific transport) | `camera.webrtcEnabled = true` |
| Annotated JPEG frame | Socket.IO `frame` | `camera.webrtcEnabled = false` (mutually exclusive with the row above, per camera) |
| Detections, loitering, fire/smoke, alerts, face match, snapshots | Socket.IO (`detections`, `loitering`, `fire:alert`, `alert:new`, `snapshot:new`, `face_match`, ...) | **Always**, regardless of WebRTC state |
| Application RTP (ONVIF), raw | Socket.IO `appRtp` | **Always** |
| Application RTP (ONVIF), raw — redundant copy | WebRTC DataChannel | Only if `WEBRTC_ENGINE=mediasoup` **and** the browser's offer included `m=application` (always true today, §7.1) |
| Application RTP (ONVIF), parsed structured event | Socket.IO `onvif:event` / `onvif:temperature` | **Always** |

There is no message type on the DataChannel other than the raw App RTP passthrough above. `detections`/`loitering`/`fire`/`stream-stats` DataChannel message schemas documented in v1.x (§9 of that version) describe messages that are never sent by any code path in this repository.

---

## 9. File & Module Layout

```
server/src/
├── services/
│   ├── ingestDaemonCapture.js      Consumes ingest-daemon's JPEG callback (EventEmitter)
│   ├── webrtcEngineFactory.js      Selects mediamtx | mediasoup | werift by WEBRTC_ENGINE
│   ├── webrtc/
│   │   ├── mediamtxEngine.js       WHEP proxy to MediaMTX (default, active)
│   │   ├── mediasoupEngine.js      Worker Pool SFU + alt-PT cache (implemented, dormant)
│   │   └── weriftEngine.js         Stub, not implemented
│   ├── mediamtxManager.js          MediaMTX REST API path registration
│   └── pipelineManager.js          Orchestrates capture start/stop, Socket.IO emission,
│                                    per-camera useWebRTC/JPEG branch (§8)
├── routes/
│   └── internalApi.js              POST /api/internal/frame/:id, /apprtp/:id (ingest-daemon → server)
└── index.js                         POST /api/webrtc/whep/:id, /ice-test, GET /ice-config, /monitor

ingest-daemon/
└── ingest_daemon.py                 Python PyAV — single RTSP session, 4-way fan-out

client/src/
├── hooks/
│   └── useWebRTC.ts                 WHEP negotiation, ontrack, DataChannel appRtp listener,
│                                     freeze/ICE-failure watchdog + reconnect
└── components/
    └── CameraView.tsx               <video> rendering, mute button, canvas overlay
```

No `rtpIngestion.js`, `webrtcGateway.js`, `webrtcSession.js`, or `webrtcSignaling.js` exist — see §2.

---

## 10. Security Considerations

| Concern | Mitigation |
|---|---|
| Media encryption | DTLS-SRTP enforced by both engines; no plaintext RTP reaches the browser |
| Signaling endpoint | `POST /api/webrtc/whep/:cameraId` accepts unauthenticated requests by design (WHEP spec convention) — access control is expected at the network/reverse-proxy layer, not the endpoint itself |
| Local RTP | ingest-daemon and both engines bind RTP transports to `127.0.0.1` only |
| DataChannel injection | Incoming App RTP JSON is parsed defensively; malformed messages are logged and dropped, never executed |
| `/api/webrtc/monitor` | Restricted to dev/localhost (FR-WRTC-052) because it can reveal per-camera RTSP URLs (containing credentials) via `producerStats`/pipeline status |
| RTSP credentials | Never logged — enforced project-wide, see `.claude/CLAUDE.md` 보안 규칙 |

---

## 11. Glossary

| Term | Definition |
|---|---|
| **WHEP** | WebRTC-HTTP Egress Protocol — single HTTP POST carrying an SDP offer, response carrying the SDP answer; used here as the one signaling contract shared by both engines |
| **ingest-daemon** | Python/PyAV process that owns the single RTSP session per camera and fans it out to AI/video/audio/App-RTP consumers |
| **App RTP** | Application-layer RTP track (dynamic payload type) some IP cameras use to carry ONVIF metadata (motion, line-crossing, temperature, etc.) |
| **DataChannel** | WebRTC SCTP channel; in this codebase, carries only a redundant copy of App RTP, and only in mediasoup mode |
| **PlainTransport** | mediasoup transport receiving unencrypted RTP from a local process (ingest-daemon) — mediasoup-specific, see Engine Modes docs |
| **DTLS-SRTP** | Encryption layer mandatory for all WebRTC media in both engines |

---

## 12. Troubleshooting

Engine-specific troubleshooting (mediamtx path registration failures, mediasoup PT mismatches, Worker crashes) lives in [ops/WebRTC_Engine_Modes_Guide.md](../ops/WebRTC_Engine_Modes_Guide.md) §5 — do not duplicate here. This section covers only the gateway contract layer:

| Symptom | Likely cause | Check |
|---|---|---|
| `POST /api/webrtc/whep/:cameraId` returns 503 | Active engine unreachable | `POST /api/webrtc/ice-test` for engine health + `hint` field |
| `POST /api/webrtc/whep/:cameraId` returns 400 | Client sent empty/missing SDP body, or wrong `Content-Type` | Confirm `Content-Type: application/sdp` and non-empty body |
| Video plays but no detections/alerts arrive | Not a WebRTC issue — check Socket.IO `camera:subscribe` room join | Confirm client joined the room; check `pipelineManager.js` emit logs |
| No audio despite `webrtcEnabled=true` and camera has an audio track | Check ingest-daemon audio thread logs for transcode failures (§5.3) | `grep "Audio RTP" ingest-daemon logs` |
| App RTP events missing on DataChannel but present via Socket.IO `appRtp` | Expected when `WEBRTC_ENGINE=mediamtx` — no DataChannel exists in that mode (§8) | Confirm `WEBRTC_ENGINE` setting |

---

## 13. Related Documents

| 문서 | 경로 | 관계 |
|---|---|---|
| RTSP → WebRTC 아키텍처 | [design/Design_RTSP_WebRTC_Architecture.md](../design/Design_RTSP_WebRTC_Architecture.md) | 인제스트 레이어 상세 |
| RTSP → WebRTC 아키텍처 RFP | [rfp/RFP_RTSP_WebRTC_Architecture.md](RFP_RTSP_WebRTC_Architecture.md) | 인제스트 백엔드/미디어 릴레이 기술 평가, M1~M5 로드맵 |
| WebRTC 엔진 선택 | [design/Design_WebRTC_Engine_Modes.md](../design/Design_WebRTC_Engine_Modes.md) | mediamtx/mediasoup 내부 동작 상세 |
| WebRTC 엔진 선택 RFP | [rfp/RFP_WebRTC_Engine_Modes.md](RFP_WebRTC_Engine_Modes.md) | 엔진 비교·채택 근거 |
| 운영 가이드 | [ops/WebRTC_Engine_Modes_Guide.md](../ops/WebRTC_Engine_Modes_Guide.md) | 엔진 전환·트러블슈팅 |
| PRD | [prd/PRD_WebRTC_Media_Gateway.md](../prd/PRD_WebRTC_Media_Gateway.md) | 제품 요구사항 |
| SRS | [srs/SRS_WebRTC_Media_Gateway.md](../srs/SRS_WebRTC_Media_Gateway.md) | 검증 가능 요구사항 |
| TC | [tc/TC_WebRTC_Media_Gateway.md](../tc/TC_WebRTC_Media_Gateway.md) | 테스트 케이스 |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for WebRTC Media Gateway |
| 1.2 | 2026-06-16 | LTS Engineering Team | §5.1 FR-V-6/FR-V-7 추가 — mediasoup PT=109 H264 제약 및 ICE listenIps env-var 전용 요구사항 |
| 1.3 | 2026-07-23 | LTS Engineering Team | 문서 상단에 정확성 안내 추가 — 본 문서의 FFmpeg 듀얼출력/mediasoup-client 시그널링 아키텍처는 미구현이며, 실제 엔진 동작은 `RFP_WebRTC_Engine_Modes.md`/`Design_WebRTC_Engine_Modes.md` 참조 |
| 2.0 | 2026-07-23 | LTS Engineering Team | 전면 재작성 — 실제 코드(ingest-daemon, 단일 WHEP 엔드포인트, Socket.IO/WebRTC/DataChannel 하이브리드 전달 모델) 기준으로 FR-WRTC-001~053 재정의, §2 계획 대비 실제 구현 차이표 신설, 존재하지 않는 파일/엔드포인트/메시지 스키마 전체 제거 |
