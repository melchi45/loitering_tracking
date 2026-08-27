---
name: project-mongodb-flush-data-loss-bug
description: "MongoDatabase.flushNow() was a no-op, causing deletes/updates to be silently lost if the server restarted shortly after — fixed 2026-07-21, applies to ALL tables not just cameras"
metadata: 
  node_type: memory
  type: project
  originSessionId: 23271567-dba0-4ffb-98f5-ab031d3bf1f0
---

Found and fixed 2026-07-21 while investigating why deleted test cameras kept "coming back" after server restarts (see [[project_analysis_server_camera_cleanup]] and [[project_ingest_daemon_http_unresponsive]] for the same session's related findings).

**The bug:** `server/src/db/MongoDatabase.js`'s `delete(table, id)`/`update(table, id, data)` are synchronous — they update the in-memory `_store` immediately, then call `_persist()` which fires `this._mongo.remove()`/`.upsert()` as pure fire-and-forget (the returned Promise was never stored or tracked). `flushNow()` was a literal no-op with a comment saying "MongoDB writes are async fire-and-forget — nothing to flush synchronously." So `DELETE /api/cameras/:id` responds `{success:true}` as soon as the in-memory removal completes, but the actual MongoDB network round-trip may still be in flight — and the graceful-shutdown handler's call to `flushNow()` did nothing to wait for it. A restart within that window abandons the write; on next boot, MongoDB hydration brings the "deleted" record right back with its original `createdAt`.

**Why it mattered this session specifically:** repeated "delete via API → restart moments later for the next diagnostic step" cycles during WebRTC/ingest-daemon debugging hit this race condition over and over, making cleaned-up test cameras reappear repeatedly and wasting significant time before the actual mechanism was found.

**Fix:** `MongoDatabase` now tracks in-flight write promises in a `_pendingWrites` Set (added in `_persist()`, removed via `.finally()`); `flushNow()` is now `async` and does `await Promise.allSettled([...this._pendingWrites])`. `BaseDatabase.flushNow()` and the `db/index.js` export are both `async` now too, and `index.js`'s shutdown handler does `await flushNow()` instead of a bare call. Verified live: create camera → delete → immediate SIGTERM (no delay) → restart → `GET` returns 404 (previously would have resurrected it).

**Scope — this is NOT camera-specific.** Every table using `db.delete()`/`db.update()` (zones, alerts, missing persons, galleries, everything) was equally exposed. The fix closes the whole class at once since it's in the shared `MongoDatabase`/`BaseDatabase` layer, not per-table code.

**How to apply:** If a delete/update ever appears to "not have taken effect" after a restart when `DB_TYPE=mongodb`, this class of bug is the first thing to suspect — check whether the fix (this memory's date) is actually present in the running code before chasing anything else. If reproducing similar issues on a fresh checkout that predates this fix, avoid restarting the server immediately after a delete/update during debugging; give MongoDB writes a few seconds to land first.
