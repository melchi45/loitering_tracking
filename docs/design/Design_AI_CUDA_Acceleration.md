# DESIGN DOCUMENT
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | DESIGN-LTS-AI-CUDA-01 |
| Version | 1.1 |
| Status | Active |
| Date | 2026-06-05 |
| Parent SRS | srs/SRS_AI_CUDA_Acceleration.md |

---

## 1. Architecture Overview

The CUDA support design introduces a shared ONNX session factory in utils layer and routes all AI model services through the same session creation policy.

```text
service/*.js
  -> utils/onnxOptions.getOnnxSessionOptions()
  -> utils/onnxOptions.createOnnxSession()
       -> try preferred providers [cuda,cpu] when ONNX_CUDA=1
  -> try preferred providers [dml,cpu] on Windows when ONNX_CUDA=0
       -> fallback providers [cpu] when allowed

server/src/index.js
  -> utils/onnxOptions.runOnnxStartupDiagnostics()
  -> enumerate listSupportedBackends once
  -> pre-disable unavailable CUDA/DML providers
```

---

## 2. File-Level Design

- server/src/utils/onnxOptions.js
  - getOnnxSessionOptions(): mode-based provider/thread policy
  - createOnnxSession(): CUDA attempt + optional CPU fallback
  - runOnnxStartupDiagnostics(): one-time startup backend diagnostics and provider pre-disable
- server/src/services/detection.js
- server/src/services/faceService.js
- server/src/services/protectiveEquipService.js
- server/src/services/fireSmokeService.js
- server/src/services/colorClothService.js
- server/src/index.js (startup diagnostics invocation)

All listed services consume the shared session creation helper.

---

## 3. Runtime Policy

### 3.1 Environment Variables

- ONNX_CUDA=1 enables preferred CUDA provider chain.
- ONNX_CUDA_STRICT=1 enforces fail-fast when CUDA init fails.
- ONNX_THREADS_CUDA controls intra-op threads in CUDA mode.
- On Windows with ONNX_CUDA=0, provider preference is DirectML first.

### 3.2 Decision Matrix

- ONNX_CUDA=0: use cpu providers.
- ONNX_CUDA=0 + Windows + DML available: use dml providers.
- ONNX_CUDA=0 + Windows + DML unavailable: pre-disable DML and use cpu providers.
- ONNX_CUDA=1 + CUDA ready: use cuda providers.
- ONNX_CUDA=1 + CUDA unavailable + strict off: fallback to cpu.
- ONNX_CUDA=1 + CUDA unavailable + strict on: throw error.

---

## 4. Error Handling

- CUDA session create exceptions are caught centrally in createOnnxSession.
- CPU fallback path logs the original CUDA error message.
- Strict mode rethrows error to preserve explicit operator intent.

---

## 5. Operational Notes (Windows and Linux)

- Both OS paths use identical env controls and session policy.
- OS-specific differences are handled by CUDA driver/toolkit packaging, not by service code branching.

---

## 6. Verification Hooks

- onnxOptions startup log indicates selected mode/provider list.
- service load logs show per-model load result and fallback events.
- startup-check log indicates supported backend list and pre-disable decisions.

---

## 7. SDLC Amendment (v1.1)

- Added startup diagnostics control flow in `server/src/index.js`.
- Added provider pre-disable design to reduce repeated unavailable-provider noise.
- Added Windows DML-first runtime policy in decision matrix.

---

## 8. Requirements Traceability Matrix

| SRS Requirement | Verification Test Case(s) | Verification Scope |
|---|---|---|
| FR-CUDA-001 | TC-CUDA-A-001, TC-CUDA-A-002 | ONNX_CUDA env-based provider selection |
| FR-CUDA-002 | TC-CUDA-A-002 | CUDA provider priority order |
| FR-CUDA-003 | TC-CUDA-A-003 | CUDA failure with CPU fallback |
| FR-CUDA-004 | TC-CUDA-A-004 | Strict mode fail-fast behavior |
| FR-CUDA-005 | TC-CUDA-B-001, TC-CUDA-B-002, TC-CUDA-B-003 | Shared session helper coverage by services |
| FR-CUDA-006 | TC-CUDA-C-001 | Startup mode/provider logging |
| FR-CUDA-007 | TC-CUDA-C-002 | Fallback reason and retry logging |
| FR-CUDA-008 | TC-CUDA-D-001, TC-CUDA-D-002 | Cross-OS env control compatibility |
| FR-CUDA-009 | TC-CUDA-A-001 | CPU-only path continuity |
| FR-CUDA-010 | TC-CUDA-E-001 | One-time startup diagnostics execution |
| FR-CUDA-011 | TC-CUDA-E-001 | listSupportedBackends visibility at boot |
| FR-CUDA-012 | TC-CUDA-E-003 | Windows DML-first provider policy |
| FR-CUDA-013 | TC-CUDA-E-004 | DML pre-disable + CPU fallback continuity |
