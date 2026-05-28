# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# YouTube URL → RTSP Ingest & Virtual Camera Channel

| | |
|---|---|
| **Document ID** | PRD-LTS-004 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_YouTube_RTSP_Ingest.md (LTS-2026-004 v1.1) |

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

The YouTube RTSP Ingest subsystem extends LTS-2026 beyond physical IP cameras by allowing operators to supply any YouTube URL and receive a fully functional virtual camera channel — indistinguishable from a hardware camera — that participates in AI detection, zone analysis, alert generation, and WebRTC video delivery.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Accept YouTube URLs (watch, youtu.be, and Shorts formats) from the operator via the dashboard UI and register them as virtual camera channels in the LTS pipeline.
- Resolve the best-quality adaptive stream via `yt-dlp` in pipe mode, bypassing SSL certificate restrictions present in corporate network environments.
- Re-encode and publish the resolved stream as an H.264 RTSP endpoint on a local MediaMTX server, making it available to the existing `pipelineManager.js` with no changes required to that component.
- Provide automatic stream looping and error-recovery restart with configurable maximum retry count and back-off delay.
- Enforce security controls: URL validation, child process spawn safety, MediaMTX loopback binding, and maximum stream count limit.

### 2.2 Non-Goals

- Age-restricted, private, or DRM-protected YouTube videos are not supported in the MVP; the system returns a descriptive error and does not attempt cookie injection.
- DVR seek or timeline scrubbing is out of scope; virtual channels have no concept of a current playback position.
- GPU-accelerated encoding is not in scope for the initial release.

---

## 3. User Personas

**System Integrator (UC-1)** — Tests AI models against real-world YouTube reference footage (crowd loitering, fire/smoke) without deploying physical cameras on-site.

**QA Engineer (UC-2)** — Reproduces specific edge-case scenarios (stadium crowds, rain occlusion, night footage) on demand by pasting a YouTube link into the dashboard. Requires the virtual channel to persist for long test runs.

**Sales / Demo Engineer (UC-3)** — Runs live product demonstrations at customer sites using publicly available footage, eliminating the cost and logistics of shipping physical cameras.

**Developer (UC-4)** — Validates detection accuracy changes against a known, reproducible video fixture that can be restarted at any time via the API.

---

## 4. Functional Specification

### 4.1 Stream Creation

The system validates the submitted URL against the pattern `youtube.com/watch?v=`, `youtu.be/`, and `youtube.com/shorts/`. Validated URLs are passed to `yt-dlp` via `child_process.spawn()` argument arrays (never shell interpolation). The yt-dlp process writes the muxed video stream to stdout; FFmpeg reads from `pipe:0` (stdin) and publishes RTSP to MediaMTX at `rtsp://127.0.0.1:8554/yt/<channelId>`. A camera record of type `youtube` is created in the LTS database with `rtspUrl`, `youtubeUrl`, `resolution`, and `bitrate` fields.

Stream readiness is detected by monitoring FFmpeg stderr for `Output #0.*rtsp`. The system must confirm the RTSP path is live within 30 seconds; otherwise it returns HTTP 504.

### 4.2 Stream Playback and Looping

When the yt-dlp pipe closes (end of VOD content), FFmpeg exits and the service auto-restarts the pipeline up to `MAX_RESTARTS` times with a 5-second back-off. Each restart spawns a fresh yt-dlp invocation, refreshing stream URLs and resolving the URL-expiry limitation.

### 4.3 Stream Management

The service provides list, stop, update, and manual restart operations. Stopping a stream terminates the FFmpeg process, removes the MediaMTX RTSP path, and deletes the camera record. All active streams are stopped automatically on server SIGTERM / SIGINT. Updating `youtubeUrl`, `resolution`, or `bitrate` triggers an async stream restart; updating `name` applies immediately.

### 4.4 Stream Lifecycle States

| State | Description |
|---|---|
| `starting` | yt-dlp and FFmpeg spawned; waiting for RTSP path confirmation |
| `live` | RTSP path active in MediaMTX; stream flowing |
| `restarting` | Back-off delay in progress; will re-spawn after delay |
| `error` | Retry limit exceeded; manual restart required |
| `stopping` | Graceful teardown in progress |
| `removed` | Record deleted |

### 4.5 UI / UX

**Add Camera modal — YouTube tab:**
- Source type selection: IP Camera / YouTube radio buttons.
- Fields: Channel Name, YouTube URL, Resolution (dropdown), Bitrate (kbps input).
- During creation: loading spinner with elapsed time counter and progress bar (30s scale).
- On failure: toast notification with human-readable error message.

**Camera tile — YouTube badge:**
- `YT` badge (red background, white text) displayed in the top-right corner of the tile.

**Error state overlay:**
- Red error banner on the camera tile when `status === "error"`.
- **Restart** button triggers `POST /api/youtube-streams/:id/restart`.

**Edit Camera modal — YouTube camera:**
- Displays Channel Name, YouTube URL, Resolution, Bitrate, and a read-only Internal RTSP URL field.
- Warning: "Saving will restart the RTSP stream."

**Error notifications:**

