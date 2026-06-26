# TEST CASES (TC)
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | TC-LTS-AI-CUDA-01 |
| Version | 1.2 |
| Status | Active |
| Date | 2026-06-26 |
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

## 7. Test Group F - BatchDetectionQueue

- TC-BATCH-001: BatchDetectionQueue — 단건 enqueue는 `detect()` 또는 `detectBatch(size=1)` 위임 후 정상 결과 반환.
- TC-BATCH-002: BatchDetectionQueue — 복수 enqueue가 `detectBatch()` 단일 호출로 묶임 (batchSizes에 복수 입력 길이 기록).
- TC-BATCH-003: BatchDetectionQueue — `BATCH_MAX_SIZE` 초과 시 즉시 플러시.
- TC-BATCH-004: BatchDetectionQueue — `BATCH_MAX_WAIT_MS` 타임아웃 경과 후 플러시.
- TC-BATCH-005: BatchDetectionQueue — `detectBatch()` 실패 시 단건 `detect()` fallback으로 결과 정상 반환.
- TC-BATCH-006: DetectionService.detectBatch — 배치 텐서 shape `[B, 3, 640, 640]` 검증.
- TC-BATCH-007: DetectionService.detectBatch — 결과 배열 길이 == 입력 배열 길이.
- TC-BATCH-008: DetectionService.supportsBatch getter 초기값 `true` 확인.

---

## 8. Test Group G - Provider Diagnostics CLI

- TC-GPU-001: `providerDiagnostics.getProviderDiagnostics()` — 구조체에 `cuda`, `dml`, `cpu` 키 존재 확인.
- TC-GPU-002: `providerDiagnostics.getProviderDiagnostics()` — CPU는 항상 `available: true`.
- TC-GPU-003: `providerDiagnostics.getProviderDiagnostics()` — `recommended` 필드가 `'cuda'`, `'dml'`, `'cpu'` 중 하나.
- TC-GPU-004: `providerDiagnostics.getBatchInferenceInfo()` — `BATCH_MAX_SIZE`, `BATCH_MAX_WAIT_MS` 환경변수 값이 반영된 설정 반환.
- TC-GPU-005: `checkGpuProviders.js` CLI 스크립트 — `node checkGpuProviders.js` 실행 시 exit code 0으로 종료.

---

## 9. Exit Criteria

- All A/B/C/D/E/F/G groups pass in at least one Windows and one Linux validation environment.
- No REST/Socket contract regressions in smoke tests.
- TC-BATCH 그룹은 `test/api/batch_inference.test.js`로 Jest 자동화 실행.

---

## 10. SDLC Amendment (v1.1)

- Added startup diagnostics verification coverage (TC-CUDA-E-001/002).
- Added Windows DML policy verification coverage (TC-CUDA-E-003/004).
- Updated exit criteria to include new E group.

## SDLC Amendment (v1.2)

- Added TC-BATCH group (F) for BatchDetectionQueue and detectBatch() verification.
- Added TC-GPU group (G) for providerDiagnostics and checkGpuProviders CLI verification.
- Updated exit criteria to include F/G groups and Jest automation note.
- Updated SRS-to-TC mapping for FR-CUDA-014..021.

---

## 11. SRS-to-TC Mapping

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
| FR-CUDA-014 | TC-GPU-001, TC-GPU-002, TC-GPU-003 |
| FR-CUDA-015 | TC-GPU-004 |
| FR-CUDA-016 | TC-GPU-005 |
| FR-CUDA-017 | TC-BATCH-001, TC-BATCH-002, TC-BATCH-003 |
| FR-CUDA-018 | TC-BATCH-004 |
| FR-CUDA-019 | TC-BATCH-005 |
| FR-CUDA-020 | TC-BATCH-006, TC-BATCH-007 |
| FR-CUDA-021 | TC-BATCH-008 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-05 | 초기 작성 |
| 1.1 | 2026-06-05 | TC-CUDA-E 그룹(시작 진단, DML 정책) 추가, 종료 기준 업데이트 |
| 1.2 | 2026-06-26 | TC-BATCH 그룹(F, TC-BATCH-001~008), TC-GPU 그룹(G, TC-GPU-001~005) 추가, SRS-to-TC 매핑 확장 (FR-CUDA-014~021) |
