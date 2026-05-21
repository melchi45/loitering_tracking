# RFP: YouTube → RTSP Ingest Service

**Document No.**: LTS-2026-012  
**Version**: 1.0  
**Date**: 2026-05-19  
**Classification**: Technical Requirements Specification (RFP)  
**Status**: Written based on Phase-1 implementation  
**Related RFPs**: LTS-2026-011 (Dashboard Sidebar – Cameras), LTS-2026-001 (Loitering Tracking System)

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [YouTubeStreamService](#3-youtubestreamservice)
4. [REST API](#4-rest-api)
5. [State Machine](#5-state-machine)
6. [Repeat Playback](#6-repeat-playback)
7. [Error Handling and Auto-restart](#7-error-handling-and-auto-restart)
8. [Implementation Status](#8-implementation-status)

---

## 1. Overview

### 1.1 Purpose

The LTS-2026 system provides functionality to ingest and re-stream **YouTube videos (VOD/Live)** as virtual camera channels in addition to physical IP cameras.  
The `yt-dlp` → `FFmpeg` → `MediaMTX RTSP` pipeline exposes YouTube videos as internal RTSP URLs and connects them to the existing LTS analysis pipeline.

### 1.2 Term Definitions

| Term | Description |
|------|------|
| Virtual channel | Internal RTSP stream derived from YouTube URL (`rtsp://…/yt/<id>`) |
| yt-dlp | CLI tool for extracting YouTube stream URLs + stdout streaming |
| FFmpeg | Media processor that re-encodes/forwards yt-dlp stdout to RTSP MediaMTX |
| MediaMTX | Internal RTSP media server |

---

## 2. System Architecture

```
YouTube URL
    │
    ▼
 yt-dlp (stdout pipe)
    │  raw stream (best quality)
    ▼
 FFmpeg
    │  - Video transcoding (resolution & bitrate applied)
    │  - RTSP publish → MediaMTX
    ▼
MediaMTX  rtsp://127.0.0.1:8554/yt/<stream-id>
    │
    ▼
LTS Analysis Pipeline (Detection, Tracking, Analytics)
```

---

## 3. YouTubeStreamService

### 3.1 StreamEntry Data Structure

| Field | Type | Description |
|------|------|------|
| `id` | string | UUID-based stream ID (`yt-<uuid>`) |
| `name` | string | Channel display name |
| `youtubeUrl` | string | Original YouTube page URL |
| `rtspUrl` | string | Internal RTSP URL (`rtsp://…/yt/<id>`) |
| `resolution` | string | Target resolution (`1080p` / `720p` / `480p`) |
| `bitrate` | number | Bitrate (bps, DB storage unit) |
| `repeatPlayback` | boolean | Whether to loop infinitely when video ends |
| `status` | string | Current state (see §5 State Machine) |
| `restartCount` | number | Current restart count |
| `createdAt` | string | ISO timestamp |

### 3.2 Key Constants

| Constant | Default | Description |
|------|--------|------|
| `MAX_RESTARTS` | `5` | Maximum auto-restart attempts (when repeatPlayback is disabled) |
| `RESTART_DELAY` | `5000ms` | Restart wait time |
| `START_TIMEOUT` | `30000ms` | Stream start timeout |

---

## 4. REST API

**Base Path**: `/api/youtube-streams`

### 4.1 Endpoint List

| Method | Path | Description |
|--------|------|------|
| `POST` | `/` | Create new virtual channel |
| `GET` | `/` | Get all stream list |
| `GET` | `/:id/status` | Poll specific stream status |
| `PATCH` | `/:id` | Update stream properties |
| `DELETE` | `/:id` | Stop stream and delete record |
| `POST` | `/:id/restart` | Manual restart of error-state stream |

### 4.2 POST / — Create Stream

**Request Body**:

```json
{
  "youtubeUrl":     "https://www.youtube.com/watch?v=...",
  "name":           "Crowd test video",
  "resolution":     "1080p",
  "bitrate":        2000,
  "repeatPlayback": false
}
```

| Field | Type | Required | Default | Description |
|------|------|------|--------|------|
| `youtubeUrl` | string | ✅ | — | YouTube page URL |
| `name` | string | ✅ | — | Channel display name |
| `resolution` | string | ❌ | `1080p` | `1080p` / `720p` / `480p` |
| `bitrate` | number | ❌ | `2000` | kbps (100–20000) |
| `repeatPlayback` | boolean | ❌ | `false` | Loop infinitely when video ends |

**Response**: `201 Created`
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
    "createdAt": "2026-05-19T..."
  }
}
```

### 4.3 PATCH /:id — Update Stream

**Request Body** (all fields optional):

```json
{
  "name":           "New channel name",
  "youtubeUrl":     "https://...",
  "resolution":     "720p",
  "bitrate":        3000,
  "repeatPlayback": true
}
```

> Stream auto-restarts when `youtubeUrl`, `resolution`, or `bitrate` changes.  
> `name` and `repeatPlayback` changes apply immediately without restart.

### 4.4 Error Codes

| HTTP | Code | Description |
|------|------|------|
| 422 | `INVALID_YOUTUBE_URL` | Invalid YouTube URL |
| 422 | `YT_DLP_FAILED` | yt-dlp execution failed (private/deleted video, etc.) |
| 503 | `FFMPEG_NOT_FOUND` | FFmpeg binary not found |
| 429 | `MAX_STREAMS_REACHED` | Maximum stream count exceeded |
| 504 | `STREAM_TIMEOUT` | Stream start timeout |
| 404 | `NOT_FOUND` | Stream ID not found |

---

## 5. State Machine

```
          createStream()
               │
               ▼
         ┌─────────────┐
         │  starting   │──── START_TIMEOUT exceeded ──► error
         └─────────────┘
               │
    MediaMTX publish event
               │
               ▼
         ┌─────────────┐
         │    live     │◄─── _setLive()
         └─────────────┘
               │
    FFmpeg close (code 0 = normal end)
    FFmpeg close (code ≠ 0 = error)
    MediaMTX unpublish
               │
               ▼
         ┌─────────────┐
         │ restarting  │──── MAX_RESTARTS exceeded (repeatPlayback=false) ──► error
         └─────────────┘
               │
         RESTART_DELAY
               │
               ▼
         (returns to starting)
```

> **When repeatPlayback=true**: On `live → restarting` transition, `restartCount` is reset to `0`, bypassing the MAX_RESTARTS limit for infinite loop.

---

## 6. Repeat Playback

### 6.1 Feature Definition

When YouTube VOD video playback ends, the pipeline (yt-dlp → FFmpeg) naturally terminates.  
Enabling the `repeatPlayback` option automatically restarts the stream when the video ends, implementing **infinite loop playback**.

### 6.2 Playback End Detection

When the FFmpeg process exits with `exit code 0`, `signal null`, it is judged as a **normal end (natural termination)**.

```javascript
ffProc.on('close', (code, signal) => {
  const isNaturalEnd = code === 0 && signal === null;
  this._scheduleRestart(entry, isNaturalEnd);
});
```

### 6.3 Repeat Playback Flow

```
Normal video end (code=0)
      │
      ▼
_scheduleRestart(entry, isNaturalEnd=true)
      │
      ├── repeatPlayback === true?
      │       └── YES → entry.restartCount = 0  (counter reset)
      │                → bypass MAX_RESTARTS check
      │                → restart after RESTART_DELAY
      │
      └── repeatPlayback === false?
              └── normal restart logic (increment restartCount, check MAX_RESTARTS)
```

### 6.4 Distinction from Error Restart

| Situation | `isNaturalEnd` | `repeatPlayback` Effect |
|------|----------------|----------------------|
| Normal video end (code=0) | `true` | Counter reset → infinite loop |
| FFmpeg error exit (code≠0) | `false` | Normal restart (MAX_RESTARTS applies) |
| MediaMTX unpublish | `false` | Normal restart (MAX_RESTARTS applies) |

> Restarts due to error maintain the `MAX_RESTARTS` limit even when `repeatPlayback=true`.  
> Infinite loop only applies when the video ends normally.

### 6.5 UI Specification

#### 6.5.1 Add Modal (YouTube tab)

- Checkbox displayed at the bottom of the form
- Label: `Repeat Playback — Auto-restart when video ends`
- Default: `false` (unchecked)
- `repeatPlayback` included in `POST /api/youtube-streams` body

#### 6.5.2 Edit Modal (YouTube channel)

- Checkbox displayed after Resolution/Bitrate section, before internal RTSP URL
- Label: `Repeat Playback — Auto-restart when video ends`
- Initial value: `camera.repeatPlayback` returned from server
- `repeatPlayback` included in `PATCH /api/youtube-streams/{id}` body
- `repeatPlayback` change applies immediately without stream restart

---

## 7. Error Handling and Auto-restart

### 7.1 Normal Restart Logic

| Trigger | Description |
|--------|------|
| FFmpeg process exit (code≠0) | Stream error — attempt restart |
| FFmpeg normal exit (code=0) | Video end — branch on `repeatPlayback` |
| MediaMTX unpublish event | RTSP path disappeared — attempt restart |

### 7.2 State Transition Conditions

| State | Description |
|------|------|
| `starting` | Waiting for yt-dlp + FFmpeg process start |
| `live` | MediaMTX publish confirmed, stream active |
| `restarting` | Waiting for RESTART_DELAY |
| `error` | MAX_RESTARTS exceeded (manual restart required) |
| `stopping` | stopStream() called, process terminating |
| `removed` | Record deletion complete |

---

## 8. Implementation Status

| Item | Status | Notes |
|------|------|------|
| `YouTubeStreamService` core logic | ✅ Done | `server/src/services/youtubeStreamService.js` |
| REST API endpoints | ✅ Done | `server/src/api/youtubeStreams.js` |
| Repeat Playback (`repeatPlayback`) | ✅ Done | `_scheduleRestart(entry, isNaturalEnd)` |
| DB storage (`cameras` table) | ✅ Done | `repeatPlayback` column |
| Client add Modal checkbox | ✅ Done | `client/src/components/CameraList.tsx` |
| Client edit Modal checkbox | ✅ Done | `client/src/components/CameraEditModal.tsx` |
| `Camera` type extension | ✅ Done | `client/src/types/index.ts` |
