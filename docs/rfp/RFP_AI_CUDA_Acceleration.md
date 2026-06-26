# REQUEST FOR PROPOSAL (RFP)
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | RFP-LTS-AI-CUDA-01 |
| Version | 1.2 |
| Status | Approved |
| Date | 2026-06-26 |
| Program | LTS-2026 |

---

## 1. Background

LTS-2026 performs real-time multi-model AI inference (human, face, PPE, fire/smoke, cloth) on incoming video streams. CPU-only operation limits channel density and increases per-frame latency.

---

## 2. Problem Statement

Current deployments require lower end-to-end inference latency and higher concurrent camera capacity without changing external APIs or dashboard behavior.

---

## 3. Scope

### In Scope

- Add production-grade CUDA execution path for ONNX Runtime sessions.
- Provide deterministic fallback to CPU when CUDA runtime is unavailable.
- Support both Windows and Linux deployment environments.
- Keep existing model files and service interfaces unchanged.

### Out of Scope

- TensorRT engine conversion and calibration.
- Client-side GPU rendering changes.
- Model architecture replacement.

---

## 4. Functional Requirements

- FR-01: System shall enable CUDA provider when ONNX_CUDA=1.
- FR-02: System shall fall back to CPU provider if CUDA session creation fails.
- FR-03: System shall support strict mode to fail fast when CUDA is required.
- FR-04: Existing AI services shall remain API-compatible.
- FR-05: System shall run ONNX provider startup diagnostics once at server boot.
- FR-06: On Windows with ONNX_CUDA=0, system shall prefer DirectML provider before CPU.
- FR-07: System shall provide a CLI script (`npm run check:gpu`) that diagnoses CUDA/DML/CPU provider availability and prints a structured report with a recommended provider.
- FR-08: System shall support multi-camera batch inference by grouping concurrent JPEG frames into a single `detectBatch()` call, controlled by `BATCH_MAX_SIZE` and `BATCH_MAX_WAIT_MS` environment variables.
- FR-09: If batch inference fails, system shall fall back to per-frame inference without service interruption.

---

## 5. Non-Functional Requirements

- NFR-01: No regression for CPU-only deployments.
- NFR-02: Startup logs shall show selected provider mode.
- NFR-03: Error messages shall clearly identify CUDA failure and fallback behavior.
- NFR-04: Startup diagnostics shall prevent repeated provider failure noise by pre-disabling unavailable providers.

---

## 6. Deliverables

- PRD for business and product acceptance.
- SRS with verifiable requirement IDs.
- Design document with file-level architecture.
- TC document for validation and release gate.
- Code changes in server-side inference services.

---

## 7. Acceptance Criteria

- AC-01: ONNX_CUDA=1 works on CUDA-ready hosts (Windows/Linux).
- AC-02: ONNX_CUDA=1 with missing CUDA runtime falls back to CPU unless strict mode enabled.
- AC-03: AI pipeline continues to load detection, face, PPE, fire/smoke, and cloth modules.
- AC-04: Startup diagnostics log supported backends exactly once at boot and clearly indicate CUDA/DML availability.
- AC-05: `npm run check:gpu` executes successfully (exit code 0) and outputs CUDA/DML/CPU provider status with a recommended provider string.
- AC-06: With `BATCH_MAX_SIZE=4`, four concurrent camera frames are processed in a single `detectBatch()` call.
- AC-07: `detectBatch()` failure triggers automatic per-frame fallback with no service downtime.

---

## 8. SDLC Amendment (v1.1)

- Added startup diagnostics requirement for ONNX providers.
- Added Windows DML auto-selection policy when CUDA is not requested.
- Added operational requirement to suppress repeated provider failure loops through pre-disable logic.

## SDLC Amendment (v1.2)

- Added GPU provider diagnostics CLI requirement (FR-07, AC-05).
- Added multi-camera batch inference requirement (FR-08, AC-06).
- Added batch fallback requirement (FR-09, AC-07).

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-05 | 초기 작성 |
| 1.1 | 2026-06-05 | 시작 진단(FR-05), Windows DML 자동 선택(FR-06), provider 사전 비활성화(NFR-04) 추가 |
| 1.2 | 2026-06-26 | Provider 진단 CLI(FR-07, AC-05), 멀티카메라 배치 추론(FR-08, AC-06), 배치 fallback(FR-09, AC-07) 추가 |
