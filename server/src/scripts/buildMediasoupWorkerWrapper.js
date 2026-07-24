'use strict';

/**
 * mediasoup-worker-priority-wrapper 빌드 스크립트
 *
 * tools/mediasoup-worker-priority-wrapper/(wrapper.c + CMakeLists.txt)를
 * cmake로 구성·빌드·설치합니다. Linux 전용 — Windows/macOS에서는 아무것도
 * 빌드하지 않고 안내만 출력한 뒤 정상 종료합니다(Design_Mediasoup_Multi_Worker.md
 * §7 — Windows는 os.setPriority()가 특별한 권한 없이 이미 동작하고, macOS는
 * Linux capabilities에 대응하는 비root 메커니즘이 아예 없어 wrapper를 만들어도
 * 이득이 없음).
 *
 * 사용법:
 *   node server/src/scripts/buildMediasoupWorkerWrapper.js
 *   npm run build:mediasoup-wrapper        (server/ 또는 루트에서)
 *
 * 빌드 완료 후 mediasoupEngine.js가 `tools/mediasoup-worker-priority-wrapper/bin/
 * mediasoup-worker-wrapper` 존재 여부를 서버 부팅 시 자동 감지해 사용합니다 —
 * 이 스크립트를 실행한 뒤 서버(재)시작만 하면 되고, 별도 설정 변경은 불필요합니다.
 * 단, 실제로 우선순위가 적용되려면 아래 setcap 1회 실행이 추가로 필요합니다:
 *   sudo setcap cap_sys_nice+ep <wrapper 바이너리 경로>
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const IS_WIN     = process.platform === 'win32';
const IS_MAC     = process.platform === 'darwin';
const PROJECT_DIR = path.resolve(__dirname, '../../../tools/mediasoup-worker-priority-wrapper');
const BUILD_DIR    = path.join(PROJECT_DIR, 'build');
const BIN_DIR       = path.join(PROJECT_DIR, 'bin');
const WRAPPER_BIN   = path.join(BIN_DIR, IS_WIN ? 'mediasoup-worker-wrapper.exe' : 'mediasoup-worker-wrapper');

function log(msg) { console.log(`[build:mediasoup-wrapper] ${msg}`); }
function err(msg) { console.error(`[build:mediasoup-wrapper] ${msg}`); }

function commandExists(cmd) {
  const probe = IS_WIN ? spawnSync('where', [cmd]) : spawnSync('which', [cmd]);
  return probe.status === 0;
}

function run(cmd, args, cwd) {
  log(`${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with code ${result.status}`);
  }
}

function main() {
  if (IS_WIN) {
    log('Windows에서는 이 wrapper가 필요 없습니다 — Node의 os.setPriority()가');
    log('별도 권한 없이 자식 프로세스 우선순위를 올릴 수 있어(SetPriorityClass),');
    log('mediasoupEngine.js의 기존 parent-side 호출만으로 충분합니다. 빌드를 건너뜁니다.');
    return;
  }
  if (IS_MAC) {
    log('macOS에는 Linux capabilities(setcap)에 대응하는 비-root 메커니즘이 없어');
    log('이 wrapper를 만들어도 이득이 없습니다(어차피 root 필요). 빌드를 건너뜁니다.');
    log('우선순위 없이도 서버는 정상 동작합니다 — mediasoup-worker가 기본 우선순위로 실행됩니다.');
    return;
  }

  if (!commandExists('cmake')) {
    err('cmake를 찾을 수 없습니다. 설치 후 다시 실행하세요:');
    err('  Ubuntu/Debian: sudo apt-get install -y cmake build-essential');
    err('  또는 https://cmake.org/download/ 에서 직접 설치');
    process.exit(1);
  }
  if (!commandExists('cc') && !commandExists('gcc') && !commandExists('clang')) {
    err('C 컴파일러(gcc/clang)를 찾을 수 없습니다. 설치 후 다시 실행하세요:');
    err('  Ubuntu/Debian: sudo apt-get install -y build-essential');
    process.exit(1);
  }

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  run('cmake', ['-S', PROJECT_DIR, '-B', BUILD_DIR, '-DCMAKE_BUILD_TYPE=Release']);
  run('cmake', ['--build', BUILD_DIR]);
  run('cmake', ['--install', BUILD_DIR]);

  if (!fs.existsSync(WRAPPER_BIN)) {
    err(`빌드는 성공했지만 예상 경로에 바이너리가 없습니다: ${WRAPPER_BIN}`);
    process.exit(1);
  }

  log(`빌드 완료: ${WRAPPER_BIN}`);
  log('');
  log('다음 1회 명령으로 우선순위 상승 권한을 부여하세요(재부팅 후에도 유지됨):');
  log(`  sudo setcap cap_sys_nice+ep ${WRAPPER_BIN}`);
  log('');
  log('이후 서버를 재시작하면 mediasoupEngine.js가 이 wrapper를 자동으로 사용합니다.');
}

main();
