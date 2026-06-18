# Operations Guide
# MongoDB Setup

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-MDB-001 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-05-28 |
| **Status** | **✅ Active — MongoDB 5.0.33 running on Ubuntu 18.04, DB_TYPE=mongodb** |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

By default the server persists all data to `server/storage/lts.json` (`DB_TYPE=json`).  
This guide describes how to switch to **MongoDB 5.0** as the primary database. When `DB_TYPE=mongodb`, all writes go to MongoDB exclusively; `lts.json` is written only if MongoDB disconnects (and only for non-high-volume tables).

> **Tested on:** Ubuntu 18.04 LTS (Bionic) · MongoDB 5.0.33 · AVX-capable CPU required

---

## 빠른 시작 — `npm run install_db` (권장)

MongoDB가 **별도 서버**에 설치된 경우, 대화형 설치 스크립트를 사용하면 컬렉션 생성·인덱스 초기화·`.env` 업데이트를 자동으로 처리합니다.

```bash
cd server
npm run install_db
```

스크립트를 실행하면 다음 항목을 단계별로 입력합니다:

| 프롬프트 | 기본값 | 설명 |
|---|:---:|---|
| MongoDB 호스트 | `127.0.0.1` | IP 주소 또는 hostname |
| MongoDB 포트 | `27017` | MongoDB 리스닝 포트 |
| 관리자 계정 | (없음) | 인증 없으면 Enter — 관리자 권한으로 사용자 생성 |
| 관리자 비밀번호 | (없음) | 마스킹 입력 |
| 데이터베이스 이름 | `lts` | 생성할 DB 이름 |
| 전용 DB 사용자 생성 | `y` | 전용 readWrite 사용자 생성 여부 |
| DB 사용자 이름 | `ltsuser` | 생성할 사용자 계정 |
| DB 사용자 비밀번호 | (없음) | 마스킹 입력 |

### 수행 작업

1. 관리자 URI로 접속 테스트
2. 전용 DB 사용자 생성 (이미 존재하면 비밀번호 업데이트)
3. 컬렉션 11개 생성: `cameras`, `zones`, `events`, `alerts`, `faceGalleries`, `faceGalleryFaces`, `settings`, `detectionSnapshots`, `faceMatchHistory`, `missing_persons`, `missing_person_detections`
4. 인덱스 17개 생성 (unique + 복합 인덱스)
5. `server/.env` 자동 업데이트: `DB_TYPE=mongodb`, `MONGODB_URI=...`, `MONGODB_DB_NAME=...`
6. 최종 URI로 접속 검증 (ping)

### CLI 옵션 (비대화형 모드)

```bash
node src/scripts/installDb.js \
  --host 192.168.1.100 \
  --port 27017 \
  --admin-user admin \
  --admin-pwd secret \
  --db lts \
  --db-user ltsuser \
  --db-pwd ltspwd
```

`--skip-user` 플래그를 추가하면 사용자 생성 단계를 건너뜁니다.

### 실행 후 서버 재시작

```bash
# .env 업데이트 내용이 적용됩니다
cd server && npm run dev
```

로그에서 확인:
```
[MongoDB] connected → mongodb://ltsuser:****@192.168.1.100:27017/lts
[DB] Storage mode: MongoDB (writes MongoDB-only; JSON written only on disconnect)
```

---

## Step 1 — Install MongoDB 5.0

```bash
# 1. Import MongoDB GPG key
curl -fsSL https://www.mongodb.org/static/pgp/server-5.0.asc | sudo apt-key add -

# 2. Add apt repository (Ubuntu 18.04 Bionic)
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu bionic/mongodb-org/5.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-5.0.list

# 3. Install
sudo apt-get update -q
sudo apt-get install -y mongodb-org

# Verify
mongod --version   # → db version v5.0.x
```

> **Ubuntu 20.04 / 22.04:** Replace `bionic` with `focal` or `jammy` in the repository URL.

## Step 2 — Start & Enable the Service

```bash
sudo systemctl start mongod
sudo systemctl enable mongod        # auto-start on boot
sudo systemctl status mongod        # should show: active (running)

# Verify connection
mongosh --eval "db.runCommand({ping:1})" --quiet
```

## Step 3 — Migrate Existing Data from lts.json

Run this once to import the current JSON store into MongoDB:

```bash
cd /path/to/loitering_tracking

python3 << 'EOF'
import json, subprocess, os, tempfile

data = json.load(open('server/storage/lts.json'))
total = 0
for table, docs in data.items():
    if not isinstance(docs, list) or len(docs) == 0:
        print(f'{table}: (empty, skip)')
        continue
    tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    for doc in docs:
        tmp.write(json.dumps(doc) + '\n')
    tmp.close()
    result = subprocess.run(
        ['mongoimport', '--db', 'lts', '--collection', table, '--drop', '--file', tmp.name],
        capture_output=True, text=True
    )
    os.unlink(tmp.name)
    if result.returncode == 0:
        print(f'{table}: {len(docs)} docs OK')
        total += len(docs)
    else:
        print(f'{table}: FAILED — {result.stderr.strip()}')
print(f'\nTotal: {total} documents imported into MongoDB \'lts\' database')
EOF
```

