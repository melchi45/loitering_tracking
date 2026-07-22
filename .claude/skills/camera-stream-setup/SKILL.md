---
name: camera-stream-setup
description: "LTS-2026 카메라 스트림 설정 및 관리. Use when: RTSP 카메라 추가/연결, ONVIF 카메라 자동 탐색, YouTube/RTMP 스트림 RTSP 변환 ingestion, WebRTC 미디어 게이트웨이 설정, MediaMTX 프록시/WHEP 설정, ICE/STUN/TURN 연결 문제 해결, 카메라 스트림 끊김 디버깅, 새 카메라 소스 지원 추가, CAPTURE_BACKEND 전환(ingest-daemon/gstreamer/ffmpeg), WEBRTC_ENGINE 선택(mediamtx/mediasoup), ingest-daemon 설정 및 재시작(ingest:restart), GStreamer 하드웨어 가속 설정(nvdec/vaapi), B-프레임 H264 카메라 처리, camera:capabilities 소켓 이벤트, Dashboard Channel Slot(channelSlot 전역 채널 매핑, MAX_CHANNEL_NUM, NVR 채널 전환). Covers: captureFactory.js, ingestDaemonCapture.js, ingest_daemon.py, rtspCapture.js, gstreamerCapture.js, pyavCapture.js, discoveryService.js, onvifDiscovery.js, youtubeStreamService.js, mediamtx.yml, streamHandler.js, channelSlotService.js."
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
  - MediaMTX 프로세스 시작 안 함 (`CAPTURE_BACKEND=mediamtx`/`WEBRTC_ENGINE=mediamtx` 설정 무관)
  - YouTubeStreamService yt-dlp 바이너리 탐색 및 로그 억제
  - UDPDiscovery 서브모듈 탐색 지연 (실제 스캔 요청 시까지)

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

---

## Ingest Daemon 정상 종료 (Graceful Shutdown)

서버 종료 시 ingest-daemon이 Traceback 없이 깔끔하게 종료되도록 2-phase 구조를 사용합니다.

### 종료 흐름

```
SIGINT 수신 → KeyboardInterrupt → finally
  ↓
_manager.stop_all()
  ├── Phase 1 (즉시): 모든 세션 _signal_stop()
  │     · self._stop.set()  ← 모든 스레드 루프에 즉시 종료 신호
  │     · push_executor.shutdown(wait=False)
  └── Phase 2 (대기): 모든 세션 _join_threads(timeout=3)
        · t.join(timeout=3) — KeyboardInterrupt 수신 시 무시
```

### 핵심 설계 원칙

- **Phase 1 선행**: 모든 세션 stop 신호를 동시에 설정 → MediaMTX 종료 후 Connection refused 경고 스팸 최소화
- **`except KeyboardInterrupt: pass`**: `t.join()` 내부 및 `stop_all()` 전체에서 두 번째 SIGINT 무시
- **스레드 루프 종료**: `while not self._stop.is_set()` + `except: if self._stop.is_set(): break` 패턴으로 stop 신호 후 예외는 조용히 종료

---

## Ingest Daemon Watchdog 및 자동 복구

LTS-2026은 세 계층의 Watchdog으로 스트림 고착·프로세스 충돌을 자동 복구합니다.

### 계층 구조

```
계층 1  ingest_daemon.py / _Watchdog (Python)
        RTSP_READ_TIMEOUT(기본 5s) 동안 RTP 없으면 PyAV 컨테이너 강제 종료 → 자동 재연결

계층 2  pipelineManager.js / frameWatchdogTimer (Node.js)
        마지막 JPEG 수신 후 20s 경과 시 ingest-daemon에 DELETE+POST 재등록
        (mediamtx·mediasoup 두 경로 모두 처리)

계층 3  startServer.js / _respawnIngest (Node.js)
        ingest-daemon 프로세스 종료 감지 → 지수 백오프 재시작 →
        POST /api/internal/ingest/reregister → pipelineManager.reregisterAllWithIngestDaemon()
```

### 복구 흐름 (계층 3)

```
ingest-daemon crash
  → exit 이벤트 (startServer.js)
  → _shuttingDown? return (정상 종료 시 무시)
  → _respawnIngest(): 1s 대기 후 재시작
  → /health 폴링 성공
  → POST /api/internal/ingest/reregister
      → pipelineManager.reregisterAllWithIngestDaemon()
          ├── ctx._ingestRtspUrl 있음 → _ingestRegisterCamera() 직접 호출 (mediamtx)
          └── 없음 + CAPTURE_BACKEND=ingest-daemon → engine.addCameraStream() (mediasoup)
  → 전체 카메라 재등록 완료 (~2-5s)
```

재시작 백오프: `1s → 1.5s → 2.25s → ... → 최대 30s` (성공 시 0 리셋)

### 로그 패턴

```
# 계층 2 — 프레임 watchdog 발동
[INFO] [PipelineManager][cam-id] Frame watchdog: no frame for 24s — restarting capture
# ingest-daemon 죽은 경우 (계층 3이 이어받음)
[ERROR] [PipelineManager][cam-id] ingest-daemon register failed: fetch failed

# 계층 3 — 프로세스 자동 재시작
[WARNING] [Start] ingest-daemon exited (code=1)
[WARNING] [Start] ingest-daemon crashed — restarting in 1.0s (attempt #1)
[INFO]    [Start] ingest-daemon restarted on :7070 — re-registering cameras
[INFO]    [Start] ingest reregister: HTTP 200
```

**버그 수정 — 계층 2 watchdog 재진입 가드 누락으로 인한 restart storm (2026-07-15):** `frameWatchdogTimer`의 `setInterval(async () => {...}, 8_000)` 콜백에 재진입 가드가 없어, `_ingestRemoveCamera()`+`_ingestRegisterCamera()` 재등록 왕복(재시도 포함 최대 ~15.5s)이 8초 폴링 주기보다 오래 걸리면 다음 tick이 이전 복구가 끝나기 전에 또 발동 — 같은 카메라에 remove+register를 중복 실행해 연결이 안정화되기도 전에 스스로 다시 끊는 무한 루프가 발생했음. TID-A800(`192.168.214.32`, RTSP 핸드셰이크 자체가 15초 이상 소요)에서 실측·재현, 로그상 "Stopped → removed → AI loop starting"이 8~25초 주기로 끝없이 반복되고 `AI frame #1`을 넘기지 못하는 패턴으로 나타남 — WebRTC "연결 안 됨"·전반적 "재생 끊김" 증상의 공통 원인이었음(재등록 왕복이 순간적으로 8초를 넘기면 어느 카메라에서도 재현 가능). 수정: `ctx._watchdogBusy` 재진입 가드 추가 + `capture.start()` 이후 `lastFrameAt`을 재시작 완료 시점 기준으로 재갱신(재등록 소요 시간만큼 유예가 깎이지 않도록). 소스: `server/src/services/pipelineManager.js`. 상세: `docs/design/Design_RTSP_Capture_Backend.md` §6.7.

**신규 — `Camera.webrtcVideoOnly` (세션 부하 완화, 2026-07-15):** 위 재진입 가드 수정 후에도 TID-A800은 stall이 완전히 사라지지 않았음 — ping(0% 손실)과 AI 디코딩 멀티스레드화(`thread_type=AUTO`)로도 해결 안 됨, 진짜 원인은 카메라 자체의 동시 RTSP 세션 처리 한계였음(실측: 물리 카메라 1대당 세션 총량을 8→6으로 줄이자 양쪽 채널 모두 안정화). `PUT /api/cameras/:id { webrtcVideoOnly: true }`로 카메라별 audio+App RTP RTP 세션을 생략하고 AI+video만 유지(카메라당 세션 4→2) — mediasoup WHEP 소비자 쪽엔 오디오/데이터채널이 없다는 것만 다를 뿐 영상 재생엔 영향 없음. RTSP 세션 부하가 큰(동시 채널 다수 등록·저사양 인코더) 카메라에 적용. 소스: `server/src/services/webrtc/mediasoupEngine.js` `addCameraStream()` opts.videoOnly. 상세: `docs/design/Design_RTSP_Capture_Backend.md` §6.7.

### 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `RTSP_READ_TIMEOUT` | `5` | PyAV 내부 watchdog 타임아웃(초). 불안정 네트워크에서는 10–15로 증가 |

### 수동 진단

```bash
# 1. 로그 확인
grep "watchdog\|crashed\|reregister" /var/log/lts/lts-$(date +%Y-%m-%d).log

# 2. 데몬 상태 확인
curl http://127.0.0.1:7070/health

# 3. 수동 재시작 (서버 재시작 없이)
cd server && npm run ingest:restart

# 4. PyAV 환경 확인
python3 -c "import av, PIL; print(av.__version__)"
```

설계 상세 → [Design_RTSP_Capture_Backend.md §6.7](../../../docs/design/Design_RTSP_Capture_Backend.md)  
운영 가이드 → [RTSP_Capture_Backend_Setup.md](../../../docs/ops/RTSP_Capture_Backend_Setup.md)

**버그 수정 — 카메라 삭제 후에도 ingest-daemon이 계속 재연결 시도 (2026-07-02, `Design_RTSP_Capture_Backend.md` §10.4):** `DELETE /api/cameras/:id` → `pipelineManager.stopCamera()`가 ingest-daemon에 보내는 `DELETE /cameras/:id`가 fire-and-forget에 실패를 완전히 삼키고 있었음(재시도 없음, 로그 없음) — 네트워크 순간 장애 등으로 이 요청이 실패하면 ingest-daemon엔 삭제된 카메라의 "좀비" 세션이 남아 무한 재연결. `_ingestRemoveCamera()`(`pipelineManager.js`)에 500ms 후 1회 재시도 + 최종 실패 시 `console.warn` 로그 추가, `mediasoupEngine.js`의 `_ingestDelete()`도 비-2xx/에러를 로그, `stopCamera()`가 세 정리 작업(mediamtx/mediasoup/ingest-daemon)을 `Promise.allSettled()`로 **await**하도록 변경 — `DELETE /api/cameras/:id`의 API 응답이 실제 정리 시도(재시도 포함) 완료 후 반환됨. 여전히 재연결되면 ingest-daemon 자체 로그(`GET /admin/logs/recent?source=ingest`)에서 `"Camera removed: <id> (found=<bool>)"` 확인 — `found=false`면 ID 불일치, 라인 자체가 없으면 요청이 ingest-daemon에 아예 도달 못한 것.

---

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

### WiseNet/Hanwha UDP Discovery 프로토콜

**레퍼런스:** SUNAPI IP Installer 스펙 §3.2~§3.4 (`http://55.101.56.209:8080/site/SUNAPI/SUNAPI_ipinstaller.html`), Annex A §5.1 (진짜 C 구조체 — 아래 참고)  
**포트:** 송신 `7701` (broadcast → 카메라), 수신 `7711` (카메라 → 서버)  
**패킷:** 334바이트 고정 바이너리 요청(`nMode=6`) → 카메라가 바이너리 응답 반환(base 261 bytes + extended 73 bytes)

응답 패킷 바이너리 레이아웃 — **필드 정의의 단일 소스는 `submodules/WiseNetChromeIPInstaller/nodejs/protocol.js`의 `FIELDS` 배열**이며, 아래 표는 그 값을 그대로 옮긴 것 (2026-07-03 갱신 — `reserved2`/`reserved3`, `nSupportedProtocol` 반영):

| 오프셋 | 크기 | 필드 | 설명 |
|--------|------|------|------|
| 0 | 1 | `nMode` | 패킷 모드 |
| 1 | 18 | `chPacketID` | 패킷 ID |
| 19 | 18 | `chMAC` | MAC 주소 (ASCII null-term) |
| 37 | 16 | `chIP` | IP 주소 |
| 53 | 16 | `chSubnetMask` | 서브넷 마스크 |
| 69 | 16 | `chGateway` | 게이트웨이 |
| 85 | 20 | `chPassword` | 기본 패스워드 |
| 105 | 1 | `is_only_support_sunapi` | `1`=SUNAPI 지원 |
| 106 | 2 | `nPort` | HTTP(S) 웹 접속 포트 (uint16 **LE**) — **RTSP 포트 아님**, 아래 참고 |
| 108 | 1 | `nStatus` | 상태 |
| 109 | 10 | `chDeviceName` | 장치명 (짧은) |
| **119** | **1** | **`reserved2`** | Annex A `DATAPACKET_IPv4_T.reserved2` — §3.2/§3.3 요약 테이블엔 없던 필드 |
| 120 | 2 | `nHttpPort` | HTTP 포트 (uint16 **LE**) |
| 122 | 2 | `nDevicePort` | Device 포트 |
| 124 | 2 | `nTcpPort` | VNP 프로토콜 전용 TCP 스트림 포트 — **VNP 클라이언트일 때만 유효, RTSP 포트 아님** |
| 126–130 | 2+2+2 | `nUdpPort`, `nUploadPort`, `nMulticastPort` | 기타 포트 (VNP 전용) |
| 132 | 1 | `nNetworkMode` | 네트워크 모드 (0=Static, 1=DHCP, 2=PPPoE) |
| 133 | 128 | `chDDNS` | DDNS 호스트명 |
| **261** | 32 | `chAlias` | 별칭 *(확장 블록 시작 — `nMode=12`일 때만 존재)* |
| 293 | 32 | `chNewModelName` | 장치명 전체 (UI 표시 우선) |
| 325 | 1 | `nModelType` | Device Type (0x00 Camera ~ 0x09 AccessController) |
| 326 | 2 | `nVersion` | 펌웨어 버전 비트마스크 (uint16 **BE** — 유일하게 빅엔디언) |
| 328 | 1 | `nHttpMode` | `0`=HTTP, `1`=HTTPS |
| **329** | **1** | **`reserved3`** | Annex A `DATAPACKET_EXT_IPv4_T.reserved3` — §3.2/§3.3 요약 테이블엔 없던 필드 |
| 330 | 2 | `nHttpsPort` | HTTPS 포트 (uint16 **LE**) |
| 332 | 1 | `nSupportedProtocol` | 지원 프로토콜 비트마스크 (0x01 SVNP, 0x02 SUNAPI1.0, 0x04 SUNAPI2.0, 0x08 SUNAPI2.3.1+, 0x10 SVP) |
| 333 | 1 | `nPasswordStatus` | `0`=비밀번호 있음, `1`=없음 (필드명과 반대 의미 주의) |

