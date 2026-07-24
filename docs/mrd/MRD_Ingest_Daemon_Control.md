# MRD — Ingest Daemon Control

**Product:** LTS-2026 Loitering Detection & Tracking System  
**Feature:** Admin Dashboard Ingest Daemon Start/Stop/Restart Control  
**Version:** 1.0  
**Date:** 2026-07-23  
**Author:** LTS Engineering Team

---

## 1. Executive Summary

`ingest_daemon.py` is the single RTSP capture process for every IP camera in streaming and combined server modes. It is known to occasionally wedge into an HTTP-unresponsive "zombie" state under sustained multi-camera load (Design_RTSP_Capture_Backend.md §6.29.5), and the only recovery paths today are an automatic watchdog or an administrator with shell access running `npm run ingest:restart`. Non-shell administrators have no way to intervene. This feature adds Start/Stop/Restart controls to the existing Admin Dashboard Ingest Daemon monitoring panel so an administrator can recover the capture pipeline from the browser.

---

## 2. Operational Need

| Pain Point | Impact |
|---|---|
| Only shell-access operators can run `npm run ingest:restart` | Non-technical admins must wait for or escalate to an engineer during an outage |
| Existing automatic watchdog has a fixed 20s check interval + cooldown | An admin who already sees a stalled dashboard cannot force an immediate recovery |
| No way to intentionally stop capture (e.g. before planned maintenance) from the UI | Admins must SSH in or kill the whole Node server |
| Two prior CLI scripts (`stopIngestDaemon.js`, `restartIngestDaemon.js`) each independently implemented the same "detect + kill" logic | A fix applied to one (§6.35's zombie-detection bug fix) silently did not apply to the other until this feature's implementation consolidated them |

---

## 3. Target Users

| User | Context |
|---|---|
| System Administrator | Recovers a stalled capture pipeline without shell access |
| DevOps / SRE | Performs planned Stop before maintenance, Restart after config changes |
| Field Engineer | Confirms ingest-daemon recovery on-site via the dashboard alone |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | Administrators must be able to Start, Stop, and Restart the ingest-daemon process from the Admin Dashboard without shell access |
| BR-02 | The controls must be available in both Streaming and Combined server modes (wherever `CAPTURE_BACKEND=ingest-daemon` is active) |
| BR-03 | Stop/Restart must reliably terminate the process even when it is in the "zombie" (HTTP-unresponsive but alive) state |
| BR-04 | Every Start/Stop/Restart action must be recorded in the audit log with the acting administrator's identity |
| BR-05 | Restart must re-register all active cameras with the daemon automatically, matching existing CLI behavior |
| BR-06 | Stop/Restart must present a confirmation prompt warning that camera capture will be interrupted |
| BR-07 | The underlying control logic must be shared between the CLI scripts (`npm run ingest:start/stop/restart`) and the new API — not duplicated |

---

## 5. Success Metrics

- An administrator can recover a wedged ingest-daemon from the dashboard in under 15 seconds, with zero shell access
- Zero non-admin users able to call the new endpoints (security audit)
- No divergence between CLI and API recovery behavior after this change (single shared implementation)

---

## 6. Out of Scope

- Automatic Start/Stop scheduling (e.g. cron-like maintenance windows)
- Per-camera start/stop (this controls the whole daemon process, not individual camera pipelines — see existing `POST /api/cameras/:id/stream/start|stop`)
- Analysis-mode support (analysis servers have no capture backend)
- Replacing or modifying the existing automatic watchdog (`ingestDaemonWatchdog.js`) or `startServer.js`'s own crash-restart supervisor — both continue to operate independently of this feature

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 |
