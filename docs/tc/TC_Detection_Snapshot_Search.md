# TC — Detection Snapshot Storage & Global Search

**Document ID:** TC-LTS2026-SNAP-001  
**Issue Date:** 2026-05-27  
**Module:** Detection Snapshot Storage & Global Search  
**SRS Reference:** SRS-LTS2026-SNAP-001  
**Test Scripts:** test/api/detection_snapshot_search.test.js (Groups B, C, F)  
**Status:** Released — v1.1 amended 2026-05-27

---

## Group A — Snapshot Saving (Server-Side)

### TC-SNAP-A-001 — Loitering Event Triggers Snapshot

| Field | Value |
|---|---|
| **Precondition** | Server running, `SNAPSHOT_ENABLED=true`, `sharp` installed, one camera streaming |
| **Steps** | 1. Simulate detection with `isLoitering=true` via `pipelineManager._allDets` override. 2. Wait 500 ms. |
| **Expected** | `GET /api/snapshots?isLoitering=true` returns ≥ 1 record; `cropData` field is non-empty base64 JPEG string |

### TC-SNAP-A-002 — First-Seen Track Triggers Snapshot

| Field | Value |
|---|---|
| **Steps** | 1. New objectId (never seen before) detected. 2. Wait 200 ms. |
| **Expected** | 1 snapshot record exists for that objectId |

### TC-SNAP-A-003 — Throttle Prevents Redundant Saves

| Field | Value |
|---|---|
| **Steps** | 1. Same objectId detected 5 times within 10 s (no loitering). |
| **Expected** | Only 1 snapshot saved (first-seen); subsequent detections within 30 s window skipped |

### TC-SNAP-A-004 — Throttle Releases After Interval

| Field | Value |
|---|---|
| **Steps** | 1. Object detected. 2. Wait `SNAPSHOT_INTERVAL_SEC + 1` s. 3. Same objectId detected again. |
| **Expected** | 2 snapshots saved for that objectId |

### TC-SNAP-A-005 — Face Match Triggers Snapshot Regardless of Throttle

| Field | Value |
|---|---|
| **Steps** | 1. Detection with `face.matchScore = 0.87` within throttle window. |
| **Expected** | Snapshot saved; throttle window does NOT suppress it |

### TC-SNAP-A-006 — Fire/Smoke Always Triggers Snapshot

| Field | Value |
|---|---|
| **Steps** | 1. Detection with `className='fire'` within throttle window. |
| **Expected** | Snapshot saved |

### TC-SNAP-A-007 — `SNAPSHOT_ENABLED=false` Disables Saving

| Field | Value |
|---|---|
| **Steps** | 1. Set `SNAPSHOT_ENABLED=false`, restart server. 2. Trigger loitering event. |
| **Expected** | No snapshot records inserted; `GET /api/snapshots` returns `total: 0` |

### TC-SNAP-A-008 — Crop Clamped to Frame Boundaries

| Field | Value |
|---|---|
| **Steps** | 1. Inject detection with `bbox.x = -10`, `bbox.y = -5` (out-of-frame). |
| **Expected** | Snapshot saved successfully (clamped); cropData is valid JPEG |

### TC-SNAP-A-009 — Tiny Bbox Skipped

| Field | Value |
|---|---|
| **Steps** | 1. Inject detection with `bbox.width=2, bbox.height=3`. |
| **Expected** | No snapshot saved; no server crash; warning logged |

### TC-SNAP-A-010 — Snapshot Non-Blocking

| Field | Value |
|---|---|
| **Steps** | 1. Measure `emit('detections')` latency during heavy detection stream (20 objects/frame). |
| **Expected** | Socket.IO emit latency < 5 ms (snapshot work runs in `setImmediate`, not in emit path) |

---

## Group B — `/api/snapshots` REST API

### TC-SNAP-B-001 — List Snapshots Default

