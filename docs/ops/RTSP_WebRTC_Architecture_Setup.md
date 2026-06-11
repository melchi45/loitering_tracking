# Operations Guide
# RTSP·WebRTC Architecture 설치 및 운영 가이드

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-RWA-001 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-06-11 |
| **Status** | **Active** |
| **Related PRD** | [prd/PRD_RTSP_WebRTC_Architecture.md](../prd/PRD_RTSP_WebRTC_Architecture.md) |
| **Related SRS** | [srs/SRS_RTSP_WebRTC_Architecture.md](../srs/SRS_RTSP_WebRTC_Architecture.md) |
| **Related Design** | [design/Design_RTSP_WebRTC_Architecture.md](../design/Design_RTSP_WebRTC_Architecture.md) |

---

## 개요

LTS-2026의 RTSP 인제스트 및 WebRTC 스트리밍 파이프라인은 다음 컴포넌트로 구성됩니다.

| 컴포넌트 | 포트 | 역할 | 마일스톤 |
|---|---|---|---|
| **ingest-daemon** (Python PyAV) | 7070 | 카메라 RTSP 수신 → JPEG 프레임 추출 → Node.js 전달 | 현재 |
| **MediaMTX** | 8554/8889/8189/9997 | RTSP 수신 → WebRTC WHEP 변환, 녹화 | 현재 |
| **Node.js 서버** | 3080/3443 | REST API, Socket.IO, AI 파이프라인 오케스트레이터 | 현재 |
| **MinIO** | 9000/9001 | 녹화 영상 S3 호환 오브젝트 스토리지 | M1 |
| **Qdrant** | 6333/6334 | 얼굴 임베딩 벡터 DB Re-ID | M3 |

---

## 포트 요구사항

| 서비스 | 프로토콜 | 포트 | 방화벽 오픈 여부 |
|---|---|---|---|
| Node.js HTTP | TCP | 3080 | 내부·외부 |
| Node.js HTTPS | TCP | 3443 | 내부·외부 |
| ingest-daemon | TCP | 7070 | 서버 내부 전용 |
| MediaMTX RTSP | TCP | 8554 | 카메라 네트워크 |
| MediaMTX WHEP | TCP | 8889 | 내부·외부 (WebRTC) |
| MediaMTX ICE UDP | UDP | 8189 | 내부·외부 (WebRTC 미디어) |
| MediaMTX API | TCP | 9997 | 서버 내부 전용 |
| MinIO API (M1) | TCP | 9000 | 서버 내부 전용 |
| MinIO Console (M1) | TCP | 9001 | 관리자 전용 |
| Qdrant REST (M3) | TCP | 6333 | 서버 내부 전용 |
| Qdrant gRPC (M3) | TCP | 6334 | 서버 내부 전용 |

```bash
# 방화벽 설정 (ufw 예시)
sudo ufw allow 3080/tcp    # HTTP API
sudo ufw allow 3443/tcp    # HTTPS API
sudo ufw allow 8889/tcp    # WHEP WebRTC
sudo ufw allow 8189/udp    # WebRTC ICE UDP
sudo ufw allow 8554/tcp    # RTSP (카메라 인바운드)
sudo ufw reload
```

---

## 현재 구현 운영 가이드

### 1. ingest-daemon 설치 및 시작

#### 1.1 Python 의존성 설치

```bash
# Python 3.9+ 필요
python3 --version

# PyAV 및 의존성 설치
pip install av requests

# 또는 requirements.txt 사용
cd /path/to/loitering_tracking
pip install -r ingest-daemon/requirements.txt
```

#### 1.2 ingest-daemon 시작

```bash
# Node.js 서버를 통한 ingest-daemon 시작 (권장)
cd server
npm run ingest:restart

# 직접 시작 (디버깅용)
cd ingest-daemon
python3 ingest_daemon.py
```

#### 1.3 ingest-daemon 환경변수 설정

`server/.env` 파일에 다음 값을 설정합니다:

```bash
CAPTURE_BACKEND=ingest-daemon
INGEST_DAEMON_URL=http://localhost:7070
INGEST_FRAME_TIMEOUT_MS=5000
```

#### 1.4 ingest-daemon 헬스체크

