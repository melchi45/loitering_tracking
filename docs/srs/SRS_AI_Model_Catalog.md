---
**Document:** SRS_AI_Model_Catalog  
**Version:** 2.1  
**Status:** Draft  
**Date:** 2026-07-12  
**Parent RFP:** [RFP_AI_Model_Catalog](../rfp/RFP_AI_Model_Catalog.md)  
**Parent PRD:** [PRD_AI_Model_Catalog](../prd/PRD_AI_Model_Catalog.md)  
**Child Design:** [Design_AI_Model_Catalog](../design/Design_AI_Model_Catalog.md)  
**Child TC:** [TC_AI_Model_Catalog](../tc/TC_AI_Model_Catalog.md)  
**Child Test Script:** `test/api/model_catalog.test.js`  
---

# SRS — AI Model Catalog & Runtime Model Switching

## 1. Introduction

This SRS specifies the software requirements for the full AI model catalog — YOLO detector plus every other ONNX model family (face detection/recognition, PPE, fire & smoke, cloth-PAR, and the proposed human-parsing/appearance-reid families) — its download/export pipeline, and runtime hot-swap, all implemented in `server/src/routes/analysisApi.js`.

## 2. Scope

Applicable to `SERVER_MODE=analysis` and `SERVER_MODE=combined`. Not applicable to `SERVER_MODE=streaming` (streaming mode delegates all inference to the remote analysis server).

## 3. Functional Requirements

### 3.1 Model Catalog Query

| ID | Requirement |
|---|---|
| FR-MC-001 | `GET /api/analysis/models` shall return `{ activeFile, catalog }` where `catalog` is an array of all catalog entries across every family (`ALL_MODELS = [...MODEL_CATALOG, ...EXTENDED_CATALOG]`), each containing at minimum: `id, label, series, file, exists, active, sizeBytes, downloading, converting, downloadPercent, downloadError`. YOLO detector entries additionally carry `size, mAP, cpuMs, t4Ms, params, flops`. Non-detector entries additionally carry `family` and `license`; `manualOnly`/`docRef` are present when no automatable source exists. |
| FR-MC-002 | `exists` shall be `true` if and only if the ONNX file exists in `server/models/<file>`. |
| FR-MC-003 | `active` shall be `true` for the model currently loaded **for that entry's family** — YOLO detector entries compare against `_detector.modelPath`; `face-detection`/`face-recognition` compare against `AttributePipeline._face.scrfdPath`/`.arcfacePath`; `ppe` against `AttributePipeline._ppe.modelPath`; `fire-smoke` against `FireSmokeService.modelPath`; `cloth-par` against `AttributePipeline._color.parModelPath`; `human-parsing` against `AttributePipeline._color.hpModelPath`; `appearance-reid` against `AppearanceReidService.modelPath`. Each family may have its own active entry simultaneously and independently — this lookup is centralized in `_activeFileForEntry()`. |
| FR-MC-004 | `downloading` shall be `true` when `_downloadProgress.status` is `'downloading'` or `'converting'`. |
| FR-MC-005 | `converting` shall be `true` when `_downloadProgress.status` is `'converting'` (any PT→ONNX conversion phase — YOLO26/YOLO12 GitHub-release or PPE/Fire-Smoke HuggingFace-Hub). |
| FR-MC-005b | `downloadPercent` shall be the integer 0–100 download progress, or `null` if no download is in progress. `downloadError` shall be the error message string when `status === 'error'`, otherwise `null`. |
| FR-MC-005c | The `url`, `classMap`, and `hfExport` fields shall never be included in the client-facing catalog response (internal source-resolution detail only). |

### 3.2 Model Download — Direct ONNX (YOLOv8, YOLO11, SCRFD, ArcFace, human-parsing, appearance-reid)

| ID | Requirement |
|---|---|
| FR-MC-006 | `POST /api/analysis/models/download` with body `{ modelId }` shall start an asynchronous download of the model's ONNX file from the URL defined in the catalog, for any entry without `requiresConversion`/`hfExport`/`manualOnly`. |
| FR-MC-007 | HTTP 301/302 redirects shall be followed automatically (GitHub releases and HuggingFace Hub redirect to CDN). |
| FR-MC-008 | The file shall be written to a `.tmp` file first and renamed atomically on completion. |
| FR-MC-009 | If the ONNX file already exists, the endpoint shall return HTTP 200 `{ already: true }` immediately, before starting any download. |
| FR-MC-010 | If a download is already in progress for the same `modelId`, the endpoint shall return HTTP 409 `{ error: 'Download already in progress' }`. |

### 3.3 Model Download — PT→ONNX Conversion (YOLO26/YOLO12 GitHub release; PPE/Fire-Smoke HuggingFace Hub)

