'use strict';

const os = require('os');

let _cudaDisabledForRuntime = false;
let _cudaDisableReasonLogged = false;

function _isTrue(v) {
  return v === '1' || v === 'true';
}

function _disableCudaForRuntime(reason) {
  _cudaDisabledForRuntime = true;
  if (_cudaDisableReasonLogged) return;
  _cudaDisableReasonLogged = true;
  console.warn(
    '[onnxOptions] CUDA execution provider is unavailable in this runtime. ' +
    `Falling back to CPU for all ONNX sessions. reason="${reason}"`
  );
  console.warn(
    '[onnxOptions] To enable CUDA: install a CUDA-enabled onnxruntime-node build and verify NVIDIA driver/CUDA/cuDNN compatibility. ' +
    'Set ONNX_CUDA=0 to silence this warning when using CPU-only inference.'
  );
}

/**
 * Returns ONNX InferenceSession options tuned to the runtime environment.
 *
 * Priority: CUDA mode > development mode > production (default)
 *
 * Thread count is resolved in this order:
 *   1. Explicit .env variable for the active mode (ONNX_THREADS_CUDA / _DEV / _PROD)
 *   2. If value is 0 or missing → auto-select:
 *        CUDA / dev  → 1
 *        production  → max(2, min(8, floor(CPU_cores / 2)))
 *
 * .env variables:
 *   NODE_ENV=development     dev mode  (set by nodemon.json automatically)
 *   ONNX_CUDA=1              enable CUDA provider (requires CUDA-enabled onnxruntime-node)
 *   ONNX_THREADS_DEV=1       intra-op threads when NODE_ENV=development  (0 = auto → 1)
 *   ONNX_THREADS_CUDA=1      intra-op threads when ONNX_CUDA=1           (0 = auto → 1)
 *   ONNX_THREADS_PROD=0      intra-op threads in production mode          (0 = auto → CPU/2)
 */
function getOnnxSessionOptions() {
  const isDev   = process.env.NODE_ENV === 'development';
  const useCudaRequested = _isTrue(process.env.ONNX_CUDA);
  const useCuda = useCudaRequested && !_cudaDisabledForRuntime;

  const numCores    = os.cpus().length;
  const autoThreads = Math.max(2, Math.min(8, Math.floor(numCores / 2)));

  let threads;
  if (useCuda) {
    const t = parseInt(process.env.ONNX_THREADS_CUDA, 10);
    threads = (t > 0) ? t : 1;
  } else if (isDev) {
    const t = parseInt(process.env.ONNX_THREADS_DEV, 10);
    threads = (t > 0) ? t : 1;
  } else {
    const t = parseInt(process.env.ONNX_THREADS_PROD, 10);
    threads = (t > 0) ? t : autoThreads;
  }

  const providers = useCuda ? ['cuda', 'cpu'] : ['cpu'];
  const modeTag   = useCuda
    ? 'cuda'
    : (useCudaRequested && _cudaDisabledForRuntime ? 'cpu(cuda-disabled)' : (isDev ? 'dev' : 'prod'));

  console.log(
    `[onnxOptions] mode=${modeTag}  threads=${threads}  cores=${numCores}  providers=${JSON.stringify(providers)}`
  );

  return {
    executionProviders:     providers,
    graphOptimizationLevel: 'all',
    intraOpNumThreads:      threads,
    interOpNumThreads:      1,
  };
}

/**
 * Create ONNX Runtime session with optional CUDA->CPU fallback.
 *
 * Behavior:
 * - ONNX_CUDA=1 + CUDA build available: uses ['cuda','cpu']
 * - ONNX_CUDA=1 + CUDA unavailable: retries with ['cpu'] unless strict mode
 * - strict mode: ONNX_CUDA_STRICT=1 (or true)
 *
 * @param {object} ort onnxruntime-node module
 * @param {string} modelPath
 * @param {string} logTag
 * @returns {Promise<any>} InferenceSession
 */
async function createOnnxSession(ort, modelPath, logTag = 'ONNX') {
  const preferred = getOnnxSessionOptions();
  const providers = preferred.executionProviders || ['cpu'];
  const wantsCuda = providers.includes('cuda');
  const strictCuda = _isTrue(process.env.ONNX_CUDA_STRICT);

  try {
    const session = await ort.InferenceSession.create(modelPath, preferred);

    // Some ORT builds silently drop unavailable providers (e.g. cuda -> cpu)
    // without throwing. If that happens once, stop requesting CUDA repeatedly.
    if (wantsCuda && !_cudaDisabledForRuntime) {
      const active = Array.isArray(session?.executionProviders)
        ? session.executionProviders.map((p) => String(p).toLowerCase())
        : null;
      if (active && !active.includes('cuda')) {
        _disableCudaForRuntime(`requested=[${providers.join(',')}] active=[${active.join(',')}]`);
      }
    }

    return session;
  } catch (err) {
    const msg = String(err?.message || err || 'unknown');
    const looksLikeCudaUnavailable = /backend not found|not available|cuda|execution provider/i.test(msg);

    if (wantsCuda && looksLikeCudaUnavailable) {
      _disableCudaForRuntime(msg);
    }

    if (!wantsCuda || strictCuda) throw err;

    const cpuOnly = {
      ...preferred,
      executionProviders: ['cpu'],
    };

    console.warn(
      `[${logTag}] CUDA session create failed (${msg}). ` +
      'Retrying with CPU provider.'
    );

    const session = await ort.InferenceSession.create(modelPath, cpuOnly);
    console.warn(`[${logTag}] Running with CPU fallback provider.`);
    return session;
  }
}

module.exports = { getOnnxSessionOptions, createOnnxSession };
