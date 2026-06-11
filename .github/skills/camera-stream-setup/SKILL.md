---
name: camera-stream-setup
description: "LTS-2026 카메라 스트림 설정 및 관리. Use when: RTSP 카메라 추가/연결, ONVIF 카메라 자동 탐색, YouTube/RTMP 스트림 RTSP 변환 ingestion, WebRTC 미디어 게이트웨이 설정, MediaMTX 프록시/WHEP 설정, ICE/STUN/TURN 연결 문제 해결, 카메라 스트림 끊김 디버깅, 새 카메라 소스 지원 추가, CAPTURE_BACKEND 전환(ingest-daemon/gstreamer/ffmpeg), WEBRTC_ENGINE 선택(mediamtx/mediasoup), ingest-daemon 설정 및 재시작(ingest:restart), GStreamer 하드웨어 가속 설정(nvdec/vaapi), B-프레임 H264 카메라 처리, camera:capabilities 소켓 이벤트. Covers: captureFactory.js, ingestDaemonCapture.js, ingest_daemon.py, rtspCapture.js, gstreamerCapture.js, pyavCapture.js, discoveryService.js, onvifDiscovery.js, youtubeStreamService.js, mediamtx.yml, streamHandler.js."
argument-hint: "카메라 소스 유형 (RTSP / ONVIF / YouTube / WebRTC) 또는 백엔드 (ingest-daemon / gstreamer / ffmpeg)"
---

# Camera Stream Setup

## ⚡ 핵심 아키텍처 원칙 (반드시 준수)

> **이 원칙은 LTS-2026의 수집 레이어 설계 근간입니다. 모든 코드 수정 시 이를 우선합니다.**

### 1. RTSP 스트림은 ingest-daemon이 유일한 수집 계층

- **RTSP로 연결 가능한 모든 카메라는 ingest-daemon(`ingest_daemon.py`)을 통해서만 수집합니다.**
- ingest-daemon은 단일 RTSP 세션에서 다음 세 경로를 동시에 팬아웃합니다:
  - **JPEG → HTTP POST** → Node.js AI 파이프라인 (YOLOv8/ByteTrack)
  - **H.264 RTP → UDP** → mediasoup PlainTransport (WebRTC 비디오 트랙)
  - **Opus RTP → UDP** → mediasoup PlainTransport (WebRTC 오디오 트랙)
- `CAPTURE_BACKEND=ingest-daemon`이 모든 배포 환경의 기본값입니다.

### 2. FFmpeg 사용 금지 범위 (RTSP 수집)

- **RTSP 카메라 수집에 FFmpeg subprocess를 사용하지 않습니다.**
- FFmpeg은 아래 불가피한 경우에만 허용됩니다:
  - YouTube 스트림 (`yt-dlp | ffmpeg → MediaMTX` 파이프라인)
  - RTSP를 지원하지 않는 특수 소스 (RTMP, HLS 등 RTSP 변환 전 단계)
- `rtspCapture.js`, `gstreamerCapture.js`, `pyavCapture.js`는 레거시입니다. 신규 카메라에 사용하지 않습니다.

### 3. mediasoup WebRTC도 ingest-daemon이 RTP 공급

- `WEBRTC_ENGINE=mediasoup` 환경에서도 ingest-daemon이 비디오/오디오 RTP를 공급합니다.
- mediasoup이 스스로 FFmpeg subprocess를 띄우는 구현은 금지입니다.
- `mediasoupEngine.js`의 `addCameraStream()`은 반드시 ingest-daemon의 `/cameras` API를 호출하고 `mediasoupPort`(video) + `mediasoupAudioPort`(audio)를 전달해야 합니다.

### 4. 수집 우선순위 결정 트리

```
카메라 소스 유형?
├── RTSP / ONVIF (IP 카메라)
│     └── 항상 ingest-daemon  ← WEBRTC_ENGINE=mediamtx OR mediasoup 무관
├── YouTube / RTMP / HLS
│     └── yt-dlp → ffmpeg → MediaMTX  (불가피한 경우)
└── ONVIF 탐색 후 RTSP 확인
      └── RTSP 주소 추출 → ingest-daemon
```

