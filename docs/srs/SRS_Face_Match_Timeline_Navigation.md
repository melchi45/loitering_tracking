# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Face Match → Detections Timeline Navigation

| | |
|---|---|
| **Document ID** | SRS-LTS-FMN-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Parent PRD** | prd/PRD_Face_Match_Timeline_Navigation.md |
| **Parent RFP** | rfp/RFP_Face_Match_Timeline_Navigation.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Navigation](#3-functional-requirements--navigation)
4. [Functional Requirements — Scrollbar Fix](#4-functional-requirements--scrollbar-fix)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Data Requirements](#6-data-requirements)
7. [Constraints & Assumptions](#7-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

Defines verifiable functional requirements (`FR-FMN-NNN`) for navigating from a Face ID tab Live Match entry to that camera's Fullscreen Detections timeline, centered and highlighted on that match, plus a scrollbar layout fix in the same tab.

### 1.2 Scope

Client-only: `App.tsx`, `FaceGalleryTab.tsx`, `FullscreenCameraView.tsx`, `DetectionsTimelineInline.tsx`. No server-side change.

---

## 2. System Overview

```
FaceGalleryTab.tsx MatchLog row click
  → App.tsx: fullscreenCameraId + focusMatch state
  → FullscreenCameraView.tsx: initialVideoTab, initialFocusMatch props
  → DetectionsTimelineInline.tsx: range/customApplied effect, matches-match effect → selectedMatch
```

---

## 3. Functional Requirements — Navigation

### FR-FMN-001 — Match Row Click Handler

- Each `MatchLog` row (`FaceGalleryTab.tsx`) gains an `onClick` that, if the `onFocusMatch` prop is provided, calls `onFocusMatch(ev.cameraId, ev.faceId, ev.timestamp)`.
- Rows remain visually unchanged when `onFocusMatch` is not supplied (no prop is required for `FaceGalleryTab` to keep working standalone).

### FR-FMN-002 — App-Level State

- `App.tsx` adds `focusMatch: { faceId: string; timestamp: number } | null` state, set together with `fullscreenCameraId` when `onFocusMatch` fires, and cleared (`null`) whenever `fullscreenCameraId` is cleared (the existing `onClose` handler).

### FR-FMN-003 — Fullscreen Initial Tab

- `FullscreenCameraView` accepts an optional `initialVideoTab` prop, used only as the `videoTab` `useState` initializer (`useState(initialVideoTab ?? 'onvif')`) — it has no effect after mount (does not force-switch an already-open view).
- When opened via a Live Match click, `initialVideoTab` is always `'detections'`.

### FR-FMN-004 — Timeline Range Centering

- `DetectionsTimelineInline` accepts an optional `initialFocusMatch: { faceId, timestamp }` prop.
- On receiving a non-null `initialFocusMatch` (checked once, on mount / first prop value), the component sets `range` to `'custom'` and `customApplied` (plus the `customStart`/`customEnd` `datetime-local`-formatted display state) to `[timestamp - 30min, timestamp + 30min]`.
- This reuses the existing custom-range fetch path unchanged — both the `detection-tracks` and `match-history` fetches key off `range`/`customApplied` already.

### FR-FMN-005 — Auto-Select Matched Entry

- Once the `matches` state (populated by the existing fetch, now scoped to the centered window) contains an entry whose `faceId` and `timestamp` both equal `initialFocusMatch`'s, `setSelectedMatch(entry)` is called automatically.
- This reuses the existing popover UI built for manual marker clicks — no new detail-rendering code.

### FR-FMN-006 — No Regression to Manual Flows

- Opening a camera via double-click (no `initialFocusMatch`) continues to default to `videoTab='onvif'` and `range='1H'` exactly as before.
- Manually clicking a face-match marker continues to set `selectedMatch` exactly as before, independent of whether `initialFocusMatch` was ever provided.

---

## 4. Functional Requirements — Scrollbar Fix

### FR-FMN-010 — Independent Scroll Regions

- `FaceGalleryTab.tsx`'s selected-gallery content wrapper (previously a single `flex-1 overflow-y-auto` region) becomes a `flex flex-col min-h-0` container.
- The enrolled-faces grid keeps its own `overflow-y-auto` region.
- `MatchLog`'s previously fixed `max-h-48` becomes `flex-1 min-h-0 overflow-y-auto`, so it takes exactly the space left over after the enrolled-faces grid and header, never more, never producing a second scrollbar for the same visual region.

---

## 5. Non-Functional Requirements

### FR-FMN-020 — No New Network Calls

- Centering the timeline reuses the exact fetch calls `DetectionsTimelineInline` already makes for a custom range — no new endpoint, no additional request beyond what a manual custom-range selection would already trigger.

---

## 6. Data Requirements

### 6.1 Match Identity (join key)

```typescript
{ faceId: string; timestamp: number }
```
Identical in shape and meaning to the key already used for React list rendering in `DetectionsTimelineInline.tsx` (`` `${m.faceId}-${m.timestamp}` ``) and sufficient to uniquely identify a match given the existing 30-second cooldown per `faceId:galleryFaceId` pair (`SRS_AI_Face_Recognition.md` FR-FAC-021).

---

## 7. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | The ±30-minute centering window is a fixed constant, not currently configurable |
| C-02 | If the clicked match somehow falls outside what `GET /api/galleries/match-history` returns for that window (e.g. an unexpected clock skew), the timeline still opens correctly centered — only the auto-popover (FR-FMN-005) would not fire; this is a graceful degradation, not a failure |
| C-03 | This feature assumes `faceId`+`timestamp` is practically unique per camera within the ±30-minute window — consistent with the 30-second cooldown already enforced upstream |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — SRS for Face Match Timeline Navigation |
