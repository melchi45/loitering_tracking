# REQUEST FOR PROPOSAL (RFP)
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | RFP-LTS-AI-CUDA-01 |
| Version | 1.0 |
| Status | Approved |
| Date | 2026-06-04 |
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

---

## 5. Non-Functional Requirements

- NFR-01: No regression for CPU-only deployments.
- NFR-02: Startup logs shall show selected provider mode.
- NFR-03: Error messages shall clearly identify CUDA failure and fallback behavior.

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
