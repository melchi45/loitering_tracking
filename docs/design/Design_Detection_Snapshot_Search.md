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
const MAX_DIMENSION = parseInt(process.env.SNAPSHOT_MAX_DIMENSION   || '320');
const JPEG_QUALITY  = parseInt(process.env.SNAPSHOT_JPEG_QUALITY    || '70');
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

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Detection Snapshot Search |
