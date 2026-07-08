# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Face Match → Detections Timeline Navigation

| | |
|---|---|
| **Document ID** | PRD-LTS-FMN-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Related RFP** | RFP_Face_Match_Timeline_Navigation.md (LTS-2026-FMN-01) |

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

A face match is not an isolated fact — it happened on a specific camera at a specific moment, alongside whatever else that camera was detecting. The Face ID tab and the Fullscreen Detections timeline should feel like one continuous investigation surface, not two separate screens the operator has to manually reconcile.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Clicking a Live Match row opens that camera's Fullscreen view directly on the Detections tab.
- The timeline is pre-centered on the clicked match's timestamp with no manual range adjustment.
- The matched face's detail popover (thumbnail, identity, score) appears automatically.
- The Face ID tab's Live Matches list scrolls cleanly within its available space at any sidebar height.

### 2.2 Non-Goals

- URL-based deep linking to a specific match.
- Any change to the underlying `faceMatchHistory` data model or the `match-history` endpoint.

---

## 3. User Personas

**Security Operator** — sees a match come in live, clicks it, and immediately gets full camera context without re-navigating.

**Investigator** — reviews historical matches days later; clicking one from the Face ID tab's fetched history jumps straight to that moment in the camera's timeline.

---

## 4. Functional Specification

### 4.1 Click-to-Navigate Flow

```
MatchLog row click (FaceGalleryTab.tsx)
  → onFocusMatch(cameraId, faceId, timestamp)   [new optional prop]
  → App.tsx: setFullscreenCameraId(cameraId) + setFocusMatch({ faceId, timestamp })
  → FullscreenCameraView mounts with initialVideoTab="detections", initialFocusMatch={{faceId,timestamp}}
  → DetectionsTimelineInline: range→'custom', customApplied→[timestamp-30min, timestamp+30min]
  → once fetched matches include {faceId,timestamp} → setSelectedMatch(match) → popover appears
```

### 4.2 Scrollbar Fix

`FaceGalleryTab.tsx`'s selected-gallery content wrapper switches from a single outer `overflow-y-auto` region to a `flex flex-col` layout where the enrolled-faces grid and the Live Matches list (`MatchLog`) each own their own bounded scroll region (`flex-1 min-h-0` instead of a fixed `max-h-48`), so the two never compete for the same scrollbar.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| New props | `FullscreenCameraView.initialVideoTab?`, `FullscreenCameraView.initialFocusMatch?`, `DetectionsTimelineInline.initialFocusMatch?`, `FaceGalleryTab.onFocusMatch?` — all optional, all backward compatible |
| Match identity | `{ faceId: string; timestamp: number }` — matches the existing marker key shape in `DetectionsTimelineInline.tsx` |
| Time window | ±30 minutes around the target timestamp, applied via the existing `customApplied`/`customStart`/`customEnd` custom-range state |
| No new store | Plain callback-prop threading through `App.tsx`'s existing `renderTabContent()` |

---

## 6. Input / Output Contract

**New prop shapes (TypeScript):**
```ts
// FaceGalleryTab.tsx
interface FaceGalleryTabProps {
  onFocusMatch?: (cameraId: string, faceId: string, timestamp: number) => void;
}

// FullscreenCameraView.tsx
interface Props {
  cameraId: string;
  cameraName: string;
  onClose: () => void;
  initialVideoTab?: 'events' | 'onvif' | 'detections';
  initialFocusMatch?: { faceId: string; timestamp: number };
}

// DetectionsTimelineInline.tsx
{ cameraId: string; initialFocusMatch?: { faceId: string; timestamp: number } }
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Click navigates to correct camera | Fullscreen view opens for the exact camera the clicked match belongs to |
| AC-02 | Opens on Detections tab | `videoTab` is `'detections'` immediately on mount, not the default `'onvif'` |
| AC-03 | Timeline centered on match | The clicked match's marker is visible in the initial view without manual pan/zoom |
| AC-04 | Detail auto-revealed | The match's popover (thumbnail/identity/score) is visible without an additional click |
| AC-05 | Normal open unaffected | Double-clicking a camera tile (no `initialFocusMatch`) still opens on `'onvif'` as before |
| AC-06 | Scrollbar fit | Live Matches list scrolls independently of the enrolled-faces grid; no double/competing scrollbar at reduced sidebar heights |
| AC-07 | No regression | Manual range picking and manual marker-click in `DetectionsTimelineInline.tsx` still work unchanged |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Status |
|---|---|---|
| M1 | Click-to-navigate prop plumbing (App → FaceGalleryTab → FullscreenCameraView → DetectionsTimelineInline) | ⏳ In progress |
| M2 | Face ID tab scrollbar layout fix | ⏳ In progress |
| M3 | `test/api/face_match_timeline_navigation.test.js` + SUITES registration | ⏳ In progress |

### 8.2 TODO

- [ ] `App.tsx` — `focusMatch` state + `renderTabContent()`/`FullscreenCameraView` mount wiring
- [ ] `FaceGalleryTab.tsx` — `onFocusMatch` prop, `MatchLog` click handler, scrollbar layout fix
- [ ] `FullscreenCameraView.tsx` — `initialVideoTab`/`initialFocusMatch` props
- [ ] `DetectionsTimelineInline.tsx` — `initialFocusMatch` prop + two effects
- [ ] `test/api/face_match_timeline_navigation.test.js`

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — PRD for Face Match Timeline Navigation |
