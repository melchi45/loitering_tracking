# DESIGN DOCUMENT
# AI Module — Color Analysis

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-05 |
| **Version** | 1.5 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Color_Analysis.md |

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [File Structure](#2-file-structure)
3. [Server-Side Design](#3-server-side-design)
4. [Client-Side Design](#4-client-side-design)
5. [Data Model](#5-data-model)
6. [API Design](#6-api-design)
7. [Sequence Diagrams](#7-sequence-diagrams)
8. [Configuration & Environment](#8-configuration--environment)
9. [Error Handling](#9-error-handling)
10. [Phase-3 Proposed Architecture — Human Parsing Model Catalog](#10-phase-3-proposed-architecture--human-parsing-model-catalog)
11. [Phase-1.5 Proposed — K-Means Dominant Color on the Existing Fixed ROI (No Model)](#11-phase-15-proposed--k-means-dominant-color-on-the-existing-fixed-roi-no-model)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (React)                        │
│  App.tsx ──────────── window.__ltsSocket (Socket.IO client) │
│      └─ PersonAttributePanel / DetectionOverlay             │
│           └─ Socket.IO: 'detections' event                  │
│                  detections[].personAttrs.color             │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP / WebSocket
┌────────────────────────▼────────────────────────────────────┐
│                     SERVER (Express + Socket.IO)             │
│                                                              │
│  services/colorClothService.js                              │
│   ├─ rgbToColorName(r, g, b)   — pure HSV classifier        │
│   ├─ avgColor(jpegBuf, roi, imgW?, imgH?) — 8×8 avg         │
│   ├─ fastColor(buf, bbox, imgW?, imgH?)  — upper+lower      │
│   └─ _colorReady = true   (always, no model required)       │
│                                                              │
│  services/attributePipeline.js                              │
│   ├─ fastColor() for pre-tracking color attachment          │
│   └─ analyze() for full color+cloth in enrich()             │
│                                                              │
│  services/pipelineManager.js                                 │
│   ├─ zone check: 'color' in zone.targetClasses              │
│   └─ attaches personAttrs.color to detections               │
│                                                              │
│  (No ONNX model required for color analysis)                │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── colorClothService.js   # rgbToColorName, avgColor, fastColor, analyze
│   │   │   ├── attributePipeline.js   # Invokes fastColor + analyze per person
│   │   │   └── pipelineManager.js     # Zone gating for 'color' targetClass
│   │   └── index.js
│   └── models/
│       └── (no model needed for Phase-1 color analysis)
│
├── client/
│   └── src/
│       ├── components/
│       │   └── PersonAttributePanel.tsx  # color chips display (upper/lower)
│       └── types/
│           └── index.ts
│
├── docs/
│   ├── srs/SRS_AI_Color_Analysis.md
│   └── design/Design_AI_Color_Analysis.md  ← this file
│
└── test/
    └── api/
        └── color_analysis.test.js
```

---

## 3. Server-Side Design

### 3.1 ColorClothService — Color Functions (`server/src/services/colorClothService.js`)

**Pure function: `rgbToColorName(r, g, b)`**

The HSV classification algorithm operates in three stages:

```
Input: r, g, b ∈ [0, 255]

Stage 1 — HSV conversion:
  rn = r/255, gn = g/255, bn = b/255
  max = Math.max(rn,gn,bn)
  min = Math.min(rn,gn,bn)
  delta = max - min
  v = max
  s = (max === 0) ? 0 : delta / max

Stage 2 — Achromatic check (priority):
  if s < 0.15:
    if v < 0.25 → 'black'
    if v > 0.80 → 'white'
    else         → 'gray'

Stage 3 — Chromatic hue classification:
  h (0–360°) computed from max channel:
    max=rn: h = 60 * (((gn-bn)/delta) % 6)
    max=gn: h = 60 * ((bn-rn)/delta + 2)
    max=bn: h = 60 * ((rn-gn)/delta + 4)
  if h < 0: h += 360

  Brown exception (checked first):
    h ∈ [10, 50) AND v < 0.55 → 'brown'

  Hue ranges:
    h < 15 OR h ≥ 345     → 'red'
    h ∈ [15, 50)          → 'orange'
    h ∈ [50, 75)          → 'yellow'
    h ∈ [75, 150)         → 'green'
    h ∈ [150, 195)        → 'cyan'
    h ∈ [195, 260)        → 'blue'
    h ∈ [260, 320)        → 'purple'
    h ∈ [320, 345)        → 'red'
```

**Valid output set (exactly 11 colors):**
```
'black' | 'white' | 'gray' | 'red' | 'orange' | 'yellow' |
'green' | 'cyan' | 'blue' | 'purple' | 'brown'
```

**`avgColor(jpegBuffer, roi, imgW?, imgH?)`:**

```
Input: roi = { x, y, w, h }

Clamping:
  left   = max(0, round(x))
  top    = max(0, round(y))
  right  = imgW ? min(imgW, round(x+w)) : round(x+w)
  bottom = imgH ? min(imgH, round(y+h)) : round(y+h)
  width  = max(1, right - left)
  height = max(1, bottom - top)

sharp(jpegBuffer)
  .extract({ left, top, width, height })
  .resize(8, 8, { fit: 'fill' })
  .removeAlpha()
  .raw()
  .toBuffer()
  → raw[192 bytes] (64 pixels × 3 channels)

avg = sum(channel) / 64 → round
returns [R_avg, G_avg, B_avg]

On sharp error: returns [128, 128, 128]  (neutral gray fallback)
```

**`fastColor(jpegBuffer, personBbox, imgW?, imgH?)`:**

```
ROI computation:
  upperRoi = {
    x: bbox.x + bbox.width  * 0.15,
    y: bbox.y + bbox.height * 0.25,
    w: bbox.width  * 0.70,
    h: bbox.height * 0.30,
  }
  lowerRoi = {
    x: bbox.x + bbox.width  * 0.15,
    y: bbox.y + bbox.height * 0.55,
    w: bbox.width  * 0.70,
    h: bbox.height * 0.35,
  }

Parallel extraction:
  [upperRgb, lowerRgb] = await Promise.all([
    avgColor(jpegBuffer, upperRoi, imgW, imgH),
    avgColor(jpegBuffer, lowerRoi, imgW, imgH),
  ])

Returns:
  {
    upper:    rgbToColorName(upperRgb[0], upperRgb[1], upperRgb[2]),
    lower:    rgbToColorName(lowerRgb[0], lowerRgb[1], lowerRgb[2]),
    upperRgb,
    lowerRgb,
  }
```

**Design notes:**
- `_colorReady = true` immediately after construction (no model load needed)
- `fastColor()` is called by PipelineManager **before** `tracker.update()` so color data feeds into multi-cue tracker association
- `analyze()` calls the same avgColor logic for color and additionally calls `_runPAR()` for cloth

### 3.2 AttributePipeline — Color Integration

```javascript
// Two invocation paths:

// Path 1 — fastColor (pre-tracker, no model):
async fastColor(jpegBuffer, bbox, imgW, imgH) {
  return this._color.fastColor(jpegBuffer, bbox, imgW, imgH);
}

// Path 2 — full analyze (post-tracker, zone-gated):
const needColor = this._color.ready && (config.color !== false || config.cloth !== false);
if (needColor) {
  await Promise.all(persons.map(async (p) => {
    const attrs = await this._color.analyze(jpegBuffer, p.bbox, origW, origH);
    colorMap.set(p.objectId, attrs);
  }));
}
// Per enriched person:
if (config.color !== false) enriched.color = color;
```

---

## 4. Client-Side Design

### 4.1 Color Chip Display

**Socket.IO color consumption:**
```typescript
socket.on('detections', (frame: DetectionFrame) => {
  frame.detections
    .filter(d => d.className === 'person' && d.personAttrs?.color)
    .forEach(person => {
      const { upper, lower } = person.personAttrs.color;
      // Render color swatch chips under the bounding box
      // e.g. "Upper: blue | Lower: black"
    });
});
```

**Color swatch mapping:**
```typescript
const COLOR_HEX: Record<string, string> = {
  black:  '#000000', white:  '#FFFFFF', gray:   '#808080',
  red:    '#E53935', orange: '#FB8C00', yellow: '#FDD835',
  green:  '#43A047', cyan:   '#00ACC1', blue:   '#1E88E5',
  purple: '#8E24AA', brown:  '#6D4C41',
};
```

---

## 5. Data Model

### 5.1 Color Attribute Object

```typescript
interface ColorAttribute {
  upper:    string;                    // one of 11 color names
  lower:    string;                    // one of 11 color names
  upperRgb: [number, number, number];  // avg RGB for upper ROI [0–255]
  lowerRgb: [number, number, number];  // avg RGB for lower ROI [0–255]
}
```

### 5.2 ROI Definition

```typescript
interface Roi {
  x: number;  // left edge in frame pixels
  y: number;  // top edge in frame pixels
  w: number;  // width
  h: number;  // height
}
```

### 5.3 Upper and Lower ROI Parameters

| Region | x offset | y offset | width | height |
|---|---|---|---|---|
| Upper torso | bbox.x + width × 0.15 | bbox.y + height × 0.25 | width × 0.70 | height × 0.30 |
| Lower torso | bbox.x + width × 0.15 | bbox.y + height × 0.55 | width × 0.70 | height × 0.35 |

### 5.4 HSV Classification Table

| Condition | Output |
|---|---|
| s < 0.15 AND v < 0.25 | black |
| s < 0.15 AND v > 0.80 | white |
| s < 0.15 AND 0.25 ≤ v ≤ 0.80 | gray |
| s ≥ 0.15 AND h∈[10,50) AND v < 0.55 | brown |
| s ≥ 0.15 AND (h < 15 OR h ≥ 345) | red |
| s ≥ 0.15 AND h∈[15,50) | orange |
| s ≥ 0.15 AND h∈[50,75) | yellow |
| s ≥ 0.15 AND h∈[75,150) | green |
| s ≥ 0.15 AND h∈[150,195) | cyan |
| s ≥ 0.15 AND h∈[195,260) | blue |
| s ≥ 0.15 AND h∈[260,320) | purple |
| s ≥ 0.15 AND h∈[320,345) | red |

---

## 6. API Design

### 6.1 Capabilities Endpoint

```
GET /api/capabilities
→ 200:
{
  "ai": {
    "humanDetection": true,
    "colorAnalysis": true,    // always true (no model required)
    "colorMethod": "hsv-pixel-average"
  }
}
```

### 6.2 Analytics Config — Color Gate

```
GET /api/analytics/config
→ 200: includes 'color' class enable/disable state

PUT /api/analytics/config
  Body: { "feature": "color", "enabled": false }
→ 200: { "success": true }
  Effect: 'color' removed from zone targetClasses processing
```

### 6.3 Socket.IO Events

| Event | Direction | Payload Field | Condition |
|---|---|---|---|
| `detections` | Server → Client | `detections[].personAttrs.color` | Zone has 'color' in targetClasses |
| `detections` | Server → Client | `personAttrs.color` absent/null | Zone does not include 'color' |

---

## 7. Sequence Diagrams

### 7.1 Pre-Tracker fastColor Flow

```
Camera JPEG Frame
  │
  ├─ pipelineManager: for each raw person detection
  │     └─ AttributePipeline.fastColor(jpegBuf, bbox, w, h)
  │           └─ ColorClothService.fastColor()
  │                 ├─ Promise.all([avgColor(upperRoi), avgColor(lowerRoi)])
  │                 │     ├─ sharp.extract().resize(8,8).removeAlpha().raw()
  │                 │     └─ channel average → [R, G, B]
  │                 └─ rgbToColorName(R, G, B) × 2
  │                       → { upper:'blue', lower:'black', upperRgb:[...], lowerRgb:[...] }
  │
  ├─ detection.color = { upper, lower, upperRgb, lowerRgb }
  └─ TrackingService.update(detectionsWithColor)  ← color used in tracker association
```

### 7.2 Zone-Gated Color Analysis (Post-Tracker)

```
Tracked persons (zone has 'color' in targetClasses)
  │
  ├─ AttributePipeline.enrich(jpegBuf, w, h, persons, zones, {color:true})
  │     └─ ColorClothService.analyze(jpegBuf, bbox, w, h)
  │           ├─ avgColor(upperRoi) + avgColor(lowerRoi)  [parallel]
  │           └─ { color: { upper, lower, upperRgb, lowerRgb }, cloth: null }
  │
  ├─ enriched[].color = { upper:'red', lower:'gray', ... }
  └─ io.emit('detections', enrichedFrame)
```

---

## 8. Configuration & Environment

### 8.1 Key Constants (all fixed in code)

```javascript
// colorClothService.js

// ROI proportions
const UPPER_ROI = { yStart: 0.25, yEnd: 0.55, xInset: 0.15 };
const LOWER_ROI = { yStart: 0.55, yEnd: 0.90, xInset: 0.15 };

// Achromatic threshold
const SAT_THRESHOLD = 0.15;

// Brightness cutoffs for black/white
const BLACK_V = 0.25;
const WHITE_V = 0.80;

// Brown exception
const BROWN_H_LOW  = 10;
const BROWN_H_HIGH = 50;
const BROWN_V_MAX  = 0.55;
```

### 8.2 Zone Config for Color

```javascript
const zone = {
  targetClasses: ['color'],   // enables fastColor + analyze
  // OR
  targetClasses: ['color', 'cloth'],  // enables color + PAR cloth
};
```

### 8.3 No Model Required

- `_colorReady` is set to `true` in the constructor — before `load()` is called
- `fastColor()` and `rgbToColorName()` are purely computational; no I/O except sharp
- No environment variables specific to color analysis (shared with cloth service)

---

## 9. Error Handling

| Scenario | Handler | Behavior |
|---|---|---|
| `sharp.extract()` throws (out-of-bounds ROI) | `avgColor()` try/catch | Returns `[128, 128, 128]` → classifies as `'gray'` |
| Zero/negative bbox dimensions | `Math.max(1, ...)` clamp | Prevents zero-size extract; gray fallback returned |
| `imgW`/`imgH` not provided | Skip edge clamping in `avgColor()` | ROI used as-is; may trigger sharp error → gray fallback |
| JPEG buffer invalid | `sharp(buf)` throws | Caught; `[128, 128, 128]` returned per ROI |
| Zone does not include 'color' | PipelineManager gate | `fastColor()`/`analyze()` not called for color; `personAttrs.color` absent |
| Concurrent `fastColor()` calls | All-local params | No shared mutable state; each call fully independent |

---

## 10. Phase-3 Proposed Architecture — Human Parsing Model Catalog

> **Status: Implemented, opt-in** (2026-07-09 proposed → 2026-07-09 코드 구현 완료, `humanParsing` 토글 기본 비활성). `colorClothService.js#_runHumanParsing()`/`reloadHumanParsing()`, `kmeansColor.js`(단위 테스트 완료), `analyticsConfig.js`의 `humanParsing` 플래그, `analysisApi.js`의 `human-parsing` family 모델 카탈로그(hot-swap)로 구현되었다. 모델 파일(`schp_lip.onnx`/`segformer_clothes.onnx`)은 `downloadModels.js`에서 기본 비활성(`enabled:false`, 라이선스 검토 후 수동 다운로드), 마스크 기반 색상 분류 자체에 대한 동작 테스트는 없음(용량/토글 수준의 테스트만 존재 — `TC_AI_Color_Analysis.md` 참조). 대응 SRS 요구사항은 `docs/srs/SRS_AI_Color_Analysis.md` §11 (FR-CLR-022~027).

### 10.1 Why Human Parsing

Phase-1's fixed-fraction ROI + plain pixel average is weaker than even the simplest tier the reference guides describe (K-Means dominant color on a fixed top/bottom split). Human Parsing (pixel-level clothing segmentation) is the guides' top-accuracy tier and removes the fixed-rectangle assumption — a mask can exclude skin/background pixels that a rectangle cannot.

### 10.2 Candidate Models (Interchangeable via Catalog)

| Model | License | Classes | Input | ONNX source |
|---|---|---|---|---|
| SCHP (LIP-20, ResNet-101) | MIT | 20 (bg, hat, hair, ..., upper-clothes, dress, coat, ..., pants, jumpsuits, ..., skirt, ...) | 473×473 (native); downscaled to 256×256 for this project's per-frame budget | `pirocheto/schp-lip-20` (HF, community export) |
| SegFormer clothes (MiT-B2) | NVIDIA SegFormer NC-inherited (non-commercial) | 18 (hat, hair, upper-clothes, skirt, pants, dress, belt, shoes, face, arms, legs, bag, scarf, ...) | Model-native | `Xenova/segformer_b2_clothes` (HF, ready ONNX) |

This project is **not a commercial deployment**, so SegFormer's NC license inheritance is not a blocker here — both models are usable. Because the guide explicitly frames these as mutually substitutable ("Human Parsing" as a category, not one specific model), both are registered as swappable catalog entries rather than hardcoding one.

**Candidate considered and excluded from the catalog — CE2P**: The guide's tier-1 list also names CE2P (Context Embedding Human Parsing) alongside SCHP and SegFormer. Unlike those two, CE2P has no maintained ONNX export available from a public source at the time of this analysis (its reference implementations are Caffe/PyTorch research checkpoints) — adding it would require doing the PyTorch→ONNX conversion work in-house first, whereas SCHP and SegFormer are usable immediately via existing community ONNX exports (`pirocheto/schp-lip-20`, `Xenova/segformer_b2_clothes`). CE2P is not registered in `EXTENDED_CATALOG`; it can be reconsidered if a maintained ONNX export becomes available and SCHP/SegFormer prove insufficient.

**Alternative considered and rejected — Person Attribute Recognition (whole-crop, non-pixel-mask)**: the CCTV/IPTV 상의하의 색상분류 guide's (now-consolidated, original deleted 2026-07-09) second tier (ALM/MGN/OSNet-PAR trained on RAP/PETA) classifies `{upper_color, lower_color, gender, backpack}` directly from a whole-person crop, without a pixel mask. `openpar.onnx` (Phase-2 Cloth, §3.1 above) already uses this whole-crop attribute-head pattern, but its exported head only classifies clothing *type* — no color output exists in the current export (`exportPAR.py`'s 12-attribute head). Human Parsing (pixel mask) was chosen over extending the PAR head with a color branch because a whole-crop classifier inherits the same background/skin-pixel contamination problem Phase-1's fixed-rectangle ROI already has; a pixel mask resolves this at the source. Extending `openpar.onnx`'s attribute head with a color branch remains a smaller, cheaper alternative if Human Parsing's inference cost proves too high in practice — noted here for future reconsideration, not pursued in this proposal.

**Alternative considered and rejected — Re-ID model attribute head (FastReID)**: The guide's tier-3 (§3 "Re-ID 모델 활용") notes that FastReID can grow a `Top Color / Bottom Color / Gender / Age` attribute head alongside its embedding output. This is architecturally the same whole-crop attribute-classifier pattern as the PAR alternative above (and inherits the same background/skin-pixel contamination weakness), so it is rejected for the same reason and is not treated as a separate proposal. FastReID/OSNet is still adopted in this project — but strictly for its embedding output (identity matching), not its optional color head — see `Design_AI_AppearanceReID.md` §12.

### 10.3 Model Catalog Extension (reuses YOLO detector UX)

The existing `MODEL_CATALOG` array in `server/src/routes/analysisApi.js` (YOLO detectors only, `GET/POST /api/analysis/models`, `/models/switch`, `/models/download`) already provides download-with-progress + hot-swap-active semantics, rendered by the Admin Dashboard's "AI Models" tab (`client/src/pages/admin/AdminUsersPage.tsx`). Proposed extension:

```
MODEL_CATALOG entry (new fields for non-YOLO families):
{
  id: 'schp-lip20', label: 'SCHP (LIP-20)', family: 'human-parsing',
  file: 'schp_lip.onnx', url: '<HF resolve URL>',
  classMap: { upper: [5, 6, 7], lower: [9, 10, 12] },   // model-specific indices → semantic role
  license: 'MIT',
}
{
  id: 'segformer-b2-clothes', label: 'SegFormer B2 Clothes', family: 'human-parsing',
  file: 'segformer_b2_clothes.onnx', url: '<HF resolve URL>',
  classMap: { upper: [4, 7, ...], lower: [5, 6, ...] },  // different index scheme — resolved via classMap, not code
  license: 'NVIDIA SegFormer NC (non-commercial) — acceptable for this non-commercial project',
}
```

- Only one `family: 'human-parsing'` entry may be "active" at a time (same in-memory `active` derivation the YOLO catalog already uses — no new persistence layer).
- `colorClothService.js` reads the active entry's `classMap` at inference time instead of hardcoding LIP-20 indices — this is what makes the two models genuinely interchangeable rather than requiring a code branch per model.
- Download/switch handlers are reused as-is; only the catalog array and the `classMap` consumer are new.

### 10.4 Per-Track Throttled Execution & Cache

```
colorClothService._parseCache: Map<objectId, { ts, color }>

analyze(jpegBuffer, personBbox, imgW, imgH, opts = {}):
  if opts.useHumanParsing && opts.objectId:
    cached = _parseCache.get(opts.objectId)
    if cached && (now - cached.ts) < HP_INTERVAL_MS:   // default 4000ms
      return cached.color
    if _hpReady:
      mask, rgbFlat = _runHumanParsing(...)            // single crop+resize reused for both
      upperPixels = pixels where mask ∈ classMap.upper
      lowerPixels = pixels where mask ∈ classMap.lower
      upperRgb = kmeansColor.dominantColor(upperPixels) || legacy avgColor(upperRoi)   // fallback if <20 px
      lowerRgb = kmeansColor.dominantColor(lowerPixels) || legacy avgColor(lowerRoi)
      color = { upper: rgbToColorName(upperRgb), lower: rgbToColorName(lowerRgb), upperRgb, lowerRgb, source: 'human-parsing' }
      _parseCache.set(opts.objectId, { ts: now, color })
      return color
  // else: Phase-1 legacy path unchanged (no `source` field, or source:'legacy')
```

**Cache lifecycle**: keyed by `objectId` (the same tracker-stable ID `attributePipeline.js` already uses for `colorMap`). Entries are removed via a `dropTrack(objectId)` hook called from `pipelineManager.js` at the exact points where `ctx._trackMeta.delete(trackKey)` already runs when ByteTrack expires a track (`tracking.js`'s `popRemovedTracks()`) — not by insertion-order/size-based eviction, which would incorrectly evict long-lived active tracks before short-lived dead ones (`Map` preserves original insertion position across `.set()` updates to an existing key).

### 10.5 Gating Fix Required at Implementation Time — Done

`attributePipeline.js`'s gate was extended as anticipated: `needColor = this._color.ready && (config.color !== false || config.cloth !== false || config.humanParsing === true)`. Note the implemented condition uses `config.humanParsing === true` (explicit opt-in) rather than the `!== false` form originally proposed here — both behave identically given `DEFAULT_CONFIG.humanParsing = false`, but `=== true` is the stricter/safer form (an unset or non-boolean value can never accidentally open the gate).

### 10.6 Explicit Non-Goals (this proposal)

- No admin-configurable interval setting in v1 — `HP_INTERVAL_MS` is a hardcoded constant (avoids speculative config surface; per-track interval tuning can be added later if needed).
- No Vector DB for color/cloth attributes — color remains a scalar attribute on the tracked object, not an embedding. (Vector DB is separately proposed for Appearance Re-ID — see `Design_AI_AppearanceReID.md` §12.)

---

## 11. Phase-1.5 Proposed — K-Means Dominant Color on the Existing Fixed ROI (No Model)

> **Status: Proposed, not yet implemented.** Closes a residual gap in the §10 analysis: the CCTV/IPTV 상의하의 색상분류 guide's (now-consolidated, original deleted 2026-07-09) §4 ("상하의 색상만 필요할 경우") describes a **fourth, no-model tier**, distinct from both Phase-1 (this project's current code) and Phase-3 Human Parsing (§10) — a fixed top/bottom bbox split whose pixels are reduced with **K-Means / Dominant Color**, which the guide states reaches "실무 정확도 약 85~90%" (~85–90% practical accuracy). §10.1 above already notes that Phase-1 is weaker than this tier ("Phase-1's fixed-fraction ROI + plain pixel average is weaker than even the simplest tier the reference guides describe"), but the proposed fix so far has only been Phase-3 (a full model). This section records the cheaper, model-free fix the guide itself recommends for that same tier.

### 11.1 What Changes vs. Phase-1

Phase-1's `avgColor()` (§3.1) shrinks the ROI to 8×8 with `sharp` and takes a **plain mean** of the 64 pixels. Phase-1.5 keeps the exact same ROI rectangles (FR-CLR-005/006 — no change to the 25–55%/55–90% split) and the exact same output schema, but replaces the reduction step:

```
Phase-1   (current):  sharp.resize(8,8) → plain mean of 64 px → rgbToColorName()
Phase-1.5 (proposed): sharp.resize(N,N) → kmeansColor.dominantColor(pixels) → rgbToColorName()
```

`kmeansColor.dominantColor()` (`server/src/utils/kmeansColor.js`) already exists and is unit-tested (`kmeansColor.test.js`) — it was built for §10's Human Parsing mask pixels, but it is a pure `[r,g,b][] → [r,g,b]` function with no dependency on a mask; it works identically on a plain rectangular ROI's pixel set. A plain mean is pulled toward any secondary color present in the ROI (background sliver, skin, shadow); K-Means separates the ROI into `k` clusters and returns the centroid of the largest one, which is closer to what a human would call "the" dominant color — this is the exact distinction the guide draws between "단순 평균" (simple average, not recommended) and "K-Means/Dominant Color" (recommended).

### 11.2 Why This Is Cheaper Than Phase-3

| | Phase-1 (current) | Phase-1.5 (proposed) | Phase-3 (§10, proposed) |
|---|---|---|---|
| Model required | None | None | SCHP or SegFormer ONNX |
| ROI source | Fixed rectangle | Fixed rectangle (unchanged) | Pixel-level parsing mask |
| Reduction method | Plain mean (8×8) | K-Means (guide's tier-4 method) | K-Means (guide's tier-1 method) |
| Extra latency/person | ~0 (baseline) | Sub-millisecond (K-Means over a small resized patch, `maxIter=6`, already the same cost profile validated for §10's mask pixels) | Full segmentation inference (§10.4 per-track throttle exists specifically because this is expensive) |
| Expected accuracy (guide's own figures) | Below guide's simplest tier | ~85–90% (guide §4) | Highest tier (guide §1) |

Phase-1.5 is a strict quality upgrade to the **always-on** code path (no model, no toggle, no opt-in) — unlike Phase-3, which is gated behind `humanParsing` and a multi-hundred-MB model download. It does not replace Phase-3; it raises the floor for every deployment that never enables Phase-3.

### 11.3 Proposed Implementation Shape

- Resize the ROI to a larger patch than 8×8 (e.g. 16×16 or 32×32 — large enough for K-Means to see real structure, small enough to stay cheap) before flattening to a pixel list.
- Pass that pixel list to the existing `dominantColor(pixels, k=2, maxIter=6)` instead of averaging.
- If `dominantColor()` returns `null` (fewer than 20 pixels — degenerate ROI, same guard already used in §10.4), fall back to the current plain-mean `avgColor()` result rather than failing the region.
- No new zone-config field or `analyticsConfig` toggle — this replaces the internal reduction step of the *existing* always-on `color` targetClass, so FR-CLR-005 through FR-CLR-009's external contract (ROI geometry, return schema) is unchanged; only the internal pixel-reduction algorithm referenced by FR-CLR-008 changes.

### 11.4 Non-Goals

- Not a replacement for Phase-3 — Human Parsing's pixel mask still removes background/skin contamination that a rectangular ROI (even with K-Means) cannot; Phase-1.5 only upgrades the reduction step within the existing rectangle.
- No accuracy benchmark run yet — the guide's "85–90%" figure is the source guide's own claim, not a measurement taken against this project's camera footage. Validating it is future work, not a blocker to documenting the proposal.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Color Analysis |
| 1.1 | 2026-07-09 | Youngho Kim | Added §10 Phase-3 proposed architecture (Human Parsing model catalog, per-track cache, classMap-based model substitutability) — not yet implemented |
| 1.2 | 2026-07-09 | Youngho Kim | Added §10.2 note on Person Attribute Recognition (whole-crop) alternative considered and rejected — final gap check before source guide deletion |
| 1.3 | 2026-07-09 | Youngho Kim | Added §10.2 CE2P (considered, excluded — no maintained ONNX export) and FastReID-attribute-head (rejected — same whole-crop pattern as PAR) notes; added §11 Phase-1.5 proposed — K-Means dominant color on the existing fixed ROI, no model required. Closes the remaining gap between `CCTV_IPTV_상의하의_색상분류_가이드.md` and this design ahead of source guide deletion |
| 1.4 | 2026-07-09 | Youngho Kim | Source guide `docs/rfp/CCTV_IPTV_상의하의_색상분류_가이드.md` deleted — full content confirmed reflected in §10–11, in-doc citations updated to archival notes |
| 1.5 | 2026-07-09 | Youngho Kim | Code sync — §10 Human Parsing flipped Proposed→Implemented, opt-in (`colorClothService.js#_runHumanParsing`, `kmeansColor.js`, `analyticsConfig.humanParsing`, model-catalog hot-swap confirmed in code); §10.5 gating fix confirmed done. §11 Phase-1.5 remains unimplemented — not touched by this sync |
