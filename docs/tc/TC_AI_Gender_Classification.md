---
**Document:** TC_AI_Gender_Classification  
**Version:** 1.3  
**Status:** Draft  
**Date:** 2026-07-14  
**Parent SRS:** [SRS_AI_Gender_Classification](../srs/SRS_AI_Gender_Classification.md)  
**Parent Design:** [Design_AI_Gender_Classification](../design/Design_AI_Gender_Classification.md)  
**Test Script:** `test/api/gender_classification.test.js`, `test/api/model_catalog.test.js`  
---

# TC — AI Gender Classification

## 1. Traceability Matrix

| TC ID | SRS FR | Description |
|---|---|---|
| TC-GEN-001 | FR-GEN-001 | Catalog exposes exactly 2 `gender-classification` entries with required fields |
| TC-GEN-002 | FR-GEN-002, FR-GEN-003 | `_activeFileForEntry()` returns null when no gender-classification model loaded; at most 1 active |
| TC-GEN-003 | FR-GEN-004 | `insightface-genderage-gender` downloads via plain HTTP path (no conversion) |
| TC-GEN-004 | FR-GEN-005~008 | `vit-gender-classifier` download triggers the existing `hfOptimumExport` branch |
| TC-GEN-005 | FR-GEN-007 | Missing `optimum`/`transformers` Python env produces descriptive error |
| TC-GEN-006 | FR-GEN-009, FR-GEN-010 | `/models/switch` for gender-classification hot-swaps active model; 409 if file missing |
| TC-GEN-007 | FR-GEN-011, FR-GEN-012 | `GenderClassificationService.load()` sets `status: 'missing'` gracefully when file absent |
| TC-GEN-008 | FR-GEN-014, FR-GEN-015 | `classifyGender()` returns normalized `{value, confidence, source, modelId}` for both model variants |
| TC-GEN-009 | FR-GEN-016~018 | Face-crop-first, body-crop-fallback, silent skip when neither available |
| TC-GEN-010 | FR-GEN-019~022 | `genderClassification` toggle default false; zero cost when disabled; Track field propagation |
| TC-GEN-011 | FR-GEN-023~026 | Admin Dashboard type union/series/module-group updated; no bespoke UI needed |
| TC-GEN-012 | FR-GEN-029, FR-GEN-030 | `estimatedGender` persists to `detectionTracks` and `detectionSnapshots` |
| TC-GEN-013 | FR-GEN-031 | `estimatedGender` renders in all 4 client locations, distinct from `cloth.gender` |
| TC-GEN-014 | FR-GEN-032 | `services.genderClassification` diagnostic field present in `/api/analysis/metrics` (both the pipelineManager-backed and standalone-analysis-mode response shapes) |
| TC-GEN-015 | FR-GEN-027, FR-GEN-028 | **(Regression guard)** Both `pipelineManager.js`'s local loop AND `analysisApi.js`'s `POST /frame` handler actually call `GenderClassificationService` — the exact gap Age Estimation shipped with on 2026-07-12 |
| TC-GEN-016 | FR-GEN-034 | `analysisApi.js`'s own `detectionTracks` persistence code (3 sites) carries `estimatedGender` through — independent of, and in addition to, TC-GEN-015's estimation-call check |
| TC-GEN-017 | FR-GEN-035, FR-GEN-036 | ✅ **Implemented & passing (2026-07-15)** — ViT variant uses `image_mean=image_std=[0.5,0.5,0.5]`; InsightFace variant feeds RGB channel order and `input_std=128.0` — unit-level assertions pass (11/11); same fix class as TC-AGE-017, independently applied to `genderClassificationService.js` |
| TC-GEN-018 | FR-GEN-037 | (Planned) Shares TC-AGE-018's graph-introspection diagnostic (same `genderage.onnx` file) |
| TC-GEN-019 | FR-GEN-038 | (Planned) Shares TC-AGE-019's landmark-alignment behavior, applied to `classifyGender()` |
| TC-GEN-020 | FR-GEN-039 | (Planned) A confidence threshold policy exists so low-confidence (near-50/50) gender predictions are distinguishable from confident ones, rather than being displayed identically |

## 2. Test Cases

### TC-GEN-001: Catalog Completeness

