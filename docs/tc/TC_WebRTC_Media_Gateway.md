# TEST CASES (TC)
# WebRTC Media Gateway

| | |
|---|---|
| **Document ID** | TC-LTS-WRTC-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_WebRTC_Media_Gateway.md |
| **Test Scripts** | test/api/webrtc.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Codec & Media Configuration](#3-test-group-a--codec--media-configuration)
4. [Test Group B — Socket.IO Signaling](#4-test-group-b--socketio-signaling)
5. [Test Group C — Router & Worker Lifecycle](#5-test-group-c--router--worker-lifecycle)
6. [Test Group D — DataChannel Messages](#6-test-group-d--datachannel-messages)
7. [Test Group E — Fallback & Reconnect](#7-test-group-e--fallback--reconnect)
8. [Test Group F — REST API](#8-test-group-f--rest-api)
9. [Test Group G — Performance & Security](#9-test-group-g--performance--security)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)
12. [Post-Patch Stability Verification](#12-post-patch-stability-verification)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | `/api/webrtc/stats`, `/api/capabilities` | Node.js fetch | `test/api/webrtc.test.js` |
| Integration | Socket.IO signaling round-trip | socket.io-client | `test/integration/webrtc_signaling.test.js` (Phase-2) |
| E2E | Full browser WebRTC video playback | Playwright | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-WRTC-001 | TC-A-001 |
| FR-WRTC-002 | TC-A-002 |
| FR-WRTC-003 | TC-A-003 |
| FR-WRTC-004 | TC-A-004 |
| FR-WRTC-005 | TC-A-005 |
| FR-WRTC-006 | TC-A-006 |
| FR-WRTC-007 | TC-A-007 |
| FR-WRTC-010 | TC-B-001 |
| FR-WRTC-011 | TC-B-002 |
| FR-WRTC-012 | TC-B-003 |
| FR-WRTC-013 | TC-B-004 |
| FR-WRTC-014 | TC-B-005 |
| FR-WRTC-015 | TC-B-006 |
| FR-WRTC-020 | TC-C-001 |
| FR-WRTC-021 | TC-C-002 |
| FR-WRTC-022 | TC-C-003 |
| FR-WRTC-023 | TC-C-004 |
| FR-WRTC-024 | TC-C-005 |
| FR-WRTC-030 | TC-D-001 |
| FR-WRTC-031 | TC-D-002 |
| FR-WRTC-032 | TC-D-003 |
| FR-WRTC-033 | TC-D-004 |
| FR-WRTC-040 | TC-E-001 |
| FR-WRTC-041 | TC-E-002 |
| FR-WRTC-042 | TC-E-003 |
| FR-WRTC-050 | TC-F-001 |
| FR-WRTC-051 | TC-F-002 |
| FR-WRTC-060 | TC-G-001 |
| FR-WRTC-061 | TC-G-002 |
| FR-WRTC-062 | TC-G-003 |
| FR-WRTC-063 | TC-G-004 |
| FR-WRTC-064 | TC-G-005 |
| FR-WRTC-065 | TC-G-006 |
| FR-WRTC-066 | TC-H-001 |
| FR-WRTC-067 | TC-H-002 |
| FR-WRTC-068 | TC-H-003 |
| FR-WRTC-069 | TC-H-004 |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3080`
- `WEBRTC_ENABLED=true` environment variable set
- mediasoup worker dependencies installed
- `GET /api/capabilities` returns `webrtcEnabled: true`
- MediaMTX running for RTSP source

---

## 3. Test Group A — Codec & Media Configuration

### TC-A-001 — mediasoup Codec Registration
- **Input:** `GET /api/capabilities`
- **Expected:** Response includes supported codecs including H.264 and Opus
- **Acceptance:** `codecs` array contains H.264 (`video/H264`) and Opus (`audio/opus`)

### TC-A-002 — H.264 Passthrough
- **Input:** RTSP source with H.264 video; WebRTC consumer subscribes
- **Expected:** H.264 frames forwarded directly without transcoding
- **Acceptance:** No CPU transcoding spike; received video is H.264

### TC-A-003 — Audio Transcoding
- **Input:** Camera with audio (non-Opus codec); WebRTC consumer
- **Expected:** Audio transcoded to Opus via FFmpeg; forwarded to WebRTC
- **Acceptance:** Audio received by client as Opus

### TC-A-004 — Port Allocation
- **Input:** mediasoup Worker initialized
- **Expected:** Port range defined (e.g., 10000–59999); no ports below 1024 used
- **Acceptance:** All mediasoup ports within configured range

### TC-A-005 — PlainTransport comedia
- **Input:** FFmpeg -> mediasoup PlainTransport connection
- **Expected:** `comedia: true` set on PlainTransport (FFmpeg-initiated comedia mode)
- **Acceptance:** FFmpeg can send RTP to PlainTransport without prior server-side IP configuration

### TC-A-006 — DataProducer
- **Input:** Detection data available for camera
- **Expected:** DataProducer created on PlainTransport; detection data sent via SCTP
- **Acceptance:** Detection data arrives at client DataChannel

### TC-A-007 — Dual FFmpeg Output
- **Input:** Camera pipeline active with WebRTC enabled
- **Expected:** Single FFmpeg process outputs to both (1) RTMP/RTSP path and (2) mediasoup RTP port
- **Acceptance:** Both outputs active simultaneously; no process duplication

---

## 4. Test Group B — Socket.IO Signaling

### TC-B-001 — getCapabilities Event
- **Input:** Client emits `getCapabilities`
- **Expected:** Server responds with `routerRtpCapabilities` (mediasoup router capabilities)
- **Acceptance:** Response contains valid mediasoup RTP capabilities object

### TC-B-002 — createTransport Event
- **Input:** Client emits `createTransport` with `{ direction: "recv" }`
- **Expected:** Server creates WebRtcTransport; responds with transport parameters (id, iceParameters, iceCandidates, dtlsParameters)
- **Acceptance:** All 4 transport parameter fields present in response

### TC-B-003 — connectTransport Event
- **Input:** Client emits `connectTransport` with DTLS parameters
- **Expected:** Server connects transport; no error emitted
- **Acceptance:** Transport state becomes 'connected'; no error event

### TC-B-004 — consume Event
- **Input:** Client emits `consume` with `{ cameraId, rtpCapabilities }`
- **Expected:** Server creates Consumer; responds with `{ id, producerId, kind, rtpParameters }`
- **Acceptance:** Consumer created for requested camera; all 4 fields present

### TC-B-005 — resumeConsumer Event
- **Input:** Client emits `resumeConsumer` with consumer ID
- **Expected:** Consumer unpaused; media flowing
- **Acceptance:** Consumer state transitions to 'active'; media received by client

### TC-B-006 — leave Event
- **Input:** Client emits `leave` or disconnects
- **Expected:** All consumers and transports for that socket cleaned up
- **Acceptance:** mediasoup resources released; no memory leak on disconnect

---

## 5. Test Group C — Router & Worker Lifecycle

### TC-C-001 — Router Lifecycle Per Camera
- **Input:** Camera registered with WebRTC enabled; camera deleted
- **Expected:** mediasoup Router created when camera added; Router closed when camera deleted
- **Acceptance:** No orphaned Routers after camera deletion

### TC-C-002 — Worker Config
- **Input:** mediasoup Worker initialized
- **Expected:** Worker config applies `logLevel: 'warn'` (or configured level); no debug spam in production
- **Acceptance:** Log output matches configured level

### TC-C-003 — Multi-Subscriber
- **Input:** 3 browsers subscribe to same camera simultaneously
- **Expected:** Each browser receives independent Consumer; all receive same media
- **Acceptance:** 3 concurrent consumers active; all 3 browsers receive video

### TC-C-004 — SERVER_IP Auto-Detect
- **Input:** `SERVER_IP` env var not set
- **Expected:** Server auto-detects local IP for ICE host candidates; WebRTC connection succeeds on LAN
- **Acceptance:** ICE candidates contain correct host IP for local network access

### TC-C-005 — PLI/FIR Handling
- **Input:** Simulate packet loss causing video corruption
- **Expected:** mediasoup sends PLI (Picture Loss Indication) or FIR to FFmpeg; video recovers with keyframe
- **Acceptance:** Video recovered after packet loss event; no persistent corruption

---

## 6. Test Group D — DataChannel Messages

### TC-D-001 — DataChannel Message Types
- **Input:** Detection data flowing; client DataChannel open
- **Expected:** Messages of type `detection`, `loitering_alert`, `camera_status` received on DataChannel
- **Acceptance:** All 3 message types observed during normal operation

### TC-D-002 — Message Schema
- **Input:** Receive `detection` DataChannel message
- **Expected:** Parsed JSON contains `type`, `cameraId`, `timestamp`, and `data` fields
- **Acceptance:** All 4 fields present; JSON valid

### TC-D-003 — Reliability Modes
- **Input:** Inspect DataChannel creation parameters
- **Expected:** Time-sensitive messages (detections) use `maxRetransmits: 0` (unreliable); alerts use ordered/reliable channel
- **Acceptance:** Different reliability settings per message criticality

### TC-D-004 — JSON Error Handling
- **Input:** Inject malformed DataChannel message from server
- **Expected:** Client DataChannel handler catches JSON parse error; does not crash; logs error
- **Acceptance:** Client remains operational after malformed message; error logged without crash

---

## 7. Test Group E — Fallback & Reconnect

### TC-E-001 — WEBRTC_ENABLED = false
- **Input:** `WEBRTC_ENABLED=false` set; refresh page
- **Expected:** Dashboard falls back to RTSP/WebRTC-free mode; mediasoup not initialized
- **Acceptance:** No mediasoup workers created; video displayed via fallback method

### TC-E-002 — Socket.IO Fallback
- **Input:** WebRTC connection fails (blocked port); fallback triggered
- **Expected:** `detections` and events still delivered via Socket.IO
- **Acceptance:** Detection events still received; no connection error blocking all functionality

### TC-E-003 — ICE Reconnect Button
- **Input:** WebRTC connection drops; reconnect button visible; user clicks it
- **Expected:** New WebRTC negotiation initiated; transport re-created; video resumes
- **Acceptance:** Video resumes after reconnect button click; no page reload needed

---

## 8. Test Group F — REST API

### TC-F-001 — Stats Endpoint
- **Input:** `GET /api/webrtc/stats` with 2 active consumers
- **Expected:** HTTP 200; response includes active consumers count, producers count, transport count
- **Acceptance:** Counts match actual active mediasoup resources

### TC-F-002 — Capabilities Endpoint
- **Input:** `GET /api/capabilities`
- **Expected:** HTTP 200; response includes `webrtcEnabled: true/false` and supported codecs when enabled
- **Acceptance:** `webrtcEnabled` reflects `WEBRTC_ENABLED` env var; codecs listed when enabled

---

## 9. Test Group G — Performance & Security

### TC-G-001 — Latency ≤ 300 ms
- **Input:** Camera pipeline active; browser playing WebRTC stream
- **Expected:** End-to-end latency from camera to browser ≤ 300 ms on local network
- **Acceptance:** Measured latency consistently ≤ 300 ms (Phase-3 manual test)

### TC-G-002 — Audio ≤ 50 kbps
- **Input:** Camera with audio; WebRTC consumer active
- **Expected:** Opus audio bitrate ≤ 50 kbps
- **Acceptance:** Measured audio bitrate ≤ 50 kbps via `getStats()`

### TC-G-003 — CPU ≤ 70% Under Load
- **Input:** 4 concurrent WebRTC streams
- **Expected:** Server CPU usage ≤ 70% (no hardware encode)
- **Acceptance:** CPU monitored during 4-stream test; stays below 70%

### TC-G-004 — DTLS-SRTP Required
- **Input:** WebRTC connection attempt
- **Expected:** All WebRTC media encrypted via DTLS-SRTP; no unencrypted RTP to clients
- **Acceptance:** `dtlsState: 'connected'` on all transports; no unencrypted media paths to clients

### TC-G-005 — Browser Compatibility
- **Input:** Open dashboard in Chrome, Firefox, Safari (if available)
- **Expected:** WebRTC streams work in all 3 browsers
- **Acceptance:** Video plays correctly in each supported browser

### TC-G-006 — Graceful Reconnect on Network Drop
- **Input:** Simulate network interruption; wait 5 seconds; restore network
- **Expected:** WebRTC reconnection attempted automatically; video resumes within 30 seconds
- **Acceptance:** Video resumes without manual page reload

---

## 10. Test Execution Order

```
Group F (REST API) → Group A (codec config) → Group C (router lifecycle) → Group B (signaling) → Group D (DataChannel) → Group E (fallback) → Group G (performance/security)
```

---

## 11. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Codecs | H.264 passthrough; Opus audio; port range within config |
| Signaling | All 6 Socket.IO events handled correctly |
| Router/Worker | Per-camera Router lifecycle; multi-subscriber; PLI/FIR recovery |
| DataChannel | 3 message types; schema valid; reliability modes; error handling |
| Fallback | WEBRTC_ENABLED gate; Socket.IO fallback; reconnect button |
| REST API | Stats and capabilities endpoints return correct data |
| Performance | ≤ 300 ms latency; ≤ 50 kbps audio; ≤ 70% CPU; DTLS-SRTP enforced |

---

## 12. Post-Patch Stability Verification

### TC-H-001 — Duplicate Camera Subscribe Guard
- **Input:** Same socket emits `camera:subscribe` for identical camera multiple times.
- **Expected:** Only one effective room join; no repeated subscribe churn.
- **Acceptance:** Server logs at most one subscribe line per socket-camera pair for a single join session.

### TC-H-002 — Duplicate createTransport Reuse
- **Input:** Same socket emits repeated `webrtc:createTransport` for the same camera while an active transport exists.
- **Expected:** Existing active transport is reused.
- **Acceptance:** No additional transport allocation for duplicate calls; session remains stable.

### TC-H-003 — Timestamp Stability Warnings
- **Input:** Run WebRTC playback for at least 2 minutes on configured RTSP camera.
- **Expected:** Timestamp-related FFmpeg warnings do not recur.
- **Acceptance:** Log contains no `Non-monotonous DTS` and no `Queue input is backward in time` warnings.

### TC-H-004 — Connected but Frozen Stream Recovery
- **Input:** Maintain WebRTC session while inducing transient stream stall conditions.
- **Expected:** Client detects no inbound media progress and performs controlled reconnect.
- **Acceptance:** Playback resumes without full page reload; ICE state returns to `connected/completed`.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for WebRTC Media Gateway |
| 1.1 | 2026-05-29 | LTS Engineering Team | Added post-patch stability verification (TC-H-001 ~ TC-H-004) |
