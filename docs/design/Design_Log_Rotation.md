# Design — Log Storage Path & Rotation

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Admin-Configurable Log Storage Path, Size-Based Rotation (Split), Count-Based Retention
**Version:** 1.4
**Date:** 2026-08-27

---

## 1. Overview

Adds an Admin Dashboard → System panel that lets an administrator change the production log directory, the file-size threshold that triggers a split, and the max number of retained archive files — all without editing `server/.env` or restarting the server, and consistently across `combined`/`streaming`/`analysis` `SERVER_MODE`.

The one architectural wrinkle this feature has to solve: **the process that owns the actual log file handle is not the process that serves the Admin API.**

---

## 2. Why This Needs Cross-Process IPC

In production (`npm run start|streaming|analysis`), `server/src/scripts/startServer.js` is the **supervisor** process. It:

1. Calls `openLogFile()` + `patchConsole()` on itself — this is the process whose `console.log/warn/error` calls actually get timestamped and written to disk.
2. `spawn()`s the real Express server (`server/src/index.js`, where every `/admin/*` route including the Admin API lives) as a **child process**, piping the child's stdout/stderr back through `makeLineRelay()` into the same file.
3. Also spawns MediaMTX and ingest-daemon as siblings, relaying their output the same way.

So when an admin calls `PUT /admin/system/logs` from the browser, that request is handled entirely inside the **child** process. If the child only updated its own in-memory `utils/logger.js` state, the **parent's** copy of that module (a separate `require()` instance in a separate OS process) would never see the change — the actual file on disk would keep using the old directory/size threshold forever.

```
Admin Dashboard (browser)
   │  PUT /admin/system/logs { dir, maxFileSizeMB, maxFiles }
   ▼
index.js  (child process — Admin API, DB, all other routes)
   │  1. logConfigService.setLogConfig(patch)      → settings table (persists across restarts)
   │  2. logger.setLogConfig(patch)                → this process's OWN logger.js instance
   │                                                   (used for tailLogFile()/GET display only —
   │                                                   this process never calls openLogFile())
   │  3. process.send({ type:'lts:logConfig', payload }) ── IPC ──┐
   ▼                                                              │
 (HTTP response with fresh GET /admin/system/logs shape)          │
                                                                   ▼
                                            startServer.js  (parent/supervisor —
                                                              THE actual file writer)
                                              child.on('message', msg) →
                                                logger.setLogConfig(msg.payload)
                                                  → closes current stream if dir changed
                                                  → openLogFile() at new location
```

Both processes `require('../utils/logger')`, but Node module caching is per-process — they are two independent instances of the same module code with independent internal state (`_cfg`, `_logStream`, etc.). This is intentional and unavoidable given the existing supervisor/child split (`Design_Server_Architecture.md`); the fix is to keep both instances in sync via `process.send()`/`process.on('message')`, not to try to unify them.

### Why not just have the child write the log file directly?

Rejected — `startServer.js` already owns stdout/stderr interleaving from *four* sources (itself, MediaMTX, ingest-daemon, and the child server) into one file via `makeLineRelay()`. Splitting that responsibility would mean two processes writing to the same file concurrently (a correctness hazard) or maintaining two separate files that would need to be interleaved for anyone reading logs — strictly worse than the IPC bridge.

### Dev mode (`npm run dev*`)

No supervisor process exists at all — `devServer.js` never calls `openLogFile()`/`patchConsole()`, matching pre-existing behavior (see `utils/logger.js` header comment, unchanged by this feature). `process.send` is `undefined` in this mode, which the Admin API surfaces as `ipcAvailable: false` — settings still persist to the `settings` table, but there is no live file to rotate.

---

## 3. Config Persistence & Boot Restore

`server/src/services/logConfigService.js` — mirrors `activeModelConfig.js`'s lazy-init + upsert pattern against the `settings` table (row id `logConfig`):