Expected output (numbers will vary):
```
cameras: 9 docs OK
settings: 2 docs OK
detectionSnapshots: 431 docs OK
...
Total: 419 documents imported into MongoDB 'lts' database
```

## Step 4 — Switch DB_TYPE in server/.env

```dotenv
# server/.env
DB_TYPE=mongodb
MONGODB_URI=mongodb://localhost:27017/lts
MONGODB_DB_NAME=lts
```

## Step 5 — Restart the Server

```bash
# From workspace root
fuser -k 3443/tcp 2>/dev/null   # stop running server
npm start
```

Confirm in logs (`/tmp/lts.log`):
```
[MongoDB] connected → mongodb://localhost:27017/lts
[DB] Storage mode: MongoDB (writes MongoDB-only; JSON written only on disconnect)
[Server] Starting 9 registered camera pipeline(s)
[Server] Loitering Tracking System backend listening on port 3080
```

> **Auto-start check**: When `DB_TYPE=mongodb` is set, the server runs `ensureMongodb.js` on startup. It TCP-probes the configured host/port. If MongoDB is down, it attempts `sudo systemctl restart mongod` and waits up to 20 s. If MongoDB is not installed, it prints a platform-specific installation guide. See `server/src/scripts/ensureMongodb.js`.

## Storage Mode Comparison

| Mode | `DB_TYPE` | Persistence | Best For |
|---|:---:|---|---|
| JSON (default) | `json` | `server/storage/lts.json` (always written) | Dev / single-node |
| MongoDB | `mongodb` | MongoDB collections (primary); `lts.json` written only if MongoDB disconnects | Production / multi-node |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mongod: NOT FOUND` after install | PATH not refreshed | Run `hash -r` or open a new terminal |
| `AVX` error on start | CPU lacks AVX support | Use MongoDB 4.4 instead (does not require AVX) |
| Data lost after server restart | `STORAGE_PATH` resolves to wrong directory | Ensure `STORAGE_PATH=./storage` and server cwd = `server/`; verify with `grep STORAGE /tmp/lts.log` |
| `[DB] MongoDB ... empty — seeding from JSON` | Collection empty on first start | Normal behaviour — JSON fallback seeds MongoDB automatically |
| `[DB] JSON persist error: Invalid string length` | In-memory store exceeded V8 JSON string limit | Switch to `DB_TYPE=mongodb` or check `TABLE_ROW_CAPS` in `db.js`; `faceMatchHistory` must not store base64 image data |
| `install_db` fails with `Authentication failed` | Wrong admin credentials | Verify with `mongosh --host HOST -u ADMIN_USER -p` |
| `install_db` fails with `Connection refused` | MongoDB not listening on host:port | Check `sudo systemctl status mongod` on the remote server; verify firewall allows port 27017 |

---

## db.js 메모리 제한 (TABLE_ROW_CAPS) 및 JSON 폴백 제외 테이블

고용량 트랜잭션 테이블은 `server/src/db.js`의 `TABLE_ROW_CAPS`로 인-메모리 행 수를 제한합니다.
MongoDB 모드에서 MongoDB 연결이 끊긴 경우 `JSON_FALLBACK_SKIP` 집합에 해당하는 테이블은 `lts.json` 쓰기에서 제외되어 이벤트루프 블로킹을 방지합니다.

| 테이블 | 최대 행 수 | MongoDB 저장 | JSON 폴백 포함 |
|---|:---:|:---:|:---:|
| `events` | 20,000 | ✅ | ❌ (JSON_FALLBACK_SKIP) |
| `alerts` | 10,000 | ✅ | ✅ |
| `detectionSnapshots` | 2,000 | ✅ | ❌ (JSON_FALLBACK_SKIP) |
| `faceMatchHistory` | 5,000 | ✅ | ❌ (JSON_FALLBACK_SKIP) |
| `missing_person_detections` | 5,000 | ✅ | ❌ (JSON_FALLBACK_SKIP) |
| `client_logs` | 10,000 | ✅ | ❌ (JSON_FALLBACK_SKIP) |
| `audit_logs` | 10,000 | ✅ | ❌ (JSON_FALLBACK_SKIP) |
| `cameras`, `zones`, `settings` 등 | 제한 없음 | ✅ | ✅ |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — MongoDB 5.0 installation and migration guide for Ubuntu 18.04 |
| 1.1 | 2026-06-09 | LTS Engineering Team | Add `npm run install_db` script documentation, TABLE_ROW_CAPS reference, extended troubleshooting |
| 1.2 | 2026-06-18 | LTS Engineering Team | MongoDB-only 쓰기 모드 반영 (JSON은 disconnect 시만 쓰기), MONGO_ONLY_TABLES → JSON_FALLBACK_SKIP, ensureMongodb.js 자동 시작 설명 추가 |