> **RTSP 포트는 이 응답 어디에도 없습니다.** `nPort`(HTTP/HTTPS 웹 포트)와 `nTcpPort`(VNP 전용)를 RTSP 포트로 오인해 쓰던 버그가 2026-07-03에 발견·수정됐습니다 — 아래 "RTSP URL 생성" 참고.

**구현 아키텍처 (2026-07-03 개편, 2026-07-03 재정정 — npm 패키지 단일 경로, 인라인 폴백 없음):**

`submodules/WiseNetChromeIPInstaller/nodejs/`(git 서브모듈)가 프로토콜 구현의 원본이지만, `server/src/utils/udpDiscovery.js`는 **그 파일시스템 경로를 직접 읽지 않습니다** — 오직 `wisenet-chrome-ip-installer` npm `optionalDependencies`(`server/package.json`, 서브모듈과 동일 저장소/브랜치를 `npm install`로 획득)만을 통해 접근합니다:

```bash
cd server && npm install   # wisenet-chrome-ip-installer optionalDependency
```

`server/src/utils/udpDiscovery.js`는 npm 패키지를 재노출하는 60줄짜리 얇은 파일입니다 — **더 이상 자체 소켓/파싱 구현(`UDPDiscoveryFallback`)도, 서브모듈 경로 직접 탐지 로직도 갖지 않습니다.** 과거엔 이 파일이 서브모듈 미초기화 시를 대비해 WiseNet 바이너리 프로토콜을 통째로 중복 구현하고 있었지만(§"UDP Discovery 인라인 폴백" 이력 참고), 그 중복 유지 비용(엔디언 버그 등 실제 drift 사례 있었음)보다 npm 패키지 경로 하나로 단순화하는 게 더 안전하다고 판단해 제거했습니다.

- **지연 로딩(2026-07-03 재정정)**: `require('wisenet-chrome-ip-installer/...')`는 `getUDPDiscovery()` 실제 호출(또는 export 프로퍼티 접근) 시점까지 지연됩니다 — `discoveryService.js`가 `SERVER_MODE`와 무관하게 이 파일을 무조건 require하는데, 파일 최상단에서 즉시 require하면 `SERVER_MODE=analysis`(카메라 자체가 없어 discovery를 아예 안 쓰는 모드)에서도 패키지 미설치 시 서버가 기동 실패하는 회귀가 실측으로 발생했습니다(2026-07-03). `require('./udpDiscovery')` 자체는 패키지가 없어도 절대 실패하지 않고, 실제로 discovery를 쓰려고 할 때만(`getUDPDiscovery()` 호출) 명확한 에러로 실패합니다.
- 패키지가 없으면(`npm install`을 안 돌렸거나 실패) `getUDPDiscovery()` 호출 시점에 `require()`가 실패합니다 — 더 이상 "조용히 폴백"하지 않고 명시적으로 에러가 납니다.

**Request/Response/protocol.js 클래스:** `submodules/WiseNetChromeIPInstaller/nodejs/` 하위 3개 파일이 프로토콜 구현을 담당합니다.

- **`protocol.js`** — 포트 상수(`SEND_PORT`/`RECEIVE_PORT`/`BROADCAST_ADDR`), 위 334바이트 `FIELDS` 테이블, `NMODE`(요청+응답 12개 값 전체), `NON_SCAN_RESPONSE_MODES`, 그리고 응답 필드별 열거형 상수(`NVERSION` 비트마스크, `NETWORK_MODE`, `DEVICE_TYPE`, `HTTP_MODE`, `SUPPORTED_PROTOCOL` 비트마스크, `PASSWORD_STATUS`) — request.js/response.js/udpDiscovery.js 세 파일이 전부 여기서 import (과거엔 `NMODE`가 세 파일에 각각 다른 부분집합으로 중복 정의돼 있었음)
- **`request.js`(`UdpRequest`)** — §3.2 SendData Format. 기본값 `nMode = DEF_REQ_SCAN_EXT (6)`, MAC+random 기반으로 매번 새로 생성되는 `chPacketID`, 나머지는 스펙상 "Unused"(0). 생성자 인자로 임의 필드 오버라이드 가능(`new UdpRequest({ nMode: 1 })`로 과거 옵코드 재현 가능)
- **`response.js`(`UdpResponse`)** — §3.3 RecvData Format. `UdpResponse.parse(buf, rinfo)`가 base 필드는 무조건, 확장 블록은 `nMode===12`이고 필드별로 남은 바이트 수가 충분할 때만 파싱(필드 하나라도 짧으면 그 이후 전부 `undefined`). `toString()`으로 파싱 결과를 `name=value` 한 줄로 표시, `parse()`가 성공 시 자동 `console.log`. `hasVersionFlag(flag)`/`hasSupportedProtocol(flag)` 인스턴스 메서드로 비트마스크 필드 조회
- `udpDiscovery.js`의 `_sendDiscovery()`는 `new UdpRequest({ nMode: NMODE.DEF_REQ_SCAN_EXT })`(옵코드 `6`)로 요청 패킷을 생성해 전송 — 과거 하드코딩된 `DISCOVERY_PACKET`(옵코드 `1`)은 **삭제하지 않고 주석 처리**로 남겨 즉시 롤백 가능. `_parseResponse()`는 이제 `UdpResponse.parse()`에 위임하는 얇은 필드명 어댑터로 축소(`chMac`/`DDNSURL`/`modelType` 등 기존 소비자 계약 유지)
- 소켓의 `'message'` 핸들러가 `UdpResponse.parse()`로 응답 `nMode===12`(`DEF_RES_SCAN_EXT`)를 독립 확인해 `'scanExtConfirmed'` 이벤트 발생 — §3.4.1/§3.4.2의 "옵코드 6 요청 → 옵코드 12 응답" 왕복 검증용 신호, 실제 `'device'` 이벤트는 그대로 `_parseResponse()`가 담당
- **`reserved2`/`reserved3` 오프셋 버그 (2026-07-03 발견·수정)**: §3.2/§3.3의 필드 테이블은 Annex A의 진짜 C 구조체에 있는 1바이트 예약 필드 2개(`chDeviceName` 뒤 `reserved2`, `nHttpMode` 뒤 `reserved3`)를 누락 — 이를 그대로 옮긴 초기 `FIELDS`(332바이트)도 누락해서 `nHttpPort` 이후 모든 필드가 1바이트씩 밀려 그럴듯하지만 틀린 값을 반환했음(예: 실제 포트 80이 20596으로 나옴). 실제 캡처 패킷으로 기존 `_parseResponse()`와 직접 대조해 발견, `FIELDS`에 두 예약 필드 추가(334바이트) 후 완전히 일치 확인. 실측(라이브 네트워크 140여 대 응답 전부 정확히 334바이트)으로도 재확인.
- **nMode 옵코드 전환 (FR-CAM-082의 "채택 안 함" 결정을 뒤집음)**: 과거엔 `nMode=6`이 무관한 광범위한 네트워크 응답을 유발한다는 실측 이유로 `nMode=1`을 유지했으나, 이번에 기본값을 `nMode=6`으로 전환하고 실제 카메라 fleet(100여 대) 대상 라이브 왕복 검증 완료. 부작용 재현 시 `new UdpRequest({ nMode: 1 })`로 즉시 롤백 가능.
- **`nVersion` 엔디언/비트 해석은 미확정 상태로 보류 (2026-07-03 조사, 미채택)**: 실측된 `nVersion` 값(3328/3072/1288)을 현재 BE 2바이트 그대로 해석하면 3개 중 2개가 4개 문서화 플래그(0x01/0x02/0x04/0x08) 전부 꺼진 것으로 나오고, 반대로 LE로 뒤집으면 2개는 그럴듯해지지만 나머지 1개가 오히려 문서에 없는 상위 비트까지 켜져 더 지저분해짐 — 어느 쪽도 3개 샘플 전부를 깔끔하게 설명하지 못해 표본 부족/미문서화 비트 가능성을 배제할 수 없음. Annex A가 `unsigned short version`(2바이트 단일 필드)이라고 명시하고 있고 레거시 파서도 항상 이렇게 읽어왔으므로, `reserved2`/`reserved3`급의 명확한 반증이 나오기 전까진 현재 구현(BE, 2바이트) 유지.

**RTSP URL 생성 (2026-07-03 버그 수정):**
```
rtsp://{chIP}:554/0/H.264/media.smp
```
과거엔 `nTcpPort`(VNP 전용 필드) 또는 `nPort`(HTTP 웹 포트)를 RTSP 포트인 것처럼 써서 `rtsp://{chIP}:{nTcpPort}/profile1/media.smp`를 생성했으나, 위 표의 스펙 원문 설명("nTcpPort: valid only if Client uses VNP")대로 이는 잘못된 필드였습니다. **UDP 응답 어디에도 진짜 RTSP 포트 필드는 없습니다** — 이제 SUNAPI 표준 기본값 `554`로 고정하고, 실제 확인된 포트가 필요하면 `querySunapiRtspPort()`(§"SUNAPI RTSP URL 패턴" 참고, CGI 조회)로 별도 확인합니다. `server/src/services/discoveryService.js`의 `mapUDPDevice()`도 동일한 이유로 `raw.nPort` 기반 `rtspPort` 폴백을 제거하고 554로 고정 — 이 값은 `camera.Port`로 클라이언트 UI(`DiscoveredCameraPanel.tsx`, "RTSP Port" 행)에 그대로 노출되므로 실사용에 영향 있는 버그였습니다. 이 수정이 §"SUNAPI RTSP URL 패턴" 절에 이미 기록된 "192.168.214.32 저장된 rtspUrl 포트(10030) vs 실제 RTSPPort(554) 불일치" 현상의 근본 원인으로 추정됩니다.

**SUNAPI CGI Digest Auth 감지 보강 (2026-07-03):** `querySunapiMaxChannel()`/`querySunapiRtspPort()`(`discoveryService.js`) 모두 Basic을 먼저 시도하고 401/403의 `WWW-Authenticate`가 Digest를 요구할 때만 재시도하는 구조는 유지하되, 감지 정규식을 `/^Digest\s/i`(문자열 맨 앞에만 매칭)에서 `/\bDigest\b/i`(단어 경계 매칭)로 변경 — 서버가 `WWW-Authenticate` 헤더를 여러 개 보내면 Node가 `"Basic realm=\"x\", Digest realm=\"y\", ..."`처럼 콤마로 합치는데, Digest가 맨 앞이 아니면 기존 정규식이 놓쳤습니다. `buildDigestAuthHeader()`도 realm/nonce/qop 파싱 범위를 challenge 문자열 전체가 아니라 "Digest" 이후 부분으로 한정해, 콤바인드 헤더에서 Basic의 realm을 잘못 집어가지 않도록 보강.

### MaxChannel 및 채널 선택 (NVR/DVR 지원)

WiseNet NVR이나 ONVIF NVR 장비는 채널 수(`MaxChannel > 1`)를 반환합니다.

> **중요**: `MaxChannel = profiles.length` 는 잘못된 방식입니다. 단일 카메라도 메인/서브 2개 프로필을 가지므로 반드시 **SourceToken 기반** 판별을 사용합니다.

**서버측 MaxChannel 도출 순서 (FR-CAM-060~063):**

| 단계 | 방법 | 파일 |
|------|------|------|
| 1 | ONVIF `GetProfiles` → 고유 `SourceToken` 수 카운트 (`sourceTokenOrder.size`) | `onvifDiscovery.js` `enrichDevice()` |
| 2 | SUNAPI best-effort 쿼리 (no-auth, 2 s timeout) | `discoveryService.js` `querySunapiMaxChannel()` |
| 3 | `mergeDevices()` — `Math.max(existing, incoming)` 병합 | `discoveryService.js` |

**SourceToken 규칙 (FR-CAM-060):**
- 단일채널 카메라: 모든 프로필이 동일한 `SourceToken` → `MaxChannel = 1`
- 4채널 NVR: 4개의 다른 `SourceToken` → `MaxChannel = 4`
- 각 프로필에 `channelIndex` (1-based) 부여 — 같은 채널의 메인/서브 프로필은 동일 `channelIndex`

**SUNAPI MaxChannel 쿼리 엔드포인트 (FR-CAM-062, 2026-07-02 엔드포인트 정정 — FR-CAM-062a):**
- `GET /stw-cgi/attributes.cgi/attributes` → XML 응답, `<group name="System"><category name="Limit"><attribute name="MaxChannel" type="int" value="N"/></category></group>` 경로에서 `value` 파싱 (벤더 SUNAPI IP Installer 자체의 쿼리 경로 `System/Limit/MaxChannel`과 동일 — `submodules/WiseNetChromeIPInstaller/media/ump/Network/http/attributes.js` 참조)
- **잘못된 과거 구현(수정됨)**: 원래 `media.cgi?msubmenu=channellist&action=view`/`system.cgi?msubmenu=systeminfo&action=view` 두 경로를 JSON으로 조회하도록 문서·코드에 기재되어 있었으나, 이 두 경로는 실제 SUNAPI CGI에 존재하지 않아 항상 실패(404/connection error)했음 — 즉 자격증명 유무와 무관하게 이 쿼리는 한 번도 성공한 적이 없었음
- 인증 필요(401/403), 타임아웃, XML 파싱 실패, 속성 미발견 → `MaxChannel = 1` 유지

