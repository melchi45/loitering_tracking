---
**Document:** TC_AI_Age_Estimation  
**Version:** 1.7  
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
| TC-AGE-012 | FR-AGE-027, FR-AGE-028 | `estimatedAge` persists to `detectionTracks` and `detectionSnapshots` |
| TC-AGE-013 | FR-AGE-029 | `estimatedAge` renders in all 4 client locations, distinct from `cloth.ageGroup` |
| TC-AGE-014 | FR-AGE-030~032 | `services.ageEstimation` diagnostic field present in `/api/analysis/metrics`; streaming-mode passthrough verified structurally (object spread, no field remap) |
| TC-AGE-015 | FR-AGE-033 | `analysisApi.js`'s `POST /frame` handler actually invokes `AgeEstimationService.estimateAge()` for streaming-delegated frames |
| TC-AGE-016 | FR-AGE-034 | `analysisApi.js`'s own `detectionTracks` persistence code (3 sites: `_trackMeta` create/update, 30s active-flush, track-completion flush) carries `estimatedAge`/`estimatedGender` through — independent of, and in addition to, TC-AGE-015's estimation-call check |
| TC-AGE-017 | FR-AGE-035, FR-AGE-036 | ✅ **Implemented & passing (2026-07-15)** — ViT variant uses `image_mean=image_std=[0.5,0.5,0.5]`; InsightFace variant feeds RGB channel order and `input_std=128.0` — unit-level assertions on the tensor construction pass (11/11); the conditional model-file-gated reference-image check remains skipped (no local model file) |
| TC-AGE-018 | FR-AGE-037 | (Planned) Graph-introspection diagnostic correctly detects baked-in vs external normalization on the actual `genderage.onnx` file, when present |
| TC-AGE-019 | FR-AGE-038 | (Planned) `estimateAge()` performs similarity-transform alignment when `landmarks` is supplied, and falls back to the existing bbox-crop behavior when it is not |
| TC-AGE-020 | FR-AGE-039 | (Planned) Body-sourced (`source: 'body'`) estimates remain distinguishable from face-sourced ones through the full pipeline to the client |

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

### TC-AGE-012: Persistence to `detectionTracks` / `detectionSnapshots`

**Steps:**
1. Enable `ageEstimation`, download+activate a model, run a live camera with a person present
2. `GET /api/analysis/detection-tracks?cameraId=<id>` → inspect the resulting track for the current session
3. `GET /api/snapshots?cameraId=<id>` → open a snapshot's `attributes`

**Expected:** Both responses include `estimatedAge: {value, bucket?, source, modelId}` for tracks/snapshots captured while the person was tracked and the model was ready. Absent when the model was not ready at capture time (no error, field simply omitted).

### TC-AGE-013: Client Display (4 locations)

**Steps:**
1. With `estimatedAge` flowing (per TC-AGE-012), open the live Camera Grid view → confirm a teal `age ~NN` label renders under the bbox in `CameraView.tsx`'s canvas overlay
2. Open Fullscreen Camera View → confirm the live detection list (`DetectionRow`) shows the same value
3. Open the Detections tab → select the track → confirm the detail panel shows both "Age Group (PAR)" (if `cloth.ageGroup` present) and "Age (Est.)" as visually distinct rows
4. Run a search matching the person → open the result detail → confirm an "Age Estimation" section appears with Estimated Age / Source / Model fields

**Expected:** All 4 locations render only when `estimatedAge.value != null`; no location conflates `estimatedAge` with `cloth.ageGroup`.

### TC-AGE-014: Diagnostic Field & Streaming Passthrough

**Steps:**
1. `GET /api/analysis/metrics` (on any `SERVER_MODE=analysis`/`combined` instance, or the proxied response on a `streaming` instance) → inspect `services` object
2. Assert `services.ageEstimation` is present with one of `'not_started' | 'missing' | 'loaded' | 'failed'` (not silently absent, as it was prior to 2026-07-14)
3. Code inspection (`server/src/services/pipelineManager.js` `_processRemoteResult()`): confirm `remoteTracked = result.tracked` and `allDetections = [...remoteTracked, ...]` use spread/direct-reference only — no `.map()` reconstructing a fixed field list that would silently drop `estimatedAge`
4. On a `streaming` instance where the remote analysis server has `services.ageEstimation === 'loaded'`, confirm `detectionTracks` on the streaming instance itself shows non-zero `estimatedAge` coverage (see Design doc §12.1 for the inverse — all-zero — diagnostic case)

