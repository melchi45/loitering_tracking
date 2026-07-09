---
**Document:** PRD_AI_Model_Catalog  
**Version:** 1.1  
**Status:** Draft  
**Date:** 2026-07-09  
**Parent RFP:** [RFP_AI_Model_Catalog](../rfp/RFP_AI_Model_Catalog.md)  
**Related SRS:** [SRS_AI_Model_Catalog](../srs/SRS_AI_Model_Catalog.md)  
**Related Design:** [Design_AI_Model_Catalog](../design/Design_AI_Model_Catalog.md)  
**Related TC:** [TC_AI_Model_Catalog](../tc/TC_AI_Model_Catalog.md)  
---

# PRD — AI Model Catalog & Runtime Model Switching

## 1. Overview

The LTS-2026 analysis server exposes a full AI model catalog UI via REST APIs — not just the YOLO detector, but every ONNX model family used by the AI pipeline (face detection/recognition, PPE, fire & smoke, cloth-PAR, and the proposed human-parsing/appearance-reid families). Operators can view available models per family, download or export them, and switch each family's active model independently — all without restarting the server.

## 2. User Stories

| # | As a… | I want to… | So that… |
|---|---|---|---|
| US-01 | System administrator | See all available models — YOLO detector and every other model family — with accuracy/speed metrics where available | I can make an informed trade-off between mAP and CPU speed, and know what's active for every module |
| US-02 | System administrator | Download or export a model from the UI | I don't need SSH access to the server |
| US-03 | System administrator | Switch the active model for any family at runtime | I can test a new model without service downtime |
| US-04 | System administrator | See download/conversion progress in real time | I know when the model is ready |
| US-05 | System administrator | Use YOLO12/YOLO26 models | I benefit from the latest attention-based / NMS-free architecture improvements |
| US-06 | System administrator | See a clear message when a model has no automatable source (e.g. cloth-PAR) | I know to export it manually instead of waiting on a Download button that can never succeed |

## 3. Supported Model Catalog

### 3.1 YOLOv8 Series

| Model | mAP val | CPU (ms) | T4 (ms) | Params |
|---|---|---|---|---|
| YOLOv8n | 37.3 | 80.4 | 1.47 | 3.2M |
| YOLOv8s | 44.9 | 128.4 | 2.66 | 11.2M |
| YOLOv8m | 50.2 | 234.7 | 5.86 | 25.9M |
| YOLOv8l | 52.9 | 375.2 | 9.06 | 43.7M |
| YOLOv8x | 53.9 | 479.1 | 14.37 | 68.2M |

### 3.2 YOLO11 Series

| Model | mAP val | CPU (ms) | T4 (ms) | Params |
|---|---|---|---|---|
| YOLO11n | 39.5 | 56.1 | 1.5 | 2.6M |
| YOLO11s | 47.0 | 90.0 | 2.5 | 9.4M |
| YOLO11m | 51.5 | 183.2 | 4.7 | 20.1M |
| YOLO11l | 53.4 | 238.6 | 6.2 | 25.3M |
| YOLO11x | 54.7 | 462.8 | 11.3 | 56.9M |

### 3.3 YOLO12 Series

| Model | mAP val | CPU (ms) | T4 (ms) | Params | Note |
|---|---|---|---|---|---|
| YOLO12n | 40.6 | 58.0 | 1.6 | 2.6M | PT→ONNX export required |
| YOLO12s | 48.0 | 95.0 | 2.7 | 9.3M | PT→ONNX export required |
| YOLO12m | 52.5 | 192.0 | 5.0 | 20.2M | PT→ONNX export required |
| YOLO12l | 53.7 | 250.0 | 6.5 | 26.4M | PT→ONNX export required |
| YOLO12x | 55.2 | 490.0 | 12.0 | 59.1M | PT→ONNX export required |

> YOLO12 uses attention-based architecture. Ultralytics does not publish pre-built ONNX for YOLO12; the server automatically downloads the `.pt` file and converts it via `ultralytics export`. YOLO26 (NMS-free, 2026) follows the identical PT→ONNX pattern.

### 3.4 Non-Detector Model Families

