# REQUEST FOR PROPOSAL (RFP)
# AI Module — Age Estimation

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-10 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-07-12 |
| **Zone Target Key** | `ageEstimation` |
| **Status** | **Proposed (opt-in) — model catalog family scaffolded, dual-model selectable** |
| **Version** | 1.4 |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Use Cases](#2-use-cases)
3. [Technical Requirements](#3-technical-requirements)
4. [Model Options](#4-model-options)
5. [Input Source Strategy](#5-input-source-strategy)
6. [Integration Requirements](#6-integration-requirements)
7. [Performance Requirements](#7-performance-requirements)
8. [Evaluation Criteria](#8-evaluation-criteria)
9. [Relationship to Existing `ageGroup` Attribute](#9-relationship-to-existing-agegroup-attribute)
10. [Appendix](#10-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for a dedicated **Age Estimation AI Module** that predicts a detected person's age from a face or body crop. Unlike the existing coarse 3-bucket `ageGroup` attribute (a byproduct of the cloth-PAR classifier, see §9), this module is a purpose-built model selectable independently in the Admin Dashboard's AI Models catalog, following the same opt-in / admin-selectable pattern already used for Cloth Attribute (PAR) and Human Parsing.

### 1.2 Scope

- Dedicated `age-estimation` model catalog family with two selectable models (lightweight regression vs. precision bucket classification)
- Face-crop-first, person(body)-crop-fallback input strategy
- Admin Dashboard Activate/Download support, reusing the existing generic per-family model catalog UI
- A new PT→ONNX conversion mechanism (`hfOptimumExport`) for non-Ultralytics HuggingFace Transformer models — the existing PT→ONNX pipeline only supports `ultralytics export()` (YOLO architectures)

### 1.3 Zone Target Key

Zones/analytics configured with the `ageEstimation` toggle activate age prediction for all tracked persons in that camera. Useful for demographic reporting, age-restricted area enforcement, and enriching incident descriptions.

---

## 2. Use Cases

| Use Case | Description |
|---|---|
| Demographic analytics | Age distribution reporting for foot-traffic analysis |
| Age-restricted area alerts | Flag minors detected in adult-only zones (future — not this phase) |
| Incident description enrichment | "Male, appears 20s, red hoodie" style descriptions |
| Missing person search | Age range as an additional filter alongside face/appearance search |

---

## 3. Technical Requirements

| Requirement | Specification |
|---|---|
| Input source | Face crop (SCRFD-aligned, preferred) or YOLOv8 person bbox crop (fallback) |
| Minimum crop size | 32×32px (face) / 60×150px (person, 1080p) |
| Output | Numeric age estimate (both models normalize to a single `value`), plus raw model-specific output (`bucket` for the ViT classifier) |
| Simultaneous persons | Up to 20 per frame (shared budget with existing attribute pipeline) |
| Activation | Opt-in via `analyticsConfig.ageEstimation` (default `false`) — no behavior change unless explicitly enabled |
| Model selection | Exactly one of the two catalog entries active at a time, switchable via Admin Dashboard (same UX as Cloth Attribute PAR) |

---

## 4. Model Options

| | InsightFace GenderAge (lightweight) | ViT Age Classifier (precision) |
|---|---|---|
| Catalog id | `insightface-genderage` | `vit-age-classifier` |
| Source | Pre-built ONNX (InsightFace `buffalo_l` pack), direct HTTP(S) download | HuggingFace `nateraw/vit-age-classifier` PyTorch checkpoint → ONNX via new `hfOptimumExport` conversion path |
| Backbone | Small CNN (InsightFace `genderage` model) | Vision Transformer (ViT) image classifier |
| Input | 96×96 | 224×224 |
| Output | Regression age value (+ gender, unused) | 9-class age bucket (`0-2` … `more than 70`) |
| Size | ~1.3MB | ~330MB (ViT-base) |
| License | InsightFace non-commercial research license — acceptable, this project is non-commercial | See HuggingFace model card |
| PT→ONNX exercised? | No (ships as ONNX already) | **Yes** — real conversion path via HuggingFace `optimum` |

Both models are marked **Proposed** in the catalog (same convention as Human Parsing / Appearance Re-ID) until end-to-end accuracy is verified against a downloaded model file.

---

## 5. Input Source Strategy

Per stakeholder decision, the module must support **both** input sources with automatic fallback:

1. If the current person track already has a face bbox (from `AttributePipeline`'s SCRFD detection, when the `face` module is enabled), use the aligned face crop — higher accuracy.
2. Otherwise, fall back to the YOLOv8 person bbox crop — lower accuracy, but available whenever `human` detection is enabled, independent of face detection.

The result carries a `source: 'face' | 'body'` tag so downstream consumers (UI, search, reports) can weight confidence accordingly.

---

## 6. Integration Requirements

### 6.1 Model Catalog (`server/src/routes/analysisApi.js`)

New family `age-estimation` in `EXTENDED_CATALOG`, wired into `_activeFileForEntry()`, `/models/switch`, and `/models/download` exactly like existing families (`cloth-par`, `human-parsing`, `appearance-reid`).

### 6.2 Admin Dashboard

`ADMIN_MODULE_GROUPS` gains an `ageEstimation` toggle item; `EXTENDED_SERIES_ORDER`/`PROPOSED_SERIES` gain `'Age Estimation'`. No bespoke UI component required — the generic per-family catalog table already renders Activate/Download per entry.

### 6.3 Tracking Persistence

`tracking.js`'s `Track` class gains an `estimatedAge` field and a matching `updateEstimatedAge()` method, following the same per-attribute pattern already used for `color`/`cloth`/`accessories` (`updateColor`/`updateCloth`/`updateAccessories`). The value actually shown to clients each frame is attached fresh to `attrObjects` by `pipelineManager.js` (throttled per-track cache) and flows through to `enrichedObjects` via `behaviorEngine.update()`'s object spread — the Track-level field exists for parity with the established pattern, not as the display mechanism itself.

---

## 7. Performance Requirements

| Metric | Requirement |
|---|---|
| Inference latency (InsightFace, CPU) | < 10ms/person |
| Inference latency (ViT, CPU) | < 80ms/person |
| Graceful degradation | If model file missing → `status: 'missing'`, feature silently no-ops (no crash, no track corruption) |
| Fallback correctness | When face bbox absent, must not throw — falls back to body crop or skips silently if neither available |

---

## 8. Evaluation Criteria

| Criterion | Weight | Description |
|---|:---:|---|
| Catalog/Admin integration correctness | 35% | Matches existing family pattern exactly, zero bespoke UI |
| PT→ONNX conversion viability | 30% | `hfOptimumExport` path actually produces a valid ONNX file from the HF checkpoint |
| Input fallback correctness | 20% | Face-preferred, body-fallback verified in both branches |
| Graceful opt-out | 15% | No behavior change when `ageEstimation` toggle is off or model missing |

---

## 9. Relationship to Existing `ageGroup` Attribute

`colorClothService.js` already derives a coarse 3-bucket `ageGroup` (`less18` / `18to60` / `over60`) as one of the 26 PA100k attributes output by the cloth-PAR classifier (PromptPAR/OpenPAR). This is **not** replaced by the new Age Estimation module — the two are independent signals:

| | `ageGroup` (existing) | `estimatedAge` (this RFP) |
|---|---|---|
| Source | Byproduct of cloth-PAR classifier | Dedicated age model |
| Granularity | 3 buckets | Numeric value (+ 9-bucket for ViT variant) |
| Requires | `cloth` toggle + PromptPAR/OpenPAR model | `ageEstimation` toggle + InsightFace/ViT model |
| Input | Person body crop only | Face crop (preferred) or body crop |

Both may be active simultaneously; UI/reporting should label them distinctly to avoid confusion.

---

## 10. Appendix

### Appendix A: Related RFP Documents

| Document | Description |
|---|---|
| [RFP_AI_Cloth_Analysis.md](RFP_AI_Cloth_Analysis.md) | Existing `ageGroup` byproduct attribute (§9 above) |
| [RFP_AI_Model_Catalog.md](RFP_AI_Model_Catalog.md) | Model catalog family list (updated alongside this RFP) |
| [RFP_CrossCamera_Face_Tracking.md](RFP_CrossCamera_Face_Tracking.md) | Face detection dependency for the face-crop input path |

### Appendix B: Verification Caveat

The exact HuggingFace mirror URL for InsightFace GenderAge and the precise ONNX input/output tensor contract (output channel order, age scale factor) are **not verified against a live model file at RFP time** — they must be confirmed against `session.inputNames`/`outputNames`/shape once the model is downloaded, before trusting numeric output in production. See `docs/design/Design_AI_Age_Estimation.md` §Verification.

### Appendix C: Addendum — UI Display Was Never Implemented Until 2026-07-14

The original RFP scope (§6.3) covered persistence parity with `color`/`cloth` at the `tracking.js` level, but the inference result (`estimatedAge`) was never actually wired into `detectionTracks`/`detectionSnapshots` DB persistence, nor rendered anywhere in the client — a gap that went unnoticed because the toggle defaults to off and the feature was never end-to-end verified against a live UI. Fixed 2026-07-14; see `docs/design/Design_AI_Age_Estimation.md` §12 (Line Flow) for the full frame-to-screen data path, including the `SERVER_MODE=streaming` split and the `services.ageEstimation` diagnostic field added to `/api/analysis/metrics`.

### Appendix D: Addendum — Appendix B's Verification Caveat Confirmed as an Actual Bug (2026-07-14)

Appendix B flagged the preprocessing contract as unverified against a live model. Production observation confirmed this was not a theoretical risk: InsightFace ages cluster near ~35 and ViT ages cluster in the `20-29` bucket almost regardless of the actual person. Direct comparison against the actual HuggingFace `preprocessor_config.json` (for both `nateraw/vit-age-classifier` and, for Gender Classification, `rizvandwiki/gender-classification-2`) and `deepinsight/insightface`'s own `model_zoo/attribute.py` source confirmed three concrete preprocessing bugs (wrong ViT normalization constants, reversed InsightFace channel order, wrong InsightFace normalization divisor) plus a structural mismatch (no face alignment, unlike `insightface`'s landmark-based similarity-transform crop). See `docs/design/Design_AI_Age_Estimation.md` §13 for the full analysis and the Phase 1–4 remediation plan.

**Status (2026-07-15):** Phase 1 (the three confirmed preprocessing bugs) is implemented and passing 11/11 unit tests. **Phase 2 (graph normalization diagnostic), Phase 3 (landmark alignment, body-crop reliability), and Phase 4 (reference-image validation harness) remain unimplemented.**

---

> **END OF DOCUMENT — LTS-2026-AI-10**

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-12 | 초기 작성 — Age Estimation AI 모듈 RFP, 듀얼 모델(InsightFace GenderAge / ViT Age Classifier) 제안 |
| 1.1 | 2026-07-12 | §6.3 정정 — 존재하지 않는 "sticky-attribute 목록" 대신 실제 코드 패턴(`color`/`cloth`/`accessories`와 동일한 Track 필드 + updater 메서드)으로 서술 수정 |
| 1.2 | 2026-07-14 | Appendix C 신규 — UI 표시가 실제로는 구현되지 않았던 갭과 2026-07-14 수정 사항을 addendum으로 기록 (원본 RFP 재작성 없이 추가만) |
| 1.3 | 2026-07-14 | Appendix D 신규 — Appendix B의 미검증 경고가 실제 프로덕션 버그로 확인됨을 기록(나이 대부분 ~35/`20-29`로 수렴). 근거와 개선 계획은 Design doc §13 참고 — 이번 개정은 계획 기록만, 구현은 후속 |
| 1.4 | 2026-07-15 | Appendix D에 구현 현황 추가 — Phase 1 완료(11/11 테스트 통과), Phase 2~4는 미구현임을 명시 |