---

## 스트림 수집 아키텍처

### WEBRTC_ENGINE=mediamtx (현재 기본)

```
IP 카메라 (RTSP)
    │ 단일 RTSP 연결
    ▼
MediaMTX (mediamtx.yml)
    ├── RTSP loopback :8554/{cameraId}
    │       │
    │       ▼
    │   ingest_daemon.py
    │       ├── JPEG → HTTP POST → Node.js /api/internal/frame/:id
    │       │        → IngestDaemonCapture → AI pipeline (YOLO/ByteTrack)
    │       │   (WEBRTC_ENGINE=mediamtx 시 RTP 경로 미사용)
    │
    └── WebRTC WHEP :8889/{cameraId}/whep  ──► 브라우저
```

### WEBRTC_ENGINE=mediasoup (Audio + Video + DataChannel)

```
IP 카메라 (RTSP)
    │ 단일 RTSP 연결
    ▼
MediaMTX (mediamtx.yml)
    └── RTSP loopback :8554/{cameraId}
            │
            ▼
        ingest_daemon.py  (MediaMTX loopback → 3개 독립 PyAV 세션)
            ├── ① JPEG → HTTP POST → /api/internal/frame/:id → AI pipeline (YOLO/ByteTrack)
            ├── ② H.264 RTP → UDP:{mediasoupPort}      → mediasoup video PlainTransport → Producer
            └── ③ Opus RTP  → UDP:{mediasoupAudioPort} → mediasoup audio PlainTransport → Producer
                   (카메라 오디오가 Opus가 아니면 PyAV로 트랜스코딩)

mediasoupEngine.js  →  WebRtcTransport (enableSctp=true)
    ├── video Consumer  → 브라우저 <video> (H.264 SRTP)
    ├── audio Consumer  → 브라우저 <audio> (Opus SRTP)
    └── DataConsumer   ← DirectTransport.DataProducer
                                └── App RTP / server-push JSON → DataChannel (SCTP)

App RTP 전달 경로:
  WEBRTC_ENGINE=mediamtx: ingest-daemon → POST /api/internal/apprtp/:id → Socket.IO emit('appRtp')
  WEBRTC_ENGINE=mediasoup: ingest-daemon → POST /api/internal/apprtp/:id → DataProducer.send()

YouTube / RTMP  ──► yt-dlp → ffmpeg → MediaMTX 내부 경로  ← FFmpeg 허용 구간
ONVIF 자동 탐색 ──► discoveryService.js ──► RTSP 주소 → ingest-daemon
```

> **현재 기본 구성:** `CAPTURE_BACKEND=ingest-daemon` + `WEBRTC_ENGINE=mediamtx`

### WEBRTC_ENGINE별 트랙 전달 요약

| 트랙 | mediamtx 모드 | mediasoup 모드 |
|---|---|---|
| 비디오 (H.264) | MediaMTX WHEP → SRTP | mediasoup WebRtcTransport → SRTP |
| 오디오 (Opus) | MediaMTX WHEP → SRTP | mediasoup WebRtcTransport → SRTP |
| Application RTP (PT 96~127) | Socket.IO `appRtp` 이벤트 | WebRTC DataChannel (SCTP) |

## 핵심 파일 위치

| 파일 | 역할 |
|---|---|
| `server/src/services/captureFactory.js` | **캡처 백엔드 팩토리** — CAPTURE_BACKEND env로 선택 |
| `server/src/services/ingestDaemonCapture.js` | Ingest-Daemon 수신 래퍼 (**현재 기본**) — 패시브 EventEmitter |
| `ingest-daemon/ingest_daemon.py` | Python PyAV 독립 HTTP 데몬 — RTSP → JPEG → POST |
| `server/src/services/rtspCapture.js` | FFmpeg 기반 캡처 *(레거시)* |
| `server/src/services/gstreamerCapture.js` | GStreamer 파이프라인 캡처 (nvdec/vaapi 지원) |
| `server/src/services/pyavCapture.js` | Python PyAV 인라인 사이드카 캡처 |
| `server/src/python/pyav_capture.py` | PyAV 인라인 사이드카 스크립트 |
| `server/src/socket/streamHandler.js` | Socket.IO 핸들러 — `camera:capabilities` 이벤트 |
| `server/src/scripts/restartIngestDaemon.js` | Ingest 데몬 핫 재시작 스크립트 |
| `server/src/services/discoveryService.js` | 네트워크 카메라 자동 탐색 조율 |
| `server/src/services/onvifDiscovery.js` | ONVIF WS-Discovery 프로토콜 |
| `server/src/services/youtubeStreamService.js` | yt-dlp로 YouTube 스트림 → RTSP 변환 |
| `mediamtx.yml` | MediaMTX 프록시 경로·인증·WebRTC WHEP 설정 |

