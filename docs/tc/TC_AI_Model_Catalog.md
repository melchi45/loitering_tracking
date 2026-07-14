---
**Document:** TC_AI_Model_Catalog  
**Version:** 2.5  
**Status:** Draft  
**Date:** 2026-07-14  
**Parent SRS:** [SRS_AI_Model_Catalog](../srs/SRS_AI_Model_Catalog.md)  
**Parent Design:** [Design_AI_Model_Catalog](../design/Design_AI_Model_Catalog.md)  
**Test Script:** `test/api/model_catalog.test.js`  
---

# TC — AI Model Catalog & Runtime Model Switching

## 1. Traceability Matrix

| TC ID | SRS FR | Description |
|---|---|---|
| TC-MC-001 | FR-MC-001, FR-MC-021 | Catalog returns 20 YOLO detector entries with required fields |
| TC-MC-002 | FR-MC-002, FR-MC-003 | exists/active flags reflect filesystem state |
| TC-MC-003 | FR-MC-004, FR-MC-005 | Converting flag during YOLO12/PPE/Fire-Smoke export |
| TC-MC-004 | FR-MC-006~010 | Download direct ONNX (YOLOv8n) |
| TC-MC-005 | FR-MC-010 | Concurrent download rejected with HTTP 409 |
| TC-MC-006 | FR-MC-016~020 | Switch active model |
| TC-MC-007 | FR-MC-017 | Switch unknown model returns HTTP 400 |
| TC-MC-008 | FR-MC-018 | Switch non-downloaded model returns HTTP 409 |
| TC-MC-009 | FR-MC-011~015 | YOLO12 download: PT fetch → converting → ONNX |
| TC-MC-010 | FR-MC-012~013 | Python fallback detection chain |
| TC-MC-011 | FR-MC-022 | All YOLO detector entries compatible with DetectionService output shape |
| TC-MC-012 | FR-MC-001, FR-MC-021 | Catalog includes all non-detector families (face/ppe/fire-smoke/cloth-par/human-parsing/appearance-reid) |
| TC-MC-013 | FR-MC-015b | Download request for a `manualOnly` entry (cloth-PAR) returns HTTP 409 with `docRef` |
| TC-MC-014 | FR-MC-011b | PPE/Fire-Smoke download resolves `.pt` via huggingface_hub then converts to ONNX |
| TC-MC-015 | FR-MC-003, FR-MC-016 | Switching one family's active model does not change another family's active model |
| TC-MC-016 | FR-MC-009 | Download request for an already-downloaded entry short-circuits with `{ already: true }` |
| TC-MC-017 | FR-MC-021 | cloth-par family exposes exactly 2 entries: PromptPAR (`openpar-pa100k`, not manualOnly) and OpenPAR (`openpar-resnet50-pa100k`, manualOnly) |
| TC-MC-018 | FR-MC-018c | `reloadPar()` rejects PromptPAR and logs `PromptPAR 수행 불가능: ...` when free system RAM is below `PROMPTPAR_MIN_FREE_MEM_MB` |
| TC-MC-019 | FR-MC-018c | `checkPromptParMemory()` gate check is a no-op for OpenPAR and passes when free RAM is comfortably above the floor |
| TC-MC-020 | FR-MC-021 | age-estimation family exposes exactly 2 entries: InsightFace GenderAge (`insightface-genderage`, direct `url`) and ViT Age Classifier (`vit-age-classifier`, `hfOptimumExport`) — see `TC_AI_Age_Estimation.md` TC-AGE-001 for full detail |
| TC-MC-021 | FR-MC-016 | `age-estimation` switch case hot-swaps `AgeEstimationService` independently of every other family — see `TC_AI_Age_Estimation.md` TC-AGE-006 |
| TC-MC-022 | FR-MC-015c | `openpar-pa100k` download runs `exportPromptPAR.py` via `pyExport`: dependency/GPU/`git` pre-checks fail fast with a clear error; on success the script's `Stage N/7` stdout markers drive `_downloadProgress.percent` |
| TC-MC-023 | FR-MC-026, FR-MC-028 | `POST /api/analysis/models/deactivate` unloads the active model for each of the 8 extended families (releases the ONNX session, resets ready/status), and `GET /api/analysis/models` reports `active: false` for every entry in that family afterward |
| TC-MC-024 | FR-MC-027 | Deactivate request for a YOLO detector entry (`family` undefined) returns HTTP 400 without touching `_detector` |
| TC-MC-025 | FR-MC-029, FR-MC-030 | Deactivate succeeds as a no-op when nothing is active for a family (no file downloaded / `AttributePipeline` not loaded), and does not modify the corresponding `analyticsConfig` toggle |
| TC-MC-026 | FR-MC-031 | A successful `/models/switch` persists `{ family: modelId }` to the `settings` table (row id `activeModels`) |
| TC-MC-027 | FR-MC-032 | A successful `/models/deactivate` persists `{ family: null }`, distinct from an absent key |
| TC-MC-028 | FR-MC-031, FR-MC-032 | A failed switch/deactivate (400/409/500) does not write anything to the `activeModels` row |
| TC-MC-029 | FR-MC-033 | `_restoreActiveModels()` replays a persisted `modelId` via the same code path as a live switch, and a persisted `null` via the same code path as a live deactivate (except the YOLO detector) |
| TC-MC-030 | FR-MC-034 | `_restoreActiveModels()` logs a warning and leaves the family on its default when the persisted `modelId` is missing from `ALL_MODELS` or its file no longer exists on disk — startup does not throw |

