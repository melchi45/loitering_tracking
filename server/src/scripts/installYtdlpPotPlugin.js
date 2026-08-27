'use strict';

/**
 * yt-dlp PO Token(Proof-of-Origin) 플러그인 설치 스크립트
 *
 * bgutil-ytdlp-pot-provider PyPI 패키지를 설치한다 — yt-dlp가 엔트리포인트로
 * 자동 인식하는 플러그인이며, YTDLP_POT_PROVIDER_ENABLED=true일 때만 실제로
 * 쓰인다(opt-in). 사이드카(brainicism/bgutil-ytdlp-pot-provider Docker 이미지,
 * 포트 4416)는 이 스크립트가 아니라 `docker compose up -d bgutil-pot-provider`
 * 로 별도 기동해야 한다.
 *
 * 사용법:
 *   node server/src/scripts/installYtdlpPotPlugin.js
 *   npm run install-pot-plugin          (server/ 또는 루트 workspace)
 *
 * 참고: docs/design/Design_YouTube_RTSP_Ingest.md §12.6, SRS FR-YT-016
 */

const { execFileSync } = require('child_process');

const ICONS = { ok: '✅', warn: '⚠️ ', fail: '❌' };

function findPython() {
  const candidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python'];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe' });
      return bin;
    } catch { /* try next */ }
  }
  return null;
}

function hasYtDlp() {
  try {
    execFileSync('yt-dlp', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function pluginInstalled(python) {
  // The package has no top-level importable module — it only ships yt-dlp
  // plugin files under yt_dlp_plugins/extractor/getpot_bgutil*.py, which
  // yt-dlp discovers via its own plugin namespace scan, not a normal import.
  // Checking pip's own metadata is what actually reflects installation state.
  try {
    execFileSync(python, ['-c', "import importlib.metadata; importlib.metadata.version('bgutil-ytdlp-pot-provider')"], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  console.log('');
  console.log('── yt-dlp PO Token 플러그인 설치 (bgutil-ytdlp-pot-provider) ──');
  console.log('');

  if (!hasYtDlp()) {
    console.log(`${ICONS.warn} yt-dlp가 PATH에서 감지되지 않았습니다 — 플러그인은 계속 설치하지만,`);
    console.log('  YouTube 수집 자체에는 yt-dlp가 별도로 필요합니다 (npm run setup-env:linux 참고).');
  }

  const python = findPython();
  if (!python) {
    console.error(`${ICONS.fail} Python이 PATH에서 감지되지 않았습니다 — 설치를 건너뜁니다.`);
    console.error('  Python 3.8+ 설치 후 다시 실행하세요.');
    process.exit(1);
  }

  try {
    execFileSync(python, ['-m', 'pip', 'install', '-q', '--upgrade', 'bgutil-ytdlp-pot-provider'], { stdio: 'inherit' });
  } catch (err) {
    console.error(`${ICONS.fail} pip install 실패: ${err.message}`);
    process.exit(1);
  }

  if (pluginInstalled(python)) {
    console.log(`${ICONS.ok} yt-dlp PO Token 플러그인 설치 완료 (pip: bgutil-ytdlp-pot-provider)`);
    console.log('');
    console.log('  다음 단계 (opt-in 기능 활성화 시):');
    console.log('    1) docker compose up -d bgutil-pot-provider   (사이드카 기동, 포트 4416)');
    console.log('    2) server/.env: YTDLP_POT_PROVIDER_ENABLED=true');
    console.log('');
    process.exit(0);
  } else {
    console.error(`${ICONS.fail} 설치 후 import 검증 실패 — 수동 설치를 시도하세요:`);
    console.error('  pip install bgutil-ytdlp-pot-provider');
    process.exit(1);
  }
}

main();
