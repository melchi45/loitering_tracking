---
name: feedback-client-server-limit-sync
description: Client-side max-count UI options must never exceed the server-side buffer/limit they draw from
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 541ebcfa-cbc6-4d9e-bef6-62a40ae1a27d
---

Whenever a client UI offers a "max items to show" option (e.g. AdminLogPanel's `MAX_LINES_OPTIONS`), the server-side buffer/limit it draws from (e.g. `LOG_BUFFER_MAX` in `server/src/utils/logger.js`, and the `/admin/logs/recent` `limit` clamp in `server/src/routes/admin.js`) must always be kept >= the client's largest option. If the server-side cap is smaller, the client option is structurally unsatisfiable no matter how the client code is fixed.

**Why:** A real bug occurred (2026-07-02) where `LOG_BUFFER_MAX=500` on the server while the AdminLogPanel UI offered 1000/2000 as selectable "Max Lines" options — those options could never actually show more than 500 lines.

**How to apply:** When adding or raising a client-side count/limit option anywhere in the codebase, grep for the corresponding server-side cap and raise it too, in the same change. This is a cross-layer invariant not visible by reading either side in isolation. Reference: `docs/design/Design_Admin_Log_Viewer.md` §4.2, `docs/srs/SRS_Admin_Log_Viewer.md` FR-LOG-017, `.claude/skills/react-dashboard-dev/SKILL.md`.
