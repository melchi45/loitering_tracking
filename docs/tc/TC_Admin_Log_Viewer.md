# TC — Admin Log Viewer

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Real-Time Server Log Viewer  
**Version:** 1.4  
**Date:** 2026-07-14  
**SRS Reference:** SRS_Admin_Log_Viewer.md

---

## Test Cases

### TC-LOG-001: Admin access to log viewer section

**SRS:** FR-LOG-007  
**Precondition:** LTS server running; logged in as admin  
**Steps:**
1. Navigate to Admin Dashboard
2. Click **🖥️ Server Logs** in sidebar

**Expected:** Log viewer panel renders; toolbar, log area, and connection indicator visible; no error

---

### TC-LOG-002: Non-admin cannot access log endpoints

**SRS:** FR-LOG-007  
**Steps:**
1. Log in as non-admin user (viewer / operator)
2. `GET /admin/logs/recent`

**Expected:** `401` or `403` response; no log data returned

---

### TC-LOG-003: Real-time log streaming — server source

**SRS:** FR-LOG-001, FR-LOG-003  
**Precondition:** Admin on Server Logs panel, source = Server  
**Steps:**
1. Note current log count
2. Trigger a server action (e.g., load camera list via API)
3. Observe log panel

**Expected:** New log entries appear in < 1 s; latest entry matches action

---

### TC-LOG-004: Ring buffer flush on subscribe

**SRS:** FR-LOG-002, FR-LOG-003  
**Steps:**
1. Generate 50+ log entries while NOT on the logs panel
2. Navigate to Server Logs panel

**Expected:** Panel loads with the last 2000 (or fewer) entries immediately on open (buffer capacity raised from 500 to 2000 on 2026-07-02 to match the largest Max Lines option — see TC-LOG-034~036)

---

### TC-LOG-005: Runtime log level change — INFO → DEBUG

**SRS:** FR-LOG-005  
**Precondition:** Source = Server, Server Log Level = INFO  
**Steps:**
1. Change Server Log Level dropdown to `DEBUG`
2. Trigger a debug-level server action

**Expected:** `PATCH /admin/logs/level` returns `{ ok: true, level: 'DEBUG' }`; debug entries now appear in log panel

---

### TC-LOG-006: Runtime log level change — INFO → WARNING (suppresses INFO)

**SRS:** FR-LOG-005  
**Steps:**
1. Change Server Log Level to `WARNING`
2. Trigger multiple `console.info()` calls server-side

**Expected:** No INFO entries arrive in the log panel

---

### TC-LOG-007: Level change is audit-logged

**SRS:** FR-LOG-006  
**Steps:**
1. Change Server Log Level
2. Navigate to Admin Dashboard → Audit Log

**Expected:** Audit entry with event `log_level_changed` and the admin's user ID visible

---

### TC-LOG-008: Display level filter — hide ERROR

**SRS:** FR-LOG-009  
**Steps:**
1. Click `ERROR` button in Show Levels row (deselect)
2. Observe log panel

**Expected:** ERROR rows disappear from view; level counter shows 0 for ERROR

---

### TC-LOG-009: Cannot deselect last visible level

**SRS:** FR-LOG-009  
**Precondition:** Only `INFO` is selected in Show Levels  
**Steps:**
1. Click `INFO` button to deselect

**Expected:** Action has no effect; INFO remains selected (minimum one level always visible)

---

### TC-LOG-010: Pause stops new entries

**SRS:** FR-LOG-011  
**Steps:**
1. Click **⏸ Pause**
2. Generate server log entries
3. Observe panel

**Expected:** No new entries appear while paused; count does not increase

---

### TC-LOG-011: Resume re-enables updates

**SRS:** FR-LOG-011  
**Steps:**
1. Resume after being paused
2. Generate server log entries

**Expected:** New entries start appearing again

---

### TC-LOG-012: Clear button removes display entries

**SRS:** FR-LOG-012  
**Steps:**
1. Ensure log panel has ≥ 1 entry
2. Click **Clear**

**Expected:** Log area is empty; count shows 0; log file on server is unaffected

