# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module — Accessories Detection

| | |
|---|---|
| **Document ID** | SRS-LTS-AI-ACC-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_AI_Accessories_Detection.md |
| **Parent RFP** | rfp/RFP_AI_Accessories_Detection.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Model & Inference](#3-functional-requirements--model--inference)
4. [Functional Requirements — Class Filtering & Gating](#4-functional-requirements--class-filtering--gating)
5. [Functional Requirements — Person-Accessory Association](#5-functional-requirements--person-accessory-association)
6. [Functional Requirements — Abandoned Item Detection](#6-functional-requirements--abandoned-item-detection)
7. [Functional Requirements — Integration & Output](#7-functional-requirements--integration--output)
8. [Functional Requirements — Error Handling](#8-functional-requirements--error-handling)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Interface Requirements](#10-interface-requirements)
11. [Constraints & Assumptions](#11-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the AI Accessories Detection module of LTS-2026. Each requirement is identified by a unique ID (FR-ACC-NNN) and is directly traceable to test cases in TC_AI_Accessories_Detection.md.

### 1.2 Scope

This document covers:
- Detection of 5 Phase-1 COCO accessory classes (backpack, umbrella, handbag, tie, suitcase) using the shared `yolov8n.onnx` model
- Per-item enable/disable toggles via `analyticsConfig` and the `/api/analytics/config` REST endpoint
- Person-accessory association via IoU overlap on expanded person bounding box
- Abandoned item detection state machine (DETECTED → UNATTENDED → ABANDONED → CLEARED)
- Socket.IO emission of accessory-enriched detection results and `abandoned_item` alerts
- Error handling for model failures and invalid inputs

Out of scope: Phase-2 worn accessories (glasses, sunglasses, jewelry, gloves, scarf), accessory color estimation, person search by accessory/color API.

### 1.3 Definitions

| Term | Definition |
|---|---|
| DetectionService | Node.js class wrapping the YOLOv8n ONNX model; shared with human/vehicle/animal detection |
| COCO accessory classes | COCO 80-class IDs 24–28: backpack(24), umbrella(25), handbag(26), tie(27), suitcase(28) |
| Person-accessory association | Matching each detected accessory bbox to the nearest person bbox using IoU on an expanded person bbox (scale ×1.3) |
| AbandonedItemTracker | State machine tracking accessories not associated with any person for longer than a configurable timeout |
| analyticsConfig | Server-side configuration object; `isClassEnabled(className)` returns boolean per item key |
| Zone targetClass | Zone config field; `'accessories'` is a backward-compatible alias for all 5 COCO accessory classes |
| abandonedItemPolicy | Per-zone block controlling abandoned item timeout and priority level |
| IoU | Intersection over Union — ratio of bounding box overlap area to union area |

---

## 2. System Overview

### 2.1 Component Dependencies

```
RTSP / JPEG Frame
  └─ DetectionService.detect()         — YOLOv8n ONNX, classes 24-28 (accessories) + class 0 (person)
       └─ PipelineManager
            ├─ analyticsConfig.isClassEnabled(className)   — per-item gate
            ├─ associateAccessoryToPerson(accessoryBbox, persons)  — IoU match
            ├─ AbandonedItemTracker.update()               — abandoned item state machine
            ├─ ZoneManager.matchZone(bbox)                 — zone assignment
            ├─ TrackingService.update(detections)          — dwell-time tracking
            └─ Socket.IO emit 'detections' / 'abandoned_item'
```

### 2.2 Phase-1 Accessory Classes (COCO yolov8n.onnx)

| COCO ID | className | analyticsConfig key | Default |
|---|---|---|---|
| 24 | `backpack` | `backpack` | `false` |
| 25 | `umbrella` | `umbrella` | `false` |
| 26 | `handbag` | `handbag` | `false` |
| 27 | `tie` | `tie` | `false` |
| 28 | `suitcase` | `suitcase` | `false` |

### 2.3 Startup Sequence

```
Server start
  1. DetectionService constructed (shared yolov8n.onnx session)
  2. DetectionService.load()   — ONNX InferenceSession created (shared with human/vehicle/animal)
  3. analyticsConfig.load()    — per-class enable flags loaded from storage/analytics.json
  4. PipelineManager.start()   — cameras registered
  5. Per-frame loop begins
  6. HTTP server listens on PORT
```

---

## 3. Functional Requirements — Model & Inference

### FR-ACC-001 — Shared Model File

- Accessory detection must use `yolov8n.onnx` in `server/models/`
- No additional ONNX model is required for Phase-1 (COCO classes 24–28 are in the existing model)
- The Phase-2 fine-tuned model (`accessories_yolov8n_finetune.onnx`) is out of scope for this SRS version

### FR-ACC-002 — Shared Inference Session

- Accessory classes must be detected in the same `DetectionService.detect()` call that detects persons, vehicles, and animals
- A separate ONNX inference session must not be created for accessory detection
- Detection output includes all COCO 80 classes; accessory classes are selected by the `ENABLED_CLASSES` map

### FR-ACC-003 — Confidence Threshold

- The default confidence threshold for accessory classes must be `0.45` (shared with all COCO classes, overridable via `CONFIDENCE_THRESHOLD` env var)
- Anchor boxes below this threshold must be discarded before NMS

### FR-ACC-004 — COCO Class ID Mapping

- The `ENABLED_CLASSES` map in `detection.js` must include entries for COCO IDs 24–28:
  `24: 'backpack'`, `25: 'umbrella'`, `26: 'handbag'`, `27: 'tie'`, `28: 'suitcase'`
- Detections with `classId` 24–28 must produce output objects with the corresponding `className` string

---

## 4. Functional Requirements — Class Filtering & Gating

### FR-ACC-005 — Per-Item Enable Toggle

- Each of the 5 accessory classes must have an independent enable/disable key in `analyticsConfig`:
  `backpack`, `umbrella`, `handbag`, `tie`, `suitcase`
- `analyticsConfig.isClassEnabled(className)` must return `true` only when the corresponding key is `true`
- Detections for disabled classes must not be forwarded to the tracker or emitted to clients

### FR-ACC-006 — Default State

- All 5 accessory keys must default to `false` in `DEFAULT_CONFIG` (accessories off at startup)
- The default may be overridden by `storage/analytics.json` if that file exists

### FR-ACC-007 — Backward-Compatible Zone Alias

- Zone configurations specifying `targetClass: 'accessories'` (singular or plural) must match all 5 COCO accessory classNames
- The `TARGET_CLASS_MAP` in `behaviorEngine.js` must include: `accessories: ['backpack', 'umbrella', 'handbag', 'tie', 'suitcase']`
- Individual zone keys (`backpack`, `handbag`, etc.) must also be supported for per-item zone targeting

### FR-ACC-008 — Analytics Config Persistence

- PUT `/api/analytics/config` with `{ backpack: true }` must persist the change to `storage/analytics.json`
- GET `/api/analytics/config` must return the current per-item state
- Changes must take effect within 1 frame processing cycle (no server restart required)

---

## 5. Functional Requirements — Person-Accessory Association

### FR-ACC-009 — IoU Association

- For each detected accessory bbox, the system must search the current frame's person detection list for the best IoU match
- The person bbox must be expanded by a scale factor of 1.3 before computing IoU: `expandBbox(person.bbox, 1.3)`
- The accessory is associated with the person whose expanded bbox has the highest IoU above the association threshold of 0.1

### FR-ACC-010 — Unassociated Accessory Handling

- Accessories with no IoU match above 0.1 must be flagged as unattended candidates
- Unattended candidates must be passed to `AbandonedItemTracker.update()` for state machine processing

### FR-ACC-011 — Association Output

- When an accessory is successfully associated with a person, it must be appended to that person detection's `accessories` array:
```json
{ "type": "backpack", "confidence": 0.91, "bbox": {...}, "color": null }
```
- `color` must be `null` in Phase-1 (color estimation is a Phase-2 feature)

### FR-ACC-012 — Detection Output Schema

Each accessory detection (stand-alone) must conform to:
```json
{
  "bbox":       { "x": number, "y": number, "width": number, "height": number },
  "confidence": number,
  "classId":    number,
  "className":  "backpack" | "umbrella" | "handbag" | "tie" | "suitcase"
}
```

---

## 6. Functional Requirements — Abandoned Item Detection

### FR-ACC-013 — Abandoned Item State Machine

The `AbandonedItemTracker` must implement the following state transitions per tracked unattended accessory:

```
DETECTED → UNATTENDED (no person within proximity for > 0 s, timer starts)
UNATTENDED → ABANDONED (accessory position stable, timer ≥ abandon_timeout)
ABANDONED → emit 'abandoned_item' Socket.IO event
ABANDONED → CLEARED (person re-approaches and is associated)
```

### FR-ACC-014 — Abandon Timeout by Priority

The default abandon timeouts must be configurable and default to:

| Priority | Timeout | Accessory Types |
|---|---|---|
| `high` | 30 s | `suitcase`, `backpack` |
| `medium` | 60 s | `handbag` |
| `low` | 120 s | `umbrella`, `tie` |

Per-zone `abandonedItemPolicy.timeoutSec` must override the default when present.

### FR-ACC-015 — Position Stability Check

- An abandoned item candidate must only be declared ABANDONED if its bbox centroid displacement is < 20 px across the timeout window
- Items with displacement ≥ 20 px must have their timer reset (item is moving, not abandoned)

### FR-ACC-016 — Abandoned Item Alert Schema

When the ABANDONED state is reached, the following Socket.IO event must be emitted:
```json
{
  "type":             "abandoned_item",
  "cameraId":         "string",
  "accessoryType":    "suitcase",
  "accessoryColor":   null,
  "lastPersonId":     "string | null",
  "abandonDurationSec": number,
  "bbox":             { "x": number, "y": number, "width": number, "height": number },
  "zoneId":           "string | null",
  "priority":         "high" | "medium" | "low",
  "timestamp":        number
}
```

### FR-ACC-017 — False Alarm Suppression

- While a person is associated with (or within proximity threshold of) an accessory, no abandoned item alert must be emitted
- If a person returns to a previously unattended accessory before the timeout, the state machine must transition to CLEARED and the timer must reset

---

## 7. Functional Requirements — Integration & Output

### FR-ACC-018 — Socket.IO Detections Event

- Accessory detections must be included in the `detections` Socket.IO event emitted by PipelineManager
- Each accessory detection in the event payload must include:
```json
{
  "id":         "string (tracker ID)",
  "bbox":       { "x": number, "y": number, "width": number, "height": number },
  "confidence": number,
  "classId":    number,
  "className":  "backpack" | "umbrella" | "handbag" | "tie" | "suitcase",
  "isLoitering": boolean,
  "dwellTime":  number,
  "zoneId":     "string | null",
  "cameraId":   "string"
}
```

### FR-ACC-019 — Loitering Alert Enrichment

- When a loitering alert is emitted for a person who has associated accessories, the `loitering:alert` event payload must include an `appearance.accessories` array:
```json
{
  "appearance": {
    "accessories": [
      { "type": "backpack", "color": null, "confidence": 0.92 }
    ]
  }
}
```

### FR-ACC-020 — Capabilities Endpoint

- `GET /api/capabilities` must include per-item accessory status
- Response must include `{ ai: { backpack: boolean, umbrella: boolean, handbag: boolean, tie: boolean, suitcase: boolean } }`
- Each value must be `true` when the yolov8n.onnx model is loaded and the item's analyticsConfig key is enabled

---

## 8. Functional Requirements — Error Handling

### FR-ACC-021 — Model Load Failure

- If `yolov8n.onnx` does not load, accessory detection must be silently disabled
- `GET /api/capabilities` must reflect `backpack: false` (and all other accessory keys) when the model is not loaded

### FR-ACC-022 — Inference Error Recovery

- If ONNX inference throws during a frame, `detect()` must return `{ detections: [], frameWidth: 0, frameHeight: 0 }`
- Accessory-specific processing (association, abandoned tracker) must be skipped for that frame

### FR-ACC-023 — Invalid Association Input

- If the person bbox list is empty or null, `associateAccessoryToPerson()` must treat all accessories as unattended without throwing

---

## 9. Non-Functional Requirements

### FR-ACC-030 — Inference Latency

- Accessory detection occurs in the shared inference pass; the per-frame overhead from accessory class parsing and person-association must not exceed 5 ms
- Total end-to-end frame processing (including accessory pipeline) must not exceed 150 ms

### FR-ACC-031 — Memory Usage

- No additional ONNX session is created for accessories; shared model memory budget is unchanged (≤ 512 MB)
- `AbandonedItemTracker._state` Map must be bounded: entries older than 5 minutes must be pruned

### FR-ACC-032 — Accuracy

- Phase-1 COCO accessory classes must achieve ≥ 53% mAP@0.5 average on COCO val2017 for backpack, umbrella, handbag, suitcase (tie is lower priority)
- Person-accessory association must be correct in ≥ 88% of cases against the test set

### FR-ACC-033 — Concurrency

- `AbandonedItemTracker` must be accessed from a single PipelineManager frame-processing loop; no mutex required as operations are sequential per camera pipeline

---

## 10. Interface Requirements

### 10.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-ACC-008 | GET | `/api/analytics/config` | Query per-item accessory enable state |
| FR-ACC-008 | PUT | `/api/analytics/config` | Set per-item accessory enable flags |
| FR-ACC-020 | GET | `/api/capabilities` | Query accessory detection capability status |

**PUT `/api/analytics/config` request schema (accessories subset):**
```json
{
  "backpack": true,
  "umbrella": false,
  "handbag":  true,
  "tie":      false,
  "suitcase": true
}
```

### 10.2 Socket.IO Events

| Event | Direction | Payload | Condition |
|---|---|---|---|
| `detections` | Server→Client | Includes accessory detection objects | Emitted per frame when accessories detected |
| `abandoned_item` | Server→Client | See FR-ACC-016 schema | Emitted when item abandoned for > timeout |

### 10.3 Internal Service API

```javascript
// DetectionService — unchanged, accessory classes already in ENABLED_CLASSES
detect(jpegBuffer, originalSize) → Promise<{ detections, frameWidth, frameHeight }>

// AbandonedItemTracker
new AbandonedItemTracker(options)
update(accessories, persons, timestamp, cameraId, zoneId) → Array<AbandonedItemEvent>

// Person-accessory association helper
associateAccessoryToPerson(accessoryBbox, personBboxes, threshold?) → PersonDetection | null
```

---

## 11. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Model `yolov8n.onnx` must be present in `server/models/` before server start |
| C-02 | Phase-1 covers only COCO classes 24–28; glasses, jewelry, gloves, scarf require Phase-2 model |
| C-03 | The `accessories` zone targetClass alias must remain supported for backward zone configuration compatibility |
| C-04 | Accessory color (`color` field) is always `null` in Phase-1 |
| C-05 | Person detection (class 0) must be enabled for person-accessory association to function correctly |
| C-06 | Abandoned item detection is gated by the respective accessory item being enabled in analyticsConfig |
| C-07 | The `abandonedItemPolicy` per-zone block is validated but optional; defaults apply when absent |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for AI Accessories Detection |
