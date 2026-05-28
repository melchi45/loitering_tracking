# DESIGN DOCUMENT
# Dashboard — Full-Screen Unified Search Panel

| | |
|---|---|
| **Document ID** | Design-LTS2026-SEARCH-FS-001 |
| **Version** | 1.1 |
| **Status** | Released — amended 2026-05-27 |
| **Date** | 2026-05-27 |
| **Parent PRD** | prd/PRD_Dashboard_Search_Fullscreen.md |
| **SRS Reference** | srs/SRS_Dashboard_Search_Fullscreen.md |

---

## 1. Architecture Overview

```
SearchBar (header)
    │
    │ onFullscreen()
    ▼
App.tsx  ─── showSearchFullscreen: boolean ───► SearchFullscreen overlay (z-[300])
                                                    │
                                   ┌────────────────┴────────────────┐
                                   │                                 │
                             LeftPanel (40%)                  RightPanel (60%)
                             ─────────────                   ──────────────────
                             • search input                  • ResultDetail
                             • type filter chips               (switches on _type)
                             • date range pickers
                             • sort selector
                             • scrollable result list         DetectionDetail
                             • load-more button               AlertDetail
                             • export CSV                     FaceDetail
                                                              MatchDetail
                                                              EventDetail
```

---

## 2. Visual Layout

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  [🔍 Search: ___________________________]  [✕ Close]           Header bar       │
│  Type: [All●] [Detection] [Alert] [Face] [Match] [Event]                         │
│  Date: [2026-05-27] → [2026-05-27]   Sort: [Newest ▼]   [Export CSV]            │
├────────────────────────────────────────┬─────────────────────────────────────────┤
│  RESULTS  (247 found)                  │  ← SELECT A RESULT                      │
│ ─────────────────────────────────────  │                                         │
│ [img] DETECTION  person ● LOITER       │  (placeholder when nothing selected)    │
│        Camera 1 · Zone A · 2:34 pm     │                                         │
│ ─────────────────────────────────────  │                                         │
│ [img] ALERT  loitering                 │                                         │
│        Camera 2 · Zone B · 2:33 pm     │                                         │
│ ─────────────────────────────────────  │                                         │
│ [img] MATCH  John Doe  94.3%           │  [After selection — Detection example]  │
│        Camera 1 · 2:32 pm              │ ┌───────────────────────────────────┐   │
│ ─────────────────────────────────────  │ │        [CROP IMAGE  320×320]      │   │
│ [img] EVENT  loitering                 │ │                                   │   │
│        Camera 3 · Zone C · 2:31 pm     │ └───────────────────────────────────┘   │
│ ─────────────────────────────────────  │  ● DETECTION  person  [LOITERING]       │
│ ...                                    │  Camera 1  ·  Zone A  ·  2:34:07 pm     │
│                                        │                                         │
│ [Load More]            [Export CSV]    │  Confidence   87%  ██████████░░░         │
│                                        │  Dwell Time   142 s                     │
│                                        │  Camera       Camera 1                  │
│                                        │  Zone         Zone A                    │
│                                        │  Timestamp    2026-05-27 14:34:07       │
│                                        │  Object ID    track-42                  │
│                                        │                                         │
│                                        │  ▼ Attributes                           │
│                                        │  Face: John Doe  (score 0.91)           │
│                                        │  Mask: no_mask                          │
│                                        │  Hat:  helmet ✓                         │
└────────────────────────────────────────┴─────────────────────────────────────────┘
```

---

## 3. Component Tree

```
SearchFullscreen
├── SearchFullscreenHeader
│   ├── search <input>
│   └── <button> ✕ Close
├── SearchFullscreenFilters
│   ├── TypeChips  (All | Detection | Alert | Face | Match | Event)
│   ├── DateRangePicker (from / to)
│   └── SortSelect
├── SearchFullscreenBody
│   ├── LeftPanel
│   │   ├── ResultCountBadge
│   │   ├── ResultList (virtualized scroll)
│   │   │   └── ResultRow (reused from SearchBar, enlarged)
│   │   ├── LoadMoreButton
│   │   └── ExportCsvButton
│   └── RightPanel
│       ├── (empty state placeholder)
│       ├── DetectionDetail
│       ├── AlertDetail
│       ├── FaceDetail
│       ├── MatchDetail
│       └── EventDetail
```

---

## 4. State Management

All state is local to `SearchFullscreen` (no global store needed).

```ts
interface SearchFullscreenState {
  query:     string;          // controlled input
  types:     TypeFilter;      // 'all' | 'detection' | 'alert' | 'face' | 'match' | 'event'
  from:      string;          // ISO date string or ''
  to:        string;          // ISO date string or ''
  sort:      SortMode;        // 'newest' | 'oldest' | 'camera'
  results:   SearchResult[];  // current page accumulated
  total:     number;          // server-reported total
  offset:    number;          // current page offset
  loading:   boolean;
  error:     string | null;
  selected:  SearchResult | null;
  ackLoading: boolean;        // for alert acknowledge button
}
```

---

## 5. API Contract

### Search Request

```
GET /api/search?q=<query>&types=<types>&from=<ISO>&to=<ISO>&limit=50&offset=<n>
```

| Parameter | Description | Default |
|---|---|---|
| `q` | Search query | required |
| `types` | Comma-separated: `detections,alerts,faces,matches,events` | all |
| `from` | ISO 8601 datetime (inclusive) | none |
| `to` | ISO 8601 datetime (inclusive) | none |
| `limit` | Results per page (max 200 in fullscreen mode) | 50 |
| `offset` | Skip N results for pagination | 0 |

### Search Response

```json
{
  "query":   "loitering",
  "total":   247,
  "results": [ ... ]
}
```

The `results` array schema is unchanged from the existing search API. The `total` field reflects the unfiltered count (before `limit`/`offset`) for display.

### Alert Acknowledge

```
POST /api/alerts/:id/acknowledge
Response: { "success": true }
```

---

## 6. TypeFilter Implementation

```ts
type TypeFilter = 'all' | 'detection' | 'alert' | 'face' | 'match' | 'event';

