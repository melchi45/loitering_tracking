---
**Document:** RFP_AI_Model_Catalog  
**Version:** 1.0  
**Status:** Draft  
**Date:** 2026-06-17  
**Related SRS:** [SRS_AI_Model_Catalog](../srs/SRS_AI_Model_Catalog.md)  
**Related PRD:** [PRD_AI_Model_Catalog](../prd/PRD_AI_Model_Catalog.md)  
**Related Design:** [Design_AI_Model_Catalog](../design/Design_AI_Model_Catalog.md)  
**Related TC:** [TC_AI_Model_Catalog](../tc/TC_AI_Model_Catalog.md)  
---

# RFP — AI Model Catalog & Runtime Model Switching

## 1. Background

The LTS-2026 analysis server uses a YOLO ONNX model for person/object detection. As Ultralytics releases new YOLO generations (v8 → YOLO11 → YOLO12), operators need to evaluate and switch models without downtime or server restart. Different deployment environments (edge CPU vs. GPU server) also require different model sizes (nano vs. xlarge).

## 2. Scope

This RFP covers the **YOLO model catalog**, **in-browser model download**, and **runtime hot-swap** functionality in the LTS-2026 analysis server (`SERVER_MODE=analysis` or `combined`).

## 3. Functional Requirements

### 3.1 Model Catalog API

| ID | Requirement |
|---|---|
| FR-RFP-MC-001 | The system shall expose a REST API listing all supported YOLO models with metadata (label, series, mAP, CPU ms, T4 ms, params, FLOPs, file name, download URL). |
| FR-RFP-MC-002 | The catalog shall include models from YOLOv8, YOLO11, and YOLO12 series in nano/small/medium/large/xlarge sizes (15 models total). |
| FR-RFP-MC-003 | Each catalog entry shall report the current download status (not_downloaded, downloading, converting, done) and whether it is the active model. |

### 3.2 Model Download

| ID | Requirement |
|---|---|
| FR-RFP-MC-004 | Operators shall be able to trigger model download from the Ultralytics GitHub release server via a REST API call. |
| FR-RFP-MC-005 | YOLOv8 and YOLO11 models shall be downloaded directly as ONNX files. |
| FR-RFP-MC-006 | YOLO12 models shall be downloaded as `.pt` (PyTorch) files and automatically converted to ONNX using the `ultralytics` Python package. |
| FR-RFP-MC-007 | The system shall auto-detect a working Python interpreter with `ultralytics` installed, falling back through multiple candidates. |
| FR-RFP-MC-008 | Download and conversion progress shall be observable in real-time. |

### 3.3 Runtime Model Switching

| ID | Requirement |
|---|---|
| FR-RFP-MC-009 | Operators shall be able to switch the active detection model at runtime without server restart. |
| FR-RFP-MC-010 | The model switch shall complete without interrupting ongoing inference or camera streams. |
| FR-RFP-MC-011 | All subsequent frames shall use the newly activated model immediately after the switch completes. |

## 4. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-MC-001 | Model download shall support HTTP 301/302 redirect (GitHub releases use CDN redirects). |
| NFR-MC-002 | YOLO12 PT→ONNX conversion shall complete within 5 minutes on a standard Linux system. |
| NFR-MC-003 | Temporary `.pt` files shall be deleted after successful ONNX conversion. |
| NFR-MC-004 | A concurrent download request for a model already downloading shall be rejected (HTTP 409). |

## 5. Constraints

- All supported YOLO series (v8/11/12) produce identical output shape `[1, 84, 8400]` — no post-processing code changes required when switching.
- YOLO12 official releases do not include pre-built ONNX artifacts; PT download + ultralytics export is mandatory.
- The feature is limited to `SERVER_MODE=analysis` and `SERVER_MODE=combined`.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — YOLOv8/YOLO11/YOLO12 모델 카탈로그 및 런타임 전환 요구사항 |
