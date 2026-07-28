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
5. CUDA Toolkit (cuDNN 호환 버전 — 버전 불일치 시 `npm run ensure-cuda` 자동 설치)
6. cuDNN 9.x 이상 (미설치 시 `npm run ensure-cuda` 가 pip 패키지로 자동 설치 시도 — NVIDIA 로그인 불필요)

> **⚠️ cuDNN-CUDA 버전 일치 확인 필수**
> cuDNN EXE 인스톨러는 특정 CUDA 버전 전용(`bin/{cudaVer}/x64/`)으로 설치됩니다.
> CUDA Toolkit 버전과 cuDNN 지원 버전이 다르면 ORT 링크 단계에서 실패합니다.
>
> 버전 확인 및 자동 설치:
> ```powershell
> # 버전 불일치 확인 (dry-run)
> npm run build-ort:auto:dry
>
> # 필요한 CUDA Toolkit 자동 설치 후 빌드
> npm run ensure-cuda
> npm run build-ort:auto
> ```

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

## cuDNN-CUDA 버전 불일치 해결 (`ensure-cuda`)

### 증상

- `build-ort:auto` 실행 시 다음 오류 출력:

```
  ⚠️  [cuDNN-CUDA 버전 불일치]
     설치된 CUDA Toolkit : v12.8
     cuDNN 호환 CUDA 버전 : v12.9
     cuDNN이 CUDA 12.9 전용으로 설치되어 있어 빌드가 실패합니다.
```

### 원인

cuDNN EXE 인스톨러는 CUDA 버전별 서브디렉토리 구조로 설치됩니다.

```
C:\Program Files\NVIDIA\CUDNN\v9.23\bin\12.9\x64\cudnn64_9.dll  ← CUDA 12.9 전용
```

설치된 CUDA Toolkit 버전(예: 12.8)과 다른 경우 링크에 실패합니다.

### 해결 방법

**A. 자동 설치 (권장)**

```powershell
npm run ensure-cuda
```

설치 순서: winget(`Nvidia.CUDA.12.9`) → NVIDIA 네트워크 인스톨러 직접 다운로드

URL 확인만:

```powershell
npm run ensure-cuda:dry
```

**B. 수동: cuDNN을 현재 CUDA 버전으로 재설치**

`https://developer.nvidia.com/cudnn` → 현재 CUDA Toolkit 버전에 맞는 cuDNN 다운로드 → 재설치

**C. 수동: CUDA Toolkit 업그레이드**

```powershell
# 다운로드 URL 확인
npm run ensure-cuda:urls

# 수동 설치 후 빌드
npm run build-ort:auto
```

### `ensure-cuda-toolkit.windows.ps1` 직접 실행

```powershell
# 특정 버전 설치
powershell -ExecutionPolicy Bypass -File server/src/scripts/ensure-cuda-toolkit.windows.ps1 -RequiredVersion 12.9

# 다운로드만
powershell -ExecutionPolicy Bypass -File server/src/scripts/ensure-cuda-toolkit.windows.ps1 -RequiredVersion 12.9 -DownloadOnly

# URL 목록
powershell -ExecutionPolicy Bypass -File server/src/scripts/ensure-cuda-toolkit.windows.ps1 -RequiredVersion 12.9 -ShowUrls
```

설치 후 `CUDA_HOME=<경로>` 를 stdout에 출력합니다. `buildOrtWithCuda.js`는 이 값을 파싱하여 빌드 파라미터로 자동 적용합니다.

---

## cuDNN 미설치 자동 설치 (`ensure-cuda`, pip 방식)

### 증상

- `build-ort:auto` 실행 시 다음 경고 출력:

```
  ⚠️  cuDNN    : 미감지 — cuDNN 없이 빌드됩니다 (일부 연산 성능 저하)
```

### 원인

NVIDIA 공식 cuDNN 배포판(zip/EXE)은 `https://developer.nvidia.com/cudnn` 로그인이 필요하여
CUDA Toolkit 네트워크 인스톨러처럼 완전 자동화할 수 없습니다.

### 해결 방법 — pip 패키지 자동 설치 (권장, 로그인 불필요)

PyTorch/JAX 등이 사용하는 것과 동일한 NVIDIA 공식 PyPI 재배포 채널(`nvidia-cudnn-cuXX`)을
pip로 설치하여 cuDNN 헤더/라이브러리/DLL을 확보합니다. `--ensure-cuda` 플래그가 CUDA Toolkit
자동 설치와 함께 cuDNN 자동 설치도 시도합니다.

```powershell
npm run ensure-cuda
# 또는
npm run build-ort:auto -- --ensure-cuda
```

URL/패키지명만 확인(설치 없음):

```powershell
npm run build-ort:auto -- --ensure-cuda:dry
```