## 주요 작업 절차

### SERVER_MODE 별 캡처/분석 분리 규칙

- `SERVER_MODE=combined`: 캡처 + 로컬 AI 추론 + 스트리밍
- `SERVER_MODE=streaming`: 캡처 + 스트리밍만 수행, AI 추론은 `ANALYSIS_SERVER_URL` 원격 서버로 위임
- `SERVER_MODE=analysis`: 캡처/Discovery 미실행, `/api/analysis/frame` 추론 전용

운영 주의:
- `streaming` 모드에서는 로컬 PAR/ArcFace 모델 eager load가 발생하면 설정/코드 회귀입니다.
- 기준 구현: `server/src/index.js`에서 streaming 모드 eager model loading 스킵.
- `ANALYSIS_SERVER_URL`이 비어 있어도 스트리밍 서버는 monitoring-only로 동작해야 하며 영상 송출은 유지됩니다.
- 이 상태에서는 AI 결과(detections/alerts/face_match)만 비활성입니다.

### CAPTURE_BACKEND 전환

`server/.env`에서 선택 (기본값: `ingest-daemon`):

```env
# ingest-daemon (기본 · 권장) — Python PyAV 독립 데몬 + MediaMTX WebRTC
CAPTURE_BACKEND=ingest-daemon
WEBRTC_ENGINE=mediamtx
PYAV_PYTHON_BIN=/home/user/.local/bin/python3
INGEST_DAEMON_BIN=../ingest-daemon/ingest_daemon.py
INGEST_DAEMON_ADDR=:7070

# gstreamer — 저레이턴시, 하드웨어 가속 (레거시)
CAPTURE_BACKEND=gstreamer
WEBRTC_ENGINE=mediamtx
GSTREAMER_HW_ACCEL=auto   # auto | nvdec | vaapi | software

# ffmpeg — 레거시 호환 (단일 RTSP 연결 원칙 위반)
CAPTURE_BACKEND=ffmpeg
WEBRTC_ENGINE=mediamtx
```

백엔드별 의존성 확인:
```bash
# ingest-daemon (기본)
python3 -c "import av, PIL; print('OK')"
ls ingest-daemon/ingest_daemon.py

# GStreamer (레거시)
gst-launch-1.0 --version
gst-inspect-1.0 nvdec           # NVIDIA 확인
gst-inspect-1.0 vaapidecodebin  # Intel/AMD 확인
```

### Ingest Daemon 재시작 (서버 전체 재시작 없이)

```bash
# workspace 루트에서
npm run ingest:restart

# server/ 에서
npm run ingest:restart -- --dry-run  # 설정 확인만
```

재시작 과정:
1. 기존 daemon 프로세스 종료 (포트 7070 kill + `pkill ingest_daemon.py`)
2. 새 데몬 기동 (백그라운드)
3. `/health` 폴링으로 기동 확인 (최대 10초)
4. DB에서 카메라 목록 읽어 daemon에 재등록

### RTSP 카메라 추가
1. 카메라의 RTSP URL 확인 (예: `rtsp://admin:pass@192.168.1.100:554/stream1`)
2. `mediamtx.yml`의 `paths` 섹션에 새 경로 추가:
   ```yaml
   paths:
     cam_01:
       source: rtsp://admin:pass@192.168.1.100:554/stream1
       sourceProtocol: tcp
   ```