**Expected:** The diagnostic field distinguishes "toggle off," "model not loaded on the server actually running inference," and "working" without needing to read server logs.

### TC-AGE-015: `analysisApi.js` `/frame` Handler Actually Calls `estimateAge()` (2026-07-14 regression guard)

**Background:** Prior to 2026-07-14, `analysisApi.js`'s `POST /frame` handler never called `AgeEstimationService.estimateAge()` at all — `_ageEstimation` was only referenced by the model-catalog switch/download/deactivate endpoints. This meant `estimatedAge` could never appear for any `SERVER_MODE=streaming` deployment, independent of toggle state, model-load state, or connection health — a structural gap, not a config/deployment issue. Confirmed via a temporary diagnostic log in `pipelineManager.js`'s `_processRemoteResult()` showing `remoteTracked` person objects with only `objectId,bbox,confidence,state,className,firstSeenAt` keys (no `color`/`cloth`/`face`/`estimatedAge`) despite `color`/`cloth` analytics being enabled — proving the remote response itself never carried any enrichment for that request, tracing back to a missing call in the handler.

**Steps:**
1. Static check: `grep -n "_ageEstimation.estimateAge" server/src/routes/analysisApi.js` → must return a match inside the `POST /frame` handler (not only inside `/models/switch`/`/models/download`/`/models/deactivate`)
2. With `ageEstimation` enabled and a model loaded on an `analysis`/`combined`-mode server, `POST /api/analysis/frame` (or via a live `streaming` client) with a frame containing a person
3. Inspect the JSON response's `tracked` array → assert at least one `person` entry has `estimatedAge: {value, source, modelId}` (bucket present only for the ViT model)
4. Confirm the module-level `_ageEstimateCache` throttles re-inference: two requests for the same `objectId` within `AGE_ESTIMATION_INTERVAL_MS` (4000ms) shall not both invoke `estimateAge()` (verify via call count on a spy, or via the identical `value` returned within the window)

**Expected:** `estimatedAge` is present in the `/frame` response's `tracked` array whenever `ageEstimation` is enabled and a model is ready — matching `pipelineManager.js`'s local-loop behavior exactly, closing the gap this TC guards against regressing.

### TC-AGE-016: `analysisApi.js`'s Own `detectionTracks` Persistence Carries `estimatedAge`/`estimatedGender` (2026-07-14 regression guard, root cause 2)

**Background:** After TC-AGE-015's fix landed, a user reported that the Fullscreen Camera View's Detections timeline (`DetectionsTimelineInline.tsx`) still showed no age when selecting a `person` track. Investigation found that `analysisApi.js` maintains its **own** `detectionTracks` persistence code — a separate copy from `pipelineManager.js`'s (already-correct, per FR-AGE-027) equivalent — spread across three sites: (1) the `ctx._trackMeta` create/update block that runs per processed frame, (2) the 30-second active-flush `fields` object for long-running in-view tracks, and (3) the `_completedFields` object built when a track ends. `estimatedAge`/`estimatedGender` were computed correctly by TC-AGE-015's fix and attached to `enrichedObjects`, and appeared correctly in live Socket.IO overlays, but none of these three persistence sites carried the two fields through — only `color`/`cloth` were. In `SERVER_MODE=streaming`, `analysisProxy.js` forwards `GET /api/analysis/detection-tracks` straight to the remote analysis server, so this is the exact code path backing what the Detections timeline displays.

**Automated (unit, source-inspection):** `test/api/age_estimation.test.js` Group F (`TC-AGE-016a/b/c`) reads `server/src/routes/analysisApi.js`'s source, isolates each of the three code sections by anchor comment, and asserts each one references `estimatedAge`/`estimatedGender` (`meta.estimatedAge`, `obj.estimatedAge ?? null`, `existing.estimatedAge = obj.estimatedAge`, etc., as appropriate to that site). This runs without a live server or model file and fails loudly if any of the three sites regresses (e.g., a future refactor that rebuilds one of these object literals from scratch and drops the two fields again).