**Pre-condition:** Analysis server running (`SERVER_MODE=analysis` or `combined`)
**Steps:**
1. `GET /api/analysis/models`
2. Filter `catalog` to entries with `family === 'gender-classification'`
3. Assert exactly 2 entries exist: ids `insightface-genderage-gender`, `vit-gender-classifier`
4. Assert both entries have `series === 'Gender Classification'`
5. Assert `insightface-genderage-gender` has no `hfOptimumExport`/`manualOnly` (downloadable directly)
6. Assert `vit-gender-classifier` has `hfOptimumExport` internally (stripped from client response) and is not `manualOnly`

**Expected:** All assertions pass.

### TC-GEN-002: Active Flag Isolation

**Steps:**
1. With neither model downloaded, `GET /api/analysis/models` → both gender-classification entries have `active: false`
2. Download+switch `insightface-genderage-gender` → its entry becomes `active: true`, `vit-gender-classifier` remains `active: false`
3. Switch to `vit-gender-classifier` → roles invert; never both `true` simultaneously

**Expected:** Family-scoped active flag behaves identically to `age-estimation`'s existing dual-entry pattern.

### TC-GEN-003: Direct ONNX Download

**Steps:**
1. Ensure `genderage.onnx` absent from `server/models/` (or already present from Age Estimation — download should be idempotent either way)
2. `POST /api/analysis/models/download { modelId: 'insightface-genderage-gender' }`
3. Poll `GET /api/analysis/models` until `downloading: false`

**Expected:** File appears at `server/models/genderage.onnx`; no Python subprocess invoked.

### TC-GEN-004: `hfOptimumExport` Conversion Path (Reused, Not New)

**Pre-condition:** Python environment with `optimum-onnx` + `transformers` installed
**Steps:**
1. Ensure `vit_gender_classifier.onnx` absent
2. `POST /api/analysis/models/download { modelId: 'vit-gender-classifier' }`
3. Observe `downloadProgress.status` transitions `'downloading' → 'converting' → 'done'`

**Expected:** `server/models/vit_gender_classifier.onnx` exists and passes `onnx.checker` (manual verification); temp export directory removed. This exercises the exact same code path as Age Estimation's TC-AGE-004 — no gender-specific conversion logic exists.

### TC-GEN-005: Missing Conversion Dependencies

**Steps:**
1. In an environment without `optimum`, trigger download for `vit-gender-classifier`

**Expected:** Download status becomes `'error'` with message mentioning `pip install -U optimum-onnx transformers` (shared `_findPythonWithOptimum()` behavior).

### TC-GEN-006: Runtime Switch

**Steps:**
1. Download both models
2. `POST /api/analysis/models/switch { modelId: 'insightface-genderage-gender' }` → 200, active reflects it
3. `POST /api/analysis/models/switch { modelId: 'vit-gender-classifier' }` → verify 409 semantics still apply to the shared file-existence pre-check

**Expected:** Matches `age-estimation`/`appearance-reid`/`cloth-par` switch semantics exactly.

### TC-GEN-007: Graceful Missing-Model Load

**Steps:**
1. Instantiate `GenderClassificationService` with a `modelPath` pointing to a non-existent file
2. Call `load()`

**Expected:** `status === 'missing'`, no exception thrown, `ready === false`.

### TC-GEN-008: Output Normalization

**Steps:**
1. With a stubbed/mocked ONNX session returning a known InsightFace-shaped `[female_logit, male_logit, age]` output, call `classifyGender()` → assert `{value, confidence, source, modelId}` shape, `value` matches the dominant logit
2. With a stubbed ViT-shaped 2-class output, call `classifyGender()` → assert `value` is one of `'female'`/`'male'` and `confidence` is a valid softmax probability

**Expected:** Both variants normalize to the same result shape.

### TC-GEN-009: Input Fallback

**Steps:**
1. Call the pipeline hook with a track that has a face bbox → assert `source: 'face'` used
2. Call with a track lacking a face bbox but having a person bbox → assert `source: 'body'`
3. Call with a track lacking both → assert no throw, no result attached

**Expected:** All three branches behave as specified in FR-GEN-016~018.

### TC-GEN-010: Opt-in Default and Zero Cost

**Steps:**
1. Confirm `analyticsConfig` default has `genderClassification: false`
2. With the toggle off, run a detection cycle and assert `GenderClassificationService.classifyGender` is never invoked
3. Turn the toggle on, re-run, assert it is invoked for `person` tracks
4. Confirm `tracking.js`'s `Track` class has an `estimatedGender` field and `ByteTracker.updateEstimatedGender()` exists

**Expected:** No behavior/perf change when disabled; propagation present when enabled.

