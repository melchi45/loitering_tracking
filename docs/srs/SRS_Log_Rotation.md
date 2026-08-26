# SRS — Log Storage Path & Rotation

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Admin-Configurable Log Storage Path, Size-Based Rotation, Count-Based Retention
**Version:** 1.0
**Date:** 2026-08-26

---

## 1. Scope

Applies to production log writing (`npm run start|streaming|analysis`, all `SERVER_MODE` values) and its Admin Dashboard configuration surface. Does not apply to `npm run dev*` (logger is not loaded there).

---

## 2. Functional Requirements

| ID | Requirement |
|---|---|
| FR-LR-001 | The system SHALL persist log directory, max file size (MB), and max retained file count in the `settings` table (row id `logConfig`), surviving restarts. |
| FR-LR-002 | On first boot with no persisted `logConfig` row, the system SHALL seed it from `server/.env` (`LOG_DIR`, `LOG_MAX_FILE_SIZE_MB`, `LOG_MAX_FILES`), defaulting to `/var/log/lts` / 50 / 10 respectively when those env vars are absent. |
| FR-LR-003 | `GET /admin/system/logs` SHALL return the current config, effective directory, fallback status, IPC availability, the active file (name + size), and the list of archived files (name, size, mtime) sorted newest-first, plus total count/bytes. |
| FR-LR-004 | `PUT /admin/system/logs` SHALL accept a partial body (`dir?`, `maxFileSizeMB?`, `maxFiles?`), validate each provided field, persist the merged config, and apply it to the live log writer when running under `startServer.js`. |
| FR-LR-005 | `dir` validation SHALL attempt to create the directory (recursive) and perform a write+delete probe; on failure the endpoint SHALL return HTTP 400 with a descriptive error and MUST NOT persist the change. |
| FR-LR-006 | `maxFileSizeMB` SHALL be validated as a number in [1, 10240]; `maxFiles` SHALL be validated as a number in [1, 1000]. Out-of-range or non-numeric values SHALL return HTTP 400. |
| FR-LR-007 | When the active log file's size reaches `maxFileSizeMB * 1024 * 1024` bytes, the system SHALL rename it to an archive filename and open a fresh active file at the original path, without dropping or corrupting any previously written lines. |
| FR-LR-008 | After any rotation (size-triggered or the existing midnight day-rollover), the system SHALL delete the oldest archived files (by filesystem mtime) until the archived file count is at most `maxFiles`. The active file SHALL never be considered for deletion. |
| FR-LR-009 | `POST /admin/system/logs/rotate` SHALL trigger an immediate rotation regardless of current file size, when running under `startServer.js`; when not (e.g. `npm run dev*`), it SHALL return HTTP 501 with a message explaining rotation requires the production supervisor process. |
| FR-LR-010 | All three endpoints SHALL be reachable only by authenticated users with the `admin` role, consistent with all other `/admin/*` routes. |
| FR-LR-011 | Configuration changes made via `PUT /admin/system/logs` and manual rotations via `POST /admin/system/logs/rotate` SHALL be recorded in the audit log (`AuditService`) with actor id and the applied change. |
| FR-LR-012 | On every server boot (`index.js`, all `SERVER_MODE` values), the system SHALL restore the persisted `logConfig` into the process's own logger state and, when an IPC channel to a supervisor process exists, forward it so the supervisor's log writer reflects the persisted configuration without requiring a manual admin action. |

---

## 3. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-LR-001 | Rotation and cleanup MUST be safe under a burst of near-simultaneous log writes — concurrent rotations MUST NOT silently overwrite one archive with another (unique archive filenames) nor attempt to rename a file that does not yet exist on disk (synchronous file creation before any rotation can be triggered). |
| NFR-LR-002 | Log directory changes MUST NOT lose in-flight log lines — any content already handed to the previous file's OS-level file descriptor MUST still land in that (possibly since-renamed) file. |
| NFR-LR-003 | The Admin UI SHALL clearly indicate when running in a mode where changes are persisted but not live (`ipcAvailable: false`), so operators are not misled into thinking a dev-mode test validated production behavior. |
| NFR-LR-004 | Directory-writability validation SHALL happen synchronously within the `PUT` request/response cycle (no async job/polling required to learn whether a path is valid). |

---

## 4. Interface Requirements

- REST: `GET/PUT /admin/system/logs`, `POST /admin/system/logs/rotate` (see `CLAUDE.md` API table, `docs/design/Design_Log_Rotation.md` §4 for request/response shapes).
- IPC: `startServer.js` child process message types `lts:logConfig` (payload: `{ dir, maxFileSizeMB, maxFiles }`) and `lts:logRotate` (no payload).
- Persistence: `settings` table row `{ id: 'logConfig', dir, maxFileSizeMB, maxFiles }`.

---

## 5. Traceability

| Requirement | Source |
|---|---|
| FR-LR-001–002, FR-LR-012 | US-01/02/03 in `PRD_Log_Rotation.md`, pattern from `Design_AI_Model_Catalog.md` (activeModelConfig persistence) |
| FR-LR-003–004 | US-04, US-06, US-07 |
| FR-LR-005–006 | US-06 |
| FR-LR-007–008 | US-02, US-03 |
| FR-LR-009 | US-05 |
| FR-LR-010–011 | Existing `/admin/*` security baseline (`CLAUDE.md` 보안 규칙) |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-08-26 | 초기 작성 |