---

### TC-LOG-013: Download exports filtered log

**SRS:** FR-LOG-013  
**Steps:**
1. Set Show Levels to ERROR only
2. Click **↓ Download**

**Expected:** `.txt` file downloaded containing only ERROR-level lines; filename matches pattern `lts-logs-server-*`

---

### TC-LOG-014: Ingest Daemon source — polling

**SRS:** FR-LOG-004, FR-LOG-008  
**Precondition:** Server running with ingest-daemon; log file exists; server mode = combined/streaming  
**Steps:**
1. Switch source to `Ingest Daemon`

**Expected:** `[Ingest]` tagged log lines appear; display updates every ~2 s

---

### TC-LOG-015: Ingest Daemon tab hidden in analysis mode

**SRS:** FR-LOG-014  
**Precondition:** Server running in `analysis` mode  
**Steps:**
1. Open Server Logs panel

**Expected:** Source tabs show only `Server`, `MediaMTX`, and `ORT CUDA Build`; `Ingest Daemon` tab is absent

---

### TC-LOG-016: Auto-scroll enabled by default

**SRS:** FR-LOG-010  
**Steps:**
1. Open Server Logs panel
2. Generate 30+ log entries rapidly

**Expected:** Log panel scrolls to show latest entries automatically

---

### TC-LOG-017: Auto-scroll disables on manual scroll-up

**SRS:** FR-LOG-010  
**Steps:**
1. Scroll up 100 px in the log area while new entries arrive

**Expected:** Auto-scroll indicator changes to inactive; log stays at scrolled position

---

### TC-LOG-018: Auto-scroll re-enables on button click

**SRS:** FR-LOG-010  
**Steps:**
1. Scroll up (disabling auto-scroll)
2. Click **↓ Auto-scroll**

**Expected:** View scrolls to bottom; auto-scroll resumes

---

### TC-LOG-019: Socket disconnect indicator

**Precondition:** Admin on Server Logs panel  
**Steps:**
1. Stop the LTS server
2. Observe connection indicator

**Expected:** Indicator turns gray; status text shows "Disconnected"

---

### TC-LOG-020: Log file not found returns empty list

**SRS:** FR-LOG-004  
**Precondition:** Log file for today does not exist  
**Steps:**
1. Switch to `Ingest Daemon` source

**Expected:** Empty state message shown; no error toast; `GET /admin/logs/recent?source=ingest` returns `{ logs: [], total: 0 }`

---

### TC-LOG-021: Toolbar remains visible during active auto-scroll

**SRS:** FR-LOG-015  
**Precondition:** Admin on Server Logs panel, auto-scroll enabled, server generating logs continuously  
**Steps:**
1. Observe the panel while log entries appear automatically
2. Do NOT interact with the panel

**Expected:** Toolbar (source selector, level controls, action buttons), search bar, and stats row remain fully visible at all times — they do NOT scroll out of view as new entries arrive

---

### TC-LOG-022: Auto-scroll re-enables on scroll-to-bottom

**SRS:** FR-LOG-010  
**Steps:**
1. Scroll up in the log area (auto-scroll should disable)
2. Manually scroll all the way back to the bottom

**Expected:** Auto-scroll automatically re-enables (↓ Auto-scroll button turns blue); no button click required

---

### TC-LOG-023: Search bar is always visible

**SRS:** FR-LOG-015, FR-LOG-016  
**Steps:**
1. Open Server Logs panel
2. Verify search bar is visible between the toolbar and stats row
3. Scroll up and down in the log area

**Expected:** Search bar remains fixed and visible; only log rows scroll

---

### TC-LOG-024: Search filters by keyword (case-insensitive)

**SRS:** FR-LOG-016  
**Precondition:** Log panel has ≥ 10 entries  
**Steps:**
1. Type a keyword that appears in some (but not all) log messages (e.g., `camera`)
2. Observe the log list and match count

**Expected:** Log list immediately shows only entries whose message or timestamp contains the keyword (case-insensitive); match count updates; all visible entries have the keyword highlighted in yellow

