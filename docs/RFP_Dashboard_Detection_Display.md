# RFP: Detection Visualization & Display Module

**Document No.**: LTS-2026-003
**Version**: 2.4
**Date**: 2026-05-20
**Classification**: Technical Requirements Specification (RFP)
**Status**: Updated to v2.4 — Video Analytics moved to Dashboard sidebar 4th tab (alongside Cameras/Alerts/Zones); Fullscreen view is now 2-column (left DetectionPanel + right video only); cloth attribute (PAR) display added

---

## 1. Overview

### 1.1 Purpose

This document defines the technical requirements for the **Detection Visualization & Display Module** of the Loitering Detection & Tracking System (LTS). It covers the canvas overlay that renders real-time object detections on live video streams, the detection list panel, the legend display, and the Video Analytics tab. The document has been updated from v1.0 to accurately reflect the Phase-1 implementation as of 2026-05-18.

### 1.2 Scope

- Camera view canvas overlay (bounding boxes, labels, attribute badges)
- Fullscreen view detection panel (left side panel with two tabs)
- Detection legend (color code reference)
- Video Analytics tab (module enable/disable toggles)
- Socket.IO real-time data reception and rendering

---

## 2. Detection Classes and Color Code Standard

### 2.1 People / Vehicles

✅ Phase-1 Complete — all colors implemented exactly as specified below.

| Class | Color | HEX | Canvas RGBA | Description |
|-------|-------|-----|-------------|-------------|
| `person` | Green | `#22c55e` | `rgba(34,197,94,0.9)` | General person |
| `bicycle` | Yellow | `#facc15` | `rgba(250,204,21,0.9)` | Bicycle |
| `car` | Blue | `#3b82f6` | `rgba(59,130,246,0.9)` | Car |
| `motorcycle` | Orange | `#f97316` | `rgba(249,115,22,0.9)` | Motorcycle |
| `bus` | Purple | `#a855f7` | `rgba(168,85,247,0.9)` | Bus |
| `truck` | Teal | `#14b8a6` | `rgba(20,184,166,0.9)` | Truck |

### 2.2 Face Class

✅ Phase-1 Complete — `face` is a **first-class detection type** emitted as a standalone object from SCRFD.

| Class | Color | Canvas RGBA | Box Style | Description |
|-------|-------|-------------|-----------|-------------|
| `face` | Light Blue | `rgba(147,197,253,0.95)` | 1.5px dashed `[4,3]` + very light fill `rgba(147,197,253,0.08)` | SCRFD standalone face detection |

> **Note (v2.0):** The original RFP (Section 3.4) documented the face bbox as a sub-box drawn *inside* the person bounding box using a `[3,2]` dash pattern. The actual implementation draws `face` detections as **independent top-level detection objects** emitted by PipelineManager alongside person/vehicle detections. The dashed box style and light-blue color apply to the standalone face detection's own bounding box. The `[4,3]` dash pattern is used (not `[3,2]`). A thin light-fill background (`rgba(147,197,253,0.08)`) is also applied.

### 2.3 Accessories (YOLOv8n COCO)

✅ Phase-1 Complete — all five accessory classes use amber color.

| Class | COCO ID | Color | HEX | Canvas RGBA |
|-------|---------|-------|-----|-------------|
| `backpack` | 24 | Amber | `#f59e0b` | `rgba(245,158,11,0.9)` |
| `umbrella` | 25 | Amber | `#f59e0b` | `rgba(245,158,11,0.9)` |
| `handbag` | 26 | Amber | `#f59e0b` | `rgba(245,158,11,0.9)` |
| `tie` | 27 | Amber | `#f59e0b` | `rgba(245,158,11,0.9)` |
| `suitcase` | 28 | Amber | `#f59e0b` | `rgba(245,158,11,0.9)` |

### 2.4 Indoor / Office Objects (YOLOv8n COCO) — New in v2.0

✅ Phase-1 Complete — not in the original RFP. The implementation supports a full set of indoor COCO classes with distinct colors.

| Class | Color Name | Canvas RGBA | Panel Text Class |
|-------|-----------|-------------|-----------------|
| `chair` | Violet | `rgba(139,92,246,0.9)` | `text-violet-400` |
| `couch` | Violet-400 | `rgba(167,139,250,0.9)` | `text-violet-300` |
| `dining table` | Emerald | `rgba(16,185,129,0.9)` | `text-emerald-400` |
| `bed` | Indigo | `rgba(99,102,241,0.9)` | `text-indigo-400` |
| `tv` | Sky | `rgba(14,165,233,0.9)` | `text-sky-400` |
| `laptop` | Cyan | `rgba(6,182,212,0.9)` | `text-cyan-400` |
| `mouse` | Amber-300 | `rgba(251,191,36,0.9)` | `text-amber-300` |
| `keyboard` | Pink | `rgba(236,72,153,0.9)` | `text-pink-400` |
| `cell phone` | Red-400 | `rgba(248,113,113,0.9)` | `text-red-300` |
| `clock` | Emerald-400 | `rgba(52,211,153,0.9)` | `text-emerald-300` |
| `cup` | Orange | `rgba(251,146,60,0.9)` | `text-orange-300` |
| `bottle` | Lime | `rgba(163,230,53,0.9)` | `text-lime-400` |
| `book` | Violet-300 | `rgba(196,181,253,0.9)` | `text-violet-200` |
| `remote` | Gray-300 | `rgba(209,213,219,0.9)` | *(no panel color assigned)* |
| `vase` | Pink-400 | `rgba(244,114,182,0.9)` | `text-pink-300` |

All unrecognized/fallback classes render as gray: `rgba(156,163,175,0.9)` / `text-gray-400`.

### 2.5 Fire / Smoke Classes (FireSmokeService)

✅ Phase-1 Complete.

| Class | Color | HEX | Canvas RGBA | Special Treatment |
|-------|-------|-----|-------------|-------------------|
| `fire` | Orange-Red | `#ff5000` | `rgba(255,80,0,1.0)` | Semi-transparent fill `rgba(255,80,0,0.18)` + 3px border |
| `smoke` | Slate Gray | `#64748b` | `rgba(100,116,139,0.9)` | Semi-transparent fill `rgba(100,116,139,0.15)` + 3px border |

### 2.6 Special States

✅ Phase-1 Complete.

| State | Color | HEX | Priority |
|-------|-------|-----|----------|
| Loitering (`isLoitering=true`) | Red | `#ef4444` | Highest — overrides class color |
| Dwell > 5s | Yellow text | `#fde047` | `dwellTime` text highlight only |

---

## 3. Canvas Overlay Visualization Requirements

### 3.1 BBox (Bounding Box) Rendering

```
┌──────────────────────────────┐
│ [className [FaceId]  conf%]  │  ← Top label background (semi-transparent black)
│  or [className #objectId  conf%]
│                              │
│  [MASK OK][HELMET]           │  ← Attribute badges (top-left inside bbox)
│                              │
│                              │
│  ↑red ↓black                 │  ← Color attribute (bottom-left inside bbox)
└──────────────────────────────┘ [dwell 12.3s]  ← Bottom-right external (dwellTime)
```

#### 3.1.1 Border Style

✅ Phase-1 Complete. Actual implementation:

| Object Type | Line Width | Style | Color |
|------------|-----------|-------|-------|
| Standard detection | 2px | Solid | Class color |
| Loitering | 2px | Solid | `rgba(239,68,68,0.9)` red |
| Fire / smoke | 3px | Solid + filled background | Class color |
| Face | 1.5px | Dashed `[4,3]` + light fill | `rgba(147,197,253,0.95)` |

#### 3.1.2 Label

✅ Phase-1 Complete. Actual format differs from original spec:

- **Face objects:** `face [F3]  87%` — uses `faceId` (`F1`, `F2`, …) instead of numeric objectId
- **All other objects:** `className #objectId  conf%`
- Position: top-left of bbox, 20px above top edge (`y - 20`)
- Font: `bold 12px monospace`
- Background: `rgba(0,0,0,0.7)` block sized to text width + 8px
- Text color: class color (same as border)

> **Note (v2.0):** The original RFP specified the label format as `{className} #{objectId}  {conf}%` for all classes. The implementation uses `face [FaceId]  conf%` for face detections (no `#` prefix, bracketed stable ID).

#### 3.1.3 DwellTime Display

✅ Phase-1 Complete.

- Position: External, bottom-right of bbox (`x+w-dw`, `y+h`)
- Height: 16px block
- Condition: `isLoitering === true` OR `dwellTime > 5.0`
- Background: Loitering → `rgba(239,68,68,0.85)` red; otherwise → `rgba(0,0,0,0.6)` dark gray
- Text: White, `bold 10px monospace`

### 3.2 AI Attribute Badges (Attribute Badges)

