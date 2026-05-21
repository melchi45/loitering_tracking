# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Clothing Analysis (Cloth Type & Style)

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-06 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_AI_Cloth_Analysis.md (LTS-2026-AI-06) |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [Technical Requirements](#5-technical-requirements)
6. [Input / Output Contract](#6-input--output-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

The Clothing Analysis module classifies upper and lower body garment types worn by detected persons — enabling precise person descriptions ("red hoodie, blue jeans"), dress-code compliance monitoring, and cross-camera re-identification within the LTS-2026 Loitering Detection & Tracking System.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Classify upper body garments into 8 categories (t-shirt, shirt, hoodie, sweater, jacket, coat, vest, uniform_top) and lower body garments into 6 categories (jeans, trousers, shorts, skirt, leggings, uniform_bottom).
- Detect full-body outfit categories (dress, jumpsuit, suit, uniform_full, sportswear) as multi-label output.
- Output clothing style attributes: sleeve length, collar type, fit, pattern, and material visual cues.
- Generate natural-language clothing descriptions (e.g., "hoodie, jeans") for alert enrichment and incident reports.
- Support uniform compliance monitoring via configurable zone `uniformPolicy`.

### 2.2 Non-Goals

- The module does not perform brand recognition or logo identification.
- Open-vocabulary free-text clothing queries (CLIP-based zero-shot extension) are a Phase-2 enhancement and not required for initial release.
- Clothing size estimation is out of scope.

---

## 3. User Personas

**Security Operator** — uses clothing descriptions in loitering alerts to communicate appearance details to field personnel. Needs reliable, concise descriptions ("red hoodie, black jeans") generated automatically.

**HR / Compliance Manager** — monitors staff uniform adherence in restricted zones (factory, hospital, security post). Needs alerts when persons enter without required uniform types and colors.

---

## 4. Functional Specification

### 4.1 Classification Taxonomy

**Upper body (8 classes):** t-shirt, shirt, hoodie, sweater, jacket, coat, vest, uniform_top

**Lower body (6 classes):** jeans, trousers, shorts, skirt, leggings, uniform_bottom

**Full body (5 classes, multi-label):** dress, jumpsuit, suit, uniform_full, sportswear

**Attributes:**
- Sleeve length: sleeveless, short, long, unknown
- Collar type: round, v-neck, collar, hood, turtleneck, unknown
- Fit: loose, regular, slim, unknown
- Pattern: solid, striped, plaid, printed, mixed

### 4.2 Two-Stage Pipeline

1. Primary person detection (YOLOv8n) provides bounding boxes.
2. For each tracked person, three ROI crops are extracted and fed to the clothing classifier:
   - Upper body ROI: y 10%–65% of bbox height → resized to 128×192 px
   - Lower body ROI: y 45%–100% of bbox height → resized to 128×192 px
   - Full body ROI: full bbox → resized to 128×256 px
3. 10-frame majority vote temporal smoothing prevents flickering.
4. Natural-language description generated from classification results.

### 4.3 Zone Activation

Zones with `"targetClasses": ["cloth"]` activate clothing analysis for all persons. The `uniformPolicy` block specifies required garment types and triggers alerts on violation.

### 4.4 Natural Language Description

Combined with color analysis output: `{ upper: 'hoodie', lower: 'jeans' }` + color → "red hoodie, blue jeans".

### 4.5 Phase Status

- **Phase-1 (complete):** `colorClothService._colorReady = true`; `cloth.upper` and `cloth.lower` are `null` (PAR model not yet available).
- **Phase-2 (pending):** `openpar.onnx` provides 40+ attributes including clothing type and color in a single inference pass.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Runtime | Node.js 18+, ONNX Runtime |
| Recommended model | EfficientNet-B0 multi-task (`cloth_classifier_efficientb0.onnx`, ~20 MB) |
| Phase-2 model | OpenPAR (`openpar.onnx`) — input `[1, 3, 256, 128]` person crop, 40+ attribute output |
| Model input (upper/lower) | 128×192 px normalized RGB crop |
| Model input (full body) | 128×256 px normalized RGB crop |
| Min person size | 60×150 px in 1080p |
| Simultaneous persons | Up to 20 per frame |
| Latency per person | < 16 ms (upper + lower + full body) |
| Latency (10 persons batched) | < 20 ms |
| Temporal smoothing | 10-frame majority vote |
| Service file | `server/src/services/colorClothService.js` |

---

## 6. Input / Output Contract

**Input:**
- Person bbox `{x, y, width, height}` in original frame pixel coordinates.
- JPEG frame buffer for ROI extraction.

**Output attached to tracked person object:**
```json
{
  "objectId": "track-uuid",
  "cloth": {
    "upperGarment": {
      "type": "hoodie",
      "confidence": 0.87,
      "sleeveLength": "long",
      "collar": "hood"
    },
    "lowerGarment": {
      "type": "jeans",
      "confidence": 0.92,
      "fit": "slim"
    },
    "fullBody": null,
    "description": "hoodie, jeans"
  }
}
```

**Alert schema extension:**
```json
{
  "appearance": {
    "upperGarment": { "type": "hoodie", "confidence": 0.87 },
    "lowerGarment": { "type": "jeans", "confidence": 0.92 },
    "description": "hoodie, jeans",
    "uniformCompliant": false
  }
}
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Upper garment classification | Top-1 accuracy ≥ 82% on surveillance test set |
| AC-02 | Lower garment classification | Top-1 accuracy ≥ 85% on surveillance test set |
| AC-03 | Full outfit detection | mAP@0.5 ≥ 78% for dress/jumpsuit/uniform categories |
| AC-04 | Attribute accuracy | Sleeve length and collar type accuracy ≥ 80% |
| AC-05 | Latency — single person | Total per-person latency ≤ 16 ms |
| AC-06 | Latency — 10 persons batched | Batched inference ≤ 20 ms |
| AC-07 | Description generation | Combined color+cloth description produced for every person with visible upper and lower body |
| AC-08 | Uniform compliance alert | `uniformCompliant: false` set and alert emitted when person in `uniform_policy` zone lacks required garment types |
| AC-09 | Zone activation | `cloth` field is `null` when zone does not include `"cloth"` in `targetClasses` |
| AC-10 | Person search | `GET /api/events?upperCloth=hoodie&lowerCloth=jeans` returns matching events |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Phase-1: colorClothService with color extraction active; cloth fields return null | 2026-05-15 | 2026-05-15 | ✅ Complete |
| M2 | Phase-2: Source or train EfficientNet-B0 multi-task ONNX clothing classifier | TBD | - | ⏳ Pending |
| M3 | Phase-2: Integrate OpenPAR ONNX model for combined color+cloth+accessories attributes | TBD | - | ⏳ Pending |
| M4 | Uniform compliance alert integration | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Export OpenPAR model to ONNX (`torch.onnx.export` with input `[1, 3, 256, 128]`, opset 11)
- [ ] Implement `_runPAR()` method in `colorClothService.js` using `openpar.onnx`
- [ ] Map PAR output attributes to `cloth.upperGarment.type` and `cloth.lowerGarment.type` fields
- [ ] Implement 10-frame majority vote smoothing per track for garment type stability
- [ ] Implement `generateDescription(cloth, color)` combining color and cloth outputs
- [ ] Extend zone schema with `uniformPolicy` block (required garment types, alertOnViolation)
- [ ] Add `uniformCompliant` field to loitering alert schema
- [ ] Implement `GET /api/events?upperCloth=&lowerCloth=&fullOutfit=` search endpoint
- [ ] Benchmark EfficientNet-B0 vs. OpenPAR on RAP v2 and PA-100K datasets
- [ ] Add `cloth` attribute display to `FullscreenCameraView.tsx` detection panel
