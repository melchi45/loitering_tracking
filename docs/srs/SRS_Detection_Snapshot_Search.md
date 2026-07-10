# SRS — Detection Snapshot Storage & Global Search

**Document ID:** SRS-LTS2026-SNAP-001  
**Issue Date:** 2026-05-27  
**Module:** Detection Snapshot Storage & Global Search  
**PRD Reference:** PRD-LTS2026-SNAP-001  
**Status:** Released — v1.1 amended 2026-05-27

---

## 1. Functional Requirements

### FR-SNAP-001 — Snapshot Trigger Conditions

The server MUST save a snapshot for a detection when ANY of the following is true:
1. `detection.isLoitering === true`
2. The `objectId` has not been seen before on this camera in the current session (first appearance)
3. `detection.face.matchScore > 0` (face recognition match)
4. `detection.className === 'fire' || detection.className === 'smoke'`
5. The elapsed time since last snapshot for `${cameraId}:${objectId}` ≥ `SNAPSHOT_INTERVAL_SEC`

When `SNAPSHOT_ENABLED=false`, no snapshots MUST be saved.

### FR-SNAP-002 — JPEG Crop Operation

- Input: `jpegBuffer` (Buffer), `bbox` (`{ x, y, width, height }` in pixels), `frameWidth`, `frameHeight`
- The crop region MUST be clamped to frame boundaries before extraction
- Output: resized JPEG Buffer ≤ `SNAPSHOT_MAX_DIMENSION` × `SNAPSHOT_MAX_DIMENSION` px (default 640×640), quality = `SNAPSHOT_JPEG_QUALITY` (default 85)
- Implementation: `sharp(jpegBuffer).extract({ left, top, width, height }).resize(...).jpeg({ quality }).toBuffer()`
- The crop operation MUST run asynchronously and MUST NOT block the frame pipeline

### FR-SNAP-003 — Snapshot Storage Record

Each saved snapshot MUST contain:

| Field | Type | Notes |
|---|---|---|
| `id` | UUID string | Auto-generated |
| `cameraId` | string | Camera UUID |
| `cameraName` | string | Denormalised |
| `timestamp` | ISO 8601 | Detection time |
| `objectId` | number | Tracker track ID |
| `className` | string | Detection class |
| `confidence` | number | 0–1 |
| `bbox` | object | `{ x, y, width, height }` pixels |
| `frameWidth` | number | Source frame width |
| `frameHeight` | number | Source frame height |
| `cropData` | string | `data:image/jpeg;base64,...` |
| `cropWidth` | number | Actual crop width after resize |
| `cropHeight` | number | Actual crop height after resize |
| `attributes` | object | Face name, color, cloth, hat, mask etc |
| `isLoitering` | boolean | — |
| `dwellTime` | number | Seconds |
| `zoneId` | string\|null | — |
| `zoneName` | string\|null | — |

### FR-SNAP-004 — Snapshot API: List

`GET /api/snapshots`

- Returns paginated list; no `cropData` in list response (use `GET /api/snapshots/:id` for full data)
- Default `limit=50`, max `limit=200`
- Sort: `timestamp DESC` by default
- Supported filters: `cameraId`, `className`, `isLoitering`, `from`, `to`, `q` (text match on className/zoneName/cameraName/face name)

### FR-SNAP-005 — Snapshot API: Single

`GET /api/snapshots/:id`

- Returns full record including `cropData` (base64 JPEG string)
- Returns `404` if not found

### FR-SNAP-006 — Snapshot API: Delete

`DELETE /api/snapshots/:id`

- Removes record from DB
- Returns `{ success: true }` or `404`

### FR-SNAP-007 — Global Search API

`GET /api/search?q=<query>&types=<types>&from=<ISO>&to=<ISO>&limit=<n>`

- `q` MUST be URL-encoded; minimum 1 character
- Returns `{ total, results: [...] }` with `_type` field on each result
- Each result of type `detection` or `alert` with a linked snapshot MUST include `cropData`
- Results sorted by timestamp DESC
- Max 30 results per entity type in a single response

### FR-SNAP-008 — Search Entity Matching

| Entity Type | Matched Fields |
|---|---|
| `detections` | `className`, `zoneName`, `cameraName`, `attributes.face.name` |
| `alerts` | `type`, `zoneName`, `cameraName` |
| `faces` | `name` (faceGalleryFaces.name) |

Match: case-insensitive substring search.

### FR-SNAP-009 — Detection Tab Crop Thumbnail

