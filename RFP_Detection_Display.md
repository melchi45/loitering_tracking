# RFP: Detection Visualization & Display Module

**Document No.**: LTS-2026-003
**Version**: 2.0
**Date**: 2026-05-18
**Classification**: Technical Requirements Specification (RFP)
**Status**: Updated to reflect Phase-1 implementation — gaps and additions documented

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

- Position: Inside bbox, bottom-left (`x`, `y+h-15`)
- Format: `↑{upper} ↓{lower}` (e.g. `↑red ↓black`)
- Font: `9px monospace`
- Background: `rgba(0,0,0,0.72)`
- Text: `#d1d5db` light gray

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

✅ Phase-1 Complete. The fullscreen view has a **two-tab left panel** (256px wide):

```
┌─────────────────────────────────────┐
│ [DETECTIONS] [VIDEO ANALYTICS]      │  ← Tab bar (blue underline = active)
├─────────────────────────────────────┤
│  DETECTIONS TAB:                    │
│                                     │
│ DETECTIONS           3 obj  1 loiter│  ← Panel header
├─────────────────────────────────────┤
│ PERSON               [LOITER] #a1b2 │
│ conf 96%  dwell 15.2s               │
│ x 120  y 80  w 60  h 120            │
│ risk 82%  revisit 2×                │  ← AMF metrics (zone-matched only)
│ vel  8px/s  ↻ circular              │
│ upper red | lower blue              │  ← color
│ face 89% [F1]                       │  ← face (score + faceId if set)
├─────────────────────────────────────┤
│ FACE                  [F3] sim 76%  │  ← standalone face det object
├─────────────────────────────────────┤
│ CAR                           #c3d4 │
│ conf 78%  dwell 2.0s                │
│ x 200  y 300  w 80  h 50            │
├─────────────────────────────────────┤
│ FIRE         [FIRE]           #e5f6 │  ← fire badge pulses (animate-pulse)
│ conf 91%  dwell 0.0s                │
├─────────────────────────────────────┤
│ ── Object Classes ─────────────────  │
│ ■ person   ■ loitering              │
│ ■ face     ■ bicycle                │
│ ■ car      ■ motorcycle             │
│ ■ bus      ■ truck                  │
│ ■ fire     ■ smoke                  │
│                                     │
│ ── Accessories ─────────────────── │
│ ■ backpack  ■ handbag               │
│ ■ suitcase  ■ umbrella              │
│ ■ tie                               │
│                                     │
│ ── Indoor / Office ────────────────│
│ ■ chair     ■ couch                 │
│ ■ dining t. ■ bed                   │
│ ... (14 indoor classes)             │
│                                     │
│ ── AI Attribute Badges ─────────── │
│ [MASK OK]  [NO MASK]                │
│ [HELMET]   [NO HELMET]              │
│ ⬚ face bbox   ↑↓ color             │
└─────────────────────────────────────┘
```

> **Note (v2.0):** The original RFP showed a single-tab panel. The actual implementation has a two-tab layout: "DETECTIONS" and "VIDEO ANALYTICS". The legend is expanded significantly — it now includes a separate "Indoor / Office" section with 14 object classes.

### 5.2 Detection Row Color Codes

✅ Phase-1 Complete. Additions since original RFP are marked.

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
| backpack / umbrella / handbag / tie / suitcase | `text-amber-400` | — |
| chair *(new)* | `text-violet-400` | — |
| couch *(new)* | `text-violet-300` | — |
| dining table *(new)* | `text-emerald-400` | — |
| bed *(new)* | `text-indigo-400` | — |
| tv *(new)* | `text-sky-400` | — |
| laptop *(new)* | `text-cyan-400` | — |
| mouse *(new)* | `text-amber-300` | — |
| keyboard *(new)* | `text-pink-400` | — |
| cell phone *(new)* | `text-red-300` | — |
| clock *(new)* | `text-emerald-300` | — |
| cup *(new)* | `text-orange-300` | — |
| bottle *(new)* | `text-lime-400` | — |
| book *(new)* | `text-violet-200` | — |
| vase *(new)* | `text-pink-300` | — |

### 5.3 Sort Order

✅ Phase-1 Complete.

1. **Loitering objects first** (`isLoitering = true`)
2. **Descending `dwellTime`** (longest dwell at top)

### 5.4 Displayed Fields Per Object

> **Note (v2.0):** Several fields are new relative to the original RFP.

