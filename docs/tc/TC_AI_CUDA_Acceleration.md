# TEST CASES (TC)
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | TC-LTS-AI-CUDA-01 |
| Version | 1.1 |
| Status | Active |
| Date | 2026-06-05 |
| Parent SRS | srs/SRS_AI_CUDA_Acceleration.md |

---

## 1. Test Strategy

Validate provider selection and fallback behavior with environment-driven startup scenarios on Windows and Linux.

---

## 2. Test Group A - Provider Selection

- TC-CUDA-A-001: ONNX_CUDA=0 -> providers are cpu-only.
- TC-CUDA-A-002: ONNX_CUDA=1 on CUDA-ready host -> providers include cuda.
- TC-CUDA-A-003: ONNX_CUDA=1 on non-CUDA host with strict off -> fallback to cpu succeeds.
- TC-CUDA-A-004: ONNX_CUDA=1 on non-CUDA host with strict on -> startup fails with explicit error.

---

## 3. Test Group B - Service Coverage

- TC-CUDA-B-001: Detection service loads via shared session helper.
- TC-CUDA-B-002: Face service SCRFD/ArcFace load via shared helper.
- TC-CUDA-B-003: PPE, Fire/Smoke, and ColorCloth PAR services load via shared helper.

---

## 4. Test Group C - Logging

- TC-CUDA-C-001: Startup log contains mode and providers.
- TC-CUDA-C-002: Fallback event log contains CUDA failure reason and CPU retry message.

---

## 5. Test Group D - Cross-OS Compatibility

- TC-CUDA-D-001: Windows host passes A and B groups with same env controls.
- TC-CUDA-D-002: Linux host passes A and B groups with same env controls.

---

## 6. Test Group E - Startup Diagnostics and DML Policy

- TC-CUDA-E-001: Server startup logs `supportedBackends` exactly once.
- TC-CUDA-E-002: ONNX_CUDA=1 with no CUDA backend pre-disables CUDA before model session creation.
- TC-CUDA-E-003: Windows + ONNX_CUDA=0 selects `['dml','cpu']` preference.
- TC-CUDA-E-004: Windows + no DML backend pre-disables DML and continues with CPU fallback.

---

## 7. Exit Criteria

- All A/B/C/D/E groups pass in at least one Windows and one Linux validation environment.
- No REST/Socket contract regressions in smoke tests.

---

## 8. SDLC Amendment (v1.1)

- Added startup diagnostics verification coverage (TC-CUDA-E-001/002).
- Added Windows DML policy verification coverage (TC-CUDA-E-003/004).
- Updated exit criteria to include new E group.

---

## 9. SRS-to-TC Mapping

| SRS Requirement | Mapped TC(s) |
|---|---|
| FR-CUDA-001 | TC-CUDA-A-001, TC-CUDA-A-002 |
| FR-CUDA-002 | TC-CUDA-A-002 |
| FR-CUDA-003 | TC-CUDA-A-003 |
| FR-CUDA-004 | TC-CUDA-A-004 |
| FR-CUDA-005 | TC-CUDA-B-001, TC-CUDA-B-002, TC-CUDA-B-003 |
| FR-CUDA-006 | TC-CUDA-C-001 |
| FR-CUDA-007 | TC-CUDA-C-002 |
| FR-CUDA-008 | TC-CUDA-D-001, TC-CUDA-D-002 |
| FR-CUDA-009 | TC-CUDA-A-001 |
| FR-CUDA-010 | TC-CUDA-E-001 |
| FR-CUDA-011 | TC-CUDA-E-001 |
| FR-CUDA-012 | TC-CUDA-E-003 |
| FR-CUDA-013 | TC-CUDA-E-004 |
