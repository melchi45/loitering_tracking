---
name: project-cudnn-cuda-version-mismatch
description: cuDNN EXE 설치 시 CUDA 버전 불일치로 ORT 소스 빌드가 실패하는 패턴과 해결법
metadata:
  node_type: memory
  type: project
  originSessionId: 2026-07-27-cuda-build-fix
---

## cuDNN-CUDA 버전 불일치 → ORT 소스 빌드 링크 실패

### 증상

- `npm run build-ort:auto` 실행 후 `onnxruntime.dll` / `onnxruntime_providers_cuda.dll` 미생성
- `build\Windows\Release\onnxruntime_providers.dir\Release\...\unsuccessfulbuild` 파일 존재
- `build\Windows\Release\onnxruntime_providers_cuda.dir\Release\...\unsuccessfulbuild` 파일 존재
- dry-run은 성공하지만 실제 빌드에서 링크 단계 실패

### 근본 원인

cuDNN EXE 인스톨러는 CUDA 버전별 서브디렉토리 구조로 설치됩니다:

```
C:\Program Files\NVIDIA\CUDNN\v9.23\
  bin\12.9\x64\cudnn64_9.dll   ← CUDA 12.9 전용 DLL
  include\12.9\cudnn.h
  lib\12.9\x64\cudnn.lib
```

이 경우 CUDA Toolkit 버전(예: 12.8)과 cuDNN 지원 버전(예: 12.9)이 다르면
링크 시 cuDNN import lib이 CUDA 12.9 런타임(`cudart64_129.dll`)을 요구하지만
CUDA 12.8만 설치된 환경에서는 존재하지 않아 빌드가 실패합니다.

### 진단 방법

```powershell
# 불일치 자동 감지
npm run build-ort:auto:dry
# → "⚠️ [cuDNN-CUDA 버전 불일치]" 출력 시 설치 필요

# URL 확인
npm run ensure-cuda:dry
```

### 해결 방법

```powershell
# 자동 설치 (winget → NVIDIA CDN 폴백, 관리자 권한 필요)
npm run ensure-cuda

# 설치 완료 후
npm run build-ort:auto
```

### 코드 위치

| 파일 | 변경 내용 |
|---|---|
| `server/src/utils/providerDiagnostics.js` | EXE 설치 cuDNN 감지 시 `cudnnCudaVersion` 필드 추가 |
| `server/src/scripts/buildOrtWithCuda.js` | 불일치 감지 로직, `--ensure-cuda`/`--ensure-cuda:dry` 옵션, `deriveCudnnCudaVersion()` |
| `server/src/scripts/ensure-cuda-toolkit.windows.ps1` | CUDA Toolkit 버전별 자동 설치 스크립트 (신규) |

### 주의

- PS1 스크립트는 반드시 **UTF-8 BOM** 으로 저장해야 한글이 정상 출력됩니다
  (`create_file`로 생성 후 `[System.IO.File]::WriteAllText(..., UTF8Encoding(true))` 재저장)
- `buildOrtWithCuda.js`의 ensure-cuda 출력 파싱: stdout 마지막 줄 `CUDA_HOME=<path>`
- 기존 빌드 캐시에 `unsuccessfulbuild` 마커가 남아있어도 `build-ort:auto`는 증분 빌드로 재시도합니다 (CMake stale subbuild 자동 정리 로직 포함)
