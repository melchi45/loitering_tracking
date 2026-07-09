# PRD — Detection Snapshot Storage & Global Search

**Document ID:** PRD-LTS2026-SNAP-001  
**Issue Date:** 2026-05-27  
**Module:** Detection Snapshot Storage & Global Search  
**RFP Reference:** RFP-LTS2026-SNAP-001  
**Status:** Released

---

## 1. Technology Selection

| Component | Choice | Rationale |
|---|---|---|
| JPEG crop library | `sharp` (npm) | Native libvips binding; 10–50× faster than pure-JS alternatives; supports JPEG region extraction |
| Crop storage format | Base64 JPEG in DB | Eliminates separate file system; portable; works with JSON and MongoDB backends |
| Crop dimensions | Max 640×640 px, JPEG quality 85 | Raised from 320×320/q70 — the original defaults produced visibly soft/blocky crops in the Detections timeline and detail panel; 640/q85 keeps typical size < 80 KB while looking close to the source frame |
| Search index | In-memory JS filter (Phase-1) | Sufficient for ≤ 50,000 records; MongoDB `$text` index for Phase-2 |
| Snapshot throttle | In-memory Map per cameraId+objectId | O(1) lookup; reset on server restart |

---

## 2. Data Model

### 2.1 `detectionSnapshots` Table

```js
{
  id:          string,     // UUID
  cameraId:    string,     // FK → cameras.id
  cameraName:  string,     // denormalised for search speed
  timestamp:   string,     // ISO 8601
  objectId:    number,     // ByteTrack track ID
  className:   string,     // 'person' | 'face' | 'vehicle' | 'fire' | 'smoke' | ...
  confidence:  number,     // 0–1
  bbox:        { x, y, width, height },  // pixels in original frame
  frameWidth:  number,
  frameHeight: number,
  cropData:    string,     // base64 JPEG (< 200 KB)
  cropWidth:   number,
  cropHeight:  number,
  attributes:  object,     // { color, cloth, face: { faceId, name, matchScore }, hat, mask, ... }
  isLoitering: boolean,
  dwellTime:   number,     // seconds
  zoneId:      string | null,
  zoneName:    string | null,
  createdAt:   string,
  updatedAt:   string,
}
```

---

## 3. Snapshot Trigger Strategy

| Trigger | Always Save? | Notes |
|---|---|---|
| `isLoitering = true` | ✅ Yes | Most important evidence |
| New track first appearance | ✅ Yes | objectId not seen before in this camera |
| Face recognition match (`matchScore > 0`) | ✅ Yes | VIP / blacklist / missing person |
| Periodic per-track throttle | ⏱ Every 30 s | `SNAPSHOT_INTERVAL_SEC` in `.env` |
| Fire / smoke detection | ✅ Yes | Safety-critical |
| Routine non-event detection | ❌ No | Skipped unless any above condition met |

Throttle state: `Map<string, number>` keyed by `${cameraId}:${objectId}` → last save timestamp.

---

## 4. Snapshot Service API (Internal)

```js
// server/src/services/snapshotService.js
module.exports = {
  cropJpeg(jpegBuffer, bbox, frameWidth, frameHeight),
  // → Promise<{ data: Buffer, width, height }>

  shouldSave(cameraId, objectId, isLoitering, isFirstSeen, hasFaceMatch, isFireSmoke),
  // → boolean

  saveSnapshot(db, camera, detection, cropBuffer, cropWidth, cropHeight, timestamp),
  // → Promise<void>  (inserts into detectionSnapshots table)

  pruneOldSnapshots(db, maxPerCameraPerDay),
  // → void  (called on startup and every 6h)
}
```

---

## 5. REST API Design

### `GET /api/snapshots`

| Param | Type | Default | Description |
|---|---|---|---|
| `cameraId` | string | — | Filter by camera |
| `className` | string | — | Filter by class |
| `isLoitering` | boolean | — | Filter loitering-only |
| `from` | ISO date | — | Start timestamp |
| `to` | ISO date | — | End timestamp |
| `q` | string | — | Text search in className, zoneName, cameraName, face name |
| `limit` | int | 50 | Max results |
| `offset` | int | 0 | Pagination offset |

