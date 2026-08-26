# Design — Log Storage Path & Rotation

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Admin-Configurable Log Storage Path, Size-Based Rotation (Split), Count-Based Retention
**Version:** 1.0
**Date:** 2026-08-26

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
| `getLogStats()` | Full snapshot for the Admin API — config, effective dir, fallback flag, `ipcAvailable`, active file, archived files list, totals |
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
