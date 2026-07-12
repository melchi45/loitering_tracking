# DESIGN DOCUMENT
# AI Module — Cloth Analysis

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-04 |
| **Version** | 2.0 |
| **Status** | Active |
| **Date** | 2026-07-12 |
| **Parent SRS** | srs/SRS_AI_Cloth_Analysis.md |
| **Related Design** | design/Design_AI_Model_Catalog.md §8 (PromptPAR memory gate, full detail) |

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
11. [Model Choice & Memory Gate](#11-model-choice--memory-gate)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (React)                        │
│  App.tsx ──────────── window.__ltsSocket (Socket.IO client) │
│      └─ PersonAttributePanel / LiveFeedTab                  │
│           └─ Socket.IO: 'detections' event                  │
│                  detections[].personAttrs.cloth              │
│  Admin Dashboard → AI Models → Cloth Attribute (PAR)         │
│      └─ Select PromptPAR or OpenPAR, click Activate          │
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
│   ├─ load()          — checks parModelPath existence,       │
│   │                     memory-gates PromptPAR (§11)         │
│   ├─ reloadPar()     — model catalog hot-swap (§11)         │
│   ├─ analyze()       — color + cloth combined                │
│   ├─ _runPAR()       — PAR ONNX inference (26 PA100k attrs) │
│   ├─ _parSession     — ONNX InferenceSession (or null)      │
│   └─ _parReady       — boolean flag                         │
│                                                              │
│  services/analyticsConfig.js                                │
│   └─ cloth flag — turned off automatically when the         │
│      PromptPAR memory gate fails (§11)                       │
│                                                              │
│  services/pipelineManager.js                                 │
│   ├─ zone check: 'cloth' in zone.targetClasses               │
│   └─ attaches personAttrs.cloth to detections                │
│                                                              │
│  routes/analysisApi.js                                       │
│   └─ cloth-par catalog family: 2 selectable entries (§11)     │
│                                                              │
│  models/                                                     │
│   ├─ yolov8n.onnx                    (person detection)     │
│   ├─ openpar_pa100k.onnx             (PromptPAR, shipped)    │
│   └─ openpar_resnet50_pa100k.onnx    (OpenPAR, manual export)│
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
│   │   │   │                          #   + PromptPAR memory gate (§11)
│   │   │   ├── analyticsConfig.js     # cloth toggle — auto-disabled by the memory gate
│   │   │   ├── attributePipeline.js   # Orchestrates color/cloth/face/ppe enrichment
│   │   │   └── pipelineManager.js     # Zone-gated cloth analysis invocation
│   │   ├── routes/
│   │   │   └── analysisApi.js         # cloth-par model catalog entries + switch/download
│   │   └── index.js
│   ├── models/
│   │   ├── yolov8n.onnx                    # Person detection
│   │   ├── openpar_pa100k.onnx             # PromptPAR (CLIP ViT-L, PA100k) — shipped
│   │   └── openpar_resnet50_pa100k.onnx    # OpenPAR (ResNet50, PA100k) — manual export
│   └── storage/
│       └── lts.json
│
├── client/
│   └── src/
│       ├── components/
│       │   └── PersonAttributePanel.tsx  # Displays cloth attributes
│       ├── pages/admin/
│       │   └── AdminUsersPage.tsx        # AI Models → Cloth Attribute (PAR) selector
│       └── types/
│           └── index.ts                  # ClothAttribute (26 PA100k fields)
│
├── docs/
│   ├── srs/SRS_AI_Cloth_Analysis.md
│   ├── design/Design_AI_Cloth_Analysis.md  ← this file
│   └── design/Design_AI_Model_Catalog.md   § 8 — PromptPAR memory gate full detail
│
└── test/
    └── api/
        ├── ai_detection_modules.test.js
        └── model_catalog.test.js           # TC-MC-017~019 — cloth-par catalog + memory gate
```

---

## 3. Server-Side Design

### 3.1 ColorClothService (`server/src/services/colorClothService.js`)

**Responsibilities:**
- Phase-1: HSV-based color extraction (always available)
- Phase-2: PAR ONNX cloth attribute inference — admin picks one of two models (§11):
  - PromptPAR (PA100k) — CLIP ViT-L backbone + text-prompt fusion, 26 attributes, forced CPU, memory-gated
  - OpenPAR (ResNet50, PA100k) — plain ResNet50 classifier head, same 26-attribute taxonomy, not memory-gated
- Expose `analyze(jpegBuffer, personBbox, imgW, imgH)` returning `{ color, cloth }`

**Key design points:**

| Method | Input | Output | Phase |
|---|---|---|---|
| `load()` | — | `Promise<void>` | Both |
| `analyze(buf, bbox, imgW?, imgH?)` | JPEG + person bbox | `{ color, cloth }` | Both |
| `fastColor(buf, bbox, imgW?, imgH?)` | JPEG + person bbox | `{ upper, lower, upperRgb, lowerRgb }` | Phase-1 |
| `_runPAR(buf, bbox)` | JPEG + person bbox | 26-field PA100k attribute object `\| null` | Phase-2 |
| `reloadPar(filePath)` | ONNX path | `Promise<void>` (throws on memory-gate failure) | Phase-2 |
| `_checkPromptParGate(filePath)` | ONNX path | `boolean` (also disables `cloth` on failure) | Phase-2 |

**Phase state machine:**

```
constructor()
  → _parSession = null
  → _parReady   = false
  → _colorReady = true     ← Phase-1 immediately ready

load()
  → check fs.existsSync(parModelPath)
  │
  ├─ NOT FOUND:
  │     log '[ColorClothService] openpar.onnx not found — cloth type analysis pending (Phase-2)'
  │     _parReady stays false
  │
  ├─ FOUND, memory gate fails (PromptPAR only — see §11):
  │     log '[ColorClothService] PromptPAR 수행 불가능: 가용 메모리 부족 (...) — Cloth 분석을 비활성화합니다.'
  │     analyticsConfig.setConfig({ cloth: false })
  │     _parReady stays false — model load is skipped entirely
  │
  ├─ FOUND, gate passes (or model is OpenPAR — never gated), load succeeds:
  │     _parSession = ort.InferenceSession
  │     _parReady   = true
  │     log '[ColorClothService] PAR model loaded (Phase-2 cloth analysis active)'
  │
  └─ FOUND, load throws:
        log warning with error message
        _parReady stays false
```

**PAR inference pipeline (`_runPAR`, PromptPAR/OpenPAR share this preprocessing and output contract):**

```
JPEG Buffer + personBbox
  │
  ├─ sharp.extract({ left, top, width, height })   ← clamp to ≥1px
  │    .resize(224, 224, { fit: 'fill' })           ← W×H = 224×224
  │    .removeAlpha().raw()
  │
  ├─ Normalization (mean=0.5/std=0.5, NOT ImageNet — matches PromptPAR's
  │  own get_transform()):
  │     value = (pixel/255 - 0.5) / 0.5
  │
  ├─ Float32Array[3*224*224] — NCHW layout [1, 3, 224, 224]
  │     index = ch * 224 * 224 + row * 224 + col
  │
  ├─ _parSession.run({ input: tensor })
  │     → res.attrs.data  ← Float32Array[26] raw logits (no sigmoid yet)
  │
  └─ sigmoid(logit) per attribute → threshold 0.5 (boolean flags) or
     argmax within a group (gender/ageGroup/viewAngle/lower type)
```

**PA100K_ATTR_WORDS index map** (verbatim CLIP text-prompt order used at export time — see `server/src/scripts/exportPAR.py`; identical for both PromptPAR and OpenPAR since they share the PA100k taxonomy):

| Index | Attribute word | Group |
|---|---|---|
| 0 | female | gender |
| 1–3 | age over 60 / 18 to 60 / less 18 | age |
| 4–6 | front / side / back | view angle |
| 7–8 | hat / glasses | accessories |
| 9–12 | hand bag / shoulder bag / backpack / hold objects in front | bags |
| 13–18 | short sleeve / long sleeve / upper stride / upper logo / upper plaid / upper splice | upper style |
| 19–24 | lower stripe / lower pattern / long coat / trousers / shorts / skirt and dress | lower style |
| 25 | boots | footwear |

Output object field names (see `ClothAttribute` in §5.1): `sleeve`, `lower`, `gender`, `ageGroup`, `viewAngle`, `hat`, `glasses`, `handBag`, `shoulderBag`, `backpack`, `holdObjectsInFront`, `upperStride`, `upperLogo`, `upperPlaid`, `upperSplice`, `lowerStripe`, `lowerPattern`, `longCoat`, `boots`. There is no categorical upper-garment-type field (tshirt/shirt/jacket/...) — PA100k has no direct equivalent, only sleeve length + style flags.

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

`config.cloth` is read from `analyticsConfig` on every frame — so when the PromptPAR memory gate flips it to `false` (§11), enrichment stops attaching `cloth` on the very next frame without any pipeline restart.

**Zone gating for cloth:**
```javascript
// pipelineManager checks zone.targetClasses before calling enrich()
const config = {
  color: zone.targetClasses.includes('color'),
  cloth: zone.targetClasses.includes('cloth'),
};
```

### 3.3 PAR Model Specifications

| Property | PromptPAR (PA100k) | OpenPAR (ResNet50, PA100k) |
|---|---|---|
| Catalog id | `openpar-pa100k` | `openpar-resnet50-pa100k` |
| Model file | `server/models/openpar_pa100k.onnx` | `server/models/openpar_resnet50_pa100k.onnx` |
| Backbone | CLIP ViT-L + text-prompt fusion | ResNet50 classifier head |
| Input name | `input` | `input` |
| Input shape | `[1, 3, 224, 224]` | `[1, 3, 224, 224]` |
| Input dtype | `float32` | `float32` |
| Output name | `attrs` | `attrs` |
| Output shape | `[26]` | `[26]` |
| Output dtype | `float32` (raw logits, sigmoid applied in `_runPAR`) | `float32` |
| Execution provider | Forced CPU (`forceCpu: true`) | Default provider selection |
| Memory gate | Yes — see §11 | No |
| Source | Shipped directly in `server/models/` (no automated download) | `manualOnly` — no public pretrained ONNX, export via OpenPAR repo |

---

## 4. Client-Side Design

### 4.1 Person Attribute Panel

**Socket.IO cloth attribute consumption:**
```typescript
socket.on('detections', (frame: DetectionFrame) => {
  frame.detections
    .filter(d => d.className === 'person' && d.personAttrs?.cloth)
    .forEach(person => {
      const { gender, ageGroup, sleeve, lower, hat, backpack } = person.personAttrs.cloth;
      // Display: "female | 18to60 | long sleeve | trousers | hat | backpack"
    });
});
```

**Phase display logic:**
```typescript
// personAttrs.cloth === undefined → PAR model not loaded (Phase-1, or memory-gated off)
// personAttrs.cloth === { ...26 PA100k fields } → Phase-2 active
if (!person.personAttrs?.cloth) {
  renderClothPending();  // show "Cloth analysis pending"
} else {
  renderClothAttrs(person.personAttrs.cloth);
}
```

### 4.2 Admin Dashboard — Model Selection

`client/src/pages/admin/AdminUsersPage.tsx` → `AiModelsSection()` renders both `cloth-par` catalog entries under the **Cloth Attribute (PAR)** series (reuses the same generic table used by every other model family — no bespoke UI). An admin:

1. Sees both rows: `PromptPAR (PA100k)` and `OpenPAR (ResNet50, PA100k)`, each with its own License/Size/Action column.
2. Clicks **Activate** on whichever row has `exists: true` (PromptPAR ships pre-installed; OpenPAR requires a manual export first — its row shows a **Manual export** link to the OpenPAR repo instead).
3. If PromptPAR's activation fails the memory gate, the request returns HTTP 500 and the failure message (in Korean, matching the server log) surfaces in the dashboard's error banner — the admin can then either free memory and retry, or activate OpenPAR instead.

A footnote under the series table states the ≥2GB free-RAM requirement for PromptPAR and that OpenPAR has no such gate (see §11.1 for full rationale).

---

## 5. Data Model

### 5.1 Cloth Attribute Object

```typescript
// PromptPAR / OpenPAR (PA100k, 26 attributes) — see server/src/services/colorClothService.js _runPAR()
export interface ClothAttribute {
  lower?: string;        // 'trousers' | 'shorts' | 'skirtAndDress'
  sleeve?: string;        // 'short' | 'long'
  gender?: 'female' | 'male';
  ageGroup?: 'over60' | '18to60' | 'less18';
  viewAngle?: 'front' | 'side' | 'back';
  hat?: boolean;
  glasses?: boolean;
  handBag?: boolean;
  shoulderBag?: boolean;
  backpack?: boolean;
  holdObjectsInFront?: boolean;
  upperStride?: boolean;
  upperLogo?: boolean;
  upperPlaid?: boolean;
  upperSplice?: boolean;
  lowerStripe?: boolean;
  lowerPattern?: boolean;
  longCoat?: boolean;
  boots?: boolean;
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
  cloth: ClothAttribute | null;  // null in Phase-1, on PAR error, or when memory-gated off
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
    "clothAnalysis": false,       // Phase-1, or memory-gated off: PAR model absent/disabled
    "clothAnalysisPhase": 1,      // 1 or 2
    "colorAnalysis": true         // always true (Phase-1 HSV available)
  }
}

