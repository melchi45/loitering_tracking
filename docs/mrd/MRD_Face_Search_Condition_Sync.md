# MRD — Face Search Condition Sync (Streaming ↔ Analysis)

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Cross-server face enrollment delegation + Face Search Condition visibility on the Analysis Server Dashboard
**Version:** 1.0
**Date:** 2026-07-08
**Author:** LTS Engineering Team

---

## 1. Executive Summary

In a distributed deployment (`SERVER_MODE=streaming` + `SERVER_MODE=analysis`), operators reported that enrolling a face photo into a gallery (VIP/Blocklist/Missing Persons/General) on the streaming server fails with **"Face service not available — models not loaded"**. The streaming server never loads local ONNX face models by design — AI inference runs on a separate GPU-backed analysis server — so the gallery-enrollment endpoint, which runs face-detect + embed synchronously in the request handler, has nothing to call.

Investigation also surfaced a related but separate gap: while live camera face matching against named galleries already works correctly end-to-end in distributed mode (the analysis server returns raw embeddings in its per-frame response, and the streaming server matches them locally), operators have no visibility on the **Analysis Server Dashboard** into how many face search conditions (enrolled named-gallery faces) are currently in effect, nor a way to add one directly from that dashboard.

This MRD covers both: (1) enrollment delegation so photo enrollment works regardless of which server in a distributed pair receives the request, and (2) a lightweight, display-only mirror of face search conditions on the analysis server with a dashboard drill-down.

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| Gallery photo enrollment silently fails on `SERVER_MODE=streaming` with a "models not loaded" error | Distributed deployments cannot manage VIP/Blocklist/Missing Persons galleries from the streaming server's own UI — the primary operator-facing surface |
| No visibility into which named-gallery search conditions are currently active on the analysis server | Operators running a dedicated GPU analysis box cannot confirm, from that box's own dashboard, what it is actually searching for without cross-referencing the streaming server |
| No fast propagation path for newly registered conditions between streaming and analysis servers | A newly enrolled missing-person photo depends entirely on shared-DB timing or the next incidental local reload to become visible for operational confirmation |

---

## 3. Target Users

| User | Context |
|---|---|
| Security Administrator | Manages face galleries via the streaming server's dashboard; expects enrollment to work the same way regardless of `SERVER_MODE` topology |
| GPU/Analysis Operator | Monitors the dedicated analysis server's own dashboard for pipeline health; needs to see what face conditions that node is actively contributing to matching for |
| Security Operator | Relies on `face_match` / `missing_person_match` alerts already working; unaffected by this feature but benefits from faster, more reliable enrollment |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | Face photo enrollment (`POST /api/galleries/:id/faces`) must succeed regardless of whether it is served by a `combined`, `streaming`, or `analysis` mode server, delegating the detect+embed step to a server with loaded models when the local one has none |
| BR-02 | The Analysis Server Dashboard must display a live count of active face search conditions (enrolled named-gallery faces), broken down by gallery type (Missing/VIP/Blocklist/General) |
| BR-03 | Clicking the count must open a detail view listing the active conditions |
| BR-04 | The detail view must allow adding a new face search condition directly, without navigating away from the analysis server's own dashboard |
| BR-05 | Conditions registered on a streaming server must propagate to the analysis server's dashboard promptly (push on change) and must self-heal within a bounded time window if a push is missed (periodic reconcile) |
| BR-06 | This feature must not introduce a second, independent face-matching engine — actual live-camera matching authority remains on the streaming server, which already works correctly today |

---

## 5. Success Metrics

- Enrolling a photo via `POST /api/galleries/:id/faces` returns `201` on a `streaming`-mode server with a reachable analysis server, instead of `503`
- The Analysis Server Dashboard's face search condition count reflects a newly enrolled streaming-side face within 5 seconds under normal network conditions
- Adding a condition from the Analysis Server Dashboard's detail view succeeds without requiring the operator to open the streaming server's UI

---

## 6. Out of Scope

- Real-time (per-frame) named-gallery matching performed on the analysis server itself — matching stays on the streaming server, unchanged
- Reverse propagation of conditions added on the analysis server back to the streaming server over HTTP (relies on shared MongoDB when deployed that way; documented as a constraint, not solved by a new network path)
- Any change to the `face_match` / `missing_person_match` Socket.IO event shapes or cooldown behavior

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-08 | 초기 작성 — 얼굴 등록 위임(Fix) + 얼굴 검색 조건 대시보드 가시성(Feature) 2건 통합 MRD |
