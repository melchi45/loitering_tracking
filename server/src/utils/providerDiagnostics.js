'use strict';

/**
 * GPU/AI provider availability diagnostics.
 *
 * Checks: NVIDIA GPU presence, CUDA Toolkit, cuDNN, ORT CUDA provider,
 * ORT DirectML provider (Windows), CPU fallback.
 *
 * Usage:
 *   const { getProviderDiagnostics } = require('./providerDiagnostics');
 *   const diag = await getProviderDiagnostics();
 *
 * CLI:
 *   node server/src/scripts/checkGpuProviders.js
 */

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const IS_WIN   = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

// ── Helpers ───────────────────────────────────────────────────────────────────

function _run(cmd, timeoutMs = 5000) {
  try {
    return execSync(cmd, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
}

// ── GPU ───────────────────────────────────────────────────────────────────────

async function detectNvidiaGpu() {
  const out = _run('nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader');
  if (!out) {
    return {
      available: false,
      reason: 'nvidia-smi 미감지 — NVIDIA 드라이버가 설치되지 않았거나 GPU가 없음',
    };
  }
  const gpus = out.split('\n').filter(Boolean).map(line => {
    const [name, driver, memory] = line.split(',').map(s => s.trim());
    return { name, driver, memory };
  });
  return { available: true, gpus };
}

// ── CUDA Toolkit ─────────────────────────────────────────────────────────────

async function detectCudaToolkit() {
  const out = _run('nvcc --version');
  if (out) {
    const match = out.match(/release (\d+\.\d+)/);
    return { available: true, version: match?.[1] ?? 'unknown' };
  }

  if (IS_LINUX) {
    const altOut = _run('/usr/local/cuda/bin/nvcc --version');
    if (altOut) {
      const m = altOut.match(/release (\d+\.\d+)/);
      return { available: true, version: m?.[1] ?? 'unknown', path: '/usr/local/cuda/bin/nvcc' };
    }
    return {
      available: false,
      reason: 'nvcc 미감지 — CUDA Toolkit이 설치되지 않았거나 PATH에 없음',
      installCmds: [
        '# Ubuntu/Debian (CUDA 12.x 예시):',
        'wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-ubuntu2204.pin',
        'sudo mv cuda-ubuntu2204.pin /etc/apt/preferences.d/cuda-repository-pin-600',
        'sudo apt-key adv --fetch-keys https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/3bf863cc.pub',
        'sudo add-apt-repository "deb https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/ /"',
        'sudo apt-get update && sudo apt-get -y install cuda-12-1',
        '# PATH 추가 (~/.bashrc):',
        'export PATH=/usr/local/cuda/bin:$PATH',
        'export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH',
      ],
    };
  }

  if (IS_WIN) {
    // 1) CUDA 설치 시 자동 설정되는 환경변수 우선 탐색
    const cudaEnvCandidates = [
      process.env.CUDA_PATH,
      process.env.CUDA_PATH_V12_9,
      process.env.CUDA_PATH_V12_8,
      process.env.CUDA_PATH_V12_7,
      process.env.CUDA_PATH_V12_6,
      process.env.CUDA_PATH_V12_5,
      process.env.CUDA_PATH_V12_4,
      process.env.CUDA_PATH_V12_3,
      process.env.CUDA_PATH_V12_2,
      process.env.CUDA_PATH_V12_1,
      process.env.CUDA_PATH_V12_0,
      process.env.CUDA_PATH_V11_8,
      process.env.CUDA_PATH_V11_7,
    ].filter(Boolean);

    for (const base of cudaEnvCandidates) {
      const nvccPath = path.join(base, 'bin', 'nvcc.exe');
      if (fs.existsSync(nvccPath)) {
        const altOut = _run(`"${nvccPath}" --version`);
        if (altOut) {
          const m = altOut.match(/release (\d+\.\d+)/);
          return { available: true, version: m?.[1] ?? 'unknown', path: nvccPath };
        }
      }
    }

    // 2) 기본 설치 경로 버전별 스캔
    const CUDA_VERSIONS = ['12.9','12.8','12.7','12.6','12.5','12.4','12.3','12.2','12.1','12.0','11.8','11.7','11.6'];
    const BASE_DIR = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
    for (const ver of CUDA_VERSIONS) {
      const nvccPath = path.join(BASE_DIR, `v${ver}`, 'bin', 'nvcc.exe');
      if (fs.existsSync(nvccPath)) {
        const altOut = _run(`"${nvccPath}" --version`);
        if (altOut) {
          const m = altOut.match(/release (\d+\.\d+)/);
          return { available: true, version: m?.[1] ?? ver, path: nvccPath };
        }
      }
    }

    return {
      available: false,
      reason: 'nvcc.exe 미감지 — CUDA Toolkit이 설치되지 않았거나 PATH/CUDA_PATH에 없음',
      installCmds: [
        '# Windows CUDA Toolkit 설치:',
        '# 1. https://developer.nvidia.com/cuda-downloads 에서 Windows 설치 파일 다운로드',
        '# 2. 설치 후 시스템 재시작',
        '# 3. 설치 경로가 PATH에 포함되었는지 확인:',
        '#    C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\vXX.X\\bin',
        '# 4. 환경변수 CUDA_PATH 자동 설정 여부 확인:',
        '#    [System Properties] → [Environment Variables] → CUDA_PATH',
      ],
    };
  }

  return { available: false, reason: `nvcc 미감지 — 지원되지 않는 플랫폼: ${process.platform}` };
}

// ── cuDNN ─────────────────────────────────────────────────────────────────────

/**
 * cuDNN 감지 전략
 *
 * cuDNN 8.x: 단일 라이브러리  (libcudnn.so.8  / cudnn64_8.dll)
 * cuDNN 9.x: 분리 라이브러리  (libcudnn.so.9  / cudnn64_9.dll  또는
 *            cudnn_ops.dll, cudnn_cnn.dll, cudnn_graph.dll — EXE 설치)
 *
 * 우선순위: 9.x → 8.x (최신 버전 우선 감지)
 */
async function detectCuDNN() {
  if (IS_LINUX) {
    // ── Linux cuDNN 검색 경로 ──────────────────────────────────────────────
    // 아키텍처별 lib 경로: x86_64, aarch64(Jetson/ARM)
    const ARCH_DIRS = [
      '/usr/lib/x86_64-linux-gnu',
      '/usr/lib/aarch64-linux-gnu',
      '/usr/lib/sbsa-linux-gnu',   // ARM Server Base System Architecture
      '/usr/lib',
    ];

    // 버전별 CUDA prefix (nvcc 경로 패턴에 맞게 자동 확장)
    const CUDA_PREFIXES = [
      '/usr/local/cuda',
      '/usr/local/cuda-12.8',
      '/usr/local/cuda-12.7',
      '/usr/local/cuda-12.6',
      '/usr/local/cuda-12.5',
      '/usr/local/cuda-12.4',
      '/usr/local/cuda-12.3',
      '/usr/local/cuda-12.2',
      '/usr/local/cuda-12.1',
      '/usr/local/cuda-12.0',
      '/usr/local/cuda-11.8',
      '/usr/local/cuda-11.7',
    ];

    // 9.x 먼저, 8.x 후순위
    const SO_NAMES = [
      'libcudnn.so.9',
      'libcudnn_ops.so.9',       // cuDNN 9.x 분리 라이브러리
      'libcudnn.so.8',
      'libcudnn_ops_infer.so.8', // cuDNN 8.x 분리 빌드 일부
      'libcudnn.so',             // 버전 symlink 없을 때 fallback
    ];

    // 1) 직접 경로 탐색 (arch dirs × cuda prefixes × so names)
    for (const soName of SO_NAMES) {
      for (const archDir of ARCH_DIRS) {
        const p = `${archDir}/${soName}`;
        if (fs.existsSync(p)) {
          const version = _cudnnVersionFromSoName(soName);
          return { available: true, path: p, version };
        }
      }
      for (const prefix of CUDA_PREFIXES) {
        const p = `${prefix}/lib64/${soName}`;
        if (fs.existsSync(p)) {
          const version = _cudnnVersionFromSoName(soName);
          return { available: true, path: p, version };
        }
      }
    }

    // 2) ldconfig 캐시 탐색 (설치 경로가 비표준인 경우)
    const ldout = _run('ldconfig -p 2>/dev/null | grep -E "libcudnn\\.so\\.(9|8)|libcudnn_ops\\.so\\.(9|8)"');
    if (ldout) {
      const firstLine = ldout.split('\n')[0];
      const p = firstLine.split('=>').pop()?.trim();
      const version = firstLine.includes('.so.9') ? '9.x' : '8.x';
      return { available: true, path: p || 'ldconfig entry', version };
    }

    // 3) find로 비표준 위치 탐색 (느리지만 마지막 수단)
    const findOut = _run(
      'find /usr /opt /home -maxdepth 8 -name "libcudnn.so.9" -o -name "libcudnn.so.8" 2>/dev/null | head -1',
      8000
    );
    if (findOut) {
      const version = findOut.includes('.so.9') ? '9.x' : '8.x';
      return { available: true, path: findOut.trim(), version };
    }

    return {
      available: false,
      reason: 'libcudnn.so.9 / libcudnn.so.8 미감지 (cuDNN 9.x 또는 8.x 필요)',
      installCmds: [
        '# ── cuDNN 9.x 설치 (CUDA 12.x 권장) ──',
        '# 방법 1: apt (Ubuntu 22.04/24.04 — CUDA 저장소 등록 후):',
        'sudo apt-get install -y libcudnn9-cuda-12 libcudnn9-dev-cuda-12',
        '',
        '# 방법 2: tar.xz 수동 설치 (https://developer.nvidia.com/cudnn):',
        'tar -xf cudnn-linux-x86_64-9.x.x_cuda12-archive.tar.xz',
        'sudo cp cudnn-linux-x86_64-9.x.x_cuda12-archive/include/cudnn*.h /usr/local/cuda/include/',
        'sudo cp cudnn-linux-x86_64-9.x.x_cuda12-archive/lib/libcudnn* /usr/local/cuda/lib64/',
        'sudo ldconfig',
        '',
        '# 방법 3: cuDNN 8.x (구버전):',
        'sudo apt-get install -y libcudnn8 libcudnn8-dev',
      ],
    };
  }

  if (IS_WIN) {
    // ── Windows cuDNN 검색 ─────────────────────────────────────────────────
    //
    // 설치 방식에 따라 DLL 위치가 다름:
    //   [zip 방식]  CUDA bin에 복사 → C:\...\CUDA\v12.8\bin\cudnn64_9.dll
    //   [EXE 방식]  별도 경로 설치  → C:\Program Files\NVIDIA\CUDNN\v9.x.x\bin\12.x\cudnn64_9.dll
    //   [System32]  일부 설치 스크립트가 복사  → C:\Windows\System32\cudnn64_9.dll
    //
    // cuDNN 9.x DLL 목록 (모든 변형 포함):
    //   cudnn64_9.dll          — 단일 통합 DLL (zip 설치, 일부 9.x)
    //   cudnn_ops.dll          — 분리 ops 라이브러리 (EXE 설치 9.x)
    //   cudnn_cnn.dll          — 분리 CNN 라이브러리 (EXE 설치 9.x)
    //   cudnn_graph.dll        — 분리 그래프 라이브러리 (EXE 설치 9.x)
    // cuDNN 8.x:
    //   cudnn64_8.dll

    const CUDNN9_DLLS = ['cudnn64_9.dll', 'cudnn_ops.dll', 'cudnn_cnn.dll', 'cudnn_graph.dll'];
    const CUDNN8_DLLS = ['cudnn64_8.dll'];
    const ALL_DLLS    = [...CUDNN9_DLLS, ...CUDNN8_DLLS];

    const CUDA_VERSIONS = [
      '12.9','12.8','12.7','12.6','12.5','12.4','12.3','12.2','12.1','12.0',
      '11.8','11.7','11.6',
    ];
    const CUDA_BASE = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';

    // cuDNN 9.x EXE 설치 경로 (독립 설치 관리자 방식)
    // 패턴: C:\Program Files\NVIDIA\CUDNN\v{major}.{minor}\bin\{cuda_ver}\{arch}\
    const CUDNN_EXE_BASE = 'C:\\Program Files\\NVIDIA\\CUDNN';
    const CUDNN9_MAJOR_VERS = [
      '9.23','9.22','9.21','9.20','9.19','9.18','9.17','9.16','9.15',
      '9.14','9.13','9.12','9.11','9.10','9.9',
      '9.8','9.7','9.6','9.5','9.4','9.3','9.2','9.1','9.0',
    ];
    const CUDA_SHORT_VERS = ['12.9','12.8','12.7','12.6','12.5','12.4','12.3','12.2','12.1'];

    // cuDNN EXE 설치 시 bin\{cudaVer}\{arch}\ 구조로 아키텍처 서브디렉토리가 추가됨
    // process.arch: 'x64' → 'x64',  'arm64' → 'arm64'
    // 실제 경로 우선, 이후 arch 없는 경로(zip 방식 호환) 순으로 탐색
    const CUDNN_ARCH_SUBDIRS = (() => {
      const archMap = { x64: 'x64', arm64: 'arm64' };
      const arch = archMap[process.arch];
      return arch ? [arch, ''] : [''];  // arch 서브디렉토리 먼저, fallback으로 없는 경우
    })();

    function _checkWinDll(basePath, dll) {
      const p = path.join(basePath, dll);
      if (fs.existsSync(p)) {
        const version = dll.includes('9') || dll === 'cudnn_ops.dll'
          || dll === 'cudnn_cnn.dll' || dll === 'cudnn_graph.dll' ? '9.x' : '8.x';
        return { available: true, path: p, version };
      }
      return null;
    }

    // 1) CUDA_PATH 환경변수 → bin/ 탐색
    const cudaEnvCandidates = [
      process.env.CUDA_PATH,
      process.env.CUDA_PATH_V12_9,
      process.env.CUDA_PATH_V12_8,
      process.env.CUDA_PATH_V12_7,
      process.env.CUDA_PATH_V12_6,
      process.env.CUDA_PATH_V12_5,
      process.env.CUDA_PATH_V12_4,
      process.env.CUDA_PATH_V12_3,
      process.env.CUDA_PATH_V12_2,
      process.env.CUDA_PATH_V12_1,
      process.env.CUDA_PATH_V12_0,
      process.env.CUDA_PATH_V11_8,
      process.env.CUDA_PATH_V11_7,
    ].filter(Boolean);

    for (const base of cudaEnvCandidates) {
      for (const dll of ALL_DLLS) {
        const r = _checkWinDll(path.join(base, 'bin'), dll);
        if (r) return r;
      }
    }

    // 2) CUDA 기본 설치 경로 버전별 스캔 → bin/
    for (const ver of CUDA_VERSIONS) {
      for (const dll of ALL_DLLS) {
        const r = _checkWinDll(path.join(CUDA_BASE, `v${ver}`, 'bin'), dll);
        if (r) return r;
      }
    }

    // 3) cuDNN EXE 독립 설치 경로 스캔
    //    C:\Program Files\NVIDIA\CUDNN\v9.x\bin\{cudaVer}\{arch}\  (EXE 설치 — arch 포함)
    //    C:\Program Files\NVIDIA\CUDNN\v9.x\bin\{cudaVer}\         (zip 복사 방식 — arch 없음)
    //    C:\Program Files\NVIDIA\CUDNN\v9.x\bin\                    (직접 복사 방식)
    function _scanCudnnExeBase(basePath) {
      for (const cudaVer of CUDA_SHORT_VERS) {
        for (const archSub of CUDNN_ARCH_SUBDIRS) {
          const binDir = archSub
            ? path.join(basePath, 'bin', cudaVer, archSub)
            : path.join(basePath, 'bin', cudaVer);
          for (const dll of CUDNN9_DLLS) {
            const r = _checkWinDll(binDir, dll);
            if (r) return r;
          }
        }
      }
      // bin\ 직접 (일부 zip 설치)
      for (const dll of CUDNN9_DLLS) {
        const r = _checkWinDll(path.join(basePath, 'bin'), dll);
        if (r) return r;
      }
      return null;
    }

    for (const cudnnVer of CUDNN9_MAJOR_VERS) {
      const cudnnBase = path.join(CUDNN_EXE_BASE, `v${cudnnVer}`);
      if (fs.existsSync(cudnnBase)) {
        const r = _scanCudnnExeBase(cudnnBase);
        if (r) return r;
      }
    }
    // 패치 버전 포함 폴더 동적 스캔 (예: v9.23.0, v9.23.1 ...)
    if (fs.existsSync(CUDNN_EXE_BASE)) {
      try {
        const entries = fs.readdirSync(CUDNN_EXE_BASE).filter(e => e.startsWith('v9.'));
        for (const entry of entries) {
          const r = _scanCudnnExeBase(path.join(CUDNN_EXE_BASE, entry));
          if (r) return r;
        }
      } catch {}
    }

    // 4) System32 (PATH 복사 방식)
    for (const dll of ALL_DLLS) {
      const r = _checkWinDll('C:\\Windows\\System32', dll);
      if (r) return r;
    }

    // 5) where 명령어 (PATH 전체 탐색)
    for (const dll of ALL_DLLS) {
      const whereOut = _run(`where ${dll} 2>nul`);
      if (whereOut) {
        const p = whereOut.split('\n')[0].trim();
        const version = dll.includes('9') || dll === 'cudnn_ops.dll'
          || dll === 'cudnn_cnn.dll' || dll === 'cudnn_graph.dll' ? '9.x' : '8.x';
        return { available: true, path: p, version };
      }
    }

    return {
      available: false,
      reason: 'cudnn64_9.dll / cudnn_ops.dll / cudnn64_8.dll 미감지 (cuDNN 9.x 또는 8.x)',
      installCmds: [
        '# ── Windows cuDNN 설치 ──',
        '# NVIDIA 계정 필요: https://developer.nvidia.com/cudnn',
        '',
        '# 방법 A: zip 파일 (수동 복사 — 전통적 방식):',
        '#  1. "Local Installer for Windows (Zip)" 다운로드',
        '#  2. 압축 해제 후 아래 경로로 파일 복사:',
        '#     cudnn-windows-x86_64-9.x.x_cuda12-archive\\bin\\*',
        '#       → C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.8\\bin\\',
        '#     cudnn-windows-x86_64-9.x.x_cuda12-archive\\include\\*',
        '#       → C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.8\\include\\',
        '#     cudnn-windows-x86_64-9.x.x_cuda12-archive\\lib\\*',
        '#       → C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.8\\lib\\',
        '',
        '# 방법 B: EXE 설치 관리자 (cuDNN 9.x 권장):',
        '#  1. "Local Installer for Windows (Exe)" 다운로드',
        '#  2. 설치 후 DLL 경로가 PATH에 포함되는지 확인:',
        '#     C:\\Program Files\\NVIDIA\\CUDNN\\v9.x.x\\bin\\12.8\\',
        '',
        '# 설치 확인 (PowerShell):',
        '#  where.exe cudnn64_9.dll',
        '#  where.exe cudnn_ops.dll',
      ],
    };
  }

  return { available: false, reason: `cuDNN 감지 미지원 플랫폼: ${process.platform}` };
}

/** libcudnn.so.N 파일명에서 major 버전 추출 */
function _cudnnVersionFromSoName(soName) {
  const m = soName.match(/\.so\.(\d+)/);
  return m ? `${m[1]}.x` : 'unknown';
}

// ── ORT Provider checks ───────────────────────────────────────────────────────

async function detectOrtCudaSupport() {
  try {
    const ort = require('onnxruntime-node');
    let backends = [];
    try { backends = ort.listSupportedBackends?.() ?? []; } catch {}
    const names = backends.map(b => String(b?.name || '').toLowerCase());

    if (names.includes('cuda')) {
      return { available: true };
    }

    // Read ORT package metadata
    let ortVersion = 'unknown';
    try {
      const pkgPath = require.resolve('onnxruntime-node/package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      ortVersion = pkg.version;
    } catch {}

    return {
      available: false,
      reason: `onnxruntime-node@${ortVersion} 가 CUDA provider 미포함 빌드입니다.`,
      ortVersion,
      installCmds: [
        '# ── CUDA 지원 ORT 빌드 방법 ──',
        '',
        '# 방법 A: 자동 빌드 스크립트 (권장 — CUDA/cuDNN/GPU 아키텍처 자동 감지):',
        'npm run build-ort:auto             # 서버 디렉토리 또는',
        'cd server && npm run build-ort:auto',
        '',
        '# 사전 확인 (빌드 없이 감지 결과만 출력):',
        'npm run build-ort:auto:dry',
        '',
        '# 방법 B: 플랫폼별 수동 실행:',
        '# Windows (PowerShell — x64 Native Tools Command Prompt for VS 2022):',
        'npm run build-ort-source:windows',
        '# Linux:',
        'npm run build-ort-source:linux',
        '',
        '# 빌드 완료 후 .env에 추가:',
        'ONNX_CUDA=1',
      ],
    };
  } catch (err) {
    return { available: false, reason: `onnxruntime-node 로드 실패: ${err.message}` };
  }
}

async function detectDmlSupport() {
  if (!IS_WIN) {
    return { available: false, reason: 'DirectML은 Windows 전용입니다.' };
  }
  try {
    const ort = require('onnxruntime-node');
    let backends = [];
    try { backends = ort.listSupportedBackends?.() ?? []; } catch {}
    const names = backends.map(b => String(b?.name || '').toLowerCase());
    if (names.includes('dml')) {
      return { available: true };
    }
    let ortVersion = 'unknown';
    try {
      const pkgPath = require.resolve('onnxruntime-node/package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      ortVersion = pkg.version;
    } catch {}
    return {
      available: false,
      reason: `onnxruntime-node@${ortVersion} 가 DirectML provider 미포함 빌드입니다.`,
      ortVersion,
      installCmds: [
        '# Windows DML 지원 ORT:',
        'npm install onnxruntime-node  # Windows용 빌드는 DML 자동 포함',
        '# DirectX 12 지원 GPU 드라이버 최신 버전 필요',
      ],
    };
  } catch (err) {
    return { available: false, reason: `onnxruntime-node 로드 실패: ${err.message}` };
  }
}

// ── Batch inference capability ────────────────────────────────────────────────

function getBatchInferenceInfo() {
  const maxSize  = parseInt(process.env.BATCH_MAX_SIZE, 10)  || 4;
  const maxWait  = parseInt(process.env.BATCH_MAX_WAIT_MS, 10) || 33;
  const enabled  = maxSize > 1;
  return {
    enabled,
    maxSize,
    maxWaitMs: maxWait,
    note: enabled
      ? `멀티카메라 배치 추론 활성 (최대 ${maxSize}개 프레임 묶음, 최대 대기 ${maxWait}ms)`
      : 'BATCH_MAX_SIZE=1 → 단일 프레임 추론 (배치 비활성)',
  };
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

async function getProviderDiagnostics() {
  const [gpu, cudaToolkit, cudnn, ortCuda, dml] = await Promise.all([
    detectNvidiaGpu(),
    detectCudaToolkit(),
    detectCuDNN(),
    detectOrtCudaSupport(),
    detectDmlSupport(),
  ]);

  const recommended = _recommend(gpu, ortCuda, dml);

  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    gpu,
    cudaToolkit,
    cudnn,
    ort: {
      cuda: ortCuda,
      dml,
    },
    cpu: { available: true },
    batchInference: getBatchInferenceInfo(),
    recommended,
    activeEnv: {
      ONNX_CUDA:       process.env.ONNX_CUDA ?? '(unset)',
      ONNX_CUDA_STRICT: process.env.ONNX_CUDA_STRICT ?? '(unset)',
      BATCH_MAX_SIZE:  process.env.BATCH_MAX_SIZE ?? '(unset → 4)',
      BATCH_MAX_WAIT_MS: process.env.BATCH_MAX_WAIT_MS ?? '(unset → 33)',
    },
  };
}

function _recommend(gpu, ortCuda, dml) {
  if (gpu.available && ortCuda.available) return 'cuda';
  if (dml.available) return 'dml';
  return 'cpu';
}

/**
 * Returns a human-readable install guide for missing components.
 * @param {object} diag  Result of getProviderDiagnostics()
 * @returns {string}
 */
function getInstallGuide(diag) {
  const sections = [];

  if (!diag.gpu.available) {
    sections.push([
      '## ❌ NVIDIA GPU 미감지',
      diag.gpu.reason,
      'NVIDIA 드라이버를 설치하거나 GPU가 없는 환경에서는 CPU 또는 DirectML을 사용하세요.',
    ].join('\n'));
  }

  if (diag.gpu.available && !diag.cudaToolkit.available) {
    const cmds = diag.cudaToolkit.installCmds || [];
    sections.push([
      '## ❌ CUDA Toolkit 미설치',
      diag.cudaToolkit.reason,
      cmds.join('\n'),
    ].join('\n'));
  }

  if (diag.gpu.available && diag.cudaToolkit.available && !diag.cudnn.available) {
    const cmds = diag.cudnn.installCmds || [];
    sections.push([
      '## ❌ cuDNN 미설치',
      diag.cudnn.reason,
      cmds.join('\n'),
    ].join('\n'));
  }

  if (diag.gpu.available && !diag.ort.cuda.available) {
    const cmds = diag.ort.cuda.installCmds || [];
    sections.push([
      '## ❌ ONNX Runtime CUDA 지원 빌드 필요',
      diag.ort.cuda.reason,
      cmds.join('\n'),
    ].join('\n'));
  }

  if (IS_WIN && !diag.ort.dml.available) {
    const cmds = diag.ort.dml.installCmds || [];
    sections.push([
      '## ⚠️  DirectML 지원 빌드 필요 (Windows)',
      diag.ort.dml.reason,
      cmds.join('\n'),
    ].join('\n'));
  }

  if (sections.length === 0) {
    return `## ✅ 모든 설정 정상\n권장 provider: ${diag.recommended.toUpperCase()}`;
  }
  return sections.join('\n\n');
}

module.exports = {
  getProviderDiagnostics,
  getInstallGuide,
  detectNvidiaGpu,
  detectCudaToolkit,
  detectCuDNN,
  detectOrtCudaSupport,
  detectDmlSupport,
  getBatchInferenceInfo,
};
