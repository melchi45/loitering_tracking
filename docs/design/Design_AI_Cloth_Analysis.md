# DESIGN DOCUMENT
# AI Module — Cloth Analysis

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-04 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent SRS** | srs/SRS_AI_Cloth_Analysis.md |

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
10. [Relationship to Proposed Human Parsing (Color Phase-3)](#10-relationship-to-proposed-human-parsing-color-phase-3)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (React)                        │
│  App.tsx ──────────── window.__ltsSocket (Socket.IO client) │
│      └─ PersonAttributePanel / LiveFeedTab                  │
│           └─ Socket.IO: 'detections' event                  │
│                  detections[].personAttrs.cloth              │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP / WebSocket
┌────────────────────────▼────────────────────────────────────┐
│                     SERVER (Express + Socket.IO)             │
│                                                              │
│  services/attributePipeline.js                              │
│   ├─ _color: ColorClothService                              │
│   └─ enrich()  — cloth attr when zone targetClass='cloth'   │
│                                                              │
│  services/colorClothService.js                              │
│   ├─ load()          — checks openpar.onnx existence        │
│   ├─ analyze()       — color + cloth combined               │
│   ├─ _runPAR()       — PAR ONNX inference (Phase-2)         │
│   ├─ _parSession     — ONNX InferenceSession (or null)      │
│   └─ _parReady       — boolean flag                         │
│                                                              │
│  services/pipelineManager.js                                 │
│   ├─ zone check: 'cloth' in zone.targetClasses              │
│   └─ attaches personAttrs.cloth to detections               │
│                                                              │
│  models/                                                     │
│   ├─ yolov8n.onnx         (person detection)                │
│   └─ openpar.onnx         (PAR model, Phase-2, optional)    │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure

```
loitering_tracking/
├── server/
│   ├── src/
│   │   ├── services/
│   │   │   ├── colorClothService.js   # ColorClothService: color + PAR cloth analysis
│   │   │   ├── attributePipeline.js   # Orchestrates color/cloth/face/ppe enrichment
│   │   │   └── pipelineManager.js     # Zone-gated cloth analysis invocation
│   │   └── index.js
│   ├── models/
│   │   ├── yolov8n.onnx               # Person detection
│   │   └── openpar.onnx               # PAR cloth model (Phase-2, optional)
│   └── storage/
│       └── lts.json
│
├── client/
│   └── src/
│       ├── components/
│       │   └── PersonAttributePanel.tsx  # Displays cloth attributes
│       └── types/
│           └── index.ts
│
├── docs/
│   ├── srs/SRS_AI_Cloth_Analysis.md
│   └── design/Design_AI_Cloth_Analysis.md  ← this file
│
└── test/
    └── api/
        └── cloth_analysis.test.js
```

---

## 3. Server-Side Design

### 3.1 ColorClothService (`server/src/services/colorClothService.js`)

**Responsibilities:**
- Phase-1: HSV-based color extraction (always available)
- Phase-2: PAR ONNX cloth attribute inference (optional, requires `openpar.onnx`)
- Expose `analyze(jpegBuffer, personBbox, imgW, imgH)` returning `{ color, cloth }`

**Key design points:**

| Method | Input | Output | Phase |
|---|---|---|---|
| `load()` | — | `Promise<void>` | Both |
| `analyze(buf, bbox, imgW?, imgH?)` | JPEG + person bbox | `{ color, cloth }` | Both |
| `fastColor(buf, bbox, imgW?, imgH?)` | JPEG + person bbox | `{ upper, lower, upperRgb, lowerRgb }` | Phase-1 |
| `_runPAR(buf, bbox)` | JPEG + person bbox | `{ upper, lower, sleeve } \| null` | Phase-2 |

**Phase state machine:**

```
constructor()
  → _parSession = null
  → _parReady   = false
  → _colorReady = true     ← Phase-1 immediately ready

load()
  → check fs.existsSync(openpar.onnx)
  │
  ├─ NOT FOUND:
  │     log '[ColorClothService] openpar.onnx not found — cloth type analysis pending (Phase-2)'
  │     _parReady stays false
  │
  ├─ FOUND, load succeeds:
  │     _parSession = ort.InferenceSession
  │     _parReady   = true
  │     log '[ColorClothService] PAR model loaded (Phase-2 cloth analysis active)'
  │
  └─ FOUND, load throws:
        log warning with error message
        _parReady stays false
```

**PAR inference pipeline (`_runPAR`):**

```
JPEG Buffer + personBbox
  │
  ├─ sharp.extract({ left, top, width, height })   ← clamp to ≥1px
  │    .resize(128, 256, { fit: 'fill' })           ← W×H = 128×256
  │    .removeAlpha().raw()
  │
  ├─ ImageNet normalization:
  │     MEAN = [0.485, 0.456, 0.406]
  │     STD  = [0.229, 0.224, 0.225]
  │     value = (pixel/255 - mean[ch]) / std[ch]
  │
  ├─ Float32Array[98304] — NCHW layout [1, 3, 256, 128]
  │     index = ch * 256 * 128 + row * 128 + col
  │
  ├─ _parSession.run({ input: tensor })
  │     → res.attrs.data  ← Float32Array[12]
  │
  └─ Attribute classification:
       Upper  (indices 0–5):  argmax → threshold 0.45 → label or 'unknown'
       Lower  (indices 6–9):  argmax → threshold 0.45 → label or 'unknown'
       Sleeve (indices 10–11): scores[10] >= scores[11] → 'short' else 'long'
```

**ATTR_LABELS index map:**

| Index | Label | Category |
|---|---|---|
| 0 | tshirt | upper |
| 1 | shirt | upper |
| 2 | jacket | upper |
| 3 | hoodie | upper |
| 4 | vest | upper |
| 5 | dress | upper |
| 6 | pants | lower |
| 7 | jeans | lower |
| 8 | shorts | lower |
| 9 | skirt | lower |
| 10 | short_sleeve | sleeve |
| 11 | long_sleeve | sleeve |

### 3.2 AttributePipeline (`server/src/services/attributePipeline.js`)

**Cloth analysis integration:**

```javascript
// In enrich()
const needColor = this._color.ready && (config.color !== false || config.cloth !== false);

if (needColor) {
  await Promise.all(persons.map(async (p) => {
    const attrs = await this._color.analyze(jpegBuffer, p.bbox, origW, origH);
    colorMap.set(p.objectId, attrs);
  }));
}

// Per person: attach cloth attribute
if (config.cloth !== false && cloth) enriched.cloth = cloth;
```

**Zone gating for cloth:**
```javascript
// pipelineManager checks zone.targetClasses before calling enrich()
const config = {
  color: zone.targetClasses.includes('color'),
  cloth: zone.targetClasses.includes('cloth'),
};
```

### 3.3 PAR Model Specifications

| Property | Value |
|---|---|
| Model file | `server/models/openpar.onnx` |
| Input name | `input` |
| Input shape | `[1, 3, 256, 128]` |
| Input dtype | `float32` |
| Output name | `attrs` |
| Output shape | `[12]` |
| Output dtype | `float32` |

---

## 4. Client-Side Design

### 4.1 Person Attribute Panel

**Socket.IO cloth attribute consumption:**
```typescript
socket.on('detections', (frame: DetectionFrame) => {
  frame.detections
    .filter(d => d.className === 'person' && d.personAttrs?.cloth)
    .forEach(person => {
      const { upper, lower, sleeve } = person.personAttrs.cloth;
      // Display: "Jacket | Jeans | Long sleeve"
    });
});
```

**Phase display logic:**
```typescript
// personAttrs.cloth === null → PAR model not loaded (Phase-1)
// personAttrs.cloth === { upper, lower, sleeve } → Phase-2 active
if (!person.personAttrs?.cloth) {
  renderClothPending();  // show "Cloth analysis pending"
} else {
  renderClothAttrs(person.personAttrs.cloth);
}
```

---

## 5. Data Model

### 5.1 Cloth Attribute Object

```typescript
interface ClothAttribute {
  upper:  'tshirt' | 'shirt' | 'jacket' | 'hoodie' | 'vest' | 'dress' | 'unknown';
  lower:  'pants' | 'jeans' | 'shorts' | 'skirt' | 'unknown';
  sleeve: 'short' | 'long';
}
```

### 5.2 AnalyzeResult (returned by `analyze()`)

```typescript
interface AnalyzeResult {
  color: {
    upper:    string;
    lower:    string;
    upperRgb: [number, number, number];
    lowerRgb: [number, number, number];
  };
  cloth: ClothAttribute | null;  // null in Phase-1 or on PAR error
}
```

### 5.3 Socket.IO Detection Payload (cloth field)

```typescript
// Within TrackedPerson (detections event)
interface TrackedPerson {
  ...
  personAttrs?: {
    color?: { upper: string; lower: string; upperRgb: number[]; lowerRgb: number[] };
    cloth?: ClothAttribute | null;
  };
}
```

---

## 6. API Design

### 6.1 Capabilities Endpoint

```
GET /api/capabilities
→ 200:
{
  "ai": {
    "humanDetection": true,
    "clothAnalysis": false,       // Phase-1: false (PAR model absent)
    "clothAnalysisPhase": 1,      // 1 or 2
    "colorAnalysis": true         // always true (Phase-1 HSV available)
  }
}

Phase-2 (PAR model loaded):
{
  "ai": {
    "clothAnalysis": true,
    "clothAnalysisPhase": 2
  }
}
```

### 6.2 Socket.IO Events

| Event | Direction | Payload Field | Phase |
|---|---|---|---|
| `detections` | Server → Client | `detections[].personAttrs.cloth` | Phase-2 only |
| `detections` | Server → Client | `detections[].personAttrs.cloth` is `null` | Phase-1 |

---

## 7. Sequence Diagrams

### 7.1 Startup — Phase-1 (No PAR Model)

```
Server start
  │
  ├─ AttributePipeline.load()
  │     └─ ColorClothService.load()
  │           ├─ fs.existsSync('openpar.onnx') → false
  │           └─ log: 'openpar.onnx not found — cloth type analysis pending (Phase-2)'
  │                _parReady = false, _colorReady = true
  │
  └─ GET /api/capabilities → clothAnalysis: false
```

### 7.2 Per-Frame Cloth Analysis (Phase-2 Active)

```
Camera JPEG Frame (zone has 'cloth' in targetClasses)
  │
  ├─ pipelineManager: config.cloth = true
  ├─ AttributePipeline.enrich(jpegBuf, w, h, persons, zones, {cloth:true})
  │     └─ ColorClothService.analyze(jpegBuf, personBbox, w, h)
  │           ├─ avgColor(upperRoi) + avgColor(lowerRoi)  → color result
  │           └─ _parReady → _runPAR(jpegBuf, personBbox)
  │                 ├─ sharp.extract → resize(128,256) → removeAlpha → raw
  │                 ├─ ImageNet normalize → Float32Array[98304] NCHW
  │                 ├─ _parSession.run({ input: tensor })
  │                 └─ scores[12] → { upper, lower, sleeve }
  │
  ├─ enriched[].personAttrs.cloth = { upper:'jacket', lower:'jeans', sleeve:'long' }
  └─ io.emit('detections', enrichedFrame)
```

---

## 8. Configuration & Environment

### 8.1 Model Paths

```javascript
// colorClothService.js constructor defaults
this.parModelPath = options.parModelPath ||
  path.resolve(__dirname, '..', '..', 'models', 'openpar.onnx');
```

### 8.2 PAR Classification Thresholds

```javascript
const THRESH = 0.45;  // Fixed constant — all upper/lower classifications

// Upper types (index 0–5)
const upperTypes = ['tshirt', 'shirt', 'jacket', 'hoodie', 'vest', 'dress'];

// Lower types (index 6–9)
const lowerTypes = ['pants', 'jeans', 'shorts', 'skirt'];

// Sleeve: no threshold — always returns 'short' or 'long'
const sleeve = scores[10] >= scores[11] ? 'short' : 'long';
```

### 8.3 AttributePipeline Zone Config

```javascript
// Zone configuration to enable cloth analysis
const zone = {
  id: 'zone-01',
  targetClasses: ['cloth'],   // enables PAR cloth analysis
  dwellThresholdSec: 30,
};
```

---

## 9. Error Handling

| Scenario | Handler | Behavior |
|---|---|---|
| `openpar.onnx` absent at load | `ColorClothService.load()` | `_parReady = false`; `cloth: null` always returned |
| PAR model load exception | `load()` try/catch | Warn log; `_parReady = false`; Phase-1 continues |
| `_runPAR()` crop/inference error | `_runPAR()` try/catch | Returns `null`; `analyze()` returns `{ color, cloth: null }` |
| Degenerate bbox (width/height = 0) | `Math.max(1, ...)` clamp | Prevents zero-size sharp extract; color returns gray fallback |
| Zone does not include 'cloth' | PipelineManager config | `analyze()` not called; `personAttrs.cloth` absent |
| PAR model not ready but zone has 'cloth' | `_parReady` check in `analyze()` | `cloth: null` returned; no error |

---

## 10. Relationship to Proposed Human Parsing (Color Phase-3)

`docs/design/Design_AI_Color_Analysis.md` §10 (proposed, 2026-07-09) introduces a Human Parsing model (SCHP/SegFormer) for **Color Analysis** Phase-3. This is a distinct concern from Cloth Analysis (this document):

| | Cloth Analysis (this doc, `_runPAR()`) | Color Analysis Phase-3 (proposed) |
|---|---|---|
| Question answered | What **type** of garment? (tshirt/shirt/jacket/pants/jeans/shorts/skirt, sleeve length) | What **region** of the crop is upper vs. lower clothing, for color sampling? |
| Model | `openpar.onnx` (custom-trained ResNet50 head, whole-bbox crop) | SCHP/SegFormer (pixel-level segmentation mask) |
| Output | Classification label (`upper`, `lower`, `sleeve`) | Per-pixel class mask consumed by `colorClothService`'s K-Means color extraction |

The two do not overlap or conflict — Human Parsing's mask could, in principle, also improve `_runPAR()`'s crop quality in a future phase, but that integration is out of scope for the current Color Analysis Phase-3 proposal and is not tracked here.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Cloth Analysis |
| 1.1 | 2026-07-09 | Youngho Kim | Added §10 cross-reference clarifying PAR(clothing type) vs proposed Human Parsing(clothing region mask, Color Analysis Phase-3) boundary |
