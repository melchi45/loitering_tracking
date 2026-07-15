---
**Document:** SRS_AI_Age_Estimation  
**Version:** 1.7  
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
| FR-AGE-033 | **(Corrects an actual production gap, 2026-07-14)** `server/src/routes/analysisApi.js`'s `POST /frame` handler — the entry point for frames delegated by a `SERVER_MODE=streaming` server — shall independently invoke `AgeEstimationService.estimateAge()` with the same face-preferred/body-fallback logic and per-track throttle (module-level `_ageEstimateCache`/`AGE_ESTIMATION_INTERVAL_MS`, mirroring `pipelineManager.js`'s instance-level equivalents) immediately after the shared `_attrPipeline.enrich()` call. Prior to this requirement, this handler never called `AgeEstimationService` during frame processing at all (the service was only referenced by the model-catalog switch/download/deactivate endpoints) — meaning `estimatedAge` could never appear for **any** `SERVER_MODE=streaming` deployment regardless of toggle state, model-load state, or connection health. FR-AGE-030's "pass-through unmodified" guarantee was structurally correct but moot, since the field was never attached in the first place. |
| FR-AGE-034 | **(Corrects a second, independent production gap, 2026-07-14 — Fullscreen Detections timeline still showed no age after FR-AGE-033)** `server/src/routes/analysisApi.js` maintains its own `detectionTracks` persistence code (`ctx._trackMeta` create/update, the 30-second active-flush `fields` object, and the track-completion `_completedFields` object) that is a **separate copy** from `pipelineManager.js`'s equivalent (FR-AGE-027) — not a shared function. All three sites shall carry `obj.estimatedAge`/`obj.estimatedGender` (and `meta.estimatedAge`/`meta.estimatedGender` at flush time) through to the persisted `detectionTracks` record, mirroring `color`/`cloth`. Prior to this requirement, FR-AGE-033 caused `estimatedAge`/`estimatedGender` to be computed and attached to `enrichedObjects` correctly, but all three persistence sites still omitted them — so `GET /api/analysis/detection-tracks` (which `DetectionsTimelineInline.tsx` queries, and which `analysisProxy.js` forwards unmodified from the remote analysis server in `SERVER_MODE=streaming`) never carried the field even though live Socket.IO overlays (`CameraView.tsx`, `FullscreenCameraView.tsx`) displayed it correctly. Both requirements must hold together for the Detections timeline's person-detail panel to show age. |

### 3.9 정확도 개선 (Accuracy Remediation — Planned, 2026-07-14, see Design doc §13)