**버그 수정 — SUNAPI가 Basic 인증만 받아들여, Digest를 요구하는 펌웨어에서 정상 자격증명도 계속 401로 거부되던 문제 (2026-07-02, FR-CAM-072):** `querySunapiMaxChannel()`는 원래 `Authorization: Basic base64(user:pass)`만 보냈음 — 실 카메라(192.168.214.32, nginx 기반 iPolis 펌웨어)는 어떤 요청이든 `WWW-Authenticate: Digest qop="auth", realm="..."`로 401 응답하고 Basic 인증 자체를 받아들이지 않아, 비밀번호가 맞아도 매번 401(auth rejected)로 실패 — `curl --digest -u admin:<password> ...`로 독립 검증한 결과 자격증명 자체는 정상(`HTTP 200`, `MaxChannel=2`)이었음이 확인되어 원인이 인증 스킴 불일치임을 특정. 수정: Basic 시도 후 401 응답의 `WWW-Authenticate`가 `Digest`를 광고하면 RFC 7616 Digest 응답(MD5, `qop=auth`)을 계산해 1회 재시도 (`buildDigestAuthHeader()` 신규 함수) — `Basic`만 광고하거나 Digest 재시도도 401이면(진짜 잘못된 비밀번호) 기존과 동일하게 실패 처리. 진단용 스크립트 `test/api/probe_camera_maxchannel.js` 신규 추가 (실제 카메라에 직접 `querySunapiMaxChannel()`/`enrichDevice()`를 호출, 서버/DB 불필요). 상세: `docs/design/Design_Camera_Discovery.md` §3.1 "SUNAPI Digest auth", `docs/design/Design_Channel_Slot.md` §4.6g, `docs/srs/SRS_Camera_Discovery.md` FR-CAM-072.

**후속 버그 수정 — SUNAPI HTTPS 접속 시 자체 서명 인증서를 거부하던 문제 (2026-07-02, FR-CAM-073):** 위 Digest 수정을 두 번째 실 카메라(192.168.214.37, HTTP:80이 HTTPS:443로 리다이렉트)로 검증하다 발견 — `sunapiRequest()`의 `https.get()`이 Node 기본 TLS 검증을 사용해 `self-signed certificate` 오류로 인증 단계 진입 전에 실패함. `onvifDiscovery.js`의 HTTPS SOAP 클라이언트는 동일한 이유로 이미 `rejectUnauthorized: false`가 적용돼 있었는데(온프레미스 IP 카메라/NVR은 거의 항상 자체 서명 인증서 사용), `querySunapiMaxChannel()`에는 이 옵션이 빠져 있었음. 수정 후 192.168.214.37은 `HTTP 200`으로 정상 응답해 실제 MaxChannel 값을 읽어옴. 인증(Basic/Digest) 자체를 우회하는 게 아니라 TLS 신뢰 단계만 완화한 것 — 상세: `docs/design/Design_Camera_Discovery.md` §3.1/§8, `docs/design/Design_Channel_Slot.md` §4.6g 후속 단락, `docs/srs/SRS_Camera_Discovery.md` FR-CAM-073.

**ONVIF 쪽 3종 개선 — HTTP/HTTPS 동시 시도 + GetVideoSources 기반 채널 판별 + 리다이렉트 추적 (2026-07-02, FR-CAM-074/075/076):** 위 SUNAPI 수정들을 검증하던 중 ONVIF 경로에서도 같은 종류의 문제가 발견/요청됨:
- **FR-CAM-074 (HTTP/HTTPS 동시 시도)**: 온디맨드 `probe-channels`는 ONVIF `device_service` XAddr을 추정만 할 수 있어(WS-Discovery처럼 장치가 알려주는 실제 URL이 없음) 기존엔 `http://`만 시도했음 — 한 장치의 SUNAPI와 ONVIF가 서로 다른 스킴을 쓸 수 있음(실측: 192.168.214.37은 SUNAPI가 HTTPS 전용, ONVIF는 평문 HTTP). `enrichDeviceAutoScheme(ip, { onvifPort, onvifHttpsPort })` 신규 함수가 두 스킴을 병렬로 시도해 결과가 있는 쪽을 사용 — WS-Discovery 스캔 경로(`ONVIFDiscovery` 클래스)는 XAddr이 장치가 준 실제 URL이라 스킴을 이미 알고 있으므로 영향 없음.
- **FR-CAM-075 (GetVideoSources 기반 MaxChannel/channelIndex)**: `enrichDevice()`가 `GetCapabilities` → Media Service 확인 후, `GetProfiles` 전에 `GetVideoSources`를 먼저 쿼리해 `VideoSources` 요소들의 `token`(`VideoSource_0`, `VideoSource_1`, ...)을 물리적 채널의 권위 있는 목록으로 사용 — 일부 NVR은 조작자가 실제로 연 채널에만 프로필을 자동 생성하므로, `GetProfiles`의 distinct-SourceToken 개수만으로는(기존 FR-CAM-060) 과소 집계될 수 있음. `GetVideoSources`가 실패/빈 응답이면 기존 FR-CAM-060 방식으로 폴백. 각 프로필의 `channelIndex`도 `GetProfiles` 응답 순서가 아니라 `GetVideoSources` 목록에서의 위치를 우선 사용.
- **FR-CAM-076 (동일 호스트 리다이렉트 추적)**: `soapPost()`가 `301`/`302`/`307`/`308` + 동일 호스트 `Location`을 1회 추적하도록 수정 — 192.168.214.37이 포트 80의 모든 ONVIF SOAP 요청을 HTTPS로 강제 리다이렉트해 기존엔 매번 `HTTP 301`로 실패했음. 다른 호스트로의 리다이렉트는 SSRF 방지를 위해 추적하지 않음.
- 세 가지 모두 mock 서버로 자동화됨: `test/api/nvr_channel_discovery.test.js` TC-H-018/H-018b(GetVideoSources)·TC-H-019(듀얼 스킴)·TC-H-020(리다이렉트). 상세: `docs/design/Design_Camera_Discovery.md` §3.1/§3.2/§8, `docs/srs/SRS_Camera_Discovery.md` FR-CAM-074~076.

**ONVIF SOAP 클라이언트 HTTP Basic→Digest 인증 재시도 (2026-07-03, FR-CAM-090):** SUNAPI CGI(FR-CAM-072/089)와 동일한 문제가 ONVIF 쪽에도 있었음 — `soapPost()`가 `Authorization` 헤더를 전혀 보내지 않아, ONVIF `device_service`를 nginx 등으로 HTTP 레벨 인증을 걸어둔 장비는 자격증명이 맞아도 항상 `AUTH_REQUIRED`로 실패. 수정: `soapPost(xaddr, body, credentials, redirectsLeft)`가 `credentials`(`{ username, password }`) 인자를 받아 Basic을 먼저 시도하고, 401의 `WWW-Authenticate`가 Digest를 광고하면 계산된 RFC 7616 Digest로 1회 재시도(`buildDigestAuthHeader()`/`challengesDigest()`를 `server/src/utils/digestAuth.js`로 이동해 `discoveryService.js`와 공유 — 더 이상 두 파일에 같은 MD5 로직 중복 없음). `enrichDevice(ip, xaddr, credentials)`/`enrichDeviceAutoScheme(ip, { onvifPort, onvifHttpsPort, username, password })`/`ONVIFDiscovery` 생성자(`RTSP_DEFAULT_USERNAME`/`PASSWORD` 기본값, FR-CAM-068과 동일 패턴)까지 credentials를 전파. `POST /api/cameras/probe-channels`(`server/src/api/cameras.js`)는 SUNAPI 프로브에 쓰던 `effectiveUsername`/`effectivePassword`를 ONVIF 프로브에도 그대로 넘김. **범위**: HTTP 전송 레벨 Basic/Digest만 커버 — ONVIF SOAP 자체의 WS-Security(`wsse:UsernameToken`)는 여전히 미구현. mock 서버가 서버측에서 실제 RFC 7616 해시를 검증하는 TC-H-037~039b로 자동화. 상세: `docs/design/Design_Camera_Discovery.md` §3.2a, `docs/srs/SRS_Camera_Discovery.md` FR-CAM-090.

**클라이언트 CameraList.tsx 탐색 목록 카드 (FR-CAM-064):**
```
┌──────────────────────────────┐
│ ● XRN-810S              8CH │  ← amber 배지, MaxChannel > 1 시 표시
│   Hanwha Vision · 192.168.1.10
│                        SUNAPI│
│                        ONVIF │
└──────────────────────────────┘
```

**DiscoveredCameraPanel.tsx 채널 선택 UI (FR-CAM-065~067):**
- `MaxChannel > 1` 인 경우:
  - `CH N` 버튼 그리드 표시 (1..MaxChannel)
  - `channelIndex === N` 이고 `rtspUrl` 있는 채널에 `●` 초록 인디케이터
  - 채널 클릭 시 RTSP URL 실시간 갱신
  - "+ Add Ch N to System" 버튼 — 이름 자동 suffix: `"{모델명} Ch{N}"`
- RTSP URL 채널별 생성 (우선순위):
  1. `profiles.find(p => p.channelIndex === N && p.rtspUrl)` — ONVIF profile 우선
  2. `profiles[N-1].rtspUrl` — 레거시 인덱스 fallback
  3. `channelRtspUrl(base, N)` — `/profile1/` → `/profileN/` 치환

**채널 추가 흐름 (NVR 8채널 예시):**
1. 탐색 결과 카드에 `8CH` 앰버 배지 표시
2. 카드 클릭 → 패널 열림, "Channel Selection" 섹션에 CH 1~8 버튼 그리드
3. CH 3 클릭 → RTSP URL 자동 갱신: `rtsp://192.168.1.10:554/profile5/media.smp`
4. "+ Add Ch 3 to System" 클릭 → `POST /api/cameras { name: "XRN-810S Ch3", rtspUrl: "..." }`

**테스트 스크립트:** `test/api/nvr_channel_discovery.test.js` (TC-H-001~TC-H-013)

### Dashboard Channel Slot (전역 채널 매핑, 2026-07-02 추가)

> **`channelIndex`(위 NVR 하위채널)와 완전히 별개의 개념입니다.** 혼동 금지.

| 개념 | 필드 | 범위 | 의미 |
|---|---|---|---|
| NVR 하위채널 | `channelIndex` | 1-based, NVR 장비 내부 | "이 카메라 레코드가 NVR의 몇 번 물리 입력을 읽는가" — SUNAPI/ONVIF discovery 시에만 설정 |
| Dashboard Channel Slot | `channelSlot` | 1..`MAX_CHANNEL_NUM`(기본 512), **시스템 전체에서 유일** | "Streaming Dashboard Grid의 어느 셀에 표시되는가" — Add/Edit 화면에서 항상 설정 |

**핵심 설계:**
- `server/.env`의 `MAX_CHANNEL_NUM`(기본 512)로 상한 조정 — `server/src/services/channelSlotService.js`가 `getMaxChannelNum()`으로 읽음
- `POST /api/cameras`, `POST /api/youtube-streams`: `channelSlot` 생략 시 최저 빈 슬롯 자동 배정 (하위 호환), 충돌 시 `409`
- `PUT /api/cameras/:id`, `PATCH /api/youtube-streams/:id`: `channelSlot` 변경 가능 (기존에는 add-time 전용이었던 `channelIndex`도 `PUT`으로 변경 가능해짐)
- 서버 시작 시 `backfillChannelSlots()`(`server/src/db/index.js`에서 `initDB()` 직후 호출)가 `channelSlot` 없는 기존 카메라에 `createdAt` 오름차순으로 순차 배정 — **멱등**, 매 시작마다 안전하게 재실행 가능
- 클라이언트 `CameraGrid.tsx`는 배열 순서가 아닌 `channelSlot` 매핑으로 렌더링 (`Map<channelSlot, Camera>` — `camerasBySlot.get(groupStart + idx + 1)`), 빈 슬롯은 점선 테두리 placeholder
- `ChannelSlotPicker.tsx` (공용 컴포넌트) — stepper(±1, 직접입력) + Group 페이징 브라우저(현재 대시보드 레이아웃의 채널 수 단위로 `1..MAX_CHANNEL_NUM` 페이징, 사용 중/빈 슬롯 표시) — `CameraList.tsx`(Add, RTSP+YouTube 탭 공용) / `CameraEditModal.tsx`(Edit) 양쪽에서 사용
- **Edit 화면 NVR 채널 전환**: `maxChannel > 1`인 카메라는 Edit 모달에도 `CH 1..maxChannel` 버튼 표시. 버튼 클릭 자체는 라이브 재조회 없이 이미 알고 있는 `nvrProfiles`(채널별 RTSP URL 배열, add-time 또는 아래 Re-detect로 확보)에서 조회 → 없으면 SUNAPI 경로치환(`channelRtspUrl()`, 클라이언트 `client/src/utils/channelRtsp.ts` + 서버 `server/src/utils/channelRtsp.js` 트윈으로 이중 구현) 폴백 → 그것도 실패하면 버튼 비활성화
- ONVIF discovery는 (2026-07-03, FR-CAM-090) HTTP Basic 시도 후 Digest 챌린지 시 재시도하도록 개선됨(`onvifDiscovery.js` `soapPost()`, `probe-channels`가 SUNAPI와 동일한 `effectiveUsername`/`effectivePassword`를 ONVIF 쪽에도 전달) — 단, SOAP 레벨 WS-Security(`wsse:UsernameToken`)를 요구하는 장비는 여전히 채널 수를 확인하지 못하고 "single-channel"로 보고됨(HTTP 레벨 인증만 커버, 별도 과제로 남음)

