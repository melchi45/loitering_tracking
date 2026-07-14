---
**Document:** SRS_AI_Age_Estimation  
**Version:** 1.3  
**Status:** Draft  
**Date:** 2026-07-14  
**Parent RFP:** [RFP_AI_Age_Estimation](../rfp/RFP_AI_Age_Estimation.md)  
**Parent PRD:** [PRD_AI_Age_Estimation](../prd/PRD_AI_Age_Estimation.md)  
**Child Design:** [Design_AI_Age_Estimation](../design/Design_AI_Age_Estimation.md)  
**Child TC:** [TC_AI_Age_Estimation](../tc/TC_AI_Age_Estimation.md)  
**Child Test Script:** `test/api/age_estimation.test.js`, `test/api/model_catalog.test.js`  
---

# SRS — AI Age Estimation

## 1. Introduction

This SRS specifies the software requirements for the Age Estimation AI module: its model catalog entries, the new `hfOptimumExport` PT→ONNX conversion strategy, the `AgeEstimationService`, face/body input fallback logic, and Admin Dashboard integration.

## 2. Scope

Model catalog, download/conversion, and inference (§3.1-3.6) are applicable to `SERVER_MODE=analysis` and `SERVER_MODE=combined` only — `SERVER_MODE=streaming` delegates inference to the remote analysis server, same as all other attribute modules, and never loads `AgeEstimationService` itself.

**Correction (2026-07-14):** UI display and local persistence (§3.8) ARE applicable to `SERVER_MODE=streaming` — `CameraView.tsx`, `FullscreenCameraView.tsx`, `DetectionsTimelineInline.tsx`, and `SearchFullscreen.tsx` are shared client components used identically regardless of server mode, and `pipelineManager.js`'s `_processRemoteResult()` (streaming mode's remote-result handler) persists `estimatedAge` to the local `detectionTracks`/`detectionSnapshots` tables exactly like the local-inference path does. Only the model/inference itself is out of scope for streaming mode — display and persistence are not.

## 3. Functional Requirements

### 3.1 Model Catalog

| ID | Requirement |
|---|---|
| FR-AGE-001 | `EXTENDED_CATALOG` in `server/src/routes/analysisApi.js` shall include two entries with `family: 'age-estimation'`, `series: 'Age Estimation'`: `insightface-genderage` (file `genderage.onnx`) and `vit-age-classifier` (file `vit_age_classifier.onnx`). |
| FR-AGE-002 | `_activeFileForEntry()` shall include a `case 'age-estimation'` returning the basename of `_ageEstimation.modelPath` when `_ageEstimation.ready` is true, `null` otherwise — mirroring the `appearance-reid` case exactly. |
| FR-AGE-003 | At most one `age-estimation` entry shall report `active: true` at any time (enforced structurally by both entries sharing the same family and `_activeFileForEntry()` comparing a single active file path). |

### 3.2 Model Download

| ID | Requirement |
|---|---|
| FR-AGE-004 | `insightface-genderage` shall download via the existing plain HTTP(S) `doDownload()` path (a `url` field, no `hfExport`/`requiresConversion`/`manualOnly`) — it ships as ONNX already. |
| FR-AGE-005 | `vit-age-classifier` shall carry a new `hfOptimumExport: { repo: 'nateraw/vit-age-classifier' }` field instead of `url`/`hfExport`/`manualOnly`. |
| FR-AGE-006 | The `/models/download` handler shall add a new branch: when `entry.hfOptimumExport` is present, it shall (1) resolve a Python interpreter via a new `_findPythonWithOptimum()` helper (checks `import optimum.exporters.onnx, transformers`), (2) run `optimum.exporters.onnx.main_export(model_name_or_path=<repo>, output=<tmp dir>, task="image-classification")` via subprocess, (3) copy the resulting `<tmp dir>/model.onnx` to `server/models/<file>`, (4) remove the temporary directory. |
| FR-AGE-007 | If no Python interpreter satisfies the `optimum.exporters.onnx`/`transformers` check, the download shall fail with an error message naming the missing packages (`pip install -U optimum-onnx transformers`). Auto-installs into the first runnable candidate before failing (2026-07-14). |
| FR-AGE-008 | The `hfOptimumExport` subprocess shall have the same 5-minute timeout (`300_000 ms`) as the existing `hfExport`/`requiresConversion` paths. |

### 3.3 Runtime Model Switch

