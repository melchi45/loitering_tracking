---
**Document:** TC_AI_Age_Estimation  
**Version:** 1.2  
**Status:** Draft  
**Date:** 2026-07-14  
**Parent SRS:** [SRS_AI_Age_Estimation](../srs/SRS_AI_Age_Estimation.md)  
**Parent Design:** [Design_AI_Age_Estimation](../design/Design_AI_Age_Estimation.md)  
**Test Script:** `test/api/age_estimation.test.js`, `test/api/model_catalog.test.js`  
---

# TC — AI Age Estimation

## 1. Traceability Matrix

| TC ID | SRS FR | Description |
|---|---|---|
| TC-AGE-001 | FR-AGE-001 | Catalog exposes exactly 2 `age-estimation` entries with required fields |
| TC-AGE-002 | FR-AGE-002, FR-AGE-003 | `_activeFileForEntry()` returns null when no age-estimation model loaded; at most 1 active |
| TC-AGE-003 | FR-AGE-004 | `insightface-genderage` downloads via plain HTTP path (no conversion) |
| TC-AGE-004 | FR-AGE-005~008 | `vit-age-classifier` download triggers `hfOptimumExport` branch |
| TC-AGE-005 | FR-AGE-007 | Missing `optimum`/`transformers` Python env produces descriptive error |
| TC-AGE-006 | FR-AGE-009, FR-AGE-010 | `/models/switch` for age-estimation hot-swaps active model; 409 if file missing |
| TC-AGE-007 | FR-AGE-011, FR-AGE-012 | `AgeEstimationService.load()` sets `status: 'missing'` gracefully when file absent |
| TC-AGE-008 | FR-AGE-014, FR-AGE-015 | `estimateAge()` returns normalized `{value, bucket?, source, modelId}` for both model variants |
| TC-AGE-009 | FR-AGE-016~018 | Face-crop-first, body-crop-fallback, silent skip when neither available |
| TC-AGE-010 | FR-AGE-019~022 | `ageEstimation` toggle default false; zero cost when disabled; sticky propagation in tracking.js |
| TC-AGE-011 | FR-AGE-023~026 | Admin Dashboard type union/series/module-group updated; no bespoke UI needed |

## 2. Test Cases

### TC-AGE-001: Catalog Completeness

**Pre-condition:** Analysis server running (`SERVER_MODE=analysis` or `combined`)
**Steps:**
1. `GET /api/analysis/models`
2. Filter `catalog` to entries with `family === 'age-estimation'`
3. Assert exactly 2 entries exist: ids `insightface-genderage`, `vit-age-classifier`
4. Assert both entries have `series === 'Age Estimation'`
5. Assert `insightface-genderage` has no `hfOptimumExport`/`manualOnly` (downloadable directly)
6. Assert `vit-age-classifier` has `hfOptimumExport` internally (stripped from client response) and is not `manualOnly`

**Expected:** All assertions pass.

### TC-AGE-002: Active Flag Isolation

**Steps:**
1. With neither model downloaded, `GET /api/analysis/models` → both age-estimation entries have `active: false`
2. Download+switch `insightface-genderage` → its entry becomes `active: true`, `vit-age-classifier` remains `active: false`
3. Switch to `vit-age-classifier` → roles invert; never both `true` simultaneously

**Expected:** Family-scoped active flag behaves identically to `cloth-par`'s existing dual-entry pattern (TC-MC-017).

### TC-AGE-003: Direct ONNX Download

**Steps:**
1. Ensure `genderage.onnx` absent from `server/models/`
2. `POST /api/analysis/models/download { modelId: 'insightface-genderage' }`
3. Poll `GET /api/analysis/models` until `downloading: false`

**Expected:** File appears at `server/models/genderage.onnx`; no Python subprocess invoked.

### TC-AGE-004: `hfOptimumExport` Conversion Path

