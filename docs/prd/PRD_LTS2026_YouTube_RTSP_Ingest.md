# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# YouTube → RTSP Ingest Service (LTS-2026-012)

| | |
|---|---|
| **Document ID** | PRD-LTS-012 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_LTS2026_YouTube_RTSP_Ingest.md (LTS-2026-012) |

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

The YouTube RTSP Ingest Service enables LTS-2026 operators to register any YouTube video (VOD or Live) as a virtual camera channel by running it through a `yt-dlp → FFmpeg → MediaMTX` pipeline, exposing the content as an internal RTSP URL (`rtsp://…/yt/<id>`) that is fully interoperable with the existing detection, tracking, and analytics pipeline.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Accept a YouTube URL from the operator and create a virtual camera channel backed by an RTSP stream served from a local MediaMTX server.
- Manage the full lifecycle of the yt-dlp and FFmpeg child processes, including health monitoring, state transitions, and automatic restart on failure.
- Support configurable resolution (1080p / 720p / 480p) and bitrate (100–20000 kbps) per virtual channel.
- Support infinite loop playback (`repeatPlayback`) for VOD content, resetting the restart counter on natural video end so the channel remains live indefinitely.
- Expose a complete REST API for creating, reading, updating, deleting, and manually restarting virtual camera channels.
- Persist virtual channel records (including `repeatPlayback` flag) in the existing LTS `cameras` database table.

### 2.2 Non-Goals

- DVR / timeline seek functionality for virtual channels is out of scope for LTS-2026.
- GPU-accelerated transcoding (e.g., `h264_nvenc`) is out of scope for the MVP; CPU-only `libx264 ultrafast` is the baseline.
- Authentication or cookie injection for age-restricted or private YouTube videos is not supported; the API returns `YT_DLP_FAILED` for such content.

---

## 3. User Personas

**System Integrator** — Needs to test AI models (crowd loitering, fire/smoke) against real-world reference footage without physical cameras. Creates YouTube virtual channels from the Add Camera modal and monitors them through the standard camera grid.

**QA Engineer** — Reproduces edge-case scenarios (stadium crowds, night footage, rain occlusion) by pasting a YouTube link. Relies on the `repeatPlayback` option to keep a test fixture running for the duration of a multi-hour test session without manual intervention.

**Sales / Demo Engineer** — Runs product demos using publicly available surveillance-style footage. Requires the virtual channel to start within 30 seconds and remain stable for the full demo duration.

---

## 4. Functional Specification

### 4.1 Stream Creation

The service accepts YouTube URLs in the formats `https://www.youtube.com/watch?v=<ID>`, `https://youtu.be/<ID>`, and `https://youtube.com/shorts/<ID>`. Non-YouTube URLs are rejected with HTTP 422 (`INVALID_YOUTUBE_URL`).

Upon receiving a valid URL, the service spawns a `yt-dlp` child process in pipe mode (`-o -`, stdout → pipe) and connects its stdout to the stdin of an `FFmpeg` child process. FFmpeg transcodes the stream to H.264 and publishes it to MediaMTX at `rtsp://127.0.0.1:8554/yt/<stream-id>`. A camera record of type `youtube` is created in the LTS database. Stream creation must complete (RTSP path live) within 30 seconds; timeout results in HTTP 504 (`STREAM_TIMEOUT`).

### 4.2 StreamEntry Data Structure

| Field | Type | Description |
|---|---|---|
| `id` | string | UUID-based stream ID (`yt-<uuid>`) |
| `name` | string | Channel display name |
| `youtubeUrl` | string | Original YouTube page URL |
| `rtspUrl` | string | Internal RTSP URL (`rtsp://…/yt/<id>`) |
| `resolution` | string | Target resolution: `1080p`, `720p`, or `480p` |
| `bitrate` | number | Bitrate in bps (stored unit) |
| `repeatPlayback` | boolean | Loop infinitely when video ends normally |
| `status` | string | Current lifecycle state (see §4.4) |
| `restartCount` | number | Current restart attempt count |
| `createdAt` | string | ISO 8601 timestamp |