`ensure-cudnn.windows.ps1` 직접 실행도 가능합니다:

```powershell
# 설치 (venv 활성화된 상태 권장 — python -m pip 사용)
powershell -ExecutionPolicy Bypass -File server/src/scripts/ensure-cudnn.windows.ps1 -CudaMajorMinor 12.9

# 패키지명/URL만 확인
powershell -ExecutionPolicy Bypass -File server/src/scripts/ensure-cudnn.windows.ps1 -CudaMajorMinor 12.9 -ShowUrls
```

설치 후 `CUDNN_HOME=<pip 패키지 경로>` 를 stdout에 출력하며(`<site-packages>\nvidia\cudnn`),
`buildOrtWithCuda.js`가 이를 파싱해 `-CudnnHome` 인자로 직접 전달합니다(레지스트리/기본 경로 유도 불필요).
`providerDiagnostics.js`도 이 pip 설치 경로를 이후 실행에서 자동 재감지합니다.

cuDNN은 선택적 의존성이므로 pip 설치가 실패해도(오프라인 등) 빌드는 cuDNN 없이 계속 진행됩니다.
실패 시 수동 설치만 남습니다: `https://developer.nvidia.com/cudnn` (NVIDIA 계정 필요).

---

## 장애 대응 가이드

### 증상 A-0: cuDNN-CUDA 버전 불일치 (`cuDNN이 CUDA X.Y 전용으로 설치되어 있어 빌드가 실패합니다`)

대표 출력:

```
  ⚠️  [cuDNN-CUDA 버전 불일치]
     설치된 CUDA Toolkit : v12.8
     cuDNN 호환 CUDA 버전 : v12.9
```

원인:

- cuDNN EXE 인스톨러는 CUDA 버전별 서브디렉토리(`bin/12.9/x64/`) 구조로 설치됩니다.
- CUDA Toolkit 버전(예: 12.8)과 cuDNN 지원 버전(예: 12.9)이 다를 때 발생합니다.

조치:

```powershell
# 방법 A: 자동 설치 (권장, 관리자 권한 필요)
npm run ensure-cuda

# 방법 B: 다운로드 URL 확인 후 수동 설치
npm run ensure-cuda:dry

# 방법 C: cuDNN을 현재 CUDA 버전용으로 재설치
# https://developer.nvidia.com/cudnn 에서 CUDA 12.8용 cuDNN 다운로드
```

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

### 증상 H: `js/node` 네이티브 애드온 빌드 단계에서 `Visual Studio 17 2022 could not find any instance` 또는 잘못된 VS 버전이 선택됨

대표 로그:

```
cmake-js ... generator="Visual Studio 17 2022"
... could not find any instance of Visual Studio.
```

원인:

- `[3c/4]` 단계(`node ./script/build --config=Release --use_cuda ...`)는 `cmake-js`를 내부적으로 호출하며, `cmake-js`는 VS 설치 버전을 자동 탐지합니다.
- 호스트에 VS 2022 외에 다른 버전(예: VS Insiders 미리보기)이 함께 설치된 경우, 자동 탐지가 C++ 툴셋이 미설치된 버전을 우선 선택해 실패할 수 있습니다.

조치:

1. 빌드 단계 진입 전 `npm_config_msvs_version` 환경변수를 `2022`로 강제 지정(`cmake-js`는 `npm_config_*` 환경변수를 npm config로 읽음):

```powershell
$env:npm_config_msvs_version = "2022"
npm run build-ort:auto
```

2. `buildOrtWithCuda.js`/`build-onnxruntime-source.windows.ps1`의 최신 버전은 이 환경변수를 `[3c/4]` 단계 진입 전에 자동으로 설정합니다 — 별도 조치 없이 최신 스크립트를 사용하면 자동 해결됩니다.

### 증상 I: `--dll_deps`/`--onnxruntime-generator` 인자 전달 시 경로가 손상되거나 공백 포함 경로에서 CLI 파싱 실패

대표 증상: `CUDA_HOME`이 `C:\Program Files\NVIDIA GPU Computing Toolkit\...`처럼 공백을 포함하는 경우, `js/node`의 네이티브 빌드 CLI에 `--dll_deps=<...>` 같은 인자를 그대로 전달하면 Node의 `spawnSync(..., { shell: true })`가 내부적으로 공백 기준 토큰화를 수행해 경로가 잘리며(따옴표로 감싸지 않음) CLI 파싱이 깨집니다.

조치:

- 최신 Windows 빌드 스크립트는 이 인자를 사용하지 않고, 빌드 성공 후 스크립트가 직접 `Copy-Item`으로 `onnxruntime_providers_cuda.dll` / `onnxruntime_providers_shared.dll` / CUDA·cuDNN 런타임 dll을 `js/node/bin/napi-v6/win32/x64/`에 복사합니다(설계 근거: `docs/design/Design_AI_CUDA_Acceleration.md` §12.2).
- 직접 CLI를 호출해야 하는 커스텀 스크립트를 작성한다면, 공백이 포함된 경로는 `spawnSync(cmd, args, { shell: false })`로 호출하거나 8.3 단축 경로(`C:\PROGRA~1\...`)를 사용해 회피합니다.

### 증상 J: 재빌드 시 이전 실패의 stale CMakeCache로 인해 옵션 변경이 반영되지 않음

증상:

- `CudaArch`, `-DCMAKE_CUDA_ARCHITECTURES` 등 옵션을 변경해도 이전 실패 시점의 설정이 계속 적용됨

원인:

- `onnxruntime/build/Windows/Release/CMakeCache.txt`가 이전 실패한 구성을 그대로 보존하며, CMake는 기본적으로 캐시된 값을 우선합니다.

조치:

1. 재시도 전 빌드 디렉토리를 정리:

```powershell
Remove-Item -Recurse -Force "D:\src\onnxruntime\build\Windows\Release"
```

2. 그 후 `npm run build-ort:auto` 또는 `build-ort-source:windows`를 다시 실행합니다.

### 증상 K: 빌드/링크는 성공했으나 실행 시 `InferenceSession.create()`가 `Invalid handle. Cannot load symbol cudnnCreate`로 실패

증상:

- 빌드 로그에 오류 없이 종료되고 `onnxruntime_providers_cuda.dll` 및 모든 CUDA/cuDNN dll이 `bin/napi-v6/win32/x64/`에 물리적으로 존재함에도, `ONNX_CUDA=1`로 서버를 시작하면 세션 생성 시점에 `Invalid handle. Cannot load symbol cudnnCreate` 오류가 발생

원인:

- `onnxruntime_providers_cuda.dll`은 실행 중 `LoadLibrary("cudnn64_9.dll")`처럼 파일명만으로 종속 dll을 동적 로드합니다.
- Windows 기본 DLL 검색 순서는 프로세스 실행 파일(node.exe)의 폴더와 PATH부터 시작하며, 애드온 자신이 위치한 폴더(`bin/napi-v6/win32/x64/`)는 포함하지 않습니다 — 이는 빌드 시점이 아닌 **실행 시점**의 문제입니다.

조치:

- `server/src/utils/onnxDllPath.js`의 `ensureOnnxCudaDllPath()`가 `server/src/index.js`에서 dotenv 로드 직후, 다른 모든 서비스가 ONNX 세션을 생성하기 전에 1회 호출되어야 합니다 — 이 함수가 `require.resolve('onnxruntime-node/package.json')` 기준으로 애드온 dll 폴더를 계산해 `process.env.PATH` 맨 앞에 추가합니다.
- 이미 최신 `server/src/index.js`에 반영되어 있으므로, 이 증상이 재발하면 먼저 `server/src/index.js` 상단에서 `ensureOnnxCudaDllPath()` 호출 순서(다른 require보다 먼저인지)를 확인합니다.
- 검증: `npm run restart` 후 시작 로그에서 `[onnxOptions] mode=cuda ... providers=["cuda","cpu"]`가 모든 AI 서비스(detection/face/ppe/fire-smoke/cloth/appearance-reid/age/gender)에 대해 출력되는지 확인합니다.

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
| 1.1 | 2026-07-27 | LTS Engineering Team | cuDNN-CUDA 버전 불일치 해결 섹션 추가 (`ensure-cuda` 스크립트, 자동 설치 옵션, 직접 실행 예시, 증상 A-0 장애 대응) |
| 1.1 | 2026-07-27 | LTS Engineering Team | cuDNN-CUDA 버전 불일치 해결 섹션 추가 (`ensure-cuda` 스크립트, 자동 설치 옵션, 직접 실행 예시) |
| 1.2 | 2026-07-27 | LTS Engineering Team | cuDNN 미설치 자동 설치 섹션 추가 (`ensure-cudnn.windows.ps1`, pip `nvidia-cudnn-cuXX` 패키지 기반, NVIDIA 로그인 불필요) |
| 1.3 | 2026-07-28 | LTS Engineering Team | Windows 네이티브 애드온 빌드/실행 장애 대응 4건 추가 — 증상 H(cmake-js VS 버전 오탐지), 증상 I(`--dll_deps` 인자 공백 경로 손상), 증상 J(stale CMakeCache 미반영), 증상 K(빌드 성공 후에도 실행 시 CUDA EP 로드 실패 — onnxDllPath.js 런타임 DLL 검색 경로 보정) |
