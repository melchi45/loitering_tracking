# REQUEST FOR PROPOSAL (RFP)
# AI Module — Gender Classification

| | |
|---|---|
| **RFP Reference** | LTS-2026-AI-11 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-07-14 |
| **Zone Target Key** | `genderClassification` |
| **Status** | **Proposed (opt-in) — model catalog family scaffolded, dual-model selectable** |
| **Version** | 1.2 |
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
9. [Relationship to Existing `gender` Attribute](#9-relationship-to-existing-gender-attribute)
10. [Appendix](#10-appendix)

---

## 1. Overview

### 1.1 Purpose

This RFP defines requirements for a dedicated **Gender Classification AI Module** that predicts a detected person's gender from a face or body crop. Unlike the existing coarse `gender` attribute (a byproduct of the cloth-PAR classifier, see §9), this module is a purpose-built model selectable independently in the Admin Dashboard's AI Models catalog, following the exact same opt-in / admin-selectable pattern already used for Age Estimation ([RFP_AI_Age_Estimation.md](RFP_AI_Age_Estimation.md)).

### 1.2 Scope

- Dedicated `gender-classification` model catalog family with two selectable models (a model that reuses the already-available InsightFace GenderAge ONNX file vs. a dedicated precision ViT classifier)
- Face-crop-first, person(body)-crop-fallback input strategy — identical to Age Estimation
- Admin Dashboard Activate/Download support, reusing the existing generic per-family model catalog UI
- Reuses the existing `hfOptimumExport` PT→ONNX conversion mechanism (introduced for Age Estimation's ViT Age Classifier) for the ViT Gender Classifier — no new conversion pipeline needed

### 1.3 Zone Target Key

Zones/analytics configured with the `genderClassification` toggle activate gender prediction for all tracked persons in that camera. Useful for demographic analytics, incident description enrichment, and missing-person search filtering.

---

## 2. Use Cases

| Use Case | Description |
|---|---|
| Demographic analytics | Gender distribution reporting for foot-traffic analysis |
| Incident description enrichment | "Male, appears 20s, red hoodie" style descriptions (paired with Age Estimation) |
| Missing person search | Gender as an additional filter alongside face/appearance/age search |

---

## 3. Technical Requirements

| Requirement | Specification |
|---|---|
| Input source | Face crop (SCRFD-aligned, preferred) or YOLOv8 person bbox crop (fallback) |
| Minimum crop size | 32×32px (face) / 60×150px (person, 1080p) |
| Output | `{value: 'male'\|'female', confidence}` for both models (normalized to the same shape) |
| Simultaneous persons | Up to 20 per frame (shared budget with existing attribute pipeline) |
| Activation | Opt-in via `analyticsConfig.genderClassification` (default `false`) — no behavior change unless explicitly enabled |
| Model selection | Exactly one of the two catalog entries active at a time, switchable via Admin Dashboard (same UX as Age Estimation) |

---

## 4. Model Options

| | InsightFace GenderAge (lightweight) | ViT Gender Classifier (precision) |
|---|---|---|
| Catalog id | `insightface-genderage-gender` | `vit-gender-classifier` |
| Source | Same pre-built ONNX file as Age Estimation's `insightface-genderage` entry (`genderage.onnx`) — this service reads the gender channels (`output[0:2]`) that Age Estimation's service ignores | HuggingFace `rizvandwiki/gender-classification-2` PyTorch checkpoint → ONNX via the existing `hfOptimumExport` conversion path |
| Backbone | Small CNN (InsightFace `genderage` model) | Vision Transformer (ViT) image classifier |
| Input | 96×96 | 224×224 |
| Output | 2-class gender softmax (+ age, ignored here) | 2-class gender softmax (`female`, `male`) |
| Size | ~1.3MB (shared with Age Estimation if both active) | ~330MB (ViT-base) |
| License | InsightFace non-commercial research license — acceptable, this project is non-commercial | See HuggingFace model card (99.1% eval accuracy per model card) |
| PT→ONNX exercised? | No (ships as ONNX already) | **Yes** — reuses the `hfOptimumExport` path proven by Age Estimation's ViT Age Classifier |

Both models are marked **Proposed** in the catalog (same convention as Age Estimation) until end-to-end accuracy is verified against a downloaded model file.

**Note on shared model file:** `insightface-genderage-gender` and Age Estimation's `insightface-genderage` point at the identical `genderage.onnx` file. If both toggles are enabled simultaneously, each service (`AgeEstimationService`, `GenderClassificationService`) independently opens its own ONNX session on that file — no cross-service session sharing, keeping the two services fully decoupled (consistent with every other independent attribute service in this codebase). This costs a small amount of duplicate memory when both are active but avoids the complexity of shared-session lifecycle management.

---

## 5. Input Source Strategy

Identical to Age Estimation ([RFP_AI_Age_Estimation.md §5](RFP_AI_Age_Estimation.md#5-input-source-strategy)): face crop preferred when available (from `AttributePipeline`'s SCRFD detection, when `face` is enabled), falling back to the YOLOv8 person bbox crop otherwise. The result carries a `source: 'face' | 'body'` tag.

---

## 6. Integration Requirements

### 6.1 Model Catalog (`server/src/routes/analysisApi.js`)

New family `gender-classification` in `EXTENDED_CATALOG`, wired into `_activeFileForEntry()`, `/models/switch`, `/models/download`, and `/models/deactivate` exactly like `age-estimation`.

### 6.2 Admin Dashboard

`ADMIN_MODULE_GROUPS` gains a `genderClassification` toggle item; `EXTENDED_SERIES_ORDER`/`PROPOSED_SERIES` gain `'Gender Classification'`. No bespoke UI component required.

### 6.3 Dual Entry-Point Requirement (learned from Age Estimation's 2026-07-14 incident)

Age Estimation was initially wired only into `pipelineManager.js`'s locally-captured-camera loop; `analysisApi.js`'s `POST /frame` handler (the entry point for `SERVER_MODE=streaming` delegated frames) never called `AgeEstimationService` at all, so the field never appeared on any streaming-mode deployment until a follow-up fix (see [Design_AI_Age_Estimation.md §12.1](../design/Design_AI_Age_Estimation.md#121-진단-포인트-2026-07-14-운영-조사에서-확정)). **Gender Classification's estimation call must be implemented in both entry points from the initial implementation** — this RFP does not allow shipping only one and treating the other as a follow-up.

### 6.4 Tracking Persistence

`tracking.js`'s `Track` class gains an `estimatedGender` field and a matching `updateEstimatedGender()` method, mirroring the existing `estimatedAge`/`updateEstimatedAge()` pattern (which itself mirrors `color`/`cloth`/`accessories`).

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
| Catalog/Admin integration correctness | 30% | Matches existing family pattern exactly, zero bespoke UI |
| Both entry points wired at ship time | 30% | Both `pipelineManager.js` AND `analysisApi.js`'s `/frame` handler call the service from the initial commit (§6.3) |
| Input fallback correctness | 20% | Face-preferred, body-fallback verified in both branches |
| Graceful opt-out | 20% | No behavior change when `genderClassification` toggle is off or model missing |

---

## 9. Relationship to Existing `gender` Attribute

`colorClothService.js` already derives a `gender` attribute (`P['female'] >= THRESH ? 'female' : 'male'`) as one of the 26 PA100k attributes output by the cloth-PAR classifier (PromptPAR/OpenPAR). This is **not** replaced by the new Gender Classification module — the two are independent signals, exactly parallel to `ageGroup` vs. `estimatedAge`:

| | `gender` (existing, PAR) | `estimatedGender` (this RFP) |
|---|---|---|
| Source | Byproduct of cloth-PAR classifier | Dedicated gender model |
| Granularity | Binary (threshold 0.5) | Binary + confidence score |
| Requires | `cloth` toggle + PromptPAR/OpenPAR model | `genderClassification` toggle + InsightFace/ViT gender model |
| Input | Person body crop only | Face crop (preferred) or body crop |

Both may be active simultaneously; UI/reporting label them distinctly ("Gender (PAR)" vs. "Gender (Est.)"/"Gender Classification") to avoid confusion — same convention as Age Estimation's "Age Group (PAR)" vs. "Age (Est.)".

---

## 10. Appendix

### Appendix A: Related RFP Documents

| Document | Description |
|---|---|
| [RFP_AI_Age_Estimation.md](RFP_AI_Age_Estimation.md) | Sibling dedicated-attribute module; this RFP mirrors its structure and reuses its `hfOptimumExport` conversion path |
| [RFP_AI_Cloth_Analysis.md](RFP_AI_Cloth_Analysis.md) | Existing `gender` byproduct attribute (§9 above) |
| [RFP_AI_Model_Catalog.md](RFP_AI_Model_Catalog.md) | Model catalog family list (updated alongside this RFP) |

### Appendix B: Verification Caveat

The InsightFace GenderAge model's exact gender channel convention (`output[0]`=female, `output[1]`=male per the upstream `insightface` project's own `genderage.py`) has **not been verified against a live model file at RFP time** — must be confirmed once the model is downloaded, before trusting numeric output in production. See `docs/design/Design_AI_Gender_Classification.md` §Verification.

### Appendix C: Addendum — Appendix B's Verification Caveat Confirmed as an Actual Bug (2026-07-14)

Production observation: a real, roughly-50:50 gender split in camera traffic is classified as majority female by both candidate models. Direct comparison against `deepinsight/insightface`'s own `model_zoo/attribute.py` source (not just the channel-order convention Appendix B already flagged, but also the actual normalization constants and image channel order used) and the real HuggingFace `preprocessor_config.json` for `rizvandwiki/gender-classification-2` confirmed concrete preprocessing bugs shared with Age Estimation (reversed channel order, wrong normalization constants — see `RFP_AI_Age_Estimation.md` Appendix D and `docs/design/Design_AI_Gender_Classification.md` §13 for the full analysis). The systematic, one-sided nature of the bias (rather than random noise) is itself evidence pointing at a deterministic preprocessing bug like reversed RGB/BGR channel order, rather than an inherent model accuracy limit.

**Status (2026-07-15):** Phase 1 is implemented and passing 11/11 unit tests. **Phase 2–4 (graph diagnostic, landmark alignment, confidence thresholding, reference-image validation) remain unimplemented.**

---

> **END OF DOCUMENT — LTS-2026-AI-11**

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — Gender Classification AI 모듈 RFP, 듀얼 모델(InsightFace GenderAge 공유 파일 / ViT Gender Classifier) 제안, Age Estimation 2026-07-14 사고에서 배운 "양쪽 진입점 동시 구현" 요구사항(§6.3) 포함 |
| 1.1 | 2026-07-14 | Appendix C 신규 — Appendix B의 미검증 경고가 실제 프로덕션 버그(성비 50:50인데 대부분 여성으로 분류)로 확인됨을 기록. 근거와 개선 계획은 Design doc §13 참고 — 이번 개정은 계획 기록만, 구현은 후속 |
| 1.2 | 2026-07-15 | Appendix C에 구현 현황 추가 — Phase 1 완료(11/11 테스트 통과), Phase 2~4는 미구현임을 명시 |