| Field | Value |
|---|---|
| **Steps** | `GET /api/snapshots` |
| **Expected** | `200`, `{ total, offset: 0, limit: 50, snapshots: [...] }`; `cropData` NOT present in list items |

### TC-SNAP-B-002 — Filter by `cameraId`

| Field | Value |
|---|---|
| **Steps** | `GET /api/snapshots?cameraId=<id>` |
| **Expected** | All returned snapshots have `cameraId === <id>` |

### TC-SNAP-B-003 — Filter by `className`

| Field | Value |
|---|---|
| **Steps** | `GET /api/snapshots?className=person` |
| **Expected** | All returned snapshots have `className === 'person'` |

### TC-SNAP-B-004 — Filter `isLoitering=true`

| Field | Value |
|---|---|
| **Steps** | `GET /api/snapshots?isLoitering=true` |
| **Expected** | All returned snapshots have `isLoitering === true` |

### TC-SNAP-B-005 — Date Range Filter

| Field | Value |
|---|---|
| **Steps** | `GET /api/snapshots?from=2026-05-27T00:00:00Z&to=2026-05-27T23:59:59Z` |
| **Expected** | All returned timestamps within specified range |

### TC-SNAP-B-006 — Pagination

| Field | Value |
|---|---|
| **Steps** | `GET /api/snapshots?limit=10&offset=10` |
| **Expected** | Returns 10 items starting from index 10; `total` matches full count |

### TC-SNAP-B-007 — Get Single Snapshot with cropData

| Field | Value |
|---|---|
| **Steps** | `GET /api/snapshots/<id>` |
| **Expected** | `200`; `cropData` field present and starts with `data:image/jpeg;base64,` |

### TC-SNAP-B-008 — Get Single Snapshot Not Found

| Field | Value |
|---|---|
| **Steps** | `GET /api/snapshots/nonexistent-uuid` |
| **Expected** | `404 { success: false, error: "Not found" }` |

### TC-SNAP-B-009 — Delete Snapshot

| Field | Value |
|---|---|
| **Steps** | 1. `DELETE /api/snapshots/<id>`. 2. `GET /api/snapshots/<id>`. |
| **Expected** | Step 1: `200 { success: true }`. Step 2: `404`. |

---

## Group C — `/api/search` API

### TC-SNAP-C-001 — Search Returns Unified Results

| Field | Value |
|---|---|
| **Steps** | Seed DB with 2 snapshots (person, loitering), 1 alert (LOITERING), 1 face (John). `GET /api/search?q=person` |
| **Expected** | `{ total: ≥2, results: [...] }`; each result has `_type` field |

### TC-SNAP-C-002 — Empty Query Returns 400

| Field | Value |
|---|---|
| **Steps** | `GET /api/search` (no `q` param) |
| **Expected** | `400 { error: "q parameter required" }` |

### TC-SNAP-C-003 — Type Filter `types=alerts`

| Field | Value |
|---|---|
| **Steps** | `GET /api/search?q=Zone&types=alerts` |
| **Expected** | All results have `_type === 'alert'` |

### TC-SNAP-C-004 — Detection Result Includes cropData

| Field | Value |
|---|---|
| **Steps** | Ensure snapshot exists for 'person'; `GET /api/search?q=person&types=detections` |
| **Expected** | Detection results include `cropData` starting with `data:image/jpeg;base64,` |

### TC-SNAP-C-005 — Face Name Search

| Field | Value |
|---|---|
| **Steps** | Face gallery face named "John Doe" exists. `GET /api/search?q=John` |
| **Expected** | Result with `_type: 'face'` and `name: 'John Doe'` returned |

### TC-SNAP-C-006 — Date Range Filter

| Field | Value |
|---|---|
| **Steps** | `GET /api/search?q=person&from=2026-01-01&to=2026-01-31` |
| **Expected** | Only results within January 2026 returned |

### TC-SNAP-C-007 — Search Performance

| Field | Value |
|---|---|
| **Steps** | Seed 10,000 snapshot records. `GET /api/search?q=person`. |
| **Expected** | Response time < 200 ms |