### 4.3 Key Service Constants

| Constant | Default | Description |
|---|---|---|
| `MAX_RESTARTS` | 5 | Maximum auto-restart attempts when `repeatPlayback` is disabled |
| `RESTART_DELAY` | 5000 ms | Wait time between restart attempts |
| `START_TIMEOUT` | 30000 ms | Maximum time to wait for RTSP path to become live |

### 4.4 State Machine

The stream progresses through the following states:

| State | Description |
|---|---|
| `starting` | yt-dlp and FFmpeg processes starting; waiting for MediaMTX publish confirmation |
| `live` | MediaMTX publish confirmed; stream active |
| `restarting` | Process exited; RESTART_DELAY in progress before re-spawn |
| `error` | MAX_RESTARTS exceeded; manual restart required |
| `stopping` | `stopStream()` called; process terminating |
| `removed` | Record deletion complete |

State transition logic:
- `starting` → `live`: MediaMTX publish event received (or FFmpeg stderr reports `Output #0 … rtsp`).
- `starting` → `error`: START_TIMEOUT exceeded.
- `live` → `restarting`: FFmpeg process exits (any cause) or MediaMTX unpublish event.
- `restarting` → `starting`: After RESTART_DELAY, if restart limit not reached.
- `restarting` → `error`: `restartCount >= MAX_RESTARTS` and `repeatPlayback` is false.

### 4.5 Repeat Playback Logic

When FFmpeg exits with `code === 0` and `signal === null` (natural end of video), the event is classified as `isNaturalEnd = true`. If `repeatPlayback` is enabled, `restartCount` is reset to 0 before the restart, bypassing the `MAX_RESTARTS` limit. Error exits (`code !== 0`) always consume the restart counter regardless of `repeatPlayback`.

### 4.6 Stream Update Behaviour

When `PATCH /:id` is called:
- Changes to `youtubeUrl`, `resolution`, or `bitrate` trigger an asynchronous stream restart.
- Changes to `name` or `repeatPlayback` are applied immediately without restarting the stream.

### 4.7 UI Integration

- The Add Camera modal includes a YouTube tab/radio option with fields for Channel Name, YouTube URL, Resolution, and Bitrate, plus a **Repeat Playback** checkbox.
- During stream creation, the modal shows a loading indicator with elapsed time and a progress bar (out of 30s).
- Camera tiles for YouTube virtual channels display a `YT` badge (red, top-right corner).
- Streams in the `error` state display a red error banner on the tile with a **Restart** button.
- YouTube virtual channels support all existing features: zone editing, AI analytics, alert rules, fullscreen view, and WebRTC delivery.

---

## 5. Technical Requirements

### 5.1 Runtime Dependencies

| Dependency | Version | Role |
|---|---|---|
| `yt-dlp` | ≥ 2024.x | Extract YouTube stream and write to stdout pipe |
| `FFmpeg` | ≥ 5.0 with `libx264` | Transcode and publish to MediaMTX via RTSP/TCP |
| `MediaMTX` | latest (`bluenviron/mediamtx`) | Local RTSP broker on `localhost:8554` |

### 5.2 Process Invocation

`yt-dlp` and `FFmpeg` must be spawned via `child_process.spawn()` with argument arrays. Shell interpolation (`exec()`) is prohibited. The YouTube URL must be validated against a strict regex before being passed to any child process.

### 5.3 yt-dlp Invocation (Pipe Mode)

```bash
yt-dlp --no-playlist \
  --format "bestvideo[ext=mp4][height<=<MAX_HEIGHT>]+bestaudio[ext=m4a]/best[ext=mp4][height<=<MAX_HEIGHT>]/best[height<=<MAX_HEIGHT>]" \
  -o - --quiet --no-check-certificate "<YOUTUBE_URL>"
```

