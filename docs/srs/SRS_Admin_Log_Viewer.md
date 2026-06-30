# SRS — Admin Log Viewer

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Real-Time Server Log Viewer  
**Version:** 1.1  
**Date:** 2026-06-29

---

## 1. Introduction

This Software Requirements Specification defines the functional and non-functional requirements for the Admin Log Viewer feature added to the LTS-2026 Administrator Dashboard.

---

## 2. Scope

- **Included**: Server log relay, log level runtime control, log source selection, admin UI, fixed toolbar layout, in-browser text search with highlight
- **Excluded**: Log file management, server-side log indexing, remote server log aggregation

---

## 3. Functional Requirements

### FR-LOG-001 — Real-Time Server Log Relay

The server SHALL relay all `console.log`, `console.info`, `console.warn`, `console.error`, and `console.debug` calls as `server:log` Socket.IO events.

Each event payload SHALL contain:
- `ts`: formatted timestamp string `[YY-MM-DD HH:mm:ss.sss]`
- `level`: one of `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`
- `msg`: the formatted log message string
- `t`: millisecond epoch timestamp

**Acceptance**: Calling `console.info('test')` in any server module SHALL produce a `server:log` event on all connected sockets within 1 second.

### FR-LOG-002 — Log Ring Buffer

The server SHALL maintain an in-memory ring buffer of the last 500 `server:log` entries.

**Acceptance**: A client connecting 5 minutes after server start SHALL receive the last 500 entries on `admin:subscribe-logs` request.

### FR-LOG-003 — Log Buffer Subscription

When a connected socket emits `admin:subscribe-logs`, the server SHALL immediately emit all buffered log entries to that socket.

### FR-LOG-004 — Log File Tail for Child Processes

`GET /admin/logs/recent?source=ingest` SHALL return the last N lines (default 200, max 500) from the current daily log file that contain `[Ingest]`.

`GET /admin/logs/recent?source=mediamtx` SHALL return lines containing `[MediaMTX]`.

If the log file does not exist, the response SHALL be `{ logs: [], total: 0 }`.

### FR-LOG-005 — Runtime Log Level Control

`PATCH /admin/logs/level` SHALL change the minimum level for Socket.IO relay emission.

Levels in ascending order: `DEBUG` < `INFO` < `WARNING` < `ERROR` < `CRITICAL` < `NONE`.

Setting level to `INFO` SHALL suppress `DEBUG` entries from `server:log` emission. Existing buffer entries are NOT retroactively filtered.

**Acceptance**: After `PATCH /admin/logs/level { level: 'WARNING' }`, subsequent `console.debug()` and `console.info()` calls SHALL NOT produce `server:log` events.

### FR-LOG-006 — Level Change Audit

Every successful `PATCH /admin/logs/level` SHALL create an AuditService entry with event type `log_level_changed` and the actor's user ID and new level.

### FR-LOG-007 — API Authentication

Both `GET /admin/logs/recent` and `PATCH /admin/logs/level` SHALL require a valid JWT access token with role `admin`. Requests without valid credentials SHALL return `401 Unauthorized` or `403 Forbidden`.

### FR-LOG-008 — Client Source Selection

The UI SHALL allow switching between source types: `server`, `ingest`, `mediamtx`.

On switching source, the UI SHALL:
1. Clear the current log display
2. Load `GET /admin/logs/recent?source=<new-source>`
3. For `server`: subscribe to `server:log` Socket.IO events
4. For `ingest`/`mediamtx`: start a 2-second polling interval

### FR-LOG-009 — Client Level View Filter

The UI SHALL provide per-level visibility toggles for `ERROR`, `WARNING`, `INFO`, `DEBUG`. At least one level SHALL remain selected at all times.

### FR-LOG-010 — Auto-Scroll Behaviour

Auto-scroll SHALL be enabled by default. Implementation SHALL use `element.scrollTop = element.scrollHeight` on the log area container (NOT `Element.scrollIntoView()`) to prevent document-level scrolling that would push the toolbar off-screen.

When the user scrolls up more than 50 px from the bottom of the log area, auto-scroll SHALL automatically disable. When the user manually scrolls back to within 50 px of the bottom, auto-scroll SHALL automatically re-enable. Clicking the "↓ Auto-scroll" button SHALL also re-enable it and scroll to the bottom immediately.

### FR-LOG-011 — Pause / Resume

When paused, the UI SHALL stop appending incoming `server:log` events and stop polling. Existing entries SHALL remain visible. On resume, polling SHALL restart and new entries SHALL append normally.