## 2. Test Cases

### TC-MC-001: Catalog Completeness

**Pre-condition:** Analysis server running  
**Steps:**
1. `GET /api/analysis/models`
2. Assert HTTP 200
3. Assert response has `catalog` array; filtering to entries with no `family` (YOLO detector) yields exactly 20 entries
4. Assert 5 detector entries with `series === 'YOLO26'`
5. Assert 5 detector entries with `series === 'YOLOv8'`
6. Assert 5 detector entries with `series === 'YOLO11'`
7. Assert 5 detector entries with `series === 'YOLO12'`
8. For each detector entry, assert fields: `id, label, series, mAP, cpuMs, t4Ms, params, flops, exists, active, downloading, converting`

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-002: Exists/Active Flags

**Pre-condition:** `server/models/yolov8n.onnx` exists  
**Steps:**
1. `GET /api/analysis/models`
2. Find entry with `id === 'yolov8n'`
3. Assert `exists === true`
4. Assert `active === true` (default model at startup)
5. Find entry with `id === 'yolo12n'`
6. Assert `exists === false` (not yet downloaded)

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-003: Converting Flag During PT→ONNX Export

**Pre-condition:** Server running; Python with `ultralytics` (+ `huggingface_hub` for PPE/Fire-Smoke) available  
**Steps:**
1. `POST /api/analysis/models/download { modelId: 'yolo12n' }` (or `'yolov8m-ppe'` for the hfExport path)
2. While conversion is in progress, `GET /api/analysis/models`
3. Find the corresponding entry
4. Assert `converting === true` AND `downloading === true`

**Expected:** PASS  
**Note:** Timing-sensitive; may need polling  
**Priority:** P2

---

### TC-MC-004: Download Direct ONNX

**Pre-condition:** `server/models/yolov8s.onnx` does NOT exist  
**Steps:**
1. `POST /api/analysis/models/download { modelId: 'yolov8s' }`
2. Assert HTTP 200 `{ ok: true }` (async start)
3. Poll `GET /api/analysis/models` until the `yolov8s` entry's `exists === true`
4. Assert file exists at `server/models/yolov8s.onnx`

**Expected:** PASS  
**Timeout:** 120 seconds  
**Priority:** P1

---

### TC-MC-005: Concurrent Download Rejected

**Pre-condition:** `yolov8s.onnx` download in progress  
**Steps:**
1. `POST /api/analysis/models/download { modelId: 'yolov8s' }` (first — starts download)
2. Immediately `POST /api/analysis/models/download { modelId: 'yolov8s' }` (second)
3. Assert second response HTTP 409

