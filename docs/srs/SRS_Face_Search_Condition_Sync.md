# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Face Search Condition Sync — Streaming ↔ Analysis

| | |
|---|---|
| **Document ID** | SRS-LTS-FSC-01 |
| **Version** | 1.2 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Parent PRD** | prd/PRD_Face_Search_Condition_Sync.md |
| **Parent RFP** | rfp/RFP_Face_Search_Condition_Sync.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Enrollment Delegation](#3-functional-requirements--enrollment-delegation)
4. [Functional Requirements — Condition Mirror & Sync](#4-functional-requirements--condition-mirror--sync)
5. [Functional Requirements — Dashboard UI](#5-functional-requirements--dashboard-ui)
6. [Non-Functional Requirements](#6-non-functional-requirements)
7. [Data Requirements](#7-data-requirements)
8. [Interface Requirements](#8-interface-requirements)
9. [Constraints & Assumptions](#9-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines verifiable functional requirements (`FR-FSC-NNN`) for enrollment delegation and face search condition visibility in distributed `streaming`+`analysis` deployments, traceable to `TC_Face_Search_Condition_Sync.md`.

### 1.2 Scope

- Delegating face-embedding extraction for gallery enrollment from a streaming server to an analysis server.
- Mirroring `faceGalleries`/`faceGalleryFaces` counts onto the analysis server for display purposes.
- Analysis Server Dashboard visibility and add-condition UI.

Out of scope: any change to live per-frame named-gallery matching (`pipelineManager._assignFaceIds()`), which already works correctly in distributed mode and is not modified by this feature.

### 1.3 Definitions

| Term | Definition |
|---|---|
| Face Search Condition | An enrolled named-gallery face (VIP/Blocklist/Missing/General) that live matching searches for |
| Mirror | The analysis server's local copy of `faceGalleries`/`faceGalleryFaces` rows originating from a streaming server, used for display only |
| `source` | Field on gallery/face rows: `'local'` (created via that server's own API) or `'synced'` (written by an incoming reconcile snapshot) |
| Push | Fire-and-forget POST of the full current gallery/face snapshot, sent immediately after a mutation |
| Poll | The same push, sent unconditionally on a 5-second interval, independent of mutations |
| Delegation | Streaming server forwarding an enrollment photo to the analysis server's `/face-embed` endpoint when no local face model is loaded |

---

## 2. System Overview

### 2.1 Component Dependencies

```
Streaming Server                                Analysis Server
─────────────────                               ───────────────
faceGallery.js (POST /:id/faces)
  ├─ getFaceService() ready? → faceEnrollHelper.extractFaceForEnrollment()  (local)
  └─ not ready → analysisClient.extractFaceEmbedding()  ──────────────────► analysisApi.js POST /face-embed
                                                                                └─ faceEnrollHelper.extractFaceForEnrollment() (local models)
faceSearchSync.js
  ├─ pushReconcile(db) — on mutation + 5s interval  ────────────────────► analysisApi.js POST /face-search-conditions/sync
                                                                                └─ faceSearchConditions.applyReconcile()
                                                                                     upsert/delete rows tagged source:'synced'
                                                                             analysisApi.js GET /face-search-conditions
                                                                             analysisApi.js GET /metrics → faceSearch field
                                                                                     ▲
                                                                    AnalysisServerDashboard.tsx / FaceSearchConditionPanel.tsx
```

### 2.2 Unaffected Path (for contrast, not modified)

```
Streaming Server: POST /api/analysis/frame ──► Analysis Server: detectFaces()+getEmbedding()
                                              ◄── { detectedFaces: [{ embedding, ... }] }
pipelineManager._assignFaceIds() vs. local _persistentGallery
  → face_match / missing_person_match (unchanged)
```

---

## 3. Functional Requirements — Enrollment Delegation

### FR-FSC-001 — Delegation Trigger

- In `POST /api/galleries/:id/faces`, if `getFaceService()` returns `null` or `!ready`, AND an `analysisClient` instance was injected into `faceGalleryRouter(...)`, delegation is attempted.
- If no `analysisClient` is available, behavior is unchanged: `503 { success: false, error: 'Face service not available — models not loaded' }`.

### FR-FSC-002 — `POST /api/analysis/face-embed`

- Accepts raw `image/jpeg` body (same content-type handling as `POST /api/analysis/frame`).
- Calls `faceEnrollHelper.extractFaceForEnrollment(faceService, buffer)` using the analysis server's own already-loaded `AttributePipeline._face`.
- Response: `{ success: true, bbox, score, embedding, thumbnail }`.
- If zero faces detected: `422 { success: false, error: 'No face detected...' }` (identical message to the existing local path).
- If embedding extraction fails: `422 { success: false, error: 'Could not extract face embedding...' }`.
- If the analysis server's own face service is not ready: `503`.

### FR-FSC-003 — Delegated Enrollment Completion

- On a successful delegated response, the streaming server proceeds with the same DB-insert flow as the local path: `db.insert('faceGalleryFaces', { id, galleryId, name, embedding, thumbnail, bbox, score, source: 'local' })`.
- `pipelineManager.reloadPersistentGallery()` is called exactly as in the local path.
- The HTTP response to the original enrollment request is `201`, identical shape to the local-path response (embedding excluded).

### FR-FSC-004 — Shared Helper, No Duplicated Logic

- `faceEnrollHelper.extractFaceForEnrollment()` is the single implementation of sharp-normalize → detect → pick-largest-face → embed → 64×64-thumbnail-crop, called by both the local `faceGallery.js` path and the new `POST /face-embed` handler.

---

## 4. Functional Requirements — Condition Mirror & Sync

### FR-FSC-010 — `source` Field

- `faceGalleries` and `faceGalleryFaces` records gain a `source: 'local' | 'synced'` field.
- Rows created via a server's own `POST /api/galleries` or `POST /api/galleries/:id/faces` are tagged `'local'`.
- Rows written by `applyReconcile()` are tagged `'synced'`.
- Records without a `source` field (pre-existing before this feature) are treated as `'local'` by all reconcile logic.

### FR-FSC-017 — Local-Row Immutability Under Reconcile (Shared-Store Deployments)

- `applyReconcile()` MUST NOT upsert (and therefore must never re-tag) a gallery/face row whose `id` already exists locally with `source === 'local'`, regardless of whether that same `id` also appears in the incoming snapshot.
- This is the guard that makes `FR-FSC-032` (Reconcile Idempotency) hold even when streaming and analysis are configured with `DB_TYPE=mongodb` pointing at the same shared `MONGODB_URI` — a supported deployment (`docs/ops/Distributed_AI_Pipeline_Setup.md`) in which `db.findOne`/`update`/`delete` calls made "on the other server's db" operate on the exact same physical documents.
- Without this guard (pre-2026-07-15), a locally-created row could have its `source` flipped to `'synced'` by the very next reconcile round trip triggered from the other side, making it eligible for deletion by the delete-sweep on the round trip after that — silently destroying gallery/face data shortly after creation. See `Design_Face_Search_Condition_Sync.md` §4.1 for the full traced sequence.
- Verified by `TC-FSC-B-006`.

### FR-FSC-011 — Push on Mutation

- After each of the 4 mutation handlers in `faceGallery.js` (create gallery, delete gallery, enroll face, delete face) commits locally, if `process.env.SERVER_MODE === 'streaming'`, `faceSearchSync.pushReconcile(db, pipelineManager)` is invoked fire-and-forget (does not block or fail the HTTP response).

### FR-FSC-012 — Poll (5-Second Interval)

- `faceSearchSync.startAutoSync(db, pipelineManager)` is called once at streaming-server startup when `SERVER_MODE==='streaming' && ANALYSIS_SERVER_URL` is set.
- It invokes `pushReconcile(db, pipelineManager)` once immediately, then every 5000ms via `setInterval(...).unref()`.
- The push and poll paths call the identical `pushReconcile()` function — no separate incremental-diff logic exists.

### FR-FSC-013 — Outbound Snapshot Payload (Streaming → Analysis)

- `pushReconcile()` sends `{ galleries: FaceGallery[], faces: FaceGalleryFace[] }` reflecting the streaming server's own locally-registered conditions (`faceSearchConditions.exportLocal()` — rows tagged `source:'local'` or missing `source`; rows already tagged `source:'synced'` on the streaming side are not re-exported).
- The `embedding` field is excluded from every face entry in the outbound payload.

### FR-FSC-014 — `POST /api/analysis/face-search-conditions/sync` — Bidirectional

- **Inbound half (analysis applies streaming's push):** applies the request body via `faceSearchConditions.applyReconcile(db, req.body)`:
  - Every gallery/face in the snapshot is upserted with `source: 'synced'`.
  - Every existing `source:'synced'` row in the analysis server's DB that is absent from the incoming snapshot is deleted.
  - Rows tagged `source:'local'` (or missing `source`) are never modified or deleted by this endpoint.
- **Outbound half (analysis responds with its own local conditions):** the HTTP response body is `{ success: true, ...faceSearchConditions.exportLocal(db) }` — the analysis server's own `source:'local'` galleries/faces, **with embeddings intact** (unlike the streaming→analysis direction, this data must be usable for real matching on the receiving side).
- The streaming server applies this response via the same `faceSearchConditions.applyReconcile()` function (tagging the rows `source:'synced'` on ITS OWN DB) and then calls `pipelineManager.reloadPersistentGallery()`, so a condition registered directly on the analysis server's dashboard becomes visible in the streaming server's Face ID tab **and** locally matchable — not just display-only.

### FR-FSC-015 — `GET /api/analysis/face-search-conditions`

- Returns `{ total, byType: { missing, vip, blocklist, general }, faces: [...] }` computed from the analysis server's current `faceGalleries`/`faceGalleryFaces` (both `local` and `synced` rows counted together).
- `faces[]` entries include `galleryType` resolved from the parent gallery and exclude the raw `embedding`.

### FR-FSC-016 — `faceSearch` in `/metrics`

- `GET /api/analysis/metrics` response gains a `faceSearch: { total, byType }` field, computed the same way as FR-FSC-015 but without the full face list (cheap to compute on every poll).
- `pipelineManager.js`'s combined-mode metrics path exposes the same field for parity.

---

## 5. Functional Requirements — Dashboard UI

### FR-FSC-020 — Active Face Search StatCard

- `AnalysisServerDashboard.tsx` renders a new `StatCard` labeled "Active Face Search" showing `faceSearch.total` from the existing 2-second `/api/analysis/metrics` poll.
- The card uses the existing `onClick`/`clickHint` prop pattern; clicking it sets local overlay state to show `FaceSearchConditionPanel`.

### FR-FSC-021 — Detail Panel

- `FaceSearchConditionPanel.tsx` fetches `GET /api/analysis/face-search-conditions` on mount.
- Conditions are grouped by gallery type using the shared `GALLERY_TYPE_META`/`GALLERY_TYPE_ORDER` extracted into `client/src/utils/galleryTypeMeta.ts`.
- The panel follows the existing full-screen overlay-with-`onClose` pattern already used by `AnalysisDetectionPanel`/`AnalysisLivePanel`.

### FR-FSC-022 — Add Condition From Detail Panel

- The panel includes a form (name, gallery-type select, photo file input).
- On submit: if no gallery of the selected type exists (checked against the fetched list), `POST /api/galleries` creates one first; then `POST /api/galleries/:id/faces` enrolls the photo.
- Both calls target the current origin (the analysis server itself) — no cross-server proxying, since analysis mode always has a locally-ready face service.
- On success, the panel's list refreshes to include the new condition.

### FR-FSC-023 — Edit Condition From Detail Panel

- Each face card in `FaceSearchConditionPanel.tsx` has an Edit control. Activating it switches that card to an inline edit form: name (pre-filled), gallery-type select (pre-filled, using the same `GALLERY_TYPE_META`/`GALLERY_TYPE_ORDER` as the add-form), and an optional replacement-photo file input.
- Saving calls `PUT /api/galleries/:galleryId/faces/:faceId` (FR-FSC-025) with only the fields that changed: `name` if edited, `galleryId` (resolved via the same find-or-create-by-type helper the add-form uses) if the type changed, and `photo` if a replacement file was chosen.
- On success, the panel reloads via the existing `GET /api/analysis/face-search-conditions` fetch. On failure, the existing error banner displays the response's `error` message.

### FR-FSC-024 — Delete Condition From Detail Panel

- Each face card has a Delete control that calls `DELETE /api/galleries/:galleryId/faces/:faceId` directly, with no confirmation dialog — consistent with `FaceGalleryTab.tsx`'s existing `deleteFace()`, which also has none (only its gallery-level delete confirms).
- On success, the panel reloads the same way as FR-FSC-023.

### FR-FSC-025 — `PUT /api/galleries/:id/faces/:faceId` Contract

- Request: `multipart/form-data` with all fields optional — `name` (string), `galleryId` (string, must reference an existing gallery or `400`), `photo` (image file).
- If `name` is provided but empty/whitespace-only: `400`.
- If `galleryId` is provided but does not resolve to an existing gallery: `400 { success: false, error: 'Target gallery not found' }`.
- If `photo` is provided: re-runs the same dual local/delegated extraction path as `POST /:id/faces` (local `extractFaceForEnrollment` when the face service is ready, else `analysisClient.extractFaceEmbedding()` when available, else `503`) and updates `embedding`/`thumbnail`/`bbox`/`score`. Same `422`/`500` error-status mapping as the POST handler for detection failures.
- If none of `name`/`galleryId`/`photo` are provided: `400 { success: false, error: 'No fields to update' }`.
- On success: `200 { success: true, data: { ...updatedFace, embedding: undefined } }` (embedding never exposed, matching every other face response in this API).
- Triggers `AuditService.log({ event: 'face_updated', ... })`, `pipelineManager.reloadPersistentGallery()`, and `syncIfStreaming()` — the identical post-mutation side effects as the existing POST/DELETE handlers.
- Mounted on the same unconditional `/api/galleries` router (`server/src/index.js`) — reachable in every `SERVER_MODE`, including `analysis`, with no additional routing change.

---

## 6. Non-Functional Requirements

### FR-FSC-030 — Delegation Latency

- End-to-end delegated enrollment (upload → HTTP hop to analysis server → detect → embed → thumbnail → HTTP response → local DB insert) completes within the same order of magnitude as one `/api/analysis/frame` round-trip plus normal enrollment processing (no fixed SLA beyond "does not hang" — uses the same HTTP client as frame analysis).

### FR-FSC-031 — Push/Poll Non-Blocking

- Neither `pushReconcile()` call site (mutation-triggered or interval-triggered) blocks or can fail the caller's own HTTP response or the interval loop itself; all errors are caught and logged with `console.warn`.

### FR-FSC-032 — Reconcile Idempotency

- Applying the same snapshot twice in a row produces no observable difference in the analysis server's mirrored rows (idempotent upsert/delete).

### FR-FSC-033 — Cross-Process Staleness Bound (Complementary Fix)

- `pipelineManager.reloadPersistentGallery()` is additionally invoked on a `setInterval(10_000)` on `streaming`/`combined` processes, bounding how long a gallery/face row written by a different process to a shared DB can remain invisible to live matching.

---

## 7. Data Requirements

### 7.1 `faceGalleries` / `faceGalleryFaces` — Added Field

```json
{ "source": "local | synced" }
```
Appended to the existing schemas documented in `SRS_AI_Face_Recognition.md` §10.1/§10.2 — no other fields change.

### 7.2 Reconcile Snapshot (wire payload)

```json
{
  "galleries": [
    { "id": "uuid", "name": "string", "description": "string", "type": "general|vip|blocklist|missing", "createdAt": "ISO-8601" }
  ],
  "faces": [
    { "id": "uuid", "galleryId": "uuid", "name": "string", "thumbnail": "data:image/jpeg;base64,...", "bbox": {"x":0,"y":0,"width":0,"height":0}, "score": 0.0, "createdAt": "ISO-8601" }
  ]
}
```

### 7.3 Face Search Condition Summary

```json
{
  "total": 7,
  "byType": { "missing": 2, "vip": 1, "blocklist": 3, "general": 1 }
}
```

---

## 8. Interface Requirements

### 8.1 REST API Summary

| ID | Method | Endpoint | Server | Description |
|---|---|---|---|---|
| FR-FSC-002 | POST | `/api/analysis/face-embed` | analysis | Detect + embed a photo, return bbox/score/embedding/thumbnail |
| FR-FSC-014 | POST | `/api/analysis/face-search-conditions/sync` | analysis | Apply a full gallery/face reconcile snapshot |
| FR-FSC-015 | GET | `/api/analysis/face-search-conditions` | analysis | List active conditions grouped by gallery type |
| FR-FSC-016 | GET | `/api/analysis/metrics` | analysis | Existing endpoint, `faceSearch` field added |
| FR-FSC-025 | PUT | `/api/galleries/:id/faces/:faceId` | streaming, analysis, combined | Rename, reassign gallery/type, and/or replace photo for an enrolled face |

### 8.2 Socket.IO Events

None added or changed — `face_match`, `missing_person_match`, `face:reidentified` remain exactly as specified in `SRS_AI_Face_Recognition.md` §11.2.

---

## 9. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | Matching authority for detections received via `/api/analysis/frame` stays on the streaming server; `_assignFaceIdsAnalysis()` on the analysis server never consults `faceGalleryFaces` for live matching. Conditions pulled IN from the analysis server (FR-FSC-014's outbound half) are matched locally on the streaming server exactly like any other `source:'local'` row — there is still only ever one place a given embedding is compared against a gallery |
| C-02 | Push/poll requires `ANALYSIS_SERVER_URL` to be reachable from the streaming server — identical network precondition to existing `/api/analysis/frame` traffic. The reverse (analysis-to-streaming) data flow rides the SAME HTTP round trip (the sync response body), so no `STREAMING_SERVER_URL` or reverse connectivity is needed |
| C-03 | **Delete-authority asymmetry**: deleting a `source:'synced'` gallery/face directly via the receiving side's own UI/API removes it locally, but since the row still exists as `source:'local'` on the OTHER server, the next push/poll cycle re-adds it. Deleting a condition must be done on the server where it was originally created (`source:'local'`) to stick |
| C-04 | The 5-second poll interval and 10-second reload interval are independent constants, not currently configurable via environment variable |
| C-05 | `source` defaulting to `'local'` for pre-existing rows means a first reconcile after upgrade will not delete any existing gallery/face data, even if it did originate from a since-removed streaming server |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — SRS for Face Search Condition Sync |
| 1.1 | 2026-07-08 | LTS Engineering Team | Made FR-FSC-013/014 bidirectional — a condition registered directly on the analysis server's dashboard is now pulled back into the streaming server (with embedding) via the same sync HTTP response, fixing the originally-reported "added on analysis, not visible on streaming" gap. Replaced C-03 with the resulting delete-authority asymmetry constraint |
| 1.2 | 2026-07-15 | LTS Engineering Team | Added FR-FSC-017 (local-row immutability guard, fixes shared-MongoDB reconcile data loss) and FR-FSC-023/024/025 (Edit/Delete Condition From Detail Panel + `PUT /api/galleries/:id/faces/:faceId` contract) |