| Field | Condition | Format |
|-------|-----------|--------|
| `className` | Always | Uppercase |
| `objectId` | Always (non-face) | `#` + first 8 digits |
| `faceId` | `className === 'face'` | `[F1]`, `[F2]`, … |
| `matchScore` | Face detection, `matchScore` present | `sim XX%` (colored by threshold) |
| `confidence` | Always | `conf XX%` |
| `dwellTime` | Always | `dwell X.Xs` (yellow if > 5s) |
| `bbox` | Always | `x`, `y`, `w`, `h` pixel values (2-column grid) |
| `riskScore` *(new)* | Zone-matched objects only | `risk XX%` (red ≥70%, yellow ≥40%) |
| `revisitCount` *(new)* | Zone-matched, `revisitCount > 0` | `revisit N×` orange |
| `velocity` *(new)* | Zone-matched objects | `vel Npx/s` (red if < 20px/s) |
| `circularScore` *(new)* | Zone-matched, `circularScore > 0.4` | `↻ circular` orange |
| `mask` | `det.mask` present | `MASK OK` / `NO MASK` / `MASK BAD` badge |
| `hat` | `det.hat` present | `HELMET` / `NO HELMET` badge |
| `color` | `det.color` present | `upper {color} \| lower {color}` |
| `face` (on person) | `det.face` present | `face XX% [FaceId] identity` |

### 5.5 Status Badges

> **Note (v2.0 correction):** The `HAT` badge in the original RFP is replaced by `NO HELMET`. The `MASK BAD` label (not `MASK?`) is used in the panel.

| Badge | Condition | Tailwind Class |
|-------|-----------|---------------|
| `LOITER` | `isLoitering === true` | `bg-red-600 text-white` |
| `FIRE` | `className === 'fire'` | `bg-orange-600 text-white animate-pulse` |
| `SMOKE` | `className === 'smoke'` | `bg-slate-600 text-white` |
| `MASK OK` | `mask.status === 'mask_correct'` | `bg-green-700 text-green-100` |
| `MASK BAD` | `mask.status === 'mask_incorrect'` | `bg-yellow-700 text-yellow-100` |
| `NO MASK` | `mask.status === 'no_mask'` | `bg-red-700 text-red-100` |
| `HELMET` | `hat.safetyCompliant === true` | `bg-blue-700 text-blue-100` |
| `NO HELMET` | `hat.safetyCompliant === false` | `bg-red-700 text-red-100` |
| `HELMET` / `NO HELMET` | `hat.safetyCompliant === null/undefined` | `bg-gray-600 text-gray-200` |

---

## 6. Legend Requirements

### 6.1 Legend Structure

✅ Phase-1 Complete. The legend is pinned to the bottom of the detection panel and contains four sections (three in the original RFP):

#### Section 1: Object Classes (People & Vehicles)
```
─ Object Classes ──────────────
■ person      ■ loitering
■ face        ■ bicycle
■ car         ■ motorcycle
■ bus         ■ truck
■ fire        ■ smoke
```

#### Section 2: Accessories
```
─ Accessories ─────────────────
■ backpack    ■ handbag
■ suitcase    ■ umbrella
■ tie
```

#### Section 3: Indoor / Office *(new in v2.0)*
```
─ Indoor / Office ─────────────
■ chair       ■ couch
■ dining table ■ bed
■ tv          ■ laptop
■ keyboard    ■ mouse
■ cell phone  ■ clock
■ cup         ■ bottle
■ book        ■ vase
```

#### Section 4: AI Attribute Badges
```
─ AI Attribute Badges ─────────
[MASK OK]    [NO MASK]
[HELMET]     [NO HELMET]
⬚ face bbox    ↑↓ color
```

### 6.2 Legend Color Specification

| Item | Tailwind Class | Description |
|------|---------------|-------------|
| person | `text-green-400` | Green |
| loitering | `text-red-400` | Red |
| face *(new)* | `text-blue-300` | Light blue |
| bicycle | `text-yellow-400` | Yellow |
| car | `text-blue-400` | Blue |
| motorcycle | `text-orange-400` | Orange |
| bus | `text-purple-400` | Purple |
| truck | `text-teal-400` | Teal |
| fire | `text-orange-500` | Orange-red |
| smoke | `text-slate-400` | Slate gray |
| accessories (all) | `text-amber-400` | Amber |
| chair | `text-violet-400` | Violet |
| couch | `text-violet-300` | Violet-300 |
| dining table | `text-emerald-400` | Emerald |
| bed | `text-indigo-400` | Indigo |
| tv | `text-sky-400` | Sky |
| laptop | `text-cyan-400` | Cyan |
| keyboard | `text-pink-400` | Pink |
| mouse | `text-amber-300` | Amber-300 |
| cell phone | `text-red-300` | Red-300 |
| clock | `text-emerald-300` | Emerald-300 |
| cup | `text-orange-300` | Orange-300 |
| bottle | `text-lime-400` | Lime |
| book | `text-violet-200` | Violet-200 |
| vase | `text-pink-300` | Pink-300 |
| MASK OK | `bg-green-700/70 text-green-100` | Green badge |
| NO MASK | `bg-red-700/70 text-red-100` | Red badge |
| HELMET | `bg-blue-700/70 text-blue-100` | Blue badge |
| NO HELMET *(was HAT)* | `bg-red-700/70 text-red-100` | Red badge |
| face bbox | `text-blue-400` | Light blue dashed |
| color | `text-gray-400` | Gray text |

