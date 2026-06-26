# DESIGN DOCUMENT
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | DESIGN-LTS-AI-CUDA-01 |
| Version | 1.2 |
| Status | Active |
| Date | 2026-06-26 |
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
- server/src/utils/providerDiagnostics.js
  - getProviderDiagnostics(): CUDA/DML/CPU 가용성 상태 구조체 반환
  - getBatchInferenceInfo(): 배치 추론 환경변수(BATCH_MAX_SIZE, BATCH_MAX_WAIT_MS) 설정값 반환
- server/src/services/detection.js
  - detectBatch(jpegBuffers[]): [B,3,640,640] 배치 텐서 단일 session.run()
  - supportsBatch getter: 배치 추론 지원 여부
- server/src/services/batchDetectionQueue.js
  - BatchDetectionQueue: 멀티카메라 프레임 배치 큐 (enqueue/flush/fallback)
- server/src/services/faceService.js
- server/src/services/protectiveEquipService.js
- server/src/services/fireSmokeService.js
- server/src/services/colorClothService.js
- server/src/scripts/checkGpuProviders.js — CLI 진단 스크립트 (npm run check:gpu)
- server/src/index.js (startup diagnostics invocation)

All listed services consume the shared session creation helper.

---

## 3. Runtime Policy

### 3.1 Environment Variables

- ONNX_CUDA=1 enables preferred CUDA provider chain.
- ONNX_CUDA_STRICT=1 enforces fail-fast when CUDA init fails.
- ONNX_THREADS_CUDA controls intra-op threads in CUDA mode.
- On Windows with ONNX_CUDA=0, provider preference is DirectML first.
- BATCH_MAX_SIZE: 배치 최대 크기 (기본값 4, 멀티카메라 배치 추론).
- BATCH_MAX_WAIT_MS: 배치 최대 대기 시간 ms (기본값 33, 30fps 기준).

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

## 9. 멀티카메라 배치 추론 아키텍처 (v1.2)

여러 카메라에서 동시에 도착하는 JPEG 프레임을 단일 ONNX `session.run()` 호출로 처리합니다.

### 9.1 배치 큐 동작 원리

```text
카메라 A → enqueue(jpegA) ─┐
카메라 B → enqueue(jpegB) ─┤→ BatchDetectionQueue._flush()
카메라 C → enqueue(jpegC) ─┘       → detectBatch([jpegA, jpegB, jpegC])
                                          → session.run([B,3,640,640])
                                          → [resultA, resultB, resultC]
```

- `BATCH_MAX_SIZE` 개수가 채워지거나 `BATCH_MAX_WAIT_MS` 경과 시 즉시 플러시
- `detectBatch()` 실패 시 각 프레임을 개별 `detect()`로 fallback 처리

### 9.2 CUDA vs DML 배치 처리 차이

| 구분 | CUDA (Linux/Windows) | DirectML (Windows 전용) |
|---|---|---|
| SM 포화율 | 배치 단위 CUDA kernel launch → GPU SM 효율 극대화 | DML Command Queue 오버헤드 절감 |
| 배치 이점 | 고배치(B≥4)에서 현저한 속도 향상 | 중간 배치(B=2~4)에서 오버헤드 절감 |
| nvidia-smi | GPU 사용률 정상 표시 | GPU 사용률 0% (DirectML 특성) |
| 권장 모니터링 | nvidia-smi dmon | Windows 작업 관리자 → GPU |

### 9.3 배치 실패 Fallback 설계

- `detectBatch()` 예외 발생 시 `_supportsBatch` 플래그를 `false`로 전환
- 이후 모든 프레임은 단건 `detect()`로 우회하여 서비스 중단 없이 처리
- fallback 전환 로그: `[batchDetectionQueue] detectBatch failed — switching to single-frame fallback`

---

## 10. Provider 가용성 진단 (v1.2)

### 10.1 npm run check:gpu 사용법

```bash
cd server
npm run check:gpu
```

### 10.2 진단 항목

| 진단 항목 | 설명 |
|---|---|
| NVIDIA GPU 존재 여부 | nvidia-smi 실행 결과 파싱 |
| CUDA Toolkit 버전 | nvcc --version 확인 |
| cuDNN 라이브러리 | libcudnn 파일 존재 여부 (Linux) |
| ORT CUDA Provider | ort.listSupportedBackends() 내 cuda 존재 여부 |
| ORT DirectML Provider | ort.listSupportedBackends() 내 dml 존재 여부 |
| 배치 추론 설정 | BATCH_MAX_SIZE, BATCH_MAX_WAIT_MS 현재값 |
| 권장 Provider | 환경 기반 추천 (cuda/dml/cpu) |

### 10.3 진단 출력 예시

```
[LTS GPU Provider Diagnostics]
  nvidia-smi    : OK (NVIDIA GeForce RTX 3080, Driver 525.85.12)
  CUDA Toolkit  : OK (nvcc 12.1)
  cuDNN         : OK (/usr/lib/libcudnn.so.8)
  ORT CUDA      : AVAILABLE
  ORT DirectML  : NOT AVAILABLE
  Batch Config  : MAX_SIZE=4, MAX_WAIT=33ms
  Recommended   : cuda

→ ONNX_CUDA=1 설정 권장
```

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
| FR-CUDA-014 | TC-GPU-001, TC-GPU-002, TC-GPU-003 | Provider 가용성 진단 구조 검증 |
| FR-CUDA-015 | TC-GPU-004 | 배치 추론 환경변수 반영 |
| FR-CUDA-016 | TC-GPU-005 | checkGpuProviders CLI 스크립트 정상 실행 |
| FR-CUDA-017 | TC-BATCH-001, TC-BATCH-002, TC-BATCH-003 | BatchDetectionQueue enqueue/flush 동작 |
| FR-CUDA-018 | TC-BATCH-004 | BATCH_MAX_WAIT_MS 타임아웃 플러시 |
| FR-CUDA-019 | TC-BATCH-005 | detectBatch() 실패 시 단건 fallback |
| FR-CUDA-020 | TC-BATCH-006, TC-BATCH-007 | detectBatch() 배치 텐서 shape 및 결과 수 검증 |
| FR-CUDA-021 | TC-BATCH-008 | supportsBatch 초기값 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-05 | 초기 작성 |
| 1.1 | 2026-06-05 | 시작 진단 흐름, provider pre-disable, Windows DML 정책 추가 |
| 1.2 | 2026-06-26 | 멀티카메라 배치 추론 아키텍처 (§9), Provider 가용성 진단 (§10), providerDiagnostics.js·batchDetectionQueue.js 파일 설계 추가, 배치 환경변수 문서화, RTM 확장 (FR-CUDA-014~021) |
