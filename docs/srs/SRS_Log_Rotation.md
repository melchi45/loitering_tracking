# SRS — Log Storage Path & Rotation

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Admin-Configurable Log Storage Path, Size-Based Rotation, Count-Based Retention
**Version:** 1.3
**Date:** 2026-08-27

---

## 1. Scope

Applies to production log writing (`npm run start|streaming|analysis`, all `SERVER_MODE` values) and its Admin Dashboard configuration surface. Does not apply to `npm run dev*` (logger is not loaded there).

---

## 2. Functional Requirements

| ID | Requirement |
|---|---|
| FR-LR-001 | The system SHALL persist log directory, max file size (MB), and max retained file count in the `settings` table under a **per-server-instance** row id `` `logConfig:${SERVER_ID or os.hostname()}` `` (v1.1 — see FR-LR-013), surviving restarts. |
| FR-LR-002 | On first boot with no persisted `logConfig` row, the system SHALL seed it from `server/.env` (`LOG_DIR`, `LOG_MAX_FILE_SIZE_MB`, `LOG_MAX_FILES`), defaulting to 50 / 10 for the latter two when absent, and to the platform-appropriate directory per FR-LR-016 for `dir`. |
| FR-LR-003 | `GET /admin/system/logs` SHALL return the current config, effective directory, fallback status, IPC availability, the active file (name + size), and the list of archived files (name, size, mtime) sorted newest-first, plus total count/bytes. The active-file and archived-file data SHALL reflect the real contents of the effective directory regardless of whether the responding process itself holds the live write handle (v1.3, FR-LR-017). |
| FR-LR-004 | `PUT /admin/system/logs` SHALL accept a partial body (`dir?`, `maxFileSizeMB?`, `maxFiles?`), validate each provided field, persist the merged config, and apply it to the live log writer when running under `startServer.js`. |
| FR-LR-005 | `dir` validation SHALL attempt to create the directory (recursive) and perform a write+delete probe; on failure the endpoint SHALL return HTTP 400 with a descriptive error and MUST NOT persist the change. |
| FR-LR-006 | `maxFileSizeMB` SHALL be validated as a number in [1, 10240]; `maxFiles` SHALL be validated as a number in [1, 1000]. Out-of-range or non-numeric values SHALL return HTTP 400. |
| FR-LR-007 | When the active log file's size reaches `maxFileSizeMB * 1024 * 1024` bytes, the system SHALL rename it to an archive filename and open a fresh active file at the original path, without dropping or corrupting any previously written lines. |
| FR-LR-008 | After any rotation (size-triggered or the existing midnight day-rollover), the system SHALL delete the oldest archived files (by filesystem mtime) until the archived file count is at most `maxFiles`. The active file SHALL never be considered for deletion. |
| FR-LR-009 | `POST /admin/system/logs/rotate` SHALL trigger an immediate rotation regardless of current file size, when running under `startServer.js`; when not (e.g. `npm run dev*`), it SHALL return HTTP 501 with a message explaining rotation requires the production supervisor process. |
| FR-LR-010 | All three endpoints SHALL be reachable only by authenticated users with the `admin` role, consistent with all other `/admin/*` routes. |
| FR-LR-011 | Configuration changes made via `PUT /admin/system/logs` and manual rotations via `POST /admin/system/logs/rotate` SHALL be recorded in the audit log (`AuditService`) with actor id and the applied change. |
| FR-LR-012 | On every server boot (`index.js`, all `SERVER_MODE` values), the system SHALL restore the persisted `logConfig` into the process's own logger state and, when an IPC channel to a supervisor process exists, forward it so the supervisor's log writer reflects the persisted configuration without requiring a manual admin action. |
| FR-LR-013 | (v1.1) The system SHALL derive the `settings` row id for log configuration as `` `logConfig:${SERVER_ID}` `` if the `SERVER_ID` env var is set, else `` `logConfig:${os.hostname()}` ``, so that multiple server instances sharing one `DB_TYPE=mongodb` database each persist independent log settings. |
| FR-LR-014 | (v1.1) On first read of the per-instance row (FR-LR-013) when it does not yet exist, if a legacy row with id `logConfig` exists (from a pre-v1.1 deployment), the system SHALL seed the new per-instance row from it instead of from `server/.env`, so upgrading does not silently discard an operator's prior configuration. The legacy row MUST NOT be deleted by this migration. |
| FR-LR-015 | (v1.1) `GET /admin/system/logs` SHALL include a `serverId` field (the value resolved per FR-LR-013) in its response, so the Admin UI can indicate which server instance's configuration is being displayed. |
| FR-LR-016 | (v1.2) The default log directory used to seed `dir` (FR-LR-002) SHALL be resolved as: `LOG_DIR_WINDOWS` if set and `process.platform === 'win32'`; else `LOG_DIR_LINUX` if set and not Windows; else the general `LOG_DIR` if set; else `C:\ProgramData\lts\logs` on Windows or `/var/log/lts` otherwise. This mirrors the OS-specific-wins-over-general precedence already used by `YTDLP_BIN_WINDOWS`/`_LINUX` etc. elsewhere in this project. |
| FR-LR-017 | (v1.3) `getLogStats()` (backing FR-LR-003) SHALL determine the active-file and archived-files data by scanning the effective directory directly, and MUST NOT depend on whether the responding process has itself called `openLogFile()` — the file list and active-file size MUST be accurate even on a process (e.g. the Admin API child) that has never itself opened a log file handle. |

