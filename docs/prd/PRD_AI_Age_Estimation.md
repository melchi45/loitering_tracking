---
**Document:** PRD_AI_Age_Estimation  
**Version:** 1.1  
**Status:** Draft  
**Date:** 2026-07-12  
**Parent RFP:** [RFP_AI_Age_Estimation](../rfp/RFP_AI_Age_Estimation.md)  
**Related SRS:** [SRS_AI_Age_Estimation](../srs/SRS_AI_Age_Estimation.md)  
**Related Design:** [Design_AI_Age_Estimation](../design/Design_AI_Age_Estimation.md)  
**Related TC:** [TC_AI_Age_Estimation](../tc/TC_AI_Age_Estimation.md)  
---

# PRD — AI Age Estimation

## 1. Overview

Add a dedicated, opt-in Age Estimation AI module that predicts a numeric age for each tracked person, selectable in the Admin Dashboard's AI Models catalog under a new `age-estimation` family — following the exact same admin-selectable, catalog-driven pattern already shipped for Cloth Attribute (PAR) and Human Parsing.

## 2. Goals

- Let an administrator activate age prediction with zero code changes, using the existing generic model catalog UI
- Offer a choice between a lightweight, always-available model and a heavier, more precise model — mirroring the PromptPAR/OpenPAR pattern
- Demonstrate and ship a genuine PT→ONNX conversion path for non-YOLO HuggingFace models, since the existing conversion pipeline only supports Ultralytics YOLO exports
- Degrade gracefully: with the toggle off or the model file absent, there is zero behavior change to the existing pipeline

## 3. Non-Goals

- Age-restricted zone alerting / enforcement policy (future phase)
- Replacing or modifying the existing `ageGroup` PA100k byproduct attribute (`colorClothService.js`) — the two coexist as independent signals (see RFP §9)
- Fine-tuning either model on surveillance-specific data — both ship as their public pretrained checkpoints

## 4. User Stories

| # | As a… | I want to… | So that… |
|---|---|---|---|
| US-01 | System administrator | See an "Age Estimation" section in AI Models with two selectable models | I can choose the accuracy/cost trade-off that fits my hardware |
| US-02 | System administrator | Download the ViT age classifier and have it actually convert PT→ONNX | I don't need a separate machine or manual export step |
| US-03 | System administrator | Toggle Age Estimation on/off independently of Face Recognition | I can enable it even when face detection is off (body-crop fallback) |
| US-04 | Operator | See an estimated age on tracked persons / search results | I can describe or filter persons more precisely |

## 5. Functional Requirements Summary

(Full detail in [SRS_AI_Age_Estimation](../srs/SRS_AI_Age_Estimation.md).)

| Area | Requirement |
|---|---|
| Catalog | New `age-estimation` family, two entries, wired into `_activeFileForEntry`/`/models/switch`/`/models/download` |
| Conversion | New `hfOptimumExport` source strategy (HuggingFace `optimum`, not `ultralytics`) |
| Input | Face crop preferred, person-bbox fallback |
| Config | `analyticsConfig.ageEstimation` toggle, default `false` |
| Persistence | `tracking.js` `Track` gains an `estimatedAge` field + `updateEstimatedAge()`, mirroring the existing `color`/`cloth`/`accessories` pattern |
| UI | `ADMIN_MODULE_GROUPS`, `EXTENDED_SERIES_ORDER`, `PROPOSED_SERIES`, `ModelCatalogEntry.family` union updated — no new component |

## 6. Rollout

Ships as **Proposed / opt-in**, same convention as Human Parsing and Appearance Re-ID: default-disabled, model files not pre-downloaded, no impact on existing deployments until an administrator explicitly downloads a model and enables the toggle.

## 7. Success Metrics

- Both catalog entries download/convert successfully in a clean environment with the documented Python dependencies installed
- Toggling `ageEstimation` on with no model downloaded does not error or degrade other analytics
- Face-crop and body-crop fallback paths both produce a normalized `{value, source}` result in manual testing

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-12 | 초기 작성 — Age Estimation PRD |
| 1.1 | 2026-07-12 | §5 Persistence 행 정정 — 실제 코드 패턴(Track 필드 + updater 메서드)으로 서술 수정 |