```bash
# 상태 확인
curl http://localhost:7070/api/ingest/status

# 활성 카메라 목록
curl http://localhost:7070/api/ingest/cameras

# 예상 응답
# { "status": "running", "activeCameras": ["cam-01", "cam-02"], "uptime": 3600 }
```

#### 1.5 ingest-daemon 중지 및 재시작

```bash
# 전체 서버 재시작 없이 ingest-daemon만 핫 재시작
cd server
npm run ingest:restart

# 강제 종료 후 재시작 (포트 충돌 시)
pkill -f ingest_daemon.py
sleep 2
npm run ingest:restart
```

---

### 2. MediaMTX 설정 및 시작

#### 2.1 MediaMTX 설치

```bash
# GitHub Release에서 최신 바이너리 다운로드
MEDIAMTX_VERSION="v0.23.8"
wget https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz
tar -xzf mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz
sudo mv mediamtx /usr/local/bin/mediamtx

# 버전 확인
mediamtx --version
```

#### 2.2 기본 mediamtx.yml 설정

프로젝트 루트의 `mediamtx.yml` 주요 설정:

```yaml
# HTTP API (경로 관리)
api: yes
apiAddress: :9997

# WebRTC WHEP
webrtcAddress: :8889
webrtcICEUDPMuxAddress: :8189

# RTSP 수신
rtspAddress: :8554

# 기본 경로 설정 (카메라별 경로는 API로 동적 등록)
paths:
  all_others:
    source: publisher
```

#### 2.3 MediaMTX 시작

```bash
# 프로젝트 루트에서 시작
cd /path/to/loitering_tracking
mediamtx mediamtx.yml

# 백그라운드 실행 (systemd 없이)
nohup mediamtx mediamtx.yml > /var/log/mediamtx.log 2>&1 &

# systemd 서비스로 등록 (프로덕션 권장)
sudo tee /etc/systemd/system/mediamtx.service > /dev/null <<EOF
[Unit]
Description=MediaMTX Media Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/loitering_tracking
ExecStart=/usr/local/bin/mediamtx mediamtx.yml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mediamtx
sudo systemctl start mediamtx
```

#### 2.4 MediaMTX 헬스체크

```bash
# API 상태 확인
curl http://localhost:9997/v3/paths/list

# 특정 카메라 경로 상태
curl http://localhost:9997/v3/paths/get/cam-01

# WHEP 연결 테스트 (SDP offer 전송)
# 브라우저에서 http://localhost:3080 접속 후 WebRTC 연결 확인
```

---

### 3. Node.js 서버 시작 (combined 모드)

```bash
cd server

# 개발 모드 (combined — 캡처+AI+WebRTC)
cp .env.example .env
# .env 파일 편집 후:
npm run dev

# 프로덕션 모드
npm run start

# 서버 중지
npm run stop
```

`server/.env` 필수 설정:

```bash
SERVER_MODE=combined
CAPTURE_BACKEND=ingest-daemon
WEBRTC_ENGINE=mediamtx
MEDIAMTX_API_URL=http://localhost:9997
MEDIAMTX_RTSP_URL=rtsp://localhost:8554
MEDIAMTX_WHEP_URL=http://localhost:8889
INGEST_DAEMON_URL=http://localhost:7070
```

---

## M1 — 영상 녹화 설치

### 4. MinIO 설치 (Docker)

```bash
# Docker Compose로 MinIO 시작
docker run -d \
  --name minio \
  --restart always \
  -p 9000:9000 \
  -p 9001:9001 \
  -v /data/minio:/data \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin123 \
  quay.io/minio/minio server /data --console-address ":9001"

# MinIO Client(mc) 설치 및 버킷 생성
wget https://dl.min.io/client/mc/release/linux-amd64/mc
chmod +x mc && sudo mv mc /usr/local/bin/mc

mc alias set lts http://localhost:9000 minioadmin minioadmin123
mc mb lts/lts-recordings
mc anonymous set none lts/lts-recordings   # private bucket

# 버킷 확인
mc ls lts/
```

### 5. mediamtx.yml 녹화 설정 추가