---

## Group D — Client: Detection Tab Thumbnails

### TC-SNAP-D-001 — Thumbnail Appears After Snapshot Event

| Field | Value |
|---|---|
| **Steps** | 1. Open Detections tab. 2. Server emits `snapshot:new` for objectId 5 (person). |
| **Expected** | Detection row for objectId 5 shows a crop thumbnail image |

### TC-SNAP-D-002 — Thumbnail Not Shown Without Snapshot

| Field | Value |
|---|---|
| **Steps** | Detection row exists but no `snapshot:new` event received for that objectId. |
| **Expected** | No thumbnail; row shows placeholder or empty crop column |

### TC-SNAP-D-003 — Click Thumbnail to Expand

| Field | Value |
|---|---|
| **Steps** | Click the crop thumbnail in a detection row. |
| **Expected** | Full-size crop image displayed (modal or lightbox) |

---

## Group E — Header Search Bar

### TC-SNAP-E-001 — Search Bar Opens on Click

| Field | Value |
|---|---|
| **Steps** | Click the search icon in the header. |
| **Expected** | Search input appears and has focus |

### TC-SNAP-E-002 — Typing Triggers Search (Debounced)

| Field | Value |
|---|---|
| **Steps** | Type "person" (one character at a time, fast). |
| **Expected** | Only 1 API call made after 300 ms pause; results appear |

### TC-SNAP-E-003 — ESC Closes Results Panel

| Field | Value |
|---|---|
| **Steps** | With results panel open, press ESC. |
| **Expected** | Results panel closes; input cleared |

### TC-SNAP-E-004 — Click Outside Closes Panel

| Field | Value |
|---|---|
| **Steps** | With results panel open, click on the video panel area. |
| **Expected** | Results panel closes |

### TC-SNAP-E-005 — Result Click Navigates to Detections Tab

| Field | Value |
|---|---|
| **Steps** | Click on a detection-type result. |
| **Expected** | Detections tab becomes active; targeted detection row is highlighted |

### TC-SNAP-E-006 — Result Click Navigates to Alerts Tab

| Field | Value |
|---|---|
| **Steps** | Click on an alert-type result. |
| **Expected** | Alerts tab becomes active |

### TC-SNAP-E-007 — Results Show Crop Thumbnails

| Field | Value |
|---|---|
| **Steps** | Search returns detection results with `cropData`. |
| **Expected** | Each detection/alert result shows a small crop thumbnail |

### TC-SNAP-E-008 — No Results State

| Field | Value |
|---|---|
| **Steps** | Search for a term with no matches (e.g., "xyzzy"). |
| **Expected** | "No results found" message displayed |

---

## Group F — Regression

### TC-SNAP-F-001 — Existing Detection Pipeline Unaffected

| Field | Value |
|---|---|
| **Steps** | Run existing Jest API tests with `SNAPSHOT_ENABLED=true`. |
| **Expected** | All pre-existing tests pass |

### TC-SNAP-F-002 — `SNAPSHOT_ENABLED=false` Full Regression

| Field | Value |
|---|---|
| **Steps** | `SNAPSHOT_ENABLED=false`, run full test suite. |
| **Expected** | All tests pass; no snapshot-related errors |

### TC-SNAP-F-003 — sharp Not Installed Fallback

| Field | Value |
|---|---|
| **Steps** | Uninstall `sharp`; restart server; trigger detections. |
| **Expected** | Server starts without crash; warning logged; pipeline continues; snapshots silently skipped |

### TC-SNAP-F-004 — WebRTC Stream Unaffected

| Field | Value |
|---|---|
| **Steps** | Verify WebRTC stream latency with snapshot saving enabled (10 objects/frame). |
| **Expected** | Stream latency not increased by more than 5 ms compared to baseline |

---

## Group G — Events Table Search (v1.1)

### TC-SNAP-G-001 — Events Table Searched by Default

