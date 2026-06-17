---
**Document:** TC_AI_Model_Catalog  
**Version:** 1.0  
**Status:** Draft  
**Date:** 2026-06-17  
**Parent SRS:** [SRS_AI_Model_Catalog](../srs/SRS_AI_Model_Catalog.md)  
**Parent Design:** [Design_AI_Model_Catalog](../design/Design_AI_Model_Catalog.md)  
**Test Script:** `test/api/model_catalog.test.js`  
---

# TC — AI Model Catalog & Runtime Model Switching

## 1. Traceability Matrix

| TC ID | SRS FR | Description |
|---|---|---|
| TC-MC-001 | FR-MC-001, FR-MC-021 | Catalog returns 15 models with required fields |
| TC-MC-002 | FR-MC-002, FR-MC-003 | Downloaded/active flags reflect filesystem state |
| TC-MC-003 | FR-MC-004, FR-MC-005 | Converting flag during YOLO12 export |
| TC-MC-004 | FR-MC-006~010 | Download direct ONNX (YOLOv8n) |
| TC-MC-005 | FR-MC-010 | Concurrent download rejected with HTTP 409 |
| TC-MC-006 | FR-MC-016~020 | Switch active model |
| TC-MC-007 | FR-MC-017 | Switch unknown model returns HTTP 400 |
| TC-MC-008 | FR-MC-018 | Switch non-downloaded model returns HTTP 400 |
| TC-MC-009 | FR-MC-011~015 | YOLO12 download: PT fetch → converting → ONNX |
| TC-MC-010 | FR-MC-012~013 | Python fallback detection chain |
| TC-MC-011 | FR-MC-022 | All models compatible with DetectionService output shape |

## 2. Test Cases

### TC-MC-001: Catalog Completeness

**Pre-condition:** Analysis server running  
**Steps:**
1. `GET /api/analysis/models`
2. Assert HTTP 200
3. Assert response has `models` array with exactly 15 entries
4. Assert 5 entries with `series === 'YOLOv8'`
5. Assert 5 entries with `series === 'YOLO11'`
6. Assert 5 entries with `series === 'YOLO12'`
7. For each entry, assert fields: `id, label, series, mAP, cpuMs, t4Ms, params, flops, downloaded, active, downloading, converting`

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-002: Downloaded/Active Flags

**Pre-condition:** `server/models/yolov8n.onnx` exists  
**Steps:**
1. `GET /api/analysis/models`
2. Find entry with `id === 'yolov8n'`
3. Assert `downloaded === true`
4. Assert `active === true` (default model at startup)
5. Find entry with `id === 'yolo12n'`
6. Assert `downloaded === false` (not yet downloaded)

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-003: Converting Flag During YOLO12 Export

**Pre-condition:** Server running; Python with ultralytics available  
**Steps:**
1. `POST /api/analysis/models/download { modelId: 'yolo12n' }`
2. While conversion is in progress, `GET /api/analysis/models`
3. Find `yolo12n` entry
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
3. Poll `GET /api/analysis/models` until `yolov8s.downloaded === true`
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
2. Assert HTTP 200 with `{ modelId: 'yolov8s', label: 'YOLOv8s' }`
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
2. Assert HTTP 400 or 404
3. Assert response has `error` field

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-008: Switch Non-Downloaded Model

**Pre-condition:** `yolo12n.onnx` does NOT exist  
**Steps:**
1. `POST /api/analysis/models/switch { modelId: 'yolo12n' }`
2. Assert HTTP 400
3. Assert response has `error` field

**Expected:** PASS  
**Priority:** P1

---

### TC-MC-009: YOLO12 Full Download Pipeline

**Pre-condition:** Python with ultralytics ≥ 8.0 available; network access to GitHub  
**Steps:**
1. Ensure `server/models/yolo12n.onnx` does NOT exist
2. `POST /api/analysis/models/download { modelId: 'yolo12n' }`
3. Assert HTTP 200
4. Poll until `GET /api/analysis/models` shows `yolo12n.downloaded === true`
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

**Pre-condition:** Any downloaded YOLO model (n variant)  
**Steps:**
1. Switch to the downloaded model
2. Submit a test frame `POST /api/analysis/process` with a JPEG
3. Assert HTTP 200 response with `detections` array
4. Assert no inference errors in server logs

**Expected:** PASS  
**Priority:** P1

---

## 3. Automated Test Coverage

`test/api/model_catalog.test.js` covers:
- TC-MC-001 (catalog completeness, field validation)
- TC-MC-002 (downloaded/active flags)
- TC-MC-007 (switch unknown model → 400)
- TC-MC-008 (switch non-downloaded → 400)
- TC-MC-005 (concurrent download → 409) — unit-level mock

Network-dependent tests (TC-MC-004, TC-MC-009) are skipped by default; enable with `INTEGRATION_DOWNLOAD=1` env var.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — TC-MC-001~011, YOLO12 PT→ONNX, 런타임 전환, 병렬 다운로드 방지 |
