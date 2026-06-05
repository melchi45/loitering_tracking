# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | SRS-LTS-AI-CUDA-01 |
| Version | 1.1 |
| Status | Active |
| Date | 2026-06-05 |
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
- FR-CUDA-010: System shall run a one-time ONNX backend startup diagnostics routine before model sessions are created.
- FR-CUDA-011: Startup diagnostics shall log listSupportedBackends output for operations visibility.
- FR-CUDA-012: On Windows with ONNX_CUDA=0, preferred providers shall be [dml, cpu].
- FR-CUDA-013: If DML is unavailable, system shall disable DML for the runtime and continue with CPU fallback.

---

## 5. Non-Functional Requirements

- NFR-CUDA-001: No additional latency overhead in steady-state CPU path beyond one-time startup checks.
- NFR-CUDA-002: No changes to external REST/Socket contracts.
- NFR-CUDA-003: Startup diagnostics shall emit provider availability logs at most once per process boot.

---

## 6. Traceability

- FR-CUDA-001..004 -> TC-CUDA-A group.
- FR-CUDA-005 -> TC-CUDA-B group.
- FR-CUDA-006..007 -> TC-CUDA-C group.
- FR-CUDA-008..009 -> TC-CUDA-D group.
- FR-CUDA-010..013 -> TC-CUDA-E group.

---

## 7. SDLC Amendment (v1.1)

- Added startup diagnostics requirements (FR-CUDA-010/011).
- Added Windows DML provider policy requirements (FR-CUDA-012/013).
- Added traceability mapping for new validation group (TC-CUDA-E).

---

## 8. Bidirectional Traceability Matrix

| Requirement ID | Design Reference | Test Reference |
|---|---|---|
| FR-CUDA-001 | `docs/design/Design_AI_CUDA_Acceleration.md` §8 | `TC-CUDA-A-001`, `TC-CUDA-A-002` |
| FR-CUDA-002 | `docs/design/Design_AI_CUDA_Acceleration.md` §3.2, §8 | `TC-CUDA-A-002` |
| FR-CUDA-003 | `docs/design/Design_AI_CUDA_Acceleration.md` §4, §8 | `TC-CUDA-A-003` |
| FR-CUDA-004 | `docs/design/Design_AI_CUDA_Acceleration.md` §4, §8 | `TC-CUDA-A-004` |
| FR-CUDA-005 | `docs/design/Design_AI_CUDA_Acceleration.md` §2, §8 | `TC-CUDA-B-001`, `TC-CUDA-B-002`, `TC-CUDA-B-003` |
| FR-CUDA-006 | `docs/design/Design_AI_CUDA_Acceleration.md` §6, §8 | `TC-CUDA-C-001` |
| FR-CUDA-007 | `docs/design/Design_AI_CUDA_Acceleration.md` §4, §6, §8 | `TC-CUDA-C-002` |
| FR-CUDA-008 | `docs/design/Design_AI_CUDA_Acceleration.md` §5, §8 | `TC-CUDA-D-001`, `TC-CUDA-D-002` |
| FR-CUDA-009 | `docs/design/Design_AI_CUDA_Acceleration.md` §3.2, §8 | `TC-CUDA-A-001` |
| FR-CUDA-010 | `docs/design/Design_AI_CUDA_Acceleration.md` §1, §2, §8 | `TC-CUDA-E-001` |
| FR-CUDA-011 | `docs/design/Design_AI_CUDA_Acceleration.md` §6, §8 | `TC-CUDA-E-001` |
| FR-CUDA-012 | `docs/design/Design_AI_CUDA_Acceleration.md` §3.1, §3.2, §8 | `TC-CUDA-E-003` |
| FR-CUDA-013 | `docs/design/Design_AI_CUDA_Acceleration.md` §3.2, §4, §8 | `TC-CUDA-E-004` |

Reference documents:
- `docs/design/Design_AI_CUDA_Acceleration.md`
- `docs/tc/TC_AI_CUDA_Acceleration.md`