| ID | Requirement |
|---|---|
| FR-MC-011 | For entries with `requiresConversion: true` (YOLO26, YOLO12), the download handler shall: (1) download the `.pt` file from the catalog `url`, (2) set status `'converting'`, (3) run `ultralytics export` via Python subprocess, (4) rename the exported ONNX to `server/models/<file>`, (5) delete the `.pt` file. |
| FR-MC-011b | For entries with an `hfExport: { repo, file }` field (PPE, Fire & Smoke), the download handler shall run a single Python subprocess that: (1) resolves the `.pt` file via `huggingface_hub.hf_hub_download(repo_id, filename)`, (2) runs `ultralytics export`, (3) copies the exported ONNX to `server/models/<file>` via `shutil.copy`. No intermediate `.pt` file is persisted in `server/models/`. |
| FR-MC-012 | For YOLO26/YOLO12 export, the Python interpreter shall be auto-detected by verifying YOLO12 support (`cfg/models/12` directory exists inside the ultralytics package) on each candidate in order: `process.env.PYTHON_EXEC`, `process.env.PYTHON_EXEC_LINUX` (Linux) / `process.env.PYTHON_EXEC_WINDOWS` (Windows), `/usr/bin/python3`, `python3`, `python`. A plain `import ultralytics` check is insufficient because ultralytics < 8.3 lacks YOLO12 architecture support. For PPE/Fire-Smoke export, the same candidate order is used but the check additionally verifies `huggingface_hub` is importable (`import ultralytics, huggingface_hub`) instead of the YOLO12-specific check. Both checks are implemented by the shared `_findPythonWithUltralytics({ checkYolo12, checkHfHub })` helper. |
| FR-MC-013 | If no candidate passes the required check, the download shall fail with a descriptive error message naming the missing package(s). |
| FR-MC-014 | The ultralytics export subprocess shall have a 5-minute timeout (`300_000 ms`). |
| FR-MC-015 | The `.pt` file shall be deleted after successful ONNX export, even if the ONNX was exported to a path different from `server/models/<file>` (ultralytics may write next to the `.pt`). This applies to the `requiresConversion` path only — the `hfExport` path never writes a `.pt` file to `server/models/` in the first place. |
| FR-MC-015b | For entries with `manualOnly: true` (cloth-PAR/OpenPAR), `POST /api/analysis/models/download` shall return HTTP 409 with `{ error, docRef }` and shall not attempt any download — there is no automatable source. This check runs before the download-in-progress and already-exists checks. |

### 3.4 Runtime Model Switch

| ID | Requirement |
|---|---|
| FR-MC-016 | `POST /api/analysis/models/switch` with body `{ modelId }` shall hot-swap the active model for that entry's family: YOLO detector families call `_detector.reload(filePath)` (constructing `_detector` first if absent); `face-detection`/`face-recognition` call `AttributePipeline._face.reloadDetector()`/`.reloadRecognizer()`; `ppe` calls `AttributePipeline._ppe.reload()`; `fire-smoke` calls `FireSmokeService.reload()` (constructing the service first if absent); `cloth-par` calls `AttributePipeline._color.reloadPar()`; `human-parsing` calls `AttributePipeline._color.reloadHumanParsing()`; `appearance-reid` calls `AppearanceReidService.reload()` (constructing the service first if absent). |
| FR-MC-017 | The switch shall fail with HTTP 400 if `modelId` is not in the catalog. |
| FR-MC-018 | The switch shall fail with HTTP 409 if the ONNX file does not exist in `server/models/` (`{ error: 'Model file not downloaded yet', file }`). |
| FR-MC-018b | The switch shall fail with HTTP 409 if the entry's family requires `AttributePipeline` and it has not finished loading (`{ error: 'AttributePipeline not loaded' }`). |
| FR-MC-018c | For the `cloth-par` entry `openpar-pa100k` (PromptPAR) specifically, the switch shall check free system RAM against a configurable floor (default 2048MB, `PROMPTPAR_MIN_FREE_MEM_MB`) before hot-swapping; if insufficient, it shall log the reason, set the `cloth` analytics config flag to `false`, and fail with HTTP 500 `{ error: <message> }` without touching the currently-active session. The sibling entry `openpar-resnet50-pa100k` (OpenPAR) is never subject to this check. |
| FR-MC-019 | The switch shall succeed synchronously — subsequent inference calls shall use the new model, scoped to that family only. |
| FR-MC-020 | The response shall include `{ ok: true, active: label, file }` on success. |

### 3.5 Catalog Composition

