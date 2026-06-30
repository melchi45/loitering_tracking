# TC — Admin Log Viewer

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Real-Time Server Log Viewer  
**Version:** 1.0  
**Date:** 2026-06-29  
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

**Expected:** Panel loads with the last 500 (or fewer) entries immediately on open

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

**Expected:** Source tabs show only `Server` and `MediaMTX`; `Ingest Daemon` tab is absent

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

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-29 | 초기 작성 |
