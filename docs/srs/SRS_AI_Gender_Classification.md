---
**Document:** SRS_AI_Gender_Classification  
**Version:** 1.3  
**Status:** Draft  
**Date:** 2026-07-14  
**Parent RFP:** [RFP_AI_Gender_Classification](../rfp/RFP_AI_Gender_Classification.md)  
**Parent PRD:** [PRD_AI_Gender_Classification](../prd/PRD_AI_Gender_Classification.md)  
**Child Design:** [Design_AI_Gender_Classification](../design/Design_AI_Gender_Classification.md)  
**Child TC:** [TC_AI_Gender_Classification](../tc/TC_AI_Gender_Classification.md)  
**Child Test Script:** `test/api/gender_classification.test.js`, `test/api/model_catalog.test.js`  
---

# SRS — AI Gender Classification

## 1. Introduction

This SRS specifies the software requirements for the Gender Classification AI module: its model catalog entries (reusing the existing `hfOptimumExport` PT→ONNX conversion strategy), the `GenderClassificationService`, face/body input fallback logic, dual frame-processing entry-point wiring, and Admin Dashboard integration.

## 2. Scope

Model catalog, download/conversion, and inference (§3.1-3.6) are applicable to `SERVER_MODE=analysis` and `SERVER_MODE=combined` for the model-loading half, but — unlike Age Estimation's original 2026-07-12 scope statement, which was corrected 2026-07-14 after a production gap — **this module's inference call is required in both `pipelineManager.js`'s local-camera loop AND `analysisApi.js`'s `POST /frame` handler from the initial implementation** (§3.8/FR-GEN-030), so `SERVER_MODE=streaming` deployments receive `estimatedGender` from the first release without a follow-up fix.

UI display and local persistence (§3.8) are applicable to all server modes — `CameraView.tsx`, `FullscreenCameraView.tsx`, `DetectionsTimelineInline.tsx`, and `SearchFullscreen.tsx` are shared client components used identically regardless of server mode.

## 3. Functional Requirements

### 3.1 Model Catalog

| ID | Requirement |
|---|---|
| FR-GEN-001 | `EXTENDED_CATALOG` in `server/src/routes/analysisApi.js` shall include two entries with `family: 'gender-classification'`, `series: 'Gender Classification'`: `insightface-genderage-gender` (file `genderage.onnx`) and `vit-gender-classifier` (file `vit_gender_classifier.onnx`). |
| FR-GEN-002 | `_activeFileForEntry()` shall include a `case 'gender-classification'` returning the basename of `_genderClassification.modelPath` when `_genderClassification.ready` is true, `null` otherwise — mirroring the `age-estimation` case exactly. |
| FR-GEN-003 | At most one `gender-classification` entry shall report `active: true` at any time (enforced structurally, same as `age-estimation`). |

### 3.2 Model Download

| ID | Requirement |
|---|---|
| FR-GEN-004 | `insightface-genderage-gender` shall download via the existing plain HTTP(S) `doDownload()` path (a `url` field, no `hfExport`/`requiresConversion`/`manualOnly`) — identical URL to Age Estimation's `insightface-genderage` entry, since it is the same file. |
| FR-GEN-005 | `vit-gender-classifier` shall carry a `hfOptimumExport: { repo: 'rizvandwiki/gender-classification-2' }` field instead of `url`/`hfExport`/`manualOnly`. |
| FR-GEN-006 | The `/models/download` handler's existing `entry.hfOptimumExport` branch (introduced for Age Estimation's ViT Age Classifier) shall handle this entry without modification — the branch is generic (keyed off `entry.hfOptimumExport`, not family), verified during implementation. |
| FR-GEN-007 | If no Python interpreter satisfies the `optimum.exporters.onnx`/`transformers` check, the download shall fail with the same descriptive error as Age Estimation's ViT model (shared `_findPythonWithOptimum()` helper, no duplication). |
| FR-GEN-008 | The `hfOptimumExport` subprocess shall have the same 5-minute timeout as all other `hfOptimumExport`/`hfExport`/`requiresConversion` paths (shared code, no new timeout constant). |

### 3.3 Runtime Model Switch

