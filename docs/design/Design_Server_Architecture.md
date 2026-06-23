# DESIGN DOCUMENT
# LTS-2026 Server Architecture

| | |
|---|---|
| **Document ID** | DESIGN-LTS-SA-01 |
| **Version** | 1.5 |
| **Status** | Active |
| **Date** | 2026-06-11 |
| **Author** | LTS-2026 Engineering |

---

## Table of Contents

1. [Overview](#1-overview)
2. [전체 시스템 아키텍처 (Mermaid)](#2-전체-시스템-아키텍처-mermaid)
3. [서버 모드 상세](#3-서버-모드-상세)
   - 3.1 [combined 모드](#31-combined-모드)
   - 3.2 [streaming 모드](#32-streaming-모드)
   - 3.3 [analysis 모드](#33-analysis-모드)
4. [DB 서버 아키텍처](#4-db-서버-아키텍처)
5. [MCP 서버 아키텍처](#5-mcp-서버-아키텍처)
6. [배포 시나리오](#6-배포-시나리오)
   - 6.1 [단일 서버 (combined)](#61-단일-서버-combined)
   - 6.2 [분산 배포 (streaming + analysis)](#62-분산-배포-streaming--analysis)
   - 6.3 [MongoDB 별도 서버](#63-mongodb-별도-서버)
   - 6.4 [MCP 서버 연동](#64-mcp-서버-연동)
   - 6.5 [Full 분산 (모든 컴포넌트 분리)](#65-full-분산-모든-컴포넌트-분리)
7. [환경변수 요약](#7-환경변수-요약)
8. [포트 요약](#8-포트-요약)
9. [모드별 기능 매트릭스](#9-모드별-기능-매트릭스)

---

## 1. Overview

LTS-2026 Node.js 서버는 **`SERVER_MODE`** 환경변수 하나로 역할을 바꿀 수 있는 **단일 바이너리, 다중 역할(Multi-Role)** 설계입니다.

| 모드 | 역할 | 주요 사용 사례 |
|---|---|---|
| `combined` | 캡처 + AI + WebRTC + REST | 단일 서버 개발/소규모 배포 |
| `streaming` | 캡처 + WebRTC (AI 없음) | 카메라 현장 서버 — GPU 없는 엣지 노드 |
| `analysis` | AI 추론만 (캡처 없음) | GPU 서버 — 여러 streaming 서버 수용 |

```
SERVER_MODE=combined   → 올인원 (기본값)
SERVER_MODE=streaming  → 현장 캡처 서버
SERVER_MODE=analysis   → AI GPU 서버
```

npm 스크립트:

```bash
npm run dev              # combined, .env
npm run dev:streaming    # streaming, .env_streaming
npm run dev:analysis     # analysis, .env_analysis
npm run start            # combined (production)
npm run streaming        # streaming (production)
npm run analysis         # analysis (production)
```

---

## 2. 전체 시스템 아키텍처 (Mermaid)

아래 다이어그램은 LTS-2026의 모든 컴포넌트와 통신 경로를 나타냅니다.  
실제 배포에서는 일부 컴포넌트만 가동됩니다 (배포 시나리오 참조).

```mermaid
graph TB
    subgraph Cameras["IP 카메라 / 스트림 소스"]
        CAM1[IP Camera 1\nRTSP/ONVIF]
        CAM2[IP Camera 2\nRTSP/ONVIF]
        YT[YouTube Live\nyt-dlp]
    end

    subgraph EdgeNode["현장 서버 (streaming mode / combined mode)"]
        direction TB
        MEDIAMTX[MediaMTX\n:8554 RTSP\n:8889 WHEP HTTP\n:8189 ICE UDP\n:9997 REST API]
        STREAMING_SRV["Node.js\nSERVER_MODE=streaming\n:3443 HTTPS / :3080 HTTP"]
        subgraph StreamingSvc["streaming 전용 서비스"]
            RTSP_CAP[RTSPCapture\n+CaptureBackend\n10 FPS JPEG]
            YOUTUBE_SVC[YouTubeStreamService\nyt-dlp → MediaMTX]
            WHEP_PROXY[WHEP Proxy\n/api/webrtc/whep/:id]
            ANALYSIS_PROXY[AnalysisProxy\n/api/analysis/*]
        end
    end

    subgraph AINode["AI 분석 서버 (analysis mode / combined mode)"]
        direction TB
        ANALYSIS_SRV["Node.js\nSERVER_MODE=analysis\n:3443 HTTPS"]
        subgraph AISvc["analysis 전용 서비스"]
            PIPELINE[PipelineManager\n로컬 AI 추론]
            YOLO[YOLOv8 ONNX\n640×640]
            BYTETRACK[ByteTrack\n+KalmanFilter]
            BEHAVIOR[BehaviorEngine\n배회 점수]
            ATTR[AttributePipeline\n의상·PPE·얼굴]
            FIRE[FireSmokeService]
        end
        ANALYSIS_API[POST /api/analysis/frame\nGET  /api/analysis/metrics\nGET  /api/analysis/health]
    end

    subgraph DBLayer["DB 레이어"]
        JSON_DB[(lts.json\n로컬 JSON)]
        MONGO[(MongoDB Atlas\n또는 standalone)]
    end

    subgraph MCPLayer["MCP 서버 (선택)"]
        MCP_SRV[mcp-server\nstdio / HTTP+SSE]
        MCP_TOOLS["10 MCP Tools\n(query, alerts, zones …)"]
    end

    subgraph Clients["클라이언트"]
        BROWSER[Browser\nReact SPA]
        CLAUDE[Claude / LLM\nMCP Client]
    end

    %% Camera → MediaMTX
    CAM1 -- RTSP --> MEDIAMTX
    CAM2 -- RTSP --> MEDIAMTX
    YT -- RTSP re-publish --> MEDIAMTX

    %% MediaMTX → Streaming Server
    MEDIAMTX -- RTSP re-publish\n:8554 --> RTSP_CAP
    MEDIAMTX -- snapshot API\n:9997 --> RTSP_CAP

    %% Streaming Server internals
    STREAMING_SRV --> StreamingSvc
    RTSP_CAP -- JPEG frames --> PIPELINE
    YOUTUBE_SVC --> MEDIAMTX

    %% Streaming → Analysis
    STREAMING_SRV -- "POST /api/analysis/frame\n(JPEG + metadata)" --> ANALYSIS_SRV

    %% Analysis Server internals
    ANALYSIS_SRV --> AISvc
    PIPELINE --> YOLO
    PIPELINE --> BYTETRACK
    PIPELINE --> BEHAVIOR
    PIPELINE --> ATTR
    PIPELINE --> FIRE
    ANALYSIS_SRV --> ANALYSIS_API

    %% Analysis → Streaming (results)
    ANALYSIS_SRV -- "JSON results\n(detections, alerts)" --> STREAMING_SRV

    %% Proxy
    ANALYSIS_PROXY -- "GET metrics/health" --> ANALYSIS_SRV

    %% DB
    STREAMING_SRV -- "read/write" --> JSON_DB
    ANALYSIS_SRV  -- "read/write" --> JSON_DB
    JSON_DB -- "write-through" --> MONGO

    %% WebRTC
    WHEP_PROXY -- "SDP offer/answer" --> MEDIAMTX
    BROWSER -- "ICE UDP :8189" --> MEDIAMTX

    %% Clients
    BROWSER -- "HTTPS REST + Socket.IO" --> STREAMING_SRV
    BROWSER -- "WHEP\nPOST /api/webrtc/whep/:id" --> WHEP_PROXY

    %% MCP
    MCP_SRV --> MCP_TOOLS
    MCP_SRV -- "HTTP REST" --> STREAMING_SRV
    CLAUDE -- "MCP Protocol\nstdio/HTTP+SSE" --> MCP_SRV
```

---

## 3. 서버 모드 상세

### 3.1 combined 모드

**`SERVER_MODE=combined`** (기본값) — 모든 기능을 하나의 Node.js 프로세스에서 실행합니다.

```mermaid
graph LR
    CAM[IP Camera\nRTSP] --> MEDIAMTX[MediaMTX]
    MEDIAMTX --> CAP[RTSPCapture\n10 FPS JPEG]
    CAP --> PM[PipelineManager]
    PM --> YOLO[YOLOv8]
    PM --> TRACKER[ByteTrack]
    PM --> BEHAVIOR[BehaviorEngine]
    PM --> ATTR[AttributePipeline]
    PM -- "Socket.IO frameData" --> BROWSER[Browser]
    MEDIAMTX -- "ICE UDP :8189" --> BROWSER
    BROWSER -- "WHEP /api/webrtc/whep/:id" --> SRV[Node.js :3443]
    SRV -- "WHEP 프록시" --> MEDIAMTX
    SRV -- "REST API" --> BROWSER
    SRV -- read/write --> DB[(lts.json\n/ MongoDB)]
```

**활성화 서비스:**

| 서비스 | 활성 여부 |
|---|---|
| CaptureBackend (ingest-daemon/gstreamer/ffmpeg/pyav) | ✅ |
| PipelineManager (AI 추론) | ✅ |
| analysisApi 마운트 | ✅ (`/api/analysis/*`) |
| analysisProxy 마운트 | ❌ |
| analysisClient (원격 전송) | ❌ |
| DiscoveryService (ONVIF) | ✅ |
| YouTubeStreamService | ✅ |
| WebRTC WHEP 프록시 | ✅ |
| 카메라 자동 시작 | ✅ (5 s 지연) |
| ONNX 모델 eager 로딩 | ✅ (3 s 지연) |

**시작 명령:**
```bash
# 개발
npm run dev
# 프로덕션
npm run start
```

---

### 3.2 streaming 모드

**`SERVER_MODE=streaming`** — 현장 카메라 캡처 서버. AI 추론 없이 프레임을 원격 analysis 서버로 전달합니다.

```mermaid
sequenceDiagram
    participant CAM as IP Camera
    participant MTX as MediaMTX
    participant CAP as RTSPCapture
    participant STR as Streaming Server
    participant ANL as Analysis Server
    participant BR as Browser

    CAM->>MTX: RTSP stream
    MTX->>CAP: RTSP re-publish / snapshot
    CAP->>STR: JPEG frame (10 FPS)

    STR->>ANL: POST /api/analysis/frame\n(JPEG binary + X-LTS-Meta)
    ANL-->>STR: JSON { detections, tracks, alerts, behaviors }

    STR->>BR: Socket.IO frameData (어노테이션 JPEG)
    STR->>BR: Socket.IO newAlert (배회 알림)

    BR->>STR: POST /api/webrtc/whep/:id (SDP offer)
    STR->>MTX: 프록시 (SDP offer)
    MTX-->>STR: SDP answer
    STR-->>BR: SDP answer
    BR->>MTX: ICE UDP :8189 (WebRTC 미디어)
```

**특징:**
- ONNX 모델 로딩 없음 → 저사양 엣지 서버에서도 실행 가능
- `AnalysisClient`가 회로 차단기(Circuit Breaker) + 백프레셔 관리
- Analysis 서버 장애 시 자동 재연결 (15 s 간격 health probe)
- `/api/analysis/*` GET은 `analysisProxy`로 analysis 서버에 프록시
- `GET /api/analysis/client-status` — 로컬 circuit-breaker 상태·통계 (프록시 전에 처리, streaming 전용)

**활성화 서비스:**

| 서비스 | 활성 여부 |
|---|---|
| CaptureBackend (ingest-daemon/gstreamer/ffmpeg/pyav) | ✅ |
| PipelineManager | ✅ (캡처 + 결과 처리만) |
| analysisApi 마운트 | ❌ |
| analysisProxy 마운트 | ✅ (`/api/analysis/*` → 원격 서버) |
| analysisClient (원격 전송) | ✅ |
| DiscoveryService (ONVIF) | ✅ |
| YouTubeStreamService | ✅ |
| WebRTC WHEP 프록시 | ✅ |
| 카메라 자동 시작 | ✅ |
| ONNX 모델 eager 로딩 | ❌ |

**시작 명령:**
```bash
# 개발 (두 번째 터미널에서 analysis 서버도 병행)
npm run dev:streaming

# 프로덕션
npm run streaming        # LTS_ENV_FILE=.env_streaming
```

`.env_streaming` 핵심 설정:
```dotenv
SERVER_MODE=streaming
ANALYSIS_SERVER_URL=https://192.168.1.200:3443
```

---

### 3.3 analysis 모드

**`SERVER_MODE=analysis`** — AI 추론 전용 서버. 카메라 없이 HTTP로 수신한 JPEG 프레임을 추론하고 결과를 반환합니다.

```mermaid
graph TB
    STR1[Streaming Server 1] -- "POST /api/analysis/frame" --> ANL
    STR2[Streaming Server 2] -- "POST /api/analysis/frame" --> ANL
    STR3[Streaming Server 3] -- "POST /api/analysis/frame" --> ANL

    subgraph ANL[Analysis Server]
        API["/api/analysis/frame\n/api/analysis/health\n/api/analysis/metrics\n/api/analysis/config/fire-smoke"]
        PM[PipelineManager\nAI 추론 전용]
        YOLO[YOLOv8 ONNX]
        BYTETRACK[ByteTrack]
        BEHAVIOR[BehaviorEngine]
        ATTR[AttributePipeline\n의상·PPE·얼굴]
        FIRE[FireSmokeService]
    end

    API --> PM
    PM --> YOLO
    PM --> BYTETRACK
    PM --> BEHAVIOR
    PM --> ATTR
    PM --> FIRE
    PM -- "JSON results" --> API
    API -- "HTTP response" --> STR1
    API -- "HTTP response" --> STR2
    API -- "HTTP response" --> STR3
```

**특징:**
- ffmpeg 불필요 (카메라 캡처 없음)
- 여러 streaming 서버의 요청을 동시 처리 (`ANALYSIS_MAX_CONCURRENT`)
- `ONNX_THREADS_PROD` / `ONNX_CUDA` 설정으로 GPU 가속 지원
- 카메라 자동 시작, ONVIF 탐색 없음
- `POST /api/analysis/frame` 에 raw JPEG binary 수신 후 추론 결과 동기 반환

**활성화 서비스:**

| 서비스 | 활성 여부 | 비고 |
|---|---|---|
| RTSPCapture / ingest-daemon | ❌ | |
| PipelineManager | ✅ | AI 추론만 |
| analysisApi 마운트 | ✅ | `/api/analysis/*` |
| analysisProxy 마운트 | ❌ | |
| analysisClient (원격 전송) | ❌ | |
| DiscoveryService (ONVIF) | ❌ | |
| YouTubeStreamService | ❌ | 바이너리 탐색·로그 억제 |
| MediaMTX 프로세스 | ❌ | `CAPTURE_BACKEND=mediamtx`여도 미시작 |
| UDPDiscovery 서브모듈 탐색 | ❌ | `getUDPDiscovery()` 호출 시점까지 지연 |
| WebRTC WHEP 프록시 | ❌ | |
| 카메라 자동 시작 | ❌ | |
| ONNX 모델 eager 로딩 | ✅ | 3 s 지연 |

> **구현 참고:** `startServer.js`·`devServer.js`는 `SERVER_MODE=analysis`일 때 MediaMTX를 시작하지 않습니다 (`CAPTURE_BACKEND` 값 무관). `youtubeStreamService.js`와 `udpDiscovery.js`의 모듈 로드 시점 탐색 코드도 analysis 모드에서 억제됩니다.

**시작 명령:**
```bash
# 개발
npm run dev:analysis

# 프로덕션 (GPU 서버)
npm run analysis         # LTS_ENV_FILE=.env_analysis
```

`.env_analysis` 핵심 설정:
```dotenv
SERVER_MODE=analysis
ONNX_CUDA=1
ONNX_THREADS_PROD=0      # 0=auto (GPU 사용시 권장)
ANALYSIS_MAX_CONCURRENT=100
```

---

## 4. DB 서버 아키텍처

`DB_TYPE` 환경변수로 스토리지 백엔드를 선택합니다. DB 레이어는 **플러그어블 백엔드 아키텍처**(`server/src/db/`)로 구현됩니다.

```
server/src/db/
├── index.js          ← factory + public API (initDB / getDB / getStorageMode)
├── BaseDatabase.js   ← abstract interface — extend to add SQLite, Oracle, etc.
├── JsonDatabase.js   ← DB_TYPE=json  (default)
├── MongoDatabase.js  ← DB_TYPE=mongodb
└── constants.js      ← ALL_TABLES, TABLE_ROW_CAPS, LEGACY_MIGRATIONS
```

> `server/src/db.js`는 backward-compat shim입니다 (`module.exports = require('./db/index')`). 모든 기존 `require('../db')` 호출은 변경 없이 동작합니다.

### 4.1 JSON 파일 DB (기본값)

```mermaid
graph LR
    SRV[Node.js Server] -- "JsonDatabase (db/ 레이어)" --> JSON[(storage/lts.json)]
    JSON -- "인메모리 캐시\n+ 디바운스 2s 쓰기" --> SRV
```

- `storage/lts.json` — 카메라, 구역, 알림, 이벤트, 설정
- `storage/face_tracking.json` — 얼굴 추적 데이터
- `storage/analytics.json` — 분석 통계
- 인메모리 캐시 + 디바운스 2 s 비동기 쓰기 (atomic `.tmp` → rename)
- 외부 의존성 없음 — 개발/단일 서버에 최적

### 4.2 MongoDB (선택)

```mermaid
graph LR
    SRV[Node.js Server] -- "MongoDatabase (db/ 레이어)" --> MONGO[(MongoDB\nAtlas / Standalone)]
    MONGO -- "startup: loadAll()" --> SRV
```

- `DB_TYPE=mongodb` 설정 시 MongoDB에 async write-through (fire-and-forget)
- `lts.json`은 **완전히 무시**됨 — MongoDB 연결 실패 시에도 JSON fallback 없음 (in-memory only)
- `MONGODB_URI` = Atlas (cloud) 또는 `mongodb://host:27017` (standalone)
- 분산 배포 시 여러 Node.js 프로세스가 동일 DB 공유 가능

```dotenv
DB_TYPE=mongodb
MONGODB_URI=mongodb://ltsuser:ltspwd@192.168.1.100:27017/lts
MONGODB_DB_NAME=lts
```

**MongoDB 초기 설정:**
```bash
# 대화형 (설치 마법사)
cd server && npm run install_db

# 비대화형
node src/scripts/installDb.js \
  --host 192.168.1.100 --port 27017 \
  --admin-user admin --admin-pwd secret \
  --db lts --db-user ltsuser --db-pwd ltspwd
```

### 4.3 MongoDB 별도 서버 배포

```mermaid
graph TB
    subgraph DBServer["DB 서버 (192.168.1.100)"]
        MONGO[(MongoDB :27017)]
    end

    subgraph AppServer1["현장 서버 A"]
        STR1[streaming mode\n:3443]
    end

    subgraph AppServer2["현장 서버 B"]
        STR2[streaming mode\n:3443]
    end

    subgraph GPUServer["GPU 서버"]
        ANL[analysis mode\n:3443]
    end

    STR1 -- "write-through" --> MONGO
    STR2 -- "write-through" --> MONGO
    ANL  -- "write-through" --> MONGO
    MONGO -- read --> STR1
    MONGO -- read --> STR2
    MONGO -- read --> ANL
```

공유 MongoDB를 사용하면 복수의 streaming 서버가 동일한 카메라·구역·알림 DB를 공유합니다.

---

## 5. MCP 서버 아키텍처

`mcp-server/` 는 LTS-2026 REST API를 MCP(Model Context Protocol) 도구로 노출하는 **독립 프로세스**입니다.

```mermaid
graph LR
    subgraph LLM["LLM / MCP Client"]
        CLAUDE[Claude Code\nClaude API]
        GPT[OpenAI Agents]
    end

    subgraph MCP["MCP 서버 (mcp-server/)"]
        direction TB
        MCP_SRV[lts-mcp-server\nNode.js ESM]
        TOOLS["10 MCP Tools\nquery_loitering_events\nget_active_alerts\nacknowledge_alert\nget_camera_status\nget_zone_config\nupdate_zone_threshold\nget_tracking_history\nget_analytics_summary\nexplain_alert\ngenerate_security_report"]
        RES["4 MCP Resources\nlts://cameras\nlts://alerts/active\nlts://zones/{cameraId}\nlts://system/summary"]
    end

    subgraph LTS["LTS-2026 서버"]
        API[Express REST API\n:3080 또는 :3443]
    end

    CLAUDE -- "stdio (Claude Code)" --> MCP_SRV
    CLAUDE -- "HTTP + SSE" --> MCP_SRV
    GPT -- "HTTP + SSE" --> MCP_SRV
    MCP_SRV --> TOOLS
    MCP_SRV --> RES
    TOOLS -- "HTTP REST" --> API
    RES   -- "HTTP REST" --> API
```

**실행 방법:**

```bash
# stdio 모드 (Claude Code / claude_desktop_config.json)
cd mcp-server && npm start

# HTTP+SSE 모드 (OpenAI Agents / 원격 LLM)
cd mcp-server && npm run start:http
```

**Claude Code 연동 (`~/.claude/mcp_servers.json`):**

```json
{
  "lts": {
    "command": "node",
    "args": ["/path/to/loitering_tracking/mcp-server/index.js"],
    "env": { "LTS_BASE_URL": "http://localhost:3080" }
  }
}
```

**핵심 환경변수:**

```dotenv
LTS_BASE_URL=http://localhost:3080   # LTS API 서버 URL
MCP_PORT=3100                        # HTTP+SSE 모드 포트 (기본 3100)
```

**주의사항:**
- MCP 서버는 LTS API 서버(`streaming` 또는 `combined`)에 의존
- `analysis` 전용 서버에 연결하면 카메라/구역/알림 API는 동작하나 캡처 관련 API는 제한됨
- LTS_BASE_URL에는 `streaming` 또는 `combined` 서버를 지정할 것

---

## 6. 배포 시나리오

### 6.1 단일 서버 (combined)

개발, 소규모 현장 (카메라 수: 1–8), GPU가 있는 단일 서버에 적합.

```mermaid
graph TB
    subgraph SingleServer["단일 서버 (combined mode)"]
        MEDIAMTX["MediaMTX\n:8554 :8889 :8189 :9997"]
        NODE["Node.js\nSERVER_MODE=combined\n:3443 HTTPS"]
        JSON["storage/lts.json"]
        NODE --> MEDIAMTX
        NODE --> JSON
    end

    CAM["IP Cameras\nRTSP"] --> MEDIAMTX
    BROWSER["Browser"] -- "HTTPS :3443" --> NODE
    BROWSER -- "ICE UDP :8189" --> MEDIAMTX
    CLAUDE["Claude Code"] -- "stdio MCP" --> MCP["mcp-server"]
    MCP -- "HTTP :3080" --> NODE
```

**구동 순서:**
```bash
# 1. MediaMTX (자동 — npm run dev가 시작)
mediamtx mediamtx.yml

# 2. LTS 서버
cd server && npm run dev

# 3. (선택) MCP 서버
cd mcp-server && npm start
```

---

### 6.2 분산 배포 (streaming + analysis)

GPU 서버를 별도 운용하거나 카메라가 많을 때 (카메라 수: 9+) 적합.

```mermaid
graph LR
    subgraph Site1["현장 A (streaming)"]
        CAM1["Cameras 1–4"] --> MTX1["MediaMTX"]
        MTX1 --> STR1["Node.js\nstreaming\n:3443"]
    end

    subgraph Site2["현장 B (streaming)"]
        CAM2["Cameras 5–8"] --> MTX2["MediaMTX"]
        MTX2 --> STR2["Node.js\nstreaming\n:3443"]
    end

    subgraph GPUServer["GPU 서버 (analysis)"]
        ANL["Node.js\nanalysis\n:3443\nONNX_CUDA=1"]
    end

    STR1 -- "POST /api/analysis/frame" --> ANL
    STR2 -- "POST /api/analysis/frame" --> ANL
    ANL -- "JSON results" --> STR1
    ANL -- "JSON results" --> STR2

    BR1["Browser"] --> STR1
    BR2["Browser"] --> STR2
```

**네트워크 요구사항:**
- streaming → analysis: HTTP/HTTPS, 포트 3443 개방
- 지연시간 권장: < 50 ms (초과 시 `ANALYSIS_REQUEST_TIMEOUT_MS` 조정)
- 방화벽: `ANALYSIS_SERVER_URL`의 포트를 streaming 서버에서만 허용 (외부 브라우저 직접 접근 불필요)

**현장 서버 `.env_streaming`:**
```dotenv
SERVER_MODE=streaming
ANALYSIS_SERVER_URL=https://192.168.1.200:3443
ANALYSIS_REQUEST_TIMEOUT_MS=2000
ANALYSIS_MAX_CONCURRENT=100
```

**GPU 서버 `.env_analysis`:**
```dotenv
SERVER_MODE=analysis
ONNX_CUDA=1
ONNX_THREADS_PROD=0
ANALYSIS_MAX_CONCURRENT=100
HTTP_PORT=3080
HTTPS_PORT=3443
```

---

### 6.3 MongoDB 별도 서버

데이터 공유, 고가용성, 대용량 이벤트 저장 시 적합.

```mermaid
graph TB
    subgraph DBSrv["DB 서버"]
        MONGO["MongoDB :27017"]
    end

    subgraph App["앱 서버들"]
        STR["streaming :3443"]
        ANL["analysis :3443"]
    end

    subgraph Client["클라이언트"]
        BR["Browser"]
        MCP_C["MCP Server"]
    end

    STR -- write-through --> MONGO
    ANL -- write-through --> MONGO
    MONGO -- read --> STR
    MONGO -- read --> ANL
    BR --> STR
    MCP_C --> STR
```

**설정:**
```dotenv
# 모든 Node.js 서버에 동일하게 설정
DB_TYPE=mongodb
MONGODB_URI=mongodb://ltsuser:ltspwd@192.168.1.100:27017/lts
MONGODB_DB_NAME=lts
```

**주의:**
- analysis 서버도 DB에 접근하나, 브라우저는 streaming 서버에만 연결
- 카메라·구역 설정은 streaming 서버 REST API를 통해 관리

---

### 6.4 MCP 서버 연동

AI 보안 리포트 생성, 알림 조회, 구역 임계값 자연어 조정 등에 사용.

```mermaid
sequenceDiagram
    participant U as 보안 담당자 (Claude)
    participant MCP as mcp-server
    participant LTS as LTS API (streaming/combined)
    participant DB as DB (JSON/MongoDB)

    U->>MCP: "지난 1시간 배회 이벤트 보여줘"
    MCP->>LTS: GET /api/alerts?since=...
    LTS->>DB: query alerts
    DB-->>LTS: events[]
    LTS-->>MCP: JSON
    MCP-->>U: 자연어 요약

    U->>MCP: "카메라 1번 구역 임계값 60초로 바꿔"
    MCP->>LTS: PATCH /api/zones/:id { threshold: 60 }
    LTS->>DB: update zone
    LTS-->>MCP: ok
    MCP-->>U: "업데이트 완료"
```

**지원 MCP 도구:**
- `query_loitering_events` — 시간·카메라·구역 필터 배회 이벤트 조회
- `get_active_alerts` — 현재 미확인 알림 목록
- `acknowledge_alert` — 알림 확인 처리
- `get_camera_status` — 카메라 연결 상태
- `get_zone_config` — 구역 설정 조회
- `update_zone_threshold` — 배회 임계값 수정
- `get_tracking_history` — 인물 추적 이력
- `get_analytics_summary` — 분석 통계 요약
- `explain_alert` — 알림 상세 설명
- `generate_security_report` — 보안 리포트 생성

---

### 6.5 Full 분산 (모든 컴포넌트 분리)

엔터프라이즈 배포 — 역할별 서버 완전 분리.

```mermaid
graph TB
    subgraph Internet["외부 접근"]
        BR["Browser / 모바일"]
        CLAUDE_EXT["Claude API"]
    end

    subgraph DMZ["DMZ / 리버스 프록시"]
        NGINX["Nginx / HAProxy\n:443 HTTPS"]
    end

    subgraph LAN["내부 LAN"]
        subgraph FieldA["현장 A"]
            MTX_A["MediaMTX\n:8189 ICE"]
            STR_A["streaming :3443"]
        end

        subgraph FieldB["현장 B"]
            MTX_B["MediaMTX\n:8189 ICE"]
            STR_B["streaming :3443"]
        end

        subgraph GPU["GPU 서버"]
            ANL["analysis :3443"]
        end

        subgraph DB["DB 서버"]
            MONGO["MongoDB :27017"]
        end

        subgraph MCP_SRV["MCP 서버"]
            MCP["mcp-server :3100"]
        end
    end

    BR --> NGINX
    CLAUDE_EXT --> MCP

    NGINX --> STR_A
    NGINX --> STR_B

    STR_A --> ANL
    STR_B --> ANL
    STR_A --> MONGO
    STR_B --> MONGO
    ANL --> MONGO

    MCP --> STR_A
    BR -- "ICE UDP :8189" --> MTX_A
    BR -- "ICE UDP :8189" --> MTX_B
```

---

## 7. 환경변수 요약

| 변수 | 기본값 | combined | streaming | analysis |
|---|---|---|---|---|
| `SERVER_MODE` | `combined` | `combined` | `streaming` | `analysis` |
| `HTTP_PORT` | `3080` | ✅ | ✅ | ✅ |
| `HTTPS_PORT` | `3443` | ✅ | ✅ | ✅ |
| `ANALYSIS_SERVER_URL` | (없음) | 미사용 | **필수** | 미사용 |
| `ANALYSIS_REQUEST_TIMEOUT_MS` | `2000` | 미사용 | ✅ | 미사용 |
| `ANALYSIS_MAX_CONCURRENT` | `100` | 미사용 | ✅ | ✅ |
| `ONNX_CUDA` | `0` | ✅ | ❌ | ✅ |
| `ONNX_THREADS_PROD` | `0` | ✅ | ❌ | ✅ |
| `CAPTURE_BACKEND` | `ingest-daemon` | ✅ | ✅ | ❌ |
| `CAPTURE_FPS` | `10` | ✅ | ✅ | ❌ |
| `MEDIAMTX_RTSP_PORT` | `8554` | ✅ | ✅ | ❌ |
| `DB_TYPE` | `json` | ✅ | ✅ | ✅ |
| `MONGODB_URI` | (없음) | ✅ | ✅ | ✅ |
| `LTS_ENV_FILE` | `.env` | — | `.env_streaming` | `.env_analysis` |

---

## 8. 실시간 감지 데이터 흐름 (SERVER_MODE별)

`DashboardDetectionPanel`이 실시간 감지 객체·크롭 이미지를 표시하기 위해서는 서버에서 아래 Socket.IO 이벤트가 올바르게 전달되어야 합니다.

### 8.1 이벤트 구조

| 이벤트 | 방향 | 설명 |
|---|---|---|
| `detections` | Server→Client | 프레임당 추적 객체·얼굴·화재/연기 목록 |
| `snapshot:new` | Server→Client | 감지 크롭 이미지 (Base64 JPEG) |

### 8.2 combined 모드 흐름

```
PipelineManager (로컬 AI 추론)
  └─► io.to(camera.id).emit('detections', { cameraId, detections, frameWidth, frameHeight })
  └─► io.to(camera.id).emit('snapshot:new', { cameraId, objectId, cropData })
           │ (snapshotSvc.shouldSave: isLoitering | isFirstSeen | hasFaceMatch | isFireSmoke)
```

- 카메라 룸(`.to(camera.id)`)으로 emit
- 클라이언트가 `camera:subscribe` → socket.join(cameraId)로 수신
- 모든 객체 유형의 크롭 지원

### 8.3 streaming 모드 흐름

```
PipelineManager._processRemoteResult (analysis 서버 HTTP 응답 수신 후)
  └─► io.to(_cameraId).emit('detections', { ... })
  └─► io.to(_cameraId).emit('snapshot:new', { ..., cropData })
           │ (snapshotSvc.shouldSave와 동일 조건)
```

- **전제조건**: analysis 서버가 연결되어 HTTP 응답을 반환해야 함
- analysis 서버 미연결(회로차단기 오픈) 시 `_processRemoteResult` 미호출 → 이벤트 없음
- 크롭 조건: isLoitering | isFirstSeen | hasFaceMatch | isFireSmoke

### 8.4 analysis 모드 흐름 (v1.1 신규)

```
analysisApi.js POST /api/analysis/process
  └─► io.emit('detections', { cameraId, detections: [...tracked, ...faces, ...fireSmoke] })
           │ (global broadcast — 카메라 룸 없음)
  └─► [setImmediate] snapshotSvc.shouldSave() → io.emit('snapshot:new', { objectId, cropData })
           │ (isFirstSeen | isLoitering | hasFaceMatch — combined/streaming과 동일 조건)
  └─► _persistFireSmoke → io.emit('snapshot:new', { objectId: 'fire'|'smoke', cropData })
  └─► _persistLoitering → io.emit('snapshot:new', { objectId: trackId, cropData })
```

- **global emit** (`io.emit()`) 사용 — DB에 카메라 없어 룸 구독 불가
- **tracked person 크롭**: `snapshotSvc.shouldSave()` 사용 — isFirstSeen/isLoitering/hasFaceMatch 조건 지원
- fire/smoke 크롭: 30s 쿨다운, loitering 크롭: 60s 쿨다운 (persist 함수 경로)

### 8.5 클라이언트 구독 메커니즘

```typescript
// useAllDetections.ts
// combined/streaming: subscribed 카메라만 수신
if (subscribedRef.current.size > 0 && !subscribedRef.current.has(ev.cameraId)) return;
// analysis 모드: 구독 없음(size=0) → 전체 수신
```

| 모드 | 카메라 구독 | DashboardDetectionPanel | 크롭 소스 |
|---|---|---|---|
| combined | camera:subscribe → 룸 join | ✅ | snapshotSvc (모든 조건) |
| streaming | camera:subscribe → 룸 join | ✅ (analysis 서버 연결 필요) | snapshotSvc (모든 조건) |
| analysis | 없음 (global 수신) | ✅ | snapshotSvc + _persistFireSmoke/Loitering |

---

## 9. 포트 요약

| 포트 | 프로토콜 | 컴포넌트 | 용도 |
|---|---|---|---|
| 3080 | HTTP | Node.js | REST API (HTTP) |
| 3443 | HTTPS | Node.js | REST API + Socket.IO + WHEP 프록시 |
| 3100 | HTTP | mcp-server | MCP HTTP+SSE 모드 |
| 8554 | RTSP | MediaMTX | RTSP 재발행 (로컬 루프백) |
| 8889 | HTTP | MediaMTX | WebRTC WHEP 시그널링 (로컬 루프백) |
| 8189 | UDP | MediaMTX | ICE 미디어 (모든 인터페이스) |
| 9997 | HTTP | MediaMTX | REST API (로컬 루프백) |
| 27017 | TCP | MongoDB | DB 연결 |

> **보안 참고:** MediaMTX의 RTSP(:8554), WHEP HTTP(:8889), API(:9997)는 `127.0.0.1`에만 바인딩됩니다. ICE UDP(:8189)만 브라우저 직접 접근을 위해 모든 인터페이스에 열립니다.

---

## 10. 모드별 기능 매트릭스

| 기능 | combined | streaming | analysis |
|---|---|---|---|
| RTSP 캡처 | ✅ | ✅ | ❌ |
| ONVIF 카메라 탐색 | ✅ | ✅ | ❌ |
| YouTube RTSP 수집 | ✅ | ✅ | ❌ |
| YOLOv8 로컬 추론 | ✅ | ❌ | ✅ |
| ByteTrack 추적 | ✅ | ❌ | ✅ |
| 배회 위험 점수 | ✅ | ❌ | ✅ |
| 얼굴 인식 Re-ID | ✅ | ❌ | ✅ |
| 화재·연기 감지 | ✅ | ❌ | ✅ |
| 의상·PPE 분석 | ✅ | ❌ | ✅ |
| 원격 분석 서버 전송 | ❌ | ✅ | ❌ |
| WebRTC WHEP 프록시 | ✅ | ✅ | ✅ |
| Socket.IO 실시간 | ✅ | ✅ | ✅ |
| REST API 전체 | ✅ | ✅ | 일부 |
| `/api/analysis/*` | ✅ | 프록시 | ✅ |
| 분석 메트릭 집계 | 로컬 | 원격 | 로컬 |
| SPA 서빙 | ✅ | ✅ | ✅ |
| ffmpeg 필요 | ✅ | ✅ | ❌ |
| GPU 가속 (CUDA) | 선택 | ❌ | 선택 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-10 | 초기 작성 — combined/streaming/analysis 모드 분리, DB/MCP 아키텍처, 배포 시나리오 5종, Mermaid 다이어그램 포함 |
| 1.1 | 2026-06-10 | Section 8 추가: 실시간 감지 데이터 흐름(SERVER_MODE별), analysis 모드 Socket.IO 활성화, useAllDetections 전체 수신 메커니즘, snapshotSvc로 일반 person 크롭 지원 |
| 1.2 | 2026-06-10 | streaming 모드 `GET /api/analysis/client-status` 엔드포인트 추가 — circuit-breaker 상태·통계 노출, DashboardDetectionPanel 분석 서버 연결 상태 배너 |
| 1.3 | 2026-06-11 | CAPTURE_BACKEND 기본값 `ingest-daemon`으로 변경; RTSPCapture 표기를 CaptureBackend로 일반화 |
| 1.4 | 2026-06-17 | analysis 모드 불필요 서비스 억제: MediaMTX(CAPTURE_BACKEND 무관), YouTubeStream 바이너리 탐색, UDPDiscovery 서브모듈 로그 모두 비활성화 |
| 1.5 | 2026-06-23 | Section 4 DB 아키텍처 업데이트: 플러그어블 백엔드(BaseDatabase/JsonDatabase/MongoDatabase), server/src/db/ 구조, MongoDB 모드 lts.json 완전 제거 반영 |