| Scenario | UI Behaviour |
|---|---|
| `YT_DLP_FAILED` | Toast: "Unable to retrieve video. It may be private or deleted." |
| `INVALID_YOUTUBE_URL` | Inline field error below the URL input. |
| `STREAM_TIMEOUT` | Toast: "Stream start timed out. Please try again." |

---

## 5. Technical Requirements

### 5.1 Pipeline Components

| Component | Role |
|---|---|
| `yt-dlp` ≥ 2024.x | Extract YouTube stream; write muxed bytes to stdout (`-o -`) |
| `FFmpeg` ≥ 5.0 + `libx264` | Read from stdin (`pipe:0`); transcode to H.264; publish RTSP |
| `MediaMTX` (latest) | Local RTSP broker; receives FFmpeg publish; serves LTS pipeline |

### 5.2 yt-dlp Invocation (Pipe Mode — v1.1)

```bash
yt-dlp --no-playlist \
  --format "bestvideo[ext=mp4][height<=<MAX_HEIGHT>]+bestaudio[ext=m4a]/best[ext=mp4][height<=<MAX_HEIGHT>]/best[height<=<MAX_HEIGHT>]" \
  -o - --quiet --no-check-certificate "<YOUTUBE_URL>"
```

Adaptive video+audio tracks are muxed by yt-dlp before writing to stdout; FFmpeg always receives a single interleaved stream on `pipe:0`.

### 5.3 FFmpeg Invocation

```bash
ffmpeg -re -i pipe:0 \
  -c:v libx264 -profile:v main -level 4.1 \
  -preset ultrafast -tune zerolatency \
  -b:v <BITRATE>k -maxrate <BITRATE>k -bufsize <BITRATE*2>k \
  -vf "scale=-2:<HEIGHT>" -g 60 -keyint_min 30 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 44100 \
  -f rtsp -rtsp_transport tcp \
  "rtsp://127.0.0.1:8554/yt/<CHANNEL_ID>"
```

| Resolution | Scale Filter | Recommended Bitrate |
|---|---|---|
| `1080p` | `scale=-2:1080` | 2000–4000 kbps |
| `720p` | `scale=-2:720` | 1000–2000 kbps |
| `480p` | `scale=-2:480` | 500–1000 kbps |

### 5.4 MediaMTX Configuration

All listeners bound to `127.0.0.1`. No MediaMTX ports published to the host network interface. `overridePublisher: yes`, `maxReaders: 10`. `all_others` catch-all path used (wildcard paths not supported in MediaMTX v1.18.2).

### 5.5 Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Startup latency (API call to first RTSP frame) | ≤ 30 s |
| NFR-2 | End-to-end latency (YouTube → browser via WebRTC) | ≤ 5 s |
| NFR-3 | Concurrent YouTube virtual channels | ≥ 4 |
| NFR-4 | Incremental CPU per 1080p/2Mbps stream | ≤ 15% of one core |
| NFR-5 | FFmpeg process RSS at steady state | ≤ 150 MB |
| NFR-6 | Recovery time after FFmpeg crash | ≤ 10 s |
| NFR-7 | Failure of one YouTube stream | Zero impact on physical camera pipelines |

### 5.6 Security

| Risk | Mitigation |
|---|---|
| Command injection via YouTube URL | Validate against strict regex; use `spawn()` with argument arrays |
| MediaMTX exposed to LAN | Bind all listeners to `127.0.0.1`; do not publish ports in docker-compose |
| Unlimited process spawn | Enforce `YOUTUBE_MAX_STREAMS` (default: 4) before spawning |
| YouTube ToS violation | Display operator warning on first use; document in README |

### 5.7 URL Validation Regex

```javascript
const YOUTUBE_URL_REGEX =
  /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[A-Za-z0-9_\-]{11}([&?].*)?$/;
```

### 5.8 File & Module Layout

```
server/src/
├── api/
│   ├── youtubeStreams.js        REST endpoints for YouTube stream CRUD
│   └── internal.js             /internal/mediamtx webhook handler
├── services/
│   └── youtubeStreamService.js yt-dlp + FFmpeg lifecycle management
└── index.js                    Route registration; SIGTERM cleanup hook

client/src/
├── components/
│   ├── CameraEditModal.tsx      Extended with YouTube source tab
│   ├── CameraGrid.tsx           YT badge added
│   └── YouTubeStreamStatus.tsx  Loading / error UI during creation
├── stores/
│   └── cameraStore.ts           Handle type: "youtube" in camera list
└── types/
    └── index.ts                 youtubeUrl?: string; type?: string fields

root/
├── mediamtx.yml                 MediaMTX configuration
└── docker-compose.yml           mediamtx service added
```

---

## 6. API / Interface Contract

### 6.1 Base Path

```
/api/youtube-streams
```

### 6.2 Endpoints

#### POST / — Create Virtual Camera from YouTube URL

**Request:**
```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "name": "Test Stream — Crowd Scene",
  "resolution": "1080p",
  "bitrate": 2000
}
```

