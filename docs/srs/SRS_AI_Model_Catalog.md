---
**Document:** SRS_AI_Model_Catalog  
**Version:** 1.0  
**Status:** Draft  
**Date:** 2026-06-17  
**Parent RFP:** [RFP_AI_Model_Catalog](../rfp/RFP_AI_Model_Catalog.md)  
**Parent PRD:** [PRD_AI_Model_Catalog](../prd/PRD_AI_Model_Catalog.md)  
**Child Design:** [Design_AI_Model_Catalog](../design/Design_AI_Model_Catalog.md)  
**Child TC:** [TC_AI_Model_Catalog](../tc/TC_AI_Model_Catalog.md)  
**Child Test Script:** `test/api/model_catalog.test.js`  
---

# SRS — AI Model Catalog & Runtime Model Switching

## 1. Introduction

This SRS specifies the software requirements for the YOLO model catalog, download pipeline, and runtime hot-swap in `server/src/routes/analysisApi.js`.

## 2. Scope

Applicable to `SERVER_MODE=analysis` and `SERVER_MODE=combined`. Not applicable to `SERVER_MODE=streaming` (streaming mode delegates all inference to the remote analysis server).

## 3. Functional Requirements

### 3.1 Model Catalog Query

| ID | Requirement |
|---|---|
| FR-MC-001 | `GET /api/analysis/models` shall return `{ activeFile, catalog }` where `catalog` is an array of all catalog entries, each containing: `id, label, series, size, mAP, cpuMs, t4Ms, params, flops, file, exists, active, sizeBytes, downloading, converting, downloadPercent, downloadError`. |
| FR-MC-002 | `exists` shall be `true` if and only if the ONNX file exists in `server/models/<file>`. |
| FR-MC-003 | `active` shall be `true` for the model currently loaded in `_detector`. |
| FR-MC-004 | `downloading` shall be `true` when `_downloadProgress.status` is `'downloading'` or `'converting'`. |
| FR-MC-005 | `converting` shall be `true` when `_downloadProgress.status` is `'converting'` (YOLO12 PT→ONNX phase only). |
| FR-MC-005b | `downloadPercent` shall be the integer 0–100 download progress, or `null` if no download is in progress. `downloadError` shall be the error message string when `status === 'error'`, otherwise `null`. |

### 3.2 Model Download — Direct ONNX (YOLOv8, YOLO11)

| ID | Requirement |
|---|---|
| FR-MC-006 | `POST /api/analysis/models/download` with body `{ modelId }` shall start an asynchronous download of the model's ONNX file from the URL defined in `MODEL_CATALOG`. |
| FR-MC-007 | HTTP 301/302 redirects shall be followed automatically (GitHub releases redirect to CDN). |
| FR-MC-008 | The file shall be written to a `.tmp` file first and renamed atomically on completion. |
| FR-MC-009 | If the ONNX file already exists, the endpoint shall return HTTP 200 `{ already: true }` without re-downloading. The `url` field is excluded from the catalog response (never sent to client). |
| FR-MC-010 | If a download is already in progress for the same `modelId`, the endpoint shall return HTTP 409. |

### 3.3 Model Download — PT→ONNX Conversion (YOLO12)

| ID | Requirement |
|---|---|
| FR-MC-011 | For entries with `requiresConversion: true`, the download handler shall: (1) download the `.pt` file, (2) set status `'converting'`, (3) run `ultralytics export` via Python subprocess, (4) rename the exported ONNX to `server/models/<file>`, (5) delete the `.pt` file. |
| FR-MC-012 | For YOLO12 export, the Python interpreter shall be auto-detected by verifying YOLO12 support (`cfg/models/12` directory exists inside the ultralytics package) on each candidate in order: `process.env.PYTHON_EXEC`, `process.env.PYTHON_EXEC_LINUX` (Linux) / `process.env.PYTHON_EXEC_WINDOWS` (Windows), `/usr/bin/python3`, `python3`, `python`. A plain `import ultralytics` check is insufficient because ultralytics < 8.3 lacks YOLO12 architecture support. |
| FR-MC-013 | If no candidate passes the YOLO12 support check, the download shall fail with a descriptive error message including the detected ultralytics version. |
| FR-MC-014 | The ultralytics export subprocess shall have a 5-minute timeout (`300_000 ms`). |
| FR-MC-015 | The `.pt` file shall be deleted after successful ONNX export, even if the ONNX was exported to a path different from `server/models/<file>` (ultralytics may write next to the `.pt`). |

### 3.4 Runtime Model Switch

| ID | Requirement |
|---|---|
| FR-MC-016 | `POST /api/analysis/models/switch` with body `{ modelId }` shall load the corresponding ONNX file via `new DetectionService({ modelPath })` and replace the module-level `_detector` instance. |
| FR-MC-017 | The switch shall fail with HTTP 404 if `modelId` is not in the catalog. |
| FR-MC-018 | The switch shall fail with HTTP 400 if the ONNX file does not exist in `server/models/`. |
| FR-MC-019 | The switch shall succeed synchronously — subsequent inference calls shall use the new detector. |
| FR-MC-020 | The response shall include `{ modelId, label, modelPath }`. |

### 3.5 Catalog Composition

| ID | Requirement |
|---|---|
| FR-MC-021 | `MODEL_CATALOG` shall contain exactly 15 entries: 5 YOLOv8 (n/s/m/l/x), 5 YOLO11 (n/s/m/l/x), 5 YOLO12 (n/s/m/l/x). |
| FR-MC-022 | All catalog entries shall produce the identical ONNX output shape `[1, 84, 8400]` compatible with the existing `DetectionService` post-processor. |

## 4. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-MC-001 | Download shall display real-time progress (0–100%) via `_downloadProgress` state accessible from `GET /api/analysis/models`. |
| NFR-MC-002 | Model switch shall complete within 30 seconds on CPU-only hardware for any catalog entry. |
| NFR-MC-003 | Concurrent camera inference is not interrupted during model load (new DetectionService is loaded before replacing the pointer). |
| NFR-MC-004 | The `server/models/` directory shall be created automatically if it does not exist at server startup. |

## 5. Constraints

- `requiresConversion: true` entries (YOLO12) require `ultralytics >= 8.0` installed in the Python environment.
- System Python (`/usr/bin/python3`) is the recommended fallback — user-local Python builds may lack standard library modules (`_lzma`) causing `import ultralytics` to fail.
- This feature is not available in `SERVER_MODE=streaming`.

## 6. Error Handling

| Scenario | HTTP | Response |
|---|---|---|
| Unknown `modelId` | 400 | `{ error: 'Unknown model' }` |
| ONNX not downloaded | 400 | `{ error: 'Model not downloaded' }` |
| Concurrent download | 409 | `{ error: 'Download already in progress' }` |
| Python not found | 500 | `{ error: 'Python with ultralytics not found.' }` |
| Export timeout | 500 | error logged; `_downloadProgress.status = 'error'` |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — FR-MC-001~022, NFR-MC-001~004, YOLO12 PT→ONNX 파이프라인 요구사항 |
| 1.1 | 2026-06-17 | FR-MC-001 응답 키 `downloaded` → `exists`/`catalog` 수정, downloadPercent/downloadError 필드 추가 (FR-MC-005b) |
| 1.2 | 2026-06-17 | FR-MC-012 강화 — `import ultralytics` → `cfg/models/12` 디렉토리 존재 확인으로 변경 (ultralytics < 8.3.x YOLO12 지원 불가 대응) |