| ID | Requirement |
|---|---|
| FR-GEN-009 | `POST /api/analysis/models/switch` shall add `case 'gender-classification'`: lazy-instantiate `_genderClassification` if absent, then call `_genderClassification.reload(filePath)` — mirroring the `age-estimation` case. |
| FR-GEN-010 | Switching shall fail with HTTP 409 if the target file does not exist on disk (existing shared pre-check, unchanged). |

### 3.4 GenderClassificationService

| ID | Requirement |
|---|---|
| FR-GEN-011 | `server/src/services/genderClassificationService.js` shall export `class GenderClassificationService` with `constructor({modelPath})`, `load()`, `reload(filePath)`, `unload()`, `ready` getter, `status` getter (`'not_started' \| 'missing' \| 'loaded' \| 'failed'`) — structurally identical to `AgeEstimationService`. |
| FR-GEN-012 | `load()` shall set `status: 'missing'` (not an error) when the model file does not exist, allowing the pipeline to continue without gender classification. |
| FR-GEN-013 | The service shall maintain a per-model preprocessing/postprocessing table keyed by catalog id: input size (96 for InsightFace, 224 for ViT), channel order, normalization, and output parsing — both variants produce a 2-class softmax, unlike Age Estimation's regression-vs-bucket split. |
| FR-GEN-014 | `classifyGender(jpegBuffer, bbox, { isFaceCrop })` shall return `{ value: 'male' \| 'female', confidence: number, source: 'face' \| 'body', modelId: string }` or `null` if the service is not ready. |
| FR-GEN-015 | For the InsightFace variant, gender shall be derived from `argmax(output[0:2])` per the upstream `insightface` project's own `genderage.py` convention (index 0 = female, index 1 = male) — the age channel at `output[2]` (used by `AgeEstimationService`) is not read by this service. `confidence` shall be the softmax probability of the winning class for both model variants. |

### 3.5 Input Source Fallback

| ID | Requirement |
|---|---|
| FR-GEN-016 | When processing a `person` track, if a face bbox is already available for that track, the pipeline shall call `classifyGender()` with the face crop and `isFaceCrop: true`. |
| FR-GEN-017 | When no face bbox is available for the track, the pipeline shall fall back to the YOLOv8 person bbox and call `classifyGender()` with `isFaceCrop: false`. |
| FR-GEN-018 | If neither a face bbox nor a person bbox is available, gender classification shall be silently skipped for that frame — no error thrown. |

### 3.6 Configuration & Persistence

| ID | Requirement |
|---|---|
| FR-GEN-019 | `analyticsConfig.js`'s `DEFAULT_CONFIG` shall add `genderClassification: false` (opt-in, matching the `ageEstimation` convention). |
| FR-GEN-020 | `genderClassification` shall be added to `PERSON_ATTR_MODULES` so it is recognized as a valid person-attribute toggle by existing config validation. |
| FR-GEN-021 | `tracking.js`'s `Track` class shall carry an `estimatedGender` field and a corresponding `ByteTracker.updateEstimatedGender(objectId, estimatedGender)` method, mirroring `estimatedAge`/`updateEstimatedAge()` exactly. Not consumed by any similarity scorer in this phase. |
| FR-GEN-022 | Gender classification shall run only when `analyticsConfig.genderClassification === true`; when `false` (default), zero additional inference or crop extraction shall occur. |

### 3.7 Admin Dashboard

| ID | Requirement |
|---|---|
| FR-GEN-023 | `client/src/pages/admin/AdminUsersPage.tsx`'s `ModelCatalogEntry.family` union type shall include `'gender-classification'`. |
| FR-GEN-024 | `EXTENDED_SERIES_ORDER` shall include `'Gender Classification'`; `PROPOSED_SERIES` shall include `'Gender Classification'`. |
| FR-GEN-025 | `ADMIN_MODULE_GROUPS`'s `attributes` group shall include a `genderClassification` item describing both selectable models. |
| FR-GEN-026 | No new React component shall be required — the existing generic `AiModelsSection()` catalog table renders both `gender-classification` entries with independent Activate/Download controls. |

### 3.8 Dual Entry Point, UI Display, Persistence & Diagnostics

