# REQUEST FOR PROPOSAL (RFP)
# Face Match → Detections Timeline Navigation

| | |
|---|---|
| **RFP Reference** | LTS-2026-FMN-01 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-07-08 |
| **Proposal Deadline** | 2026-07-08 |
| **Zone Target Key** | `face` (reuses the existing Face Recognition zone target — no new one) |
| **Status** | **Active — in implementation** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Architecture](#4-architecture)
5. [Integration Requirements](#5-integration-requirements)
6. [Evaluation Criteria](#6-evaluation-criteria)
7. [Appendix](#7-appendix)

---

## 1. Overview

### 1.1 Purpose

Connect two already-existing views built in [RFP_Face_Match_History.md](RFP_Face_Match_History.md) — the Face ID tab's persisted Live Matches list and the Fullscreen Detections timeline's face-match marker row — so clicking one navigates to and highlights the other. Also fixes a scrollbar-fit defect in the Live Matches list surfaced while working in the same component.

### 1.2 Scope

- Client-side navigation: a click handler in the Face ID tab, new optional props threading through `App.tsx` → `FullscreenCameraView.tsx` → `DetectionsTimelineInline.tsx`.
- Client-side layout: flex-based scroll region fix in `FaceGalleryTab.tsx`.

### 1.3 Explicit Non-Goal

No server/API changes — this feature is entirely a client-side navigation and layout fix built on the existing `GET /api/galleries/match-history` contract.

---

## 2. Use Cases

| Use Case | Description | Status |
|---|---|---|
| Click a Live Match | Fullscreen view opens for that match's camera, on the Detections tab, timeline centered on the match | New |
| Review Face ID tab on a short sidebar | Live Matches list scrolls independently without a competing outer scrollbar | New |

---

## 3. Technical Requirements

| Requirement | Specification |
|---|---|
| Navigation trigger | Click on a `MatchLog` row in `FaceGalleryTab.tsx` |
| Match identity | `{ faceId, timestamp }` pair — the same tuple already used as the React `key` for face-match markers in `DetectionsTimelineInline.tsx` |
| Fullscreen initial tab | New `initialVideoTab` prop on `FullscreenCameraView`, consumed as the `videoTab` state's initializer |
| Timeline centering | New `initialFocusMatch` prop on `DetectionsTimelineInline`, applied via the existing custom-range (`customApplied`) mechanism — ±30 minutes around the match timestamp |
| Auto-detail reveal | Once the focused match is found in the fetched range, `selectedMatch` is set programmatically, reusing the popover already built for manual clicks |

---

## 4. Architecture

```
FaceGalleryTab.tsx (MatchLog row click)
  │ onSelect(cameraId, faceId, timestamp)
  ▼
App.tsx
  │ setFullscreenCameraId(cameraId)
  │ setFocusMatch({ faceId, timestamp })
  ▼
<FullscreenCameraView cameraId=... initialVideoTab="detections" initialFocusMatch={{faceId,timestamp}} />
  │ videoTab initializes to "detections" instead of the default "onvif"
  ▼
<DetectionsTimelineInline cameraId=... initialFocusMatch={{faceId,timestamp}} />
  │ effect 1: range='custom', customApplied = [timestamp-30min, timestamp+30min]
  │ effect 2: once matches (fetched for that range) contains {faceId,timestamp} → setSelectedMatch(match)
  ▼
Existing popover (thumbnail, identity, score, time) renders automatically
```

---

## 5. Integration Requirements

| Requirement | Detail |
|---|---|
| No new Zustand store | `renderTabContent()` in `App.tsx` already closes over `setFullscreenCameraId` and is the sole render site for `<FaceGalleryTab />` — plain callback-prop threading, matching the existing `ZonesPanel`/`onOpenCamera` precedent |
| No new REST endpoint | Reuses `GET /api/galleries/match-history`'s existing `from`/`to` filters, and `DetectionsTimelineInline`'s existing custom-range fetch path verbatim |
| Backward compatible | All new props (`initialVideoTab`, `initialFocusMatch`) are optional — normal double-click-to-open-fullscreen behavior is unchanged when absent |

---

## 6. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Navigation correctness | 40% | Correct camera, correct tab, correct time window, correct match highlighted |
| No regression to existing Fullscreen/timeline behavior | 30% | Manual camera open, manual range picking, existing marker click all unaffected |
| Scrollbar fix correctness | 20% | Single, properly-fitted scrollbar per region at any sidebar height |
| Documentation completeness | 10% | MRD/RFP/PRD/SRS/Design/TC set internally consistent |

---

## 7. Appendix

### Appendix A: Related Documents

| Document | Description |
|---|---|
| [RFP_Face_Match_History.md](RFP_Face_Match_History.md) | Defines the Live Matches list and the Detections timeline's face-match marker row this feature connects |
| [Design_ONVIF_Timeline.md](../design/Design_ONVIF_Timeline.md) | Point-marker convention reused by the connected timeline row |

---

> **END OF DOCUMENT — LTS-2026-FMN-01**

---

*CONFIDENTIAL | melchi45/loitering_tracking*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — Face Match → Detections Timeline Navigation |
