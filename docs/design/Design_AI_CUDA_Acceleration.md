# DESIGN DOCUMENT
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | DESIGN-LTS-AI-CUDA-01 |
| Version | 1.0 |
| Status | Active |
| Date | 2026-06-04 |
| Parent SRS | srs/SRS_AI_CUDA_Acceleration.md |

---

## 1. Architecture Overview

The CUDA support design introduces a shared ONNX session factory in utils layer and routes all AI model services through the same session creation policy.

```text
service/*.js
  -> utils/onnxOptions.getOnnxSessionOptions()
  -> utils/onnxOptions.createOnnxSession()
       -> try preferred providers [cuda,cpu] when ONNX_CUDA=1
       -> fallback providers [cpu] when allowed
```

---

## 2. File-Level Design

- server/src/utils/onnxOptions.js
  - getOnnxSessionOptions(): mode-based provider/thread policy
  - createOnnxSession(): CUDA attempt + optional CPU fallback
- server/src/services/detection.js
- server/src/services/faceService.js
- server/src/services/protectiveEquipService.js
- server/src/services/fireSmokeService.js
- server/src/services/colorClothService.js

All listed services consume the shared session creation helper.

---

## 3. Runtime Policy

### 3.1 Environment Variables

- ONNX_CUDA=1 enables preferred CUDA provider chain.
- ONNX_CUDA_STRICT=1 enforces fail-fast when CUDA init fails.
- ONNX_THREADS_CUDA controls intra-op threads in CUDA mode.

### 3.2 Decision Matrix

- ONNX_CUDA=0: use cpu providers.
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