**Expected:** PASS  
**Priority:** P2

---

### TC-MC-006: Switch Active Model

**Pre-condition:** Both `yolov8n.onnx` and `yolov8s.onnx` exist  
**Steps:**
1. `POST /api/analysis/models/switch { modelId: 'yolov8s' }`
2. Assert HTTP 200 with `{ ok: true, active: 'YOLOv8s', file: 'yolov8s.onnx' }`
3. `GET /api/analysis/models`
4. Assert `yolov8s.active === true`
5. Assert `yolov8n.active === false`

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-007: Switch Unknown Model

**Pre-condition:** Server running  
**Steps:**
1. `POST /api/analysis/models/switch { modelId: 'nonexistent' }`
2. Assert HTTP 400
3. Assert response has `error` field

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-008: Switch Non-Downloaded Model

**Pre-condition:** `yolo12n.onnx` does NOT exist  
**Steps:**
1. `POST /api/analysis/models/switch { modelId: 'yolo12n' }`
2. Assert HTTP 409 (`{ error: 'Model file not downloaded yet', file }`)
3. Assert response has `error` field

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-009: YOLO12 Full Download Pipeline

**Pre-condition:** Python with ultralytics ≥ 8.3 available; network access to GitHub  
**Steps:**
1. Ensure `server/models/yolo12n.onnx` does NOT exist
2. `POST /api/analysis/models/download { modelId: 'yolo12n' }`
3. Assert HTTP 200
4. Poll until `GET /api/analysis/models` shows the `yolo12n` entry's `exists === true`
5. Assert `server/models/yolo12n.onnx` exists
6. Assert `server/models/yolo12n.pt` does NOT exist (cleaned up)

**Expected:** PASS  
**Timeout:** 10 minutes  
**Priority:** P2 (requires Python + network)

---

### TC-MC-010: Python Fallback Detection

**Pre-condition:** PYTHON_EXEC_LINUX points to Python without `_lzma`; `/usr/bin/python3` has ultralytics  
**Steps:**
1. Set `PYTHON_EXEC_LINUX` to a Python that fails `import ultralytics`
2. Run model catalog download for YOLO12n
3. Assert download succeeds (server fell back to `/usr/bin/python3`)

**Expected:** PASS  
**Note:** Environment-specific test; verify by checking server log for fallback message  
**Priority:** P2

---

### TC-MC-011: Model Output Shape Compatibility

**Pre-condition:** Any downloaded YOLO detector model (n variant)  
**Steps:**
1. Switch to the downloaded model
2. Submit a test frame `POST /api/analysis/process` with a JPEG
3. Assert HTTP 200 response with `detections` array
4. Assert no inference errors in server logs

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-012: Extended Catalog Composition

**Pre-condition:** Analysis server running  
**Steps:**
1. `GET /api/analysis/models`
2. Assert the set of distinct `family` values across `catalog` includes all of: `face-detection`, `face-recognition`, `ppe`, `fire-smoke`, `cloth-par`, `human-parsing`, `appearance-reid`, `age-estimation`
3. Assert at least one entry has `manualOnly === true`
4. Assert no entry ever exposes a raw `url` field in the response (always `undefined`)

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-013: Manual-Only Download Rejected

**Pre-condition:** Catalog contains a `manualOnly` entry (`openpar-resnet50-pa100k`, the OpenPAR ResNet50 cloth-par alternative)  
**Steps:**
1. `POST /api/analysis/models/download { modelId: 'openpar-resnet50-pa100k' }`
2. Assert HTTP 409
3. Assert response has `error` and `docRef` fields

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-014: HuggingFace .pt → ONNX Export (PPE / Fire & Smoke)

