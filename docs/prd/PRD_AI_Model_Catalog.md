---
**Document:** PRD_AI_Model_Catalog  
**Version:** 1.4  
**Status:** Draft  
**Date:** 2026-07-13  
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
| US-07 | System administrator | Deactivate (unload) an optional model I'm no longer using | I can free memory/VRAM without having to restart the server, and reactivate it later if needed |

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
| `cloth-par` | PromptPAR (PA100k) | shipped directly in `server/models/` — no automated download source, but the file is already present. Memory-gated: activation requires ≥2GB free system RAM (`PROMPTPAR_MIN_FREE_MEM_MB`), else it's refused, logged, and Cloth Analysis is auto-disabled (see §4.4) |
| `cloth-par` | OpenPAR (ResNet50, PA100k) | **manual export only** — no public pretrained ONNX exists. Not memory-gated. Admin-selectable alternative to PromptPAR |
| `human-parsing` (Proposed) | SCHP (LIP-20), SegFormer B2 Clothes | direct ONNX download |
| `appearance-reid` (Proposed) | OSNet (person Re-ID) | direct ONNX download |
| `age-estimation` (Proposed) | InsightFace GenderAge (buffalo_l) | direct ONNX download — ships pre-built |
| `age-estimation` (Proposed) | ViT Age Classifier (nateraw) | HuggingFace checkpoint → `optimum.exporters.onnx` (new — non-YOLO architecture, distinct from `ultralytics export`) |

Each family's active model is tracked independently — activating a new PPE model does not affect the active YOLO detector, face model, etc.

## 4. Product Requirements

### 4.1 Model Catalog Display

- `GET /api/analysis/models` returns `{ activeFile, catalog }` — `catalog` is an array covering every family above. Each entry carries (at minimum): `id, label, series, family?, file, exists, active, sizeBytes, downloading, converting, downloadPercent, downloadError, manualOnly?, license?`. YOLO detector entries additionally carry `mAP, cpuMs, t4Ms, params, flops`.
- UI displays the YOLO Detection Model table (grouped by series) plus one table per non-detector family, each with Download/Activate controls. `manualOnly` entries show a "Manual export" reference link instead of a Download button.

### 4.2 Download Flow

Direct ONNX (YOLOv8, YOLO11, SCRFD, ArcFace, human-parsing, appearance-reid, InsightFace GenderAge entries):
1. `POST /api/analysis/models/download { modelId }` → server downloads ONNX directly
2. Progress tracked in `_downloadProgress` map
3. `GET /api/analysis/models` reflects `downloading: true` while in progress

PT→ONNX conversion (YOLO26, YOLO12 — GitHub release `.pt`; PPE, Fire & Smoke — HuggingFace Hub `.pt`):
1. Server downloads (or `huggingface_hub`-resolves) the `.pt` file
2. Server runs `ultralytics export` (Python subprocess, max 5 min)
3. `GET /api/analysis/models` reflects `converting: true` during export
4. `.pt` file deleted after successful conversion

HuggingFace `optimum` conversion (ViT Age Classifier — new, non-YOLO architecture):
1. Server resolves and converts the HuggingFace checkpoint via `optimum.exporters.onnx.main_export(..., task="image-classification")` (Python subprocess, max 5 min) — `ultralytics export` cannot handle this architecture
2. `GET /api/analysis/models` reflects `converting: true` during export
3. Temporary export directory removed after the ONNX file is copied to `server/models/`

Manual-only (cloth-PAR / OpenPAR):
- `POST /api/analysis/models/download` returns HTTP 409 with a `docRef` link — there is no automatable source; the operator must export their own ONNX file and place it in `server/models/`.

Already downloaded (any family):
- `POST /api/analysis/models/download` short-circuits with HTTP 200 `{ already: true }` without re-downloading.

### 4.3 Model Switch

- `POST /api/analysis/models/switch { modelId }` — loads ONNX, then hot-swaps the corresponding service for that entry's family (`_detector` for YOLO, `AttributePipeline._face/_ppe/_color` for face/PPE/cloth-PAR/human-parsing, `AppearanceReidService` for appearance-reid, `AgeEstimationService` for age-estimation)
- Switch is synchronous on the hot-path but invisible to camera pipelines (next frame uses new model)
- Returns `{ ok: true, active: label, file }` on success

### 4.4 PromptPAR Memory Gate