**즉시 채널 감지 — discovery 스캔 없이 (2026-07-02 추가):** 위 두 UI(Add/Edit)는 원래 "discovery 스캔으로 찾은 장치"에서만 채널 정보를 얻을 수 있었음. 이제 IP 하나만 알면 즉시 감지 가능:
- `POST /api/cameras/probe-channels { ip, httpPort?, httpType?, onvifPort?, username?, password?, baseRtspUrl? }` → `{ maxChannel, supportSunapi, protocol: 'sunapi'|'onvif'|'none', profiles }`
- 내부적으로 `querySunapiMaxChannel()`(`discoveryService.js`, 재사용)과 `enrichDevice(ip, guessedXAddr)`(`onvifDiscovery.js`, 신규 export)를 **병렬** 실행, 각각 `PROBE_TIMEOUT_MS`(8초) 개별 타임박스 — 응답 없는 장치가 요청 전체를 붙잡지 않도록 `Promise.race()` 폴백 패턴 사용
- ONVIF XAddr을 WS-Discovery 없이 `http://{ip}:{onvifPort||80}/onvif/device_service` (Hanwha/Axis/Dahua/Hikvision 공통 관례 경로)로 추정 — 이 경로를 쓰지 않는 소수 장비는 감지 실패
- 두 프로토콜 모두 다채널 보고 시 **ONVIF 우선** (GetStreamUri로 검증된 실제 RTSP URL 보유, SUNAPI는 경로치환 추정값)
- 클라이언트 UI: `CameraList.tsx` Add 모달(RTSP 탭)에 "🔍 Detect Channels" 버튼(RTSP URL에서 IP 파싱), `CameraEditModal.tsx`에 "🔍 Re-detect" 버튼(`maxChannel` 유무와 무관하게 **항상 표시** — 이 기능 이전에 추가된 기존 카메라도 채널 재감지 가능)
- Re-detect 결과는 `redetected` 로컬 state로 유지되다가 Save 시에만 `PUT /api/cameras/:id`로 영구 저장 (클릭만 하고 저장 안 하면 기존 값 불변)

**버그 수정 — Re-detect가 무반응처럼 보이던 결함 (2026-07-02, FR-CH-049a):** `CameraEditModal.tsx`의 NVR Channel 섹션이 "채널 없음(2-way)" 게이트만 갖고 있어서, Re-detect를 클릭해 요청이 정상적으로 완료됐지만 `maxChannel ≤ 1`(다채널 NVR 아님, 또는 ONVIF 인증 실패로 조용히 실패)인 경우 클릭 전과 똑같은 "click Re-detect to query..." 문구가 그대로 남아있어 마치 버튼이 안 먹는 것처럼 보였음. `redetected`(시도 여부) 상태를 추가해 "아직 시도 안 함" vs "시도했지만 결과 없음" 두 문구로 분리해 수정 — **비동기 버튼의 결과가 정상적으로 "빈 결과"일 수 있다면, 반드시 (미시도/시도+빈결과/시도+데이터) 3단계 상태로 나눠야 함. 2-way 불리언 게이트 하나로는 "빈 결과"와 "안 눌림"이 똑같이 렌더링됨** — 이 패턴은 Channel Slot 외 다른 비동기 액션 버튼(예: SUNAPI 재탐지류)에도 동일 적용.

**버그 수정 — Add 모달 "Detect Channels"가 UDP SUNAPI Discovery 결과를 무시하고 재탐지하다 실패 (2026-07-02):** `CameraList.tsx`의 `handleDetectChannels()`가 `POST /api/cameras/probe-channels`에 `httpPort`/`httpType`를 전달하지 않아, 서버측 `querySunapiMaxChannel()`이 항상 기본값 80/HTTP로 질의 — 실제 SUNAPI 웹 포트가 다르거나 HTTPS인 카메라는 이미 UDP SUNAPI Discovery(Found 탭)로 `HttpPort`/`HttpsPort`/`HttpType`을 알고 있음에도 조용히 실패해 "single-channel"로만 보고됨. `discovered.find(d => d.IPAddress === ip)`로 discovery store에서 동일 IP 항목을 찾아 `httpPort`/`httpType`/`Username`/`Password`를 probe-channels 요청에 재사용하도록 수정. `POST /api/cameras/probe-channels` 자체는 변경 없음(사전 discovery 없는 IP에도 여전히 독립 동작) — **알려진 잔여 한계**: `Camera.httpType`이 DB에 저장되지 않아 `CameraEditModal.tsx`의 "Re-detect"는 여전히 항상 HTTP로만 질의(후속 과제). 상세: `docs/design/Design_Channel_Slot.md` §5.3a.

**Found 탭 discovery 패널(`DiscoveredCameraPanel.tsx`)의 Re-detect (2026-07-02 추가, FR-CH-048a):** Found 탭에서 탐색된 장치를 클릭했을 때 나오는 패널은 이미 스캔 시점에 채널 정보를 확보했으므로 Add 모달의 "Detect Channels"(§ 위)를 그대로 추가하면 중복 작업 — **의도적으로 추가하지 않음**. 대신 스캔 결과가 오래됐거나 불완전할 때(스캔 당시 SUNAPI/ONVIF best-effort 조회가 타임아웃된 경우 등)를 위해 채널 수 표시 옆에 "🔍 Re-detect" 버튼만 추가:
- `camera.IPAddress` + 패널이 이미 알고 있는 `HttpPort`/`HttpsPort`/`HttpType`/`Username`/`Password`로 `POST /api/cameras/probe-channels` 호출 (URL 파싱 불필요 — Add 모달과 달리 구조화된 필드를 이미 보유)
- 결과는 `redetected` state로 유지, `resolveRtspUrl()`이 원래 스캔의 `camera.profiles`보다 `redetected.profiles`를 우선 사용
- `+ Add to System` 제출 시 `effectiveSupportSunapi`/재계산된 `channelCount`가 원래 스캔값을 덮어씀
- FR-CH-049a와 동일한 3-way 피드백 규칙 적용 (채널 못 찾아도 "no multi-channel NVR found, scan result unchanged" 메시지 표시, 무반응처럼 보이지 않게)

**DEBUG 레벨 discovery 로깅 (2026-07-02 추가, FR-CH-063):** `querySunapiMaxChannel()`/`enrichDevice()`는 설계상 실패를 조용히 삼킴(어떤 원인이든 `maxChannel: 1`/부분 결과로 수렴 — 그래야 프로토콜 하나가 막혀도 probe 전체가 실패하지 않음) — 그런데 이는 "왜 감지가 안 됐는지"(포트 오류/인증 거부/타임아웃/진짜 단일채널)를 운영자가 소스코드 없이는 구분할 수 없다는 뜻이기도 함. `POST /api/cameras/probe-channels`(Add/Edit/Found 세 진입점 공통)에 `console.debug()` 로그를 추가:
- `utils/logger.js`의 기존 프로덕션 로거가 `console.debug`를 DEBUG 레벨로 직접 매핑(`LOG_LEVEL=DEBUG`일 때만 출력, 기본값 `INFO`에서는 무영향) — `console.log`에 "DEBUG" 문자열을 넣는 방식이 아니라 반드시 `console.debug()` 함수를 사용해야 진짜 레벨 게이팅이 됨
- `[cameras][probe-channels]` (요청 파라미터·SUNAPI/ONVIF 결과 요약·최종 decision), `[Discovery][SUNAPI]` (경로별 HTTP status/timeout/connection-error/파싱 결과), `[ONVIFDiscovery][enrichDevice]` (SOAP 호출 4단계 각각의 성공/실패, 최종 MaxChannel/profiles 요약) 세 태그로 로그
- **자격증명은 절대 로그하지 않음** — `username`/`password` 값이 아니라 `auth=yes|no`만 기록 (RTSP URL 자격증명 로그 금지 규칙을 SUNAPI Basic-Auth로 확장)
- 같은 `enrichDevice()`/`querySunapiMaxChannel()`이 백그라운드 WS-Discovery 스캔에서도 호출되므로, DEBUG 레벨 활성화 시 온디맨드 probe뿐 아니라 정기 스캔에서도 로그가 나옴 — 볼륨 예상하고 켤 것
- 진단 방법: `LOG_LEVEL=DEBUG` 설정 후 재시작 → 버튼 클릭 → `tail -f /var/log/lts/lts-$(date +%Y-%m-%d).log | grep 'probe-channels\|SUNAPI\|ONVIFDiscovery.*enrichDevice'` 또는 Admin Dashboard → Server Logs (레벨 필터 DEBUG)

**cameraId 있는 요청은 비밀번호 없는 카메라의 SUNAPI probe를 생략 (2026-07-02 추가, FR-CH-064):** 위 DEBUG 로깅이 실제로 드러낸 문제 — Edit 모달 "Re-detect"가 비밀번호를 전혀 등록하지 않은 카메라에 대해서도 클릭할 때마다 조용히 실패하는 SUNAPI 쿼리를 계속 시도하고 있었음. 그 카메라의 DB 레코드 자체가 이미 "인증 불가"를 알고 있으므로 매번 재시도하는 건 순수한 낭비:
- `POST /api/cameras/probe-channels`가 옵션 `cameraId` 파라미터를 받음 — 있으면 서버가 `db.findOne('cameras', { id: cameraId })`로 그 카메라의 저장된 `username`/`password`를 조회해 요청 본문에 없을 때 사용 (클라이언트는 password 값을 절대 받을 수 없음 — `GET /api/cameras`·`GET /api/cameras/:id` 모두 응답에서 `password`를 제거함)
- 요청 본문·카메라 레코드·`RTSP_DEFAULT_PASSWORD` env 중 **어디에서도** 비밀번호를 구할 수 없으면 SUNAPI 네트워크 호출 자체를 생략(`querySunapiMaxChannel()` 미호출, `maxChannel` 즉시 1로 처리)
- **이 게이트는 `cameraId`가 있을 때만 적용** — Add 모달의 "Detect Channels"(아직 저장 안 된 카메라, cameraId 없음)와 Found 탭의 "Re-detect"(스캔이 캡처한 자격증명을 그대로 사용, DB 레코드도 없음)는 영향 없음 — 이 두 경로는 "아직 자격증명 없음"이 "영원히 안 될 것"이라는 증거가 아니므로 기존처럼 무인증 시도를 계속함
- `CameraEditModal.tsx`의 `handleRedetectChannels()`가 `cameraId: camera.id`를 요청에 포함하도록 수정 (이전엔 username/password/cameraId 모두 안 보냈음)

**버그 수정 — Edit 모달에서 Save 전 입력한 username/password로 Re-detect를 눌러도 "no username/password on file"이 계속 뜨던 문제 (2026-07-02):** 위 FR-CH-064 게이트가 참조하는 credential은 카메라의 **DB에 저장된** 값뿐이었음 — `handleRedetectChannels()`가 `cameraId`만 보내고 폼에 방금 입력한 `rtspForm.username`/`password`는 요청에 포함하지 않았기 때문에, Save를 누르기 전에 Re-detect를 클릭하면 서버가 조회하는 DB 레코드는 여전히 옛(빈) 값이라 게이트가 계속 SUNAPI probe를 스킵함. `handleRedetectChannels()`가 `rtspForm.username`/`rtspForm.password`도 요청 body에 함께 보내도록 수정 — 서버(`api/cameras.js`)는 이미 `username || camera?.username`처럼 body 값을 DB 레코드보다 우선하므로 서버 변경은 불필요. 안 건드린 필드는 `''`(falsy)라서 그대로 DB 레코드로 폴백. 단, 모달을 저장 없이 닫으면 이 세션의 입력값은 사라지고 다음에 열 때는 다시 DB 레코드 기준으로 게이트가 적용됨(의도된 "stage then save" 동작). 상세: `docs/design/Design_Channel_Slot.md` §4.6e.

**버그 수정 — Edit 모달 "Re-detect"가 Save 전 수정한 RTSP URL/IP는 반영하지 않고 여전히 저장된 주소로 probe하던 문제 (2026-07-02):** 위 두 건은 credential(username/password)만 `rtspForm`에서 가져오도록 고쳤을 뿐, `handleRedetectChannels()`의 `ip`/`baseRtspUrl` 계산은 여전히 `camera.ip`/`camera.rtspUrl`(저장된 값)에서만 유도하고 있었음 — 운영자가 "RTSP URL" 필드에서 잘못된 IP/포트를 고친 뒤 Save 없이 바로 Re-detect를 누르면 방금 고친 주소가 아니라 옛 주소로 계속 probe함. `handleRedetectChannels()`가 `rtspForm.rtspUrl.trim() || camera.rtspUrl`에서 hostname을 파싱해 `ip`를 구하고(파싱 실패 시에만 `camera.ip`로 폴백), 그 값을 그대로 `baseRtspUrl`로도 전송하도록 수정. `camera.httpPort`는 Edit 폼에 별도 편집 필드가 없어 그대로 둠. 상세: `docs/design/Design_Channel_Slot.md` §5.4b.

