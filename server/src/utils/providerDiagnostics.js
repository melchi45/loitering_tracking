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
  if (!out) {
    // Try cuda-specific path on Linux
    const altOut = IS_LINUX ? _run('/usr/local/cuda/bin/nvcc --version') : null;
    if (!altOut) {
      return {
        available: false,
        reason: 'nvcc 미감지 — CUDA Toolkit이 설치되지 않았거나 PATH에 없음',
        installCmds: IS_LINUX
          ? [
              '# Ubuntu/Debian (CUDA 12.x 예시):',
              'wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-ubuntu2204.pin',
              'sudo mv cuda-ubuntu2204.pin /etc/apt/preferences.d/cuda-repository-pin-600',
              'sudo apt-key adv --fetch-keys https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/3bf863cc.pub',
              'sudo add-apt-repository "deb https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/ /"',
              'sudo apt-get update && sudo apt-get -y install cuda-12-1',
              '# PATH 추가 (~/.bashrc):',
              'export PATH=/usr/local/cuda/bin:$PATH',
              'export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH',
            ]
          : ['https://developer.nvidia.com/cuda-downloads 에서 설치 파일 다운로드'],
      };
    }
    const m = altOut.match(/release (\d+\.\d+)/);
    return { available: true, version: m?.[1] ?? 'unknown', path: '/usr/local/cuda/bin/nvcc' };
  }
  const match = out.match(/release (\d+\.\d+)/);
  return { available: true, version: match?.[1] ?? 'unknown' };
}

// ── cuDNN ─────────────────────────────────────────────────────────────────────

async function detectCuDNN() {
  if (IS_LINUX) {
    const searchPaths = [
      '/usr/lib/x86_64-linux-gnu/libcudnn.so.8',
      '/usr/lib/x86_64-linux-gnu/libcudnn.so',
      '/usr/local/cuda/lib64/libcudnn.so.8',
      '/usr/local/cuda/lib64/libcudnn.so',
      '/usr/lib/libcudnn.so',
    ];
    for (const p of searchPaths) {
      if (fs.existsSync(p)) return { available: true, path: p };
    }
    const ldout = _run('ldconfig -p 2>/dev/null | grep libcudnn');
    if (ldout) {
      const p = ldout.split('=>').pop()?.trim();
      return { available: true, path: p || 'ldconfig entry' };
    }
    return {
      available: false,
      reason: 'libcudnn.so 미감지',
      installCmds: [
        '# Ubuntu/Debian cuDNN 설치:',
        'sudo apt-get install -y libcudnn8 libcudnn8-dev',
        '# 또는 https://developer.nvidia.com/cudnn 에서 수동 설치',
      ],
    };
  }

  if (IS_WIN) {
    const searchPaths = [
      'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.1\\bin\\cudnn64_8.dll',
      'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v11.8\\bin\\cudnn64_8.dll',
      'C:\\Windows\\System32\\cudnn64_8.dll',
    ];
    for (const p of searchPaths) {
      if (fs.existsSync(p)) return { available: true, path: p };
    }
    return {
      available: false,
      reason: 'cudnn64_*.dll 미감지',
      installCmds: ['https://developer.nvidia.com/cudnn 에서 설치 파일 다운로드 후 CUDA 설치 경로에 배치'],
    };
  }

  return { available: false, reason: `cuDNN 감지 미지원 플랫폼: ${process.platform}` };
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
        '# CUDA 지원 ORT 설치 방법 1 — onnxruntime-gpu (ORT v1.x):',
        'npm uninstall onnxruntime-node',
        'npm install onnxruntime-gpu',
        '',
        '# CUDA 지원 ORT 설치 방법 2 — 공식 napi 바이너리 교체:',
        '# https://github.com/microsoft/onnxruntime/releases 에서 Node.js GPU 바이너리 다운로드',
        '',
        '# .env에 CUDA 활성화 추가:',
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
