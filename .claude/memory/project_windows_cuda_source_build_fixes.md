---
name: project-windows-cuda-source-build-fixes
description: Windows onnxruntime-node CUDA 네이티브 애드온 소스 빌드 + 런타임 DLL 경로 보정 — cmake-js VS 오탐지, --dll_deps 공백 경로 손상, stale CMakeCache, 빌드 성공 후 실행 시 cudnnCreate 로드 실패
metadata:
  node_type: memory
  type: project
  originSessionId: 2026-07-28-cuda-windows-source-build-runtime-fix
---

## Windows CUDA 네이티브 애드온 — 소스 빌드 + 런타임 DLL 검색 경로 보정 (Fixes 8-14)

> Fixes 1-6(초기 CMake/MSBuild/컴파일 단계 오류)은 `project_cudnn_cuda_version_mismatch.md`와
> `/memories/repo/notes.md`의 앞선 항목에 이미 기록됨. 이 파일은 그 이후 이어진 Fixes 8-14를 다룬다 —
> `npm install`은 성공하지만 실제 CUDA 네이티브 애드온이 빌드되지 않는 문제, 그리고 빌드가 완전히
> 성공한 뒤에도 실행 시점에 CUDA EP 로드가 실패하는 별도의 런타임 버그.

### 증상

1. **(Fix 10-11)** `js/node`에서 `npm install`이 exit 0으로 끝나지만 `onnxruntime_binding.node`가
   CUDA 미지원(cpu-only)으로 빌드됨 — `npm install`의 `postinstall`/`prepare`는 TypeScript(`tsc`)만
   컴파일하며 네이티브 addon은 별도 `node ./script/build --use_cuda ...` 호출이 필요.
2. **(Fix 12)** 네이티브 addon 빌드 단계(`node ./script/build`)에서 `Visual Studio 17 2022 could not
   find any instance of Visual Studio` 오류 — 호스트에 VS2022 외 다른 버전(VS Insiders 등)이 공존할 때.
3. **(Fix 13)** `--dll_deps=<...>` 인자에 공백 포함 경로(`C:\Program Files\...`)를 전달하면 CLI 파싱이
   깨져 `'Files\NVIDIA'`, `'GPU'` 같은 조각난 argv가 cmake에 전달됨.
4. **(Fix 14, RUNTIME)** 빌드/링크가 전부 성공하고 모든 dll이 물리적으로 존재해도, 서버 시작 후
   `InferenceSession.create()` 시점에 `Invalid handle. Cannot load symbol cudnnCreate` 오류 발생.

### 근본 원인

- Fix 12: `cmake-js`는 자체적으로 VS 버전을 자동 탐지하며(ORT 메인 빌드와 별개 로직), 최신 설치
  버전을 우선 선택 — C++ 툴셋이 없는 버전을 잘못 고르면 실패. `js/node/script/build.ts`는 알 수
  없는 CLI 플래그의 passthrough가 전혀 없음(`--onnxruntime-generator`는 무관한 Ninja 체크에만 사용).
- Fix 13: `build.ts` → `cmake-js` → 내부적으로 `spawnSync(cmd, args, {shell:true})`를 2단계로
  호출하며, `shell:true`는 인자 배열을 단순 공백 join으로 넘겨 각 값의 공백을 인용 처리하지 않음.
- Fix 14: `onnxruntime_providers_cuda.dll`은 실행 중 `LoadLibrary("cudnn64_9.dll")`처럼 파일명만으로
  종속 dll을 동적 로드함. Windows 기본 DLL 검색 순서는 프로세스 실행 파일(node.exe) 폴더와 PATH부터
  시작하며, 애드온 자신이 위치한 폴더(`bin/napi-v6/win32/x64/`)는 포함하지 않음 — **빌드 시점이
  아닌 실행 시점**의 문제.

### 진단 방법

```powershell
# 네이티브 addon이 실제로 CUDA 지원으로 빌드됐는지 확인 (파일 존재 여부만으론 불충분)
node -e "require('onnxruntime-node').InferenceSession.create('server/models/yolov8n.onnx', {executionProviders:['cuda','cpu']}).then(s=>console.log('OK', s.inputNames)).catch(e=>console.error('FAIL', e.message))"
```

`"successful build" ≠ "CUDA EP works at runtime"` — 반드시 실제 `InferenceSession.create()` +
`session.run()` 스모크 테스트로 검증해야 한다 (컴파일/링크 단계에서는 드러나지 않음).

### 해결 방법

