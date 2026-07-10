# Design — Detection Snapshot Storage & Global Search

**Document ID:** Design-LTS2026-SNAP-001  
**Issue Date:** 2026-05-27  
**Module:** Detection Snapshot Storage & Global Search  
**SRS Reference:** SRS-LTS2026-SNAP-001  
**Status:** Released — v1.1 amended 2026-05-27

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  pipelineManager.js  (frame loop — step 7.5, after detections emit) │
│                                                                     │
│  for each detection in _allDets:                                    │
│    if snapshotService.shouldSave(...)                               │
│      cropBuf ← snapshotService.cropJpeg(jpegBuffer, bbox, ...)     │
│      snapshotService.saveSnapshot(db, camera, det, cropBuf, ...)   │  ← async, non-blocking
│      io.to(camera.id).emit('snapshot:new', { cropData, ... })      │
└─────────────────────────────────────────────────────────────────────┘
         │                                         │
         ▼                                         ▼
┌─────────────────┐                     ┌──────────────────────────┐
│  db.insert(     │                     │  Socket.IO room          │
│  'detectionS-  │                     │  'snapshot:new' event    │
│   napshots', …) │                     │  → DetectionPanel crops  │
└─────────────────┘                     └──────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  REST APIs                                                          │
│  GET  /api/snapshots          → list (no cropData in list)         │
│  GET  /api/snapshots/:id      → single with cropData               │
│  DELETE /api/snapshots/:id    → remove                             │
│  GET  /api/search?q=...       → unified search (snapshots+alerts+  │
│                                  faceGalleryFaces)                 │
└─────────────────────────────────────────────────────────────────────┘
         ▲                    ▲
         │                    │
┌────────────────┐  ┌────────────────────────────────────────────────┐
│ DashboardDete- │  │  SearchBar.tsx (Header)                        │
│ ctionPanel.tsx │  │  useSearch.ts hook (debounce 300ms)            │
│ crop thumbnail │  │  SearchResultsPanel.tsx                        │
└────────────────┘  └────────────────────────────────────────────────┘
```

---

## 2. New Files

### Server

```
server/src/
├── services/
│   └── snapshotService.js        ← JPEG crop + throttle + DB insert
├── api/
│   ├── snapshots.js              ← GET/DELETE /api/snapshots
│   └── search.js                 ← GET /api/search
```

### Client

```
client/src/
├── components/
│   ├── SearchBar.tsx             ← header search input + results panel
│   └── SnapshotThumb.tsx         ← reusable crop thumbnail component
├── hooks/
│   └── useSearch.ts              ← debounced fetch to /api/search
```

### Modified Files

| File | Change |
|---|---|
| `server/src/db.js` | Add `detectionSnapshots` to `ALL_TABLES` |
| `server/src/index.js` | Register `snapshotsRouter`, `searchRouter`; add `SNAPSHOT_*` env reads |
| `server/src/services/pipelineManager.js` | Hook snapshot save after step 7 (detections emit) |
| `server/.env` | Add `SNAPSHOT_*` variables |
| `client/src/components/DashboardDetectionPanel.tsx` | Subscribe `snapshot:new`; attach `cropData` to detection rows |
| `client/src/App.tsx` | Add `<SearchBar>` to header |

---

## 3. `snapshotService.js` Design

```js
'use strict';
const { v4: uuidv4 } = require('uuid');
let sharp = null;
try { sharp = require('sharp'); } catch { console.warn('[Snapshot] sharp not found — snapshots disabled'); }

const INTERVAL_SEC  = parseInt(process.env.SNAPSHOT_INTERVAL_SEC    || '30');
const MAX_DIMENSION = parseInt(process.env.SNAPSHOT_MAX_DIMENSION   || '640');  // v1.4: was 320
const JPEG_QUALITY  = parseInt(process.env.SNAPSHOT_JPEG_QUALITY    || '85');   // v1.4: was 70
const ENABLED       = process.env.SNAPSHOT_ENABLED !== 'false';

// Throttle: Map<'cameraId:objectId', lastSaveTimestamp>
const _lastSave = new Map();
// First-seen Set: Set<'cameraId:objectId'>
const _seen = new Set();

function shouldSave(cameraId, objectId, { isLoitering, hasFaceMatch, isFireSmoke, timestamp }) {
  if (!ENABLED || !sharp) return false;
  const key = `${cameraId}:${objectId}`;
  const isFirstSeen = !_seen.has(key);
  _seen.add(key);
  if (isLoitering || isFirstSeen || hasFaceMatch || isFireSmoke) return true;
  const last = _lastSave.get(key) || 0;
  return (timestamp - last) / 1000 >= INTERVAL_SEC;
}

async function cropJpeg(jpegBuffer, bbox, frameWidth, frameHeight) {
  const left   = Math.max(0, Math.round(bbox.x));
  const top    = Math.max(0, Math.round(bbox.y));
  const width  = Math.min(Math.round(bbox.width),  frameWidth  - left);
  const height = Math.min(Math.round(bbox.height), frameHeight - top);
  if (width < 4 || height < 4) throw new Error('Bbox too small');

  const img = sharp(jpegBuffer).extract({ left, top, width, height });
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    img.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true });
  }
  const buf = await img.jpeg({ quality: JPEG_QUALITY }).toBuffer();
  const meta = await sharp(buf).metadata();
  return { data: buf, width: meta.width, height: meta.height };
}