- The Detections tab row MUST show the crop thumbnail when a snapshot exists for the detection's `objectId` + `cameraId` within the same second
- Compact thumbnail display: 48×64 px (portrait), `object-cover`
- "Click to expand" / detail views MUST render the crop with `object-contain` inside a box sized from the record's `cropWidth`/`cropHeight` (CSS `aspect-ratio`), NOT `object-cover` — the full image MUST be visible without cropping. See `SRS_Fullscreen_Camera_View.md` FR-FCV for the Detections timeline detail-panel implementation of this rule.
- Snapshot lookup: poll `GET /api/snapshots?cameraId=&objectId=&limit=1` or serve via Socket.IO `snapshot:new` event

### FR-SNAP-010 — Header Search Bar

- Positioned in the dashboard header, right of the title
- Input debounce: 300 ms
- Results panel: drops down below header, z-index above all content
- ESC key or click outside closes the panel
- Each result shows: crop thumbnail (if available), entity type badge, key metadata, timestamp
- Click on a result navigates to the relevant tab (Detections/Alerts/Face ID) with that entry highlighted

---

## 2. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-SNAP-01 | `sharp` crop MUST complete in < 50 ms (p95) per detection frame |
| NFR-SNAP-02 | Crop JPEG size MUST be ≤ 200 KB (enforced by quality + dimension limits) |
| NFR-SNAP-03 | Snapshot insert MUST be fire-and-forget (non-blocking to pipeline) |
| NFR-SNAP-04 | Search response time MUST be < 200 ms for ≤ 50,000 records (in-memory scan) |
| NFR-SNAP-05 | `SNAPSHOT_ENABLED=false` MUST completely disable snapshot I/O |
| NFR-SNAP-06 | `detectionSnapshots` table MUST be included in lts.json AND MongoDB write-through |
| NFR-SNAP-07 | Pruning job MUST run on startup and every 6 hours; MUST NOT block the event loop |

---

## 3. API Contracts

### 3.1 `GET /api/snapshots` Response

```json
{
  "total": 142,
  "offset": 0,
  "limit": 50,
  "snapshots": [
    {
      "id": "uuid",
      "cameraId": "uuid",
      "cameraName": "Camera 1",
      "timestamp": "2026-05-27T11:33:47.000Z",
      "objectId": 12,
      "className": "person",
      "confidence": 0.91,
      "bbox": { "x": 100, "y": 50, "width": 80, "height": 180 },
      "cropWidth": 80,
      "cropHeight": 160,
      "attributes": { "color": "blue", "isLoitering": true },
      "isLoitering": true,
      "dwellTime": 87.2,
      "zoneId": "uuid",
      "zoneName": "Zone 1",
      "createdAt": "2026-05-27T11:33:47.310Z"
    }
  ]
}
```

Note: `cropData` is **omitted** from list responses to reduce payload size. Fetch via `GET /api/snapshots/:id`.

### 3.2 `GET /api/search` Response

```json
{
  "query": "person",
  "total": 5,
  "results": [
    {
      "_type": "detection",
      "id": "uuid",
      "cameraId": "uuid",
      "cameraName": "Camera 1",
      "className": "person",
      "confidence": 0.91,
      "isLoitering": true,
      "dwellTime": 87.2,
      "zoneName": "Zone 1",
      "timestamp": "2026-05-27T11:33:47.000Z",
      "cropData": "data:image/jpeg;base64,/9j/..."
    },
    {
      "_type": "alert",
      "id": "uuid",
      "type": "LOITERING",
      "cameraName": "Camera 1",
      "zoneName": "Zone 1",
      "dwellTime": 87.2,
      "timestamp": "2026-05-27T11:33:47.000Z",
      "cropData": "data:image/jpeg;base64,..."
    },
    {
      "_type": "face",
      "id": "uuid",
      "name": "John Doe",
      "galleryType": "vip",
      "galleryId": "uuid",
      "photoData": "data:image/jpeg;base64,..."
    }
  ]
}
```

---

## 4. Socket.IO Events

### New event: `snapshot:new`

Emitted to the camera's room when a snapshot is saved.

```json
{
  "cameraId": "uuid",
  "snapshotId": "uuid",
  "objectId": 12,
  "className": "person",
  "timestamp": "...",
  "cropData": "data:image/jpeg;base64,..."
}
```

The client listens for this event and matches it to active detection rows by `objectId`.

---

## 5. Configuration