| ID | Requirement |
|---|---|
| FR-AGE-035 | ✅ **Implemented (2026-07-15)** **(Corrects a confirmed preprocessing bug)** The ViT variant (`vit-age-classifier`) shall normalize input pixels using `image_mean=[0.5,0.5,0.5]`, `image_std=[0.5,0.5,0.5]` — verified against the actual `preprocessor_config.json` published for `nateraw/vit-age-classifier` on HuggingFace — instead of the ImageNet statistics (`mean=[0.485,0.456,0.406]`, `std=[0.229,0.224,0.225]`) the current implementation uses. |
| FR-AGE-036 | ✅ **Implemented (2026-07-15)** **(Corrects a confirmed preprocessing bug)** The InsightFace variant (`insightface-genderage`) shall feed the ONNX tensor in RGB channel order (matching `deepinsight/insightface`'s `model_zoo/attribute.py` reference implementation, which uses `cv2.dnn.blobFromImage(..., swapRB=True)` on a BGR-sourced image — i.e. RGB reaches the graph) instead of the BGR order the current implementation constructs. It shall also use `input_std=128.0` (not `127.5`) for the "no baked-in graph normalization" branch, matching the same reference implementation's default. |
| FR-AGE-037 | 🔲 **Not yet implemented (Phase 2)** A diagnostic capability shall exist to determine, for the actual downloaded `genderage.onnx` file, whether normalization is already baked into the graph (auto-detected the same way `deepinsight/insightface` does: scanning the first ~8 graph nodes for `Sub`/`Mul` operations near the input) — since this determines whether FR-AGE-036's `input_mean=127.5`/`input_std=128.0` is correct, or whether `input_mean=0.0`/`input_std=1.0` (raw pixel values) should be used instead. This cannot be resolved from documentation alone and requires inspecting the actual model file. |
| FR-AGE-038 | 🔲 **Not yet implemented (Phase 3)** `estimateAge()` shall accept an optional 5-point `landmarks` array (already produced by `faceService.js`'s SCRFD detector) and, when provided, perform a similarity-transform face alignment equivalent to `insightface`'s `face_align.transform()` (`scale = input_size / (max(bbox_w, bbox_h) * 1.5)`, centered on the face) before resizing to the model's input size — instead of the current naive `sharp().extract(bbox).resize(size,size,{fit:'fill'})`, which neither centers nor preserves aspect ratio. When `landmarks` is absent (body-crop fallback), the existing bbox-crop behavior remains as-is. |
| FR-AGE-039 | 🔲 **Not yet implemented (Phase 3)** Because both InsightFace GenderAge and ViT Age Classifier are trained on face crops, an estimate produced from a body (non-face) bbox fallback is a known out-of-distribution input. The returned result shall be extensible to carry a reliability indicator (e.g. a `source: 'body'` field, already present) so downstream consumers (UI, search) can distinguish face-sourced from body-sourced estimates; no numeric confidence threshold is defined for age (unlike gender's FR-GEN-039) since age is a regression/bucket output without a natural confidence score for InsightFace. |

## 4. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-AGE-001 | Age estimation inference shall not block the main detection loop for more than the per-model latency budget in RFP §7 (10ms InsightFace / 80ms ViT, CPU). |
| NFR-AGE-002 | A missing or failed-to-load model shall never crash `pipelineManager.js` — all service methods degrade to `null`/no-op. |
| NFR-AGE-003 | Exact numeric output contracts (InsightFace output tensor layout, age scale factor) shall be verified against the actual downloaded ONNX model before being trusted in production output — see Design doc Verification section. **(2026-07-14) This risk materialized in production** (ages clustering near ~35/`20-29`) — see §3.9 FR-AGE-035~039 and Design doc §13 for the confirmed root causes and remediation plan. |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-12 | 초기 작성 — Age Estimation SRS, FR-AGE-001~026 |
| 1.1 | 2026-07-12 | FR-AGE-021 정정 — 존재하지 않는 "sticky-attribute 목록" 대신 실제 코드 패턴(Track 필드 + `updateEstimatedAge()`, `color`/`cloth`/`accessories`와 동일 구조)으로 서술 수정 |
| 1.2 | 2026-07-14 | FR-AGE-006/007 정정 — ONNX export 기능이 `optimum[exporters]`(base `optimum` extra, 실제로는 더 이상 `optimum.exporters.onnx` 미제공)에서 별도 패키지 `optimum-onnx`로 이전됨을 반영(`huggingface/optimum-onnx`). 검증 스크립트도 `import optimum` 대신 `import optimum.exporters.onnx`로 정정 |
| 1.3 | 2026-07-14 | §2 Scope 정정 — UI 표시·로컬 영속화는 `SERVER_MODE=streaming`에도 적용됨을 명시(모델 추론만 원격 위임). §3.8 신규 — FR-AGE-027~032: `detectionTracks`/`detectionSnapshots` 영속화, 클라이언트 4곳 표시, streaming 모드 필드 통과 보장, `getAnalysisMetrics()`의 `services.ageEstimation` 진단 필드 |
| 1.4 | 2026-07-14 | **FR-AGE-033 신규 (실제 근본 원인)** — `analysisApi.js`의 `POST /frame` 핸들러(streaming 위임 프레임 처리 경로)에 Age Estimation이 전혀 구현되어 있지 않았음이 실시간 진단으로 확정됨. FR-AGE-030의 "통과 보장"은 애초에 필드가 부착되지 않아 무의미했음 — `analysisApi.js`에 동일 face/body 폴백 로직 신규 추가로 수정 |
| 1.5 | 2026-07-14 | **FR-AGE-034 신규 (두 번째 독립 결함)** — FR-AGE-033 수정 후에도 Fullscreen Detections 타임라인에 나이가 표시되지 않는다는 재보고를 받아 조사한 결과, `analysisApi.js`가 `pipelineManager.js`와 별개로 보유한 `detectionTracks` 영속화 코드(3곳)에 `estimatedAge`/`estimatedGender`가 빠져 있었음을 확인 — `SERVER_MODE=streaming`에서는 `analysisProxy.js`가 이 (누락된) 원격 레코드를 그대로 프록시하므로 영향이 직접적임. 3곳 모두 필드 추가로 수정 |
| 1.6 | 2026-07-14 | **§3.9 신규 — 정확도 개선 계획, FR-AGE-035~039** — 실사용 관측(나이 대부분 ~35/`20-29`로 수렴)으로 NFR-AGE-003의 미검증 리스크가 현실화됨을 확인. HuggingFace `preprocessor_config.json`/`deepinsight/insightface` 소스 대조로 확인된 전처리 버그(ViT 정규화 상수, InsightFace 채널 순서·표준편차) 및 구조적 위험(랜드마크 정렬 미구현, body-crop 폴백)에 대한 요구사항 신설 — 이번 개정은 계획만 반영, 구현은 후속(Design doc §13 참고) |
| 1.7 | 2026-07-15 | **FR-AGE-035/036 구현 완료 표기** — `ageEstimationService.js`에 실제 반영, TC-AGE-017 유닛 테스트 통과 확인. FR-AGE-037~039(Phase 2~3)는 여전히 미착수로 명시 |