✅ Phase-1 Complete. Badges render inside the bbox, top-left (`x+2`, `y+2`), laid out horizontally.

#### 3.2.1 Mask Badge

| Status | Display Text | Background Color |
|--------|-------------|-----------------|
| `mask_correct` | `MASK OK` | `rgba(34,197,94,0.85)` green |
| `no_mask` | `NO MASK` | `rgba(239,68,68,0.85)` red |
| `mask_incorrect` | `MASK?` | `rgba(234,179,8,0.85)` yellow |

#### 3.2.2 Helmet / Hat Badge

> **Note (v2.0 correction):** The original RFP specified `HAT` as the badge text when `isHelmet = false`. The actual implementation displays `NO HELMET` (not `HAT`) when `isHelmet = false`. The color logic is also richer than documented — it uses the `safetyCompliant` field, not just `isHelmet`.

| `safetyCompliant` Value | `isHelmet` | Display Text | Background Color |
|------------------------|------------|-------------|-----------------|
| `true` | `true` | `HELMET` | `rgba(59,130,246,0.85)` blue |
| `false` | `false` | `NO HELMET` | `rgba(239,68,68,0.85)` red |
| `null` / `undefined` | either | `HELMET` or `NO HELMET` | `rgba(107,114,128,0.85)` gray |

- Font: `bold 9px monospace`
- Height: 14px per badge

### 3.3 Color Attribute Display

✅ Phase-1 Complete.

- Position: Below bbox bottom-left (`x`, `y+h`), stacked downward if cloth also present
- Format: `↑{upper} ↓{lower}` (e.g. `↑red ↓black`)
- Font: `bold 10px monospace`
- Background: `rgba(0,0,0,0.72)`
- Text: `#d1d5db` light gray

### 3.4a Cloth Attribute Display *(New — Phase-2)*

🔲 Phase-2 — requires `openpar.onnx`. Rendered only when `det.cloth.upper` or `det.cloth.lower` is present and not `'unknown'`.

- Position: Below color line (`y+h+16`), or directly below bbox (`y+h`) if no color
- Format: `cloth ↑{upper} ↓{lower} [{sleeve}]` — sleeve omitted when `'unknown'` or absent
  - Example: `cloth ↑hoodie ↓jeans [long]`
- Font: `bold 10px monospace`
- Background: `rgba(0,0,0,0.72)`
- Text: `#a78bfa` (violet-400) — visually distinct from gray color text

> **Stack order** (below bbox, y+h downward):
> 1. Color line (`#d1d5db` gray) — if `det.color` present
> 2. Cloth line (`#a78bfa` violet) — if `det.cloth` present and non-unknown values exist

### 3.4 Face Detection Box — Revised in v2.0

> **Original RFP spec (now superseded):** Section 3.4 originally specified that when `det.face` exists on a person detection, an internal dashed box should be drawn inside the person bbox using the face sub-bbox coordinates. This behavior is **not implemented**. Instead:

**Actual implementation:** SCRFD detects all faces in the frame independently. PipelineManager emits them as separate `className='face'` detection objects alongside person/vehicle detections. Each face detection gets its own top-level bounding box drawn with the dashed light-blue style (Section 3.1.1). Person detection objects may carry a `face` attribute (score + bbox) used only for detection panel display, but no internal sub-box is drawn on the canvas.

---

## 4. Zone Overlay Requirements

### 4.1 Zone Polygon Colors

✅ Phase-1 Complete.

> **Note (v2.0):** The original RFP used type names `MONITOR` and `EXCLUSION`. The actual type system uses `MONITOR` and `EXCLUDE` (not `EXCLUSION`) in `index.ts`. Canvas rendering uses `zone.type === 'MONITOR'` to select colors.

| Zone Type | Fill Color | Border Color |
|-----------|-----------|-------------|
| `MONITOR` | `rgba(59,130,246,0.12)` blue | `rgba(59,130,246,0.8)` |
| `EXCLUDE` | `rgba(245,158,11,0.12)` amber | `rgba(245,158,11,0.8)` |

### 4.2 Zone Label

✅ Phase-1 Complete.

- Position: Polygon centroid
- Background: `rgba(0,0,0,0.65)` semi-transparent block
- Text color: MONITOR → `#60a5fa`, EXCLUDE → `#fbbf24`
- Font: `bold 10px sans-serif`

---

## 5. Detection List Panel (Detection Panel) Requirements

### 5.1 Panel Layout (Fullscreen View)

✅ Phase-1 Complete. Updated in **v2.4** — two-column layout. Left panel is DetectionPanel only; Video Analytics is in the Dashboard sidebar (see §7.1).

```
┌───────────────────┬──────────────────────────────────────┐
│  LEFT (256px)     │  CENTER (flex-1)                     │
│  DetectionPanel   │  Header: CameraName              [X] │
│  (always shown)   ├──────────────────────────────────────┤
│                   │  Video feed (CameraView)              │
└───────────────────┴──────────────────────────────────────┘
```

**Left panel — DetectionPanel (256px, no tab bar):**

```
┌─────────────────────────────────────┐
│ DETECTIONS           3 obj  1 loiter│  ← Panel header
├─────────────────────────────────────┤
│ PERSON               [LOITER] #a1b2 │  ← Row bg: bg-red-900/20
│ conf 96%  dwell 15.2s               │
│ x 120  y 80  w 60  h 120            │
│ risk 82%  revisit 2×                │  ← AMF metrics (zone-matched only)
│ vel  8px/s  ↻ circular              │
│ upper red | lower blue              │  ← color
│ face 89% [F1]                       │  ← face (score + faceId if set)
├─────────────────────────────────────┤
│ FACE  [F3] sim 76% [↔ CROSS-CAM]   │  ← standalone face; CROSS-CAM badge when
│                                     │     face is in a cross-camera event
├─────────────────────────────────────┤
│ PERSON  [MASK OK] [HELMET] #b3c4    │  ← MASK / HAT badges
│ PERSON  [NO MASK] [HAT?]   #d5e6   │  ← HAT? when hat.isHelmet is null/undefined
├─────────────────────────────────────┤
│ CAR                           #c3d4 │
│ conf 78%  dwell 2.0s                │
│ x 200  y 300  w 80  h 50            │
├─────────────────────────────────────┤
│ FIRE         [FIRE]           #e5f6 │  ← fire badge pulses (animate-pulse)
│ conf 91%  dwell 0.0s                │
├─────────────────────────────────────┤
│  ─ Cross-Camera Re-ID ──────────── │  ← Conditional section — only shown when
│  [F5] Front Gate → Lobby Exit  83% │    this camera has cross-camera events
│  [F2] Front Gate → Lobby Exit  91% │    Max 5 events, max-height 20, scroll
├─────────────────────────────────────┤
│ ── Object Classes ─────────────────  │  ← Legend (always visible, at bottom)
│ ■ person   ■ loitering              │
│ ■ face     ■ bicycle                │
│ ■ car      ■ motorcycle             │
│ ■ bus      ■ truck                  │
│ ■ fire     ■ smoke                  │
│                                     │
│ ── Accessories ─────────────────── │
│ ■ backpack  ■ handbag               │
│ ... + sports equipment (10 classes) │
│ ... + cutlery (fork/knife/spoon...) │
│                                     │
│ ── Animals ────────────────────── │
│ ■ bird      ■ cat                   │
│ ... (10 animal classes)             │
│                                     │
│ ── Outdoor / Infrastructure ─────── │
│ ■ bench     ■ traffic light         │
│ ... (8 classes)                     │
│                                     │
│ ── Food / Kitchen ───────────────── │
│ ■ bowl      ■ wine glass            │
│ ... (10+ classes)                   │
│                                     │
│ ── Home Appliances ──────────────── │
│ ■ bed       ■ sink                  │
│ ... (8 classes)                     │
│                                     │
│ ── Indoor / Office ────────────────│
│ ■ chair     ■ couch                 │
│ ■ dining t. ■ bed                   │
│ ... (13 indoor classes)             │
│                                     │
│ ── AI Attribute Badges ─────────── │
│ [MASK OK]  [NO MASK]                │
│ [HELMET]   [NO HELMET]              │
│ [MASK? / HAT?]  gray = AI uncertain │
│ ⬚ face bbox   ↑↓ color             │
└─────────────────────────────────────┘
```

