'use strict';

/**
 * installDb.js — MongoDB 초기 설정 스크립트
 *
 * Usage:
 *   npm run install_db
 *   node src/scripts/installDb.js
 *   node src/scripts/installDb.js --host 192.168.1.10 --port 27017
 *                                  --admin-user admin --admin-pwd secret
 *                                  --db-user ltsuser --db-pwd ltspwd
 *
 * 수행 작업:
 *   1. MongoDB 서버 접속 정보 입력 (대화형 또는 CLI 인자)
 *   2. 관리자 계정으로 접속해 `lts` DB 및 전용 사용자 생성
 *   3. 필요한 컬렉션 & 인덱스 초기화
 *   4. server/.env 의 MONGODB_URI / DB_TYPE 자동 업데이트
 *   5. 접속 검증 (ping + 간단한 read/write)
 */

const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const mongoose = require('mongoose');

const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');

// ── ANSI colours ──────────────────────────────────────────────────────────────
const R = '\x1b[0m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const RD = '\x1b[31m';
const C = '\x1b[36m';
const B = '\x1b[1m';

const ok   = (m) => console.log(`  ${G}✓${R} ${m}`);
const warn = (m) => console.log(`  ${Y}!${R} ${m}`);
const fail = (m) => console.log(`  ${RD}✗${R} ${m}`);
const info = (m) => console.log(`  ${C}·${R} ${m}`);
const h1   = (m) => console.log(`\n${B}${m}${R}`);
const hr   = ()  => console.log(`${'─'.repeat(60)}`);

// ── CLI argument parser ───────────────────────────────────────────────────────
function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    args[key] = val;
  }
  return args;
}

// ── Interactive prompt ────────────────────────────────────────────────────────
function prompt(rl, question, defaultVal, masked) {
  return new Promise((resolve) => {
    const hint = defaultVal ? ` [${defaultVal}]` : '';
    process.stdout.write(`  ${question}${hint}: `);
    if (masked) {
      // Hide input for passwords
      const stdin = process.openStdin();
      process.stdout.write('\x1b[8m'); // hide
      rl.once('line', (val) => {
        process.stdout.write('\x1b[28m\n'); // show
        resolve(val.trim() || defaultVal || '');
      });
    } else {
      rl.once('line', (val) => resolve(val.trim() || defaultVal || ''));
    }
  });
}

