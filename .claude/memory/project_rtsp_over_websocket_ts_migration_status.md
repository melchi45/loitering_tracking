---
name: project-rtsp-over-websocket-ts-migration-status
description: melchi45/rtsp-over-websocket has an active TypeScript/ESM migration (src/player/, legacy app/media/ untouched) — status snapshot and known doc/build issues as of 2026-07-27
metadata:
  type: project
---

**STALE (2026-08-04):** `melchi45/rtsp-over-websocket` was removed from this repo — its `src/player/` TS rewrite shipped as the standalone npm package `@melchi45/rtsp-over-websocket`, which LTS-2026 now consumes directly (see `docs/design/Design_RTSP_Over_WebSocket.md` §8.21 and `docs/design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md` §9, Superseded/Shipped). Everything below describes the situation as of 2026-07-27, while the submodule still existed — kept for historical reference only; none of the `melchi45/rtsp-over-websocket/...` paths below still exist in this repo.

`melchi45/rtsp-over-websocket` (a separate git submodule, npm-published as `@melchi45/rtsp-over-websocket`) is undergoing an incremental TypeScript/ESM rewrite of its legacy `app/media/` JS library (87 files) + `app/media/angularInterface/` (2 files) into `melchi45/rtsp-over-websocket/src/player/`. This is internal to the rtsp-over-websocket library itself — separate from, and not to be confused with, `[[project_ingest_daemon_http_unresponsive_pattern]]`-style LTS-2026 server work or the `camera-stream-setup` skill's RTSP-over-WebSocket streaming feature (that skill covers the npm-consumed `<rtsp-over-websocket>` element; this migration is about the library's own source tree).

**SDD docs**: `melchi45/rtsp-over-websocket/docs/{mrd,prd,srs,design,ops,tc}/*_TypeScript_Migration.md`. Full architecture/roadmap in the Design doc.

**Status as of 2026-07-27**:
- Formally documented as "Phase 0+1 complete" (Exceptions + pure Util, 12 files, 32 parity tests), but the actual `src/player/` tree already has far more built out and passing (`npm run test:player`: 200 tests / 48 files green) — `exceptions/`(7), `util/`(16), `network/`(13), `mediaSession/`(22), `listen/`(9), `talk/`(3). **The SDD docs are stale relative to actual code state** for layers 3-9 — their phase/milestone tables still say "계획"(planned). A dedicated doc-sync session is needed to reconcile this before trusting the docs' phase tables at face value.
- Layer 12 (`angularInterface/` — AngularJS 1.x factory/directive glue code) was explicitly deprioritized in the original plan (MRD: "usage unclear, needs team confirmation, lowest priority, out of scope for early conversion") but was completed early (2026-07-27) at the repo owner's explicit request, out of roadmap order. See [[feedback_rtsp_over_websocket_layer_migration_pattern]] for the approach used.
- **Known broken build** (unrelated to the angularInterface work, not caused by it): `cd src/player && npx tsc -b --force` currently fails on `mediaSession/MediaRouter.ts` (`metaNTPDateTime`/`rtcpTSmeta` fields referenced but not declared, TS2339, 4 occurrences). `npm run test:player` (Vitest/esbuild, no type-checking) is unaffected and fully green, but `npm run build:player` (which runs `tsc -b` before `vite build`) is currently blocked project-wide. Check whether this has been fixed before assuming the production build works.
- A likely pre-existing security-relevant bug was found during the angularInterface port: `streamCanvas.js`'s `updatePlayer()` deep-copies the player-init payload, then deletes `zipPassword` from the *original* object instead of the copy that's actually forwarded downstream — so the password isn't actually stripped. Preserved as-is for parity (not fixed, per this migration's "record don't fix" convention for pre-existing issues), flagged in Design doc §6 and PRD §7 for follow-up security review.

**How to apply**: Before trusting any specific phase/FR completion claim in these SDD docs, spot-check against `find melchi45/rtsp-over-websocket/src/player -name '*.ts' ! -name '*.test.ts'` and `npm run test:player` rather than the docs' status tables alone.
