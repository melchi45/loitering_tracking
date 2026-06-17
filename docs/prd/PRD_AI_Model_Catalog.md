---
**Document:** PRD_AI_Model_Catalog  
**Version:** 1.0  
**Status:** Draft  
**Date:** 2026-06-17  
**Parent RFP:** [RFP_AI_Model_Catalog](../rfp/RFP_AI_Model_Catalog.md)  
**Related SRS:** [SRS_AI_Model_Catalog](../srs/SRS_AI_Model_Catalog.md)  
**Related Design:** [Design_AI_Model_Catalog](../design/Design_AI_Model_Catalog.md)  
**Related TC:** [TC_AI_Model_Catalog](../tc/TC_AI_Model_Catalog.md)  
---

# PRD — AI Model Catalog & Runtime Model Switching

## 1. Overview

The LTS-2026 analysis server exposes a YOLO model catalog UI via REST APIs. Operators can view available models, download them, and switch the active model — all without restarting the server.

## 2. User Stories

| # | As a… | I want to… | So that… |
|---|---|---|---|
| US-01 | System administrator | See all available YOLO models with accuracy and speed metrics | I can make an informed trade-off between mAP and CPU speed |
| US-02 | System administrator | Download a model from the UI | I don't need SSH access to the server |
| US-03 | System administrator | Switch the active detection model at runtime | I can test a new model without service downtime |
| US-04 | System administrator | See download progress in real time | I know when the model is ready |
| US-05 | System administrator | Use YOLO12 models | I benefit from the latest attention-based architecture improvements |

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

> YOLO12 uses attention-based architecture. Ultralytics does not publish pre-built ONNX for YOLO12; the server automatically downloads the `.pt` file and converts it via `ultralytics export`.

## 4. Product Requirements

### 4.1 Model Catalog Display

- `GET /api/analysis/models` returns catalog with per-model: `id, label, series, mAP, cpuMs, t4Ms, params, flops, downloaded, active, downloading, converting`
- UI may display a table/grid with download buttons and an "Activate" control

### 4.2 Download Flow

For YOLOv8 / YOLO11:
1. `POST /api/analysis/models/download { modelId }` → server downloads ONNX directly
2. Progress tracked in `_downloadProgress` map
3. `GET /api/analysis/models` reflects `downloading: true` while in progress

For YOLO12:
1. Server downloads `.pt` from Ultralytics v8.4.0 release
2. Server runs `ultralytics export` (Python subprocess, max 5 min)
3. `GET /api/analysis/models` reflects `converting: true` during export
4. `.pt` file deleted after successful conversion

### 4.3 Model Switch

- `POST /api/analysis/models/switch { modelId }` — loads ONNX, replaces `_detector` pointer
- Switch is synchronous on the hot-path but invisible to camera pipelines (next frame uses new model)
- Returns `{ modelId, label, modelPath }` on success

## 5. Acceptance Criteria

| AC | Description |
|---|---|
| AC-01 | `GET /api/analysis/models` returns 15 models (5 per series) |
| AC-02 | `POST /api/analysis/models/download` with a YOLOv8/YOLO11 ID downloads ONNX file |
| AC-03 | `POST /api/analysis/models/download` with a YOLO12 ID downloads PT then converts to ONNX |
| AC-04 | `POST /api/analysis/models/switch` succeeds for any downloaded model |
| AC-05 | Concurrent download request for an in-progress model returns HTTP 409 |
| AC-06 | After switch, `GET /api/analysis/models` shows new model as `active: true` |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — YOLO12 포함 15종 모델 카탈로그 제품 요구사항 |