Phase-2 (a cloth-par model loaded — PromptPAR or OpenPAR):
{
  "ai": {
    "clothAnalysis": true,
    "clothAnalysisPhase": 2
  }
}
```

### 6.2 Model Catalog Endpoints (see Design_AI_Model_Catalog.md §5, §8 for full detail)

| Endpoint | Behavior for `cloth-par` |
|---|---|
| `GET /api/analysis/models` | Returns both `openpar-pa100k` and `openpar-resnet50-pa100k` entries with `exists`/`active` flags |
| `POST /api/analysis/models/switch { modelId }` | Hot-swaps via `ColorClothService.reloadPar()` — memory-gated for `openpar-pa100k`, throws HTTP 500 with a Korean error message on gate failure |
| `POST /api/analysis/models/download { modelId }` | `openpar-resnet50-pa100k` is `manualOnly` → 409; `openpar-pa100k` already exists → `{ already: true }` |

### 6.3 Socket.IO Events

| Event | Direction | Payload Field | Phase |
|---|---|---|---|
| `detections` | Server → Client | `detections[].personAttrs.cloth` | Phase-2 only |
| `detections` | Server → Client | `detections[].personAttrs.cloth` is `null`/absent | Phase-1, or memory-gated off |

---

## 7. Sequence Diagrams

### 7.1 Startup — Phase-1 (No PAR Model)

```
Server start
  │
  ├─ AttributePipeline.load()
  │     └─ ColorClothService.load()
  │           ├─ fs.existsSync(parModelPath) → false
  │           └─ log: 'openpar.onnx not found — cloth type analysis pending (Phase-2)'
  │                _parReady = false, _colorReady = true
  │
  └─ GET /api/capabilities → clothAnalysis: false