async function saveSnapshot(db, camera, det, cropBuf, cropWidth, cropHeight, timestamp) {
  const key = `${camera.id}:${det.objectId}`;
  _lastSave.set(key, timestamp);
  const attributes = {};
  if (det.color)  attributes.color = det.color;
  if (det.cloth)  attributes.cloth = det.cloth;
  if (det.face)   attributes.face  = { faceId: det.face.faceId, name: det.face.name, matchScore: det.face.matchScore };
  if (det.hat  !== undefined) attributes.hat  = det.hat;
  if (det.mask !== undefined) attributes.mask = det.mask;
  const record = {
    id:          uuidv4(),
    cameraId:    camera.id,
    cameraName:  camera.name || camera.id,
    timestamp:   new Date(timestamp).toISOString(),
    objectId:    det.objectId,
    className:   det.className,
    confidence:  det.confidence,
    bbox:        det.bbox,
    frameWidth,
    frameHeight,
    cropData:    'data:image/jpeg;base64,' + cropBuf.toString('base64'),
    cropWidth,
    cropHeight,
    attributes,
    isLoitering: det.isLoitering || false,
    dwellTime:   det.dwellTime   || 0,
    zoneId:      det.zoneId      || null,
    zoneName:    det.zoneName    || null,
  };
  db.insert('detectionSnapshots', record);
}

function pruneOldSnapshots(db, maxPerCameraDay = 500) { /* ... */ }
```

---

## 4. `pipelineManager.js` Hook

Inserted **after** step 7 (`emit('detections', ...)`) and before `ctx._inferring = false`:

```js
// 8. Save detection snapshots (non-blocking)
if (snapshotSvc.isEnabled()) {
  setImmediate(async () => {
    for (const det of _allDets) {
      try {
        const hasFaceMatch = !!(det.face?.matchScore > 0);
        const isFireSmoke  = det.className === 'fire' || det.className === 'smoke';
        if (!snapshotSvc.shouldSave(camera.id, det.objectId, {
              isLoitering: det.isLoitering, hasFaceMatch, isFireSmoke, timestamp })) continue;
        const { data: cropBuf, width: cw, height: ch } =
          await snapshotSvc.cropJpeg(jpegBuffer, det.bbox, frameWidth, frameHeight);
        await snapshotSvc.saveSnapshot(db, camera, det, cropBuf, cw, ch, timestamp);
        this._io.to(camera.id).emit('snapshot:new', {
          cameraId:   camera.id,
          snapshotId: null, // populated by insert callback if needed
          objectId:   det.objectId,
          className:  det.className,
          timestamp,
          cropData:   'data:image/jpeg;base64,' + cropBuf.toString('base64'),
        });
      } catch (e) {
        // ignore per-detection crop errors
      }
    }
  });
}
```

---

## 5. REST API: `snapshots.js`

```js
router.get('/', (req, res) => {
  // Parse query params, filter in-memory db.all('detectionSnapshots'),
  // strip cropData from list, paginate, return
});
router.get('/:id', (req, res) => {
  // db.findOne includes cropData
});
router.delete('/:id', (req, res) => {
  // db.delete
});
```

---

## 6. REST API: `search.js`

```js
router.get('/', (req, res) => {
  const { q, types = 'alerts,detections,faces', from, to, limit = 30 } = req.query;
  // 1. Parse type list
  // 2. For each type: filter, text-match q (case-insensitive substring), join snapshot cropData
  // 3. Merge results, sort by timestamp DESC, return
});
```

---

## 7. Client: `SearchBar.tsx`

```tsx
// State: query (string), results (SearchResult[]), open (bool)
// On input change (debounced 300ms): fetch('/api/search?q=...')
// Render: input + results panel (absolute, z-50)
// Each result: <SnapshotThumb cropData> + metadata + type badge
// onClick: dispatch navigation to correct tab
```

---

## 8. Client: `DashboardDetectionPanel.tsx` Changes

```tsx
// Add to component:
const [cropMap, setCropMap] = useState<Record<string, string>>({}); 
// key: `${cameraId}:${objectId}` → cropData