| ID | Requirement |
|---|---|
| FR-MC-021 | `MODEL_CATALOG` shall contain exactly 20 YOLO detector entries: 5 YOLO26 (n/s/m/l/x), 5 YOLO12 (n/s/m/l/x), 5 YOLO11 (n/s/m/l/x), 5 YOLOv8 (n/s/m/l/x). `EXTENDED_CATALOG` shall additionally contain one entry each for `face-detection`, `face-recognition`, `ppe`, `fire-smoke`, two entries for `cloth-par` (PromptPAR + OpenPAR — see FR-MC-023), two entries for `human-parsing`, plus one for `appearance-reid` — 9 entries total, 29 in `ALL_MODELS` overall. |
| FR-MC-022 | All YOLO detector catalog entries shall produce the identical ONNX output shape `[1, 84, 8400]` compatible with the existing `DetectionService` post-processor. Non-detector entries are consumed by their respective service (`FaceService`, `ProtectiveEquipService`, `FireSmokeService`, `ColorClothService`, `AppearanceReidService`) and are not subject to this shape constraint. |

## 4. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-MC-001 | Download shall display real-time progress (0–100%) via `_downloadProgress` state accessible from `GET /api/analysis/models`. |
| NFR-MC-002 | Model switch shall complete within 30 seconds on CPU-only hardware for any catalog entry. |
| NFR-MC-003 | Concurrent camera inference is not interrupted during model load (the new session/service is loaded before replacing the active pointer). |
| NFR-MC-004 | The `server/models/` directory shall be created automatically if it does not exist at server startup. |

## 5. Constraints

- `requiresConversion: true` entries (YOLO26, YOLO12) require `ultralytics >= 8.3` installed in the Python environment.
- `hfExport` entries (PPE, Fire & Smoke) require `ultralytics` and `huggingface_hub` installed in the Python environment.
- System Python (`/usr/bin/python3`) is the recommended fallback — user-local Python builds may lack standard library modules (`_lzma`) causing `import ultralytics` to fail.
- `cloth-par` has two entries with different source strategies: `openpar-pa100k` (PromptPAR) ships its `.onnx` directly in `server/models/` with no download URL at all (not `manualOnly` — the file is simply already present); `openpar-resnet50-pa100k` (OpenPAR) has no automatable source — `manualOnly: true` is a permanent property of that entry, not a temporary download-failure state. See FR-MC-023~025 for the PromptPAR-specific memory gate.
- This feature is not available in `SERVER_MODE=streaming`.

## 6. Error Handling

| Scenario | HTTP | Response |
|---|---|---|
| Unknown `modelId` | 400 | `{ error: 'Unknown modelId' }` |
| `manualOnly` entry download requested | 409 | `{ error: '...manual export...', docRef }` |
| ONNX not downloaded (switch) | 409 | `{ error: 'Model file not downloaded yet', file }` |
| `AttributePipeline` not loaded (switch) | 409 | `{ error: 'AttributePipeline not loaded' }` |
| PromptPAR memory gate failed (switch) | 500 | `{ error: 'PromptPAR 수행 불가능: ...' }` — `cloth` config also set to `false` |
| Concurrent download | 409 | `{ error: 'Download already in progress' }` |
| Already downloaded (download) | 200 | `{ ok: true, already: true, message }` |
| Python not found | 500 | `{ error: 'Python with ultralytics [+ huggingface_hub] not found...' }` |
| Export timeout | 500 | error logged; `_downloadProgress.status = 'error'` |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — FR-MC-001~022, NFR-MC-001~004, YOLO12 PT→ONNX 파이프라인 요구사항 |
| 1.1 | 2026-06-17 | FR-MC-001 응답 키 `downloaded` → `exists`/`catalog` 수정, downloadPercent/downloadError 필드 추가 (FR-MC-005b) |
| 1.2 | 2026-06-17 | FR-MC-012 강화 — `import ultralytics` → `cfg/models/12` 디렉토리 존재 확인으로 변경 (ultralytics < 8.3.x YOLO12 지원 불가 대응) |
| 2.0 | 2026-07-09 | 전체 모델 파일로 범위 확대 — face-detection/face-recognition/ppe/fire-smoke/cloth-par family 및 hfExport 다운로드 전략 추가(FR-MC-005c, 011b, 015b), family별 독립 active 판정 명시(FR-MC-003), switch 실패 코드 400→409 정정(FR-MC-018, 실제 코드와 불일치했던 기존 문서 오류 수정), 다운로드 완료본 재요청 시 `{already:true}` 단축 응답 신규 구현 반영(FR-MC-009 — 이전에는 문서만 있고 코드 미구현), 카탈로그 개수 15→20(감지기)+8(비감지기)=28 갱신(FR-MC-021) |
| 2.1 | 2026-07-12 | PromptPAR(PA100k) 통합 반영 — `cloth-par` family가 `openpar-pa100k`(PromptPAR, 직접 배포) + `openpar-resnet50-pa100k`(OpenPAR ResNet50, manualOnly) 2개 항목으로 확장(FR-MC-021 카탈로그 개수 28→29 갱신), PromptPAR 전용 사전 메모리 게이트 요구사항 신설(FR-MC-018c — 가용 RAM 부족 시 HTTP 500 + `cloth` 설정 자동 비활성화), §5 제약사항·§6 오류표 갱신 |
