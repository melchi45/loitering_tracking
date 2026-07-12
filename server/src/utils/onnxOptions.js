'use strict';

const os = require('os');

let _cudaDisabledForRuntime = false;
let _cudaDisableReasonLogged = false;
let _dmlDisabledForRuntime = false;
let _dmlDisableReasonLogged = false;

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

function _disableDmlForRuntime(reason) {
  _dmlDisabledForRuntime = true;
  if (_dmlDisableReasonLogged) return;
  _dmlDisableReasonLogged = true;
  console.warn(
    '[onnxOptions] DirectML execution provider is unavailable in this runtime. ' +
    `Falling back to CPU for all ONNX sessions. reason="${reason}"`
  );
  console.warn(
    '[onnxOptions] To enable DirectML on Windows: keep a DirectX 12 capable GPU/driver and use a DML-capable onnxruntime-node build. '
  );
}

/**
 * Startup-time provider diagnostics.
 * - Prints supported backends once.
 * - Pre-disables unavailable CUDA/DML providers before model sessions are created.
 */
function runOnnxStartupDiagnostics(ort) {
  const isWindows = process.platform === 'win32';
  const useCudaRequested = _isTrue(process.env.ONNX_CUDA);

  let backends = [];
  try {
    backends = typeof ort?.listSupportedBackends === 'function'
      ? ort.listSupportedBackends()
      : [];
  } catch (err) {
    console.warn(`[onnxOptions][startup-check] Failed to enumerate supported backends: ${String(err?.message || err)}`);
  }

  const backendNames = backends
    .map((b) => String(b?.name || '').toLowerCase())
    .filter(Boolean);

  console.log(`[onnxOptions][startup-check] supportedBackends=${JSON.stringify(backends)}`);

  if (useCudaRequested && !backendNames.includes('cuda')) {
    _disableCudaForRuntime(`startup-check: cuda not in supported backends [${backendNames.join(',')}]`);
  } else if (useCudaRequested) {
    console.log('[onnxOptions][startup-check] CUDA backend is available.');
  }

  if (!useCudaRequested && isWindows) {
    if (!backendNames.includes('dml')) {
      _disableDmlForRuntime(`startup-check: dml not in supported backends [${backendNames.join(',')}]`);
    } else {
      console.log('[onnxOptions][startup-check] DirectML backend is available and will be preferred on Windows.');
    }
  }
}

/**
 * Returns ONNX InferenceSession options tuned to the runtime environment.
 *
 * Priority: CUDA mode > Windows DML auto mode > development mode > production (default)
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
  const isWindows = process.platform === 'win32';
  const isDev   = process.env.NODE_ENV === 'development';
  const useCudaRequested = _isTrue(process.env.ONNX_CUDA);
  const useCuda = useCudaRequested && !_cudaDisabledForRuntime;
  const useDml = !useCuda && isWindows && !_dmlDisabledForRuntime;

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

  const providers = useCuda ? ['cuda', 'cpu'] : (useDml ? ['dml', 'cpu'] : ['cpu']);
  const modeTag   = useCuda
    ? 'cuda'
    : (useDml
      ? 'dml'
      : (useCudaRequested && _cudaDisabledForRuntime
        ? 'cpu(cuda-disabled)'
        : (isDev ? 'dev' : 'prod')));

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
 * Create ONNX Runtime session with provider fallback.
 *
 * Behavior:
 * - ONNX_CUDA=1 + CUDA build available: uses ['cuda','cpu']
 * - Windows default (when CUDA is not requested): uses ['dml','cpu']
 * - CUDA/DML unavailable: retries with ['cpu'] unless strict CUDA mode
 * - strict mode: ONNX_CUDA_STRICT=1 (or true)
 *
 * @param {object} ort onnxruntime-node module
 * @param {string} modelPath
 * @param {string} logTag
 * @param {{forceCpu?: boolean}} [opts] forceCpu: skip CUDA/DML entirely for this
 *   session (e.g. a model too heavy for the DML execution provider to run
 *   reliably — observed DXGI_ERROR_DEVICE_REMOVED / GPU device removed on
 *   inference, not session creation, so the normal create()-time fallback
 *   below never triggers for it).
 * @returns {Promise<any>} InferenceSession
 */
async function createOnnxSession(ort, modelPath, logTag = 'ONNX', opts = {}) {
  if (opts.forceCpu) {
    console.log(`[${logTag}] forceCpu requested — using CPU execution provider.`);
    return ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
  }

  const preferred = getOnnxSessionOptions();
  const providers = preferred.executionProviders || ['cpu'];
  const wantsCuda = providers.includes('cuda');
  const wantsDml = providers.includes('dml');
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

    if (wantsDml && !_dmlDisabledForRuntime) {
      const active = Array.isArray(session?.executionProviders)
        ? session.executionProviders.map((p) => String(p).toLowerCase())
        : null;
      if (active && !active.includes('dml')) {
        _disableDmlForRuntime(`requested=[${providers.join(',')}] active=[${active.join(',')}]`);
      }
    }

    return session;
  } catch (err) {
    const msg = String(err?.message || err || 'unknown');
    const looksLikeCudaUnavailable = /backend not found|not available|cuda|execution provider/i.test(msg);
    const looksLikeDmlUnavailable = /backend not found|not available|dml|directml|execution provider/i.test(msg);

    if (wantsCuda && looksLikeCudaUnavailable) {
      _disableCudaForRuntime(msg);
    }

    if (wantsDml && looksLikeDmlUnavailable) {
      _disableDmlForRuntime(msg);
    }

    if (strictCuda && wantsCuda) throw err;

    const cpuOnly = {
      ...preferred,
      executionProviders: ['cpu'],
    };

    console.warn(
      `[${logTag}] ${wantsCuda ? 'CUDA' : (wantsDml ? 'DirectML' : 'Preferred provider')} session create failed (${msg}). ` +
      'Retrying with CPU provider.'
    );

    const session = await ort.InferenceSession.create(modelPath, cpuOnly);
    console.warn(`[${logTag}] Running with CPU fallback provider.`);
    return session;
  }
}

module.exports = { getOnnxSessionOptions, createOnnxSession, runOnnxStartupDiagnostics };
