'use strict';

/**
 * ensureMongodb.js
 *
 * DB_TYPE=mongodb 일 때 서버 시작 전에 로컬 MongoDB 상태를 확인하고,
 * 중지된 경우 자동으로 재시작을 시도합니다.
 * MongoDB가 설치되지 않은 경우 설치 가이드를 출력합니다.
 *
 * - 원격 URI(Atlas, SRV, 외부 IP): TCP 확인을 건너뜁니다 — MongoDatabase.init()이 처리합니다.
 * - 로컬 MongoDB 재시작 실패 시 서버는 process.exit(1)로 즉시 종료됩니다.
 *   DB_TYPE=mongodb에서 lts.json fallback은 허용되지 않습니다.
 */

const net             = require('net');
const { execFile }    = require('child_process');
const { promisify }   = require('util');
const { execFileSync } = require('child_process');

const execFileAsync = promisify(execFile);

// ── URI 파싱 ──────────────────────────────────────────────────────────────────

/**
 * MongoDB URI에서 host/port를 추출합니다.
 * mongodb+srv:// (Atlas SRV) → null 반환 (원격으로 간주).
 */
function parseMongoHost(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol === 'mongodb+srv:') return null;
    const host = url.hostname || 'localhost';
    const port = parseInt(url.port || '27017', 10);
    return { host, port };
  } catch {
    return { host: 'localhost', port: 27017 };
  }
}

function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// ── TCP 연결 확인 ──────────────────────────────────────────────────────────────

async function tcpConnect(host, port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error',   () => resolve(false));
    sock.connect(port, host);
  });
}

// ── mongod 바이너리 확인 ──────────────────────────────────────────────────────

function mongodInstalledPath() {
  const candidates = [
    '/usr/bin/mongod',
    '/usr/local/bin/mongod',
    '/opt/homebrew/bin/mongod',
    'mongod',
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 2000 });
      return bin;
    } catch { /* not found at this path */ }
  }
  return null;
}

// ── 설치 가이드 출력 ──────────────────────────────────────────────────────────