// ── .env updater ─────────────────────────────────────────────────────────────
function updateEnv(uri, dbName) {
  if (!fs.existsSync(ENV_PATH)) {
    warn(`.env not found at ${ENV_PATH} — skipping update`);
    return false;
  }
  let content = fs.readFileSync(ENV_PATH, 'utf8');

  const setKey = (key, value) => {
    const re = new RegExp(`^(#\\s*)?${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content += `\n${line}`;
    }
  };

  setKey('DB_TYPE',        'mongodb');
  setKey('MONGODB_URI',    uri);
  setKey('MONGODB_DB_NAME', dbName);

  fs.writeFileSync(ENV_PATH, content, 'utf8');
  return true;
}

// ── MongoDB setup ─────────────────────────────────────────────────────────────
const COLLECTIONS = [
  'cameras', 'zones', 'events', 'alerts',
  'faceGalleries', 'faceGalleryFaces',
  'settings', 'detectionSnapshots', 'faceMatchHistory',
  'missing_persons', 'missing_person_detections',
];

// Indexes: [collection, field, options]
const INDEXES = [
  ['cameras',   { id: 1 },        { unique: true }],
  ['zones',     { id: 1 },        { unique: true }],
  ['events',    { id: 1 },        { unique: true }],
  ['events',    { cameraId: 1, createdAt: -1 }, {}],
  ['alerts',    { id: 1 },        { unique: true }],
  ['alerts',    { acknowledged: 1, createdAt: -1 }, {}],
  ['faceGalleries',     { id: 1 }, { unique: true }],
  ['faceGalleryFaces',  { id: 1 }, { unique: true }],
  ['faceGalleryFaces',  { galleryId: 1 }, {}],
  ['detectionSnapshots', { id: 1 }, { unique: true }],
  ['detectionSnapshots', { cameraId: 1, createdAt: -1 }, {}],
  ['faceMatchHistory',  { id: 1 }, { unique: true }],
  ['faceMatchHistory',  { cameraId: 1, createdAt: -1 }, {}],
  ['missing_persons',   { id: 1 }, { unique: true }],
  ['missing_person_detections', { id: 1 },         { unique: true }],
  ['missing_person_detections', { missingPersonId: 1, createdAt: -1 }, {}],
  ['settings',  { id: 1 }, { unique: true }],
];

async function setupCollectionsAndIndexes(db) {
  const existingCols = (await db.listCollections().toArray()).map((c) => c.name);

  for (const col of COLLECTIONS) {
    if (!existingCols.includes(col)) {
      await db.createCollection(col);
      info(`컬렉션 생성: ${col}`);
    } else {
      info(`컬렉션 존재: ${col}`);
    }
  }

  for (const [col, fields, opts] of INDEXES) {
    try {
      await db.collection(col).createIndex(fields, opts);
    } catch (e) {
      // Ignore "index already exists" errors
      if (!e.message.includes('already exists') && !e.message.includes('IndexOptionsConflict')) {
        warn(`인덱스 생성 실패 ${col}: ${e.message}`);
      }
    }
  }
  ok(`인덱스 ${INDEXES.length}개 적용 완료`);
}

async function createDbUser(adminDb, dbName, dbUser, dbPwd) {
  try {
    await adminDb.command({
      createUser: dbUser,
      pwd: dbPwd,
      roles: [{ role: 'readWrite', db: dbName }],
    });
    ok(`사용자 생성: ${dbUser}@${dbName}`);
    return true;
  } catch (e) {
    if (e.codeName === 'DuplicateKey' || e.message.includes('already exists')) {
      // Update password if user already exists
      try {
        await adminDb.command({ updateUser: dbUser, pwd: dbPwd });
        ok(`사용자 비밀번호 업데이트: ${dbUser}@${dbName}`);
        return true;
      } catch (ue) {
        warn(`사용자 업데이트 실패: ${ue.message}`);
        return false;
      }
    }
    warn(`사용자 생성 실패: ${e.message}`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  hr();
  console.log(`${B}  LTS-2026 MongoDB 설치 스크립트${R}`);
  hr();

  const cliArgs = parseArgs();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // ── Step 1: 접속 정보 수집 ──────────────────────────────────────────────────
  h1('1단계: MongoDB 서버 접속 정보');

  const host       = cliArgs['host']       || await prompt(rl, 'MongoDB 호스트 (IP 또는 hostname)', '127.0.0.1');
  const port       = cliArgs['port']       || await prompt(rl, 'MongoDB 포트', '27017');
  const adminUser  = cliArgs['admin-user'] || await prompt(rl, '관리자 계정 (인증 없으면 Enter)');
  const adminPwd   = adminUser
    ? (cliArgs['admin-pwd'] || await prompt(rl, '관리자 비밀번호', '', true))
    : '';
  const dbName     = cliArgs['db']         || await prompt(rl, '데이터베이스 이름', 'lts');
  const createUser = cliArgs['skip-user']  ? false
    : (await prompt(rl, `전용 DB 사용자 생성? (y/n)`, 'y')).toLowerCase() === 'y';

  let dbUser = '';
  let dbPwd  = '';
  if (createUser) {
    dbUser = cliArgs['db-user'] || await prompt(rl, `DB 사용자 이름`, 'ltsuser');
    dbPwd  = cliArgs['db-pwd']  || await prompt(rl, `DB 사용자 비밀번호`, '', true);
  }

  rl.close();

  // ── Step 2: 관리자 URI 구성 ─────────────────────────────────────────────────
  h1('2단계: MongoDB 접속 테스트');

  const adminAuth = adminUser ? `${encodeURIComponent(adminUser)}:${encodeURIComponent(adminPwd)}@` : '';
  const adminUri  = `mongodb://${adminAuth}${host}:${port}/admin?authSource=admin`;
  const maskedUri = adminUser
    ? `mongodb://${adminUser}:****@${host}:${port}/admin`
    : `mongodb://${host}:${port}/admin`;

  info(`접속 중: ${maskedUri}`);

  let adminConn;
  try {
    adminConn = await mongoose.createConnection(adminUri, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 15000,
    }).asPromise();
    ok('관리자 접속 성공');
  } catch (e) {
    fail(`접속 실패: ${e.message}`);
    process.exit(1);
  }

  // ── Step 3: DB 사용자 생성 ──────────────────────────────────────────────────
  if (createUser && dbUser && dbPwd) {
    h1('3단계: DB 사용자 생성');
    const adminDb = adminConn.useDb('admin').db;
    await createDbUser(adminDb, dbName, dbUser, dbPwd);
  }

  // ── Step 4: lts DB 초기화 ───────────────────────────────────────────────────
  h1('4단계: lts 데이터베이스 초기화');

  const ltsDb = adminConn.useDb(dbName).db;
  await setupCollectionsAndIndexes(ltsDb);

  // ── Step 5: 최종 URI 결정 ───────────────────────────────────────────────────
  h1('5단계: 접속 URI 확인');

  let finalUri;
  if (createUser && dbUser && dbPwd) {
    finalUri = `mongodb://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPwd)}@${host}:${port}/${dbName}?authSource=${dbName}`;
  } else if (adminUser) {
    finalUri = `mongodb://${encodeURIComponent(adminUser)}:${encodeURIComponent(adminPwd)}@${host}:${port}/${dbName}?authSource=admin`;
  } else {
    finalUri = `mongodb://${host}:${port}/${dbName}`;
  }

  // 연결 검증
  let verifyConn;
  try {
    verifyConn = await mongoose.createConnection(finalUri, {
      serverSelectionTimeoutMS: 8000,
    }).asPromise();
    await verifyConn.db.command({ ping: 1 });
    ok('최종 URI 접속 검증 성공');
  } catch (e) {
    warn(`최종 URI 검증 실패: ${e.message}`);
    warn('URI를 수동으로 .env에 설정해 주세요');
  } finally {
    if (verifyConn) await verifyConn.close().catch(() => {});
  }

  await adminConn.close().catch(() => {});

  // ── Step 6: .env 업데이트 ───────────────────────────────────────────────────
  h1('6단계: .env 업데이트');

  const maskedFinal = finalUri.replace(/:([^:@/]+)@/, ':****@');
  info(`MONGODB_URI = ${maskedFinal}`);

  if (updateEnv(finalUri, dbName)) {
    ok(`${ENV_PATH} 업데이트 완료`);
    ok('DB_TYPE=mongodb 설정됨');
  }

  // ── 완료 ──────────────────────────────────────────────────────────────────
  hr();
  console.log(`\n${G}${B}  설치 완료!${R}`);
  console.log(`  서버 재시작: ${C}npm run dev${R}\n`);
  hr();
}

main().catch((e) => {
  console.error(`\n${RD}오류: ${e.message}${R}`);
  process.exit(1);
});
