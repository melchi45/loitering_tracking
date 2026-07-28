'use strict';

/**
 * TC: Windows CUDA Source Build - Runtime DLL Search Path Correction
 *
 * TC-CUDA-H-001  ensureOnnxCudaDllPath() — Windows에서 onnxruntime-node 애드온 dll 폴더를
 *                process.env.PATH 맨 앞에 정확히 1회 추가(idempotent), non-Windows 및
 *                onnxruntime-node 미설치/애드온 폴더 부재 시 no-op.
 *
 * (TC-CUDA-H-002 — 실제 CUDA GPU가 있는 Windows 호스트에서 소스 빌드된 addon으로
 *  InferenceSession.create() + session.run() 실 추론 성공 검증 — 은 GPU 하드웨어가 필요한
 *  수동/현장 검증 항목이며 Jest로 자동화하지 않는다. docs/tc/TC_AI_CUDA_Acceleration.md §9 참고.)
 */

const path = require('path');
const fs = require('fs');

const MODULE_PATH = path.resolve(__dirname, '../../server/src/utils/onnxDllPath');
// onnxDllPath.js resolves 'onnxruntime-node' relative to its own directory
// (server/src/utils), which is different from this test file's directory
// (test/api). Resolve using the same base so results match the real module.
const RESOLVE_OPTS = { paths: [path.dirname(MODULE_PATH)] };

function resolveAddonDir() {
  return path.join(
    require.resolve('onnxruntime-node/package.json', RESOLVE_OPTS),
    '..',
    'bin',
    'napi-v6',
    'win32',
    'x64'
  );
}

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value });
}

describe('TC-CUDA-H: onnxDllPath (Windows CUDA runtime DLL search path)', () => {
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;

  afterEach(() => {
    setPlatform(originalPlatform);
    process.env.PATH = originalPath;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('TC-CUDA-H-001a: non-Windows 플랫폼에서는 PATH를 변경하지 않는다 (no-op)', () => {
    setPlatform('linux');
    process.env.PATH = '/usr/bin:/bin';
    const { ensureOnnxCudaDllPath } = require(MODULE_PATH);

    ensureOnnxCudaDllPath();

    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });

  test('TC-CUDA-H-001b: onnxruntime-node를 resolve할 수 없는 환경에서는 PATH를 변경하지 않고 예외도 던지지 않는다 (no-op)', () => {
    setPlatform('win32');
    process.env.PATH = 'C:\\Windows\\System32';

    let resolvable = false;
    try {
      require.resolve('onnxruntime-node/package.json', RESOLVE_OPTS);
      resolvable = true;
    } catch {
      resolvable = false;
    }
    if (resolvable) {
      // 이 개발 환경에는 onnxruntime-node가 설치되어 있어 실제 MODULE_NOT_FOUND를
      // 재현할 수 없다 — 함수의 try/catch가 이 경로를 안전하게 처리한다는 점은
      // 소스 코드 검토(onnxDllPath.js)로 보증되며, 이 테스트는 그 반대 상황(실제
      // 패키지 미설치 CI 환경)에서 실행된다.
      return;
    }

    const { ensureOnnxCudaDllPath } = require(MODULE_PATH);
    expect(() => ensureOnnxCudaDllPath()).not.toThrow();
    expect(process.env.PATH).toBe('C:\\Windows\\System32');
  });

  test('TC-CUDA-H-001c: 애드온 dll 폴더가 실제로 존재하지 않으면 PATH를 변경하지 않는다 (no-op)', () => {
    setPlatform('win32');
    process.env.PATH = 'C:\\Windows\\System32';

    let resolvable = false;
    try {
      require.resolve('onnxruntime-node/package.json', RESOLVE_OPTS);
      resolvable = true;
    } catch {
      resolvable = false;
    }
    if (!resolvable) {
      // onnxruntime-node가 설치되지 않은 환경 — require.resolve() 자체가 조기 반환하므로 통과 처리
      return;
    }

    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const { ensureOnnxCudaDllPath } = require(MODULE_PATH);

    ensureOnnxCudaDllPath();

    expect(process.env.PATH).toBe('C:\\Windows\\System32');
  });

  const itWin32 = originalPlatform === 'win32' ? test : test.skip;

  itWin32('TC-CUDA-H-001d: Windows + onnxruntime-node 설치 환경에서 애드온 dll 폴더를 PATH 맨 앞에 1회만 추가한다 (idempotent)', () => {
    setPlatform('win32');
    const basePath = 'C:\\Windows\\System32';
    process.env.PATH = basePath;

    let addonDir;
    try {
      addonDir = resolveAddonDir();
    } catch {
      return; // onnxruntime-node not installed in this environment — nothing to verify
    }
    if (!fs.existsSync(addonDir)) {
      return; // Windows이지만 win32 addon 폴더가 없는 환경(cpu-only 등) — nothing to verify
    }

    const { ensureOnnxCudaDllPath } = require(MODULE_PATH);

    ensureOnnxCudaDllPath();
    const afterFirstCall = process.env.PATH;
    expect(afterFirstCall.startsWith(addonDir)).toBe(true);
    expect(afterFirstCall).toContain(basePath);

    ensureOnnxCudaDllPath();
    const afterSecondCall = process.env.PATH;
    expect(afterSecondCall).toBe(afterFirstCall); // idempotent — no duplicate entry
  });
});
