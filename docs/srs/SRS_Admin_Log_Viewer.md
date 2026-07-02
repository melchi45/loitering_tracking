# SRS — Admin Log Viewer

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Real-Time Server Log Viewer  
**Version:** 1.3  
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

### FR-LOG-017 — Max Lines Setting

The UI SHALL provide a **Max Lines** dropdown selector in the toolbar.

- Options SHALL be: `100`, `200`, `500`, `1000`, `2000`
- Default value SHALL be `500`
- The selected value SHALL be persisted in `localStorage` under the key `lts_admin_log_maxLines`
- On mount, the component SHALL restore the saved value; if no saved value exists or the saved value is not in the valid option set, the default `500` SHALL be used
- The number of lines actually rendered on screen SHALL always be able to reach exactly `maxLines` (once that many entries exist for the selected source) — no other cap in the pipeline (fetch limit, server buffer size) SHALL be smaller than the largest available `maxLines` option
- **On `maxLines` change (either direction)**: the display buffer SHALL be immediately trimmed client-side to `maxLines` entries if it currently exceeds that count (`prev.slice(-maxLines)`), AND the panel SHALL re-fetch `GET /admin/logs/recent?source=<source>&limit=<maxLines>` to backfill additional buffered history when `maxLines` increases — relying on live-only accumulation to eventually "grow into" a larger setting is NOT sufficient
- On each new log entry (real-time `server:log` handler): `setLogs(prev => { const next = [...prev, entry]; return next.length > maxLines ? next.slice(-maxLines) : next; })` — this handler SHALL always read the **current** `maxLines` value; because the underlying Socket.IO client is a module-level singleton whose `useEffect(..., [socket])` only runs once for the component's lifetime, `maxLines` MUST be included in that effect's dependency array (or read via a ref updated on every render) so the handler is not permanently bound to the value captured at mount
- On initial load and polling (`source=ingest|mediamtx`): the fetch request SHALL pass `limit=<maxLines>` (the user's current setting), never a fixed value independent of `maxLines`; the polling `setInterval` closure is subject to the same stale-value risk as the socket handler and SHALL likewise depend on the current `maxLines`
- The header subtitle SHALL reflect the current value: `Real-time log viewer · last {maxLines} lines per source`

**Acceptance**:
- Changing Max Lines from 500 to 100 while 400 lines are displayed SHALL immediately reduce the display to the newest 100 lines.
- Changing Max Lines from 100 to 1000 while connected to a source with ≥1000 buffered/logged entries SHALL, within one fetch round-trip, grow the display to 1000 lines — not remain capped near 100 or 200 until enough new live events happen to arrive.
- Changing Max Lines while the real-time stream (`source=server`) is actively receiving entries SHALL apply the new cap to the very next entry, not to entries received after some unrelated state change (e.g. switching `source` and back).

**Server ring buffer sizing**: The server-side ring buffer (`LOG_BUFFER_MAX` in `server/src/utils/logger.js`) and the `GET /admin/logs/recent` `limit` clamp (`server/src/routes/admin.js`) SHALL both be **≥ the largest value in the Max Lines option set** (currently `2000`). If either constant and the option set diverge, they MUST be updated together — a smaller server-side cap makes the corresponding Max Lines UI option structurally unsatisfiable regardless of client-side correctness, which is what caused the 2026-07-02 defect (buffer was fixed at 500 while the UI already offered 1000/2000).

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
| 1.2 | 2026-06-30 | FR-LOG-017 Max Lines 설정 추가 — localStorage 영속, 즉시 트림, 서버 ring buffer와의 차이 명시 |
| 1.3 | 2026-07-02 | FR-LOG-017 버그 수정 반영 — "표시 lines가 Max Lines와 항상 일치해야 함" 요구사항 명문화, stale closure 방지 규칙(maxLines를 effect 의존성에 포함) 추가, 서버 ring buffer는 Max Lines 최대 옵션 이상이어야 함을 SHALL로 규정 (기존 500 고정값 노트 삭제 — 그 자체가 결함의 원인이었음) |
