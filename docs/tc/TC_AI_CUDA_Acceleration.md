# TEST CASES (TC)
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | TC-LTS-AI-CUDA-01 |
| Version | 1.0 |
| Status | Active |
| Date | 2026-06-04 |
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

## 6. Exit Criteria

- All A/B/C/D groups pass in at least one Windows and one Linux validation environment.
- No REST/Socket contract regressions in smoke tests.