### FR-LOG-012 — Clear Action

The Clear button SHALL remove all entries from the in-browser display only. It SHALL NOT modify or delete any server-side log files.

### FR-LOG-013 — Download Action

The Download button SHALL export all currently visible (filtered) log entries as a UTF-8 plain text file. The filename SHALL follow the pattern:
`lts-logs-<source>-<YYYY-MM-DDTHH-MM-SS>.txt`

### FR-LOG-014 — Source Visibility by Server Mode

The `Ingest Daemon` source option SHALL be hidden when the server reports `SERVER_MODE=analysis`.

### FR-LOG-015 — Fixed Control Area

The toolbar (source selector, level controls, action buttons), search bar, and stats row SHALL be rendered in a `flex-shrink-0` container that never scrolls. Only the log area div (below the fixed area) SHALL have `overflow-y-auto`. This ensures controls remain visible regardless of the number of log entries displayed.

**Acceptance**: While auto-scroll is active and entries are arriving, the toolbar and search bar SHALL remain fully visible without any user scroll interaction.

### FR-LOG-016 — In-Browser Text Search

The UI SHALL provide a persistent search bar between the toolbar and the stats row.

- Typing in the search bar SHALL filter the displayed log list in real-time (no submit required)
- Filter SHALL be case-insensitive
- Filter SHALL match against both the `msg` field and the `ts` timestamp string
- Matching substring in the `msg` field SHALL be visually highlighted (yellow background mark)
- Highlighting SHALL be recursive — multiple occurrences per line SHALL all be highlighted
- A match count indicator SHALL be shown within the search bar while a query is active
- A clear button (✕) within the search bar SHALL reset the query to empty
- The stats row SHALL display a `🔍 filtered` tag when a search query is active
- The Download action SHALL export only entries that pass both the level filter AND the search filter

**Acceptance**: Typing `camera` in the search bar while 200 entries are displayed SHALL immediately update the list to show only entries whose message or timestamp contains `camera` (case-insensitive); all remaining visible entries SHALL have `camera` highlighted.

---

## 4. Non-Functional Requirements

### NFR-LOG-01 — Performance

Socket.IO relay emission MUST be non-blocking. The relay function MUST NOT synchronously wait for socket acknowledgement.

### NFR-LOG-02 — Memory Bound

The in-memory log ring buffer MUST NOT exceed 500 entries. The ring buffer MUST NOT retain references to message objects beyond the buffer capacity.

### NFR-LOG-03 — Security

All admin log endpoints MUST verify JWT and require `admin` role before returning any data. Log content MUST NOT include raw database credentials or JWT secret values.

### NFR-LOG-04 — Availability

A failure in the Socket.IO relay (e.g., IO reference not yet set) MUST NOT crash the server process. The relay MUST be wrapped in a try/catch.

### NFR-LOG-05 — Compatibility

The log viewer MUST function in `combined`, `streaming`, and `analysis` server modes.

---

## 5. Data Model

### LogEntry (in-memory / socket event)

```typescript
interface LogEntry {
  ts:    string;    // "[YY-MM-DD HH:mm:ss.sss]"
  level: string;    // "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL"
  msg:   string;    // formatted message (no ts/level prefix)
  t:     number;    // Date.now() at emission time
}
```

---

## 6. Component Map

| Component | File | Role |
|---|---|---|
| Log relay install | `server/src/utils/logger.js` · `installSocketRelay(io)` | Wraps console, emits `server:log` |
| Runtime level | `server/src/utils/logger.js` · `setLogLevel()` / `getLogLevel()` | Controls relay filter |
| Ring buffer | `server/src/utils/logger.js` · `_recentLogs[]` | Last 500 entries |
| Log file tail | `server/src/utils/logger.js` · `tailLogFile()` | Reads daily log file |
| REST endpoints | `server/src/routes/admin.js` | GET+PATCH `/admin/logs/*` |
| IO wiring | `server/src/index.js` | Calls `installSocketRelay(io)` |
| Log panel UI | `client/src/components/AdminLogPanel.tsx` | Viewer component |
| Admin page | `client/src/pages/admin/AdminUsersPage.tsx` | Hosts panel in `logs` section |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-29 | 초기 작성 |
| 1.1 | 2026-06-30 | FR-LOG-010 scrollTop 방식 명시, FR-LOG-015 고정 Control Area, FR-LOG-016 텍스트 검색 추가; searchQuery 상태 추가 |