`--no-check-certificate` is required for networks with self-signed proxy certificates. Controlled by `YTDLP_NO_CHECK_CERT` env var (default: `true`).

### 5.4 FFmpeg Invocation

```bash
ffmpeg -re -i pipe:0 \
  -c:v libx264 -profile:v main -level 4.1 \
  -preset ultrafast -tune zerolatency \
  -b:v <BITRATE>k -maxrate <BITRATE>k -bufsize <BITRATE*2>k \
  -vf scale=-2:<HEIGHT> -g 60 -keyint_min 30 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 44100 \
  -f rtsp -rtsp_transport tcp \
  rtsp://127.0.0.1:8554/yt/<CHANNEL_ID>
```

| Resolution | `-vf scale` | Recommended Bitrate |
|---|---|---|
| `1080p` | `scale=-2:1080` | 2000–4000 kbps |
| `720p` | `scale=-2:720` | 1000–2000 kbps |
| `480p` | `scale=-2:480` | 500–1000 kbps |

### 5.5 MediaMTX Configuration

All MediaMTX listeners bind to `127.0.0.1` only (RTSP on port 8554, API on port 9997). YouTube streams must not be exposed to the LAN. The `mediamtx.yml` uses an `all_others` catch-all path with `overridePublisher: yes` and `maxReaders: 10`.

### 5.6 Performance

| Metric | Target |
|---|---|
| Stream startup latency | ≤ 30 s |
| End-to-end latency (YouTube → browser via WebRTC) | ≤ 5 s |
| Concurrent YouTube virtual channels | ≥ 4 |
| Incremental CPU per 1080p/2Mbps stream | ≤ 15% of one core |
| FFmpeg process RSS at steady state | ≤ 150 MB |
| Auto-restart recovery time after crash | ≤ 10 s |

### 5.7 Security

- YouTube URL validated against regex before use in child process arguments.
- `YOUTUBE_MAX_STREAMS` environment variable (default: 4) enforced before spawning.
- `/internal/mediamtx` webhook endpoint accepts requests from `127.0.0.1` only.
- SIGTERM / SIGINT handlers stop all active FFmpeg processes on server shutdown.

---

## 6. API / Interface Contract

**Base Path**: `/api/youtube-streams`

### 6.1 Endpoint Summary

| Method | Path | Description |
|---|---|---|
| `POST` | `/` | Create a new virtual YouTube channel |
| `GET` | `/` | List all active streams |
| `GET` | `/:id/status` | Poll stream readiness (starting → live) |
| `PATCH` | `/:id` | Update stream properties |
| `DELETE` | `/:id` | Stop stream and remove record |
| `POST` | `/:id/restart` | Manually restart an error-state stream |

### 6.2 POST / — Create Stream

**Request Body:**

```json
{
  "youtubeUrl":     "https://www.youtube.com/watch?v=...",
  "name":           "Crowd test video",
  "resolution":     "1080p",
  "bitrate":        2000,
  "repeatPlayback": false
}
```

**Response 201 Created:**

```json
{
  "success": true,
  "camera": {
    "id": "yt-xxxx",
    "name": "Crowd test video",
    "type": "youtube",
    "youtubeUrl": "https://...",
    "rtspUrl": "rtsp://127.0.0.1:8554/yt/yt-xxxx",
    "resolution": "1080p",
    "bitrate": 2000000,
    "repeatPlayback": false,
    "status": "starting",
    "restartCount": 0,
    "createdAt": "2026-05-21T..."
  }
}
```

### 6.3 Error Codes

| HTTP | Code | Condition |
|---|---|---|
| 422 | `INVALID_YOUTUBE_URL` | URL does not match a recognised YouTube format |
| 422 | `YT_DLP_FAILED` | yt-dlp failed to extract stream (private, deleted, age-restricted) |
| 429 | `MAX_STREAMS_REACHED` | `YOUTUBE_MAX_STREAMS` limit reached |
| 503 | `FFMPEG_NOT_FOUND` | FFmpeg binary not available in PATH |
| 504 | `STREAM_TIMEOUT` | RTSP path not live within 30 seconds |
| 404 | `NOT_FOUND` | Stream ID does not exist |

