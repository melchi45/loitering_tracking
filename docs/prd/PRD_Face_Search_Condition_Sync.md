# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Face Search Condition Sync — Streaming ↔ Analysis

| | |
|---|---|
| **Document ID** | PRD-LTS-FSC-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-07-08 |
| **Related RFP** | RFP_Face_Search_Condition_Sync.md (LTS-2026-FSC-01) |

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

Distributed `streaming` + `analysis` deployments must behave identically to `combined` mode from the operator's point of view: enrolling a face into a gallery must work regardless of which server receives the request, and the analysis server's own dashboard must show what it is contributing to matching for — without requiring a second, independent matching engine.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- Enrollment (`POST /api/galleries/:id/faces`) succeeds on a `streaming`-mode server by delegating detect+embed to the analysis server when the local face service isn't loaded.
- Analysis server exposes `POST /api/analysis/face-embed` so any caller without local models can extract a face embedding from a photo.
- The Analysis Server Dashboard shows a live "Active Face Search" count (total + by gallery type), clickable into a detail list.
- The detail view supports adding a new condition directly (writes to the analysis server's own local, already-working `/api/galleries` API).
- Conditions created on a streaming server propagate to the analysis server within seconds (push) and self-heal on a 5-second interval (poll) using the same function.

### 2.2 Non-Goals

- Re-implementing named-gallery matching on the analysis server — matching stays exclusively on the streaming server (already correct).
- A new database table for search conditions — reuses `faceGalleries`/`faceGalleryFaces`.
- Reverse (analysis → streaming) HTTP sync — out of scope; documented as a constraint for non-shared-DB deployments.

---

## 3. User Personas

**Security Administrator (streaming server UI)** — enrolls faces through the Face ID tab exactly as in `combined` mode; unaware of and unaffected by which server actually performs the detect+embed step.

**GPU/Analysis Operator (analysis server dashboard)** — monitors pipeline health and, separately, wants to confirm what named-gallery conditions this node is currently seeing pushed to it, and occasionally needs to add one (e.g. a VIP photo) without switching to the streaming server's UI.

---

## 4. Functional Specification

### 4.1 Enrollment Delegation

```
POST /api/galleries/:id/faces (streaming server)
  │
  ├─ getFaceService() ready?
  │    YES → existing local path (unchanged)
  │    NO  → analysisClient configured?
  │           YES → POST {ANALYSIS_SERVER_URL}/api/analysis/face-embed (raw JPEG)
  │                  ← { bbox, score, embedding, thumbnail }
  │                  → continue with existing DB-insert flow using delegated result
  │           NO  → 503 (unchanged fallback)
```

`POST /api/analysis/face-embed` (analysis server, new):
```
raw image/jpeg body
  │ sharp normalize → faceService.detectFaces() → pick largest face
  │ faceService.getEmbedding()
  │ 64×64 thumbnail crop
  ▼
{ success: true, bbox, score, embedding, thumbnail }
```
Errors mirror the existing local path: `422` no face detected, `422` no embedding extracted, `503` face service not ready.

### 4.2 Face Search Condition Mirror + Sync

- `source: 'local' | 'synced'` field added to `faceGalleries` and `faceGalleryFaces` records (undefined/missing treated as `'local'` for pre-existing rows).
- `faceSearchSync.pushReconcile(db)` (streaming-side only): reads current galleries + faces (embeddings excluded), POSTs the full snapshot to the analysis server. Called (a) immediately after every gallery/face create/delete mutation, and (b) on a `setInterval(5000)`.
- `POST /api/analysis/face-search-conditions/sync` (analysis server): applies the incoming snapshot — upserts every `synced`-tagged row, deletes any existing `synced` row absent from the snapshot. Never touches `local`-tagged rows — **(2026-07-15 fix)** this guarantee did not actually hold when streaming and analysis shared one MongoDB instance (`DB_TYPE=mongodb` with a common `MONGODB_URI`): the upsert step re-tagged a matching local row to `'synced'` in place, making it eligible for deletion on the following round trip. `applyReconcile()` now skips the upsert entirely when a matching row already exists with `source:'local'`. See `Design_Face_Search_Condition_Sync.md` §4.1.
- `GET /api/analysis/face-search-conditions`: returns `{ total, byType: {missing,vip,blocklist,general}, faces: [...] }` for the dashboard detail view.
- `GET /api/analysis/metrics` gains a `faceSearch: { total, byType }` field for the dashboard's existing 2-second poll.

### 4.3 Analysis Server Dashboard UI

- New `StatCard` "Active Face Search" (existing `onClick`/`clickHint` pattern) showing `faceSearch.total`.
- Clicking it opens `FaceSearchConditionPanel` (new component, same full-screen overlay pattern as `AnalysisDetectionPanel`/`AnalysisLivePanel`), listing conditions grouped by gallery type using the shared `galleryTypeMeta` metadata (extracted from `FaceGalleryTab.tsx` into `client/src/utils/galleryTypeMeta.ts`).
- The panel includes an inline "add condition" form (name, type, photo) that creates a gallery-of-that-type if none exists, then enrolls the photo — both same-origin calls to the analysis server's own `/api/galleries` (already functional there since analysis mode loads local models).
- **(2026-07-15 addition)** Each listed face also has Edit and Delete controls: Edit switches the card to an inline form (rename, reassign gallery/type, optionally replace the photo) that saves via a new `PUT /api/galleries/:id/faces/:faceId`; Delete calls the existing `DELETE /api/galleries/:id/faces/:faceId`. Both give the Analysis Server Dashboard the same add/edit/delete capability over Face ID entries that the streaming dashboard's `FaceGalleryTab` already has.

### 4.4 Cross-Process Staleness Fix

- `pipelineManager.reloadPersistentGallery()` gains a `setInterval(10_000)` self-refresh on `streaming`/`combined` processes, so a condition written by another process to a shared DB (e.g. added directly on the analysis server) is picked up by the streaming server's live-matching gallery without requiring an unrelated local API call to trigger a reload.

---

## 5. Technical Requirements

| Requirement | Specification |
|---|---|
| Transport | Raw `image/jpeg` POST body for `/face-embed` (same shape as `/api/analysis/frame`), JSON POST for `/face-search-conditions/sync` |
| New DB fields | `source: 'local' \| 'synced'` on `faceGalleries`, `faceGalleryFaces` |
| No new tables | Reuses existing tables — no `ALL_TABLES`/`mongoDbService.js` TABLES changes needed |
| Sync interval | 5 seconds, `setInterval(...).unref()` |
| Reload interval (staleness fix) | 10 seconds |
| Delegation timeout | Uses `AnalysisClient`'s existing HTTP transport, own error handling (no circuit breaker/backpressure — enrollment is a rare, synchronous, user-triggered call) |

---

## 6. Input / Output Contract

**`POST /api/analysis/face-embed` response:**
```json
{
  "success": true,
  "bbox": { "x": 110, "y": 55, "width": 80, "height": 90 },
  "score": 0.94,
  "embedding": [0.12, -0.08, "... 512 floats"],
  "thumbnail": "data:image/jpeg;base64,..."
}
```

**`POST /api/analysis/face-search-conditions/sync` request:**
```json
{
  "galleries": [
    { "id": "gallery-uuid", "name": "Missing Children 2026", "type": "missing", "createdAt": "..." }
  ],
  "faces": [
    { "id": "face-uuid", "galleryId": "gallery-uuid", "name": "Kim Minsu", "thumbnail": "data:image/jpeg;base64,...", "bbox": {...}, "score": 0.94, "createdAt": "..." }
  ]
}
```
> Note: no `embedding` field — the analysis-side mirror is display-only.

**`GET /api/analysis/face-search-conditions` response:**
```json
{
  "total": 7,
  "byType": { "missing": 2, "vip": 1, "blocklist": 3, "general": 1 },
  "faces": [ { "id": "...", "galleryId": "...", "galleryType": "missing", "name": "Kim Minsu", "thumbnail": "...", "source": "synced" } ]
}
```

**`GET /api/analysis/metrics` addition:**
```json
{ "faceSearch": { "total": 7, "byType": { "missing": 2, "vip": 1, "blocklist": 3, "general": 1 } } }
```

---

## 7. Acceptance Criteria

| ID | Criterion | Pass Condition |
|---|---|---|
| AC-01 | Enrollment delegation succeeds | `POST /api/galleries/:id/faces` on a `streaming` server with a reachable analysis server and no local face model returns `201`, not `503` |
| AC-02 | Delegation is skipped when unnecessary | On `combined`/`analysis` mode (local model ready), enrollment uses the existing local path unchanged — no HTTP call to `/api/analysis/face-embed` |
| AC-03 | `/face-embed` error parity | No-face and no-embedding cases return the same `422` shape as the existing local path |
| AC-04 | Push propagation | Enrolling a face on the streaming server causes `GET /api/analysis/face-search-conditions` on the analysis server to reflect it within the push round-trip (no need to wait for the 5s poll) |
| AC-05 | Poll self-heal | A `synced` row manually removed from the analysis server's DB (simulating a missed push) is restored within one 5-second reconcile cycle |
| AC-06 | Local rows preserved | A condition added directly via the analysis server's own `/api/galleries` (tagged `source: 'local'`) is never deleted or overwritten by an incoming reconcile snapshot — **including when streaming and analysis share one MongoDB instance** (the gap fixed 2026-07-15; previously this held only for independent-store deployments) |
| AC-07 | Dashboard count | `AnalysisServerDashboard.tsx`'s "Active Face Search" StatCard shows `faceSearch.total` from `/api/analysis/metrics` |
| AC-08 | Dashboard detail + add | Clicking the count opens a panel listing conditions by type; submitting the add-condition form results in a new enrolled face visible in the same panel after refresh |
| AC-09 | No duplicate live-matching events | `face_match`/`missing_person_match` emission rate and payload shape on the streaming server are unaffected by this feature |
| AC-10 | Cross-process staleness bound | A gallery/face row written to a shared MongoDB by a different process is reflected in `pipelineManager._persistentGallery` within 10 seconds, without an unrelated local mutation |
| AC-11 | Edit condition | `PUT /api/galleries/:id/faces/:faceId` renames, reassigns gallery/type, and/or replaces the photo of an existing enrolled face; changes are visible on the next `GET` and survive a reconcile round trip |
| AC-12 | Delete condition from Analysis Server Dashboard | The Delete control in `FaceSearchConditionPanel.tsx` removes the face via the existing `DELETE` endpoint and the panel reflects the removal without a manual refresh |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Status |
|---|---|---|---|
| M1 | Enrollment delegation (`/face-embed` + `faceGallery.js` fallback branch) | 2026-07-08 | ⏳ In progress |
| M2 | Face search condition mirror (push + poll, `source` tagging) | 2026-07-08 | ⏳ In progress |
| M3 | Analysis Server Dashboard StatCard + detail panel + add-condition form | 2026-07-08 | ⏳ In progress |
| M4 | TC suite + SUITES registration | 2026-07-08 | ⏳ In progress |
| M5 | Shared-MongoDB reconcile corruption fix (AC-06 gap) + Edit/Delete condition UI (AC-11/12) | 2026-07-15 | ✅ Done |

### 8.2 TODO

- [ ] `server/src/services/faceEnrollHelper.js` — extracted detect+embed+thumbnail helper
- [ ] `POST /api/analysis/face-embed`
- [ ] `AnalysisClient.extractFaceEmbedding()`
- [ ] `faceGallery.js` delegation branch
- [ ] `source` field on `faceGalleries`/`faceGalleryFaces`
- [ ] `faceSearchConditions.js` (summarize/listGrouped/applyReconcile)
- [ ] `faceSearchSync.js` (pushReconcile/startAutoSync)
- [ ] `POST /api/analysis/face-search-conditions/sync`, `GET /api/analysis/face-search-conditions`, `faceSearch` in `/metrics`
- [ ] `pipelineManager.js` 10s reload interval
- [ ] `client/src/utils/galleryTypeMeta.ts` extraction
- [ ] `FaceSearchConditionPanel.tsx`
- [ ] `AnalysisServerDashboard.tsx` StatCard + overlay wiring
- [ ] `test/api/face_search_condition_sync.test.js` + both SUITES registrations

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-08 | LTS Engineering Team | Initial release — PRD for Face Search Condition Sync |
| 1.1 | 2026-07-15 | LTS Engineering Team | Fixed AC-06 gap — `applyReconcile()` corrupted/deleted local rows when streaming and analysis shared one MongoDB. Added AC-11/12 and M5 — Edit/Delete condition controls in the Analysis Server Dashboard |
