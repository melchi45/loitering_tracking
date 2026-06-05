# Operations Guide
# ONNX Runtime Source Build (CUDA 13.3) for Node.js

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-ORT-001 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-06-05 |
| **Status** | **✅ Active** |
| **Related File (Windows)** | [server/src/scripts/build-onnxruntime-source.windows.ps1](../../server/src/scripts/build-onnxruntime-source.windows.ps1) |
| **Related File (Linux)** | [server/src/scripts/build-onnxruntime-source.linux.sh](../../server/src/scripts/build-onnxruntime-source.linux.sh) |

---

## 개요

사전 빌드 `onnxruntime-node` 패키지에서 CUDA Execution Provider가 노출되지 않는 환경을 위해,
LTS-2026은 ONNX Runtime 소스 빌드 자동화 스크립트를 제공합니다.

이 문서는 다음을 다룹니다.

1. CUDA 13.3 기준 사전 준비
2. Windows/Linux 자동 빌드 스크립트 실행
3. 서버 프로젝트에 로컬 `onnxruntime/js/node` 연결
4. 검증 로그 확인
5. 장애 대응(설치 중단, 부분 설치, 모듈 누락)

---

## 적용 범위

- 서버 프로젝트: [server/package.json](../../server/package.json)
- npm 스크립트:
  - `build-ort-source:windows`
  - `build-ort-source:linux`

---

## 사전 요구사항

### 공통

1. Git
2. Python 3.x
3. CMake 3.28+
4. Node.js / npm
5. CUDA Toolkit 13.3
6. cuDNN 9.x 이상 (CUDA 13.3 호환)

### Windows 추가

1. Visual Studio 2022 (Desktop development with C++)
2. 권장 실행 셸: x64 Native Tools Command Prompt for VS 2022

### Linux 추가

1. GCC/G++
2. `build-essential` 계열 도구

---

## 빠른 실행

### Windows

```powershell
cd server
npm run build-ort-source:windows
```

### Linux

```bash
cd server
npm run build-ort-source:linux
```

---

## 고급 실행 (옵션 지정)

### Windows 예시

```powershell
powershell -ExecutionPolicy Bypass -File server/src/scripts/build-onnxruntime-source.windows.ps1 \
  -OrtRepoDir "D:\src\onnxruntime" \
  -OrtRef "v1.26.0" \
  -CudaHome "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3" \
  -CudnnHome "C:\tools\cudnn" \
  -CudaArch "120"
```

옵션 설명:

- `OrtRepoDir`: ONNX Runtime 소스 저장 경로
- `OrtRef`: 빌드할 태그/브랜치 (기본 `v1.26.0`)
- `CudaHome`: CUDA 설치 경로
- `CudnnHome`: cuDNN 설치 경로
- `CudaArch`: GPU 아키텍처 (예: `120`)
- `AllowInsecureTlsForFetch`: CMake FetchContent 다운로드 시 `CMAKE_TLS_VERIFY=0` 적용(사내망 TLS 이슈 임시 우회)
- `SkipClone`, `SkipBuild`, `SkipNodePackageBuild`, `SkipProjectInstall`: 단계별 건너뛰기

### Linux 예시

```bash
cd server
ORT_REPO_DIR=$HOME/source/onnxruntime \
ORT_REF=v1.26.0 \
CUDA_HOME=/usr/local/cuda-13.3 \
CUDNN_HOME=/usr/lib/x86_64-linux-gnu \
CUDA_ARCH=120 \
npm run build-ort-source:linux
```

단계 건너뛰기 환경변수:

- `SKIP_CLONE=1`
- `SKIP_BUILD=1`
- `SKIP_NODE_PACKAGE_BUILD=1`
- `SKIP_PROJECT_INSTALL=1`

---

## 스크립트 동작 순서

두 스크립트 모두 아래 4단계를 수행합니다.

1. ONNX Runtime 소스 clone/update + submodule sync
2. CUDA 포함 네이티브 라이브러리 빌드 (`--build_shared_lib`, `onnxruntime_USE_FLASH_ATTENTION=OFF`)
  - Windows 스크립트는 `cmake/deps.txt`의 `abseil_cpp` 태그를 읽어 `abseil-cpp`를 git clone한 로컬 경로를 `FETCHCONTENT_SOURCE_DIR_ABSEIL_CPP`로 주입합니다.
  - 즉, `abseil_cpp`는 FetchContent zip 다운로드 대신 로컬 git 소스를 우선 사용합니다.
  - 또한 `protobuf`도 태그를 읽어 git clone한 로컬 경로를 `FETCHCONTENT_SOURCE_DIR_PROTOBUF`로 주입합니다.
  - 즉, `protobuf` 역시 FetchContent 다운로드/patch 단계 대신 로컬 git 소스를 우선 사용합니다.
3. `onnxruntime/js/node` 패키지 빌드
4. 현재 서버 프로젝트에 로컬 패키지 설치 (`--no-save`)

참고: `--no-save` 설치이므로 `server/package.json` 의존성 버전을 직접 변경하지 않습니다.

---

## 검증 절차

### 1) 서버 재시작

```bash
cd server
npm run restart
```

### 2) 기대 로그

```text
[onnxOptions] mode=cuda ... providers=["cuda","cpu"]
```

### 3) 진단 로그 함께 확인

자세한 provider startup-check 해석은 [docs/ops/ONNX_Runtime_Provider_Diagnostics.md](ONNX_Runtime_Provider_Diagnostics.md) 참고.

---

## 장애 대응 가이드

### 증상 A: `MODULE_NOT_FOUND` 연쇄 발생

원인:

- 설치가 중간 중단되어 `node_modules`가 부분 상태로 남음

조치:

1. 설치 프로세스를 강제 종료하지 말고 완료 메시지(`added/changed/audited`)까지 대기
2. 필요 시 `server/node_modules` 제거 후 재설치
3. 재설치 시 절대 경로 npm 사용 권장 (Windows PATH 흔들림 회피)

예시:

```powershell
& "C:\Program Files\nodejs\npm.cmd" --prefix "e:\workspace\loitering_tracking\server" install --no-progress
```

### 증상 B: `onnxruntime-node` 폴더가 비정상 (예: `bin/`만 존재)

원인:

- npm reify 중단 또는 충돌

조치:

1. 전체 설치를 완료시킨 뒤 모듈 resolve 확인
2. 필요 시 `onnxruntime-node` 재설치

검증 예시:

```powershell
& "C:\Program Files\nodejs\node.exe" -e "const {createRequire}=require('module'); const req=createRequire('e:/workspace/loitering_tracking/server/package.json'); ['onnxruntime-node','express','mime','mediasoup'].forEach(m=>{try{req(m);console.log(m+':ok')}catch(e){console.log(m+':fail')}});"
```

### 증상 C: WebRTC 비활성 (`mediasoup-worker ENOENT`)

설명:

- 이 문서의 대상은 ONNX Runtime/CUDA 경로입니다.
- `mediasoup-worker ENOENT`는 WebRTC worker 바이너리 이슈로 별도 복구가 필요합니다.
- API/AI 서버 자체는 기동될 수 있으나 WebRTC 경로는 비활성화됩니다.

### 증상 D: `CMake 3.28 or higher is required` 오류

원인:

- ONNX Runtime v1.26.0의 CMake 최소 요구사항은 3.28+
- 시스템 PATH의 `cmake`가 구버전(예: 3.25.1)

조치:

1. CMake 3.28+ 설치
2. 스크립트에 `-CmakePath`로 최신 `cmake.exe` 지정

Windows 재실행 예시:

powershell -ExecutionPolicy Bypass -File server/src/scripts/build-onnxruntime-source.windows.ps1 -CmakePath "C:\Program Files\CMake\bin\cmake.exe"

참고:

- 최신 스크립트는 시작 시 CMake 버전을 사전 점검하고, 조건 미달 시 즉시 중단하며 경로 지정을 안내합니다.

### 증상 E: `Visual Studio 17 2022 could not find any instance of Visual Studio`

원인:

- CMake Generator가 `Visual Studio 17 2022`인데, 호스트에 VS 2022 C++ 툴체인이 없음
- 또는 VS는 설치되어 있으나 C++ 워크로드/컴포넌트가 누락됨

조치:

1. Visual Studio 2022 Build Tools 설치
2. 아래 항목 중 하나 이상 포함
  - Desktop development with C++ 워크로드
  - `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`

설치 확인 명령:

& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath

출력이 비어 있지 않으면 조건 충족입니다.

참고:

- 최신 Windows 빌드 스크립트는 빌드 시작 전에 VS C++ 툴체인을 사전 점검하고, 미설치 시 즉시 중단해 원인을 명확히 출력합니다.

### 증상 F: `FetchContent` 다운로드 실패 + `CRYPT_E_NO_REVOCATION_CHECK`

대표 로그:

- `status_code: 35`
- `schannel: next InitializeSecurityContext failed: CRYPT_E_NO_REVOCATION_CHECK`
- `Each download failed!`

원인:

- Windows Schannel 환경에서 인증서 폐기(Revocation) 확인이 차단되어 HTTPS 다운로드가 실패
- 사내망 보안 정책/프록시/검사 장비 환경에서 자주 발생

조치(임시 우회):

1. 신뢰 가능한 내부망에서만 사용
2. 스크립트 옵션 `-AllowInsecureTlsForFetch`로 재실행

예시:

powershell -ExecutionPolicy Bypass -File server/src/scripts/build-onnxruntime-source.windows.ps1 -AllowInsecureTlsForFetch

참고:

- 해당 옵션은 실행 중에만 `CMAKE_TLS_VERIFY=0`을 적용하고 종료 시 복원합니다.
- 장기적으로는 사내 CA 신뢰체인/프록시 인증서 배포 등 정식 TLS 경로 정비를 권장합니다.

### 증상 G: Protobuf patch 단계에서 `/usr/bin/patch ... Permission denied`

대표 로그:

- `Performing patch step for 'protobuf-populate'`
- `/usr/bin/patch: **** Failed to set the permissions ... Permission denied`

원인:

- Windows 환경에서 FetchContent의 Protobuf populate/patch 단계가 MSYS2/Git patch 동작과 파일 권한 처리 충돌로 실패

조치:

1. 최신 Windows 빌드 스크립트 사용 (`server/src/scripts/build-onnxruntime-source.windows.ps1`)
2. 스크립트가 `protobuf`를 git tag clone한 로컬 경로로 강제 주입하므로, 일반적으로 `protobuf-populate` patch 단계 자체를 우회
3. 과거 실패 캐시가 남아 있으면 `onnxruntime/build/Windows/Release`를 정리 후 재시도

---

## 운영 권장사항

1. 빌드 중 터미널 강제 종료 금지
2. 동일 세션에서 연속 설치 실행 지양 (중복 npm 프로세스 방지)
3. 대규모 설치 직후에는 반드시 `npm run restart`로 최종 상태 검증
4. Windows에서 명령 인식 오류가 반복되면 npm/node 절대 경로를 사용

---

## 관련 문서

- [docs/ops/ONNX_Runtime_Provider_Diagnostics.md](ONNX_Runtime_Provider_Diagnostics.md)
- [README.md](../../README.md)
- [server/package.json](../../server/package.json)

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-06-05 | LTS Engineering Team | Initial release — CUDA 13.3 source build automation guide for onnxruntime-node |