3. MediaMTX 재시작: `docker compose restart mediamtx`
4. 서버 API로 카메라 등록: `POST /api/cameras`
5. `server/src/services/captureFactory.js`를 통해 선택된 백엔드로 스트림 소비 확인

### ONVIF 카메라 자동 탐색
1. `server/src/services/discoveryService.js` 탐색 범위(subnet) 확인
2. `server/src/services/onvifDiscovery.js`의 WS-Discovery 타임아웃 조정
3. 탐색 API 호출: `POST /api/cameras/discover`
4. 반환된 카메라 목록에서 선택하여 등록

### YouTube 스트림 수집
1. 대상 YouTube URL 준비 (라이브 또는 녹화)
2. `server/src/services/youtubeStreamService.js`에서 yt-dlp 경로 확인
3. API 호출: `POST /api/streams/youtube` `{ "url": "https://youtube.com/..." }`
4. MediaMTX 내부 경로로 RTSP 변환 후 파이프라인 연결 확인
5. 참고: [Design_LTS2026_YouTube_RTSP_Ingest.md](../../../docs/design/Design_LTS2026_YouTube_RTSP_Ingest.md)

### WebRTC 연결 문제 해결
1. `server/src/services/webrtcGateway.js` ICE candidate 로그 확인
2. STUN/TURN 서버 설정 검토 (환경변수 `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`)
3. 방화벽에서 UDP 10000–20000 포트 허용 여부 확인
4. 브라우저 콘솔에서 `RTCPeerConnection` 상태 확인
5. 참고: [Design_STUN_TURN_ICE.md](../../../docs/design/Design_STUN_TURN_ICE.md)

### MediaMTX 설정 핵심 옵션

```yaml
# mediamtx.yml 주요 설정
logLevel: info
hlsAlwaysRemux: yes
webrtcICEServers:
  - url: stun:stun.l.google.com:19302

paths:
  ~^cam_(.+)$:             # 정규식 패턴 매칭
    readUser: viewer
    readPass: password
```

## Ingest Daemon 설정 및 진단

### ingest_daemon.py HTTP API

| 엔드포인트 | 설명 |
|---|---|
| `GET /health` | `{"status":"ok","cameras":N}` |
| `POST /cameras` | `{"id","rtspUrl","callbackUrl"}` 카메라 등록 |
| `DELETE /cameras/:id` | 카메라 등록 해제 |

```bash
# 데몬 상태 확인
curl http://127.0.0.1:7070/health

# 카메라 등록 수동 테스트
curl -X POST http://127.0.0.1:7070/cameras \
  -H 'Content-Type: application/json' \
  -d '{"id":"test","rtspUrl":"rtsp://...","callbackUrl":"https://127.0.0.1:3443/api/internal/frame/test"}'

# MediaMTX 등록 경로 확인
curl http://127.0.0.1:9997/v3/paths/list
```

### B-프레임 H264 카메라 처리

H.264 B-프레임 카메라에서 빈 프레임 발생 시: ingest-daemon은 모든 패킷을 디코딩 후 N번째 프레임만 전송합니다 (`AI_FRAME_INTERVAL`). 구 서브프로세스 백엔드에서 패킷 자체를 스킵하던 방식과 다릅니다.

### `camera:capabilities` 소켓 이벤트

`streamHandler.js`에서 클라이언트가 `camera:subscribe`를 보낼 때:
- `CAPTURE_BACKEND=ingest-daemon` + `WEBRTC_ENGINE=mediasoup`: `{webrtcEnabled: false}` 전송 (RTP 소스 없음)
- `CAPTURE_BACKEND=ingest-daemon` + `WEBRTC_ENGINE=mediamtx`: 이벤트 미전송 (DB 값 사용)
- 다른 조합: 이벤트 미전송

> **주의:** 이 이벤트는 클라이언트의 Zustand 스토어를 즉시 덮어씁니다. WEBRTC_ENGINE 체크 없이 보내면 WebRTC가 동작 중에도 JPEG 모드로 강제됩니다.

## ffmpeg 버전 호환성 *(레거시 참조)*