| Family | Model(s) | Source strategy |
|---|---|---|
| `face-detection` | SCRFD 2.5G | direct ONNX download |
| `face-recognition` | ArcFace ResNet50 (w600k) | direct ONNX download |
| `ppe` | YOLOv8m PPE (mask + helmet) | HuggingFace `.pt` → `ultralytics export` |
| `fire-smoke` | YOLOv8s Fire & Smoke | HuggingFace `.pt` → `ultralytics export` |
| `cloth-par` | OpenPAR | **manual export only** — no public pretrained ONNX exists |
| `human-parsing` (Proposed) | SCHP (LIP-20), SegFormer B2 Clothes | direct ONNX download |
| `appearance-reid` (Proposed) | OSNet (person Re-ID) | direct ONNX download |

Each family's active model is tracked independently — activating a new PPE model does not affect the active YOLO detector, face model, etc.

## 4. Product Requirements

### 4.1 Model Catalog Display

- `GET /api/analysis/models` returns `{ activeFile, catalog }` — `catalog` is an array covering every family above. Each entry carries (at minimum): `id, label, series, family?, file, exists, active, sizeBytes, downloading, converting, downloadPercent, downloadError, manualOnly?, license?`. YOLO detector entries additionally carry `mAP, cpuMs, t4Ms, params, flops`.
- UI displays the YOLO Detection Model table (grouped by series) plus one table per non-detector family, each with Download/Activate controls. `manualOnly` entries show a "Manual export" reference link instead of a Download button.

### 4.2 Download Flow

Direct ONNX (YOLOv8, YOLO11, SCRFD, ArcFace, human-parsing, appearance-reid entries):
1. `POST /api/analysis/models/download { modelId }` → server downloads ONNX directly
2. Progress tracked in `_downloadProgress` map
3. `GET /api/analysis/models` reflects `downloading: true` while in progress

PT→ONNX conversion (YOLO26, YOLO12 — GitHub release `.pt`; PPE, Fire & Smoke — HuggingFace Hub `.pt`):
1. Server downloads (or `huggingface_hub`-resolves) the `.pt` file
2. Server runs `ultralytics export` (Python subprocess, max 5 min)
3. `GET /api/analysis/models` reflects `converting: true` during export
4. `.pt` file deleted after successful conversion

Manual-only (cloth-PAR / OpenPAR):
- `POST /api/analysis/models/download` returns HTTP 409 with a `docRef` link — there is no automatable source; the operator must export their own ONNX file and place it in `server/models/`.

Already downloaded (any family):
- `POST /api/analysis/models/download` short-circuits with HTTP 200 `{ already: true }` without re-downloading.

### 4.3 Model Switch

- `POST /api/analysis/models/switch { modelId }` — loads ONNX, then hot-swaps the corresponding service for that entry's family (`_detector` for YOLO, `AttributePipeline._face/_ppe/_color` for face/PPE/cloth-PAR/human-parsing, `AppearanceReidService` for appearance-reid)
- Switch is synchronous on the hot-path but invisible to camera pipelines (next frame uses new model)
- Returns `{ ok: true, active: label, file }` on success

## 5. Acceptance Criteria

| AC | Description |
|---|---|
| AC-01 | `GET /api/analysis/models` returns 20 YOLO detector entries (5 per series × YOLO26/12/11/v8) plus one entry per non-detector family listed in §3.4 |
| AC-02 | `POST /api/analysis/models/download` with a direct-ONNX ID (YOLOv8/YOLO11/SCRFD/ArcFace) downloads the ONNX file |
| AC-03 | `POST /api/analysis/models/download` with a PT-conversion ID (YOLO26/YOLO12/PPE/Fire-Smoke) downloads/resolves the PT file then converts to ONNX |
| AC-04 | `POST /api/analysis/models/switch` succeeds for any downloaded model, independently per family |
| AC-05 | Concurrent download request for an in-progress model returns HTTP 409; a download request for a `manualOnly` entry also returns HTTP 409 with a `docRef` |
| AC-06 | After switch, `GET /api/analysis/models` shows the new model as `active: true` for its family, without affecting other families' active models |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — YOLO12 포함 15종 모델 카탈로그 제품 요구사항 |
| 1.1 | 2026-07-09 | 전체 모델 파일로 범위 확대 — §3.4 non-detector 패밀리 표 추가, §4 응답 형식(`catalog`/`exists`)·다운로드 전략(direct/PT변환/manualOnly)·이미 다운로드된 경우 단축 응답 반영, US-06·AC-01~06 갱신 |
