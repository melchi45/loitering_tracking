# Operations Guide — Ingest Daemon Control

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Admin Dashboard Ingest Daemon Start/Stop/Restart Control  
**Version:** 1.1  
**Date:** 2026-07-28

---

## 1. Overview

The Admin Dashboard's Ingest Daemon section (previously monitoring-only) now has Start / Stop / Restart buttons. This guide covers when to use each action, what happens under the hood, and how the same logic is exposed via `npm run ingest:*` CLI scripts for shell access.

---

## 2. Accessing the Controls

1. Log in with an **admin** account
2. Go to **Admin Dashboard → Ingest Daemon**
3. The three buttons (▶ Start / ■ Stop / ↻ Restart) appear above the per-camera monitoring grid

Available in `SERVER_MODE=streaming` and `SERVER_MODE=combined`, whenever `CAPTURE_BACKEND=ingest-daemon` in `server/.env`. Not available in `analysis` mode (no capture backend there) or with any other `CAPTURE_BACKEND` value — the server returns `501` in those cases.

---

## 3. When to Use Each Action

| Action | Use when… | What happens |
|---|---|---|
| **Start** | Daemon was manually stopped and cameras show no video | Spawns `ingest_daemon.py`, waits for it to answer `/health` (up to 10s), re-registers every camera. No-op (safe to click) if already running. |
| **Stop** | Planned maintenance, or you want to force-quit before diagnosing manually | Terminates the daemon (see §4). Camera capture stops entirely until Start/Restart. |
| **Restart** | Dashboard shows cameras stuck in RETRY/error, or `/health` is unresponsive ("zombie" daemon) | Stop, then Start, then re-register all cameras — the standard recovery action for a wedged daemon (Design_RTSP_Capture_Backend.md §6.29.5) |

Stop and Restart both show a confirmation dialog warning that camera capture will be interrupted — dismiss it to cancel.

---

## 4. How Termination Works (Zombie-Safe)

The ingest-daemon can enter a state where the process is alive and consuming CPU but its HTTP API never responds. Whether the daemon is "running" is determined by attempting to bind its port directly (`isPortFree()`) — never by whether `/health` answers — so Stop/Restart correctly detect and terminate a zombie daemon that a naive health-check-based approach would miss entirely.

Termination sequence:
1. `fuser -k <port>/tcp` + `pkill -f 'ingest_daemon.py --addr :<port>'` (SIGTERM-equivalent — matched by
   this instance's own `--addr :<port>` cmdline argument, not by process name alone, so killing one
   instance in a multi-instance fleet, §8, never touches another instance's process)
2. Poll port occupancy for up to 8 seconds
3. If still occupied: `pkill -9 -f 'ingest_daemon.py --addr :<port>'` (SIGKILL-equivalent), poll up to 3 more seconds

---

## 5. Equivalent CLI Commands

The same underlying logic (`server/src/services/ingestDaemonControl.js`) backs both the dashboard buttons and these commands — behavior is identical either way:

```bash
cd server
npm run ingest:start     # equivalent to clicking Start
npm run ingest:stop      # equivalent to clicking Stop
npm run ingest:restart   # equivalent to clicking Restart

# Preview config without side effects (start/restart only):
npm run ingest:start -- --dry-run
npm run ingest:restart -- --dry-run

# Target a single instance in a multi-instance fleet (§8) — 0-based index:
npm run ingest:start -- --instance=1
npm run ingest:stop -- --instance=1
npm run ingest:restart -- --instance=1
```

---

## 6. Audit Trail

Every click (success or failure) is recorded in **Admin Dashboard → Audit Log** as `ingest_daemon_start` / `ingest_daemon_stop` / `ingest_daemon_restart`, including the acting administrator and the operation result (PID, camera re-registration results, or error message).

---

## 7. Related Recovery Mechanisms (Independent of This Feature)

These continue to run automatically and are unaffected by the manual controls above:

- **`ingestDaemonWatchdog.js`** — polls `/health` every 20s; after 2 consecutive failures, automatically runs the same restart logic (90s cooldown between attempts)
- **`startServer.js`'s crash-restart supervisor** — if the daemon process it spawned exits unexpectedly, it automatically respawns with exponential backoff (independent implementation — see Design_Ingest_Daemon_Control.md §2.2 for why it isn't merged into the shared module)

If cameras keep failing shortly after a manual Restart, check whether one of these automatic mechanisms is fighting a deeper issue (e.g. sustained GIL contention under heavy multi-camera load, Design_RTSP_Capture_Backend.md §6.29.5) rather than repeatedly clicking Restart.

---

## 8. Multi-Instance Fleet (§6.45)

Since 2026-07-28, the sustained-GIL-contention issue in §7 was root-caused to GIL thrashing under a
high thread count in a single `ingest_daemon.py` process (confirmed via live `strace` showing ~22,000
`futex()` syscalls/sec across ~96 threads with zero actual I/O). The structural fix: cameras are
distributed (by a deterministic hash of `cameraId`, re-computed on every restart — never persisted)
across `INGEST_DAEMON_INSTANCES` independent OS processes instead of one.

- **Env var**: `INGEST_DAEMON_INSTANCES` in `server/.env` (default `1` — fully backward compatible,
  identical single-process behavior to before this feature). Each instance listens on
  `INGEST_DAEMON_BASE_PORT + index * 10` (default base `7070`, so instance 0 = port 7070/internal 7071,
  instance 1 = port 7080/internal 7081, instance 2 = port 7090/internal 7091, ...).
- **Admin API**: `/admin/ingest/{start,stop,restart}` accept an optional body field `instance` (0-based)
  to target one instance; omitted targets the whole fleet. See RFP/SRS/TC_Ingest_Daemon_Control.md for
  the exact request/response shapes.
- **CLI**: `--instance=<n>` flag on all three `npm run ingest:*` scripts (§5 above); omitted runs across
  every configured instance.
- **Dashboard UI**: the Start/Stop/Restart buttons do not yet expose a per-instance picker — each click
  still targets the whole fleet, same as clicking with no `instance` via the API.
- **Verifying the fleet is up**: `ps -ef | grep ingest_daemon.py` should show one process per instance,
  each with a distinct `--addr :<port>` argument; `curl 127.0.0.1:<port>/health` for each configured
  port should return `200`.
- Full technical background, the strace evidence, and the six single-process mitigations that were
  tried and failed before this structural fix: `docs/design/Design_RTSP_Capture_Backend.md` §6.45.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 |
| 1.1 | 2026-07-28 | §8 멀티 인스턴스 플릿(§6.45) 추가, §4/§5 인스턴스 스코프 반영 |