**Pre-condition:** Python with `ultralytics` + `huggingface_hub` available; network access to HuggingFace Hub; `server/models/yolov8m_ppe.onnx` does NOT exist  
**Steps:**
1. `POST /api/analysis/models/download { modelId: 'yolov8m-ppe' }`
2. Assert HTTP 200
3. While in progress, `GET /api/analysis/models` shows `converting === true` for the entry
4. Poll until the entry's `exists === true`
5. Assert `server/models/yolov8m_ppe.onnx` exists and no stray `.pt` file was left in `server/models/`

**Expected:** PASS  
**Timeout:** 5 minutes  
**Priority:** P2 (requires Python + network)

---

### TC-MC-015: Per-Family Switch Independence

**Pre-condition:** A YOLO detector model and a PPE model both exist and are downloaded  
**Steps:**
1. `POST /api/analysis/models/switch { modelId: 'yolov8m-ppe' }`
2. Assert HTTP 200
3. `GET /api/analysis/models`
4. Assert the YOLO detector's `active` entry (`family` undefined) is unchanged from before step 1
5. Assert `yolov8m-ppe.active === true`

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-016: Already-Downloaded Short-Circuit

**Pre-condition:** Any catalog entry's file already exists in `server/models/`  
**Steps:**
1. `POST /api/analysis/models/download { modelId: <existing entry> }`
2. Assert HTTP 200 `{ ok: true, already: true }`
3. Assert no download/conversion was started (`_downloadProgress` unchanged)

**Expected:** PASS  
**Priority:** P2

---

### TC-MC-017: cloth-par Family Composition (PromptPAR + OpenPAR)

**Pre-condition:** Analysis server running  
**Steps:**
1. `GET /api/analysis/models`
2. Filter `catalog` to `family === 'cloth-par'` — assert exactly 2 entries
3. Assert one entry has `id === 'openpar-pa100k'` (PromptPAR) and `manualOnly` is falsy
4. Assert the other has `id === 'openpar-resnet50-pa100k'` (OpenPAR) and `manualOnly === true`

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-018: PromptPAR Memory Gate Rejects Activation Below the Floor

**Pre-condition:** None (unit test against `server/src/services/colorClothService.js` — no running server or real ONNX file required, since the gate check runs before any filesystem/ONNX access)  
**Steps:**
1. Monkey-patch `os.freemem()` to return 1GB (below the default 2048MB floor)
2. Call `checkPromptParMemory()` — assert `ok === false`
3. Call `new ColorClothService().reloadPar('server/models/openpar_pa100k.onnx')` — assert it throws an error whose message contains `PromptPAR`
4. Assert `_parReady` remains `false` on the service instance after the rejection

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-019: OpenPAR Is Never Memory-Gated; Gate Passes Above the Floor

