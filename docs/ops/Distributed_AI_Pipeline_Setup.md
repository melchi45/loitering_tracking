# Operations Guide
# Distributed AI Pipeline 설치 및 운영 가이드

| | |
|---|---|
| **Document Reference** | OPS-LTS-DAP-01 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026 Loitering Detection & Tracking System |
| **Issue Date** | 2026-06-08 |
| **Status** | Active |
| **Related Design** | [design/Design_Distributed_AI_Pipeline.md](../design/Design_Distributed_AI_Pipeline.md) |
| **Related SRS** | [srs/SRS_Distributed_AI_Pipeline.md](../srs/SRS_Distributed_AI_Pipeline.md) |

---

## 개요

LTS-2026의 Distributed AI Pipeline 기능은 `server/.env`의 `SERVER_MODE` 환경변수 하나로 서버 역할을 세 가지 중 하나로 선택합니다.

| 모드 | 역할 | 권장 하드웨어 |
|---|---|---|
| `combined` | 기본값 — 캡처·추론·스트리밍 모두 처리 | GPU 장착 단일 서버 |
| `streaming` | 카메라 캡처 + WebRTC 스트리밍 전담 | CPU 전용 서버 (다수 배치 가능) |
| `analysis` | AI 추론 전담 (YOLOv8 ONNX + ByteTracker + BehaviorEngine) | GPU 서버 (A100, RTX 계열) |

---

## Table of Contents

