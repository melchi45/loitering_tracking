# RFP — Ingest Daemon Control

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Admin Dashboard Ingest Daemon Start/Stop/Restart Control  
**Version:** 1.1  
**Date:** 2026-07-28

---

## 1. Background

The Admin Dashboard already has an Ingest Daemon monitoring section (`IngestDaemonSection.tsx`, Design_Ingest_Daemon_Monitoring.md) showing per-camera connection state, bitrate, and AI throughput in real time. It is read-only. Recovering a stalled ingest-daemon today requires shell access to run one of three CLI scripts (`npm run ingest:start|stop|restart`). This RFP adds control actions to the same panel.

---

## 2. Scope of Work

Add three admin-only REST endpoints and matching Dashboard buttons that start, stop, and restart the `ingest_daemon.py` process, reusing (and consolidating) the existing CLI scripts' logic.

---

## 3. Functional Requirements

### 3.1 Control Actions

| Action | Endpoint | Behavior |
|---|---|---|
| Start | `POST /admin/ingest/start` | No-op if already running (port occupied); otherwise spawns the daemon and re-registers cameras |
| Stop | `POST /admin/ingest/stop` | Terminates the daemon (SIGTERM → SIGKILL escalation), including a zombie/HTTP-unresponsive process |
| Restart | `POST /admin/ingest/restart` | Stop, then Start, then re-register cameras |

### 3.2 Shared Implementation

All three CLI scripts (`startIngestDaemon.js`, `stopIngestDaemon.js`, `restartIngestDaemon.js`) and all three new routes call a single shared module, `server/src/services/ingestDaemonControl.js`. No control logic is duplicated between the CLI and the API.

### 3.3 Reliable Zombie Detection

"Is the daemon running" MUST be determined by attempting a real TCP bind to the daemon's port (`isPortFree()`), not by whether `/health` responds — a wedged daemon holds the port while never answering HTTP (Design_RTSP_Capture_Backend.md §6.29.5/§6.35/§6.36). Kill logic uses `fuser -k` plus a `pkill -f 'ingest_daemon.py'` fallback (cmdline-matched, not gated by `ptrace_scope`), with an 8-second grace period before escalating to SIGKILL (+ `pkill -9 -f`).

### 3.4 Mode Gating

The three endpoints are available whenever `CAPTURE_BACKEND=ingest-daemon` is active — this covers both `SERVER_MODE=streaming` and `SERVER_MODE=combined` (matching the existing monitoring panel's visibility rule). When the backend is not `ingest-daemon`, the endpoints return `501`.

### 3.5 UI

Three buttons (Start / Stop / Restart) added to the top of `IngestDaemonSection.tsx`, above the per-camera monitoring grid:
- Stop and Restart require a browser `confirm()` warning that camera capture will be interrupted
- Buttons are disabled while any action is in flight
- The result of the last action (success + PID, or error) is shown inline next to the buttons

### 3.6 Access Control & Audit

Reuses the existing `verifyAccessToken` + `requireRole('admin')` middleware chain already applied to all `/admin/*` routes. Every call (success or failure) is recorded via `AuditService.log()` with events `ingest_daemon_start` / `ingest_daemon_stop` / `ingest_daemon_restart`.

---

## 4. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Security | Admin role required for all three endpoints |
| Reliability | Stop/Restart must succeed even against a zombie (HTTP-unresponsive) daemon |
| Consistency | CLI and API must never diverge in kill/start behavior (single shared module) |
| Response model | Synchronous — the HTTP request is held until the operation completes (up to ~11s for Restart) |

---

## 5. API Contracts

All three endpoints accept an optional body field `instance?: number` (0-based) to target a single
ingest-daemon instance in a multi-instance fleet (`INGEST_DAEMON_INSTANCES`, §6.45). When omitted,
the action applies to every configured instance. With the default `INGEST_DAEMON_INSTANCES=1`
(or when `instance` is explicitly given), the response is the original flat shape below, unchanged.
When `instance` is omitted AND the fleet has more than one instance, the response wraps per-instance
results in an `instances[]` array instead (see each contract below).

### POST /admin/ingest/start

```
Response 200 (single instance): { "ok": true, "alreadyRunning": boolean, "pid"?: number, "cameras"?: {...} }
Response 200 (fleet, N>1, no `instance`): { "ok": true, "instances": [ { "index": number, "port": number, "ok": true, "alreadyRunning": boolean, "pid"?: number }, ... ] }
Response 500: { "ok": false, "error": string }
Response 501: { "error": "ingest-daemon backend not active (CAPTURE_BACKEND != ingest-daemon)" }
```

### POST /admin/ingest/stop

```
Response 200 (single instance): { "ok": true, "wasRunning": boolean }
Response 200 (fleet, N>1, no `instance`): { "ok": true, "instances": [ { "index": number, "port": number, "ok": true, "wasRunning": boolean }, ... ] }
Response 500: { "ok": false, "wasRunning": boolean, "error": string }
Response 501: (same as above)
```

### POST /admin/ingest/restart

```
Response 200 (single instance): { "ok": true, "pid": number, "cameras": { "<cameraId>": { "ok": boolean, "error"?: string } } }
Response 200 (fleet, N>1, no `instance`): { "ok": true, "instances": [ { "index": number, "port": number, "ok": true, "pid": number, "cameras": {...} }, ... ] }
Response 500: { "ok": false, "error": string }
Response 501: (same as above)
```

All three require `Authorization: Bearer <admin JWT>`.

---

## 6. UI Placement

Admin Dashboard → Ingest Daemon section (existing) — new control row above the camera monitoring grid:

```
[▶ Start] [■ Stop] [↻ Restart]    Started (PID 12345)
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 |
| 1.1 | 2026-07-28 | §5 API Contracts에 멀티 인스턴스 `instance` 파라미터 및 `instances[]` 응답 형태 추가 (§6.45) |
