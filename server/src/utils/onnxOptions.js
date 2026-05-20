'use strict';

const os = require('os');

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
  const useCuda = process.env.ONNX_CUDA === '1' || process.env.ONNX_CUDA === 'true';

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
  const modeTag   = useCuda ? 'cuda' : (isDev ? 'dev' : 'prod');

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

module.exports = { getOnnxSessionOptions };
