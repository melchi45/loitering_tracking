# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Hat & Head Accessory Detection

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-07 |
| **Version** | 1.0 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_AI_Hat_Detection.md (LTS-2026-AI-07) |

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

The Hat & Head Accessory Detection module provides per-person head covering classification — enabling construction site hardhat compliance monitoring, suspicious hooded-person alerts, and person description enrichment — using the shared PPE model already deployed for mask detection, with zero additional model requirement for Phase-1.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Detect hardhat presence (`hardhat`) and absence (`no_hardhat`) per tracked person using the shared `yolov8m_ppe.onnx` model.
- Emit `hat` attribute (`{className, confidence, isHelmet, safetyCompliant}`) on every person detection object when the hat module is enabled.
- Display HELMET (blue), NO HELMET (red), and HAT? (gray) badges in the canvas overlay and detection panel.
- Support per-zone safety policy configuration (`hatRequired`, `graceperiodSec`, `alertOnViolation`).
- Share head ROI extraction with the mask detection module (single pass serves both).

### 2.2 Non-Goals

- The 8-class hat taxonomy (baseball_cap, beanie, hood_up, hat_wide, hair_net, etc.) requires `hat_classifier.onnx` and is a Phase-2 feature.
- Hat color detection is a Phase-2 feature.
- Temporal smoothing (majority vote over 10 frames) is a Phase-2 enhancement.

---

## 3. User Personas

**Construction Site Safety Manager** — needs real-time alerts when workers enter the construction zone without hardhats. Requires high precision to avoid false alarms that erode operator trust, and high recall to ensure no safety violation is missed.

**Security Operator** — uses hat type as a person description attribute for post-event search ("person in baseball cap") and identifies hooded persons loitering in restricted zones at night.

---

## 4. Functional Specification

### 4.1 Phase-1 — PPE Model Hat Detection (Complete)

The existing `yolov8m_ppe.onnx` (keremberke/yolov8m-protective-equipment-detection) provides hardhat detection at zero additional model cost. PPE model class mapping:

| PPE Class | Index | `hat.isHelmet` | `hat.safetyCompliant` | UI Badge |
|---|---|---|---|---|
| `Hardhat` | 0 | `true` | `true` | HELMET (blue) |
| `NO-Hardhat` | 2 | `false` | `false` | NO HELMET (red) |
| No PPE match | — | `null` | `null` | HAT? (gray) |

The `hat` field is always emitted (never `undefined`) when the PPE model is running, allowing the UI to distinguish "model off" from "model on, no result."

### 4.2 Head ROI Extraction

Head ROI is extracted as the top 35% of each tracked person bounding box (heuristic, Method A). Hat detection bboxes are IoU-matched to the head ROI using `_bestMatch()` (IoU ≥ 0.1).

```javascript
function extractHeadRoi(personBbox) {
  const headHeight = personBbox.height * 0.28;
  return {
    x:      personBbox.x + personBbox.width  * 0.10,
    y:      personBbox.y - headHeight * 0.10,
    width:  personBbox.width  * 0.80,
    height: headHeight * 1.20,
  };
}
```

### 4.3 Shared Head ROI Optimization

When both mask and hat modules are enabled, a single PPE inference pass serves both modules:
```javascript
const [hatResult, maskResult] = await Promise.all([
  hatClassifier.classify(headCrop),
  maskClassifier.classify(headCrop),
]);
```

### 4.4 Zone Safety Policy

Zones include `"hat"` in `targetClasses` and a `safetyPolicy` block:
```json
{
  "targetClasses": ["human", "hat"],
  "safetyPolicy": { "hatRequired": "helmet_hard", "alertOnViolation": true, "graceperiodSec": 5 }
}
```
The `safety_violation` Socket.IO event is emitted when a person in the zone lacks the required hat (Phase-2).

### 4.5 Phase-2 — 8-Class Hat Taxonomy (Pending)