// Socket.IO subscription (in useEffect):
socket.on('snapshot:new', ({ cameraId, objectId, cropData }) => {
  setCropMap(prev => ({ ...prev, [`${cameraId}:${objectId}`]: cropData }));
});

// In detection row rendering:
const crop = cropMap[`${det._cameraId}:${det.objectId}`];
{crop && <SnapshotThumb cropData={crop} className="w-10 h-14 flex-shrink-0 rounded" />}
```

---

## 9. Sequence Diagram

```
Frame arrives
    │
    ├─ detect() → bbox list
    ├─ track() → trackedObjects
    ├─ enrich() → attrObjects
    ├─ behavior() → enrichedObjects
    ├─ emit('detections') → browser
    │
    └─ setImmediate: for each det in _allDets
          shouldSave()? ──NO──▶ skip
              │ YES
          cropJpeg() ──error──▶ log, skip
              │ OK
          saveSnapshot() → db.insert('detectionSnapshots')
              │
          io.emit('snapshot:new', {cropData}) → browser
              │
          DashboardDetectionPanel: cropMap updated
              │
          Detection row shows thumbnail
```

---

## 10. DB Changes

```js
// server/src/db.js
const ALL_TABLES = [
  'cameras', 'zones', 'events', 'alerts',
  'faceGalleries', 'faceGalleryFaces', 'settings',
  'detectionSnapshots',   // ← NEW
  'faceMatchHistory',     // ← NEW (Face ID v1.1)
];
```

---

## 11. v1.1 Amendment — DB Persistence Hardening & Search Improvements

### 11.1 Background

During live operations, `persistJson()` was being called on every `db.insert()` invocation, writing the entire store (including base64 JPEG crop data) synchronously to disk. With 6,000+ `detectionSnapshots` records this produced a 36+ MB file per write cycle, leading to two risks:
1. **Event-loop blocking**: a 36 MB synchronous `writeFileSync` on every detection frame.
2. **File corruption on crash**: if the process was killed mid-write, `lts.json` became unparseable JSON; on next startup `loadFromJson()` silently ignored the error and the store started empty — all data appeared lost.

### 11.2 `persistJson` Redesign (db.js)

#### Atomic Write (temp → rename)

```js
const TEMP_DB_PATH = DB_PATH + '.tmp';

function _flushJson() {
  try {
    fs.writeFileSync(TEMP_DB_PATH, JSON.stringify(store, null, 2));
    fs.renameSync(TEMP_DB_PATH, DB_PATH);   // atomic on POSIX
  } catch (err) {
    console.error('[DB] JSON persist error:', err.message);
    try { if (fs.existsSync(TEMP_DB_PATH)) fs.unlinkSync(TEMP_DB_PATH); } catch (_) {}
  }
}
```

`fs.renameSync` is atomic on POSIX file systems: the destination file is replaced atomically. On crash, either the old file or the complete new file exists — never a partial write.

#### Write Debounce (max once per 2 s)

```js
const PERSIST_DEBOUNCE_MS = 2000;
let _persistTimer = null;

function persistJson() {
  _persistPending = true;
  if (_persistTimer) return;           // already scheduled
  _persistTimer = setTimeout(() => {
    _persistTimer  = null;
    _persistPending = false;
    _flushJson();
  }, PERSIST_DEBOUNCE_MS);
}
```

Any number of `db.insert()` / `db.update()` calls within a 2-second window results in exactly one file write.

#### Graceful Shutdown Flush

```js
// index.js — in shutdown handler
flushNow();   // flush any pending debounced write before closing

// db.js
function flushNow() {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  if (_persistPending) { _persistPending = false; _flushJson(); }
}
module.exports = { initDB, getDB, getStorageMode, flushNow };
```

`flushNow()` is called before `httpServer.close()` in both `SIGTERM` and `SIGINT` handlers to guarantee pending data is written on graceful shutdown.

### 11.3 Search API Improvements (search.js)

#### `events` Table Search (new `types=events`)

Added `events` to the default search types and implemented a new search branch:

```js
const DEFAULT_TYPES = 'alerts,detections,faces,events';  // ← added 'events'

if (typeSet.has('events')) {
  let events = db.all('events');
  events = events.filter(e =>
    (e.type      || '').toLowerCase().includes(ql) ||
    (e.cameraName || e.camera || '').toLowerCase().includes(ql) ||
    (e.className || '').toLowerCase().includes(ql) ||
    (e.zoneName  || e.zone || '').toLowerCase().includes(ql) ||
    (e.message   || '').toLowerCase().includes(ql)
  );
  // ... map to { _type: 'event', ... }
}
```

#### `isLoitering` Keyword Search

```js
// Before (v1.0):
snaps = snaps.filter(s =>
  (s.className  || '').toLowerCase().includes(ql) || ...
);