```yaml
# mediamtx.yml — 녹화 설정 추가
paths:
  all_others:
    source: publisher
    # 녹화 활성화
    record: yes
    recordSegmentDuration: 10m
    recordDeleteAfter: 0s    # 로컬 파일 유지 (0s = 삭제 안 함)
    recordPath: ./recordings/%path/%Y-%m-%d/%path_%Y-%m-%d_%H-%M-%S-%f.mp4
    # 세그먼트 완료 시 Node.js 훅 호출
    runOnRecordSegmentComplete: >-
      curl -s -X POST http://localhost:3080/api/recording/segment-complete
      -H "Content-Type: application/json"
      -d "{\"path\":\"$MTX_RECORD_PATH\",\"startMs\":$MTX_RECORD_START_TIME,\"endMs\":$MTX_RECORD_END_TIME}"
```

### 6. recordingService 환경변수 설정

`server/.env`에 추가:

```bash
# M1 — 영상 녹화
RECORDING_ENABLED=true
RECORD_SEGMENT_MINUTES=10
RECORDING_LOCAL_PATH=./recordings
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123
MINIO_BUCKET=lts-recordings
RECORDING_PRESIGNED_TTL_SECONDS=3600
```

### 7. 녹화 기능 헬스체크

```bash
# 녹화 목록 확인
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3080/api/recordings?camId=cam-01&limit=10"

# 특정 카메라 녹화 시작
curl -X POST -H "Authorization: Bearer <token>" \
  http://localhost:3080/api/recording/cam-01/start

# MinIO 버킷 내 파일 확인
mc ls lts/lts-recordings/cam-01/
```

---

## M2 — Playback 설정

### 8. Playback API 환경변수

`server/.env`에 추가:

```bash
# M2 — Playback
PLAYBACK_SEGMENTS_DEFAULT_LIMIT=100
PLAYBACK_SEGMENTS_MAX_LIMIT=500
PLAYBACK_ALERT_CLIP_SECONDS=30    # 알림 전후 클립 길이
```

### 9. Presigned URL 설정

```bash
# AWS S3를 MinIO 대신 사용하는 경우
MINIO_ENDPOINT=https://s3.amazonaws.com
MINIO_ACCESS_KEY=<AWS_ACCESS_KEY_ID>
MINIO_SECRET_KEY=<AWS_SECRET_ACCESS_KEY>
MINIO_BUCKET=your-bucket-name
MINIO_REGION=ap-northeast-2    # 사용 리전

# Presigned URL 유효기간 (보안 정책에 따라 조정)
RECORDING_PRESIGNED_TTL_SECONDS=7200   # 2시간
```

### 10. Playback API 검증

```bash
# 세그먼트 목록 조회
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3080/api/playback/segments?cam=cam-01&startTs=1749600000&endTs=1749686400"

# 특정 시점 재생 URL
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3080/api/playback?cam=cam-01&ts=1749612345"

# 알림 이벤트 재생
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3080/api/playback/event/<alertId>"
```

---

## M3 — Qdrant 설치

### 11. Qdrant Docker 시작

```bash
# Docker로 Qdrant 시작
docker run -d \
  --name qdrant \
  --restart always \
  -p 6333:6333 \
  -p 6334:6334 \
  -v /data/qdrant:/qdrant/storage \
  qdrant/qdrant:latest

# 또는 Docker Compose 사용
cat > docker-compose.qdrant.yml <<EOF
version: '3'
services:
  qdrant:
    image: qdrant/qdrant:latest
    restart: always
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - /data/qdrant:/qdrant/storage
    environment:
      - QDRANT__SERVICE__API_KEY=${QDRANT_API_KEY:-}
EOF

docker compose -f docker-compose.qdrant.yml up -d
```

### 12. Qdrant 헬스체크

```bash
# REST API 상태 확인
curl http://localhost:6333/healthz

# 컬렉션 목록 조회
curl http://localhost:6333/collections

# 예상 응답: { "result": { "collections": [] }, "status": "ok" }
```

### 13. faceService.js 전환 환경변수

`server/.env`에 추가:

```bash
# M3 — Qdrant Re-ID
REID_BACKEND=qdrant
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=                      # 인증 키 (없으면 빈칸)
QDRANT_COLLECTION=face_embeddings
FACE_EMBEDDING_DIM=512
FACE_REID_THRESHOLD=0.75
```

### 14. 기존 데이터 마이그레이션

