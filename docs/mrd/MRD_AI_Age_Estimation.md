# MRD — AI Age Estimation Display, Persistence & Cross-Server Diagnostics

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Age Estimation end-to-end visibility (frame → model → DB → screen) across `combined`/`analysis`/`streaming` deployments
**Version:** 1.3
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

- ~~Verifying the numeric accuracy of either model's age output against ground truth~~ — **moved in-scope 2026-07-14** (§7 Addendum below) after this exact risk materialized in production
- Building a dedicated remote-health dashboard panel — the fix is a single diagnostic field added to an existing, already-polled endpoint
- Backfilling `estimatedAge` onto `detectionTracks`/`detectionSnapshots` rows written before this fix shipped (those rows simply lack the field, same as any other historical schema addition)

## 7. Addendum (2026-07-14) — Accuracy Business Impact

Once the display/persistence/diagnostic gaps above were fixed, a new problem surfaced that is arguably more damaging than the original "nothing shows" gap: **the feature shows a value on every person, and the value is wrong** — InsightFace ages cluster near ~35 and ViT ages cluster in the `20-29` bucket almost regardless of who is actually in frame. A feature that visibly displays confident-looking but systematically wrong data is worse for operator trust than a feature that visibly does nothing, since a wrong-but-plausible number is far less likely to be questioned than a blank field.

| Pain Point | Impact |
|---|---|
| Age estimates cluster near a near-constant value across visibly different people | Operators lose trust in the feature the first time they notice it; any downstream use (e.g. cross-referencing a missing-person age range) becomes actively misleading rather than merely unavailable |
| Root cause requires cross-referencing this codebase's preprocessing code against upstream model conventions (HuggingFace processor configs, `insightface` reference source) that were never verified when the feature shipped | Confirms the risk `Design_AI_Age_Estimation.md` §11/NFR-AGE-003 already flagged as unverified — this MRD's original "Out of Scope" call was the direct cause of this defect reaching production undetected |

**Business requirement (new):** BR-05 — Before an AI attribute estimation feature (age, gender, or future additions) is marked "verified" in this project's SDLC docs, its exact preprocessing contract (channel order, normalization constants, resize/alignment method) must be checked against an authoritative source (the model's own published processor config, or the reference implementation's source code) — not merely assumed from a similar-sounding convention used by a different model family. See `Design_AI_Age_Estimation.md` §13 for the concrete remediation plan and `Design_AI_Gender_Classification.md` §13 for the shared analysis (same underlying model file, same bug class).

**Implementation status (2026-07-15):** Phase 1 (the three confirmed preprocessing bugs — ViT normalization constants, InsightFace channel order, InsightFace normalization divisor) is implemented and unit-tested (`test/api/age_estimation.test.js`, 11/11 passing). **Phase 2 (ONNX graph normalization diagnostic), Phase 3 (landmark-based face alignment, body-crop reliability flagging), and Phase 4 (reference-image accuracy validation harness) are not yet implemented** — see Design doc §13.4 for the full phase breakdown. Since this deployment runs `SERVER_MODE=streaming`, the Phase 1 fix also requires redeployment to the remote analysis server before it takes effect in production.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-14 | 초기 작성 — Age Estimation UI 표시/영속화 갭 및 streaming/analysis 서버 간 진단 가능성 갭 기록 |
| 1.1 | 2026-07-14 | Addendum — 라이브 진단 로그로 확인된 세 번째(실제 근본) 갭 기록: `analysisApi.js`의 `POST /frame` 핸들러가 Age Estimation을 전혀 호출하지 않던 구조적 결함(FR-AGE-033) |
| 1.2 | 2026-07-14 | **§7 신규 — 정확도 비즈니스 영향 Addendum** — 나이가 대부분 ~35/`20-29`로 수렴하는 실사용 관측을 "값이 틀렸는데도 자신 있게 표시되어 오히려 신뢰를 해친다"는 비즈니스 관점에서 기록, BR-05(전처리 계약 검증 의무화) 신설. §6의 "정확도 검증은 범위 외" 항목을 이번 개정으로 범위 내로 이동 |
| 1.3 | 2026-07-15 | §7에 구현 현황 추가 — Phase 1 구현·테스트 완료, Phase 2~4는 미착수임을 명시 |
