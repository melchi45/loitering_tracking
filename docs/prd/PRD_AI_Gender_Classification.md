---
**Document:** PRD_AI_Gender_Classification  
**Version:** 1.2  
**Status:** Draft  
**Date:** 2026-07-14  
**Parent RFP:** [RFP_AI_Gender_Classification](../rfp/RFP_AI_Gender_Classification.md)  
**Related SRS:** [SRS_AI_Gender_Classification](../srs/SRS_AI_Gender_Classification.md)  
**Related Design:** [Design_AI_Gender_Classification](../design/Design_AI_Gender_Classification.md)  
**Related TC:** [TC_AI_Gender_Classification](../tc/TC_AI_Gender_Classification.md)  
---

# PRD — AI Gender Classification

## 1. Overview

Add a dedicated, opt-in Gender Classification AI module that predicts a person's gender for each tracked person, selectable in the Admin Dashboard's AI Models catalog under a new `gender-classification` family — following the exact same admin-selectable, catalog-driven pattern already shipped for Age Estimation, and shipping with both frame-processing entry points (local camera loop and streaming-delegated `/frame` handler) wired in from day one.

## 2. Goals

- Let an administrator activate gender prediction with zero code changes, using the existing generic model catalog UI
- Offer a choice between a model that reuses the already-downloaded InsightFace GenderAge file (no extra download if Age Estimation is already active) and a dedicated precision ViT classifier
- Reuse the existing `hfOptimumExport` PT→ONNX conversion path proven by Age Estimation — no new conversion mechanism
- Ship both the local-camera-loop AND the streaming `/frame` handler estimation calls in the same initial change — Age Estimation shipped only the former and needed a same-day follow-up fix once a `SERVER_MODE=streaming` deployment reported the field never appearing (see `Design_AI_Age_Estimation.md` §12.1)
- Degrade gracefully: with the toggle off or the model file absent, there is zero behavior change to the existing pipeline

## 3. Non-Goals

- Gender-based access policy or restricted-area enforcement (out of scope for this phase)
- Replacing or modifying the existing `gender` PA100k byproduct attribute (`colorClothService.js`) — the two coexist as independent signals (see RFP §9)
- Fine-tuning either model on surveillance-specific data — both ship as their public pretrained checkpoints
- Non-binary gender classification — both candidate models output a binary male/female prediction; a future phase could revisit this if a suitable model is found

## 4. User Stories

| # | As a… | I want to… | So that… |
|---|---|---|---|
| US-01 | System administrator | See a "Gender Classification" section in AI Models with two selectable models | I can choose the accuracy/cost trade-off, and reuse the InsightFace file if Age Estimation is already downloaded |
| US-02 | System administrator | Download the ViT gender classifier and have it actually convert PT→ONNX | I don't need a separate machine or manual export step |
| US-03 | System administrator | Toggle Gender Classification on/off independently of Face Recognition | I can enable it even when face detection is off (body-crop fallback) |
| US-04 | Operator | See a predicted gender on tracked persons / search results, in both `combined` and `streaming` deployments | I can describe or filter persons more precisely regardless of deployment topology |

## 5. Functional Requirements Summary

(Full detail in [SRS_AI_Gender_Classification](../srs/SRS_AI_Gender_Classification.md).)

| Area | Requirement |
|---|---|
| Catalog | New `gender-classification` family, two entries, wired into `_activeFileForEntry`/`/models/switch`/`/models/download`/`/models/deactivate` |
| Conversion | Reuses existing `hfOptimumExport` source strategy (no new mechanism) |
| Input | Face crop preferred, person-bbox fallback |
| Config | `analyticsConfig.genderClassification` toggle, default `false` |
| Persistence | `tracking.js` `Track` gains an `estimatedGender` field + `updateEstimatedGender()`, `detectionTracks`/`detectionSnapshots` DB persistence, mirroring `estimatedAge` exactly |
| Dual entry point | `pipelineManager.js`'s local-camera loop AND `analysisApi.js`'s `POST /frame` handler both call `GenderClassificationService` from the initial implementation |
| UI | `ADMIN_MODULE_GROUPS`, `EXTENDED_SERIES_ORDER`, `PROPOSED_SERIES`, `ModelCatalogEntry.family` union updated — no new component; display in the same 4 client locations as Age Estimation (Camera View overlay, Fullscreen detection list, Detections timeline detail, search result detail) |
| Diagnostics | `getAnalysisMetrics()`'s `services` object includes `genderClassification`, mirroring the `ageEstimation` diagnostic field added 2026-07-14 |

## 6. Rollout

Ships as **Proposed / opt-in**, same convention as Age Estimation: default-disabled, model files not pre-downloaded, no impact on existing deployments until an administrator explicitly downloads a model and enables the toggle.

## 7. Success Metrics

- Both catalog entries download/convert successfully in a clean environment with the documented Python dependencies installed
- Toggling `genderClassification` on with no model downloaded does not error or degrade other analytics
- Face-crop and body-crop fallback paths both produce a normalized `{value, confidence, source}` result in manual testing
- Gender is visible on tracked persons and search results in **both** `combined`/`analysis` mode (local inference) and `SERVER_MODE=streaming` deployments (remote-delegated inference) from the first release — no follow-up fix required, unlike Age Estimation
- **US-04 reopened 2026-07-14 (accuracy)**: production observation showed a roughly 50:50 real gender split classified as majority female by both models, failing "I can describe or filter persons more precisely." Root-caused as sharing Age Estimation's confirmed preprocessing bugs (same `genderage.onnx` file, independently duplicated preprocessing code) — see `Design_AI_Gender_Classification.md` §13
- **US-04 partially re-closed 2026-07-15**: Phase 1 is implemented and unit-tested (11/11 passing). **Phase 2–4 (graph diagnostic, landmark alignment, confidence thresholding, reference-image validation) remain unimplemented** — US-04 stays open until real-world balanced-gender accuracy is confirmed

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — Gender Classification PRD, Age Estimation 2026-07-14 사고 교훈(양쪽 진입점 동시 구현) 반영 |
| 1.1 | 2026-07-14 | §7 US-04 재오픈(정확도) — 실제 성비 50:50에 가까운데도 대부분 여성으로 분류되는 실사용 관측을 기록, 개선 계획은 Design doc §13 참고. 구현은 후속 |
| 1.2 | 2026-07-15 | §7 Phase 1 구현 완료 반영 — 11/11 테스트 통과. Phase 2~4 미착수로 US-04는 계속 open 상태 유지 |
