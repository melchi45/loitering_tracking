---
**Document:** PRD_AI_Age_Estimation  
**Version:** 1.4  
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
| UI | `ADMIN_MODULE_GROUPS`, `EXTENDED_SERIES_ORDER`, `PROPOSED_SERIES`, `ModelCatalogEntry.family` union updated — no new component (Admin catalog only) |
| Operator-facing display (added 2026-07-14) | `estimatedAge` rendered in 4 locations — live Camera View overlay, Fullscreen detection list, Detections timeline detail, search result detail — and persisted to `detectionTracks`/`detectionSnapshots`. See `Design_AI_Age_Estimation.md` §12 (Line Flow) |
| Diagnostics (added 2026-07-14) | `GET /api/analysis/metrics` exposes `services.ageEstimation` so operators can tell whether a remote analysis server actually loaded a model, without reading server logs |

## 6. Rollout

Ships as **Proposed / opt-in**, same convention as Human Parsing and Appearance Re-ID: default-disabled, model files not pre-downloaded, no impact on existing deployments until an administrator explicitly downloads a model and enables the toggle.

## 7. Success Metrics

- Both catalog entries download/convert successfully in a clean environment with the documented Python dependencies installed
- Toggling `ageEstimation` on with no model downloaded does not error or degrade other analytics
- Face-crop and body-crop fallback paths both produce a normalized `{value, source}` result in manual testing
- **US-04 closed 2026-07-14**: an estimated age is now visible on tracked persons and search results in all 4 client locations (was generated server-side and sent over Socket.IO since v1.0, but never rendered or persisted anywhere until this date — see Design doc §12 Line Flow)
- **US-04 reopened 2026-07-14 (accuracy)**: visibility alone is not sufficient — production observation showed ages clustering near a near-constant value (~35 InsightFace, `20-29` bucket ViT) regardless of the actual person, meaning the displayed value fails to satisfy "I can describe or filter persons more precisely." Root-caused (confirmed preprocessing bugs vs. HuggingFace/`insightface` reference sources) and a Phase 1–4 remediation plan recorded in `Design_AI_Age_Estimation.md` §13
- **US-04 partially re-closed 2026-07-15**: Phase 1 (the 3 confirmed preprocessing bugs) is implemented and unit-tested (11/11 passing). **Phase 2 (graph normalization diagnostic), Phase 3 (landmark alignment, body-crop reliability), and Phase 4 (reference-image validation) remain unimplemented** — US-04 stays open until at least Phase 4 confirms real-world accuracy improvement against known reference faces

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-12 | 초기 작성 — Age Estimation PRD |
| 1.1 | 2026-07-12 | §5 Persistence 행 정정 — 실제 코드 패턴(Track 필드 + updater 메서드)으로 서술 수정 |
| 1.2 | 2026-07-14 | §5에 Operator-facing display/Diagnostics 행 추가, §7 US-04 closed 표기 — `estimatedAge`가 v1.0부터 생성만 되고 화면/DB 어디에도 도달하지 않던 갭을 발견·수정 (Design doc §12 Line Flow 참고) |
| 1.3 | 2026-07-14 | §7 US-04 재오픈(정확도) — 나이가 대부분 ~35/`20-29`로 수렴하는 실사용 관측을 기록, 개선 계획은 Design doc §13 참고. 구현은 후속 |
| 1.4 | 2026-07-15 | §7 Phase 1 구현 완료 반영 — 11/11 테스트 통과. Phase 2~4 미착수로 US-04는 계속 open 상태 유지 |