```

### 7.2 Startup — PromptPAR Present but Memory Gate Fails

```
Server start
  │
  ├─ AttributePipeline.load()
  │     └─ ColorClothService.load()
  │           ├─ fs.existsSync('openpar_pa100k.onnx') → true
  │           ├─ _checkPromptParGate() → os.freemem() < PROMPTPAR_MIN_FREE_MEM_MB
  │           ├─ log: 'PromptPAR 수행 불가능: 가용 메모리 부족 (...) — Cloth 분석을 비활성화합니다.'
  │           ├─ analyticsConfig.setConfig({ cloth: false })
  │           └─ _parReady stays false — ONNX session is never created
  │
  └─ GET /api/capabilities → clothAnalysis: false
     GET /api/analytics/config → cloth: false
```

### 7.3 Per-Frame Cloth Analysis (Phase-2 Active)

```
Camera JPEG Frame (zone has 'cloth' in targetClasses)
  │
  ├─ pipelineManager: config.cloth = true
  ├─ AttributePipeline.enrich(jpegBuf, w, h, persons, zones, {cloth:true})
  │     └─ ColorClothService.analyze(jpegBuf, personBbox, w, h)
  │           ├─ avgColor(upperRoi) + avgColor(lowerRoi)  → color result
  │           └─ _parReady → _runPAR(jpegBuf, personBbox)
  │                 ├─ sharp.extract → resize(224,224) → removeAlpha → raw
  │                 ├─ mean=0.5/std=0.5 normalize → Float32Array[3*224*224] NCHW
  │                 ├─ _parSession.run({ input: tensor })
  │                 └─ sigmoid(logits[26]) → { gender, ageGroup, sleeve, lower, hat, ... }
  │
  ├─ enriched[].personAttrs.cloth = { gender:'female', sleeve:'long', lower:'trousers', ... }
  └─ io.emit('detections', enrichedFrame)