// After (v1.1):
snaps = snaps.filter(s =>
  (s.className  || '').toLowerCase().includes(ql) || ...
  || (ql === 'loitering' && s.isLoitering === true)  // ← NEW
);
```

Querying `q=loitering` now returns all `detectionSnapshots` where `isLoitering=true`, regardless of `className`.

#### Timestamp-Agnostic Sort

```js
// Before (v1.0) — breaks when timestamp is a Unix ms number:
return tb.localeCompare(ta);  // TypeError if ta/tb is number

// After (v1.1):
const ta = new Date(a.timestamp || a.createdAt || 0).getTime();
const tb = new Date(b.timestamp || b.createdAt || 0).getTime();
return tb - ta;
```

Applied to the final results sort, alerts sort, and events sort.

---

## 12. SearchFullscreen — Type Filter Chips (v1.2)

### 12.1 Overview

The top filter bar in `SearchFullscreen.tsx` has 6 type filter chips (buttons).  
Each button has a `title` attribute (native browser tooltip) applied, showing a feature description on mouse hover.

### 12.2 Filter Chip Definitions

| Key | Label | Color | Tooltip | API `types` value |
|---|---|---|---|---|
| `all` | All | gray | Displays all result types — searches Detections, Alerts, Faces, Matches, and Events all at once. | `detections,alerts,faces,matches,events` |
| `detection` | Detection | blue | Snapshots of objects detected by AI (people, vehicles, etc.). Includes dwell time, risk score, clothing, and color analysis. | `detections` |
| `alert` | Alert | red | Alerts triggered when the loitering threshold is exceeded. Unacknowledged alerts are shown first; includes camera, zone, and dwell time info. | `alerts` |
| `face` | Face | purple | Searches persons enrolled in the face gallery. Can be filtered by gallery category such as missing persons, suspects, or authorized personnel. | `faces` |
| `match` | Match | cyan | Events where a registered person was matched via real-time face recognition. Displays similarity score (%) and the face crop image at detection time. | `matches` |
| `event` | Event | amber | Searches loitering event records. Includes zone entry/exit times, total dwell time, and camera movement path information. | `events` |

### 12.3 Implementation

```tsx
// SearchFullscreen.tsx
const TYPE_CHIPS: { key: TypeFilter; label: string; color: string; tooltip: string }[] = [
  { key: 'all',       label: 'All',       color: 'bg-gray-600 text-gray-200',
    tooltip: 'Displays all result types — searches Detections, Alerts, Faces, Matches, and Events all at once.' },
  { key: 'detection', label: 'Detection', color: 'bg-blue-700 text-blue-100',
    tooltip: 'Snapshots of objects detected by AI (people, vehicles, etc.). Includes dwell time, risk score, clothing, and color analysis.' },
  { key: 'alert',     label: 'Alert',     color: 'bg-red-700 text-red-100',
    tooltip: 'Alerts triggered when the loitering threshold is exceeded. Unacknowledged alerts are shown first; includes camera, zone, and dwell time info.' },
  { key: 'face',      label: 'Face',      color: 'bg-purple-700 text-purple-100',
    tooltip: 'Searches persons enrolled in the face gallery. Can be filtered by gallery category such as missing persons, suspects, or authorized personnel.' },
  { key: 'match',     label: 'Match',     color: 'bg-cyan-700 text-cyan-100',
    tooltip: 'Events where a registered person was matched via real-time face recognition. Displays similarity score (%) and the face crop image at detection time.' },
  { key: 'event',     label: 'Event',     color: 'bg-amber-700 text-amber-100',
    tooltip: 'Searches loitering event records. Includes zone entry/exit times, total dwell time, and camera movement path information.' },
];
```

Add `title={chip.tooltip}` to button rendering:

```tsx
<button
  key={chip.key}
  onClick={() => setTypeFilter(chip.key)}
  title={chip.tooltip}
  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
    typeFilter === chip.key
      ? chip.color + ' ring-1 ring-white/30'
      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
  }`}
>
  {chip.label}
</button>
```

### 12.4 API Mapping

The selected chip key is converted to the `/api/search?types=...` parameter via the `TYPE_TO_API` map:

```tsx
const TYPE_TO_API: Record<TypeFilter, string> = {
  all:       'detections,alerts,faces,matches,events',
  detection: 'detections',
  alert:     'alerts',
  face:      'faces',
  match:     'matches',
  event:     'events',
};
```

---

## 13. v1.3 Amendment — Confidence Range Filter

**Revision:** v1.3 · 2026-05-27

### 13.1 Server: `search.js` Changes

#### Parameter Parsing

```js
const {
  q, types = DEFAULT_TYPES, from, to,
  limit = 30, offset = 0,
  minConfidence, maxConfidence,        // ← NEW
} = req.query;

const minConf = (minConfidence !== undefined) ? parseFloat(minConfidence) : 0.0;
const maxConf = (maxConfidence !== undefined) ? parseFloat(maxConfidence) : 1.0;

// Validation
if (!isNaN(minConf) && !isNaN(maxConf) && minConf > maxConf) {
  return res.status(400).json({ success: false, error: 'minConfidence must be ≤ maxConfidence' });
}
```