const TYPE_TO_API: Record<TypeFilter, string> = {
  all:       'detections,alerts,faces,matches,events',
  detection: 'detections',
  alert:     'alerts',
  face:      'faces',
  match:     'matches',
  event:     'events',
};
```

Clicking a chip sets `types = TYPE_TO_API[chip]`, resets `offset = 0`, clears `results`, re-runs search.

---

## 7. Detail Panel Per Entity Type

### 7.1 Detection Detail

```
┌────────────────────────────────────────────────────────┐
│              Crop Image  (max 320px, full width)       │
└────────────────────────────────────────────────────────┘

● DETECTION  [className]  [LOITERING?]  [RISK badge]  [confidence %]

── Object Identity ─────────────────────────────────────
  Object ID      <objectId>  (truncated SHA-style hash)
  Object Hash    <md5/uuid first 8 chars>
  Confidence     [████████░░] 87%

── Position & Frame ────────────────────────────────────
  BBox           x=412, y=198, w=96, h=228  (pixels)
  Center         (460, 312)  →  54.3%, 48.7% of frame
  Frame Size     1280 × 720 px
  Crop Size      96 × 228 → 96 × 228 px (after resize)

── Behavior Metrics ────────────────────────────────────
  Dwell Time     142 s
  Velocity       12.4 px/s
  Risk Score     [████████░░] 0.82  HIGH
  Circular Score [██████░░░░] 0.61
  Pacing Score   [████░░░░░░] 0.43
  Revisit Count  3

── Location ────────────────────────────────────────────
  Zone           Zone A  (id: z-001)
  Camera         Camera 1  [●LIVE]
  Timestamp      2026-05-27 14:34:07

── Clothing ────────────────────────────────────────────
  Upper Garment  jacket
  Lower Garment  jeans
  Sleeve         long

── Color ───────────────────────────────────────────────
  Upper Color    [■] navy blue  (RGB 25, 42, 86)
  Lower Color    [■] dark gray  (RGB 60, 60, 65)