**Manual / full-server verification:**
1. On a `SERVER_MODE=streaming` deployment with `ageEstimation` enabled and a model loaded on the remote analysis server, let a person walk through a camera's view for several seconds (long enough to trigger the 30s active-flush) and then leave frame (triggering the completion flush)
2. `GET /api/analysis/detection-tracks?cameraId=<id>&limit=20` → find the track for that person
3. Assert the record has a non-null `estimatedAge` (and `estimatedGender` if that toggle is also on) matching what was shown live in `FullscreenCameraView.tsx`'s `DetectionRow` during the walk-through
4. Open the Fullscreen Camera View → Detections tab → select that person's bar → confirm the detail panel (`DetectionsTimelineInline.tsx`) renders an "Age (Est.)" row

**Expected:** `estimatedAge`/`estimatedGender` survive all three `analysisApi.js` persistence sites and reach `GET /api/analysis/detection-tracks`, so the Detections timeline's person-detail panel shows age/gender exactly as the live overlay does — independent of whether the deployment is `combined`/`analysis` (backed by `pipelineManager.js`, FR-AGE-027) or `streaming` (backed by the remote `analysisApi.js`, FR-AGE-034).

### TC-AGE-017: Corrected Preprocessing Constants (✅ Implemented & passing 2026-07-15 — accuracy remediation, Design doc §13)

**Background:** Production observation (2026-07-14) showed InsightFace ages clustering near ~35 and ViT ages clustering in the `20-29` bucket almost universally — the classic signature of a model receiving out-of-distribution input. `WebFetch` against the actual HuggingFace `preprocessor_config.json` for `nateraw/vit-age-classifier` confirmed `image_mean=image_std=[0.5,0.5,0.5]`, not the ImageNet statistics the code currently uses; `deepinsight/insightface`'s `model_zoo/attribute.py` source confirmed the reference implementation feeds RGB (via `swapRB=True` on a BGR-sourced image) with `input_std=128.0`, while the current code feeds BGR with `input_std=127.5`.