| Variable | Default | Description |
|---|---|---|
| `SNAPSHOT_ENABLED` | `true` | Set `false` to disable all snapshot saving |
| `SNAPSHOT_INTERVAL_SEC` | `30` | Min seconds between snapshots per track |
| `SNAPSHOT_MAX_PER_CAMERA_DAY` | `500` | Prune threshold per camera per 24h |
| `SNAPSHOT_JPEG_QUALITY` | `85` | JPEG compression quality (1–100) |
| `SNAPSHOT_MAX_DIMENSION` | `640` | Max crop width/height in pixels |
| `AI_MAX_WIDTH` | `640` | Streaming-mode only — max width of the copy forwarded to the remote analysis server (`pipelineManager.js`). Does NOT bound crop resolution (§12); see `Design_RTSP_Capture_Backend.md` §9.1 |

---

## 6. Error Handling

| Condition | Behaviour |
|---|---|
| `sharp` not installed | Log warning on startup; snapshot saving disabled; pipeline continues |
| Crop region out of frame bounds | Clamp to valid region; if region < 4×4 px, skip |
| DB insert failure | Log error; do NOT crash pipeline |
| `GET /api/search?q=` with empty q | Return `400 Bad Request` |
| Snapshot not found | Return `404 { success: false, error: "Not found" }` |

---

## 7. v1.1 Amendment — Search Improvements & Persistence Safety

### 7.1 New Functional Requirements

#### FR-SNAP-020 — Events Table Search

`GET /api/search` MUST support `types=events`. When `types` includes `events`, the endpoint MUST search the `events` table and return matching records with `_type: "event"`. The default `types` value MUST include `events`.

Matched fields for `events`:

| Field | Description |
|---|---|
| `type` | Event classification (e.g., `loitering`, `intrusion`) |
| `cameraName` | Source camera name |
| `className` | Detected object class |
| `zoneName` | Zone name where event occurred |
| `message` | Human-readable event description |

#### FR-SNAP-021 — `isLoitering` Keyword Detection

When `q=loitering` (case-insensitive), `GET /api/search` MUST return all `detectionSnapshots` records where `isLoitering === true`, in addition to records whose `className` substring-matches the query.

#### FR-SNAP-022 — Timestamp-Format-Agnostic Sort

Search results MUST be sorted by timestamp in descending order regardless of whether timestamps are stored as ISO 8601 strings or Unix millisecond integers. The sort MUST use `new Date(ts).getTime()` for comparison.

### 7.2 New Non-Functional Requirements

#### NFR-SNAP-005 — Atomic JSON File Write

`lts.json` MUST be written atomically using a write-to-temp-then-rename strategy. Specifically:
1. The new content MUST be written to `lts.json.tmp` first.
2. `fs.renameSync(lts.json.tmp, lts.json)` MUST be called to replace the live file.
3. On any write error, `lts.json.tmp` MUST be deleted before propagating the error.
4. A partially written `lts.json` MUST NOT be possible as a result of a mid-write process kill.

#### NFR-SNAP-006 — Write Debounce

`db.insert()` / `db.update()` MUST NOT trigger synchronous disk I/O more than once per 2 seconds (`PERSIST_DEBOUNCE_MS = 2000`). Multiple mutations within the debounce window MUST result in exactly one file write.

#### NFR-SNAP-007 — Graceful Shutdown Flush

On receiving `SIGTERM` or `SIGINT`, the server MUST flush any pending debounced write (`flushNow()`) before closing the HTTP server. This guarantees that data inserted in the final 2 seconds of a graceful shutdown is not lost.

---

## 8. v1.2 Amendment — SearchFullscreen Filter Chip Tooltips

### 8.1 New Functional Requirements

#### FR-SNAP-023 — Type Filter Chip Tooltip

Each type filter chip (button) in the `SearchFullscreen` component MUST display a tooltip describing the role of that filter on mouse hover.  
The tooltip is provided via the HTML `title` attribute using browser default behavior.

| Button | Display Text |
|---|---|
| All | Displays all result types — searches Detections, Alerts, Faces, Matches, and Events all at once. |
| Detection | Snapshots of objects detected by AI (persons, vehicles, etc.). Includes dwell time, risk score, clothing, and color analysis. |
| Alert | Alerts triggered when the loitering threshold is exceeded. Unacknowledged alerts are shown first; includes camera, zone, and dwell time information. |
| Face | Searches for persons enrolled in the face gallery. Can be filtered by gallery category: missing persons, suspects, authorized personnel, etc. |
| Match | Events where a real-time face recognition match was found against enrolled persons. Displays similarity score (%) and face crop image at time of detection. |
| Event | Searches loitering event records. Includes zone entry/exit times, total dwell time, and camera movement path information. |