---

## 3. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-LR-001 | Rotation and cleanup MUST be safe under a burst of near-simultaneous log writes — concurrent rotations MUST NOT silently overwrite one archive with another (unique archive filenames) nor attempt to rename a file that does not yet exist on disk (synchronous file creation before any rotation can be triggered). |
| NFR-LR-002 | Log directory changes MUST NOT lose in-flight log lines — any content already handed to the previous file's OS-level file descriptor MUST still land in that (possibly since-renamed) file. |
| NFR-LR-003 | The Admin UI SHALL clearly indicate when running in a mode where changes are persisted but not live (`ipcAvailable: false`), so operators are not misled into thinking a dev-mode test validated production behavior. |
| NFR-LR-004 | Directory-writability validation SHALL happen synchronously within the `PUT` request/response cycle (no async job/polling required to learn whether a path is valid). |
| NFR-LR-005 | (v1.1) When multiple server instances share one `DB_TYPE=mongodb` database, a `PUT /admin/system/logs` on one instance MUST NOT alter another instance's persisted or in-memory log configuration. |

---

## 4. Interface Requirements

- REST: `GET/PUT /admin/system/logs`, `POST /admin/system/logs/rotate` (see `CLAUDE.md` API table, `docs/design/Design_Log_Rotation.md` §4 for request/response shapes).
- IPC: `startServer.js` child process message types `lts:logConfig` (payload: `{ dir, maxFileSizeMB, maxFiles }`) and `lts:logRotate` (no payload).
- Persistence: `settings` table row `{ id: 'logConfig:<SERVER_ID or hostname>', dir, maxFileSizeMB, maxFiles }` (v1.1 — was a fixed `id: 'logConfig'` in v1.0).

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
| FR-LR-013–015, NFR-LR-005 | Post-ship gap found 2026-08-27: shared-`DB_TYPE=mongodb` deployments would let one server's log-path change overwrite another's — same bug class as the 2026-07-15 `faceSearchConditions` shared-MongoDB incident (`Design_Face_Search_Condition_Sync.md`) |
| FR-LR-016 | Post-ship gap found 2026-08-27: `LOG_DIR` default was Linux-only (`/var/log/lts`), unlike every other path-like env var in this project which has `_WINDOWS`/`_LINUX` variants |
| FR-LR-017 | Real production bug reported 2026-08-27 (both streaming and analysis instances) — Admin Dashboard showed no active file/archived files despite real log content; reproduced in an isolated sandbox and root-caused to child-process-local `_logDir`/`_logPath` state |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-08-26 | 초기 작성 |
| 1.1 | 2026-08-27 | FR-LR-001 수정 + FR-LR-013~015, NFR-LR-005 추가 — 서버 인스턴스별 설정 분리(SERVER_ID/hostname), 레거시 row 마이그레이션, `serverId` 응답 필드 |
| 1.2 | 2026-08-27 | FR-LR-002 수정 + FR-LR-016 추가 — `LOG_DIR` 기본값에 Windows 대응(`LOG_DIR_WINDOWS`/`LOG_DIR_LINUX`, Windows 기본값 `C:\ProgramData\lts\logs`) |
| 1.3 | 2026-08-27 | FR-LR-003 수정 + FR-LR-017 추가 — Admin Dashboard가 실제 로그 내용에도 불구하고 빈 상태로 보이던 실사용 버그 수정, `getLogStats()`가 프로세스 로컬 상태 대신 실제 디렉토리를 스캔하도록 변경 |