**Pre-condition:** None (unit test, same as TC-MC-018)  
**Steps:**
1. With `os.freemem()` patched to 1GB, call `_checkPromptParGate('server/models/openpar_resnet50_pa100k.onnx')` — assert it returns `true` (OpenPAR's filename is not in the gated set)
2. With `os.freemem()` patched to 8GB, call `checkPromptParMemory()` — assert `ok === true`

**Expected:** PASS  
**Priority:** P2

---

### TC-MC-020: age-estimation Family Composition (InsightFace GenderAge + ViT Age Classifier)

**Pre-condition:** Analysis server running  
**Steps:**
1. `GET /api/analysis/models`
2. Filter `catalog` to `family === 'age-estimation'` — assert exactly 2 entries
3. Assert one entry has `id === 'insightface-genderage'` and no `manualOnly`
4. Assert the other has `id === 'vit-age-classifier'` and no `manualOnly` (its `hfOptimumExport` field is stripped from the client response, but the download endpoint must still route it correctly — see TC-AGE-004)

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-021: age-estimation Switch Independence

**Pre-condition:** Both age-estimation models downloaded; a YOLO detector model also downloaded  
**Steps:**
1. `POST /api/analysis/models/switch { modelId: 'insightface-genderage' }` → HTTP 200
2. `GET /api/analysis/models` — assert `insightface-genderage.active === true`, YOLO detector's active entry unchanged
3. `POST /api/analysis/models/switch { modelId: 'vit-age-classifier' }` → HTTP 200
4. Assert `vit-age-classifier.active === true` and `insightface-genderage.active === false`

**Expected:** PASS — matches the family-scoped independence already verified for `cloth-par` (TC-MC-015, TC-MC-017)  
**Priority:** P1

---

### TC-MC-022: PromptPAR pyExport Download Pipeline

**Pre-condition:** `openpar-pa100k`'s file does NOT exist in `server/models/`  
**Steps (pre-flight failure paths — no GPU/network required):**
1. With `torch`/`onnx`/`gdown` NOT importable by any candidate interpreter, `POST /api/analysis/models/download { modelId: 'openpar-pa100k' }` → `_downloadProgress` ends in `status: 'error'` with a message naming the missing packages
2. With those importable but `git` not on `PATH`, same request → `_downloadProgress` ends in `status: 'error'` mentioning `git`

**Steps (full pipeline — GPU + network required, manual/offline only):**
3. On a CUDA-capable machine with `git`, `torch`, `torchvision`, `onnx`, `onnxruntime`, `gdown` installed: `POST /api/analysis/models/download { modelId: 'openpar-pa100k' }`
4. Poll `GET /api/analysis/models` — assert `downloading: true`, `downloadPercent` increases in roughly the stage sequence (clone → ViT backbone → checkpoint → build → export → verify)
5. On completion (up to 30 min), assert `server/models/openpar_pa100k.onnx` exists and `exists: true`
6. Server log / subprocess stdout contains a `Max abs diff (PyTorch vs ONNX): <N>` line with `N < 1e-2`

**Expected:** PASS  
**Note:** Steps 3-6 require a GPU + real network access to github.com and drive.google.com — not run in the standard CI test environment; verified by design/code review against the real `Event-AHU/OpenPAR` repository structure as of 2026-07-12, not executed end-to-end. Steps 1-2 (pre-flight checks) can run anywhere.  
**Priority:** P2 (steps 1-2), P3/manual (steps 3-6)

---

### TC-MC-023: Deactivate Unloads the Active Model Per Family

**Pre-condition:** Unit test against the service classes directly (`faceService.js`, `protectiveEquipService.js`, `fireSmokeService.js`, `colorClothService.js`, `appearanceReidService.js`, `ageEstimationService.js`) — no running server or real ONNX file required, since `unload()`/`unloadDetector()`/`unloadRecognizer()`/`unloadPar()`/`unloadHumanParsing()` only touch in-memory state and a stubbed session object.
**Steps (repeat for each of the 8 extended families):**
1. Construct the service, set its ready flag `true` and its session field to a stub object with a `release()` spy
2. Call the corresponding unload method
3. Assert the stub's `release()` was called exactly once
4. Assert the ready flag (and `status`, where applicable) is now `false`/`'not_started'`, and the session field is `null`

**Expected:** PASS
**Priority:** P1

---

### TC-MC-024: Deactivate Rejects the YOLO Detector Family

**Pre-condition:** Analysis server running; a YOLO detector model is active
**Steps:**
1. Find any catalog entry with `family === undefined` (e.g. `yolov8n`)
2. `POST /api/analysis/models/deactivate { modelId: 'yolov8n' }`
3. Assert HTTP 400 with an `error` field mentioning the core detection pipeline requirement
4. `GET /api/analysis/models` — assert the YOLO detector's `active` entry is unchanged

**Expected:** PASS
**Priority:** P1

---

### TC-MC-025: Deactivate Is a Safe No-Op When Nothing Is Active

**Pre-condition:** A `cloth-par` model file exists but has never been activated (or `AttributePipeline` has not finished loading)
**Steps:**
1. `POST /api/analysis/models/deactivate { modelId: 'openpar-pa100k' }`
2. Assert HTTP 200 `{ ok: true, deactivated: <label> }` (no exception, no 409/500)
3. `GET /api/analytics/config` — assert the `cloth` toggle value is unchanged from before the request (deactivate never touches `analyticsConfig`)

**Expected:** PASS
**Priority:** P2

---

### TC-MC-026: Successful Switch Persists the Selection

**Pre-condition:** Unit test against `server/src/services/activeModelConfig.js` directly (no running server required) — `DB_TYPE=json` pointed at a scratch `STORAGE_PATH`
**Steps:**
1. `initDB()`, then call `activeModelConfig.setActiveModel('cloth-par', 'openpar-resnet50-pa100k')`
2. Assert `activeModelConfig.getActiveModels()['cloth-par'] === 'openpar-resnet50-pa100k'`
3. `db.flushNow()`, read the raw `storage/lts.json` file, assert the `settings` row with `id: 'activeModels'` contains `'cloth-par': 'openpar-resnet50-pa100k'`

**Expected:** PASS
**Priority:** P1

---

### TC-MC-027: Successful Deactivate Persists an Explicit `null`

**Pre-condition:** Same as TC-MC-026
**Steps:**
1. `activeModelConfig.setActiveModel('cloth-par', 'openpar-pa100k')`
2. `activeModelConfig.clearActiveModel('cloth-par')`
3. Assert `'cloth-par' in activeModelConfig.getActiveModels()` is `true` AND its value is `null` (not simply absent)
4. Assert a family that was never touched (e.g. `'ppe'`) is absent from the map entirely — confirms `null` (deactivated) and "never configured" are distinguishable

**Expected:** PASS
**Priority:** P1

---

### TC-MC-028: Failed Switch/Deactivate Does Not Persist

**Pre-condition:** Analysis server running
**Steps:**
1. Note current `GET /api/settings/activeModels` value
2. `POST /api/analysis/models/switch { modelId: '__nonexistent__' }` → assert HTTP 400
3. `POST /api/analysis/models/switch { modelId: <a valid but not-yet-downloaded model id> }` → assert HTTP 409
4. `GET /api/settings/activeModels` again — assert the value is byte-for-byte unchanged from step 1

**Expected:** PASS
**Priority:** P2

---

### TC-MC-029: Startup Restore Replays Switch/Deactivate Through the Same Code Path

**Pre-condition:** Unit test against `server/src/routes/analysisApi.js`'s exported internals (or integration test restarting a real analysis server process) — a `cloth-par` model other than the default is persisted as active, and a `ppe` deactivation (`null`) is persisted
**Steps:**
1. Seed the `activeModels` settings row: `{ 'cloth-par': 'openpar-resnet50-pa100k', 'ppe': null }` (with the corresponding `.onnx` files present in `server/models/`)
2. Start (or restart) the analysis server
3. `GET /api/analysis/models` — assert `openpar-resnet50-pa100k.active === true` and every `cloth-par` sibling entry's `active === false`
4. Assert every `ppe` entry's `active === false` (deactivation was replayed, not left at the on-disk default)

**Expected:** PASS
**Priority:** P1
**Note:** Full server-restart form requires a real process restart; can be approximated by calling `_loadServices()`'s restore step directly against freshly-constructed service instances in a unit test.

---

### TC-MC-030: Restore Tolerates a Missing Model File or Removed Catalog Entry

**Pre-condition:** Same setup style as TC-MC-029
**Steps:**
1. Seed the `activeModels` settings row with a `modelId` whose `.onnx` file has since been deleted from `server/models/`
2. Start (or restart) the analysis server
3. Assert startup completes without throwing and `_servicesReady` reaches `true`
4. Assert a warning was logged naming the missing file, and the family's `GET /api/analysis/models` `active` entry reflects whatever default it already had loaded (not a crash, not a stuck "loading" state)

**Expected:** PASS
**Priority:** P2

---

## 3. Automated Test Coverage

`test/api/model_catalog.test.js` covers:
- TC-MC-001 (catalog completeness, field validation — 20 YOLO detector entries across 4 series)
- TC-MC-002 / TC-MC-002b (exists/active flags; at most one active entry per family)
- TC-MC-007 (switch unknown model → 400)
- TC-MC-008 (switch non-downloaded → 409)
- TC-MC-012 (all non-detector families present; `manualOnly` entries never expose `url`)
- TC-MC-013 (download request for a `manualOnly` entry → 409 with `docRef`)
- TC-MC-017 (cloth-par family exposes exactly 2 entries: PromptPAR + OpenPAR)
- TC-MC-018 / TC-MC-019 (PromptPAR memory gate — unit tests, no running server required; see Group D in the script)
- TC-MC-020 (age-estimation family exposes exactly 2 entries: InsightFace GenderAge + ViT Age Classifier)
- TC-MC-023 (Deactivate unloads each of the 8 extended families — unit tests, no running server required; see Group E in the script)
- TC-MC-026 / TC-MC-027 (`activeModelConfig.js` persists a switch as a `modelId` and a deactivate as an explicit `null` — unit tests against a scratch JSON DB, no running server required; see Group F in the script)

Network-dependent tests (TC-MC-004, TC-MC-009, TC-MC-014) are skipped by default; enable with `INTEGRATION_DOWNLOAD=1` env var. TC-MC-003, TC-MC-005, TC-MC-006, TC-MC-010, TC-MC-011, TC-MC-015, TC-MC-016, TC-MC-021, TC-MC-024, TC-MC-025, TC-MC-028, TC-MC-029, TC-MC-030 are exercised manually / via the Admin Dashboard (or a full server-restart cycle) against a running analysis server (not yet automated). TC-MC-022's full pipeline (steps 3-6) requires a CUDA GPU + real network access and is manual-only by design; only its pre-flight failure paths (steps 1-2) are candidates for automation.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — TC-MC-001~011, YOLO12 PT→ONNX, 런타임 전환, 병렬 다운로드 방지 |
| 2.0 | 2026-07-09 | 전체 모델 파일로 범위 확대 — TC-MC-012~016 신규(비감지기 패밀리 구성·manualOnly 거부·HF export·family별 독립 전환·already 단축응답), TC-MC-001/002/004/008/009 필드명(`catalog`/`exists`) 및 응답코드(400→409) 정정, §3 자동화 커버리지에서 근거 없이 포함되어 있던 TC-MC-005 제거 |
| 2.1 | 2026-07-12 | PromptPAR(PA100k) 통합 반영 — TC-MC-013 `modelId`를 실제 manualOnly 항목(`openpar-resnet50-pa100k`)으로 정정(구 `openpar-market1501`은 실존한 적 없는 placeholder였음), TC-MC-017~019 신규(cloth-par 2-항목 구성 검증, PromptPAR 메모리 게이트 유닛 테스트) — `test/api/model_catalog.test.js` Group D로 자동화 |
| 2.2 | 2026-07-12 | `age-estimation` family(Proposed) 추가 — TC-MC-020(패밀리 구성)·TC-MC-021(family 독립 전환) 신규, TC-MC-012 family 목록 갱신, §3 자동화 커버리지에 TC-MC-020 추가. 상세는 신규 `TC_AI_Age_Estimation.md`(TC-AGE-001~011) 참조 |
| 2.3 | 2026-07-12 | PromptPAR Download 자동화(`pyExport`) 반영 — TC-MC-022 신규(사전조건 실패 경로는 자동화 가능, 전체 파이프라인은 GPU·네트워크 필요로 수동 전용) |
| 2.4 | 2026-07-13 | Runtime Model Deactivate 반영 — TC-MC-023(8개 확장 family 언로드 유닛 테스트, `test/api/model_catalog.test.js` Group E로 자동화)·TC-MC-024(YOLO 탐지기 거부)·TC-MC-025(no-op 안전성 + analyticsConfig 미변경) 신규 |
| 2.5 | 2026-07-14 | Active Model Persistence 반영 — TC-MC-026~030 신규(성공한 switch/deactivate의 `settings` 영속화·실패 시 미영속화·시작 시 복원·누락 파일/카탈로그 항목에 대한 안전한 폴백). TC-MC-026/027은 `test/api/model_catalog.test.js` Group F로 자동화 |
