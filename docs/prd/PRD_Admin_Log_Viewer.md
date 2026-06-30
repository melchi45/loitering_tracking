# PRD — Admin Log Viewer

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Real-Time Server Log Viewer  
**Version:** 1.1  
**Date:** 2026-06-29

---

## 1. Overview

The Admin Log Viewer adds a **Server Logs** section to the existing Administrator Dashboard that streams live server logs directly in the browser. It eliminates the need for SSH terminal access during production monitoring and incident investigation.

---

## 2. User Stories

| ID | As a... | I want to... | So that... |
|---|---|---|---|
| US-01 | Admin | See server logs in real time | I can monitor the system without SSH |
| US-02 | Admin | Filter by log source | I can focus on Server / Ingest Daemon / MediaMTX separately |
| US-03 | Admin | Toggle log levels (ERROR/WARNING/INFO/DEBUG) | I can reduce noise or see verbose detail on demand |
| US-04 | Admin | Change the server-side log level at runtime | I can enable DEBUG without restarting the server |
| US-05 | Admin | Pause the log stream | I can read an entry without it scrolling away |
| US-06 | Admin | Download the current log view | I can attach logs to a support ticket |
| US-07 | Admin | See color-coded severity | I can immediately spot errors at a glance |
| US-08 | Admin | Keep the toolbar visible while log entries scroll | I can change filters without scrolling back to the top |
| US-09 | Admin | Search log messages by keyword | I can find specific events instantly without reading every line |

---

## 3. Feature Specification

### 3.1 Source Selector

Three mutually exclusive source tabs:

| Tab | Description | Data channel |
|---|---|---|
| Server | Main Node.js server logs | Socket.IO `server:log` (real-time) |
| Ingest Daemon | Python ingest daemon logs | HTTP poll `GET /admin/logs/recent?source=ingest` every 2 s |
| MediaMTX | MediaMTX proxy logs | HTTP poll `GET /admin/logs/recent?source=mediamtx` every 2 s |

**Visibility rules:**
- `Ingest Daemon` tab is hidden in `analysis` server mode (no capture daemon)
- `MediaMTX` tab always visible (MediaMTX may or may not be running)

### 3.2 Level View Filter

Client-side checkboxes: `ERROR`, `WARNING`, `INFO`, `DEBUG`

- At least one level must always remain selected (toggle deselection of last item is blocked)
- Counts per level shown in status bar
- Does not affect server-side emission — purely a display filter

### 3.3 Runtime Log Level

Dropdown: `DEBUG` | `INFO` | `WARNING` | `ERROR` | `CRITICAL` | `NONE`

- Only applies to the Socket.IO relay (not log file output)
- Calls `PATCH /admin/logs/level` on change
- Current value fetched from `GET /admin/logs/recent` on mount
- Disabled (visually dimmed) when source ≠ Server
- Level change is recorded in audit log via AuditService

### 3.4 Log Display Area

Layout (fixed-header pattern — only the log area scrolls):

```
┌─ Fixed control area (flex-shrink-0, never scrolls) ──────────────────────┐
│ Header · connection indicator                                             │
│ Toolbar: [Source] [Level▾] [Show:ERROR|WARNING|INFO|DEBUG] [Actions]     │
│ Search: 🔍 [___search text______________________________] 12 matches  ✕  │
│ Stats: 12 / 200 lines · 🔍 filtered · ERROR:2 WARNING:5                  │
├─ Scrollable log area (flex-1 min-h-0 overflow-y-auto) ───────────────────┤
│ [26-06-29 14:30:00.123] [ERROR]  [pipelineManager] Camera disconnected   │
│ [26-06-29 14:30:01.456] [WARNING] [internalApi] ONVIF parse timeout      │
│ [26-06-29 14:30:02.789] [INFO]  [captureFactory] Camera cam-001 started  │
│ [26-06-29 14:30:03.012] [DEBUG]  [tracking] ByteTrack frame 2045         │
└───────────────────────────────────────────────────────────────────────────┘
```

- Monospace font, dark background, 11 px text
- Max 500 lines in display; FIFO purge on overflow
- Auto-scroll enabled by default; uses `scrollTop = scrollHeight` (not `scrollIntoView`) to prevent document-level scroll
- Auto-scroll pauses when user scrolls up; automatically re-enables when user scrolls back to bottom
- The toolbar, search bar, and stats row are wrapped in `flex-shrink-0` so they are never pushed off-screen by incoming log entries

### 3.5 Status Bar

`{filtered} / {total} lines  [level counts]  [polling indicator for file sources]`

### 3.6 Toolbar Controls

| Control | Behavior |
|---|---|
| Source selector | Switch between Server / Ingest Daemon / MediaMTX |
| Server Log Level | Change runtime relay level (server source only) |
| Show Levels | Toggle per-level display filter |
| ↓ Auto-scroll | Re-enable auto-scroll to bottom |
| ⏸ Pause / ▶ Resume | Halt / resume ingestion of new entries |
| ↓ Download | Export filtered + searched logs as plain text |
| Clear | Clear in-browser display |

### 3.7 Log Search

- A search bar sits between the toolbar and the stats row, visible at all times
- Typing filters the displayed logs in real-time (case-insensitive)
- Matches against message text AND timestamp string
- Matching substring is highlighted in yellow within each log row
- Match count shown in search bar; cleared with ✕ button
- Stats row shows `🔍 filtered` tag when search is active
- Download respects active search filter

---

## 4. Edge Cases

| Scenario | Behavior |
|---|---|
| Socket disconnects | Connection indicator turns red; existing logs remain; auto-reconnects |
| Log file not found | Ingest/MediaMTX source shows "No log entries" message |
| No log entries | Empty state with contextual message |
| 500+ lines arrive quickly | Oldest lines dropped; scroll position maintained |
| Admin leaves logs section | Socket event listener is cleaned up on unmount |

---

## 5. Access Control

- All log endpoints require JWT authentication + `admin` role
- Non-admin users cannot access `/admin/logs/recent` or `/admin/logs/level`
- Socket.IO `server:log` event is broadcast to all sockets (admin page auth already gates access)

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-29 | 초기 작성 |
| 1.1 | 2026-06-30 | US-08/09 추가, 3.4 레이아웃 고정 설계, 3.7 텍스트 검색 명세 추가 |