> **Note (v2.0):** The original RFP showed a single-tab panel. The actual implementation had a two-tab layout: "DETECTIONS" and "VIDEO ANALYTICS". The legend is expanded significantly — it now has 8 sections including Animals, Outdoor/Infrastructure, Food/Kitchen, Home Appliances.
>
> **Note (v2.1 additions):** The "Cross-Camera Re-ID" feed section appears at the bottom of the detection list, above the legend, when the current camera is involved in any cross-camera Re-ID events. It shows up to 5 most recent events in format `[FaceId] prevCameraName → newCameraName similarity%`. The `↔ CROSS-CAM` badge appears on face detection rows whose faceId matches a cross-camera event. The `HAT?` badge appears when `hat.isHelmet` is `null`/`undefined` (AI uncertain).
>
> **Note (v2.5 — Camera name display):** `prevCameraId` and `newCameraId` UUIDs are now resolved to human-readable camera names using the `useCameraStore` cameras array. `DetectionPanel` subscribes to `cameras` from `useCameraStore` and uses a `camName(id)` helper: `cameras.find(c => c.id === id)?.name ?? id.slice(0, 8)`. If the camera is not found in the store, it falls back to the first 8 characters of the UUID. Camera names are also exposed via a `title` tooltip attribute on the name span so the full UUID is still accessible on hover.
>
> **Note (v2.2 — Collapsible sections):** Both the Legend and Cross-Camera Re-ID sections are now collapsible via a clickable header row (▲/▼ toggle). This allows users to maximize the detection list area when the legend or Re-ID feed is not needed.
>
> **Note (v2.3 → superseded by v2.4):** An intermediate layout placed Video Analytics in a 3-column right panel inside the Fullscreen view. This was reverted.
>
> **Note (v2.4 — Layout restructure):** Video Analytics moved out of the Fullscreen view entirely. The Fullscreen view is now a **2-column layout**: left DetectionPanel (256px) + right video feed (flex-1). `VideoAnalyticsTab` is now the **4th tab in the Dashboard sidebar** (`w-72 bg-gray-800 border-l border-gray-700`), alongside the Cameras / Alerts / Zones tabs (`SidebarTab = 'cameras' | 'alerts' | 'zones' | 'analytics'`). This reflects the semantic distinction: DetectionPanel is per-camera live data; VideoAnalyticsTab is global AI module configuration accessible from the main dashboard at all times.

#### 5.1.1 Legend Collapse/Expand Behaviour *(New in v2.2)*

| Property | Value |
|----------|-------|
| State variable | `showLegend` (`boolean`) in `DetectionPanel` |
| Default state | `false` — **collapsed on mount** |
| Toggle trigger | Click anywhere on the legend header row |
| Header label | i18n key `t.legendPeopleVehicles` (e.g. "Object Classes") |
| Expand indicator | `▲` (open) / `▼` (closed) — `text-[8px] text-gray-500` |
| Expanded content | `max-h-64 overflow-y-auto` — scrollable when needed |

When collapsed, the legend header occupies a single `py-1.5` row and `flex-shrink-0`. When expanded, the content block grows up to `max-h-64` with a scrollbar.

#### 5.1.2 Cross-Camera Re-ID Collapse/Expand Behaviour *(New in v2.2)*

| Property | Value |
|----------|-------|
| State variable | `showCrossCamera` (`boolean`) in `DetectionPanel` |
| Default state | `true` — **expanded on mount** (relevant data is shown by default) |
| Toggle trigger | Click anywhere on the Cross-Camera Re-ID header row |
| Header label | `"Cross-Camera Re-ID"` + event count in parentheses |
| Expand indicator | `▲` (open) / `▼` (closed) |
| Expanded content | `max-h-20 overflow-y-auto` — scrollable at 5 events |
| Visibility | Section only appears when `localEvents.length > 0` |

### 5.2 Detection Row Color Codes

✅ Phase-1 Complete. Additions since original RFP are marked.

#### 5.2.1 People / Vehicles / Hazards

| Class | Text Color | Row Background |
|-------|-----------|----------------|
| person (loitering) | `text-red-400` | `bg-red-900/20` |
| person | `text-green-400` | — |
| face *(new in v2.0)* | `text-blue-300` | `bg-blue-900/15` |
| bicycle | `text-yellow-400` | — |
| car | `text-blue-400` | — |
| motorcycle | `text-orange-400` | — |
| bus | `text-purple-400` | — |
| truck | `text-teal-400` | — |
| fire | `text-orange-500` | `bg-orange-900/25` |
| smoke | `text-slate-400` | `bg-slate-800/40` |

#### 5.2.2 Accessories / Personal Items

| Class | Text Color | Row Background |
|-------|-----------|----------------|
| backpack / umbrella / handbag / tie / suitcase | `text-amber-400` | — |

#### 5.2.3 Sports Equipment & Tools *(new in v2.1)*

| Class | Text Color |
|-------|-----------|
| sports ball | `text-orange-400` |
| frisbee | `text-orange-300` |
| skis | `text-sky-500` |
| snowboard | `text-sky-400` |
| baseball bat | `text-yellow-500` |
| baseball glove | `text-yellow-600` |
| skateboard | `text-orange-500` |
| surfboard | `text-cyan-500` |
| tennis racket | `text-lime-400` |
| kite | `text-violet-400` |
| scissors | `text-slate-400` |
| fork | `text-gray-300` |
| knife | `text-gray-400` |
| spoon | `text-gray-200` |

#### 5.2.4 Animals *(new in v2.1)*

| Class | Text Color |
|-------|-----------|
| bird | `text-pink-200` |
| cat | `text-rose-300` |
| dog | `text-rose-400` |
| horse | `text-orange-800` |
| sheep | `text-gray-100` |
| cow | `text-amber-900` |
| elephant | `text-gray-500` |
| bear | `text-amber-800` |
| zebra | `text-gray-100` |
| giraffe | `text-amber-600` |

#### 5.2.5 Outdoor / Infrastructure *(new in v2.1)*

| Class | Text Color |
|-------|-----------|
| bench | `text-emerald-400` |
| traffic light | `text-yellow-400` |
| fire hydrant | `text-red-500` |
| stop sign | `text-red-700` |
| parking meter | `text-gray-600` |
| airplane | `text-indigo-400` |
| boat | `text-blue-400` |
| train | `text-emerald-500` |

#### 5.2.6 Food / Kitchen *(new in v2.1)*

| Class | Text Color |
|-------|-----------|
| bowl | `text-amber-400` |
| wine glass | `text-violet-300` |
| banana | `text-yellow-300` |
| apple | `text-red-500` |
| sandwich | `text-yellow-500` |
| orange | `text-orange-500` |
| broccoli | `text-green-600` |
| carrot | `text-orange-600` |
| hot dog | `text-yellow-600` |
| pizza | `text-orange-400` |
| donut | `text-pink-400` |
| cake | `text-pink-200` |

#### 5.2.7 Home Appliances *(new in v2.1)*

| Class | Text Color |
|-------|-----------|
| bed | `text-indigo-400` |
| toilet | `text-slate-200` |
| sink | `text-slate-400` |
| microwave | `text-slate-500` |
| oven | `text-slate-600` |
| toaster | `text-slate-400` |
| refrigerator | `text-sky-200` |
| potted plant | `text-green-300` |
| teddy bear | `text-orange-200` |
| hair drier | `text-rose-300` |
| toothbrush | `text-emerald-200` |

#### 5.2.8 Indoor / Office Objects

| Class | Text Color |
|-------|-----------|
| chair | `text-violet-400` |
| couch | `text-violet-300` |
| dining table | `text-emerald-400` |
| tv | `text-sky-400` |
| laptop | `text-cyan-400` |
| mouse | `text-amber-300` |
| keyboard | `text-pink-400` |
| cell phone | `text-red-300` |
| clock | `text-emerald-300` |
| cup | `text-orange-300` |
| bottle | `text-lime-400` |
| book | `text-violet-200` |
| vase | `text-pink-300` |

All unrecognized/fallback classes render as: `text-gray-400`.

### 5.3 Sort Order

✅ Phase-1 Complete.

1. **Loitering objects first** (`isLoitering = true`)
2. **Descending `dwellTime`** (longest dwell at top)

### 5.4 Displayed Fields Per Object

> **Note (v2.0):** Several fields are new relative to the original RFP.
> **Note (v2.1):** Cross-camera badge and HAT? variant added.

