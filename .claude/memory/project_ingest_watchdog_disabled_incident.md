---
name: project-ingest-watchdog-disabled-incident
description: 2026-07-27 incident — INGEST_WATCHDOG_ENABLED=false left on from a past debug session silently disabled ingest-daemon auto-recovery for days; fixed + auto re-enable safety net added
metadata:
  type: project
---

Streaming Dashboard showed all 8 IP cameras as RETRY/Offline, but WebRTC video playback itself was working fine — only the status badge was wrong. Root cause and fix, in full: [[project_ingest_daemon_http_unresponsive_pattern]] (see that note for the underlying GIL-wedge symptom this incident is a variant of).

**What happened**: `ingest_daemon.py` (:7070) was HTTP-wedged again (process alive, CPU busy, `/health`/register/DELETE all timing out — the known recurring GIL-contention pattern, `Design_RTSP_Capture_Backend.md` §6.29.5/§6.29.9/§6.37). `server/src/services/pipelineManager.js`'s frame-stall watchdog (`FRAME_STALL_MS=45s`) was looping "no frame for Ns — restarting capture" → "ingest-daemon re-registration failed" hundreds of times, which is what drove the dashboard `status` field to `reconnecting` (RETRY). WebRTC video kept working because mediasoup's RTP relay is UDP-socket-based and, once established, is fully independent of ingest-daemon's HTTP control plane (architecture invariant, §4.3) — so "video fine, status badge wrong" is an expected combination when only the HTTP thread is wedged, not a contradiction.

The daemon-level auto-recovery watchdog (`server/src/utils/ingestDaemonWatchdog.js`, added 2026-07-21 per §6.29.9 — polls `/health` every 20s, force-restarts via `restartIngestDaemon.js` after 2 consecutive failures) should have caught this automatically. It didn't fire because `server/.env` had `INGEST_WATCHDOG_ENABLED=false` — set during some earlier live-debugging session (the `.env` comment explicitly says "temporarily... re-enable afterward") and never reverted. `index.js` only logs a `console.warn` when this flag is false; it does not start any recovery path at all. This had been silently off for at least several days.

**Fix applied**:
1. `server/.env`: `INGEST_WATCHDOG_ENABLED` reverted `false` → `true`.
2. `npm run ingest:restart` run immediately to recover the wedged daemon — all 10 registered cameras (8 IP + 2 YouTube) re-registered; the 8 IP cameras returned to `streaming` status within seconds. The 2 YouTube cameras (`yt-1a647`, `yt-e54f2`) stayed on a separate, pre-existing MediaMTX-path-404 issue unrelated to this incident (YouTube URL refresh problem, already tracked separately).
3. **Structural fix** (not just a one-off env revert): `ingestDaemonWatchdog.js` gained `armDebugDisableSafetyNet()`. When `INGEST_WATCHDOG_ENABLED=false`, `index.js` now calls this instead of just warning — it logs a reminder every 5 minutes, and after 30 minutes force-starts the real watchdog regardless of the env value. Documented as `Design_RTSP_Capture_Backend.md` §6.40.

**Why this matters beyond this one incident**: a working auto-recovery watchdog is only as reliable as the manual "please remember to turn it back on" step it depends on. Any similar debug-only kill-switch flag in this codebase is a candidate for the same failure mode — silently left off, with no loud ongoing signal that it's off, until the exact scenario it exists to catch recurs.

**How to apply**: When Streaming Dashboard cameras show RETRY/Offline, check `curl --max-time 5 http://127.0.0.1:7070/health` first, per [[project_ingest_daemon_http_unresponsive_pattern]]. If video is still playing despite RETRY status, that's not a contradiction — it confirms the HTTP control plane (registration/health) is wedged while the already-established WebRTC RTP relay is unaffected. Also check `grep INGEST_WATCHDOG_ENABLED server/.env` — if the watchdog should have auto-recovered this and didn't, this flag is the first thing to check (now self-healing within 30 min as of this fix, but still worth checking as a "why didn't recovery happen sooner" question).