| Field | Value |
|---|---|
| **Pre-condition** | DB contains at least one `events` record |
| **Steps** | `GET /api/search?q=loitering` (no `types` param) |
| **Expected** | Response includes results with `_type: "event"` (events are in default `types`) |
| **Covers** | FR-SNAP-020 |

### TC-SNAP-G-002 — `types=events` Explicit Filter

| Field | Value |
|---|---|
| **Pre-condition** | DB contains events with `type=loitering` and events with `type=intrusion` |
| **Steps** | `GET /api/search?q=loitering&types=events` |
| **Expected** | Returns only `_type: "event"` results; no `_type: "detection"` or `_type: "alert"` in response |
| **Covers** | FR-SNAP-020 |

### TC-SNAP-G-003 — Events Field Matching

| Field | Value |
|---|---|
| **Pre-condition** | DB has an event with `zoneName: "Main Entrance"` |
| **Steps** | `GET /api/search?q=main+entrance&types=events` |
| **Expected** | The event for `Main Entrance` is returned |
| **Covers** | FR-SNAP-020 |

### TC-SNAP-G-004 — `q=loitering` Returns `isLoitering=true` Detections

| Field | Value |
|---|---|
| **Pre-condition** | DB contains `detectionSnapshots` where `isLoitering=true` and `className=person` |
| **Steps** | `GET /api/search?q=loitering&types=detections` |
| **Expected** | Results include detections where `isLoitering=true`; total > 0 |
| **Covers** | FR-SNAP-021 |

### TC-SNAP-G-005 — `q=loitering` Does Not Return Non-Loitering Detections

| Field | Value |
|---|---|
| **Pre-condition** | DB contains `detectionSnapshots` where `isLoitering=false` and `className=person` |
| **Steps** | `GET /api/search?q=loitering&types=detections` |
| **Expected** | Detections with `isLoitering=false` are NOT in results (unless `className` contains "loitering") |
| **Covers** | FR-SNAP-021 |

### TC-SNAP-G-006 — Timestamp Sort Works for Unix ms Integers

| Field | Value |
|---|---|
| **Pre-condition** | DB contains alerts whose `timestamp` field is a Unix millisecond integer (not ISO string) |
| **Steps** | `GET /api/search?q=loitering&types=alerts` |
| **Expected** | Response returns `200 OK` with results sorted by timestamp descending; no `localeCompare` TypeError |
| **Covers** | FR-SNAP-022 |

---

## Group H — DB Persistence Safety (v1.1)

### TC-SNAP-H-001 — Data Survives Graceful Restart

| Field | Value |
|---|---|
| **Pre-condition** | Server running; at least 10 `detectionSnapshots` inserted since last start |
| **Steps** | 1. Send `SIGTERM` to server process. 2. Restart server. 3. `GET /api/search?q=person&types=detections` |
| **Expected** | All snapshots from before shutdown are returned in search results |
| **Covers** | NFR-SNAP-005, NFR-SNAP-007 |

### TC-SNAP-H-002 — `lts.json` Not Corrupted After Crash

| Field | Value |
|---|---|
| **Pre-condition** | Server running; active `db.insert()` traffic |
| **Steps** | 1. `kill -9 <server_pid>` during active writes. 2. `node -e "JSON.parse(require('fs').readFileSync('server/storage/lts.json', 'utf8'))"` |
| **Expected** | Command exits 0; no `SyntaxError`; `lts.json` is valid JSON |
| **Covers** | NFR-SNAP-005 |

### TC-SNAP-H-003 — Write Debounce Limits Disk I/O

| Field | Value |
|---|---|
| **Pre-condition** | `PERSIST_DEBOUNCE_MS = 2000` (default) |
| **Steps** | 1. Monitor `lts.json` mtime using `inotifywait`. 2. Trigger 100 rapid `db.insert()` calls within 500 ms. 3. Count file-write events within a 3-second window |
| **Expected** | `lts.json` mtime changes ≤ 1 time within the 3-second observation window |
| **Covers** | NFR-SNAP-006 |

