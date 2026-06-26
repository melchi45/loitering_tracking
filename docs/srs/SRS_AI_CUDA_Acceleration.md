# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# AI Module - CUDA Acceleration for Video Analytics

| | |
|---|---|
| Document ID | SRS-LTS-AI-CUDA-01 |
| Version | 1.2 |
| Status | Active |
| Date | 2026-06-26 |
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
- FR-CUDA-014: The system shall provide a CLI script (`npm run check:gpu`) that reports CUDA/DML/CPU provider availability and batch inference configuration.
- FR-CUDA-015: Provider diagnostics utility shall return a structured object including per-provider availability, recommended provider, and batch inference settings reflecting current environment variables.
- FR-CUDA-016: The `checkGpuProviders.js` CLI script shall exit with code 0 on successful diagnostics execution.
- FR-CUDA-017: The system shall support multi-camera batch inference by accumulating JPEG frames into a single `detectBatch()` call using `BatchDetectionQueue`.
- FR-CUDA-018: `BatchDetectionQueue` shall flush when `BATCH_MAX_SIZE` frames are accumulated or `BATCH_MAX_WAIT_MS` milliseconds elapse, whichever occurs first.
- FR-CUDA-019: If `detectBatch()` fails, the system shall automatically fall back to per-frame `detect()` calls without interrupting service.
- FR-CUDA-020: `detectBatch()` shall accept an array of JPEG buffers and produce a result array of equal length with per-frame detections.
- FR-CUDA-021: `DetectionService.supportsBatch` getter shall return `true` by default when the service is initialized.

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
- FR-CUDA-014..016 -> TC-GPU group.
- FR-CUDA-017..021 -> TC-BATCH group.

---

## 7. SDLC Amendment (v1.1)

- Added startup diagnostics requirements (FR-CUDA-010/011).
- Added Windows DML provider policy requirements (FR-CUDA-012/013).
- Added traceability mapping for new validation group (TC-CUDA-E).

## SDLC Amendment (v1.2)

- Added provider diagnostics CLI requirements (FR-CUDA-014..016).
- Added multi-camera batch inference requirements (FR-CUDA-017..021).
- Added TC-GPU and TC-BATCH group traceability mappings.

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
| FR-CUDA-014 | `docs/design/Design_AI_CUDA_Acceleration.md` §10 | `TC-GPU-001`, `TC-GPU-002`, `TC-GPU-003` |
| FR-CUDA-015 | `docs/design/Design_AI_CUDA_Acceleration.md` §10.2 | `TC-GPU-004` |
| FR-CUDA-016 | `docs/design/Design_AI_CUDA_Acceleration.md` §10.1 | `TC-GPU-005` |
| FR-CUDA-017 | `docs/design/Design_AI_CUDA_Acceleration.md` §9.1 | `TC-BATCH-001`, `TC-BATCH-002`, `TC-BATCH-003` |
| FR-CUDA-018 | `docs/design/Design_AI_CUDA_Acceleration.md` §9.1 | `TC-BATCH-004` |
| FR-CUDA-019 | `docs/design/Design_AI_CUDA_Acceleration.md` §9.3 | `TC-BATCH-005` |
| FR-CUDA-020 | `docs/design/Design_AI_CUDA_Acceleration.md` §9.1 | `TC-BATCH-006`, `TC-BATCH-007` |
| FR-CUDA-021 | `docs/design/Design_AI_CUDA_Acceleration.md` §2 | `TC-BATCH-008` |

Reference documents:
- `docs/design/Design_AI_CUDA_Acceleration.md`
- `docs/tc/TC_AI_CUDA_Acceleration.md`
- `docs/ops/GPU_Provider_Setup.md`
- `docs/ops/ONNX_Runtime_Provider_Diagnostics.md`

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-05 | 초기 작성 |
| 1.1 | 2026-06-05 | 시작 진단(FR-CUDA-010/011), Windows DML 정책(FR-CUDA-012/013), TC-CUDA-E 추적성 추가 |
| 1.2 | 2026-06-26 | Provider 진단 CLI(FR-CUDA-014~016), 멀티카메라 배치 추론(FR-CUDA-017~021), TC-GPU·TC-BATCH 그룹 추적성 추가 |
