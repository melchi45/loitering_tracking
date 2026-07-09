# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module — Color Analysis

| | |
|---|---|
| **Document ID** | SRS-LTS-AI-06-CLR |
| **Version** | 1.4 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_AI_Color_Analysis.md |
| **Parent RFP** | rfp/RFP_AI_Color_Analysis.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Color Extraction](#3-functional-requirements--color-extraction)
4. [Functional Requirements — ROI Computation](#4-functional-requirements--roi-computation)
5. [Functional Requirements — Zone Gating](#5-functional-requirements--zone-gating)
6. [Functional Requirements — Error Handling](#6-functional-requirements--error-handling)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [Data Requirements](#8-data-requirements)
9. [Interface Requirements](#9-interface-requirements)
10. [Constraints & Assumptions](#10-constraints--assumptions)
11. [Functional Requirements — Phase-3 Human Parsing (Proposed)](#11-functional-requirements--phase-3-human-parsing-proposed)
12. [Functional Requirements — Phase-1.5 K-Means Dominant Color (Proposed)](#12-functional-requirements--phase-15-k-means-dominant-color-proposed)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the AI Color Analysis Module (AI-06-CLR) of LTS-2026. Each requirement is identified by a unique ID (FR-CLR-NNN) and is directly traceable to test cases in TC_AI_Color_Analysis.md.

### 1.2 Scope

This document covers:
- HSV-based dominant color classification for upper and lower body regions of detected persons
- Body ROI extraction parameters (upper torso and lower torso coordinates)
- Zone-level gating via `targetClass: 'color'`
- Error handling for degenerate bounding boxes and image extraction failures
- Socket.IO event output schema carrying color attributes

Out of scope: ML model-based color analysis (covered by Cloth Analysis SRS), pattern detection (striped/plaid), multi-color support beyond primary dominant color per region.

### 1.3 Definitions

| Term | Definition |
|---|---|
| ROI | Region of Interest — a rectangular sub-region of the full camera frame |
| Upper ROI | Portion of person bounding box covering the upper torso (25%–55% of bbox height, inner 70% width) |
| Lower ROI | Portion of person bounding box covering the lower torso (55%–90% of bbox height, inner 70% width) |
| HSV | Hue-Saturation-Value color space used for color name classification |
| Achromatic | Colors with saturation < 15%: classified as black, white, or gray by brightness |
| Chromatic | Colors with saturation ≥ 15%: classified by hue angle into 8 named colors |
| avgColor | Internal function that extracts an 8×8 pixel average of a ROI using sharp |
| fastColor | Public method of ColorClothService that returns upper/lower color and RGB values |
| targetClass | Zone configuration field that enables a specific AI analysis pipeline |

---

## 2. System Overview

### 2.1 Component Dependencies

```
RTSP Frame (JPEG Buffer)
  └─ PipelineManager._processFrame()
       └─ ColorClothService.fastColor()         [AI-06-CLR: Phase-1 only]
            ├─ avgColor(upperRoi)               — sharp extract + 8×8 resize
            ├─ avgColor(lowerRoi)               — sharp extract + 8×8 resize
            ├─ rgbToColorName(upperRgb)         — HSV classification
            └─ rgbToColorName(lowerRgb)         — HSV classification
                 └─ detections[].personAttrs.color  → Socket.IO 'detections' event
```

### 2.2 Activation Condition

Color extraction is activated only when the current zone has `targetClass: 'color'` in its configuration. The `pipelineManager` reads zone configuration before each frame and gates the `fastColor()` call accordingly.

### 2.3 Phase Availability

- Phase-1 (current): HSV pixel-average method — always available, no model required
- Phase-2 (planned): PAR ONNX model color output — covered in SRS-LTS-AI-07-CLT
- Phase-3 (proposed, 2026-07-09): Human Parsing model (SCHP LIP-20 / SegFormer clothes) for pixel-mask-based dominant color extraction — see §11

---

## 3. Functional Requirements — Color Extraction

### FR-CLR-001 — HSV-Based Color Classification

- `rgbToColorName(r, g, b)` must accept three integer values in the range [0, 255]
- The function must convert RGB to HSV and classify the result into exactly one of 11 color names
- Valid output values: `'black'`, `'white'`, `'gray'`, `'red'`, `'orange'`, `'yellow'`, `'green'`, `'cyan'`, `'blue'`, `'purple'`, `'brown'`
- No other string values may be returned

### FR-CLR-002 — Achromatic Classification (Saturation < 15%)

- When HSV saturation `s < 0.15`, the color must be classified as achromatic
- Achromatic sub-classification by brightness `v`:
  - `v < 0.25` → `'black'`
  - `v > 0.80` → `'white'`
  - otherwise → `'gray'`
- Achromatic check takes priority over all hue-based rules

### FR-CLR-003 — Chromatic Hue Classification

- When `s ≥ 0.15`, hue angle `h` (0–360°) must be computed from the RGB-to-HSV formula
- Hue must be normalized to [0, 360) by adding 360 when negative
- Hue classification thresholds:
  - `h < 15` or `h ≥ 345` → `'red'`
  - `15 ≤ h < 50` → `'orange'`
  - `50 ≤ h < 75` → `'yellow'`
  - `75 ≤ h < 150` → `'green'`
  - `150 ≤ h < 195` → `'cyan'`
  - `195 ≤ h < 260` → `'blue'`
  - `260 ≤ h < 320` → `'purple'`
  - `320 ≤ h < 345` → `'red'`

### FR-CLR-004 — Brown Exception

- When `h ≥ 10` and `h < 50` and `v < 0.55`, the color must be classified as `'brown'`
- The brown exception is evaluated before the general hue-based chromatic rules
- Brown represents dark orange tones in low-brightness conditions

### FR-CLR-005 — Upper Body Color Extraction

- `fastColor(jpegBuffer, personBbox, imgW, imgH)` must extract the dominant color for the upper torso region
- The upper ROI must be computed as:
  - x offset: `personBbox.x + personBbox.width * 0.15`
  - y offset: `personBbox.y + personBbox.height * 0.25`
  - width: `personBbox.width * 0.70`
  - height: `personBbox.height * 0.30`
- The extracted average RGB must be passed to `rgbToColorName()` to produce the `upper` color string

### FR-CLR-006 — Lower Body Color Extraction

- `fastColor()` must extract the dominant color for the lower torso region
- The lower ROI must be computed as:
  - x offset: `personBbox.x + personBbox.width * 0.15`
  - y offset: `personBbox.y + personBbox.height * 0.55`
  - width: `personBbox.width * 0.70`
  - height: `personBbox.height * 0.35`
- The extracted average RGB must be passed to `rgbToColorName()` to produce the `lower` color string

### FR-CLR-007 — Parallel ROI Extraction

- `fastColor()` must extract upper and lower ROI colors concurrently using `Promise.all()`
- Sequential extraction is not permitted (performance requirement)

### FR-CLR-008 — 8×8 Pixel Average

- The `avgColor()` function must resize each ROI to 8×8 pixels using `sharp` with `fit: 'fill'`
- The 64 RGB pixel values must be averaged to produce a single [R, G, B] triple
- Each channel average must be rounded to the nearest integer

### FR-CLR-009 — fastColor Return Schema

- `fastColor()` must return a plain object with exactly these four fields:
  - `upper`: string — color name for upper torso
  - `lower`: string — color name for lower torso
  - `upperRgb`: number[3] — average RGB triple for upper ROI
  - `lowerRgb`: number[3] — average RGB triple for lower ROI
- Both `upper` and `lower` must be one of the 11 valid color names (FR-CLR-001)

### FR-CLR-010 — Always Available (No Model Required)

- Color extraction must be available immediately on server startup without loading any ONNX model
- `ColorClothService._colorReady` must be `true` after construction, before `load()` is called
- Color extraction must not block or fail due to PAR model availability

---

## 4. Functional Requirements — ROI Computation

### FR-CLR-011 — ROI Coordinate Clamping

- `avgColor()` must clamp the left edge to `Math.max(0, Math.round(x))`
- `avgColor()` must clamp the top edge to `Math.max(0, Math.round(y))`
- When `imgW` is provided, the right edge must be clamped to `Math.min(imgW, Math.round(x + w))`
- When `imgH` is provided, the bottom edge must be clamped to `Math.min(imgH, Math.round(y + h))`
- Effective width must be `Math.max(1, right - left)` to prevent zero-width extraction
- Effective height must be `Math.max(1, bottom - top)` to prevent zero-height extraction

### FR-CLR-012 — Alpha Channel Removal

- `avgColor()` must call `sharp(...).removeAlpha()` before converting to raw pixel buffer
- The resulting buffer must contain exactly 3 bytes per pixel (RGB, no alpha)

### FR-CLR-013 — Frame Dimension Parameters

- `fastColor(jpegBuffer, personBbox, imgW, imgH)` must accept optional `imgW` and `imgH` parameters
- When `imgW` and `imgH` are provided, they must be forwarded to `avgColor()` for edge clamping
- When `imgW` or `imgH` are not provided, ROI edge clamping against frame boundaries is skipped

---

## 5. Functional Requirements — Zone Gating

### FR-CLR-014 — Zone targetClass Activation

- Color extraction via `fastColor()` must only be called when the zone configuration for the current camera includes `'color'` in its `targetClasses` array
- `pipelineManager` must check zone configuration before invoking `fastColor()` for each detection

### FR-CLR-015 — Color Output Attachment

- When color extraction is active and succeeds, the result must be attached to the detection as `personAttrs.color`
- The attached object must match the `fastColor()` return schema: `{ upper, lower, upperRgb, lowerRgb }`

### FR-CLR-016 — Color in Socket.IO Detections Event

- The `detections` Socket.IO event payload must include `personAttrs.color` for each detection where color extraction ran
- The event must carry `personAttrs.color.upper` and `personAttrs.color.lower` as string color names
- When zone does not include `'color'`, `personAttrs.color` must be absent or `null`

---

## 6. Functional Requirements — Error Handling

### FR-CLR-017 — Graceful Failure on Extract Error

- If `sharp` throws an exception during ROI extraction, `avgColor()` must catch the error and return `[128, 128, 128]` (neutral gray)
- The error must not propagate to `fastColor()` or the caller
- This fallback ensures the pipeline continues without interruption

### FR-CLR-018 — Zero-Size Bounding Box Handling

- When `personBbox.width` or `personBbox.height` is zero or near zero, the computed ROI dimensions may underflow
- The clamping in FR-CLR-011 (`Math.max(1, ...)`) must prevent a zero-size extract from being submitted to `sharp`
- The resulting color for a degenerate bbox is `'gray'` (from the [128,128,128] fallback)

---

## 7. Non-Functional Requirements

### FR-CLR-019 — Performance: Latency per Person

- End-to-end `fastColor()` execution time must be ≤ 2 ms per person under typical operation
- Target latency for a single person with 1080p source frame is approximately 0.5 ms

### FR-CLR-020 — Concurrency

- Multiple instances of `fastColor()` may execute concurrently across different persons in the same frame without data corruption
- No shared mutable state is used between concurrent calls (all parameters are call-local)

### FR-CLR-021 — Memory

- The 8×8 raw pixel buffer (192 bytes per ROI) must be garbage-collected after each `avgColor()` call
- No ROI pixel data is retained in service state between frames

---

## 8. Data Requirements

### 8.1 Input: Person Bounding Box

```json
{
  "x":      "number — left edge in pixels",
  "y":      "number — top edge in pixels",
  "width":  "number — bbox width in pixels",
  "height": "number — bbox height in pixels"
}
```

### 8.2 Output: Color Attribute Object

```typescript
interface ColorAttribute {
  upper:    string;    // one of 11 color names
  lower:    string;    // one of 11 color names
  upperRgb: [number, number, number];   // avg RGB for upper ROI
  lowerRgb: [number, number, number];   // avg RGB for lower ROI
}
```

### 8.3 Valid Color Names

```
black | white | gray | red | orange | yellow | green | cyan | blue | purple | brown
```

### 8.4 HSV Classification Table

| Condition | Output |
|---|---|
| s < 0.15 AND v < 0.25 | black |
| s < 0.15 AND v > 0.80 | white |
| s < 0.15 AND 0.25 ≤ v ≤ 0.80 | gray |
| s ≥ 0.15 AND h∈[10,50) AND v < 0.55 | brown |
| s ≥ 0.15 AND (h < 15 OR h ≥ 345) | red |
| s ≥ 0.15 AND h∈[15,50) | orange |
| s ≥ 0.15 AND h∈[50,75) | yellow |
| s ≥ 0.15 AND h∈[75,150) | green |
| s ≥ 0.15 AND h∈[150,195) | cyan |
| s ≥ 0.15 AND h∈[195,260) | blue |
| s ≥ 0.15 AND h∈[260,320) | purple |
| s ≥ 0.15 AND h∈[320,345) | red |

---

## 9. Interface Requirements

### 9.1 Internal API

| Method | Signature | Returns | Notes |
|---|---|---|---|
| `rgbToColorName` | `(r, g, b) → string` | Color name string | Pure function, synchronous |
| `avgColor` | `(jpegBuffer, roi, imgW, imgH) → Promise<number[3]>` | RGB triple | Fallback [128,128,128] on error |
| `fastColor` | `(jpegBuffer, personBbox, imgW?, imgH?) → Promise<ColorAttribute>` | Color attribute object | Calls avgColor twice in parallel |

### 9.2 Socket.IO Event

| Event | Direction | Payload Field | Description |
|---|---|---|---|
| `detections` | Server → Client | `detections[].personAttrs.color` | Color attribute object per person |
| `detections` | Server → Client | `detections[].personAttrs.color.upper` | Upper body color name |
| `detections` | Server → Client | `detections[].personAttrs.color.lower` | Lower body color name |

### 9.3 REST API

No dedicated REST endpoints for color analysis. Color data flows exclusively through the Socket.IO `detections` event.

---

## 10. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Color extraction operates on Phase-1 HSV algorithm only; ML model color is Phase-2 (SRS-LTS-AI-07-CLT) |
| C-02 | Input frame must be a valid JPEG buffer decodable by `sharp` |
| C-03 | Person bounding box coordinates are in pixel units relative to the full frame |
| C-04 | The 11-color taxonomy is fixed; adding or removing colors requires code change |
| C-05 | Color accuracy may degrade under extreme illumination conditions (very dark/overexposed frames) |
| C-06 | Color extraction classifies the dominant single color per region — no multi-color or pattern support in Phase-1 |
| C-07 | `sharp` library must be installed in the server runtime environment |
| C-08 | Phase-3 Human Parsing (§11) is a proposed enhancement, not yet implemented; FR-CLR-001 through FR-CLR-021 above describe Phase-1 behavior only |
| C-09 | Phase-1.5 K-Means reduction (§12) is a proposed enhancement, not yet implemented; until implemented, FR-CLR-008 (8×8 plain mean) describes actual behavior |

---

## 11. Functional Requirements — Phase-3 Human Parsing

> **Status: Implemented, opt-in** (2026-07-09 proposed → 2026-07-09 code implemented). This section records requirements derived from gap analysis against the CCTV/IPTV 상의하의 색상분류 guide (now-consolidated, original deleted 2026-07-09) and `docs/rfp/ReID_및_색상분석_활용가이드.md` (2026-07-09). All 6 FRs below are implemented in code but disabled by default (`humanParsing:false`) with no behavioral test coverage; see `docs/design/Design_AI_Color_Analysis.md` §10 for the corresponding architecture.

### FR-CLR-022 — Human Parsing Global Toggle — ✅ Done

- A boolean `humanParsing` key must be added to `analyticsConfig.js`'s `DEFAULT_CONFIG`, defaulting to `false`
- When `humanParsing` is disabled or its model is not loaded, color extraction must silently fall back to Phase-1 behavior (FR-CLR-005/006)

### FR-CLR-023 — Model Catalog Registration (Substitutable Models) — ✅ Done

- Human Parsing models (SCHP LIP-20, SegFormer clothes) must be registered in a model catalog with the same download + activate UX as the existing YOLO detector catalog (`GET/POST /api/analysis/models`)
- Each catalog entry must carry a `classMap` field mapping the model's own class indices to the semantic roles `upper` and `lower`, so that switching the active model does not require code changes
- Only one Human Parsing model may be active at a time per analysis server instance
- **Implementation**: `analysisApi.js`'s `EXTENDED_CATALOG` (`family: 'human-parsing'`, `schp-lip20`/`segformer-clothes` entries); `/models/switch` calls `colorClothService.js#reloadHumanParsing(filePath, classMap, inputSize)`

### FR-CLR-024 — Per-Track Throttled Execution — ✅ Done

- Human Parsing inference must not run on every frame; it must run at most once per tracked person (`objectId`) per a fixed interval (default 4000 ms)
- Between runs, the previously computed color result for that `objectId` must be reused from a cache
- The cache entry for a given `objectId` must be removed when the corresponding track is dropped by the tracker (lifecycle hook, not a fixed-size/LRU eviction)
- **Implementation**: `HP_INTERVAL_MS = 4000`, `_parseCache` Map, `dropTrack(objectId)` called from `pipelineManager.js` at both track-finalization sites

### FR-CLR-025 — Mask-Based Dominant Color Extraction — ✅ Done

- When the Human Parsing model is active and ready, color extraction must classify each pixel of the person crop into the model's class set, then select pixels belonging to `upper`-mapped classes and `lower`-mapped classes per FR-CLR-023's `classMap`
- A K-Means (or equivalent dominant-color) algorithm must compute the representative RGB for each pixel set
- If a region's pixel count is below a minimum threshold (default 20), that region must fall back to the Phase-1 fixed-fraction ROI average (FR-CLR-005/006) instead of returning an unreliable color
- **Implementation**: `_runHumanParsing()` argmaxes per-pixel class logits, feeds masked pixels to `kmeansColor.js#dominantColor()` (unit-tested), `HP_MIN_MASK_PIXELS = 20` fallback threshold confirmed

### FR-CLR-026 — Output Schema Extension — ✅ Done

- When Phase-3 produces a color result, the output object (FR-CLR-009 schema) must include an additional `source` field with value `'human-parsing'`; Phase-1-derived output must omit this field or set it to `'legacy'`

### FR-CLR-027 — Licensing Constraint — ✅ Done

- Any Human Parsing model added to the catalog must have its license terms recorded in the catalog entry metadata
- This project is not a commercial deployment; models with non-commercial-only license terms (e.g. NVIDIA SegFormer NC-inherited checkpoints) are permitted for this project but the catalog entry must flag the restriction so the field is preserved if the project's deployment model changes
- **Implementation**: `EXTENDED_CATALOG` entries carry `license: 'MIT'` (SCHP) and `license: 'NVIDIA SegFormer NC (non-commercial...)'` (SegFormer); `downloadModels.js` DIRECT_MODELS entries default `enabled:false` pending manual license verification

---

## 12. Functional Requirements — Phase-1.5 K-Means Dominant Color (Proposed)

> **Status: Proposed, not yet implemented.** Closes the remaining gap against the CCTV/IPTV 상의하의 색상분류 guide's (now-consolidated, original deleted 2026-07-09) §4 (the guide's no-model "fixed split + K-Means" tier), distinct from §11's Phase-3 (which requires a Human Parsing model). See `docs/design/Design_AI_Color_Analysis.md` §11 for the corresponding architecture.

### FR-CLR-028 — K-Means Reduction Replaces Plain Mean (Always-On, No Toggle)

- The pixel-reduction step used by the always-on Phase-1 `color` path must use a K-Means/dominant-color algorithm (`kmeansColor.dominantColor()`) instead of a plain channel-wise mean, applied to the same fixed upper/lower ROI rectangles defined by FR-CLR-005/FR-CLR-006 (ROI geometry is unchanged)
- This requirement does not introduce a new `analyticsConfig` toggle — it changes the internal implementation of the existing always-on `color` targetClass, not its activation condition (FR-CLR-014 is unaffected)
- The external return schema (FR-CLR-009: `{upper, lower, upperRgb, lowerRgb}`) must remain unchanged

### FR-CLR-029 — Fallback on Degenerate Pixel Count

- If the K-Means input for a region yields fewer than the minimum pixel count accepted by `dominantColor()` (same 20-pixel floor used in FR-CLR-025 for Phase-3), that region must fall back to the plain-mean result rather than an unreliable/null color
- This mirrors the Phase-3 fallback behavior (FR-CLR-025) so both proposed enhancements degrade the same way under a degenerate ROI

---

## 13. Cross-Reference — Alert Attribute Enrichment (Proposed, out of this doc's scope)

> **Final consistency check before deleting `docs/rfp/ReID_및_색상분석_활용가이드.md`.** This guide's §3 ("이벤트 설명/Event Metadata") asks for the color this document already computes (§3–§9 of this SRS) to be attached to loitering/intrusion **alert** records, not just detection snapshots. That requirement belongs to the alert/behavior layer, not the color-computation layer this document specifies, so it is not defined here as a new FR-CLR — it is tracked as **FR-CCFR-067** in `docs/srs/SRS_CrossCamera_Face_Tracking.md` §14 (📝 Proposed, not implemented), with design detail in `docs/design/Design_AI_AppearanceReID.md` §12.7 and roadmap entry `docs/mrd/MRD_LTS2026.md` §6.4 Phase 12b-5. This document's own color output schema (FR-CLR-009) is unaffected — the gap is that `alertService.js` doesn't yet read it.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for AI Color Analysis |
| 1.1 | 2026-07-09 | Youngho Kim | Added §11 Phase-3 Human Parsing proposed requirements (FR-CLR-022~027), C-08 constraint, §2.3 phase note — gap analysis vs CCTV_IPTV_상의하의_색상분류_가이드.md / ReID_및_색상분석_활용가이드.md |
| 1.2 | 2026-07-09 | Youngho Kim | Added §12 Phase-1.5 proposed requirements (FR-CLR-028~029) — K-Means dominant color on the existing fixed ROI, no model required; closes the guide's tier-4 gap ahead of source guide deletion |
| 1.3 | 2026-07-09 | Youngho Kim | Source guide `docs/rfp/CCTV_IPTV_상의하의_색상분류_가이드.md` deleted — full content confirmed reflected in §11–12, in-doc citations updated to archival notes |
| 1.4 | 2026-07-09 | Youngho Kim | Code sync — §11 all FR-CLR-022~027 flipped Proposed→Implemented (opt-in, no behavioral test coverage yet); §12 Phase-1.5 (FR-CLR-028~029) confirmed still unimplemented, not touched |
| 1.5 | 2026-07-09 | Youngho Kim | Added §13 — cross-reference to FR-CCFR-067 (Alert Attribute Enrichment, Proposed) closing `ReID_및_색상분석_활용가이드.md` §3; source guide deleted |
