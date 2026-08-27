---
name: project-ops-no-console-access
description: The operator running the live streaming/analysis servers (streaming-be2, analysis-1) has no server console/terminal access — diagnosis must go through the Admin Dashboard/API, not "check the logs on the machine"
metadata:
  type: project
---

Confirmed 2026-08-27 during a real Log Rotation incident: when asked to check the raw console/terminal output of the `analysis-1` (Windows) server process for a `[Logger] Cannot open ...` diagnostic line already present in the code, the operator could not — no console access, or couldn't locate/reach it.

**Why this matters:** this project's usual debugging instinct ("check the server logs / console output directly") is not available to whoever operates these specific live instances. Any diagnostic information needed to resolve an incident must be surfaced through the Admin Dashboard or a REST API response — not left as a `console.log`/`process.stderr.write` line that only a terminal-attached operator could read.

**How to apply:** when investigating or fixing something on `streaming-be2`/`analysis-1` (or by extension, any similarly-operated instance), prefer adding the diagnostic to an existing Admin API response (e.g. `GET /admin/system/*`) over adding a console log line and asking the user to go check it. See [[project_log_rotation_dual_process_architecture]] for the concrete precedent (`dirWritable`/`dirWriteError` added to `GET /admin/system/logs` for exactly this reason).
