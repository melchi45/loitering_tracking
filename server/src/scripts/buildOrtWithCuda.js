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
 *   --no-report           빌드 로그를 LTS 서버로 전송하지 않음 (기본: 전송)
 *
 * 원격 로그 확인:
 *   이 스크립트는 자체 프로세스로 실행되어 서버 콘솔과 stdio 를 공유하지 않으므로,
 *   각 출력 라인을 best-effort 로 POST /api/internal/build-log 에 전송합니다.
 *   같은 머신에서 LTS 서버(combined/analysis)가 실행 중이면 Admin Dashboard →
 *   Logs → "ORT CUDA Build" 탭(GET /admin/logs/recent?source=build)에서 실시간에
 *   가깝게 진행 상황·오류를 확인할 수 있습니다. 대상 URL은
 *   BUILD_LOG_REPORT_URL 환경변수로 재정의 가능(기본: server/.env 의
 *   HTTPS_ENABLED/HTTP_PORT/HTTPS_PORT 로 로컬 서버 주소를 유도).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { execFileSync, spawn } = require('child_process');
const http   = require('http');
const https  = require('https');
const path   = require('path');
const { getProviderDiagnostics } = require('../utils/providerDiagnostics');

const IS_WIN   = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const SCRIPT_DIR = __dirname;

// ── 원격 로그 전송 (best-effort) ─────────────────────────────────────────────

let _reportEnabled = true;
let _reportUrl      = '';
let _reportQueue    = [];
let _reportTimer    = null;
let _reportWarned   = false;

function _resolveReportUrl() {
  if (process.env.BUILD_LOG_REPORT_URL) return process.env.BUILD_LOG_REPORT_URL;
  const httpsEnabled = process.env.HTTPS_ENABLED === 'true';
  const proto = httpsEnabled ? 'https' : 'http';
  const port  = httpsEnabled
    ? parseInt(process.env.HTTPS_PORT || '3443', 10)
    : parseInt(process.env.HTTP_PORT  || '3080', 10);
  return `${proto}://127.0.0.1:${port}/api/internal/build-log`;
}

function _flushReportQueue() {
  if (_reportQueue.length === 0) return;
  const lines = _reportQueue.splice(0, _reportQueue.length);
  let body;
  try {
    body = JSON.stringify({ lines });
  } catch {
    return;
  }
  try {
    const url    = new URL(_reportUrl);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false, // internal loopback call — self-signed certs are expected
      timeout: 3000,
    }, (res) => { res.resume(); });
    req.on('error', () => {
      if (!_reportWarned) {
        _reportWarned = true;
        process.stderr.write('[buildOrtWithCuda] LTS 서버로 빌드 로그 전송 실패 — 로컬 콘솔에만 기록됩니다 (서버 미기동 시 정상).\n');
      }
    });
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch (_) { /* best-effort — never let log relay break the build */ }
}

function _reportLine(text) {
  if (!_reportEnabled) return;
  _reportQueue.push(String(text).slice(0, 2000));
  if (_reportQueue.length >= 50) { _flushReportQueue(); return; }
  if (!_reportTimer) {
    _reportTimer = setTimeout(() => { _reportTimer = null; _flushReportQueue(); }, 500);
    _reportTimer.unref?.();
  }
}

/** Patches console.log/warn/error to also relay every line to the LTS server. */
function installReportingConsole() {
  const origLog   = console.log;
  const origWarn  = console.warn;
  const origError = console.error;
  console.log   = (...a) => { origLog(...a);   _reportLine(a.map(String).join(' ')); };
  console.warn  = (...a) => { origWarn(...a);  _reportLine('[WARN] '  + a.map(String).join(' ')); };
  console.error = (...a) => { origError(...a); _reportLine('[ERROR] ' + a.map(String).join(' ')); };
}

/** Exits the process after giving the report queue a brief chance to flush. */
function exitWithFlush(code) {
  _flushReportQueue();
  setTimeout(() => process.exit(code), 150);
}

/**
 * Runs a command with stdio piped (not 'inherit') so each output line can be
 * echoed locally AND relayed to the LTS server. Mirrors utils/logger.js's
 * makeLineRelay buffering approach.
 */
function runStreamed(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['inherit', 'pipe', 'pipe'] });

    const relay = (stream, isErr) => {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) {
          (isErr ? process.stderr : process.stdout).write(line + '\n');
          _reportLine(line);
        }
      });
      stream.on('end', () => {
        if (buf) {
          (isErr ? process.stderr : process.stdout).write(buf + '\n');
          _reportLine(buf);
        }
      });
    };
    relay(child.stdout, false);
    relay(child.stderr, true);

    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      process.stderr.write(`${err.message}\n`);
      _reportLine(`[ERROR] ${err.message}`);
      resolve(1);
    });
  });
}

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
    noReport:       args.includes('--no-report'),
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

  _reportEnabled = !opts.noReport;
  _reportUrl     = _resolveReportUrl();
  if (_reportEnabled) {
    installReportingConsole();
    console.log(`[buildOrtWithCuda] 빌드 로그를 LTS 서버로 전송합니다: ${_reportUrl} (--no-report 로 비활성화)`);
    console.log('[buildOrtWithCuda] Admin Dashboard → Logs → "ORT CUDA Build" 에서 진행 상황을 확인하세요.');
  }

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
    exitWithFlush(1);
    return;
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
    exitWithFlush(1);
    return;
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
    exitWithFlush(1);
    return;
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
    exitWithFlush(0);
    return;
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

    const code = await runStreamed('powershell.exe', psArgs, {});
    exitWithFlush(code);

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

    const code = await runStreamed('bash', [sh], { env });
    exitWithFlush(code);

  } else {
    console.error(`[ERROR] 지원되지 않는 플랫폼: ${process.platform}`);
    console.error('        Windows(PowerShell) 또는 Linux(bash) 에서 실행하세요.');
    exitWithFlush(1);
  }
}

main().catch(err => {
  console.error('[buildOrtWithCuda] 오류:', err.message);
  exitWithFlush(1);
});
