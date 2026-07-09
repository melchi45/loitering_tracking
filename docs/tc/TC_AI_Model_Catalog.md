---
**Document:** TC_AI_Model_Catalog  
**Version:** 2.0  
**Status:** Draft  
**Date:** 2026-07-09  
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
2. Assert the set of distinct `family` values across `catalog` includes all of: `face-detection`, `face-recognition`, `ppe`, `fire-smoke`, `cloth-par`, `human-parsing`, `appearance-reid`
3. Assert at least one entry has `manualOnly === true`
4. Assert no entry ever exposes a raw `url` field in the response (always `undefined`)

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-013: Manual-Only Download Rejected

**Pre-condition:** Catalog contains a `manualOnly` entry (`openpar-market1501`)  
**Steps:**
1. `POST /api/analysis/models/download { modelId: 'openpar-market1501' }`
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

## 3. Automated Test Coverage

`test/api/model_catalog.test.js` covers:
- TC-MC-001 (catalog completeness, field validation — 20 YOLO detector entries across 4 series)
- TC-MC-002 / TC-MC-002b (exists/active flags; at most one active entry per family)
- TC-MC-007 (switch unknown model → 400)
- TC-MC-008 (switch non-downloaded → 409)
- TC-MC-012 (all non-detector families present; `manualOnly` entries never expose `url`)
- TC-MC-013 (download request for a `manualOnly` entry → 409 with `docRef`)

Network-dependent tests (TC-MC-004, TC-MC-009, TC-MC-014) are skipped by default; enable with `INTEGRATION_DOWNLOAD=1` env var. TC-MC-003, TC-MC-005, TC-MC-006, TC-MC-010, TC-MC-011, TC-MC-015, TC-MC-016 are exercised manually / via the Admin Dashboard against a running analysis server (not yet automated).

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — TC-MC-001~011, YOLO12 PT→ONNX, 런타임 전환, 병렬 다운로드 방지 |
| 2.0 | 2026-07-09 | 전체 모델 파일로 범위 확대 — TC-MC-012~016 신규(비감지기 패밀리 구성·manualOnly 거부·HF export·family별 독립 전환·already 단축응답), TC-MC-001/002/004/008/009 필드명(`catalog`/`exists`) 및 응답코드(400→409) 정정, §3 자동화 커버리지에서 근거 없이 포함되어 있던 TC-MC-005 제거 |
