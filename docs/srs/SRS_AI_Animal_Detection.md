# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module — Animal Detection

| | |
|---|---|
| **Document ID** | SRS-LTS-AI-ANI-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_AI_Animal_Detection.md |
| **Parent RFP** | rfp/RFP_AI_Animal_Detection.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Model & Inference](#3-functional-requirements--model--inference)
4. [Functional Requirements — Class Filtering & Gating](#4-functional-requirements--class-filtering--gating)
5. [Functional Requirements — Postprocessing & Output](#5-functional-requirements--postprocessing--output)
6. [Functional Requirements — Loitering & Zone Integration](#6-functional-requirements--loitering--zone-integration)
7. [Functional Requirements — Dashboard Integration](#7-functional-requirements--dashboard-integration)
8. [Functional Requirements — Error Handling](#8-functional-requirements--error-handling)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Interface Requirements](#10-interface-requirements)
11. [Constraints & Assumptions](#11-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the AI Animal Detection module of LTS-2026. Each requirement is identified by a unique ID (FR-ANI-NNN) and is directly traceable to test cases in TC_AI_Animal_Detection.md.

### 1.2 Scope

This document covers:
- Real-time detection of 10 COCO animal species using the shared `yolov8n.onnx` model (zero additional model cost)
- Per-class enable/disable toggles via `analyticsConfig` and the `/api/analytics/config` REST endpoint
- Zone-based loitering dwell-time analysis applied to animal tracks (identical logic to person/vehicle)
- Socket.IO emission of animal detection results and `loitering:alert` events
- Dashboard display with species-specific color codes
- Error handling for model failures and configuration errors

Out of scope: species outside COCO 80 (fox, deer, rabbit, raccoon, etc.), animal re-identification across cameras, animal behavior analysis beyond basic dwell-time loitering.

### 1.3 Definitions

| Term | Definition |
|---|---|
| DetectionService | Node.js class wrapping the YOLOv8n ONNX model; shared with human/vehicle/accessories detection |
| COCO animal classes | COCO 80-class IDs 14–23: bird(14), cat(15), dog(16), horse(17), sheep(18), cow(19), elephant(20), bear(21), zebra(22), giraffe(23) |
| analyticsConfig | Server-side configuration object; `isClassEnabled(className)` returns boolean per species key |
| ByteTracker | Multi-object tracker that assigns objectIds and accumulates dwellTime; treats animal tracks identically to person tracks |
| BehaviorAnalyzer | Module that sets `isLoitering = true` when `dwellTime ≥ zone.dwellThreshold` |
| Zone targetClass | Individual species names used as zone config `targetClasses` values (e.g., `["dog", "cat"]`) |
| dwellThreshold | Per-zone configurable time in seconds after which a detected object is considered loitering |

---

## 2. System Overview

### 2.1 Component Dependencies

```
RTSP / JPEG Frame
  └─ DetectionService.detect()           — YOLOv8n ONNX, classes 14-23 (animals)
       └─ PipelineManager
            ├─ analyticsConfig.isClassEnabled(className)   — per-species gate
            ├─ ZoneManager.matchZone(bbox)                 — zone assignment
            ├─ ByteTracker.update(detections)              — animal track assignment + dwellTime
            ├─ BehaviorAnalyzer.update(tracks)             — isLoitering flag
            └─ Socket.IO emit 'detections' / 'loitering:alert'
```

### 2.2 Animal Class Mapping

| COCO ID | className | analyticsConfig key | Default | Dashboard Color |
|---|---|---|---|---|
| 14 | `bird` | `bird` | `false` | `text-pink-200` |
| 15 | `cat` | `cat` | `false` | `text-rose-300` |
| 16 | `dog` | `dog` | `false` | `text-rose-400` |
| 17 | `horse` | `horse` | `false` | `text-orange-800` |
| 18 | `sheep` | `sheep` | `false` | `text-gray-100` |
| 19 | `cow` | `cow` | `false` | `text-amber-900` |
| 20 | `elephant` | `elephant` | `false` | `text-gray-500` |
| 21 | `bear` | `bear` | `false` | `text-amber-800` |
| 22 | `zebra` | `zebra` | `false` | `text-gray-100` |
| 23 | `giraffe` | `giraffe` | `false` | `text-amber-600` |

### 2.3 Startup Sequence

```
Server start
  1. DetectionService constructed (shared yolov8n.onnx session)
  2. DetectionService.load()    — ONNX InferenceSession created (shared with all COCO classes)
  3. analyticsConfig.load()     — per-class enable flags loaded from storage/analytics.json
  4. PipelineManager.start()    — cameras registered
  5. Per-frame loop begins
  6. HTTP server listens on PORT
```

---

## 3. Functional Requirements — Model & Inference

### FR-ANI-001 — Shared Model File

- Animal detection must use `yolov8n.onnx` in `server/models/` (shared with all COCO class detection)
- No additional ONNX model is required for Phase-1; all 10 COCO animal classes are present in the existing model

### FR-ANI-002 — Shared Inference Session

- Animal classes must be detected in the same `DetectionService.detect()` call used for persons, vehicles, and accessories
- A separate ONNX inference session must not be created for animal detection
- Additional model memory usage for animal detection must be 0 MB

### FR-ANI-003 — COCO Class ID Mapping

- The `ENABLED_CLASSES` map in `detection.js` must include entries for all 10 animal COCO IDs (14–23)
- Detections with `classId` 14–23 must produce output objects with the corresponding `className` string

### FR-ANI-004 — Confidence Threshold

- The default confidence threshold for animal classes must be `0.25` (as specified in the PRD; consistent with other shared COCO classes, overridable via `CONFIDENCE_THRESHOLD` env var)
- Anchor boxes below this threshold must be discarded before NMS

### FR-ANI-005 — NMS Threshold

- The default NMS IoU threshold must be `0.5` (shared with all COCO classes)
- Two boxes of the same animal class with IoU ≥ 0.5 must result in the lower-confidence box being suppressed

---

## 4. Functional Requirements — Class Filtering & Gating

### FR-ANI-006 — Per-Species Enable Toggle

- Each of the 10 animal classes must have an independent enable/disable key in `analyticsConfig`
- `analyticsConfig.isClassEnabled(className)` must return `true` only when the corresponding species key is `true`
- Detections for disabled species must not be forwarded to ByteTracker or emitted to clients

### FR-ANI-007 — Default State

- All 10 animal species keys must default to `false` in `DEFAULT_CONFIG` (all animals disabled at startup)
- The default may be overridden by `storage/analytics.json` if that file exists

### FR-ANI-008 — Analytics Config Persistence

- PUT `/api/analytics/config` with `{ dog: true, cat: true }` must persist changes to `storage/analytics.json`
- GET `/api/analytics/config` must return the current per-species enable state
- Changes must take effect within 1 frame processing cycle (no server restart required)

### FR-ANI-009 — Disable Takes Effect Immediately

- When a species class is disabled via PUT `/api/analytics/config`, detections for that class must be suppressed starting from the next processed frame
- No grace period or delay is permitted between config change and suppression

---

## 5. Functional Requirements — Postprocessing & Output

### FR-ANI-010 — Detection Output Schema

Each detected animal must produce an object with the following fields:
```json
{
  "bbox":       { "x": number, "y": number, "width": number, "height": number },
  "confidence": number,
  "classId":    number,
  "className":  "bird" | "cat" | "dog" | "horse" | "sheep" | "cow" | "elephant" | "bear" | "zebra" | "giraffe"
}
```

### FR-ANI-011 — Coordinate Transformation

- Bounding box coordinates must be mapped from the 640×640 letterboxed model space back to the original frame pixel space (same algorithm as human detection)
- Output bbox fields: `{ x, y, width, height }` in original frame pixel coordinates
- Coordinates must be clamped: x1 ≥ 0, y1 ≥ 0, x2 ≤ origW, y2 ≤ origH

### FR-ANI-012 — Return Structure

- `detect()` must return `{ detections: Array, frameWidth: number, frameHeight: number }`
- `detections` array contains all class-enabled animals (after `isClassEnabled()` filter) plus other enabled classes

---

## 6. Functional Requirements — Loitering & Zone Integration

### FR-ANI-013 — ByteTracker Animal Track Assignment

- Animal detections must be passed to `ByteTracker.update()` using the same call path as person and vehicle detections
- The tracker must assign a persistent `objectId` to each animal track across frames
- `dwellTime` must accumulate while the animal remains inside a zone polygon

### FR-ANI-014 — Zone Species Filtering

- Zones with `targetClasses: ["dog"]` must trigger loitering analysis only for dogs
- Zones with `targetClasses: ["cat", "dog", "bird"]` must trigger loitering analysis for those three species only
- Zones with an empty `targetClasses` array must apply loitering analysis to all enabled classes including animals

### FR-ANI-015 — Loitering Alert

- `BehaviorAnalyzer` must set `isLoitering = true` on animal tracks when `dwellTime ≥ zone.dwellThreshold`
- When an animal track becomes loitering, a `loitering:alert` Socket.IO event must be emitted with:
```json
{
  "cameraId":  "string",
  "objectId":  "string",
  "className": "dog",
  "zone":      "string",
  "dwellTime": number
}
```

### FR-ANI-016 — Detections Event Schema (Enriched)

Animal detections in the `detections` Socket.IO event payload must include enriched fields:
```json
{
  "id":          "string (tracker ID)",
  "bbox":        { "x": number, "y": number, "width": number, "height": number },
  "confidence":  number,
  "classId":     number,
  "className":   "dog",
  "isLoitering": boolean,
  "dwellTime":   number,
  "zoneId":      "string | null",
  "cameraId":    "string"
}
```

---

## 7. Functional Requirements — Dashboard Integration

### FR-ANI-017 — Species-Specific Color Codes

- The `DetectionRow` component must render each animal class with its designated Tailwind color class
- The mapping must match the PRD specification (see Section 2.2)
- Color codes must not be configurable by users; they are defined at the component level

### FR-ANI-018 — Loitering Badge

- Animal tracks with `isLoitering === true` must display a red loitering badge in the detection row
- The detection row background must switch to `bg-red-900/20` when loitering is active for animal detections

### FR-ANI-019 — Detection Panel Category Filter

- The Dashboard Detection Panel `CATEGORIES` list must include an "Animals" filter group
- Enabling the Animals filter must display all 10 species in the merged detection list
- Disabling the Animals filter must hide all animal detection rows without affecting other categories

### FR-ANI-020 — VideoAnalytics Tab Group

- A "Animals" checkbox group must appear in `VideoAnalyticsTab.tsx` with 10 individual checkboxes
- The group's i18n key must be `zoneGroupAnimals`
- Each checkbox label must use the corresponding i18n key for the species name
- Toggling a checkbox must call PUT `/api/analytics/config` with the updated species key

---

## 8. Functional Requirements — Error Handling

### FR-ANI-021 — Missing Model File

- If `yolov8n.onnx` does not exist at startup, animal detection must be silently disabled along with all other COCO classes
- `GET /api/capabilities` must reflect `animalDetection: false` when the model is not loaded

### FR-ANI-022 — Inference Error Recovery

- If ONNX inference throws during a frame, `detect()` must catch the error, log it, and return `{ detections: [], frameWidth: 0, frameHeight: 0 }`
- Animal-specific processing (zone matching, loitering analysis) must be skipped for that frame

### FR-ANI-023 — Invalid Species Key in Config

- If a PUT `/api/analytics/config` request contains an unrecognized animal species key, it must be silently ignored
- Valid keys for the 10 Phase-1 animals must be applied; unknown keys must not cause a 400 error

---

## 9. Non-Functional Requirements

### FR-ANI-030 — Inference Latency

- Animal detection occurs in the shared inference pass; no additional model latency is incurred
- Total frame processing latency with animals enabled must remain ≤ 15 ms/frame on target hardware

### FR-ANI-031 — Memory Usage

- No additional ONNX session is created; shared model memory budget is unchanged (≤ 512 MB)
- Animal track entries in ByteTracker must be subject to the same TTL pruning as person tracks

### FR-ANI-032 — Accuracy

- Animal class detections must achieve ≥ 45% mAP@0.5 average across all 10 classes on COCO val2017
- False positive rate must be < 5% per animal class on typical surveillance footage

### FR-ANI-033 — Concurrency

- The service must support concurrent animal `detect()` calls from multiple camera pipelines
- Each pipeline's ByteTracker instance is independent; no shared mutable state between camera pipelines

---

## 10. Interface Requirements

### 10.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-ANI-008 | GET | `/api/analytics/config` | Query per-species animal enable state |
| FR-ANI-008 | PUT | `/api/analytics/config` | Set per-species animal enable flags |
| FR-ANI-021 | GET | `/api/capabilities` | Query animal detection capability status |

**PUT `/api/analytics/config` request schema (animals subset):**
```json
{
  "bird": false, "cat": true, "dog": true, "horse": false,
  "sheep": false, "cow": false, "elephant": false,
  "bear": false, "zebra": false, "giraffe": false
}
```

### 10.2 Socket.IO Events

| Event | Direction | Payload | Condition |
|---|---|---|---|
| `detections` | Server→Client | Includes animal detection objects with enriched fields | Emitted per frame when enabled animals detected |
| `loitering:alert` | Server→Client | `{ cameraId, objectId, className, zone, dwellTime }` | Emitted when `dwellTime ≥ zone.dwellThreshold` |

### 10.3 Internal Service API

```javascript
// DetectionService — shared, animal classes already in ENABLED_CLASSES
detect(jpegBuffer, originalSize) → Promise<{ detections, frameWidth, frameHeight }>

// analyticsConfig
isClassEnabled(className: string) → boolean

// ByteTracker — unchanged, treats animal tracks identically to person tracks
update(detections) → TrackedObject[]
```

---

## 11. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Model `yolov8n.onnx` must be present in `server/models/` before server start |
| C-02 | Phase-1 covers only COCO animal classes (IDs 14–23); wildlife species outside COCO require Phase-2 model |
| C-03 | All 10 animal species default to `false` in `DEFAULT_CONFIG`; operators must explicitly enable desired species |
| C-04 | Animal Re-ID across cameras is not in scope; each camera tracks animals independently |
| C-05 | Animal loitering uses the same `dwellThreshold` configuration mechanism as person loitering |
| C-06 | The `zoneGroupAnimals` i18n key must be translated in all 15 supported languages |
| C-07 | ByteTracker parameters (IoU threshold, min_hits, max_age) apply equally to animal and person tracks |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for AI Animal Detection |