── Face Recognition ────────────────────────────────────
  Face ID        fa-001-xxxx
  Identity       John Doe
  Match Score    [█████████░] 91.3%
  Face BBox      x=430, y=200, w=45, h=55

── PPE / Mask / Hat ────────────────────────────────────
  Mask           no_mask  ✗
  Hat            hardhat  ✓ (safety compliant)

── Camera Info ─────────────────────────────────────────
  Name           Camera 1  (PNM-7082RV)
  IP             192.168.1.100
  RTSP URL       rtsp://192.168.1.100:554/...
  Status         ● LIVE

── Person Trail (cross-camera trajectory) ──────────────
  Alias          P3
  First Seen     2026-05-27 14:20:00
  Last Seen      2026-05-27 14:34:07
  Segments:
    [Camera 1] 14:20:00 → 14:22:30  (150 s)
    [Camera 2] 14:22:45 → 14:28:10  (325 s)
    [Camera 1] 14:28:30 → now...

── Cross-Camera Re-ID ──────────────────────────────────
  Camera 2 → Camera 1   sim=0.93   14:28:30
  Camera 1 → Camera 2   sim=0.89   14:22:45
```

### 7.2 Alert Detail

```
● ALERT  [type badge]  [ACK status]

┌────────────┬─────────────────────────┐
│ Camera     │ <cameraName>            │
│ Zone       │ <zoneName>              │
│ Timestamp  │ <formatted datetime>    │
│ Dwell Time │ <dwellTime> s           │
└────────────┴─────────────────────────┘