| Field | Condition | Format |
|-------|-----------|--------|
| `className` | Always | Uppercase |
| `objectId` | Always (non-face) | `#` + first 8 chars of `String(objectId)` |
| `faceId` | `className === 'face'` | `[F1]`, `[F2]`, … |
| `matchScore` | Face detection, `matchScore` present | `sim XX%` (green ≥60%, yellow ≥40%, gray <40%) |
| `isCrossCamera` *(new in v2.1)* | Face detection; faceId in cross-camera events | `↔ CROSS-CAM` badge (`bg-blue-700/70 text-blue-100`) |
| `confidence` | Always | `conf XX%` |
| `dwellTime` | Always | `dwell X.Xs` (yellow if > 5s) |
| `bbox` | Always | `x`, `y`, `w`, `h` pixel values (2-column grid) |
| `riskScore` *(new in v2.0)* | Zone-matched objects only | `risk XX%` (red ≥70%, yellow ≥40%) |
| `revisitCount` *(new in v2.0)* | Zone-matched, `revisitCount > 0` | `revisit N×` orange |
| `velocity` *(new in v2.0)* | Zone-matched objects | `vel Npx/s` (red if < 20px/s) |
| `circularScore` *(new in v2.0)* | Zone-matched, `circularScore > 0.4` | `↻ circular` orange |
| `mask` | `det.mask` present | `MASK OK` / `NO MASK` / `MASK BAD` / `MASK?` badge |
| `hat` | `det.hat` present | `HELMET` / `NO HELMET` / `HAT?` badge |
| `color` | `det.color` present | `upper {color} \| lower {color}` |
| `cloth` *(Phase-2)* | `det.cloth` present, value ≠ `'unknown'` | `cloth ↑{upper} ↓{lower} [{sleeve}]` — violet text; sleeve omitted when absent/unknown |
| `face` (on person) | `det.face` present | `face XX% [FaceId] identity` |

### 5.5 Status Badges

> **Note (v2.0 correction):** The `HAT` badge in the original RFP is replaced by `NO HELMET`. The `MASK BAD` label (not `MASK?`) is used for `mask_incorrect` in the panel.
> **Note (v2.1 additions):** `HAT?` badge added for hat.isHelmet null/undefined case. `MASK?` badge added for `uncertain` mask status. `↔ CROSS-CAM` badge added for cross-camera face re-identification.

| Badge | Condition | Tailwind Class |
|-------|-----------|---------------|
| `LOITER` | `isLoitering === true` | `bg-red-600 text-white` |
| `FIRE` | `className === 'fire'` | `bg-orange-600 text-white animate-pulse` |
| `SMOKE` | `className === 'smoke'` | `bg-slate-600 text-white` |
| `MASK OK` | `mask.status === 'mask_correct'` | `bg-green-700 text-green-100` |
| `MASK BAD` | `mask.status === 'mask_incorrect'` | `bg-yellow-700 text-yellow-100` |
| `NO MASK` | `mask.status === 'no_mask'` | `bg-red-700 text-red-100` |
| `MASK?` *(new in v2.1)* | `mask.status === 'uncertain'` | `bg-gray-600 text-gray-200` |
| `HELMET` | `hat.safetyCompliant === true` | `bg-blue-700 text-blue-100` |
| `NO HELMET` | `hat.safetyCompliant === false` | `bg-red-700 text-red-100` |
| `HAT?` *(new in v2.1)* | `hat.isHelmet` is `null`/`undefined` (AI uncertain) | `bg-gray-600 text-gray-200` |
| `↔ CROSS-CAM` *(new in v2.1)* | `isCrossCamera === true` (face in cross-camera event) | `bg-blue-700/70 text-blue-100` |

> **Badge text selection for hat:**
> - `hat.isHelmet === true` → `HELMET`
> - `hat.isHelmet === false` → `NO HELMET`
> - `hat.isHelmet === null/undefined` → `HAT?`
>
> **Badge color for hat** is driven by `hat.safetyCompliant` (not `hat.isHelmet`):
> - `true` → `bg-blue-700` (compliant); `false` → `bg-red-700` (non-compliant); `null/undefined` → `bg-gray-600` (uncertain)

### 5.6 Cross-Camera Re-ID in Detection Panel *(New in v2.1)*

✅ Phase-1 Complete.

#### 5.6.1 Overview

When a face is re-identified across multiple cameras, the Detection Panel displays an inline "Cross-Camera Re-ID" feed and marks the corresponding face row with a `↔ CROSS-CAM` badge. This is powered by the `useCrossCameraStore` Zustand store.

#### 5.6.2 Store — `useCrossCameraStore`

```typescript
// client/src/stores/crossCameraStore.ts
const MAX_EVENTS = 20;        // max events stored
const EXPIRY_MS  = 60_000;    // events expire after 60s

interface CrossCameraStore {
  events:       CrossCameraReIdEvent[];
  addEvent:     (event: CrossCameraReIdEvent) => void;
  pruneExpired: () => void;
  clearEvents:  () => void;
}
```

- `addEvent()` prepends the new event, prunes expired entries, and caps at `MAX_EVENTS`.
- The store is populated by `App.tsx` listening to `face:reidentified` Socket.IO events (global, not per-camera).

#### 5.6.3 Socket.IO Event — `face:reidentified`

| Field | Type | Description |
|-------|------|-------------|
| `faceId` | `string` | Stable gallery face ID (e.g. `F3`) |
| `prevCameraId` | `string` | UUID of the camera where the face was last seen |
| `newCameraId` | `string` | UUID of the camera where the face is now seen |
| `similarity` | `number` | Cosine similarity (0–1) at the time of re-ID |
| `timestamp` | `number` | Unix ms |

> **Note:** The event name is `face:reidentified` (emitted by `pipelineManager.js`). An earlier draft used `cross-camera:reid` — that name is **not** used in the actual implementation.

#### 5.6.4 `isCrossCamera` Prop Logic

`DetectionPanel` computes a set of faceIds that appeared in a cross-camera event involving the current camera (as source **or** destination):

```typescript
const crossCamFaceIds = new Set(
  crossCameraEvents
    .filter((ev) => ev.prevCameraId === cameraId || ev.newCameraId === cameraId)
    .map((ev) => ev.faceId)
);
```

A `DetectionRow` receives `isCrossCamera = true` when:
- `det.className === 'face'`
- `det.faceId != null`
- `det.faceId` is in `crossCamFaceIds`

#### 5.6.5 Cross-Camera Feed Section

Appears **below the detection list, above the legend** in `DetectionPanel`. Rendered only when `localEvents.length > 0`:

```
─ Cross-Camera Re-ID ──────────────────
[F5] 80d658eb → 4f3a1c2b  83%
[F2] 80d658eb → 4f3a1c2b  91%
```

| Property | Value |
|----------|-------|
| Section label color | `text-blue-400` |
| FaceId color | `text-blue-300 font-bold` |
| Similarity color | `text-gray-600` |
| Max events displayed | 5 (most recent) |
| Max height | `max-h-20` (overflow-y scroll) |
| Camera ID truncation | First 8 characters of UUID |
| Separator | Unicode `→` (U+2192) |

#### 5.6.6 `crossCamera` Field on Detection Object

When a face detection matches a gallery entry last seen on a **different** camera, the server adds a `crossCamera` field to the detection:

```typescript
crossCamera?: { prevCameraId: string }
```

This field is used server-side to flag the detection and is available in the `Detection` type, but it is **not rendered directly** in the detection row. The `DetectionPanel` uses the `crossCamFaceIds` set (derived from the store) to determine `isCrossCamera` for row rendering.

#### 5.6.7 `↔ CROSS-CAM` Badge

Displayed inside the face detection row header, after the face ID and similarity score:

- Text: `↔ CROSS-CAM` (Unicode `↔` = U+2194)
- Tailwind: `bg-blue-700/70 text-blue-100 rounded px-1 py-0.5 uppercase`
- Font size: `text-[8px] font-bold`

---

## 6. Legend Requirements

### 6.1 Legend Structure

✅ Phase-1 Complete. The legend is pinned to the bottom of the detection panel and contains **8 sections** (4 in the original RFP, expanded in v2.0/v2.1):

#### Section 1: People & Vehicles
```
─ People & Vehicles ──────────────────
■ person      ■ loitering
■ face        ■ bicycle
■ car         ■ motorcycle
■ bus         ■ truck
■ fire        ■ smoke
```

#### Section 2: Accessories *(expanded in v2.1 — sports equipment added)*
```
─ Accessories ──────────────────────
■ backpack    ■ handbag
■ suitcase    ■ umbrella
■ tie
■ sports ball ■ skis
■ baseball bat ■ skateboard
■ surfboard   ■ tennis racket
■ kite        ■ scissors/fork/knife
■ remote/spoon
```

#### Section 3: Animals *(new in v2.1)*
```
─ Animals ──────────────────────────
■ bird        ■ cat
■ dog         ■ horse
■ sheep       ■ cow
■ elephant    ■ bear
■ zebra       ■ giraffe
```

#### Section 4: Outdoor / Infrastructure *(new in v2.1)*
```
─ Outdoor / Infrastructure ─────────
■ bench       ■ traffic light
■ fire hydrant ■ stop sign
■ parking meter ■ airplane
■ boat        ■ train
```

#### Section 5: Food / Kitchen *(new in v2.1)*
```
─ Food / Kitchen ───────────────────
■ bowl        ■ wine glass
■ banana      ■ apple
■ orange      ■ broccoli
■ pizza       ■ donut
■ cake        ■ sandwich/hotdog
```

#### Section 6: Home Appliances *(new in v2.1)*
```
─ Home Appliances ──────────────────
■ bed         ■ sink
■ microwave   ■ refrigerator
■ potted plant ■ hair drier
■ toothbrush  ■ teddy bear
```

