'use strict';

/**
 * ONNX Runtime CUDA 소스 빌드 자동 실행기
 *
 * providerDiagnostics 를 통해 감지된 CUDA/cuDNN 경로와 GPU 아키텍처를
 * 자동으로 플랫폼별 빌드 스크립트(PowerShell/bash)에 전달합니다.
 *
 * 사용법:
 *   node server/src/scripts/buildOrtWithCuda.js
 *   npm run build-ort:auto            (server/ 또는 루트에서)
 *
 * 옵션:
 *   --ort-ref <tag>       ORT 버전 태그 (기본: v1.26.0)
 *   --ort-repo <path>     clone 대상 로컬 경로 (기본: ~/source/onnxruntime)
 *   --skip-clone          git clone/fetch 건너뜀
 *   --skip-build          네이티브 빌드 건너뜀
 *   --skip-node-build     js/node 패키지 빌드 건너뜀
 *   --skip-install        server 프로젝트 install 건너뜀
 *   --insecure-tls        CMAKE_TLS_VERIFY=0 (기업 프록시 환경용, Windows 전용)
 *   --dry-run             감지 결과 출력 후 실제 빌드 없이 종료
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { execFileSync, spawnSync } = require('child_process');
const path   = require('path');
const { getProviderDiagnostics } = require('../utils/providerDiagnostics');

const IS_WIN   = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const SCRIPT_DIR = __dirname;

// ── CLI 파싱 ─────────────────────────────────────────────────────────────────

function parseCli() {
  const args = process.argv.slice(2);
  const get  = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  const defaultRepoDir = path.join(
    process.env.USERPROFILE || process.env.HOME || '~',
    'source', 'onnxruntime'
  );
  return {
    ortRef:         get('--ort-ref')  || 'v1.26.0',
    ortRepoDir:     get('--ort-repo') || defaultRepoDir,
    skipClone:      args.includes('--skip-clone'),
    skipBuild:      args.includes('--skip-build'),
    skipNodeBuild:  args.includes('--skip-node-build'),
    skipInstall:    args.includes('--skip-install'),
    insecureTls:    args.includes('--insecure-tls'),
    dryRun:         args.includes('--dry-run'),
  };
}

// ── 경로 유도 헬퍼 ───────────────────────────────────────────────────────────

/**
 * nvcc 경로 → CUDA_HOME
 *   Linux:   /usr/local/cuda-12.9/bin/nvcc → /usr/local/cuda-12.9
 *   Windows: C:\...\CUDA\v12.9\bin\nvcc.exe → C:\...\CUDA\v12.9
 *
 * nvccPath 가 없거나 유도된 경로가 존재하지 않으면 환경변수 / 기본 설치 경로로 fallback
 */
function deriveCudaHome(nvccPath, cudaVersion) {
  const fs = require('fs');

  // 1) nvcc 경로에서 2단계 상위 디렉토리 유도
  if (nvccPath) {
    const derived = path.dirname(path.dirname(nvccPath));
    if (fs.existsSync(derived)) return derived;
  }

  // 2) CUDA_PATH_Vxx 환경변수 탐색 (버전 순)
  const envVars = [
    'CUDA_PATH_V12_9', 'CUDA_PATH_V12_8', 'CUDA_PATH_V12_7',
    'CUDA_PATH_V12_6', 'CUDA_PATH_V12_5', 'CUDA_PATH_V12_4',
    'CUDA_PATH_V12_3', 'CUDA_PATH_V12_2', 'CUDA_PATH_V12_1',
    'CUDA_PATH_V12_0', 'CUDA_PATH_V11_8', 'CUDA_PATH_V11_7',
    'CUDA_PATH',
  ];
  for (const v of envVars) {
    const val = process.env[v];
    if (val && fs.existsSync(val)) return val;
  }

  // 3) 감지된 버전 문자열로 기본 설치 경로 구성 (Windows)
  if (cudaVersion && IS_WIN) {
    const winPath = `C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v${cudaVersion}`;
    if (fs.existsSync(winPath)) return winPath;
  }

  // 4) /usr/local/cuda symlink (Linux)
  if (!IS_WIN && require('fs').existsSync('/usr/local/cuda')) return '/usr/local/cuda';

  return '';
}

