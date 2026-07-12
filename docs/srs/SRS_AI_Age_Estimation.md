---
**Document:** SRS_AI_Age_Estimation  
**Version:** 1.1  
**Status:** Draft  
**Date:** 2026-07-12  
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

Applicable to `SERVER_MODE=analysis` and `SERVER_MODE=combined`. Not applicable to `SERVER_MODE=streaming` (delegates inference to the remote analysis server, same as all other attribute modules).

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
| FR-AGE-006 | The `/models/download` handler shall add a new branch: when `entry.hfOptimumExport` is present, it shall (1) resolve a Python interpreter via a new `_findPythonWithOptimum()` helper (checks `import optimum, transformers`), (2) run `optimum.exporters.onnx.main_export(model_name_or_path=<repo>, output=<tmp dir>, task="image-classification")` via subprocess, (3) copy the resulting `<tmp dir>/model.onnx` to `server/models/<file>`, (4) remove the temporary directory. |
| FR-AGE-007 | If no Python interpreter satisfies the `optimum`/`transformers` check, the download shall fail with an error message naming the missing packages (`pip install -U optimum[exporters] transformers`). |
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