**백그라운드 스캔의 SUNAPI CGI 조회를 자격증명 설정 시에만 secondary로 실행 (2026-07-02 추가, FR-CH-040a/040b, BR-10):** 위 두 온디맨드 기능(Add "Detect Channels", Found "Re-detect")은 여전히 항상 시도하고, Edit "Re-detect"는 위 FR-CH-064의 카메라별 게이트를 따로 갖는 것과 별개로, 자동 백그라운드 discovery 스캔(`discoveryService.js` `_runScan()`)과 Found 탭의 수동 재스캔(Socket.IO, `streamHandler.js`)은 SUNAPI CGI 채널 조회(`querySunapiMaxChannel()` → `GET /stw-cgi/attributes.cgi/attributes`, 위 FR-CAM-062a 참조)를 더 이상 모든 SUNAPI 장치에 무조건 시도하지 않음:
- UDP discovery 응답(`mapUDPDevice()`)에서 이미 `MaxChannel > 1`을 확인했다면 CGI 조회를 완전히 건너뜀 — UDP 응답이 **primary source**
- CGI 조회는 오직 (a) UDP 응답이 다채널을 보고하지 못했고, AND (b) `hasConfiguredSunapiCredentials()`(`RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD` 둘 다 설정)가 `true`일 때만 **secondary/fallback**으로 실행 — 인증 필요 장비에 자격증명 없이 매 스캔 사이클마다 실패가 예정된 요청을 보내지 않기 위함
- `hasConfiguredSunapiCredentials()`는 `discoveryService.js`에서 export되어 `streamHandler.js`(수동 재스캔)와 동일하게 재사용 — 두 호출부 모두 동일 조건으로 게이팅
- **UDP 응답 직접 파싱 구현됨 (2026-07-03, FR-CAM-091)**: "UDP 응답에서 `MaxChannel`을 직접 파싱"하는 primary-source 구현 추가. §3.4.2 Response 절 서술은 `nVersion 0x08`(SupportPasswordVerification digest) 지원 기기에서 `MaxChannel`/`Nonce`가 각각 `nMulticastPort`/`chPassword` 슬롯을 재해석한 값으로 실린다고 암시하지만, 이 네트워크에서 실측한 모든 기기가 base-mode(`nMode=11`) 응답이라 `nVersion` 필드 자체가 없어 그 조건으로는 검증이 불가능함 — 그래서 `UdpResponse`(response.js)의 `MaxChannel` getter는 더 단순하고 검증 가능한 조건을 씀: `nMode === DEF_RES_SCAN_EXT`(12)일 때만 `nMulticastPort`(항상 디코딩되는 base 필드)를 `MaxChannel`로 재해석. `_parseResponse()`(`udpDiscovery.js`)가 이를 `raw.nMaxChannel`(다른 raw 숫자 필드들처럼 `n` 접두사)로 노출하고, `mapUDPDevice()`가 `MaxChannel: raw.nMaxChannel > 1 ? raw.nMaxChannel : 1`로 소비 — forward-compatible 패턴은 그대로 유지하되 실제로 연결됨. **아직 검증 안 된 부분**: 진짜 `nMode=12` 기기를 한 번도 캡처하지 못해 이 값 자체가 진짜 채널 수인지(vs 우연히 채널 수처럼 보이는 멀티캐스트 포트 번호)는 미확인 — TC-H-040은 파싱 메커니즘(base 필드가 `nMode` 조건으로 정확히 게이팅되는지)만 합성 픽스처로 검증. 자격증명 게이팅된 CGI 폴백(`querySunapiMaxChannel()`)은 계속 secondary/cross-check로 남음
- 이 게이팅(FR-CH-040a/040b)은 온디맨드 Detect/Re-detect(`POST /api/cameras/probe-channels`)에는 적용되지 않음 — 그쪽은 운영자가 그 순간 직접 요청하는 단발성 액션(FR-CH-064의 카메라별 게이트는 별개 메커니즘)

**probe-channels가 SUNAPI CGI 쿼리 전에 UDP Discovery 캐시를 우선 확인 (2026-07-02 추가, FR-CH-065):** 코드 리뷰 지적 — `sunapiMax`(`api/cameras.js`)는 `querySunapiMaxChannel()`이 IP에 직접 보내는 HTTP CGI 쿼리 결과이지 UDP Discovery 결과가 아님. 이 IP가 이미 UDP Discovery 스캔으로 발견돼 `discoveryService.js`의 메모리 캐시에 존재한다면, 그 결과를 재사용하지 않고 매번 새로 CGI 쿼리를 날리고 있었음:
- `DiscoveryService`에 `getByIp(ip)` 신규 메서드 추가 — `_ipIndex`/`_known` Map을 이용한 동기 조회, 네트워크 I/O 없음
- `probe-channels`가 `getDiscoveryService()`(싱글턴, `io` 인자 없이 호출 — 이미 떠 있으면 재사용, 없으면 `null`)로 캐시를 먼저 확인 → `SupportSunapi && MaxChannel > 1`인 캐시 히트가 있으면 그 값을 바로 사용, CGI 쿼리 자체를 생략
- **우선순위**: 이 캐시 확인은 FR-CH-064의 자격증명 게이트보다 먼저 실행됨 — 캐시 히트는 자격증명이 전혀 필요 없음(스캔이 이미 채널 수를 확정했으므로)
- 캐시 미스(스캔 이력 없음/단일채널로 보고됨/discovery 비활성화로 싱글턴 자체가 없음) 시에는 이전과 동일하게 FR-CH-064 게이트 → CGI 쿼리로 폴백 — FR-CH-045의 "사전 스캔 불필요" 보장은 그대로 유지
- ONVIF 쪽(`enrichDevice()`)은 범위 밖 — 매 호출마다 그대로 새로 조회함 (요청받은 범위가 SUNAPI 한정이었음)

**Found 패널에 SUNAPI/ONVIF MaxChannel을 별도 표시 (2026-07-02 추가, FR-CH-066):** "Dashboard 우측 카메라 FOUND 정보에 SUNAPI의 MaxChannel 정보를 표시해달라"는 직접 요청 — 기존 `{N} CH` 배지(`DiscoveredCameraPanel.tsx`, §5.2a)는 `mergeDevices()`가 `Math.max(sunapi, onvif)`로 병합한 값이라, 어느 프로토콜이 실제로 채널을 찾았는지 UI에서 구분할 수 없었음. 병합 값은 그대로 두고, 각 프로토콜의 자체 값을 별도 필드로 추가 추적:
- `discoveryService.js` `mapUDPDevice()`에 `SunapiMaxChannel` 필드 추가 (`SupportSunapi`가 true일 때만 설정), `_runScan()`의 CGI 폴백 성공 시(`streamHandler.js`의 수동 rescan도 동일)에도 갱신
- `onvifDiscovery.js` `enrichDevice()`에 `OnvifMaxChannel = MaxChannel`(별칭) 추가
- `mergeDevices()`가 두 필드를 각각 독립적으로 `Math.max()` — 서로 다른 프로토콜의 값이 섞이지 않음(각 필드는 해당 프로토콜의 코드 경로에서만 설정되므로)
- `POST /api/cameras/probe-channels` 응답에 `sunapiMaxChannel`(항상 숫자, 미탐지 시 1)과 `onvifMaxChannel`(ONVIF가 응답 자체를 안 했으면 `null`, 응답했으면 숫자 — 단일채널 확인과 무응답을 구분) 추가 — 기존 `maxChannel`/`protocol`/`profiles`는 하위호환을 위해 그대로 유지
- 클라이언트: `types/index.ts`에 `DiscoveredCamera.SunapiMaxChannel`/`OnvifMaxChannel`, `ProbeChannelsResult.sunapiMaxChannel`/`onvifMaxChannel` 추가. `DiscoveredCameraPanel.tsx` Device 정보 섹션에 "SUNAPI MaxCh"/"ONVIF MaxCh" 두 행 신규 추가 — 기존 병합 배지(`> 1`일 때만 표시)와 달리 **항상** 표시, 값 없으면 "not detected" 문구로 명시(미탐지 vs 단일채널 확인을 구분). Re-detect 클릭 시 `redetected` state를 통해 두 행 모두 즉시 갱신 (기존 `effectiveMaxChannel` 패턴과 동일)
- 사이드바 목록(패널 열기 전 압축 리스트)은 병합된 `N CH` 배지만 표시 — 프로토콜별 분리 표시는 상세 패널 전용. 단, 이 배지 자체가 Re-detect 결과로 갱신될 수 있는지는 아래 FR-CH-068 참조 (기존엔 안 됐음)

**probe-channels 결과가 discovery 레지스트리보다 높으면 레지스트리를 정정 (2026-07-02 추가, FR-CH-068):** 위 FR-CH-066으로 패널에 SUNAPI/ONVIF MaxChannel을 각각 보여주게 됐지만, Re-detect가 실제로 더 나은 값을 찾아도(예: UDP 스캔은 `MaxChannel:1`로 보고했지만 그 카메라의 실제 자격증명으로 Re-detect하면 `attributes.cgi`가 `2`를 응답 — 실 카메라 192.168.214.32로 확인된 케이스) 그 정정은 패널의 로컬 `redetected` state에만 남고, `discoveryService.js`의 공유 레지스트리(`_known`)나 클라이언트 `useDiscoveryStore`에는 전혀 반영되지 않았음 — 패널을 닫으면 사이드바 배지는 다시 예전 값으로 돌아감:
- `DiscoveryService`에 `applyProbeResult(ip, patch)` 신규 메서드 추가 — IP로 기존 레지스트리 항목을 찾아 `maxChannel`/`sunapiMaxChannel`/`onvifMaxChannel`이 기존 값보다 **높을 때만** 갱신(내려가는 갱신은 무시 — `mergeDevices()`와 동일한 "더 큰 값이 이긴다" 철학), 실제로 뭔가 바뀐 경우에만 `_emit()`으로 `discovery:result` 재브로드캐스트. 레지스트리에 아예 없는 IP(한 번도 스캔 안 된 IP)는 no-op — 새 항목을 만들지 않고 기존 항목만 정정
- `POST /api/cameras/probe-channels`가 응답을 만들기 직전에 이미 계산해둔 `sunapiMax`/`onvifResult`/`maxChannel`로 `applyProbeResult()`를 호출 — Add "Detect Channels", Edit "Re-detect", Found "Re-detect" 세 진입점 모두 이 한 엔드포인트를 공유하므로 자동으로 동일하게 적용됨
- **클라이언트 코드 변경 불필요**: `App.tsx`가 `useDiscoveryStore`의 `selected`를 `DiscoveredCameraPanel`의 `camera` prop으로 넘기고, `CameraList.tsx`의 기존 `discovery:result` 소켓 핸들러가 이미 `addOrUpdate(data.device)`를 호출(리스트 갱신 + id 일치 시 `selected`도 갱신) — 서버가 `_emit()`만 해주면 사이드바 배지와(패널이 열려있다면) 패널의 SUNAPI/ONVIF MaxCh 행이 기존 파이프를 그대로 타고 자동 갱신됨

**probe-channels가 이번 요청의 라이브 SUNAPI+ONVIF 쿼리 모두 실패했을 때 discovery 레지스트리의 MaxChannel로 폴백 (2026-07-02 추가, FR-CH-069):** "attributes.cgi 또는 ONVIF의 VideoSource를 검색하지 못하면 MaxChannel이 다시 1로 설정된다"는 리포트로 발견 — §4.6d의 `cachedMaxChannel`은 `SupportSunapi`가 true일 때만, 그리고 라이브 쿼리를 **실행하기 전** 건너뛰는 용도였고, 위 FR-CH-068의 `applyProbeResult()`는 성공한 probe 결과를 레지스트리에 **써넣는** 반대 방향이라, "이번 요청의 라이브 재조회가 실패했지만 레지스트리엔 이미 더 나은 값이 있다"는 경우를 아무도 처리하지 않고 있었음 — 일시적 인증 실패·잘못된 포트·(FR-CAM-074의 듀얼 스킴 ONVIF 시도가 우연히 응답 없는 스킴을 골랐을 때) 등으로 매번 `maxChannel:1`/`protocol:'none'`로 되돌아갈 수 있었음:
- §4.6의 `if (onvifMax>1...) else if (sunapiMax>1...)` 결정 블록 전체를 순수 함수 `resolveProbeChannelsDecision({ onvifMax, onvifProfiles, sunapiMax, sunapiProfiles, knownDevice, baseRtspUrl })`(`api/cameras.js`, `module.exports.resolveProbeChannelsDecision`로 노출)로 추출하고, 세 번째 분기 추가: `(knownDevice?.MaxChannel || 1) > 1`이면 레지스트리 값을 사용 — `knownDevice.SupportSunapi`면 `channelRtspUrl()`로 프로필 합성(§4.6과 동일), 아니면 레지스트리에 캐시된 ONVIF `profiles`(rtspUrl 있는 것만) 재사용, 둘 다 없으면 채널 수만 보고
- **§4.6d/§4.6h와 충돌하지 않음**: §4.6d의 캐시 재사용은 이 분기보다 먼저 실행되어 라이브 SUNAPI 쿼리 자체를 생략시키므로 이 시점엔 이미 `sunapiMax`가 그 캐시값(사실상 no-op); §4.6h의 레지스트리 기록은 이 함수가 반환한 값을 그대로 다시 쓰는 것뿐이라(raise-only 규칙상) 마찬가지로 no-op
- 순수 함수로 추출된 덕분에 서버 없이 `test/api/channel_slot.test.js` TC-CH-F-013~013d로 전체 4개 분기(레지스트리 SUNAPI 폴백/ONVIF 폴백/폴백 없음/라이브 결과가 항상 우선) 자동화

**문서:** `docs/design/Design_Channel_Slot.md` §4.6a~§4.6i·§5.2a·§5.2b·§5.3a·§5.4a, `docs/srs/SRS_Channel_Slot.md` (FR-CH-001~069, FR-CH-040a, FR-CH-040b, FR-CH-048a, FR-CH-049a), `docs/ops/Channel_Slot_Guide.md` §5.1a~§5.1d·§5.2·§5.3
**테스트:** `test/api/channel_slot.test.js` (TC-CH-A-001~007, TC-CH-F-001~003·006~009·011~012, TC-CH-G-001~003, TC-CH-D-010~012·F-004~005·F-010(getByIp 자체는 G-002로 자동화, 전체 HTTP 통합만 수동)은 수동, TcRunner 등록: `captureOnly: true`)

### SUNAPI RTSP URL 패턴 — 두 컨벤션 동시 지원 (2026-07-02 추가)

이 네트워크 실제 카메라 DB 조사 결과, `channelRtspUrl()`(`server/src/utils/channelRtsp.js` + client twin `client/src/utils/channelRtsp.ts`)이 인식하던 `/profileN/`(1-based, WiseNet Profile S 인코더 — TID-A800 계열) 컨벤션 하나만으로는 부족했음 — 조사한 6대 카메라 중 5대(192.168.214.34/35/37/39/40)가 `/N/H.264/`(0-based 채널 세그먼트) 컨벤션을 쓰고 있어서, 이 카메라들에서는 채널 전환 시 `channelRtspUrl()`이 조용히 no-op(URL 불변)이었음:

- `channelRtspUrl(baseUrl, channel)`이 두 컨벤션을 모두 인식 — `baseUrl`이 이미 쓰고 있는 형태 안에서만 채널 세그먼트를 치환(`channel` 파라미터는 두 경우 모두 1-based 유지, `/N/H.264/`에서만 URL에 쓸 때 `channel - 1`로 변환)
- 신규 `defaultSunapiRtspUrl(ip, rtspPort, channel)` — 참고할 `baseUrl`이 전혀 없을 때(신규 IP를 처음 probe하는 Add 플로우 등) `/N/H.264/` 컨벤션으로 기본 URL을 합성. RTSP 포트는 아래 확인된 값 또는 SUNAPI 기본값 554
- 신규 `querySunapiRtspPort()`(`discoveryService.js`) — 자격증명이 있을 때 `GET /stw-cgi/network.cgi?msubmenu=portconf&action=view`로 실제 설정된 RTSP 포트를 확인. **응답이 XML이 아니라 평문 `key=value` 줄바꿈 형식**(`RTSPPort=554` 등)임에 주의 — `attributes.cgi`와 다른 파싱 필요. 실 카메라(192.168.214.32, 192.168.214.37) `curl --digest`로 사전 검증 완료(FR-CAM-062a의 "존재하지 않는 엔드포인트 가정" 재발 방지) — 흥미로운 부수 발견: 192.168.214.32는 DB에 저장된 `rtspUrl` 포트가 `10030`인데 실제 CGI 확인값은 `554`로 서로 다름(기존 저장값이 stale)
- `sunapiRequest()`(discoveryService.js의 SUNAPI CGI 공용 GET 헬퍼)도 `soapPost()`(ONVIF)와 동일하게 동일 호스트 301/302/307/308 리다이렉트를 1회까지 추적하도록 수정 — 192.168.214.37이 SUNAPI 웹포트도 HTTP→HTTPS 강제 리다이렉트를 걸어서, 리다이렉트 미추적 시 `querySunapiMaxChannel()`이 무조건 `HTTP 301`로 실패(진짜 MaxChannel=4인데 항상 1로 보고)하던 문제. 다른 호스트로의 리다이렉트는 SSRF 방지를 위해 따라가지 않음(ONVIF쪽과 동일 규칙)
- `POST /api/cameras/probe-channels` 응답에 `sunapiProfiles`/`onvifProfiles`(각 프로토콜이 독자적으로 계산한 채널별 URL — 기존 `sunapiMaxChannel`/`onvifMaxChannel` "승자와 무관하게 둘 다 보고" 관례와 동일 패턴), `sunapiRtspPort`(확인된 포트 또는 `null`) 필드 추가. `baseRtspUrl`이 없어도 `sunapiMax > 1`이면 `defaultSunapiRtspUrl()`로 `sunapiProfiles`를 채움(이전엔 이 경우 빈 배열로 남던 결함)
- `DiscoveredCameraPanel.tsx`/`CameraEditModal.tsx`에 "SUNAPI URL"/"ONVIF URL" 행 신규 추가 — 기존 SUNAPI/ONVIF MaxCh 행과 동일한 패턴으로, 현재 선택된 채널에 대해 각 프로토콜이 실제로 무엇을 확인했는지 나란히 표시(없으면 "not detected")

**문서:** `docs/design/Design_Camera_Discovery.md` §3.1a·§5.3·§8, `docs/srs/SRS_Camera_Discovery.md` FR-CAM-077~080, `docs/mrd/MRD_Camera_Discovery.md`, `docs/ops/Camera_Discovery_Guide.md` (신규), `docs/rfp/RFP_Camera_Discovery.md` §10.4, `docs/prd/PRD_Camera_Discovery.md` §9.6
**테스트:** `test/api/nvr_channel_discovery.test.js` TC-H-021a~c·TC-H-022~025 (실제 모듈 direct-require + mock 서버로 자동화 — TC-H-001~007의 인라인 재구현 방식과 달리 진짜 코드를 검증)

### UDP Discovery 확장 필드 bounds-check 버그 + Device Type 표시 (2026-07-02 추가, FR-CAM-081)

사용자가 벤더 SUNAPI IP Installer 스펙(§3.4.2 Response, 내부망 `http://55.101.56.209:8080/.../SUNAPI_ipinstaller.html`)을 직접 제공해 실측 검증한 결과:

- `MaxChannel`/`Nonce`는 실제 UDP 응답 필드가 맞지만 **`nVersion 0x08`을 지원하는 기기에서만 조건부로 삽입**됨. 이 네트워크의 실 카메라 2대(같은 IP 192.168.214.37을 공유하던 서로 다른 물리 장비 — 아래 참고)를 raw 소켓으로 직접 캡처해 byte-diff한 결과, 둘 다 정확히 262바이트 고정 응답으로 해당 조건부 필드가 들어갈 자리가 아예 없음을 확인 — offset을 못 찾은 게 아니라 이 펌웨어 세대엔 필드 자체가 없는 것. (2026-07-03, FR-CAM-091) `MaxChannel`만 이후 `nMode` 기반 조건으로 파싱하도록 구현됨 — 아래 별도 항목 참고. `Nonce`는 여전히 미구현(대응하는 base 필드 `chPassword`를 재해석할 마땅한 트리거 조건이 없어 보류)
- 그 조사 과정에서 발견한 진짜 버그: `_parseResponse()`(`submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js`)의 확장 필드 블록이 `if (b.length >= 261)` 하나로만 게이팅되어 있었는데, 262바이트 패킷은 이 조건을 통과하면서도 남은 바이트가 1개뿐(72바이트 필요) — `rb(n)`/`bytes2int(rb(1))`/`r16()`은 범위 초과 시 `undefined`가 아니라 `0`/`''`을 조용히 반환(오직 `r8()`의 `b[i]` 직접 인덱싱만 자연스럽게 `undefined`)해서, `modelType`이 거짓 `0`("Camera")으로 나와 진짜 Device Type 0과 구분 불가능했음. 각 필드를 순번대로 남은 바이트 수로 게이팅하고, 한 필드라도 부족하면 그 이후 필드는 전부 `undefined`로 남기도록 수정(뒤쪽 필드가 우연히 남은 바이트 수를 만족해도, 앞쪽 필드가 잘렸다면 그 offset 자체가 무효이므로)
- `mapUDPDevice()`에 `DeviceType`(사람이 읽을 수 있는 라벨, `DEVICE_TYPE_LABELS` — 0x00 Camera, 0x01 Encoder, 0x02 Decoder, 0x03 Recorder, 0x04 IOBox, 0x05 NetworkSpeaker, 0x06 NetworkMic, 0x07 LEDBox, 0x08 EmergencyBell, 0x09 AccessController) 신규 노출, `DiscoveredCameraPanel.tsx` Device info 섹션에 "Type" 행 추가. `mergeDevices()`도 `Type`/`DeviceType`을 채워넣되(UDP 전용 필드, ONVIF는 안 건드림), `Type`은 기존 문자열용 `hasMeaningful()`(내부적으로 `String(v||'')`라 숫자 `0`을 falsy로 오판) 대신 `!= null` 체크로 별도 처리
- **부수 발견(중요, 네트워크 이슈)**: 192.168.214.37 하나의 IP에서 서로 다른 MAC·모델명(PNM-C32083, TNO-C3020T)을 가진 물리 카메라 2대가 UDP Discovery에 응답 — **IP 충돌**. 이게 "어제는 MaxChannel=4, 오늘은 1" 같은 재현 불가능한 결과의 실제 원인이었음(HTTP 쿼리가 그 순간 ARP 캐시가 가리키는 아무 장비에나 도달). 코드로 우회 불가 — 실제로 어느 IP가 어느 물리 카메라를 가리키는지 혼란스러우면 `arp -n <ip>`로 확인하고 한쪽 카메라의 IP를 재할당해야 함

**문서:** `docs/design/Design_Camera_Discovery.md` §3.1b·§8, `docs/srs/SRS_Camera_Discovery.md` FR-CAM-081, `docs/ops/Camera_Discovery_Guide.md` §5 (중복 IP·Type 미표시 트러블슈팅)
**테스트:** `test/api/nvr_channel_discovery.test.js` TC-H-026~027 (실제 캡처한 262바이트 패킷 + 합성 333바이트 패킷으로 검증)

### UDP Discovery MaxChannel — nMode 기반 primary-source 파싱 (2026-07-03 추가, FR-CAM-091)

위 §"UDP Discovery 확장 필드..."에서 미구현으로 남겨뒀던 `MaxChannel` 파싱을 구현 — 벤더 스펙이 요구하는 `nVersion 0x08` 조건은 이 네트워크에 검증 가능한 기기가 없어(모든 실측 기기가 `nVersion` 필드 자체가 없는 base-mode 응답) 대신 `nMode === DEF_RES_SCAN_EXT`(12, `protocol.js`의 `NMODE`)라는 더 단순하고 그 자체로 검증 가능한 조건을 사용:

- `UdpResponse`(response.js)에 `MaxChannel` getter 신규 추가 — `this.nMode === NMODE.DEF_RES_SCAN_EXT ? this.nMulticastPort : undefined`. `nMulticastPort`는 base 필드(nMode와 무관하게 항상 디코딩됨)라 extended tail 바이트 없이도 동작
- `_parseResponse()`(`udpDiscovery.js`)가 이를 `nMaxChannel: r.MaxChannel`로 legacy adapter 출력에 노출 — 다른 raw 숫자 필드(`nPort`/`nHttpPort`/`nMulticastPort` 등)와 동일하게 `n` 접두사 명명 규칙을 맞춤(어댑터 자체 필드명 스타일에 맞춘 것이지, `UdpResponse` 클래스 getter 이름은 그대로 `MaxChannel`)
- `mapUDPDevice()`(`discoveryService.js`)가 기존 forward-compatible 패턴(`MaxChannel: raw.MaxChannel > 1 ? raw.MaxChannel : 1`)의 우변 참조만 `raw.nMaxChannel`로 갱신 — 별도 로직 변경 없음
- **검증 상태**: 파싱 메커니즘(어느 nMode에서 값이 설정/미설정되는지)은 합성 픽스처(실제 262바이트 캡처에 `nMode` 바이트만 12로 덮어씀)로 자동화됨. 진짜 `nMode=12` 응답을 보내는 실기기는 여전히 캡처된 적 없어, 그 경우의 `nMulticastPort` 값이 실제로 타당한 채널 수인지는 미확인 — 자격증명 게이팅된 CGI 폴백(`querySunapiMaxChannel()`)이 계속 secondary/cross-check 역할

**문서:** `docs/design/Design_Camera_Discovery.md` §3.1h, `docs/srs/SRS_Camera_Discovery.md` FR-CAM-091
**테스트:** `test/api/nvr_channel_discovery.test.js` TC-H-040

### UDP Discovery 인라인 폴백 — 역사적 기록 (2026-07-03: `UDPDiscoveryFallback` 자체가 완전히 제거됨, 위 "구현 아키텍처" 참고)

> **이 절은 역사적 기록입니다.** 여기서 설명하는 `UDPDiscoveryFallback` 클래스는 2026-07-03에 완전히 삭제되었고, `server/src/utils/udpDiscovery.js`는 이제 서브모듈/npm 패키지를 재노출하는 얇은 파일입니다(§"WiseNet/Hanwha UDP Discovery 프로토콜"의 "구현 아키텍처" 참고). ONVIF XML 스텁 버그와 엔디언 버그의 발견 경위는 향후 유사 이슈 디버깅에 참고 가치가 있어 남겨둡니다.

사용자가 벤더 SUNAPI IP Installer 스펙 §3.4 "IP Scan for SUNAPI"(내부망 `http://55.101.56.209:8080/.../SUNAPI_ipinstaller.html#_ip_scan_for_sunapi`)를 문서화·`_parseResponse()` 준수를 요청한 계기로 발견한 결함 (2026-07-02, FR-CAM-082):

- `server/src/utils/udpDiscovery.js`의 `UDPDiscoveryFallback`(서브모듈 `submodules/WiseNetChromeIPInstaller` 미초기화 시 사용되는 자체 폴백)은 WiseNet 전용 포트(7701/7711)에서 리슨하면서도 `_parseResponse()`가 응답을 `toString('utf8')`한 뒤 ONVIF 스타일 XML 태그(`MACAddress`, `Model`, `XAddrs`)를 정규식으로 추출하고 있었음 — **완전히 다른 프로토콜**. 서브모듈이 없는 배포에서는 SUNAPI/WiseNet 카메라를 UDP로 하나도 못 찾는데, 에러도 없이 그냥 "결과 0개"라서 "LAN에 카메라가 없나보다"와 구분 불가능했음
- 수정: `UDPDiscoveryFallback`이 서브모듈과 완전히 동일한 바이너리 파서를 구현(FR-CAM-081의 bounds-check 수정 포함), 캡처된 동일 요청 패킷을 자체 상수로 중복 보유(서브모듈 의존 없음). 실제 캡처한 262바이트 응답으로 두 구현체가 byte-for-byte 동일한 결과를 내는지 parity 테스트로 검증(`test/api/nvr_channel_discovery.test.js` TC-H-028/029), 서브모듈 없이 폴백만으로 실제 이 네트워크의 214.x 서브넷 카메라 13대를 전부 정상 탐색하는 것도 라이브로 확인
- **구현 중 발견한 별도 버그**: `ntohs()`의 `big` 파라미터는 이름과 반대 의미 — 서브모듈 코드 주석에 이미 "big=true: camera uses little-endian for port fields"라고 명시돼 있었는데, 처음 재구현 시 이를 거꾸로 구현해서 `nTcpPort`가 그럴듯하지만 틀린 값(11815 대신 10030이어야 함)으로 나왔음. 구조/타입 체크만으로는 안 잡히고, 실제 캡처한 바이트로 두 구현을 직접 비교하는 parity 테스트에서만 잡힘 — **엔디언 버그는 "형태는 맞는데 값이 틀린" 결과를 내므로 반드시 실제 바이트 fixture로 검증해야 함**
- **정보성 조사(당시 채택 안 함 — 2026-07-03에 뒤집힘)**: 스펙상 요청 옵코드는 `nMode=6`(`DEF_REQ_SCAN_EX`)인데 기존 캡처된 요청 패킷은 `nMode=1`을 사용 중. 실측 비교 결과 이 네트워크의 실제 카메라 펌웨어는 둘에 동일하게 응답(옵코드 구분 안 함)하는 반면, `nMode=6`으로 보내면 이 프로젝트의 카메라 서브넷과 무관해 보이는 훨씬 광범위한 네트워크 대역에서까지 응답이 옴 — 네트워크 범위 측면에서 주의가 필요해 당시엔 `nMode=1`을 유지했음. **2026-07-03에 이 결정을 뒤집고 `nMode=6`을 기본값으로 전환**(위 "구현 아키텍처" 참고) — `nMode=1` 패킷은 삭제하지 않고 주석 처리해 즉시 롤백 가능하게 남겨둠