---

## 7. Video Analytics Tab Requirements — New in v2.0

✅ Phase-1 Complete. The original RFP did not document the Video Analytics tab.

### 7.1 Tab Location and Access

The Video Analytics tab is the second tab in the fullscreen view's left panel (alongside "Detections"). It is accessible by clicking "VIDEO ANALYTICS" in the tab bar.

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
| AI Attributes | Cloth | Phase-2 (pending) |
| Hazards | Fire, Smoke (`yolov8s_fire_smoke.onnx`) | Phase-1 |
| Indoor / Office | Chair, Couch, Desk/Table, Laptop, TV, Keyboard, Mouse, Phone, Clock, Cup, Bottle, Book | Phase-1 |

### 7.3 Toggle Button States

| State | Appearance |
|-------|-----------|
| Enabled | `bg-blue-700/70 border-blue-500 text-white` |
| Disabled (model present) | `bg-gray-800 border-gray-700 text-gray-400` |
| Unavailable (model missing) | `opacity-35 cursor-not-allowed bg-gray-800` + "미설치" label |
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
  upper?: string;
  lower?: string;
}
```

> **Note (v2.0 corrections vs original RFP:**
> - `Detection.class` field (alias for `className`) is present in the type but was not in the original spec.
> - `FaceAttribute` has additional optional fields: `faceId`, `identity`, `matchScore`.
> - `HatAttribute` has an additional `safetyCompliant` field.
> - `ColorAttribute` has optional `upperRgb`/`lowerRgb` fields.
> - `ClothAttribute` now has typed `upper`/`lower` string fields (was `[key: string]: unknown`).
> - Several new top-level Detection fields: `faceId`, `matchScore`, `riskScore`, `revisitCount`, `velocity`, `circularScore`.

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
| `camera:status` | Server → Client | Status changes (connecting/streaming/offline/reconnecting/error) |
| `camera:error` | Server → Client | Fatal pipeline error |
| `camera:stats` | Server → Client | Frame count and FPS stats |
| `alert:new` | Server → All | Saved loitering alert broadcast to all clients |

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
| Color attribute (↑upper ↓lower) | ✅ Phase-1 Complete | |
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
| Face attribute display (score + faceId + identity) | ✅ Phase-1 Complete | |
| FaceId + matchScore on face objects | ✅ Phase-1 Complete | Not in original RFP |
| AMF metrics (riskScore, revisitCount, velocity, circularScore) | ✅ Phase-1 Complete | Not in original RFP |
| Legend — people/vehicles/fire/smoke | ✅ Phase-1 Complete | |
| Legend — face class | ✅ Phase-1 Complete | Not in original RFP |
| Legend — accessories (amber) | ✅ Phase-1 Complete | |
| Legend — indoor/office classes | ✅ Phase-1 Complete | Not in original RFP |
| Legend — loitering | ✅ Phase-1 Complete | |
| Legend — AI attribute badges | ✅ Phase-1 Complete | Shows NO HELMET (not HAT) |
| Two-tab panel (Detections + Video Analytics) | ✅ Phase-1 Complete | Not in original RFP |

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
| Cloth attribute analysis | 🔲 Phase-2 Planned | Reserved `ClothAttribute` structure |

---

## 11. Model File Requirements

| Filename | Size | Location | Function |
|----------|------|----------|----------|
| `yolov8n.onnx` | ~6 MB | `server/models/` | Person/vehicle/accessory/indoor detection |
| `scrfd_2.5g.onnx` | ~3.2 MB | `server/models/` | Face detection |
| `yolov8m_ppe.onnx` | ~99 MB | `server/models/` | Mask/helmet PPE detection |
| `arcface_w600k_r50.onnx` | ~249 MB | `server/models/` | Face recognition embeddings |
| `yolov8s_fire_smoke.onnx` | ~22 MB | `server/models/` | Fire/smoke detection |

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
| 5.1 Panel layout | Single tab | Two tabs: "DETECTIONS" + "VIDEO ANALYTICS" |
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
