# RFP — Admin Log Viewer

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Real-Time Server Log Viewer  
**Version:** 1.1  
**Date:** 2026-06-29

---

## 1. Background

LTS-2026 is a multi-process server system (Node.js server + Ingest Daemon + MediaMTX). When issues occur in production, administrators currently need SSH terminal access to view logs. The Admin Dashboard already provides user management, AI model control, ONVIF event management, system metrics, and audit logging. A dedicated Log Viewer section completes the operational toolset.

---

## 2. Scope of Work

Implement a real-time server log viewer within the existing Administrator Dashboard that enables in-browser log monitoring without external tools.

---

## 3. Functional Requirements

### 3.1 Log Source Selection

The viewer must support three log sources selectable at runtime:

| Source ID | Label | Transport | Availability |
|---|---|---|---|
| `server` | Server | Socket.IO real-time (`server:log`) | All modes |
| `ingest` | Ingest Daemon | HTTP poll — log file filter `[Ingest]` | streaming/combined only |
| `mediamtx` | MediaMTX | HTTP poll — log file filter `[MediaMTX]` | All modes |

### 3.2 Log Level Control

- **View filter**: checkboxes to show/hide ERROR / WARNING / INFO / DEBUG entries client-side
- **Runtime level**: dropdown to set the server-side minimum relay level via `PATCH /admin/logs/level`; change takes effect immediately without restart; change is audited via AuditService

### 3.3 Real-Time Streaming

- Server source: Socket.IO event `server:log` with payload `{ ts, level, msg, t }`
- On connect: client emits `admin:subscribe-logs` to receive the last 500 buffered entries
- Ring buffer: last 500 entries retained in memory for late-joining clients
- Ingest / MediaMTX: `GET /admin/logs/recent?source=<source>&limit=200` polled every 2 s

### 3.4 Log Display

- Monospace font, dark background
- Color-coded rows by level: ERROR red / WARNING yellow / INFO blue / DEBUG gray
- Auto-scroll to bottom (toggleable); automatically pauses when user scrolls up; re-enables when user scrolls back to bottom
- Pause / Resume toggle to stop accepting new entries without disconnecting
- Maximum displayed lines is user-configurable (options: 100 / 200 / 500 / 1000 / 2000; default 500); oldest entries purged on overflow
- Display columns: timestamp | level badge | message
- **Fixed control area**: toolbar, search bar, and stats row MUST remain visible at all times; only the log area scrolls internally
- Max Lines preference is persisted in browser `localStorage` and restored on next visit

### 3.5 Actions

| Action | Trigger |
|---|---|
| Clear | Clears in-browser display only (does not delete log file) |
| Download | Exports current filtered view as `.txt` file |
| Auto-scroll toggle | Stays at bottom vs. free scroll |
| Pause / Resume | Halt real-time updates vs. resume |
| Max Lines | Dropdown (100/200/500/1000/2000, default 500) — controls display buffer size; persisted in `localStorage` |

### 3.6 Log Search

- A persistent search bar SHALL be displayed between the toolbar and the stats row
- Search SHALL filter the current in-browser log list in real time (case-insensitive)
- Search SHALL match against message text AND timestamp string
- Matching substring SHALL be highlighted in each log row (yellow highlight)
- A match count indicator (`N matches`) SHALL be shown within the search bar
- A clear button (✕) SHALL reset the search query
- The stats row SHALL show a `🔍 filtered` indicator when a search is active
- Download SHALL export only the currently matched (filtered) entries

---

## 4. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Security | Admin role required for all log endpoints (JWT + `requireRole('admin')`) |
| Performance | Socket relay must not block the main event loop; log emission is async fire-and-forget |
| Reliability | Log relay failure must not crash the server process (try/catch wrapper) |
| Compatibility | Works in all three server modes: combined / streaming / analysis |

---

## 5. API Contracts

### GET /admin/logs/recent

```
Query params:
  source   = server | ingest | mediamtx    (default: server)
  limit    = 1–500                          (default: 200)

Response 200:
{
  "logs":  [{ "ts": string, "level": string, "msg": string, "t": number }],
  "level": string,   // current runtime log level
  "total": number
}
```

### PATCH /admin/logs/level

```
Body: { "level": "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL" | "NONE" }

Response 200: { "ok": true, "level": string }
Response 400: { "error": string }
```

### Socket.IO: server:log (Server → Client)

```
{ "ts": string, "level": string, "msg": string, "t": number }
```

### Socket.IO: admin:subscribe-logs (Client → Server)

Triggers flush of buffered log entries to the requesting socket.

---

## 6. UI Placement

Admin Dashboard (`AdminUsersPage.tsx`) sidebar:

```
👥 Users
🤖 AI Models
📡 ONVIF
📋 Audit Log
📊 System
🖥️ Server Logs  ← NEW
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-29 | 초기 작성 |
| 1.1 | 2026-06-30 | 3.4 툴바 고정 명시, 3.6 로그 텍스트 검색 요구사항 추가 |
| 1.2 | 2026-06-30 | 3.4 Max Lines 설정 가능 기술, 3.5 Actions 표에 Max Lines 항목 추가 |