```

### 7.4 Admin Switches from OpenPAR to PromptPAR at Runtime, Gate Fails

```
Admin Dashboard → AI Models → Cloth Attribute (PAR) → Activate (PromptPAR row)
  │
  ├─ POST /api/analysis/models/switch { modelId: 'openpar-pa100k' }
  ├─ analysisApi.js: fs.existsSync(filePath) → true
  ├─ AttributePipeline._color.reloadPar(filePath)
  │     ├─ _checkPromptParGate(filePath) → false (insufficient free RAM)
  │     ├─ log + analyticsConfig.setConfig({ cloth: false })
  │     └─ throws Error('PromptPAR 수행 불가능: ...')
  │
  ├─ analysisApi.js catch block → HTTP 500 { error: <message> }
  └─ Admin Dashboard error banner shows the message; OpenPAR remains active
     (the previously active session, if any, is untouched — reloadPar()
     throws before replacing _parSession)
```

---

## 8. Configuration & Environment

### 8.1 Model Paths

```javascript
// colorClothService.js constructor defaults
this.parModelPath = options.parModelPath ||
  path.resolve(__dirname, '..', '..', 'models', 'openpar_pa100k.onnx');
```

The active model is switched at runtime via `reloadPar(filePath)` (model catalog hot-swap) rather than by changing this default — see §11 / Design_AI_Model_Catalog.md §5.

### 8.2 PAR Classification Thresholds

```javascript
const THRESH = 0.5;  // sigmoid(logit) >= THRESH → boolean attribute true

