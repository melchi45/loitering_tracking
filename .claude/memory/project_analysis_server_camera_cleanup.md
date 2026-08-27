---
name: project-analysis-server-camera-cleanup
description: Why zombie camera channels appear on the Analysis server / Streaming server and how to avoid or clean them (TC test artifacts vs real deletion gaps)
metadata: 
  node_type: memory
  type: project
  originSessionId: 23271567-dba0-4ffb-98f5-ab031d3bf1f0
---

Two distinct sources of "zombie channel" entries, found and fixed 2026-07-21 (see [[project_ingest_daemon_http_unresponsive]] for the related ingest-daemon reliability work from the same session, and `Design_RTSP_Capture_Backend.md` §6.29.11-13 for full detail):

**1. Analysis server ad-hoc cameraIds from `distributed_pipeline.test.js`** (TC-DAP-005/009) — these tests POST directly to `/api/analysis/frame` with synthetic `cameraId` values (`tc009-cam-alpha`, `tc009-cam-beta`, `test-cam-distributed`) without ever calling `POST /api/cameras`. There is no Camera record to delete — `analysisApi.js` lazily creates `_cameraContexts`/`_metrics.perCamera` entries for any cameraId it sees in a frame POST. `_cameraContexts` already self-prunes after 5 min idle (`CONTEXT_EXPIRY_MS`); `_metrics.perCamera` didn't (fixed — now pruned in the same 60s sweep).

**2. Orphaned real test cameras from an interrupted TC auto-run** — `TcRunnerService.runOnStartup()` runs all 43 TC suites automatically ~30s after every server boot. `camera_discovery.test.js` (TC-B/TC-A groups) DOES register real cameras via `POST /api/cameras` and DOES clean them up — but only in `cleanupAll()` at the very end of `main()`. If the server restarts before that suite run finishes, the cleanup never happens, leaving orphaned `TC-B-*`/`TC-A-*` named cameras with TEST-NET (RFC 5737: `10.0.0.x`, `192.0.2.x`) RTSP URLs. This happened during the 2026-07-21 session because of ~15 repeated server restarts while debugging WebRTC/ingest-daemon issues — 14 orphaned cameras accumulated and were manually cleaned after user confirmation.

**How to apply:**
- Before assuming a "zombie channel" is a bug, check the RTSP URL and name — `TC-*` prefix + TEST-NET address (`10.0.0.x`/`192.0.2.x`) means it's a test artifact, safe to `DELETE /api/cameras/:id` after confirming with the user.
- **During any active debugging session that requires repeated server restarts**, set `TC_STARTUP_RUN=false` in `server/.env` temporarily to stop the auto-run from creating fresh orphans on every restart. Revert when done.
- `DELETE /api/cameras/:id` now (as of this fix) also notifies the Analysis server via `POST /api/analysis/camera-removed` for immediate cleanup on real camera deletion — but this only takes effect once the **remote Analysis server** itself pulls this commit and restarts (it's a separate machine at `ANALYSIS_SERVER_URL`, not something a session on the Streaming server host can restart directly).
- `pipelineManager.stopCamera()` used to skip ALL external cleanup (ingest-daemon/mediasoup/mediamtx) when the camera had no in-memory pipeline context (e.g. paused/errored/never-started) — fixed to always attempt cleanup regardless of local ctx state.