**Steps (implemented 2026-07-15, `test/api/age_estimation.test.js` Group G):**
1. ✅ Unit: construct a small synthetic crop with known, distinct R/G/B channel values (a solid-color JPEG fixture, R=120/G=100/B=90) and assert the float32 tensor `estimateAge()` builds internally places the R channel value at the tensor's first channel-plane offset for both variants (i.e. RGB order, not BGR) — implemented by stubbing `session.run` to capture the input tensor.
2. ✅ Unit: for the ViT variant, assert the normalized value matches `(px/255 - 0.5) / 0.5` (not the ImageNet-normalized value).
3. ✅ Unit: for the InsightFace variant's non-baked-in-graph branch, assert pixel values normalize via `(px - 127.5) / 128.0` (not `/127.5`) — tolerance widened to 0.02 to absorb JPEG re-encoding quantization drift on the fixture, while still far tighter than the ~0.13-0.23 error a real channel-order/divisor bug would produce.
4. 🔲 **Not yet run** — Conditional/integration (skipped when `server/models/genderage.onnx`/`vit_age_classifier.onnx` are absent, as in this repo's dev environment, which is also `SERVER_MODE=streaming` — the actual model files live only on the remote analysis server `192.168.214.254`): run `estimateAge()` against 3-5 reference face images with roughly known ages and confirm predictions fall within a reasonable band (e.g. ±10 years) rather than clustering on a single value regardless of input. This step still requires the Phase 1 fix to be **redeployed to the remote analysis server** before it can be exercised against real inference.

**Result:** `node test/api/age_estimation.test.js` — 11/11 passed, including `TC-AGE-017a`/`TC-AGE-017b`. Tensor construction matches the verified reference conventions for both variants. Step 4 (live accuracy against real faces) remains unverified until the fix is redeployed to the remote analysis server.

### TC-AGE-018: Graph Normalization Auto-Detection (Planned)

**Steps:** When `server/models/genderage.onnx` is present, load it via the `onnx` package (or equivalent), scan the first ~8 graph nodes for `Sub`/`Mul` operations near the input, and assert the diagnostic reports whether normalization is baked in — mirroring `deepinsight/insightface`'s own auto-detection logic. Skipped (not failed) when the model file is absent.

**Expected:** The diagnostic's baked-in/external determination is available to `AgeEstimationService` (or a shared diagnostic utility) so FR-AGE-036's mean/std choice can be validated against the actual file rather than assumed.

### TC-AGE-019: Landmark-Based Face Alignment (Planned)

**Steps:** With a synthetic face crop and a known 5-point `landmarks` array, call `estimateAge()` with `landmarks` supplied and confirm the crop passed to `sharp` (or the resulting tensor) reflects a centered, scale-normalized alignment (`scale = input_size / (max(w,h) * 1.5)`) rather than a direct bbox stretch. Without `landmarks`, confirm the existing bbox-crop behavior is unchanged (backward compatible).

**Expected:** Alignment is applied only when landmarks are available; body-crop fallback (no landmarks) behavior is unaffected.

### TC-AGE-020: Body-Crop Source Distinguishability (Planned)

**Steps:** Confirm `source: 'body'` (already returned by `estimateAge()` when `isFaceCrop=false`) survives all persistence sites (FR-AGE-027/034) and is exposed to the client, so a future UI/analytics change can visually distinguish or filter out body-sourced (inherently less reliable) age estimates.

**Expected:** `source` is never dropped between the service, `detectionTracks`, `detectionSnapshots`, and the client display layer.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-12 | 초기 작성 — TC-AGE-001~011 |
| 1.1 | 2026-07-12 | TC-AGE-010 정정 — 실제 코드 패턴(Track 필드 + updater 메서드)으로 서술 수정 |
| 1.2 | 2026-07-14 | TC-AGE-004/005 정정 — `optimum[exporters]`가 `optimum-onnx`로 대체됨을 반영, TC-AGE-005에 자동 설치 재시도 동작 추가 |
| 1.3 | 2026-07-14 | TC-AGE-012~014 신규 — `detectionTracks`/`detectionSnapshots` 영속화, 클라이언트 4곳 표시, `services.ageEstimation` 진단 필드 + streaming 모드 패스스루 구조 검증 |
| 1.4 | 2026-07-14 | **TC-AGE-015 신규 (실제 근본 원인 회귀 방지)** — `analysisApi.js`의 `POST /frame` 핸들러가 Age Estimation을 전혀 호출하지 않던 실제 프로덕션 결함을 실시간 진단 로그로 확정, 수정 후 회귀 가드 테스트케이스 추가 |
| 1.5 | 2026-07-14 | **TC-AGE-016 신규 (근본 원인 2 회귀 방지)** — Fullscreen Detections 타임라인 나이 미표시 재보고를 조사한 결과 `analysisApi.js` 자체의 `detectionTracks` 영속화 코드(3곳)에 `estimatedAge`/`estimatedGender`가 누락되어 있었음을 확인. `test/api/age_estimation.test.js` Group F에 소스 검사 기반 자동 회귀 테스트 추가(서버 기동 불필요) |
| 1.6 | 2026-07-14 | **TC-AGE-017~020 신규 (Planned) — 정확도 개선 계획** — 나이가 대부분 ~35/`20-29`로 수렴하는 실사용 관측을 근거로 FR-AGE-035~039에 대응하는 테스트케이스 설계(정규화 상수·채널 순서 수정, 그래프 내장 정규화 진단, 랜드마크 정렬, body-crop 구분). 구현 전 계획 단계 — Design doc §13 참고 |
| 1.7 | 2026-07-15 | **TC-AGE-017 구현 완료 및 통과 표기** — `test/api/age_estimation.test.js` Group G 추가, 11/11 통과 확인(JPEG 재인코딩 오차 흡수를 위해 허용 오차 0.02로 조정). TC-AGE-018~020(Phase 2~3)는 여전히 미착수 |
