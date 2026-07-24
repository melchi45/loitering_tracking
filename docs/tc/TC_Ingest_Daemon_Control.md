# TC — Ingest Daemon Control

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Admin Dashboard Ingest Daemon Start/Stop/Restart Control  
**Version:** 1.0  
**Date:** 2026-07-23  
**SRS Reference:** SRS_Ingest_Daemon_Control.md

---

## Test Cases

### TC-IDC-001: Non-admin cannot call ingest control endpoints

**SRS:** FR-IDC-008  
**Precondition:** `CAPTURE_BACKEND=ingest-daemon`; logged in as a non-admin (viewer/operator) user  
**Steps:**
1. `POST /admin/ingest/start` with a non-admin JWT
2. `POST /admin/ingest/stop` with a non-admin JWT
3. `POST /admin/ingest/restart` with a non-admin JWT

**Expected:** All three return `401` or `403`; the daemon process is not affected

---

### TC-IDC-002: Endpoints disabled when CAPTURE_BACKEND != ingest-daemon

**SRS:** FR-IDC-007  
**Precondition:** `CAPTURE_BACKEND=ffmpeg` (or `gstreamer`/`pyav`); logged in as admin  
**Steps:**
1. `POST /admin/ingest/start`

**Expected:** `501` with an error message mentioning `ingest-daemon backend not active`

---

### TC-IDC-003: Start is a no-op when already running

**SRS:** FR-IDC-004  
**Precondition:** `CAPTURE_BACKEND=ingest-daemon`; daemon already running and healthy; admin JWT  
**Steps:**
1. Note current daemon PID (`ps aux | grep ingest_daemon.py`)
2. `POST /admin/ingest/start`

**Expected:** `200 { ok: true, alreadyRunning: true }`; PID unchanged; no kill/spawn occurred

---

### TC-IDC-004: Start spawns a fresh daemon when not running

**SRS:** FR-IDC-004  
**Precondition:** Daemon stopped (port free); admin JWT  
**Steps:**
1. `POST /admin/ingest/start`

**Expected:** `200 { ok: true, alreadyRunning: false, pid: <number>, cameras: {...} }`; `GET /api/ingest-status` reports `healthy: true` within 10s

---

### TC-IDC-005: Stop terminates a healthy daemon

**SRS:** FR-IDC-005  
**Precondition:** Daemon running and healthy; admin JWT  
**Steps:**
1. `POST /admin/ingest/stop`

**Expected:** `200 { ok: true, wasRunning: true }`; port is free immediately after; `GET /api/ingest-status` reports `healthy: false`

---

### TC-IDC-006: Stop is a no-op when not running

**SRS:** FR-IDC-005  
**Precondition:** Daemon already stopped; admin JWT  
**Steps:**
1. `POST /admin/ingest/stop`

**Expected:** `200 { ok: true, wasRunning: false }` — not an error

---

### TC-IDC-007: Stop terminates a zombie (HTTP-unresponsive) daemon

**SRS:** FR-IDC-002, FR-IDC-003, FR-IDC-005  
**Precondition:** Daemon process alive and bound to its port, but `/health` does not respond (simulate by SIGSTOP-ing the process, or unit-test with a mocked `checkHealth()` returning false while `isPortFree()` returns false)  
**Steps:**
1. `POST /admin/ingest/stop`

**Expected:** The port-occupancy check (not `/health`) determines `wasRunning: true`; kill sequence (SIGTERM-equivalent → 8s grace → SIGKILL-equivalent) executes; port is free by the time the response returns; response is `200 { ok: true, wasRunning: true }`

---

### TC-IDC-008: Restart recovers a wedged daemon and re-registers cameras

**SRS:** FR-IDC-006  
**Precondition:** 3+ cameras configured and previously registered; daemon in zombie state  
**Steps:**
1. `POST /admin/ingest/restart`

**Expected:** `200 { ok: true, pid: <number>, cameras: { <id>: { ok: true }, ... } }` for every active camera; all cameras show `streaming`/connected state within a few seconds afterward

---

### TC-IDC-009: Restart failure surfaces a clear error

**SRS:** FR-IDC-006  
**Precondition:** Daemon binary path misconfigured (e.g. `INGEST_DAEMON_BIN` points to a nonexistent file) — test env only  
**Steps:**
1. `POST /admin/ingest/restart`

**Expected:** `500 { ok: false, error: <message mentioning /health timeout or spawn failure> }`; no unhandled exception/crash in the main server process

---

### TC-IDC-010: Every action is audit-logged

**SRS:** FR-IDC-009  
**Precondition:** Admin JWT  
**Steps:**
1. Call each of `/admin/ingest/start`, `/stop`, `/restart` once
2. `GET /admin/audit`

**Expected:** Three new entries with `event` = `ingest_daemon_start`, `ingest_daemon_stop`, `ingest_daemon_restart` respectively, each with the correct `actorId` and a `detail` object matching the response

---

### TC-IDC-011: CLI scripts still work after the refactor

**SRS:** FR-IDC-001, FR-IDC-012  
**Steps:**
1. `cd server && npm run ingest:start -- --dry-run`
2. `cd server && npm run ingest:restart -- --dry-run`
3. `cd server && npm run ingest:start` (daemon already running)
4. `cd server && npm run ingest:stop`
5. `cd server && npm run ingest:restart`

**Expected:** `--dry-run` prints config and exits 0 without side effects; step 3 prints "이미 실행 중입니다" and exits 0; step 4 stops the daemon and exits 0; step 5 restarts and re-registers cameras, printing per-camera results — output format unchanged from before the refactor

---

### TC-IDC-012: Dashboard UI — confirmation prompts

**SRS:** FR-IDC-011  
**Precondition:** Admin logged into the Admin Dashboard, Ingest Daemon section, `CAPTURE_BACKEND=ingest-daemon`  
**Steps:**
1. Click **Stop**, then dismiss the confirmation dialog
2. Click **Restart**, then dismiss the confirmation dialog

**Expected:** No `POST` request is sent in either case; daemon state unchanged

---

### TC-IDC-013: Dashboard UI — button disabling while in flight

**SRS:** FR-IDC-011  
**Steps:**
1. Click **Restart** and confirm
2. While the request is pending, attempt to click **Start**, **Stop**, and **Restart** again

**Expected:** All three buttons are disabled (non-clickable) until the in-flight request resolves; the acting button shows "Restarting…" with a spinning icon

---

### TC-IDC-014: Dashboard UI — result display

**SRS:** FR-IDC-011  
**Steps:**
1. Click **Start** while the daemon is already running

**Expected:** Inline text reads "Already running" in green next to the buttons

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 |
