# DESIGN DOCUMENT
# RTSP 캡처 백엔드 추상화 — FFmpeg / GStreamer / PyAV 다중 백엔드 설계

| | |
|---|---|
| **Document ID** | DESIGN-LTS-CAPTURE-002 |
| **Version** | 1.36 |
| **Status** | Active |
| **Date** | 2026-07-20 |
| **Ops Guide** | [RTSP_Capture_Backend_Setup.md](../ops/RTSP_Capture_Backend_Setup.md) |
| **Related Design** | [Design_FFmpeg_RTSP_Capture.md](../design/Design_FFmpeg_RTSP_Capture.md) · [Design_RTSP_WebRTC_Architecture.md](../design/Design_RTSP_WebRTC_Architecture.md) |

---

## Table of Contents
1. [목적 및 범위](#1-목적-및-범위)
2. [아키텍처 개요](#2-아키텍처-개요)
3. [FFmpeg 백엔드](#3-ffmpeg-백엔드) *(레거시)*
4. [GStreamer 백엔드](#4-gstreamer-백엔드)
5. [PyAV 백엔드](#5-pyav-백엔드)
6. [Ingest-Daemon 백엔드](#6-ingest-daemon-백엔드) *(현재 기본값)*
7. [백엔드 선택 기준 비교](#7-백엔드-선택-기준-비교)
8. [이벤트 인터페이스 규격](#8-이벤트-인터페이스-규격)
9. [환경변수 참조](#9-환경변수-참조)
10. [오류 처리 및 재연결](#10-오류-처리-및-재연결)
11. [향후 고려사항](#11-향후-고려사항)

---

## 1. 목적 및 범위

이 문서는 LTS-2026의 RTSP 카메라 스트림 수집 계층을 단일 FFmpeg 의존에서
**4가지 백엔드(ingest-daemon / ffmpeg / gstreamer / pyav)를 런타임에 선택 가능한 추상화 구조**로 확장한 설계를 기술합니다.

> **현재 기본 백엔드:** `CAPTURE_BACKEND=ingest-daemon` (Python PyAV 독립 데몬)  
> **ffmpeg 캡처 서브프로세스**: v1.1(2026-06-11)부터 레거시로 분류됩니다. `captureFactory.js`에서 여전히 선택 가능하지만, 신규 배포에는 `ingest-daemon` 사용을 권장합니다.

각 백엔드는 동일한 `EventEmitter` 인터페이스를 구현하므로, 상위 서비스(`pipelineManager.js`)는
어떤 백엔드가 선택되었는지 알 필요 없이 `frame` 이벤트만 수신합니다.

**범위:**
- `server/src/services/captureFactory.js` — 백엔드 선택 팩토리
- `server/src/services/ingestDaemonCapture.js` — Ingest-Daemon 백엔드 (Node.js 수신 래퍼, **현재 기본**)
- `ingest-daemon/ingest_daemon.py` — Python PyAV 독립 데몬 프로세스
- `server/src/services/rtspCapture.js` — FFmpeg 백엔드 *(레거시)*
- `server/src/services/gstreamerCapture.js` — GStreamer 백엔드
- `server/src/services/pyavCapture.js` — PyAV 백엔드 (Node.js 래퍼, 인라인 사이드카)
- `server/src/python/pyav_capture.py` — PyAV Python 사이드카 프로세스

**범위 외:**
- MediaMTX 프록시 설정 (→ `camera-stream-setup` SKILL)
- WebRTC SFU (→ `Design_WebRTC_Media_Gateway.md`)
- YouTube 스트림 수집 (→ `Design_LTS2026_YouTube_RTSP_Ingest.md`)

---

## 2. 아키텍처 개요

```
IP 카메라 (RTSP/554)
    │
    ▼ TCP 연결
┌──────────────────────────────────────────────────────────────┐
│  captureFactory.js                                           │
│                                                              │
│  CAPTURE_BACKEND env var                                     │
│    'ingest-daemon' → IngestDaemonCapture (★현재 기본값★)   │
│    'ffmpeg'        → RTSPCapture      (레거시)              │
│    'gstreamer'     → GStreamerCapture (레거시)              │
│    'pyav'          → PyAVCapture      (레거시)              │
└──────────────────────┬───────────────────────────────────────┘
                       │ 동일 EventEmitter 인터페이스
                       │ events: frame / started / reconnecting
                       │         stats / warn / error
                       ▼
             PipelineManager (pipelineManager.js)
                       │
                       ▼
             detection.js (YOLOv8 ONNX)
```

### 팩토리 패턴

```javascript
// captureFactory.js
const CAPTURE_BACKEND = (process.env.CAPTURE_BACKEND || 'ffmpeg').toLowerCase();

function createCapture(cameraId, rtspUrl, opts = {}) {
  switch (CAPTURE_BACKEND) {
    case 'ingest-daemon': return new (require('./ingestDaemonCapture'))(cameraId, rtspUrl, opts);
    case 'gstreamer':     return new (require('./gstreamerCapture'))(cameraId, rtspUrl, opts);
    case 'pyav':          return new (require('./pyavCapture'))(cameraId, rtspUrl, opts);
    case 'ffmpeg':
    default:              return new (require('./rtspCapture'))(cameraId, rtspUrl, opts);
  }
}

module.exports = { createCapture, CAPTURE_BACKEND };
```

> **Note:** `ingest-daemon` 백엔드는 `IngestDaemonCapture`(패시브 EventEmitter)를 반환합니다. 외부 Python 데몬이 JPEG 프레임을 HTTP POST로 Node.js에 전달하며, Node.js는 이를 `injectFrame()` → `emit('frame', jpegBuffer)` 경로로 내부에 주입합니다. 다른 백엔드처럼 `start()` 메서드가 서브프로세스를 직접 스폰하지 않습니다.

`pipelineManager.js`는 직접 `RTSPCapture`를 `require`하는 대신 `createCapture()`를 호출합니다.
백엔드 변경은 `.env`의 `CAPTURE_BACKEND` 값만 바꾸면 서버 재시작 후 즉시 적용됩니다.

---

## 3. FFmpeg 백엔드 *(레거시)*

> ⚠️ **v1.1(2026-06-11) 이후 레거시로 분류됩니다.** `CAPTURE_BACKEND=ingest-daemon`이 기본값이며, 신규 배포에는 ingest-daemon을 사용하세요. ffmpeg 캡처 서브프로세스는 여전히 동작하나, 단일 RTSP 연결 원칙(Design_RTSP_WebRTC_Architecture.md §2.1)을 위반하므로 권장하지 않습니다.

### 3.1 개요

- **파일**: `server/src/services/rtspCapture.js`
- **의존성**: 시스템에 설치된 `ffmpeg` 바이너리
- **특징**: 가장 넓은 OS/코덱 호환성, Ubuntu 18.04 (ffmpeg 3.4)부터 지원

### 3.2 파이프라인 다이어그램

```
IP 카메라 (RTSP/TCP)
    │
    ▼
ffmpeg 자식 프로세스
    ├─ [입력 옵션]
    │    -rtsp_transport tcp
    │    -fflags +genpts+igndts
    │    [-stimeout|-timeout] 5000000   ← ffmpeg Major 버전에 따라 자동 선택
    │    -analyzeduration 1000000
    │    -probesize 1000000
    │    -i rtsp://user:pass@IP/PATH
    │
    ├─ [필터/인코딩]
    │    -vf fps=10,scale=640:-2
    │    -f image2pipe -vcodec mjpeg -q:v 5
    │
    └─ stdout → JPEG 연속 바이트 스트림
         │
         ▼
    Node.js _onData()
    SOI(FF D8 FF) / EOI(FF D9) 마커로 프레임 추출
         │
         ▼ emit('frame', jpegBuffer)
    PipelineManager
```

### 3.3 ffmpeg 버전 자동 감지

서버 기동 시 `ffmpeg -version`으로 Major 버전을 1회 감지하여 RTSP 타임아웃 플래그를 자동 선택합니다.

| FFMPEG_MAJOR | 플래그 | 대상 Ubuntu |
|---|---|---|
| `< 4` | `-stimeout 5000000` | 18.04 (ffmpeg 3.4.x) |
| `>= 4` | `-timeout 5000000` | 20.04+ (ffmpeg 4.x / 6.x / 7.x) |

자세한 버전 호환성은 [Design_FFmpeg_RTSP_Capture.md](../design/Design_FFmpeg_RTSP_Capture.md) 참조.

---

## 4. GStreamer 백엔드

### 4.1 개요

- **파일**: `server/src/services/gstreamerCapture.js`
- **의존성**: `gst-launch-1.0` 및 관련 GStreamer 플러그인
- **특징**: 낮은 CPU 레이턴시, NVIDIA nvdec / Intel VA-API 하드웨어 가속 지원

### 4.2 하드웨어 가속 자동 감지

서버 기동 시 `gst-inspect-1.0 [plugin]`으로 하드웨어 디코더 가용 여부를 1회 확인합니다.

```
GSTREAMER_HW_ACCEL=auto (기본)
    │
    ├─ gst-inspect-1.0 nvdec  → status=0 이면 nvdec 사용
    ├─ gst-inspect-1.0 vaapi  → status=0 이면 vaapi 사용
    └─ 둘 다 없으면           → software 소프트웨어 디코딩
```

| `GSTREAMER_HW_ACCEL` 값 | 동작 |
|---|---|
| `auto` | nvdec → vaapi 순으로 자동 탐색 |
| `nvdec` | NVIDIA GPU 전용 강제 |
| `vaapi` | Intel/AMD VA-API 전용 강제 |
| `software` | 소프트웨어 디코딩 강제 |

### 4.3 파이프라인 다이어그램

**Software 모드:**
```
rtspsrc location="rtsp://..." protocols=tcp latency=200
    ! decodebin
    ! videorate max-rate=10
    ! videoscale ! video/x-raw,width=640
    ! videoconvert
    ! jpegenc quality=85
    ! fdsink fd=1
         │
         ▼ stdout → JPEG 연속 바이트 스트림
    Node.js _onData()
    SOI/EOI 마커로 프레임 추출
         │
         ▼ emit('frame', jpegBuffer)
```

**NVIDIA nvdec 모드:**
```
rtspsrc ...
    ! rtph264depay
    ! h264parse
    ! nvh264dec           ← NVIDIA GPU 하드웨어 디코딩
    ! videorate max-rate=10
    ! videoscale ! video/x-raw,width=640
    ! videoconvert
    ! jpegenc quality=85
    ! fdsink fd=1
```

**Intel/AMD VA-API 모드:**
```
rtspsrc ...
    ! decodebin            ← vaapidecodebin 자동 선택
    ! videorate max-rate=10
    ! videoscale ! video/x-raw,width=640
    ! vaapipostproc        ← VA-API 색공간 변환
    ! jpegenc quality=85
    ! fdsink fd=1
```

### 4.4 stderr 필터링

GStreamer stderr의 경고/오류 패턴:

```
/ERROR|error|WARN|warning|No such|Could not|Failed|Unauthorized|401/
```

---

## 5. PyAV 백엔드

### 5.1 개요

- **파일**: `server/src/services/pyavCapture.js` (Node.js 래퍼) + `server/src/python/pyav_capture.py` (Python 사이드카)
- **의존성**: Python 3.x, `av` (PyAV), `Pillow` 패키지
- **특징**: Python 생태계의 CUDA 연동 최적화, 향후 GPU 인퍼런스 통합 경로

### 5.2 파이프라인 다이어그램

```
IP 카메라 (RTSP/TCP)
    │
    ▼
Python 사이드카 프로세스
    python3 pyav_capture.py <rtsp_url> <fps> <width> <hw_accel>
    │
    ├─ PyAV (libav 바인딩)
    │    av.open(rtsp_url, options={'rtsp_transport':'tcp'})
    │    for frame in container.decode(video=0):
    │        frame.reformat(width, height, 'rgb24')
    │
    ├─ PIL/Pillow
    │    Image.fromarray(ndarray).save(stdout, 'JPEG', quality=85)
    │
    └─ stdout → JPEG 연속 바이트 스트림
         │
         ▼
    Node.js PyAVCapture._onData()
    SOI(FF D8 FF) / EOI(FF D9) 마커로 프레임 추출
         │
         ▼ emit('frame', jpegBuffer)
    PipelineManager
```

### 5.3 사이드카 기동 인수

```bash
python3 pyav_capture.py <rtsp_url> <fps> <width> <hw_accel>
# 예시:
python3 pyav_capture.py rtsp://admin:pass@192.168.1.100/stream 10 640 none
python3 pyav_capture.py rtsp://admin:pass@192.168.1.100/stream 10 640 cuda
```

| 인수 | 설명 |
|---|---|
| `rtsp_url` | RTSP 스트림 URL |
| `fps` | 목표 캡처 프레임레이트 |
| `width` | 출력 영상 너비 (픽셀) |
| `hw_accel` | 하드웨어 가속: `none` / `cuda` / `videotoolbox` |

### 5.4 Python/PyAV 가용성 확인

서버 기동 시 Python 바이너리와 패키지를 1회 확인합니다:

```javascript
spawnSync(PYAV_PYTHON_BIN, ['-c', 'import av, PIL; print("ok")'])
// status=0 & stdout="ok" → PYAV_AVAILABLE = true
```

가용하지 않을 경우 `start()` 호출 시 즉시 `error` 이벤트를 발생시킵니다.

---

## 6. Ingest-Daemon 백엔드 *(현재 기본값)*

### 6.1 개요

- **Node.js 래퍼**: `server/src/services/ingestDaemonCapture.js` — 패시브 EventEmitter (프레임 주입 전용)
- **Python 데몬**: `ingest-daemon/ingest_daemon.py` — 독립 HTTP 서버 + PyAV RTSP 캡처
- **통신 방식**: 외부 데몬 → HTTP POST `{callbackUrl}/api/internal/frame/{cameraId}` → Node.js
- **의존성**: Python 3.x + `av` (PyAV) + `Pillow`

이 백엔드는 기존 서브프로세스 모델(ffmpeg/gstreamer)과 달리, Node.js가 프레임을 직접 캡처하지 않습니다.
별도 Python 데몬이 RTSP 연결을 관리하고 JPEG 프레임을 Node.js에 HTTP POST로 전달합니다.

### 6.2 아키텍처 다이어그램

```
IP 카메라 (RTSP)
    │
    ▼ TCP 연결 (단일 연결 원칙)
MediaMTX (mediamtx.yml, :8554 RTSP 로컬 재퍼블리시)
    │                          │
    ▼ RTSP loopback            ▼ WebRTC WHEP (:8889)
ingest_daemon.py              브라우저
    │  PyAV decode
    │  JPEG 인코딩 (10 FPS)
    │  HTTP POST callbackUrl
    ▼
Node.js /api/internal/frame/:id
    │  onIngestFrame(cameraId, jpegBuffer)
    ▼
IngestDaemonCapture.injectFrame()
    │  emit('frame', jpegBuffer)
    ▼
PipelineManager — AI 분석 / Socket.IO 전송
```

### 6.3 Python 데몬 HTTP API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/health` | 데몬 상태 확인 (`{"status":"ok","cameras":N}`) |
| `POST` | `/cameras` | 카메라 등록 `{"id","rtspUrl","callbackUrl"}` |
| `DELETE` | `/cameras/:id` | 카메라 등록 해제 |

### 6.4 B-프레임 처리

H.264 B-프레임 카메라(대부분의 IP 카메라)는 모든 패킷을 디코더에 공급해야 합니다. 이전 서브프로세스 백엔드에서는 패킷 스킵 시 빈 프레임이 발생했습니다. ingest-daemon은 다음 방식으로 해결합니다:

```python
# 모든 패킷 디코딩 → 출력 프레임에서만 레이트 제한
for packet in container.demux(video_stream):
    for frame in packet.decode():      # 항상 디코딩
        frame_counter += 1
        if frame_counter % AI_FRAME_INTERVAL == 0:
            self._push_jpeg(frame)     # N번째 프레임만 전송
```

### 6.5 MediaMTX 연동

`WEBRTC_ENGINE=mediamtx` 환경에서:
- `pipelineManager.js`가 MediaMTX REST API로 카메라 경로를 등록
- 데몬은 MediaMTX loopback RTSP(`rtsp://127.0.0.1:8554/{cameraId}`)에 연결
- 브라우저는 MediaMTX WHEP(`https://SERVER_IP:8889/{cameraId}/whep`)로 직접 WebRTC 수신

### 6.6 `npm run ingest:restart`

서버 전체 재시작 없이 ingest 데몬만 재시작합니다:

```bash
# workspace 루트에서
npm run ingest:restart

# server/ 에서
npm run ingest:restart -- --dry-run  # 설정 출력만
```

- 기존 daemon 프로세스 종료(포트 7070 kill)
- 새 데몬 시작 → `/health` 기동 확인(최대 10초)
- DB에서 카메라 목록 읽어 재등록 (`callbackUrl` 포함)

---

### 6.7 Watchdog 및 자동 복구 (Auto-Recovery)

ingest-daemon은 두 계층의 Watchdog으로 RTSP 스트림 고착 및 프로세스 충돌을 자동 복구합니다.

#### 계층 1 — PyAV 내부 Watchdog (`ingest_daemon.py`)

각 RTSP 세션(`ai` / `vrtp` / `artp` / `apprtp`)에 독립적인 `_Watchdog` 스레드가 붙습니다.

```python
RTSP_READ_TIMEOUT = float(os.environ.get("RTSP_READ_TIMEOUT", "5"))  # 기본 5초

class _Watchdog:
    def _run(self):
        while not self._disarmed.wait(timeout=0.25):
            if elapsed > self._timeout:
                log.warning("%s watchdog: no RTP for %.1fs — closing container", ...)
                self._container.close()   # demux() → av.AVError → 루프 종료
                return
```

- RTP 패킷이 `RTSP_READ_TIMEOUT`(기본 5 s) 동안 도착하지 않으면 PyAV 컨테이너를 닫습니다.
- `demux()` 루프가 `av.AVError` / `OSError`를 발생시키고 `_*_loop()` 함수가 재연결을 스케줄합니다.
- RTSP keepalive(OPTIONS/GET_PARAMETER)는 `wd.reset()`을 호출하지 않으므로 "keepalive는 살아있지만 영상이 없는" 고착 상태를 정확히 감지합니다.
- 환경변수 `RTSP_READ_TIMEOUT`(초)으로 민감도를 조정할 수 있습니다.

#### 계층 2 — Node.js 프레임 Watchdog (`pipelineManager.js`)

`pipelineManager.js`는 카메라별로 `setInterval`(8 s 주기)을 유지하며,
마지막 JPEG 수신 이후 `FRAME_STALL_MS`(기본 20 s)가 지나면 복구를 시도합니다.

```javascript
// server/src/services/pipelineManager.js
const FRAME_STALL_MS = 20_000;

ctx.frameWatchdogTimer = setInterval(async () => {
  if (!ctx.running || !ctx.lastFrameAt) return;
  const stalledMs = Date.now() - ctx.lastFrameAt;
  if (stalledMs > FRAME_STALL_MS) {
    ctx.lastFrameAt = Date.now();             // 다음 인터벌까지 재발동 방지
    ctx.capture.stop();

    if (CAPTURE_BACKEND === 'ingest-daemon' && ctx._ingestRtspUrl) {
      // mediamtx/직접 경로: ingest-daemon HTTP API로 재등록
      await _ingestRemoveCamera(camera.id);
      await _ingestRegisterCamera(camera.id, ctx._ingestRtspUrl, ctx._ingestCallbackUrl);
    } else if (CAPTURE_BACKEND === 'ingest-daemon') {
      // mediasoup 경로: 엔진이 PlainTransport 재생성 + daemon에 POST
      await getWebRTCEngine().addCameraStream(camera.id, ctx._captureUrl);
    }
    ctx.capture.start();
  }
}, 8_000);
```

| 필드 | 값 | 설명 |
|---|---|---|
| `FRAME_STALL_MS` | 20,000 ms | 마지막 JPEG 이후 이 시간 경과 시 복구 시작 |
| 폴링 주기 | 8,000 ms | setInterval 주기 |
| `ctx._ingestRtspUrl` | MediaMTX loopback URL | 설정 시 직접 HTTP 재등록 |
| `ctx._captureUrl` | 원본 RTSP / MediaMTX URL | mediasoup 재등록 시 사용 |

**버그 수정 — 재진입 가드 누락으로 인한 restart storm (2026-07-15):** 위 `setInterval(async () => {...}, 8_000)` 콜백에 재진입 가드가 없어, `_ingestRemoveCamera()`(최대 1회 재시도 포함 최대 ~10.5s) + `_ingestRegisterCamera()`(최대 5s) 왕복이 8초 폴링 주기보다 오래 걸리면 다음 tick이 이전 복구 작업이 끝나기 전에 또 발동해 같은 카메라 ID에 대해 remove+register를 중복 실행했음 — 새로 맺어진 연결이 안정화되기도 전에 스스로 다시 끊어버리는 무한 restart storm으로 이어짐. 실측(TID-A800, `192.168.214.32`)에서 RTSP 핸드셰이크 자체가 15초 이상 걸려 이 조건에 상시 해당했고, 동일 물리 카메라에 대해 2개의 카메라 레코드(채널 0/1)가 각각 4개(AI/videoRTP/audioRTP/appRTP) 세션을 열어 총 8개 동시 RTSP 세션이 걸리면서 증상이 더 심해짐 — 로그상 8~25초 주기로 "Stopped → removed → AI loop starting"이 끝없이 반복되고 `AI frame #1`을 넘어서기도 전에 다시 끊기는 패턴으로 나타났다. 다른 카메라라도 재등록 왕복이 일시적으로 8초를 넘기면 동일 증상이 재현될 수 있어, 특정 카메라만의 문제가 아니라 전반적인 "재생 끊김"의 공통 원인이었다.

수정: `ctx._watchdogBusy` 불리언 가드를 추가해 이전 복구 작업이 진행 중이면 새 tick을 스킵. 또한 `ctx.capture.start()` 이후 `ctx.lastFrameAt`을 재시작 완료 시점으로 다시 갱신해, 새로 등록된 세션이 RTSP 핸드셰이크를 마칠 때까지 `FRAME_STALL_MS`(20s) 전체를 유예받도록 함(기존에는 tick이 발동한 시점 기준으로 갱신되어 실제 재등록 소요 시간만큼 유예가 깎였음). 소스: `server/src/services/pipelineManager.js` frame watchdog 블록.

```javascript
ctx._watchdogBusy = false;
ctx.frameWatchdogTimer = setInterval(async () => {
  if (!ctx.running || !ctx.lastFrameAt || ctx._watchdogBusy) return;
  const stalledMs = Date.now() - ctx.lastFrameAt;
  if (stalledMs > FRAME_STALL_MS) {
    ctx._watchdogBusy = true;
    try {
      // ...capture.stop() → _ingestRemoveCamera() → _ingestRegisterCamera() → capture.start()
      ctx.lastFrameAt = Date.now(); // 재시작 완료 시점 기준으로 유예 재부여
    } finally {
      ctx._watchdogBusy = false;
    }
  }
}, 8_000);
```

#### `Camera.webrtcVideoOnly` — 세션 부하 완화용 video-only fan-out (2026-07-15 추가)

재진입 가드(§6.7 계층 2) 적용 후에도 TID-A800(`192.168.214.32`)은 watchdog stall이 완전히 사라지지 않고 주기적으로 재발했음 — 원인 조사 순서(모두 라이브로 실측):

1. **ICMP ping 클린**: `192.168.214.32`로 120회 ping, 패킷 손실 0%·지연 <2ms — 순수 네트워크 계층 문제 아님
2. **AI 디코딩 CPU 병목 가설**: `ingest_daemon.py`의 AI 경로가 `codec_context.thread_type="NONE", thread_count=1`(단일 스레드 강제)였고, TID-A800(2560×1920@30fps)은 이 카메라 fleet에서 가장 큰 프레임 크기 — `thread_type="AUTO", thread_count=0`(멀티스레드 디코딩)으로 전환했으나 단독으로는 stall 빈도를 유의미하게 낮추지 못함
3. **동일 물리 카메라 중복 등록**: `ffmpeg`로 채널 0(`/0/H.264/`)·채널 1(`/1/H.264/`) 각각 1프레임씩 캡처해 시각적으로 비교 — 완전히 동일한 화면(사무실 데스크뷰)으로 확인, 실제로는 단일 물리 카메라를 두 카메라 레코드("TID-A800"·"TID-A800 Ch2")로 중복 등록하고 있었음. 각 레코드가 4개(AI/video/audio/appRTP) RTSP 세션을 열어 총 8개 동시 세션이 한 카메라에 걸림 — 하나를 삭제해 반짝 안정화됐으나, 이후 다른 세션에서 같은 카메라가 재발견/재등록되며 두 레코드가 다시 공존하게 됨(아래 참고)
4. **video-only fan-out**: 세션 수를 더 줄이기 위해 `mediasoupEngine.js`의 `addCameraStream(cameraId, rtspUrl, appRtpRtspUrl, captureFps, opts)`에 `opts.videoOnly`를 추가 — `true`면 audio `PlainTransport`/`Producer`와 App RTP용 `DirectTransport`/`DataProducer`를 아예 생성하지 않고, ingest-daemon 등록 body에서도 `mediasoupAudioPort`/`appRtpCallbackUrl`/`appRtpRtspUrl`을 생략(daemon 쪽 `CameraSession.__init__`이 `if self.mediasoup_audio_port:`/`if self.app_rtp_callback_url:`로 존재 여부만으로 스레드 기동 여부를 결정하므로, 필드 자체를 안 보내면 해당 스레드가 시작되지 않음). 카메라당 세션 4→2.
   - `negotiate()`(WHEP)에서 `cam.audioProducer.closed`/`cam.dataProducer.closed`를 옵셔널 체이닝 없이 직접 참조하던 두 곳이 `videoOnly` 카메라에서 `TypeError`를 낼 수 있어 `cam.audioProducer && !cam.audioProducer.closed` / `cam.dataProducer && !cam.dataProducer.closed`로 가드 추가 — `_closeCam()`은 이미 전 필드 옵셔널 체이닝이라 무영향
   - `Camera.webrtcVideoOnly`(boolean, `PUT /api/cameras/:id`) → `pipelineManager.js`가 `ctx._webrtcVideoOnly`로 캐싱해 watchdog 재등록 경로(`reregisterAllWithIngestDaemon()` 포함) 3곳 모두 동일하게 반영
5. **최종 실측 결과**: `TID-A800`(video-only, 세션 2)에 적용 직후 1회 재시작(전환 직후 과도기적 40초 지점) 후 5분+ 연속 무중단, 동시에 재등록되어 있던 `TID-A800 Ch2`(표준 4세션, video-only 아님)도 같은 기간 재시작 0회 — 물리 카메라 1대당 총 세션 수가 8→6(2+4)로 줄어든 것만으로 두 채널 모두 안정화됨. 이는 원인이 카메라 자체의 동시 RTSP 세션 처리 한계(네트워크도 디코딩 속도도 아님)였음을 시사

**중복 등록이 다시 나타난 경위**: 이 저장소 작업 환경은 여러 세션이 동시에 공유하므로(과거 기록 참고), 한 세션에서 카메라를 삭제해도 다른 세션이나 discovery 재스캔이 동일 물리 카메라를 다시 등록할 수 있음 — 실제로 그렇게 됨. 강제로 계속 유지하려 하지 않고, 대신 위 4번(video-only)으로 "레코드 2개가 공존해도 세션 총량이 감당 가능한 수준"이 되도록 조정하는 편이 이런 공유 환경에서 더 견고함.

#### §6.8 카메라당 RTSP 세션을 정확히 1개로 — 단일 연결 재설계 (2026-07-15)

`Camera.webrtcVideoOnly`(위 §6.7 항목)는 세션을 4→2로 줄여 TID-A800을 안정화했지만, "RTSP는 무조건 1개, YouTube도 1개"라는 명시적 요구를 만족하려면 그 이상이 필요함 — `ingest_daemon.py`를 카메라당 **정확히 1개의 `av.open()`**만 여는 구조로 재설계.

**아키텍처 (모듈 docstring 및 코드 주석 참고):**
- `CameraSession`에 스레드가 하나만 남음 — `io`(구 `_combined_loop`/`_combined_ingest_once`). 이 스레드가 `video`+`audio`(+같은 URL일 때 `app` data 스트림)를 `container.demux(*streams)` 하나로 함께 읽음.
- 영상 RTP passthrough(디코드 없음, 시간 민감)는 `io` 스레드에서 그대로 처리 — 지연에 민감하므로 절대 다른 스레드로 옮기지 않음.
- AI JPEG 디코드는 **완전히 별도 스레드**(`_ai_decode_worker`)로 분리 — `io` 스레드는 각 비디오 패킷의 **원시 바이트**(`bytes(packet)`, PyAV 객체가 아닌 불변 데이터)를 bounded queue(`_WORKER_QUEUE_MAXSIZE`, 기본 60, 가득 차면 drop)로 넘기고, 워커는 자신만의 독립 `CodecContext`(`vs.codec_context.extradata`로 시딩)로 디코드. **동일 스레드에서 decode+RTP mux를 합치는 시도는 과거(§6.7 이전) 한 번 시도·롤백됐음** — 느린 디코드가 시간 민감한 RTP mux를 head-of-line-block 시켰기 때문. 원시 바이트를 큐로 넘겨 디코드를 별도 스레드로 완전히 분리하는 이번 설계는 그 실패를 반복하지 않음(직접 검증: TID-A800에 대해 269개 패킷 크로스스레드 디코드, 에러 0).
- 오디오: 이미 Opus인 경우 무손실 passthrough는 `io` 스레드에서 그대로(디코드 불필요, 저렴), 그 외 포맷은 transcode 전용 워커 스레드로 분리(AI 워커와 동일 패턴).
- App RTP(ONVIF 메타데이터)는 `appRtpRtspUrl == rtspUrl`(현재 mediasoup/직접-카메라 배포의 일반적인 경우)일 때만 같은 연결에 합류 — 다를 때(MediaMTX loopback 모드)는 원본 카메라 URL이 필요하므로 기존 별도 연결(`_app_rtp_loop`)을 그대로 유지(이 경우는 물리적으로 다른 소스라 1개로 합칠 수 없음).

**부수적으로 함께 발견·수정한 문제 3건** (모두 카메라 churn이 잦을 때만 드러남):

1. **`_join_threads` 타임아웃 부족**: 스레드가 1개(`io`)로 줄면서 그 내부 정리(AI/오디오 워커 join + RTP muxer/container close)가 중첩됨 — 기존 3초 타임아웃은 이 중첩 정리 시간(최대 ~7초)에 못 미쳐 오히려 스레드가 새어나갔음(구조상 4개였을 때보다 스레드당 정리 시간이 길어졌기 때문). 8초로 상향(구조 4-스레드 방식은 스레드당 개별 3초 예산이라 이론상 최대 12초였으므로 회귀 아님).
2. **HTTP 서버가 단일 스레드**: `HTTPServer`(요청 순차 처리) → `ThreadingHTTPServer`로 교체. 카메라 churn이 몰릴 때 느린 stop() 하나가 다른 모든 요청(다른 카메라 add/remove, `/health`)을 막던 문제 해결.
3. **`CameraManager.add()`/`remove()`의 동기적 `sess.stop()`**: HTTP 요청을 처리하는 스레드가 최대 8초짜리 join을 그대로 물고 있었음 — `old.stop()`을 별도 `threading.Thread`로 fire-and-forget 실행하도록 변경, HTTP 응답은 즉시 반환.
4. **카메라당 `ThreadPoolExecutor(max_workers=4)`**: JPEG/App RTP push용 스레드 풀을 카메라마다 만들고 있어 fleet 전체로 최대 4×카메라수(13대 기준 52개) 스레드가 쌓일 수 있었음 — 데몬 전체가 공유하는 `_SHARED_PUSH_EXECUTOR`(기본 `max_workers=16`, env `INGEST_PUSH_WORKERS`)와 `_SHARED_PUSH_SEMAPHORE`로 통합.

**검증 (라이브, TID-A800 대상):**
- 독립 스크립트로 원시 바이트 크로스스레드 디코드 기법 확인(269 패킷, 에러 0)
- 실제 `CameraSession` 클래스를 직접 인스턴스화해 30초 실행 — video RTP 10,804 UDP 패킷/30s, AI JPEG 278프레임/30s, 스레드 누수 없음
- `CameraSession` 4회 연속 시작/종료 사이클 — 매번 스레드 수가 정확히 baseline으로 복귀(누수 0)
- 배포 후 13개 카메라+YouTube 전체 재등록 시 로그에 `Combined RTSP loop starting`이 카메라당 1줄만 나타남(과거처럼 `AI loop`/`Video RTP loop`/`Audio RTP loop`/`App RTP loop` 4줄이 아님) — "RTSP 1개" 요구가 코드 레벨에서 충족됨을 로그로 직접 확인

**§6.8 배포 직후 남아있던 미해결 항목** (아래 §6.9에서 실제 근본 원인 확정·수정됨): 위 3개 부수 수정(join 타임아웃/ThreadingHTTPServer/공유 풀) 배포 후에도 데몬 스레드 수는 안정적(393개 고정, 성장 없음)이었지만, `curl http://127.0.0.1:7070/health`가 간헐적으로 수십초~2분 이상 응답하지 않는 현상이 남아있고, 이 창에서는 Node.js의 watchdog 재등록(`_ingestRemoveCamera`/`_ingestRegisterCamera`, 5초 타임아웃)이 실제로 반복 실패함(YouTube 채널 다수에서 로그로 확인). `av.open()`/`demux()`가 블로킹 구간에서 GIL을 정상적으로 반환하는지는 별도 스크립트로 검증해 문제 없음을 확인했으므로(카운터 스레드가 6개의 동시 PyAV 연결 중에도 베이스라인 속도 그대로 유지), GIL 경합은 원인이 아니었음.

#### §6.9 진짜 근본 원인 — `mediasoupEngine.js`의 무제한 대기 HTTP 요청이 카메라를 영구히 잠금 (2026-07-16)

§6.8 배포 다음날, TID-A800이 서버를 몇 시간 재시작 없이 켜뒀더니 다시 완전히 멈춰(`frameCount` 정지) 있었고, `POST /api/cameras/:id/stream/start`를 수동으로 호출해도 `{"success":true}`를 반환하면서도 실제로는 파이프라인이 전혀 시작되지 않는(`pipelineStatus`가 계속 `null`) 현상을 발견 — 로그에도 `Capture started`/`Fatal error` 어느 쪽도 찍히지 않고 완전히 침묵.

**원인**: `pipelineManager.js`의 `startCamera(camera)`는 동시 호출 방지를 위해 `_starting`(Set) 가드를 사용합니다:
```javascript
async startCamera(camera) {
  if (this._starting.has(camera.id)) return;   // 이미 시작 중이면 조용히 no-op
  this._starting.add(camera.id);
  try {
    await this._doStartCamera(camera);
  } finally {
    this._starting.delete(camera.id);           // 항상 정리 — 단, await가 "끝나야" 실행됨
  }
}
```
`_doStartCamera()`는 mediasoup 경로에서 `getWebRTCEngine().addCameraStream()`을 호출하고, 그 내부는 ingest-daemon에 `POST /cameras`를 보내는 `_ingestPost()`를 `await`합니다. 그런데 `_ingestPost()`/`_ingestDelete()`(`mediasoupEngine.js`)는 **Node 내장 `http.request()`를 타임아웃 없이** 사용하고 있었음(`pipelineManager.js`의 동급 함수 `_ingestRegisterCamera`/`_ingestRemoveCamera`는 `fetch()` + `AbortSignal.timeout(5000)`로 이미 보호되어 있었지만, mediasoup 전용 헬퍼는 그 보호가 빠져 있었음). ingest-daemon이 (§6.8에서 다룬 것과 같은 부류의) 응답 지연을 한 번이라도 겪으면 이 Promise가 **영원히 resolve도 reject도 되지 않고**, `_doStartCamera()`의 `await`가 끝나지 않으므로 `finally { this._starting.delete(camera.id) }`도 절대 실행되지 않습니다 — 그 순간부터 해당 카메라 ID는 **프로세스가 재시작될 때까지 영구히** `_starting`에 남아, 이후의 모든 시작 시도(부팅 시 자동시작, watchdog 재시작, 수동 `stream/start` API 호출 전부)가 첫 줄의 가드에서 조용히 no-op됩니다 — 에러 로그도 전혀 남지 않아 원인 파악이 어려웠음.

**수정**: `_ingestPost()`/`_ingestDelete()`에 `timeout: 8000`(ingest-daemon 쪽 `_join_threads` 8초 예산과 정합) 옵션과 `req.on('timeout', () => req.destroy(new Error(...)))` 핸들러 추가 — 타임아웃 시 `req.destroy(err)`가 기존 `req.on('error', reject)` 핸들러를 통해 Promise를 정상적으로 reject시켜, `_starting` 가드가 절대 영구 고착되지 않도록 보장. 소스: `server/src/services/webrtc/mediasoupEngine.js`.

**검증**: 수정 배포 후 서버 재부팅 시 TID-A800 두 채널 모두 다른 11개 카메라와 함께 즉시 자동시작(`running=true`, frameCount 정상 증가) — 이전에는 매 재부팅마다 정적으로 남아있었음. 90초 관찰 창에서 TID-A800 watchdog 재시작 0회, mediasoup Consumer 진단 로그(`Consumer-diag [43e8ec94] bytesSent=2225750 pkts=1517`)로 실제 WebRTC 비디오 패킷이 지속적으로 전송되고 있음을 직접 확인. Playwright 기반 `iceTest.js`(`--headless`)로 STUN/TURN/ICE 인프라 자체도 독립 검증(ICE `connected`, LAN direct 경로) — 이 스크립트가 기존에는 자체 서명 인증서 때문에 `ERR_CERT_AUTHORITY_INVALID`로 항상 실패했던 것도 `ignoreHTTPSErrors: true` 추가로 함께 수정.

**교훈**: 동일한 다운스트림(ingest-daemon)을 호출하는 두 개의 병렬 HTTP 클라이언트 구현(`pipelineManager.js`의 `fetch`+타임아웃 vs `mediasoupEngine.js`의 원시 `http.request`+무제한 대기)이 존재했고, 한쪽만 보호되어 있었던 것이 근본 원인 — 재발 방지를 위해 향후 ingest-daemon을 호출하는 신규 코드는 반드시 명시적 타임아웃을 갖춰야 함.

#### §6.10 `ingest-daemon` 간헐적 응답 불능의 진짜 원인 — libav 내부 디코드 스레드가 코어 수만큼 자동 증식 (2026-07-16)

§6.9 배포 이후에도 `ingest-daemon`의 `/health`가 다시 완전히 무응답 상태(10초 타임아웃)로 돌아오는 현상이 재발 — 이번엔 프로세스 스레드 수가 270개(기동 직후) → 399~482개(약 15~30분 후, 실제 카메라/YouTube churn 하에서)로 계속 증가한 뒤 완전히 멈췄음. `CameraManager.add()`/`remove()`의 "stopper" 스레드를 무제한 `threading.Thread(...).start()`에서 고정 크기(`_SHARED_STOP_EXECUTOR`, 8 workers) `ThreadPoolExecutor`로 교체했지만 재발을 막지 못함 — 이 수정 자체는 유효하지만 근본 원인이 아니었음.

**진단**: `py-spy`/`gdb`는 이 환경에서 ptrace 권한(`/proc/sys/kernel/yama/ptrace_scope=1`, sudo 없음)이 없어 사용 불가. 대신 `faulthandler.register(signal.SIGUSR1, ...)`을 데몬 코드에 내장해 `kill -USR1 <pid>`만으로 프로세스 자신이 모든 Python 스레드의 실제 스택을 `/tmp/ingest-daemon-stacks.log`에 덤프하도록 함(외부 ptrace 불필요). 실제로 멈춘 인스턴스에 이 신호를 보내 확보한 덤프 결과, **Python이 인지하는 스레드는 51개뿐**이었는데 동시각 `/proc/<pid>/task`에는 400개 이상이 있었음 — 나머지 350개 이상은 Python `threading` 모듈에 등록되지 않은 스레드, 즉 C 확장(libav)이 내부적으로 만든 네이티브 스레드였다는 뜻.

**원인**: `_ai_decode_worker()`가 각 카메라의 AI 디코드용 `CodecContext`에 `ctx.thread_type = "AUTO"; ctx.thread_count = 0`을 설정하고 있었음 — libav는 `thread_count=0`을 "가용 코어 수만큼 자동 할당"으로 해석한다. 이 서버는 40코어(`nproc`)이므로, 카메라 1대의 AI 디코드 `CodecContext` 하나가 최악의 경우 최대 40개의 네이티브 디코드 스레드를 열 수 있고, 13대 카메라 전체로는 이론상 최대 520개까지 누적될 수 있는 구조였다. 이 스레드들은 Python 레벨에서 전혀 보이지 않으므로 기존의 모든 진단(GIL 경합 배제 테스트, `_starting` 가드 조사, stopper 풀 도입)이 놓칠 수밖에 없었음 — `thread_type="AUTO"` 자체는 §6.7 이전부터 TID-A800의 2560×1920@30fps 대형 프레임을 단일 스레드 디코드로는 실시간 처리할 수 없어서 의도적으로 도입된 설정이었다(대형 프레임 자체의 멀티스레드 디코드 필요성은 여전히 유효함).

**수정**: `thread_count=0`(코어 수만큼 자동)을 고정 상한 `_AI_DECODE_THREADS`(환경변수 `AI_DECODE_THREADS`, 기본값 4)로 교체 — 대형 프레임의 프레임/슬라이스 병렬 디코드 이점은 유지하면서, 전체 네이티브 스레드 수가 카메라 대수 × 코어 수가 아니라 카메라 대수 × 4로 상한선이 고정되도록 함. 소스: `ingest-daemon/ingest_daemon.py` `_ai_decode_worker()`.

**검증**: 수정 배포 직후 프로세스 스레드 수 125개(이전 기동 직후 기준 270개 대비 대폭 감소), `/health` 응답 7ms. 장시간 churn 하에서의 스레드 수 증가 억제 여부는 후속 관찰 필요(진행 중).

**교훈**: 스레드 수 폭증 진단에서 `/proc/<pid>/task`(OS 레벨)와 `threading.enumerate()`/`sys._current_frames()`(Python 레벨, faulthandler 포함)의 카운트가 다르면 C 확장이 자체적으로 스레드를 생성하고 있다는 강한 신호다 — Python 코드만 감사해서는 절대 찾을 수 없음. libav의 `thread_count=0`(auto)은 코어 수에 비례하므로, 컨테이너/멀티 카메라처럼 하나의 프로세스가 같은 종류의 `CodecContext`를 다수 여는 워크로드에서는 위험한 기본값 — 항상 고정 상한을 명시할 것.

#### §6.11 재시작 직후 전체 함대 동시 연결로 인한 완전 정지, 그리고 SIGTERM 무응답으로 인한 카메라측 좀비 세션 (2026-07-16)

§6.10 배포 직후에도 daemon 재시작 시 13개 카메라 + 6개 YouTube 세션이 **거의 동시에** `av.open()`을 호출하면서 4분 이상 전체 정지(프레임 0건, `/health` 완전 무응답, 메인 accept 스레드는 `select()`에서 정상 대기 중)가 재현됨. SIGUSR1 스택 덤프로 확인한 결과, 10개 이상의 카메라 io 스레드가 setup 단계의 동일한 지점에 몰려 있었고 단 하나도 steady-state 루프에 도달하지 못했음 — GIL이 CPU/파싱 부하가 큰 setup 단계(연결+스트림 프로빙+워커 스레드 기동)에서 다수 스레드에 의해 장시간 점유된 것으로 추정.

**수정 1 — 연결 수립 게이트**: `_combined_ingest_once()`의 `av.open()`부터 steady-state demux 루프 진입 직전까지를 `_INGEST_SETUP_SEMAPHORE`(기본 3, `INGEST_SETUP_CONCURRENCY`)로 감싸 동시 setup 개수를 제한. steady-state 루프 진입 직후 즉시 해제(연결 수명 전체를 붙잡지 않음). 소스: `ingest_daemon.py` `_combined_ingest_once()`.

**수정 2 — SIGTERM 무응답 발견**: 게이트 적용 후에도 REAL IP 카메라(TID-A800 등)에 대한 `av.open()`이 개별적으로 계속 멈춰있는 게 관찰됨. 원인 조사 중 `ingest_daemon.py`가 `except KeyboardInterrupt`(SIGINT)만 처리하고 **SIGTERM에는 아무 핸들러도 등록하지 않았음**을 발견 — `npm run ingest:restart`/`stop`이 실제로 보내는 신호는 SIGTERM인데, Python 기본 동작상 핸들러 없는 SIGTERM은 프로세스를 즉시 종료시켜 `finally` 블록도, `container.close()`(RTSP TEARDOWN 전송)도 전혀 실행되지 않음. 이 세션에서 디버깅 중 반복한 재시작(4~5회, 모두 SIGTERM)마다 카메라 측에 정상 종료되지 않은 RTSP 세션이 남았고, 특히 동시 세션 처리 한계가 낮은 TID-A800(§6.7)이 이 좀비 세션 누적으로 새 연결 자체를 거부/행(hang)하게 되어 §6.11 앞부분의 setup 게이트 permit이 영구히 반환되지 않는 연쇄 장애로 이어진 것으로 판단.

**수정**: `signal.signal(signal.SIGTERM, _handle_sigterm)`을 `main()` 시작 시 등록, 핸들러는 `KeyboardInterrupt`를 재발생시켜 기존 SIGINT 경로의 `_manager.stop_all()`(→ 카메라별 `container.close()` → RTSP TEARDOWN)을 SIGTERM에도 동일하게 적용. 소스: `ingest_daemon.py` `_handle_sigterm()`.

**검증**: 좀비 세션 발생 이후 daemon을 SIGTERM으로 재시작(이번엔 그레이스풀)하고 카메라측 세션 타임아웃을 기다린 뒤 재확인 — TID-A800 Ch1/Ch2 포함 13개 카메라 전부 `running=true`, `frameCount` 지속 증가, `lastFrameAt` 10~20초 이내로 신선함을 `/api/cameras` REST 조회로 직접 확인. `/health` 응답도 5~17ms로 정상.

**미해결 (2026-07-16 시점, §6.12에서 부분 해소됨)**: 위 수정 이후에도 대부분의 카메라(TID-A800뿐 아니라 TNM-C2712TDR·TNO-C3020TRA·TNM-C2712T 등)의 `lastFrameAt`이 약 20~24초 주기로 정체된 뒤 Node.js 프레임 watchdog(`FRAME_STALL_MS=20_000`)에 의해 강제 재시작되는 패턴이 다수 카메라에서 거의 동시에 관찰됨 — 특정 카메라(TID-A800)만의 문제가 아니라 함대 전체에 걸친 주기적 현상일 가능성. daemon 프로세스 자체는 9분+ 동안 죽지 않고 살아있었지만(같은 PID 유지), 그 사이에도 `/health`가 어떤 순간엔 5~17ms, 어떤 순간엔 8초 완전 타임아웃으로 오락가락하는 것을 확인 — 완전 정지가 아니라 주기적 부분 마비.

#### §6.12 setup 게이트의 진짜 결함 — 취소된 카메라가 permit을 영원히 기다림, 그리고 SIGTERM이 실제로는 신뢰할 수 없음 (2026-07-16)

`FRAME_STALL_MS`를 20s→45s로 완화했지만 재발 — 이번엔 `mediasoup re-registration failed`가 **실제 IP 카메라 7대 전부**에서 거의 균등한 빈도(최근 100건 중 각 14~15건)로 나타남, TID-A800만의 문제가 아니었음. `addCameraStream failed: ingest-daemon POST /cameras timed out after 8000ms`가 원인 — ingest-daemon의 `/cameras` POST 핸들러 자체는 스레드만 스폰하고 즉시 응답해야 하는데도 8초를 넘김.

**원인**: §6.11에서 추가한 `_INGEST_SETUP_SEMAPHORE.acquire()`가 **타임아웃도 `self._stop` 확인도 없는 순수 블로킹 호출**이었음. 카메라가 재시작될 때마다(약 45~56초 주기) 옛 세션의 io 스레드가 아직 permit을 기다리는 도중에 `CameraManager.add()`로 교체(cancel)될 수 있는데, 대기 중인 `acquire()`는 이 취소를 전혀 알지 못하고 **영원히 대기**함. permit은 5개(원래 3개)뿐이므로, 이런 영구 대기 스레드가 재시작마다 하나씩 누적되어 결국 새로 등록하려는 카메라조차 실제 permit을 받기까지 오래 걸리게 되고, 그 여파가 (놀랍게도) ingest-daemon 전체의 HTTP 응답성까지 저하시켜 POST 자체가 8초를 넘기게 만든 것으로 판단(스레드 수 폭증이 다시 §6.10과 같은 부류의 전반적 스케줄링 저하를 유발).

**수정**: `acquire()`를 `while not self._stop.is_set(): if _INGEST_SETUP_SEMAPHORE.acquire(timeout=0.5): break` 폴링 방식으로 교체 — 취소된 카메라는 0.5초 내 대기를 포기하고 조용히 반환(`_combined_loop`의 `while not self._stop.is_set()`이 이를 정상적인 종료로 처리). 동시성도 3→5로 상향. 소스: `ingest_daemon.py` `_combined_ingest_once()`.

**부수 발견 — 비디오 payload_type 암묵 의존**: 오디오 RTP 출력은 `payload_type`을 명시하는데 비디오는 하지 않고 있었음(ffmpeg rtp muxer 기본값에 암묵적으로 의존). mediasoup Producer는 `VIDEO_PT=96`만 허용하므로 위험한 비대칭 — `_MEDIASOUP_VIDEO_PT=96`을 신설해 오디오와 동일하게 명시.

**검증**: 배포 후 WHEP 테스트에서 **처음으로 실제 비디오 바이트 수신 확인**(TID-A800, t=20s 시점 bytesReceived=1,628,448) — 이전까지는 예외 없이 0바이트였음. mediasoup 등록 실패 패턴도 재시작 직후 관찰 window에서 소멸.

**부수 발견 — SIGTERM이 실제로는 신뢰할 수 없음**: §6.11에서 추가한 SIGTERM 핸들러가 격리된 재현 스크립트에서는 100% 정상 작동(핸들러 발동, 2초 내 정상 종료)하지만, **실제 daemon 프로세스에서는 재현 불가 — 여러 차례 SIGTERM을 보내도 메인 스레드가 몇 분씩 원래의 `select()` 호출에 그대로 남아있음**(SIGUSR1 스택 덤프로 확인). 스레드별 `SigBlk`도 확인했으나 SIGTERM을 차단하는 스레드는 없었음 — 정확한 메커니즘은 미확정(다중 스레드 부하 하에서 CPython의 시그널 처리 타이밍 이슈로 추정). 근본 원인 규명 대신, **`server/src/scripts/restartIngestDaemon.js`의 `killExistingDaemon()`에 systemd 스타일 TERM→(8초 대기)→KILL 승급 로직을 추가**해 재시작이 항상 성공하도록 함(기존에는 고정 500ms 대기 후 바로 `startDaemon()`을 호출해 옛 프로세스가 포트를 아직 쥐고 있으면 "Address already in use"로 매번 실패했음 — 사용자가 직접 `npm run ingest:restart`를 실행하다 이 실패를 겪음). `stopServer.js`는 이미 이 패턴을 쓰고 있었으므로 두 스크립트가 이제 일관됨.

**미해결**: SIGTERM이 실제 daemon에서 왜 신뢰할 수 없는지 근본 원인 미확정(TERM→KILL 승급으로 증상은 우회됨). steady-state(정상 스트리밍 중) io 스레드가 `self._stop` 이후에도 8초 내 종료되지 않는 문제(§6.11 "leaked" 경고 로그)는 여전히 남아있음 — libav의 블로킹 `demux()`가 완전한 패킷은 아니지만 간헐적 소켓 활동이 있는 상황에서 `stimeout`을 안정적으로 트리거하지 못하는 것으로 추정되나, 다른 스레드에서 강제로 `container.close()`를 호출하면 크래시 위험이 있어(§6.8 문서화) 안전한 해결책이 아직 없음.

#### 계층 3 — 프로세스 자동 재시작 (`startServer.js`)

`startServer.js`는 ingest-daemon 프로세스의 `exit` 이벤트를 감지하여 지수 백오프로 재시작합니다.

```
ingest-daemon 프로세스 종료
    │
    ▼  _attachIngestHandlers(proc).on('exit')
    │  _shuttingDown? → return (정상 종료 중이면 무시)
    │
    ▼  _respawnIngest() — 지수 백오프 대기 (1s → 1.5s → 2.25s → ... → 최대 30s)
    │
    ▼  spawn(ingestExec, ingestArgs) + _attachIngestHandlers(proc)
    │
    ▼  /health 폴링 (최대 15 s)
    │
    ▼  ready → _ingestRestartAttempts = 0
           POST http://127.0.0.1:{PORT}/api/internal/ingest/reregister
               → pipelineManager.reregisterAllWithIngestDaemon()
                   ├── mediamtx 경로: _ingestRemoveCamera + _ingestRegisterCamera (직접)
                   └── mediasoup 경로: engine.addCameraStream (PlainTransport 재생성)
```

**복구 소요 시간 (일반적):**

| 경로 | 총 복구 시간 |
|---|---|
| mediasoup 카메라 | ~2–5 s (daemon 재시작 + reregister 호출) |
| mediamtx 카메라 | ~2–5 s (daemon 재시작 + reregister 호출) |
| daemon 반복 재시작 실패 | 최대 30 s 대기 후 재시도 |

**백오프 공식:**

```
대기 시간 = min(1000 × 1.5^attempt, 30000) ms
attempt:  0 → 1.0 s
          1 → 1.5 s
          2 → 2.25 s
          ...
          9 → 29.5 s (이후 30 s 고정)
```

성공 시 `_ingestRestartAttempts`를 0으로 리셋합니다.

#### `reregisterAllWithIngestDaemon()` — 통합 재등록 메서드

`pipelineManager.reregisterAllWithIngestDaemon()`은 모든 활성 파이프라인을
WEBRTC_ENGINE 종류에 무관하게 단일 API로 재등록합니다.

```javascript
// server/src/services/pipelineManager.js
async reregisterAllWithIngestDaemon() {
  for (const [cameraId, ctx] of this._pipelines) {
    if (!ctx.running) continue;
    if (ctx._ingestRtspUrl) {
      // mediamtx/직접 경로
      await _ingestRemoveCamera(cameraId);
      await _ingestRegisterCamera(cameraId, ctx._ingestRtspUrl, ctx._ingestCallbackUrl);
    } else if (CAPTURE_BACKEND === 'ingest-daemon') {
      // mediasoup 경로: engine이 PlainTransport 포트 포함 재등록
      await getWebRTCEngine().addCameraStream(cameraId, ctx._captureUrl);
    }
  }
}
```

HTTP API: `POST /api/internal/ingest/reregister` (localhost 전용, 인증 없음)

#### §6.24 프레임 워치독이 재시작을 시도하는 동안 대시보드 상태가 전혀 갱신되지 않던 결함 (2026-07-20)

**증상**: 카메라가 물리적으로 꺼지거나 네트워크가 끊겨도 Dashboard 우측 "Cameras" 패널(Added 탭)의 상태 dot이 변화 없이 마지막 상태(보통 초록 `streaming`)에 고정되어 있다는 사용자 보고.

**원인 (두 가지가 겹쳐 있었음)**:

1. `IngestDaemonCapture`(`ingestDaemonCapture.js`)는 `'started'`/`'stats'`/`'frame'` 세 이벤트만 emit하고 `'warn'`/`'reconnecting'`/`'error'`는 전혀 emit하지 않는 순수 passive receiver다. `pipelineManager.js`의 `_updateCameraStatus()` 호출 6곳 중 4곳(`source_unavailable`/`reconnecting`/`error`/최초 `streaming`)은 전부 이 `capture` EventEmitter의 이벤트에 의존하므로, ingest-daemon 백엔드(현재 기본값)에서는 프레임 워치독(§6.7 계층 2)이 스톨을 감지해 재등록을 반복 시도해도 성공이든 실패든 `camera:status`가 **한 번도 발행되지 않았다.**
2. `_updateCameraStatus()`가 `this._io.to(cameraId).emit(...)`으로 **해당 카메라 room에만** 전송하고 있었다. Room 가입은 `useCamera.ts`/`useAllDetections.ts`가 그 카메라의 `CameraView`를 실제로 마운트할 때만 일어나므로, 사이드바 "Cameras" 목록(`CameraList.tsx`)처럼 room에 가입하지 않는 컴포넌트나, 다른 채널 그룹 페이지로 넘어가 화면에 없는 카메라는 상태 갱신을 원천적으로 못 받는 구조였다.

**수정** (`pipelineManager.js`):

- `_updateCameraStatus()`: `io.to(cameraId).emit(...)` → `io.emit(...)` 전역 broadcast로 변경. `camera:status`는 저빈도 이벤트이고 사이드바 목록은 항상 최신 상태를 반영해야 하므로 room 제한의 이점이 없음.
- 프레임 워치독(§6.7 계층 2) 스톨 감지 분기 진입 시 재등록 시도 전에 즉시 `_updateCameraStatus(camera.id, 'reconnecting')` 발행.
- 재등록 연속 실패 횟수(`ctx._watchdogFailCount`)가 `WATCHDOG_ERROR_THRESHOLD`(3회) 이상이면 `_updateCameraStatus(camera.id, 'error')`로 격상 — 한 번의 일시적 재시도 실패만으로 빨간 dot을 띄우지 않도록 임계값을 둠.
- `ctx._statusIsDown` 플래그 도입: 기존 `capture.on('frame', ...)` 핸들러는 클로저 `firstFrame` 변수로 파이프라인 생애주기 통틀어 **딱 한 번만** `streaming`을 재발행했는데, 워치독이 `capture` 인스턴스를 재생성하지 않고 `stop()`/`start()`만 호출하는 구조라 스톨 이후 실제로 프레임이 재개돼도 `streaming` 상태가 다시 알려지지 않는 별개의 결함이었다. `ctx._statusIsDown`을 최초 연결 대기 중과 워치독 스톨 감지 시 모두 `true`로 세팅하고, 프레임 수신 시 `true`면 `streaming`을 재발행 후 `false`로 리셋하도록 통합.

**검증 범위**: 코드 정적 검토 및 `node --check` 문법 확인. 실제 카메라 전원 차단 재현 테스트는 후속 세션에서 라이브 확인 필요.

#### §6.25 H.265/HEVC 카메라의 WebRTC 재생 불가 — mediasoup 자체의 H.265 미지원이 근본 원인 (2026-07-20)

**증상**: 일부 카메라(TNM-C2712TDR 계열 4채널)의 WebRTC 영상이 아예 재생되지 않고(검은 화면, ICE 통계상 bytesReceived≈0), 실제 스트림 코덱을 확인한 결과 H.264가 아닌 H.265/HEVC였음. `ingest_daemon.py`는 이미 이 경우를 감지해 경고 로그를 남기고 있었지만, 그 이상의 처리는 없었음.

**1차 시도(동적 코덱 감지·선택)와 그 결과**: `mediasoupEngine.js`의 Router `mediaCodecs`와 video Producer가 전부 `video/H264`로 정적 하드코딩되어 있고 Producer가 ingest-daemon의 코덱 파악보다 먼저 생성되는 구조였으므로, 처음에는 이를 동적으로 만드는 방향으로 수정했음:

- `ingest_daemon.py`: `_parse_h264_sps_pps()`에 대응하는 `_parse_h265_vps_sps_pps()`를 추가해 H.265의 2바이트 NAL 헤더(VPS=32/SPS=33/PPS=34)와 RFC 7798 §7.1의 3분리 fmtp(`sprop-vps`/`sprop-sps`/`sprop-pps`)를 파싱, SPS의 `profile_tier_level()`에서 profile-id/tier-flag/level-id 추출. **최초 구현에는 Annex-B emulation-prevention byte(`00 00 03` → `00 00`) 제거 없이 비트 오프셋을 그대로 읽는 버그가 있어 `level-id`가 실제 카메라 4대 전부에서 0으로 나왔음** — 실제 SPS 바이트를 수동 디코드해 확인(예: level_idc 위치의 실제 바이트가 escape byte였음), `_remove_emulation_prevention()` 헬퍼를 추가해 수정(수정 후 2048×1536 카메라는 Level 5.0(150), 640×480 카메라들은 Level 4.0(120)으로 해상도와 합리적으로 상관되는 값이 나옴을 확인).
- `mediasoupEngine.js`: Router `mediaCodecs`에 `video/H265` 항목 추가, `addCameraStream()`의 video Producer 생성을 ingest-daemon 등록 이후로 옮겨 감지된 코덱에 따라 H264/H265 rtpParameters를 동적 선택, `_parseOffer()`/`_buildBrowserRtpCapabilities()`/`_buildAnswer()`를 H265 PT 매칭·3분리 sprop fmtp 주입까지 확장.

**실제 재현한 결과 — 근본적으로 막다른 길**: 서버·ingest-daemon을 재시작해 실제로 확인한 결과, `videoPlain.produce({ rtpParameters: { codecs: [{ mimeType: 'video/H265', ... }] } })` 호출이 **매번** `media codec not supported [mimeType:video/H265]`로 실패했음. 원인은 mediasoup 자체에 있음 — 설치된 버전(3.21.0)과 npm에 게시된 최신 버전(3.21.2)의 `node/lib/supportedRtpCapabilities.js`를 직접 확인한 결과, mediasoup의 네이티브 워커(C++)가 인식하는 비디오 코덱은 **VP8/VP9/H264/AV1뿐이며 H.265는 어떤 버전에도 존재하지 않음**. 즉 Producer 측 코덱 선언을 아무리 정확히 구성해도 mediasoup 자체가 H.265 RTP 페이로드 포맷(RFC 7798)을 처리하는 코드를 가지고 있지 않아 구조적으로 불가능함 — 이 프로젝트 코드의 버그가 아니라 의존 라이브러리의 기능 한계.

**최종 조치(되돌림)**: 위 mediasoup 관련 변경(Router H.265 항목, 동적 Producer 코덱 선택, `_parseOffer`/`_buildBrowserRtpCapabilities`/`_buildAnswer`의 H.265 분기)을 전부 제거하고 video Producer는 항상 H.264로 고정(기존 동작으로 복귀) — `addCameraStream()`도 Producer 생성을 원래 순서(등록 POST 이전)로 되돌림. 다만 `ingest_daemon.py`의 H.265 감지·파싱 로직(EPB 수정 포함)과 `GET /cameras/:id/video-params`의 확장 필드는 **유지** — 어떤 카메라가 HEVC라서 재생이 불가능한지 진단하는 용도로 여전히 유용하며, `addCameraStream()`이 등록 후 non-blocking으로 `_pollVideoCodec()`을 호출해 HEVC 카메라마다 명확한 경고 로그(`mediasoup has no H.265 support, WebRTC playback cannot work for this camera until it's reconfigured to H.264`)를 남김. 부수적으로 `negotiate()`의 `profileLevelId` 변수가 선언만 되고 `videoParams.profileLevelId`로부터 할당되지 않아 H.264 카메라에서도 `_buildAnswer()`의 override 분기가 항상 스킵되던 기존 결함을 발견·수정(이 부분은 되돌리지 않음, 정상 동작).

**실질적 해결책**: 이 4개 카메라의 WebRTC 재생을 살리려면 (a) 카메라/NVR 설정에서 해당 RTSP 프로파일을 H.264로 변경하거나, (b) mediasoup을 H.265를 지원하는 버전/포크로 교체하거나 다른 미디어 서버로 전환하는 두 경로뿐이며 둘 다 이 리포지토리의 코드 수정만으로 해결 불가능함. AI 감지 파이프라인(JPEG 캡처)은 mediasoup을 거치지 않으므로 이 카메라들에서도 정상 동작 중.

**검증 범위**: `node -c`/`python3 -m py_compile` 문법 확인 + 실제 라이브 재시작으로 재현·확인(`media codec not supported` 에러 직접 관측, mediasoup 3.21.0/3.21.2 소스 직접 다운로드해 지원 코덱 목록 확인). EPB 수정은 실제 4대 카메라의 SPS 원본 바이트를 수동 디코드해 검증.

#### §6.26 H.264 카메라조차 WebRTC 재생이 안 되던 진짜 원인 — mediasoup Consumer PT가 브라우저 offer와 무관하게 고정되는 구조적 한계, PT별 Router/파이프라인 캐시로 해결 (2026-07-20)

**증상**: 코덱이 확실히 H.264인 카메라(TID-A800 192.168.214.32, TNM-C2712TDR 192.168.214.40)조차 Chrome에서 재생이 안 됨 — Edge에서는 같은 카메라가 정상 재생됨. 브라우저 getStats()에서 `bytesReceived`는 정상 증가하지만 `framesReceived`/`framesDecoded`가 0에 머무르고, 비디오 `codec` 통계 항목 자체가 아예 생성되지 않음 — §6.13/§6.21에서 이미 다뤘던 "healthy transport, decoder never binds" 패턴과 동일.

**근본 원인 (mediasoup `node/lib/ortc.js` 직접 확인으로 확정)**: `getConsumableRtpParameters()`/`getConsumerRtpParameters()`는 Consumer가 실제로 내보내는 코덱 payload type을 **Router가 등록 시 정적으로 선언한 `preferredPayloadType`**으로 항상 고정한다. `negotiate()`마다 넘기는 `remoteRtpCapabilities`(`_buildBrowserRtpCapabilities()`가 브라우저 offer에 맞춰 패치하던 값)는 `matchCodecs(..., {strict:true})`로 "호환 코덱이 있는지"만 필터링할 뿐, 실제 전송 PT에는 **전혀 영향을 주지 않는다** — 이 파일의 기존 주석(§6.14 등)이 반대로 가정하고 있었던 부분. 브라우저의 SDP offer가 H.264에 어떤 PT를 배정하는지는 브라우저의 코덱 열거 순서(AV1/VP9 지원 여부, OS, 버전)에 좌우되며 **같은 머신의 Chrome과 Edge조차 다를 수 있음**(실측: Edge=PT108/재생됨, Chrome=PT109·RTX114/재생 안 됨) — Router에 정적으로 108을 박아두는 기존 방식은 "브라우저가 우연히 108을 쓰면 되고 아니면 실패"하는 도박이었음.

**시도했다가 폐기한 방법**: Router `mediaCodecs`에 H.264 엔트리를 PT=108/109 두 개 선언 + Producer 두 개 생성. mediasoup `ortc.js`의 `getProducerRtpParametersMapping()`을 직접 읽어 확인한 결과, Producer→Router capability 매칭은 `matchCodecs()`(packetization-mode + H.264 profile family만 비교, PT는 비교 기준에 없음)로 이뤄지고 `.find()`가 배열의 첫 매치를 결정적으로 선택함 — 두 엔트리가 실제로는 같은 카메라의 같은 비트스트림(같은 packetization-mode/profile)을 설명해야 하므로 구별 불가능, Producer를 몇 개 만들어도 항상 첫 번째(108)로만 매핑됨. `transport.produce()`에 `rtpMapping`을 직접 지정하는 옵션도 없어 우회 불가 — **한 Router 안에서는 근본적으로 불가능함을 소스 레벨로 확정**.

**실제 해결 — PT별 Router/파이프라인 지연 생성·캐싱**: RFC 3264 §6.1(answer는 offer가 실제 사용한 PT만 사용해야 함)을 만족하려면 브라우저가 offer한 PT를 **그대로** 선언한 Router가 있어야 하므로, 통계적 추측(자주 보이는 값 몇 개를 하드코딩) 대신 실제로 필요한 PT가 나타날 때마다 그 자리에서 만들어 캐싱하는 구조로 구현:

- `mediasoupEngine.js`: `_ensurePtRouter(videoPt, videoRtxPt)` — `videoPt`가 기존 기본값(108)이면 기존 공유 `_router`를 그대로 재사용(비용 0), 처음 보는 값이면 그 PT **하나만** 선언하는 새 Router를 같은 Worker 위에 생성(모호성 자체가 없어 매칭 문제 재발 안 함). RTX는 `_computeRtxPlaceholderPts()`(기존 §6.17의 8개 고정 placeholder 트릭을 임의의 목표 PT로 일반화 — mediasoup의 `dynamicPayloadTypes` free-list 순서를 그대로 재현해 목표 PT 앞의 모든 값을 harmless한 `audio/PCMU` placeholder로 미리 점유)로 브라우저가 실제 offer한 RTX PT에 맞춤 — 모를 때는 Consumer의 `enableRtx`를 꺼서 §6.17에서 확인된 "잘못된 PT에 RTX를 켜면 끄는 것보다 더 나빠짐" 위험을 피함.
- `_ensureAltPipeline()`/`_buildAltPipeline()` — 카메라별로 PT-Router 위에 video Producer(+App RTP DataProducer)를 지연 생성, ingest-daemon에 같은 RTP를 새 목적지로 fan-out 등록. 오디오는 이번 조사에서 문제가 확인되지 않아 범위 밖으로 두고 alt 파이프라인은 비디오+데이터만 제공(문서화된 의도적 축소).
- `ingest_daemon.py`: `CameraSession`에 `_video_fanout`(현재 연결 한정)/`_video_fanout_ports`(RTSP 재연결 간 유지) 도입, video RTP passthrough를 단일 목적지에서 리스트 기반 fan-out으로 변경. **주의**: `_mux_passthrough()`가 `packet.pts/dts/time_base/stream`을 제자리에서 변형하므로, 같은 패킷을 여러 목적지에 순서대로 mux할 때 원본 타이밍 값을 목적지마다 리셋하지 않으면 두 번째부터는 첫 번째 목적지의 변형된 상태를 기준으로 재계산되는 버그가 있었음 — 목적지 루프마다 `packet.pts/dts/time_base`를 원본값으로 리셋하도록 수정. 신규 엔드포인트 `POST /cameras/:id/video-fanout { port }`로 실행 중인 세션에도 목적지 추가 가능.
- `addCameraStream()`이 카메라 재등록마다 alt 파이프라인의 fan-out을 ingest-daemon에 재등록(ingest-daemon의 `CameraManager.add()`가 매번 새 `CameraSession` 객체를 만들어 `_video_fanout_ports`가 초기화되므로, 재등록 후 자동 복구 안 하면 alt-PT 시청자가 재연결/크래시 복구 때마다 조용히 끊김) + `_worker`의 `died` 핸들러에서 PT-Router 캐시도 함께 초기화.

**검증(실제 재현, 통계·추측 아님)**: 서버·ingest-daemon 재시작 후 실제 브라우저(Chrome) 재접속 시 로그에서 `alt-PT router ready videoPt=109 rtxPt=114` → `Video RTP fan-out added` → `alt-pipeline ready` 순서로 6개 카메라 전부 자동 생성됨을 확인. 이후 TID-A800의 실제 브라우저 WebRTC 통계(`GET /api/client-logs/webrtc`)에서 `framesDecoded: 2812`, `framesReceived: 2817`, `frameWidth: 2560`, `frameHeight: 1920`, `framesPerSecond: 30`, `keyFramesDecoded: 56` 확인 — 이 프로젝트의 전체 디버깅 세션을 통틀어 TID-A800에서 처음으로 실제 프레임 디코드가 확인된 사례.

#### §6.27 §6.26 배포 직후 재생은 되지만 FPS가 0/28/5fps로 요동치고 버퍼가 자주 비는 현상 — 커널 UDP 버퍼 실측 진단과 두 가지 원인 수정 (2026-07-20)

**증상**: §6.26 배포 후 Chrome·Edge 모두에서 영상 자체는 재생되지만, Dashboard ICE 패널에서 FPS가 0fps/28fps/5fps 등으로 자주 요동치고 buffer가 종종 0이 됨.

**진단(실측)**:
- `/proc/net/snmp`의 UDP `RcvbufErrors`가 5초 사이 42건(초당 ~8건) 증가 — 시스템 전체 UDP 소켓에서 커널 수신 버퍼 오버플로가 **그 순간에도 계속 발생 중**이었음(§6.18과 같은 클래스의 문제, 이번엔 다른 소켓).
- `ingest_daemon.py`가 CPU 270%대를 지속 사용 중. SIGUSR1 스레드 덤프(faulthandler)로 확인한 결과 명시적 크래시/블로킹은 아니었으나, §6.26으로 카메라당 video RTP mux 목적지가 최대 2개(기본 PT=108 + alt-PT)로 늘어난 상태에서 **실측상 거의 모든 실제 뷰어가 alt-PT(Chrome=109)만 사용**하고 있어 기본(108) 파이프라인은 아무도 안 보는데도 ingest-daemon이 계속 그쪽에도 mux하고 있었음 — "절대 지연되면 안 되는" io 스레드의 패킷당 작업량이 실질적으로 불필요하게 2배가 된 상태.
- `net.core.rmem_max`는 16MB로 이미 충분히 크지만(sudo 없이 확인만 가능, 변경은 불가), mediasoup의 `PlainTransport`만 §6.18에서 명시적으로 8MB 버퍼를 요청했을 뿐 **브라우저와 직접 통신하는 `WebRtcTransport`는 이 옵션 자체를 쓸 방법이 없는 `listenIps`(구식 API)를 사용 중**이어서 OS 기본값(`net.core.rmem_default` ≈ 208KB)에 머물러 있었음 — `Router.js` 소스 직접 확인으로 `listenIps`가 내부적으로 `listenInfos`로 변환될 때 `recvBufferSize`/`sendBufferSize` 필드가 전달되지 않음을 확정.

**수정**:
- `mediasoupEngine.js`의 `createWebRtcTransport()`를 `listenIps` → `listenInfos`로 전환(각 IP × udp/tcp 조합에 `recvBufferSize`/`sendBufferSize` 2MB 명시) — `Router.js`의 `listenIps→listenInfos` 자동 변환 로직을 그대로 수동 재현(같은 프로토콜 우선순위, `preferUdp` 유지).
- 기본(PT=108) 파이프라인의 ingest-daemon fan-out 등록을 **alt-PT 파이프라인과 동일하게 지연 생성**으로 전환 — `addCameraStream()`의 초기 `POST /cameras`에서 `mediasoupPort`를 아예 빼고, `negotiate()`가 실제로 PT=108을 필요로 하는 첫 순간에만 `POST /cameras/:id/video-fanout`으로 등록(`cam.videoFanoutRegistered` 플래그로 중복 등록 방지). 카메라 재등록/ingest-daemon 재시작 시에도 이 상태가 유실되지 않도록 `addCameraStream()`과 `reregisterAllWithIngestDaemon()`(= `npm run ingest:restart`가 실제로 타는 경로) 양쪽에 재등록 로직 추가 — 후자는 기존에 alt-PT 파이프라인 재등록 자체가 없던 결함이라 함께 수정.
- `waitForStreamReady()`가 실제로는 어디서도 호출되지 않는 죽은 코드임을 확인 — 기본 파이프라인 지연화가 그 함수의 동작을 바꿔도 실제 영향이 없음을 근거로 안전하다고 판단.

**검증(실제 재현)**: 재시작 후 실제 뷰어 재접속 로그에서 카메라별로 `(pipeline: default)`/`(pipeline: alt-PT 109)`가 혼재해서 찍히는 것을 확인(동일 서버에 여러 브라우저/탭이 각자 실제로 쓰는 PT에 대해서만 파이프라인이 생성됨). 수정 전 5초당 42건씩 증가하던 `RcvbufErrors`가 수정 후 5초간 **0건 증가**로 확인됨.

**추가 확인 — 위 수정만으로는 불충분했음**: `RcvbufErrors`는 잡았지만 사용자가 실제 Dashboard에서 재확인한 결과 FPS 요동·버퍼 비는 증상은 그대로였음. `ingest_daemon.py` CPU가 여전히 250~270%대에서 안 내려간 게 단서 — `AI_DECODE_THREADS`를 4→8로 늘려봤지만 CPU는 250%대로 거의 변화 없어(디코드 병렬도가 원인이 아님을 반증) 배제. 대신 실제 브라우저 candidate-pair RTT가 1~2ms로 완전히 동일 LAN임을 확인해 인터넷 구간 손실 가능성도 배제.

다음으로 `.env`의 `CAPTURE_FPS`가 빈 값이라 "네이티브 fps 자동 매칭" 모드로 동작해야 하는데, 실제 ingest-daemon 로그의 AI frame 카운터 간격을 보면 TID-A800이 초당 약 9~10프레임씩 2560×1920 원본 해상도로 JPEG 인코딩·푸시되고 있었음(참고: `pipelineManager.js`가 `process.env.CAPTURE_FPS || 10`으로 항상 truthy 값을 강제해, `.env` 주석이 설명하는 "비워두면 자동 매칭" 경로가 실제로는 한 번도 타지 않는 기존 불일치도 함께 발견 — 이번 세션에서는 수정하지 않고 기록만 함). `CAPTURE_FPS=5`로 명시적으로 낮추고(전역 설정이라 카메라별 차등은 현재 배선 없음) 서버·ingest-daemon 재시작 후 재측정:

| 지표 | 수정 전 | `CAPTURE_FPS=5` 적용 후 |
|---|---|---|
| `ingest_daemon.py` CPU | 250~270% | **170%** |
| TID-A800 패킷 손실률 | ~1.2% | **~0.26%** |
| .40 카메라(TNM) 패킷 손실률 | ~1.26% | **~0.56%** |
| TID-A800 PLI(디코더 풀 리셋 요청) | 16~19회 | **2회** |

CPU·손실률·PLI 모두 실측으로 뚜렷하게 개선됨을 확인. 다만 freezeCount가 완전히 0이 되지는 않아(8~14회) 잔여 불안정 요소가 더 있을 가능성은 남아있음 — AI 배회 감지의 시간 해상도를 낮추는 트레이드오프이므로 값 확정 전 실사용 화면으로 최종 확인 필요.

**클라이언트 측 보완 — 적응형 jitter buffer**: 서버 측 개선 후에도 카메라별로 수신 fps가 다르고(다른 Video 연결에 의한 자연스러운 편차) Dashboard ICE 패널의 Buffer 값이 카메라마다 다르게 나타남(TID-A800 100ms, TNM 7~12ms) — 사용자 확인 결과 이 편차 자체는 정상이나, "수신 fps가 흔들릴 때 재생기 버퍼가 동적으로 늘어나야 끊김이 준다"는 방향 확인 요청. `RTCRtpReceiver.jitterBufferTarget`(ms 단위, Chrome 123+; 이전 seconds 단위 `playoutDelayHint`의 W3C 표준화된 후속 — MDN·Chromium Intent-to-Ship로 확인)로 페이지에서 브라우저의 jitter buffer 최소 유지 시간을 직접 요청 가능함을 확인. `useWebRTC.ts`의 기존 5초 주기 stats 폴링 루프에 추가:
- 매 tick마다 freezeCount·packetsLost 증가분을 계산해, 증가가 있으면 목표치를 150ms 상향(최대 1000ms), 없으면 30ms씩 하향(플로어 100ms) — 아무 문제가 없었던 연결은 브라우저 기본값을 그대로 두고(0 = 미설정) 건드리지 않음.
- `pc.getReceivers()`에서 video 트랙의 Receiver를 연결 시점에 한 번 획득, `'jitterBufferTarget' in receiver` 런타임 feature-detect 후 적용.
- 클라이언트 빌드(`npm run build`)까지 완료 확인 — `express.static`이 매 요청마다 디스크에서 직접 서빙하고 Vite 빌드 산출물이 콘텐츠 해시 파일명이라, 서버 재시작 없이 브라우저 새로고침만으로 반영됨(server/src/index.js 주석에 이미 명시된 설계).

**추가 확인 — 백그라운드 탭 전환 시 "무조건" 재현되는 별개 원인**: 사용자가 위 프로액티브 jitterBufferTarget 적용 후에도 재확인한 결과 Buffer red→fps 0 증상이 남아있었고, 특히 브라우저 탭을 다른 창으로 전환했다가 되돌아올 때 "무조건" 발생한다는 결정적 단서를 제공함. WebSearch로 확인한 결과 Chrome은 백그라운드(비활성) 탭의 WebRTC 비디오 디코드를 절전을 위해 자체적으로 스로틀링/일시정지하며, 백그라운드 타이머 스로틀링 예산은 약 30초 후부터 적용됨 — 이 프로젝트의 프레임/바이트 스톨 워치독(`FRAME_STALL_MS`/`STALL_MS`, §6.20/§6.22에서 다룬 것과 같은 계열의 로직이나 그 당시엔 탭 가시성 자체를 인지하지 못했음)이 이 정상적인 브라우저 절전 동작을 실제 스트림 장애로 오인해 `staleReconnect()`를 유발하고 있었음이 근본 원인으로 확정됨.

**수정**: `useWebRTC.ts`에 Page Visibility API(`document.hidden`/`visibilitychange`) 기반 가드 추가:
- `visibilitychange` 리스너가 탭이 다시 보이는 순간(`!document.hidden`) 프레임/바이트/freeze/loss 기준 시각·카운터(`lastFrames`/`lastFramesAt`/`lastBytesRx`/`lastBytesRxAt`/`prevFreezeCount`/`prevLossForAdapt`/`prevJitterDelay`/`prevJitterCount`)를 모두 리셋 — 백그라운드 동안 쌓인 시간 격차를 "정지"로 오판하지 않도록 함. 리스너는 `sessionRegistry`의 `pc` 일치 여부로 자가 정리(§6.22와 동일한 패턴).
- 프레임/바이트 스톨 판정 로직 전체를 `if (!document.hidden) { ... }`로 감싸 탭이 숨겨진 동안은 카운터 갱신도, 스톨 판정도 하지 않음 — 최종 재연결 결정 블록도 `document.hidden`이면 완전히 no-op.
- 프로액티브 jitterBufferTarget 상향 로직(`bufferMs`/`freezeDelta`/`lossDeltaForAdapt` 기반 escalation)도 동일하게 `!document.hidden`으로 감싸 백그라운드 탭에서 부풀려지거나 정지된 `bufferMs` 값에 반응해 목표치를 잘못 올리는 것을 방지. decay(하향) 로직도 같은 블록 안에 있어 탭이 숨겨진 동안은 목표치가 고정됨.
- `document.removeEventListener('visibilitychange', ...)` 정리를 `clearInterval(statsTimer)`가 발생하는 두 지점(인터벌 자체의 entry-liveness 체크, `staleReconnect()` 내부) 모두에 추가.

**검증**: `npx tsc --noEmit`, `npm run build` 모두 클린 통과 확인.

**추가 개선 — ICE 패널 Bytes 표시를 누적 바이트에서 순간 bps로 변경 (2026-07-20)**: 기존 ICE 디버그 패널의 "Bytes ↑/↓" 항목은 nominated candidate-pair의 `bytesSent`/`bytesReceived`를 그대로 표시(§6.18에서 처음 구현)했는데, 이는 연결 시작 이후 누적값이라 시간이 지날수록 계속 커지기만 하고 "지금" 링크 상태를 보여주지 못함. `useWebRTC.ts`의 기존 5초 stats 폴링에서 video/audio Kbps를 계산하던 것과 동일한 델타 방식(`prevCpBytesTx`/`prevCpBytesRx` + 이전 샘플 시각 대비 경과 시간)으로 candidate-pair 바이트의 순간 전송률을 계산해 `IceStats.sentBps`/`receivedBps`(bits/sec)로 교체 — 기존 `bytesSent`/`bytesReceived` 필드는 제거. `WebRtcStatsPanel.tsx`의 해당 행 라벨을 "Bytes"→"Rate"로 변경하고 `fmtBps()` 헬퍼(bps/kbps/Mbps 자동 단위)로 표시, 더 이상 쓰이지 않게 된 `fmtBytes()` 헬퍼는 `noUnusedLocals` 빌드 설정에 따라 함께 제거. `npx tsc --noEmit`/`npm run build` 클린 통과 확인.

**추가 개선 — Rate 갱신 주기를 5초 폴링에서 분리해 1초로 단축 (2026-07-20)**: 사용자 요청으로 ICE 패널 Rate 값의 갱신 빈도를 높임. 전체 `statsTimer`의 `POLL_MS`(5초) 자체를 낮추는 대신 별도의 `rateTimer`(`RATE_POLL_MS=1000`)를 신설해 candidate-pair bytes만 1초마다 재조회·재계산하는 방식을 택함 — `POLL_MS`는 프레임/바이트 스톨 워치독의 판정 주기이자 `JITTER_TARGET_STEP_UP_MS`/`STEP_DOWN_MS`(§6.27 상단)의 틱당 증분 크기가 전제하는 시간 단위이기도 해서, 이 값을 그대로 1초로 낮추면 스톨 감지가 더 예민해지는 것은 물론 jitterBufferTarget escalation/decay 속도가 의도치 않게 5배 빨라져 §6.27 전체에서 검증한 튜닝이 깨짐. 두 루프가 candidate-pair를 파싱하는 로직(nominated pair 탐색 → local/remote candidate 매칭 → rttMs)이 동일해, 이를 모듈 스코프 `extractNominatedPair()` 헬퍼로 추출해 공유(메인 루프는 rttMs만, rateTimer는 local/remote+bytes만 사용). `rateTimer`는 `document.hidden`으로 게이팅하지 않음 — candidate-pair bytes는 ICE/네트워크 계층 카운터라 탭이 백그라운드로 디코드를 멈춘 동안에도(§focus-throttle) 실제로 계속 증가하므로, 스톨 워치독/jitterBufferTarget escalation과 달리 여기서는 감춰야 할 "허위 신호"가 아님. `npx tsc --noEmit`/`npm run build` 클린 통과 확인.

**추가 확인 — Buffer가 ~980ms까지 상승 후 fps 0·재생 정지·재연결·다시 반복되는 패턴 (2026-07-20, 진단만, 미수정)**: 사용자가 수신 대역폭이 10Mbps 이상으로 충분함에도 이 패턴이 반복된다고 보고 — 네트워크 대역폭은 원인에서 배제되고, 이는 이미 §6.20 코드 주석에 "client-side decode CPU starvation from many simultaneous high-res tiles/tabs — reconnecting cannot fix a browser decode-capacity problem"로 정확히 예견되어 있던 클라이언트 디코드 용량 한계 클래스의 증상과 정확히 일치함:
- `bufferMs`(`jitterBufferDelay`/`jitterBufferEmittedCount` 델타)는 "프레임이 재생되기까지 지터 버퍼에 머문 평균 시간"이지 네트워크 지연이 아님 — 네트워크는 정상인데 이 값이 계속 오르기만 하고 안정되지 않는다는 것은, 디코더가 도착 속도만큼 프레임을 소비(디코드+재생)하지 못해 버퍼에 미디어가 계속 쌓이고 있다는 신호. §6.21에서 이 카메라들에 Level 5.1(2560×1920 등급)을 적용했으므로 인코딩 자체는 정상이지만, 그만큼 브라우저 쪽 디코드 부하도 큼.
- 이 프로젝트의 프로액티브 jitterBufferTarget 로직(§6.27 상단)은 "bufferMs가 오르는 것은 네트워크 지터이니 버퍼를 더 늘려 흡수하자"는 전제로 설계됨 — 실제 원인이 네트워크 지터가 아니라 디코드 용량 부족이라면, 목표 버퍼를 올려봐야 디코드 처리량 자체가 늘지 않으므로 문제를 해결하지 못하고 오히려 큐만 더 깊게 쌓은 뒤에 무너지게 만들 가능성이 있음 — `JITTER_TARGET_MAX_MS=1000` 천장까지 거의 다 차서(~980ms) 정지하는 관찰과 부합.
- fps가 0으로 떨어졌다가 재연결로 30fps가 회복되는 패턴은, 재연결이 Consumer/디코더 상태를 리셋해 쌓여있던 백로그를 강제로 비워주기 때문일 뿐 — 디코드 용량 자체가 늘어난 것이 아니므로, 동일한 조건(예: 동일 그리드에 여러 고해상도 타일 동시 렌더링)이 유지되면 버퍼가 다시 쌓이기 시작해 같은 주기로 재현되는 것으로 설명됨.
- 검증되지 않은 가설이므로 다음 세션에서 확인 필요: (1) 해당 카메라를 그리드가 아닌 단일 풀스크린으로만 열어 동시 디코드 타일 수를 1개로 줄였을 때도 재현되는지(재현 안 되면 디코드 용량 가설 강화), (2) `chrome://gpu`/`chrome://media-internals`에서 해당 스트림이 하드웨어 가속 디코드를 실제로 타는지(소프트웨어 디코드라면 그 자체가 원인), (3) 재현 시점에 동시에 열려있던 다른 카메라 타일 수. **미수정** — 코드 변경 전 사용자 확인 대기 중.

**추가 확인 — `chrome://gpu` 실측 결과로 가설 수정 (2026-07-20)**: 사용자가 증상 재현 환경(Windows, Edge/151, NVIDIA RTX 2000 Ada, 동시 오픈 타일 JPEG 폴링 4개 + WebRTC 2개)의 `chrome://gpu` 리포트를 제공:
- **"Video Decode: Hardware accelerated"** 및 Video Acceleration Information에 `Decode h264 high: 64x64 to 4096x4096 pixels` 확인 — H.264 High 프로파일 하드웨어 디코드가 2560×1920(Level 5.1)을 충분히 커버함. **(2)번 확인 항목의 "소프트웨어 디코드가 원인" 가설은 이걸로 배제됨.**
- 동시 오픈 타일이 WebRTC 비디오 디코드가 필요한 것은 2개뿐(JPEG 폴링 4개는 `<img>` 갱신이라 별도 비디오 디코드 파이프라인을 타지 않음) — §6.20이 예견한 "many simultaneous high-res tiles"만큼 극단적인 동시 디코드 경합은 아니어서, 순수 디코드 처리량 부족 가설의 설명력이 약해짐.
- 대신 같은 리포트에서 새로운 단서 발견: `YUY2/NV12/BGRA8/RGB10A2/P010 overlay support`가 전부 **SOFTWARE**로 표시됨(`Direct Rendering Display Compositor: Disabled`도 함께) — 즉 H.264 디코드 자체는 GPU 하드웨어를 타지만, 디코드된 프레임을 화면에 합성(overlay/compositing)하는 경로는 이 GPU/드라이버 조합에서 진짜 제로카피 하드웨어 오버레이가 아니라 소프트웨어 경로로 폴백하고 있음. 또한 GPU 프로세스 로그에 `SharedImageManager::ProduceOverlay`/`ProduceSkia: Trying to Produce a ... representation from a non-existent mailbox` 에러가 여러 날짜·시각에 걸쳐 반복적으로(때로는 짧은 간격으로 연달아) 발생 — 디코드된 프레임을 컴포지터로 넘기는 SharedImage/mailbox 단계에서 실패가 간헐적으로 발생 중임을 시사.
- **가설 수정**: 순수 "디코드 처리량 부족"보다는, "디코드는 하드웨어로 빠르게 끝나지만 그 결과를 화면에 합성하는 소프트웨어 오버레이 경로가 병목이 되어 프레젠테이션이 밀리고, 그 결과가 jitterBufferDelay 상승(재생이 안 되니 버퍼에 계속 쌓임)으로 나타난다"는 쪽이 증거와 더 잘 맞음 — 디코드 자체가 아니라 "디코드된 프레임을 화면에 올리는" 프레젠테이션 단계가 약한 GPU/드라이버 조합(소프트웨어 오버레이)인 것이 실제 병목일 가능성.
- 다음 확인 필요(여전히 미수정): `chrome://media-internals`에서 증상 재현 시점에 프레임 드롭/디코더 지연이 실제로 발생하는지, 그리고 그 시각이 GPU 프로세스 로그의 `ProduceOverlay`/`ProduceSkia` 에러 시각과 겹치는지 대조. 겹치면 프레젠테이션(오버레이/컴포지팅) 병목 가설이 확정됨.

**적용된 수정 — bufferMs 포화 시 프로액티브 재연결 (2026-07-20)**: 정확한 근본 원인(디코드 vs 프레젠테이션 병목)은 `chrome://media-internals` 대조로 아직 확정되지 않았지만, 원인과 무관하게 유효한 개선을 먼저 적용: `jitterTargetMs`가 이미 `JITTER_TARGET_MAX_MS`(1000ms) 상한까지 escalation된 상태에서 `bufferMs`가 여전히 `BUFFER_MS_BAD`(300ms) 이상이면, 더 이상 escalation으로 얻을 수 있는 여지가 없다는 뜻 — 브라우저에게 요청할 수 있는 버퍼를 이미 최대로 요청했는데도 따라가지 못하고 있다는 신호이므로, 실제 fps 정지가 벌어지는 20~25초짜리 프레임/바이트 스톨 워치독을 기다리지 않고 바로 `staleReconnect()`를 트리거하도록 변경.
- `useWebRTC.ts`에 `BUFFER_SATURATED_TICKS_LIMIT=2`(단발성 스파이크에 반응하지 않도록 연속 2틱=10초 요구) 및 `bufferSaturatedTicks` 카운터 추가 — jitterBufferTarget escalation 블록(`!document.hidden` 가드 내부)에서 `jitterTargetMs >= JITTER_TARGET_MAX_MS && bufferMs >= BUFFER_MS_BAD`일 때만 증가, 그 외에는 0으로 리셋.
- 최종 스톨 판정 if/else 체인에 `bufferSaturatedTicks >= BUFFER_SATURATED_TICKS_LIMIT` 분기를 `frameStalled`보다 먼저(더 이른 신호이므로) 추가 — 동일한 `staleReconnect()`를 재사용해 기존 backoff/retryCount 상한 로직을 그대로 상속.
- `handleVisibilityChange`(탭 재활성화 시 리셋 목록)에도 `bufferSaturatedTicks = 0` 추가 — 백그라운드 탭에서 인위적으로 부풀려진 bufferMs가 포그라운드 복귀 직후 오탐 재연결을 유발하지 않도록.
- 효과: 사용자가 겪던 "Buffer가 980ms까지 오르며 화면이 얼어붙어 있다가 한참 후에야 재연결" 패턴이, 버퍼가 포화되는 즉시(대략 10초 이내) 짧은 재연결로 대체됨 — 화면이 멈춰있는 체감 시간이 크게 줄어듦. `npx tsc --noEmit`/`npm run build` 클린 통과 확인.

---

## 7. 백엔드 선택 기준 비교

| 항목 | Ingest-Daemon | FFmpeg *(레거시)* | GStreamer | PyAV (인라인) |
|---|---|---|---|---|
| **CPU 효율** | 우수 (IDR 대기, 최적 스킵) | 보통 | 우수 (낮은 레이턴시) | 보통 |
| **GPU 하드웨어 가속** | CUDA (Python PyAV) | `-hwaccel cuda` (별도 빌드) | nvdec / VA-API 자동 감지 | CUDA (Python 생태계) |
| **의존성** | Python 3 + av + Pillow | `ffmpeg` 바이너리 | GStreamer + 다수 플러그인 | Python 3 + av + Pillow |
| **단일 RTSP 연결** | ✅ (MediaMTX loopback) | ❌ (직접 연결) | ❌ (직접 연결) | ❌ (직접 연결) |
| **WebRTC 통합** | ✅ (MediaMTX WHEP) | ❌ | ❌ | ❌ |
| **B-프레임 처리** | ✅ (모든 패킷 디코딩) | ✅ | ✅ | ✅ |
| **자동 재연결** | ✅ (IDR 키프레임 대기) | ✅ 1초 간격 | ✅ 1초 간격 | ✅ 1초 간격 |
| **설치 복잡도** | 낮음 (pip) | 낮음 | 중간 | 낮음 (pip) |
| **추천 환경** | **모든 환경 (기본값)** | 레거시 호환 | 저레이턴시 GPU | 레거시 Python 통합 |

### 운영 환경별 추천 백엔드

| 환경 | 추천 백엔드 | 이유 |
|---|---|---|
| **모든 신규 배포** | `ingest-daemon` | 단일 RTSP 연결, WebRTC 통합, B-프레임 처리 |
| NVIDIA GPU 서버 (레거시) | `gstreamer` (nvdec) | 하드웨어 디코딩 (ingest-daemon 전환 권장) |
| Docker 컨테이너 (레거시) | `ffmpeg` | 단순 의존성 (ingest-daemon 전환 권장) |

---

## 8. 이벤트 인터페이스 규격

모든 백엔드 클래스는 `EventEmitter`를 상속하며 동일한 이벤트/메서드 규격을 구현합니다.

### 7.1 이벤트

| 이벤트 | 페이로드 타입 | 발생 시점 |
|---|---|---|
| `frame` | `Buffer` (JPEG) | 새 프레임 수신 완료 시 |
| `started` | `{ cameraId: string, cmdline: string }` | 자식 프로세스 기동 직후 |
| `reconnecting` | `{ cameraId: string, attempt: number, delay: number }` | 자식 프로세스 종료 후 재시도 예약 시 |
| `stats` | `{ cameraId: string, frameCount: number }` | 100 프레임마다 |
| `warn` | `{ cameraId: string, message: string }` | stderr 경고 라인 수신 시 |
| `error` | `Error` | 복구 불가 오류 (바이너리 미설치 등) |

### 8.2 메서드

| 메서드 | 설명 |
|---|---|
| `start()` | 캡처 시작. 이미 실행 중이면 무시 (idempotent) |
| `stop()` | 캡처 중지, 자식 프로세스 SIGKILL (ingest-daemon 백엔드는 데몬을 종료하지 않음) |
| `injectFrame(jpegBuffer)` | **(ingest-daemon 전용)** 외부 데몬에서 프레임 주입 → `frame` 이벤트 발생 |

### 8.3 생성자 공통 인수

```javascript
new BackendCapture(cameraId, rtspUrl, opts)
// opts.fps   (number, 기본 10)  — 목표 캡처 프레임레이트
// opts.width (number, 기본 640) — 출력 영상 너비 (픽셀)
```

### 8.4 JPEG 프레임 파싱 (공통 로직)

모든 백엔드는 동일한 SOI/EOI 마커 기반 파싱 로직을 사용합니다.

```
stdout: [FF D8 FF ... FF D9][FF D8 FF ... FF D9][FF D8 FF ... (불완전)]
         ← 프레임 1 ─────→  ← 프레임 2 ─────→  ← 버퍼에 보관 →
```

---

## 9. 환경변수 참조

| 변수 | 기본값 | 관련 백엔드 | 설명 |
|---|---|---|---|
| `CAPTURE_BACKEND` | `ingest-daemon` | 전체 | 캡처 백엔드: `ingest-daemon` / `ffmpeg` / `gstreamer` / `pyav` |
| `WEBRTC_ENGINE` | `mediamtx` | 전체 | WebRTC 엔진: `mediamtx` (기본·권장) / `mediasoup` |
| `INGEST_DAEMON_BIN` | `../ingest-daemon/ingest_daemon.py` | ingest-daemon | Python 데몬 스크립트 경로 (server/ 기준 상대경로) |
| `INGEST_DAEMON_ADDR` | `:7070` | ingest-daemon | 데몬 HTTP 서버 bind 주소 |
| `INGEST_DAEMON_URL` | `http://127.0.0.1:7070` | ingest-daemon | Node.js → 데몬 요청 URL |
| `PYAV_PYTHON_BIN` | `python3` | ingest-daemon, pyav | Python 바이너리 절대경로 (예: `/home/user/.local/bin/python3`) |
| `GSTREAMER_HW_ACCEL` | `auto` | gstreamer | GStreamer 하드웨어 가속 모드: `auto` / `nvdec` / `vaapi` / `software` |
| `PYAV_HW_ACCEL` | `none` | pyav | PyAV 하드웨어 가속 (인라인 사이드카): `none` / `cuda` / `videotoolbox` |
| `MAX_PIPELINES` | `0` | 전체 | 동시 캡처 파이프라인 최대 수 (0=무제한) |
| `AI_MAX_WIDTH` | `960` | streaming (Node.js) | (§9.1, §9.2) streaming 서버가 remote analysis 서버로 전송하는 다운스케일 사본의 최대 가로 픽셀 — analysis 서버 자신의 SNAPSHOT_MAX_DIMENSION 이상으로 설정할 것 |
| `JPEG_QUALITY` | `85` | ingest-daemon | AI JPEG 인코딩 품질(1-95) — 항상 원본(native) 해상도로 인코딩 |

### 9.1 AI 프레임 해상도와 `detectionSnapshots` crop 화질

`ingest_daemon.py`의 AI 스레드(§6.2 다이어그램, `push_jpeg()`)는 프레임을 **원본(native, 디코딩된 그대로) 해상도로** JPEG 인코딩하여 Node.js `/api/internal/frame/:cameraId`로 전송합니다 — 리사이즈하지 않습니다. 이 원본 JPEG 버퍼가 `pipelineManager.js`의 `capture.on('frame', jpegBuffer)`에서 유일한 소스가 되며, 서버 모드별로 다르게 소비됩니다:

- **combined / analysis 모드(로컬 추론)**: `detection.js`가 이 원본 버퍼를 직접 받아 내부적으로 640×640 letterbox 재조정 후 추론합니다. bbox는 `_postprocess()`가 원본 좌표계(`origW`/`origH`)로 스케일-백하므로, `detectionSnapshots` crop(`snapshotService.cropJpeg()`)도 항상 원본 해상도에서 정확히 잘라냅니다. **추가 코드 없이 자동으로 고화질 crop이 보장됩니다.**
- **streaming 모드(원격 analysis 서버 위임)**: `pipelineManager.js`가 원본 버퍼를 그대로 보관하되(`ctx._pendingFrame.buf`), remote analysis 서버로 보내기 **직전에만** `sharp`로 `AI_MAX_WIDTH`(기본 640) 폭까지 다운스케일한 **별도 사본**을 만들어 전송합니다(`_downscaleForAnalysis()`). analysis 서버가 반환하는 bbox는 이 다운스케일 사본의 좌표계(`result.frameWidth`/`result.frameHeight`)를 기준으로 하므로, `_processRemoteResult()`가 `_scaleBbox()`로 원본 좌표계로 보정한 뒤 원본 버퍼에서 crop합니다.

이 설계로 두 목표를 동시에 달성합니다: (1) remote analysis 서버로 가는 HTTP 페이로드/디코드 부하는 `AI_MAX_WIDTH`로 계속 작게 유지되고, (2) `detectionSnapshots` crop은 항상 원본 해상도에서 추출되어 `AI_MAX_WIDTH` 설정과 무관하게 고화질입니다.

**`AI_MAX_WIDTH`를 낮추거나 높여도 *이 streaming 서버 자신의* crop 화질에는 영향이 없습니다** — 이 값은 오직 analysis 서버로 보내는 사본의 네트워크/CPU 부하만 조절합니다. 이 서버가 저장하는 crop 화질은 카메라의 실제 해상도(ingest-daemon이 그대로 전달)와 `SNAPSHOT_MAX_DIMENSION`/`SNAPSHOT_JPEG_QUALITY`(`docs/design/Design_Detection_Snapshot_Search.md` §14)에만 좌우됩니다. **단, remote analysis 서버 자신이 저장하는 crop은 예외입니다 — §9.2 참조.**

**부하 참고:** ingest-daemon → Node.js 홉은 이제 원본 해상도를 항상 전송하므로 카메라 해상도가 높을수록(예: 4K) 이 홉의 CPU(JPEG 인코딩/디코드)·네트워크가 증가합니다. `!ctx.useWebRTC` 카메라(WebRTC 미사용, 브라우저에 raw JPEG 프레임 직접 전송)의 경우 브라우저로 가는 페이로드도 함께 커집니다. GPU/ONNX 추론 시간 자체는 영향받지 않습니다(입력 텐서가 항상 640×640으로 고정).

`.env` 설정 예시:

```bash
# Ingest-Daemon + MediaMTX WebRTC (기본 · 권장)
CAPTURE_BACKEND=ingest-daemon
WEBRTC_ENGINE=mediamtx
PYAV_PYTHON_BIN=/home/user/.local/bin/python3
INGEST_DAEMON_BIN=../ingest-daemon/ingest_daemon.py
INGEST_DAEMON_ADDR=:7070

# GStreamer (NVIDIA GPU, 레거시)
CAPTURE_BACKEND=gstreamer
WEBRTC_ENGINE=mediamtx
GSTREAMER_HW_ACCEL=nvdec

# FFmpeg (레거시 호환)
CAPTURE_BACKEND=ffmpeg
WEBRTC_ENGINE=mediamtx
```

### 9.2 예외: remote analysis 서버 자신의 `detectionSnapshots` — `AI_MAX_WIDTH`에 해상도가 그대로 제한됨

§9.1의 "AI_MAX_WIDTH는 crop 화질에 영향 없음" 결론은 **streaming 서버 자신**이 저장하는 crop(`_processRemoteResult()`, 원본 버퍼에서 추출)에만 해당합니다. 순수 `SERVER_MODE=analysis` 서버(카메라 없이 HTTP로 프레임을 위임받는 구성, `docs/ops/Distributed_AI_Pipeline_Setup.md`)는 자신의 Dashboard(`AnalysisServerDashboard.tsx`)에서도 crop을 보여주기 위해 `analysisApi.js`의 `POST /frame` 핸들러에서 **독자적으로** `detectionSnapshots`를 저장합니다. 이 경로가 크롭하는 소스는 그 요청의 `jpegBuffer` — 즉 streaming 서버가 `_downscaleForAnalysis()`로 `AI_MAX_WIDTH` 폭까지 이미 축소해서 보낸 바로 그 사본입니다. analysis 서버는 native 해상도 버퍼를 애초에 가지고 있지 않으므로, 이 crop의 최대 해상도는 **항상 `min(AI_MAX_WIDTH, 카메라 실제 해상도)`로 상한이 걸립니다.**

**증상:** analysis 서버의 `SNAPSHOT_MAX_DIMENSION`을 720/1080 등으로 올려도, 페어링된 streaming 서버의 `AI_MAX_WIDTH`가 더 낮으면(예: 기본값 640이던 구버전 배포) crop 해상도가 그 값에서 더 이상 올라가지 않습니다 — analysis 서버 관리자 입장에서는 자신의 설정이 무시되는 것처럼 보입니다.

**해결:** streaming 서버의 `AI_MAX_WIDTH`를 페어링된 analysis 서버(들) 중 가장 큰 `SNAPSHOT_MAX_DIMENSION` 이상으로 설정합니다. 두 값이 서로 다른 서버(종종 다른 관리자)의 `.env`에 있으므로 자동으로 동기화되지 않습니다 — 배포 시 수동으로 맞춰야 합니다. 기본값을 640→960으로 상향해 일반적인 `SNAPSHOT_MAX_DIMENSION`(640~720) 대비 여유를 두었습니다(`server/.env.example`, `.env.streaming.example`, `.env.analysis.example`).

이 값을 올리면 streaming↔analysis 간 네트워크/디코드 부하가 늘어나지만(§9.1 "부하 참고" 동일 트레이드오프), YOLO 추론 자체는 어떤 입력 해상도든 640×640 letterbox로 처리되므로 감지 정확도에는 영향이 없습니다.

---

## 10. 오류 처리 및 재연결

모든 백엔드는 동일한 재연결 정책을 따릅니다.

### 10.1 재연결 정책

| 상황 | 동작 |
|---|---|
| 자식 프로세스 정상 종료 (`code=0`) | 1초 후 재연결 |
| 자식 프로세스 비정상 종료 (`code≠0`) | 1초 후 재연결 |
| SIGKILL | 재연결 (단, `stop()` 호출 후면 중단) |
| `ENOENT` (바이너리 미설치) | 즉시 중단, `error` 이벤트 발생 |
| PyAV 패키지 미설치 | `start()` 호출 즉시 `error` 이벤트 발생 |

### 10.2 연결 성공 판단 기준

첫 번째 stdout 데이터(`_onData()`) 수신 시 `_connected = true`로 전환하고 재시도 카운터를 초기화합니다.
단순 프로세스 기동이 아니라 **실제 프레임 수신**으로 연결 성공을 판단합니다.

### 10.3 백엔드별 미설치 탐지

```javascript
// FFmpeg
if (err.code === 'ENOENT') {
  this.emit('error', new Error('ffmpeg not found. Install ffmpeg to enable RTSP capture.'));
}

// GStreamer
if (err.code === 'ENOENT') {
  this.emit('error', new Error('gst-launch-1.0 not found. Install GStreamer to use gstreamer backend.'));
}

// PyAV
if (!PYAV_AVAILABLE) {
  this.emit('error', new Error('Python/PyAV not available. Install: pip3 install av Pillow'));
}
```

### 10.4 카메라 삭제 시 ingest-daemon 연결 해제 신뢰성 (2026-07-02)

`DELETE /api/cameras/:id` → `pipelineManager.stopCamera()`는 `CAPTURE_BACKEND=ingest-daemon`일 때 ingest-daemon에 `DELETE /cameras/:id`를 보내 해당 카메라 세션(재연결 루프 포함)을 중지시킵니다. 이 호출이 실패하면 ingest-daemon은 삭제된 카메라를 계속 재연결 시도합니다 — 운영자가 보기엔 "카메라를 삭제했는데 Ingest가 계속 연결을 시도"하는 것으로 나타납니다.

**이전 결함**: `_ingestRemoveCamera()`(`pipelineManager.js`)와 `_ingestDelete()`(`webrtc/mediasoupEngine.js`, mediasoup 모드에서 `removeCameraStream()`이 호출) 둘 다 실패를 완전히 삼켰습니다(`catch(() => {})`/`req.on('error', () => resolve(0))`) — 재시도도 없고 로그도 없어서, 네트워크 순간 장애나 ingest-daemon이 일시적으로 바쁜 경우 등 어떤 이유로든 DELETE가 실패하면 아무 흔적도 남기지 않고 ingest-daemon에는 "좀비" 세션이 남아 무한히 재연결을 시도했습니다. `stopCamera()`도 이 호출들을 fire-and-forget으로 던지고 기다리지 않았습니다.

**수정**:
- `_ingestRemoveCamera()`가 실패 시 500ms 후 1회 재시도하고, 최종 실패 시 `console.warn`으로 로그를 남김 (`[PipelineManager][<id>] ingest-daemon DELETE ... failed after N attempts`)
- `mediasoupEngine.js`의 `_ingestDelete()`도 비-2xx 응답/에러를 `console.warn`으로 로그
- `stopCamera()`가 `mediamtxManager.removeCameraPath()` / `getWebRTCEngine().removeCameraStream()` / `_ingestRemoveCamera()`를 `Promise.allSettled()`로 **await** — `DELETE /api/cameras/:id`의 API 응답이 실제로 ingest-daemon 정리 시도(재시도 포함)가 끝난 뒤에 반환됨. 각 정리 작업은 내부에서 개별적으로 실패를 로그하므로, 하나가 실패해도 다른 정리 작업이나 로그를 가리지 않음
- WEBRTC_ENGINE=mediasoup + CAPTURE_BACKEND=ingest-daemon 조합에서는 `removeCameraStream()`(mediasoupEngine 경유)과 `_ingestRemoveCamera()`(pipelineManager 직접) 양쪽에서 같은 cameraId로 중복 DELETE가 나가는 것은 의도된 이중 안전장치 — 한쪽이 실패해도 다른 쪽이 정리를 시도함 (두 번째 시도는 `found: false`로 조용히 성공 처리됨)

**진단**: 여전히 재연결이 관찰되면 ingest-daemon 자체 로그(`GET /admin/logs/recent?source=ingest`)에서 `"Camera removed: <id> (found=<bool>)"` 라인을 확인 — `found=false`면 DELETE 요청 자체는 도달했지만 해당 id로 등록된 세션이 없었다는 뜻(등록 시점의 id 불일치 가능성), 라인 자체가 없으면 요청이 ingest-daemon에 전혀 도달하지 못한 것(네트워크/포트 문제).

---

## 11. ingest-daemon 정상 종료 (Graceful Shutdown)

서버 종료 시 ingest-daemon은 SIGINT를 수신하고 `main()`의 `except KeyboardInterrupt` 블록으로 진입합니다.

### 11.1 종료 시퀀스

```
서버 종료
  ↓
MediaMTX 종료 (RTSP 127.0.0.1:8554 불응)
  ↓
ingest-daemon SIGINT 수신 → KeyboardInterrupt → finally
  ↓
_manager.stop_all()  ←─── 2-phase 구조
  ├── Phase 1: 모든 CameraSession._signal_stop() (동시 실행)
  │     · self._stop.set()           ← 모든 스레드 루프에 즉시 종료 신호
  │     · self._push_executor.shutdown(wait=False)
  ↓
  └── Phase 2: 모든 CameraSession._join_threads(timeout=3) (순차 대기)
        · t.join(timeout=3) — KeyboardInterrupt 수신 시 무시
server.server_close()
log.info("Ingest daemon stopped")
```

### 11.2 2-phase 설계 이유

| 문제 | 원인 | 해결 |
|---|---|---|
| `KeyboardInterrupt` 스택 트레이스 | `t.join()` 내부 `_wait_for_tstate_lock`에서 두 번째 SIGINT | `_join_threads()`에서 `except KeyboardInterrupt: pass` |
| Connection refused 경고 스팸 | 세션 A join 대기 중 세션 B,C,D가 `_stop` 미설정 상태로 연결 재시도 | Phase 1에서 **모든** 세션에 `_stop.set()` 선행 → Phase 2에서 join |
| `stop_all()` 자체의 SIGINT | 두 번째 SIGINT가 `stop_all()` 실행 중 도착 | `main()` finally에서 `try/except KeyboardInterrupt` 감싸기 |

### 11.3 스레드 루프 종료 흐름

모든 루프(`_ai_loop`, `_video_rtp_loop`, `_audio_rtp_loop`, `_app_rtp_loop`)는 동일 패턴을 따릅니다:

```python
while not self._stop.is_set():
    try:
        self._xxx_ingest_once()   # 블로킹 PyAV open/demux
    except Exception as exc:
        if self._stop.is_set():   # stop 신호 후 예외 → 조용히 종료
            break
        log.warning(...)          # 실제 오류만 로그
        self._stop.wait(retry_delay)  # stop 신호 오면 즉시 깨어남
```

`_stop.wait(retry_delay)`: Python `threading.Event.wait(timeout)`는 `_stop`이 set되는 순간 즉시 반환하므로 retry 지연 없이 빠르게 종료됩니다.

---

## 12. App RTP 안전 타임아웃 — `read_timeout` (`AVFormatContext.io_timeout`)

### 12.1 배경 — App RTP watchdog segfault

`_Watchdog`은 AI/Video/Audio 루프에서 h264 등 알려진 코덱에 대해 안전하게 동작합니다. 그러나 App RTP (ONVIF 메타데이터, `codec=unknown` 데이터 스트림)에서는:

1. 5초 무패킷 → watchdog background thread → `container.close()` 호출
2. `inp.demux(ds)` 실행 중인 app_rtp thread와 **cross-thread close**
3. `codec=unknown` 데이터 트랙은 libav가 close() 시 내부 상태를 정리 못함 → **segfault**
4. 전체 Python 프로세스 종료 → 모든 카메라 RTSP 세션 동시 끊김

### 12.2 해결책 — `inp.read_timeout`

```python
# APP_RTP_READ_TIMEOUT 기본값 60s (env: APP_RTP_READ_TIMEOUT)
# ONVIF 메타데이터는 이벤트 사이 간격이 수십 초 이상이므로 5s watchdog은 과민
inp = av.open(self.rtsp_url, options=_RTSP_OPTIONS)
inp.read_timeout = int(APP_RTP_READ_TIMEOUT * 1_000_000)  # μs 단위
```

`read_timeout`은 `AVFormatContext.io_timeout`에 매핑됩니다. libav가 각 블로킹 demux 호출마다 C 레벨에서 타임아웃을 체크하고, 초과 시 `av.AVError`를 발생시킵니다. **완전 thread-safe** — background thread가 container를 닫지 않습니다.

| | `_Watchdog` + `container.close()` | `read_timeout` |
|---|---|---|
| 스레드 안전성 | ❌ cross-thread close (codec=unknown에서 segfault) | ✅ libav 내부 처리 |
| ONVIF 메타데이터 적합성 | ❌ 5s 타임아웃 — 이벤트 간격보다 짧음 | ✅ 60s 타임아웃 |
| AI/Video/Audio | ✅ 동일 Watchdog 유지 | — |

### 6.13 mediasoup H.264 payload type 충돌 — `framesDecoded=0` 근본 원인 (2026-07-16)

이전(1.12~1.16) 수정으로 바이트/패킷은 Producer→Consumer로 정상 도달했지만(`videoScore=10`, `bytesReceived>0`), 브라우저의 `RTCPeerConnection.getStats()`는 모든 카메라에서 `framesReceived=0`, `framesDecoded=0`, `jitterBufferEmittedCount=0`으로 고정 — SRTP 전송은 성공했지만 지터 버퍼가 프레임을 단 한 번도 조립하지 못하는, 디코드 이전 단계의 실패였다.

**근본 원인**: 라우터(`_router.createRouter({mediaCodecs:...})`)의 H.264 `preferredPayloadType`이 `109`로 고정되어 있었는데, 이는 과거 세션에서 "Edge가 PT=109를 H264로 쓴다"고 오인해 채택한 값이었다. Chrome(및 Chromium 기반 Edge로 추정)의 실제 오퍼 SDP를 직접 파싱하면: `PT=108 → H264(pm=1, 42e01f)`가 진짜 1차 코덱이고, `PT=109 → rtx apt=108`(PT 108의 재전송 래퍼)이다. mediasoup 라우터가 PT=109로 H.264 본체를 응답하면, 브라우저는 들어오는 패킷을 "PT 108의 재전송"으로 잘못 해석해 지터 버퍼가 프레임을 조립하지 않는다 — bytesReceived는 전송 계층에서 집계되므로 정상으로 보이지만, framesReceived/framesDecoded는 영구히 0에 머문다.

`_parseOffer()`/`_buildBrowserRtpCapabilities()`가 브라우저별로 PT를 동적으로 맞추려 시도했지만, `mediasoup/node/lib/ortc.js`의 `getConsumableRtpParameters()`를 직접 확인한 결과 Consumer가 실제 전송하는 PT는 **Producer 생성 시점의 라우터 `preferredPayloadType`으로 고정**되며, `transport.consume()`에 매번 전달하는 `remoteRtpCapabilities`의 `preferredPayloadType`은 코덱 매칭(필터링) 용도로만 쓰이고 실제 전송 PT에는 전혀 반영되지 않는다 — 즉 동적 PT 매핑 코드는 실질적으로 죽은 코드였다.

**수정**: 라우터·Producer의 H.264 `preferredPayloadType`을 `109`→`108`(Chrome이 순수 H.264에 실제로 배정하는, 어떤 코덱의 RTX apt= 대상도 아닌 값)로 변경. Edge가 Chromium 기반으로 코덱 열거 순서를 공유한다는 점에서 기존 "Edge=109" 판단 자체가 Chrome과 동일한 RTX 항목 오독이었을 가능성이 높다고 결론.

**검증**: 실카메라(`TNO-C3020TRA`, 768×576)에서 WHEP+headless Chrome+`getStats()` 48초 관측 — `framesDecoded` 209→1411 (프레임 드롭 0, keyFramesDecoded 4→24, ≈30.05fps로 목표치 근접). TID-A800(`9c02a7e1`, 2560×1920)도 완전 연결 불가(503)에서 실제 프레임 디코드 성공으로 전환 확인.

부수적으로 `getProducerStats()`(`GET /api/webrtc/monitor`)가 `webrtcVideoOnly=true`(§6.7 `Camera.webrtcVideoOnly`) 카메라의 `audioProducer`/`audioPlain`이 `null`인 경우 옵셔널 체이닝이 `.closed` 프로퍼티에만 적용되고 실제 메서드 호출부에는 적용되지 않아 `Cannot read properties of null (reading 'getStats')`로 매 폴링마다 예외가 발생하던 결함도 함께 발견·수정.

**미해결**: TID-A800 2대(`9c02a7e1`/`43e8ec94`)에 `webrtcVideoOnly=true`를 적용해도 videoBytesRx가 여전히 ~45초 주기로 정체(§6.7의 "동시 RTSP 세션 한계" 가설로는 완전히 설명되지 않음 — 세션을 최소치로 줄인 상태에서도 재현). 5MP(2560×1920) 고해상도 스트림의 카메라측 인코더 버퍼링/네트워크 대역폭 한계일 가능성 — 후속 조사 필요.

---

### 6.14 프레임 워치독 재시도 폭풍 — backoff/jitter 부재로 인한 함대 전체 장애 (2026-07-16)

§6.13 배포 직후, 여러 카메라(192.168.214.38/39/40)의 RTSP 포트가 동시에 응답 불능 상태가 되면서 `ingest-daemon`의 `POST /cameras` setup 큐가 포화되어 `/health`조차 응답하지 않는 상태(커널 accept 큐 SYN_SENT 백로그로 `lsof` 확인)가 발생, 6분 이상 함대 전체 재생 불가로 이어졌다.

**근본 원인**: `pipelineManager.js`의 프레임 워치독(`FRAME_STALL_MS=45s`, 8초 tick)이 재시작 시도의 성공/실패와 무관하게 항상 `ctx.lastFrameAt = Date.now()`로 리셋 — 즉 재등록이 실패해도 정확히 45초(+최대 8초 tick 지연) 후 동일 카메라에 대해 재시도하는 구조로, backoff이 전혀 없었다. 문제 카메라 몇 대의 재시도가 이미 포화된 `ingest-daemon`에 계속 새 setup 요청을 쌓으면서, **원래 멀쩡했던 카메라들까지** 같은 ~48-56초 주기로 동시에 재등록 실패를 겪기 시작 — 함대 전체가 자기 자신의 컨트롤 플레인을 스스로 DoS하는 공진(resonance) 상태에 빠져, 외부 개입 없이는 절대 스스로 회복되지 않았다(재시도가 곧 장애의 원인이므로).

**수정**: 프레임 워치독에 연속 실패 카운터(`ctx._watchdogFailCount`)와 지수 백오프(실패 1회당 +15s, 최대 240s cap) + 랜덤 지터(0-5s)를 추가 — 재등록 성공 시 카운터 리셋, 실패 시 다음 재시도를 `Date.now() + backoffMs + jitterMs`만큼 미룸(`ctx.lastFrameAt`을 미래 시각으로 설정해 기존 `stalledMs > FRAME_STALL_MS` 게이트를 그대로 재사용). 만성적으로 실패하는 카메라는 최대 ~4분 45초까지 재시도 간격이 벌어지고, 동시에 시작된 여러 카메라의 재시도가 지터로 위상이 어긋나 lockstep이 깨진다.

**검증**: 서버 전체 재시작(백오프 코드 반영) 후 9개 카메라 전부 프레임 재유입 확인, WHEP+`getStats()` 48초 관측으로 실제 재생 확인(1398프레임, 드롭 0, 정확히 30.0fps).

**교훈**: 자동 재시도 로직은 반드시 실패 시 backoff을 가져야 하며, 특히 여러 인스턴스가 같은 공유 자원(이 경우 `ingest-daemon`의 단일 HTTP 컨트롤 플레인)에 재시도할 때는 지터로 동기화를 깨야 한다 — 이번 사고는 원인 카메라 자체보다 "재시도 storm이 재시도 storm을 낳는" 구조적 결함이 실제 장애 지속 시간(6분+)을 지배했다.

---

### 6.15 `webrtcVideoOnly` 카메라의 reject된 audio/data 섹션 `a=bundle-only` 모순 — "SDP without DTLS fingerprint" (2026-07-16)

`Camera.webrtcVideoOnly=true`(§6.7) 카메라에서 WHEP negotiate가 매번 `Called with SDP without DTLS fingerprint`로 실패 — 비디오 섹션의 fingerprint 라인 자체는 바이트 단위로 검증해도 완전히 유효했다. 근본 원인: audio/data Consumer가 없어 reject하는 섹션(`m=audio 0 ... a=inactive`)에 `a=bundle-only`를 선언하면서도, `a=group:BUNDLE`에는 실제 Consumer가 있는 mid만 나열되어 이 reject 섹션이 그룹에서 빠져 있는 자기모순 SDP였음(예: `a=group:BUNDLE 0`인데 mid 1이 `a=bundle-only` 주장) — Chrome이 이 불일치로 BUNDLE 태그 해석에 실패해 전체 답변을 "fingerprint 없음"으로 잘못 보고. `webrtcVideoOnly`가 아닌 카메라(모든 Consumer 존재, 모든 mid가 그룹에 포함)에서는 재현되지 않아 특정.

**수정**: reject 섹션에서 `a=bundle-only` 제거(포트 0 + `a=inactive`만으로 reject 의미 충분, RFC상 불필요한 속성). `mediasoupEngine.js` `_buildAnswer()`의 audio/data reject 블록 두 곳 수정.

**검증**: TID-A800 Ch2(`webrtcVideoOnly=true`)에서 `setRemoteDescription` 성공, framesDecoded 0→393(48초, 드롭 0) 확인.

### 6.16 YouTube 카메라 mediasoup WebRTC 재활성화 (2026-07-16)

`pipelineManager.js`는 YouTube 카메라를 `!isYouTube` 조건으로 mediasoup 등록(`getWebRTCEngine().addCameraStream()`) 대상에서 원천 배제해 왔다(사유 주석: "MediaMTX RTSP URL에 mediasoup RTP fan-out을 걸면 connection-refused 재시도 루프가 생김"). 이 판단은 §6.8의 단일-RTSP-연결 재설계 **이전** 시점의 것으로, 현재는 YouTube 카메라의 `captureUrl`이 이미 AI-only ingestion이 매번 성공적으로 여는 것과 동일한 MediaMTX 루프백(`rtsp://127.0.0.1:8554/yt/<id>`)이라 mediasoup용으로 별도 연결을 열 이유가 없음을 확인, `!isYouTube` 게이트 제거.

**검증**: 재활성화 후 mediasoup 등록 즉시 성공(`Camera added: yt-a372f [AI+vRTP+aRTP+appRTP]`, AAC→Opus 자동 트랜스코딩 포함), 실제 WHEP 재생으로 실사용자 브라우저가 4MB+ 정상 수신 확인. 재시도 폭풍 재현 없음(§6.8 이후 아키텍처에서 우려가 해소됨을 뒷받침).

**미해결**: 이 YouTube 소스(1080p) 특정 세션에서 WHEP 재생이 처음 300프레임(~10초, 정상 디코딩) 후 `framesDecoded`가 정체되는 현상 관찰 — `bytesReceived`는 계속 증가하는데 `keyFramesDecoded`도 2에서 멈춤(추가 키프레임 요청/PLI 흐름 문제로 추정). 이 YouTube 스트림 자체가 테스트 중 URL 만료 자동복구 루프(404/403 반복, WebRTC와 무관한 기존 이슈)를 동시에 겪고 있어 두 현상이 얽혀 있을 가능성 — 후속 세션에서 독립적으로 재현·조사 필요.

---

### 6.17 RTX(재전송) 활성화 — 패킷 손실 시 재생 정지 구간 (2026-07-16)

WHEP 세션을 90초간 관찰한 결과, 특정 카메라(특히 2048×1536 이상 고해상도)에서 `nackCount`가 수백까지 치솟으면서 `framesDecoded`가 수 초~수십 초간 멈췄다 한꺼번에 따라잡는(burst) 패턴이 재현됨 — Web UI에서 "재생 멈추는 구간"으로 체감되는 현상과 일치. 원인은 라우터에 RTX 코덱 자체가 없고 Consumer에 `enableRtx: false`가 박혀 있어, 패킷이 하나라도 유실되면 재전송 없이 카메라 자체의 다음 예약된 키프레임까지 기다릴 수밖에 없었기 때문(Producer가 인코더 없는 순수 RTSP→RTP passthrough라 PLI/FIR로 즉석 키프레임을 받아낼 방법도 없음 — 90초 세션에서 `pliCount`가 계속 늘어도 아무 효과 없었음을 확인).

**1차 시도(실패)**: 라우터 `mediaCodecs`에 `video/rtx` 항목을 수동으로 추가했더니 `_ensureRouter()`가 매번 `media codec not supported [mimeType:video/rtx]`로 실패 — **전체 카메라의 mediasoup 등록이 전부 깨지는 회귀**를 일으킴. `mediasoup/node/lib/ortc.js`의 `generateRouterRtpCapabilities()`를 확인한 결과, RTX는 video 코덱마다 **자동 생성**되며 사용자가 `mediaCodecs`에 직접 선언하는 것은 애초에 지원되지 않음(정적 `supportedRtpCapabilities` 목록에 `video/rtx` 항목 자체가 없어 매칭 실패). 수동 항목 제거로 즉시 복구.

**2차 시도(비효과적, §6.13과 동일 클래스의 문제)**: 자동 생성에 맡기면 mediasoup 내부 `DynamicPayloadTypes` 고정 순서([100,101,...,127,96...99]에서 이미 점유된 108/111 제외)상 PT=100으로 배정됨 — Chrome 오퍼에서 PT=100은 VP9 슬롯이라 §6.13과 동일한 PT 어휘 충돌. 실측 결과 RTX를 꺼둔 것보다 오히려 **악화**(nackCount 303→525, 정지 구간 비중 거의 2배)됐음 — 재전송 패킷이 죽은 코덱 슬롯으로 가서 회수되지 않고 NACK만 계속 쌓임.

**3차 시도(수정)**: PT 100~107을 실제로는 절대 협상에 노출되지 않는 더미 오디오 코덱 8개(PCMU/PCMA/G722/iLBC/SILK×4)로 미리 소진시켜, H.264의 자동 생성 RTX가 정확히 PT=109(Chrome 실제 오퍼의 H264-RTX 슬롯과 동일)에 배정되도록 강제. 더미 코덱은 어떤 Producer도 사용하지 않으므로 `_buildAnswer()`가 실제 Consumer의 consumable 코덱만 직렬화하는 한 SDP에는 전혀 노출되지 않음.

**검증**: 회귀 없음(768×576 카메라는 90초간 프레임 2655개, 스톨/드롭/NACK 전부 0, RTX 적용 전과 동일하게 완벽). WHEP negotiate 연속 8/8 성공(§6.15/§6.16 수정과 합쳐 "새로고침해도 가끔 안 나옴" 문제 해소로 판단). **미해결**: 2048×1536 이상 고해상도 카메라는 PT를 정확히 맞춘 RTX 적용 후에도 여전히 상당한 정지 구간 재현 — 대역폭/인코더 한계일 가능성. 테스트 시점에 이 서버를 동시에 사용 중인 다른 Claude Code 세션이 9개 이상 확인됨(load average 7.86) — 관측된 손실이 이 애플리케이션 코드만의 문제가 아니라 공유 서버 부하와 얽혀 있을 가능성이 있어 후속 세션에서 부하가 낮은 시간대에 독립적으로 재확인 필요.

---

### 6.18 커널 UDP 수신 버퍼 오버플로우 — §6.17까지의 패킷 손실 근본 원인 (2026-07-16)

§6.17에서 RTX를 올바른 PT로 활성화한 뒤에도 고해상도 카메라(TID-A800 5MP, TNM-C2712T 3MP)는 여전히 심한 정지 구간(nackCount 수백)을 보였다. 실사용자 대시보드에서도 "영상은 안 나오는데 서버 쪽 Consumer는 수십 MB씩 정상 전송 중"인 채널이 다수 관찰되어, ICE 진단 패널(`iceStats`가 `null`로 하드코딩되어 있던 죽은 코드를 이번에 구현) 확인 결과 로컬망 경로(srflx↔host, 같은 192.168.214.x 서브넷) 위에서 실제로 6~16MB가 정상 수신되는데도 프레임이 전혀 디코딩되지 않는 극단적 사례가 확인됨 — 네트워크 대역폭이 아니라 "거의 모든 프레임이 최소 1패킷씩 유실"되는 양상.

**근본 원인 확정**: `cat /proc/net/snmp | grep Udp:`로 시스템 전체 UDP 통계를 확인한 결과 `RcvbufErrors`가 1000만 건을 넘어 있었다 — 커널 UDP 소켓 수신 버퍼(`net.core.rmem_default` 기본값 ~208KB)가 오버플로우되어 패킷을 조용히 버리고 있었던 것. 5MP H.264 키프레임 하나가 만들어내는 UDP 데이터그램 버스트가 208KB 버퍼를 손쉽게 넘침 — 이번 세션 내내 유일하게 무결점이었던 저해상도(768×576) 카메라와 정확히 대비되는 패턴(작은 키프레임 버스트는 기본 버퍼로도 충분). **localhost(ingest-daemon→mediasoup PlainTransport) 구간에서도 재현**되어, 원격 네트워크 품질과 무관한 순수 서버 내부 문제임을 확정.

**수정**: `mediasoupEngine.js`의 video/audio `PlainTransport` 생성 시 구버전 `listenIp`(버퍼 크기 옵션 없음) 대신 `listenInfo`(`protocol`, `ip`, `recvBufferSize` 포함)로 전환, `recvBufferSize: 8MB`(`net.core.rmem_max` 16MB 이내) 명시적 요청.

**검증**: TID-A800 Ch2 40초 관측 — nackCount 319→**0**, 프레임 안정적으로 계속 증가(636프레임, 드롭은 일부 있으나 재전송 요청 자체가 사라짐). TNM-C2712T Ch1 40초 관측 — 정지 구간 다수(0-90초 구간의 상당 부분)→**0회**, nackCount 517→**0**, 933프레임(≈23fps)로 사실상 실시간 재생 수준 회복. 이번 세션에서 추적해온 "패킷 손실로 인한 재생 정지" 계열 문제의 실질적 근본 원인으로 판단.

### 6.19 `<video>.play()`의 `NotAllowedError` 조용한 무시 — 정지된 프레임을 재생 중으로 오인 (2026-07-16)

§6.18 수정 이후 재생 자체는 정상화됐지만, Chrome DevTools의 Media 패널에서 특정 타일이 "Pause" 상태로 표시되는 것이 확인됨 — 실제로는 `<video>` 엘리먼트가 마지막으로 디코딩한 프레임을 계속 화면에 보여주기 때문에(정지된 video도 현재 프레임은 계속 렌더링), 타일 자체는 "영상처럼" 보이지만 실제로는 멈춰있는 상태를 육안으로 구분할 수 없었다.

**원인**: `useWebRTC.ts`가 `video.play().catch(_ignoreAbort)` 패턴을 3곳에서 사용했는데, `_ignoreAbort`가 `AbortError`(무해 — srcObject 재설정 등으로 이전 play() 요청이 superseded된 정상 케이스)뿐 아니라 **`NotAllowedError`(브라우저 자동재생 정책 차단)까지 동일하게 조용히 무시**하고 있었음. 타일 7개가 동시에 autoplay를 시도하는 페이지 로드/대량 재연결 시점에 일시적으로 정책 차단이 걸릴 수 있는데, 이 경우 아무 에러 로그도 없이 영원히 정지 상태로 남게 됨.

**수정**: `_attachAndPlay()` 헬퍼로 통일 — `NotAllowedError`만 별도로 감지해 500ms 후 1회 재시도(일시적 정책 차단은 부하가 가라앉으면 재시도 시 대부분 해소됨), 재시도도 실패하면 콘솔에 명확히 로그. `AbortError`는 기존과 동일하게 무해하므로 계속 무시.

### 6.20 클라이언트 프레임 스톨 재연결이 동기화되어 전체 타일이 함께 멈추던 문제 (2026-07-16)

§6.19까지 반영 후에도 실사용자 대시보드 콘솔 로그를 직접 확인한 결과, **카메라 7개 전부**가 "framesDecoded stuck ... reconnecting"을 반복하고 있었다 — 이번 세션 내내 격리 테스트에서 단 한 번도 문제가 없었던 저해상도 카메라(TNO-C3020TRA)조차 프레임 60개 디코딩 후 정확히 멈춰 재연결되는 것을 확인. 원인: 그리드 페이지의 타일 7개가 거의 동시에 마운트되어 각자의 프레임 스톨 워치독(§6.18에서 추가)이 고정된 임계값(20초)으로 거의 동시에 만료 — 여러 타일이 동시에 재협상(새 RTCPeerConnection, ICE, DTLS, 서버측 Consumer)을 시작하면 그 부하 자체가 방금까지 멀쩡하던 다른 타일의 디코딩까지 멈추게 만들어, 스톨→재연결→(다른 타일)스톨→재연결이 서로를 촉발하며 영원히 반복되는 자기강화 루프였음 — §6.14에서 서버측에 이미 확인·수정했던 것과 동일한 클래스의 문제가 클라이언트에도 있었던 것.

**수정**: `useWebRTC.ts`에 연결당 랜덤 지터(0-8초)를 `STALL_MS`/`FRAME_STALL_MS`에 추가해 타일 간 워치독 만료 시점을 분산시키고, 재연결 지연 시간에 `retryCount` 기반 증가 백오프(회당 +2초, 최대 +15초, §6.14의 서버측 백오프와 동일한 논리)를 추가 — 만성적으로 스톨되는 타일은 점점 더 느리게 재시도해 동시다발 재협상 폭풍을 방지.

### 6.21 mediasoup H.264 profile-level-id를 Level 4.0→5.1로 상향 (2026-07-16)

§6.20까지 반영해도 고해상도 카메라(TID-A800, TNM-C2712T Ch1)는 계속 검은 화면(오버레이만 렌더링)이었다. `ingest_daemon.py`가 실제 카메라 SPS에서 파싱한 profile-level-id를 확인한 결과 TID-A800/TNM-C2712T Ch1은 `640032`(Level 5.0)인데, mediasoup 라우터·Producer는 정적으로 `640028`(Level 4.0, MaxFS 8192 매크로블록)을 선언하고 있었음 — 실제 해상도(2560×1920=19200MB, 2048×1536=12288MB)가 선언된 레벨의 최대 프레임 크기를 훨씬 초과하는 규격 위반으로, 표준을 지키는 디코더가 이를 거부할 수 있는 상태였다(저해상도 카메라들은 전부 자체 매크로블록 수가 Level 4.0 이내라 문제가 드러나지 않았음 — 세션 내내 관측된 해상도 상관 패턴과 정확히 일치).

**수정**: Router `mediaCodecs`와 Producer `rtpParameters` 양쪽의 `profile-level-id`를 `640033`(Level 5.1, MaxFS 36864)으로 상향 — 현재 함대의 모든 카메라를 여유 있게 커버.

**검증**: TID-A800 Ch2 40초 관측 — 1066프레임(≈26.6fps), 스톨 2초(시작 구간)뿐. TNM-C2712T Ch1 40초 관측 — 1158프레임(≈29fps), 스톨 0회·NACK 0회·드롭 0회, 사실상 완전한 실시간 재생 회복.

### 6.22 그리드 타일+풀스크린 뷰 간 공유 세션의 스톨 감시 범위 누락 (2026-07-16)

§6.21까지 반영 후에도, 카메라를 풀스크린으로 열어둔 상태에서 WebRTC 영상이 마지막 프레임에 멈춘 채 AI 분석 오버레이(바운딩박스)만 계속 갱신되는 현상이 실사용자 환경에서 재현됨(감지 데이터는 Socket.IO로 별도 전달되어 비디오 디코드 상태와 무관하게 계속 흐름).

**원인**: `useWebRTC.ts`의 `sessionRegistry`는 같은 카메라를 보는 여러 컴포넌트(그리드 타일 + 풀스크린 뷰)가 RTCPeerConnection 하나를 공유하도록 설계되어 있는데, §6.18/§6.20에서 추가한 프레임 스톨 워치독과 `track.onended` 핸들러가 **연결을 최초로 만든 컴포넌트 인스턴스의 `cancelled` 플래그에만 묶여 있었음**. 그리드 타일이 연결을 만든 뒤 사용자가 풀스크린을 열면(그리드 타일이 화면에서 가려지며 언마운트될 수 있음) 최초 생성자의 effect cleanup이 실행되어 `cancelled=true`가 되고, 이 시점에 워치독의 `setInterval`과 `onended` 핸들러가 전부 조용히 중단됨 — 이후로는 실제로 스트림을 보고 있는 풀스크린 뷰(Case A로 기존 스트림을 재사용만 함)를 감시하는 주체가 아무도 남지 않아, 스톨이 발생해도 영원히 복구되지 않았음.

**수정**: 워치독의 인터벌 종료 조건을 컴포넌트 로컬 `cancelled`가 아니라 **`sessionRegistry.get(cameraId)?.pc === pc`(이 연결이 여전히 해당 카메라의 현재 활성 연결인지)** 로 변경해, 연결을 만든 컴포넌트가 언마운트돼도 다른 소비자가 남아있는 한 워치독이 계속 동작하도록 함. 재연결 액션도 로컬 `setState`/`setRetryCount` 대신 **공유 `stream`의 모든 트랙을 `stop()`** 하도록 변경 — 네이티브 `MediaStream` `inactive` 이벤트가 발생해, Case A(재사용 소비자)가 이미 구독 중이던 핸들러와 Case C(생성자) 자신에게 새로 추가한 동일 핸들러 양쪽에 자동으로 전파되어, 어느 컴포넌트가 최초 생성자였는지와 무관하게 현재 마운트된 모든 소비자가 각자 재협상을 트리거함.

---

### 6.23 등록 응답 유실 시 ingest-daemon 좀비 세션 (2026-07-20)

메인 서버 크래시 복구 구간(04:37~04:43)에서 카메라 삭제 API가 정상 처리된 후, ingest-daemon이 보고하는 카메라 수(`/health`의 `cameras`)가 DB의 실제 카메라 수보다 1개 많은 상태로 지속되는 현상이 발견됨.

**원인**: `_ingestRegisterCamera()`(`pipelineManager.js`)는 `POST /cameras` 호출이 `fetch` 레벨에서 실패(타임아웃·커넥션 리셋)하면 무조건 "등록 실패"로 간주해 `false`를 반환한다. 그러나 이 시점 ingest-daemon이 요청 자체는 정상적으로 처리해 내부적으로 카메라를 이미 등록해놓고, 그 **응답만** 네트워크 혼잡·데몬 자체 재시작 등으로 유실되는 경우가 있음이 로그로 확인됨(`cf24e5b4-8aa3-4d75-9bf8-ebd1bc88914b`, 2026-07-20 04:42:12 — register가 "fetch failed"로 실패 처리됐지만 daemon 쪽엔 실제로 등록되어 있었음). 등록 실패로 처리된 카메라는 DB에 저장되지 않으므로, 이후 어떤 재조정(reconcile) 경로도 이 ID를 알지 못해 `DELETE`를 호출할 방법이 없다 — daemon 내부에 영구적인 좀비 세션으로 남는다.

**수정**: `_ingestRegisterCamera()`의 catch 블록에서 실패를 로그로 남긴 직후, 동일한 `cameraId`로 `_ingestRemoveCamera()`(§10.4에서 이미 구현된 재시도 1회 + 로그 포함 DELETE 헬퍼)를 즉시 호출하도록 변경. `DELETE`는 daemon 쪽에 해당 ID가 없으면 `{ok:false}`를 반환할 뿐 오류가 아니므로(멱등), 실제로 등록이 실패했던 정상 케이스에서는 비용이 거의 없고, 등록은 성공했지만 응답만 유실된 케이스에서는 좀비 세션을 즉시 정리한다. 검증: 수동으로 `DELETE http://127.0.0.1:7070/cameras/cf24e5b4-...`를 호출해 daemon의 `cameras` 카운트가 5→4로 즉시 DB와 일치함을 확인, 이후 이 정리 로직을 register 실패 경로에 상시 편입.

---

### 12.3 스트림별 타임아웃 전략

| 스트림 | 방식 | 타임아웃 | 근거 |
|---|---|---|---|
| AI (JPEG), Video RTP, Audio RTP | `_Watchdog` + `container.close()` | `RTSP_READ_TIMEOUT=5s` | h264/opus — 연속 고빈도 스트림, cross-thread close 안전 |
| App RTP (ONVIF metadata) | `inp.read_timeout` | `APP_RTP_READ_TIMEOUT=60s` | codec=unknown — cross-thread close 불안전, 이벤트 간격 길음 |

---

## 13. 향후 고려사항

| 항목 | 설명 | 우선순위 |
|---|---|---|
| H.265/HEVC 지원 | ingest-daemon PyAV: `av.open` H.265 자동 디코딩 (libav 기반이므로 추가 작업 최소) | Medium |
| 인트 데몬 CUDA 가속 | `ingest_daemon.py`에 `PYAV_HW_ACCEL=cuda` 옵션 추가 | Medium |
| 백엔드 헬스 지표 | `/api/cameras/:id/capture-stats` 엔드포인트로 프레임률·지연 노출 | Low |
| Docker 이미지 최적화 | Python + PyAV만 포함하는 슬림 이미지 (`lts-ingest-daemon`) | Low |
| 동적 백엔드 전환 | 실행 중 카메라별 백엔드를 API로 전환 (현재는 서버 재시작 필요) | Low |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-04 | 초기 작성 (ffmpeg / gstreamer / pyav 3가지 백엔드) |
| 1.1 | 2026-06-11 | ingest-daemon 백엔드 추가 (현재 기본값); ffmpeg 레거시 분류; WEBRTC_ENGINE 환경변수 추가; captureFactory.js 코드 스니펫 업데이트 |
| 1.2 | 2026-06-19 | §6.7 Watchdog 및 자동 복구 추가 — PyAV 내부 watchdog, Node.js 프레임 watchdog, startServer.js 자동 재시작, reregisterAllWithIngestDaemon() |
| 1.3 | 2026-06-23 | §11 ingest-daemon 정상 종료 추가 — 2-phase stop (pre-signal all → join all), KeyboardInterrupt 보호, Connection refused 스팸 제거 |
| 1.4 | 2026-06-23 | §12 App RTP watchdog segfault 수정 — _Watchdog→read_timeout(AVFormatContext.io_timeout) 교체, codec=unknown cross-thread close 금지, APP_RTP_READ_TIMEOUT=60s |
| 1.5 | 2026-06-26 | §2 아키텍처 다이어그램에 ingest-daemon 항목 추가 및 현재 기본값 표기 |
| 1.6 | 2026-07-02 | §10.4 추가 — 카메라 삭제 시 ingest-daemon DELETE가 무재시도·무로그로 실패해 삭제된 카메라를 계속 재연결 시도하던 결함 수정 (재시도 1회 + 로그 + stopCamera()가 정리 작업을 await) |
| 1.7 | 2026-07-09 | §9 환경변수 표에 `AI_MAX_WIDTH`/`JPEG_QUALITY` 추가, §9.1 신규 — AI 프레임(YOLO 추론+crop 공용 소스 원본) 해상도가 `detectionSnapshots` crop 화질의 실제 상한임을 문서화; 기본값 640→1920 상향 근거 및 CPU/대역폭 트레이드오프 명시 |
| 1.8 | 2026-07-09 | §9.1 재작성 — v1.7의 "AI_MAX_WIDTH 상향" 방식을 아키텍처 수정으로 대체: `ingest_daemon.py`는 항상 원본(native) 해상도를 전송(리사이즈 제거), `AI_MAX_WIDTH`는 streaming 모드에서 Node.js(`pipelineManager.js`)가 remote analysis 서버 전송 직전 다운스케일하는 사본에만 적용, analysis 결과 bbox는 `_scaleBbox()`로 원본 좌표계 보정 후 crop — analysis 서버 부하와 crop 화질을 완전히 분리 |
| 1.9 | 2026-07-15 | §9.2 신규 — remote analysis 서버 자신이 `analysisApi.js` `/frame`에서 직접 저장하는 `detectionSnapshots`(Analysis Server Dashboard 전용 crop)는 §9.1의 "AI_MAX_WIDTH 무관" 결론 예외임을 문서화(analysis 서버는 native 버퍼가 없어 streaming 서버가 보낸 다운스케일 사본에서만 crop 가능 — SNAPSHOT_MAX_DIMENSION을 올려도 AI_MAX_WIDTH가 더 낮으면 해상도가 그 값에 상한됨); §9 환경변수 표·`.env`/`.env.example`/`.env.streaming.example`/`.env.analysis.example`의 `AI_MAX_WIDTH` 기본값 640→960 상향 |
| 1.10 | 2026-07-15 | §6.7 계층 2에 버그 수정 기록 추가 — Node.js 프레임 watchdog의 `setInterval` 콜백에 재진입 가드가 없어 재등록 왕복(최대 ~15.5s)이 8초 폴링 주기를 넘기면 restart storm이 발생하던 결함(TID-A800/`192.168.214.32`에서 실측·수정, WebRTC 연결 불가·전체 재생 끊김의 공통 원인) 수정: `ctx._watchdogBusy` 재진입 가드 추가, `lastFrameAt`을 재시작 완료 시점 기준으로 재갱신 |
| 1.11 | 2026-07-15 | §6.7 `Camera.webrtcVideoOnly` 신규 절 추가 — TID-A800 잔여 stall의 실제 원인이 카메라 자체의 동시 RTSP 세션 처리 한계였음을 ping/디코딩 스레딩/중복등록 순차 실측으로 특정, `mediasoupEngine.js` `addCameraStream()`에 `opts.videoOnly`(audio+App RTP 세션 생략, 4→2) 추가하고 적용 후 5분+ 무중단 실측 확인 |
| 1.12 | 2026-07-15 | §6.8 신규 — "RTSP 1개·YouTube 1개" 요구를 충족하기 위해 `ingest_daemon.py`를 카메라당 4개 독립 RTSP 세션(AI/videoRTP/audioRTP/appRTP)에서 **정확히 1개**로 재설계: 단일 `av.open()` + `container.demux(*streams)`, AI 디코드는 원시 바이트를 큐로 넘겨 완전히 분리된 워커 스레드에서 처리(§6.7 이전 실패했던 동일-스레드 병합과 달리 RTP mux를 절대 블로킹하지 않음). 배포 중 부수적으로 발견한 스레드 누수 3건(`_join_threads` 타임아웃 부족, HTTP 서버 단일 스레드, `CameraManager` 동기적 stop(), 카메라당 개별 push 스레드풀)도 함께 수정. 라이브 검증(TID-A800): 크로스스레드 디코드 269패킷 무오류, `CameraSession` 30초 실행 시 video RTP 10,804패킷/AI 278프레임, 4회 연속 시작/종료 무누수, 배포 후 로그에 카메라당 `Combined RTSP loop starting` 1줄만 확인. **미해결**: 위 수정 후에도 `ingest-daemon`의 `/health`가 간헐적으로 수십초~2분 응답 지연되고 Node.js watchdog 재등록이 타임아웃되는 현상이 남음(GIL 경합은 별도 스크립트로 배제 확인) — 정확한 원인은 후속 세션에서 py-spy 등으로 추가 조사 필요 |
| 1.13 | 2026-07-16 | §6.9 신규 — v1.12의 "미해결" 항목이 실은 별개의 심각한 버그였음을 확정: `mediasoupEngine.js`의 `_ingestPost`/`_ingestDelete`가 타임아웃 없는 원시 `http.request()`를 사용해, ingest-daemon 응답 지연 1회만으로 `pipelineManager.js`의 `_starting` 가드가 해당 카메라 ID에 **영구히**(프로세스 재시작 전까지) 고착 — 이후 모든 시작 시도(부팅 자동시작·watchdog·수동 API)가 에러 로그 없이 조용히 no-op됨. TID-A800이 몇 시간 동안 완전히 멈춰있던 실제 원인. `timeout: 8000` + `req.on('timeout', ...)` 추가로 수정. 검증: 재부팅 시 TID-A800 즉시 자동시작, 90초 관찰 창 watchdog 재시작 0회, mediasoup Consumer 진단 로그로 실제 비디오 패킷 전송 확인, Playwright `iceTest.js`(자체서명 인증서 무시 옵션 추가) 헤드리스 브라우저로 ICE/STUN/TURN 독립 검증 |
| 1.14 | 2026-07-16 | §6.10 신규 — `ingest-daemon` 간헐적 완전 무응답의 진짜 근본 원인 확정: `_ai_decode_worker()`의 libav `CodecContext.thread_count=0`("AUTO")이 코어 수(40)만큼 카메라당 네이티브 디코드 스레드를 생성 — Python `threading`에 미등록되어 기존 진단(GIL 배제 테스트 등)에서 전혀 보이지 않던 스레드 폭증의 실체였음. ptrace 권한 없이(py-spy/gdb 불가) `faulthandler.register(SIGUSR1)`을 내장해 실제 스택 덤프로 확정(Python 가시 스레드 51개 vs `/proc` 400개+). `thread_count`를 고정 상한 `AI_DECODE_THREADS`(기본 4)로 교체, `CameraManager.add()`/`remove()`의 "stopper" 스레드도 `_SHARED_STOP_EXECUTOR`(고정 8 workers)로 함께 정리(단, 이 자체는 근본 원인이 아니었음을 §6.10에 명시) |
| 1.15 | 2026-07-16 | §6.11 신규 — 재시작 직후 함대 전체 동시 `av.open()`으로 인한 완전 정지를 `_INGEST_SETUP_SEMAPHORE`(연결 수립 단계만 감싸는 게이트, 기본 동시 3개)로 완화; 조사 중 `ingest_daemon.py`가 SIGTERM에 아무 핸들러도 없어(`KeyboardInterrupt`=SIGINT만 처리) `npm run ingest:restart`/`stop`의 모든 재시작이 `container.close()`(RTSP TEARDOWN) 없이 즉시 강제종료되어 카메라측에 좀비 세션을 누적시켜온 사실을 발견 — `signal.signal(SIGTERM, ...)`으로 동일한 그레이스풀 종료 경로 적용. 검증: 좀비 세션 해소 후 13개 카메라 전부(TID-A800 포함) `running=true`·`frameCount` 증가·`lastFrameAt` 10~20초 이내로 정상 확인. **미해결**: 대부분의 카메라가 ~20~24초 주기로 정체 후 Node.js 프레임 watchdog에 재시작되는 함대 전체 패턴 재관찰 — 공유 push pool 포화 vs 재시작 자체의 스레드 정리 지연 자기강화, 두 가설 중 미확정 |
| 1.16 | 2026-07-16 | §6.12 신규 — `_INGEST_SETUP_SEMAPHORE.acquire()`가 타임아웃·`self._stop` 확인 없는 순수 블로킹 호출이라, 재시작마다 교체된 옛 세션의 스레드가 permit을 영원히 대기하며 누적 — 결국 실제 카메라 7대 전부의 mediasoup 등록이 8초 타임아웃으로 실패하는 함대 전체 장애로 번짐(WHEP 비디오 0바이트, Web UI "WebRTC connection failed" 사용자 신고의 실제 원인). `self._stop` 확인하는 폴링 방식으로 교체 + 동시성 3→5 상향, 비디오 RTP `payload_type` 명시(오디오와 대칭) 추가 수정 — 배포 후 WHEP에서 최초로 실제 비디오 바이트 수신 확인(1.6MB). 부수적으로 SIGTERM이 격리 테스트에서는 완벽히 작동하지만 실제 daemon에서는 재현 불가하게 무시되는 현상을 발견(근본 원인 미확정) — `restartIngestDaemon.js`에 TERM→8초 대기→KILL 승급 로직 추가로 재시작 실패(사용자가 직접 겪음)를 우회. **미해결**: steady-state io 스레드가 8초 내 종료 안 되는 근본 문제, SIGTERM 무시 근본 원인 |
| 1.17 | 2026-07-16 | §6.13 신규 — 바이트/패킷은 정상 도달하는데 `framesDecoded`가 모든 카메라에서 영구히 0으로 고정되던 근본 원인 확정: mediasoup 라우터 H.264 `preferredPayloadType=109`가 Chrome 오퍼에서 실제로는 `rtx apt=108`(PT 108의 재전송)에 해당해, 브라우저 지터 버퍼가 들어오는 순수 H.264 패킷을 재전송 래퍼로 오인식 — `mediasoup/node/lib/ortc.js` 확인 결과 Consumer 실전송 PT는 Producer 생성 시점 라우터 설정으로 고정되며 `_buildBrowserRtpCapabilities()`의 동적 PT 매핑은 죽은 코드였음. PT를 108(Chrome이 실제 순수 H.264에 배정하는 값)로 변경 후 WHEP+`getStats()` 실측으로 프레임 디코드 정상 확인(≈30fps). 부수적으로 `getProducerStats()`가 `webrtcVideoOnly` 카메라의 null `audioProducer`/`audioPlain`에서 매 폴링 예외를 던지던 결함도 수정. **미해결**: TID-A800 2대는 `webrtcVideoOnly=true` 적용 후에도 ~45초 주기로 videoBytesRx 정체 재현 — 세션 수 감소로 설명되지 않는 별개 원인(고해상도 인코더/대역폭 한계 추정) 조사 필요 |
| 1.18 | 2026-07-16 | §6.14 신규 — 일부 카메라(192.168.214.38/39/40)의 RTSP 포트가 동시에 응답 불능이 되면서 `ingest-daemon`의 setup 큐가 포화(`/health`조차 무응답, 커널 accept 큐 SYN_SENT 백로그로 확인)되어 함대 전체가 6분 이상 재생 불가에 빠진 사고 분석: 프레임 워치독(`pipelineManager.js`)이 재등록 성공/실패와 무관하게 매번 정확히 45초(+최대 8초) 후 동일 카메라를 재시도하는 구조라 backoff이 전무했고, 문제 카메라들의 무한 재시도가 이미 포화된 daemon을 계속 두드리면서 원래 멀쩡했던 카메라들까지 같은 주기로 동기화되어 재등록 실패 — 함대가 자기 자신의 컨트롤 플레인을 스스로 DoS하는 공진 상태(외부 개입 없이는 회복 불가)에 빠졌던 것을 확정. 연속 실패 카운터 기반 지수 백오프(+15s/회, 최대 240s) + 랜덤 지터(0-5s)를 워치독에 추가해 재발 방지, 서버 재시작 후 9개 카메라 전부 즉시 복구·WHEP 재생 30fps/드롭 0 확인 |
| 1.19 | 2026-07-16 | §6.15 신규 — `webrtcVideoOnly` 카메라에서 WHEP negotiate가 항상 "SDP without DTLS fingerprint"로 실패하던 결함 확정: fingerprint 라인 자체는 유효했으나, reject된 audio/data 섹션이 `a=group:BUNDLE`에 없으면서도 `a=bundle-only`를 선언하는 자기모순 SDP였음 — 해당 속성 제거로 수정(TID-A800 Ch2 재생 정상 확인). §6.16 신규 — YouTube 카메라를 mediasoup WebRTC 등록에서 배제하던 `!isYouTube` 게이트를 제거(§6.8 단일-RTSP-연결 재설계로 과거의 "connection-refused 재시도 루프" 우려 근거가 사라졌음을 확인) — 재활성화 후 등록 즉시 성공, 실사용자 WHEP로 4MB+ 정상 수신 확인, 재시도 폭풍 재현 없음. **미해결**: 해당 YouTube 세션에서 초기 300프레임 정상 디코딩 후 framesDecoded 정체 현상(YouTube 자체 URL 만료 자동복구 루프와 동시 발생, 인과관계 미확정) |
| 1.20 | 2026-07-16 | §6.17 신규 — WHEP 재생 중 정지 구간(nackCount 급증과 상관)의 원인이 RTX(재전송) 완전 비활성화였음을 확정하고 활성화: 라우터에 `video/rtx`를 수동 선언하면 mediasoup가 원천적으로 거부(`media codec not supported`)해 전체 카메라 등록이 깨지는 회귀를 유발함을 발견·롤백, RTX는 video 코덱마다 자동 생성됨을 확인. 자동 생성 PT(100)가 Chrome 오퍼의 VP9 슬롯과 충돌해 §6.13과 동일한 클래스의 문제로 오히려 악화(nackCount 303→525)됨을 실측 확인 후, 더미 오디오 코덱 8개로 PT 100-107을 선점시켜 자동 RTX를 Chrome의 실제 H264-RTX 슬롯(PT=109)에 정확히 배정 — 저해상도 카메라 무회귀 확인(90초 무결점), WHEP negotiate 연속 8/8 성공. **미해결**: 고해상도(2048×1536+) 카메라는 PT를 정확히 맞춘 RTX 적용 후에도 정지 구간 재현 — 대역폭/인코더 한계 추정, 테스트 시점 동일 서버를 쓰는 다른 Claude Code 세션 9개+ 확인(load average 7.86)되어 공유 서버 부하와의 상관관계 미확정 |
| 1.21 | 2026-07-16 | §6.18 신규 — §6.17의 "미해결" 항목의 진짜 근본 원인 확정: `/proc/net/snmp`의 `Udp: RcvbufErrors`가 1000만 건 이상 — 커널 UDP 수신 버퍼(기본 ~208KB) 오버플로우로 5MP/3MP 카메라의 키프레임 버스트가 조용히 유실되고 있었음(localhost 구간에서도 재현되어 원격 네트워크와 무관함을 확정). `mediasoupEngine.js`의 video/audio PlainTransport를 구버전 `listenIp`에서 `listenInfo`(`recvBufferSize: 8MB`)로 전환. 검증: TID-A800 Ch2 nackCount 319→0, TNM-C2712T Ch1 정지 구간 다수→0회·nackCount 517→0(≈23fps로 사실상 실시간 회복) — 이번 세션 전체를 관통한 "패킷 손실형 재생 정지"의 실질 근본 원인. 부수적으로 `useWebRTC.ts`의 ICE 진단 패널(`iceStats`)이 항상 `null`로 하드코딩되어 "Collecting stats…"만 표시되던 죽은 코드를 발견·구현(기존 스톨 감시 로직이 이미 수집하던 candidate-pair 정보를 재사용). 또한 프레임 스톨 자동 재연결이 사용자 수동 "재연결" 버튼 전용 함수(`retryCount` 리셋)를 그대로 호출해 `MAX_AUTO_RETRIES` 제한이 무력화되며 무한 재연결 폭풍을 일으키던 회귀를 자체 발견·수정(기존 byte-stall 경로도 동일 결함 보유, 함께 수정) — 자동 재시도는 이제 다른 자동 경로와 동일하게 횟수 제한 있는 지연 방식(`setRetryCount(n=>n+1)` + 3초 지연)만 사용 |
| 1.22 | 2026-07-16 | §6.19 신규 — Chrome DevTools Media 패널에서 특정 타일이 "Pause"로 표시되는 현상 확인: `<video>.play()` 실패 시 `_ignoreAbort`가 무해한 `AbortError`뿐 아니라 `NotAllowedError`(자동재생 정책 차단)까지 조용히 무시해, 정지된 마지막 프레임만 계속 표시되는데도 아무 에러 없이 영원히 멈춰있을 수 있었던 결함 발견·수정 — `_attachAndPlay()` 헬퍼로 통일해 `NotAllowedError`만 500ms 후 1회 재시도 |
| 1.23 | 2026-07-16 | §6.20 신규 — 실사용자 콘솔 로그 직접 확인 결과 카메라 7개 전부가 프레임 스톨→재연결을 반복 중임을 확정: 그리드의 모든 타일이 거의 동시에 마운트되어 §6.18의 프레임 스톨 워치독(고정 20초 임계값)이 동시에 만료 → 여러 타일이 동시에 재협상하며 그 부하 자체가 서로의 디코딩을 방해 → 다시 동시 스톨 → 재연결이 서로를 촉발하는 자기강화 루프였음(§6.14 서버측 문제와 동일 클래스, 이번엔 클라이언트). `useWebRTC.ts`에 연결당 랜덤 지터(0-8초)로 워치독 만료 시점 분산 + `retryCount` 기반 증가 백오프(회당 +2초, 최대 +15초)로 재연결 지연 추가 |
| 1.24 | 2026-07-16 | §6.21 신규 — 고해상도 카메라가 계속 검은 화면이던 마지막 원인 확정: mediasoup이 정적으로 선언하는 H.264 `profile-level-id`가 Level 4.0(MaxFS 8192 매크로블록)인데 TID-A800/TNM-C2712T Ch1의 실제 SPS는 Level 5.0이고 해상도(2560×1920/2048×1536)가 Level 4.0의 최대 프레임 크기를 초과하는 규격 위반이었음 — Level 5.1(`640033`)로 상향, TID-A800 Ch2 26.6fps·TNM-C2712T Ch1 29fps(스톨/NACK/드롭 전부 0)로 완전 회복. §6.22 신규 — 그리드 타일+풀스크린처럼 같은 카메라를 공유하는 여러 컴포넌트 중, §6.18/§6.20의 프레임 스톨 워치독이 연결을 최초로 만든 컴포넌트의 `cancelled` 플래그에만 묶여 있어 그 컴포넌트가 언마운트(예: 풀스크린 열면서 그리드 타일이 가려짐)되면 감시 자체가 조용히 중단되던 결함 발견·수정 — 워치독 종료 조건을 `sessionRegistry` 엔트리의 `pc` 일치 여부로 변경(생성자 언마운트와 무관하게 다른 소비자가 남아있으면 계속 동작), 재연결 액션도 공유 `stream.getTracks().forEach(t=>t.stop())`로 바꿔 네이티브 `inactive` 이벤트를 통해 현재 마운트된 모든 소비자에게 자동 전파되도록 함 |
| 1.25 | 2026-07-20 | §6.23 신규 — 메인 서버 크래시 복구 구간에서 `_ingestRegisterCamera()`의 `POST /cameras`가 `fetch` 레벨에서 실패(타임아웃/커넥션 리셋)해도 daemon 쪽은 실제로 등록을 완료해놓는 경우가 있어, DB엔 없고 daemon 내부에만 존재하는 좀비 세션이 남던 결함 확인(`/health`의 `cameras`가 DB 카메라 수보다 많음) — catch 블록에서 동일 ID로 `_ingestRemoveCamera()`(멱등 DELETE)를 즉시 호출하도록 수정, 실측으로 카운트 5→4 정합 확인 |
| 1.26 | 2026-07-20 | §6.24 신규 — 카메라가 꺼져도 Dashboard "Cameras" 패널 상태 dot이 갱신되지 않던 결함 수정: `IngestDaemonCapture`가 `warn`/`reconnecting`/`error`를 전혀 emit하지 않아 프레임 워치독의 재시도가 `camera:status`를 한 번도 발행하지 않던 문제(워치독 스톨 감지 시 `reconnecting`, 연속 3회 실패 시 `error` 발행 추가) + `_updateCameraStatus()`가 room-scoped emit이라 사이드바처럼 room 미가입 컴포넌트에 도달하지 않던 문제(전역 broadcast로 변경) + 워치독 복구 후 `streaming` 재발행 누락(`ctx._statusIsDown` 플래그로 통합) 함께 수정 |
| 1.27 | 2026-07-20 | §6.25 신규 — H.265/HEVC 카메라 WebRTC 재생 불가 원인 조사: 최초 동적 코덱 선택 구현(Router H.265 항목, Producer 동적 mimeType, SDP H.265 fmtp 주입) 후 실제 재시작으로 검증한 결과 mediasoup 3.21.0/3.21.2 모두 H.265를 전혀 지원하지 않음(`media codec not supported`)을 확인 — 해당 mediasoup 관련 변경을 전부 되돌리고 video Producer는 항상 H.264로 고정. `ingest_daemon.py`의 H.265 감지·파싱(`_parse_h265_vps_sps_pps`, EPB 버그 수정 포함)과 `/video-params` 확장 필드는 진단용으로 유지. 부수적으로 `negotiate()`의 미사용 `profileLevelId` 할당 누락 결함도 함께 발견·수정(유지) |
| 1.28 | 2026-07-20 | §6.26 신규 — H.264 카메라조차 Chrome에서 재생 안 되던 근본 원인 확정: mediasoup Consumer의 실제 전송 PT는 Router 등록 시 정적 선언값으로 영구 고정되며 `negotiate()`마다 넘기는 `remoteRtpCapabilities`는 호환성 필터일 뿐 PT를 바꾸지 못함(`ortc.js` 직접 확인) — 브라우저 offer가 Router 고정값과 다른 PT를 쓰면 프레임이 영원히 디코드 안 됨(Edge=108 재생됨, Chrome=109 재생 안 됨 실측). 한 Router 안에 PT 두 개를 선언하는 방식은 Producer→capability 매칭이 PT를 기준으로 삼지 않아 근본적으로 불가능함을 소스로 확정, 대신 PT별 Router/파이프라인을 필요할 때마다 생성·캐싱하는 방식(`_ensurePtRouter`/`_ensureAltPipeline`)으로 해결. `ingest_daemon.py`에 video RTP 다중 목적지 fan-out 추가(`_mux_passthrough`의 패킷 in-place 변형으로 인한 목적지 간 타이밍 오염 버그도 함께 발견·수정). 실제 브라우저 재접속으로 TID-A800의 `framesDecoded`가 처음으로 0 아닌 값(2812, 30fps, 2560×1920)을 기록함을 확인 |
| 1.29 | 2026-07-20 | §6.27 신규 — §6.26 배포 직후 재생은 되지만 FPS 요동·버퍼 empty가 빈번하던 증상 실측 진단: UDP `RcvbufErrors`가 초당 ~8건씩 실시간 증가 중이었음(WebRtcTransport가 `listenIps`(구식 API) 사용으로 §6.18의 버퍼 크기 옵션을 못 받고 있었음 + 아무도 안 보는 기본(108) 파이프라인까지 ingest-daemon이 계속 mux) — `listenInfos`로 전환해 버퍼 명시 + 기본 파이프라인도 alt-PT처럼 지연 생성으로 전환, `RcvbufErrors` 증가를 0으로 확인. 그러나 사용자 재확인 결과 시각적 증상은 그대로였음 — `AI_DECODE_THREADS` 4→8은 CPU 무변화로 배제, candidate-pair RTT 1~2ms로 네트워크 구간 손실도 배제. 최종적으로 `CAPTURE_FPS`가 실질적으로 항상 10fps 강제(`.env` 문서의 "비워두면 자동 매칭" 경로가 코드상 한 번도 실행 안 되는 기존 불일치 발견, 미수정 기록만)였고 TID-A800 기준 초당 9~10회 2560×1920 원본 해상도 JPEG 인코딩이 지속 부하원이었음을 확인 — `CAPTURE_FPS=5`로 낮춰 CPU 250~270%→170%, TID-A800 손실률 1.2%→0.26%, PLI 16~19회→2회로 실측 개선 |
| 1.30 | 2026-07-20 | §6.27 보완 — 클라이언트 측 적응형 jitter buffer 추가: `useWebRTC.ts`에 `RTCRtpReceiver.jitterBufferTarget`(Chrome 123+) 기반 로직 도입, 5초 stats 폴링마다 freezeCount/packetsLost 증가 여부로 목표 버퍼 시간을 100~1000ms 사이에서 동적 조정(문제 없으면 브라우저 기본값 유지). `npx tsc --noEmit`/`npm run build` 확인, 서버 재시작 없이 브라우저 새로고침만으로 반영됨을 확인 |
| 1.31 | 2026-07-20 | §6.27 재보완 — 사용자 실측 관찰(Buffer가 빨간색으로 변한 뒤 얼마 지나 fps가 0이 되는 패턴 반복)에 따라 트리거를 반응형(freeze 발생 후)에서 선제형(bufferMs 자체가 WebRtcStatsPanel의 yellow/red 임계값을 넘는 순간)으로 변경 — `BUFFER_MS_WARN`(100ms)/`BUFFER_MS_BAD`(300ms) 상수를 `useWebRTC.ts`에서 export해 `WebRtcStatsPanel.tsx`와 단일 소스로 공유, red 진입 시 2배 폭으로 즉시 상향 |
| 1.32 | 2026-07-20 | §6.27 재보완 — 브라우저 탭 Focus In/Out 시 "무조건" 재현되는 재연결 근본 원인 확정: Chrome의 백그라운드 탭 WebRTC 비디오 디코드 스로틀링을 기존 스톨 워치독이 정상 동작으로 인지하지 못해 오탐 재연결을 유발 — `useWebRTC.ts`에 Page Visibility API 기반 가드 추가(탭 숨김 중 스톨 판정·jitterBufferTarget escalation 전면 정지, 재표시 시 기준 시각/카운터 리셋). `npx tsc --noEmit`/`npm run build` 클린 통과 확인 |
| 1.33 | 2026-07-20 | §6.27 재보완 — ICE 패널 "Bytes ↑/↓" 항목을 연결 시작 이후 누적 바이트에서 순간 전송률(bps)로 변경: candidate-pair `bytesSent`/`bytesReceived` 델타를 video/audio Kbps와 동일한 방식으로 계산해 `IceStats.sentBps`/`receivedBps`로 교체, `WebRtcStatsPanel.tsx` 라벨 "Bytes"→"Rate" + `fmtBps()` 자동 단위(bps/kbps/Mbps) 표시로 변경, 미사용 `fmtBytes()` 제거 |
| 1.34 | 2026-07-20 | §6.27 재보완 — ICE 패널 Rate 갱신 주기를 메인 5초 stats/워치독 루프(`POLL_MS`)에서 분리한 별도 1초 `rateTimer`(`RATE_POLL_MS`)로 단축, candidate-pair 파싱 공통 로직을 `extractNominatedPair()` 헬퍼로 추출해 두 루프가 공유(`POLL_MS`를 직접 낮추면 스톨 워치독 민감도와 jitterBufferTarget escalation/decay 속도까지 5배 빨라져 §6.27 상단에서 튜닝한 값이 깨지므로 회피). 사용자가 보고한 "Buffer가 ~980ms까지 상승→fps 0→재연결→반복" 패턴을 §6.20에서 이미 예견된 클라이언트 디코드 용량 한계(네트워크가 아닌 브라우저 디코드 처리량 부족으로 지터 버퍼에 프레임이 계속 쌓이는 현상)로 진단·문서화, 코드 수정은 사용자 확인 후로 보류 |
| 1.35 | 2026-07-20 | §6.27 재보완 — 사용자가 제공한 `chrome://gpu` 실측(Windows/Edge, NVIDIA RTX 2000 Ada)으로 v1.34 가설 수정: H.264 하드웨어 디코드가 4096×4096까지 지원되어 "소프트웨어 디코드" 가설 배제, 동시 오픈 타일도 WebRTC 비디오 디코드 2개뿐(JPEG 폴링 4개는 비디오 디코드 무관)이라 "다수 타일 동시 디코드 경합"의 설명력도 약화. 대신 overlay 지원이 전부 SOFTWARE로 표시되고 GPU 프로세스 로그에 `SharedImageManager::ProduceOverlay`/`ProduceSkia` "non-existent mailbox" 에러가 반복 발견되어, 디코드가 아닌 "디코드된 프레임을 화면에 합성하는 프레젠테이션(오버레이/컴포지팅) 경로"가 실제 병목일 가능성으로 가설 이동 — 여전히 미수정, `chrome://media-internals` 프레임 드롭 시각과 GPU 에러 시각 대조 필요 |
| 1.36 | 2026-07-20 | §6.27 재보완 — 근본 원인 확정 전이지만 원인과 무관하게 유효한 개선으로 프로액티브 재연결 추가: `useWebRTC.ts`에 `bufferSaturatedTicks`/`BUFFER_SATURATED_TICKS_LIMIT=2` 도입, jitterBufferTarget escalation이 이미 `JITTER_TARGET_MAX_MS` 상한에 도달했는데도 `bufferMs`가 계속 `BUFFER_MS_BAD` 이상이면(더 escalation할 여지가 없다는 신호) 20~25초짜리 프레임/바이트 스톨 워치독을 기다리지 않고 즉시 `staleReconnect()` 트리거 — 사용자가 겪던 "Buffer 980ms까지 상승 후 장시간 정지" 패턴을 짧은 재연결로 대체. `npx tsc --noEmit`/`npm run build` 클린 통과 확인 |
