# DESIGN DOCUMENT
# AI Module — Color Analysis

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-05 |
| **Version** | 1.0 |
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

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Color Analysis |