| ID | Requirement |
|---|---|
| FR-AGE-009 | `POST /api/analysis/models/switch` shall add `case 'age-estimation'`: lazy-instantiate `_ageEstimation` if absent, then call `_ageEstimation.reload(filePath)` — mirroring the `appearance-reid` case. |
| FR-AGE-010 | Switching shall fail with HTTP 409 if the target file does not exist on disk (existing shared pre-check in the handler, unchanged). |

### 3.4 AgeEstimationService

| ID | Requirement |
|---|---|
| FR-AGE-011 | `server/src/services/ageEstimationService.js` shall export `class AgeEstimationService` with `constructor({modelPath})`, `load()`, `reload(filePath)`, `ready` getter, `status` getter (`'not_started' \| 'missing' \| 'loaded' \| 'failed'`) — mirroring `AppearanceReidService`'s structure. |
| FR-AGE-012 | `load()` shall set `status: 'missing'` (not an error) when the model file does not exist, allowing the pipeline to continue without age estimation. |
| FR-AGE-013 | The service shall maintain a per-model preprocessing/postprocessing table keyed by catalog id, covering: input size (96 for InsightFace, 224 for ViT), channel order, normalization, and output parsing (regression value vs. 9-class bucket argmax). |
| FR-AGE-014 | `estimateAge(jpegBuffer, bbox, { isFaceCrop })` shall return `{ value: number, bucket?: string, source: 'face' \| 'body', modelId: string }` or `null` if the service is not ready. |
| FR-AGE-015 | For the ViT classifier, `bucket` shall be one of the 9 published class labels (`'0-2'`…`'more than 70'`); `value` shall be derived as the bucket's midpoint (e.g. `'20-29'` → `24.5`) for cross-model comparability with the InsightFace regression output. |

### 3.5 Input Source Fallback

| ID | Requirement |
|---|---|
| FR-AGE-016 | When processing a `person` track, if a face bbox is already available for that track (from `AttributePipeline`'s face detection, when the `face` module is enabled), the pipeline shall call `estimateAge()` with the face crop and `isFaceCrop: true`. |
| FR-AGE-017 | When no face bbox is available for the track, the pipeline shall fall back to the YOLOv8 person bbox and call `estimateAge()` with `isFaceCrop: false`. |
| FR-AGE-018 | If neither a face bbox nor a person bbox is available (should not normally occur for a `person`-class track), age estimation shall be silently skipped for that frame — no error thrown. |

### 3.6 Configuration & Persistence

| ID | Requirement |
|---|---|
| FR-AGE-019 | `analyticsConfig.js`'s `DEFAULT_CONFIG` shall add `ageEstimation: false` (opt-in, matching the `humanParsing` convention). |
| FR-AGE-020 | `ageEstimation` shall be added to `PERSON_ATTR_MODULES` so it is recognized as a valid person-attribute toggle by existing config validation. |
| FR-AGE-021 | `tracking.js`'s `Track` class shall carry an `estimatedAge` field and a corresponding `ByteTracker.updateEstimatedAge(objectId, estimatedAge)` method, mirroring the existing `color`/`cloth`/`accessories` per-attribute pattern (`updateColor`/`updateCloth`/`updateAccessories`) — not a shared "sticky-attribute list" (that phrase does not correspond to an actual construct in the code; `gender`/`ageGroup`/`lower`/`sleeve` are fields nested inside the `cloth` object, read only by `Track._clothSim()`'s re-association scoring). `estimatedAge` is not consumed by any similarity scorer in this phase — the field exists for parity with the established per-attribute pattern and to leave room for future re-association use. |
| FR-AGE-022 | Age estimation shall run only when `analyticsConfig.ageEstimation === true`; when `false` (default), zero additional inference or crop extraction shall occur (no performance cost when disabled). |

### 3.7 Admin Dashboard

| ID | Requirement |
|---|---|
| FR-AGE-023 | `client/src/pages/admin/AdminUsersPage.tsx`'s `ModelCatalogEntry.family` union type shall include `'age-estimation'`. |
| FR-AGE-024 | `EXTENDED_SERIES_ORDER` shall include `'Age Estimation'`; `PROPOSED_SERIES` shall include `'Age Estimation'` (rendered with the same "Proposed" badge as Human Parsing/Appearance Re-ID). |
| FR-AGE-025 | `ADMIN_MODULE_GROUPS`'s `attributes` group shall include an `ageEstimation` item describing both selectable models. |
| FR-AGE-026 | No new React component shall be required — the existing generic `AiModelsSection()` catalog table shall render both `age-estimation` entries with independent Activate/Download controls without code changes beyond the constants above. |