// Grouped (argmax within group, not independent thresholds):
//   gender:    'female' vs 'male'          (single threshold on P['female'])
//   ageGroup:  'over60' | '18to60' | 'less18'
//   viewAngle: 'front' | 'side' | 'back'
//   lower:     'trousers' | 'shorts' | 'skirtAndDress'
// sleeve: no threshold — P['short sleeve'] >= P['long sleeve'] ? 'short' : 'long'
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

### 8.4 Memory Gate Environment Variable

| Variable | Default | Description |
|---|---|---|
| `PROMPTPAR_MIN_FREE_MEM_MB` | `2048` | Minimum free system RAM (MB) required before PromptPAR (`openpar_pa100k.onnx`) is loaded or hot-swapped in. Does not apply to OpenPAR. See §11. |

---

## 9. Error Handling

| Scenario | Handler | Behavior |
|---|---|---|
| PAR model file absent at load | `ColorClothService.load()` | `_parReady = false`; `cloth: null` always returned |
| PromptPAR present but memory gate fails | `ColorClothService.load()` / `_checkPromptParGate()` | Logs `PromptPAR 수행 불가능: ...`; `analyticsConfig.setConfig({ cloth: false })`; model load skipped; `_parReady` stays `false` |
| PromptPAR hot-swap (`reloadPar()`) memory gate fails | `reloadPar()` | Same logging + `cloth: false` side effect, then throws — surfaced as HTTP 500 by `POST /api/analysis/models/switch` |
| PAR model load exception (non-memory) | `load()` try/catch | Warn log; `_parReady = false`; Phase-1 continues |
| `_runPAR()` crop/inference error | `_runPAR()` try/catch | Returns `null`; `analyze()` returns `{ color, cloth: null }` |
| Degenerate bbox (width/height = 0) | `Math.max(1, ...)` clamp | Prevents zero-size sharp extract; color returns gray fallback |
| Zone does not include 'cloth' | PipelineManager config | `analyze()` not called; `personAttrs.cloth` absent |
| PAR model not ready but zone has 'cloth' | `_parReady` check in `analyze()` | `cloth: null` returned; no error |

---

## 10. Relationship to Proposed Human Parsing (Color Phase-3)

`docs/design/Design_AI_Color_Analysis.md` §10 (proposed, 2026-07-09) introduces a Human Parsing model (SCHP/SegFormer) for **Color Analysis** Phase-3. This is a distinct concern from Cloth Analysis (this document):

