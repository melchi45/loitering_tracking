# TC — Log Storage Path & Rotation

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Admin-Configurable Log Storage Path, Size-Based Rotation, Count-Based Retention
**Version:** 1.0
**Date:** 2026-08-26
**SRS Reference:** SRS_Log_Rotation.md

> Manual test cases. Not currently wired into `TcRunnerService`/`tc_runner_cli.js` `SUITES` — see `Design_Log_Rotation.md` §8 for why.

---

## Test Cases

### TC-LR-001: Initial config reflects env seed on first boot

**SRS:** FR-LR-002
**Precondition:** No `logConfig` row in `settings` table; `server/.env` has default `LOG_DIR`/`LOG_MAX_FILE_SIZE_MB`/`LOG_MAX_FILES`
**Steps:**
1. Start server (`npm run start`) fresh
2. `GET /admin/system/logs`

**Expected:** `config.dir`/`maxFileSizeMB`/`maxFiles` match the env values (or defaults 50/10 if env vars absent)

---

### TC-LR-002: Non-admin cannot access log rotation endpoints

**SRS:** FR-LR-010
**Steps:**
1. Log in as non-admin (viewer/operator)
2. `GET /admin/system/logs`, `PUT /admin/system/logs`, `POST /admin/system/logs/rotate`

**Expected:** `401`/`403` for all three; no config change

---

### TC-LR-003: Change directory to a writable path

**SRS:** FR-LR-004, FR-LR-005
**Steps:**
1. `PUT /admin/system/logs` with `{ dir: "/tmp/lts-test-logs" }`
2. `GET /admin/system/logs`

**Expected:** 200; `config.dir` updated; `effectiveDir` matches; `fallbackActive: false`; a new active log file appears under the new path within a few seconds (production mode)

---

### TC-LR-004: Reject an unwritable directory

**SRS:** FR-LR-005
**Steps:**
1. `PUT /admin/system/logs` with `{ dir: "/root/no-permission" }` (or any path the server process can't write to)

**Expected:** `400` with a descriptive error; `GET /admin/system/logs` afterwards shows the PREVIOUS `dir`, unchanged

---

### TC-LR-005: Reject out-of-range maxFileSizeMB / maxFiles

**SRS:** FR-LR-006
**Steps:**
1. `PUT` with `{ maxFileSizeMB: 0 }` → expect 400
2. `PUT` with `{ maxFileSizeMB: 99999 }` → expect 400
3. `PUT` with `{ maxFiles: 0 }` → expect 400
4. `PUT` with `{ maxFiles: 5000 }` → expect 400

**Expected:** All four rejected with 400; config unchanged after each

---

### TC-LR-006: Size-triggered rotation produces an archive file

**SRS:** FR-LR-007
**Precondition:** Production mode (`npm run start`); `maxFileSizeMB` set low (e.g. 1)
**Steps:**
1. `PUT /admin/system/logs` with `{ maxFileSizeMB: 1 }`
2. Generate enough log volume to exceed 1 MB (e.g. reconnect a camera repeatedly, or wait for normal traffic)
3. `GET /admin/system/logs`

**Expected:** A new file `lts-YYYY-MM-DD_HHmmssSSS-N.log` appears in `files[]`; `currentFile` is a fresh, small active file; no log lines lost across the boundary (spot-check the tail of the archive + head of the new active file for continuity)

---

### TC-LR-007: Manual "Rotate Now" trigger

**SRS:** FR-LR-009
**Precondition:** Production mode
**Steps:**
1. `POST /admin/system/logs/rotate`
2. `GET /admin/system/logs` a few seconds later

**Expected:** 200 immediately; a new archive file appears regardless of current file size

---

### TC-LR-008: Rotate endpoint under dev mode

**SRS:** FR-LR-009
**Precondition:** `npm run dev` (no supervisor/IPC)
**Steps:**
1. `POST /admin/system/logs/rotate`

**Expected:** `501` with a message indicating rotation requires the production supervisor process; no crash

---

### TC-LR-009: Count-based retention deletes the oldest archive

**SRS:** FR-LR-008
**Precondition:** Production mode; `maxFiles` set to 2
**Steps:**
1. `PUT` `{ maxFiles: 2 }`
2. Trigger 4 manual rotations via `POST .../rotate` (with short delays so mtimes differ)
3. `GET /admin/system/logs`

**Expected:** `files.length === 2`; the two most recently rotated archives remain; the two oldest were deleted; the active file was never deleted

---

### TC-LR-010: Config persists across restart

**SRS:** FR-LR-001, FR-LR-012
**Steps:**
1. `PUT` a non-default `dir`/`maxFileSizeMB`/`maxFiles`
2. Restart the server (`npm run stop` then `npm run start`)
3. `GET /admin/system/logs`

**Expected:** Config matches what was set before restart, not the `server/.env` defaults

---

### TC-LR-011: Dev-mode save without live effect

**SRS:** NFR-LR-003
**Precondition:** `npm run dev`
**Steps:**
1. `PUT` a new `maxFileSizeMB`
2. `GET /admin/system/logs`

**Expected:** `ipcAvailable: false`; config value reflects the new setting (persisted) even though no log file exists to rotate

---

### TC-LR-012: Feature parity across SERVER_MODE

**SRS:** Scope (§1)
**Steps:**
1. Repeat TC-LR-003 and TC-LR-006 with `SERVER_MODE=combined`
2. Repeat with `SERVER_MODE=streaming`
3. Repeat with `SERVER_MODE=analysis`

**Expected:** Identical behavior in all three modes — no mode-specific branching exists in this feature's code path

---

### TC-LR-013: Two server instances sharing one MongoDB get independent settings (v1.1)

**SRS:** FR-LR-013, NFR-LR-005
**Precondition:** `DB_TYPE=mongodb`, same `MONGODB_URI` on two server processes (or the same process restarted twice with a different `SERVER_ID`)
**Steps:**
1. Start server A with `SERVER_ID=host-a`, `PUT /admin/system/logs { dir: "/data/logs/a" }`
2. Start server B against the same MongoDB with `SERVER_ID=host-b`, `PUT /admin/system/logs { dir: "/data/logs/b" }`
3. `GET /admin/system/logs` on server A
4. `GET /admin/system/logs` on server B
5. Inspect the `settings` collection directly

**Expected:** Server A's `GET` still reports `dir: "/data/logs/a"` (unaffected by step 2); server B reports `/data/logs/b`; both responses include `serverId` matching their own `SERVER_ID`; the `settings` collection contains two distinct rows (`logConfig:host-a`, `logConfig:host-b`), not one shared `logConfig` row

---

### TC-LR-014: Upgrade migrates the legacy global row (v1.1)

**SRS:** FR-LR-014
**Precondition:** A `settings` row with `id: 'logConfig'` already exists (simulating a pre-v1.1 deployment), and no `logConfig:<serverId>` row exists yet
**Steps:**
1. Seed the DB directly with `{ id: 'logConfig', dir: '/legacy/path', maxFileSizeMB: 80, maxFiles: 5 }`
2. Start the server (no per-instance row exists yet)
3. `GET /admin/system/logs`
4. Inspect the `settings` collection/table

**Expected:** The response reflects the legacy values (`dir: '/legacy/path'`, etc.), not the `server/.env` defaults; a new `logConfig:<serverId>` row now exists with those values; the original `logConfig` row still exists (not deleted)

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-08-26 | 초기 작성 |
| 1.1 | 2026-08-27 | TC-LR-013/014 추가 — 서버 인스턴스별 설정 분리 및 레거시 row 마이그레이션 검증 |
