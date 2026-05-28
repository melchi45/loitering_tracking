# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# YouTube → RTSP Ingest Service (LTS-2026-012)

| | |
|---|---|
| **Document ID** | SRS-LTS-YT-02 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_LTS2026_YouTube_RTSP_Ingest.md |
| **Parent RFP** | rfp/RFP_LTS2026_YouTube_RTSP_Ingest.md |
| **Supersedes** | SRS-LTS-YT-01 (general YouTube RTSP Ingest) |

> **Note:** This document specifies the LTS-2026-specific refinements to the YouTube RTSP Ingest service. For general architecture, API design, and test cases, refer to the linked documents:
> - SRS: srs/SRS_YouTube_RTSP_Ingest.md (SRS-LTS-YT-01)
> - Design: design/Design_YouTube_RTSP_Ingest.md (DESIGN-LTS-YT-01)
> - TC: tc/TC_YouTube_RTSP_Ingest.md (TC-LTS-YT-01)
>
> This SRS adds or refines requirements specific to the LTS-2026-012 delivery:
> `repeatPlayback`, database schema, extended error codes, SIGTERM handling, and the `YOUTUBE_MAX_STREAMS` enforcement.

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [LTS-2026-012 Specific Requirements — Repeat Playback](#3-lts-2026-012-specific-requirements--repeat-playback)
4. [LTS-2026-012 Specific Requirements — Database Schema](#4-lts-2026-012-specific-requirements--database-schema)
5. [LTS-2026-012 Specific Requirements — Stream Entry Data Model](#5-lts-2026-012-specific-requirements--stream-entry-data-model)
6. [LTS-2026-012 Specific Requirements — Service Constants](#6-lts-2026-012-specific-requirements--service-constants)
7. [LTS-2026-012 Specific Requirements — Error Codes](#7-lts-2026-012-specific-requirements--error-codes)
8. [LTS-2026-012 Specific Requirements — Process Invocation](#8-lts-2026-012-specific-requirements--process-invocation)
9. [LTS-2026-012 Specific Requirements — Server Shutdown](#9-lts-2026-012-specific-requirements--server-shutdown)
10. [LTS-2026-012 Specific Requirements — UI](#10-lts-2026-012-specific-requirements--ui)
11. [Non-Functional Requirements](#11-non-functional-requirements)
12. [Acceptance Criteria Mapping](#12-acceptance-criteria-mapping)
13. [Constraints & Assumptions](#13-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS captures the LTS-2026-012-specific requirements for the YouTube RTSP Ingest service. It inherits all requirements from SRS-LTS-YT-01 and adds or overrides them where the LTS-2026 delivery diverges.

### 1.2 Scope

LTS-2026-012 specific additions over SRS-LTS-YT-01:
- `repeatPlayback` field in StreamEntry and database schema
- Natural-end detection logic (`code === 0 && signal === null`)
- Explicit enumeration of all `StreamEntry` fields with types
- `STREAM_TIMEOUT` HTTP status 504 (confirmed in error code table)
- `FFMPEG_NOT_FOUND` HTTP status 503 (new error code in LTS-2026-012)
- `SIGTERM`/`SIGINT` handler requirement (explicitly mandated)
- `YOUTUBE_MAX_STREAMS` enforcement is a TODO milestone (pending)
- `--no-check-certificate` gated by `YTDLP_NO_CHECK_CERT` env var

### 1.3 Relationship to SRS-LTS-YT-01

All FR-YT-NNN requirements from SRS-LTS-YT-01 apply. This document's FR-YT2-NNN requirements are additive or clarifying.

---

## 2. System Overview

The LTS-2026-012 service is architecturally identical to the general YouTube RTSP Ingest service (SRS-LTS-YT-01). The key structural additions are:

1. **`repeatPlayback` support**: Allows VOD virtual cameras to loop indefinitely for long-running test sessions or demos without consuming the restart counter on natural video completion.
2. **Explicit `StreamEntry` contract**: All fields are explicitly typed to ensure DB schema consistency across deployment environments.
3. **`SIGTERM` handler**: Explicitly required to prevent orphaned FFmpeg processes on server shutdown.

---

## 3. LTS-2026-012 Specific Requirements — Repeat Playback

### FR-YT2-001 — repeatPlayback Field in Create Request

- `POST /api/youtube-streams` must accept `repeatPlayback` (boolean, default `false`) in the request body.
- The value must be included in the database record and in the in-memory `StreamEntry`.

### FR-YT2-002 — Natural End Detection

- A `close` event on the FFmpeg process with `code === 0` and `signal === null` must be classified as `isNaturalEnd = true`.
- Any other exit condition (non-zero code, or any signal) must be classified as `isNaturalEnd = false`.

### FR-YT2-003 — Repeat Playback Restart Logic

- When `entry.repeatPlayback === true` and `isNaturalEnd === true`:
  - `entry.restartCount` must be reset to `0` before scheduling a restart.
  - The log must include the message: `"Repeat playback: restarting <id> after natural end"`.
  - The stream must restart indefinitely, never entering `error` state from natural ends.
- When `isNaturalEnd === false` (error exit):
  - The restart counter increments normally regardless of `repeatPlayback`.
  - After `MAX_RESTARTS`, the stream transitions to `error`.

### FR-YT2-004 — repeatPlayback Update Without Restart

- A `PATCH /:id` request changing only `repeatPlayback` (not `youtubeUrl`, `resolution`, or `bitrate`) must apply the change immediately without restarting the stream.
- The `status` must remain unchanged.

### FR-YT2-005 — repeatPlayback in Add Camera Modal

- The Add Camera modal's YouTube tab must include a **Repeat Playback** checkbox.
- The default value must be `false` (unchecked).
- The checkbox value must be included in the `POST /api/youtube-streams` request body.

---

## 4. LTS-2026-012 Specific Requirements — Database Schema

### FR-YT2-010 — cameras Table — YouTube Fields

The `cameras` database table must support the following fields for YouTube virtual cameras:

| Field | Type | Description |
|---|---|---|
| `id` | string | `yt-<uuid-segment>` |
| `name` | string | Display name |
| `type` | string | Must be `'youtube'` |
| `youtubeUrl` | string | Original YouTube URL |
| `rtspUrl` | string | `rtsp://127.0.0.1:8554/yt/<id>` |
| `resolution` | string | `'1080p'`, `'720p'`, or `'480p'` |
| `bitrate` | number | Bitrate in **bps** (stored as bps, not kbps) |
| `repeatPlayback` | boolean | Repeat playback enabled |
| `status` | string | Current stream state |
| `createdAt` | string | ISO 8601 timestamp |

### FR-YT2-011 — Bitrate Storage Convention

- The database must store bitrate in **bps** (bits per second).
- In-memory `StreamEntry` and API responses must use **kbps** (kilobits per second).
- `createStream()` must convert: `db.insert({ bitrate: bitrate_kbps * 1000 })`.
- `init()` (restoration) must convert: `entry.bitrate = Math.round(cam.bitrate / 1000)`.

### FR-YT2-012 — repeatPlayback DB Column Migration

- The `repeatPlayback` column must be present in all deployment environments.
- A DB migration or schema update must ensure the column exists before server start in all environments.

---

## 5. LTS-2026-012 Specific Requirements — Stream Entry Data Model

### FR-YT2-020 — StreamEntry Fields

Each in-memory `StreamEntry` must contain the following fields:

| Field | Type | Description |
|---|---|---|
| `id` | string | `yt-<uuid-segment>` |
| `name` | string | Channel display name |
| `youtubeUrl` | string | Original YouTube page URL |
| `rtspUrl` | string | Internal RTSP URL |
| `resolution` | string | Target resolution string |
| `bitrate` | number | Bitrate in kbps |
| `maxHeight` | number | Pixel height for `-vf scale=-2:<n>` |
| `repeatPlayback` | boolean | Repeat on natural video end |
| `status` | string | Current state (see §3, state machine) |
| `restartCount` | number | Current restart attempt count |
| `createdAt` | string | ISO 8601 creation timestamp |
| `ffmpegProcess` | ChildProcess or null | Active FFmpeg process handle |
| `ytdlpProcess` | ChildProcess or null | Active yt-dlp process handle |
| `restartTimer` | Timeout or null | Pending restart timer handle |
| `startTimer` | Timeout or null | Startup timeout timer handle |
| `liveResolve` | Function or null | Promise resolve for startup |
| `liveReject` | Function or null | Promise reject for startup |

---

## 6. LTS-2026-012 Specific Requirements — Service Constants

### FR-YT2-030 — Configurable Defaults

All service constants must be overridable via environment variables:

| Constant | Default | Env Variable |
|---|---|---|
| `MAX_STREAMS` | 4 | `YOUTUBE_MAX_STREAMS` |
| `MAX_RESTARTS` | 5 | `YOUTUBE_MAX_RESTARTS` |
| `RESTART_DELAY` | 5000 ms | `YOUTUBE_RESTART_DELAY_MS` |
| `START_TIMEOUT` | 30000 ms | `YOUTUBE_START_TIMEOUT_MS` |
| `MEDIAMTX_HOST` | `127.0.0.1` | `MEDIAMTX_HOST` |
| `MEDIAMTX_PORT` | `8554` | `MEDIAMTX_PORT` |

### FR-YT2-031 — YTDLP_NO_CHECK_CERT Behavior

- When `YTDLP_NO_CHECK_CERT` is `'false'` (string), SSL certificate verification must be enabled (omit `--no-check-certificate`).
- Any other value (including absence of the variable) must disable certificate verification (include `--no-check-certificate`).
- This enables compatibility with corporate networks that use self-signed proxy certificates.

---

## 7. LTS-2026-012 Specific Requirements — Error Codes

### FR-YT2-040 — Complete Error Code Reference

| HTTP Status | Error Code | Trigger Condition |
|---|---|---|
| 422 | `INVALID_YOUTUBE_URL` | URL fails YOUTUBE_URL_REGEX test |
| 422 | `YT_DLP_FAILED` | yt-dlp extraction failed (private/deleted/age-restricted) |
| 429 | `MAX_STREAMS_REACHED` | Active stream count >= `YOUTUBE_MAX_STREAMS` |
| 503 | `FFMPEG_NOT_FOUND` | FFmpeg binary not in PATH (`ENOENT` on spawn) |
| 504 | `STREAM_TIMEOUT` | RTSP path not live within `START_TIMEOUT` ms |
| 404 | `NOT_FOUND` | Stream ID does not exist in `this.streams` Map |
| 409 | `STREAM_STOPPED` | Stream status is `'stopping'` or `'removed'` |
| 500 | `STREAM_FAILED` | FFmpeg exits during startup (non-timeout cause) |

### FR-YT2-041 — Error Response Format

All error responses must follow:
```json
{ "success": false, "code": "ERROR_CODE", "error": "human readable message" }
```

---

## 8. LTS-2026-012 Specific Requirements — Process Invocation

### FR-YT2-050 — yt-dlp Format Priority

The format string must prioritize H.264 (avc) streams to avoid AV1/VP9 which FFmpeg 3.x may not decode:

```
bestvideo[ext=mp4][vcodec^=avc][height<=<H>]+bestaudio[ext=m4a]
/bestvideo[vcodec^=avc][height<=<H>]+bestaudio
/best[ext=mp4][vcodec^=avc][height<=<H>]
/best[ext=mp4][height<=<H>]
/best[height<=<H>]
```

This fallback chain ensures playability across all YouTube content types.

### FR-YT2-051 — FFmpeg RTSP Output Pattern Matching

- The `RTSP_LIVE_RE` pattern used to detect successful output must be:
  `/Output #0[^\n]*rtsp|frame=\s*[1-9]|size=\s*\d+kB/i`
- This is more reliable than matching only `Output #0` because line boundaries may fall mid-pattern in stderr chunks.

### FR-YT2-052 — FFmpeg stderr Buffering

- FFmpeg stderr must be buffered line-by-line (split on `\n`, retain partial last line).
- The live detection pattern must be checked against each complete line after trimming.
- Lines must be logged to console with prefix `[YouTubeStream] ffmpeg[<id>]:` (truncated to 300 chars).

---

## 9. LTS-2026-012 Specific Requirements — Server Shutdown

### FR-YT2-060 — SIGTERM/SIGINT Handler

- The LTS server must register `process.on('SIGTERM', ...)` and `process.on('SIGINT', ...)` handlers.
- Both handlers must call `youtubeStreamService.stopAll()` and await its completion before `process.exit()`.
- All active yt-dlp and FFmpeg processes must be terminated within 5 seconds of receiving the signal.

### FR-YT2-061 — stopAll() Implementation

- `stopAll()` must call `_stopEntry(entry, false)` for all non-removed entries in parallel (`Promise.allSettled`).
- Individual `_stopEntry` failures must be caught and ignored (best-effort cleanup).
- After all entries are stopped, `this.streams` must be cleared.

---

## 10. LTS-2026-012 Specific Requirements — UI

### FR-YT2-070 — Repeat Playback Checkbox

- The Add Camera modal must include a **Repeat Playback** checkbox in the YouTube tab.
- The checkbox must default to unchecked (`false`).
- When checked and the stream is created, `repeatPlayback: true` must be included in the `POST` request body.

### FR-YT2-071 — Camera Tile — YT Badge and Error State

- Camera tiles for YouTube virtual channels must display a red `YT` badge in the top-right corner (same as SRS-LTS-YT-01 FR-YT-051).
- Streams in `error` state must show a red error banner with a functional **Restart** button (same as FR-YT-052).

### FR-YT2-072 — Edit Modal Read-Only RTSP URL

- The Edit Camera modal for YouTube cameras must show the internal RTSP URL in a read-only field.
- A restart warning must be shown when `youtubeUrl`, `resolution`, or `bitrate` is changed.

---

## 11. Non-Functional Requirements

All NFRs from SRS-LTS-YT-01 (FR-YT-060 through FR-YT-067) apply.

### FR-YT2-080 — Concurrent 1-Hour Stability

- Four concurrent 1080p YouTube streams must operate for 1 hour without any stream entering the `error` state due to resource exhaustion.

### FR-YT2-081 — repeatPlayback Stability

- A single YouTube VOD stream with `repeatPlayback: true` must run for at least 24 hours without manual intervention (looping on natural end).

---

## 12. Acceptance Criteria Mapping

| AC ID | FR Reference | Description |
|---|---|---|
| AC-1 | FR-YT-005, FR-YT2-001 | Valid URL → 201; stream reaches `live` within 30s |
| AC-2 | FR-YT-001 | Non-YouTube URL → 422 `INVALID_YOUTUBE_URL` |
| AC-3 | FR-YT2-040 | Private/deleted → 422 `YT_DLP_FAILED` |
| AC-4 | FR-YT-021, FR-YT-022 | FFmpeg crash → auto-restart within 10s |
| AC-5 | FR-YT-022, FR-YT-035 | 5 error restarts → `error`; manual restart resets counter |
| AC-6 | FR-YT2-003 | `repeatPlayback: true` + natural end → restart with count reset |
| AC-7 | FR-YT-033 | PATCH new URL → restart; previous FFmpeg terminated |
| AC-8 | FR-YT2-004 | PATCH only `repeatPlayback` → no restart; status unchanged |
| AC-9 | FR-YT2-060 | SIGTERM → all processes terminate within 5s |
| AC-10 | FR-YT-002 | Creating > `YOUTUBE_MAX_STREAMS` → 429 `MAX_STREAMS_REACHED` |
| AC-11 | FR-YT2-071 | Camera tile shows red `YT` badge |
| AC-12 | FR-YT2-070 | Add Camera modal has Repeat Playback checkbox (default false) |
| AC-13 | FR-YT-054 | YouTube virtual channel supports zone editing, loitering detection, WebRTC |
| AC-14 | FR-YT2-080 | 4 concurrent 1080p streams stable for 1 hour |

---

## 13. Constraints & Assumptions

All constraints from SRS-LTS-YT-01 (C-01 through C-09) apply.

| ID | LTS-2026-012 Specific Constraint |
|---|---|
| C-10 | `repeatPlayback` column migration must be verified in all deployment environments before M3 milestone |
| C-11 | The `YOUTUBE_MAX_STREAMS` enforcement (FR-YT-002) is a pending M3 milestone; the feature is implemented but requires env-variable wiring |
| C-12 | `SIGTERM`/`SIGINT` handlers (FR-YT2-060) are pending M3 milestone implementation |
| C-13 | The LTS-2026-012 PRD (PRD-LTS-012) supersedes PRD-LTS-004 for the production delivery scope |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for LTS2026 YouTube RTSP Ingest |