**Response 201:**
```json
{
  "success": true,
  "camera": {
    "id": "yt-a1b2c3d4",
    "name": "Test Stream — Crowd Scene",
    "type": "youtube",
    "youtubeUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "rtspUrl": "rtsp://127.0.0.1:8554/yt/a1b2c3d4",
    "status": "starting",
    "createdAt": "2026-05-21T10:00:00.000Z"
  }
}
```

#### GET / — List Active Streams

Returns array of stream objects with `id`, `name`, `youtubeUrl`, `rtspUrl`, `status`, `restartCount`, `uptimeSeconds`, `resolution`, `bitrate`.

#### DELETE /:id — Stop and Remove a Stream

Terminates FFmpeg process, removes RTSP path, deletes camera record. Returns `200 OK` with confirmation message.

#### PATCH /:id — Update YouTube URL / Settings

Fields `youtubeUrl`, `name`, `resolution`, `bitrate` (all optional). Changes to URL/resolution/bitrate trigger async restart. Returns updated camera record.

#### POST /:id/restart — Restart Error Stream

Resets retry counter and re-spawns pipeline. Returns camera record with `status: "starting"`.

Errors: `404 NOT_FOUND`, `409 STREAM_STOPPED`.

#### GET /:id/status — Polling Endpoint

```json
{
  "id": "yt-a1b2c3d4",
  "status": "live",
  "rtspUrl": "rtsp://127.0.0.1:8554/yt/a1b2c3d4",
  "elapsed": 8.4
}
```

### 6.3 Error Code Reference

| HTTP | Code | Condition |
|---|---|---|
| 422 | `INVALID_YOUTUBE_URL` | URL does not match YouTube format |
| 422 | `YT_DLP_FAILED` | yt-dlp extraction failed |
| 429 | `MAX_STREAMS_REACHED` | Stream limit reached |
| 504 | `STREAM_TIMEOUT` | RTSP path not live within 30 s |
| 404 | `NOT_FOUND` | Stream ID not found |
| 409 | `STREAM_STOPPED` | Stream already removed |

### 6.4 Internal MediaMTX Webhook

`POST /internal/mediamtx` — accepts requests from `127.0.0.1` only. Used to drive `starting → live` and `live → restarting` transitions based on `publish` and `unpublish` events.

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-1 | Valid YouTube URL: stream reaches `live` within 30 seconds of `POST /api/youtube-streams`. |
| AC-2 | Non-YouTube URL: API returns 422 with `INVALID_YOUTUBE_URL`. |
| AC-3 | Private/deleted video: API returns 422 with `YT_DLP_FAILED`. |
| AC-4 | FFmpeg crash: service auto-restarts within 10 seconds; stream returns to `live`. |
| AC-5 | 5 consecutive error restarts: stream transitions to `error`; `POST /:id/restart` resets counter and initiates restart. |
| AC-6 | `MAX_STREAMS_REACHED`: creating a 5th stream (default limit 4) returns 429. |
| AC-7 | PATCH with new `youtubeUrl`: triggers async restart; previous FFmpeg process terminated. |
| AC-8 | PATCH with only `name`: no stream restart occurs; `status` remains unchanged. |
| AC-9 | SIGTERM: all active yt-dlp and FFmpeg processes terminated within 5 seconds. |
| AC-10 | YouTube camera tile shows a red `YT` badge in top-right corner. |
| AC-11 | Error-state camera tile shows a red error banner with a functional Restart button. |
| AC-12 | YouTube virtual channel supports loitering detection, zone editing, and WebRTC delivery. |
| AC-13 | Edit Camera modal for a YouTube channel shows read-only RTSP URL and restart warning on save. |
| AC-14 | `/internal/mediamtx` endpoint rejects requests from IPs other than `127.0.0.1` with 403. |
| AC-15 | Load test: 4 concurrent 1080p streams run for 1 hour without entering `error` state. |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Backend core: `youtubeStreamService.js`, REST API, MediaMTX integration | Week 1–2 | 2026-05-19 | ✅ Done |
| M2 | UI integration: YouTube tab, YT badge, polling, error overlay | Week 2–3 | 2026-05-19 | ✅ Done |
| M3 | Hardening: `YOUTUBE_MAX_STREAMS`, SIGTERM handler, ToS banner, load test | Week 3–4 | - | ⏳ Pending |

### 8.2 TODO

- [ ] Add `YOUTUBE_MAX_STREAMS` environment variable and enforcement in POST handler
- [ ] Implement SIGTERM / SIGINT handler to stop all FFmpeg processes
- [ ] Add operator ToS compliance warning banner on first YouTube stream creation
- [ ] Update README with yt-dlp and MediaMTX installation and configuration instructions
- [ ] Perform load test: 4 concurrent 1080p YouTube streams for 1 hour
- [ ] Add `YOUTUBE_STREAM_ENABLED=false` env var to allow disabling the feature in air-gapped deployments
- [ ] Add i18n localisation strings for YouTube-specific UI messages
- [ ] Write end-to-end UI test: paste URL → camera tile appears with `YT` badge
- [ ] Confirm docker-compose MediaMTX `network_mode: host` requirement and document alternatives
- [ ] Review and finalise URL validation regex edge cases (playlist URLs, live stream URLs)

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for YouTube RTSP Ingest |