#### FR-SNAP-024 — Type Filter API Mapping

When a filter chip is selected, the `types` parameter of the `/api/search` request MUST be mapped according to the table below.

| Chip Key | `types` Parameter Value | Returned `_type` List |
|---|---|---|
| `all` | `detections,alerts,faces,matches,events` | All |
| `detection` | `detections` | `detection` |
| `alert` | `alerts` | `alert` |
| `face` | `faces` | `face` |
| `match` | `matches` | `match` |
| `event` | `events` | `event` |

#### FR-SNAP-025 — Filter Chip Exclusive Selection

Only one type filter may be in the active (selected) state at a time. Clicking a different chip immediately deselects the current selection, activates the new chip, and refreshes the search result list based on the new filter.

---

## 9. v1.3 Amendment — Confidence Range Filter

**Revision:** v1.3 · 2026-05-27

### 9.1 New Functional Requirements

#### FR-SNAP-026 — `minConfidence` Query Parameter

The `GET /api/search` endpoint MUST support an optional `minConfidence` parameter.

- **Type:** `number`, range `[0.0, 1.0]`
- **Default:** `0.0` (no filter)
- **Behavior:** Excludes items where `confidence < minConfidence` from `detection` results.
- When `minConfidence=0` or not provided, no filter is applied.

#### FR-SNAP-027 — `maxConfidence` Query Parameter

The `GET /api/search` endpoint MUST support an optional `maxConfidence` parameter.

- **Type:** `number`, range `[0.0, 1.0]`
- **Default:** `1.0` (no filter)
- **Behavior:** Excludes items where `confidence > maxConfidence` from `detection` results.
- When `maxConfidence=1` or not provided, no filter is applied.

#### FR-SNAP-028 — Range Validation

If `minConfidence > maxConfidence`, the server MUST return an HTTP 400 response.

```json
{ "success": false, "error": "minConfidence must be ≤ maxConfidence" }
```

#### FR-SNAP-029 — Confidence Range UI (SearchFullscreen)

The filter row of the `SearchFullscreen` component MUST include a Confidence Range input UI.

- Min/Max numeric input fields (integer percentage input `0`–`100`; divided by `/100` when sent to API)
- Default Min: `0`, Default Max: `100`
- When input values change, immediately re-run search (with debounce applied)
- When the state is `Min: 0 / Max: 100`, do not include parameters in API requests (removes unnecessary filters)

#### FR-SNAP-030 — Non-Detection Types

The `minConfidence` / `maxConfidence` filters apply only to the `detection` type.  
Results of type `alert`, `face`, `match`, and `event` are not affected by the confidence filter.

### 9.2 Updated API Contract

**Request:**

```
GET /api/search?q=<query>
  &types=detections,alerts,...
  &from=<ISO>
  &to=<ISO>
  &minConfidence=<0.0–1.0>
  &maxConfidence=<0.0–1.0>
  &limit=<n>
  &offset=<n>
```

**Response shape:** Same as before (`total`, `results[]`).

### 9.3 Non-Functional Requirements

#### NFR-SNAP-008 — Performance

The `minConfidence` / `maxConfidence` filters are applied as an O(n) traversal after text filtering and implemented without a separate index. Additional latency for 10,000 `detectionSnapshots` records ≤ 5 ms.

#### NFR-SNAP-009 — Input Safety

When non-numeric values are passed for `minConfidence` or `maxConfidence`, they are silently replaced with their respective defaults (0.0 / 1.0). A 400 error is only returned for range inversion (`min > max`).

---

## 10. v1.4 Amendment — Crop Quality & Detail-View Rendering

**Revision:** v1.4 · 2026-07-09

### 10.1 Background

Streaming-mode users reported that crops shown in the Detections timeline (Fullscreen Camera View) looked visibly degraded compared to the source video, and that the enlarged crop in the right-side detail panel appeared cropped/cut off rather than showing the full bounding-box region.

### 10.2 Updated Requirements

- FR-SNAP-002 crop output dimension/quality raised to `SNAPSHOT_MAX_DIMENSION=640`, `SNAPSHOT_JPEG_QUALITY=85` (see §5 Configuration, updated).
- FR-SNAP-009 detail/expand views MUST use `object-contain` with a dynamically sized box (see updated FR-SNAP-009 above).
- NFR-SNAP-02 crop size ceiling raised to ≤ 200 KB to accommodate the higher-quality output.