```javascript
function getLogConfig()        { /* lazy-load row, seed from env on first boot */ }
function setLogConfig(partial) { /* merge + persist */ }
function restoreOnBoot()       {
  const cfg = getLogConfig();
  logger.setLogConfig(cfg);               // this process's own logger.js state
  if (process.send) process.send({ type: 'lts:logConfig', payload: cfg }); // → supervisor, if any
  return cfg;
}
```

`index.js` calls `restoreOnBoot()` immediately after DB initialization, before any routes are registered — this runs identically in `combined`/`streaming`/`analysis` since none of this code is `SERVER_MODE`-gated. This is the same "restore persisted setting on every boot" shape already used for AI Model Active selections (`Design_AI_Model_Catalog.md`), so an admin's configuration survives a full server restart without needing to re-apply it.

---

## 3A. Per-Instance Config Scoping (v1.1, 2026-08-27)

**Problem found post-ship:** §3's original design copied `activeModelConfig.js`'s pattern verbatim, including a **fixed** `settings` row id (`logConfig`). For `activeModelConfig.js` that's correct — which AI model a family should run is a value every server sharing a DB is *supposed* to agree on. `logConfig.dir` is the opposite kind of value: it names a path on **this process's own local filesystem**. When `DB_TYPE=json` (the default), each server already has its own local `storage/lts.json`, so the bug is latent. When `DB_TYPE=mongodb` and that MongoDB is intentionally shared across physically distinct servers (a supported, documented deployment shape — `docs/ops/Distributed_AI_Pipeline_Setup.md`), every server sharing it would fight over the same `dir`/`maxFileSizeMB`/`maxFiles` — whichever server's Admin Dashboard was touched last silently rewrites the path every other server's log writer thinks it's using. This is the same class of bug as the 2026-07-15 shared-MongoDB `faceSearchConditions` incident (`Design_Face_Search_Condition_Sync.md`) — a genuinely per-instance value stored under a globally-shared key.

**Fix:** the `settings` row id is now derived per server instance instead of a fixed string:

```javascript
// server/src/utils/serverId.js — the ONE place this is computed, so
// logConfigService.js and logger.js (getLogStats()) can never drift apart.
function getServerId() {
  return process.env.SERVER_ID || os.hostname();
}
```

