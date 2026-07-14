# OPERATIONS GUIDE
# GPU Provider Setup for LTS-2026 ONNX Runtime

| | |
|---|---|
| Document ID | OPS-GPU-001 |
| Version | 1.1 |
| Status | Active |
| Date | 2026-07-14 |
| Related Design | design/Design_AI_CUDA_Acceleration.md |
| Related SRS | srs/SRS_AI_CUDA_Acceleration.md |

---

## 1. 개요

LTS-2026 AI 파이프라인은 ONNX Runtime을 통해 GPU 가속 추론을 지원합니다.
이 문서는 CUDA(Linux/Windows) 및 DirectML(Windows) provider 설치와 멀티카메라 배치 추론 설정 방법을 안내합니다.

---

## 2. CUDA Toolkit 설치

### 2.1 Linux (Ubuntu 20.04 / 22.04)

```bash
# CUDA 12.x 설치 (NVIDIA 공식 저장소)
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.0-1_all.deb
sudo dpkg -i cuda-keyring_1.0-1_all.deb
sudo apt-get update
sudo apt-get install -y cuda-toolkit-12-1

# 환경변수 등록 (~/.bashrc 또는 ~/.zshrc)
export PATH=/usr/local/cuda/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH

# 설치 확인
nvcc --version
nvidia-smi
```

### 2.2 Windows

**자동 설치 (권장)** — `server/src/scripts/setup-cuda.windows.ps1` (2026-07-14 추가):

PromptPAR export(`exportPromptPAR.py`, cloth-PAR — OpenPAR 모델 코드가 `.cuda()`를 하드코딩해 CPU 폴백 없음) 등 GPU가 반드시 필요한 analysis 워크로드를 위해, NVIDIA GPU가 이미 장착된 Windows 머신에서 CUDA Toolkit 설치부터 CUDA 지원 PyTorch 설치·검증까지 한 번에 자동화합니다.

```powershell
# 관리자 권한 PowerShell에서 실행
cd loitering_tracking
powershell -ExecutionPolicy Bypass -File server/src/scripts/setup-cuda.windows.ps1
```

- `nvidia-smi`로 GPU·드라이버 확인 → 지원하지 않는 드라이버면 경고 후 확인
- CUDA Toolkit network installer 자동 다운로드·설치 (기본 `12.4.1`, `-CudaVersion`으로 변경 가능)
- 드라이버는 이미 설치되어 있다고 가정하고 **기본적으로 건드리지 않음** — 드라이버까지 설치기가 관리하게 하려면 `-IncludeDriver` 명시적으로 전달
- 설치 후 `nvcc`/`CUDA_PATH` 확인, 이어서 매칭되는 CUDA 지원 PyTorch(`--index-url .../whl/cuXXX`) 설치
- 마지막에 `torch.cuda.is_available()`이 `True`인지 검증까지 완료
- 재부팅이 필요하면(exit code `3010`) 재부팅 후 스크립트 재실행

GPU가 없는 Windows 머신에서는 이 스크립트도, CUDA 자체도 도움이 되지 않습니다 — 그 경우 GPU 머신에서 한 번 export한 `openpar_pa100k.onnx`를 대상 서버 `server/models/`에 복사하거나, 카탈로그의 `openpar-resnet50-pa100k`(manualOnly) 대안을 사용하세요.

**수동 설치**:

1. https://developer.nvidia.com/cuda-downloads 에서 CUDA 12.x 설치 프로그램 다운로드
2. 실행 후 "Express (권장)" 선택하여 설치
3. 설치 완료 후 재시작
4. 확인:
   ```cmd
   nvcc --version
   nvidia-smi
   ```

---

## 3. cuDNN 설치

cuDNN은 CUDA 딥러닝 연산 가속 라이브러리입니다. ONNX Runtime CUDA 빌드 실행에 필요합니다.

### 3.1 Linux

```bash
# cuDNN 8.x (CUDA 12.x 호환)
sudo apt-get install -y libcudnn8 libcudnn8-dev

# 설치 확인
ldconfig -p | grep cudnn
```

### 3.2 Windows

1. https://developer.nvidia.com/cudnn 에서 cuDNN 다운로드 (NVIDIA 계정 필요)
2. 압축 해제 후 파일 복사:
   - `bin\cudnn*.dll` → `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.x\bin\`
   - `include\cudnn*.h` → `...\include\`
   - `lib\cudnn*.lib` → `...\lib\x64\`

---

## 4. ONNX Runtime CUDA 빌드 설치

LTS-2026은 Node.js `onnxruntime-node` 패키지를 사용합니다.

```bash
cd server

# CUDA provider 포함 빌드 설치 (공식 npm 패키지는 CPU-only)
# CUDA 지원을 위해 onnxruntime-node의 CUDA 빌드 버전 설치
npm install onnxruntime-node@1.16.3

