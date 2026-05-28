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
- Output: resized JPEG Buffer ≤ `SNAPSHOT_MAX_DIMENSION` × `SNAPSHOT_MAX_DIMENSION` px, quality = `SNAPSHOT_JPEG_QUALITY`
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
- Thumbnail display: 48×64 px (portrait), `object-cover`, click to expand to full crop
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
| NFR-SNAP-02 | Crop JPEG size MUST be ≤ 100 KB (enforced by quality + dimension limits) |
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
| `SNAPSHOT_JPEG_QUALITY` | `70` | JPEG compression quality (1–100) |
| `SNAPSHOT_MAX_DIMENSION` | `320` | Max crop width/height in pixels |

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

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Detection Snapshot Search |
