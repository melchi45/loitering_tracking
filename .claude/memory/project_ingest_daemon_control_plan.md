---
name: project-ingest-daemon-control-plan
description: "Admin Dashboard ingest-daemon Start/Stop/Restart control — implemented 2026-07-23 (design doc drafted 2026-07-23 same day, decisions locked same session, full SDLC doc set + code shipped)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 23271567-dba0-4ffb-98f5-ab031d3bf1f0
  modified: 2026-07-23T11:36:37.049Z
---

**Status: Implemented (2026-07-23).** User asked (same day, later in the session) to actually build the feature that had been drafted as a design doc earlier: Start/Stop/Restart controls for ingest-daemon in the Admin Dashboard, admin-only.

**Decisions locked via AskUserQuestion** (both recommended options accepted):
- **Q1 scope**: Streaming **and** Combined mode (matches the existing monitoring panel's `serverMode !== 'analysis'` visibility rule) — not Streaming-only as literally worded in the original request. Gating is `CAPTURE_BACKEND=ingest-daemon` alone; no separate `SERVER_MODE` check needed since analysis mode never uses this backend.
- **Q2 response model**: Synchronous — HTTP request held until the operation completes (up to ~11s for restart), result in the response body. Not the async-ack-then-poll pattern used by `POST /admin/tc-results/run`.

**What shipped**:
- `server/src/services/ingestDaemonControl.js` — new shared module (`startDaemon()`/`stopDaemon()`/`restartDaemon()`, `isPortFree()`, kill escalation, camera re-registration). Both the 3 CLI scripts (now thin wrappers) and the 3 new admin routes call this same module — the exact DRY fix the design doc called for, since two independent code paths having the same zombie-detection logic had already caused a real recurring bug this session (see [[project_ingest_daemon_http_unresponsive]]).
- `POST /admin/ingest/{start,stop,restart}` in `admin.js` — `verifyAccessToken`+`requireRole('admin')`, `AuditService.log()` per call, `501` when `CAPTURE_BACKEND != ingest-daemon`.
- `IngestDaemonSection.tsx` — 3 buttons above the monitoring grid, `confirm()` warning before Stop/Restart, buttons disabled while any action in flight, inline success/error result display.
- Full SDLC doc set: `docs/mrd|rfp|prd|srs|tc/*_Ingest_Daemon_Control.md`, `docs/ops/Ingest_Daemon_Control_Guide.md`. `Design_Ingest_Daemon_Control.md` bumped Draft(0.1)→Active(1.0).
- New TC suite `test/api/ingest_daemon_control.test.js` (FR-IDC-001~012), registered in both `tc_runner_cli.js` and `TcRunnerService.js` as `captureOnly`. **Deliberately non-destructive by default** — Stop/Restart against a real running daemon are gated behind `LTS_TEST_INGEST_DESTRUCTIVE=true` since this test suite may run against a server with real live cameras; only auth-gating, backend-gating, Start-when-already-running (no-op), audit-log-presence, and CLI `--dry-run` paths run unconditionally.
- `camera-stream-setup` skill (both `.claude`/`.github`, kept byte-identical) updated Proposed→Implemented; `api-testing` skill (both mirrors) got the new TC suite row.

**Scope boundary kept intentionally separate**: `startServer.js`'s own crash-restart supervisor (`_respawnIngest()`/`_killPortOrphan()`, fixed earlier same session in [[project_ingest_daemon_http_unresponsive]] §6.36) was NOT folded into `ingestDaemonControl.js` — it needs stdout/stderr pipe-relay into the main server log and a tracked child-process handle for graceful shutdown, which the shared module's simpler detached-spawn-to-logfile model doesn't provide. Merging them would have silently dropped the `[Ingest]` log relay. Documented in Design_Ingest_Daemon_Control.md §2.1.

**Verification note**: could not exercise the actual admin-authenticated HTTP path live in this session — this environment's DB already has real users, so no `LTS_ADMIN_EMAIL`/`LTS_ADMIN_PASSWORD` were available to obtain a real admin JWT, and guessing/creating privileged credentials wasn't appropriate. Verified instead via: `tsc --noEmit` clean, `node --check` on all new/edited server files, the no-token 401 gate working live, and the CLI wrappers (which call the exact same `ingestDaemonControl.js` functions the routes call) working live end-to-end including the "already running" no-op branch. If a future session has real admin credentials, run `test/api/ingest_daemon_control.test.js` for full live confirmation of the positive-path admin routes.