```bash
# face_tracking.json → Qdrant 마이그레이션
# 실행 전 자동 백업됨 (storage/face_tracking.json.bak)
node server/src/scripts/migrateEmbeddingsToQdrant.js

# 마이그레이션 완료 확인
curl http://localhost:6333/collections/face_embeddings

# 폴백 테스트 (Qdrant 중지 시 인메모리 자동 전환 확인)
docker stop qdrant
curl http://localhost:3080/api/faces/search -X POST \
  -H "Content-Type: application/json" \
  -d '{"embedding": [...]}'
# 경고 로그: "[faceService] Qdrant unavailable, falling back to in-memory"
docker start qdrant
```

---

## HTTPS/TLS 설정

```bash
# TLS 인증서 경로 설정 (server/.env)
HTTPS_ENABLED=true
TLS_CERT_PATH=/etc/lts/certs/server.crt
TLS_KEY_PATH=/etc/lts/certs/server.key

# Let's Encrypt 사용 시
sudo certbot certonly --standalone -d yourdomain.com
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem /etc/lts/certs/server.crt
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem /etc/lts/certs/server.key
sudo chown $(whoami) /etc/lts/certs/*
```

TLS 상세 설정은 [HTTPS_TLS_Setup.md](HTTPS_TLS_Setup.md) 참조.

---

## 트러블슈팅

| 증상 | 원인 | 해결 방법 |
|---|---|---|
| WebRTC 영상이 표시되지 않음 | MediaMTX 미실행 또는 경로 미등록 | `curl http://localhost:9997/v3/paths/list` 확인, MediaMTX 재시작 |
| ingest-daemon 프레임 수신 0건 | ingest-daemon 미실행 또는 RTSP URL 오류 | `npm run ingest:restart`, `curl http://localhost:7070/api/ingest/status` |
| WHEP 연결 실패 (브라우저) | UDP 8189 포트 차단 | 방화벽 규칙 확인, `sudo ufw allow 8189/udp` |
| WebRTC ICE 연결 타임아웃 | STUN 서버 미설정 또는 NAT 문제 | `server/.env`에 `STUN_URLS` 설정, TURN 서버 추가 |
| 녹화 파일 생성 안 됨 (M1) | `mediamtx.yml` record 미설정 또는 `RECORDING_ENABLED=false` | `mediamtx.yml` record 설정 확인, 환경변수 확인 |
| MinIO 업로드 실패 (M1) | 자격증명 오류 또는 버킷 없음 | `mc ls lts/`, `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` 확인 |
| Presigned URL 접근 거부 (M2) | TTL 만료 또는 버킷 정책 | `RECORDING_PRESIGNED_TTL_SECONDS` 값 확인, MinIO 버킷 정책 확인 |
| Qdrant 연결 실패 (M3) | Qdrant 미실행 또는 포트 차단 | `docker ps | grep qdrant`, `curl http://localhost:6333/healthz` |
| 얼굴 Re-ID 정확도 저하 (M3) | `FACE_REID_THRESHOLD` 너무 높음 | 0.75 → 0.65로 낮추어 테스트 |
| MediaMTX API 경로 등록 실패 | MediaMTX API 미활성화 | `mediamtx.yml`에서 `api: yes` 확인 |
| ingest-daemon FORCE_NO_WEBRTC | `WEBRTC_ENGINE=mediasoup` 설정 오류 | `server/.env`에서 `WEBRTC_ENGINE=mediamtx` 확인 |

---

## 환경변수 전체 참조 (RWA 관련)