> `CAPTURE_BACKEND=ffmpeg`는 레거시입니다. 신규 배포에는 `ingest-daemon`을 사용하세요.  
> 상세 내용: [Design_FFmpeg_RTSP_Capture.md](../../../docs/design/Design_FFmpeg_RTSP_Capture.md) (Deprecated)

| Ubuntu | ffmpeg | RTSP timeout 플래그 |
|--------|--------|---------------------|
| 18.04 LTS | 3.4.x | `-stimeout` |
| 20.04~22.04 | 4.x | `-timeout` (권장) |
| 24.04+ | 6.x~7.x | `-timeout` |

`rtspCapture.js`에서 `ffmpeg -version`으로 Major 버전 자동 감지 후 플래그 선택.

## .env* 파일 관리 규칙

> `CAPTURE_BACKEND`·`WEBRTC_ENGINE`·`INGEST_DAEMON_*` 등 캡처 관련 환경변수 설명(주석)을 **하나의 파일에서 수정하면 반드시 나머지 모든 `.env*` 파일에도 동기화**해야 합니다.

### 동기화 대상 파일 목록

| 파일 | 용도 |
|---|---|
| `server/.env` | 개발/운영 실제 값 (git 미추적) |
| `server/.env_streaming` | streaming 모드 전용 설정 |
| `server/.env_analysis` | analysis 모드 전용 설정 |
| `server/.env.example` | 신규 설치 템플릿 (git 추적) |

### CAPTURE_BACKEND 설명 블록 표준 형식

모든 `.env*` 파일의 `CAPTURE_BACKEND` 설명은 아래 형식을 유지합니다:

```env
# ── RTSP Capture Backend ─────────────────────────────────────────────────────
# Selects the capture engine used to ingest RTSP camera frames for the AI pipeline.
#
# ingest-daemon (default) — External Python PyAV daemon (ingest_daemon.py, :7070).
#                       The daemon pulls from MediaMTX RTSP loopback
#                       (rtsp://127.0.0.1:MEDIAMTX_RTSP_PORT/{cameraId}) and
#                       POSTs JPEG frames to Node.js via HTTP.
#                       MediaMTX holds ONE connection to the camera; WebRTC (WHEP)
#                       and AI frames share it without a second RTSP pull.
#                       Requires: MediaMTX running + ingest_daemon.py
#                       Config: INGEST_DAEMON_BIN, INGEST_DAEMON_ADDR, INGEST_DAEMON_URL
# mediamtx            — Polls MediaMTX snapshot REST API for JPEG frames.
#                       GET /v3/paths/{id}/get-snapshot → JPEG. No subprocess.
#                       Requires MediaMTX ≥ 1.2.0 with api: yes in mediamtx.yml.
# ffmpeg              — FFmpeg subprocess connects directly to the camera RTSP URL.
#                       Widest codec/OS compatibility. Requires: ffmpeg ≥ 3.4
# gstreamer           — GStreamer pipeline. Lower latency; supports hardware decode
#                       (NVIDIA nvdec, Intel/AMD VA-API).
#                       Requires: gstreamer1.0-tools gstreamer1.0-plugins-*
# pyav                — Python PyAV sidecar. Best CUDA utilisation; future path for
#                       Python-side GPU inference. Requires: pip3 install av Pillow
#
CAPTURE_BACKEND=ingest-daemon
```

### Ingest Daemon 섹션 표준 제목

```env
# ── Ingest Daemon (CAPTURE_BACKEND=ingest-daemon 전용) ───────────────────────
```

> **주의**: `WEBRTC_ENGINE=mediasoup 전용`이라고 적힌 구형 주석은 **잘못된 설명**입니다.  
> `ingest-daemon`은 `mediamtx`(기본)·`mediasoup` 양쪽 WEBRTC_ENGINE과 함께 사용 가능합니다.

---

## server/.env 필수 설정 체크리스트

> **이 섹션을 먼저 확인하세요.** 잘못된 환경 변수 설정이 스트림 오류의 가장 흔한 원인입니다.

### 키 이름 주의사항