### TC-GEN-011: Admin Dashboard Wiring

**Steps:**
1. Inspect `AdminUsersPage.tsx` — `ModelCatalogEntry.family` union includes `'gender-classification'`
2. `EXTENDED_SERIES_ORDER` and `PROPOSED_SERIES` include `'Gender Classification'`
3. `ADMIN_MODULE_GROUPS` includes a `genderClassification` item
4. Manually load AI Models tab in browser → confirm "Gender Classification" section renders with 2 rows and independent Activate/Download buttons

**Expected:** Matches the age-estimation precedent.

### TC-GEN-012: Persistence to `detectionTracks` / `detectionSnapshots`

**Steps:**
1. Enable `genderClassification`, download+activate a model, run a live camera with a person present
2. `GET /api/analysis/detection-tracks?cameraId=<id>` → inspect the resulting track
3. `GET /api/snapshots?cameraId=<id>` → open a snapshot's `attributes`

**Expected:** Both responses include `estimatedGender: {value, confidence, source, modelId}` for tracks/snapshots captured while the person was tracked and the model was ready.

### TC-GEN-013: Client Display (4 locations)

**Steps:**
1. With `estimatedGender` flowing, open the live Camera Grid view → confirm a fuchsia `gender male|female` label renders under the bbox in `CameraView.tsx`'s canvas overlay
2. Open Fullscreen Camera View → confirm the live detection list shows the same value with confidence %
3. Open the Detections tab → select the track → confirm the detail panel shows both "Gender (PAR)" (if `cloth.gender` present) and "Gender (Est.)" as visually distinct rows
4. Run a search matching the person → open the result detail → confirm a "Gender Classification" section appears with Estimated Gender / Source / Model fields

**Expected:** All 4 locations render only when `estimatedGender.value != null`; no location conflates `estimatedGender` with `cloth.gender`.

### TC-GEN-014: Diagnostic Field (Both Response Shapes)

**Steps:**
1. `GET /api/analysis/metrics` on a `combined`-mode instance (backed by `pipelineManager.getAnalysisMetrics()`) → assert `services.genderClassification` present
2. `GET /api/analysis/metrics` on a pure `analysis`-mode instance with no `pipelineManager` registered (the standalone fallback response in `analysisApi.js`) → assert `services.genderClassification` present there too

**Expected:** Both response shapes expose the diagnostic field — this module fixes both simultaneously, unlike Age Estimation which initially only got the `pipelineManager` one.

### TC-GEN-015: Dual Entry-Point Regression Guard

**Background:** Age Estimation shipped 2026-07-12 with the estimation call only in `pipelineManager.js`'s local-camera loop. `analysisApi.js`'s `POST /frame` handler — the entry point for `SERVER_MODE=streaming` delegated frames — never called `AgeEstimationService` at all until a same-day follow-up fix on 2026-07-14, discovered via a user report and live diagnostic logging (see `Design_AI_Age_Estimation.md` §12.1). Gender Classification is required to ship with both entry points from the start (FR-GEN-027/028).

**Steps:**
1. `grep -n "_genderClassification.classifyGender\|GenderClassificationService" server/src/services/pipelineManager.js` → must match (local loop call present)
2. `grep -n "_genderClassification.classifyGender\|GenderClassificationService" server/src/routes/analysisApi.js` → must match (streaming entry point call present)
3. With a `SERVER_MODE=streaming` instance pointed at an `analysis` server with `genderClassification` enabled and a model loaded, confirm `detectionTracks` on the **streaming** instance shows non-zero `estimatedGender` coverage — the exact check that, for Age Estimation, initially returned 0/200

**Expected:** Both grep checks match and the streaming-mode live check shows non-zero coverage on the first release — no follow-up fix required.

### TC-GEN-016: `analysisApi.js`'s Own `detectionTracks` Persistence Carries `estimatedGender` (2026-07-14, discovered alongside Age Estimation's TC-AGE-016)