[Acknowledge ✓]  (hidden if already ack'd)

Linked Snapshot:
┌──────────────────────────────────────┐
│    [crop image from linked snapshot] │
└──────────────────────────────────────┘
```

### 7.3 Face Detail

```
┌────────────────────────────────────┐
│          Gallery Photo             │
└────────────────────────────────────┘
● FACE  [name]  [gallery badge]

┌────────────┬─────────────────────────┐
│ Name       │ <name>                  │
│ Gallery    │ <galleryName>           │
│ Type       │ <galleryType>           │
│ Notes      │ <notes>                 │
│ Added      │ <createdAt>             │
└────────────┴─────────────────────────┘

Recent Matches (last 5):
  [live crop] [gallery photo]  94.3%  Camera 1  14:34
```

### 7.4 Match Detail

```
┌───────────────────┬───────────────────┐
│  Live Crop         │  Gallery Photo    │
│  (at match time)   │  (registered)     │
└───────────────────┴───────────────────┘
● MATCH  [identity]

┌────────────┬─────────────────────────┐
│ Identity   │ <identity>              │
│ Gallery    │ <galleryType>           │
│ Score      │ [████████░░] 94.3%      │
│ Camera     │ <cameraName>            │
│ Timestamp  │ <formatted datetime>    │
└────────────┴─────────────────────────┘
```

### 7.5 Event Detail

```
● EVENT  [type badge]

┌────────────┬─────────────────────────┐
│ Type       │ <type>                  │
│ Camera     │ <cameraName>            │
│ Zone       │ <zoneName>              │
│ Class      │ <className>             │
│ Dwell Time │ <dwellTime> s           │
│ Timestamp  │ <formatted datetime>    │
│ Message    │ <message>               │
└────────────┴─────────────────────────┘
```

---

## 8. Keyboard Navigation

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection up/down in result list |
| `Enter` | Confirm selection (same as click) |
| `Escape` | Close fullscreen panel |
| `Tab` | Move focus to right panel actions |

The result list scrolls to keep the selected row visible (`scrollIntoView`).

---

## 9. Export CSV

When the user clicks **Export CSV**, the client serializes `state.results` into RFC 4180 CSV format with the following columns:

```
type, id, cameraName, className, zoneName, dwellTime, confidence, isLoitering, timestamp, name, identity, matchScore
```

The download is triggered via a `<a href="data:text/csv..." download="lts-search-YYYY-MM-DD.csv">` element created dynamically.

No server round-trip is required; the export uses already-fetched data.

---

## 10. Pagination

The fullscreen search uses cursor-based offset pagination:

1. Initial search: `offset=0, limit=50`
2. "Load More" button: `offset=results.length, limit=50`
3. Server returns up to `limit` more results starting from `offset`
4. New results are **appended** to `state.results` (not replaced)
5. "Load More" is hidden when `results.length >= total`

---

## 11. Search-as-you-type

The fullscreen input uses a **500 ms debounce** (vs. 300 ms in the compact bar) to avoid excessive API calls when the user is typing a longer query.

On debounce fire:
1. Reset `offset = 0`
2. Clear `results = []`
3. Fire `GET /api/search?...`

---

## 12. Server Changes Required

### 12.1 Add `offset` Parameter to Search API (`search.js`)

```js
const { q, types = DEFAULT_TYPES, from, to, limit = 30, offset = 0 } = req.query;
const lim = Math.min(parseInt(limit) || 30, MAX_LIMIT);
const off = Math.max(parseInt(offset) || 0, 0);

// After building full list:
const total = results.length;
const paged = results.slice(off, off + lim);
res.json({ query: q, total, results: paged });
```

### 12.2 Increase `MAX_LIMIT`

```js
const MAX_LIMIT = 200;  // was 100
```

---

## 13. Animation & Transitions

| Transition | Implementation |
|---|---|
| Overlay open | `opacity-0 → opacity-100` + `scale-[0.98] → scale-100`, 150 ms ease-out |
| Overlay close | `opacity-100 → opacity-0`, 100 ms ease-in |
| Detail panel swap | `opacity-0 → opacity-100`, 120 ms ease-out on `selected` change |
| Result row hover | `bg-gray-700/60` transition-colors 100 ms |
| Selected row | `bg-blue-900/40 border-l-2 border-blue-500` |

CSS approach: Tailwind `transition-opacity duration-150` + conditional class swap in React.

---

## 14. Responsive Behaviour

| Viewport | Layout |
|---|---|
| ≥ 1024px | Side-by-side (left 40% / right 60%) |
| 768–1023px | Stacked (results top, detail bottom) — detail hidden until result selected |
| < 768px | Single-pane: result list only; selecting a result pushes detail view (back button shown) |

---

## 15. Proposed Additional Features (v1.1 Candidates)

| Feature | Benefit | Effort |
|---|---|---|
| Saved searches (bookmark icon) | Re-run frequent queries instantly | Medium |
| Time-window quick presets (Last 1h / 24h / 7d) | Common investigative need | Low |
| Camera multi-select filter | Focus on specific cameras | Medium |
| Zone multi-select filter | Focus on specific zones | Medium |
| Highlight matched text in result rows | Faster visual scanning | Low |
| Deep link URL (`?search=loitering&types=alerts`) | Share specific queries | Medium |
| Thumbnail hover-to-enlarge | Quick image review | Low |
| Result grouping by camera | Chronological per-camera view | Medium |

---

## 16. v1.1 Amendment — Rich Detection Detail Panel

### 16.1 Additional Fields Saved in `snapshotService.js`

The snapshot record is extended to persist behavioral tracking metrics computed by `behaviorEngine.js`:

```js
// Added to record in saveSnapshot():
velocity:      det.velocity      ?? null,   // avg px/s over last 10 frames
riskScore:     det.riskScore     ?? null,   // composite 0–1 priority score
circularScore: det.circularScore ?? null,   // circular/loop movement 0–1
pacingScore:   det.pacingScore   ?? null,   // x-direction reversal rate 0–1
revisitCount:  det.revisitCount  ?? null,   // zone re-entry count
```

### 16.2 Additional Fields in Search API (`search.js`)

The `detection` search result is extended with all physical and behavioral fields:

```js
{
  _type:         'detection',
  // — existing —
  id, cameraId, cameraName, className, confidence, isLoitering,
  dwellTime, zoneName, timestamp, attributes, cropData,
  // — NEW in v1.1 —
  objectId:      s.objectId,
  zoneId:        s.zoneId,
  bbox:          s.bbox,           // { x, y, width, height } in pixels
  frameWidth:    s.frameWidth,     // original frame resolution
  frameHeight:   s.frameHeight,
  cropWidth:     s.cropWidth,      // actual crop dimensions after resize
  cropHeight:    s.cropHeight,
  velocity:      s.velocity,       // px/s (null if outside zone)
  riskScore:     s.riskScore,      // 0–1 composite risk
  circularScore: s.circularScore,  // 0–1 circular motion indicator
  pacingScore:   s.pacingScore,    // 0–1 back-and-forth pacing
  revisitCount:  s.revisitCount,   // zone re-entry count
}
```

### 16.3 New `SearchResult` Interface Fields (TypeScript)

```ts
// Added to SearchResult in useSearch.ts:
objectId?:      string | number;
zoneId?:        string;
bbox?:          { x: number; y: number; width: number; height: number };
frameWidth?:    number;
frameHeight?:   number;
cropWidth?:     number;
cropHeight?:    number;
velocity?:      number | null;
riskScore?:     number | null;
circularScore?: number | null;
pacingScore?:   number | null;
revisitCount?:  number | null;
```

### 16.4 DetectionDetail Panel Sections (v1.1)

The detection detail panel is organized into collapsible sections:

| Section | Fields | Data Source |
|---|---|---|
| Object Identity | objectId (short), className, confidence bar | search result |
| Position & Frame | bbox (x,y,w,h), center %, frame size, crop size | search result |
| Behavior Metrics | dwellTime, velocity (px/s), riskScore gauge, circularScore, pacingScore, revisitCount | search result |
| Location | zone name+id, camera name, timestamp | search result |
| Clothing | upper garment type, lower garment type, sleeve length | `attributes.cloth` |
| Color | upper/lower color name + RGB swatch | `attributes.color` |
| Face Recognition | faceId, identity, match score bar, face bbox | `attributes.face` |
| PPE (Mask/Hat) | mask status icon, hat class + helmet compliance | `attributes.mask`, `attributes.hat` |
| Camera Info | name, IP, rtspUrl, live status badge | `useCameraStore` |
| Person Trail | alias, first/last seen, per-camera segments | `usePersonTrajectoryStore` + `/api/persons/active` |
| Cross-Camera Re-ID | transition events (prev→new camera, similarity, time) | `useCrossCameraStore` |

### 16.5 Risk Score Color Coding

| Score Range | Label | Color |
|---|---|---|
| 0.00 – 0.39 | LOW | `text-green-400` |
| 0.40 – 0.69 | MEDIUM | `text-yellow-400` |
| 0.70 – 0.84 | HIGH | `text-orange-400` |
| 0.85 – 1.00 | CRITICAL | `text-red-400` |

### 16.6 Person Trail & Cross-Camera

For a detection result where `attributes.face.faceId` is present:
1. Query `usePersonTrajectoryStore` for matching `PersonTrajectory`
2. Display alias, first/last seen, and sorted `segments[]` (each showing cameraId → camera name, entryTime, exitTime)
3. Query `useCrossCameraStore` for `CrossCameraReIdEvent[]` where `faceId` matches
4. Display each transition: `prevCamera → newCamera`, similarity %, timestamp

If no faceId is present but `objectId` is available, a note is shown: "Person trail not available (no face match for this object)".

### 16.7 File Changes Summary (v1.1)

| File | Change |
|---|---|
| `server/src/services/snapshotService.js` | Save `velocity`, `riskScore`, `circularScore`, `pacingScore`, `revisitCount` |
| `server/src/api/search.js` | Return `objectId`, `zoneId`, `bbox`, `frameWidth/Height`, `cropWidth/Height`, tracking metrics |
| `client/src/hooks/useSearch.ts` | Extend `SearchResult` with all new fields |
| `client/src/components/SearchFullscreen.tsx` | Rewrite `DetectionDetail` with 11 collapsible sections |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Dashboard Search Fullscreen |