function printInstallGuide(platform) {
  const line = '━'.repeat(60);
  console.error('');
  console.error(line);
  console.error('  [MongoDB] MongoDB가 설치되어 있지 않습니다.');
  console.error('');

  if (platform === 'linux') {
    // Detect distro
    let distro = 'ubuntu22';
    try {
      const release = execFileSync('lsb_release', ['-cs'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (release === 'bionic') distro = 'ubuntu18';
      else if (release === 'focal') distro = 'ubuntu20';
      else if (release === 'jammy') distro = 'ubuntu22';
      else if (release === 'noble') distro = 'ubuntu24';
    } catch { /* lsb_release not available */ }

    const repoLine = distro === 'ubuntu18'
      ? 'echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu bionic/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list'
      : distro === 'ubuntu20'
        ? 'echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list'
        : distro === 'ubuntu24'
          ? 'echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list'
          : 'echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list';

    console.error('  [Ubuntu/Debian] 설치 방법:');
    console.error('');
    console.error('    # 1. GPG 키 등록');
    console.error('    curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \\');
    console.error('      | sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor');
    console.error('');
    console.error('    # 2. 저장소 등록');
    console.error(`    ${repoLine}`);
    console.error('');
    console.error('    # 3. 설치');
    console.error('    sudo apt-get update && sudo apt-get install -y mongodb-org');
    console.error('');
    console.error('    # 4. 서비스 시작 및 부팅 자동 시작 등록');
    console.error('    sudo systemctl enable --now mongod');
  } else if (platform === 'darwin') {
    console.error('  [macOS] 설치 방법 (Homebrew):');
    console.error('');
    console.error('    brew tap mongodb/brew');
    console.error('    brew install mongodb-community');
    console.error('    brew services start mongodb-community');
  } else {
    console.error('  [Windows] 설치 방법:');
    console.error('');
    console.error('    1. https://www.mongodb.com/try/download/community 에서 MSI 다운로드');
    console.error('    2. 설치 시 "Install MongoDB as a Service" 옵션 선택');
    console.error('    3. 설치 완료 후 서비스 자동 시작됨');
  }
  console.error('');
  console.error('  ※ MongoDB 없이 사용하려면 .env에서 DB_TYPE=json 으로 변경하세요.');
  console.error(line);
  console.error('');
}

// ── 치명적 오류 배너 출력 후 종료 ────────────────────────────────────────────

function fatalExit(reason) {
  const line = '═'.repeat(62);
  console.error('');
  console.error(line);
  console.error('  [FATAL] DB_TYPE=mongodb — MongoDB에 연결할 수 없어 서버를 시작할 수 없습니다.');
  console.error('');
  console.error(`  원인: ${reason}`);
  console.error('');
  console.error('  해결 방법:');
  console.error('    1. MongoDB를 시작하세요:  sudo systemctl start mongod');
  console.error('    2. 또는 .env에서  DB_TYPE=json  으로 변경하세요.');
  console.error(line);
  console.error('');
  process.exit(1);
}

// ── systemctl 재시작 시도 ─────────────────────────────────────────────────────

async function trySystemctlStart() {
  // sudo -n : 패스워드 없이 실행 가능한 경우에만 성공 (NOPASSWD 설정)
  try {
    await execFileAsync('sudo', ['-n', 'systemctl', 'start', 'mongod'], { timeout: 10_000 });
    return true;
  } catch { /* sudo needs password or not available */ }

  // sudo 없이 시도 (root 또는 systemd user-level service)
  try {
    await execFileAsync('systemctl', ['start', 'mongod'], { timeout: 10_000 });
    return true;
  } catch { /* not permitted */ }

  return false;
}

async function tryBrewStart() {
  try {
    await execFileAsync('brew', ['services', 'start', 'mongodb-community'], { timeout: 15_000 });
    return true;
  } catch { return false; }
}

// ── 주 진입점 ─────────────────────────────────────────────────────────────────

/**
 * DB_TYPE=mongodb 일 때 로컬 MongoDB 상태를 확인하고 필요 시 재시작합니다.
 *
 * 성공: 정상 반환 (서버 시작 계속)
 * 실패: process.exit(1) — lts.json fallback 없음.
 *        DB_TYPE=mongodb를 선택한 이상 MongoDB는 필수 전제조건입니다.
 */
async function ensureMongoDB() {
  if (process.env.DB_TYPE !== 'mongodb') return;

  const uri = (process.env.MONGODB_URI || '').trim();
  if (!uri) {
    fatalExit('MONGODB_URI가 server/.env에 설정되어 있지 않습니다.');
  }

  const parsed = parseMongoHost(uri);
  if (!parsed || !isLocalHost(parsed.host)) {
    // 원격 MongoDB(Atlas, SRV, 외부 IP): TCP 관리 불가 — MongoDatabase.init()이 연결 실패 시 throw
    console.log('[MongoDB] 원격 URI 감지 — 연결 확인은 MongoDatabase.init()에서 수행합니다.');
    return;
  }

  const { host, port } = parsed;
  const platform = process.platform === 'darwin' ? 'darwin'
    : process.platform === 'win32' ? 'windows'
    : 'linux';

  // 1. 이미 실행 중인지 확인
  const running = await tcpConnect(host, port, 1500);
  if (running) {
    console.log(`[MongoDB] ${host}:${port} — 실행 중`);
    return;
  }

  // 2. mongod 바이너리 설치 여부 확인
  const mongodBin = mongodInstalledPath();
  if (!mongodBin) {
    printInstallGuide(platform);
    fatalExit(`mongod 바이너리를 찾을 수 없습니다 (${host}:${port} 응답 없음).`);
  }

  // 3. 재시작 시도
  console.log(`[MongoDB] ${host}:${port} — 중지됨. 재시작을 시도합니다...`);
  let started = false;

  if (platform === 'linux') {
    started = await trySystemctlStart();
  } else if (platform === 'darwin') {
    started = await tryBrewStart();
  } else if (platform === 'windows') {
    try {
      await execFileAsync('net', ['start', 'MongoDB'], { timeout: 15_000 });
      started = true;
    } catch { /* service name may differ */ }
  }

  if (started) {
    // 포트가 응답할 때까지 최대 20초 대기
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      if (await tcpConnect(host, port, 1000)) {
        console.log(`[MongoDB] ${host}:${port} — 재시작 완료`);
        return;
      }
    }
    fatalExit(`재시작 명령은 성공했지만 ${host}:${port}가 20초 내에 응답하지 않았습니다. mongod 로그를 확인하세요.`);
  }

  // 4. 자동 시작 실패 — 수동 명령 안내 후 종료
  const line = '━'.repeat(60);
  console.error('');
  console.error(line);
  console.error('  [MongoDB] 자동 시작에 실패했습니다. 수동으로 시작해주세요:');
  console.error('');
  if (platform === 'linux') {
    console.error('    sudo systemctl start mongod');
    console.error('    sudo systemctl enable mongod   # 부팅 시 자동 시작');
  } else if (platform === 'darwin') {
    console.error('    brew services start mongodb-community');
  } else {
    console.error('    net start MongoDB');
  }
  console.error(line);
  console.error('');
  fatalExit(`자동 시작 실패 — ${host}:${port}에 연결할 수 없습니다.`);
}

module.exports = { ensureMongoDB };
