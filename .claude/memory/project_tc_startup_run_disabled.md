---
name: project-tc-startup-run-disabled
description: "TC_STARTUP_RUN=false is a permanent decision, not a temporary debugging-session override — do not revert it"
metadata:
  type: project
  originSessionId: 23271567-dba0-4ffb-98f5-ab031d3bf1f0
---

`server/.env` has `TC_STARTUP_RUN=false` and the user confirmed (2026-07-22) this should **stay disabled going forward**, not just during the active debugging session that introduced it.

**Why:** On 2026-07-21, `TcRunnerService.runOnStartup()`'s automatic 43-suite TC test run (firing ~30s after every server boot) was found to be the root cause of a severe ingest-daemon overload — repeated restarts during active development caused TC camera-CRUD suites to collide with live camera registration, ballooning ingest-daemon to 34 registered cameras and dropping every live channel to 0fps. `TC_STARTUP_RUN=false` was added to `server/.env` to stop this. The design doc (`docs/design/Design_RTSP_Capture_Backend.md` §6.29.13/§6.29.14) originally framed this as a temporary measure to revert once debugging concluded — when asked directly whether to revert now that the crisis was resolved, the user chose to keep it disabled instead.

**How to apply:** Do not re-enable `TC_STARTUP_RUN` (remove the line or set to `true`) as a "cleanup" or "restore default behavior" action — the disabled state is now the intended steady state for this environment. The Admin Dashboard's Audit → Tests panel will not auto-refresh with new TC results on boot as a result; manual runs are still available via `POST /admin/tc-results/run` or `npm run test:tc`. All three `.env.example` reference templates now document `TC_STARTUP_RUN` (added 2026-07-22) with the commented-out form `# TC_STARTUP_RUN=false`, consistent with how other optional settings are documented there.