### 3.8 UI Display, Persistence & Diagnostics (2026-07-14)

| ID | Requirement |
|---|---|
| FR-AGE-027 | `pipelineManager.js` shall carry `estimatedAge` through all three `ctx._trackMeta` update sites (new-track creation, existing-track update, and each of the three `detectionTracks` flush branches: completed/active/stale) so that a track's most recent `estimatedAge` reaches the `detectionTracks` DB table, mirroring the existing `cloth`/`color` persistence pattern. |
| FR-AGE-028 | `snapshotService.js`'s `saveSnapshot()` shall include `det.estimatedAge` in the persisted `attributes` object (when present), so `estimatedAge` reaches `detectionSnapshots` and is retrievable via `/api/search` and `/api/snapshots`. |
| FR-AGE-029 | The client shall render `estimatedAge` in exactly four locations when `estimatedAge.value != null`: (1) `CameraView.tsx`'s live canvas overlay, (2) `FullscreenCameraView.tsx`'s live `DetectionRow`, (3) `DetectionsTimelineInline.tsx`'s track detail panel, (4) `SearchFullscreen.tsx`'s search result detail panel. Each rendering shall be visually and label-distinct from the existing `cloth.ageGroup` PA100k byproduct (labeled "Age Group (PAR)") to avoid operator confusion between the two independent signals. |
| FR-AGE-030 | In `SERVER_MODE=streaming`, the `estimatedAge` field computed by the remote analysis server shall pass through to the local `detections` Socket.IO event and local DB persistence unmodified — the streaming server's `_processRemoteResult()` shall consume `result.tracked` (and downstream `allDetections`) via object spread only, never a field-enumerated remap that could silently drop unlisted attributes. |
| FR-AGE-031 | `pipelineManager.js`'s `getAnalysisMetrics()` (the function backing `GET /api/analysis/metrics`) shall include an `ageEstimation` key in its `services` object, reporting `AgeEstimationService.status` (`'not_started' \| 'missing' \| 'loaded' \| 'failed'`), mirroring the field already present in `getServiceStatus()`. Prior to this requirement, `services` silently omitted the key entirely (neither `null` nor an error value), making it impossible to distinguish "toggle off," "model not loaded," and "working correctly but streaming server has stale code" from the metrics endpoint alone. |
| FR-AGE-032 | (Operational) When `estimatedAge` is absent from all recent `detectionTracks` on a `SERVER_MODE=streaming` instance despite `analyticsConfig.ageEstimation === true` locally, this shall be diagnosed by checking `services.ageEstimation` on the **remote** analysis server's own `/api/analysis/metrics` response (not the streaming server's) — see Design doc §12.1 for the full diagnostic decision table. |

## 4. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-AGE-001 | Age estimation inference shall not block the main detection loop for more than the per-model latency budget in RFP §7 (10ms InsightFace / 80ms ViT, CPU). |
| NFR-AGE-002 | A missing or failed-to-load model shall never crash `pipelineManager.js` — all service methods degrade to `null`/no-op. |
| NFR-AGE-003 | Exact numeric output contracts (InsightFace output tensor layout, age scale factor) shall be verified against the actual downloaded ONNX model before being trusted in production output — see Design doc Verification section. |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-12 | 초기 작성 — Age Estimation SRS, FR-AGE-001~026 |
| 1.1 | 2026-07-12 | FR-AGE-021 정정 — 존재하지 않는 "sticky-attribute 목록" 대신 실제 코드 패턴(Track 필드 + `updateEstimatedAge()`, `color`/`cloth`/`accessories`와 동일 구조)으로 서술 수정 |
| 1.2 | 2026-07-14 | FR-AGE-006/007 정정 — ONNX export 기능이 `optimum[exporters]`(base `optimum` extra, 실제로는 더 이상 `optimum.exporters.onnx` 미제공)에서 별도 패키지 `optimum-onnx`로 이전됨을 반영(`huggingface/optimum-onnx`). 검증 스크립트도 `import optimum` 대신 `import optimum.exporters.onnx`로 정정 |
| 1.3 | 2026-07-14 | §2 Scope 정정 — UI 표시·로컬 영속화는 `SERVER_MODE=streaming`에도 적용됨을 명시(모델 추론만 원격 위임). §3.8 신규 — FR-AGE-027~032: `detectionTracks`/`detectionSnapshots` 영속화, 클라이언트 4곳 표시, streaming 모드 필드 통과 보장, `getAnalysisMetrics()`의 `services.ageEstimation` 진단 필드 |