/**
 * cuDNN 라이브러리 경로 → CUDNN_HOME
 *
 * Windows EXE 설치: ...NVIDIA\CUDNN\v9.23\bin\12.9\x64\cudnn64_9.dll
 *   → C:\Program Files\NVIDIA\CUDNN\v9.23
 * zip / Linux: CUDA 경로 안에 있거나 시스템 경로
 *   → '' (ORT build.bat/sh 이 CUDA_HOME 에서 찾음)
 */
function deriveCudnnHome(cudnnPath) {
  if (!cudnnPath) return '';
  // Windows EXE 독립 설치 감지: \NVIDIA\CUDNN\v{version}\ 패턴
  const m = cudnnPath.match(/(.+[/\\]CUDNN[/\\]v[\d.]+)/i);
  return m ? m[1] : '';
}

/**
 * nvidia-smi 로 GPU compute capability 조회
 * "8.9" → "89"   (RTX 4090 / RTX 2000 Ada)
 * "8.6" → "86"   (RTX 3080)
 */
function detectCudaArch() {
  try {
    const out = execFileSync('nvidia-smi', [
      '--query-gpu=compute_cap', '--format=csv,noheader',
    ], { timeout: 5000, encoding: 'utf8' }).trim();
    const cap = out.split('\n')[0].trim();  // 첫 번째 GPU만 사용
    return cap.replace('.', '');            // "8.9" → "89"
  } catch {
    return '';
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseCli();

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  LTS-2026  ORT CUDA 소스 빌드 자동 실행기');
  console.log(`  플랫폼: ${process.platform} / ${process.arch}  Node ${process.version}`);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('[1/3] 환경 감지 중...');

  const diag = await getProviderDiagnostics();

  // ── GPU 확인 ──────────────────────────────────────────────────────────────
  if (!diag.gpu.available) {
    console.error('[ERROR] NVIDIA GPU 미감지. NVIDIA 드라이버 설치 후 재시도하세요.');
    console.error(`        상세: ${diag.gpu.reason}`);
    process.exit(1);
  }
  for (const g of diag.gpu.gpus) {
    console.log(`  ✅ GPU       : ${g.name}  (Driver ${g.driver}, VRAM ${g.memory})`);
  }

  // ── CUDA Toolkit 확인 ─────────────────────────────────────────────────────
  if (!diag.cudaToolkit.available) {
    console.error(`[ERROR] CUDA Toolkit 미감지: ${diag.cudaToolkit.reason}`);
    if (diag.cudaToolkit.installCmds) {
      console.error('  설치 방법:');
      diag.cudaToolkit.installCmds.forEach(l => console.error('  ' + l));
    }
    process.exit(1);
  }
  console.log(`  ✅ CUDA      : v${diag.cudaToolkit.version}  (${diag.cudaToolkit.path})`);

  // ── cuDNN 확인 ────────────────────────────────────────────────────────────
  if (diag.cudnn.available) {
    const verStr = diag.cudnn.version ? `cuDNN ${diag.cudnn.version}  ` : '';
    console.log(`  ✅ cuDNN     : ${verStr}→ ${diag.cudnn.path}`);
  } else {
    console.warn(`  ⚠️  cuDNN    : 미감지 — cuDNN 없이 빌드됩니다 (일부 연산 성능 저하)`);
  }

  // ── 경로 유도 ─────────────────────────────────────────────────────────────
  const cudaHome  = deriveCudaHome(diag.cudaToolkit.path, diag.cudaToolkit.version);
  const cudnnHome = deriveCudnnHome(diag.cudnn.path || '');
  const cudaArch  = detectCudaArch();

  if (!cudaHome) {
    console.error('[ERROR] CUDA_HOME 을 유도할 수 없습니다. nvcc 경로를 확인하세요.');
    process.exit(1);
  }

  if (cudaArch) {
    console.log(`  ✅ CUDA Arch : sm_${cudaArch}  (nvidia-smi 자동 감지)`);
  } else {
    console.warn(`  ⚠️  CUDA Arch : 미감지 — CMake 가 자동 결정합니다`);
  }

  console.log('');
  console.log('[2/3] 빌드 파라미터 확인:');
  console.log(`  ORT_REF    : ${opts.ortRef}`);
  console.log(`  ORT_REPO   : ${opts.ortRepoDir}`);
  console.log(`  CUDA_HOME  : ${cudaHome}`);
  console.log(`  CUDNN_HOME : ${cudnnHome || '(빌드 스크립트가 CUDA_HOME 에서 자동 탐색)'}`);
  console.log(`  CUDA_ARCH  : ${cudaArch || '(CMake 자동 결정)'}`);
  console.log('');

  if (opts.dryRun) {
    console.log('[DRY-RUN] --dry-run 모드 — 실제 빌드를 실행하지 않습니다.');
    console.log('          위 파라미터로 실제 빌드하려면 --dry-run 옵션을 제거하세요.');
    process.exit(0);
  }

  console.log('[3/3] 빌드 스크립트 실행 중...');
  console.log('');

  // ── Windows ───────────────────────────────────────────────────────────────
  if (IS_WIN) {
    const ps1 = path.join(SCRIPT_DIR, 'build-onnxruntime-source.windows.ps1');
    const psArgs = [
      '-ExecutionPolicy', 'Bypass',
      '-File', ps1,
      '-OrtRef',      opts.ortRef,
      '-OrtRepoDir',  opts.ortRepoDir,
      '-CudaHome',    cudaHome,
    ];
    if (cudnnHome)        psArgs.push('-CudnnHome',  cudnnHome);
    if (cudaArch)         psArgs.push('-CudaArch',   cudaArch);
    if (opts.skipClone)   psArgs.push('-SkipClone');
    if (opts.skipBuild)   psArgs.push('-SkipBuild');
    if (opts.skipNodeBuild) psArgs.push('-SkipNodePackageBuild');
    if (opts.skipInstall) psArgs.push('-SkipProjectInstall');
    if (opts.insecureTls) psArgs.push('-AllowInsecureTlsForFetch');

    const result = spawnSync('powershell.exe', psArgs, { stdio: 'inherit' });
    process.exit(result.status ?? 1);

  // ── Linux ─────────────────────────────────────────────────────────────────
  } else if (IS_LINUX) {
    const sh = path.join(SCRIPT_DIR, 'build-onnxruntime-source.linux.sh');
    const env = {
      ...process.env,
      ORT_REF:                 opts.ortRef,
      ORT_REPO_DIR:            opts.ortRepoDir,
      CUDA_HOME:               cudaHome,
      CUDNN_HOME:              cudnnHome,
      CUDA_ARCH:               cudaArch,
      SKIP_CLONE:              opts.skipClone    ? '1' : '0',
      SKIP_BUILD:              opts.skipBuild    ? '1' : '0',
      SKIP_NODE_PACKAGE_BUILD: opts.skipNodeBuild ? '1' : '0',
      SKIP_PROJECT_INSTALL:    opts.skipInstall  ? '1' : '0',
    };

    const result = spawnSync('bash', [sh], { stdio: 'inherit', env });
    process.exit(result.status ?? 1);

  } else {
    console.error(`[ERROR] 지원되지 않는 플랫폼: ${process.platform}`);
    console.error('        Windows(PowerShell) 또는 Linux(bash) 에서 실행하세요.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[buildOrtWithCuda] 오류:', err.message);
  process.exit(1);
});
