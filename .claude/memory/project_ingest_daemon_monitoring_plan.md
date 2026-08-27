---
name: project-ingest-daemon-monitoring-plan
description: "Admin Dashboard real-time Ingest Daemon monitoring panel — implemented and verified live end-to-end 2026-07-21 (docs-first workflow, all design decisions resolved)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 23271567-dba0-4ffb-98f5-ab031d3bf1f0
---

User requested (2026-07-21) a real-time Ingest Daemon monitoring panel in the Admin Dashboard: connected channels/cameras, RTSP/YouTube URLs, live Bps/Fps/audio-video codec, IP connection info, live capture status, video sent to the Analysis server, analysis results received back, data sent to the Streaming server, plus an admin-only clickable Ingest-Daemon status badge on the Streaming Dashboard navigating here.

**Process note**: user explicitly required docs to be written *before* any code, and to be told about anything additional discovered. Followed: design doc written and iterated (draft → decisions confirmed via AskUserQuestion → implementation → results appended), skills updated at each stage, this memory updated throughout — not just at the end.

**Status: implemented and verified**, 2026-07-21. Design doc: `docs/design/Design_Ingest_Daemon_Monitoring.md` (v2.0) — full requirements mapping (§3: which requested item lives in ingest-daemon Python vs. Node) and §8 implementation results. `docs/design/Design_Admin_Dashboard.md` §4.6 points to it.

**Key architectural finding (still relevant for future work here)**: `ingest_daemon.py`'s HTTP API was extremely minimal before this — no per-camera real-time stats existed anywhere in `CameraSession`. This feature added genuine new Python-side instrumentation (`CameraStats` dataclass, hot-path counter increments, a single shared `_stats_sampler()` background thread computing bps/fps by diffing, new `GET /cameras/stats` endpoint) — it was not just a Node-side aggregation job. Several of the originally-requested items are NOT ingest-daemon's domain at all (Analysis-server send/receive stats live in Node's `pipelineManager.js`/`analysisClient.js`) — the design doc's §3 table is the reference for "which process actually owns this data" if this area is touched again.

**Decisions locked in via AskUserQuestion (2026-07-21)**: full pipeline view (not ingest-daemon-only), Socket.IO push (not REST polling), show real peer IP/port, include time-series sparkline graphs.

**Security finding worth remembering**: while building this, discovered the codebase's *existing* admin-facing Socket.IO events (`server:log`/`admin:subscribe-logs` in `utils/logger.js`) have **no server-side authorization at all** — `io.emit()` broadcasts to every connected socket regardless of role. This new feature's `rtspUrl` field carries embedded camera credentials, so it deliberately did NOT follow that precedent: added `verifySocketAdmin(token)` to `middleware/auth.js` (reuses the existing RS256 JWT verify logic) and gates the `admin:ingest-stats` push to a per-connection verified-subscriber `Set`, emitting via `io.to(socketId)` rather than `io.emit()`. Verified live with signed test tokens: admin role receives data, viewer role does not. **The pre-existing gap in `server:log`/`admin:subscribe-logs` was not fixed** — that's lower-severity (log lines, not credentials) and was out of this feature's scope, but if anyone touches Socket.IO auth in this codebase, know that gap exists.

**Open/deferred**: YouTube-camera URL display format was assumed (original YouTube URL + pipeline status) without an explicit confirmation question — flagged for user feedback if wrong. `db.all('cameras')` is polled every 1.5s for the merge; fine at current camera counts, worth revisiting if the fleet grows much larger.
