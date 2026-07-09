# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Color Analysis (Appearance Attribute)

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-05 |
| **Version** | 1.3 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_AI_Color_Analysis.md (LTS-2026-AI-05) |

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

The Color Analysis module classifies the dominant clothing colors of a person's upper and lower body regions from surveillance video — enabling color-based person search ("person in red top, blue pants"), alert enrichment, and cross-camera re-identification within the LTS-2026 Loitering Detection & Tracking System.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Extract dominant upper body and lower body colors per tracked person using body-region ROI crops.
- Classify colors into 11 basic color categories (black, white, gray, red, orange, yellow, green, blue, purple, pink, brown).
- Support top-2 dominant colors and pattern detection (solid, striped, plaid, etc.) per region.
- Attach color metadata to tracked person objects and include in alert notifications.
- Enable color-based person search via `GET /api/events?upperColor=red&lowerColor=blue`.

### 2.2 Non-Goals

- Fine-grained color shade matching (e.g., navy vs. royal blue) is optional and requires the extended 17-color set.
- Vehicle color detection is out of scope for this module.
- Real-time color-triggered zone access control (e.g., "alert if red clothing enters zone") is a Phase-2 feature.

---

## 3. User Personas

**Security Operator** — receives a loitering alert and needs to relay a useful person description over radio. Needs color metadata in the alert notification automatically ("red top, blue bottom").

**Incident Investigator** — searches event history for a suspect described by a witness as wearing a "yellow jacket." Needs color-based query support against historical alert records.

---

## 4. Functional Specification

### 4.1 Color Taxonomy

