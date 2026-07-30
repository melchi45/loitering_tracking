# PRD — Ingest Daemon Control

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Admin Dashboard Ingest Daemon Start/Stop/Restart Control  
**Version:** 1.1  
**Date:** 2026-07-28

---

## 1. Overview

Adds Start / Stop / Restart buttons to the existing Admin Dashboard → Ingest Daemon monitoring section, backed by three new admin-only REST endpoints that reuse (and consolidate) the logic already present in `npm run ingest:start|stop|restart`.

---

## 2. User Stories

| ID | As a... | I want to... | So that... |
|---|---|---|---|
| US-01 | Admin | Click Restart in the dashboard | I can recover a stalled ingest-daemon without SSH access |
| US-02 | Admin | Click Stop before maintenance | Camera capture cleanly stops without me killing the whole Node server |
| US-03 | Admin | Click Start after a manual stop | Capture resumes and all cameras re-register automatically |
| US-04 | Admin | Be warned before Stop/Restart | I don't accidentally interrupt live camera capture |
| US-05 | Admin | See the outcome of my last action | I know whether the daemon actually restarted (PID) or failed |
| Auditor | Admin/Auditor | See who started/stopped/restarted the daemon and when | I can trace operational actions during an incident review |

---

## 3. Feature Specification

### 3.1 Control Row

Three buttons rendered above the existing per-camera monitoring grid in `IngestDaemonSection.tsx`:

| Button | Color | Confirmation | Result shown |
|---|---|---|---|
| ▶ Start | Green | None | "Already running" or "Started (PID N)" |
| ■ Stop | Red | Yes — capture interruption warning | "Stopped" or "Was not running" |
| ↻ Restart | Blue | Yes — capture interruption warning | "Restarted (PID N)" |

All three buttons are disabled while any one action is in flight (`pending` state), and the acting button shows a "…ing" label (Starting… / Stopping… / Restarting…) plus a spin animation on the Restart icon.

### 3.2 Availability

Visible whenever the existing Ingest Daemon section itself is visible — i.e. `serverMode !== 'analysis'` (same rule as the parent panel, `AdminUsersPage.tsx`). The server independently enforces `CAPTURE_BACKEND=ingest-daemon` on every request and returns `501` otherwise, so the buttons are never actionable in a configuration where they'd have nothing to control.

### 3.3 Reliability Requirement

Stop and Restart must work even when the ingest-daemon is in the "zombie" state (process alive, CPU-busy, HTTP API completely unresponsive — see Design_RTSP_Capture_Backend.md §6.29.5). The backing logic determines "is it running" from actual port occupancy, not from a `/health` response, and escalates to SIGKILL after an 8-second grace period if the process does not exit on its own.

### 3.4 Multi-Instance Fleet (§6.45)

Since the ingest-daemon capture layer moved to a fleet of `INGEST_DAEMON_INSTANCES` independent
processes (default 1, Design_RTSP_Capture_Backend.md §6.45), the three admin endpoints accept an
optional `instance` body field to target one instance; the dashboard's three buttons still send no
`instance` (no per-instance picker in the UI as of this revision), so each click continues to act on
the whole fleet — Start/Stop/Restart all configured instances in one call, exactly as it does today
with the default single instance. With `INGEST_DAEMON_INSTANCES=1` this is byte-for-byte the same
behavior as before; with N>1 the "Result shown" text (US-05) reflects an aggregate outcome across
instances rather than a single PID. A future revision may add a per-instance picker to the UI — not
in scope for this revision.

### 3.5 Audit Trail

Every call — success or failure — is logged via `AuditService.log()`:

```
{ event: 'ingest_daemon_start' | 'ingest_daemon_stop' | 'ingest_daemon_restart',
  actorId: <admin user id>,
  detail: { ok, ...action-specific fields } }
```

Visible in the existing Admin Dashboard → Audit Log section.

---

## 4. Non-Goals

- Scheduling automatic restarts
- Per-camera pipeline start/stop (already exists via `/api/cameras/:id/stream/start|stop`)
- Changing the automatic watchdog's own recovery behavior

---

## 5. Success Criteria

- An admin with only a browser can fully recover a wedged ingest-daemon (Stop implicitly via Restart) in under 15 seconds
- No behavior divergence between `npm run ingest:restart` and clicking Restart in the dashboard — both call the same `ingestDaemonControl.js` functions

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 |
| 1.1 | 2026-07-28 | §3.4 멀티 인스턴스 플릿(§6.45) 섹션 추가, 이후 섹션 번호 조정 |
