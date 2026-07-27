---
name: project-ingest-daemon-http-unresponsive-pattern
description: ingest-daemon can go fully HTTP-unresponsive while alive (CPU-busy) — the first thing to check whenever WebRTC cameras fail to register or Dashboard shows RETRY/Offline
metadata:
  type: project
---

`ingest_daemon.py` (the single Python PyAV capture daemon on `:7070`) has repeatedly been observed going fully unresponsive on its own HTTP API (`/health`, `/cameras`, registration/DELETE POSTs never return) while the process itself stays alive and CPU-busy. Suspected CPython GIL contention — confirmed at the RTSP `mux()` (network write) level in `Design_RTSP_Capture_Backend.md` §6.37, not the decode/read side (which is GIL-safe). Root cause not fully eliminated as of 2026-07-27; the fix strategy so far has been automatic detection + restart, not eliminating the wedge itself.

**Symptoms**: `pipelineManager.js` register/DELETE calls time out (`AbortSignal.timeout(5000)`); frame-stall watchdog loops "no frame for Ns — restarting capture" → "ingest-daemon re-registration failed" repeatedly since re-registration itself hits the same wedged daemon; Streaming Dashboard camera status flips to RETRY/Offline. **Important**: WebRTC video can keep playing fine during this — mediasoup's RTP relay is UDP-socket-based and independent of the daemon's HTTP control plane once established (§4.3), so "video fine, status RETRY" is expected, not contradictory.

**How to check**: `curl --max-time 5 http://127.0.0.1:7070/health` (or `GET /api/ingest-status` on the LTS server, which does the same check server-side). If it hangs/times out, the daemon is wedged — this is always the first thing to check before chasing WebRTC/mediasoup/SDP theories.

**How to recover**: `cd server && npm run ingest:restart` — kills the wedged daemon (uses `isPortFree()` bind-attempt detection, not `lsof`/`fuser`, which are blind to cross-session processes under `ptrace_scope=1`; see `Design_RTSP_Capture_Backend.md` §6.35/§6.36) and re-registers all cameras, usually recovering within ~10s.

**Automatic recovery**: `server/src/utils/ingestDaemonWatchdog.js` polls `/health` every 20s and auto-triggers the same restart after 2 consecutive failures (~40s) — this should mean nobody has to do the manual check/restart above. It depends on `INGEST_WATCHDOG_ENABLED` in `server/.env` staying `true`; see [[project_ingest_watchdog_disabled_incident]] for a 2026-07-27 incident where this flag was left `false` from a past debug session and silently disabled auto-recovery for days (now mitigated with a 30-minute forced re-enable safety net, but the flag is still worth checking as a first question if auto-recovery visibly didn't happen).

**How to apply**: Any time this symptom recurs, `curl --max-time 5 http://127.0.0.1:7070/health` is the fastest diagnostic — cheaper than reasoning about mediasoup stats, SDP negotiation, or client-side WebRTC state first.
