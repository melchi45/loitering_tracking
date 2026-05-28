# DESIGN DOCUMENT
# YouTube → RTSP Ingest Service (LTS-2026-012 Refinements)

| | |
|---|---|
| **Document ID** | DESIGN-LTS-YT-02 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_LTS2026_YouTube_RTSP_Ingest.md |
| **Base Design** | design/Design_YouTube_RTSP_Ingest.md (DESIGN-LTS-YT-01) |

> **Note:** This document covers only the LTS-2026-012-specific additions and refinements.
> For the full architecture, API design, and sequence diagrams, refer to DESIGN-LTS-YT-01.

---

## Table of Contents
1. [Scope of LTS-2026-012 Refinements](#1-scope-of-lts-2026-012-refinements)
2. [repeatPlayback Feature Design](#2-repeatplayback-feature-design)
3. [Database Schema — LTS-2026-012](#3-database-schema--lts-2026-012)
4. [StreamEntry Fields — Complete Specification](#4-streamentry-fields--complete-specification)
5. [Error Code Catalogue — Extended](#5-error-code-catalogue--extended)
6. [SIGTERM / SIGINT Handler Design](#6-sigterm--sigint-handler-design)
7. [Process Invocation Details](#7-process-invocation-details)
8. [YOUTUBE_MAX_STREAMS Enforcement (TODO)](#8-youtube_max_streams-enforcement-todo)
9. [UI Changes — LTS-2026-012](#9-ui-changes--lts-2026-012)

---

## 1. Scope of LTS-2026-012 Refinements

LTS-2026-012 extends DESIGN-LTS-YT-01 with the following additions:

| Feature | SRS Reference | Status |
|---|---|---|
| `repeatPlayback` field | FR-YT2-001 ~ FR-YT2-005 | Phase-1 |
| Explicit DB schema | FR-YT2-010 ~ FR-YT2-012 | Phase-1 |
| Complete `StreamEntry` contract | FR-YT2-020 | Phase-1 |
| Extended error codes | FR-YT2-040 ~ FR-YT2-041 | Phase-1 |
| `SIGTERM`/`SIGINT` handler | FR-YT2-060 ~ FR-YT2-061 | Phase-1 |
| `YOUTUBE_MAX_STREAMS` env override | FR-YT2-030 | Phase-1 |
| `--no-check-certificate` gate | FR-YT2-031 | Phase-1 |
| UI Repeat Playback checkbox | FR-YT2-070 ~ FR-YT2-072 | Phase-1 |
| `YOUTUBE_MAX_STREAMS` enforcement | FR-YT2-030 | TODO milestone |

---

## 2. repeatPlayback Feature Design

### 2.1 Natural End Detection

```javascript
ffmpeg.on('close', (code, signal) => {
  const isNaturalEnd = (code === 0 && signal === null)
  // isNaturalEnd = true  → VOD played to completion normally
  // isNaturalEnd = false → crash, SIGKILL, user stop
  ...
})
```

### 2.2 Restart Logic with repeatPlayback

```
FFmpeg close event
      │
      ├─ status === 'stopping' or 'removed'? → return (no action)
      │
      ├─ isNaturalEnd === true AND repeatPlayback === true?
      │    └─ restartCount = 0        ← reset counter
      │       log "Repeat playback: restarting <id> after natural end"
      │       _scheduleRestart(entry)
      │
      └─ else (error exit OR repeatPlayback=false)
           └─ _scheduleRestart(entry)  ← normal counter increment
```

### 2.3 repeatPlayback PATCH (No Restart)

```javascript
// PATCH /api/youtube-streams/:id
if (Object.keys(patch).every(k => k === 'repeatPlayback' || k === 'name')) {
  // Apply immediately without restarting
  entry.repeatPlayback = patch.repeatPlayback
  await db.update('cameras', entry.id, { repeatPlayback: patch.repeatPlayback })
  return res.json({ success: true, camera: entry })
}
// Changes to youtubeUrl / resolution / bitrate → restart
```

---

## 3. Database Schema — LTS-2026-012

### 3.1 cameras Table Schema

```sql
-- YouTube virtual camera record in lts.json "cameras" array
{
  "id":             "yt-a1b2c3d4",      -- string, "yt-" prefix + 8-char UUID segment
  "name":           "My YouTube Stream", -- string
  "type":           "youtube",           -- literal "youtube"
  "youtubeUrl":     "https://...",       -- string
  "rtspUrl":        "rtsp://127.0.0.1:8554/yt/yt-a1b2c3d4",
  "resolution":     "720p",             -- "1080p" | "720p" | "480p"
  "bitrate":        1500000,            -- INTEGER bps (stored as bps in DB)
  "repeatPlayback": false,              -- boolean
  "status":         "offline",          -- initial status on DB insert
  "createdAt":      "2026-05-27T00:00:00Z"
}
```

> **Critical:** `bitrate` is stored as **bps** in the database.
> In-memory `StreamEntry` and all API responses use **kbps**.
> Conversion: `db.bitrate = api.bitrate * 1000`

### 3.2 Migration Strategy

On server startup, `YouTubeStreamService.init()` checks each restored YouTube camera record for the `repeatPlayback` field. If missing (legacy record), it is defaulted to `false` and written back to the DB.

```javascript
async init() {
  const cameras = await db.findAll('cameras', { type: 'youtube' })
  for (const cam of cameras) {
    if (cam.repeatPlayback === undefined) {
      cam.repeatPlayback = false
      await db.update('cameras', cam.id, { repeatPlayback: false })
    }
    // ... restore entry
  }
}
```

---

## 4. StreamEntry Fields — Complete Specification

```typescript
interface StreamEntry {
  // Identity
  id: string                       // "yt-a1b2c3d4"
  name: string
  youtubeUrl: string
  rtspUrl: string                  // internal MediaMTX URL

  // Config
  resolution: '1080p' | '720p' | '480p'
  bitrate: number                  // kbps (in-memory)
  repeatPlayback: boolean

  // State
  status: 'starting' | 'live' | 'restarting' | 'error' | 'stopping' | 'removed'
  restartCount: number             // resets to 0 on POST /:id/restart

  // Processes
  ytdlpProcess?: ChildProcess      // null when not running
  ffmpegProcess?: ChildProcess     // null when not running

  // Timers
  startTimer?: NodeJS.Timeout      // START_TIMEOUT (30s) watchdog
  restartTimer?: NodeJS.Timeout    // RESTART_DELAY (5s) delay handle

  // Promise handles (for createStream await)
  liveResolve?: (cam: CameraRecord) => void
  liveReject?: (err: Error) => void

  // Timestamps
  startedAt?: Date
}
```

---

## 5. Error Code Catalogue — Extended

| Code | HTTP Status | Trigger Condition |
|---|---|---|
| `INVALID_YOUTUBE_URL` | 422 | URL does not match `YOUTUBE_URL_REGEX` |
| `MAX_STREAMS_REACHED` | 429 | Active streams ≥ `YOUTUBE_MAX_STREAMS` |
| `FFMPEG_NOT_FOUND` | 503 | `ffmpeg` binary not found (ENOENT) |
| `STREAM_TIMEOUT` | 504 | Not live within `START_TIMEOUT` (30s) |
| `STREAM_NOT_FOUND` | 404 | No stream with given id |
| `STREAM_ALREADY_RUNNING` | 409 | Restart called on non-error stream |
| `INTERNAL_ERROR` | 500 | Unexpected exception |

### Error Response Format

```json
{
  "success": false,
  "code": "STREAM_TIMEOUT",
  "error": "Stream did not start within 30 seconds"
}
```

---

## 6. SIGTERM / SIGINT Handler Design

```javascript
// server/src/index.js (or app.js)
async function gracefulShutdown(signal) {
  console.log(`Received ${signal}, shutting down…`)
  await youtubeStreamService.stopAll()
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT',  () => gracefulShutdown('SIGINT'))
```

### stopAll() Implementation

```javascript
async stopAll() {
  const active = [...this.streams.values()]
    .filter(e => e.status !== 'removed')
  await Promise.all(active.map(e => this._stopEntry(e)))
  this.streams.clear()
}
```

### _stopEntry() — Graceful Kill Sequence

```
1. pipelineManager.stopCamera(entry.id)
2. entry.ytdlpProcess?.kill('SIGTERM')
3. await sleep(3000)  OR  SIGKILL if still alive
4. entry.ffmpegProcess?.kill('SIGTERM')
5. await sleep(5000)  OR  SIGKILL if still alive
6. entry.status = 'removed'
```

---

## 7. Process Invocation Details

### 7.1 yt-dlp Format String (H.264 Priority)

```
bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/
bestvideo[vcodec^=avc1]+bestaudio/
bestvideo+bestaudio/
best[vcodec^=avc1]/
best
```

Purpose: avoids AV1/VP9 formats that would force FFmpeg transcode.

### 7.2 SSL Certificate Check Gate

```javascript
const YTDLP_NO_CHECK_CERT = process.env.YTDLP_NO_CHECK_CERT !== 'false'
// Default: true (skip cert check) — for lab/dev environments
// Set YTDLP_NO_CHECK_CERT=false to enable cert verification

const args = [
  ...(YTDLP_NO_CHECK_CERT ? ['--no-check-certificate'] : []),
  // other args...
]
```

### 7.3 FFmpeg Live Detection Pattern

```javascript
const RTSP_LIVE_RE = /Output #0[^\n]*rtsp|frame=\s*[1-9]|size=\s*\d+kB/i
```

Matching any of:
- `Output #0` line with RTSP path (RTSP session established)
- `frame= N` where N ≥ 1 (first frame encoded)
- `size= NkB` (data flowing)

---

## 8. YOUTUBE_MAX_STREAMS Enforcement (TODO)

Current state (Phase-1): `YOUTUBE_MAX_STREAMS` is checked in `createStream()` but enforcement is a TODO milestone for runtime dynamic updates.

```javascript
// Phase-1: checked at creation time only
const MAX_STREAMS = parseInt(process.env.YOUTUBE_MAX_STREAMS || '4')
const active = [...this.streams.values()].filter(e => e.status !== 'removed')
if (active.length >= MAX_STREAMS) {
  throw { code: 'MAX_STREAMS_REACHED' }
}
```

**TODO (Phase-2):** Dynamic reduction — when `YOUTUBE_MAX_STREAMS` is lowered at runtime, stop excess streams and notify UI.

---

## 9. UI Changes — LTS-2026-012

### 9.1 Add Camera Modal — Repeat Playback Checkbox

```tsx
// AddCameraModal.tsx — YouTube tab
<label className="flex items-center gap-2 text-sm text-gray-300">
  <input
    type="checkbox"
    checked={repeatPlayback}
    onChange={e => setRepeatPlayback(e.target.checked)}
    className="rounded"
  />
  Repeat Playback
  <span className="text-xs text-gray-500">(loop VOD streams)</span>
</label>
```

Default: unchecked.

### 9.2 Edit Camera Modal — Restart Warning

When editing `youtubeUrl`, `resolution`, or `bitrate`, show:

```
⚠ Changing URL, resolution, or bitrate will restart the stream.
```

Read-only internal RTSP URL field:

```tsx
<input
  type="text"
  value={camera.rtspUrl}
  readOnly
  className="bg-gray-800 text-gray-400 cursor-default"
/>
```

### 9.3 CameraView — YT Badge and Error States

```tsx
// YT badge
{camera.type === 'youtube' && (
  <span className="absolute top-1 right-1 bg-red-600 text-white text-[10px] px-1 rounded">
    YT
  </span>
)}

// Error overlay
{camera.status === 'error' && (
  <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2">
    <span className="text-red-400 text-sm">Stream Error</span>
    <button
      onClick={() => restartYouTubeStream(camera.id)}
      className="px-3 py-1 bg-yellow-600 text-white text-xs rounded hover:bg-yellow-500"
    >
      Restart
    </button>
  </div>
)}
```

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for LTS2026 YouTube RTSP Ingest |