**Background:** While investigating a user report that Age Estimation's Fullscreen Detections timeline showed no age (TC-AGE-016), it was found that `analysisApi.js`'s own `detectionTracks` persistence code (a separate copy from `pipelineManager.js`'s, per FR-GEN-029) omitted `estimatedGender` from all three of its sites (`ctx._trackMeta` create/update, 30s active-flush, track-completion flush) — even though TC-GEN-015 already confirmed the `classifyGender()` **call** was present in this handler from the initial release. Calling the estimator and persisting its result are two independent code paths in this file; TC-GEN-015 only guards the former.

**Automated (unit, source-inspection):** `test/api/gender_classification.test.js` Group F (`TC-GEN-016a/b/c`) mirrors `age_estimation.test.js`'s Group F exactly — isolates each of the three persistence sections by anchor comment and asserts each references `estimatedGender`.

**Manual / full-server verification:** Same procedure as TC-AGE-016's manual steps, substituting `estimatedGender` for `estimatedAge` and confirming the Detections timeline detail panel's "Gender (Est.)" row.

**Expected:** `estimatedGender` survives all three `analysisApi.js` persistence sites and reaches `GET /api/analysis/detection-tracks`, independent of TC-GEN-015's (already-passing) call-site check.

### TC-GEN-017: Corrected Preprocessing (✅ Implemented & passing 2026-07-15) / TC-GEN-018~019: Graph Diagnostic, Landmark Alignment (still Planned — Design doc §13)

**Background:** Production observation (2026-07-14) showed real camera traffic with a roughly 50:50 gender split being classified as majority-female by both the InsightFace and ViT variants. Root-cause investigation (shared with Age Estimation, since `insightface-genderage-gender` reads the same `genderage.onnx` file and both ViT models share the same HuggingFace processor bug pattern) found: (1) `rizvandwiki/gender-classification-2`'s actual `preprocessor_config.json` specifies `image_mean=image_std=[0.5,0.5,0.5]`, not the ImageNet statistics the code uses; (2) `deepinsight/insightface`'s reference implementation feeds RGB with `input_std=128.0`, while the code feeds BGR with `input_std=127.5` — of the two, the channel-order inversion is the most likely single cause of a *systematic, one-sided* bias (rather than random noise), since it consistently miscolors every input the same way.

**TC-GEN-017 steps (implemented 2026-07-15, `test/api/gender_classification.test.js` Group G):** Identical structure to TC-AGE-017, applied to `genderClassificationService.js`: unit tests asserting RGB channel placement and the corrected normalization constants for both variants, using the same solid-color JPEG fixture and stubbed-session approach. **Result:** `node test/api/gender_classification.test.js` — 11/11 passed, including `TC-GEN-017a`/`TC-GEN-017b`.

**TC-GEN-018/019 (🔲 still not implemented):** (b) a conditional graph-introspection check against the shared `genderage.onnx` (Phase 2); (c) landmark-based alignment when `landmarks` is supplied (Phase 3).

**Expected:** Tensor construction matches verified reference conventions (confirmed). With real model files redeployed to the remote analysis server and a small reference set with a known, balanced gender split, the classifier should no longer report majority-female — this live-accuracy check is not yet performed (requires redeployment to `192.168.214.254`).

### TC-GEN-020: Confidence Threshold for Uncertain Predictions (Planned)

**Steps:** Once a confidence-threshold policy (FR-GEN-039) is implemented, feed the service inputs engineered to produce near-50/50 softmax output and confirm the result is either omitted or flagged as low-confidence, distinct from a high-confidence prediction, at whichever layer (service or client) the implementation chooses to enforce the threshold.

**Expected:** A near-coin-flip prediction is never displayed with the same visual certainty as a confident one.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — TC-GEN-001~015. TC-GEN-015는 Age Estimation의 2026-07-14 사고(양쪽 진입점 미구현)를 재발 방지하기 위한 회귀 가드로 신규 설계 |
| 1.1 | 2026-07-14 | **TC-GEN-016 신규** — Age Estimation의 TC-AGE-016 조사 중 `analysisApi.js` 자체 `detectionTracks` 영속화 코드가 `estimatedGender`도 누락하고 있었음을 발견(호출 자체는 TC-GEN-015로 이미 보장됨). `test/api/gender_classification.test.js` Group F에 소스 검사 기반 자동 회귀 테스트 추가 |
| 1.2 | 2026-07-14 | **TC-GEN-017~020 신규 (Planned) — 정확도 개선 계획** — 실제 성비 50:50에 가까운데도 대부분 여성으로 분류되는 실사용 관측을 근거로 FR-GEN-035~039에 대응하는 테스트케이스 설계. 구현 전 계획 단계 — Design doc §13 참고 |
| 1.3 | 2026-07-15 | **TC-GEN-017 구현 완료 및 통과 표기** — `test/api/gender_classification.test.js` Group G 추가, 11/11 통과 확인. TC-GEN-018~020(Phase 2~3)는 여전히 미착수 |