| 잘못된 키 (사용 금지) | 올바른 키 | 비고 |
|---|---|---|
| `PORT` | `HTTP_PORT` | Express HTTP 포트 |
| `TURN_USER` / `TURN_PASS` | `TURN_USERNAME` / `TURN_CREDENTIAL` | TURN 인증 |

### 캡처 백엔드 + WebRTC 엔진 필수 변수

```env
# ingest-daemon + mediamtx (기본 · 권장)
CAPTURE_BACKEND=ingest-daemon
WEBRTC_ENGINE=mediamtx
PYAV_PYTHON_BIN=/home/user/.local/bin/python3
INGEST_DAEMON_BIN=../ingest-daemon/ingest_daemon.py
INGEST_DAEMON_ADDR=:7070

# gstreamer (레거시)
CAPTURE_BACKEND=gstreamer
GSTREAMER_HW_ACCEL=auto       # auto | nvdec | vaapi | software
```

### YouTube 스트림 필수 변수

```env
# 반드시 실제 바이너리 절대경로를 지정해야 합니다 (비워 두면 YouTube 수집 불가)
YTDLP_BIN=/home/youngho/.local/bin/yt-dlp
MEDIAMTX_BIN=/home/youngho/.local/bin/mediamtx

YOUTUBE_MAX_STREAMS=10   # 동시 YouTube 스트림 상한
YOUTUBE_MAX_RESTARTS=5   # 자동 재시작 횟수 한계
```

경로 확인 명령:
```bash
which yt-dlp        # → /home/youngho/.local/bin/yt-dlp
which mediamtx      # → /home/youngho/.local/bin/mediamtx
```

### WebRTC / ICE 필수 변수

```env
SERVER_IP=192.168.214.3          # 브라우저가 도달 가능한 LAN IP
SERVER_PUBLIC_IP=55.101.57.105   # 외부 공인 IP (없으면 공란)

STUN_URLS=stun:192.168.214.3:3478,stun:55.101.57.105:3478,stun:stun.l.google.com:19302

TURN_URL=turn:192.168.214.3:3478
TURN_USERNAME=turn_user1         # ← TURN_USER 아님
TURN_CREDENTIAL=test1234         # ← TURN_PASS 아님

TURN_URL_2=turn:55.101.57.105:3478
TURN_USERNAME_2=turn_user1
TURN_CREDENTIAL_2=test1234
```

### 자주 발생하는 오설정 패턴

| 증상 | 원인 | 해결책 |
|---|---|---|
| Edit Camera에서 WebRTC toggle이 항상 OFF | `camera:capabilities` 이벤트가 WEBRTC_ENGINE 체크 없이 전송됨 | `streamHandler.js` — `WEBRTC_ENGINE=mediasoup`일 때만 이벤트 전송 |
| WebRTC 설정 후에도 JPEG 모드로 동작 | `WEBRTC_ENGINE` 미설정 (기본값 mediamtx) + 소켓 이벤트 충돌 | `.env` 에 `WEBRTC_ENGINE=mediamtx` 명시 |
| Ingest daemon 등록 실패 | `PYAV_PYTHON_BIN` 경로 오류 또는 `av` 미설치 | `PYAV_PYTHON_BIN` 절대경로 확인, `pip3 install av Pillow` |
| 카메라 구독 후 프레임 없음 | ingest daemon 미기동 | `npm run ingest:restart` |
| YouTube 스트림이 `error` 상태 | `YTDLP_BIN` 또는 `MEDIAMTX_BIN` 공란 | 절대경로 지정 및 실행 권한 확인 |
| WebRTC ICE 연결 실패 | `SERVER_IP`가 브라우저와 다른 서브넷 | 서버의 실제 LAN IP로 수정 |
| TURN 인증 오류 | `TURN_USER` / `TURN_PASS` 사용 (구 키명) | `TURN_USERNAME` / `TURN_CREDENTIAL`로 교체 |
| HTTP 서버 미기동 | `PORT` 사용 (구 키명) | `HTTP_PORT`로 교체 |
| GStreamer 스트림 미동작 | `gst-launch-1.0` 미설치 | `apt install gstreamer1.0-tools gstreamer1.0-plugins-good` |

