# ONNX Runtime Provider Startup Diagnostics (Windows DML / CUDA)

## Summary

As of 2026-06-05, LTS-2026 performs a one-time ONNX provider diagnostics check at server startup.

- The server logs the supported ONNX Runtime backends once.
- If CUDA is requested (`ONNX_CUDA=1`) but unavailable, CUDA is disabled for the current runtime.
- On Windows (when CUDA is not requested), DirectML (`dml`) is preferred automatically.
- If DirectML is unavailable, the runtime falls back to CPU and avoids repeated provider failures.

## Implementation

- Startup hook: `server/src/index.js`
- Diagnostics logic: `server/src/utils/onnxOptions.js`

## Expected Startup Logs

```
[onnxOptions][startup-check] supportedBackends=[{"name":"cpu","bundled":true},{"name":"dml","bundled":true},{"name":"webgpu","bundled":true}]
[onnxOptions][startup-check] DirectML backend is available and will be preferred on Windows.
```

When CUDA is requested but unavailable:

```
[onnxOptions] CUDA execution provider is unavailable in this runtime. Falling back to CPU for all ONNX sessions. reason="startup-check: ..."
```

## Environment Behavior

- `ONNX_CUDA=1`
  - Tries `['cuda','cpu']`
  - If CUDA backend is missing, startup diagnostics disables CUDA and uses CPU fallback

- `ONNX_CUDA=0` on Windows
  - Tries `['dml','cpu']` automatically
  - If DML is missing, startup diagnostics disables DML and uses CPU fallback

- `ONNX_CUDA_STRICT=1`
  - Keeps strict CUDA behavior for CUDA-requested sessions

## Operational Recommendation

- Windows host: use DML auto mode (`ONNX_CUDA=0`) unless you intentionally run a CUDA-capable Linux/x64 runtime.
- Linux/x64 with compatible CUDA stack: use `ONNX_CUDA=1`.