### TC-SNAP-H-004 — `flushNow()` Called Before HTTP Server Closes

| Field | Value |
|---|---|
| **Pre-condition** | Server running; pending debounced write in flight |
| **Steps** | Add debug log in `flushNow()` and `httpServer.close()`. Send SIGTERM. Check log order. |
| **Expected** | Log shows `flushNow()` output BEFORE `httpServer.close()` output |
| **Covers** | NFR-SNAP-007 |

---

## Group I — SearchFullscreen Filter Chip Tooltips (v1.2)

### TC-SNAP-I-001 — Verify All chip tooltip text

| Field | Value |
|---|---|
| **Pre-condition** | `SearchFullscreen.tsx` build complete |
| **Steps** | Read the `title` attribute of the element with `label = "All"` among `button[title]` elements in the DOM |
| **Expected** | `title` value starts with `"Displays results of all types"` and includes all keywords: Detections, Alerts, Faces, Matches, Events |
| **Covers** | FR-SNAP-023 |

### TC-SNAP-I-002 — Verify Detection chip tooltip text

| Field | Value |
|---|---|
| **Pre-condition** | `SearchFullscreen.tsx` build complete |
| **Steps** | Read the `title` attribute of the button with `label = "Detection"` |
| **Expected** | `title` includes the keywords `"AI-detected objects"`, `"dwell time"`, `"risk score"`, `"clothing"`, `"color analysis"` |
| **Covers** | FR-SNAP-023 |

### TC-SNAP-I-003 — Verify Alert chip tooltip text

| Field | Value |
|---|---|
| **Pre-condition** | `SearchFullscreen.tsx` build complete |
| **Steps** | Read the `title` attribute of the button with `label = "Alert"` |
| **Expected** | `title` includes the keywords `"loitering threshold"`, `"unacknowledged alerts"`, `"dwell time"` |
| **Covers** | FR-SNAP-023 |

### TC-SNAP-I-004 — Verify Face chip tooltip text

| Field | Value |
|---|---|
| **Pre-condition** | `SearchFullscreen.tsx` build complete |
| **Steps** | Read the `title` attribute of the button with `label = "Face"` |
| **Expected** | `title` includes the keywords `"face gallery"`, `"missing persons"`, `"suspects"`, `"gallery classification"` |
| **Covers** | FR-SNAP-023 |

### TC-SNAP-I-005 — Verify Match chip tooltip text

| Field | Value |
|---|---|
| **Pre-condition** | `SearchFullscreen.tsx` build complete |
| **Steps** | Read the `title` attribute of the button with `label = "Match"` |
| **Expected** | `title` includes the keywords `"face recognition"`, `"similarity score"`, `"cropped image"` |
| **Covers** | FR-SNAP-023 |

### TC-SNAP-I-006 — Verify Event chip tooltip text

| Field | Value |
|---|---|
| **Pre-condition** | `SearchFullscreen.tsx` build complete |
| **Steps** | Read the `title` attribute of the button with `label = "Event"` |
| **Expected** | `title` includes the keywords `"loitering events"`, `"dwell time"`, `"movement path"` |
| **Covers** | FR-SNAP-023 |

### TC-SNAP-I-007 — Verify API `types=detections` when Detection chip is selected

| Field | Value |
|---|---|
| **Pre-condition** | SearchFullscreen open; search query entered |
| **Steps** | 1. Click the `Detection` chip. 2. Capture the `/api/search` request in the Network tab |
| **Expected** | The `types` parameter in the request URL is `detections` and does not include `alerts`, `faces`, etc. |
| **Covers** | FR-SNAP-024 |

### TC-SNAP-I-008 — Verify API `types=alerts` when Alert chip is selected

| Field | Value |
|---|---|
| **Pre-condition** | SearchFullscreen open; search query entered |
| **Steps** | 1. Click the `Alert` chip. 2. Verify the request URL |
| **Expected** | `types=alerts`; all results in the response have `_type: "alert"` |
| **Covers** | FR-SNAP-024 |

