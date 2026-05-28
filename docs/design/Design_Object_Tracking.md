# DESIGN DOCUMENT
# Object Tracking Subsystem

| | |
|---|---|
| **Document ID** | DESIGN-LTS-TRK-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_Object_Tracking.md |

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [KalmanFilter Design](#3-kalmanfilter-design)
4. [ByteTracker Design](#4-bytetracker-design)
5. [BehaviorEngine Design](#5-behaviorengine-design)
6. [Zone Management Design](#6-zone-management-design)
7. [Data Model](#7-data-model)
8. [API Design](#8-api-design)
9. [Sequence Diagrams](#9-sequence-diagrams)
10. [Error Handling](#10-error-handling)

---

## 1. Architecture Overview

```
[RTSP / WebRTC Frame (JPEG)]
           │
           ▼
   ┌──────────────────┐
   │  DetectionService │  YOLOv8n — produces [{bbox, class, confidence}]
   └────────┬─────────┘
            │ detections[]
            ▼
   ┌──────────────────┐     predict() each frame
   │   ByteTracker    │────────────────────────────────────────┐
   │                  │  IoU-based greedy Hungarian assignment  │
   │  _tracks: Track[]│◄───────────────────────────────────────┘
   └────────┬─────────┘
            │ trackedObjects[] { objectId, bbox, class, state }
            ▼
   ┌──────────────────────────────┐
   │  AttributePipeline (optional)│  ArcFace embedding, PPE, color
   └────────┬─────────────────────┘
            │ enriched objects
            ▼
   ┌──────────────────┐  loitering event   ┌──────────────────┐
   │  BehaviorEngine  │───────────────────►│  AlertService    │
   │                  │                    └──────────────────┘
   │  _state: Map     │  detections event
   │  _zoneGallery:Map│───────────────────►┌──────────────────┐
   └────────┬─────────┘                    │   Socket.IO      │
            │ zone evaluation              │ 'detections'     │
            ▼                             │ 'loitering_alert' │
   ┌──────────────────┐                    │ 'detections:     │
   │   ZoneManager    │                    │  summary'        │
   │  (MONITOR/EXCLUDE│                    └──────────────────┘
   │   polygons,      │
   │   schedules)     │
   └──────────────────┘
```

The tracking pipeline is per-camera. Each `startCamera()` call in `PipelineManager` creates a dedicated `ByteTracker` and `BehaviorEngine` instance. The `KalmanFilter` is embedded inside each `Track` object (one per tracked object).

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── tracking.js          # KalmanFilter, Track, ByteTracker classes
│   │   │   ├── behaviorEngine.js    # BehaviorEngine + risk scoring helpers
│   │   │   ├── zoneManager.js       # Zone CRUD + point-in-polygon
│   │   │   ├── trackerConfig.js     # Runtime-tunable config (iouThreshold, maxAge, etc.)
│   │   │   └── pipelineManager.js   # Orchestrates all per-camera pipelines
│   │   ├── api/
│   │   │   ├── zones.js             # REST router for /api/cameras/:id/zones
│   │   │   └── tracker.js           # REST router for /api/tracker/config
│   │   └── index.js                 # Express app entry point
│   └── storage/
│       └── lts.json                 # Persistent data store (zones)
│
├── docs/
│   ├── srs/SRS_Object_Tracking.md
│   └── design/Design_Object_Tracking.md  ← this file
│
└── test/
    └── api/
        └── object_tracking.test.js
```

---

## 3. KalmanFilter Design

**File:** `server/src/services/tracking.js`

### 3.1 State Representation

The filter maintains an **8-dimensional state vector** stored as a `Float64Array(8)`:

```
x = [x, y, w, h, vx, vy, vw, vh]
     ─────────────────────────────
     position (px)    velocity (px/frame)
```

`(x, y)` is the bounding-box center; `(w, h)` is width and height. Velocities `(vx, vy, vw, vh)` are latent — they are estimated by the filter, not observed directly.

### 3.2 Matrix Definitions

| Matrix | Shape | Description |
|--------|-------|-------------|
| `x`    | 8×1   | State mean (position + velocity) |
| `P`    | 8×8   | State covariance — uncertainty of state estimate |
| `F`    | 8×8   | Transition matrix — constant velocity model |
| `H`    | 4×8   | Observation matrix — maps state to measurement space |
| `Q`    | 8×8   | Process noise — models motion uncertainty |
| `R`    | 4×4   | Measurement noise — models detector uncertainty |

All matrices are stored as flat row-major `Float64Array` for numerical precision.

**Transition matrix F (constant velocity model):**

```
F = I(8) with F[0][4]=1, F[1][5]=1, F[2][6]=1, F[3][7]=1

Meaning: x_next = x + vx, y_next = y + vy, etc.
```

**Observation matrix H:**

```
H[0][0]=1, H[1][1]=1, H[2][2]=1, H[3][3]=1

Meaning: observe only [x, y, w, h] from the 8-D state
```

**Initial noise values:**
- `P = eye(8) × 10`  — moderate initial uncertainty
- `Q = eye(8) × 1`   — small process noise (smooth motion assumed)
- `R = eye(4) × 10`  — moderate measurement noise

### 3.3 `init(bbox)` Method

```
init({x, y, width, height}):
  state[0..3] = [x, y, width, height]
  state[4..7] = [0, 0, 0, 0]   ← velocities start at zero
  P = eye(8) × 10               ← reset covariance
```

### 3.4 `predict()` Method — Prediction Step

```
predict():
  x = F · x             ← advance position by velocity
  P = F · P · F^T + Q   ← grow uncertainty by process noise
  return stateToBbox()  ← extract {x, y, width, height}
```

**Adaptive process noise Q (in `Track.predict()`):**
- `speed = sqrt(vx² + vy²)`
- `speed > fastSpeedThreshold` → `Q = eye(8) × fastQScale` (larger noise for fast objects)
- `speed < slowSpeedThreshold` → `Q = eye(8) × slowQScale` (smaller noise for slow objects)
- This makes the filter responsive to velocity changes without over-smoothing.

**Drift safety check:** If the predicted position moves more than 2× the bbox diagonal from the last known position, the KF is reset to the last known position via `init(prevBbox)`. This prevents bad velocity estimates from pushing tracks to impossible locations.

**Extended-Lost freeze:** When `framesWithoutHit > 1`, the bbox is frozen at the last known position. Repeated `predict()` calls on a Lost track cause covariance to grow unboundedly (`P → ∞`) leading to NaN in later IoU calculations. The freeze prevents this.

### 3.5 `update(bbox)` Method — Measurement Update Step

```
update({x, y, width, height}):
  z = [x, y, width, height]            ← raw detector measurement
  y_innov = z − H·x                    ← innovation (residual)
  S = H·P·H^T + R                      ← innovation covariance (4×4)
  K = P·H^T·S^{-1}                     ← Kalman gain (8×4)
  x = x + K·y_innov                    ← correct state
  P = (I − K·H)·P                      ← shrink uncertainty
  return stateToBbox()
```

`S^{-1}` is computed by the `_inv4()` method using Gauss-Jordan elimination with partial pivoting. If the pivot is near zero (`< 1e-12`), the identity matrix is returned as a fallback to avoid numerical explosion.

**NaN guard:** After update, if any corrected component is non-finite, the KF is reset via `init(detBbox)` with `P = eye(8) × 10` to prevent contaminating subsequent frames.

### 3.6 State Machine

```
KalmanFilter state transitions (within Track lifecycle):

init(bbox)
  └─► [Initialized — velocities = 0]
         │
         │ predict() called each frame
         ▼
  [Predicted] ──── framesWithoutHit > 1 ──► [Frozen — bbox held at last known]
         │
         │ update(detBbox) on match
         ▼
  [Updated — velocity refined by observation]
```

---

## 4. ByteTracker Design

**File:** `server/src/services/tracking.js`

### 4.1 Class Overview

```javascript
class ByteTracker {
  _tracks: Track[]           // all active + recently lost tracks
  minHits: number            // min consecutive hits before a track is reported
  highConfThreshold: number  // detections ≥ this are matched first
  lowConfThreshold:  number  // detections ≥ this but < high are matched to lost tracks
  iouThreshold:      number  // minimum score to accept a match (runtime-configurable)
  _maxAgeOverride:   number  // optional constructor override; normally from trackerConfig
  _iouThreshOverride: number // optional constructor override
}
```

### 4.2 Track State Machine

```
[New Detection]
      │
      │ unmatched high-conf det → new Track()
      ▼
  [Tracked] ──── no match in frame ──► [Lost]
      ▲                                    │
      │ match found (update())             │ framesWithoutHit > maxAge
      └──────────────────────────         ▼
                                     [Removed] ──► filtered out
```

- `Tracked`: object was matched in the current frame (`state = TrackState.Tracked`)
- `Lost`: not matched but still alive in the buffer
- `Removed`: aged out; removed from `_tracks` array

### 4.3 `update(detections)` Flow

```
update(detections):

  1. Read live config: maxAge, iouThreshold from trackerConfig (runtime-tunable)
  2. Call predict() on all existing tracks
  3. Split detections into highConf (≥ highConfThreshold) and lowConf
  4. Match highConf detections to ALL active tracks via _matchDetections()
     → returns: matchedHigh, unmatchedTracks, unmatchedHighDets
  5. Match lowConf detections to LOST tracks from unmatchedTracks
     → returns: matchedLow, stillUnmatched
  6. track.update(det) for all matched pairs
  7. Create new Track() for each unmatched high-conf detection
  8. Age out stillUnmatched tracks: framesWithoutHit > maxAge → Removed
  9. Remove dead tracks from _tracks
  10. Return tracks where state === Tracked AND hitStreak >= minHits
```

The two-pass design mirrors ByteTrack's core insight: high-confidence detections update confirmed tracks first; low-confidence detections rescue lost tracks that may still be present but weakly visible.

### 4.4 5-Cue Weighted Scoring

The `_matchDetections()` method builds a score matrix using up to 5 appearance cues:

| Cue | Similarity Function | Weight (default) | Active When |
|-----|--------------------|--------------------|-------------|
| IoU | `_iou(detBbox, trackBbox)` | 0.60 | Always |
| Face (ArcFace) | `_cosineSim(emb, emb)` | 0.20 | Both embeddings present |
| Color | `_colorSim(upperRgb, lowerRgb)` | 0.12 | Both color attrs present |
| Cloth (PAR) | `_clothSim(upper, lower)` | 0.05 | Both cloth attrs present |
| Accessories | `_accSim(hat, mask)` | 0.03 | Both accessories present |

**Dynamic normalization:** `score = weightedSum / totalWeight` (only active-cue weights counted in denominator), ensuring score ∈ [0, 1] regardless of which cues are available.

**Class guard:** `track.className !== det.className` → score = −1 (hard reject).

**Greedy matching:** Pairs sorted by score descending; highest-scoring pairs assigned first. Ensures global near-optimality without full Hungarian algorithm overhead.

**Appearance update methods:**
- `updateAppearance(objectId, embedding)` — stores ArcFace embedding with EMA smoothing (α=0.9)
- `updateColor(objectId, color)` — stores pixel-averaged RGB upper/lower
- `updateCloth(objectId, cloth)` — stores PAR cloth type classification
- `updateAccessories(objectId, accessories)` — stores hat/mask boolean flags

### 4.5 IoU Computation

```
_iou(bboxA, bboxB):
  Guards: if any component is non-finite → return 0 (prevents NaN propagation)
  Intersection: [max(ax1,bx1), max(ay1,by1)] to [min(ax2,bx2), min(ay2,by2)]
  IoU = intersection_area / (aArea + bArea − intersection_area)
```

### 4.6 Track Object Design

```javascript
class Track {
  id:               string         // UUID v4 — persists for track lifetime
  state:            TrackState     // Tracked | Lost | Removed
  age:              number         // frames since creation
  hitStreak:        number         // consecutive matched frames
  framesWithoutHit: number         // consecutive unmatched frames
  bbox:             {x,y,w,h}      // current best-estimate bbox
  className:        string         // COCO class label
  kf:               KalmanFilter   // per-track state estimator
  embedding:        Float32Array   // ArcFace 512-D embedding (EMA)
  embeddingAge:     number         // frames since last updateAppearance()
  color:            object|null    // {upper, lower, upperRgb, lowerRgb}
  cloth:            object|null    // {upper, lower, sleeve}
  accessories:      object|null    // {hat: bool, mask: bool}
}
```

---

## 5. BehaviorEngine Design

**File:** `server/src/services/behaviorEngine.js`

### 5.1 Class Overview

```javascript
class BehaviorEngine extends EventEmitter {
  _zoneManager:  ZoneManager      // shared zone config
  _state:        Map<objectId, TrackState>
  _zoneGallery:  Map<zoneId, AppearanceEntry[]>
}
```

`_state` persists across frames for each tracked object. `_zoneGallery` stores recent appearance descriptors per zone for cross-ID revisit detection.

### 5.2 Per-Object State Record

```javascript
{
  frames:            [{x, y, timestamp}]  // position history (HISTORY_CAPACITY=300)
  enteredAt:         number               // Unix ms — zone entry time
  zoneId:            string               // current zone ID
  lastLoiteringEmit: number               // Unix ms — last alert emission time
  reentryData:       null                 // reserved
  leftAt:            number|null          // Unix ms — last zone exit time
  revisitCount:      number               // number of re-entries within reentryWindow
}
```

### 5.3 `update(cameraId, trackedObjects, frameTimestamp)` Flow

```
For each trackedObject:
  1. Determine centroid (cx, cy) from bbox
  2. Find matching MONITOR zone containing centroid, with matching targetClasses
  3. If in EXCLUDE zone: clear state, push {isLoitering:false}; continue
  4. If no matching MONITOR zone: record leftAt, push {isLoitering:false}; continue
  5. Load or create per-object state entry
     a. New objectId: attempt cross-ID re-association via _checkAndEnrollAppearance()
        - Match by ArcFace cosine similarity (threshold 0.45)
        - Fallback: match by clothing color (upper + lower exact match)
        - On match: transfer prev state → seamless dwell continuation
     b. Zone changed: reset frames[], preserve revisitCount
  6. Re-entry gate: if leftAt set AND (now−leftAt)/1000 ≤ reentryWindow
     → effectiveThreshold *= 0.5; revisitCount++; clear leftAt
  7. Enroll/refresh appearance in _zoneGallery
  8. Append {x: cx, y: cy, timestamp: now} to state.frames (cap at 300)
  9. Compute metrics:
     dwellTime     = (now − enteredAt) / 1000
     velocity      = _computeVelocity(frames, window=10)
     circularScore = _circularScore(frames)
     pacingScore   = _pacingScore(frames)
     maxDisp       = max distance within 10-second sliding window
  10. isLoitering = dwellTime ≥ effectiveThreshold AND maxDisp ≤ zone.minDisplacement
  11. riskScore   = _riskScore(dwellTime, threshold, revisitCount, velocity, circ, pacing)
  12. If isLoitering AND riskScore ≥ zone.minRiskScore AND cooldown elapsed:
      emit 'loitering' event
  13. Push enriched object to result array

After loop: purge state for inactive tracks (leftAt set → evict after 5 minutes)
```

### 5.4 Metric Computation

#### Velocity (`_computeVelocity`)

```
Sliding window of last min(windowFrames=10, len) frames:
  totalDist = Σ euclidean(frame[i-1], frame[i])
  dtMs = frames[-1].timestamp - frames[0].timestamp
  velocity = (totalDist / dtMs) × 1000  (px/s)
```

Returns 0 if fewer than 2 frames available.

#### Circular Score (`_circularScore`)

```
Requires ≥ 20 frames and pathLen ≥ 10 px:
  pathLen     = Σ euclidean(frame[i-1], frame[i])   (cumulative)
  displacement = euclidean(frame[0], frame[-1])      (straight-line)
  circularScore = max(0, 1 − displacement / pathLen)

Score = 0: straight-line motion
Score = 1: perfectly circular / closed-loop motion
```

#### Pacing Score (`_pacingScore`)

```
Requires ≥ 10 frames:
  Count x-direction sign reversals (dx > 2 px threshold to filter micro-jitter)
  pacingScore = min(1, reversals / 10)

Score = 1: ≥ 10 direction reversals (back-and-forth pacing)
Score = 0: consistent directional movement
```

#### Risk Score (`_riskScore`)

```
dwellRatio   = min(dwellTime / max(threshold, 1), 2) / 2     [0, 1]
revisitRatio = min(revisitCount / 5, 1)                      [0, 1]
lowVeloRatio = max(0, 1 − velocity / 80)                     [0, 1]

riskScore = min(1,
  dwellRatio   × 0.35 +
  revisitRatio × 0.30 +
  lowVeloRatio × 0.15 +
  pacingScore  × 0.12 +
  circScore    × 0.08
)
```

The dwellRatio is capped at 2× the threshold to allow scores above 0.5 even for very long dwell, while preventing a single extreme dwell from saturating the whole score.

### 5.5 Cross-ID Revisit Detection (`_checkAndEnrollAppearance`)

When a new `objectId` first appears in a zone, the engine checks the `_zoneGallery` for a recently seen appearance that matches the same person under a different tracker ID:

```
_checkAndEnrollAppearance(zoneId, objectId, obj, now):
  1. Prune gallery entries older than EXPIRY_MS (120 s)
  2. For each existing gallery entry (different objectId, not enrolled THIS frame):
     a. ArcFace cosine similarity ≥ 0.45 → match
     b. Fallback: exact upper + lower color match → match
  3. If match found: update gallery entry's objectId to current; return prevObjectId
  4. If no match: append new entry {objectId, embedding, upperColor, lowerColor, lastSeenAt}
  5. Return null (no prior match)
```

On cross-ID re-association, the caller transfers the previous state to the new `objectId`, preserving accumulated `dwellTime`, `revisitCount`, and position history. This prevents false "new person" events when the tracker loses and re-acquires a person at short range.

### 5.6 Zone Gallery Entry Schema

```javascript
{
  objectId:   string   // current tracker UUID for this appearance
  embedding:  number[] // ArcFace 512-D embedding (or null)
  upperColor: string   // CSS color string (or null)
  lowerColor: string   // CSS color string (or null)
  lastSeenAt: number   // Unix ms — for expiry pruning
}
```

---

## 6. Zone Management Design

**Files:** `server/src/services/zoneManager.js`, `server/src/api/zones.js`

### 6.1 ZoneManager

Manages zone definitions per camera. Persists to `lts.json` via the DB layer.

**Key methods:**
- `addZone(cameraId, zoneData)` → creates zone with UUID, defaults, persists
- `updateZone(id, updates)` → partial update, invalidates cache
- `deleteZone(id)` → removes from DB and cache
- `getZonesForCamera(cameraId)` → returns all zones for a camera (cached)
- `getActiveZones(cameraId, date)` → filters by schedule (day/time window)
- `isPointInZone(x, y, zone)` → ray-casting point-in-polygon test

### 6.2 Point-in-Polygon (Ray Casting)

```
isPointInZone(x, y, zone):
  polygon = zone.polygon
  For each edge (poly[i], poly[j]):
    if (yi > y) != (yj > y):
      if x < ((xj-xi)(y-yi)/(yj-yi) + xi):
        toggle inside
  return inside
```

### 6.3 Zone Schema

```javascript
{
  id:             string         // UUID v4
  cameraId:       string         // owner camera UUID
  name:           string         // display label
  type:           'MONITOR'|'EXCLUDE'
  polygon:        [{x, y}]       // ≥ 3 vertices (pixel coords)
  dwellThreshold: number         // seconds before loitering flag
  minDisplacement: number        // max movement (px) for loitering (default 50)
  reentryWindow:  number         // seconds for re-entry bonus (default 60)
  targetClasses:  string[]       // e.g. ['person', 'vehicle']
  minRiskScore:   number         // 0–1 minimum riskScore to emit alert
  schedule:       { startTime, endTime, days: string[] } | null
  createdAt:      string         // ISO-8601
}
```

### 6.4 Zone API Router (`zones.js`)

```
GET    /api/cameras/:cameraId/zones
  → 200: { success: true, data: Zone[] }
  → 500: { success: false, error }

POST   /api/cameras/:cameraId/zones
  Body: { name, polygon, type?, dwellThreshold?, minDisplacement?, reentryWindow?, schedule? }
  Validation: name required; polygon ≥ 3 points; type must be MONITOR|EXCLUDE
  → 201: { success: true, data: Zone }
  → 400: { success: false, error: 'name and polygon...' }

PUT    /api/cameras/:cameraId/zones/:id
  Body: partial Zone fields
  → 200: { success: true, data: Zone }
  → 404: { success: false, error: 'Zone not found' }

DELETE /api/cameras/:cameraId/zones/:id
  → 200: { success: true, message: 'Zone deleted' }
  → 404: { success: false, error: 'Zone not found' }
```

### 6.5 Tracker Config API (`tracker.js`)

Runtime-tunable parameters exposed without server restart:

```
GET  /api/tracker/config
  → 200: { success: true, data: TrackerConfig }

PUT  /api/tracker/config
  Body: { iouThreshold?, maxAge?, iouWeight?, faceWeight?, colorWeight?, ... }
  → 200: { success: true, data: TrackerConfig }

POST /api/tracker/config/reset
  → 200: { success: true, data: TrackerConfig }  ← defaults restored
```

---

## 7. Data Model

### 7.1 Zone Record (DB / lts.json)

```
id             UUID v4         Primary key
cameraId       UUID v4         FK → cameras.id
name           string
type           'MONITOR'|'EXCLUDE'
polygon        JSON [{x,y}]    ≥ 3 points
dwellThreshold number          seconds (default 30)
minDisplacement number         pixels (default 50)
reentryWindow  number          seconds (default 60)
targetClasses  JSON string[]
minRiskScore   number          0–1 (default 0)
schedule       JSON | null
createdAt      ISO-8601
updatedAt      ISO-8601
```

### 7.2 In-Memory Track State (per camera, not persisted)

```javascript
// ByteTracker._tracks entry
{
  id:               UUID      // objectId
  state:            'Tracked'|'Lost'|'Removed'
  age:              number    // frames alive
  hitStreak:        number    // consecutive hits
  framesWithoutHit: number
  bbox:             {x, y, width, height}
  kf:               KalmanFilter
  embedding:        Float32Array(512)|null
  color, cloth, accessories: object|null
}

// BehaviorEngine._state entry
{
  frames:       [{x, y, timestamp}]  // max 300 entries
  enteredAt:    number
  zoneId:       string
  leftAt:       number|null
  revisitCount: number
  lastLoiteringEmit: number
}
```

### 7.3 Socket.IO Payloads

**`detections` event:**
```json
{
  "cameraId": "uuid",
  "timestamp": 1748000000000,
  "objects": [
    {
      "objectId":     "uuid",
      "bbox":         { "x": 120, "y": 80, "width": 60, "height": 150 },
      "class":        "person",
      "confidence":   0.87,
      "riskScore":    0.43,
      "dwellTime":    12.5,
      "isLoitering":  false,
      "zoneId":       "zone-uuid",
      "revisitCount": 1,
      "velocity":     15.2,
      "pacingScore":  0.3,
      "circularScore": 0.1
    }
  ]
}
```

**`loitering_alert` event:**
```json
{
  "objectId":       "uuid",
  "cameraId":       "uuid",
  "zoneId":         "zone-uuid",
  "zoneName":       "Entrance Zone",
  "dwellTime":      35.0,
  "maxDisplacement": 22.5,
  "revisitCount":   2,
  "velocity":       5.1,
  "circularScore":  0.2,
  "riskScore":      0.78,
  "bbox":           { "x": 120, "y": 80, "width": 60, "height": 150 },
  "timestamp":      1748000035000
}
```

**`detections:summary` event:**
```json
{
  "cameraId":      "uuid",
  "timestamp":     1748000000000,
  "activeCount":   5,
  "loiteringCount": 1,
  "zones": [
    { "zoneId": "uuid", "name": "Entrance", "count": 2, "loiteringCount": 1 }
  ]
}
```

---

## 8. API Design

### 8.1 Zone REST API

| Method | Endpoint | Body / Params | Success | Error |
|--------|----------|---------------|---------|-------|
| GET | `/api/cameras/:cameraId/zones` | — | `200 { data: Zone[] }` | `500` |
| POST | `/api/cameras/:cameraId/zones` | `{name, polygon, type?, ...}` | `201 { data: Zone }` | `400`, `500` |
| PUT | `/api/cameras/:cameraId/zones/:id` | partial Zone | `200 { data: Zone }` | `404`, `500` |
| DELETE | `/api/cameras/:cameraId/zones/:id` | — | `200 { message }` | `404`, `500` |

### 8.2 Tracker Config REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tracker/config` | Read current tracker configuration |
| PUT | `/api/tracker/config` | Partially update tracker configuration |
| POST | `/api/tracker/config/reset` | Restore factory defaults |

**TrackerConfig fields:**

| Field | Default | Description |
|-------|---------|-------------|
| `iouThreshold` | 0.25 | Minimum combined score for match |
| `maxAge` | 90 | Frames before lost track is removed |
| `iouWeight` | 0.60 | IoU cue weight |
| `faceWeight` | 0.20 | ArcFace cue weight |
| `colorWeight` | 0.12 | Color cue weight |
| `clothWeight` | 0.05 | Cloth type cue weight |
| `accWeight` | 0.03 | Accessories cue weight |
| `fastSpeedThreshold` | 30 | px/frame; above → larger Q |
| `slowSpeedThreshold` | 2 | px/frame; below → smaller Q |
| `fastQScale` | 4.0 | Process noise scale for fast objects |
| `slowQScale` | 0.25 | Process noise scale for slow objects |
| `measurementNoise` | 10 | R diagonal value |

---

## 9. Sequence Diagrams

### 9.1 Normal Frame Processing

```
Camera Frame     PipelineManager     ByteTracker      BehaviorEngine     Socket.IO
     │                 │                  │                  │               │
     │── JPEG buf ────►│                  │                  │               │
     │                 │── detect() ──────►│(DetectionService)│               │
     │                 │◄── detections[] ─│                  │               │
     │                 │── tracker.update(detections)        │               │
     │                 │◄── trackedObjects[] ─────────────────               │
     │                 │── attributePipeline.enrich() ─────►                 │
     │                 │◄── enriched objects ───────────────                 │
     │                 │── behavior.update(cameraId, objects, ts) ──────────►│
     │                 │◄── enrichedWithBehavior[] ──────────────────────────│
     │                 │                                    │── 'loitering'  │
     │                 │                                    │   (if triggered)│
     │                 │── emit 'detections' ───────────────────────────────►│
     │                 │── emit 'detections:summary' ───────────────────────►│
```

### 9.2 Zone Creation and Immediate Effect

```
Client               REST API (zones.js)       ZoneManager        BehaviorEngine
  │                        │                       │                    │
  │── POST /api/.../zones ─►│                       │                    │
  │                        │── zoneManager.addZone()►│                    │
  │                        │                       │── persist to DB     │
  │                        │                       │── invalidate cache  │
  │◄── 201 { zone } ───────│                       │                    │
  │                        │                       │◄── next frame:      │
  │                        │                       │   getActiveZones()  │
  │                        │                       │── new zone returned │
  │                        │                       │───────────────────►│
  │                        │                       │   zone applied in  │
  │                        │                       │   update() logic   │
```

---

## 10. Error Handling

| Scenario | Location | Behavior |
|----------|----------|----------|
| KF produces NaN/Inf on predict | `Track.predict()` | Freeze bbox at last known value; reset KF via `init()` if drift detected |
| KF produces NaN/Inf on update | `Track.update()` | Reset KF to detector bbox; reset `P = eye(8)×10` |
| IoU with non-finite bbox | `ByteTracker._iou()` | Return 0; log warning |
| Detection service unavailable | `PipelineManager` | Skip inference frame; `detections = []` |
| Zone polygon < 3 points | `zones.js` validation | HTTP 400 with descriptive error |
| Invalid zone type | `zones.js` validation | HTTP 400 `'type must be MONITOR or EXCLUDE'` |
| Zone not found on update/delete | `zones.js` | HTTP 404 |
| DB write failure | `zoneManager` / `zones.js` | HTTP 500 with error string |
| Tracker config invalid body | `tracker.js` | HTTP 400 `'Body must be a JSON object.'` |
| Frame drop (previous frame still inferring) | `PipelineManager` | Skip frame (`ctx._inferring` guard) |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Object Tracking |
