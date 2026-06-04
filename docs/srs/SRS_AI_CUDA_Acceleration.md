# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | SRS-LTS-AI-CUDA-01 |
| Version | 1.0 |
| Status | Active |
| Date | 2026-06-04 |
| Parent PRD | prd/PRD_AI_CUDA_Acceleration.md |
| Parent RFP | rfp/RFP_AI_CUDA_Acceleration.md |

---

## 1. Scope

This SRS defines requirements for CUDA-enabled ONNX session creation and fallback behavior in server-side video analytics services.

---

## 2. Functional Requirements

- FR-CUDA-001: The system shall read ONNX_CUDA to determine whether CUDA is requested.
- FR-CUDA-002: When CUDA is requested, the preferred execution provider list shall include cuda followed by cpu.
- FR-CUDA-003: If CUDA session creation fails and strict mode is disabled, the system shall retry session creation with cpu-only provider.
- FR-CUDA-004: If ONNX_CUDA_STRICT=1 and CUDA session creation fails, the system shall not perform CPU fallback.
- FR-CUDA-005: Shared ONNX session creation behavior shall be used by detection, face, PPE, fire/smoke, and cloth services.

---

## 3. Logging Requirements

- FR-CUDA-006: Startup logs shall include onnx mode, thread count, and provider list.
- FR-CUDA-007: Fallback log shall include failure reason and CPU retry notice.

---

## 4. Compatibility Requirements

- FR-CUDA-008: Behavior shall be identical on Windows and Linux for the same environment variables.
- FR-CUDA-009: CPU-only operation shall remain functional with ONNX_CUDA=0.

---

## 5. Non-Functional Requirements

- NFR-CUDA-001: No additional latency overhead in steady-state CPU path beyond one-time startup checks.
- NFR-CUDA-002: No changes to external REST/Socket contracts.

---

## 6. Traceability

- FR-CUDA-001..004 -> TC-CUDA-A group.
- FR-CUDA-005 -> TC-CUDA-B group.
- FR-CUDA-006..007 -> TC-CUDA-C group.
- FR-CUDA-008..009 -> TC-CUDA-D group.
