# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module — Mask Detection

| | |
|---|---|
| **Document ID** | PRD-LTS-AI-04 |
| **Version** | 1.0 |
| **Status** | In Progress |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_AI_Mask_Detection.md (LTS-2026-AI-04) |

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

The Mask Detection module classifies whether individuals in configured surveillance zones are wearing facial masks, enabling automated PPE compliance monitoring in healthcare, industrial, and public-transport environments without manual operator inspection.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- **G1**: Classify each tracked person's mask status as `mask_correct`, `no_mask`, or `uncertain` in real time at 10 FPS.
- **G2**: Operate as a two-stage pipeline — person detection → head ROI extraction → mask classifier — to minimise compute overhead.
- **G3**: Integrate with zone `targetClasses: ["mask"]` to generate `mask_violation` alerts for non-compliant individuals.
- **G4**: Share the existing PPE ONNX model (`yolov8m_ppe.onnx`) with the Hat Detection module.
- **G5**: Emit `mask.status` on every detection frame so the dashboard can render MASK OK / NO MASK / MASK? badges.

### 2.2 Non-Goals

- **NG1**: Fine-grained mask-type classification (`surgical`, `n95`, `cloth`) — Phase 2.
- **NG2**: `mask_incorrect` (chin/below-nose) detection — requires dedicated 3-class model, Phase 2.
- **NG3**: Identity recognition of mask non-compliant persons.

---

## 3. User Personas

### P1: Facility Security Operator
Monitors hospital entrance or clean-room access; needs instant visual feedback (badge colour) when someone enters without a mask.

### P2: Compliance Manager
Reviews alert logs after each shift to verify PPE policy adherence; requires accurate alert records with thumbnails and timestamps.

---

## 4. Functional Specification

### 4.1 Two-Stage Detection Pipeline

1. **Stage 1 — Person Detection**: YOLOv8n produces person bounding boxes per frame.
2. **Head ROI Extraction**: `x += width×0.15`, `y` unchanged, `width ×= 0.70`, `height ×= 0.35`.
3. **Stage 2 — Mask Classification**: PPE model runs on head crop; classes `Mask`(1) and `NO-Mask`(3) map to `mask_correct` / `no_mask`.
4. **Uncertain fallback**: If no PPE detection overlaps the head ROI, emit `mask.status = "uncertain"`.

### 4.2 Zone Activation

- Zone `targetClasses` must include `"mask"` to enable the module.
- `maskPolicy`: `"mandatory"` | `"recommended"` | `"none"`.
- `mask_violation` alert fired when policy is violated.

### 4.3 Batch Inference

Up to 8 head crops batched per inference call (reduces per-person latency from ~2 ms to ~0.5 ms).

### 4.4 Dashboard Badge Rendering

| `mask.status` | Badge | Colour |
|---|---|---|
| `mask_correct` | MASK OK | Green |
| `no_mask` | NO MASK | Red |
| `uncertain` | MASK? | Gray |

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Runtime | Node.js >= 20, `onnxruntime-node` (CPU) |
| PPE model | `server/models/yolov8m_ppe.onnx` |
| Mask classifier input | 112x112 normalised head crop |
| Inference speed | <= 7 ms per person; <= 30 ms per frame (10 persons) |
| Minimum head size | 30x30 px at 1080p |
| Model accuracy | >= 95% overall; `no_mask` precision >= 96%, recall >= 94% |

---

## 6. Input / Output Contract

### Detection output per tracked object
```json
{
  "objectId": "track-uuid",
  "className": "person",
  "bbox": { "x": 100, "y": 50, "width": 60, "height": 180 },
  "mask": { "status": "no_mask", "confidence": 0.962 }
}
```

### Alert output (`mask_violation`)
```json
{
  "type": "mask_violation",
  "cameraId": "cam-01",
  "objectId": "track-uuid",
  "zoneId": "zone-uuid",
  "maskStatus": "no_mask",
  "maskConfidence": 0.962,
  "dwellTime": 8.3,
  "timestamp": 1715678901234
}
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Zone activation | Module runs only when zone `targetClasses` includes `"mask"` |
| AC-02 | Badge rendering | Dashboard shows correct badge colour for each status |
| AC-03 | No-mask alert | `mask_violation` alert created when policy violated |
| AC-04 | Uncertain suppression | No alert fired when `mask.status=uncertain` |
| AC-05 | Batch performance | <= 30 ms per frame for 10 simultaneous persons |
| AC-06 | Accuracy | `no_mask` precision >= 96% on MaskedFace-Net test set |
| AC-07 | Capabilities | `GET /api/capabilities` returns correct `ai.mask` and `status.mask` |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | PPE model integration: Mask/NO-Mask class mapping, head ROI | 2026-05-18 | 2026-05-18 | Done |
| M2 | Dashboard badge rendering (MASK OK / NO MASK / MASK?) | 2026-05-20 | 2026-05-20 | Done |
| M3 | `mask_incorrect` support via dedicated 3-class classifier | TBD | - | Pending |

### 8.2 TODO

- [ ] Integrate dedicated 3-class mask classifier (MobileNetV3-Small) for `mask_incorrect` detection (Phase 2)
- [ ] Add extended mask-type classification: surgical, n95, cloth, face_shield (Phase 2)
- [ ] Validate accuracy >= 95% on MaskedFace-Net and MAFA benchmark datasets
- [ ] Implement `maskPolicy` field in zone configuration schema
- [ ] Add `mask_violation` alert type to alert service and frontend alert panel

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for AI Mask Detection |