### .env 빠른 검증 스크립트

```bash
# 필수 바이너리 경로 존재 여부 확인
node -e "
const e = require('dotenv').config({ path: 'server/.env' }).parsed;
['YTDLP_BIN','MEDIAMTX_BIN'].forEach(k => {
  const fs = require('fs');
  if (!e[k]) { console.error('MISSING:', k); process.exit(1); }
  if (!fs.existsSync(e[k])) { console.error('NOT FOUND:', k, e[k]); process.exit(1); }
  console.log('OK:', k, e[k]);
});
"

# 잘못된 구 키명 사용 여부 탐지
grep -nE '^(PORT|TURN_USER|TURN_PASS)\s*=' server/.env && echo "WARNING: deprecated key names found" || echo "Key names OK"
```

## 스트림 상태 진단 명령

```bash
# MediaMTX 경로 목록 확인
curl http://localhost:9997/v3/paths/list

# RTSP 스트림 직접 테스트
ffplay rtsp://localhost:8554/cam_01

# GStreamer 파이프라인 직접 테스트
gst-launch-1.0 rtspsrc location=rtsp://localhost:8554/cam_01 protocols=tcp ! \
  decodebin ! videoconvert ! autovideosink

# yt-dlp 스트림 품질 확인
yt-dlp -F https://youtube.com/watch?v=...
```

## 관련 문서 (SDLC 참조)

> 구현·수정 전 아래 문서를 확인하고, **코드 변경 시 해당 문서를 반드시 동기화**하세요.

| 구분 | 문서 |
|------|------|
| RFP | [RFP_Video_Capture_Pipeline](../../../docs/rfp/RFP_Video_Capture_Pipeline.md) · [RFP_Camera_Discovery](../../../docs/rfp/RFP_Camera_Discovery.md) · [RFP_WebRTC_Media_Gateway](../../../docs/rfp/RFP_WebRTC_Media_Gateway.md) · [RFP_STUN_TURN_ICE](../../../docs/rfp/RFP_STUN_TURN_ICE.md) · [RFP_LTS2026_YouTube_RTSP_Ingest](../../../docs/rfp/RFP_LTS2026_YouTube_RTSP_Ingest.md) · [RFP_YouTube_RTSP_Ingest](../../../docs/rfp/RFP_YouTube_RTSP_Ingest.md) |
| RFP | [RFP_Distributed_AI_Pipeline](../../../docs/rfp/RFP_Distributed_AI_Pipeline.md) — 스트리밍/분석 서버 분리 (SERVER_MODE) |
| PRD | [PRD_LTS2026_YouTube_RTSP_Ingest](../../../docs/prd/PRD_LTS2026_YouTube_RTSP_Ingest.md) · [PRD_Camera_Discovery](../../../docs/prd/PRD_Camera_Discovery.md) · [PRD_WebRTC_Media_Gateway](../../../docs/prd/PRD_WebRTC_Media_Gateway.md) · [PRD_STUN_TURN_ICE](../../../docs/prd/PRD_STUN_TURN_ICE.md) |
| PRD | [PRD_Distributed_AI_Pipeline](../../../docs/prd/PRD_Distributed_AI_Pipeline.md) — 스트리밍 서버 프레임 포워딩 제품 요구사항 |
| SRS | [SRS_LTS2026_YouTube_RTSP_Ingest](../../../docs/srs/SRS_LTS2026_YouTube_RTSP_Ingest.md) · [SRS_Camera_Discovery](../../../docs/srs/SRS_Camera_Discovery.md) · [SRS_WebRTC_Media_Gateway](../../../docs/srs/SRS_WebRTC_Media_Gateway.md) · [SRS_STUN_TURN_ICE](../../../docs/srs/SRS_STUN_TURN_ICE.md) |
| SRS | [SRS_Distributed_AI_Pipeline](../../../docs/srs/SRS_Distributed_AI_Pipeline.md) — ANALYSIS_SERVER_URL, back-pressure, 결과 오버레이 요구사항 |
| Design | [Design_RTSP_Capture_Backend](../../../docs/design/Design_RTSP_Capture_Backend.md) · [Design_FFmpeg_RTSP_Capture](../../../docs/design/Design_FFmpeg_RTSP_Capture.md) · [Design_WebRTC_Media_Gateway](../../../docs/design/Design_WebRTC_Media_Gateway.md) |
| Design | [Design_Camera_Discovery](../../../docs/design/Design_Camera_Discovery.md) · [Design_YouTube_RTSP_Ingest](../../../docs/design/Design_YouTube_RTSP_Ingest.md) · [Design_STUN_TURN_ICE](../../../docs/design/Design_STUN_TURN_ICE.md) |
| Design | [Design_Distributed_AI_Pipeline](../../../docs/design/Design_Distributed_AI_Pipeline.md) — 분산 파이프라인 아키텍처 설계 |
| TC | [TC_RTSP_Capture_Backend](../../../docs/tc/TC_RTSP_Capture_Backend.md) · [TC_FFmpeg_RTSP_Capture](../../../docs/tc/TC_FFmpeg_RTSP_Capture.md) · [TC_WebRTC_Media_Gateway](../../../docs/tc/TC_WebRTC_Media_Gateway.md) · [TC_STUN_TURN_ICE](../../../docs/tc/TC_STUN_TURN_ICE.md) |
| TC | [TC_Distributed_AI_Pipeline](../../../docs/tc/TC_Distributed_AI_Pipeline.md) — SERVER_MODE별 기능 테스트 케이스 |
| Ops | [RTSP_Capture_Backend_Setup](../../../docs/ops/RTSP_Capture_Backend_Setup.md) · [FFmpeg_Installation_Compatibility](../../../docs/ops/FFmpeg_Installation_Compatibility.md) |
| Ops | [Distributed_AI_Pipeline_Setup](../../../docs/ops/Distributed_AI_Pipeline_Setup.md) — 분산 배포 운영 가이드 |

