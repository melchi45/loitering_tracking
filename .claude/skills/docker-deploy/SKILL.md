---
name: docker-deploy
description: "LTS-2026 Docker 배포 및 운영 환경 설정. Use when: Docker Compose로 전체 스택 시작/중지, 서비스 컨테이너 재빌드, 환경변수 설정, 프로덕션 배포, HTTPS/TLS 인증서 설정, MongoDB 연결 설정, 서비스 헬스체크, 컨테이너 로그 확인, 포트 충돌 해결, 이미지 업데이트. Covers: docker-compose.yml, server/.env, mediamtx.yml, TLS 인증서 설정, MongoDB Atlas/로컬 연결."
argument-hint: "배포 환경 또는 작업 (예: production, staging, restart, rebuild, logs)"
---

# Docker Deploy

## 서비스 구성

```
docker-compose.yml
├── qdrant         — 벡터 DB, opt-in (포트 6333, 6334) — QDRANT_ENABLED=true 없이는 서버가 연결 안 함, 무해
├── mediamtx       — RTSP/WebRTC/HLS 미디어 프록시 (포트 8554, 8889, 9997)
├── server         — Node.js 백엔드 API + AI 파이프라인 (포트 3080)
└── client         — React 정적 파일 (Nginx, 포트 3000)
```