| ID | Requirement |
|---|---|
| FR-GEN-027 | **(Ship-blocking, learned from Age Estimation's 2026-07-14 incident)** `server/src/routes/analysisApi.js`'s `POST /frame` handler shall invoke `GenderClassificationService.classifyGender()` with the same face-preferred/body-fallback logic and a module-level per-track throttle cache (`_genderClassifyCache`/`GENDER_CLASSIFICATION_INTERVAL_MS`, mirroring `pipelineManager.js`'s instance-level equivalents), in the same initial change that adds the `pipelineManager.js` local-loop call (FR-GEN-028). This module must not ship with only one of the two entry points wired. |
| FR-GEN-028 | `pipelineManager.js`'s local-camera loop shall invoke `GenderClassificationService.classifyGender()` immediately after the existing Age Estimation block, using an identical face-preferred/body-fallback pattern and its own instance-level throttle cache (`this._genderClassifyCache`/`GENDER_CLASSIFICATION_INTERVAL_MS`). |
| FR-GEN-029 | `pipelineManager.js` shall carry `estimatedGender` through all `ctx._trackMeta` update sites (new-track creation, existing-track update, and each `detectionTracks` flush branch: completed/active/stale) so that a track's most recent `estimatedGender` reaches the `detectionTracks` DB table, mirroring the `estimatedAge` persistence pattern exactly. |
| FR-GEN-030 | `snapshotService.js`'s `saveSnapshot()` shall include `det.estimatedGender` in the persisted `attributes` object (when present), so `estimatedGender` reaches `detectionSnapshots` and is retrievable via `/api/search` and `/api/snapshots`. |
| FR-GEN-031 | The client shall render `estimatedGender` in exactly four locations when `estimatedGender.value != null`: (1) `CameraView.tsx`'s live canvas overlay, (2) `FullscreenCameraView.tsx`'s live `DetectionRow`, (3) `DetectionsTimelineInline.tsx`'s track detail panel, (4) `SearchFullscreen.tsx`'s search result detail panel. Each rendering shall be visually and label-distinct from the existing `cloth.gender` PA100k byproduct (labeled "Gender (PAR)") to avoid operator confusion between the two independent signals. |
| FR-GEN-032 | Both `pipelineManager.js`'s `getAnalysisMetrics()`/`getServiceStatus()` and `analysisApi.js`'s standalone `/metrics` route (the no-`pipelineManager` fallback path) shall include a `genderClassification` key in their respective `services` objects, reporting `GenderClassificationService.status`. |
| FR-GEN-033 | (Operational) When `estimatedGender` is absent from all recent `detectionTracks` on a `SERVER_MODE=streaming` instance despite `analyticsConfig.genderClassification === true` locally, the diagnostic procedure shall first verify (via code inspection or the `services.genderClassification` field on the remote analysis server) that the remote server is running code containing FR-GEN-027 — unlike Age Estimation, this should never be the root cause if FR-GEN-027 shipped in the initial release, but the check remains documented for completeness (see Design doc §12.1). |
| FR-GEN-034 | **(Corrects a gap discovered 2026-07-14 while investigating Age Estimation's FR-AGE-034)** `server/src/routes/analysisApi.js` maintains its own `detectionTracks` persistence code (`ctx._trackMeta` create/update, the 30-second active-flush `fields` object, and the track-completion `_completedFields` object) that is a **separate copy** from `pipelineManager.js`'s equivalent (FR-GEN-029) — not a shared function. Although FR-GEN-027 correctly wired the `classifyGender()` **call** into this handler from the initial release, all three persistence sites still omitted `estimatedGender` (and `estimatedAge`) — only `color`/`cloth` were carried through. All three sites shall carry `obj.estimatedGender`/`meta.estimatedGender` through to the persisted `detectionTracks` record. This is the same class of gap as FR-AGE-034 (calling the estimator correctly does not guarantee the separate persistence code copies it), except here it existed from the initial release rather than being introduced later. |

### 3.9 정확도 개선 (Accuracy Remediation — Planned, 2026-07-14, see Design doc §13, shared with Age Estimation)

| ID | Requirement |
|---|---|
| FR-GEN-035 | ✅ **Implemented (2026-07-15)** **(Corrects a confirmed preprocessing bug)** The ViT variant (`vit-gender-classifier`) shall normalize input pixels using `image_mean=[0.5,0.5,0.5]`, `image_std=[0.5,0.5,0.5]` — verified against the actual `preprocessor_config.json` published for `rizvandwiki/gender-classification-2` on HuggingFace — instead of the ImageNet statistics the current implementation uses. This is the same bug class as Age Estimation's FR-AGE-035, independently present in `genderClassificationService.js`'s own copy of the preprocessing code. |
| FR-GEN-036 | ✅ **Implemented (2026-07-15)** **(Corrects a confirmed preprocessing bug, most likely root cause of the observed female-majority bias)** The InsightFace variant (`insightface-genderage-gender`) shall feed the ONNX tensor in RGB channel order (matching `deepinsight/insightface`'s reference implementation) instead of BGR, and shall use `input_std=128.0` (not `127.5`) for the "no baked-in graph normalization" branch — identical fix to Age Estimation's FR-AGE-036, applied to `genderClassificationService.js`'s independent copy of the same preprocessing block reading the same `genderage.onnx` file. |
| FR-GEN-037 | 🔲 **Not yet implemented (Phase 2, shared with Age Estimation)** The graph-introspection diagnostic defined in Age Estimation's FR-AGE-037 (determining whether `genderage.onnx` has baked-in normalization) applies identically here, since both services read the same model file — one diagnostic suffices for both. |
| FR-GEN-038 | 🔲 **Not yet implemented (Phase 3)** `classifyGender()` shall accept an optional 5-point `landmarks` array and perform the same similarity-transform face alignment as Age Estimation's FR-AGE-038, instead of the current naive bbox-stretch-to-square. |
| FR-GEN-039 | 🔲 **Not yet implemented (Phase 3)** **(Gender-specific)** Because a near-50/50 binary classification is inherently prone to low-confidence "coin-flip" predictions even after FR-GEN-035/036 are fixed, the client and/or service layer shall support a confidence threshold below which `estimatedGender` is either not attached at all or is rendered with a distinct "uncertain" indicator, rather than being displayed identically to a high-confidence prediction. The specific threshold value and enforcement point (service-side vs. client-side) are left to the implementation phase — see Design doc §13.2 item H. |

## 4. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-GEN-001 | Gender classification inference shall not block the main detection loop for more than the per-model latency budget in RFP §7 (10ms InsightFace / 80ms ViT, CPU). |
| NFR-GEN-002 | A missing or failed-to-load model shall never crash `pipelineManager.js` or `analysisApi.js` — all service methods degrade to `null`/no-op. |
| NFR-GEN-003 | The InsightFace gender channel convention (`output[0]`=female, `output[1]`=male) shall be verified against the actual downloaded ONNX model before being trusted in production output — see Design doc Verification section. **(2026-07-14) This risk materialized in production** (near-50/50 real gender distribution classified as majority-female) — see §3.9 FR-GEN-035~039 and Design doc §13 for the confirmed root causes and remediation plan. |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — Gender Classification SRS, FR-GEN-001~033. Age Estimation의 2026-07-14 스트리밍 모드 갭(양쪽 진입점 미구현) 사고를 반영해 FR-GEN-027/028을 "동시 구현 필수(ship-blocking)"로 명시 — Age Estimation처럼 한쪽만 먼저 구현 후 후속 수정하는 것을 방지 |
| 1.1 | 2026-07-14 | **FR-GEN-034 신규** — Age Estimation의 FR-AGE-034 조사 중 `analysisApi.js`의 자체 `detectionTracks` 영속화 코드(3곳)가 `estimatedGender`도 함께 누락하고 있었음을 발견(FR-GEN-027의 호출 자체는 정상이었음 — 호출과 영속화는 별개 코드). 3곳 모두 필드 추가로 수정 |
| 1.2 | 2026-07-14 | **§3.9 신규 — 정확도 개선 계획, FR-GEN-035~039** — 실제 성비 50:50에 가까운데도 대부분 여성으로 분류되는 문제 보고를 조사, Age Estimation의 FR-AGE-035~038과 원인을 공유함을 확인(동일 `genderage.onnx`, 독립 전처리 코드 사본)하고 Gender 고유의 신뢰도 임계값 요구사항(FR-GEN-039) 추가 — 이번 개정은 계획만 반영, 구현은 후속 |
| 1.3 | 2026-07-15 | **FR-GEN-035/036 구현 완료 표기** — `genderClassificationService.js`에 실제 반영, TC-GEN-017 유닛 테스트 통과 확인. FR-GEN-037~039(Phase 2~3)는 여전히 미착수로 명시 |
