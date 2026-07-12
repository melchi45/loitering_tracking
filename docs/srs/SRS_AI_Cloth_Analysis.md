# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module — Cloth Analysis

| | |
|---|---|
| **Document ID** | SRS-LTS-AI-07-CLT |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-07-12 |
| **Parent PRD** | prd/PRD_AI_Cloth_Analysis.md |
| **Parent RFP** | rfp/RFP_AI_Cloth_Analysis.md |

> **Note (v1.1):** §3–§10 below describe the original Phase-2 design (`openpar.onnx`, 12 attributes, 128×256 input). The shipped implementation replaced this with PromptPAR (PA100k, CLIP ViT-L, 26 attributes, 224×224) plus a second selectable OpenPAR (ResNet50, PA100k) model — see `docs/design/Design_AI_Cloth_Analysis.md` v2.0 for the current, accurate model/schema. §12 (new in this version) adds the model-selection and memory-gate requirements for that shipped pair and is accurate as written.

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Phase-1 Behavior](#3-functional-requirements--phase-1-behavior)
4. [Functional Requirements — Phase-2 Model Loading](#4-functional-requirements--phase-2-model-loading)
5. [Functional Requirements — PAR Inference](#5-functional-requirements--par-inference)
6. [Functional Requirements — Attribute Classification](#6-functional-requirements--attribute-classification)
7. [Functional Requirements — Zone Gating](#7-functional-requirements--zone-gating)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Data Requirements](#9-data-requirements)
10. [Interface Requirements](#10-interface-requirements)
11. [Constraints & Assumptions](#11-constraints--assumptions)
12. [Functional Requirements — Model Selection & Memory Gate](#12-functional-requirements--model-selection--memory-gate)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the AI Cloth Analysis Module (AI-07-CLT) of LTS-2026. Each requirement is identified by a unique ID (FR-CLT-NNN) and is directly traceable to test cases in TC_AI_Cloth_Analysis.md.

### 1.2 Scope

This document covers:
- Phase-1 behavior: cloth analysis unavailable when PAR model is absent (returns `null`)
- Phase-2: optional loading of `openpar.onnx` Pedestrian Attribute Recognition model
- PAR model input preprocessing: ImageNet normalization and NCHW tensor formation
- Output attribute classification for upper clothing type, lower clothing type, and sleeve length
- Zone-level gating via `targetClass: 'cloth'`

Out of scope: HSV-based color extraction (covered by SRS-LTS-AI-06-CLR), face analysis, hat/mask detection.

### 1.3 Definitions

| Term | Definition |
|---|---|
| PAR | Pedestrian Attribute Recognition — multi-label classification of clothing attributes from a person crop |
| openpar.onnx | ONNX export of the OpenPAR model (https://github.com/Event-AHU/OpenPAR) |
| NCHW | Tensor layout: [Batch, Channels, Height, Width] |
| ATTR_LABELS | The 12 attribute output indices from the PAR model |
| Upper types | Clothing worn on the upper body: tshirt, shirt, jacket, hoodie, vest, dress |
| Lower types | Clothing worn on the lower body: pants, jeans, shorts, skirt |
| Sleeve types | Sleeve length classification: short_sleeve (index 10), long_sleeve (index 11) |
| Threshold | Confidence threshold 0.45 — scores below this are classified as 'unknown' |
| _parReady | Boolean flag on ColorClothService indicating the PAR model is loaded and ready |

---

## 2. System Overview

### 2.1 Component Dependencies

```
RTSP Frame (JPEG Buffer)
  └─ PipelineManager._processFrame()
       └─ ColorClothService.analyze()           [AI-07-CLT: cloth attribute]
            ├─ avgColor(upperRoi) + rgbToColorName()    [color — shared with AI-06-CLR]
            └─ _runPAR(jpegBuffer, personBbox)   [cloth — Phase-2 only]
                 ├─ sharp: extract + resize to 128×256
                 ├─ ImageNet normalization → Float32 NCHW [1,3,256,128]
                 ├─ ort.InferenceSession.run({ input: tensor })
                 └─ scores[12] → { upper, lower, sleeve }
                      └─ detections[].personAttrs.cloth  → Socket.IO 'detections' event
```

### 2.2 Phase Summary

| Phase | Model Required | cloth Output | Activation |
|---|---|---|---|
| Phase-1 | No | `null` | Always |
| Phase-2 | `openpar.onnx` | `{ upper, lower, sleeve }` | When model present on disk |

### 2.3 Model Reference

- Model source: https://github.com/Event-AHU/OpenPAR
- Export: `torch.onnx.export(model, dummy_input, "openpar.onnx", input_names=["input"], output_names=["attrs"], opset_version=11)`
- Model path: `server/models/openpar.onnx`

---

## 3. Functional Requirements — Phase-1 Behavior

### FR-CLT-001 — Phase-1 cloth Output is null

- When `openpar.onnx` is not present at `server/models/openpar.onnx`, `analyze()` must return `{ color: {...}, cloth: null }`
- `cloth: null` must be the value — not `undefined`, not an empty object
- The `null` return must be stable and deterministic regardless of the bounding box or frame content

### FR-CLT-002 — Color Always Returned in Phase-1

- Even when `cloth` is `null`, `analyze()` must return a valid `color` object with `upper` and `lower` color names
- `color` output is produced by the HSV-based pixel-average method regardless of PAR model availability

### FR-CLT-003 — _parReady Flag

- `ColorClothService._parReady` must be `false` before `load()` is called
- `_parReady` must remain `false` after `load()` if `openpar.onnx` is not found on disk
- `_parReady` must remain `false` after `load()` if the ONNX model fails to load (exception caught)
- `_parReady` must be set to `true` only when `_parSession` is successfully created

### FR-CLT-004 — Startup Log Messages

- When `openpar.onnx` is not found, `load()` must log: `[ColorClothService] openpar.onnx not found — cloth type analysis pending (Phase-2)`
- When PAR model loads successfully, `load()` must log: `[ColorClothService] PAR model loaded (Phase-2 cloth analysis active)`
- When PAR model load fails with an exception, `load()` must log a warning with the error message

---

## 4. Functional Requirements — Phase-2 Model Loading

### FR-CLT-005 — Optional Model Loading

- `load()` must check for `openpar.onnx` existence using `fs.existsSync(this.parModelPath)` before attempting to load
- Model loading must be attempted only when the file is present
- Model loading failure must not throw; the exception must be caught and logged

### FR-CLT-006 — ONNX Runtime Integration

- When loading, `ort.InferenceSession.create(this.parModelPath, getOnnxSessionOptions())` must be called
- The resulting session must be stored as `this._parSession`
- `getOnnxSessionOptions()` must be used to ensure consistent ONNX execution provider configuration

### FR-CLT-007 — Custom Model Path

- `ColorClothService` constructor must accept `options.parModelPath` to override the default model path
- Default model path: `path.resolve(__dirname, '..', '..', 'models', 'openpar.onnx')`

---

## 5. Functional Requirements — PAR Inference

### FR-CLT-008 — Person Crop Extraction

- `_runPAR(jpegBuffer, personBbox)` must extract the person crop using `sharp` with:
  - `left`: `Math.max(0, Math.round(personBbox.x))`
  - `top`: `Math.max(0, Math.round(personBbox.y))`
  - `width`: `Math.max(1, Math.round(personBbox.width))`
  - `height`: `Math.max(1, Math.round(personBbox.height))`
- The crop must be resized to 128×256 pixels (width × height) with `fit: 'fill'`

### FR-CLT-009 — ImageNet Normalization

- After resize, pixel values must be normalized with ImageNet statistics:
  - Mean: `[0.485, 0.456, 0.406]` for R, G, B channels respectively
  - Std: `[0.229, 0.224, 0.225]` for R, G, B channels respectively
  - Formula per channel: `(pixelValue / 255 - mean[ch]) / std[ch]`
- The result must be stored in a `Float32Array` of length `3 × 256 × 128 = 98,304` elements

### FR-CLT-010 — NCHW Tensor Layout

- The Float32Array must be arranged in NCHW order: channel index is the outer dimension
- Index formula: `floatData[ch * 256 * 128 + row * 128 + col]`
- The tensor shape must be `[1, 3, 256, 128]` (batch=1, channels=3, height=256, width=128)
- The tensor dtype must be `'float32'`

### FR-CLT-011 — Model Input Name

- The model input must be passed as `{ input: tensor }` to `_parSession.run()`
- Output must be read as `res.attrs.data` — a `Float32Array` of length 12

### FR-CLT-012 — Inference Error Handling

- If `_runPAR()` throws any exception during crop, normalization, or inference, it must catch the error, log a warning, and return `null`
- Returning `null` from `_runPAR()` causes `analyze()` to return `{ color: {...}, cloth: null }`

---

## 6. Functional Requirements — Attribute Classification

### FR-CLT-013 — Upper Clothing Type Classification

- Upper clothing scores are at output indices 0–5
- Index mapping: `0=tshirt, 1=shirt, 2=jacket, 3=hoodie, 4=vest, 5=dress`
- The index with the highest score among 0–5 must be selected as `bestUpperIdx`
- If `scores[bestUpperIdx] ≥ 0.45`, `upper` is set to the corresponding label string
- If `scores[bestUpperIdx] < 0.45`, `upper` is set to `'unknown'`

### FR-CLT-014 — Lower Clothing Type Classification

- Lower clothing scores are at output indices 6–9
- Index mapping: `6=pants, 7=jeans, 8=shorts, 9=skirt`
- The index with the highest score among 6–9 must be selected as `bestLowerIdx`
- If `scores[6 + bestLowerIdx] ≥ 0.45`, `lower` is set to the corresponding label string
- If `scores[6 + bestLowerIdx] < 0.45`, `lower` is set to `'unknown'`

### FR-CLT-015 — Sleeve Length Classification

- Sleeve scores are at output indices 10 (short_sleeve) and 11 (long_sleeve)
- `sleeve` is set to `'short'` when `scores[10] ≥ scores[11]`
- `sleeve` is set to `'long'` when `scores[11] > scores[10]`
- No threshold check is applied to sleeve — always returns one of `'short'` or `'long'`

### FR-CLT-016 — Cloth Attribute Return Schema

- When PAR inference succeeds, `_runPAR()` must return exactly:
  ```json
  { "upper": "string", "lower": "string", "sleeve": "short|long" }
  ```
- Valid values for `upper`: `tshirt`, `shirt`, `jacket`, `hoodie`, `vest`, `dress`, `unknown`
- Valid values for `lower`: `pants`, `jeans`, `shorts`, `skirt`, `unknown`
- Valid values for `sleeve`: `short`, `long`

---

## 7. Functional Requirements — Zone Gating

### FR-CLT-017 — Zone targetClass Activation

- Cloth analysis via `analyze()` must only be called when the zone has `'cloth'` in its `targetClasses` array
- `pipelineManager` must check zone configuration before invoking cloth analysis for each detection

### FR-CLT-018 — Cloth Output in Socket.IO Detections Event

- When cloth analysis is active and the PAR model is loaded, `detections[].personAttrs.cloth` must contain the `{ upper, lower, sleeve }` object
- When cloth analysis is active but the PAR model is not loaded, `detections[].personAttrs.cloth` must be `null`
- When zone does not include `'cloth'`, `personAttrs.cloth` must be absent or `null`

---

## 8. Non-Functional Requirements

### FR-CLT-019 — Model Load Time

- PAR model load must complete within 30 seconds of server startup on target hardware
- Model loading is performed during `ColorClothService.load()`, called during `AttributePipeline.load()`

### FR-CLT-020 — Inference Latency

- PAR inference per person must complete within 50 ms on CPU-based ONNX Runtime
- This latency budget includes crop extraction, normalization, and inference

### FR-CLT-021 — Memory

- The `Float32Array` tensor (98,304 floats = 393 KB) must be allocated per inference call and garbage-collected after the call
- No inference tensors must be held in service state between frames

---

## 9. Data Requirements

### 9.1 PAR Model Specifications

| Property | Value |
|---|---|
| Model file | `server/models/openpar.onnx` |
| Input name | `input` |
| Input shape | `[1, 3, 256, 128]` |
| Input dtype | `float32` |
| Output name | `attrs` |
| Output shape | `[12]` |
| Output dtype | `float32` |

### 9.2 ATTR_LABELS Index Map

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

### 9.3 analyze() Return Schema

```typescript
interface AnalyzeResult {
  color: {
    upper:    string;    // one of 11 color names
    lower:    string;    // one of 11 color names
    upperRgb: number[];
    lowerRgb: number[];
  };
  cloth: {
    upper:  string;   // tshirt|shirt|jacket|hoodie|vest|dress|unknown
    lower:  string;   // pants|jeans|shorts|skirt|unknown
    sleeve: string;   // short|long
  } | null;           // null when PAR model not loaded
}
```

---

## 10. Interface Requirements

### 10.1 Internal API

| Method | Signature | Returns | Notes |
|---|---|---|---|
| `load` | `() → Promise<void>` | void | Loads PAR model if present |
| `analyze` | `(jpegBuffer, personBbox, imgW?, imgH?) → Promise<AnalyzeResult>` | AnalyzeResult | Full color + cloth |
| `_runPAR` | `(jpegBuffer, personBbox) → Promise<ClothAttr\|null>` | Cloth object or null | Private method |

### 10.2 Socket.IO Event

| Event | Direction | Payload Field | Description |
|---|---|---|---|
| `detections` | Server → Client | `detections[].personAttrs.cloth` | Cloth attribute object or null |
| `detections` | Server → Client | `detections[].personAttrs.cloth.upper` | Upper clothing type string |
| `detections` | Server → Client | `detections[].personAttrs.cloth.lower` | Lower clothing type string |
| `detections` | Server → Client | `detections[].personAttrs.cloth.sleeve` | Sleeve length string |

### 10.3 REST API

No dedicated REST endpoints for cloth analysis. Cloth data flows exclusively through the Socket.IO `detections` event.

---

## 11. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | `openpar.onnx` must be exported from the OpenPAR PyTorch model using opset 11 |
| C-02 | The PAR model output node must be named `attrs` for the `res.attrs.data` access pattern |
| C-03 | `onnxruntime-node` must be installed in the server runtime |
| C-04 | Phase-2 is optional; the system is fully operational with `cloth: null` in Phase-1 |
| C-05 | The 0.45 confidence threshold is a fixed constant — adjustable only via code change |
| C-06 | Person crop must be at least 1×1 pixels after clamping; degenerate crops return `null` from `_runPAR()` |
| C-07 | Cloth analysis is only applied to `className === 'person'` detections |

---

## 12. Functional Requirements — Model Selection & Memory Gate

### FR-CLT-022 — Two Selectable `cloth-par` Models

- The `cloth-par` model catalog family must expose exactly two entries: PromptPAR (`openpar-pa100k`) and OpenPAR (`openpar-resnet50-pa100k`)
- Both must share the same 26-attribute PA100k output schema so downstream consumers (Socket.IO `detections`, Admin Dashboard) need no per-model branching
- Only one may be the active model for the family at any time (enforced by the existing per-family active-model invariant — see SRS_AI_Model_Catalog.md)

### FR-CLT-023 — Admin Selection UI

- The Admin Dashboard AI Models tab must list both `cloth-par` entries under a single series ("Cloth Attribute (PAR)") with independent **Activate** actions
- An entry must only be activatable when its `.onnx` file exists in `server/models/`
- The entry with `manualOnly: true` (OpenPAR) must show a manual-export link instead of a Download button when its file is absent

### FR-CLT-024 — PromptPAR Pre-Activation Memory Check

- Before loading PromptPAR — at server startup (if the file already exists) and on every runtime hot-swap request — the system must check free system RAM against a minimum floor (default 2048MB, overridable via `PROMPTPAR_MIN_FREE_MEM_MB`)
- OpenPAR must never be subject to this check
- The check must run before any ONNX Runtime session is created for PromptPAR

### FR-CLT-025 — Logging on Gate Failure

- When the memory check fails, the system must emit a log entry that (a) identifies PromptPAR by name, (b) states the reason is insufficient memory, (c) reports the free and required MB values, and (d) states that Cloth Analysis is being disabled
- The reference log format is: `[ColorClothService] PromptPAR 수행 불가능: 가용 메모리 부족 (free=<N>MB < required=<M>MB) — Cloth 분석을 비활성화합니다.`

### FR-CLT-026 — Automatic Cloth Analysis Disable on Gate Failure

- When the memory gate fails, the system must set the `cloth` analytics config flag to `false` (via the existing `/api/analytics/config` persistence layer) so the pipeline stops expecting cloth output
- This must happen automatically, without operator action, immediately when the gate failure is detected

### FR-CLT-027 — Gate Failure Does Not Crash the Server

- At startup, a memory gate failure must result in `_parReady` remaining `false` and the server continuing to start normally — no exception may propagate out of `ColorClothService.load()`
- On a runtime hot-swap request, a memory gate failure must result in the switch API responding with an HTTP error (surfaced to the Admin Dashboard) rather than crashing the server process or leaving the service in a partially-initialized state

### FR-CLT-028 — No Automatic Fallback Between Models

- The system must not automatically switch to OpenPAR when PromptPAR's memory gate fails, nor automatically retry PromptPAR later — model selection remains an explicit operator action via the Admin Dashboard

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for AI Cloth Analysis |
| 1.1 | 2026-07-12 | LTS Engineering Team | Added §12 (FR-CLT-022~028) — dual PromptPAR/OpenPAR model selection and the PromptPAR pre-activation memory gate (auto-disable Cloth analysis + logging on failure); flagged §3-§10 as describing the superseded 12-attribute placeholder design, see Design_AI_Cloth_Analysis.md v2.0 for the current schema |
