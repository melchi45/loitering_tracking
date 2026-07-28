'use strict';

/**
 * Windows: onnxruntime_providers_cuda.dll dynamically LoadLibrary()'s its CUDA/cuDNN
 * runtime dependencies (e.g. cudnn64_9.dll, cudnn_ops64_9.dll, cublas64_12.dll, ...) by
 * filename only. The default Win32 DLL search order for that kind of load starts with the
 * directory of the process executable (node.exe) and PATH — NOT the folder that contains
 * onnxruntime-node's own native addon (server/node_modules/onnxruntime-node/bin/napi-v6/win32/x64),
 * even though we copy all required CUDA/cuDNN dlls there during the CUDA source build
 * (see server/src/scripts/build-onnxruntime-source.windows.ps1, stage [3c/4]).
 *
 * Without this, ONNX_CUDA=1 sessions fail at InferenceSession.create() time with
 * "Invalid handle. Cannot load symbol cudnnCreate" even though every required .dll is
 * physically present right next to onnxruntime_binding.node.
 *
 * Call this once, as early as possible at process startup (before any ONNX session is
 * created), to add that folder to the DLL search path via PATH.
 */
function ensureOnnxCudaDllPath() {
  if (process.platform !== 'win32') return;

  let addonDir;
  try {
    addonDir = require('path').join(
      require.resolve('onnxruntime-node/package.json'),
      '..',
      'bin',
      'napi-v6',
      'win32',
      'x64'
    );
  } catch {
    return; // onnxruntime-node not installed — nothing to do.
  }

  const fs = require('fs');
  if (!fs.existsSync(addonDir)) return;

  const path = require('path');
  const sep = path.delimiter;
  const current = process.env.PATH || process.env.Path || '';
  const entries = current.split(sep).filter(Boolean);
  if (entries.some((e) => path.resolve(e) === path.resolve(addonDir))) return; // already present

  process.env.PATH = `${addonDir}${sep}${current}`;
}

module.exports = { ensureOnnxCudaDllPath };
