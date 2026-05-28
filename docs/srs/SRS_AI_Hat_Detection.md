# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module — Hat & Helmet Detection

| | |
|---|---|
| **Document ID** | SRS-LTS-AI-HAT-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_AI_Hat_Detection.md |
| **Parent RFP** | rfp/RFP_AI_Hat_Detection.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Model & Inference](#3-functional-requirements--model--inference)
4. [Functional Requirements — Head ROI Extraction](#4-functional-requirements--head-roi-extraction)
5. [Functional Requirements — Hat Classification & Output](#5-functional-requirements--hat-classification--output)
6. [Functional Requirements — Integration & Zone Policy](#6-functional-requirements--integration--zone-policy)
7. [Functional Requirements — Error Handling](#7-functional-requirements--error-handling)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Interface Requirements](#9-interface-requirements)
10. [Constraints & Assumptions](#10-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the AI Hat & Helmet Detection module of LTS-2026. Each requirement is identified by a unique ID (FR-HAT-NNN) and is directly traceable to test cases in TC_AI_Hat_Detection.md.

### 1.2 Scope

This document covers:
- Phase-1 hardhat/no-hardhat detection using the shared `yolov8m_ppe.onnx` PPE model (`ProtectiveEquipService`)
- Head ROI extraction (heuristic: top 35% of person bbox) per tracked person
- IoU-based matching of PPE detections to person head ROI (`_bestMatch()`, IoU ≥ 0.1)
- Emission of `hat` attribute on every person detection object when the hat module is enabled
- Canvas overlay and detection panel badges (HELMET/NO HELMET/HAT?)
- Shared inference optimization when both hat and mask modules are active
- Per-zone safety policy configuration (Phase-1 data available; alerting is Phase-2)

Out of scope: Phase-2 8-class hat taxonomy (`hat_classifier.onnx`), safety violation alerts (`safety_violation` event), hat color estimation, temporal smoothing.

### 1.3 Definitions

| Term | Definition |
|---|---|
| ProtectiveEquipService | Node.js class wrapping the `yolov8m_ppe.onnx` model; handles both hat and mask detection |
| PPE model | `yolov8m_ppe.onnx` — keremberke/yolov8m-protective-equipment-detection (10-class PPE detector) |
| PPE class 0 | `hardhat` — protective hard hat detected → `isHelmet: true, safetyCompliant: true` |
| PPE class 2 | `no_hardhat` — person without hard hat detected → `isHelmet: false, safetyCompliant: false` |
| Head ROI | Region of Interest covering the top portion of a tracked person's bounding box |
| `hat` attribute | JSON object attached to person detection: `{ className, confidence, isHelmet, safetyCompliant }` |
| `_bestMatch()` | IoU helper: finds the highest-IoU PPE detection overlapping a given ROI (threshold ≥ 0.1) |
| analyticsConfig key | `hat` — boolean toggle controlling whether hat detection runs for the current frame |

---

## 2. System Overview

### 2.1 Component Dependencies

```
RTSP / JPEG Frame
  └─ DetectionService.detect()           — YOLOv8n: person bboxes
       └─ AttributePipeline.enrich()
            ├─ ProtectiveEquipService.detect()  — PPE YOLOv8m: hardhat/no_hardhat
            ├─ analyticsConfig.hat              — gate: is 'hat' enabled?
            ├─ extractHeadRoi(personBbox)        — top 35% heuristic
            ├─ _bestMatch(ppeDetections, headRoi)— IoU ≥ 0.1 match
            ├─ det.hat = { className, confidence, isHelmet, safetyCompliant }
            └─ Socket.IO emit 'detections'
```

### 2.2 PPE Model Class Mapping (Hat)

| PPE Class ID | className | `hat.isHelmet` | `hat.safetyCompliant` | UI Badge |
|---|---|---|---|---|
| 0 | `hardhat` | `true` | `true` | HELMET (blue) |
| 2 | `no_hardhat` | `false` | `false` | NO HELMET (red) |
| — (no match) | `uncertain` | `null` | `null` | HAT? (gray) |

### 2.3 Startup Sequence

```
Server start
  1. ProtectiveEquipService constructed (modelPath: server/models/yolov8m_ppe.onnx)
  2. AttributePipeline.load() → ProtectiveEquipService.load()  — ONNX session created
  3. analyticsConfig.load()   — hat key loaded from storage/analytics.json
  4. PipelineManager.start()  — cameras registered
  5. Per-frame loop: detect persons → enrich with hat attribute
  6. HTTP server listens on PORT
```

---

## 3. Functional Requirements — Model & Inference

### FR-HAT-001 — PPE Model File

- Hat detection must use `yolov8m_ppe.onnx` located in `server/models/`
- Model path is configurable via `ProtectiveEquipService` constructor option `modelPath`
- The model must accept input shape `[1, 3, 640, 640]` (NCHW Float32)
- The model output shape must be `[1, 4+NC, 8400]` where NC is the number of PPE classes (10)

### FR-HAT-002 — PPE Model Loading

- `ProtectiveEquipService.load()` must create an ONNX `InferenceSession` using `ort.InferenceSession.create()`
- Loading must use `getOnnxSessionOptions()` (CPU execution provider)
- After successful load, `_ready` must be `true` and `_status` must be `'loaded'`
- If model file is missing, `_status` must be set to `'missing'` and `_ready` must remain `false`
- If load throws (corrupt file, OOM), `_status` must be set to `'failed'` and `_ready` must remain `false`

### FR-HAT-003 — Hat Module Toggle Gate

- Before running hat classification, `AttributePipeline` must check `analyticsConfig.hat !== false`
- If `analyticsConfig.hat` is `false` or the PPE model is not ready, the `hat` field must be `undefined` on person detections
- Hat detection must be enabled within 1 frame after PUT `/api/analytics/config` with `{ hat: true }`

### FR-HAT-004 — Shared PPE Inference

- The PPE model inference call in `ProtectiveEquipService.detect()` produces results for all PPE classes simultaneously (hardhat, mask, no_hardhat, no_mask, safety_vest, etc.)
- When both `hat` and `mask` analyticsConfig keys are `true`, a single PPE inference pass must serve both modules
- Two separate ONNX inference sessions must not be created for hat and mask

### FR-HAT-005 — PPE Preprocessing

- Input JPEG frame must be preprocessed identically to the primary YOLOv8n model:
  - Proportional resize with letterboxing to 640×640 (grey padding: R:114, G:114, B:114)
  - CHW Float32 tensor, normalized to [0, 1]
  - Tensor shape: `[1, 3, 640, 640]`

---

## 4. Functional Requirements — Head ROI Extraction

### FR-HAT-006 — Heuristic Head ROI Computation

- For each tracked person bbox `{ x, y, width, height }`, the head ROI must be computed as:
```javascript
headHeight = personBbox.height * 0.28
headRoi = {
  x:      personBbox.x + personBbox.width  * 0.10,
  y:      personBbox.y - headHeight * 0.10,
  width:  personBbox.width  * 0.80,
  height: headHeight * 1.20,
}
```
- The ROI must extend slightly above the top of the person bbox (`y - headHeight * 0.10`) to capture hats above the head

### FR-HAT-007 — Head ROI Bounds Clamping

- All head ROI coordinates must be clamped to the frame bounds before use: x ≥ 0, y ≥ 0, x+width ≤ frameWidth, y+height ≤ frameHeight
- A head ROI with zero area after clamping must produce `hat = { isHelmet: null, safetyCompliant: null, className: 'uncertain' }`

### FR-HAT-008 — IoU Matching (`_bestMatch`)

- The `_bestMatch()` function must iterate all PPE detections from the current frame and return the one with the highest IoU overlap with the head ROI
- The minimum IoU threshold for a valid match is 0.1
- If no PPE detection achieves IoU ≥ 0.1 with the head ROI, `_bestMatch()` must return `null`

---

## 5. Functional Requirements — Hat Classification & Output

### FR-HAT-009 — Hat Attribute Always Emitted

- When the hat module is enabled (FR-HAT-003) and the PPE model is ready, every person detection must include a `hat` field
- The `hat` field must never be `undefined` when the module is active; it may be `{ isHelmet: null, ... }` if no match found
- When the module is disabled or model not loaded, `hat` must be `undefined` (absent from the detection object)

### FR-HAT-010 — Hat Attribute Schema

The `hat` attribute attached to each person detection must conform to:
```json
{
  "className":       "hardhat" | "no_hardhat" | "uncertain",
  "confidence":      number,
  "isHelmet":        true | false | null,
  "safetyCompliant": true | false | null
}
```

| Condition | `className` | `isHelmet` | `safetyCompliant` | `confidence` |
|---|---|---|---|---|
| PPE class 0 (hardhat) matched | `"hardhat"` | `true` | `true` | match score |
| PPE class 2 (no_hardhat) matched | `"no_hardhat"` | `false` | `false` | match score |
| No PPE match in head ROI | `"uncertain"` | `null` | `null` | 0 |

### FR-HAT-011 — UI Badges

- `hat.isHelmet === true` must render a **HELMET** badge (blue color) in the detection panel and canvas overlay
- `hat.isHelmet === false` must render a **NO HELMET** badge (red color)
- `hat.isHelmet === null` must render a **HAT?** badge (gray color)
- When `hat === undefined` (module off), no hat badge must be rendered

### FR-HAT-012 — Confidence Threshold for Hat Classification

- PPE detections with `confidence < 0.30` must be discarded before `_bestMatch()` is called
- This threshold is the default for `ProtectiveEquipService` and must match `confThresh` constructor option

---

## 6. Functional Requirements — Integration & Zone Policy

### FR-HAT-013 — Analytics Config Key

- The `analyticsConfig` must include a `hat` key (boolean)
- PUT `/api/analytics/config` with `{ hat: true | false }` must update the key and persist to `storage/analytics.json`
- GET `/api/analytics/config` must return the current `hat` value

### FR-HAT-014 — Capabilities Endpoint

- `GET /api/capabilities` must include `ai.hat` (boolean) and `status.hat` (string)
- `ai.hat` must be `true` when `yolov8m_ppe.onnx` is present and not failed
- `status.hat` must be one of: `'loaded'`, `'available'`, `'missing'`, `'failed'`

| `status.hat` | Meaning |
|---|---|
| `'loaded'` | Model actively running in memory |
| `'available'` | File present, not yet loaded (loads on first camera start) |
| `'missing'` | `yolov8m_ppe.onnx` not on disk |
| `'failed'` | File found but ONNX session creation threw |

### FR-HAT-015 — Zone Safety Policy (Phase-1 Data)

- Zone configurations may include a `safetyPolicy` block: `{ hatRequired: "helmet_hard", alertOnViolation: true, graceperiodSec: 5 }`
- In Phase-1, this data must be stored and retrievable via the zone API but no `safety_violation` event is emitted
- The `hat` detection attribute must be available on each person detection for downstream Phase-2 alerting

### FR-HAT-016 — Socket.IO Detections Event

- Person detections with hat attributes must be included in the `detections` Socket.IO event
- The enriched person detection must include the `hat` field alongside all other person detection fields

---

## 7. Functional Requirements — Error Handling

### FR-HAT-017 — PPE Model Missing

- If `yolov8m_ppe.onnx` does not exist at startup, `ProtectiveEquipService._status` must be `'missing'`
- Hat detection must be gracefully disabled; all person detections will have `hat === undefined`
- `GET /api/capabilities` must return `ai.hat: false` and `status.hat: 'missing'`

### FR-HAT-018 — PPE Inference Error Recovery

- If PPE `detect()` throws during a frame, the exception must be caught and logged
- The frame's person detections must receive `hat = { isHelmet: null, safetyCompliant: null, className: 'uncertain' }` rather than propagating an error

### FR-HAT-019 — Invalid JPEG Input

- If `jpegBuffer` is invalid, `sharp` will throw inside `ProtectiveEquipService.detect()`
- The service must catch this and return `[]` (empty PPE detection array), resulting in `hat = uncertain` for all persons

---

## 8. Non-Functional Requirements

### FR-HAT-030 — Latency

- Per-person hat detection overhead (head ROI extraction + IoU matching) must not exceed 5 ms
- For 10 persons batched in a single frame, total hat overhead must not exceed 8 ms
- PPE inference latency is shared with mask detection; no duplicate inference cost when both are enabled

### FR-HAT-031 — Memory Usage

- The PPE ONNX model is shared between hat and mask; no additional memory is used when enabling hat if mask is already loaded
- PPE model memory must not exceed 200 MB (yolov8m_ppe.onnx ~50 MB on disk, larger in memory)

### FR-HAT-032 — Accuracy

- Phase-1 `helmet_hard` (hardhat) precision must be ≥ 92% on SHWD test set
- Phase-1 `helmet_hard` recall must be ≥ 90% on SHWD test set
- False safety alert rate (hardhat detected when no hardhat present) must be ≤ 3%

### FR-HAT-033 — Simultaneous Persons

- The hat detection pipeline must support up to 50 simultaneous tracked persons per frame
- Head ROI extraction and IoU matching are O(N × M) where N = persons, M = PPE detections; performance must remain within latency budget at N=50, M=100

---

## 9. Interface Requirements

### 9.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-HAT-013 | GET | `/api/analytics/config` | Query hat module enable state |
| FR-HAT-013 | PUT | `/api/analytics/config` | Set hat module enable flag |
| FR-HAT-014 | GET | `/api/capabilities` | Query hat capability and model status |

**Response schema for `/api/capabilities` (hat fields):**
```json
{
  "ai":     { "hat": true },
  "status": { "hat": "loaded" }
}
```

### 9.2 Socket.IO Events

| Event | Direction | Payload | Condition |
|---|---|---|---|
| `detections` | Server→Client | Person detections with `hat` attribute | Emitted per frame when hat module is enabled |

### 9.3 Internal Service API

```javascript
// ProtectiveEquipService
new ProtectiveEquipService({ modelPath, confThresh, nmsThresh })
load() → Promise<void>
detect(jpegBuffer, origW, origH) → Promise<Array<{bbox, confidence, classId, className}>>
get ready() → boolean
get status() → 'not_started' | 'missing' | 'loaded' | 'failed'

// AttributePipeline hat integration
extractHeadRoi(personBbox) → { x, y, width, height }
_bestMatch(ppeDetections, headRoi) → PPEDetection | null
```

---

## 10. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Model `yolov8m_ppe.onnx` must be present in `server/models/` for hat detection to function |
| C-02 | Phase-1 hat classification is binary: `hardhat` / `no_hardhat` only; 8-class taxonomy requires Phase-2 `hat_classifier.onnx` |
| C-03 | Head ROI heuristic (top 35% of person bbox) is a Phase-1 approximation; accuracy degrades at steep camera angles |
| C-04 | Minimum head size for reliable detection: 25×25 pixels in the original frame |
| C-05 | The `hat` field is `undefined` (not `null`) when the module is disabled or model not loaded |
| C-06 | `safety_violation` Socket.IO events are a Phase-2 feature; Phase-1 only attaches the `hat` attribute to detections |
| C-07 | Hat color estimation is a Phase-2 feature; `color` is not included in the Phase-1 `hat` output schema |
| C-08 | The PPE model is shared with mask detection (AI-04); loading it once serves both modules simultaneously |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for AI Hat Detection |
