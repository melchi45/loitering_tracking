# MRD — AI Inference CPU / DirectML / CUDA Provider Strategy

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** Adaptive ONNX Runtime execution provider selection (CPU baseline, Windows DirectML, CUDA GPU acceleration) across all AI model services
**Version:** 1.0
**Date:** 2026-07-28
**Author:** LTS Engineering Team

---

## 1. Executive Summary

LTS-2026 runs a growing number of ONNX models per detected person per frame — YOLOv8 detection, face recognition (SCRFD/ArcFace), PPE, fire/smoke, cloth-PAR, appearance Re-ID, age estimation, gender classification. On CPU-only hardware, this multi-model pipeline caps the number of concurrent camera channels a single server can analyze in real time. GPU acceleration (NVIDIA CUDA) removes this ceiling, but is not "free": the official `onnxruntime-node` npm package only ships a CUDA execution provider for Linux x64 — Windows prebuilt binaries only expose CPU/DirectML/WebGPU. Since a meaningful share of LTS-2026 deployments run on Windows (site security workstations, on-prem GPU boxes without a Linux team), this left Windows deployments unable to use CUDA at all until this feature area, even when a capable NVIDIA GPU was already installed and paid for.

This MRD covers the business case for (a) a CPU/DML/CUDA adaptive provider strategy so every deployment gets the best available acceleration without operator intervention, and (b) — newly in scope as of 2026-07-28 — a documented, repeatable path to unlock actual CUDA acceleration on Windows via a custom `onnxruntime-node` source build, since "just install a Linux prebuilt package" is not an option for our Windows install base.

---

## 2. Market / Operational Need

| Pain Point | Impact |
|---|---|
| CPU-only inference caps concurrent camera channel density | Sites with 16+ cameras see rising per-frame latency and dropped detection cadence, directly limiting the site sizes LTS-2026 can be sold into |
| Official `onnxruntime-node` Windows prebuilt package has no CUDA provider | Windows sites with an installed, paid-for NVIDIA GPU still run CPU-only inference — the hardware investment is wasted and GPU-accelerated throughput claims do not hold on our largest install-base OS |
| DirectML (Windows GPU fallback) is a partial mitigation, not parity | DML avoids CPU-only limits but shows materially different batch-scaling behavior than CUDA (no `nvidia-smi` visibility, different batch-size sweet spot) — it is not a like-for-like substitute for CUDA in throughput-sensitive deployments |
| No previously-documented, repeatable procedure existed to build a CUDA-enabled `onnxruntime-node` on Windows from source | Any attempt required unassisted trial-and-error against ONNX Runtime's C++/CMake build system, cmake-js's own Visual Studio auto-detection, and Windows-specific DLL loading semantics — not something a field engineer or site admin could reasonably reproduce without deep native build tooling experience |
| GPU acceleration is silently unavailable at runtime even after a "successful" build | A native addon can build with zero errors and all files physically present, yet still fail to actually use the GPU because of Windows DLL search-order rules for dynamically loaded CUDA/cuDNN dependencies — a gap invisible from build logs alone |

---

## 3. Target Users

| User | Context |
|---|---|
| Platform Engineer | Provisions LTS-2026 servers for both Windows and Linux sites and needs the same `ONNX_CUDA`/`ONNX_CUDA_STRICT` environment-variable contract to work identically across OSes |
| Field Engineer | Deploys or upgrades a Windows GPU box on-site and needs a documented, repeatable build+verify procedure rather than ad-hoc native-toolchain troubleshooting |
| Site Operator | Runs a multi-camera Windows deployment and expects the system to automatically use the best available provider (CUDA > DML > CPU) without manual per-camera tuning |
| Support / Operations | Diagnoses "GPU not being used" reports and needs a startup log and CLI tool (`npm run check:gpu`) that clearly states which provider is active and why a preferred one was not used |

---

## 4. Business Requirements

| ID | Requirement |
|---|---|
| BR-01 | The system must automatically select the best available execution provider (CUDA when requested and available, DirectML as the Windows default fallback, CPU otherwise) without requiring per-service or per-camera configuration |
| BR-02 | CPU-only deployments must remain fully functional and unaffected — GPU acceleration is strictly additive, never a hard dependency |
| BR-03 | Windows sites with an installed NVIDIA GPU must have a documented, repeatable path to obtain actual CUDA acceleration, since the official prebuilt `onnxruntime-node` package does not provide one on Windows |
| BR-04 | A successful native build must be operationally distinguishable from a build that is merely "complete" but non-functional at runtime — the verification procedure must include a real inference smoke test, not just a build exit code |
| BR-05 | Operations staff must be able to determine, from startup logs and a CLI diagnostic tool, which provider is active and the reason any preferred provider (CUDA/DML) was not used, without reading source code |

---

## 5. Success Metrics

- A Windows deployment with `ONNX_CUDA=1` and a CUDA-capable GPU shows `providers=["cuda","cpu"]` in startup logs for every AI service (detection, face, PPE, fire/smoke, cloth, appearance Re-ID, age, gender)
- A Windows deployment without CUDA (or with `ONNX_CUDA` unset) automatically falls back to `providers=["dml","cpu"]` with no operator action
- A CPU-only deployment (`ONNX_CUDA=0`, no DirectML) continues to run every AI service on `providers=["cpu"]` with zero functional regression
- Following the documented build procedure (`docs/ops/ONNX_Runtime_Source_Build_CUDA13.md` + `npm run build-ort:auto`), a field engineer can produce a working CUDA-enabled `onnxruntime-node` on a fresh Windows GPU box and confirm it with a real `InferenceSession.create()` + `session.run()` smoke test — not just a clean build log
- `npm run check:gpu` and server startup diagnostics report the active provider and, when a preferred provider is unavailable, the specific reason (missing backend, disabled at runtime, etc.)

---

## 6. Out of Scope

- TensorRT engine conversion/calibration (see `docs/rfp/RFP_AI_CUDA_Acceleration.md` §3 Out of Scope)
- Client-side (browser) GPU rendering acceleration
- Automated CI validation of the Windows CUDA source-build pipeline against real GPU hardware (the build pipeline and the runtime DLL-path fix are unit-testable; the actual multi-hour native compilation and GPU-backed inference smoke test remain a manual/field-engineer verification step)
- Linux CUDA source-build troubleshooting beyond what is already covered by `build-onnxruntime-source.linux.sh` and its existing ops guide

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-28 | 초기 작성 — CPU/DML/CUDA 적응형 provider 전략 및 Windows CUDA 소스 빌드 재현성 비즈니스 요구사항 기록 |
