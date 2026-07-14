# MRD — AI Gender Classification

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Dedicated Gender Classification AI module (InsightFace GenderAge / ViT Gender Classifier), shipped with full frame-to-screen coverage across `combined`/`analysis`/`streaming` deployments from day one
**Version:** 1.0
**Date:** 2026-07-14
**Author:** LTS Engineering Team

---

## 1. Executive Summary

This MRD introduces a dedicated Gender Classification AI module, selectable in the Admin Dashboard's AI Models catalog alongside the existing Age Estimation module. It reuses Age Estimation's proven patterns end-to-end: the model catalog family structure, the `hfOptimumExport` PT→ONNX conversion path, the face-preferred/body-fallback input strategy, and the `detectionTracks`/`detectionSnapshots` persistence + 4-location client display pattern.

Critically, this feature is scoped to **avoid repeating a real incident from Age Estimation's rollout**: on 2026-07-12, Age Estimation shipped with its inference call wired only into `pipelineManager.js`'s locally-captured-camera loop. `analysisApi.js`'s `POST /frame` handler — the entry point that actually processes frames for any `SERVER_MODE=streaming` deployment — never called `AgeEstimationService` at all, so `estimatedAge` could never appear on a split streaming/analysis deployment regardless of toggle state or model-load state. This was only discovered on 2026-07-14 via a user report and live diagnostic logging, requiring a same-day emergency fix (see `Design_AI_Age_Estimation.md` §12.1). Gender Classification's requirements explicitly mandate both entry points ship together (RFP §6.3, SRS FR-GEN-027/028, TC-GEN-015) so this class of gap cannot recur.

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| No dedicated gender signal independent of the coarse PA100k `gender` byproduct | Operators and search/reporting cannot distinguish a purpose-built, confidence-scored gender prediction from a cloth-classifier side-effect |
| Age Estimation's split-deployment gap (2026-07-12→2026-07-14) went undetected for two days | A new attribute module can silently never work on a common deployment topology (`streaming`+`analysis` split) unless both frame-processing entry points are verified at ship time, not discovered by a customer |
| Model file duplication risk if a new gender-only model were introduced independently of Age Estimation's already-downloaded `genderage.onnx` | Reusing the existing InsightFace file (which already ships gender channels, previously discarded) avoids an unnecessary duplicate download for operators who already have Age Estimation active |

---

## 3. Target Users

| User | Context |
|---|---|
| Security Operator | Watches the live Camera Grid / Fullscreen view and expects a gender prediction alongside the existing age estimate for richer incident descriptions |
| Security Administrator | Manages either a `combined` single-server deployment or a split `streaming`/`analysis` deployment, and must be able to trust that enabling a toggle produces the same result in both topologies without a follow-up patch |
| Investigator | Reviews Detections timeline / search history and expects gender data (like age) to be retrievable after the fact, not just live |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | An enabled, working Gender Classification module must produce a visible result in the primary live-monitoring surface (Camera Grid / Fullscreen view) |
| BR-02 | Gender Classification results must survive beyond the live session — retrievable from Detections history and search |
| BR-03 | The module must work identically in `combined`/`analysis` mode (local inference) and `SERVER_MODE=streaming` (remote-delegated inference) **from the first release** — both frame-processing entry points (`pipelineManager.js` local loop, `analysisApi.js` `/frame` handler) must be implemented and verified before ship, per the lesson learned from Age Estimation §RFP-6.3 |
| BR-04 | The diagnostic surface (`/api/analysis/metrics` `services` object) must expose `genderClassification` status on both response shapes (`pipelineManager`-backed and the standalone `analysis`-mode fallback) from the first release |

---

## 5. Success Metrics

- With the toggle on and a model loaded, an operator watching the live Camera Grid sees a `gender male|female` label on tracked persons within one frame of a face/body crop being available
- Opening the Detections tab or running a search on a past detection shows the same `estimatedGender` value that was visible live
- On a fresh `SERVER_MODE=streaming` deployment (never previously running Age Estimation's fix), `estimatedGender` appears in `detectionTracks` on the first attempt — no follow-up fix required, verified via TC-GEN-015
- `GET /api/analysis/metrics` reports `services.genderClassification` as one of `not_started`/`missing`/`loaded`/`failed` on both response shapes — never silently absent

---

## 6. Out of Scope

- Non-binary gender classification (both candidate models are binary male/female classifiers)
- Verifying the numeric accuracy of either model's gender output against ground truth beyond a basic sanity check (tracked separately — see `Design_AI_Gender_Classification.md` §11 Verification)
- Gender-based access policy or restricted-area enforcement
- Backfilling `estimatedGender` onto `detectionTracks`/`detectionSnapshots` rows written before this feature shipped

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — Gender Classification MRD, Age Estimation의 2026-07-12→07-14 스트리밍 모드 갭 사고를 반영해 "양쪽 진입점 최초 구현" 비즈니스 요구사항(BR-03/04) 명시 |
