# TEST CASES (TC)
# YouTube → RTSP Ingest Service

| | |
|---|---|
| **Document ID** | TC-LTS-YT-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_YouTube_RTSP_Ingest.md |
| **Test Scripts** | test/api/youtube_streams.test.js |
| **TC Mode** | `captureOnly: true` — **`SERVER_MODE=analysis`에서 스킵** (YouTubeStreamService 비활성) |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — URL Validation & Stream Limits](#3-test-group-a--url-validation--stream-limits)
4. [Test Group B — Process Management (yt-dlp + FFmpeg)](#4-test-group-b--process-management-yt-dlp--ffmpeg)
5. [Test Group C — State Machine](#5-test-group-c--state-machine)
6. [Test Group D — REST API](#6-test-group-d--rest-api)
7. [Test Group E — MediaMTX Integration](#7-test-group-e--mediamtx-integration)
8. [Test Group F — UI](#8-test-group-f--ui)
9. [Test Group G — Performance](#9-test-group-g--performance)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | Create/list/stop/restart YouTube streams | Node.js fetch | `test/api/youtube_streams.test.js` |
| Unit | URL validation, state machine transitions | Jest | `test/unit/youtube_streams.test.js` (Phase-2) |
| Integration | yt-dlp + FFmpeg process lifecycle, state machine | Node.js | `test/integration/youtube_pipeline.test.js` (Phase-2) |
| E2E | Dashboard YouTube stream playback | Playwright | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-YT-001 | TC-A-001 |
| FR-YT-002 | TC-A-002 |
| FR-YT-003 | TC-A-003 |
| FR-YT-004 | TC-D-001 |
| FR-YT-005 | TC-D-001 |
| FR-YT-010 | TC-B-001 |
| FR-YT-011 | TC-B-002 |
| FR-YT-012 | TC-B-003 |
| FR-YT-013 | TC-B-004 |
| FR-YT-014 | TC-E-001 |
| FR-YT-015 | TC-B-005 |
| FR-YT-020 | TC-C-001 |
| FR-YT-021 | TC-C-002 |
| FR-YT-022 | TC-C-003 |
| FR-YT-023 | TC-C-004 |
| FR-YT-024 | TC-C-005 |
| FR-YT-025 | TC-C-006 |
| FR-YT-026 | TC-D-001 |
| FR-YT-030 | TC-D-002 |
| FR-YT-031 | TC-D-003 |
| FR-YT-032 | TC-D-004 |
| FR-YT-033 | TC-D-005 |
| FR-YT-034 | TC-D-006 |
| FR-YT-035 | TC-D-007 |
| FR-YT-036 | TC-D-008 |
| FR-YT-040 | TC-E-001 |
| FR-YT-041 | TC-E-002 |
| FR-YT-042 | TC-E-003 |
| FR-YT-050 | TC-F-001 |
| FR-YT-051 | TC-F-002 |
| FR-YT-052 | TC-F-003 |
| FR-YT-053 | TC-F-004 |
| FR-YT-054 | TC-F-005 |
| FR-YT-060 | TC-G-001 |
| FR-YT-061 | TC-G-002 |
| FR-YT-062 | TC-G-003 |
| FR-YT-063 | TC-G-004 |
| FR-YT-064 | TC-G-005 |
| FR-YT-065 | TC-G-006 |
| FR-YT-066 | TC-G-007 |
| FR-YT-067 | TC-A-004 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| Valid YouTube URL (`https://www.youtube.com/watch?v=...`) | Basic create test |
| Invalid URL (`https://example.com/notYouTube`) | URL validation test |
| Resolution/bitrate table fixture (360p/800k, 720p/2000k, 1080p/4000k) | Resolution/bitrate tests |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3080`
- `yt-dlp` and `ffmpeg` installed and on PATH
- MediaMTX running and accessible on `127.0.0.1:8554`
- `GET /health` returns `{ status: 'ok' }`

---

## 3. Test Group A — URL Validation & Stream Limits

### TC-A-001 — Valid YouTube URL Accepted
- **Input:** `POST /api/youtube-streams` with `{ youtubeUrl: "https://www.youtube.com/watch?v=XXXXXXXXXXX", name: "Test", resolution: "720p" }`
- **Expected:** HTTP 201; stream entry created
- **Acceptance:** `success: true`, `id` present in response

### TC-A-002 — Max Streams Limit
- **Input:** Create streams up to `MAX_STREAMS` limit (default 4); attempt to create one more
- **Expected:** HTTP 429; `{ code: "MAX_STREAMS_REACHED" }`
- **Acceptance:** 5th stream rejected with 429

### TC-A-003 — Unique ID Generation
- **Input:** Create 3 YouTube streams
- **Expected:** Each stream has unique UUID `id`
- **Acceptance:** All 3 IDs distinct and valid UUIDs

### TC-A-004 — URL Security: Only youtube.com / youtu.be
- **Input 1:** `https://malicious.site.com/watch?v=test`
- **Expected:** HTTP 422; `{ code: "INVALID_YOUTUBE_URL" }`
- **Input 2:** `https://www.youtube.com/watch?v=VALID123`
- **Expected:** HTTP 201
- **Acceptance:** Non-YouTube URLs rejected; valid YouTube URLs accepted

---

## 4. Test Group B — Process Management (yt-dlp + FFmpeg)

### TC-B-001 — yt-dlp Invocation
- **Input:** Create YouTube stream; stream enters `starting` state
- **Expected:** yt-dlp process spawned with `--format` preference for H.264; output piped to FFmpeg stdin
- **Acceptance:** yt-dlp process running; stdout piped to FFmpeg

### TC-B-002 — FFmpeg Invocation
- **Input:** yt-dlp running; FFmpeg spawned
- **Expected:** FFmpeg reads from stdin (yt-dlp pipe); outputs RTSP to `rtsp://127.0.0.1:8554/<id>`
- **Acceptance:** FFmpeg process running with correct input/output args

### TC-B-003 — Resolution/Bitrate Mapping
- **Input:** Create stream with `resolution: "720p"`
- **Expected:** FFmpeg invoked with `-vf scale=1280:720`; bitrate set to 2000k (720p default)
- **Acceptance:** Correct scale and bitrate args in FFmpeg command

### TC-B-004 — Live Stream Detection
- **Input:** Create stream from YouTube live URL
- **Expected:** `isLive: true` reported in stream status
- **Acceptance:** Live streams correctly identified via yt-dlp output

### TC-B-005 — Binary Detection
- **Input:** Remove yt-dlp from PATH; attempt to create stream
- **Expected:** HTTP 503; `{ code: "YTDLP_NOT_FOUND" }`
- **Input 2:** Remove ffmpeg from PATH
- **Expected:** HTTP 503; `{ code: "FFMPEG_NOT_FOUND" }`
- **Acceptance:** Missing binaries return 503 with specific error code

---

## 5. Test Group C — State Machine

### TC-C-001 — State Transitions
- **Input:** Create stream; observe status progression
- **Expected:** States: `idle` → `starting` → `fetching` → `converting` → `live`
- **Acceptance:** Each state reached in order; no state skipped

### TC-C-002 — Error State Transition
- **Input:** Create stream with unavailable video (deleted/private)
- **Expected:** State transitions to `error` when yt-dlp or FFmpeg fails
- **Acceptance:** Status = `error`; `errorMessage` populated

### TC-C-003 — restartCount Increment
- **Input:** Stream enters error state; auto-restart kicks in
- **Expected:** `restartCount` increments on each restart attempt
- **Acceptance:** Counter reflects number of restart attempts

### TC-C-004 — Natural End Detection
- **Input:** Stream from short VOD; video finishes playing
- **Expected:** FFmpeg exits with `code=0, signal=null`; classified as natural end
- **Acceptance:** `isNaturalEnd = true` when `code===0` and `signal===null`

### TC-C-005 — Env Override for State Machine Constants
- **Input:** Set `YOUTUBE_MAX_RESTARTS=2` env var
- **Expected:** Stream auto-restart stops after 2 attempts; transitions to `error` permanently
- **Acceptance:** Restart count limited to env-specified value

### TC-C-006 — SIGTERM Handler
- **Input:** Send SIGTERM to server process with active YouTube streams
- **Expected:** All yt-dlp and FFmpeg processes killed; streams set to `idle`; no orphaned processes
- **Acceptance:** Zero orphaned processes after SIGTERM

---

## 6. Test Group D — REST API

### TC-D-001 — Create Stream (POST)
- **Input:** `POST /api/youtube-streams` with valid payload
- **Expected:** HTTP 201; stream entry returned with all fields
- **Acceptance:** `id`, `name`, `youtubeUrl`, `rtspUrl`, `resolution`, `status` all present

### TC-D-002 — List Streams (GET)
- **Input:** `GET /api/youtube-streams` with 2 streams active
- **Expected:** HTTP 200; array of 2 stream entries
- **Acceptance:** Both streams in response with correct fields

### TC-D-003 — Get Status (GET one)
- **Input:** `GET /api/youtube-streams/:id`
- **Expected:** HTTP 200; single stream entry with current `status`
- **Acceptance:** Correct status reflected

### TC-D-004 — Update Stream (PATCH)
- **Input:** `PATCH /api/youtube-streams/:id` with `{ resolution: "1080p" }`
- **Expected:** HTTP 200; stream updated; restart triggered with new settings
- **Acceptance:** New resolution applied; `status` transitions through `starting` again

### TC-D-005 — Delete Stream (DELETE)
- **Input:** `DELETE /api/youtube-streams/:id`
- **Expected:** HTTP 200; stream processes stopped and removed from list
- **Acceptance:** `GET /api/youtube-streams/:id` returns 404 after deletion

### TC-D-006 — Restart Stream (POST restart)
- **Input:** `POST /api/youtube-streams/:id/restart` on stream in `error` state
- **Expected:** HTTP 200; stream re-enters `starting` state; `restartCount` reset
- **Acceptance:** Stream attempts to restart; status changes from `error`

### TC-D-007 — Restart Already Running
- **Input:** `POST /api/youtube-streams/:id/restart` on `live` stream
- **Expected:** HTTP 409; `{ code: "STREAM_ALREADY_RUNNING" }`
- **Acceptance:** No restart initiated; error code returned

### TC-D-008 — Stream Not Found
- **Input:** Any operation on non-existent stream ID
- **Expected:** HTTP 404; `{ code: "STREAM_NOT_FOUND" }`
- **Acceptance:** 404 with specific error code

---

## 7. Test Group E — MediaMTX Integration

### TC-E-001 — RTSP to localhost Only
- **Input:** Inspect FFmpeg RTSP output target
- **Expected:** FFmpeg outputs to `rtsp://127.0.0.1:8554/<id>` (localhost only; not 0.0.0.0)
- **Acceptance:** RTSP output bound to 127.0.0.1 only

### TC-E-002 — MediaMTX Webhook (publish)
- **Input:** Stream starts; MediaMTX calls publish webhook
- **Expected:** Server receives `POST /mediamtx/publish`; stream status updated to `live`
- **Acceptance:** Status = `live` after webhook received

### TC-E-003 — MediaMTX Webhook (unpublish)
- **Input:** Stream stops; MediaMTX calls unpublish webhook
- **Expected:** Server receives `POST /mediamtx/unpublish`; stream status updated
- **Acceptance:** Status no longer `live` after unpublish webhook

---

## 8. Test Group F — UI

### TC-F-001 — YouTube Tab in Add Camera Modal
- **Input:** Open Add Camera modal; click YouTube tab
- **Expected:** YouTube-specific fields visible: URL, stream name, resolution dropdown
- **Acceptance:** Tab visible; all 3 fields present

### TC-F-002 — YT Badge on Camera Tile
- **Input:** YouTube camera added; camera grid visible
- **Expected:** Camera tile shows red "YT" badge
- **Acceptance:** Badge visible and red

### TC-F-003 — Error Overlay
- **Input:** YouTube stream enters error state
- **Expected:** Error overlay on camera tile; error message displayed
- **Acceptance:** Error text visible on camera tile; overlay distinguishes from normal state

### TC-F-004 — Edit Modal
- **Input:** Click edit on YouTube camera
- **Expected:** Edit modal shows current URL, resolution, bitrate; RTSP URL displayed but read-only
- **Acceptance:** All current settings visible; RTSP URL read-only

### TC-F-005 — Full LTS Pipeline Support
- **Input:** YouTube stream reaches `live` status; AI detection enabled
- **Expected:** Detections, zones, alerts all function on YouTube stream same as RTSP camera
- **Acceptance:** Full LTS pipeline active for YouTube-sourced video

---

## 9. Test Group G — Performance

### TC-G-001 — Stream Startup ≤ 30 Seconds
- **Input:** Create YouTube stream; measure time to `live` status
- **Expected:** Status reaches `live` within 30 seconds
- **Acceptance:** Startup time ≤ 30 s for typical YouTube video

### TC-G-002 — E2E Latency ≤ 5 Seconds
- **Input:** YouTube stream `live`; browser displays video
- **Expected:** First frame visible in browser within 5 seconds of `live` status
- **Acceptance:** UI shows video within 5 seconds of live state

### TC-G-003 — 4 Concurrent Streams
- **Input:** 4 simultaneous YouTube streams (different URLs) at 720p
- **Expected:** All 4 streams reach `live` status; no resource exhaustion
- **Acceptance:** All 4 live simultaneously

### TC-G-004 — CPU ≤ 15% Per Stream
- **Input:** Single 720p YouTube stream running
- **Expected:** CPU usage for yt-dlp + FFmpeg per stream ≤ 15%
- **Acceptance:** CPU within limit on 4-core machine

### TC-G-005 — RAM ≤ 150 MB Per Stream
- **Input:** Single 720p YouTube stream running for 5 minutes
- **Expected:** RSS memory for yt-dlp + FFmpeg ≤ 150 MB per stream
- **Acceptance:** Memory stable; no leak over 5 minutes

### TC-G-006 — Restart ≤ 10 Seconds
- **Input:** Stream enters error state; auto-restart triggered
- **Expected:** Stream returns to `live` within 10 seconds after restart
- **Acceptance:** Recovery time ≤ 10 s

### TC-G-007 — Process Isolation
- **Input:** One stream crashes its FFmpeg process
- **Expected:** Other streams unaffected; only failed stream enters error state
- **Acceptance:** No cascading failures across streams

---

## 10. Test Execution Order

```
Group A (validation/limits) → Group D (REST API) → Group B (processes) → Group C (state machine) → Group E (MediaMTX) → Group F (UI) → Group G (performance)
```

---

## 11. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| URL Validation | YouTube-only URLs; max 4 concurrent; UUID IDs |
| Process Management | yt-dlp + FFmpeg correct args; binary detection; localhost-only RTSP |
| State Machine | All 6 states reachable; correct transitions; env override; SIGTERM clean |
| REST API | All 7 operations (create, list, get, patch, delete, restart, error handling) |
| MediaMTX | localhost RTSP; publish/unpublish webhooks update status |
| UI | YouTube tab; YT badge; error overlay; edit modal; full pipeline |
| Performance | ≤ 30s startup; ≤ 5s E2E; 4 concurrent; ≤ 15% CPU; ≤ 150 MB RAM; isolation |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for YouTube RTSP Ingest |
| 1.1 | 2026-06-26 | LTS Engineering Team | captureOnly 모드 표기 추가 (SERVER_MODE=analysis 스킵); _startStream() spawn 위치 명시 |