Requires `hat_classifier.onnx` (MobileNetV3-Small, 8-class):
`no_hat`, `baseball_cap`, `beanie`, `helmet_hard`, `helmet_bike`, `hood_up`, `hat_wide`, `hair_net`

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Runtime | Node.js 18+, ONNX Runtime |
| Phase-1 model | `yolov8m_ppe.onnx` (shared with mask detection, ~50 MB) |
| Phase-2 model | `hat_classifier.onnx` (MobileNetV3-Small, ~6 MB, 8-class) |
| Head ROI input | Top 35% of person bbox, resized to 96×96 px |
| Simultaneous persons | Up to 50 per frame |
| Detection speed | ≥ 10 FPS (real-time) |
| Latency per person | < 5 ms (head ROI extraction + classification) |
| Latency (10 persons batched) | < 8 ms |
| Face angle tolerance | 0°–70° yaw |
| Min head size | 25×25 px in 1080p |
| Service file | `server/src/services/protectiveEquipService.js` |
| Analytics config key | `hat` |

---

## 6. Input / Output Contract

**Input:**
- Person bbox `{x, y, width, height}` from tracked person objects.
- JPEG frame buffer for head ROI crop extraction.
- PPE model detections from `protectiveEquipService.js` (shared with mask module).

**Output `hat` field attached to each person detection:**
```json
{
  "objectId": "track-uuid",
  "className": "person",
  "hat": {
    "className":       "hardhat",
    "confidence":      0.91,
    "isHelmet":        true,
    "safetyCompliant": true
  }
}
```

| Scenario | `hat` value |
|---|---|
| PPE model off / module disabled | `undefined` |
| PPE model on, hardhat detected | `{isHelmet: true, safetyCompliant: true}` |
| PPE model on, no_hardhat detected | `{isHelmet: false, safetyCompliant: false}` |
| PPE model on, no match (occluded/small) | `{isHelmet: null, safetyCompliant: null, className: 'uncertain'}` |

**Safety violation alert (Phase-2):**
```json
{
  "type": "safety_violation",
  "subtype": "no_hardhat",
  "objectId": "track-uuid",
  "zoneId": "construction-zone-uuid",
  "hatStatus": "baseball_cap",
  "requiredHat": "helmet_hard"
}
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Module toggle | PUT `/api/analytics/config` with `hat: true/false` enables/disables hat detection within 1 frame |
| AC-02 | Capabilities endpoint | `/api/capabilities` returns `ai.hat: true` and `status.hat: 'loaded'` when model is present and loaded |
| AC-03 | HELMET badge | `hat.isHelmet === true` renders HELMET badge (blue) in detection panel and canvas overlay |
| AC-04 | NO HELMET badge | `hat.isHelmet === false` renders NO HELMET badge (red) |
| AC-05 | HAT? badge | `hat.isHelmet === null` renders HAT? badge (gray) |
| AC-06 | `hat` field always emitted | When PPE model is running, every person detection includes a `hat` field (never `undefined`) |
| AC-07 | Shared inference | Enabling both `hat` and `mask` uses a single PPE inference pass, not two |
| AC-08 | Phase-1 accuracy | `helmet_hard` precision ≥ 92% on SHWD test set |
| AC-09 | Phase-1 accuracy | `helmet_hard` recall ≥ 90% on SHWD test set |
| AC-10 | Latency | Per-person hat detection adds ≤ 5 ms to frame processing time |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | Phase-1: PPE model hardhat/no_hardhat detection with UI badges | 2026-05-18 | 2026-05-18 | ✅ Complete |
| M2 | Phase-2: Source/train `hat_classifier.onnx` (8-class MobileNetV3-Small) | TBD | - | ⏳ Pending |
| M3 | Phase-2: Safety violation alert (`safety_violation` Socket.IO event) | TBD | - | ⏳ Pending |
| M4 | Phase-2: Temporal smoothing (majority vote over 10 frames) | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Train `hat_classifier.onnx` (MobileNetV3-Small, 8-class) on HAT-1K + SHWD + HardHat Dataset
- [ ] Integrate `hat_classifier.onnx` into `protectiveEquipService.js` (Phase-2 path)
- [ ] Implement `safety_violation` Socket.IO event when `no_hardhat` detected in zone with `hatRequired: "helmet_hard"`
- [ ] Add zone `safetyPolicy` schema fields: `hatRequired`, `alertOnViolation`, `graceperiodSec`
- [ ] Implement 10-frame majority vote temporal smoothing for stable hat type output
- [ ] Implement hat color estimation using color classifier on head ROI crop
- [ ] Add suspicious pattern detection: hooded person at night, cap facing away from camera
- [ ] Add `status.hat` detail values (`loaded`, `available`, `missing`, `failed`) to `/api/capabilities` response (verify existing implementation)
- [ ] Benchmark Phase-1 hardhat precision/recall on SHWD dataset