#### Detection Snapshots Filter Insertion Point

    Insert after text filter (`snaps = snaps.filter(...)`) and before sort:

```js
// Confidence range filter (detections only)
if (minConf > 0 || maxConf < 1) {
  snaps = snaps.filter(s => {
    const c = s.confidence ?? 1.0;   // pass if no confidence
    return c >= minConf && c <= maxConf;
  });
}
```

### 13.2 Client: `useSearch.ts` Changes

```ts
interface SearchOptions {
  q: string;
  types?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  minConfidence?: number;   // ← NEW (0.0–1.0)
  maxConfidence?: number;   // ← NEW (0.0–1.0)
}
```

URL serialization:

```ts
if (opts.minConfidence != null && opts.minConfidence > 0)
  params.set('minConfidence', String(opts.minConfidence));
if (opts.maxConfidence != null && opts.maxConfidence < 1)
  params.set('maxConfidence', String(opts.maxConfidence));
```

### 13.3 Client: `SearchFullscreen.tsx` UI

Add Confidence Range input to header row:

```
[Min %] [──────] [Max %]
```

- State: `confMin: number = 0`, `confMax: number = 100` (integer percent)
- API transmission: `minConfidence = confMin / 100`, `maxConfidence = confMax / 100`
- Omit parameters if `confMin === 0 && confMax === 100`
- On input change, reset `offset=0` + debounced 500 ms search re-run
- Visual display: `Min: xx% – Max: xx%` label, highlighted (blue border) when non-default

### 13.4 Scope of Application

| Type | Filter Applied |
|---|---|
| `detection` | ✅ filtered by `confidence` field |
| `alert` | ❌ excluded |
| `face` | ❌ excluded |
| `match` | ❌ excluded (`matchScore` separate) |
| `event` | ❌ excluded |

---

## 14. v1.4 Amendment — Crop Quality Defaults & Detail-View Rendering

**Revision:** v1.4 · 2026-07-09

### 14.1 Background

`snapshotService.cropJpeg()` (server/src/services/snapshotService.js) capped every stored crop at 320×320 px, JPEG quality 70. This is the single source image consumed by every crop consumer in the app (Detections tab thumbnail, Detections timeline filmstrip, detail panel, header search results). At 320px/q70 the crop is visibly softer/blockier than the source video, most noticeable when a user enlarges a crop to inspect it.

### 14.2 Server Change

`server/src/services/snapshotService.js` L33-34 defaults raised:

```js
const MAX_DIM      = parseInt(process.env.SNAPSHOT_MAX_DIMENSION || '640', 10);  // was 320
const JPEG_QUALITY  = parseInt(process.env.SNAPSHOT_JPEG_QUALITY  || '85',  10);  // was 70
```

`cropJpeg()` itself is unchanged — `fit: 'inside'` already preserves aspect ratio and `withoutEnlargement: true` already prevents upscaling small crops, so no distortion is introduced by the higher cap. Typical crop size grows from ~15-25 KB to ~40-80 KB (still well under the revised NFR-SNAP-02 ceiling of 200 KB).

Both values remain overridable via `.env` (`SNAPSHOT_MAX_DIMENSION`, `SNAPSHOT_JPEG_QUALITY`) for deployments that need to trade quality for storage.

### 14.3 Client Change — Detail-View `object-contain`

`client/src/components/DetectionsTimelineInline.tsx` previously rendered every crop — including the enlarged "zoomed snapshot" preview and the detail-panel thumbnail grid — with `object-cover` inside a fixed-height box (`maxHeight: 120` / `height: 52`). Because saved person crops are typically portrait (taller than wide), `object-cover` cropped the top/bottom of the image to fill the fixed box, hiding part of the captured region.

Fix: the zoomed-snapshot `<img>` now sets `style.aspectRatio` from the snapshot's own `cropWidth`/`cropHeight` (falling back to `1/1` if absent) and uses `object-contain` with a `maxHeight: 260` safety cap — the box height follows the crop's real proportions instead of a fixed value, and `object-contain` guarantees no part of the image is ever clipped even if the cap is hit. The thumbnail grid keeps its fixed 52px cell (grid uniformity) but also switched `object-cover` → `object-contain` with a `bg-black` letterbox background so no cropping occurs there either.

See `Design_Fullscreen_Camera_View.md` for the full before/after layout of the Detections timeline detail panel.

---

## 15. v1.5 Correction — The Real Upstream Bottleneck Is `AI_MAX_WIDTH`, Not `SNAPSHOT_MAX_DIMENSION`

