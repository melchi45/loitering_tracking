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

---

## GPU Provider 진단 CLI (npm run check:gpu)

서버 설치 환경에서 CUDA/DML/CPU 가용성을 빠르게 점검할 수 있는 CLI 스크립트입니다.

```bash
cd server
npm run check:gpu
```

### 진단 항목 표

| 진단 항목 | 확인 방법 | 상태 예시 |
|---|---|---|
| NVIDIA GPU 존재 여부 | `nvidia-smi` 실행 파싱 | OK / NOT FOUND |
| CUDA Toolkit 버전 | `nvcc --version` | OK (nvcc 12.1) / NOT FOUND |
| cuDNN 라이브러리 | `libcudnn*.so` 파일 탐색 (Linux) | OK / NOT FOUND |
| ORT CUDA Provider | `ort.listSupportedBackends()` | AVAILABLE / NOT AVAILABLE |
| ORT DirectML Provider | `ort.listSupportedBackends()` | AVAILABLE / NOT AVAILABLE |
| 배치 추론 설정 | `BATCH_MAX_SIZE`, `BATCH_MAX_WAIT_MS` 환경변수 | MAX_SIZE=4, MAX_WAIT=33ms |
| 권장 Provider | 위 진단 결과 기반 자동 결정 | cuda / dml / cpu |

### 스크립트 소스 위치

- `server/src/scripts/checkGpuProviders.js`
- `server/src/utils/providerDiagnostics.js` (진단 로직 유틸)

---

## 배치 추론 설정 환경변수

멀티카메라 배치 추론(`BatchDetectionQueue`)은 아래 환경변수로 제어합니다:

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `BATCH_MAX_SIZE` | `4` | 배치 최대 크기 (카메라 수 기준 설정 권장) |
| `BATCH_MAX_WAIT_MS` | `33` | 배치 최대 대기 ms (30fps 기준: 33ms = 1프레임) |

- `BATCH_MAX_SIZE` 개수가 채워지거나 `BATCH_MAX_WAIT_MS` 경과 시 즉시 플러시
- `detectBatch()` 실패 시 자동으로 단건 `detect()` fallback 처리

---

## DML GPU 모니터링 주의사항

DirectML(DML) 사용 시 `nvidia-smi`로는 GPU 사용률이 0%로 표시됩니다.
이는 DirectML이 Windows WDDM 드라이버 스택을 통해 GPU를 사용하기 때문입니다.

| 상황 | 올바른 모니터링 방법 |
|---|---|
| CUDA 사용 중 (ONNX_CUDA=1, Linux/Windows) | `nvidia-smi dmon -s u` — GPU SM 사용률 정상 표시 |
| DirectML 사용 중 (ONNX_CUDA=0, Windows) | Windows 작업 관리자 → 성능 탭 → GPU → 비디오 처리 또는 Compute |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-05 | 초기 작성 — 시작 진단, DML 정책, 환경 동작 정리 |
| 1.1 | 2026-06-26 | `npm run check:gpu` CLI 사용법 추가, 진단 항목 표, 배치 추론 환경변수, DML 모니터링 주의사항 추가 |
