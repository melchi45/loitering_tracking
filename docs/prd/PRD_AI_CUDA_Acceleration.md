# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | PRD-LTS-AI-CUDA-01 |
| Version | 1.2 |
| Status | Active |
| Date | 2026-06-26 |
| Parent RFP | rfp/RFP_AI_CUDA_Acceleration.md |

---

## 1. Product Goal

Provide a stable CUDA acceleration path for ONNX inference in LTS-2026 video analytics, while preserving CPU compatibility and current service contracts.

---

## 2. Personas

- Platform Engineer: needs predictable deployment across Windows/Linux.
- Site Operator: needs improved throughput without behavior changes in Web UI.

---

## 3. Product Requirements

- PR-01: ONNX_CUDA=1 enables preferred providers [cuda, cpu].
- PR-02: CUDA initialization failure automatically retries with [cpu].
- PR-03: ONNX_CUDA_STRICT=1 disables fallback and keeps fail-fast behavior.
- PR-04: Session creation behavior is shared across all AI services.
- PR-05: Startup diagnostics shall log supported ONNX backends once per server boot.
- PR-06: Windows runtime shall auto-prefer [dml, cpu] when ONNX_CUDA is disabled.
- PR-07: A CLI tool (`npm run check:gpu`) shall diagnose GPU provider availability and print a recommended provider without requiring server startup.
- PR-08: Multi-camera batch inference shall group concurrent JPEG frames into a single `detectBatch()` call, reducing GPU kernel invocation overhead.
- PR-09: Batch inference failure shall fall back gracefully to per-frame inference with no service downtime.

---

## 4. Success Metrics

- SM-01: Zero startup crash caused by missing CUDA runtime when strict mode is off.
- SM-02: All AI model services load successfully on CPU fallback path.
- SM-03: Startup logs expose mode and fallback events for operations teams.
- SM-04: On Windows, DML availability is visible at startup and fallback path remains deterministic.
- SM-05: `npm run check:gpu` completes with exit code 0 and displays CUDA/DML/CPU status and a recommended provider.
- SM-06: With `BATCH_MAX_SIZE=4`, four concurrent camera frames are processed in a single `detectBatch()` call.
- SM-07: `detectBatch()` failure triggers automatic single-frame fallback without service interruption.

---

## 5. Constraints

- Keep Node.js CommonJS runtime and current model paths.
- No external API schema changes.
- No mandatory dependency changes for CPU-only environments.

---

## 6. Release Criteria

- RC-01: SRS requirements mapped to TC cases.
- RC-02: Server code diagnostics pass for modified files.
- RC-03: Docs index updated to include CUDA SDLC chain.

---

## 7. SDLC Amendment (v1.1)

- Extended product scope from CUDA-only acceleration policy to provider-aware startup diagnostics.
- Added Windows DirectML auto-selection as the default GPU path when CUDA is not requested.
- Added release expectation for one-time startup backend visibility in operations logs.

## SDLC Amendment (v1.2)

- Added GPU provider diagnostics CLI tool (PR-07, SM-05).
- Added multi-camera batch inference product requirement (PR-08, SM-06).
- Added batch fallback product requirement (PR-09, SM-07).

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-05 | 초기 작성 |
| 1.1 | 2026-06-05 | provider-aware 시작 진단 범위 확장, Windows DML 자동 선택, 시작 로그 가시성 추가 |
| 1.2 | 2026-06-26 | Provider 진단 CLI(PR-07, SM-05), 멀티카메라 배치 추론(PR-08, SM-06), 배치 fallback(PR-09, SM-07) 추가 |
