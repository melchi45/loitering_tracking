# SRS — Ingest Daemon Control

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Admin Dashboard Ingest Daemon Start/Stop/Restart Control  
**Version:** 1.0  
**Date:** 2026-07-23

---

## 1. Introduction

This Software Requirements Specification defines the functional and non-functional requirements for administrator-triggered Start/Stop/Restart control of the `ingest_daemon.py` process, exposed via the Admin Dashboard and a shared backend service module.

---

## 2. Scope

- **Included**: Shared control service module, three admin REST endpoints, Admin Dashboard control buttons, audit logging, zombie-daemon-safe kill detection
- **Excluded**: Automatic scheduling, per-camera pipeline control, changes to the existing automatic watchdog (`ingestDaemonWatchdog.js`) or `startServer.js`'s crash-restart supervisor

---

## 3. Functional Requirements

### FR-IDC-001 — Shared Control Module

All Start/Stop/Restart logic SHALL live in exactly one module, `server/src/services/ingestDaemonControl.js`. Both the CLI scripts (`npm run ingest:start|stop|restart`) and the Admin API routes SHALL call this module's exported functions (`startDaemon()`, `stopDaemon()`, `restartDaemon()`) — no control logic SHALL be duplicated in more than one place.

**Acceptance**: A bug fix applied to `ingestDaemonControl.js` SHALL apply identically to both the CLI scripts and the Admin API without further changes.

### FR-IDC-002 — Port-Occupancy-Based Liveness Check

Whether the daemon is "running" SHALL be determined by attempting a real TCP bind to its configured port (`isPortFree()`), never by whether `GET /health` responds. A daemon that is alive but HTTP-unresponsive (the "zombie" state, Design_RTSP_Capture_Backend.md §6.29.5) SHALL still be correctly detected as running.

**Acceptance**: Simulating a zombie daemon (process bound to the port, `/health` timing out) SHALL cause `stopDaemon()`/`restartDaemon()` to still attempt termination, not skip it.

### FR-IDC-003 — Kill Escalation

Termination SHALL first attempt `fuser -k <port>/tcp` and `pkill -f 'ingest_daemon.py'` (SIGTERM-equivalent), then poll port occupancy for up to 8 seconds. If the port is still occupied after 8 seconds, SHALL escalate to `pkill -9 -f 'ingest_daemon.py'` (SIGKILL-equivalent) and poll for up to 3 more seconds.

### FR-IDC-004 — POST /admin/ingest/start

SHALL start the daemon if not already running (per FR-IDC-002) and re-register all active cameras via the existing internal reregister endpoint. If already running, SHALL return `{ ok: true, alreadyRunning: true }` without any side effects.

**Acceptance**: Calling this endpoint while the daemon is already running SHALL NOT kill or restart it.

### FR-IDC-005 — POST /admin/ingest/stop

SHALL terminate the daemon per FR-IDC-002/FR-IDC-003. SHALL return `{ ok: true, wasRunning: false }` (not an error) if the daemon was not running.

### FR-IDC-006 — POST /admin/ingest/restart

SHALL terminate the daemon (per FR-IDC-003), start a fresh instance, wait for `/health` to respond (up to 10 seconds), and re-register all active cameras. SHALL return per-camera registration results.

### FR-IDC-007 — Backend Availability Gating

All three endpoints SHALL return `501` with a descriptive error when `CAPTURE_BACKEND` is not `ingest-daemon`. No `SERVER_MODE` check is required beyond this — analysis mode does not use this capture backend and is excluded by this condition alone.

### FR-IDC-008 — Access Control

All three endpoints SHALL require a valid JWT access token and `admin` role, reusing the existing `verifyAccessToken` + `requireRole('admin')` middleware chain applied to all `/admin/*` routes.

### FR-IDC-009 — Audit Logging

Every call to any of the three endpoints — whether it succeeds or fails — SHALL create an `AuditService` entry with `event` one of `ingest_daemon_start` / `ingest_daemon_stop` / `ingest_daemon_restart`, the acting user's ID as `actorId`, and the operation's result in `detail`.

### FR-IDC-010 — Synchronous Response

Each endpoint SHALL hold the HTTP request open until the operation fully completes (start/stop up to a few seconds, restart up to ~11 seconds) and return the final result in the response body. Clients SHALL NOT need to poll a separate endpoint to learn the outcome of a specific button click (though the existing `admin:ingest-stats`/`GET /api/ingest-status` channels continue to reflect ongoing state independently).

### FR-IDC-011 — UI Control Row

The Admin Dashboard's Ingest Daemon section SHALL render Start/Stop/Restart buttons above the per-camera monitoring grid. Stop and Restart SHALL require the user to confirm a browser prompt warning that camera capture will be interrupted before the request is sent. Buttons SHALL be disabled while any action is in flight. The outcome of the most recent action SHALL be shown inline (success message with PID, or error text).

**Acceptance**: Clicking Stop SHALL show a confirmation prompt; dismissing it SHALL NOT send any request.

### FR-IDC-012 — CLI Backward Compatibility

`npm run ingest:start`, `npm run ingest:stop`, and `npm run ingest:restart` SHALL continue to work exactly as before this change (including `--dry-run` support on start/restart), now implemented as thin wrappers over `ingestDaemonControl.js`.

---

## 4. Non-Functional Requirements

### NFR-IDC-01 — Reliability

Stop/Restart MUST succeed against a zombie (HTTP-unresponsive) daemon without requiring manual process inspection.

### NFR-IDC-02 — Consistency

CLI and API code paths MUST NOT diverge in kill/start/liveness-check behavior — verified structurally by both depending on the same module (FR-IDC-001).

### NFR-IDC-03 — Security

Non-admin roles MUST receive `401`/`403` for all three endpoints. No RTSP URLs, credentials, or other sensitive camera data SHALL appear in audit log `detail` fields.

### NFR-IDC-04 — Compatibility

MUST function in both `SERVER_MODE=streaming` and `SERVER_MODE=combined`. MUST be inert (`501`) in `SERVER_MODE=analysis` or any `CAPTURE_BACKEND` other than `ingest-daemon`.

---

## 5. Data Model

### Start Response

```typescript
interface StartResult {
  ok: boolean;
  alreadyRunning?: boolean;
  pid?: number;
  cameras?: Record<string, { ok: boolean; error?: string; status?: number }>;
  error?: string;
}
```

### Stop Response

```typescript
interface StopResult {
  ok: boolean;
  wasRunning: boolean;
  error?: string;
}
```

### Restart Response

```typescript
interface RestartResult {
  ok: boolean;
  pid?: number;
  cameras?: Record<string, { ok: boolean; error?: string; status?: number }>;
  error?: string;
}
```

---

## 6. Component Map

| Component | File | Role |
|---|---|---|
| Shared control logic | `server/src/services/ingestDaemonControl.js` | `startDaemon()`/`stopDaemon()`/`restartDaemon()`, port-bind liveness check, kill escalation, camera re-registration |
| CLI wrappers | `server/src/scripts/{start,stop,restart}IngestDaemon.js` | `.env` load + CLI output only |
| Admin API | `server/src/routes/admin.js` | `POST /ingest/{start,stop,restart}`, gating, audit logging |
| Dashboard UI | `client/src/components/IngestDaemonSection.tsx` | Control buttons, confirmation prompts, result display |
| Admin page host | `client/src/pages/admin/AdminUsersPage.tsx` | Passes `apiFetch` to the section |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 |