**Basic 11-color set (Berlin & Kay universal):**
black (#1a1a1a), white (#f5f5f5), gray (#808080), red (#e53935), orange (#fb8c00), yellow (#fdd835), green (#43a047), blue (#1e88e5), purple (#8e24aa), pink (#f06292), brown (#6d4c41)

**Pattern classes:** solid, striped, plaid, dotted, printed, camouflage, mixed

### 4.2 Two-Stage Pipeline

1. Primary person detection (YOLOv8n) provides bounding boxes.
2. For each tracked person (className === 'person'):
   - Extract upper body ROI: x+5%W to x+95%W, y+10%H height of 45%H → resize 64×128 px
   - Extract lower body ROI: x+10%W to x+90%W, y+50%H height of 45%H → resize 64×128 px
   - Run EfficientNet-B0 color classifier on each crop → `{primary, secondary, pattern, confidence}`
3. Exponential moving average smoothing over last 10 frames stabilizes color labels.
4. Attach `color.upperBody` and `color.lowerBody` to tracked person object.

### 4.3 Phase Status

- **Phase-1 (complete):** `colorClothService.js` uses `avgColor()` + `rgbToColorName()`. Body ROIs are shrunk to 8×8 via `sharp`, RGB averaged, and mapped to the 11-color table. No ML model required. Latency < 2 ms/person.
- **Phase-1.5 (proposed, 2026-07-09):** Same fixed ROI rectangles as Phase-1, but the plain 8×8 mean is replaced with `kmeansColor.dominantColor()` (K-Means over a larger resized patch). No model, no new toggle — a strict accuracy upgrade to the always-on Phase-1 path, matching the reference guide's own no-model tier (see RFP §Appendix E, Design §11).
- **Phase-2 (pending):** `openpar.onnx` provides ML-based multi-attribute color output alongside clothing type. Replaces the heuristic RGB average with a trained classifier.
- **Phase-3 (proposed, 2026-07-09):** Human Parsing model (SCHP LIP-20 or SegFormer clothes) produces a pixel-level upper/lower clothing mask per tracked person; K-Means dominant-color extraction runs on the masked pixels instead of a fixed-fraction rectangle. Runs per-track on a throttled interval (not per-frame) with cached fallback to Phase-1 when the model is unavailable or the mask has too few pixels. Model choice is admin-selectable/downloadable via the same Admin Dashboard "AI Models" catalog UX used for YOLO detectors (see RFP §Appendix E, Design §10).

### 4.4 Zone Activation

Zones with `"targetClasses": ["color"]` activate color analysis. The optional `colorFilter` block enables alerting on specific colors entering a zone.

### 4.5 Fallback Method

When DNN inference is unavailable, the HSV histogram method provides approximate color with ~82% accuracy and < 0.5 ms latency.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Runtime | Node.js 18+, ONNX Runtime |
| Phase-1 method | RGB average on 8×8 shrunk ROI via `sharp` (no model) |
| Phase-2 model | `color_upper_efficientb0.onnx` + `color_lower_efficientb0.onnx` (~20 MB each) or `openpar.onnx` |
| Model input | 64×128 px normalized RGB crop |
| Color classes | 11 basic colors (extendable to 17) |
| Min ROI size | Upper: ≥ 30×40 px; Lower: ≥ 30×50 px |
| Simultaneous persons | Up to 30 per frame |
| Latency per person | < 10 ms total (ROI extraction + upper + lower classification) |
| Latency (10 persons batched) | < 15 ms |
| Temporal smoothing | EMA majority vote over last 10 frames |
| Service file | `server/src/services/colorClothService.js` |

---

## 6. Input / Output Contract

**Input:**
- Person bbox `{x, y, width, height}` in original frame pixel coordinates.
- JPEG frame buffer (1080p) for ROI extraction.

**Output attached to tracked person object:**
```json
{
  "objectId": "track-uuid",
  "color": {
    "upperBody": {
      "primary": "red",
      "secondary": "white",
      "pattern": "striped",
      "confidence": { "red": 0.82, "white": 0.61 }
    },
    "lowerBody": {
      "primary": "blue",
      "secondary": null,
      "pattern": "solid",
      "confidence": { "blue": 0.91 }
    },
    "description": "red/white striped top, blue pants"
  }
}
```

**Alert schema extension:**
```json
{
  "appearance": {
    "upperBody": { "primary": "red", "pattern": "solid" },
    "lowerBody": { "primary": "blue", "pattern": "solid" },
    "description": "red top, blue bottom"
  }
}
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Top-1 color accuracy | ≥ 85% on RAP v2 or PA-100K dataset (11-class) |
| AC-02 | Top-2 color accuracy | ≥ 92% on same dataset |
| AC-03 | Pattern classification | ≥ 80% accuracy for solid/striped/plaid patterns |
| AC-04 | Illumination robustness | Accuracy ≥ 80% under partial shadow conditions |
| AC-05 | Latency — single person | Total per-person latency ≤ 10 ms |
| AC-06 | Latency — 10 persons batched | Batched inference ≤ 15 ms |
| AC-07 | Phase-1 functional | `color.upperBody.primary` and `color.lowerBody.primary` populated for every detected person when `color` is in zone `targetClasses` |
| AC-08 | Temporal stability | Color label for a stationary person does not flicker between two different colors across consecutive frames |
| AC-09 | Alert enrichment | Loitering alert payload contains `appearance.upperBody.primary` and `appearance.lowerBody.primary` |
| AC-10 | Person search | `GET /api/events?upperColor=red&lowerColor=blue&fromTime=...` returns correct matching events |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Phase-1: RGB color extraction via `sharp` + 11-color mapping (no model) | 2026-05-15 | 2026-05-15 | ✅ Complete |
| M2 | Phase-2: Export OpenPAR ONNX model for ML-based color classification | TBD | - | ⏳ Pending |
| M3 | Phase-2: Integrate EfficientNet-B0 color models and validate accuracy | TBD | - | ⏳ Pending |
| M4 | Person search API for color queries | TBD | - | ⏳ Pending |
| M5 | Phase-3: Human Parsing (SCHP/SegFormer) model catalog + per-track throttled color extraction | TBD | - | 📝 Proposed |
| M6 | Phase-1.5: Replace Phase-1's plain-mean reduction with K-Means dominant color on the same fixed ROI (no model) | TBD | - | 📝 Proposed |

### 8.2 TODO

- [ ] Export OpenPAR PyTorch model to ONNX (input `[1, 3, 256, 128]`, opset 11)
- [ ] Implement `_runPAR()` in `colorClothService.js` to replace heuristic when `openpar.onnx` is available
- [ ] Add EMA temporal smoothing (`smoothColorHistory()`) for both upper and lower color outputs
- [ ] Implement `GET /api/events?upperColor=&lowerColor=` search endpoint
- [ ] Extend loitering alert schema to include `appearance.upperBody` and `appearance.lowerBody`
- [ ] Add `colorFilter` zone policy support (alert when specific colors enter zone)
- [ ] Benchmark Phase-1 heuristic vs. Phase-2 ML model on RAP v2 dataset
- [ ] Add color description display to `FullscreenCameraView.tsx` detection panel
- [ ] Write unit tests for `rgbToColorName()` covering all 11 color boundaries
- [ ] (Phase-3, proposed) Add `schp_lip.onnx` / SegFormer clothes model entries to the Admin Dashboard AI Models catalog with download + activate actions
- [ ] (Phase-3, proposed) Implement per-track parse cache + K-Means dominant-color extraction on Human Parsing mask output, with fallback to Phase-1 fixed-fraction average
- [ ] (Phase-1.5, proposed) Replace `avgColor()`'s plain 8×8 mean with `kmeansColor.dominantColor()` over a larger resized patch, for the always-on fixed-ROI path (no model, no toggle)

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for AI Color Analysis |
| 1.1 | 2026-07-09 | Youngho Kim | Added Phase-3 (Human Parsing) product requirements — M5 milestone, TODO items, phase-status note |
| 1.2 | 2026-07-09 | Youngho Kim | Added Phase-1.5 (K-Means on existing fixed ROI, no model) — M6 milestone, TODO item, phase-status note — closes the guide's tier-4 gap ahead of source guide deletion |
| 1.3 | 2026-07-09 | Youngho Kim | Source guide `docs/rfp/CCTV_IPTV_상의하의_색상분류_가이드.md` deleted — full content confirmed reflected in §4.3/§8 |