#### Section 7: Indoor / Office *(new in v2.0)*
```
─ Indoor / Office ──────────────────
■ chair       ■ couch
■ dining table ■ tv
■ laptop      ■ keyboard
■ mouse       ■ cell phone
■ clock       ■ cup
■ bottle      ■ book
■ vase
```

#### Section 8: AI Attribute Badges
```
─ AI Attribute Badges ──────────────
[MASK OK]    [NO MASK]
[HELMET]     [NO HELMET]
[MASK? / HAT?]   gray = AI uncertain
⬚ face bbox    ↑↓ color
```

> **Note (v2.1):** The legend's Accessories section includes sports equipment and cutlery that was not in the v2.0 spec. Four new sections were added: Animals, Outdoor/Infrastructure, Food/Kitchen, Home Appliances. The AI badges section now explicitly shows `MASK? / HAT?` for the gray uncertain state.

### 6.2 Legend Color Specification

#### People / Vehicles / Hazards

| Item | Tailwind Class | Description |
|------|---------------|-------------|
| person | `text-green-400` | Green |
| loitering | `text-red-400` | Red |
| face | `text-blue-300` | Light blue |
| bicycle | `text-yellow-400` | Yellow |
| car | `text-blue-400` | Blue |
| motorcycle | `text-orange-400` | Orange |
| bus | `text-purple-400` | Purple |
| truck | `text-teal-400` | Teal |
| fire | `text-orange-500` | Orange-red |
| smoke | `text-slate-400` | Slate gray |

#### Accessories / Personal Items

| Item | Tailwind Class |
|------|---------------|
| accessories (backpack/handbag/suitcase/umbrella/tie) | `text-amber-400` |

#### Sports Equipment & Tools *(new in v2.1)*

| Item | Tailwind Class |
|------|---------------|
| sports ball | `text-orange-400` |
| frisbee | `text-orange-300` |
| skis | `text-sky-500` |
| snowboard | `text-sky-400` |
| baseball bat | `text-yellow-500` |
| baseball glove | `text-yellow-600` |
| skateboard | `text-orange-500` |
| surfboard | `text-cyan-500` |
| tennis racket | `text-lime-400` |
| kite | `text-violet-400` |
| scissors | `text-slate-400` |
| fork | `text-gray-300` |
| knife | `text-gray-400` |
| spoon | `text-gray-200` |

#### Animals *(new in v2.1)*

| Item | Tailwind Class |
|------|---------------|
| bird | `text-pink-200` |
| cat | `text-rose-300` |
| dog | `text-rose-400` |
| horse | `text-orange-800` |
| sheep | `text-gray-100` |
| cow | `text-amber-900` |
| elephant | `text-gray-500` |
| bear | `text-amber-800` |
| zebra | `text-gray-100` |
| giraffe | `text-amber-600` |

#### Outdoor / Infrastructure *(new in v2.1)*

| Item | Tailwind Class |
|------|---------------|
| bench | `text-emerald-400` |
| traffic light | `text-yellow-400` |
| fire hydrant | `text-red-500` |
| stop sign | `text-red-700` |
| parking meter | `text-gray-600` |
| airplane | `text-indigo-400` |
| boat | `text-blue-400` |
| train | `text-emerald-500` |

#### Food / Kitchen *(new in v2.1)*

| Item | Tailwind Class |
|------|---------------|
| bowl | `text-amber-400` |
| wine glass | `text-violet-300` |
| banana | `text-yellow-300` |
| apple | `text-red-500` |
| sandwich | `text-yellow-500` |
| orange | `text-orange-500` |
| broccoli | `text-green-600` |
| carrot | `text-orange-600` |
| hot dog | `text-yellow-600` |
| pizza | `text-orange-400` |
| donut | `text-pink-400` |
| cake | `text-pink-200` |

#### Home Appliances *(new in v2.1)*

| Item | Tailwind Class |
|------|---------------|
| bed | `text-indigo-400` |
| toilet | `text-slate-200` |
| sink | `text-slate-400` |
| microwave | `text-slate-500` |
| oven | `text-slate-600` |
| toaster | `text-slate-400` |
| refrigerator | `text-sky-200` |
| potted plant | `text-green-300` |
| teddy bear | `text-orange-200` |
| hair drier | `text-rose-300` |
| toothbrush | `text-emerald-200` |

#### Indoor / Office

| Item | Tailwind Class |
|------|---------------|
| chair | `text-violet-400` |
| couch | `text-violet-300` |
| dining table | `text-emerald-400` |
| bed | `text-indigo-400` |
| tv | `text-sky-400` |
| laptop | `text-cyan-400` |
| keyboard | `text-pink-400` |
| mouse | `text-amber-300` |
| cell phone | `text-red-300` |
| clock | `text-emerald-300` |
| cup | `text-orange-300` |
| bottle | `text-lime-400` |
| book | `text-violet-200` |
| vase | `text-pink-300` |

#### AI Attribute Badges

| Item | Tailwind Class | Description |
|------|---------------|-------------|
| MASK OK | `bg-green-700/70 text-green-100` | Green badge |
| NO MASK | `bg-red-700/70 text-red-100` | Red badge |
| MASK BAD | `bg-yellow-700/70 text-yellow-100` | Yellow badge |
| MASK? | `bg-gray-600/70 text-gray-200` | Gray badge — AI uncertain |
| HELMET | `bg-blue-700/70 text-blue-100` | Blue badge |
| NO HELMET | `bg-red-700/70 text-red-100` | Red badge |
| HAT? *(new in v2.1)* | `bg-gray-600/70 text-gray-200` | Gray badge — AI uncertain |
| ↔ CROSS-CAM *(new in v2.1)* | `bg-blue-700/70 text-blue-100` | Cross-camera Re-ID |
| face bbox | `text-blue-400` | Light blue dashed |
| color | `text-gray-400` | Gray text |

---

## 7. Video Analytics Panel Requirements — New in v2.0

✅ Phase-1 Complete. Location updated in **v2.4**.

### 7.1 Panel Location and Access

The Video Analytics panel is the **4th tab (`analytics`) in the Dashboard right sidebar**, alongside the Cameras / Alerts / Zones tabs. It is not inside the Fullscreen view.

| Property | Value |
|----------|-------|
| Position | Dashboard sidebar — 4th tab (`SidebarTab = 'analytics'`) |
| Sidebar width | `w-72` (`288px`) — same as other sidebar tabs |
| Sidebar style | `bg-gray-800 border-l border-gray-700` |
| Tab label (i18n key) | `t.tabVideoAnalytics` → `"Analytics"` |
| Tab order | Cameras → Alerts → Zones → **Analytics** |
| Rationale | `VideoAnalyticsTab` is **global AI module configuration** (not per-camera), so it belongs in the persistent Dashboard sidebar, accessible at all times regardless of which camera is active |

### 7.2 Module Groups and Items

The tab shows toggle switches for all analytics modules, organized in five groups:

| Group Key | Items | Phase |
|-----------|-------|-------|
| People & Vehicles | Human, Vehicle | Phase-1 |
| Accessories | Backpack, Handbag, Suitcase, Umbrella, Tie | Phase-1 |
| Accessories (pending) | Glasses, Sunglasses | Phase-2 (pending) |
| AI Attributes | Face Recognition (`scrfd_2.5g.onnx + arcface_w600k_r50.onnx`) | Phase-1 |
| AI Attributes | Mask (`yolov8m_ppe.onnx`), Color (no model) | Phase-1 |
| AI Attributes | Hat (`yolov8m_ppe.onnx`) | Phase-1 |
| AI Attributes | Cloth (`openpar.onnx` — ResNet50 PAR) | Phase-2 (activate by running `exportPAR.py` → `server/models/openpar.onnx`) |
| Hazards | Fire, Smoke (`yolov8s_fire_smoke.onnx`) | Phase-1 |
| Indoor / Office | Chair, Couch, Desk/Table, Laptop, TV, Keyboard, Mouse, Phone, Clock, Cup, Bottle, Book | Phase-1 |

### 7.3 Toggle Button States

| State | Appearance |
|-------|-----------|
| Enabled | `bg-blue-700/70 border-blue-500 text-white` |
| Disabled (model present) | `bg-gray-800 border-gray-700 text-gray-400` |
| Unavailable (model missing) | `opacity-35 cursor-not-allowed bg-gray-800` + "Not installed" label |
| Pending Phase-2 | `opacity-35 cursor-not-allowed` + "Phase-2" label |

### 7.4 API Endpoints