**Pre-condition:** Python environment with `optimum-onnx` + `transformers` installed (installs `optimum.exporters.onnx` into the `optimum.*` namespace — the older `optimum[exporters]` extra no longer provides it)
**Steps:**
1. Ensure `vit_age_classifier.onnx` absent
2. `POST /api/analysis/models/download { modelId: 'vit-age-classifier' }`
3. Observe `downloadProgress.status` transitions `'downloading' → 'converting' → 'done'`

**Expected:** `server/models/vit_age_classifier.onnx` exists and passes `onnx.checker` (manual verification); temp export directory removed.

### TC-AGE-005: Missing Conversion Dependencies

**Steps:**
1. In an environment without `optimum`, trigger download for `vit-age-classifier`

**Expected:** Download status becomes `'error'` with message mentioning `pip install -U optimum-onnx transformers` (after an automatic install attempt into the first runnable interpreter, per `_findPythonWithOptimum()`, 2026-07-14).

### TC-AGE-006: Runtime Switch

**Steps:**
1. Download both models
2. `POST /api/analysis/models/switch { modelId: 'insightface-genderage' }` → 200, active reflects it
3. `POST /api/analysis/models/switch { modelId: 'vit-age-classifier' }` (before downloading a hypothetical 3rd file that doesn't exist) → verify 409 semantics still apply to the shared file-existence pre-check

**Expected:** Matches `appearance-reid`/`cloth-par` switch semantics exactly.

### TC-AGE-007: Graceful Missing-Model Load

**Steps:**
1. Instantiate `AgeEstimationService` with a `modelPath` pointing to a non-existent file
2. Call `load()`

**Expected:** `status === 'missing'`, no exception thrown, `ready === false`.

### TC-AGE-008: Output Normalization

**Steps:**
1. With a stubbed/mocked ONNX session returning a known InsightFace-shaped output, call `estimateAge()` → assert `{value, source, modelId}` shape, no `bucket`
2. With a stubbed ViT-shaped 9-class output, call `estimateAge()` → assert `bucket` is one of the 9 published labels and `value` equals the documented midpoint

**Expected:** Both variants normalize to the same result shape.

### TC-AGE-009: Input Fallback

**Steps:**
1. Call the pipeline hook with a track that has a face bbox → assert `source: 'face'` used
2. Call with a track lacking a face bbox but having a person bbox → assert `source: 'body'`
3. Call with a track lacking both → assert no throw, no result attached

**Expected:** All three branches behave as specified in FR-AGE-016~018.

### TC-AGE-010: Opt-in Default and Zero Cost

**Steps:**
1. Confirm `analyticsConfig` default has `ageEstimation: false`
2. With the toggle off, run a detection cycle and assert `AgeEstimationService.estimateAge` is never invoked
3. Turn the toggle on, re-run, assert it is invoked for `person` tracks
4. Confirm `tracking.js`'s `Track` class has an `estimatedAge` field and `ByteTracker.updateEstimatedAge()` exists, mirroring `updateColor`/`updateCloth`

**Expected:** No behavior/perf change when disabled; sticky propagation present when enabled.

### TC-AGE-011: Admin Dashboard Wiring

**Steps:**
1. Inspect `AdminUsersPage.tsx` — `ModelCatalogEntry.family` union includes `'age-estimation'`
2. `EXTENDED_SERIES_ORDER` and `PROPOSED_SERIES` include `'Age Estimation'`
3. `ADMIN_MODULE_GROUPS` includes an `ageEstimation` item
4. Manually load AI Models tab in browser → confirm "Age Estimation" section renders with 2 rows and independent Activate/Download buttons, with zero additional component code

**Expected:** Matches the cloth-par precedent (MEMORY.md `feedback_ai_model_catalog_doc_drift.md`).

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-12 | 초기 작성 — TC-AGE-001~011 |
| 1.1 | 2026-07-12 | TC-AGE-010 정정 — 실제 코드 패턴(Track 필드 + updater 메서드)으로 서술 수정 |
| 1.2 | 2026-07-14 | TC-AGE-004/005 정정 — `optimum[exporters]`가 `optimum-onnx`로 대체됨을 반영, TC-AGE-005에 자동 설치 재시도 동작 추가 |
