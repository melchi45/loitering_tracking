# TEST CASES (TC)
# YouTube → RTSP Ingest Service (LTS-2026-012 Refinements)

| | |
|---|---|
| **Document ID** | TC-LTS-YT-02 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_LTS2026_YouTube_RTSP_Ingest.md |
| **Base TC** | tc/TC_YouTube_RTSP_Ingest.md (TC-LTS-YT-01) |
| **Test Scripts** | test/api/youtube_streams_lts2026.test.js |

> **Note:** This document covers only the LTS-2026-012-specific test cases.
> For general YouTube RTSP Ingest tests (FR-YT-NNN), refer to TC-LTS-YT-01.

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — repeatPlayback Feature](#3-test-group-a--repeatplayback-feature)
4. [Test Group B — Database Schema Compliance](#4-test-group-b--database-schema-compliance)
5. [Test Group C — StreamEntry Contract](#5-test-group-c--streamentry-contract)
6. [Test Group D — Error Codes — Extended](#6-test-group-d--error-codes--extended)
7. [Test Group E — SIGTERM / SIGINT Handling](#7-test-group-e--sigterm--sigint-handling)
8. [Test Group F — Process Invocation Details](#8-test-group-f--process-invocation-details)
9. [Test Group G — UI (LTS-2026-012 specific)](#9-test-group-g--ui-lts-2026-012-specific)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | `repeatPlayback` CRUD, extended error codes | Node.js fetch | `test/api/youtube_streams_lts2026.test.js` |
| Unit | Natural end detection, restart logic | Node.js | `test/unit/youtube_lts2026.test.js` (Phase-2) |
| Integration | SIGTERM handler, `stopAll()` | Process signal | `test/integration/youtube_sigterm.test.js` (Phase-2) |
| E2E | 24h loop stability | Manual/long-running | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-YT2-001 | TC-A-001 |
| FR-YT2-002 | TC-A-002 |
| FR-YT2-003 | TC-A-003 |
| FR-YT2-004 | TC-A-004 |
| FR-YT2-005 | TC-G-001 |
| FR-YT2-010 | TC-B-001 |
| FR-YT2-011 | TC-B-002 |
| FR-YT2-012 | TC-B-003 |
| FR-YT2-020 | TC-C-001 |
| FR-YT2-030 | TC-F-001 |
| FR-YT2-031 | TC-F-002 |
| FR-YT2-040 | TC-D-001 |
| FR-YT2-041 | TC-D-002 |
| FR-YT2-050 | TC-F-003 |
| FR-YT2-051 | TC-F-004 |
| FR-YT2-052 | TC-F-005 |
| FR-YT2-060 | TC-E-001 |
| FR-YT2-061 | TC-E-002 |
| FR-YT2-070 | TC-G-001 |
| FR-YT2-071 | TC-G-002 |
| FR-YT2-072 | TC-G-003 |
| FR-YT2-080 | TC-G-004 |
| FR-YT2-081 | TC-G-005 |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3080`
- `yt-dlp` and `ffmpeg` available on PATH
- MediaMTX running and bound to `127.0.0.1:8554`
- Test YouTube URLs accessible (or mocked)
- `GET /health` returns `{ status: 'ok' }`

---

## 3. Test Group A — repeatPlayback Feature

### TC-A-001 — repeatPlayback in Create Request
- **Input:** `POST /api/youtube-streams` with `{ ..., repeatPlayback: true }`
- **Expected:** HTTP 201; camera record includes `repeatPlayback: true`
- **Acceptance:** `repeatPlayback` present in response and in `GET /api/youtube-streams`

### TC-A-002 — Natural End Detection
- **Input:** FFmpeg process exits with `code=0, signal=null`
- **Expected:** Classified as `isNaturalEnd = true`; any other exit = `isNaturalEnd = false`
- **Acceptance:** Unit test: `{ code: 0, signal: null }` → `isNaturalEnd = true`; `{ code: 1 }` → `false`

### TC-A-003 — Repeat Playback Restart Logic
- **Precondition:** Stream with `repeatPlayback: true`
- **Input:** FFmpeg exits naturally (`code=0, signal=null`)
- **Expected:** `restartCount` reset to 0; log includes "Repeat playback: restarting <id> after natural end"; stream restarts without error state
- **Acceptance:** Stream continues running; `status` never becomes `error` on natural ends

### TC-A-004 — repeatPlayback-Only PATCH
- **Input:** `PATCH /api/youtube-streams/:id` with `{ repeatPlayback: false }` (no URL/resolution/bitrate change)
- **Expected:** HTTP 200; `repeatPlayback` updated immediately; stream NOT restarted
- **Acceptance:** Stream `status` unchanged; `repeatPlayback` updated in response

---

## 4. Test Group B — Database Schema Compliance

### TC-B-001 — cameras Table Fields for YouTube
- **Input:** `POST /api/youtube-streams` to create stream; inspect DB record
- **Expected:** Record contains all required fields: `id`, `name`, `type`, `youtubeUrl`, `rtspUrl`, `resolution`, `bitrate`, `repeatPlayback`, `status`
- **Acceptance:** All fields present with correct types

### TC-B-002 — bitrate bps vs kbps Conversion
- **Input:** Create stream with `bitrate: 1500` (kbps via API)
- **Expected:** DB record stores `bitrate: 1500000` (bps); API response returns `1500` (kbps)
- **Acceptance:** bps/kbps conversion correct at both DB and API layers

### TC-B-003 — repeatPlayback Migration
- **Input:** Legacy DB record without `repeatPlayback` field; server startup
- **Expected:** `repeatPlayback` defaulted to `false` and written back to DB
- **Acceptance:** Legacy record updated; `GET /api/youtube-streams` shows `repeatPlayback: false`

---

## 5. Test Group C — StreamEntry Contract

### TC-C-001 — All StreamEntry Fields Present
- **Input:** Create active YouTube stream; inspect in-memory entry
- **Expected:** StreamEntry contains all required fields: `id`, `name`, `youtubeUrl`, `rtspUrl`, `resolution`, `bitrate`, `status`, `restartCount`, `repeatPlayback`, process handles, timers
- **Acceptance:** All mandatory fields present; `ytdlpProcess` and `ffmpegProcess` set when running

---

## 6. Test Group D — Error Codes — Extended

### TC-D-001 — Extended Error Code Table
- **Input:** Trigger each error condition:
  - Invalid YouTube URL → expect `INVALID_YOUTUBE_URL` (422)
  - Max streams reached → `MAX_STREAMS_REACHED` (429)
  - FFmpeg not found → `FFMPEG_NOT_FOUND` (503)
  - Start timeout → `STREAM_TIMEOUT` (504)
  - Non-existent ID → `STREAM_NOT_FOUND` (404)
  - Restart non-error → `STREAM_ALREADY_RUNNING` (409)
- **Expected:** Each error returns correct HTTP status code
- **Acceptance:** All 6 error codes with correct HTTP status codes

### TC-D-002 — Error Response Format
- **Input:** Trigger any error (e.g., invalid URL)
- **Expected:** Response body: `{ "success": false, "code": "ERROR_CODE", "error": "message" }`
- **Acceptance:** All 3 fields present in error response

---

## 7. Test Group E — SIGTERM / SIGINT Handling

### TC-E-001 — SIGTERM Handler Registration
- **Input:** Server process receives SIGTERM
- **Expected:** `youtubeStreamService.stopAll()` called; all FFmpeg processes terminated within 5 seconds; `process.exit(0)` called
- **Acceptance:** No orphaned FFmpeg processes after SIGTERM

### TC-E-002 — stopAll() Parallel Execution
- **Input:** 2 active YouTube streams; call `stopAll()`
- **Expected:** Both streams stopped in parallel (Promise.all); `this.streams` cleared after completion
- **Acceptance:** Both streams stop concurrently (not sequentially); streams Map is empty after

---

## 8. Test Group F — Process Invocation Details

### TC-F-001 — Service Constants Override
- **Input:** Set env vars `YOUTUBE_MAX_STREAMS=2`, `YOUTUBE_MAX_RESTARTS=3`, `YOUTUBE_RESTART_DELAY=10000`
- **Expected:** Service uses overridden values (max 2 streams; 3 restarts; 10s delay)
- **Acceptance:** Create 3rd stream → `MAX_STREAMS_REACHED`; restart count limit = 3

### TC-F-002 — SSL Certificate Check Gate
- **Input:** `YTDLP_NO_CHECK_CERT=false` set in environment
- **Expected:** `--no-check-certificate` NOT passed to yt-dlp
- **Input 2:** `YTDLP_NO_CHECK_CERT` unset (default)
- **Expected:** `--no-check-certificate` IS passed
- **Acceptance:** Argument presence matches env var value

### TC-F-003 — H.264 Priority Format String
- **Input:** Inspect yt-dlp arguments when creating stream
- **Expected:** Format string contains `vcodec^=avc1` priority entries before generic fallback
- **Acceptance:** H.264 preference chain present; AV1/VP9 avoided

### TC-F-004 — FFmpeg Live Detection Pattern
- **Input:** Mock FFmpeg stderr with "Output #0 rtsp://..." line
- **Expected:** `RTSP_LIVE_RE` matches; `_setLive()` called
- **Input 2:** "frame=  5" line
- **Expected:** Pattern matches
- **Acceptance:** All 3 pattern variants trigger live detection

### TC-F-005 — Line-Buffered FFmpeg stderr
- **Input:** FFmpeg stderr outputs partial line followed by newline
- **Expected:** Pattern checked only on complete lines (after newline)
- **Acceptance:** No premature live detection on partial lines

---

## 9. Test Group G — UI (LTS-2026-012 specific)

### TC-G-001 — Repeat Playback Checkbox in Modal
- **Input:** Open Add Camera modal → YouTube tab
- **Expected:** Repeat Playback checkbox present; default state = unchecked
- **Acceptance:** Checkbox visible and unchecked by default

### TC-G-002 — YT Badge on Camera Tile
- **Input:** YouTube camera added; camera grid visible
- **Expected:** Camera tile shows red "YT" badge
- **Acceptance:** Badge visible; color is red

### TC-G-003 — Edit Modal Restart Warning
- **Input:** Open Edit modal for YouTube camera; change bitrate
- **Expected:** Warning message about restart visible
- **Acceptance:** Warning text present when URL/resolution/bitrate changed

### TC-G-004 — 4 Concurrent Streams Stability (Phase-3 manual)
- **Input:** 4 simultaneous 1080p YouTube streams for 1 hour
- **Expected:** All 4 streams stable; no resource exhaustion
- **Acceptance:** All 4 live throughout 1-hour observation

### TC-G-005 — 24h Loop Stability (Phase-3 manual)
- **Input:** Single YouTube VOD with `repeatPlayback: true` running 24 hours
- **Expected:** Stream loops indefinitely without entering error state
- **Acceptance:** Stream live after 24 hours; `restartCount` reset correctly on each loop

---

## 10. Test Execution Order

```
Group B (schema) → Group C (entry) → Group A (repeatPlayback) → Group D (errors) → Group E (SIGTERM) → Group F (invocation) → Group G (UI)
```

---

## 11. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| repeatPlayback | Field accepted; natural end resets counter; PATCH no restart |
| DB schema | All fields present; bps/kbps conversion correct; migration works |
| Error codes | All 6 codes with correct HTTP status |
| SIGTERM | Clean shutdown; no orphaned processes |
| Process args | Correct format string; SSL gate; line-buffered stderr |
| UI | Checkbox default unchecked; YT badge; restart warning |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for LTS2026 YouTube RTSP Ingest |