- `GET /api/analytics/config` — returns current enable/disable state per module
- `PUT /api/analytics/config` — updates one or more module states
- `GET /api/capabilities` — returns model availability (`cap.ai` map)
- `GET /api/tracker/config` — returns current Kalman Q/R config
- `PUT /api/tracker/config` — updates one or more Kalman parameters (persisted to `storage/tracker.json`)
- `POST /api/tracker/config/reset` — resets all Kalman parameters to defaults

### 7.5 Tracker / Kalman Settings Section *(New in v2.1)*

✅ Phase-1 Complete. A collapsible **"⚙ Tracker / Kalman Settings"** section appears below the module toggle groups in the Video Analytics tab. It is collapsed by default and expands on click.

#### 7.5.1 Layout

```
⚙ Tracker / Kalman Settings                          ▼
┌──────────────────────────────────────────────────────┐
│ Fast Speed Threshold             30 px/f             │
│ ────────────────────────────────────────             │
│ Fast Q Scale                     4.00×               │
│ ────────────────────────────────────                 │
│ Slow Speed Threshold              5 px/f             │
│ ──────────────────────                               │
│ Slow Q Scale                     0.50×               │
│ ─────────────────────────                            │
│ Occlusion Q Scale                3.00×               │
│ ────────────────────────────────────                 │
│ Measurement Noise (R)              10                 │
│ ──────────────────────────────────────────────────── │
│ [       Reset Defaults       ]                       │
└──────────────────────────────────────────────────────┘
```

#### 7.5.2 Slider Specifications

| Slider | Default | Range | Step | Unit | Accent Color |
|--------|:-------:|-------|:----:|------|:---:|
| Fast Speed Threshold | 30 | 5–100 | 1 | px/f | purple |
| Fast Q Scale | 4.0 | 1.0–10.0 | 0.5 | × | purple |
| Slow Speed Threshold | 5 | 1–20 | 1 | px/f | purple |
| Slow Q Scale | 0.50 | 0.1–1.0 | 0.05 | × | purple |
| Occlusion Q Scale | 3.0 | 1.0–10.0 | 0.5 | × | purple |
| Measurement Noise (R) | 10 | 1–50 | 1 | — | purple |

- Values with `step < 1` display 2 decimal places; integer values display without decimals.
- Changes are debounced (300ms) and saved via `PUT /api/tracker/config`.
- **Reset Defaults** button calls `POST /api/tracker/config/reset` and refreshes all sliders.
- A "saving…" indicator (purple, pulsing) appears while the PUT request is in flight.

---

## 8. Socket.IO Event Data Specification

### 8.1 `detections` Event Payload

```typescript
interface DetectionsPayload {
  cameraId:    string;
  frameId:     number;
  timestamp:   number;       // Unix ms
  frameWidth:  number;       // pixels (parsed from JPEG SOF header)
  frameHeight: number;       // pixels
  detections:  Detection[];
}

interface Detection {
  objectId:       number;        // ByteTracker ID, fire/smoke ID, or face ID
  className:      string;        // COCO class name, 'fire', 'smoke', or 'face'
  class:          string;        // Same as className (legacy alias)
  confidence:     number;        // 0.0 ~ 1.0
  bbox:           BBox;          // pixel coords in original frame
  isLoitering:    boolean;
  dwellTime:      number;        // seconds
  // Face tracking (on standalone 'face' detection objects)
  faceId?:        string;        // stable ID: 'F1', 'F2', … (gallery-assigned)
  matchScore?:    number;        // cosine similarity vs gallery entry (0–1)
  crossCamera?:   { prevCameraId: string }; // *(new in v2.1)* present when face was
                                 //   last seen on a different camera
  // Adaptive Multi-Feature Tracking metrics (zone-matched objects only)
  riskScore?:     number;        // composite risk score 0–1
  revisitCount?:  number;        // number of re-entries into zone
  velocity?:      number;        // movement speed px/s
  circularScore?: number;        // circular movement score 0–1
  // Attribute enrichment (only when model is loaded and module is enabled)
  face?:          FaceAttribute;
  mask?:          MaskAttribute;
  hat?:           HatAttribute;
  color?:         ColorAttribute;
  cloth?:         ClothAttribute;
}

interface BBox {
  x: number; y: number; width: number; height: number;
}

interface FaceAttribute {
  bbox:       BBox;
  score:      number;        // face detection confidence 0–1
  faceId?:    string;        // stable gallery ID
  identity?:  string;        // ArcFace identity name (when matched)
  matchScore?: number;       // cosine similarity vs gallery (0–1)
}

interface MaskAttribute {
  status:     'mask_correct' | 'mask_incorrect' | 'no_mask';
  confidence: number;
}

interface HatAttribute {
  className:        string;          // 'hardhat' | 'no_hardhat'
  confidence:       number;
  isHelmet:         boolean;
  safetyCompliant?: boolean | null;  // true=compliant, false=non-compliant, null=no rule
}

interface ColorAttribute {
  upper:     string;               // e.g. 'red', 'blue', 'black'
  lower:     string;
  upperRgb?: [number, number, number];  // raw RGB triple (optional)
  lowerRgb?: [number, number, number];
}

interface ClothAttribute {
  /** PAR upper garment: 'tshirt' | 'shirt' | 'jacket' | 'hoodie' | 'vest' | 'dress' | 'unknown' */
  upper?: string;
  /** PAR lower garment: 'pants' | 'jeans' | 'shorts' | 'skirt' | 'unknown' */
  lower?: string;
  /** PAR sleeve length: 'short' | 'long' — absent when model not loaded */
  sleeve?: string;
}
```