1. [사전 요구사항](#1-사전-요구사항)
2. [combined 모드 설정 (기본)](#2-combined-모드-설정-기본)
3. [streaming 서버 설정](#3-streaming-서버-설정)
4. [analysis 서버 설정](#4-analysis-서버-설정)
5. [환경변수 설정 참조](#5-환경변수-설정-참조)
6. [네트워크 요구사항](#6-네트워크-요구사항)
7. [Docker Compose를 이용한 분리 배포](#7-docker-compose를-이용한-분리-배포)
8. [모니터링 및 헬스체크](#8-모니터링-및-헬스체크)
9. [트러블슈팅](#9-트러블슈팅)

---

## 1. 사전 요구사항

### 1.1 공통

| 항목 | 최소 요구사항 |
|---|---|
| Node.js | 18.x LTS 이상 |
| npm | 9.x 이상 |
| ffmpeg | 3.4 이상 (`streaming` / `combined` 모드) |
| 디스크 | `/storage` 마운트 포인트 10GB 이상 (`combined` / `streaming` 모드) |

### 1.2 streaming 서버 추가 요구사항

| 항목 | 요구사항 |
|---|---|
| CPU | 8코어 이상 권장 (카메라당 1-2코어) |
| RAM | 8GB 이상 |
| 네트워크 | analysis 서버와 LAN 직결 (RTT < 5ms 권장) |
| ffmpeg | 필수 (RTSP 스트림 캡처용) |

### 1.3 analysis 서버 추가 요구사항

| 항목 | 요구사항 |
|---|---|
| GPU | NVIDIA GPU (ONNX CUDA 실행 시) — RTX 3070 이상 권장 |
| CUDA | 12.x 이상 (ONNX CUDA 사용 시) |
| RAM | 16GB 이상 |
| ONNX 모델 | `server/models/yolov8n.onnx` (또는 커스텀 모델) |

---

## 2. combined 모드 설정 (기본)

기존 설치 환경에서 `SERVER_MODE` 환경변수를 설정하지 않으면 자동으로 `combined` 모드로 동작합니다. **별도 설정이 필요 없습니다.**

### 2.1 .env 설정 확인

```dotenv
# server/.env
SERVER_MODE=combined  # 또는 이 줄을 아예 삭제해도 combined 모드로 동작
```

### 2.2 서버 시작

```bash
cd server
npm run dev      # 개발 모드
# 또는
npm start        # 프로덕션 모드
```

### 2.3 시작 확인

서버 로그에서 다음 출력을 확인합니다:

```
[Server] SERVER_MODE=combined | (all-in-one mode)
```

---

## 3. streaming 서버 설정

### 3.1 .env 파일 설정

```dotenv
# server/.env (스트리밍 서버)

# ── 분산 AI 파이프라인 ────────────────────────────────────────────────────────
SERVER_MODE=streaming

# analysis 서버 URL (필수)
ANALYSIS_SERVER_URL=http://192.168.1.200:3001

# 분석 요청 타임아웃 (ms) — 최악의 경우 추론 시간보다 크게 설정
# CPU 전용: 5000ms / GPU (RTX 3070+): 2000ms
ANALYSIS_REQUEST_TIMEOUT_MS=5000

# 최대 동시 분석 요청 수 — 카메라 수와 analysis 서버 GPU 용량을 고려하여 설정
# 카메라 8대 / GPU 1개: 4~8 권장
ANALYSIS_MAX_CONCURRENT=4

# 카메라당 analysis 서버 전송 fps 상한 (0 = unlimited, 권장)
# 0: latest-frame-wins 자동 조절 — 추론이 빨라지면 fps가 자동 증가
# N: 하드 캡 N fps — 대역폭/부하 제한이 필요한 환경에서 사용
ANALYSIS_FPS=0

# ── 카메라 캡처 ───────────────────────────────────────────────────────────────
CAPTURE_BACKEND=ffmpeg
CAPTURE_FPS=10
MAX_PIPELINES=8

# ── 서버 포트 ─────────────────────────────────────────────────────────────────
HTTP_PORT=3080
HTTPS_ENABLED=true
HTTPS_PORT=3443
```

### 3.2 서버 시작 및 확인

```bash
cd server
npm start
```

정상 시작 로그:
```
[Server] SERVER_MODE=streaming | ANALYSIS_SERVER_URL=http://192.168.1.200:3001
[Server] Express listening on port 3080
```

### 3.3 시작 실패 케이스

**ANALYSIS_SERVER_URL 미설정:**
```
[Server] ERROR: SERVER_MODE=streaming requires ANALYSIS_SERVER_URL to be set.
          Set ANALYSIS_SERVER_URL in server/.env and restart.
```

**해결 방법:**
```bash
echo "ANALYSIS_SERVER_URL=http://<analysis-server-ip>:3001" >> server/.env
```

### 3.4 streaming 서버에서 비활성화되는 기능

`streaming` 모드에서는 다음 기능이 비활성화됩니다:
- YOLOv8 ONNX 모델 로딩 (ONNX 라이브러리 미사용)
- ByteTracker / BehaviorEngine 로컬 실행
- AttributePipeline (PPE, 색상 분석)
- FireSmokeService

대신 이 기능들은 analysis 서버에서 처리되며, 결과는 `detections` Socket.IO 이벤트로 전달됩니다.

---

## 4. analysis 서버 설정

### 4.1 .env 파일 설정

```dotenv
# server/.env (분석 서버)

# ── 분산 AI 파이프라인 ────────────────────────────────────────────────────────
SERVER_MODE=analysis

# 최대 동시 추론 요청 수 (GPU 메모리에 따라 조정)
# RTX 3070 (8GB): 4~6 권장
# A100 (40GB): 8~16 가능
ANALYSIS_MAX_CONCURRENT=4

# ── AI 모델 ───────────────────────────────────────────────────────────────────
YOLO_MODEL=models/yolov8n.onnx
CONFIDENCE_THRESHOLD=0.45
NMS_IOU_THRESHOLD=0.5

# GPU 가속 (CUDA 가능 환경에서 1로 설정)
ONNX_CUDA=1
ONNX_THREADS_CUDA=1

# ── 서버 포트 ─────────────────────────────────────────────────────────────────
HTTP_PORT=3001
HTTPS_ENABLED=false   # 내부망 운영 시 HTTPS 불필요 (방화벽으로 외부 차단)

# ── 배회 감지 파라미터 ────────────────────────────────────────────────────────
LOITERING_THRESHOLD_SEC=30
MIN_DISPLACEMENT_PX=50
REENTRY_WINDOW_SEC=120
MAX_TRACK_AGE_FRAMES=30

# ── 데이터베이스 (analysis 서버는 DB 접근 최소화) ─────────────────────────────
DB_TYPE=json
```

### 4.2 ONNX 모델 파일 복사

analysis 서버에 YOLOv8 ONNX 모델 파일이 있어야 합니다.

```bash
# streaming 서버 또는 공유 스토리지에서 모델 파일 복사
scp user@streaming-server:/path/to/server/models/yolov8n.onnx \
    /path/to/analysis-server/server/models/yolov8n.onnx

# 또는 직접 변환 (yolov8s.pt → ONNX)
cd server
python3 -c "
from ultralytics import YOLO
model = YOLO('../yolov8s.pt')
model.export(format='onnx', imgsz=640)
"
```

### 4.3 서버 시작

```bash
cd server
npm start
```

정상 시작 로그:
```
[Server] SERVER_MODE=analysis | ANALYSIS_MAX_CONCURRENT=4
[DetectionService] ONNX model loaded: models/yolov8n.onnx
[DetectionService] Execution provider: cuda (ONNX_CUDA=1)
[Server] Express listening on port 3001
[analysisApi] POST /api/analysis/frame ready
[analysisApi] GET  /api/analysis/health ready
```

### 4.4 analysis 서버에서 비활성화되는 기능

`analysis` 모드에서는 다음이 비활성화됩니다:
- 카메라 RTSP 캡처 (ffmpeg 프로세스 미생성)
- WebRTC mediasoup SFU
- Socket.IO 스트림 이벤트 핸들러
- 카메라/구역/알림 REST API (선택적 활성화 가능)

---

## 5. 환경변수 설정 참조

### 5.1 신규 환경변수

| 변수 | 기본값 | 적용 모드 | 설명 |
|---|---|---|---|
| `SERVER_MODE` | `combined` | 전체 | 서버 운영 모드 (`combined` / `streaming` / `analysis`) |
| `ANALYSIS_SERVER_URL` | (없음) | `streaming` | analysis 서버 기본 URL (필수) |
| `ANALYSIS_REQUEST_TIMEOUT_MS` | `5000` | `streaming` | HTTP 요청 타임아웃 (밀리초). 최악의 경우 추론 시간보다 크게 설정 |
| `ANALYSIS_MAX_CONCURRENT` | `4` | `streaming`, `analysis` | 최대 동시 요청 수 |
| `ANALYSIS_FPS` | `0` | `streaming` | 카메라당 전송 fps 상한. `0` = unlimited (권장); `N > 0` = 하드 캡 |
| `FIRE_SMOKE_CONF_THRESHOLD` | `0.35` | `analysis`, `combined` | 화재/연기 감지 신뢰도 하한. 낮출수록 감도 증가, 오탐 증가 |
| `FIRE_SMOKE_NMS_THRESHOLD` | `0.45` | `analysis`, `combined` | 화재/연기 NMS IoU 임계값. 낮출수록 겹치는 박스 제거 강화 |

### 5.2 ANALYSIS_REQUEST_TIMEOUT_MS 권장값

| 환경 | 권장값 | 이유 |
|---|---|---|
| LAN (RTT < 1ms) + RTX 3070 | 2000ms | GPU 추론 ~100ms + 여유 |
| LAN (RTT < 1ms) + CPU 전용 | 5000ms (기본값) | CPU 추론 최대 ~1500ms (face+fire 활성 시) + 여유 |
| WAN 또는 고지연 네트워크 | 8000ms | 네트워크 지연 고려 |

> **주의:** 타임아웃이 너무 짧으면 (예: 100ms) ONNX 추론이 완료되기 전에 모든 요청이 실패하여
> 분석 클라이언트 circuit breaker가 작동하고 15초 동안 요청이 차단됩니다.
> 항상 실제 추론 시간(`/api/analysis/metrics`에서 `avgProcessingMs` 확인)보다 최소 3배 이상으로 설정하세요.

### 5.4 ANALYSIS_FPS 권장값

| 환경 | 권장값 | 이유 |
|---|---|---|
| 로컬 LAN + GPU 서버 | `0` (unlimited) | 추론 속도가 자동으로 처리량 결정 |
| 로컬 LAN + CPU 전용, face 활성 | `0` (unlimited) | 0.7~1.8fps 수준에서 자동 수렴 |
| 원격 WAN 연결 | `1` ~ `2` | 대역폭 절감 (frame당 ~50-200KB) |
| 부하 테스트 / 시뮬레이션 | `1` | 재현 가능한 고정 부하 확인 |

### 5.5 FIRE_SMOKE_CONF_THRESHOLD 감도 조정 가이드

| 값 | 감도 | 적합 상황 |
|---|---|---|
| `0.50` 이상 | 낮음 | 직접 연소, 짙은 연기 등 명확한 경우만 감지 |
| `0.35` (기본값) | 보통 | 대부분의 실외 CCTV 환경 |
| `0.20` | 높음 | 초기 단계 화재, 옅은 연기, 역광·야간 환경 |
| `0.10` | 매우 높음 | 최대 감도. 오탐 비율 높아짐; 운영 전 검증 필수 |

> **설정 예시 (`server/.env`):**
> ```env
> # 감도를 높여 초기 연기도 감지
> FIRE_SMOKE_CONF_THRESHOLD=0.20
> FIRE_SMOKE_NMS_THRESHOLD=0.45
> ```
>
> 변경 후 **analysis 서버만 재시작**하면 됩니다. 로그에서 다음처럼 확인:
> ```
> [FireSmokeService] yolov8s_fire_smoke.onnx loaded (conf=0.2 nms=0.45)
> ```

### 5.6 런타임 감도 조정 — Dashboard UI

`FIRE_SMOKE_CONF_THRESHOLD` / `FIRE_SMOKE_NMS_THRESHOLD` 환경변수 외에도, analysis 서버 실행 중 **재시작 없이** 대시보드 UI에서 임계값을 실시간으로 변경할 수 있습니다.

**경로:** Dashboard 우측 Analytics 탭 → **🔥 Fire / Smoke Sensitivity** 패널 (접이식)

| 항목 | 값 범위 | 기본값 |
|---|---|---|
| Conf Threshold | 0.05 ~ 0.95 (스텝 0.05) | 0.35 |
| NMS IoU Threshold | 0.10 ~ 0.90 (스텝 0.05) | 0.45 |

- 슬라이더를 움직이면 300ms debounce 후 `PATCH /api/analysis/config/fire-smoke` 자동 저장
- "Reset Defaults" 버튼으로 기본값(0.35 / 0.45) 복원
- `analysis` 또는 `combined` 모드에서만 패널이 표시됨 (`available: false` 시 숨김)
- **주의:** 런타임 변경값은 서버 재시작 시 초기화됨 → 영구 적용은 `.env` 수정 필요

**API 상세:**
```http
GET /api/analysis/config/fire-smoke
→ { "confThreshold": 0.35, "nmsThreshold": 0.45, "available": true }

PATCH /api/analysis/config/fire-smoke
Content-Type: application/json
{ "confThreshold": 0.20 }
→ { "confThreshold": 0.20, "nmsThreshold": 0.45 }
```

### 5.3 ANALYSIS_MAX_CONCURRENT 권장값

| GPU 모델 | 카메라 수 | 권장값 |
|---|---|---|
| RTX 3070 / RTX 4070 | 4-8대 | 4 |
| RTX 4090 | 8-16대 | 8 |
| A100 40GB | 16-32대 | 16 |
| CPU 전용 (16코어) | 4대 | 2 |

---

## 6. 네트워크 요구사항

### 6.1 포트 개방 (방화벽 설정)

**streaming 서버:**

| 포트 | 프로토콜 | 방향 | 용도 |
|---|---|---|---|
| 3080 | TCP | 외부 → 서버 | HTTP API + Socket.IO (WebRTC 미사용 시) |
| 3443 | TCP | 외부 → 서버 | HTTPS API + Socket.IO |
| 40000-49999 | UDP | 외부 ↔ 서버 | mediasoup WebRTC RTP (WebRTC 사용 시) |
| 3001 (외부 차단) | TCP | 서버 → analysis | 분석 서버 HTTP 요청 (내부망 전용) |

**analysis 서버:**

| 포트 | 프로토콜 | 방향 | 용도 |
|---|---|---|---|
| 3001 | TCP | streaming 서버 → 서버 | `/api/analysis/frame`, `/api/analysis/health` |
| 3001 (외부 차단) | TCP | 외부 → 차단 | 외부에서 직접 접근 금지 (방화벽 필수) |

### 6.2 방화벽 설정 예시 (Ubuntu ufw)

**analysis 서버에서 실행:**
```bash
# streaming 서버 IP에서만 3001 포트 접근 허용
sudo ufw allow from 192.168.1.100 to any port 3001 proto tcp

# 외부에서 3001 직접 접근 차단 (기본 deny)
sudo ufw deny 3001

sudo ufw enable
sudo ufw status verbose
```

**streaming 서버에서 실행:**
```bash
# 브라우저 클라이언트 접근 허용
sudo ufw allow 3443/tcp
sudo ufw allow 40000:49999/udp  # WebRTC RTP

# analysis 서버 방향 아웃바운드는 기본 허용
sudo ufw enable
```

### 6.3 네트워크 레이턴시 권장사항

- streaming ↔ analysis 서버 간 RTT: **5ms 이하 권장**
- 10ms 이상 RTT 환경에서는 `ANALYSIS_REQUEST_TIMEOUT_MS`를 10,000ms 이상으로 증가 필요
- 동일 랙(rack) 또는 동일 스위치에 배치 권장

---

## 7. Docker Compose를 이용한 분리 배포

### 7.1 디렉토리 구조

```
loitering_tracking/
├── docker-compose.yml          # combined 모드 (기존)
├── docker-compose.streaming.yml   # streaming 서버용
└── docker-compose.analysis.yml    # analysis 서버용
```

### 7.2 streaming 서버 docker-compose.streaming.yml

```yaml
version: '3.8'
services:
  lts-streaming:
    build:
      context: ./server
      dockerfile: Dockerfile
    environment:
      SERVER_MODE: streaming
      ANALYSIS_SERVER_URL: http://lts-analysis:3001
      ANALYSIS_REQUEST_TIMEOUT_MS: 5000
      ANALYSIS_MAX_CONCURRENT: 4
      HTTP_PORT: 3080
      HTTPS_ENABLED: "true"
      HTTPS_PORT: 3443
      CAPTURE_BACKEND: ffmpeg
      CAPTURE_FPS: 10
    ports:
      - "3080:3080"
      - "3443:3443"
      - "40000-49999:40000-49999/udp"
    volumes:
      - ./storage:/app/storage
      - ./server/certs:/app/certs:ro
      - ./server/.env.streaming:/app/.env:ro
    networks:
      - lts-internal
    restart: unless-stopped

networks:
  lts-internal:
    driver: bridge
```

### 7.3 analysis 서버 docker-compose.analysis.yml

```yaml
version: '3.8'
services:
  lts-analysis:
    build:
      context: ./server
      dockerfile: Dockerfile.analysis
    environment:
      SERVER_MODE: analysis
      ANALYSIS_MAX_CONCURRENT: 4
      HTTP_PORT: 3001
      HTTPS_ENABLED: "false"
      ONNX_CUDA: "1"
      YOLO_MODEL: models/yolov8n.onnx
    ports:
      - "127.0.0.1:3001:3001"   # 외부 노출 금지 (loopback만)
    volumes:
      - ./server/models:/app/models:ro
      - ./server/.env.analysis:/app/.env:ro
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    networks:
      - lts-internal
    restart: unless-stopped

networks:
  lts-internal:
    driver: bridge
```

### 7.4 배포 명령어

```bash
# streaming 서버 배포
docker compose -f docker-compose.streaming.yml up -d

# analysis 서버 배포 (GPU 서버에서)
docker compose -f docker-compose.analysis.yml up -d

# 로그 확인
docker compose -f docker-compose.streaming.yml logs -f lts-streaming
docker compose -f docker-compose.analysis.yml logs -f lts-analysis

# 서비스 재빌드 및 재시작
docker compose -f docker-compose.analysis.yml build lts-analysis
docker compose -f docker-compose.analysis.yml up -d lts-analysis
```

---

## 8. 모니터링 및 헬스체크

### 8.1 헬스 엔드포인트

**analysis 서버 헬스 조회:**

```bash
curl http://192.168.1.200:3001/api/analysis/health
```

응답 예시:
```json
{
  "status": "ok",
  "mode": "analysis",
  "activeCameras": 4,
  "concurrentRequests": 2,
  "maxConcurrent": 4,
  "processedFrames": 48320,
  "droppedFrames": 12,
  "timeoutFrames": 0,
  "uptime": 7200
}
```

**streaming 서버 분석 클라이언트 통계 조회:**

```bash
curl http://localhost:3080/api/analysis/health
```

응답 예시:
```json
{
  "status": "ok",
  "mode": "streaming",
  "analysisServerUrl": "http://192.168.1.200:3001",
  "concurrentRequests": 1,
  "maxConcurrent": 4,
  "sentFrames": 52800,
  "droppedFrames": 5,
  "timeoutFrames": 2,
  "errorFrames": 0
}
```

### 8.2 주요 모니터링 지표

| 지표 | 위치 | 경고 기준 | 조치 |
|---|---|---|---|
| `droppedFrames` | analysis 서버 / streaming 서버 | 전체 프레임의 5% 초과 | `ANALYSIS_MAX_CONCURRENT` 증가 또는 analysis 서버 추가 |
| `timeoutFrames` | streaming 서버 | 전체 프레임의 1% 초과 | `ANALYSIS_REQUEST_TIMEOUT_MS` 증가 또는 analysis 서버 성능 점검 |
| `concurrentRequests` | analysis 서버 | `maxConcurrent`의 90% 도달 | 스케일업 검토 |
| `activeCameras` | analysis 서버 | 0 (카메라 있는데 0) | streaming 서버 연결 확인 |

### 8.3 로그 모니터링

**streaming 서버 로그 패턴:**

```
# 정상 (분석 요청 성공)
[AnalysisClient] Frame cam-01#1234 analyzed in 87ms

# 백프레셔 (드롭, 연속 10개마다 1회 출력)
[AnalysisClient] Backpressure: dropped 10 frames (concurrentRequests=4/4)

# 연결 실패 (graceful degradation)
[AnalysisClient] warn: Frame cam-01#1236 dropped — ECONNREFUSED http://192.168.1.200:3001

# 타임아웃
[AnalysisClient] warn: Frame cam-01#1240 dropped — timeout after 5000ms
```

**analysis 서버 로그 패턴:**

```
# 정상 추론
[analysisApi] cam-01 frame#1234: 3 detections, 2 tracked, 1 behavior (82ms)

# 컨텍스트 정리
[analysisApi] Cleaned up context for camera cam-02 (inactive 5m)

# 503 백프레셔
[analysisApi] 503 Backpressure: concurrentRequests=4/4 for cam-03 frame#999
```

### 8.4 정기 헬스체크 스크립트

```bash
#!/bin/bash
# health_check.sh — cron으로 5분마다 실행

ANALYSIS_URL="http://192.168.1.200:3001/api/analysis/health"
STREAMING_URL="http://localhost:3080/api/analysis/health"
ALERT_EMAIL="admin@example.com"

check_health() {
  local url=$1
  local name=$2
  local response
  response=$(curl -s --max-time 5 "$url" 2>/dev/null)
  
  if [ $? -ne 0 ]; then
    echo "[$name] HEALTH CHECK FAILED — no response" | mail -s "LTS-2026 Alert: $name down" "$ALERT_EMAIL"
    return 1
  fi
  
  local dropped
  dropped=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('droppedFrames', 0))")
  local processed
  processed=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('processedFrames', 1))")
  
  local drop_rate
  drop_rate=$(python3 -c "print($dropped / max($processed, 1) * 100)")
  
  echo "[$name] status=ok, dropped=${dropped}, rate=${drop_rate}%"
  
  if (( $(echo "$drop_rate > 5" | bc -l) )); then
    echo "[$name] WARNING: drop rate ${drop_rate}% > 5%" | mail -s "LTS-2026 Warning: $name high drop rate" "$ALERT_EMAIL"
  fi
}

check_health "$ANALYSIS_URL" "analysis-server"
check_health "$STREAMING_URL" "streaming-server"
```

---

## 9. 트러블슈팅

### 9.1 서버 시작 실패

**증상:** `SERVER_MODE=streaming`으로 시작 시 즉시 종료

```
[Server] ERROR: SERVER_MODE=streaming requires ANALYSIS_SERVER_URL to be set.
```

**해결:**
```bash
# server/.env에 추가
echo "ANALYSIS_SERVER_URL=http://<analysis-server-ip>:3001" >> server/.env
```

---

**증상:** `SERVER_MODE=invalid_value`로 시작 시 종료

```
[Server] ERROR: Invalid SERVER_MODE: "invalid_value". Must be one of: combined, streaming, analysis
```

**해결:**
```bash
# server/.env 수정
sed -i 's/SERVER_MODE=.*/SERVER_MODE=combined/' server/.env
```

---

### 9.2 analysis 서버 연결 실패

**증상:** streaming 서버 로그에서 반복적으로 ECONNREFUSED 출력

```
[AnalysisClient] warn: Frame cam-01#xxx dropped — ECONNREFUSED http://192.168.1.200:3001
```

**원인 및 해결:**

```bash
# 1. analysis 서버 실행 여부 확인
ssh user@192.168.1.200 "ps aux | grep node"

# 2. analysis 서버 포트 수신 확인
ssh user@192.168.1.200 "ss -tlnp | grep 3001"

# 3. 방화벽 확인 (streaming 서버에서 실행)
nc -zv 192.168.1.200 3001

# 4. analysis 서버 재시작
ssh user@192.168.1.200 "cd /path/to/server && npm start"
```

---

### 9.3 프레임 드롭 비율이 높음

**증상:** `health` API에서 `droppedFrames`가 지속적으로 증가

**원인 1: ANALYSIS_MAX_CONCURRENT가 너무 낮음**
```bash
# streaming 서버 .env 수정
ANALYSIS_MAX_CONCURRENT=8  # 4에서 8로 증가

# 재시작 필요
npm restart
```

**원인 2: analysis 서버 처리 속도 부족 (GPU 과부하)**
```bash
# analysis 서버에서 GPU 사용률 확인
nvidia-smi -l 1

# 처리 속도 확인
curl http://192.168.1.200:3001/api/analysis/health | python3 -m json.tool

# CAPTURE_FPS를 줄여 프레임 입력 감소
# streaming 서버 .env:
CAPTURE_FPS=5  # 10에서 5로 감소
```

**원인 3: 네트워크 레이턴시 과다**
```bash
# streaming → analysis 레이턴시 측정
ping -c 20 192.168.1.200

# ANALYSIS_REQUEST_TIMEOUT_MS 증가
ANALYSIS_REQUEST_TIMEOUT_MS=8000
```

---

### 9.4 tracker objectId가 리셋됨 (분석 서버 재시작 시)

**증상:** analysis 서버 재시작 후 objectId가 1번부터 재시작, 배회 시간 초기화

**원인:** analysis 서버는 per-camera 컨텍스트를 **메모리**에만 저장합니다. 재시작 시 컨텍스트가 소실됩니다.

**해결:**

이는 현재 설계의 의도된 동작입니다. analysis 서버 재시작 직후에는 다음 현상이 일시적으로 발생합니다:
- 배회 중인 인물의 dwell time 초기화
- objectId 재시작으로 추적 연속성 단절

**완화 방법:**
1. analysis 서버를 재시작할 때는 **카메라 활동이 낮은 시간대** 선택
2. analysis 서버를 **rolling restart** 방식으로 교체 (Blue/Green 배포)
3. `combined` 모드로 일시 전환 후 재시작 → 다시 분리 모드로 전환

---

### 9.5 analysis 서버 메모리 증가

**증상:** analysis 서버의 메모리 사용량이 시간이 지날수록 계속 증가

**진단:**
```bash
# analysis 서버에서 실행
curl http://localhost:3001/api/analysis/health | python3 -c "
import sys, json
h = json.load(sys.stdin)
print(f'activeCameras: {h[\"activeCameras\"]}')
"
```

**원인:** `activeCameras`가 계속 증가하는 경우 컨텍스트 정리 타이머가 정상 동작하지 않거나, 카메라 수가 너무 많은 경우입니다.

**해결:**
```bash
# analysis 서버 재시작으로 메모리 초기화
npm restart

# 장기적으로: analysis 서버가 처리하는 카메라 수 확인
# streaming 서버의 카메라 수 = analysis 서버의 activeCameras (정상)
```

---

### 9.6 combined 모드에서 기존 기능 동작 안 함

**증상:** `combined` 모드로 설정했는데 `/api/analysis/frame`이 404 반환

```
GET /api/analysis/frame → 404 Not Found
```

**해결:** 이것은 **정상 동작**입니다. `combined` 모드에서는 분석 엔드포인트가 등록되지 않습니다. `analysis` 모드에서만 해당 엔드포인트가 활성화됩니다.

---

### 9.7 ONNX CUDA 오류 (analysis 서버)

**증상:** analysis 서버 시작 시 ONNX CUDA 관련 오류

```
[DetectionService] CUDA provider load failed — falling back to CPU
```

**해결:**
```bash
# CUDA 버전 확인
nvcc --version
nvidia-smi

# ONNX_CUDA 비활성화 (CPU 모드로 폴백)
# server/.env:
ONNX_CUDA=0

# 또는 ONNX Runtime CUDA 버전 재설치
cd server
npm uninstall onnxruntime-node
ONNXRUNTIME_NODE_BUILD_FROM_SOURCE=1 npm install onnxruntime-node
```

ONNX Runtime CUDA 설치에 대한 자세한 내용은 [ONNX_Runtime_Provider_Diagnostics.md](ONNX_Runtime_Provider_Diagnostics.md) 참조.

---

### 9.8 화재/연기 감지가 작동하지 않음

**증상:** analyticsConfig에서 `fire` / `smoke`가 활성화되어 있고 영상에 화재·연기가 있음에도 감지 결과가 없음.

**원인 1 — 신뢰도 임계값(`CONF_THRESHOLD`) 초과**

모델이 화재를 감지했더라도 confidence 점수가 기본값 `0.35` 미만이면 결과에서 제외됩니다. 역광, 야간, 초기 단계 연기, 소규모 화원에서 주로 발생합니다.

**해결:** `FIRE_SMOKE_CONF_THRESHOLD`를 낮춰 감도를 높입니다.

```env
# server/.env (analysis 서버 또는 combined 서버)
FIRE_SMOKE_CONF_THRESHOLD=0.20   # 기본값 0.35 → 감도 상향
```

설정 적용 확인 (서버 재시작 후 로그):
```
[FireSmokeService] yolov8s_fire_smoke.onnx loaded (conf=0.2 nms=0.45)
```

**원인 2 — 모델 파일 누락**

```
[FireSmokeService] yolov8s_fire_smoke.onnx not found — fire/smoke detection disabled
```

모델 파일이 `server/models/yolov8s_fire_smoke.onnx`에 없으면 서비스 자체가 비활성화됩니다. [Design_AI_Fire_Smoke_Detection.md](../design/Design_AI_Fire_Smoke_Detection.md)의 모델 다운로드 절차를 참조하세요.

**원인 3 — analyticsConfig `smoke` 키 비활성**

`/api/analysis/metrics` 응답의 `modules.enabled` 배열에 `fire` 또는 `smoke`가 포함되어 있는지 확인합니다. 포함되지 않았다면 대시보드의 Analytics 탭에서 활성화하세요.

---

### 9.9 analysis 서버에 `BadRequestError: request aborted` 반복 출력

**증상:**
```
[Express] Unhandled error: BadRequestError: request aborted
  code: 'ECONNABORTED', expected: 56945, received: 16044
```

**원인:** streaming 서버가 JPEG 바디를 전송하는 도중 `ANALYSIS_REQUEST_TIMEOUT_MS` 타임아웃이 만료되어 소켓을 `destroy()`합니다. analysis 서버의 `express.raw()` body 파서가 이를 에러(`ECONNABORTED`)로 감지하고 `next(err)`를 호출하는데, 에러 핸들러가 없어서 Express 전역 에러로 올라갑니다.

이 에러는 **기능상 무해**합니다. streaming 서버가 이미 연결을 끊었으므로 해당 프레임 결과를 보낼 수 없고, 다음 프레임에서 정상 재개됩니다.

**해결 (코드 수정 적용됨 — 별도 설정 불필요):**  
`analysisApi.js`의 `_parseFrameBody` 미들웨어에서 `ECONNABORTED` / `request.aborted` 에러를 감지하면 로그 없이 조용히 드롭합니다. `_metrics.errorsTotal`에만 카운트됩니다.

**재발 빈도를 줄이려면:**  
`ANALYSIS_REQUEST_TIMEOUT_MS`를 늘려 streaming 서버가 body 전송을 완료할 충분한 시간을 줍니다.

```env
# server/.env (streaming 서버)
ANALYSIS_REQUEST_TIMEOUT_MS=8000   # 네트워크가 느리거나 프레임이 큰 경우
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-08 | 초기 작성 — 분산 AI 파이프라인 설정 가이드 |
| 1.1 | 2026-06-10 | 환경변수 표에 `FIRE_SMOKE_CONF_THRESHOLD`, `FIRE_SMOKE_NMS_THRESHOLD` 추가; 섹션 5.5 감도 조정 가이드 추가; 섹션 9.8 화재/연기 트러블슈팅 추가 |
| 1.2 | 2026-06-10 | 섹션 9.9 추가: `ECONNABORTED` / `request aborted` 반복 에러 원인 및 해결 |
| 1.3 | 2026-06-10 | 섹션 5.6 추가: Dashboard UI 런타임 감도 조정, `/api/analysis/config/fire-smoke` 엔드포인트; fireSmokeService 임계값 인스턴스 프로퍼티화 |