## 코드 수정 시 문서 동기화 의무

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `ingestDaemonCapture.js`, `ingest_daemon.py` | `docs/design/Design_RTSP_Capture_Backend.md` §6, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| `captureFactory.js` | `docs/design/Design_RTSP_Capture_Backend.md` §2 코드스니펫 |
| `socket/streamHandler.js` (camera:capabilities) | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/design/Design_Server_Architecture.md` |
| `scripts/restartIngestDaemon.js` | `CLAUDE.md` 개발 명령어, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| `api/cameras.js` (FORCE_NO_WEBRTC) | `docs/design/Design_RTSP_WebRTC_Architecture.md` |
| `rtspCapture.js` *(레거시)* | `docs/design/Design_FFmpeg_RTSP_Capture.md` (Deprecated) |
| `gstreamerCapture.js` | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| `webrtcGateway.js`, `rtpIngestion.js` | `docs/design/Design_WebRTC_Media_Gateway.md` (Historical) |
| `discoveryService.js`, `onvifDiscovery.js` | `docs/design/Design_Camera_Discovery.md`, `docs/srs/SRS_Camera_Discovery.md` |
| `youtubeStreamService.js` | `docs/design/Design_YouTube_RTSP_Ingest.md`, `docs/srs/SRS_LTS2026_YouTube_RTSP_Ingest.md` |
| `mediamtx.yml` | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| coturn / TURN 설정 변경 | `docs/design/Design_STUN_TURN_ICE.md`, `docs/tc/TC_STUN_TURN_ICE.md` |
| `services/analysisClient.js` | `docs/design/Design_Distributed_AI_Pipeline.md`, `docs/ops/Distributed_AI_Pipeline_Setup.md` |

**공통 규칙**
- **새 기능 추가** → PRD + SRS + Design + TC 문서 모두 신규 작성 또는 기존 문서에 항목 추가
- **버그 수정** → 스펙 오류가 원인이면 SRS·Design 수정, TC에 회귀 케이스 추가
- **설정 파라미터 변경** → SRS 제약 조건 + Ops 가이드 + TC 경계값 반영
- **새 캡처 백엔드 추가** → Design_RTSP_Capture_Backend + SRS + TC + Ops 가이드 신규 추가