**문서:** `docs/design/Design_Camera_Discovery.md` §3.1c, `docs/srs/SRS_Camera_Discovery.md` FR-CAM-082, `docs/rfp/RFP_Camera_Discovery.md` §10.5, `docs/prd/PRD_Camera_Discovery.md` §9.7, `docs/mrd/MRD_Camera_Discovery.md` §6, `docs/ops/Camera_Discovery_Guide.md` §1a (신규)
**테스트:** `test/api/nvr_channel_discovery.test.js` TC-H-028~029 (실제 캡처 바이트로 서브모듈과 parity 검증)

### YouTube 스트림 수집
1. 대상 YouTube URL 준비 (라이브 또는 녹화, HLS 전용 스트림 포함)
2. `server/src/services/youtubeStreamService.js`에서 yt-dlp 경로 확인
3. API 호출: `POST /api/youtube-streams` `{ "youtubeUrl": "https://youtube.com/...", "name": "...", "resolution": "720p", "webrtcEnabled": false }`
4. MediaMTX 내부 경로로 RTSP 변환 후 파이프라인 연결 확인
5. 참고: [Design_YouTube_RTSP_Ingest.md](../../../docs/design/Design_YouTube_RTSP_Ingest.md)

**YouTube WebRTC 토글 (`webrtcEnabled`):**
- Add Camera 모달(YouTube 탭)과 Edit Camera 모달 모두 WebRTC 토글 제공 (RTSP 채널과 동일한 UI)
- `true` → WebRTC(WHEP) 수신, `false` → JPEG/Socket.IO (기본값: `false`)
- `webrtcEnabled` 변경 시 스트림 자동 재시작
- 관련 파일: `client/src/components/CameraList.tsx`, `client/src/components/CameraEditModal.tsx`, `server/src/api/youtubeStreams.js`

**FFmpeg 파이프라인 (youtubeStreamService.js `_buildFFmpegArgsPipe`):**
- `-c:v copy`: H.264 소스 복사 (libx264 재인코딩 제거 → CPU 대폭 절감)
- `-c:a aac -b:a 128k`: AAC 재인코딩 (HLS ADTS → MPEG-4 global header 변환 필수)
- `-re` 플래그 제거: yt-dlp가 출력 속도를 제어, pipe 병목 방지
- `--merge-output-format mkv`: DASH 스트림 병합 시 mkv 사용 (mp4는 pipe 스트리밍 불가)

**yt-dlp 포맷 셀렉터 우선순위:**
1. DASH (별도 video+audio): `bestvideo[ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]` 등
2. HLS 통합 스트림: `best[vcodec^=avc][height<=HEIGHT]` — 라이브 스트림·일부 VOD 전용

**`STREAM_FAILED` 원인 진단:**
- DASH 포맷이 없는 HLS 전용 스트림 → 현재 구현은 자동 폴백 지원
- HLS AAC `AAC with no global headers` 오류 → `-c:a aac`로 자동 변환
- `STREAM_TIMEOUT` → yt-dlp 또는 MediaMTX 문제, 로그 확인: `grep YouTubeStream /tmp/lts-server-dev.log`

### 카메라 Pause/Resume — 수집 연결 일시정지/재개 (2026-07-21 추가)

카메라 레코드(자격증명·`channelSlot`·구역 등)는 그대로 둔 채, 수집 연결(RTSP/YouTube)만 끊고 나중에 재개하는 기능. Streaming Dashboard 사이드바 "Added" 탭의 각 카메라 행에 Pause/Resume 버튼으로 노출됨.

- `POST /api/cameras/:id/stream/pause` / `POST /api/cameras/:id/stream/resume`
- **RTSP 카메라**: `pipelineManager.pauseCamera(cameraId)` → 기존 `stopCamera()`(ingest-daemon `DELETE /cameras/:id`, MediaMTX/mediasoup 정리)를 그대로 호출한 뒤 최종 DB `status`만 `'offline'` 대신 `'paused'`로 덮어씀. Resume은 기존 `startCamera(camera)` 재사용.
- **YouTube 가상 카메라**: `youtubeStreamService.pauseStream(id)`/`resumeStream(id)` — 기존 `restartStream()`이 쓰는 `_stopEntry(entry, false)`(yt-dlp/ffmpeg 프로세스 트리 종료 + `pipelineManager.stopCamera()`, DB 레코드는 유지)를 재사용하되 즉시 재시작하지 않고 `'paused'`로 멈춰둠.
- **daemon 레벨에 "freeze" 프리미티브는 없음**: `ingest_daemon.py`의 `CameraManager`는 `add()`/`remove()`만 제공하고 세션을 유지한 채 콜백만 멈추는 중간 상태가 없다 — 따라서 Pause는 완전한 연결 해제이며 세션 자원(스레드/소켓)을 즉시 반환한다(가벼운 "음소거"가 아님).
- **서버 재시작 후에도 유지됨**: `status === 'paused'`인 카메라는 `index.js`의 부트 자동시작 스윕과 `youtubeStreamService.init()`의 YouTube 자동시작 양쪽에서 제외된다 — 명시적으로 `/stream/resume`을 호출해야 재개된다.
- 알려진 한계: `PUT /api/cameras/:id`로 `rtspUrl`/자격증명/`webrtcEnabled`/`webrtcVideoOnly`를 변경하면 기존 동작대로 파이프라인이 자동 재시작되어 일시정지 상태가 풀린다 — 편집 UI가 일시정지 상태를 인지하지 않음.
- 설계 상세: [Design_RTSP_Capture_Backend.md](../../../docs/design/Design_RTSP_Capture_Backend.md) §6.28, [Design_Channel_Slot.md](../../../docs/design/Design_Channel_Slot.md) §5.3b (프론트엔드)

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
| `GET /cameras` | `{"count":N}` — 개수만, 목록·상세 없음 |
| `GET /cameras/:id/video-params` | SDP 협상용 codec/sprop-parameter-sets/profile-level-id (H.264/H.265) — 실시간 통계 아님 |
| `GET /cameras/stats` | 전체 카메라 실시간 통계 배열 — 연결상태·peer IP/port·video/audio bps·fps·AI push fps·해상도·codec·fan-out 포트 등(2026-07-21 신규, Admin Dashboard Ingest Daemon 패널이 1.5초 주기로 폴링) |
| `POST /cameras` | `{"id","rtspUrl","callbackUrl"}` 카메라 등록 |
| `POST /cameras/:id/video-fanout` | `{"port"}` 비디오 RTP fan-out 대상 포트 추가 |
| `DELETE /cameras/:id` | 카메라 등록 해제 |

```bash
# 데몬 상태 확인
curl http://127.0.0.1:7070/health

# 카메라 등록 수동 테스트
curl -X POST http://127.0.0.1:7070/cameras \
  -H 'Content-Type: application/json' \
  -d '{"id":"test","rtspUrl":"rtsp://...","callbackUrl":"https://127.0.0.1:3443/api/internal/frame/test"}'

# 실시간 통계 확인
curl http://127.0.0.1:7070/cameras/stats

# MediaMTX 등록 경로 확인
curl http://127.0.0.1:9997/v3/paths/list
```

**Admin Dashboard 실시간 모니터링**: `GET /cameras/stats`(위)를 Node의 `ingestStatsAggregator.js`가 1.5초 주기로 폴링해 DB 카메라 메타·`pipelineManager` AI/분석 누적치·mediasoup 수신량과 병합, `admin:ingest-stats` Socket.IO 이벤트로 admin 검증된 세션에만 push한다(2026-07-21 구현 완료) — 설계·구현 상세는 [Design_Ingest_Daemon_Monitoring.md](../../../docs/design/Design_Ingest_Daemon_Monitoring.md) 참고. Streaming Dashboard의 Ingest-Daemon 상태 배지를 admin 계정으로 클릭하면 이 패널로 이동한다.

### B-프레임 H264 카메라 처리

H.264 B-프레임 카메라에서 빈 프레임 발생 시: ingest-daemon은 모든 패킷을 디코딩 후 N번째 프레임만 전송합니다 (`AI_FRAME_INTERVAL`). 구 서브프로세스 백엔드에서 패킷 자체를 스킵하던 방식과 다릅니다.

### AI 프레임 해상도 (`AI_MAX_WIDTH`) — crop 화질과 직결

`ingest_daemon.py`가 `/api/internal/frame/:cameraId`로 보내는 JPEG(≈10 FPS)는 **항상 원본(native) 해상도**입니다(리사이즈 없음). combined/analysis 모드는 이 원본 버퍼에서 직접 crop하므로 자동으로 고화질입니다. `AI_MAX_WIDTH`는 **streaming 모드 전용** — `pipelineManager.js`가 remote analysis 서버로 전송하기 직전 `sharp`로 이 값까지 다운스케일한 **별도 사본**을 만들고(`_downscaleForAnalysis()`), `detectionSnapshots` crop은 로컬에 남겨둔 원본 버퍼에서 이루어집니다. analysis 서버가 반환하는 bbox는 다운스케일 좌표계이므로 crop 직전 `_scaleBbox()`가 원본 좌표계로 보정합니다.

- `AI_MAX_WIDTH`를 낮춰도 **crop 화질은 영향 없음** — streaming↔analysis 서버 간 네트워크/CPU 부하만 조절
- crop 화질은 `SNAPSHOT_MAX_DIMENSION`/`SNAPSHOT_JPEG_QUALITY`로 별도 조정
- `AI_MAX_WIDTH`는 이제 `pipelineManager.js`(Node.js)가 읽으므로 변경 후 서버 재시작 필요 — `npm run ingest:restart`(ingest-daemon만 재시작)로는 반영 안 됨

상세: [Design_RTSP_Capture_Backend.md §9.1](../../../docs/design/Design_RTSP_Capture_Backend.md), [RTSP_Capture_Backend_Setup.md](../../../docs/ops/RTSP_Capture_Backend_Setup.md), [Design_Detection_Snapshot_Search.md §15](../../../docs/design/Design_Detection_Snapshot_Search.md)

### `camera:capabilities` 소켓 이벤트

`streamHandler.js`에서 클라이언트가 `camera:subscribe`를 보낼 때:
- `CAPTURE_BACKEND=ingest-daemon` + `WEBRTC_ENGINE=mediasoup`: `{webrtcEnabled: false}` 전송 (RTP 소스 없음)
- `CAPTURE_BACKEND=ingest-daemon` + `WEBRTC_ENGINE=mediamtx`: 이벤트 미전송 (DB 값 사용)
- 다른 조합: 이벤트 미전송

> **주의:** 이 이벤트는 클라이언트의 Zustand 스토어를 즉시 덮어씁니다. WEBRTC_ENGINE 체크 없이 보내면 WebRTC가 동작 중에도 JPEG 모드로 강제됩니다.

### 열상 카메라 Sensor Coordinate Calibration (2026-07-10 추가)

열상(Thermal/Radiometry) IP 카메라의 ONVIF `BoxTemperatureReading` 좌표(`maxTempX/Y`, `minTempX/Y`)는 **열상 센서 자체의 원본 해상도**(예: 160×120) 기준이며, 카메라가 실제로 스트리밍하는 영상 해상도(`frameWidth`/`frameHeight`, 예: 640×480)와는 무관합니다. 두 해상도가 다른 카메라에서 Sensor Coordinate 미설정 시 `ThermalOverlay`의 crosshair가 영상 좌상단 작은 corner 안에만 몰려 표시됩니다.

- **Camera 스키마:** `Camera.thermalSensorWidth`/`thermalSensorHeight`(정수, nullable) — `client/src/types/index.ts`. 미설정(`null`)이면 calibration 없음(하위 호환).
- **설정 UI:** `CameraEditModal.tsx` RTSP/IP 카메라 폼(WebRTC 토글 아래) — Sensor Coordinate Width/Height 입력란. YouTube 폼에는 노출 안 함.
- **API:** `POST /api/cameras`, `PUT /api/cameras/:id` 둘 다 whitelist 방식 필드 추출이므로 신규 필드는 **두 핸들러 모두**(`server/src/api/cameras.js`)에 추가해야 반영됨.
- **클라이언트 렌더링:** `ThermalOverlay.tsx`의 `toScreen()`이 원시 좌표 정규화 분모로 `sensorWidth`/`sensorHeight`를 사용하고(미설정 시 `frameWidth`/`frameHeight` 폴백), letterbox 종횡비 계산(`getRenderArea()`)은 항상 `frameWidth`/`frameHeight` 기준을 유지 — **두 해상도를 같은 변수로 혼용하지 않는 것이 설계 핵심.**
- **재시작 불필요:** calibration은 순수 클라이언트 렌더링 계산이므로 저장 후 파이프라인 재시작 없이 다음 `onvif:temperature` 이벤트부터 즉시 반영됨.