---

### TC-LOG-025: Search — no matches shows empty state

**SRS:** FR-LOG-016  
**Steps:**
1. Type a string guaranteed not to appear in any log (e.g., `xyzzy9999`)

**Expected:** Log area shows empty state message `No matches for "xyzzy9999"` (not the generic "No log entries" message)

---

### TC-LOG-026: Search clear button resets filter

**SRS:** FR-LOG-016  
**Precondition:** A search query is active and filtering the log list  
**Steps:**
1. Click the ✕ button inside the search bar

**Expected:** Search query clears; all level-filtered entries reappear; match count and `🔍 filtered` tag disappear

---

### TC-LOG-027: Search highlight — multiple occurrences per line

**SRS:** FR-LOG-016  
**Steps:**
1. Search for a very short common substring (e.g., `a`) that appears multiple times in a single log message
2. Observe a log row that contains multiple occurrences

**Expected:** All occurrences of the substring within that row's message are highlighted (recursive highlight)

---

### TC-LOG-028: Download respects active search filter

**SRS:** FR-LOG-016  
**Steps:**
1. Enter a search query that reduces visible logs (e.g., `error`)
2. Click **↓ Download**
3. Open the downloaded file

**Expected:** Downloaded file contains only entries that matched the search query — not the full log buffer

---

### TC-LOG-029: Max Lines dropdown is present in toolbar

**SRS:** FR-LOG-017  
**Precondition:** Admin Dashboard → Server Logs section open  
**Steps:**
1. Observe the toolbar

**Expected:** A "Max Lines" dropdown is visible in the toolbar; available options are 100, 200, 500, 1000, 2000; default value is 500

---

### TC-LOG-030: Changing Max Lines immediately trims display

**SRS:** FR-LOG-017  
**Precondition:** 300 log entries visible; Max Lines = 500  
**Steps:**
1. Change Max Lines dropdown to 100

**Expected:** Display immediately shows only the newest 100 entries; entry count in stats row shows 100 / 100 (or fewer if less than 100 were visible)

---

### TC-LOG-031: Incoming entries respect new Max Lines cap

**SRS:** FR-LOG-017  
**Precondition:** Max Lines = 100; source = server; real-time updates active  
**Steps:**
1. Let 120 entries accumulate via real-time stream

**Expected:** Display never exceeds 100 entries; oldest entries are dropped as new ones arrive

---

### TC-LOG-032: Max Lines persisted in localStorage

**SRS:** FR-LOG-017  
**Steps:**
1. Change Max Lines to 200
2. Reload the page
3. Navigate back to Admin Dashboard → Server Logs

**Expected:** Max Lines dropdown shows 200 (restored from localStorage)

---

### TC-LOG-033: Max Lines reset to 500 for unknown saved value

**SRS:** FR-LOG-017  
**Steps:**
1. Manually set `localStorage.setItem('lts_admin_log_maxLines', '999')` in browser console
2. Reload the page
3. Navigate to Server Logs

**Expected:** Max Lines dropdown shows 500 (fallback to default — 999 is not a valid option)

---

### TC-LOG-034: Increasing Max Lines backfills history immediately (not just via live stream)

**SRS:** FR-LOG-017  
**Precondition:** Source = Server; ≥1000 entries exist in the server ring buffer (generate via repeated API calls if needed); Max Lines = 100  
**Steps:**
1. Confirm the panel shows 100 lines
2. Change Max Lines to 1000
3. Observe the panel within ~1 s (one fetch round-trip), without waiting for any new log activity

**Expected:** The panel backfills to show 1000 lines (via a `GET /admin/logs/recent?limit=1000` re-fetch), not just whatever accumulates from new live entries. Regression case for the 2026-07-02 defect where the fetch always requested a fixed 200 entries regardless of Max Lines.

---

### TC-LOG-035: Real-time stream honors a Max Lines change made while streaming (no reload required)

