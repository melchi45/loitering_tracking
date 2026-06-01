---
name: docker-deploy
description: "LTS-2026 Docker 배포 및 운영 환경 설정. Use when: Docker Compose로 전체 스택 시작/중지, 서비스 컨테이너 재빌드, 환경변수 설정, 프로덕션 배포, HTTPS/TLS 인증서 설정, MongoDB 연결 설정, 서비스 헬스체크, 컨테이너 로그 확인, 포트 충돌 해결, 이미지 업데이트. Covers: docker-compose.yml, server/.env, mediamtx.yml, TLS 인증서 설정, MongoDB Atlas/로컬 연결."
argument-hint: "배포 환경 또는 작업 (예: production, staging, restart, rebuild, logs)"
---

# Docker Deploy

## 서비스 구성

```
docker-compose.yml
├── mediamtx       — RTSP/WebRTC/HLS 미디어 프록시 (포트 8554, 8889, 9997)
├── server         — Node.js 백엔드 API + AI 파이프라인 (포트 3001)
└── client         — React 정적 파일 (Nginx, 포트 3000)
```

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
```bash
# 전체 서비스 실시간 로그
docker compose logs -f

# 특정 서비스 로그
docker compose logs -f server
docker compose logs -f mediamtx --tail 100
```

## 환경변수 설정 (`server/.env`)

```bash
# 서버 포트
PORT=3001
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
- 참고: [HTTPS_TLS_Setup.md](../../docs/ops/HTTPS_TLS_Setup.md)

## MongoDB 설정

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
- 참고: [MongoDB_Setup.md](../../docs/ops/MongoDB_Setup.md)

## 헬스체크

```bash
# 서버 API 상태 확인
curl http://localhost:3001/health

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

## 문제 해결

### 컨테이너 시작 실패
```bash
docker compose ps            # 상태 확인
docker compose logs server   # 오류 로그 확인
```

### 포트 충돌
```bash
lsof -i :3001   # 포트 점유 프로세스 확인
```

### 볼륨 마운트 권한 오류
```bash
chmod -R 755 server/models server/storage
```

## 관련 설계 문서
- [Design_HTTPS_TLS.md](../../docs/design/Design_HTTPS_TLS.md)
- [Design_Storage_MongoDB.md](../../docs/design/Design_Storage_MongoDB.md)
- [HTTPS_TLS_Setup.md](../../docs/ops/HTTPS_TLS_Setup.md)
- [MongoDB_Setup.md](../../docs/ops/MongoDB_Setup.md)