Response: `{ total, snapshots: [{ id, cameraId, cameraName, timestamp, className, confidence, bbox, cropData, attributes, isLoitering, zoneName, ... }] }`

### `GET /api/snapshots/:id`

Returns single snapshot with full `cropData`.

### `DELETE /api/snapshots/:id`

Removes snapshot record.

### `GET /api/search`

| Param | Type | Default | Description |
|---|---|---|---|
| `q` | string | required | Search query |
| `types` | string | `alerts,detections,faces` | Comma-separated entity types |
| `from` | ISO date | — | Date range start |
| `to` | ISO date | — | Date range end |
| `limit` | int | 30 | Max results per type |

Response:
```json
{
  "total": 42,
  "results": [
    {
      "_type": "detection",
      "id": "...",
      "cameraName": "Camera 1",
      "className": "person",
      "timestamp": "2026-05-27T...",
      "cropData": "data:image/jpeg;base64,...",
      "isLoitering": true,
      "zoneName": "Zone 1"
    },
    {
      "_type": "alert",
      "id": "...",
      "type": "LOITERING",
      "cameraName": "Camera 1",
      "zoneName": "Zone 1",
      "timestamp": "...",
      "cropData": "..."
    },
    {
      "_type": "face",
      "id": "...",
      "name": "John Doe",
      "galleryType": "vip",
      "cropData": "..."
    }
  ]
}
```

---

## 6. Client Component Design

### 6.1 SearchBar (Header)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  🔍 [Search alerts, detections, faces...]                    [×] [⚙]  │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  Filters: [All ▾] [Detections] [Alerts] [Faces]  Date: [   ~   ]  │  │
│  │  ─────────────────────────────────────────────────────────────────│  │
│  │  [crop] person   Camera 1 · Zone 1 · LOITERING  2026-05-27 11:33  │  │
│  │  [crop] face     Camera 2 · John Doe · 0.91      2026-05-27 10:12  │  │
│  │  [!]   ALERT    Camera 1 · Zone 1 · 87s dwell   2026-05-27 11:33  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Detections Tab Row (with crop)

```
┌───────────────────────────────────────────────────────────────────────────┐
│  [CROP]  person  Camera 1  Zone 1  conf 0.91  LOITERING 87s  11:33:47   │
│   48×64                                                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Crop Rendering Convention — Compact vs. Detail

Every surface that renders `cropData` MUST classify itself as one of two display modes:

| Mode | `object-fit` | Sizing | Used by |
|---|---|---|---|
| Compact marker | `cover` | Fixed small box (filmstrip icon, grid tile) | Gantt filmstrip thumbnail, header SearchBar result row |
| Detail view | `contain`, box height derived from `cropWidth`/`cropHeight` (CSS `aspect-ratio`) | Dynamic, capped at a max height | Detections timeline right-side detail panel (`DetectionsTimelineInline`), any "click to enlarge" preview |

Detail-view surfaces MUST NOT crop the saved image — see `PRD_Fullscreen_Camera_View.md` §6 for the concrete layout this drives in the Detections tab.

---

## 7. `.env` Configuration

```ini
# ── Detection Snapshots ──────────────────────────────────────────────────────
SNAPSHOT_ENABLED=true
SNAPSHOT_INTERVAL_SEC=30        # min seconds between snapshots for same track
SNAPSHOT_MAX_PER_CAMERA_DAY=500 # prune threshold per camera per 24h
SNAPSHOT_JPEG_QUALITY=85        # JPEG quality 1-100
SNAPSHOT_MAX_DIMENSION=640      # max width or height of crop in pixels
```

---

## 8. Priority

| Priority | Feature |
|:---:|---|
| P0 | Loitering event snapshot save |
| P0 | `GET /api/snapshots` REST endpoint |
| P0 | Detection tab crop thumbnail display |
| P1 | Global search `GET /api/search` |
| P1 | Header SearchBar component |
| P1 | First-seen + face-match snapshot triggers |
| P2 | Snapshot pruning / retention limits |
| P2 | Search date range filter |
| P3 | MongoDB `$text` index search (Phase-2) |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Detection Snapshot Search |
| 1.1 | 2026-07-09 | LTS Engineering Team | Raised crop quality defaults (640×640/q85), added §6.3 compact-vs-detail crop rendering convention |