**SRS:** FR-LOG-017  
**Precondition:** Source = Server; real-time updates active; Max Lines = 100  
**Steps:**
1. Let the display reach 100 lines via live streaming
2. Change Max Lines to 2000 **without switching source and without reloading the page**
3. Trigger enough server activity to produce >100 new log lines while watching the panel

**Expected:** The display grows past 100 toward 2000 as new entries arrive (i.e. the new cap of 2000 is honored on the very next incoming entry). Regression case for the stale-closure bug where `useEffect(..., [socket])` captured `maxLines` only once at mount, so changing the dropdown had no effect on an already-active real-time stream until an unrelated `source` change or full page reload.

---

### TC-LOG-036: `GET /admin/logs/recent` honors `limit` values above the old 500 ceiling

**SRS:** FR-LOG-017  
**Steps:**
1. `GET /admin/logs/recent?source=server&limit=1500`
2. `GET /admin/logs/recent?source=server&limit=2000`
3. `GET /admin/logs/recent?source=server&limit=999999`

**Expected:** Requests 1–2 are honored up to the requested `limit` (bounded only by how many entries actually exist in the buffer, capacity 2000) — response is no longer silently truncated to 500. Request 3 is clamped to 2000 (upper bound), not passed through unbounded and not clamped to the old 500 value. Automated coverage: `TC-LOG-A-009`/`TC-LOG-A-010` in `test/api/admin_log_viewer.test.js`.

---

### TC-LOG-037: `source=build` tab shows ORT CUDA build log

**SRS:** FR-LOG-004, FR-LOG-008  
**Precondition:** Log file for today exists  
**Steps:**
1. Switch source to `ORT CUDA Build`

**Expected:** `[OrtBuild]` tagged log lines appear (if any were relayed today); display updates every ~2 s, same polling behavior as `Ingest Daemon`/`MediaMTX`. Automated coverage: `TC-LOG-A-011`.

---

### TC-LOG-038: `POST /api/internal/build-log` accepts a batch of lines from the ORT CUDA build script

**SRS:** FR-LOG-004  
**Precondition:** LTS server running (any mode) on the same machine as the build  
**Steps:**
1. `POST /api/internal/build-log` with body `{ lines: ["...", "..."] }` from `server/src/scripts/buildOrtWithCuda.js` (default behavior; disable with `--no-report`)

**Expected:** `200` response; each line is level-detected (ERROR/WARNING/DEBUG/INFO keyword rules, same as `[Ingest]`/`[MediaMTX]`), tagged `[OrtBuild]`, and written to the daily log file — readable via `GET /admin/logs/recent?source=build`. Automated coverage: `TC-LOG-D-001`, `TC-LOG-D-002`.

---

### TC-LOG-039: `POST /api/internal/build-log` rejects non-loopback callers

**SRS:** FR-LOG-004  
**Steps:**
1. Call `POST /api/internal/build-log` from a non-localhost source address

**Expected:** `403` response — the build-log relay is loopback-only, matching the existing `/api/internal/ingest/reregister` guard pattern, since the build always runs on the same host as the server it reports to.

---

### TC-LOG-040: `POST /api/internal/build-log` rejects an empty body

**SRS:** FR-LOG-004  
**Steps:**
1. `POST /api/internal/build-log` with body `{}` (no `line` or `lines`)

**Expected:** `400` response. Automated coverage: `TC-LOG-D-003`.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-29 | 초기 작성 |
| 1.1 | 2026-06-30 | TC-LOG-021~028 추가 (고정 툴바 + 텍스트 검색) |
| 1.2 | 2026-06-30 | TC-LOG-029~033 추가 (Max Lines 설정) |
| 1.3 | 2026-07-02 | TC-LOG-004 buffer 500→2000 갱신, TC-LOG-034~036 추가 (Max Lines 증가 시 backfill, 실시간 스트림 stale closure 회귀 테스트, 서버 limit 상한 회귀 테스트) — "표시 lines ≠ Max Lines" 버그 수정 검증 |
| 1.4 | 2026-07-14 | TC-LOG-037~040 추가 — `POST /api/internal/build-log` (ORT CUDA 소스 빌드 로그 원격 릴레이, `source=build` 탭) |