# 또는 환경에 따라 소스 빌드 필요:
# docs/ops/ONNX_Runtime_Source_Build_CUDA13.md 참조
```

> 참고: npm 공식 배포의 `onnxruntime-node`는 CPU-only입니다.
> CUDA 지원이 필요한 경우 `docs/ops/ONNX_Runtime_Source_Build_CUDA13.md`의 소스 빌드 가이드를 따르세요.

---

## 5. Windows DirectML 설정

DirectML은 Windows 10 이상에서 기본 제공됩니다. 별도 설치가 불필요합니다.

### 5.1 DirectML 활성화 설정

`server/.env` 파일에서:

```env
# DirectML 모드 (Windows, CUDA 미설치 환경)
ONNX_CUDA=0
# ONNX_CUDA=0 + Windows → 자동으로 DirectML 우선 선택
```

### 5.2 DirectML 가용성 확인

```bash
cd server
npm run check:gpu
```

출력 예시:
```
ORT DirectML  : AVAILABLE
Recommended   : dml
→ ONNX_CUDA=0 (Windows DirectML 모드) 설정 권장
```

---

## 6. 멀티카메라 배치 추론 설정

`server/.env` 파일에 아래 환경변수를 추가합니다:

```env
# 배치 추론 설정
BATCH_MAX_SIZE=4         # 배치 최대 크기 (기본값 4)
BATCH_MAX_WAIT_MS=33     # 배치 최대 대기 ms (기본값 33 = 30fps 기준 1프레임)
```

### 6.1 권장 설정 기준

| 카메라 수 | BATCH_MAX_SIZE | BATCH_MAX_WAIT_MS | 비고 |
|---|---|---|---|
| 1~2대 | 2 | 50 | 단일/소규모 배포 |
| 3~8대 | 4 | 33 | 기본값 (30fps 권장) |
| 9~16대 | 8 | 33 | 고밀도 배포, GPU VRAM 여유 필요 |
| 17대 이상 | 4~8 | 25 | 25fps 이상 유지 목표 시 |

### 6.2 배치 추론 동작 원리

```text
카메라 A, B, C, D → BatchDetectionQueue.enqueue()
  → BATCH_MAX_SIZE(4) 충족 또는 BATCH_MAX_WAIT_MS(33ms) 경과 시 flush()
  → DetectionService.detectBatch([jpegA, jpegB, jpegC, jpegD])
  → ONNX session.run([4, 3, 640, 640])  ← 단일 GPU kernel 호출
  → [resultA, resultB, resultC, resultD]
```

### 6.3 Fallback 동작

`detectBatch()` 실패 시 자동으로 단건 `detect()` 처리로 전환됩니다:

```
[batchDetectionQueue] detectBatch failed — switching to single-frame fallback
```

---

## 7. GPU 모니터링

### 7.1 CUDA (Linux / Windows)

```bash
# GPU SM 사용률 실시간 모니터링
nvidia-smi dmon -s u -d 1

# 메모리 사용량 포함
nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv -l 1
```

### 7.2 DirectML (Windows 전용)

> **주의**: DirectML 사용 중에는 `nvidia-smi`의 GPU 사용률이 0%로 표시됩니다.
> 이는 DirectML이 Windows WDDM 드라이버 스택을 통해 GPU를 사용하기 때문이며, 정상 동작입니다.

올바른 모니터링 방법:
1. Windows 작업 관리자 열기 (`Ctrl+Shift+Esc`)
2. 성능 탭 → GPU 선택
3. "비디오 처리" 또는 "Compute" 그래프 확인

---

## 8. 환경변수 전체 목록

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `ONNX_CUDA` | `0` | `1` = CUDA provider 활성화 |
| `ONNX_CUDA_STRICT` | `0` | `1` = CUDA 실패 시 서버 종료 (strict mode) |
| `ONNX_THREADS_CUDA` | (auto) | CUDA 세션 intra-op 스레드 수 |
| `BATCH_MAX_SIZE` | `4` | 배치 최대 크기 |
| `BATCH_MAX_WAIT_MS` | `33` | 배치 최대 대기 시간 (ms) |

---

## 9. 문제 해결

### 9.1 CUDA provider 초기화 실패

```
[onnxOptions] CUDA execution provider is unavailable in this runtime.
```

- `nvidia-smi`로 GPU 드라이버 확인
- `nvcc --version`으로 CUDA Toolkit 설치 확인
- cuDNN 라이브러리 설치 여부 확인: `ldconfig -p | grep cudnn`
- `npm run check:gpu`로 전체 진단 실행

### 9.2 배치 추론 비활성화 증상

```
[batchDetectionQueue] detectBatch failed — switching to single-frame fallback
```

- GPU VRAM 부족 여부 확인: `nvidia-smi --query-gpu=memory.used,memory.total --format=csv`
- `BATCH_MAX_SIZE` 값을 줄여서 재시도

### 9.3 DML 모니터링 시 GPU 사용률 0% 표시

- 정상 동작입니다. §7.2의 Windows 작업 관리자 방법으로 확인하세요.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-26 | 초기 작성 — CUDA/cuDNN 설치, DirectML 설정, 배치 추론 설정, GPU 모니터링 가이드 |
| 1.1 | 2026-07-14 | §2.2 Windows에 `setup-cuda.windows.ps1` 자동 설치 스크립트 안내 추가 — PromptPAR export 등 GPU 필수 워크로드 대상, nvidia-smi 확인부터 CUDA Toolkit·CUDA 지원 PyTorch 설치·검증까지 자동화 |