### 10.3 New Non-Functional Requirement

#### NFR-SNAP-010 — No Crop-Induced Data Loss in Detail Views

Any UI surface that lets the user inspect a single saved crop at larger size (timeline detail panel, "click to enlarge" preview) MUST render the full extent of the stored `cropData` — i.e. `object-fit: contain`, never `cover` — so that no part of the originally captured bounding-box region is hidden from the viewer.

---

## 11. v1.5 Correction — Upstream Frame Resolution Is the Real Constraint

**Revision:** v1.5 · 2026-07-09

§10's `SNAPSHOT_MAX_DIMENSION`/`SNAPSHOT_JPEG_QUALITY` change (crop-step resize/quality) is necessary but not sufficient: the crop's actual source buffer (the JPEG `ingest_daemon.py` sends to Node.js for AI inference — `AI_MAX_WIDTH` env, package default `640`) was itself already downscaled before `cropJpeg()` ever runs, capping achievable quality regardless of `SNAPSHOT_MAX_DIMENSION`.

#### FR-SNAP-031 — AI Frame Resolution Governs Crop Quality Ceiling

The resolution of the JPEG buffer produced by the capture backend for AI inference (`AI_MAX_WIDTH` in `ingest_daemon.py`) MUST be treated as the effective upper bound on `detectionSnapshots.cropData` fidelity — `SNAPSHOT_MAX_DIMENSION` only ever downsizes from that buffer, never upscales past it (`withoutEnlargement: true`). Deployments seeking higher crop fidelity MUST raise `AI_MAX_WIDTH`, not only `SNAPSHOT_MAX_DIMENSION`.

`AI_MAX_WIDTH` default raised `640` → `1920` in `server/.env` and all `.env.*.example` templates. Detail: `Design_RTSP_Capture_Backend.md` §9.1.

> **Superseded by §12 below** — this fix was replaced the same day by a code-level change that decouples crop fidelity from the analysis-server bandwidth setting. Do not raise `AI_MAX_WIDTH` for crop quality; see §12.

---

## 12. v1.6 Superseding Amendment — Crop Uses Native Resolution Regardless of `AI_MAX_WIDTH`

**Revision:** v1.6 · 2026-07-09

§11's FR-SNAP-031 (raise `AI_MAX_WIDTH` to widen the crop source) is **superseded**. It coupled crop fidelity to the streaming→analysis-server network/CPU cost, which is undesirable for bandwidth-constrained deployments. FR-SNAP-031 MUST NOT be applied as written — `AI_MAX_WIDTH` has reverted to `640` with a redefined scope (below).

#### FR-SNAP-032 — Ingest Layer Delivers Native Resolution (supersedes FR-SNAP-031)

The capture backend (`ingest_daemon.py`) MUST deliver frames to the Node.js server at native/decoded resolution, with no intermediate downscale. This buffer MUST be the sole source for both AI inference input and `detectionSnapshots` crop extraction in combined/analysis mode (local inference), requiring no additional coordinate transformation.

#### FR-SNAP-033 — Streaming Mode Decouples Analysis Payload From Crop Source

In `SERVER_MODE=streaming`, the Node.js server MUST retain the native-resolution frame buffer locally and forward only a downscaled copy (target width: `AI_MAX_WIDTH`, default `640`) to the remote analysis server. `detectionSnapshots` crop extraction MUST use the retained native buffer, not the downscaled copy sent for analysis.

#### FR-SNAP-034 — Bounding-Box Coordinate Rescaling

Because the remote analysis server's response bbox coordinates are expressed relative to the downscaled copy it received (`result.frameWidth`/`result.frameHeight`), the streaming server MUST rescale each bbox to the retained native buffer's coordinate space (proportional scale by width/height ratio) before passing it to the crop function. **Superseded by §13 below** — the Socket.IO `detections` event broadcast to browser clients was originally left unscaled by this FR, but that produced a live-overlay flicker bug; §13 corrects this to also rescale the client-facing event.

#### NFR-SNAP-011 — Crop Fidelity Independent of Analysis Bandwidth Setting

Changing `AI_MAX_WIDTH` MUST NOT affect `detectionSnapshots` crop resolution or quality in any server mode. Crop fidelity MUST be governed solely by the camera's native resolution and `SNAPSHOT_MAX_DIMENSION`/`SNAPSHOT_JPEG_QUALITY`.