### TC-SNAP-I-009 — Verify all types when All chip is selected

| Field | Value |
|---|---|
| **Pre-condition** | SearchFullscreen open; search query entered |
| **Steps** | 1. Click the `All` chip. 2. Verify the request URL |
| **Expected** | `types=detections,alerts,faces,matches,events`; multiple `_type` values may coexist in the response |
| **Covers** | FR-SNAP-024 |

### TC-SNAP-I-010 — Chip exclusive selection

| Field | Value |
|---|---|
| **Pre-condition** | `Detection` chip is selected |
| **Steps** | 1. Click the `Alert` chip. 2. Verify button state |
| **Expected** | Only the `Alert` chip becomes active (ring style applied) and the `Detection` chip changes to inactive state (gray) |
| **Covers** | FR-SNAP-025 |

### TC-SNAP-I-011 — Chip tooltip is not empty string (regression)

| Field | Value |
|---|---|
| **Pre-condition** | `SearchFullscreen.tsx` source |
| **Steps** | Read the `tooltip` field from all items in the `TYPE_CHIPS` array |
| **Expected** | All 6 items have a `tooltip` containing a non-empty description of 50 or more characters |
| **Covers** | FR-SNAP-023 |

---

## Group J — Confidence Range Filter (v1.3)

> **Target SRS:** FR-SNAP-026, FR-SNAP-027, FR-SNAP-028, FR-SNAP-029, FR-SNAP-030  
> **Test script:** `test/api/detection_snapshot_search.test.js` (Group J)

### TC-J-001 — Apply minConfidence lower bound filter

| Field | Value |
|---|---|
| **ID** | TC-J-001 |
| **Priority** | High |
| **Pre-condition** | 3 snapshots with `confidence=0.3`, `confidence=0.7`, `confidence=0.9` exist in the DB (same `className`) |
| **Steps** | `GET /api/search?q=<className>&types=detections&minConfidence=0.6` |
| **Expected** | Response `results` contain only items with `confidence ≥ 0.6`; `confidence=0.3` item excluded |
| **Covers** | FR-SNAP-026 |

### TC-J-002 — Apply maxConfidence upper bound filter

| Field | Value |
|---|---|
| **ID** | TC-J-002 |
| **Priority** | High |
| **Pre-condition** | Same data as TC-J-001 |
| **Steps** | `GET /api/search?q=<className>&types=detections&maxConfidence=0.8` |
| **Expected** | Only items with `confidence ≤ 0.8` returned; `confidence=0.9` excluded |
| **Covers** | FR-SNAP-027 |

### TC-J-003 — Apply both min + max range simultaneously

| Field | Value |
|---|---|
| **ID** | TC-J-003 |
| **Priority** | High |
| **Pre-condition** | Same data as TC-J-001 |
| **Steps** | `GET /api/search?q=<className>&types=detections&minConfidence=0.5&maxConfidence=0.8` |
| **Expected** | Only items with `0.5 ≤ confidence ≤ 0.8`, i.e., `confidence=0.7`, are returned |
| **Covers** | FR-SNAP-026, FR-SNAP-027 |

### TC-J-004 — Return 400 when min > max is provided

| Field | Value |
|---|---|
| **ID** | TC-J-004 |
| **Priority** | Medium |
| **Pre-condition** | Server running |
| **Steps** | `GET /api/search?q=person&minConfidence=0.9&maxConfidence=0.3` |
| **Expected** | HTTP 400; `{ "success": false, "error": "minConfidence must be ≤ maxConfidence" }` |
| **Covers** | FR-SNAP-028 |

### TC-J-005 — Default processing for non-numeric input

| Field | Value |
|---|---|
| **ID** | TC-J-005 |
| **Priority** | Low |
| **Steps** | `GET /api/search?q=person&minConfidence=abc&maxConfidence=xyz` |
| **Expected** | HTTP 200; all detection results returned (no filter applied) |
| **Covers** | NFR-SNAP-009 |

