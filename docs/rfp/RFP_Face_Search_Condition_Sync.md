# REQUEST FOR PROPOSAL (RFP)
# Face Search Condition Sync — Streaming ↔ Analysis

| | |
|---|---|
| **RFP Reference** | LTS-2026-FSC-01 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-07-08 |
| **Proposal Deadline** | 2026-07-08 |
| **Zone Target Key** | (none — server-to-server feature, not a zone/targetClasses filter) |
| **Status** | **Active — Shared-DB reconcile fix + Edit/Delete UI shipped 2026-07-15** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Architecture](#4-architecture)
5. [Integration Requirements](#5-integration-requirements)
6. [Privacy & Compliance](#6-privacy--compliance)
7. [Performance Requirements](#7-performance-requirements)
8. [Evaluation Criteria](#8-evaluation-criteria)
9. [Appendix](#9-appendix)

---

## 1. Overview

### 1.1 Purpose

Two related gaps in the `streaming` + `analysis` distributed deployment (see [Design_Server_Architecture.md](../design/Design_Server_Architecture.md) §3.2/§3.3):

1. **Bug**: `POST /api/galleries/:id/faces` (face enrollment) fails with `503 Face service not available — models not loaded` on `SERVER_MODE=streaming` because that mode never loads local ONNX face models.
2. **Feature gap**: the Analysis Server Dashboard has no visibility into how many named-gallery face search conditions are currently in effect, and no way to add one from that dashboard.

### 1.2 Scope

- Delegate the enrollment photo's detect+embed step to the analysis server when the local face service is unavailable.
- Mirror gallery/face condition counts (by type: Missing/VIP/Blocklist/General) onto the analysis server for dashboard display, kept fresh via push-on-change plus a periodic reconcile.
- Add a dashboard drill-down (count → detail list → add condition) on `AnalysisServerDashboard.tsx`.

### 1.3 Explicit Non-Goal

Live per-frame face matching against named galleries is **not** re-implemented on the analysis server — it already works correctly on the streaming server today (traced: the analysis server returns raw embeddings in `detectedFaces`, and the streaming server's own `_assignFaceIds()` matches them against its local `_persistentGallery`, emitting `face_match`/`missing_person_match`). This RFP does not change that path.

---

## 2. Use Cases

| Use Case | Description | Status |
|---|---|---|
| Enroll a VIP/Blocklist/Missing/General face on a streaming server | Photo upload succeeds even though the streaming server has no local face model | New (Fix) |
| Enroll a face directly on the analysis server's own dashboard | Uses the analysis server's already-loaded local model — no delegation needed | New (Feature) |
| View active face search condition count on Analysis Server Dashboard | Count updates within seconds of a streaming-side enrollment | New (Feature) |
| Drill into face search condition detail | Lists all currently mirrored + locally-added conditions grouped by gallery type | New (Feature) |
| Analysis server restarts | Mirror is empty until the next push arrives; a periodic pull-from-DB reconcile self-heals within its interval when the deployment shares one MongoDB instance | New (Feature, documented constraint) |

---

## 3. Technical Requirements

### 3.1 Enrollment Delegation

| Requirement | Specification |
|---|---|
| Delegation trigger | Local `getFaceService()` returns `null` or not-ready, AND `SERVER_MODE === 'streaming'`, AND `ANALYSIS_SERVER_URL` is configured |
| Delegated call | `POST {ANALYSIS_SERVER_URL}/api/analysis/face-embed`, raw `image/jpeg` body (same transport shape as `/api/analysis/frame`) |
| Delegated response | `{ success, bbox, score, embedding, thumbnail }` — same fields the local path already produces |
| Fallback | If no `analysisClient` is configured (e.g. `ANALYSIS_SERVER_URL` unset), behavior is unchanged — existing `503` |

### 3.2 Face Search Condition Mirror

| Requirement | Specification |
|---|---|
| Storage | Reuses existing `faceGalleries` / `faceGalleryFaces` tables — no new DB table |
| Origin tagging | New `source: 'local' \| 'synced'` field distinguishes locally-added rows from streaming-mirrored rows; reconcile only ever touches `'synced'` rows — **(2026-07-15 fix)** the reconcile upsert previously re-tagged a `'local'` row to `'synced'` whenever streaming and analysis shared one MongoDB instance (same physical row, matching `id`), making it eligible for deletion on the next round trip; the upsert now skips any row that already exists locally with `source:'local'`, see `Design_Face_Search_Condition_Sync.md` §4.1 |
| Push | Streaming server POSTs a full snapshot (galleries + faces, embeddings excluded) to the analysis server on every gallery/face mutation, fire-and-forget |
| Poll | Streaming server also re-sends the same full snapshot on a 5-second interval, independent of mutations, as a self-healing safety net |
| Read | `GET /api/analysis/face-search-conditions` (detail list), `faceSearch` field added to `GET /api/analysis/metrics` (dashboard count) |

### 3.3 Edit / Delete Condition (2026-07-15 addition)

| Requirement | Specification |
|---|---|
| Edit | `PUT /api/galleries/:id/faces/:faceId` — rename, reassign gallery/type, and/or replace the enrolled photo (re-embed via the same dual local/delegated extraction path as the existing enroll endpoint) |
| Delete | Existing `DELETE /api/galleries/:id/faces/:faceId`, now wired into `FaceSearchConditionPanel.tsx` (previously enroll-only) |
| Reachability | `/api/galleries` is mounted unconditionally in every `SERVER_MODE` — no new routing or `analysisProxy.js` change needed for either control to work from the Analysis Server Dashboard |

---

## 4. Architecture

```
Streaming Server                              Analysis Server
─────────────────                             ───────────────
POST /api/galleries/:id/faces
  │ local faceService not ready
  ▼
AnalysisClient.extractFaceEmbedding(jpeg) ───► POST /api/analysis/face-embed
                                                  │ faceService.detectFaces()
                                                  │ faceService.getEmbedding()
                                               ◄──┘ { bbox, score, embedding, thumbnail }
  │ insert faceGalleryFaces (source: 'local')
  │ reloadPersistentGallery()
  ▼
faceSearchSync.pushReconcile(db) ─────────────► POST /api/analysis/face-search-conditions/sync
  (also on a 5s setInterval, unconditionally)     { galleries: [...], faces: [...] }  (no embeddings)
                                                  │ applyReconcile() — upsert/delete
                                                  │   rows tagged source:'synced'
                                                  ▼
                                                faceGalleries / faceGalleryFaces (mirrored)
                                                  │
                                    Analysis Server Dashboard ◄── GET /api/analysis/face-search-conditions
                                                                  GET /api/analysis/metrics (faceSearch field)
```

Live per-frame matching (unchanged, already working):

```
Streaming Server                              Analysis Server
POST /api/analysis/frame ────────────────────► detectFaces() + getEmbedding()
                                               ◄─ { detectedFaces: [{ embedding, ... }] }  (raw, not stripped)
_assignFaceIds(detectedFaces)
  vs. local _persistentGallery (own faceGalleryFaces)
  → emit face_match / missing_person_match
  → insert faceMatchHistory
```

---

## 5. Integration Requirements

| Requirement | Detail |
|---|---|
| No new environment variables | Reuses existing `ANALYSIS_SERVER_URL` |
| No `analysisProxy.js` changes | `AnalysisServerDashboard.tsx` only mounts on a server with `/api/analysis/*` already mounted directly (analysis mode, or combined mode at `/analysis`) |
| Complementary fix | `pipelineManager.reloadPersistentGallery()` gains a 10s periodic self-refresh so cross-process DB writes (e.g. a condition added directly on the analysis server in a shared-Mongo deployment) are picked up by the streaming server's live-matching gallery without requiring an unrelated local mutation to trigger a reload |

---

## 6. Privacy & Compliance

| Requirement | Detail |
|---|---|
| No raw embeddings over the sync channel | `pushReconcile()` snapshot excludes the `embedding` field — the analysis-side mirror is display-only and never needs it |
| GDPR right-to-erasure preserved | Deleting a face on the streaming server removes it from the next reconcile snapshot, and the analysis-side mirror row is deleted on the following push/poll cycle |
| Audit logging | Reuses existing `faceGallery.js` audit-log calls (`gallery_created`, `gallery_deleted`, `face_enrolled`, `face_deleted`) — no new event types needed since sync mutations are a side effect of the same handlers |

---

## 7. Performance Requirements

| Metric | Requirement |
|---|---|
| Enrollment delegation latency | Adds no more than one additional HTTP round-trip (~same order as one `/api/analysis/frame` call) to the existing enrollment request |
| Push/poll payload size | Bounded by realistic gallery sizes (dozens–low hundreds of enrolled faces); thumbnails are already small (64×64 JPEG base64) |
| Push/poll network cost | Negligible on the LAN link streaming↔analysis servers already require (per `Design_Server_Architecture.md` §6.2, RTT ≤ 5ms recommended) |

---

## 8. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Correctness of delegation fallback | 35% | Enrollment succeeds via delegation with no regression to the local-model path |
| Dashboard visibility accuracy | 30% | Count and detail view match actual enrolled conditions within the push/poll window |
| No duplicate matching / no regression to live alerts | 25% | `face_match`/`missing_person_match` behavior on the streaming server is unaffected |
| Documentation completeness | 10% | MRD/RFP/PRD/SRS/Design/ops/TC set is internally consistent and cross-referenced |

---

## 9. Appendix

### Appendix A: Related Documents

| Document | Description |
|---|---|
| [RFP_AI_Face_Recognition.md](RFP_AI_Face_Recognition.md) | Parent face detection/recognition/gallery feature set |
| [RFP_Distributed_AI_Pipeline.md](RFP_Distributed_AI_Pipeline.md) | Parent streaming/analysis server split |
| [Design_Server_Architecture.md](../design/Design_Server_Architecture.md) | Root architecture reference — §3.4 documents this feature's sequence |

---

> **END OF DOCUMENT — LTS-2026-FSC-01**
>
> *For enquiries, open an issue at [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking)*

---

*CONFIDENTIAL | melchi45/loitering_tracking*

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — enrollment delegation fix + face search condition sync feature |
| 1.1 | 2026-07-15 | LTS Engineering Team | §3.2 — fixed reconcile corruption of local rows under a shared-MongoDB deployment. Added §3.3 — Edit/Delete Condition from the Analysis Server Dashboard |
