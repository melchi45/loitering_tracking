# PRD — Log Storage Path & Rotation

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Admin-Configurable Log Storage Path, Size-Based Rotation (Split), Count-Based Retention
**Version:** 1.0
**Date:** 2026-08-26

---

## 1. Overview

Production logging (`npm run start|streaming|analysis`) currently writes unbounded daily files to a directory fixed at process start via `LOG_DIR` (`server/.env`). There is no built-in rotation or cleanup — operators must maintain their own `cron` job to delete old files (`docs/ops/Logging_Guide.md`). This feature adds an **Admin Dashboard → System → Log Storage & Rotation** panel where an administrator can, without editing `.env` or restarting the server:

1. Change the log storage directory.
2. Set a maximum file size that triggers a split (crond/logrotate-style rotation).
3. Set a maximum number of retained rotated files, with automatic deletion of the oldest once exceeded.

Applies uniformly to all three `SERVER_MODE` values (`combined`, `streaming`, `analysis`).

---

## 2. User Stories

| ID | As a... | I want to... | So that... |
|---|---|---|---|
| US-01 | Admin | Change the log directory from the dashboard | I don't need shell access or a restart to relocate logs (e.g. to a larger disk) |
| US-02 | Admin | Set a max file size for automatic splitting | A single runaway day (verbose DEBUG burst, camera flapping) doesn't produce one unbounded file |
| US-03 | Admin | Set a max number of retained log files | Disk usage stays bounded without a separate cron job |
| US-04 | Admin | See the currently active file and archived files with sizes | I can verify the policy is working and gauge disk usage at a glance |
| US-05 | Admin | Manually trigger a rotation | I can validate the configuration works before trusting it unattended |
| US-06 | Admin | Get a clear error when a directory isn't writable | I don't silently lose logging or discover it only after an incident |
| US-07 | Admin | Know whether my changes take effect immediately | I'm not confused when testing under `npm run dev` (no live effect) vs. production |

---

## 3. Feature Specification

### 3.1 Settings

| Setting | Range | Default |
|---|---|---|
| Directory | any writable absolute/relative path | `/var/log/lts` (env `LOG_DIR` seeds first boot) |
| Max file size | 1–10240 MB | 50 MB (env `LOG_MAX_FILE_SIZE_MB`) |
| Max retained files | 1–1000 | 10 (env `LOG_MAX_FILES`) |

Settings persist in the `settings` table (row id `logConfig`) and survive restarts — env vars only seed the very first boot, mirroring how `activeModelConfig.js` persists AI Model Active selections (`docs/design/Design_AI_Model_Catalog.md`).

### 3.2 Rotation Behavior

- The active file is always the plain daily name `lts-YYYY-MM-DD.log`.
- When it reaches the configured max size, it's renamed to an archive name (`lts-YYYY-MM-DD_HHmmssSSS-N.log`) and a fresh active file opens immediately.
- The existing midnight day-rollover is unaffected — it still opens a new daily file — but now also triggers the same retention cleanup.
- Once archived file count exceeds the configured max, the oldest (by mtime) is deleted first. The active file is never a deletion candidate.

### 3.3 Production-Only Scope

The actual log file handle is owned by the `startServer.js` supervisor process, not the Express process where the Admin API runs (see `docs/design/Design_Log_Rotation.md` §2). Consequently:

- Under `npm run start|streaming|analysis`: changes apply live within ~1 request round-trip.
- Under `npm run dev*`: there is no supervisor process and `utils/logger.js` isn't even loaded, so settings save but have no live effect. The panel surfaces this via an `ipcAvailable: false` badge.

---

## 4. Out of Scope

- Automated TC-suite integration (`TcRunnerService`) — manual test cases only (`docs/tc/TC_Log_Rotation.md`), noted as future work.
- Compression of archived files (e.g. gzip) — not requested; may be considered later if disk usage remains a concern.
- Remote/off-host log shipping (ELK/Loki) — tracked separately under README.md ES-7 (Observability).

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-08-26 | 초기 작성 |