**Revision:** v1.5 · 2026-07-09

### 15.1 Background

§14 raised `SNAPSHOT_MAX_DIMENSION`/`SNAPSHOT_JPEG_QUALITY` (the crop-step's own resize/quality ceiling) but this alone does not fix crop quality for most deployments. Further investigation traced the actual bottleneck one layer upstream: `ingest_daemon.py`'s AI thread (`push_jpeg()`) resizes every frame to at most `AI_MAX_WIDTH` (env, default `640`) **before** that JPEG ever reaches Node.js:

```python
# ingest-daemon/ingest_daemon.py
img = _resize_frame(img, AI_MAX_WIDTH)   # default 640
buf = io.BytesIO()
img.save(buf, format="JPEG", quality=JPEG_QUALITY)
```

This resized JPEG (`jpegBuffer` in `pipelineManager.js`'s `capture.on('frame', ...)` handler) is the **single source buffer** used for both:
1. YOLO inference input (`detection.js`, which internally letterboxes to 640×640 regardless of input size — so this part is unaffected by `AI_MAX_WIDTH`)
2. `snapshotService.cropJpeg()` — the crop is extracted directly from this same buffer, in all three server modes (combined/analysis local inference at pipelineManager.js L1107-1122, and streaming mode's `_processRemoteResult` at L1719-1958, which reuses `frame.buf` — the identical buffer sent to the remote analysis server, never a higher-resolution original)

Consequence: with the package default `AI_MAX_WIDTH=640`, a 16:9 camera's frame is already downscaled to roughly 640×360 **before** `cropJpeg()` runs. Raising `SNAPSHOT_MAX_DIMENSION` past that point (§14 raised it to 640) cannot recover detail that was already discarded — `fit: 'inside', withoutEnlargement: true` means the resize step becomes a no-op once the source is already smaller than the target.

### 15.2 Fix

`server/.env` (+ all three `.env.*.example` templates): `AI_MAX_WIDTH` raised `640` → `1920`.

`_resize_frame()` only downscales when `img.width > max_width`, so `AI_MAX_WIDTH=1920` passes through any camera at or below 1080p **unmodified** (no resize, no quality loss from this stage at all), while still bounding pathological 4K+ sources. No application code changes were needed — `detection.js`'s letterbox preprocessing and bbox scale-back (`_postprocess`, `origW`/`origH`) already handle arbitrary input resolutions correctly.

**Trade-off:** raising `AI_MAX_WIDTH` increases ingest-daemon PIL resize/encode CPU, the `/api/internal/frame/:cameraId` HTTP payload size, and Node.js JPEG-decode CPU — proportional to camera count × FPS (~10 fps/camera). GPU/ONNX inference time is unaffected (the tensor is always 640×640). Deployments with many concurrent cameras or a network hop between ingest-daemon and the Node.js host should verify headroom before adopting `1920`, or keep a lower value and accept the §14 fix as a partial improvement only.

Full operator-facing guidance: `Design_RTSP_Capture_Backend.md` §9.1, `docs/ops/RTSP_Capture_Backend_Setup.md` "AI 프레임 해상도 튜닝".

### 15.3 Corrected Understanding of §14

§14's `SNAPSHOT_MAX_DIMENSION=640`/`SNAPSHOT_JPEG_QUALITY=85` change remains valid and still improves quality for crops smaller than the (now larger) `AI_MAX_WIDTH` source frame — it is not superseded, just insufficient alone. Both settings must be raised together for the fix to reach its intended effect.

---

## 16. v1.6 Superseding Fix — Decouple Analysis-Server Bandwidth From Crop Resolution

**Revision:** v1.6 · 2026-07-09

### 16.1 Why §15's Fix Was Replaced

§15's "raise `AI_MAX_WIDTH`" fix works, but it couples two unrelated concerns: crop fidelity and the bandwidth/CPU cost of the streaming→analysis-server HTTP hop. Raising `AI_MAX_WIDTH` to get better crops also makes every frame forwarded to the (possibly remote) analysis server bigger, at ~10 fps per camera — undesirable for deployments where that hop is bandwidth- or CPU-constrained. This amendment replaces §15's config-only fix with a code-level change that gets full-resolution crops **without** growing the analysis-server payload.

### 16.2 Architecture

```
ingest_daemon.py  push_jpeg()
    │  no resize — always native/decoded resolution
    ▼
Node.js  capture.on('frame', jpegBuffer)      ← single source buffer, all modes
    │
    ├─ combined / analysis mode (local inference)
    │     detection.js processes jpegBuffer directly; letterboxes internally to
    │     640×640 for the model, then _postprocess() scales bbox back to the
    │     buffer's own origW/origH. snapshotService.cropJpeg() crops that same
    │     native buffer — correct and full-resolution with ZERO extra code.
    │
    └─ streaming mode
          ctx._pendingFrame.buf = jpegBuffer   (native — retained for crop)
          _downscaleForAnalysis(buf, AI_MAX_WIDTH)  → analysisBuf (sharp, aspect-preserving)
              │
              ▼
          analysisClient.analyzeFrame({ jpegBuffer: analysisBuf, ... })  → remote analysis server
              │
              ▼  result.frameWidth/frameHeight = analysisBuf's own dimensions; bbox in that coordinate space
          _processRemoteResult(frame, result, ...)
              │  frame.buf = native buffer (unchanged)
              │  remoteFrameWidth/Height = result.frameWidth/Height (downscaled coordinate space)
              │  frame.fw/fh = native dimensions
              ▼
          cropBbox = _scaleBbox(det.bbox, remoteFrameWidth, remoteFrameHeight, frame.fw, frame.fh)
          snapshotSvc.cropJpeg(frame.buf, cropBbox, frame.fw, frame.fh)   ← full-resolution crop
```

### 16.3 Code Changes

- **`ingest-daemon/ingest_daemon.py`**: removed `_resize_frame()` and the `AI_MAX_WIDTH` env read entirely. `push_jpeg()` now always sends the native decoded frame.
- **`server/src/services/pipelineManager.js`**:
  - New `_downscaleForAnalysis(jpegBuffer, maxWidth)` — lazy-loads `sharp` (same optional-dependency pattern as `snapshotService.js`), resizes aspect-preserving, no-op if already ≤ `maxWidth` or `sharp` unavailable.
  - New `_scaleBbox(bbox, fromW, fromH, toW, toH)` — proportional bbox scaling between two coordinate spaces; returns the bbox unchanged if either dimension is falsy or scale is 1:1.
  - `_AI_MAX_WIDTH = parseInt(process.env.AI_MAX_WIDTH || '640', 10)` — now read by Node.js, not the Python daemon.
  - `_runPendingAnalysis()`: downscales a copy via `_downscaleForAnalysis()` immediately before `analysisClient.analyzeFrame()`; `ctx._pendingFrame.buf` (native) is untouched and still passed through to `_processRemoteResult()`.
  - `_processRemoteResult()`: both crop call sites (pending face-match live crop, and the general `detectionSnapshots` save loop) now compute `cropBbox = _scaleBbox(bbox, remoteFrameWidth, remoteFrameHeight, _fw, _fh)` and crop `_buf` (native) at `_fw`×`_fh` instead of the previous `remoteFrameWidth`×`remoteFrameHeight`. ~~The `detections` Socket.IO event emitted to the browser is unchanged~~ **— corrected in §17: this event also needed the same rescale, see below.**
- **`server/.env` + all three `.env.*.example` templates**: `AI_MAX_WIDTH` reverted `1920` → `640` (its role changed — it no longer bounds the ingest-daemon→Node.js hop, only the streaming→analysis-server hop) with rewritten comments.

### 16.4 Trade-offs

- **Analysis-server hop**: unchanged from before §15 — still bounded by `AI_MAX_WIDTH` (default 640), independent of crop quality.
- **ingest-daemon → Node.js hop**: now always native resolution. For most IP cameras (≤1080p) this is a modest increase over the old 640-capped default; for 4K+ cameras it is proportionally larger. This hop is typically LAN-local (ingest-daemon and Node.js on the same host or same network segment), unlike the analysis-server hop which may cross a WAN.
- **`!ctx.useWebRTC` cameras** (raw JPEG frames pushed to the browser via Socket.IO `'frame'`, used when WebRTC is disabled for that camera): these now also receive native-resolution JPEGs at ~10 fps, since they share the same source buffer. This is a genuine bandwidth increase for that specific fallback path; most cameras use WebRTC and are unaffected.
- **combined/analysis mode**: `detection.js`'s JPEG decode + letterbox now processes a larger native buffer instead of the old 640-capped one — a modest CPU increase per frame, offset by no longer needing any workaround.
- GPU/ONNX inference time is unaffected either way (input tensor is always 640×640).

### 16.5 §15 Amendment Status

§15's "raise `AI_MAX_WIDTH` to 1920" is superseded by this amendment and should **not** be applied — `AI_MAX_WIDTH` has reverted to `640` with a different meaning (§16.3). §14's `SNAPSHOT_MAX_DIMENSION`/`SNAPSHOT_JPEG_QUALITY` change remains valid and unaffected.

---

## 17. v1.7 Correction — Live Bbox Overlay Flicker

**Revision:** v1.7 · 2026-07-10

### 17.1 Bug Report

§16.3 asserted that leaving the `detections` Socket.IO event's bbox/`frameWidth`/`frameHeight` unscaled (still in the analysis server's downscaled coordinate space) was safe, reasoning that `CameraView.tsx` treats `frameWidth`/`frameHeight` as an abstract normalized coordinate space independent of actual video resolution. In practice, streaming-mode users observed the live bbox overlay **alternating between two different scales/positions** on every update — correct once, wrong once, repeating.

### 17.2 Root Cause

`client/src/hooks/useCamera.ts` listens to two independent Socket.IO events and both write to the **same** `frameWidth`/`frameHeight` React state:

```typescript
// useCamera.ts
const handleFrame = (event: FrameEvent) => {
  // ...
  if (event.frameWidth && event.frameHeight) {
    setFrameWidth(event.frameWidth);   // ← native resolution (§16, FR-SNAP-032)
    setFrameHeight(event.frameHeight);
  }
};

const handleDetections = (event: DetectionsEvent) => {
  // ...
  if (event.frameWidth && event.frameHeight) {
    setFrameWidth(event.frameWidth);   // ← was: downscaled analysis resolution
    setFrameHeight(event.frameHeight);
  }
};
```

`§16.3`'s reasoning ("`CameraView.tsx` treats this as a normalized coordinate space") only holds when **exactly one** event drives `frameWidth`/`frameHeight` for a given camera. Once ingest-daemon started sending native-resolution frames (§16), the `'frame'` event (native) and `'detections'` event (downscaled, streaming mode only) began reporting **different absolute values** for the same camera — and because `detections`' `bbox` values are only valid relative to the downscaled space, whichever event fired last determined whether the currently-displayed bbox was interpreted in the right coordinate space or not. This race is specific to `SERVER_MODE=streaming` cameras with `webrtcEnabled=false` (the raw-JPEG `'frame'`-event display path flagged as a bandwidth trade-off in §16.4) — combined/analysis mode was never affected, since both events there already shared one native buffer.

### 17.3 Fix

`_processRemoteResult()` now builds a separate `clientDetections` array for the Socket.IO emit, rescaling every `bbox` (and nested `face.bbox`) from `remoteFrameWidth`/`remoteFrameHeight` to `_fw`/`_fh` (native) via the same `_scaleBbox()` used for cropping, and emits `frameWidth: _fw, frameHeight: _fh` instead of `remoteFrameWidth`/`remoteFrameHeight`:

```js
const clientDetections = allDetections.map(det => ({
  ...det,
  bbox: _scaleBbox(det.bbox, remoteFrameWidth, remoteFrameHeight, _fw, _fh),
  ...(det.face ? { face: { ...det.face, bbox: _scaleBbox(det.face.bbox, remoteFrameWidth, remoteFrameHeight, _fw, _fh) } } : {}),
}));

this._io.to(_cameraId).emit('detections', {
  cameraId: _cameraId, frameId: _frameId, timestamp: _ts,
  detections: clientDetections,
  frameWidth: _fw, frameHeight: _fh,
});
```

The original (unscaled) `allDetections` array is left untouched for the crop loop and `_trackMeta` bookkeeping that follow — only the client-facing payload is rescaled. No client-side change was needed: with both events now reporting the same (native) coordinate space, `useCamera.ts`'s dual-write pattern is safe again.

### 17.4 Why Not Fix `useCamera.ts` Instead

An alternative fix would have been to stop `handleFrame` from updating `frameWidth`/`frameHeight` at all, leaving only `handleDetections` as the source of truth. This was rejected: `ZoneEditor` and `ThermalOverlay` also consume `frameWidth`/`frameHeight` from `useCamera()`, and when AI is disabled for a camera (`ctx.aiEnabled === false`), **no `detections` event is ever emitted** — so `frameWidth`/`frameHeight` would be stuck at the hook's hardcoded fallback (640×640) for the lifetime of that camera's session, breaking zone editing and thermal calibration whenever AI is off. Fixing the server-side emit instead keeps both events valid, general-purpose sources of truth in every configuration.

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Detection Snapshot Search |
| 1.4 | 2026-07-09 | LTS Engineering Team | §14 amendment — crop quality defaults raised (640×640/q85), detail-view object-contain fix |
| 1.5 | 2026-07-09 | LTS Engineering Team | §15 correction — real bottleneck identified as `AI_MAX_WIDTH` (ingest_daemon.py), the crop's actual source buffer; raised 640→1920 |
| 1.6 | 2026-07-09 | LTS Engineering Team | §16 supersedes §15 — code-level fix: ingest_daemon.py sends native resolution always; `pipelineManager.js` downscales only the streaming→analysis-server copy and rescales bbox back to native before cropping; `AI_MAX_WIDTH` reverted to 640 with new meaning |
| 1.7 | 2026-07-10 | LTS Engineering Team | §17 correction — fixed live bbox overlay flicker (§16.3's "detections event left unscaled" claim was wrong in practice); `detections` Socket.IO emit now rescales bbox/frameWidth to native, matching the `frame` event |
