---
**Document:** RFP_AI_Model_Catalog  
**Version:** 1.2  
**Status:** Draft  
**Date:** 2026-07-12  
**Related SRS:** [SRS_AI_Model_Catalog](../srs/SRS_AI_Model_Catalog.md)  
**Related PRD:** [PRD_AI_Model_Catalog](../prd/PRD_AI_Model_Catalog.md)  
**Related Design:** [Design_AI_Model_Catalog](../design/Design_AI_Model_Catalog.md)  
**Related TC:** [TC_AI_Model_Catalog](../tc/TC_AI_Model_Catalog.md)  
---

# RFP — AI Model Catalog & Runtime Model Switching

## 1. Background

The LTS-2026 analysis server uses a YOLO ONNX model for person/object detection, plus several other ONNX models for attribute/hazard analysis (face detection/recognition, PPE, fire & smoke, cloth-PAR). As Ultralytics releases new YOLO generations (v8 → YOLO11 → YOLO12 → YOLO26) and as the non-detector models are updated, operators need to evaluate and switch **any** of these models without downtime or server restart, and without SSH access to the server. Different deployment environments (edge CPU vs. GPU server) also require different model sizes (nano vs. xlarge).

## 2. Scope

This RFP covers the **full AI model catalog** (YOLO detector + face + PPE + fire/smoke + cloth-PAR + the proposed human-parsing/appearance-reid families), **in-browser model download**, and **runtime hot-swap** functionality in the LTS-2026 analysis server (`SERVER_MODE=analysis` or `combined`), surfaced through the Admin Dashboard's AI Models tab.

## 3. Functional Requirements

### 3.1 Model Catalog API

| ID | Requirement |
|---|---|
| FR-RFP-MC-001 | The system shall expose a REST API listing all supported models — across every AI model family, not only the YOLO detector — with metadata (label, series, family, mAP/benchmarks where applicable, file name, download URL where automatable). |
| FR-RFP-MC-002 | The catalog shall include YOLO detector models from YOLO26, YOLO12, YOLO11, and YOLOv8 series in nano/small/medium/large/xlarge sizes (20 detector entries), plus non-detector entries for face detection (SCRFD), face recognition (ArcFace), PPE (mask+helmet), fire & smoke, cloth-PAR, and the proposed human-parsing and appearance-reid families. |
| FR-RFP-MC-003 | Each catalog entry shall report the current download status (not_downloaded, downloading, converting, done, or manual-export-required) and whether it is the active model **for its family** — multiple families may each have an independently active model at the same time. |

### 3.2 Model Download

| ID | Requirement |
|---|---|
| FR-RFP-MC-004 | Operators shall be able to trigger model download/export for any automatable catalog entry via a REST API call, without SSH access to the server. |
| FR-RFP-MC-005 | Entries with a direct ONNX URL (YOLOv8, YOLO11, SCRFD, ArcFace) shall be downloaded directly as ONNX files. |
| FR-RFP-MC-006 | Entries requiring PyTorch conversion (YOLO26/YOLO12 from GitHub releases; PPE and Fire & Smoke from HuggingFace Hub) shall be downloaded as `.pt` files and automatically converted to ONNX using the `ultralytics` Python package (and `huggingface_hub` for the HuggingFace-sourced entries). |
| FR-RFP-MC-007 | The system shall auto-detect a working Python interpreter with the required packages (`ultralytics`, and `huggingface_hub` where applicable), falling back through multiple candidates. |
| FR-RFP-MC-008 | Download and conversion progress shall be observable in real-time (via polling). |
| FR-RFP-MC-009 | Entries with no automatable source (e.g. cloth-PAR's OpenPAR ResNet50 alternative, which has no public pretrained ONNX) shall be marked `manualOnly` in the catalog; a download request for such an entry shall be rejected with a clear error and a reference link, instead of silently failing. |
| FR-RFP-MC-010 | For cloth-PAR models whose backbone cannot run reliably on the available GPU (e.g. PromptPAR's CLIP ViT-L, forced onto CPU), the system shall verify sufficient free system RAM before activating the model; if insufficient, it shall refuse activation, log the reason, and disable the dependent analysis feature (Cloth Analysis) automatically rather than risk crashing the server. A lighter alternative model with no such constraint (OpenPAR ResNet50) shall remain independently selectable. |

### 3.3 Runtime Model Switching

| ID | Requirement |
|---|---|
| FR-RFP-MC-010 | Operators shall be able to switch the active model for any family at runtime without server restart. |
| FR-RFP-MC-011 | The model switch shall complete without interrupting ongoing inference or camera streams. |
| FR-RFP-MC-012 | All subsequent frames shall use the newly activated model immediately after the switch completes, scoped to that model's family only (switching the active PPE model must not affect the active YOLO detector, and vice versa). |

## 4. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-MC-001 | Model download shall support HTTP 301/302 redirect (GitHub releases and HuggingFace Hub use CDN redirects). |
| NFR-MC-002 | PT→ONNX conversion shall complete within 5 minutes on a standard Linux system, for both the GitHub-release and HuggingFace-Hub sourced entries. |
| NFR-MC-003 | Temporary `.pt` files shall be deleted after successful ONNX conversion. |
| NFR-MC-004 | A concurrent download request for a model already downloading shall be rejected (HTTP 409). A download request for a model that is already downloaded shall short-circuit with HTTP 200 `{ already: true }` instead of re-downloading. |

## 5. Constraints

- All supported YOLO detector series (v8/11/12/26) produce identical output shape `[1, 84, 8400]` — no post-processing code changes required when switching.
- YOLO26/YOLO12 official releases do not include pre-built ONNX artifacts; PT download + ultralytics export is mandatory.
- PPE and Fire & Smoke models have no pre-built ONNX release either; huggingface_hub `.pt` download + ultralytics export is mandatory.
- OpenPAR (cloth-PAR's ResNet50 alternative) has no publicly hosted pretrained checkpoint at all — the operator must train/export their own ONNX file and place it manually in `server/models/`. PromptPAR (cloth-PAR's shipped CLIP ViT-L model) ships pre-installed but is memory-gated (FR-RFP-MC-010) — the two are independently selectable, not mutually exclusive at the catalog level.
- The feature is limited to `SERVER_MODE=analysis` and `SERVER_MODE=combined`.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — YOLOv8/YOLO11/YOLO12 모델 카탈로그 및 런타임 전환 요구사항 |
| 1.1 | 2026-07-09 | 전체 모델 파일(얼굴 감지/인식·PPE·화재연기·의상PAR·Human Parsing·Appearance Re-ID)로 범위 확대 — FR-RFP-MC-001~003 재정의, hfExport/manualOnly 다운로드 전략 추가(FR-RFP-MC-006, 009), family별 독립 활성 모델 명시(FR-RFP-MC-003, 012) |
| 1.2 | 2026-07-12 | PromptPAR(PA100k) 통합 반영 — cloth-PAR가 PromptPAR(CLIP ViT-L, 배포됨)와 OpenPAR(ResNet50, manualOnly) 2개 모델로 구성됨을 명시, PromptPAR 사전 메모리 게이트 요구사항 신설(FR-RFP-MC-010) |
