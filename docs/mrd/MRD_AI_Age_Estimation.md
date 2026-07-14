# MRD — AI Age Estimation Display, Persistence & Cross-Server Diagnostics

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Age Estimation end-to-end visibility (frame → model → DB → screen) across `combined`/`analysis`/`streaming` deployments
**Version:** 1.1
**Date:** 2026-07-14
**Author:** LTS Engineering Team

---

## 1. Executive Summary

The Age Estimation AI module (`AgeEstimationService`, InsightFace GenderAge / ViT Age Classifier) has computed a per-person `estimatedAge` value since 2026-07-12 and sent it over the live `detections` Socket.IO event — but it was never persisted to `detectionTracks`/`detectionSnapshots` and never rendered anywhere in the client, so operators enabling the toggle saw no observable effect and had no way to tell whether the feature was working, misconfigured, or simply not yet displayed. Fixed 2026-07-14, together with a second gap discovered while verifying the fix: in `SERVER_MODE=streaming` deployments (camera capture and AI inference on separate servers), there was no way to tell from the streaming server's own dashboard whether the *remote* analysis server had actually loaded an age model — the `/api/analysis/metrics` diagnostic endpoint silently omitted the field entirely.

This MRD covers both the display/persistence gap and the cross-server diagnosability gap, since both block the same operational outcome: an administrator being able to confirm "Age Estimation is enabled, a model is loaded, and it is visibly working" without reading server logs.

**Addendum (2026-07-14, same day, after live verification):** The diagnostic field alone was not sufficient to explain a real customer report of "still not displaying." Live diagnostic logging added to the running `streaming`-mode server revealed a third, more severe gap: `server/src/routes/analysisApi.js`'s `POST /frame` handler — the actual code path that processes frames delegated by a `streaming`-mode server — **never called `AgeEstimationService.estimateAge()` at all**. The service was wired only into the model-catalog switch/download/deactivate endpoints and into a *separate* local-camera processing loop in `pipelineManager.js` (used by `combined` mode or an `analysis`-mode server with its own directly-attached cameras). This meant `estimatedAge` could never appear for **any** `SERVER_MODE=streaming` deployment — independent of toggle state, model-load state, or connection health — a structural implementation gap, not a configuration or deployment-freshness issue as first suspected. Fixed same day (`analysisApi.js`, FR-AGE-033).

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| `estimatedAge` computed but never rendered anywhere in the client | Enabling the toggle produces zero observable change — operators cannot verify the feature works, and had no way to distinguish "not enabled" from "enabled but silently broken" |
| `estimatedAge` never persisted to `detectionTracks`/`detectionSnapshots` | Historical review (Detections tab, search) never shows age data even after the live-display gap is fixed — an investigator reviewing a past incident sees nothing |
| `SERVER_MODE=streaming` deployments split camera capture and AI inference across two physical servers | An operator on the streaming server's dashboard has no local signal of the remote analysis server's model-load state — `services.ageEstimation` was entirely absent from the metrics response operators already check for other AI services (`detector`, `attrPipeline`, `fireSmokeService`) |

---

## 3. Target Users

| User | Context |
|---|---|
| Security Operator | Watches the live Camera Grid / Fullscreen view and expects an enabled analytics toggle to produce a visible, distinguishable signal on tracked persons |
| Security Administrator | Manages a split `streaming`/`analysis` deployment (common for GPU-constrained sites) and needs to confirm the remote analysis server's AI services — including newly-added ones — are actually loaded, without SSH access to that machine's logs |
| Investigator | Reviews Detections timeline / search history after an incident and expects any attribute the system computed at capture time to still be retrievable |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | An enabled, working Age Estimation module must produce a visible result in at least the primary live-monitoring surface (Camera Grid / Fullscreen view), not only in the raw Socket.IO payload |
| BR-02 | Age Estimation results must survive beyond the live session — retrievable from Detections history and search after the original detection has scrolled out of view |
| BR-03 | Any AI service with a load/ready state must be discoverable via the same diagnostic surface (`/api/analysis/metrics`) already used for `detector`/`attrPipeline`/`fireSmokeService`, including newly-added modules |
| BR-04 | Documentation must distinguish, for a split `streaming`/`analysis` deployment, which half of the system a missing feature's root cause lives in — an operator should not need to inspect both servers' source code to know where to look |

---

## 5. Success Metrics

- With the toggle on and a model loaded, an operator watching the live Camera Grid sees an `age ~NN` label on tracked persons within one frame of a face/body crop being available
- Opening the Detections tab or running a search on a past detection shows the same `estimatedAge` value that was visible live
- `GET /api/analysis/metrics` on any server mode reports `services.ageEstimation` as one of `not_started`/`missing`/`loaded`/`failed` — never silently absent
- Given a `streaming` instance showing zero `estimatedAge` coverage in `detectionTracks`, an operator can determine within one diagnostic step (checking the remote analysis server's own `/api/analysis/metrics`) whether the cause is "toggle off," "model not loaded remotely," or "stale remote code" — see `Design_AI_Age_Estimation.md` §12.1

---

## 6. Out of Scope

- Verifying the numeric accuracy of either model's age output against ground truth (tracked separately — see `Design_AI_Age_Estimation.md` §11 Verification)
- Building a dedicated remote-health dashboard panel — the fix is a single diagnostic field added to an existing, already-polled endpoint
- Backfilling `estimatedAge` onto `detectionTracks`/`detectionSnapshots` rows written before this fix shipped (those rows simply lack the field, same as any other historical schema addition)

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — Age Estimation UI 표시/영속화 갭 및 streaming/analysis 서버 간 진단 가능성 갭 기록 |
| 1.1 | 2026-07-14 | Addendum — 라이브 진단 로그로 확인된 세 번째(실제 근본) 갭 기록: `analysisApi.js`의 `POST /frame` 핸들러가 Age Estimation을 전혀 호출하지 않던 구조적 결함(FR-AGE-033) |
