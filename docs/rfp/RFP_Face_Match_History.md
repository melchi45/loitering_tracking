# REQUEST FOR PROPOSAL (RFP)
# Face Match History — Persistence, Camera Name, Timeline Integration

| | |
|---|---|
| **RFP Reference** | LTS-2026-FMH-01 |
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
6. [Performance Requirements](#6-performance-requirements)
7. [Evaluation Criteria](#7-evaluation-criteria)
8. [Appendix](#8-appendix)

---

## 1. Overview

### 1.1 Purpose

Three gaps reported together against the existing Face Recognition module ([RFP_AI_Face_Recognition.md](RFP_AI_Face_Recognition.md)):

1. The Face ID tab's Live Matches list is Socket.IO-only and empties on refresh, despite `faceMatchHistory` already being durably written on every match.
2. Match entries show a raw `cameraId`, not the camera's configured name.
3. Face matches don't appear on the per-camera Fullscreen Detections timeline.

### 1.2 Scope

- A read endpoint over the existing `faceMatchHistory` table.
- Threading `cameraName` into the event objects that are already built and persisted on every match.
- A client-side fetch-on-mount for the Face ID tab, and a new marker row in the Detections timeline.

### 1.3 Explicit Non-Goal

No change to the matching pipeline itself (`_assignFaceIds`'s cosine-similarity logic, thresholds, or cooldown) — this is a persistence-visibility fix layered on top of an already-correct matching pipeline.

---

## 2. Use Cases

| Use Case | Description | Status |
|---|---|---|
| Refresh the Face ID tab mid-shift | Live Matches list still shows recent matches | New |
| Identify which camera raised a match | Match entry shows the camera's name | New |
| Review a camera's Fullscreen Detections timeline | Face-match markers appear alongside that camera's other detection tracks, clickable to reveal the matched thumbnail | New |

---

## 3. Technical Requirements

| Requirement | Specification |
|---|---|
| New endpoint | `GET /api/galleries/match-history` — query: `limit` (default 50, max 200), optional `cameraId`, `galleryType`, `from`, `to` |
| `cameraName` field | Added to the `matchEvt`/`matchEvt2` objects built inside `pipelineManager.js`'s `_assignFaceIds()`, flowing automatically into both the `face_match`/`missing_person_match` socket payloads and the `faceMatchHistory` DB row (both already spread the full event object) |
| Face ID tab | Fetch-on-mount seeds `matchLog` from the new endpoint before the live socket listener takes over |
| Detections timeline | New dedicated "Face Matches" row using a diamond point-marker (not a synthetic duration bar), reusing the existing `OnvifTimelineOverlay.tsx` point-event convention |

---

## 4. Architecture

```
Frame processed (combined or streaming mode)
  │
  ▼ pipelineManager._assignFaceIds(cameraId, cameraName, detectedFaces, timestamp)
  │    matchEvt / matchEvt2 now include cameraName
  │
  ├─ io.emit('face_match', evt)              — live, unchanged event name/shape + cameraName
  ├─ io.emit('missing_person_match', evt)     — unchanged, missing-type only
  └─ db.insert('faceMatchHistory', evt)       — unchanged call, now includes cameraName

GET /api/galleries/match-history?cameraId=&limit=&from=&to=
  └─ db.find('faceMatchHistory', {}) → filter → sort desc by timestamp → slice(limit)

FaceGalleryTab.tsx (Face ID tab)
  ├─ on mount: GET match-history?limit=50 → seed matchLog
  └─ socket.on('face_match', ...) → prepend (unchanged)

DetectionsTimelineInline.tsx (Fullscreen → Detections tab)
  ├─ existing: GET /api/analysis/detection-tracks?cameraId=&from=&to=
  └─ new:      GET /api/galleries/match-history?cameraId=&from=&to=
       → dedicated "Face Matches" row, diamond marker per event, click → thumbnail popover
```

---

## 5. Integration Requirements

| Requirement | Detail |
|---|---|
| No new DB table | Reuses `faceMatchHistory` (already in `ALL_TABLES`, already row-capped at 5000) |
| No new Socket.IO event | `cameraName` is an additive field on the existing `face_match`/`missing_person_match` payloads |
| Backward compatibility | Historical rows persisted before this ships lack `cameraName`; the client falls back to a `useCameraStore` lookup, then the raw ID |

---

## 6. Performance Requirements

| Metric | Requirement |
|---|---|
| `GET /api/galleries/match-history` | In-memory filter/sort/slice over a table capped at 5000 rows — no pagination infrastructure needed |
| Detections timeline fetch | Scoped by `cameraId` + visible `from`/`to` range, matching the existing `detection-tracks` fetch's own scoping — bounded by the same viewport, not the full table |

---

## 7. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Correctness of persistence-read round trip | 40% | What's written matches what's read back after refresh |
| Camera name resolution correctness | 25% | Real name shown wherever resolvable, sensible fallback otherwise |
| Timeline integration usability | 25% | Marker position accuracy, thumbnail reachability |
| Documentation completeness | 10% | MRD/RFP/PRD/SRS/Design/ops/TC set internally consistent |

---

## 8. Appendix

### Appendix A: Related Documents

| Document | Description |
|---|---|
| [RFP_AI_Face_Recognition.md](RFP_AI_Face_Recognition.md) | Parent face detection/recognition/gallery feature set — defines `face_match`/`missing_person_match` |
| [RFP_Face_Search_Condition_Sync.md](RFP_Face_Search_Condition_Sync.md) | Prior fix in the same feature area (streaming↔analysis condition sync) |
| [Design_ONVIF_Timeline.md](../design/Design_ONVIF_Timeline.md) | Source of the point-event marker convention reused here |

---

> **END OF DOCUMENT — LTS-2026-FMH-01**

---

*CONFIDENTIAL | melchi45/loitering_tracking*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — face match history persistence, camera name, timeline integration |
