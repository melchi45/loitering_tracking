# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | PRD-LTS-AI-CUDA-01 |
| Version | 1.1 |
| Status | Active |
| Date | 2026-06-05 |
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

---

## 4. Success Metrics

- SM-01: Zero startup crash caused by missing CUDA runtime when strict mode is off.
- SM-02: All AI model services load successfully on CPU fallback path.
- SM-03: Startup logs expose mode and fallback events for operations teams.
- SM-04: On Windows, DML availability is visible at startup and fallback path remains deterministic.

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