### TC-J-006 — Filter not applied to non-Detection types

| Field | Value |
|---|---|
| **ID** | TC-J-006 |
| **Priority** | Medium |
| **Steps** | `GET /api/search?q=<keyword>&types=alerts,faces&minConfidence=0.9&maxConfidence=0.95` |
| **Expected** | alert, face results are not removed by the confidence filter and are returned normally |
| **Covers** | FR-SNAP-030 |

### TC-J-007 — Full results when minConfidence=0 / maxConfidence=1.0

| Field | Value |
|---|---|
| **ID** | TC-J-007 |
| **Priority** | Low |
| **Steps** | `GET /api/search?q=person&types=detections&minConfidence=0&maxConfidence=1` |
| **Expected** | Returns the same result set as when no parameters are provided |
| **Covers** | FR-SNAP-026, FR-SNAP-027 |

---

## Group K — Crop Quality & Detail-View Rendering (v1.4)

> **Target SRS:** FR-SNAP-002, FR-SNAP-009, NFR-SNAP-02, NFR-SNAP-010
> **Test type:** Manual / visual QA (image quality and layout are not meaningfully assertable via Jest)

### TC-K-001 — Crop Resolution Uses Raised Defaults

| Field | Value |
|---|---|
| **ID** | TC-K-001 |
| **Priority** | High |
| **Pre-condition** | Server running with default `.env` (`SNAPSHOT_MAX_DIMENSION` unset → 640, `SNAPSHOT_JPEG_QUALITY` unset → 85) |
| **Steps** | 1. Trigger a snapshot save for a bbox ≥ 640px on its long side (e.g. a near-camera person). 2. `GET /api/snapshots/:id`. |
| **Expected** | `cropWidth` or `cropHeight` = 640 (the resized long side); decoded JPEG shows materially less blockiness than the pre-v1.4 320px/q70 output for the same bbox |
| **Covers** | FR-SNAP-002 |

### TC-K-002 — Crop Size Stays Within Revised Ceiling

| Field | Value |
|---|---|
| **ID** | TC-K-002 |
| **Priority** | Medium |
| **Steps** | 1. Save 20 snapshots across varied bbox sizes/content. 2. Measure decoded `cropData` byte size for each. |
| **Expected** | All ≤ 200 KB (NFR-SNAP-02) |
| **Covers** | NFR-SNAP-02 |

### TC-K-003 — Detections Timeline Detail Panel Shows Full Crop (No Cropping)

| Field | Value |
|---|---|
| **ID** | TC-K-003 |
| **Priority** | High |
| **Pre-condition** | Fullscreen Camera View → Detections tab, a track with ≥ 1 saved snapshot of a portrait (taller-than-wide) person bbox |
| **Steps** | 1. Click a track row to open the right-side detail panel. 2. Click a filmstrip crop to open the "zoomed snapshot" preview. |
| **Expected** | The enlarged preview shows the full person from head to feet (or full bbox extent) — no top/bottom clipping. The preview box height varies with the crop's aspect ratio instead of a fixed 120px crop. |
| **Covers** | FR-SNAP-009, NFR-SNAP-010 |

### TC-K-004 — Detail Panel Thumbnail Grid Does Not Crop

| Field | Value |
|---|---|
| **ID** | TC-K-004 |
| **Priority** | Medium |
| **Steps** | With the detail panel open, inspect the "All crop thumbnails" grid below the zoomed preview. |
| **Expected** | Each grid tile letterboxes (black bars) a portrait crop rather than cutting off its top/bottom; no part of the saved image is invisible |
| **Covers** | NFR-SNAP-010 |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Detection Snapshot Search |
| 1.4 | 2026-07-09 | LTS Engineering Team | Added Group K — crop quality defaults (640×640/q85) and detail-view object-contain rendering |