```powershell
# Fix 12 — cmake-js가 올바른 VS 버전을 선택하도록 강제
$env:npm_config_msvs_version = "2022"

# Fix 13 — --dll_deps/--onnxruntime-generator 인자를 넘기지 않고, 빌드 성공 후 직접 복사
# (build-onnxruntime-source.windows.ps1이 이미 이 방식으로 구현됨)
node ./script/build --config=Release --use_cuda --onnxruntime-build-dir=<path>
Copy-Item onnxruntime_providers_cuda.dll, onnxruntime_providers_shared.dll, ... `
  -Destination js/node/bin/napi-v6/win32/x64/

# Fix 14 — 런타임 DLL 검색 경로 보정 (server/src/index.js 최상단, dotenv 로드 직후 1회 호출)
require('./utils/onnxDllPath').ensureOnnxCudaDllPath();
```

`ensureOnnxCudaDllPath()`는 `require.resolve('onnxruntime-node/package.json')` 기준으로 애드온
dll 폴더를 계산해 `process.env.PATH` 맨 앞에 추가한다. non-Windows, 패키지 미설치, 폴더 부재 시
모두 안전하게 no-op하며, 중복 호출에도 PATH에 중복 삽입되지 않는다(idempotent).

### 코드 위치

| 파일 | 변경 내용 |
|---|---|
| `server/src/utils/onnxDllPath.js` | `ensureOnnxCudaDllPath()` — Fix 14 런타임 DLL 경로 보정 (신규) |
| `server/src/index.js` | dotenv 로드 직후 `ensureOnnxCudaDllPath()` 1회 호출 |
| `server/src/scripts/build-onnxruntime-source.windows.ps1` | Fix 12(`npm_config_msvs_version` 강제), Fix 13(`--dll_deps` 제거 후 `Copy-Item` 직접 복사), `[3c/4]` 네이티브 addon 빌드 단계 추가 |
| `test/api/onnx_dll_path.test.js` | TC-CUDA-H-001 Jest 자동화 (real Jest describe/test 스타일 — SUITES에 등록하지 않음, 아래 테스트 규칙 참고) |
| `docs/ops/ONNX_Runtime_Source_Build_CUDA13.md` | 증상 H(VS 오탐지)/I(`--dll_deps` 손상)/J(stale CMakeCache)/K(런타임 cudnnCreate 실패) 추가 (v1.3) |
| `docs/design/Design_AI_CUDA_Acceleration.md` §12 | Windows CUDA 소스 빌드 파이프라인 설계 (v1.6, FR-CUDA-022/023) |
| `docs/srs/SRS_AI_CUDA_Acceleration.md` | FR-CUDA-022(소스 빌드)/FR-CUDA-023(DLL 경로 보정)/NFR-CUDA-004 (v1.3) |
| `docs/tc/TC_AI_CUDA_Acceleration.md` §9 | Test Group H — TC-CUDA-H-001(Jest 자동화)/TC-CUDA-H-002(수동 GPU 스모크 테스트) (v1.3) |
| `docs/mrd/MRD_AI_CUDA_Acceleration.md` | 신규 MRD (v1.0) — 이 기능 영역의 최초 MRD |

### 테스트 파일 규칙 (관련 발견사항)

이 저장소의 `test/api/*.test.js`에는 **서로 호환되지 않는 두 스타일**이 공존한다:

1. 커스텀 하네스(`test(id,desc,fn)`/`assert()`) 스타일 — `node test/api/X.test.js`로 라이브 서버
   대상 직접 실행, `SUITES` 배열(`test/tc_runner_cli.js`/`TcRunnerService.js`)에 등록됨.
2. 진짜 Jest `describe()`/`test()` 스타일(예: `batch_inference.test.js`, `onnx_dll_path.test.js`) —
   `SUITES`의 node-spawn 방식으로 실행 불가(Jest 전역 없음), **SUITES에 등록하면 안 됨**. 실행은
   `cd server && npx jest --config jest.config.js --rootDir .. --runInBand ../test/api/<file>.test.js`
   (기본 `jest.config.js`는 `rootDir`/`roots` 미지정으로 `server/`만 스캔하여 top-level `test/api/`를
   찾지 못함).
3. Jest 테스트에서 다른 폴더의 모듈을 검증할 때 `require.resolve('pkg', { paths: [...] })`로 해당
   모듈의 실제 디렉토리를 기준으로 resolve해야 함 — 테스트 파일 자신의 위치 기준으로 bare
   `require.resolve()`를 호출하면 조용히 다른 결과가 나와 분기가 잘못 스킵될 수 있음.