상세: [Design_Thermal_Radiometry_Overlay.md §8](../../../docs/design/Design_Thermal_Radiometry_Overlay.md), [Thermal_Sensor_Calibration_Guide.md](../../../docs/ops/Thermal_Sensor_Calibration_Guide.md)

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

### 알려진 버그 및 회귀 이슈

#### PyAV `read_timeout` 속성 쓰기 오류 (2026-06-23 수정)

**증상 로그:**
```
[ERROR] [Ingest] App RTP error: attribute 'read_timeout' of 'av.container.core.Container' objects is not writable — retry in 5.0s
[ERROR] [Ingest] App RTP error: [Errno 808465656] Server returned 400 Bad Request: 'rtsp://127.0.0.1:8554/{cameraId}' — retry in 5.0s
[INFO]  [MediaMTX] closed: maximum reader count reached
```

**원인:** 신 PyAV 버전에서 `av.open()` 이후 `inp.read_timeout = N` 속성 쓰기 불가 → App RTP 루프가 5초마다 즉시 실패하면서 MediaMTX RTSP 좀비 세션 누적 → `maxReaders: 10` 초과

**수정:** `ingest_daemon.py::_app_rtp_ingest_once()` — `av.open()` 호출 시 `options={"timeout": str(µs)}` 방식으로 전달 (`AVFormatContext.io_timeout`에 매핑, RTSP keepalive와 무관)

**회귀 테스트:** `test/ingest/test_apprtp.py::TestAppRtpOptions` — PyAV 버전 업그레이드 시 반드시 실행

**관련 문서:** `docs/design/Design_ONVIF_Metadata_Pipeline.md §5.4`, `docs/srs/SRS_ONVIF_Metadata_Pipeline.md FR-ONVIF-APPRTP-002`

---

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
| **mediasoup Edge 검은 화면** (`inbound-rtp` 없음) | Router `preferredPayloadType`이 Edge H264 PT(109)와 불일치 | `_boot()`에서 `preferredPayloadType: 109` 확인. 진단: `GET /api/client-logs/webrtc`에서 `candidate-pair.bytesReceived > 0`이지만 `inbound-rtp` 항목 없음. 참조: SRS FR-WRTC-070, TC-A-008, Design §4.6 |
| **mediasoup 모든 브라우저 검은 화면** (ICE loopback) | `_getListenIps()`가 서버 공인 IP를 포함해 loopback ICE path 형성 | `SERVER_IP` / `SERVER_PUBLIC_IP` 환경변수를 LAN IP로 한정. 서버 시작 로그 `announcedIps=[...]` 확인. 참조: SRS FR-WRTC-071, TC-A-009, Design §4.7 |

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
| RFP/PRD/SRS/Design/Ops/TC | [RFP_Channel_Slot](../../../docs/rfp/RFP_Channel_Slot.md) · [PRD_Channel_Slot](../../../docs/prd/PRD_Channel_Slot.md) · [SRS_Channel_Slot](../../../docs/srs/SRS_Channel_Slot.md) · [Design_Channel_Slot](../../../docs/design/Design_Channel_Slot.md) · [Channel_Slot_Guide](../../../docs/ops/Channel_Slot_Guide.md) · [TC_Channel_Slot](../../../docs/tc/TC_Channel_Slot.md) — Dashboard Channel Slot (channelSlot 전역 매핑, MAX_CHANNEL_NUM) |
| PRD | [PRD_LTS2026_YouTube_RTSP_Ingest](../../../docs/prd/PRD_LTS2026_YouTube_RTSP_Ingest.md) · [PRD_Camera_Discovery](../../../docs/prd/PRD_Camera_Discovery.md) · [PRD_WebRTC_Media_Gateway](../../../docs/prd/PRD_WebRTC_Media_Gateway.md) · [PRD_STUN_TURN_ICE](../../../docs/prd/PRD_STUN_TURN_ICE.md) |
| PRD | [PRD_Distributed_AI_Pipeline](../../../docs/prd/PRD_Distributed_AI_Pipeline.md) — 스트리밍 서버 프레임 포워딩 제품 요구사항 |
| SRS | [SRS_LTS2026_YouTube_RTSP_Ingest](../../../docs/srs/SRS_LTS2026_YouTube_RTSP_Ingest.md) · [SRS_Camera_Discovery](../../../docs/srs/SRS_Camera_Discovery.md) · [SRS_WebRTC_Media_Gateway](../../../docs/srs/SRS_WebRTC_Media_Gateway.md) · [SRS_STUN_TURN_ICE](../../../docs/srs/SRS_STUN_TURN_ICE.md) |
| SRS | [SRS_Distributed_AI_Pipeline](../../../docs/srs/SRS_Distributed_AI_Pipeline.md) — ANALYSIS_SERVER_URL, back-pressure, 결과 오버레이 요구사항 |
| Design | [Design_RTSP_Capture_Backend](../../../docs/design/Design_RTSP_Capture_Backend.md) · [Design_FFmpeg_RTSP_Capture](../../../docs/design/Design_FFmpeg_RTSP_Capture.md) · [Design_WebRTC_Media_Gateway](../../../docs/design/Design_WebRTC_Media_Gateway.md) |
| Design | [Design_Camera_Discovery](../../../docs/design/Design_Camera_Discovery.md) · [Design_YouTube_RTSP_Ingest](../../../docs/design/Design_YouTube_RTSP_Ingest.md) · [Design_STUN_TURN_ICE](../../../docs/design/Design_STUN_TURN_ICE.md) |
| Design | [Design_Distributed_AI_Pipeline](../../../docs/design/Design_Distributed_AI_Pipeline.md) — 분산 파이프라인 아키텍처 설계 |
| Design | [Design_WebRTC_Engine_Modes](../../../docs/design/Design_WebRTC_Engine_Modes.md) — mediamtx·mediasoup·werift 엔진 비교·전환 방법 |
| Design | [Design_ONVIF_Metadata_Pipeline](../../../docs/design/Design_ONVIF_Metadata_Pipeline.md) — RTSP App RTP ONVIF 메타데이터 수집·라우팅 파이프라인 |
| MRD/RFP/PRD/SRS/Design/Ops/TC | [MRD_Thermal_Sensor_Coordinate_Calibration](../../../docs/mrd/MRD_Thermal_Sensor_Coordinate_Calibration.md) · [RFP_Thermal_Sensor_Coordinate_Calibration](../../../docs/rfp/RFP_Thermal_Sensor_Coordinate_Calibration.md) · [PRD_Thermal_Sensor_Coordinate_Calibration](../../../docs/prd/PRD_Thermal_Sensor_Coordinate_Calibration.md) · [SRS_Thermal_Radiometry_Overlay](../../../docs/srs/SRS_Thermal_Radiometry_Overlay.md) · [Design_Thermal_Radiometry_Overlay](../../../docs/design/Design_Thermal_Radiometry_Overlay.md) · [Thermal_Sensor_Calibration_Guide](../../../docs/ops/Thermal_Sensor_Calibration_Guide.md) · [TC_Thermal_Radiometry_Overlay](../../../docs/tc/TC_Thermal_Radiometry_Overlay.md) — 열상 센서 원본 해상도→영상 해상도 좌표 calibration |
| Design | [Design_DataChannel_CameraEvents](../../../docs/design/Design_DataChannel_CameraEvents.md) — WebRTC DataChannel Camera Events Tab UI |
| TC | [TC_RTSP_Capture_Backend](../../../docs/tc/TC_RTSP_Capture_Backend.md) · [TC_FFmpeg_RTSP_Capture](../../../docs/tc/TC_FFmpeg_RTSP_Capture.md) · [TC_WebRTC_Media_Gateway](../../../docs/tc/TC_WebRTC_Media_Gateway.md) · [TC_STUN_TURN_ICE](../../../docs/tc/TC_STUN_TURN_ICE.md) |
| TC | [TC_Distributed_AI_Pipeline](../../../docs/tc/TC_Distributed_AI_Pipeline.md) — SERVER_MODE별 기능 테스트 케이스 |
| Ops | [RTSP_Capture_Backend_Setup](../../../docs/ops/RTSP_Capture_Backend_Setup.md) · [FFmpeg_Installation_Compatibility](../../../docs/ops/FFmpeg_Installation_Compatibility.md) |
| Ops | [Distributed_AI_Pipeline_Setup](../../../docs/ops/Distributed_AI_Pipeline_Setup.md) — 분산 배포 운영 가이드 |

## 코드 수정 시 문서 동기화 의무

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `ingestDaemonCapture.js`, `ingest_daemon.py` | `docs/design/Design_RTSP_Capture_Backend.md` §6, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| `ingest_daemon.py` (_Watchdog, RTSP_READ_TIMEOUT) | `docs/design/Design_RTSP_Capture_Backend.md` §6.7, `docs/ops/RTSP_Capture_Backend_Setup.md` Watchdog 섹션 |
| `pipelineManager.js` (frameWatchdogTimer, reregisterAllWithIngestDaemon) | `docs/design/Design_RTSP_Capture_Backend.md` §6.7 |
| `scripts/startServer.js` (_respawnIngest, _attachIngestHandlers) | `docs/design/Design_RTSP_Capture_Backend.md` §6.7, `docs/ops/Process_Management.md` |
| `captureFactory.js` | `docs/design/Design_RTSP_Capture_Backend.md` §2 코드스니펫 |
| `socket/streamHandler.js` (camera:capabilities) | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/design/Design_Server_Architecture.md` |
| `scripts/restartIngestDaemon.js` | `CLAUDE.md` 개발 명령어, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| `api/cameras.js` (FORCE_NO_WEBRTC) | `docs/design/Design_RTSP_WebRTC_Architecture.md` |
| `server/.env*` (WEBRTC_ENGINE 변경) | `docs/design/Design_WebRTC_Engine_Modes.md` §8 |
| `services/webrtc/mediasoupEngine.js` (DataChannel 변경) | `docs/design/Design_WebRTC_Engine_Modes.md` §4, `docs/design/Design_DataChannel_CameraEvents.md` |
| `routes/internalApi.js` (apprtp 경로, ONVIF 저장) | `docs/design/Design_ONVIF_Metadata_Pipeline.md` §6, `docs/design/Design_ONVIF_Timeline.md` §3 |
| `routes/onvifApi.js` (REST API) | `docs/design/Design_ONVIF_Timeline.md` §3.3, `CLAUDE.md` API 표 |
| `db.js` (`onvif_events` 스키마) | `docs/design/Design_ONVIF_Timeline.md` §2.1 |
| `ingest_daemon.py` (_app_rtp_* 변경) | `docs/design/Design_ONVIF_Metadata_Pipeline.md` §5, `docs/srs/SRS_ONVIF_Metadata_Pipeline.md`, `docs/tc/TC_ONVIF_Metadata_Pipeline.md` |
| `rtspCapture.js` *(레거시)* | `docs/design/Design_FFmpeg_RTSP_Capture.md` (Deprecated) |
| `gstreamerCapture.js` | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| `webrtcGateway.js`, `rtpIngestion.js` | `docs/design/Design_WebRTC_Media_Gateway.md` (Historical) |
| `discoveryService.js`, `onvifDiscovery.js` | `docs/design/Design_Camera_Discovery.md`, `docs/srs/SRS_Camera_Discovery.md` |
| `youtubeStreamService.js` | `docs/design/Design_YouTube_RTSP_Ingest.md`, `docs/srs/SRS_LTS2026_YouTube_RTSP_Ingest.md` |
| `channelSlotService.js`, `api/cameras.js`/`youtubeStreams.js`(channelSlot 검증), `db/index.js`(backfill 훅) | `docs/design/Design_Channel_Slot.md`, `docs/srs/SRS_Channel_Slot.md`, `docs/tc/TC_Channel_Slot.md` |
| `CameraGrid.tsx`(channelSlot 렌더링), `ChannelSlotPicker.tsx`, `CameraList.tsx`/`CameraEditModal.tsx`(Channel 섹션) | `docs/design/Design_Channel_Slot.md` §5, `docs/prd/PRD_Channel_Slot.md` |
| `ThermalOverlay.tsx`(toScreen sensorWidth/Height), `CameraEditModal.tsx`(Sensor Coordinate 섹션), `api/cameras.js`(thermalSensorWidth/Height) | `docs/design/Design_Thermal_Radiometry_Overlay.md` §8, `docs/srs/SRS_Thermal_Radiometry_Overlay.md` §6, `docs/tc/TC_Thermal_Radiometry_Overlay.md` 그룹 F |
| `MAX_CHANNEL_NUM` (server/.env*) | `docs/ops/Channel_Slot_Guide.md` §2 |
| `mediamtx.yml` | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| coturn / TURN 설정 변경 | `docs/design/Design_STUN_TURN_ICE.md`, `docs/tc/TC_STUN_TURN_ICE.md` |
| `services/analysisClient.js` | `docs/design/Design_Distributed_AI_Pipeline.md`, `docs/ops/Distributed_AI_Pipeline_Setup.md` |

**공통 규칙**
- **새 기능 추가** → PRD + SRS + Design + TC 문서 모두 신규 작성 또는 기존 문서에 항목 추가
- **버그 수정** → 스펙 오류가 원인이면 SRS·Design 수정, TC에 회귀 케이스 추가
- **설정 파라미터 변경** → SRS 제약 조건 + Ops 가이드 + TC 경계값 반영
- **새 캡처 백엔드 추가** → Design_RTSP_Capture_Backend + SRS + TC + Ops 가이드 신규 추가
