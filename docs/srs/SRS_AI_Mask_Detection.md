# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module — Mask Detection

| | |
|---|---|
| **Document ID** | SRS-LTS-AI-MSK-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_AI_Mask_Detection.md |
| **Parent RFP** | rfp/RFP_AI_Mask_Detection.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Model & Inference](#3-functional-requirements--model--inference)
4. [Functional Requirements — Head ROI Extraction](#4-functional-requirements--head-roi-extraction)
5. [Functional Requirements — Mask Classification & Output](#5-functional-requirements--mask-classification--output)
6. [Functional Requirements — Zone Activation & Alerts](#6-functional-requirements--zone-activation--alerts)
7. [Functional Requirements — Integration & Dashboard](#7-functional-requirements--integration--dashboard)
8. [Functional Requirements — Error Handling](#8-functional-requirements--error-handling)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Interface Requirements](#10-interface-requirements)
11. [Constraints & Assumptions](#11-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the AI Mask Detection module of LTS-2026. Each requirement is identified by a unique ID (FR-MSK-NNN) and is directly traceable to test cases in TC_AI_Mask_Detection.md.

### 1.2 Scope

This document covers:
- Phase-1 mask/no-mask classification using the shared `yolov8m_ppe.onnx` PPE model (`ProtectiveEquipService`)
- Two-stage detection pipeline: person detection → head ROI extraction → PPE model mask classification
- Head ROI extraction formula (`x += width×0.15`, `width ×= 0.70`, `height ×= 0.35`)
- Three-state mask status output: `mask_correct`, `no_mask`, `uncertain`
- Zone-based activation via `targetClasses: ["mask"]` and `maskPolicy` field
- `mask_violation` alert emission for non-compliant persons in masked zones
- Dashboard badge rendering (MASK OK / NO MASK / MASK?)
- Shared PPE inference with hat detection module

Out of scope: Phase-2 fine-grained mask-type classification (surgical, N95, cloth), `mask_incorrect` (chin/below-nose) detection, identity recognition of non-compliant persons.

### 1.3 Definitions

| Term | Definition |
|---|---|
| ProtectiveEquipService | Node.js class wrapping the `yolov8m_ppe.onnx` model; handles both mask and hat detection |
| PPE model | `yolov8m_ppe.onnx` — keremberke/yolov8m-protective-equipment-detection (10-class PPE detector) |
| PPE class 1 | `mask` — face mask detected and worn → `mask.status: 'mask_correct'` |
| PPE class 3 | `no_mask` — person detected without mask → `mask.status: 'no_mask'` |
| `mask` attribute | JSON object: `{ status: string, confidence: number }` attached to person detections |
| Head ROI | Region of Interest covering the upper-face/head area of a tracked person's bounding box |
| `maskPolicy` | Zone-level field: `'mandatory'` | `'recommended'` | `'none'` |
| mask_violation | Socket.IO event emitted when maskPolicy is violated in a zone |
| `uncertain` | Mask status when PPE model is running but could not classify (occluded, too small, rotated) |

---

## 2. System Overview

### 2.1 Component Dependencies

```
RTSP / JPEG Frame
  └─ DetectionService.detect()              — YOLOv8n: person bboxes
       └─ AttributePipeline.enrich()
            ├─ ProtectiveEquipService.detect()  — PPE YOLOv8m: Mask(1) / NO-Mask(3)
            ├─ analyticsConfig.mask             — gate: is 'mask' module enabled?
            ├─ extractHeadRoi(personBbox)        — head ROI formula
            ├─ _bestMatch(ppeDetections, headRoi)— IoU ≥ 0.1 match
            ├─ det.mask = { status, confidence } — classification result
            ├─ zone maskPolicy compliance check
            └─ Socket.IO emit 'detections' / 'mask_violation'
```

### 2.2 PPE Model Class Mapping (Mask)

| PPE Class ID | className | `mask.status` | UI Badge |
|---|---|---|---|
| 1 | `mask` | `mask_correct` | MASK OK (green) |
| 3 | `no_mask` | `no_mask` | NO MASK (red) |
| — (no match) | — | `uncertain` | MASK? (gray) |

### 2.3 Startup Sequence

```
Server start
  1. ProtectiveEquipService constructed (modelPath: server/models/yolov8m_ppe.onnx)
  2. AttributePipeline.load() → ProtectiveEquipService.load()  — ONNX session created
  3. analyticsConfig.load()   — mask key loaded from storage/analytics.json
  4. PipelineManager.start()  — cameras registered
  5. Per-frame loop: detect persons → enrich with mask attribute → check zone compliance
  6. HTTP server listens on PORT
```

---

## 3. Functional Requirements — Model & Inference

### FR-MSK-001 — PPE Model File

- Mask detection must use `yolov8m_ppe.onnx` located in `server/models/`
- The model must accept input shape `[1, 3, 640, 640]` (NCHW Float32)
- The model output shape must be `[1, 4+NC, 8400]` where NC = 10 (PPE classes)
- The model file is shared with the hat detection module (AI-07)

### FR-MSK-002 — PPE Model Loading

- `ProtectiveEquipService.load()` must create an ONNX `InferenceSession` using `ort.InferenceSession.create()`
- Loading must use `getOnnxSessionOptions()` (CPU execution provider)
- After successful load, `_ready` must be `true` and `_status` must be `'loaded'`
- If model file is missing, `_status` must be `'missing'` and `_ready` must remain `false`
- If load throws (corrupt file, OOM), `_status` must be `'failed'` and `_ready` must remain `false`

### FR-MSK-003 — Mask Module Toggle Gate

- Before running mask classification, `AttributePipeline` must check `analyticsConfig.mask !== false`
- If `analyticsConfig.mask` is `false` or the PPE model is not ready, the `mask` field must be `undefined` on person detections
- Mask detection must activate within 1 frame after PUT `/api/analytics/config` with `{ mask: true }`

### FR-MSK-004 — Shared PPE Inference

- When both `mask` and `hat` analyticsConfig keys are `true`, a single PPE inference call must produce detections used by both modules
- No duplicate ONNX inference calls must occur for mask when hat is already running
- The `ProtectiveEquipService.detect()` result array is processed once and filtered by classId for each module

### FR-MSK-005 — PPE Preprocessing

- Input JPEG frame must be preprocessed identically to the YOLOv8n pipeline:
  - Proportional resize with letterboxing to 640×640 (grey padding: R:114, G:114, B:114)
  - CHW Float32 tensor normalized to [0, 1]
  - Tensor shape: `[1, 3, 640, 640]`

### FR-MSK-006 — PPE Confidence Threshold

- PPE detections with `confidence < 0.30` must be discarded before head ROI matching
- This threshold is the `confThresh` constructor option defaulting to `0.30`

---

## 4. Functional Requirements — Head ROI Extraction

### FR-MSK-007 — Head ROI Formula

- For each tracked person bbox `{ x, y, width, height }`, the head ROI must be computed as:
```javascript
headRoi = {
  x:      personBbox.x + personBbox.width  * 0.15,
  y:      personBbox.y,
  width:  personBbox.width  * 0.70,
  height: personBbox.height * 0.35,
}
```
- This covers the upper 35% of the person bounding box centered horizontally

### FR-MSK-008 — Head ROI Bounds Clamping

- All head ROI coordinates must be clamped to the frame bounds: x ≥ 0, y ≥ 0, x+width ≤ frameWidth, y+height ≤ frameHeight
- A head ROI with zero area after clamping must produce `mask = { status: 'uncertain', confidence: 0 }`

### FR-MSK-009 — IoU Matching

- The `_bestMatch()` function must search all PPE class 1 (`mask`) and class 3 (`no_mask`) detections and return the highest-IoU match with the head ROI
- Minimum IoU threshold for a valid match: 0.1
- If no PPE detection achieves IoU ≥ 0.1 with the head ROI, `_bestMatch()` returns `null` → `status: 'uncertain'`

### FR-MSK-010 — Minimum Head Size

- If the computed head ROI has `width < 30` or `height < 30` pixels (in original frame coordinates), the mask classification must be skipped and `status: 'uncertain'` returned
- This prevents classification on heads too small for reliable detection

---

## 5. Functional Requirements — Mask Classification & Output

### FR-MSK-011 — Mask Attribute Always Emitted

- When the mask module is enabled (FR-MSK-003) and the PPE model is ready, every person detection must include a `mask` field
- The `mask` field must never be `undefined` when the module is active
- When the module is disabled or model is not loaded, `mask` must be `undefined` (absent)

### FR-MSK-012 — Mask Attribute Schema

The `mask` attribute attached to each person detection must conform to:
```json
{
  "status":     "mask_correct" | "no_mask" | "uncertain",
  "confidence": number
}
```

| Condition | `status` | `confidence` |
|---|---|---|
| PPE class 1 (Mask) IoU-matched to head ROI | `"mask_correct"` | PPE detection score |
| PPE class 3 (NO-Mask) IoU-matched to head ROI | `"no_mask"` | PPE detection score |
| No PPE mask/no_mask detection overlaps head ROI | `"uncertain"` | 0 |

### FR-MSK-013 — UI Badge Rendering

- `mask.status === 'mask_correct'` must render a **MASK OK** badge (green) in the detection panel and canvas overlay
- `mask.status === 'no_mask'` must render a **NO MASK** badge (red)
- `mask.status === 'uncertain'` must render a **MASK?** badge (gray)
- When `mask === undefined` (module off), no mask badge must be rendered

---

## 6. Functional Requirements — Zone Activation & Alerts

### FR-MSK-014 — Zone targetClasses Activation

- The mask detection attribute pipeline must be activated per zone when `zone.targetClasses` includes `"mask"`
- Zones without `"mask"` in `targetClasses` must still receive person detections but without zone-level mask compliance checking

### FR-MSK-015 — maskPolicy Zone Field

- Zone configuration must support a `maskPolicy` field with values: `'mandatory'`, `'recommended'`, `'none'`
- Default value when `maskPolicy` is absent: `'none'` (monitoring only, no alerts)

### FR-MSK-016 — mask_violation Alert

- When `zone.maskPolicy === 'mandatory'` and a person in the zone has `mask.status === 'no_mask'`, a `mask_violation` Socket.IO event must be emitted
- The event payload must conform to:
```json
{
  "type":            "mask_violation",
  "cameraId":        "string",
  "objectId":        "string",
  "zoneId":          "string",
  "maskStatus":      "no_mask",
  "maskConfidence":  number,
  "dwellTime":       number,
  "timestamp":       number
}
```

### FR-MSK-017 — No Alert on Uncertain

- When `mask.status === 'uncertain'`, no `mask_violation` alert must be emitted regardless of zone policy
- This prevents false alarms for persons who are occluded, turned away, or too small to classify

### FR-MSK-018 — Recommended Policy Behavior

- When `zone.maskPolicy === 'recommended'`, a `mask_violation` event may be emitted as an informational warning (not a blocking alert)
- `mask.status === 'uncertain'` must never trigger a violation under `'recommended'` policy

---

## 7. Functional Requirements — Integration & Dashboard

### FR-MSK-019 — Analytics Config Key

- The `analyticsConfig` must include a `mask` key (boolean)
- PUT `/api/analytics/config` with `{ mask: true | false }` must update the key and persist to `storage/analytics.json`
- GET `/api/analytics/config` must return the current `mask` value

### FR-MSK-020 — Capabilities Endpoint

- `GET /api/capabilities` must include `ai.mask` (boolean) and `status.mask` (string)
- `ai.mask` must be `true` when `yolov8m_ppe.onnx` is present and not failed
- `status.mask` must be one of: `'loaded'`, `'available'`, `'missing'`, `'failed'`

### FR-MSK-021 — Socket.IO Detections Event

- Person detections with mask attributes must be included in the `detections` Socket.IO event payload
- The enriched person detection must include the `mask` field alongside all other fields

### FR-MSK-022 — Batch Inference

- When multiple persons (up to 8) are detected per frame, head ROI crops may be batched into a single PPE inference call to reduce per-person latency from ~2 ms to ~0.5 ms
- Batching is optional in Phase-1; sequential per-person processing is acceptable if batch inference is not implemented

---

## 8. Functional Requirements — Error Handling

### FR-MSK-023 — PPE Model Missing

- If `yolov8m_ppe.onnx` does not exist at startup, `ProtectiveEquipService._status` must be `'missing'`
- Mask detection must be gracefully disabled; all person detections will have `mask === undefined`
- `GET /api/capabilities` must return `ai.mask: false` and `status.mask: 'missing'`

### FR-MSK-024 — PPE Inference Error Recovery

- If PPE `detect()` throws during a frame, the exception must be caught and logged
- All person detections in that frame must receive `mask = { status: 'uncertain', confidence: 0 }` instead of propagating the error

### FR-MSK-025 — Invalid JPEG Input

- If the `jpegBuffer` passed to `ProtectiveEquipService.detect()` is invalid, `sharp` will throw
- The service must catch this and return `[]` (empty PPE detection array), resulting in `mask = uncertain` for all persons

---

## 9. Non-Functional Requirements

### FR-MSK-030 — Inference Latency

- Per-person mask detection overhead must not exceed 7 ms (head ROI extraction + IoU matching)
- Per-frame mask overhead (10 persons) must not exceed 30 ms; with batch inference ≤ 10 ms
- PPE inference is shared with hat detection; combined overhead must not duplicate inference cost

### FR-MSK-031 — Memory Usage

- The PPE model is shared between mask and hat; no additional memory beyond the shared model
- PPE model memory budget: ≤ 200 MB (file ~50 MB, session larger in memory)

### FR-MSK-032 — Accuracy

- `no_mask` precision must be ≥ 96% on MaskedFace-Net test set
- `no_mask` recall must be ≥ 94% on MaskedFace-Net test set
- Overall accuracy (3-class) must be ≥ 95% on combined test set

### FR-MSK-033 — Simultaneous Persons

- The mask pipeline must support up to 50 simultaneously tracked persons per frame
- For 50 persons with batch size 8, maximum 7 inference batches per frame is acceptable

---

## 10. Interface Requirements

### 10.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-MSK-019 | GET | `/api/analytics/config` | Query mask module enable state |
| FR-MSK-019 | PUT | `/api/analytics/config` | Set mask module enable flag |
| FR-MSK-020 | GET | `/api/capabilities` | Query mask capability and model status |

**Response schema for `/api/capabilities` (mask fields):**
```json
{
  "ai":     { "mask": true },
  "status": { "mask": "loaded" }
}
```

### 10.2 Socket.IO Events

| Event | Direction | Payload | Condition |
|---|---|---|---|
| `detections` | Server→Client | Person detections with `mask` attribute | Per frame when mask module enabled |
| `mask_violation` | Server→Client | See FR-MSK-016 schema | When `maskPolicy: 'mandatory'` and `no_mask` detected |

### 10.3 Internal Service API

```javascript
// ProtectiveEquipService
new ProtectiveEquipService({ modelPath, confThresh, nmsThresh })
load() → Promise<void>
detect(jpegBuffer, origW, origH) → Promise<Array<{bbox, confidence, classId, className}>>
get ready() → boolean
get status() → 'not_started' | 'missing' | 'loaded' | 'failed'

// AttributePipeline mask integration
extractHeadRoi(personBbox) → { x, y, width, height }
_bestMatch(ppeDetections, headRoi) → PPEDetection | null
isMaskCompliant(maskStatus, zonePolicy) → boolean
```

---

## 11. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Model `yolov8m_ppe.onnx` must be present in `server/models/` for mask detection to function |
| C-02 | Phase-1 mask classification is binary: `mask_correct` / `no_mask`; `mask_incorrect` detection requires a dedicated Phase-2 model |
| C-03 | Head ROI formula (top 35% of person bbox) degrades at steep camera angles or when persons are very small |
| C-04 | Minimum head size for reliable classification: 30×30 pixels in the original frame |
| C-05 | The `mask` field is `undefined` (absent) when the module is disabled or the model is not loaded |
| C-06 | `mask.status === 'uncertain'` must never trigger a `mask_violation` alert |
| C-07 | The `maskPolicy` field in zone configuration is validated but defaults to `'none'` when absent |
| C-08 | The PPE model is shared with hat detection (AI-07); loading it once serves both modules simultaneously |
| C-09 | Phase-2 mask-type sub-classification (surgical, N95, cloth) is out of scope for this SRS version |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for AI Mask Detection |
