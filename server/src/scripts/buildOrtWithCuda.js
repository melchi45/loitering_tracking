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
 *   --ensure-cuda         CUDA Toolkit 미설치/버전 불일치 및 cuDNN 미설치 시 자동 설치
 *                         (ensure-cuda-toolkit.windows.ps1 / ensure-cudnn.windows.ps1 를
 *                         내부 호출, Windows 전용. cuDNN 은 NVIDIA 로그인 없이 받을 수
 *                         있는 pip 패키지(nvidia-cudnn-cuXX)로 설치합니다.)
 *   --ensure-cuda:dry     설치 없이 필요 버전과 다운로드 URL/패키지명만 출력
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
    ensureCuda:     args.includes('--ensure-cuda'),
    ensureCudaDry:  args.includes('--ensure-cuda:dry'),
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
 * cuDNN 경로에서 cuDNN이 빌드된 CUDA 버전 추출
 *   EXE 설치: ...CUDNN\v9.23\bin\12.9\x64\cudnn64_9.dll → "12.9"
 *   providerDiagnostics.js 가 cudnnCudaVersion 필드를 이미 추출하지만,
 *   fallback 으로 경로 패턴에서도 유도합니다.
 */
function deriveCudnnCudaVersion(cudnnPath, diagCudnnCudaVersion) {
  if (diagCudnnCudaVersion) return diagCudnnCudaVersion;
  if (!cudnnPath) return '';
  // EXE 설치 패턴: ...\bin\12.9\x64\... 또는 ...\include\12.9\...
  const m = cudnnPath.match(/[/\\](?:bin|include|lib)[/\\]([\d]+\.[\d]+)[/\\]/i);
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
    if (opts.ensureCuda || opts.ensureCudaDry) {
      // --ensure-cuda: CUDA 자체가 없는 경우 cuDNN이 요구하는 버전으로 자동 설치 시도
      if (!IS_WIN) {
        console.error('[ERROR] --ensure-cuda 는 Windows 에서만 지원됩니다.');
        console.error(`        Linux: sudo apt-get install cuda-toolkit-12-9`);
        exitWithFlush(1);
        return;
      }

      // cuDNN 에서 필요 CUDA 버전 추출, 없으면 기본값 12.9
      const cudnnCudaVer = deriveCudnnCudaVersion(
        diag.cudnn?.path || '', diag.cudnn?.cudnnCudaVersion || ''
      );
      const targetVer = cudnnCudaVer
        ? cudnnCudaVer.split('.').slice(0, 2).join('.')
        : '12.9';

      if (cudnnCudaVer) {
        console.log(`  ℹ️  cuDNN 감지 — CUDA ${targetVer} 필요 (cuDNN 호환 버전)`);
      } else {
        console.log(`  ℹ️  cuDNN 미감지 — 기본 버전 CUDA ${targetVer} 설치 시도`);
      }

      const ensurePs1 = path.join(SCRIPT_DIR, 'ensure-cuda-toolkit.windows.ps1');
      const ensureArgs = ['-ExecutionPolicy', 'Bypass', '-File', ensurePs1, '-RequiredVersion', targetVer];
      if (opts.insecureTls) ensureArgs.push('-AllowInsecureTls');

      if (opts.ensureCudaDry) {
        ensureArgs.push('-ShowUrls');
        console.log(`  [--ensure-cuda:dry] CUDA ${targetVer} 인스톨러 URL 확인 중...`);
        await runStreamed('powershell.exe', ensureArgs, {});
        exitWithFlush(0);
        return;
      }

      console.log(`  [--ensure-cuda] CUDA Toolkit ${targetVer} 자동 설치 중...`);
      console.log('  (관리자 권한이 없으면 UAC 팝업이 표시될 수 있습니다.)');
      console.log('');

      let ensureOutput = '';
      const ensureResult = await new Promise((resolve) => {
        const { spawn } = require('child_process');
        const child = spawn('powershell.exe', ensureArgs, { stdio: ['inherit', 'pipe', 'pipe'] });
        const relay = (stream, isErr) => {
          let buf = '';
          stream.on('data', (chunk) => {
            buf += chunk.toString();
            const parts = buf.split('\n');
            buf = parts.pop();
            for (const line of parts) {
              (isErr ? process.stderr : process.stdout).write(line + '\n');
              _reportLine(line);
              ensureOutput += line + '\n';
            }
          });
          stream.on('end', () => {
            if (buf) {
              (isErr ? process.stderr : process.stdout).write(buf + '\n');
              ensureOutput += buf + '\n';
            }
          });
        };
        relay(child.stdout, false);
        relay(child.stderr, true);
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', (err) => { process.stderr.write(`${err.message}\n`); resolve(1); });
      });

      if (ensureResult === 3 || ensureResult !== 0) {
        // 인스톨러 실패 — PS1 이 상세 안내를 이미 출력했으므로 짧게 마무리
        if (ensureResult !== 3) {
          console.error(`[ERROR] CUDA Toolkit ${targetVer} 설치 실패 (종료 코드: ${ensureResult}).`);
        }
        console.error('');
        console.error('  설치 완료 후 새 PowerShell 창에서 다시 실행하세요:');
        console.error('    npm run build-ort:auto');
        exitWithFlush(1);
        return;
      }

      // 설치 후 CUDA_HOME 파싱 → 이후 로직에서 사용하도록 diag 패치
      const cudaHomeLine = ensureOutput.split('\n').find(l => l.trim().startsWith('CUDA_HOME='));
      if (cudaHomeLine) {
        const installedHome = cudaHomeLine.trim().replace(/^CUDA_HOME=/, '');
        console.log(`  ✅ 설치 완료 — CUDA_HOME=${installedHome}`);
        // diag 에 반영하여 이후 CUDA_HOME 유도 로직이 사용하도록 패치
        diag.cudaToolkit.available = true;
        diag.cudaToolkit.version   = targetVer;
        diag.cudaToolkit.path      = require('path').join(installedHome, 'bin', IS_WIN ? 'nvcc.exe' : 'nvcc');
      } else {
        console.warn('  ⚠️  설치 후 CUDA_HOME 을 확인할 수 없습니다. 새 터미널을 열어 다시 시도하세요.');
        exitWithFlush(1);
        return;
      }
      console.log('');
    } else {
      console.error(`[ERROR] CUDA Toolkit 미감지: ${diag.cudaToolkit.reason}`);
      if (diag.cudaToolkit.installCmds) {
        console.error('  설치 방법:');
        diag.cudaToolkit.installCmds.forEach(l => console.error('  ' + l));
      }
      console.error('');
      console.error('  --ensure-cuda 플래그를 사용하면 자동 설치를 시도합니다:');
      console.error('    npm run ensure-cuda');
      console.error('    npm run build-ort:auto -- --ensure-cuda');
      exitWithFlush(1);
      return;
    }
  }
  console.log(`  ✅ CUDA      : v${diag.cudaToolkit.version}  (${diag.cudaToolkit.path})`);

  // ── cuDNN 확인 ────────────────────────────────────────────────────────────
  let effectiveCudnnHome = null;  // --ensure-cuda 로 pip 설치된 cuDNN 홈 (nvidia\cudnn 디렉토리)
  if (diag.cudnn.available) {
    const verStr = diag.cudnn.version ? `cuDNN ${diag.cudnn.version}  ` : '';
    console.log(`  ✅ cuDNN     : ${verStr}→ ${diag.cudnn.path}`);
  } else if (opts.ensureCuda || opts.ensureCudaDry) {
    // --ensure-cuda: cuDNN 미설치 시 pip 패키지(nvidia-cudnn-cuXX)로 자동 설치 시도
    // (NVIDIA 공식 zip/EXE 는 developer.nvidia.com 로그인이 필요해 완전 자동화 불가)
    if (!IS_WIN) {
      console.warn('  ⚠️  cuDNN    : 미감지 — --ensure-cuda 의 cuDNN 자동 설치는 Windows 전용입니다.');
      console.warn('             Linux: sudo apt-get install libcudnn9-cuda-12 libcudnn9-dev-cuda-12');
    } else {
      const cudaMajorMinor = (diag.cudaToolkit.version || '12.9').split('.').slice(0, 2).join('.');
      const ensureCudnnPs1 = path.join(SCRIPT_DIR, 'ensure-cudnn.windows.ps1');
      const ensureCudnnArgs = ['-ExecutionPolicy', 'Bypass', '-File', ensureCudnnPs1, '-CudaMajorMinor', cudaMajorMinor];
      if (opts.insecureTls) ensureCudnnArgs.push('-AllowInsecureTls');

      if (opts.ensureCudaDry) {
        ensureCudnnArgs.push('-ShowUrls');
        console.log(`  [--ensure-cuda:dry] cuDNN(CUDA ${cudaMajorMinor}) pip 패키지 확인 중...`);
        await runStreamed('powershell.exe', ensureCudnnArgs, {});
      } else {
        console.log(`  [--ensure-cuda] cuDNN 자동 설치 중 (pip, CUDA ${cudaMajorMinor})...`);
        console.log('');

        let ensureCudnnOutput = '';
        const ensureCudnnResult = await new Promise((resolve) => {
          const child = spawn('powershell.exe', ensureCudnnArgs, { stdio: ['inherit', 'pipe', 'pipe'] });
          const relay = (stream, isErr) => {
            let buf = '';
            stream.on('data', (chunk) => {
              buf += chunk.toString();
              const parts = buf.split('\n');
              buf = parts.pop();
              for (const line of parts) {
                (isErr ? process.stderr : process.stdout).write(line + '\n');
                _reportLine(line);
                ensureCudnnOutput += line + '\n';
              }
            });
            stream.on('end', () => {
              if (buf) {
                (isErr ? process.stderr : process.stdout).write(buf + '\n');
                ensureCudnnOutput += buf + '\n';
              }
            });
          };
          relay(child.stdout, false);
          relay(child.stderr, true);
          child.on('close', (code) => resolve(code ?? 1));
          child.on('error', (err) => { process.stderr.write(`${err.message}\n`); resolve(1); });
        });

        const cudnnHomeLine = ensureCudnnOutput.split('\n').find(l => l.trim().startsWith('CUDNN_HOME='));
        if (ensureCudnnResult === 0 && cudnnHomeLine) {
          effectiveCudnnHome = cudnnHomeLine.trim().replace(/^CUDNN_HOME=/, '');
          diag.cudnn.available = true;
          diag.cudnn.path = effectiveCudnnHome;
          console.log(`  ✅ cuDNN 설치 완료(pip) — CUDNN_HOME=${effectiveCudnnHome}`);
        } else {
          console.warn(`  ⚠️  cuDNN    : pip 자동 설치 실패 — cuDNN 없이 빌드됩니다 (일부 연산 성능 저하)`);
        }
      }
    }
  } else {
    console.warn(`  ⚠️  cuDNN    : 미감지 — cuDNN 없이 빌드됩니다 (일부 연산 성능 저하)`);
    console.warn('             --ensure-cuda 플래그로 pip 패키지(nvidia-cudnn-cuXX) 자동 설치 가능:');
    console.warn('               npm run build-ort:auto -- --ensure-cuda');
  }

  // ── cuDNN-CUDA 버전 호환성 검사 ───────────────────────────────────────────
  // cuDNN EXE 설치 방식은 CUDA 버전별 서브디렉토리를 사용하므로 불일치 감지 가능.
  // 예) cuDNN v9.23 → CUDA 12.9 전용 설치, CUDA Toolkit 12.8 만 있을 때 빌드 실패.
  let effectiveCudaHome = null;  // --ensure-cuda 로 교체된 CUDA 홈
  if (diag.cudnn.available) {
    const cudnnCudaVer = deriveCudnnCudaVersion(diag.cudnn.path || '', diag.cudnn.cudnnCudaVersion || '');
    const installedCudaVer = diag.cudaToolkit.version || '';

    if (cudnnCudaVer && installedCudaVer) {
      // major.minor 비교 ("12.9" vs "12.8")
      const cudnnMinor     = cudnnCudaVer.split('.').slice(0, 2).join('.');
      const installedMinor = installedCudaVer.split('.').slice(0, 2).join('.');

      if (cudnnMinor !== installedMinor) {
        console.warn('');
        console.warn('  ⚠️  [cuDNN-CUDA 버전 불일치]');
        console.warn(`     설치된 CUDA Toolkit : v${installedMinor}`);
        console.warn(`     cuDNN 호환 CUDA 버전 : v${cudnnMinor}`);
        console.warn(`     cuDNN이 CUDA ${cudnnMinor} 전용으로 설치되어 있어 빌드가 실패합니다.`);
        console.warn('');

        if (opts.ensureCudaDry || opts.ensureCuda) {
          if (!IS_WIN) {
            console.error('[ERROR] --ensure-cuda 는 Windows 에서만 지원됩니다.');
            console.error(`        Linux: sudo apt-get install cuda-toolkit-${cudnnMinor.replace('.', '-')}`);
            exitWithFlush(1);
            return;
          }

          const ensurePs1 = path.join(SCRIPT_DIR, 'ensure-cuda-toolkit.windows.ps1');
          const ensureArgs = ['-ExecutionPolicy', 'Bypass', '-File', ensurePs1, '-RequiredVersion', cudnnMinor];
          if (opts.insecureTls) ensureArgs.push('-AllowInsecureTls');

          if (opts.ensureCudaDry) {
            // URL 출력만
            ensureArgs.push('-ShowUrls');
            console.log(`  [--ensure-cuda:dry] CUDA ${cudnnMinor} 인스톨러 URL 확인 중...`);
            await runStreamed('powershell.exe', ensureArgs, {});
            exitWithFlush(0);
            return;
          }

          console.log(`  [--ensure-cuda] CUDA Toolkit ${cudnnMinor} 자동 설치 중...`);
          console.log('  (관리자 권한이 없으면 UAC 팝업이 표시될 수 있습니다.)');
          console.log('');

          // ensure 스크립트 실행 + 출력에서 CUDA_HOME 파싱
          let ensureOutput = '';
          const ensureResult = await new Promise((resolve) => {
            const { spawn } = require('child_process');
            const child = spawn('powershell.exe', ensureArgs, { stdio: ['inherit', 'pipe', 'pipe'] });
            const relay = (stream, isErr) => {
              let buf = '';
              stream.on('data', (chunk) => {
                buf += chunk.toString();
                const parts = buf.split('\n');
                buf = parts.pop();
                for (const line of parts) {
                  (isErr ? process.stderr : process.stdout).write(line + '\n');
                  _reportLine(line);
                  ensureOutput += line + '\n';
                }
              });
              stream.on('end', () => {
                if (buf) {
                  (isErr ? process.stderr : process.stdout).write(buf + '\n');
                  ensureOutput += buf + '\n';
                }
              });
            };
            relay(child.stdout, false);
            relay(child.stderr, true);
            child.on('close', (code) => resolve(code ?? 1));
            child.on('error', (err) => { process.stderr.write(`${err.message}\n`); resolve(1); });
          });

          if (ensureResult === 3 || ensureResult !== 0) {
            // 인스톨러 실패 — PS1 이 상세 안내를 이미 출력했으므로 짧게 마무리
            if (ensureResult !== 3) {
              console.error(`[ERROR] CUDA Toolkit ${cudnnMinor} 설치 실패 (종료 코드: ${ensureResult}).`);
            }
            console.error('');
            console.error('  설치 완료 후 새 PowerShell 창에서 다시 실행하세요:');
            console.error('    npm run build-ort:auto');
            exitWithFlush(1);
            return;
          }

          // ensure 스크립트 출력에서 "CUDA_HOME=<path>" 파싱
          const cudaHomeLine = ensureOutput.split('\n').find(l => l.trim().startsWith('CUDA_HOME='));
          if (cudaHomeLine) {
            effectiveCudaHome = cudaHomeLine.trim().replace(/^CUDA_HOME=/, '');
            console.log(`  ✅ 설치 완료 — CUDA_HOME=${effectiveCudaHome}`);
          } else {
            console.warn('  ⚠️  설치 후 CUDA_HOME 을 확인할 수 없습니다. 기존 감지 경로를 사용합니다.');
          }
          console.log('');

        } else {
          // --ensure-cuda 없음 → 오류 + 가이드 출력
          console.error(`[ERROR] CUDA Toolkit ${cudnnMinor} 이 필요하지만 설치되지 않았습니다.`);
          console.error('');
          console.error('  해결 방법 (하나 선택):');
          console.error('');
          console.error('  A) 자동 설치 (권장)');
          console.error(`     npm run build-ort:auto -- --ensure-cuda`);
          console.error(`     (또는 npm run ensure-cuda)`);
          console.error('');
          console.error('  B) URL 확인 후 수동 설치');
          console.error(`     npm run build-ort:auto -- --ensure-cuda:dry`);
          console.error('');
          console.error('  C) cuDNN을 현재 CUDA 버전에 맞게 재설치');
          console.error(`     https://developer.nvidia.com/cudnn 에서 CUDA ${installedMinor} 용 cuDNN 을 다운로드`);
          exitWithFlush(1);
          return;
        }
      } else {
        console.log(`  ✅ cuDNN-CUDA 호환  : cuDNN(CUDA ${cudnnMinor}) ↔ Toolkit(${installedMinor}) 일치`);
      }
    }
  }

  // ── 경로 유도 ─────────────────────────────────────────────────────────────
  const cudaHome  = effectiveCudaHome || deriveCudaHome(diag.cudaToolkit.path, diag.cudaToolkit.version);
  const cudnnHome = effectiveCudnnHome || diag.cudnn.cudnnHome || deriveCudnnHome(diag.cudnn.path || '');
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