> **Note (v2.0 corrections vs original RFP:**
> - `Detection.class` field (alias for `className`) is present in the type but was not in the original spec.
> - `FaceAttribute` has additional optional fields: `faceId`, `identity`, `matchScore`.
> - `HatAttribute` has an additional `safetyCompliant` field.
> - `ColorAttribute` has optional `upperRgb`/`lowerRgb` fields.
> - `ClothAttribute` now has typed `upper`/`lower` string fields (was `[key: string]: unknown`).
> - Several new top-level Detection fields: `faceId`, `matchScore`, `riskScore`, `revisitCount`, `velocity`, `circularScore`.
>
> **Note (v2.1 additions):**
> - New `crossCamera?: { prevCameraId: string }` field on `Detection` — present when a face was re-identified from a different camera.
> - New `uncertain` status value in `MaskAttribute.status` → panel renders `MASK?` badge (gray).

### 8.2 objectId Ranges

✅ Phase-1 Complete.

| Range | Source | Description |
|-------|--------|-------------|
| 1 ~ 79,999 | ByteTracker | Person / vehicle / accessory tracking IDs |
| 80,000+ | FireSmokeService | `80000 + (frameId % 1000) * 10 + i` |
| 90,000+ | PipelineManager (face) | `90000 + (frameId % 1000) * 10 + i` (standalone face objects) |

> **Note (v2.0):** The original RFP documented only two ID ranges. Face objects (className='face') use the 90,000+ range. This was not in the original spec.

### 8.3 Additional Socket.IO Events

> **Note (v2.0):** The original RFP documented only the `detections` event. The following are also emitted:

| Event | Direction | Description |
|-------|-----------|-------------|
| `frame` | Server → Client | JPEG frame as base64 + frameWidth/frameHeight |
| `detections` | Server → Client | Enriched detection array |
| `loitering` | Server → Client | Loitering event from BehaviorEngine |
| `fire:alert` | Server → Client | Fire/smoke zone breach alert (10s cooldown per zone) |
| `face:reidentified` *(new in v2.1)* | Server → **All** clients (global broadcast) | Cross-camera face Re-ID event — emitted by `pipelineManager.js` when a face matches a gallery entry last seen on a different camera |
| `camera:status` | Server → Client | Status changes (connecting/streaming/offline/reconnecting/error) |
| `camera:error` | Server → Client | Fatal pipeline error |
| `camera:stats` | Server → Client | Frame count and FPS stats |
| `alert:new` | Server → All | Saved loitering alert broadcast to all clients |

#### `CrossCameraReIdEvent` Type *(new in v2.1)*

```typescript
// client/src/types/index.ts
interface CrossCameraReIdEvent {
  faceId:      string;   // stable gallery face ID (e.g. 'F3')
  prevCameraId: string;  // camera UUID where the face was last seen
  newCameraId:  string;  // camera UUID where the face is now detected
  similarity:   number;  // cosine similarity score (0–1) at time of re-ID
  timestamp:    number;  // Unix ms
}
```

Client subscription (in `App.tsx`):

```typescript
socket.on('face:reidentified', (event: CrossCameraReIdEvent) => {
  useCrossCameraStore.getState().addEvent(event);
});
```

---

## 9. Performance Requirements

✅ Phase-1 Complete (as specified).

| Item | Requirement |
|------|------------|
| Overlay render latency | < 5ms after frame receipt (requestAnimationFrame) |
| Detection list update | ≤ 1 update per frame at 60fps |
| Legend display | Always visible (no scroll required) |
| Max simultaneous objects | 100 per camera (DOM rendering limit) |
| Inference frame-drop guard | Skip frame if previous inference still running (`_inferring` flag) |
| Fire alert cooldown | 10 seconds per camera+zone+class to avoid alert flooding |

---

## 10. Implementation Status Checklist

### 10.1 Canvas Overlay (`CameraView.tsx`)

| Feature | Status | Notes |
|---------|--------|-------|
| BBox rendering | ✅ Phase-1 Complete | |
| Class colors: person → truck | ✅ Phase-1 Complete | |
| Accessory class colors (amber) | ✅ Phase-1 Complete | backpack/umbrella/handbag/tie/suitcase |
| Indoor/office class colors | ✅ Phase-1 Complete | 15 classes; not in original RFP |
| fire/smoke color + background fill | ✅ Phase-1 Complete | |
| face class (dashed light-blue) | ✅ Phase-1 Complete | Standalone top-level box, not sub-box |
| Loitering red override | ✅ Phase-1 Complete | |
| Label: class + id/faceId + conf | ✅ Phase-1 Complete | Face uses `[FaceId]`; others use `#objectId` |
| DwellTime display | ✅ Phase-1 Complete | |
| MASK badge (OK / NO MASK / MASK?) | ✅ Phase-1 Complete | |
| Helmet badge (HELMET / NO HELMET) | ✅ Phase-1 Complete | Uses `safetyCompliant`; original spec had `HAT` |
| Color attribute (↑upper ↓lower) | ✅ Phase-1 Complete | Below bbox, gray `#d1d5db` |
| Cloth attribute (cloth ↑upper ↓lower [sleeve]) | 🔲 Phase-2 | Below color line, violet `#a78bfa`; requires `openpar.onnx` |
| Zone polygon overlay | ✅ Phase-1 Complete | |
| Internal face sub-bbox inside person box | ❌ Not Implemented | Original RFP Section 3.4 — superseded by standalone face class |

### 10.2 Detection List Panel (`FullscreenCameraView.tsx`)

| Feature | Status | Notes |
|---------|--------|-------|
| Object row rendering | ✅ Phase-1 Complete | |
| Class text colors (all classes) | ✅ Phase-1 Complete | |
| Face class row (blue-300 + bg-blue-900/15) | ✅ Phase-1 Complete | Not in original RFP |
| Indoor/office class colors (14 classes) | ✅ Phase-1 Complete | Not in original RFP |
| Accessory amber colors | ✅ Phase-1 Complete | |
| fire/smoke background colors | ✅ Phase-1 Complete | |
| LOITER badge | ✅ Phase-1 Complete | |
| FIRE badge (animate-pulse) | ✅ Phase-1 Complete | |
| SMOKE badge | ✅ Phase-1 Complete | |
| MASK badges (MASK OK / MASK BAD / NO MASK) | ✅ Phase-1 Complete | Panel uses "MASK BAD" (original RFP had "MASK?") |
| Helmet badges (HELMET / NO HELMET) | ✅ Phase-1 Complete | Uses `safetyCompliant`; original RFP had `HAT` |
| Color attribute display | ✅ Phase-1 Complete | |
| Cloth attribute display (cloth ↑upper ↓lower [sleeve]) | 🔲 Phase-2 | violet `text-violet-300`; requires `openpar.onnx` |
| Face attribute display (score + faceId + identity) | ✅ Phase-1 Complete | |
| FaceId + matchScore on face objects | ✅ Phase-1 Complete | Not in original RFP |
| AMF metrics (riskScore, revisitCount, velocity, circularScore) | ✅ Phase-1 Complete | Not in original RFP |
| Legend — people/vehicles/fire/smoke | ✅ Phase-1 Complete | |
| Legend — face class | ✅ Phase-1 Complete | Not in original RFP |
| Legend — accessories (amber) | ✅ Phase-1 Complete | |
| Legend — sports equipment & cutlery *(new in v2.1)* | ✅ Phase-1 Complete | 14 classes in Accessories section |
| Legend — animals *(new in v2.1)* | ✅ Phase-1 Complete | 10 animal classes |
| Legend — outdoor/infrastructure *(new in v2.1)* | ✅ Phase-1 Complete | 8 classes |
| Legend — food/kitchen *(new in v2.1)* | ✅ Phase-1 Complete | 12 classes |
| Legend — home appliances *(new in v2.1)* | ✅ Phase-1 Complete | 11 classes |
| Legend — indoor/office classes | ✅ Phase-1 Complete | Not in original RFP |
| Legend — loitering | ✅ Phase-1 Complete | |
| Legend — AI attribute badges | ✅ Phase-1 Complete | Shows NO HELMET (not HAT); MASK?/HAT? gray badge added in v2.1 |
| Cross-Camera Re-ID feed (in Detections tab) *(new in v2.1)* | ✅ Phase-1 Complete | Conditional section; max 5 events; `face:reidentified` Socket.IO |
| ↔ CROSS-CAM badge on face rows *(new in v2.1)* | ✅ Phase-1 Complete | Via `isCrossCamera` prop + `useCrossCameraStore` |
| HAT? badge (hat.isHelmet null/undefined) *(new in v2.1)* | ✅ Phase-1 Complete | `bg-gray-600 text-gray-200` |
| MASK? badge (mask.status === 'uncertain') *(new in v2.1)* | ✅ Phase-1 Complete | `bg-gray-600 text-gray-200` |
| Sports/animals/outdoor/food/appliances color codes *(new in v2.1)* | ✅ Phase-1 Complete | 50+ additional COCO classes |
| Legend collapsible (▲/▼ toggle) *(new in v2.2)* | ✅ Phase-1 Complete | `showLegend` state; default collapsed; `max-h-64 overflow-y-auto` when open |
| Cross-Camera Re-ID feed collapsible *(new in v2.2)* | ✅ Phase-1 Complete | `showCrossCamera` state; default expanded; count badge in header |
| Two-tab panel (Detections + Video Analytics) | ✅ → **Superseded by v2.4** | Replaced by 2-column fullscreen + Dashboard sidebar Analytics tab |
| 2-column layout: Left=DetectionPanel / Right=Video *(v2.4)* | ✅ Phase-1 Complete | No tab bar; no Analytics in fullscreen |
| Video Analytics as Dashboard sidebar 4th tab *(v2.4)* | ✅ Phase-1 Complete | `SidebarTab = 'analytics'`; `App.tsx` sidebar; tab label `t.tabVideoAnalytics` |

### 10.3 Video Analytics Tab (`VideoAnalyticsTab.tsx`)

| Feature | Status | Notes |
|---------|--------|-------|
| Module toggle switches (all groups) | ✅ Phase-1 Complete | Not in original RFP |
| Model availability gate (caps API) | ✅ Phase-1 Complete | |
| Phase-2 pending indicators | ✅ Phase-1 Complete | Glasses, Sunglasses, Cloth |
| API: GET/PUT /api/analytics/config | ✅ Phase-1 Complete | |
| API: GET /api/capabilities | ✅ Phase-1 Complete | |
| Kalman Settings section (collapsible) | ✅ Phase-1 Complete | §7.5 — 6 sliders, debounced save, reset button |
| API: GET/PUT /api/tracker/config | ✅ Phase-1 Complete | Persisted to `storage/tracker.json` |
| API: POST /api/tracker/config/reset | ✅ Phase-1 Complete | Returns defaults and refreshes UI |

### 10.4 Data Pipeline

| Feature | Status | Notes |
|---------|--------|-------|
| YOLOv8n person/vehicle/accessory detection | ✅ Phase-1 Complete | |
| ByteTracker object tracking | ✅ Phase-1 Complete | |
| BehaviorEngine loitering analysis | ✅ Phase-1 Complete | |
| SCRFD face detection | ✅ Phase-1 Complete (model required) | `scrfd_2.5g.onnx` |
| Standalone face detection objects (90000+ IDs) | ✅ Phase-1 Complete | Not in original RFP |
| Face gallery + cosine similarity ID assignment | ✅ Phase-1 Complete | Not in original RFP |
| ArcFace face recognition | ✅ Phase-1 Complete (model required) | `arcface_w600k_r50.onnx` — original RFP marked as 🔲 |
| YOLOv8m PPE mask/helmet detection | ✅ Phase-1 Complete (model required) | `yolov8m_ppe.onnx` |
| Phase-1 color analysis (pixel average) | ✅ Phase-1 Complete | No model required |
| FireSmokeService | ✅ Phase-1 Complete (model required) | `yolov8s_fire_smoke.onnx` |
| Fire/smoke zone alert with 10s cooldown | ✅ Phase-1 Complete | Not in original RFP |
| AMF tracking metrics (risk, revisit, velocity, circular) | ✅ Phase-1 Complete | Not in original RFP |
| Indoor/office class detection | ✅ Phase-1 Complete | Via YOLOv8n COCO; not in original RFP |
| Inference frame-drop guard | ✅ Phase-1 Complete | Not in original RFP |
| Glasses / Sunglasses worn accessory detection | 🔲 Phase-2 Planned | Requires dedicated classifier |
| Cloth attribute analysis (PAR) | 🔲 Phase-2 | `_runPAR()` implemented in `colorClothService.js`; `openpar.onnx` auto-activates it. Generate with `python3 server/src/scripts/exportPAR.py` (fine-tune on PA-100K/RAPv2 for production accuracy) |

---

## 11. Model File Requirements

| Filename | Size | Location | Function |
|----------|------|----------|----------|
| `yolov8n.onnx` | ~6 MB | `server/models/` | Person/vehicle/accessory/indoor detection |
| `scrfd_2.5g.onnx` | ~3.2 MB | `server/models/` | Face detection |
| `yolov8m_ppe.onnx` | ~99 MB | `server/models/` | Mask/helmet PPE detection |
| `arcface_w600k_r50.onnx` | ~249 MB | `server/models/` | Face recognition embeddings |
| `yolov8s_fire_smoke.onnx` | ~22 MB | `server/models/` | Fire/smoke detection |
| `openpar.onnx` *(Phase-2)* | ~90 MB (ResNet50) | `server/models/` | Pedestrian Attribute Recognition — cloth type (upper/lower) + sleeve length. Generate: `python3 server/src/scripts/exportPAR.py` |

Model presence is checked via the `GET /api/capabilities` endpoint. When a model file is absent, the corresponding analytics module is automatically disabled and its toggle button is grayed out in the Video Analytics tab.

---

## 12. Known Differences from Original RFP

**v2.1 additions (2026-05-18):**

| Section | Change |
|---------|--------|
| 7.5 | New: Tracker / Kalman Settings collapsible section with 6 configurable sliders |
| 7.4 | New: `/api/tracker/config` GET/PUT and `/api/tracker/config/reset` POST endpoints |
| 10.3 | New: Kalman Settings section and tracker config API rows added to checklist |

---

### Known Differences from Original RFP v1.0

The following table summarizes all deviations between the original specification and the Phase-1 implementation:

| Section | Original RFP v1.0 | Actual Implementation |
|---------|-----------------|-----------------------|
| 2.2 / face class | Not listed as a class | `face` is a first-class detection with its own bbox, color, and panel row |
| 2.4 | No indoor classes | 15 indoor/office COCO classes with distinct colors |
| 3.2.2 Hat badge text | `HAT` when `isHelmet=false` | `NO HELMET` always; `safetyCompliant` drives badge color |
| 3.4 Face bbox | Internal sub-box inside person bbox | Not implemented; superseded by standalone face detection objects |
| 4.1 Zone type name | `EXCLUSION` | `EXCLUDE` (in Zone type definition) |
| 5.1 Panel layout | Single tab | Fullscreen is 2-column (DetectionPanel + video); VideoAnalyticsTab is Dashboard sidebar 4th tab (v2.4) |
| 5.2 Detection row | No face row | Face row: `text-blue-300 + bg-blue-900/15` |
| 5.4 Fields | No AMF metrics | `riskScore`, `revisitCount`, `velocity`, `circularScore` shown for zone-matched objects |
| 5.5 HAT badge | `bg-gray-600` gray | Replaced by `NO HELMET` red (`bg-red-700`) |
| 5.5 MASK BAD label | `MASK?` (canvas) / `MASK BAD` (panel) | Canvas: `MASK?`; Panel: `MASK BAD` ✅ matches |
| 6.1 Legend | Two sections | Four sections (adds Accessories and Indoor/Office) |
| 7 Video Analytics | Not documented | Full toggle UI with 5 groups, 20+ modules, API integration |
| 7.1 payload | No `class` alias, no `faceId`, no AMF fields | `class` alias, `faceId`, `matchScore`, `riskScore`, `revisitCount`, `velocity`, `circularScore` added |
| 7.2 objectId ranges | Two ranges (ByteTracker + fire/smoke) | Three ranges (+ 90000+ for face objects) |
| 7.3 events | Only `detections` documented | 8 additional events documented |
| 9.3 ArcFace | Marked 🔲 Pending | ✅ Implemented (model required) |
| 9.3 Standalone face IDs | Not documented | `_assignFaceIds()` with cosine gallery, 30s expiry |
| 9.3 Fire zone alert | Not documented | `fire:alert` event with 10s per-zone cooldown |

---

## 14. Dashboard Detection Panel — All-Camera Aggregated View *(New in v2.5)*

**Status**: ✅ Implemented

### 14.1 Overview

The **Dashboard Detection tab** (sidebar 4th tab `👁`) is upgraded from a single-camera view to a **multi-camera aggregated detection feed**. All registered cameras' detections are merged into one list with per-row camera badges. The FullScreen individual camera Detection panel is unchanged.

### 14.2 Camera Filter — Checkbox Dropdown

A custom dropdown at the top of the Detection tab replaces the plain `<select>`:

```
┌─────────────────────────────────────────────┐
│  CAMERA  [All Cameras (3) ▼]               │
└─────────────────────────────────────────────┘
  ▼ dropdown open:
  ┌────────────────────────────────┐
  │ ☑ All                          │
  │ ──────────────────────────────│
  │ ☑ Entrance-Cam                 │
  │ ☑ Hallway-Cam                  │
  │ ☒ Parking-Cam   (unchecked)    │
  └────────────────────────────────┘
```

| State | Behaviour |
|---|---|
| All checked (default) | Label: "All Cameras (N)" — shows detections from every camera |
| Partial | Label: "N / M cameras" — hides unchecked cameras' detections |
| None checked | Empty list — label: "No cameras" |
| "All" checkbox clicked | Toggles all on or all off |

### 14.3 Detection List — All-Camera Merged

- Detections from all enabled cameras are merged into a single sorted list
- Sort order: **loitering first** → then by `dwellTime` descending
- Each row displays a **camera name badge** (teal/gray chip) at the top of the row
- All existing attributes (face, color, cloth, mask, hat, risk score, loitering) are displayed as in the individual camera panel
- **Person Trails** and **Cross-Camera Re-ID** feed are also shown (global, not per-camera)

### 14.4 Implementation

| Component | File | Notes |
|---|---|---|
| `useAllDetections(ids)` | `client/src/hooks/useAllDetections.ts` | New hook — manages Socket.IO subscribe/unsubscribe for multiple cameras; returns `Map<cameraId, Detection[]>` |
| `DashboardDetectionPanel` | `client/src/components/DashboardDetectionPanel.tsx` | New component — checkbox filter + merged list + camera badges |
| Detection tab | `client/src/App.tsx` | Replaces `<select>` + `<DetectionPanel>` with `<DashboardDetectionPanel>` |

### 14.5 `useAllDetections` Hook

```typescript
// Returns a Map<cameraId, Detection[]> for all enabled cameras.
// Manages Socket.IO camera:subscribe / camera:unsubscribe automatically.
// Uses shared subscriptionCounts from useCamera to avoid duplicate subscriptions.
export function useAllDetections(enabledCameraIds: string[]): Map<string, Detection[]>
```

- On mount: subscribes to all `enabledCameraIds` rooms
- On `enabledCameraIds` change: diff — subscribe new, unsubscribe removed
- On unmount: unsubscribes all
- On socket reconnect: re-subscribes all

---

## 13. References

- [RFP_AI_Human_Detection.md](./RFP_AI_Human_Detection.md) — Person/vehicle AI module spec
- [RFP_AI_Accessories_Detection.md](./RFP_AI_Accessories_Detection.md) — Accessories detection spec
- [RFP_AI_Face_Recognition.md](./RFP_AI_Face_Recognition.md) — Face detection and recognition spec
- [RFP_AI_Mask_Detection.md](./RFP_AI_Mask_Detection.md) — Mask/PPE detection spec
- [RFP_AI_Hat_Detection.md](./RFP_AI_Hat_Detection.md) — Helmet/hat detection spec
- [RFP_AI_Color_Analysis.md](./RFP_AI_Color_Analysis.md) — Color analysis spec
- [RFP_AI_Cloth_Analysis.md](./RFP_AI_Cloth_Analysis.md) — Cloth analysis spec (Phase-2)
- [RFP_AI_Fire_Smoke_Detection.md](./RFP_AI_Fire_Smoke_Detection.md) — Fire/smoke detection spec
- [RFP_AI_Vehicle_Detection.md](./RFP_AI_Vehicle_Detection.md) — Vehicle detection spec
- [RFP_LTS2026_Loitering_Tracking_System.md](./RFP_LTS2026_Loitering_Tracking_System.md) — System-level architecture
- [README.md](./README.md) — System overview