- **Default:** `os.hostname()` — zero-config; correct for the common case of one server process per physical/virtual machine.
- **Override:** `SERVER_ID` env var — for the case where two `SERVER_MODE` instances (or two instances of the same mode) run on the *same* host and would otherwise collide on hostname (mirrors the disambiguation need `ingestDaemonPool.js`'s `INGEST_DAEMON_INSTANCES`/instance-index already solves for a different subsystem).
- **New settings row id:** `` `logConfig:${getServerId()}` `` instead of the fixed `logConfig`.

**Migration (one-time, transparent):** `_getOrInit()` in `logConfigService.js` now checks, in order: (1) does a row already exist under this instance's new id? Use it. (2) Does the pre-fix global row (`id: 'logConfig'`) exist — e.g. from a deployment that ran the v1.0 code before this fix shipped? If so, copy its values into this instance's new row (read-only adoption; the legacy row is left in place, not deleted, so any other instance that already keyed off it during the same migration window sees the same seed). (3) Otherwise seed from `server/.env` as before (§3). This means an operator who had already configured Log Rotation under the old global key does not lose that configuration on upgrade.

**Visibility:** `getLogStats()` (`utils/logger.js`) now includes `serverId` in its response so the Admin Dashboard panel can show *which* server's settings are being displayed/edited — important specifically because this used to be (incorrectly) one shared value; now that it's per-instance, an admin managing multiple servers needs to see which one they're looking at.

**Explicitly not addressed by this fix:** the separate Windows-default-path gap (`LOG_DIR`/`logConfigService.js`'s seed value hardcodes `/var/log/lts` with no `_WINDOWS`/`_LINUX` variant, unlike every other path-like env var in this project). Fixed separately in §3B (v1.2).

---

## 3B. Windows Default Path (v1.2, 2026-08-27)

**Problem:** the env-seed default for `LOG_DIR` was hardcoded to `/var/log/lts` in both `logger.js` and `logConfigService.js`, with no `_WINDOWS`/`_LINUX` variant — unlike every other path-like env var in this project (`YTDLP_BIN_WINDOWS`/`_LINUX`, `INGEST_DAEMON_BIN_WINDOWS`/`_LINUX`, `MEDIAMTX_BIN_WINDOWS`/`_LINUX`, `PYTHON_EXEC_WINDOWS`/`_LINUX`). On Windows this default is never a valid path, so a fresh Windows deployment always fails the writability probe on first boot and silently lands on the `server/logs/` fallback — not incorrect, but the "default" was Linux-only in a project that otherwise treats Windows as a first-class target.

**Fix:** a new resolver, `_resolveDefaultLogDir()` (added to `utils/logger.js`, the one place both call sites already import from), follows this project's established precedence for OS-specific path env vars — **OS-specific override wins over the general one** (matching `youtubeStreamService.js`'s `findYtDlp()`: `YTDLP_BIN_WINDOWS`/`_LINUX` checked before the general `YTDLP_BIN`):

```javascript
function _resolveDefaultLogDir() {
  const isWindows = process.platform === 'win32';
  const osOverride = isWindows ? process.env.LOG_DIR_WINDOWS : process.env.LOG_DIR_LINUX;
  if (osOverride) return osOverride;
  if (process.env.LOG_DIR) return process.env.LOG_DIR;
  return isWindows ? 'C:\\ProgramData\\lts\\logs' : '/var/log/lts';
}
```

- New env vars: `LOG_DIR_WINDOWS` (optional), `LOG_DIR_LINUX` (optional) — both empty by default in `.env.example`, matching the other `_WINDOWS`/`_LINUX` pairs.
- New built-in Windows default: `C:\ProgramData\lts\logs` (machine-wide app-data location, doesn't require `Program Files` write access) — used only when neither `LOG_DIR_WINDOWS` nor `LOG_DIR`(general) is set.
- `logConfigService.js`'s `_seedFromEnv()` now calls `logger._resolveDefaultLogDir()` instead of duplicating the `process.env.LOG_DIR || '/var/log/lts'` literal, so the two modules cannot drift apart again.
- The existing `FALLBACK_DIR` (`server/logs/`, built via `path.resolve()`) is unchanged and still the final safety net on either OS if the resolved primary directory turns out unwritable.
- Out of scope: this only fixes the *default* used when nothing is configured. An admin who explicitly sets `LOG_DIR`/`dir` (via `.env` or the Admin Dashboard) to a Windows path already worked before this fix — `_assertDirWritable()`'s real write-probe (`fs.mkdirSync`/`fs.writeFileSync`) was always OS-agnostic.

---

## 3C. Admin Dashboard Showing "No Active File" Despite Real Log Content (v1.3, 2026-08-27)

**Symptom (reported by user, both `streaming` and `analysis` instances):** editing the directory and clicking Save, or clicking "Rotate Now", had visibly no effect — "Active File" stayed `—` and "Archived Files" stayed `0`, even though the real supervisor process was actively writing a real, growing log file at the configured path.

**Root cause, reproduced in an isolated sandbox (real `startServer.js` + `index.js`, real IPC, `DB_TYPE=json` to avoid touching production Mongo):** `getLogStats()`'s file listing and "current file" detection were keyed off `_logDir`/`_logPath` — module-scope variables that are populated **only when THIS process has itself called `openLogFile()`**. For the Admin API (child/`index.js`) process, that only happens opportunistically inside `setLogConfig()`, when `dirChanged` (the new `dir` differs from this process's own already-in-memory `_cfg.dir`) happens to be true *during this process's lifetime*. Since the child's own `_cfg.dir` is seeded independently at module-load time via the same `_resolveDefaultLogDir()`/persisted-config restore path the supervisor uses, there is a real window — confirmed via direct reproduction — where the persisted/effective directory is correct and the supervisor is genuinely writing there, yet `dirChanged` never evaluates true on the child during its lifetime, so `_logDir`/`_logPath` stay empty on the child **forever**, and every `GET /admin/system/logs` from that child reports an empty file list regardless of reality. `POST .../rotate` only relays IPC to the supervisor and never touches the child's own state at all, so its real effect (the supervisor genuinely rotating) was similarly invisible on the dashboard.

**Fix:** `getLogStats()` now scans the *effective* directory (`_logDir || _cfg.dir` — the same fallback `effectiveDir` already used) regardless of whether this process itself holds an open handle there, and for the active file, falls back to a direct `fs.statSync()` on the expected `lts-<today>.log` path when `_logPath` is empty. This makes the Admin Dashboard reflect the real filesystem state independent of which process (child or supervisor) actually owns the live write handle — a purely additive, read-only change (no new file handles opened, no behavior change to what's actually written).

**Verification:** reproduced the exact broken state (fresh boot, `dirChanged` never true on the child) and confirmed the fix resolves it — `currentFile` now correctly reports the supervisor's real active file size on the very first `GET` after boot, `POST .../rotate` results are correctly visible afterward, and the existing Save-with-different-directory path (already working before this fix) shows no regression.

---

## 3D. Live Write-Capability Diagnostic (v1.4, 2026-08-27)

**Follow-up incident:** after §3C shipped and was confirmed fixed on a Linux instance (real "Active File"/"Archived Files" data appeared correctly), a Windows instance (`analysis-1`) in the same deployment still showed no data. Direct filesystem check on that machine confirmed the configured directory genuinely had no log file — §3C's fix was working correctly (honestly reporting nothing exists), but *something* is preventing the actual write from happening there on Windows. `openLogFile()` already logs the real OS error on failure (`[Logger] Cannot open ${dir}: ${err.message}`), which would have answered this immediately — but the operator had no access to that process's console/terminal output to read it.

**Fix:** `getLogStats()` now performs a live write-capability probe (`_probeWritable()` — `mkdir` + tiny temp-file write/unlink, mirroring `routes/admin.js`'s `_assertDirWritable()`) against the effective directory on every call, and returns `dirWritable`/`dirWriteError` in the response. The Admin Dashboard panel (`LogRotationPanel.tsx`) now shows:
- A red banner with the real OS error when `dirWritable === false` — answers "why isn't this working" without needing server console access.
- A blue informational banner when `dirWritable === true` but no active file exists yet — signals "this process *can* write here, but nothing has, so whatever is actually producing logs (typically the production supervisor) may be pointed at a different directory" — the next diagnostic step for exactly the Windows case that triggered this.

This does not fix the underlying "why can't the Windows supervisor write there" question by itself — it makes that question answerable from the dashboard instead of requiring terminal access, which the operator confirmed they did not have. The probe reflects *this responding process's* (the Admin API child's) capability; on the common deployment shape where the supervisor spawns the child from the same session, this is a reliable proxy, but it is not a direct measurement of the supervisor's own capability (no reverse-IPC channel exists for the supervisor to report its own state back to the child — out of scope for this fix).

---

## 4. `utils/logger.js` — Rotation Engine

### 4.1 State

```javascript
let _cfg = { dir, maxFileSizeMB, maxFiles };  // mutable, was a set of top-level consts
let _logStream, _logDate, _logDir, _logPath, _fallback, _currentSizeBytes;
```

### 4.2 File Creation — Synchronous by Construction

`_tryOpen()` uses `fs.openSync(logPath, 'a')` (not `fs.createWriteStream(path)` directly) so the file is guaranteed to exist on disk the instant `_tryOpen()` returns, then wraps that fd with `fs.createWriteStream(null, { fd })`. This closes a real race found during implementation testing: `createWriteStream(path)` opens its fd lazily/asynchronously, so a burst of synchronous writes could trigger a second rotation before the first rotation's freshly-opened file actually existed on disk, causing `fs.renameSync()` to throw `ENOENT`. `openSync` removes that window entirely.

### 4.3 Size Tracking & Rotation

- `_currentSizeBytes` is tracked incrementally (existing size from `fstatSync` on open + bytes written per line) rather than `stat()`-ing on every write, for performance.
- `_writeToFile()` triggers `_rotate()` once `_currentSizeBytes >= maxFileSizeMB * 1024 * 1024`.
- `_rotate()`: close current stream → `fs.renameSync(activePath, archivePath)` → `openLogFile()` (reopens the plain daily filename fresh) → `_enforceMaxFiles()`.
- Archive filenames: `lts-YYYY-MM-DD_HHmmssSSS-N.log` — time-of-day-to-the-millisecond plus a per-process monotonic counter `N`, so a burst of same-millisecond rotations (pathological, but possible under a synchronous flood of ERROR lines) still produces unique filenames instead of one silently clobbering another.
- The existing midnight day-rollover branch in `_writeToFile()` (unchanged logic: new date → new file) now also calls `_enforceMaxFiles()`, so retention is enforced consistently regardless of which trigger caused the rollover.

### 4.4 Retention

`_enforceMaxFiles()` lists all files in the active directory matching `lts-YYYY-MM-DD(_HHmmssSSS-N)?.log`, excludes the currently-open active file path, sorts by mtime ascending, and `unlinkSync`s the oldest ones until the count is at most `maxFiles`.

### 4.5 New Public API

| Function | Purpose |
|---|---|
| `getLogConfig()` | Returns `{ dir, maxFileSizeMB, maxFiles }` |
| `setLogConfig(partial)` | Merges + applies; reopens the file if `dir` changed |
| `getLogStats()` | Full snapshot for the Admin API — config, effective dir, fallback flag, `ipcAvailable`, `serverId` (§3A), active file, archived files list, totals |
| `forceRotate()` | Rotates immediately regardless of size; no-op (returns `false`) if file logging is off or not yet open |

---

## 5. Admin API (`server/src/routes/admin.js`)

| Route | Behavior |
|---|---|
| `GET /admin/system/logs` | `res.json(getLogStats())` — no persistence/DB round-trip needed beyond what's already cached in this process's logger.js state |
| `PUT /admin/system/logs` | Validates each provided field → `logConfigService.setLogConfig()` (persist) → `logger.setLogConfig()` (this process) → `process.send()` if available (supervisor) → `AuditService.log('log_config_changed', ...)` → responds with fresh `getLogStats()` |
| `POST /admin/system/logs/rotate` | `process.send` missing → 501; otherwise sends `{ type: 'lts:logRotate' }` and audits `log_rotate_requested` |

`dir` validation (`_assertDirWritable`): `fs.mkdirSync(dir, { recursive: true })` then a probe file write+unlink, so a bad path (permissions, doesn't exist and can't be created, etc.) fails the request with HTTP 400 and a specific error message instead of silently falling back later.

All three routes sit below the router's existing `verifyAccessToken` + `requireRole('admin')` gate — no new auth surface introduced.

---

## 6. Frontend (`client/src/components/LogRotationPanel.tsx`)

Mounted inside `SystemSection` (`AdminUsersPage.tsx`), below the existing Database card. Polls `GET /admin/system/logs` every 10s (same cadence as `loadDbDetail`). Provides:

- Directory / max size (MB) / max files inputs + Save (`PUT`).
- Active file name+size, archived files table (name/size/mtime), total count/bytes.
- "Rotate Now" button (`POST .../rotate`), disabled when `ipcAvailable === false`.
- `fallbackActive` warning banner (configured dir unwritable, using `server/logs/`).
- `ipcAvailable === false` badge ("Dev mode — saved but not applied live").
- **`serverId` label (v1.1, §3A)** — small subtitle showing which server instance's settings are displayed (e.g. "Server: web-01"), since this became per-instance instead of a single shared value.

---

## 7. Failure Modes & Edge Cases

| Scenario | Behavior |
|---|---|
| Configured `dir` becomes unwritable after being accepted (e.g. permissions revoked, disk unmounted) | `openLogFile()`'s existing dual-fallback (`_cfg.dir` → `FALLBACK_DIR`) still applies on the supervisor side; `fallbackActive` reflects this on the next `GET` |
| `PUT` with an invalid path | 400, config unchanged, no partial persistence |
| `POST .../rotate` under `npm run dev*` | 501, clear message; no crash |
| Directory changed to a path with existing `lts-*.log` files from a prior run | `openLogFile()` opens in append mode (`fs.openSync(path, 'a')`) — an existing same-day file is appended to, not overwritten; `_currentSizeBytes` is seeded from its real on-disk size |
| Burst of rotations within the same millisecond | Unique archive filenames via the `_archiveSeq` counter — verified under a synthetic 60,000-line synchronous flood during implementation |
| Server restart with a previously-configured non-default `dir` | Restored via `restoreOnBoot()` before any camera/pipeline code runs |
| Two servers share one `DB_TYPE=mongodb` instance (v1.1) | Each resolves its own `settings` row via `logConfig:${SERVER_ID or hostname()}` — no cross-server overwrite. A server upgraded from the pre-fix version adopts its own prior config from the legacy global `logConfig` row on first boot after upgrade (§3A) |

---

## 8. Testing

Manual test cases: `docs/tc/TC_Log_Rotation.md`. Not wired into `TcRunnerService`/`tc_runner_cli.js` `SUITES` — noted as future work (would need a way to assert against the log directory from an HTTP-only test harness, which the existing TC suite style doesn't currently do for filesystem side effects).

Ad-hoc verification performed during implementation (isolated `node -e` scripts against `utils/logger.js`, not part of the automated suite):
- Size-triggered rotation under sustained write volume, confirming split + retention cap converge correctly.
- `forceRotate()` producing correctly-capped archive sets.
- `setLogConfig({ dir })` cleanly relocating the active file without touching the old directory's content.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-08-26 | 초기 작성 |
| 1.1 | 2026-08-27 | §3A 신규 — `settings` row id를 고정 `logConfig`에서 `logConfig:${SERVER_ID or hostname()}`로 변경(서버 인스턴스별 분리), 레거시 글로벌 row 자동 마이그레이션, `getLogStats()`에 `serverId` 필드 추가. 공유 MongoDB 배포에서 서버 간 로그 설정 상호 덮어쓰기 버그 수정(Windows 기본 경로 미고려는 별도 이슈로 분리, 이번 변경 범위 아님) |
| 1.2 | 2026-08-27 | §3B 신규 — `LOG_DIR` 기본값에 Windows 대응 추가: `LOG_DIR_WINDOWS`/`LOG_DIR_LINUX` env var, Windows 기본값 `C:\ProgramData\lts\logs`, `_resolveDefaultLogDir()`로 `logger.js`/`logConfigService.js` 로직 일원화 |
| 1.3 | 2026-08-27 | §3C 신규 — 사용자 실사용 보고("Active File/Archived Files가 표시되던 게 안 보임") 기반 실제 버그 발견·수정. `getLogStats()`가 `_logDir`/`_logPath`(이 프로세스가 직접 연 적 있을 때만 채워짐) 대신 `_cfg.dir` 기준으로 항상 실제 디렉토리를 스캔하도록 변경 — Admin API child 프로세스가 자기 생애주기 동안 한 번도 `openLogFile()`을 호출하지 않으면 GET이 영원히 빈 목록을 반환하던 버그. 격리된 샌드박스에서 실제 코드로 재현 후 수정 검증 완료 |
| 1.4 | 2026-08-27 | §3D 신규 — Windows 인스턴스에서 §3C 수정에도 여전히 데이터가 안 보이는 후속 사례 발생, 콘솔 접근 불가로 원인 확인이 막혀 `getLogStats()`에 실시간 쓰기 가능 여부 진단(`dirWritable`/`dirWriteError`) 추가, Admin Dashboard에 실제 OS 에러 표시 |