Configuration: `server/.env` + all `.env.*.example` templates — `AI_MAX_WIDTH` reverted `1920` → `640` (§5 Configuration re-updated). Design detail: `Design_RTSP_Capture_Backend.md` §9.1, `Design_Detection_Snapshot_Search.md` §16.

---

## 13. v1.7 Correction — Live Overlay Flicker Between Two Coordinate Spaces

**Revision:** v1.7 · 2026-07-10

### 13.1 Background (Bug Report)

After §12 shipped, streaming-mode users reported the live bbox overlay on camera video alternating between two different scales/positions frame-to-frame — the box would appear correctly sized once, then jump to a different (wrong) size on the next update, repeating indefinitely.

### 13.2 Root Cause

The client (`useCamera.ts`) receives two independent Socket.IO events that both update the SAME `frameWidth`/`frameHeight` state consumed by the bbox-overlay scaling math (`CameraView.tsx` `getRenderArea`/`drawOverlay`):

1. `'frame'` — emitted per raw frame arrival (`!ctx.useWebRTC` cameras only) with `frameWidth`/`frameHeight` parsed directly from the native buffer (native resolution, per §12's FR-SNAP-032).
2. `'detections'` — emitted whenever a streaming-mode analysis result returns, previously reporting `remoteFrameWidth`/`remoteFrameHeight` (the **downscaled** analysis coordinate space, per FR-SNAP-034 as originally written) paired with the **original, unscaled** `det.bbox`.

Because these two events fire independently and asynchronously, whichever fired most recently determined the client's `frameWidth`/`frameHeight` state — but the `detections` array's `bbox` values were only ever valid relative to the downscaled coordinate space. When `frameWidth`/`frameHeight` held the native value (from a `'frame'` update) while the still-displayed bbox was expressed in downscaled coordinates (from the last `'detections'` update), the overlay rendered at the wrong scale — and vice versa. The two events racing against each other produced the observed flicker.

This affects `SERVER_MODE=streaming` cameras with `webrtcEnabled=false` (raw JPEG display path) — combined/analysis mode is unaffected because its single local buffer already keeps both events self-consistent (§12 FR-SNAP-032).

### 13.3 Fix — FR-SNAP-034 Corrected

#### FR-SNAP-034 (revised) — `detections` Event MUST Also Report Native Coordinates

The Socket.IO `detections` event emitted by `_processRemoteResult()` (streaming mode) MUST rescale every detection's `bbox` (and nested `face.bbox`, when present) from the analysis coordinate space to the native buffer's coordinate space using the same `_scaleBbox()` helper used for cropping, and MUST report `frameWidth`/`frameHeight` as the native buffer's own dimensions (`_fw`/`_fh`) — never `remoteFrameWidth`/`remoteFrameHeight`. This makes the `detections` event's coordinate space match the `frame` event's at all times, eliminating the race.

This rescale is applied to a **new array** built for the emit only — it MUST NOT mutate the `allDetections` array used internally for snapshot cropping (which independently rescales via its own `cropBbox` computation, per FR-SNAP-034 original text) or for `_trackMeta` bookkeeping.

Detail: `server/src/services/pipelineManager.js` `_processRemoteResult()` — `clientDetections` array. `Design_Detection_Snapshot_Search.md` §17.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Detection Snapshot Search |
| 1.4 | 2026-07-09 | LTS Engineering Team | §10 amendment — raised crop quality defaults, added NFR-SNAP-010 (no crop-induced data loss in detail views) |
| 1.5 | 2026-07-09 | LTS Engineering Team | §11 correction — added FR-SNAP-031, `AI_MAX_WIDTH` (ingest_daemon.py) identified as the real crop-fidelity ceiling, raised 640→1920 |
| 1.6 | 2026-07-09 | LTS Engineering Team | §12 supersedes §11/FR-SNAP-031 — added FR-SNAP-032~034, NFR-SNAP-011: ingest layer now always native resolution, streaming mode downscales only the analysis-server copy and rescales bbox back to native for crop; `AI_MAX_WIDTH` reverted to 640 (§5 Configuration row added) |
| 1.7 | 2026-07-10 | LTS Engineering Team | §13 correction — fixed live-overlay flicker bug (`detections` event alternated between native and downscaled coordinate spaces with the `frame` event); FR-SNAP-034 revised so `detections` also reports native coordinates |