| | Cloth Analysis (this doc, `_runPAR()`) | Color Analysis Phase-3 (proposed) |
|---|---|---|
| Question answered | What clothing **attributes** does the person have? (gender, age, sleeve length, bag type, style flags, 26 PA100k attributes total) | What **region** of the crop is upper vs. lower clothing, for color sampling? |
| Model | PromptPAR (CLIP ViT-L) or OpenPAR (ResNet50) — admin-selectable, whole-bbox crop (§11) | SCHP/SegFormer (pixel-level segmentation mask) |
| Output | 26-field attribute object (see §5.1) | Per-pixel class mask consumed by `colorClothService`'s K-Means color extraction |

The two do not overlap or conflict — Human Parsing's mask could, in principle, also improve `_runPAR()`'s crop quality in a future phase, but that integration is out of scope for the current Color Analysis Phase-3 proposal and is not tracked here.

---

## 11. Model Choice & Memory Gate

Two PAR models are selectable for the `cloth-par` family, both exposed identically through the model catalog (Admin Dashboard → AI Models → Cloth Attribute (PAR)):

| | PromptPAR (PA100k) | OpenPAR (ResNet50, PA100k) |
|---|---|---|
| Catalog id | `openpar-pa100k` | `openpar-resnet50-pa100k` |
| Accuracy | Higher (CLIP ViT-L + text-prompt fusion) | Lower (plain ResNet50 head) |
| Execution provider | Forced CPU — DirectML crashes on this backbone during inference (`DXGI_ERROR_DEVICE_REMOVED`) | Default provider selection |
| Free-RAM requirement to activate | ≥ 2048MB (`PROMPTPAR_MIN_FREE_MEM_MB`) | None |
| Source | Shipped in `server/models/` | Manual export only (`manualOnly`) |

### 11.1 Why the gate exists

PromptPAR's CLIP ViT-L backbone (~1.2GB) runs on the CPU execution provider by necessity (see table above), so its checkpoint and ONNX Runtime's session buffers all draw from system RAM rather than GPU VRAM. Attempting to load it when free RAM is already low risks an OS-level out-of-memory kill of the entire server process, which is far worse than a clean, logged refusal to activate. OpenPAR's ResNet50 head has no equivalent constraint and is never gated.

### 11.2 Behavior

Both the eager startup load (`ColorClothService.load()`) and the runtime hot-swap (`ColorClothService.reloadPar()`, invoked by `POST /api/analysis/models/switch`) run the same `_checkPromptParGate(filePath)` check before touching the ONNX runtime:

- **Gate passes** (or the model isn't PromptPAR, e.g. OpenPAR): load proceeds normally.
- **Gate fails**: logs `[ColorClothService] PromptPAR 수행 불가능: 가용 메모리 부족 (free=<N>MB < required=<M>MB) — Cloth 분석을 비활성화합니다.`, calls `analyticsConfig.setConfig({ cloth: false })` so the pipeline stops expecting cloth output, and either silently skips the load (startup path — must not crash the server) or throws (hot-swap path — surfaced to the admin as an HTTP 500 error with the same message).

Full design rationale, code excerpts, and the environment variable reference live in `docs/design/Design_AI_Model_Catalog.md` §8 — this section is a Cloth-Analysis-scoped summary, not the source of truth for the gate's implementation.

### 11.3 Operator recovery paths

1. Free system RAM (stop other processes, reduce concurrent camera pipelines) and click **Activate** on PromptPAR again.
2. Activate **OpenPAR** instead — no memory gate applies, at some accuracy cost.
3. Leave Cloth Analysis disabled — Color Analysis (Phase-1, always available) is unaffected either way.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for AI Cloth Analysis |
| 1.1 | 2026-07-09 | Youngho Kim | Added §10 cross-reference clarifying PAR(clothing type) vs proposed Human Parsing(clothing region mask, Color Analysis Phase-3) boundary |
| 2.0 | 2026-07-12 | LTS Engineering Team | Full rewrite to match the shipped PromptPAR (PA100k, CLIP ViT-L, 26 attributes, 224×224) integration — replaced the stale 12-attribute/128×256 `openpar.onnx` placeholder throughout (§1-§9); added OpenPAR (ResNet50, PA100k) as a second selectable `cloth-par` model and new §11 (PromptPAR memory gate: pre-activation free-RAM check, auto-disable Cloth analysis + Korean log on failure, admin recovery paths) |