`docker compose up -d`는 `qdrant`도 함께 기동합니다(기본 포함, opt-in). `qdrant`만 개별로 올리려면 `docker compose up -d qdrant`. 상세: [`docs/ops/Distributed_AI_Pipeline_Setup.md` §7.5](../../../docs/ops/Distributed_AI_Pipeline_Setup.md#75-qdrant-벡터-db-opt-in--ai-05-phase-3--crosscamera-phase-2).

## 기본 운영 명령

### 전체 스택 시작
```bash
cd /home/youngho/workspace/loitering_tracking
docker compose up -d
```

### 전체 스택 중지
```bash
docker compose down
```

### 특정 서비스 재시작
```bash
docker compose restart server
docker compose restart mediamtx
```

### 서비스 재빌드 후 시작
```bash
# 서버만 재빌드
docker compose build server && docker compose up -d server

# 클라이언트만 재빌드
docker compose build client && docker compose up -d client

# 전체 재빌드
docker compose build && docker compose up -d
```

### 로그 확인

#### Docker 컨테이너 로그
```bash
# 전체 서비스 실시간 로그
docker compose logs -f

# 특정 서비스 로그
docker compose logs -f server
docker compose logs -f mediamtx --tail 100
```

#### 프로덕션 로그 파일 (`npm run start` 계열)
`startServer.js`가 모든 출력(서버·MediaMTX·Ingest)에 `[YY-MM-DD HH:mm:ss.sss] [LEVEL]` 접두어를 붙여 일별 파일로 저장합니다.

**출력 형식**
```
[26-06-19 13:45:30.012] [INFO]    [DB] MongoDB connected
[26-06-19 13:45:30.234] [WARNING] [MediaMTX] Port 8554 already in use
[26-06-19 13:45:30.456] [DEBUG]   [YouTubeStream] yt-dlp: [hls @ 0x...] Skip(...)
```

**초기 설정 (1회, root 필요)**
```bash
sudo mkdir -p /var/log/lts && sudo chown $USER:$USER /var/log/lts
```

**로그 조회**
```bash
# 실시간 확인
tail -f /var/log/lts/lts-$(date +%Y-%m-%d).log

# 레벨별 필터
grep '\[ERROR\]'   /var/log/lts/lts-$(date +%Y-%m-%d).log
grep '\[WARNING\]' /var/log/lts/lts-$(date +%Y-%m-%d).log
```

**환경변수 (`server/.env`)**

| 변수 | 기본값 | 설명 |
|---|---|---|
| `LOG_TO_FILE` | `true` | `false`로 설정 시 파일 저장 비활성화 |
| `LOG_DIR` | `/var/log/lts` | 로그 디렉토리. 권한 없을 시 `server/logs/`로 자동 폴백 |
| `LOG_LEVEL` | `INFO` | 최소 레벨: `DEBUG`/`INFO`/`WARNING`/`ERROR`/`CRITICAL`/`NONE` |
| `LOG_FILTER_PATTERNS` | `` | 쉼표 구분 정규식 — 매칭 줄 강제 억제 |

> `LOG_LEVEL=INFO`(기본) 설정 시 ffmpeg `[hls @ 0x...] Skip` 노이즈가 자동 필터링됩니다.
> `LOG_LEVEL=DEBUG`로 변경하면 yt-dlp/ffmpeg 전체 verbose 출력을 볼 수 있습니다.

상세 내용 → [`docs/ops/Logging_Guide.md`](../../../docs/ops/Logging_Guide.md)

## 환경변수 파일 규칙

> **모든 서버 모드(`combined` / `streaming` / `analysis`)는 `server/.env` 파일 하나만 로드합니다.**
> `server/.env.example`, `server/.env.streaming.example`, `server/.env.analysis.example`은
> 참조용 문서(README 역할)이며 서버가 절대 로드하지 않습니다.
> Claude 등 AI 도구는 `.env` 이외의 `.env.*` 파일을 설정 파일로 취급하거나 수정하지 않습니다.

`SERVER_MODE` 값은 `server/.env` 안에서 설정합니다:

```env
# combined(기본) | streaming | analysis
SERVER_MODE=streaming
```

## 환경변수 설정 (`server/.env`)

```bash
# 서버 포트
PORT=3080
NODE_ENV=production

# MongoDB 연결
MONGODB_URI=mongodb://localhost:27017/lts2026
# 또는 MongoDB Atlas:
# MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/lts2026

# JWT 인증
JWT_SECRET=your-strong-secret-key
JWT_EXPIRY=24h

# MSAL (Microsoft 인증, 선택사항)
MSAL_CLIENT_ID=
MSAL_TENANT_ID=

# 캡처 백엔드 (권장: ingest-daemon)
CAPTURE_BACKEND=ingest-daemon
WEBRTC_ENGINE=mediamtx
INGEST_DAEMON_BIN=../ingest-daemon/ingest_daemon.py
INGEST_DAEMON_ADDR=:7070

# TURN 서버 (WebRTC NAT 통과)
TURN_URL=turn:your-turn-server.com:3478
TURN_USER=username
TURN_PASS=password

# TLS
TLS_CERT_PATH=./certs/server.crt
TLS_KEY_PATH=./certs/server.key
HTTPS_PORT=3443
```

## HTTPS/TLS 설정

### 자체 서명 인증서 생성 (개발용)
```bash
mkdir -p server/certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout server/certs/server.key \
  -out server/certs/server.crt \
  -subj "/CN=localhost"
```

### Let's Encrypt (프로덕션)
```bash
certbot certonly --standalone -d your-domain.com
cp /etc/letsencrypt/live/your-domain.com/fullchain.pem server/certs/server.crt
cp /etc/letsencrypt/live/your-domain.com/privkey.pem server/certs/server.key
```
- 참고: [HTTPS_TLS_Setup.md](../../../docs/ops/HTTPS_TLS_Setup.md)

## MongoDB 설정

### DB 백엔드 아키텍처 (v1.7+)

LTS-2026 DB 레이어는 플러그어블 백엔드 구조입니다:

```
server/src/db/
├── index.js          ← factory + public API
├── BaseDatabase.js   ← abstract interface
├── JsonDatabase.js   ← DB_TYPE=json (default)
├── MongoDatabase.js  ← DB_TYPE=mongodb
└── constants.js      ← 공유 상수
```

`server/src/db.js`는 shim으로 `require('./db/index')`를 재내보냅니다. 모든 기존 호출은 변경 없이 동작합니다.

**주의**: `DB_TYPE=mongodb` 설정 시 `MongoDatabase`는 `lts.json`을 절대 읽거나 쓰지 않습니다. MongoDB 연결 실패 시에도 JSON fallback 없이 in-memory only로 동작합니다.

### 원격 MongoDB 초기 설정 (`npm run install_db`)
별도 서버에 MongoDB가 설치된 경우 — 컬렉션·인덱스·`.env` 자동 구성:
```bash
cd server
npm run install_db
# 또는 CLI 옵션:
node src/scripts/installDb.js \
  --host 192.168.1.100 --port 27017 \
  --admin-user admin --admin-pwd secret \
  --db lts --db-user ltsuser --db-pwd ltspwd
```
수행 내용: 관리자 접속 → DB 사용자 생성 → 컬렉션 + 인덱스 초기화 → `server/.env` 자동 업데이트

### 로컬 MongoDB 실행 (Docker)
```bash
docker run -d \
  --name mongodb \
  -p 27017:27017 \
  -v mongodb_data:/data/db \
  mongo:7.0
```

### MongoDB 컬렉션 확인
```bash
docker exec -it mongodb mongosh lts2026 \
  --eval "db.getCollectionNames()"
```
- 참고: [MongoDB_Setup.md](../../../docs/ops/MongoDB_Setup.md)

## 헬스체크

```bash
# 서버 API 상태 확인
curl http://localhost:3080/health

# MediaMTX 경로 상태
curl http://localhost:9997/v3/paths/list

# 클라이언트 접속 확인
curl -I http://localhost:3000
```

## 포트 요약

| 서비스 | 포트 | 용도 |
|---|---|---|
| client (Nginx) | 3000 | React 웹 대시보드 |
| server (HTTP) | 3001 | REST API + WebSocket |
| server (HTTPS) | 3443 | TLS API (선택사항) |
| mediamtx RTSP | 8554 | RTSP 스트림 수신/배포 |
| mediamtx WebRTC | 8889 | WebRTC 시그널링 |
| mediamtx API | 9997 | MediaMTX 관리 API |
| MongoDB | 27017 | 데이터베이스 |
| Qdrant | 6333, 6334 | 벡터 DB (opt-in, `QDRANT_ENABLED=true`) |

## 프로세스 관리 및 종료

### 정상 종료 방법

```bash
# 대화형 터미널 (Ctrl+C)
# → startServer.js가 mediamtx·ingest-daemon·index.js에 신호 전달 → 자동 종료

# 백그라운드 실행 중 (npm run stop)
cd server
npm run stop           # combined 서버 종료 + mediamtx/ingest-daemon 잔여 프로세스 정리
npm run stop:streaming
npm run stop:analysis
```

`npm run stop`은 두 단계로 종료합니다:
1. 포트(3080/3443) 기반으로 Node.js 서버 SIGTERM → 10초 후 미반납 시 SIGKILL
2. `mediamtx`, `ingest_daemon.py` 프로세스를 이름으로 찾아 SIGTERM → 3초 후 SIGKILL

### 잔여 프로세스 수동 정리

```bash
# LTS 관련 모든 프로세스 확인
ps -ef | grep -E "mediamtx|ingest_daemon|index.js|ffmpeg" | grep -v grep

# 개별 강제 종료
pkill -f mediamtx
pkill -f ingest_daemon.py
```

### mcp-server 별도 관리

mcp-server는 startServer.js와 독립 프로세스입니다 — `npm run stop`으로 종료되지 않습니다.

```bash
# mcp-server 수동 종료
pkill -f "loitering_tracking/mcp-server"
```

상세 내용 → [`docs/ops/Process_Management.md`](../../../docs/ops/Process_Management.md)

## 문제 해결

### 컨테이너 시작 실패
```bash
docker compose ps            # 상태 확인
docker compose logs server   # 오류 로그 확인
```

### 포트 충돌
```bash
lsof -i :3080   # 포트 점유 프로세스 확인
```

### 볼륨 마운트 권한 오류
```bash
chmod -R 755 server/models server/storage
```

## 관련 문서 (SDLC 참조)

> 구현·수정 전 아래 문서를 확인하고, **코드 변경 시 해당 문서를 반드시 동기화**하세요.

| 구분 | 문서 |
|------|------|
| RFP | [RFP_HTTPS_TLS](../../../docs/rfp/RFP_HTTPS_TLS.md) · [RFP_DB_Layer](../../../docs/rfp/RFP_DB_Layer.md) · [RFP_LTS2026_Loitering_Tracking_System](../../../docs/rfp/RFP_LTS2026_Loitering_Tracking_System.md) · [RFP_User_Authentication](../../../docs/rfp/RFP_User_Authentication.md) |
| PRD | [PRD_HTTPS_TLS](../../../docs/prd/PRD_HTTPS_TLS.md) · [PRD_DB_Layer](../../../docs/prd/PRD_DB_Layer.md) · [PRD_LTS2026_Loitering_Tracking_System](../../../docs/prd/PRD_LTS2026_Loitering_Tracking_System.md) |
| SRS | [SRS_HTTPS_TLS](../../../docs/srs/SRS_HTTPS_TLS.md) · [SRS_DB_Layer](../../../docs/srs/SRS_DB_Layer.md) · [SRS_LTS2026_Loitering_Tracking_System](../../../docs/srs/SRS_LTS2026_Loitering_Tracking_System.md) |
| Design | [Design_HTTPS_TLS](../../../docs/design/Design_HTTPS_TLS.md) · [Design_DB_Layer](../../../docs/design/Design_DB_Layer.md) · [Design_LTS2026_Loitering_Tracking_System](../../../docs/design/Design_LTS2026_Loitering_Tracking_System.md) · [Design_Server_Architecture](../../../docs/design/Design_Server_Architecture.md) |
| TC | [TC_HTTPS_TLS](../../../docs/tc/TC_HTTPS_TLS.md) · [TC_DB_Layer](../../../docs/tc/TC_DB_Layer.md) · [TC_LTS2026_Loitering_Tracking_System](../../../docs/tc/TC_LTS2026_Loitering_Tracking_System.md) |
| Ops | [HTTPS_TLS_Setup](../../../docs/ops/HTTPS_TLS_Setup.md) · [MongoDB_Setup](../../../docs/ops/MongoDB_Setup.md) · [RTSP_Capture_Backend_Setup](../../../docs/ops/RTSP_Capture_Backend_Setup.md) · [MCP_Server_Setup](../../../docs/ops/MCP_Server_Setup.md) |

## 코드 수정 시 문서 동기화 의무

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `docker-compose.yml` (서비스·포트 변경) | `docs/design/Design_LTS2026_Loitering_Tracking_System.md` 아키텍처 섹션 |
| `server/.env` (환경변수 추가·변경) | 해당 기능의 SRS 설정 파라미터 섹션 + `docs/ops/` 관련 가이드 |
| `server/src/index.js` (포트·TLS 설정) | `docs/design/Design_HTTPS_TLS.md`, `docs/ops/HTTPS_TLS_Setup.md`, `docs/tc/TC_HTTPS_TLS.md` |
| `server/src/db/` (BaseDatabase, JsonDatabase, MongoDatabase, index.js), `mongoDbService.js` | `docs/design/Design_DB_Layer.md`, `docs/srs/SRS_DB_Layer.md`, `docs/tc/TC_DB_Layer.md` |
| `server/certs/` (인증서 구조 변경) | `docs/ops/HTTPS_TLS_Setup.md` |
| `mediamtx.yml` | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/ops/RTSP_Capture_Backend_Setup.md`, `docs/design/Design_Server_Architecture.md` |
| `server/.env` (`SERVER_MODE` 변경) | `docs/design/Design_Server_Architecture.md` 모드별 기능 매트릭스 |
| 새 서비스 컨테이너 추가 | `docs/design/Design_LTS2026_Loitering_Tracking_System.md` 배포 아키텍처 다이어그램 + Ops 가이드 신규 추가 |
| `docker-compose.yml` (`qdrant` 서비스), `QDRANT_ENABLED`/`QDRANT_URL` | `docs/ops/Distributed_AI_Pipeline_Setup.md` §5.1/§7.5, `docs/design/Design_AI_AppearanceReID.md` §12.3 |

**공통 규칙**
- **포트 변경** → Design 아키텍처 포트 표 + SRS 시스템 제약 + Ops 가이드 업데이트
- **환경변수 추가** → `.env.example` + 해당 기능 SRS + Ops 가이드 반영
- **TLS 인증서 경로 변경** → `docs/ops/HTTPS_TLS_Setup.md` 설치 절차 업데이트
- **MongoDB 스키마 변경** → `docs/design/Design_DB_Layer.md` 컬렉션 명세 업데이트
- **Docker 이미지 버전 업그레이드** → Ops 가이드 버전 표 + TC 호환성 케이스 갱신