| 환경변수 | 기본값 | 마일스톤 | 설명 |
|---|---|---|---|
| `CAPTURE_BACKEND` | `ingest-daemon` | 현재 | 캡처 백엔드 선택 |
| `WEBRTC_ENGINE` | `mediamtx` | 현재 | WebRTC 엔진 선택 |
| `MEDIAMTX_API_URL` | `http://localhost:9997` | 현재 | MediaMTX REST API URL |
| `MEDIAMTX_RTSP_URL` | `rtsp://localhost:8554` | 현재 | MediaMTX RTSP URL |
| `MEDIAMTX_WHEP_URL` | `http://localhost:8889` | 현재 | MediaMTX WHEP URL |
| `INGEST_DAEMON_URL` | `http://localhost:7070` | 현재 | ingest-daemon 베이스 URL |
| `INGEST_FRAME_TIMEOUT_MS` | `5000` | 현재 | 프레임 수신 타임아웃(ms) |
| `RECORDING_ENABLED` | `false` | M1 | 녹화 기능 전역 활성화 |
| `RECORD_SEGMENT_MINUTES` | `10` | M1 | 녹화 세그먼트 길이(분) |
| `RECORDING_LOCAL_PATH` | `./recordings` | M1 | 로컬 임시 저장 경로 |
| `MINIO_ENDPOINT` | `http://localhost:9000` | M1 | MinIO 엔드포인트 |
| `MINIO_ACCESS_KEY` | — | M1 | MinIO 액세스 키 |
| `MINIO_SECRET_KEY` | — | M1 | MinIO 시크릿 키 |
| `MINIO_BUCKET` | `lts-recordings` | M1 | 녹화 저장 버킷명 |
| `MINIO_REGION` | `us-east-1` | M1 | S3 리전 (AWS S3 사용 시) |
| `RECORDING_PRESIGNED_TTL_SECONDS` | `3600` | M1 | Presigned URL 유효기간(초) |
| `REID_BACKEND` | `qdrant` | M3 | Re-ID 백엔드 (`qdrant` \| `memory`) |
| `QDRANT_URL` | `http://localhost:6333` | M3 | Qdrant REST API URL |
| `QDRANT_API_KEY` | — | M3 | Qdrant 인증 키 (선택) |
| `QDRANT_COLLECTION` | `face_embeddings` | M3 | 컬렉션명 |
| `FACE_EMBEDDING_DIM` | `512` | M3 | 임베딩 벡터 차원 |
| `FACE_REID_THRESHOLD` | `0.75` | M3 | Re-ID 유사도 임계값 |
| `RTCP_STATS_ENABLED` | `false` | M4 | RTCP 통계 폴링 활성화 |
| `RTCP_STATS_INTERVAL_MS` | `5000` | M4 | 폴링 주기(ms) |
| `RTCP_PLI_THRESHOLD` | `0.05` | M4 | PLI 트리거 패킷 손실률 |
| `RTCP_REMB_MIN_BITRATE_KBPS` | `500` | M4 | 최소 비트레이트(kbps) |
| `RTCP_REMB_MAX_BITRATE_KBPS` | `4000` | M4 | 최대 비트레이트(kbps) |
| `KAFKA_ENABLED` | `false` | M5 | Kafka 분산 파이프라인 활성화 |
| `KAFKA_BROKERS` | `localhost:9092` | M5 | Kafka 브로커 주소 |
| `KAFKA_RAW_FRAMES_TOPIC` | `raw-frames` | M5 | 원시 프레임 토픽명 |
| `KAFKA_RESULTS_TOPIC` | `analysis-results` | M5 | 분석 결과 토픽명 |
| `KAFKA_CONSUMER_GROUP` | `lts-analysis-workers` | M5 | 컨슈머 그룹 ID |

---

## 관련 문서

| 문서 | 경로 |
|---|---|
| PRD — RTSP·WebRTC Architecture | [prd/PRD_RTSP_WebRTC_Architecture.md](../prd/PRD_RTSP_WebRTC_Architecture.md) |
| SRS — RTSP·WebRTC Architecture | [srs/SRS_RTSP_WebRTC_Architecture.md](../srs/SRS_RTSP_WebRTC_Architecture.md) |
| Design — RTSP·WebRTC Architecture | [design/Design_RTSP_WebRTC_Architecture.md](../design/Design_RTSP_WebRTC_Architecture.md) |
| RTSP 캡처 백엔드 설치 가이드 | [RTSP_Capture_Backend_Setup.md](RTSP_Capture_Backend_Setup.md) |
| HTTPS/TLS 설정 가이드 | [HTTPS_TLS_Setup.md](HTTPS_TLS_Setup.md) |
| MongoDB 설정 가이드 | [MongoDB_Setup.md](MongoDB_Setup.md) |
| MCP 서버 설정 가이드 | [MCP_Server_Setup.md](MCP_Server_Setup.md) |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-11 | 초기 작성 — ingest-daemon, MediaMTX 운영 가이드 및 M1-M3 설치 절차 포함 |
