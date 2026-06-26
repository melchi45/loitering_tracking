'use strict';

/**
 * GPU / ONNX Provider 가용성 진단 스크립트
 *
 * 사용법:
 *   node server/src/scripts/checkGpuProviders.js
 *   npm run check:gpu          (server/ 디렉토리에서)
 *
 * 출력:
 *   - NVIDIA GPU 감지 여부 + 드라이버 버전
 *   - CUDA Toolkit 버전 (nvcc)
 *   - cuDNN 라이브러리 감지 여부
 *   - onnxruntime-node 의 CUDA / DML provider 포함 여부
 *   - 현재 권장 provider (cuda | dml | cpu)
 *   - 누락 항목별 설치 안내
 *   - 배치 추론 설정 현황 (BATCH_MAX_SIZE, BATCH_MAX_WAIT_MS)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { getProviderDiagnostics, getInstallGuide } = require('../utils/providerDiagnostics');

const ICONS = { ok: '✅', warn: '⚠️ ', fail: '❌' };

function icon(ok) { return ok ? ICONS.ok : ICONS.fail; }

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  LTS-2026  GPU / ONNX Provider 가용성 진단');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  const diag = await getProviderDiagnostics();

  // ── Platform ──────────────────────────────────────────────────────────────
  console.log(`플랫폼:   ${diag.platform} / ${diag.arch}  Node ${diag.nodeVersion}`);
  console.log('');

  // ── GPU ───────────────────────────────────────────────────────────────────
  if (diag.gpu.available) {
    for (const g of diag.gpu.gpus) {
      console.log(`${ICONS.ok} NVIDIA GPU:       ${g.name}  (Driver ${g.driver}, VRAM ${g.memory})`);
    }
  } else {
    console.log(`${ICONS.fail} NVIDIA GPU:       ${diag.gpu.reason}`);
  }

  // ── CUDA Toolkit ──────────────────────────────────────────────────────────
  if (diag.cudaToolkit.available) {
    console.log(`${ICONS.ok} CUDA Toolkit:     v${diag.cudaToolkit.version}`);
  } else {
    console.log(`${ICONS.fail} CUDA Toolkit:     ${diag.cudaToolkit.reason}`);
  }

  // ── cuDNN ─────────────────────────────────────────────────────────────────
  if (diag.cudnn.available) {
    const ver = diag.cudnn.version ? `cuDNN ${diag.cudnn.version}  ` : '';
    console.log(`${ICONS.ok} cuDNN:            ${ver}→ ${diag.cudnn.path}`);
  } else {
    console.log(`${ICONS.fail} cuDNN:            ${diag.cudnn.reason}`);
  }

  // ── ORT CUDA ──────────────────────────────────────────────────────────────
  if (diag.ort.cuda.available) {
    console.log(`${ICONS.ok} ORT CUDA:         사용 가능`);
  } else {
    console.log(`${ICONS.fail} ORT CUDA:         ${diag.ort.cuda.reason}`);
  }

  // ── ORT DML ───────────────────────────────────────────────────────────────
  if (diag.ort.dml.available) {
    console.log(`${ICONS.ok} ORT DirectML:     사용 가능 (Windows)`);
  } else if (diag.platform === 'win32') {
    console.log(`${ICONS.warn} ORT DirectML:    ${diag.ort.dml.reason}`);
  } else {
    console.log(`   ORT DirectML:     해당 없음 (Linux/Mac)`);
  }

  // ── CPU ───────────────────────────────────────────────────────────────────
  console.log(`${ICONS.ok} CPU:              항상 사용 가능`);

  // ── Recommended ───────────────────────────────────────────────────────────
  console.log('');
  console.log(`─────────────────────────────────────────────────────`);
  console.log(`  권장 실행 provider: ${diag.recommended.toUpperCase()}`);
  console.log(`─────────────────────────────────────────────────────`);

  // ── Batch Inference ───────────────────────────────────────────────────────
  console.log('');
  console.log(`배치 추론 설정:`);
  console.log(`  ${diag.batchInference.note}`);
  console.log(`  BATCH_MAX_SIZE    = ${diag.activeEnv.BATCH_MAX_SIZE}`);
  console.log(`  BATCH_MAX_WAIT_MS = ${diag.activeEnv.BATCH_MAX_WAIT_MS}`);

  // ── .env advice ───────────────────────────────────────────────────────────
  console.log('');
  console.log('server/.env 권장 설정:');
  if (diag.recommended === 'cuda') {
    console.log('  ONNX_CUDA=1');
    console.log('  BATCH_MAX_SIZE=4      # 동시 카메라 수에 맞게 조정');
    console.log('  BATCH_MAX_WAIT_MS=33  # 30fps 기준 1-frame 대기');
  } else if (diag.recommended === 'dml') {
    console.log('  # Windows DML 자동 선택 — 추가 설정 불필요');
    console.log('  BATCH_MAX_SIZE=2      # DML은 Command Queue 단일, 소규모 배치 권장');
    console.log('  BATCH_MAX_WAIT_MS=50');
  } else {
    console.log('  # CPU 모드 — 배치 비활성 권장 (메모리 압박)');
    console.log('  BATCH_MAX_SIZE=1');
  }

  // ── Install guide ─────────────────────────────────────────────────────────
  const guide = getInstallGuide(diag);
  if (!guide.includes('✅ 모든 설정 정상')) {
    console.log('');
    console.log('══════ 설치 안내 ══════════════════════════════════════');
    console.log(guide);
  }

  // ── DML GPU monitoring note ───────────────────────────────────────────────
  if (diag.recommended === 'dml') {
    console.log('');
    console.log(`${ICONS.warn} DML GPU 모니터링 주의:`);
    console.log('  nvidia-smi 의 CUDA Compute % 는 DML 사용량을 반영하지 않습니다.');
    console.log('  Windows 작업관리자 → 성능 → GPU → "3D" 또는 "Compute_0" 컬럼으로 확인하세요.');
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  process.exit(0);
}

main().catch(err => {
  console.error('[checkGpuProviders] 진단 중 오류:', err.message);
  process.exit(1);
});