### 6.4 PATCH /:id — Update Stream

All fields optional. Changes to `youtubeUrl`, `resolution`, or `bitrate` trigger async stream restart. Changes to `name` and `repeatPlayback` apply immediately.

### 6.5 GET /:id/status — Poll Readiness

```json
{
  "id": "yt-xxxx",
  "status": "live",
  "rtspUrl": "rtsp://127.0.0.1:8554/yt/yt-xxxx",
  "elapsed": 8.4
}
```

### 6.6 Internal MediaMTX Webhook

`POST /internal/mediamtx` receives publish/unpublish events from MediaMTX and drives state transitions (`starting` → `live`, `live` → `restarting`).

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a valid YouTube URL, `POST /api/youtube-streams` returns 201 and the stream reaches `status: "live"` within 30 seconds. |
| AC-2 | Given a non-YouTube URL, `POST /api/youtube-streams` returns 422 with code `INVALID_YOUTUBE_URL`. |
| AC-3 | Given a private or deleted YouTube URL, the API returns 422 with code `YT_DLP_FAILED`. |
| AC-4 | When the FFmpeg process crashes, the service automatically restarts within 10 seconds; the stream returns to `live` state. |
| AC-5 | After 5 consecutive error restarts (with `repeatPlayback: false`), the stream transitions to `error` state and a manual restart via `POST /:id/restart` resets the counter and returns `status: "starting"`. |
| AC-6 | When `repeatPlayback: true` and a VOD video ends normally (FFmpeg exits code 0), the stream restarts with `restartCount` reset to 0 and returns to `live` without manual intervention. |
| AC-7 | `PATCH /:id` with a new `youtubeUrl` triggers a stream restart; the previous FFmpeg process is terminated. |
| AC-8 | `PATCH /:id` changing only `repeatPlayback` does not restart the stream; `status` remains `live`. |
| AC-9 | When the LTS server receives SIGTERM, all active FFmpeg and yt-dlp processes are terminated within 5 seconds. |
| AC-10 | Creating more than `YOUTUBE_MAX_STREAMS` virtual channels returns HTTP 429 with code `MAX_STREAMS_REACHED`. |
| AC-11 | The camera tile for a YouTube virtual channel displays a red `YT` badge in the top-right corner. |
| AC-12 | The Add Camera modal renders a Repeat Playback checkbox with default value `false`; the value is included in the `POST` request body. |
| AC-13 | A YouTube virtual channel supports zone editing, loitering detection, and WebRTC video delivery identically to a physical camera. |
| AC-14 | Four concurrent 1080p YouTube streams operate for 1 hour without any stream entering the `error` state due to resource exhaustion. |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Backend core: `YouTubeStreamService`, REST API, DB schema | TBD | 2026-05-19 | ✅ Done |
| M2 | UI integration: Add/Edit modal YouTube tab, YT badge, error overlay | TBD | 2026-05-19 | ✅ Done |
| M3 | Hardening: `YOUTUBE_MAX_STREAMS`, SIGTERM handler, ToS warning, load test | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Add `YOUTUBE_MAX_STREAMS` environment variable and enforce in POST handler
- [ ] Implement SIGTERM / SIGINT handler to stop all active FFmpeg processes on server shutdown
- [ ] Add operator warning banner for YouTube Terms of Service compliance
- [ ] Update README with setup instructions for yt-dlp and MediaMTX
- [ ] Run load test: 4 concurrent 1080p YouTube streams for 1 hour; record CPU and memory usage
- [ ] Verify `repeatPlayback` DB column migration is applied in all deployment environments
- [ ] Add integration test covering the full create → live → delete cycle
- [ ] Confirm `--no-check-certificate` behaviour is correctly gated by `YTDLP_NO_CHECK_CERT` env var

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for LTS2026 YouTube RTSP Ingest |