- Switching to (or starting up with) PromptPAR (`openpar-pa100k`) checks free system RAM before loading; below the floor (default 2048MB), the switch fails with HTTP 500 and the reason is logged
- On gate failure, Cloth Analysis (`cloth` analytics config) is automatically turned off — the admin is not left with a stale "enabled" toggle pointing at a model that never loaded
- The admin can either free memory and retry, or activate OpenPAR (`openpar-resnet50-pa100k`) instead — there is no automatic fallback between the two
- OpenPAR is never subject to this gate

### 4.5 Model Deactivate

- `POST /api/analysis/models/deactivate { modelId }` — unloads the active model for that entry's family (releases the ONNX session and resets the family's ready state), leaving no model active until the operator clicks Activate again
- Available for the 8 non-YOLO families (face-detection, face-recognition, ppe, fire-smoke, cloth-par, human-parsing, appearance-reid, age-estimation) — **not** available for the YOLO detector, since person/object detection is core to the system and must always have an active model; requesting it returns HTTP 400
- Admin Dashboard shows a **Deactivate** button in place of the static "Active" label for any row where the model is currently active, in the extended-families table only
- Deactivating does not change the corresponding `analyticsConfig` toggle (e.g. `cloth`, `humanParsing`) — enrichment for that attribute simply returns `null`/absent until a model is active again, same as existing Phase-1 graceful degradation

## 5. Acceptance Criteria

| AC | Description |
|---|---|
| AC-01 | `GET /api/analysis/models` returns 20 YOLO detector entries (5 per series × YOLO26/12/11/v8) plus one entry per non-detector family listed in §3.4 |
| AC-02 | `POST /api/analysis/models/download` with a direct-ONNX ID (YOLOv8/YOLO11/SCRFD/ArcFace) downloads the ONNX file |
| AC-03 | `POST /api/analysis/models/download` with a PT-conversion ID (YOLO26/YOLO12/PPE/Fire-Smoke) downloads/resolves the PT file then converts to ONNX |
| AC-04 | `POST /api/analysis/models/switch` succeeds for any downloaded model, independently per family |
| AC-05 | Concurrent download request for an in-progress model returns HTTP 409; a download request for a `manualOnly` entry also returns HTTP 409 with a `docRef` |
| AC-06 | After switch, `GET /api/analysis/models` shows the new model as `active: true` for its family, without affecting other families' active models |
| AC-07 | Switching to PromptPAR when free system RAM is below the configured floor fails with HTTP 500, logs the reason, and disables Cloth Analysis (`cloth` config → `false`) |
| AC-08 | Switching to OpenPAR always proceeds regardless of free system RAM (no memory gate applies) |
| AC-09 | `POST /api/analysis/models/download` with `vit-age-classifier` triggers the `optimum` PT→ONNX conversion path and produces a valid ONNX file, distinct from the `ultralytics`-based conversion used by other families |
| AC-10 | `POST /api/analysis/models/deactivate` unloads the active model for any of the 8 non-YOLO families, after which `GET /api/analysis/models` shows `active: false` for every entry in that family |
| AC-11 | `POST /api/analysis/models/deactivate` for the YOLO detector family returns HTTP 400 and does not affect the active detector |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-17 | 초기 작성 — YOLO12 포함 15종 모델 카탈로그 제품 요구사항 |
| 1.1 | 2026-07-09 | 전체 모델 파일로 범위 확대 — §3.4 non-detector 패밀리 표 추가, §4 응답 형식(`catalog`/`exists`)·다운로드 전략(direct/PT변환/manualOnly)·이미 다운로드된 경우 단축 응답 반영, US-06·AC-01~06 갱신 |
| 1.2 | 2026-07-12 | PromptPAR(PA100k) 통합 반영 — `cloth-par` 패밀리에 PromptPAR(직접 배포, 메모리 게이트) + OpenPAR(ResNet50, manualOnly) 2개 모델 명시(§3.4), §4.4 신설(PromptPAR 사전 메모리 체크·게이트 실패 시 Cloth 분석 자동 비활성화·OpenPAR로 수동 전환), AC-07/AC-08 추가 |
| 1.3 | 2026-07-12 | `age-estimation` 패밀리(Proposed) 추가 — §3.4에 InsightFace GenderAge(직접 ONNX) + ViT Age Classifier(신규 `optimum` 변환 경로) 명시, §4.2/§4.3 갱신, AC-09 추가. 상세는 신규 `PRD_AI_Age_Estimation.md` 참조 |
| 1.4 | 2026-07-13 | Model Deactivate 기능 추가 — US-07·§4.5 신설(`POST /api/analysis/models/deactivate`, YOLO 탐지기 제외 8개 family 언로드), AC-10/AC-11 추가 |
