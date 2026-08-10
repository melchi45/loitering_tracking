# DESIGN DOCUMENT
# RTSP 캡처 백엔드 추상화 — FFmpeg / GStreamer / PyAV 다중 백엔드 설계

| | |
|---|---|
| **Document ID** | DESIGN-LTS-CAPTURE-002 |
| **Version** | 1.71 |
| **Status** | Active |
| **Date** | 2026-07-28 |
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

> **(2026-07-24, §6.37로 정정)** 이 결론은 **읽기 쪽**(`av.open()`으로 여는 입력 컨테이너의 `demux()`)에 한정된 것으로, 여전히 유효하다. 그러나 **쓰기 쪽**(`av.open(..., "w", format="rtsp")`로 여는 출력 컨테이너의 `mux()`)은 별도로 검증된 적이 없었고, §6.37에서 실측한 결과 RTSP `mux()`는 블로킹 네트워크 쓰기 동안 GIL을 놓지 않는 것으로 확인됨 — "PyAV는 GIL 경합이 없다"가 아니라 "읽기는 안전, RTSP 쓰기는 안전하지 않다"로 정정.

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

**적용했다가 되돌림 — bufferMs 포화 시 프로액티브 재연결 (2026-07-20 적용, 2026-07-21 revert)**: 정확한 근본 원인(디코드 vs 프레젠테이션 병목)이 `chrome://media-internals` 대조로 확정되기 전, 원인과 무관하게 유효할 것으로 보고 다음을 적용했었음: `jitterTargetMs`가 이미 `JITTER_TARGET_MAX_MS`(1000ms) 상한까지 escalation된 상태에서 `bufferMs`가 여전히 `BUFFER_MS_BAD`(300ms) 이상이면 실제 fps 정지가 벌어지는 20~25초짜리 프레임/바이트 스톨 워치독을 기다리지 않고 바로 `staleReconnect()`를 트리거(`BUFFER_SATURATED_TICKS_LIMIT=2`, 연속 2틱=10초 요구).
- **사용자 실측 피드백(2026-07-21)**: "재연결로 인해 채널의 영상이 정지되고, 채널이 refresh 되고 있습니다. 근본원인 파악이 필요합니다" — 즉 이 프로액티브 재연결 자체가 사용자에게 뚜렷이 보이는 화면 정지+새로고침으로 체감되어, "긴 프리즈를 짧은 재연결로 대체"라는 원래 의도와 달리 오히려 눈에 띄는 방해로 작용했고, 근본 원인을 가리는 부작용도 있음(재연결이 증상을 매번 리셋시켜 버려 `chrome://media-internals` 등으로 실제 디코드/프레젠테이션 지연을 관찰할 기회 자체가 줄어듦).
- **되돌린 이유**: 증상을 마스킹하는 임시방편보다, 근본 원인(§6.27 상단의 `chrome://gpu` 소프트웨어 오버레이/`SharedImageManager` mailbox 에러 가설)을 먼저 확정하는 것이 우선이라는 사용자 판단에 따름 — `useWebRTC.ts`에서 `BUFFER_SATURATED_TICKS_LIMIT` 상수, `bufferSaturatedTicks` 카운터(선언·escalation 블록 내 갱신·`handleVisibilityChange` 리셋·최종 판정 분기) 전부 제거, 프로액티브 jitterBufferTarget escalation 로직 자체(§6.27 상단)는 유지 — 재연결이 아니라 버퍼 목표치만 올리는 부분은 그대로 둠. 스톨 감지는 다시 기존 20~25초 프레임/바이트 워치독만 사용. `npx tsc --noEmit`/`npm run build` 클린 통과 확인.
- **다음 단계**: `chrome://media-internals`로 실제 프레임 드롭/디코더 지연 시각을 GPU 프로세스 로그의 `ProduceOverlay`/`ProduceSkia` 에러 시각과 대조하는 근본 원인 확인이 여전히 필요 — 프로액티브 재연결을 제거했으므로 이제 증상이 방해받지 않고 자연스럽게 관찰 가능함.

**진전 — `chrome://media-internals` 실측으로 서버 로그와 밀리초 단위 대조 확인 (2026-07-21)**: 사용자가 제공한 `kWebMediaPlayerDestroyed` 이벤트(재생 시작 후 38.029초만에 `kPause`+`kWebMediaPlayerDestroyed` 동시 발생, UTC 05:15:12.539)를 서버 로그(`server/logs/lts-2026-07-21.log`, 브래킷 타임스탬프가 UTC임을 `date -u`로 확인)와 대조한 결과, **동일 카메라(`4e562747`)의 `DTLS ... closed` 로그가 정확히 05:15:12.539(밀리초 단위 일치)에 찍힘** — 직전 연결도 05:14:32.479에 DTLS closed 후 05:14:34.510 재협상, 이번 연결도 05:15:12.539 DTLS closed 후 05:15:14.565 재협상으로 패턴이 반복(연결 수명 약 33~38초). `Consumer-diag`/`vScore` 로그는 종료 직전까지 정상(bytesSent 증가 중, score 9~10)이라 서버측 mediasoup Consumer/Producer 자체의 이상 징후는 없음.
- `mediasoupEngine.js:1398`의 `TRANSPORT_MAX_LIFETIME_MS=90_000`(90초 하드 타임아웃)은 33~38초와 맞지 않아 배제.
- 대신 클라이언트 자체 스톨 워치독 타이밍과 겹침에 주목: `STALL_MS = 25_000 + jitterMs(0~8000)`(25~33초) 감지 + 다음 5초 폴링 틱까지 지연(최대 5초) + `staleReconnect()`의 `AUTO_RETRY_DELAY=3_000`(최초 재시도, backoffMs=0) = 총 33~41초 — 관찰된 33~38초 범위와 거의 정확히 겹침. `FRAME_STALL_MS`(20~28초) 경로도 유사 범위(23~36초)로 겹침.
- **잠정 결론**: 이 재연결이 서버가 먼저 끊은 것이 아니라, **클라이언트 자신의 프레임/바이트 스톨 워치독이 `stream.getTracks().forEach(t=>t.stop())`을 호출해 브라우저 쪽에서 먼저 ICE/DTLS를 닫고, 그 결과가 서버 로그에 "DTLS closed"로 나타났을` 가능성이 높음 — 즉 반복되는 재연결의 실제 방아쇠가 디코드/프레젠테이션 병목이 아니라 **우리 자신의 워치독 임계값(threshold)이 너무 민감하게 잡히고 있을 가능성**으로 무게중심 이동. 확정을 위해서는 사용자가 재현 시점에 브라우저 개발자도구 콘솔에서 `[useWebRTC][4e562747] video stream stale for ...` 또는 `framesDecoded stuck at ...` 로그가 실제로 찍히는지 확인 필요 — 찍힌다면 클라이언트발 재연결 확정.

**별개로 발견·수정 — Buffer/Latency가 0ms↔900ms+로 반복 진동하는 결함 (2026-07-21)**: 위 조사와 별개로 사용자가 "이전보다 더 안 좋다, Buffer/Latency가 0ms와 900ms+ 사이를 너무 자주 왔다갔다한다"고 보고. 원인은 최근(다른 세션에서) `rxHistory` 샘플링이 `statsTimer`(5초 주기)에서 `rateTimer`(1초 주기)로 이전되면서, `bufferMs` 계산이 `jitterBufferEmittedCount`가 해당 1초 틱 동안 전혀 증가하지 않으면(30fps 기준 1초 창에서는 흔히 발생 가능) 무조건 0으로 폴백하도록 되어 있던 것 — 그 다음 틱에서 두 틱 분량의 누적 `jitterBufferDelay`가 그사이 emit된 소수의 프레임에 나눠지며 보정성 스파이크가 발생, 결과적으로 0ms↔900ms+ 톱니파가 반복됨. `useWebRTC.ts`의 `rateTimer`에 `lastKnownBufferMs`(마지막으로 유효하게 계산된 값을 다음 틱에 이월)를 추가해 새 데이터가 있을 때만 갱신하고 없으면 이전 값을 유지하도록 수정 — `statsTimer`(5초, 스톨 워치독·jitterBufferTarget escalation 담당)의 별도 계산 로직은 손대지 않음. `npx tsc --noEmit`/`npm run build` 클린 통과 확인.

**최종 근본 원인 확정 — ingest-daemon 다운 + `profileLevelId` 캐시 고착 (2026-07-21)**: §6.27 전체를 관통한 "framesDecoded=0"/"Codec 칸이 빈칸"/"버퍼 급등 후 정지" 증상들의 실제 근본 원인 두 가지를 최종 확정:
1. **ingest-daemon 프로세스 자체가 다운**: `curl http://127.0.0.1:7070/health`가 `Connection refused` — 포트 7070에 아무 프로세스도 없었음(`ps aux`로 확인). 원인 미상(공유 서버 부하 중 크래시 추정, 별도 크래시 로그 없음). 서버가 재시작될 때마다 `PipelineManager][<id>] ingest-daemon register failed: fetch failed` → `WebRTC disabled for this pipeline (engine: mediasoup, ready: false)`로 귀결되어, 재시작을 몇 번을 해도 WHEP negotiate가 `Camera <id> is not streaming via mediasoup`(503)로 즉시 거부됨 — 이번 세션에서 반복했던 여러 차례의 `npm run restart`가 전부 이 이유로 헛수고였음. `npm run ingest:start`로 데몬을 되살리고 카메라 8대 재등록 확인 후 메인 서버를 재시작하자 실제 카메라 2대(4e562747/61813f62)는 즉시 정상화(`vFrames`가 실시간으로 증가하기 시작함, 실측 확인).
2. **`profileLevelId` 캐시 고착 — Baseline(`42e01f`)로 영구 고정**: mediasoup Producer의 `profile-level-id`는 `addCameraStream()` 시점에 딱 한 번 `_pollVideoCodec()`(예산 5초)로 ingest-daemon의 실제 SPS 파싱 결과를 가져와 캐싱하고, 이후 모든 negotiate()에서 재조회 없이 재사용하는 구조(§6.13 설계, 코드 주석에 이미 "Producer는 ingest-daemon이 SPS를 다 읽기 전 하드코딩된 `42e01f`(Baseline)로 먼저 생성되고 나중에 실제 값으로 덮어써야 한다"고 명시돼 있었음). 오늘 ingest-daemon이 여러 차례 다운·재시작을 반복하는 동안 이 카메라들의 `addCameraStream()`이 실행됐을 때, 5초 폴링 예산 안에 ingest-daemon이 SPS 파싱을 못 끝내 폴백값 `42e01f`(Baseline, Level 3.1)가 그대로 캐싱됨. 이후 ingest-daemon이 완전히 복구돼 `GET /cameras/:id/video-params`로 직접 조회하면 정상값(`640032`, High Profile Level 5.0)이 나오는데도, 캐시된 값은 갱신되지 않아 계속 `42e01f`로 협상됨. Level 3.1은 2048×1536(61813f62/TNM-C2712T Ch1) 같은 고해상도 스트림엔 턱없이 부족(MaxFS 3600 매크로블록 vs 실제 소요 12288)해 일부 프레임(14개)만 디코드되다 막히는 것으로 실측 확인(Buffer 506ms/Latency 507ms로 급등, 8.2% 손실 동반) — 코덱이 아예 안 잡히던 다른 케이스(`Codec: – / opus`)도 같은 계열로 추정.
   - **미봉책(적용 완료)**: `POST /api/cameras/:id/stream/reconnect`로 두 카메라의 파이프라인을 재시작해 캐시를 새로 고침 — ingest-daemon이 이미 건강한 상태에서 재폴링되어 `640032`로 정상 갱신됨(로그로 확인: `sprop-parameter-sets ready ... profile-level-id=640032`).
   - **근본 수정은 미적용, 후속 필요**: `_pollVideoCodec()`의 결과가 폴백(Baseline)이었던 경우 이후 negotiate() 시점에 한 번 더 재폴링을 시도하는 지연 재확인 로직, 또는 폴링 예산 초과를 감지해 별도 상태로 노출(관리자가 "이 카메라는 프로파일 정보가 폴백값입니다" 식으로 인지 가능하게)하는 개선이 필요함.
3. 조사 과정에서 서버 로직(`mediasoupEngine.js`)에 임시로 추가했던 SDP 원문 디버그 로그(`SDP-DEBUG-BEGIN/SDP-DEBUG/SDP-DEBUG-END`)는 근본 원인 확정 후 제거함.

**§6.27 재재보완 — "데이터 수신은 정상인데 Buffer만 주기적으로 900ms+" 최종 근본 원인: `jitterBufferTarget` 자기강화 피드백 루프 (2026-07-21)**: 위 두 가지 원인(ingest-daemon 다운, profileLevelId 캐시 고착)을 고친 뒤에도 사용자가 "데이터 수신은 아주 잘되는데 Buffer가 왜 주기적으로 900ms 이상 되는지" 재차 질문 — `BUFFER_SATURATED_TICKS_LIMIT`를 다시 추가했다가 재연결이 오히려 더 잦아지는(5~20초 간격) 부작용까지 실측되면서, 이번엔 임계값 튜닝이 아니라 로직 자체를 처음부터 재검증:

- **버그 메커니즘**: §6.27 상단에서 구현한 프로액티브 escalation은 `bufferMs`(브라우저의 실측 지터 버퍼 보유 시간)가 `BUFFER_MS_WARN`(100ms)만 넘어도 `jitterTargetMs`를 올리고, 그 값을 곧바로 `videoReceiver.jitterBufferTarget`에 써서 **브라우저에게 "최소 이만큼 프레임을 들고 있어라"고 직접 명령**한다. 문제는 그 다음 틱에 다시 읽는 `bufferMs` 자체가 `jitterBufferDelay/jitterBufferEmittedCount`(getStats())로, 즉 **우리가 방금 내린 명령의 결과를 그대로 반영**한다는 것 — "문제의 증거"로 쓰는 지표를 같은 코드가 직접 조작하고 있어 양성 피드백 루프가 성립한다. `JITTER_TARGET_STEP_UP_MS`(150~300ms/틱)가 `JITTER_TARGET_STEP_DOWN_MS`(30ms/틱)보다 5~10배 가파른 비대칭 때문에, 정상적인 지터 한 번(100ms 초과는 흔함)만으로도 3~4틱(15~20초) 만에 `JITTER_TARGET_MAX_MS`(1000ms) 상한까지 자동으로 폭주 — 실측된 "Buffer 900ms+ 주기적 반복"과 정확히 일치. 데이터 수신량과는 애초에 무관했던 것.
- **수정**: escalation 트리거에서 `bufferMs` 기반 조건(`bufferMs >= BUFFER_MS_BAD/WARN`)을 완전히 제거하고, 우리 코드가 직접 조작하지 않는 진짜 외부 신호인 `freezeDelta`(실제 디코더 프리즈 발생)와 `lossDeltaForAdapt`(실제 새 패킷 손실)만으로 escalate하도록 변경. `bufferMs`는 계속 표시/모니터링용으로만 사용(패널 표시, `BUFFER_SATURATED_TICKS_LIMIT` 판정의 보조 조건). `jitterTargetMs`가 상한에 도달하는 경우도 이제 반복된 "진짜" freeze/loss 없이는 불가능해져, `BUFFER_SATURATED_TICKS_LIMIT` 프로액티브 재연결도 자기 자신이 만든 상황이 아닌 진짜 위기에만 반응하게 됨.
- **검증**: `npx tsc --noEmit`/`npm run build` 클린 통과. 클라이언트 전용 변경이라 서버 재시작 불필요, 브라우저 새로고침만으로 반영.
- 별개로 이번 라운드에서 Node.js 이벤트 루프 지연 모니터(`server/src/utils/eventLoopLag.js`, 200ms 이상 블로킹 시 `[EventLoopLag]` 로그)를 신규 추가 — 완전히 무관한 스트림들이 밀리초 단위로 동시에 끊기는 잔여 패턴의 원인 후보(Node 이벤트 루프 vs mediasoup worker vs ingest-daemon GIL) 중 하나를 실측으로 배제/확정하기 위함이며, 실제로 233ms/217ms 블로킹이 관측됨(경미하나 실재).

**§6.27 재재재보완 — `profile-level-id=42e01f`가 재연결마다 무작위로 재발하는 진짜 원인: `negotiate()`의 단발성 video-params 조회 (2026-07-21)**: v1.40에서 `POST /stream/reconnect`로 프로파일 캐시를 `640032`(High Profile)로 고쳤는데도, 사용자가 이후 여러 번의 ICE 패널 스크린샷에서 `profile-level-id=42e01f`(Baseline)이 다시 나타나는 것을 확인 — 재연결할 때마다 결과가 랜덤하게 좋았다 나빴다 하는 패턴이었음. 로그에서 `video-params not available yet (ready=undefined)` 경고가 **하루 133회** 발견되어 원인 확정:
- `negotiate()`는 WHEP 재협상(재연결)이 일어날 때마다 매번 `_ingestGetVideoParams()`를 **재시도 없이, 2초 타임아웃 한 번만 걸고** 직접 호출해 ingest-daemon으로부터 카메라의 실제 `profileLevelId`/`spropParameterSets`를 가져온다(`addCameraStream()` 시점 1회 캐싱이라는 이전 v1.40의 이해는 부정확했음 — 실제로는 negotiate()마다 매번 fresh fetch). ingest-daemon이 여러 카메라의 RTSP/AI/mux를 동시 처리하느라 바쁠 때(250%+ CPU 실측) 이 2초 안에 응답하지 못하면 그 요청은 실패 처리되고, `_buildAnswer()`가 Producer의 하드코딩된 Baseline(`42e01f`) 기본값으로 조용히 폴백한다. 재연결이 잦을수록(다른 미해결 원인으로 인해) 이 실패 확률도 비례해서 누적되는 악순환.
- **수정**: `_lastKnownVideoParams`(cameraId → 마지막 성공값) 모듈 레벨 캐시 추가. `negotiate()`의 fetch가 성공하면 캐시를 갱신하고, 실패하면 Baseline 기본값이 아니라 **캐시된 마지막 성공값**으로 폴백 — 카메라의 실제 인코더 프로파일은 재연결 사이에 바뀌지 않으므로, 한 번이라도 성공적으로 알아낸 값을 일시적 fetch 실패 때문에 버릴 이유가 없음. `addCameraStream()`의 기존 H.265 진단용 `_pollVideoCodec()`(5초 예산, 재시도 있음)도 성공 시 같은 캐시를 선제적으로 채워, 카메라 파이프라인 시작 직후 첫 negotiate()부터 캐시가 이미 따뜻한 상태가 되도록 함. `removeCameraStream()`에서 카메라 삭제 시 캐시도 함께 정리.
- **검증 예정**: 서버 재시작 후 재연결이 반복돼도 `profile-level-id`가 더 이상 `42e01f`로 되돌아가지 않는지 확인 필요.

### 6.28 카메라별 Pause/Resume — RTSP/YouTube 수집 연결 일시정지 (2026-07-21, 신규 기능)

**요구사항**: Streaming Dashboard 사이드바에서 개별 카메라의 RTSP(ingest-daemon)·YouTube(yt-dlp/ffmpeg) 수집 연결을 카메라 레코드/`channelSlot`을 유지한 채 일시정지·재개할 수 있어야 함(대역폭/CPU 절약, 계획된 점검 등). UI 반영은 `Design_Channel_Slot.md` §5.3b 참고.

**설계 제약 — 진짜 "freeze"가 아니라 "재연결 가능한 완전 정지"**: `ingest_daemon.py`의 `CameraManager`는 `add()`/`remove()`만 제공하며, RTSP 세션(io/AI decode/RTP mux/App RTP 스레드)을 유지한 채 콜백만 멈추는 중간 상태가 없다(`CameraSession.stop()`이 전체 스레드를 종료하는 것이 유일한 정지 경로, §11 Graceful Shutdown과 동일 메커니즘). 따라서 Pause는 daemon 레벨에 새 프리미티브를 추가하지 않고, **기존 `stopCamera()`/`_ingestRemoveCamera()` 경로를 그대로 재사용해 완전히 연결을 끊되, DB `status`를 `'offline'`이 아닌 `'paused'`로 남겨** "의도된 정지"와 "장애로 인한 오프라인"을 구분하는 방식으로 구현함. 카메라 설정(자격증명, `channelSlot`, 구역 등)은 전혀 건드리지 않음 — Delete와 달리 DB 레코드가 삭제되지 않는다.

**백엔드 구현**:
- `pipelineManager.js`에 `pauseCamera(cameraId)` 추가 — 기존 `stopCamera(cameraId)`(ingest-daemon 등록 해제, MediaMTX/mediasoup 정리, `_pipelines` 맵에서 제거)를 호출한 뒤 `_updateCameraStatus(cameraId, 'paused')`로 최종 상태만 덮어씀. 파이프라인이 이미 없는 카메라(예: 이미 `error`/`offline`)에 호출해도 `stopCamera()`가 no-op이라 안전(멱등).
- Resume은 별도 메서드 없이 기존 `startCamera(camera)`를 그대로 재사용(상태 필드를 사전에 검사하지 않으므로 `'paused'`에서의 재시작에 특별한 처리 불필요).
- `pipelineManager.updateCameraStatus(cameraId, status)` — 기존 private `_updateCameraStatus()`(DB 기록 + `camera:status` 소켓 브로드캐스트)의 public 래퍼. YouTube 카메라처럼 이 매니저가 소유하지 않는 연결(yt-dlp/ffmpeg)의 상태를 동일한 DB+소켓 경로로 반영해야 하는 다른 서비스를 위해 추가.
- **YouTube 카메라** (`youtubeStreamService.js`): YouTube 가상 카메라는 ingest-daemon이 다루지 않고(§6.1, MediaMTX `/yt/<id>` 경로로 발행), yt-dlp/ffmpeg 프로세스가 실제 "연결"이다. `pauseStream(id)`/`resumeStream(id)`를 신규 추가 — 기존 `restartStream()`이 쓰던 `_stopEntry(entry, false)`(DB 레코드는 삭제하지 않고 yt-dlp→ffmpeg 프로세스 트리 + `pipelineManager.stopCamera()`까지만 정리)를 그대로 재사용하되, 즉시 재시작하는 대신 `status='paused'`로 멈춰두고 `pipelineManager.updateCameraStatus(id, 'paused')`로 최종 상태를 덮어씀(그렇지 않으면 `_stopEntry` 내부의 `pipelineManager.stopCamera()`가 이미 브로드캐스트한 `'offline'`이 마지막 상태로 남음). Resume은 `restartStream()`과 동일하게 `_startStream(entry)`를 재호출.
- **서버 재시작 시 자동복원 예외 처리**: `index.js`의 부트 시 전체 카메라 자동시작 루프(§6.6과 무관, 서버 기동 직후 5초 지연 후 `db.find('cameras', {})` 전체를 순회하며 `startCamera()` 호출하는 기존 로직)와 `youtubeStreamService.init()`의 YouTube 스트림 자동시작(2초 지연) 양쪽 모두 `camera.status === 'paused'`인 레코드를 건너뛰도록 수정 — 그렇지 않으면 일시정지가 서버 재시작 한 번으로 무효화됨. `youtubeStreamService.init()`은 기존에 모든 YouTube 카메라의 `status`를 무조건 `'offline'`으로 리셋했는데(프로세스가 재시작으로 사라졌다는 전제), 이 리셋이 `'paused'`를 함께 지워버리지 않도록 복원 시점에 `cam.status === 'paused'`인 경우만 예외적으로 유지하도록 수정.

**API**:

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/cameras/:id/stream/pause` | RTSP는 `pipelineManager.pauseCamera()`, YouTube(`camera.type === 'youtube'`)는 `youtubeStreamService.pauseStream()` 호출 |
| POST | `/api/cameras/:id/stream/resume` | RTSP는 `pipelineManager.startCamera()`, YouTube는 `youtubeStreamService.resumeStream()` 호출 |

**알려진 한계**: `PUT /api/cameras/:id`가 `rtspUrl`/자격증명/`webrtcEnabled`/`webrtcVideoOnly` 변경 시 파이프라인을 자동 재시작하는 기존 동작(CLAUDE.md API 표 참고)은 일시정지 상태를 인지하지 않음 — 일시정지된 카메라를 편집해 이 필드들을 바꾸면 의도치 않게 재개(resume)된다. 별도 이슈로 후속 처리 필요.

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

### 6.29 Graceful Shutdown 행 & mediasoup Worker IPC 무한 대기 — 강제 SIGKILL 근본 수정 (2026-07-21)

#### 6.29.1 증상

`npm run stop`(→ `stopServer.js`)이 SIGTERM 전송 후 10초 내에 프로세스가 종료되지 않아 매번 외부 SIGKILL로 강제 종료해야 했다. 사용자가 이를 "임시방편이 아닌 근본 수정"으로 명시 요청.

#### 6.29.2 근본 원인 — 워치독 등록 순서 버그

`index.js`의 `shutdown()` 핸들러가 강제종료 워치독 `setTimeout`을 `await pipelineManager.stopAll()` 등 잠재적으로 행(hang)할 수 있는 호출들 **뒤에** 등록하고 있었다:

```js
// 수정 전 — 워치독이 await 뒤에 있어, await 자체가 멎으면 워치독도 영원히 등록 안 됨
const shutdown = async (signal) => {
  await youtubeSvc.stopAll();
  await pipelineManager.stopAll();   // 이 await가 멎으면 아래 setTimeout은 코드 도달 자체를 못함
  const forceExitTimer = setTimeout(() => process.exit(1), 10000);
  ...
};
```

`pipelineManager.stopAll()`은 내부적으로 mediasoup Producer/Consumer/Transport의 `.close()`를 호출하며, 이는 §6.29.3의 Worker IPC 채널을 거친다 — 그 채널이 멎어 있으면 `await`가 resolve도 reject도 하지 않고 영원히 대기하며, 함수는 워치독을 등록하는 코드 줄에 영영 도달하지 못한다. 즉 `stopServer.js`의 외부 10초 타임아웃 SIGKILL이 사실상 유일한 안전망이었다.

**수정**: 워치독을 함수 최상단, 어떤 `await`보다도 먼저 무조건 등록.

```js
const shutdown = async (signal) => {
  console.log(`\n[Server] Received ${signal} — shutting down gracefully…`);
  const forceExitTimer = setTimeout(() => {
    console.error('[Server] Graceful shutdown did not complete in time — forcing exit');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();
  try {
    await youtubeSvc.stopAll();
    await pipelineManager.stopAll();
    io.close();
    flushNow();
    httpServer.close(() => { db.close(); clearTimeout(forceExitTimer); process.exit(0); });
  } catch (err) {
    console.error('[Server] Error during shutdown:', err);
    process.exit(1);
  }
};
```

실측 검증: SIGTERM 전송 후 2~7초 내 `[Server] HTTPS server closed` 로그와 함께 정상 종료(`kill -0`로 확인), 외부 SIGKILL 불필요.

#### 6.29.3 관련 근본 원인 — mediasoup Worker IPC 무한 대기 (`getProducerStats()`)

`/api/webrtc/monitor`가 사용하는 `getProducerStats()`가 완전히 새로 재시작한 직후에도(누적 다중 시간 상태 문제가 아님) 무한 대기하는 것을 확인 — mediasoup Worker(Node ↔ C++ 자식 프로세스) IPC 채널이 멎으면 `await producer.getStats()`가 **resolve도 reject도 하지 않아** `try/catch`가 무력화된다. 이는 §6.29.2의 shutdown 행과 동일한 근본 메커니즘(Worker IPC 정체)일 가능성이 높다.

**수정**: 모든 mediasoup `getStats()` 호출(`videoProducer`/`audioProducer`/`videoConsumer`/`audioPlain`)을 `Promise.race` 기반 `_withIpcTimeout()`(3초)로 감싸, 카메라 1개의 IPC 정체가 엔드포인트 전체를 막지 못하도록 함:

```js
const WORKER_IPC_TIMEOUT_MS = 3000;
function _withIpcTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${WORKER_IPC_TIMEOUT_MS}ms (worker IPC stall)`)), WORKER_IPC_TIMEOUT_MS)),
  ]);
}
```

실측: 활성 카메라 다수 상태에서 `/api/webrtc/monitor` 응답 시간 ~50ms(이전엔 무한 대기, `curl --max-time`으로 확인 시 exit code 28 타임아웃).

**미해결**: Worker IPC 채널이 애초에 왜 멎는지(신선한 재시작에서도 재현)는 이번 세션에서 원인을 확정하지 못했다 — 타임아웃 가드는 증상(무한 대기)을 막을 뿐, 채널 정체 자체의 근본 원인은 후속 조사 과제로 남는다.

#### 6.29.5 진짜 근본 원인 — ingest-daemon HTTP API가 살아있는 채로 완전히 응답 불능 상태에 빠짐

§6.29.1~6.29.4까지의 수정을 전부 반영한 뒤에도 서버 재시작 직후 WebRTC 카메라 3대 전부가 `addCameraStream POST /cameras timed out after 8000ms`로 3회 재시도 모두 실패해 `useWebRTC=false`로 폴백되는 것이 재현되었고, 26분이 지나도 자연 복구되지 않았다(기존에는 이 상태를 벗어날 자동 경로가 전혀 없었음 — §6.29.6 참고). 원인을 추적한 결과:

- `ps aux`에는 `ingest_daemon.py` 프로세스가 살아있고 CPU도 소모 중이었으나(200~250%), `curl http://127.0.0.1:7070/health`와 `/cameras` 모두 **응답 없이 무한 대기** — 데몬이 죽은 게 아니라 자기 자신의 HTTP API에 전혀 응답 못 하는 상태.
- 사용자가 실제로 확인: 대시보드가 아닌 ingest-daemon 자체 채널 상태 화면에서 "모든 채널이 노란색(미연결)"으로 표시됨 — Node 쪽 증상(등록 타임아웃, WebRTC 비활성 폴백)과 정확히 같은 시각에 발생.
- `npm run ingest:restart`로 재시작 시도 시, SIGTERM에 8초간 응답이 없어 스크립트가 자동으로 SIGKILL로 강제 종료해야 했음 — 정상 종료 신호에도 응답 못 할 만큼 완전히 멎어 있었다는 추가 증거.
- 새 데몬(신선한 프로세스)으로 교체 후 `/health`가 즉시 응답, 9개 카메라 전부 정상 재등록, WebRTC self-heal 스윕(§6.29.6)이 30초 안에 나머지 카메라를 수동 개입 없이 자동 복구.

CPython GIL 경합(다중 카메라의 PyAV 디코드 스레드가 HTTP 서버 스레드를 계속 밀어냄)이 유력한 메커니즘으로 의심되나, 이번 세션에서 `ingest_daemon.py` 내부까지는 프로파일링하지 못했다 — py-spy로 확인하려면 `ptrace_scope=1` 때문에 root 권한이 필요해 차단됨(§6.29.7 참고). 근본적인 Python 쪽 수정(HTTP 서버를 별도 프로세스/스레드풀로 분리 등)은 후속 과제로 남는다.
> **(2026-07-24) §6.37에서 py-spy 없이 격리 실험으로 확정**: PyAV RTSP `mux()`(디코드가 아니라 카메라 fan-out의 네트워크 쓰기)가 블로킹 동안 GIL을 놓지 않음을 실측 — 여기서 의심한 "디코드 스레드가 HTTP 서버를 밀어낸다"는 메커니즘 자체는 디코드가 아니라 **쓰기(mux)** 쪽이 원인이었을 가능성이 높음(디코드/읽기 쪽은 §6.8 각주에서 이미 GIL 반환 정상 확인됨). `rtsp_publish_worker.py`로 mux를 별도 프로세스로 분리해 해결.

부수적으로, 같은 시간대에 사용자가 보고한 고해상도 열상 카메라(2560×1920, 2048×1536) 2대의 Buffer/Latency 급상승(991ms/2575ms)도 이 ingest-daemon 응답 불능 상태와 겹쳐 있었다 — RTP가 고르게 전달되지 못하고 버스트로 전달되면서 지터 버퍼가 누적됐을 가능성이 있으나, ingest-daemon 재시작 후 재현 여부는 사용자 확인 대기 중(미확정).

#### 6.29.6 WebRTC self-heal 스윕 — `useWebRTC=false` 영구 고착에 대한 자동 복구

`startCamera()`의 `addCameraStream()` 재시도 루프(3회, 2초 간격)가 실패하면 `ctx.useWebRTC=false`로 영구 폴백되는데, 기존 프레임 워치독(`ctx.frameWatchdogTimer`)은 AI 프레임 자체가 끊겼을 때만 발동해 이 케이스(캡처는 정상, mediasoup 등록만 실패)를 전혀 커버하지 못했다 — 수동으로 `/stream/reconnect`를 호출하기 전까지 26분 넘게 방치된 것을 실측으로 확인.

`pipelineManager.js`에 `_healWebRTCPipelines()`를 추가하고 `WEBRTC_ENGINE !== 'mediamtx'`일 때 30초 주기로 실행 — `ctx.running && ctx._requestedWebRTC && !ctx.useWebRTC`인 모든 파이프라인에 대해 카메라당 1회씩(동시에 몰아넣지 않고) `addCameraStream()`을 재시도하고, 성공 시 `ctx.useWebRTC=true`로 전환한다. `ctx` 리터럴에 `_requestedWebRTC`(카메라 설정이 원래 WebRTC를 원했는지, 이번 시도 성공 여부와 무관하게)를 추가해 `useWebRTC` 하나만으로는 구분 안 되던 "애초에 미설정" vs "재시도 소진 후 실패"를 구분했다. 실측 검증: ingest-daemon 재시작 직후 3대 카메라가 다시 3회 재시도 모두 실패했으나, 30초 뒤 self-heal 스윕이 수동 개입 없이 전부 자동 복구(`WebRTC self-heal: registration succeeded — re-enabled`).

#### 6.29.7 서버 재시작 시 등록 thundering herd

이번 세션에서 반복 재현: 서버가 카메라 7~9대를 부팅 시퀀스에서 거의 동시에 시작하면서, 각 카메라의 `addCameraStream()` POST가 수백 ms 이내에 전부 ingest-daemon에 몰리고(로그 타임스탬프 밀리초 단위로 겹침 확인), ingest-daemon이 이를 감당 못 해 8초 타임아웃이 카메라 전체에서 동시다발적으로 발생한다. §6.29.6의 self-heal 스윕이 사후 복구를 제공하지만, thundering herd 자체(등록 요청 간 지연 도입 등)를 완화하는 것은 범위 밖으로 남겨둔다 — ingest-daemon의 HTTP 응답성 자체가 더 근본적인 병목(§6.29.5)이므로, 등록 요청 스태거링만으로는 데몬이 이미 응답 불능 상태에 빠진 경우를 막지 못한다.

#### 6.29.4 관련 발견 — git submodule vs npm 설치 사본 drift

UDP 탐색 로그 스팸(`UdpResponse from ... { nMode=12, ... }` 콘솔 도배)이 이전 세션에서 "수정했다"고 기록되었음에도 재발했다. 원인: 이전 수정이 git submodule(`submodules/WiseNetChromeIPInstaller/nodejs/response.js`)에만 적용되었으나, `server/package.json`이 같은 저장소를 `"wisenet-chrome-ip-installer": "git+https://github.com/melchi45/WiseNetChromeIPInstaller.git#nodejs-udp-discovery"`로 **별도 고정**하고 있어, 런타임이 실제로 `require()`하는 것은 `node_modules/wisenet-chrome-ip-installer/`의 독립적인 npm 설치 사본이었다 — submodule 체크아웃과는 완전히 별개이며, submodule 편집은 런타임에 어떤 영향도 주지 않는다.

**수정**: 처음엔 `node_modules` 사본에 동일 패치를 직접 적용했으나(임시방편), 확인 결과 submodule의 `nodejs-udp-discovery` 브랜치에는 이미 이 수정이 커밋·푸시되어 있었음(`7ac33e3 fix: stop UdpResponse.parse() from logging every raw packet`) — 즉 `node_modules` 사본만 그 커밋 이전 버전으로 뒤처져 있던 상태. 수동 패치를 버리고 `npm install wisenet-chrome-ip-installer@git+...#nodejs-udp-discovery`로 재설치해 정식 버전 사본으로 교체 완료. 이제 submodule과 `node_modules` 사본이 완전히 동일하며, 향후 `npm install`로도 드리프트 없음.

> **후속 (2026-08-10)**: `nodejs-udp-discovery` 브랜치가 upstream `master`에 머지되고 SUNAPI 와이어 포맷 모듈(`protocol.js`/`request.js`/`response.js`)이 Chrome 확장과 공유되는 `sunapi/`로 이동함에 따라, `server/package.json`의 의존성 참조를 `#master`로 전환하고 재설치했다(루트 `files`는 `["nodejs", "sunapi"]`로 확장됨). 서버 소비 서브패스는 `wisenet-chrome-ip-installer/nodejs/udpDiscovery` 하나뿐이라 경로 변경 없음 — parity 테스트(TC-H-028/029/032/034) 및 라이브 탐색(84대, nMode=12 왕복)으로 검증 완료.

#### 6.29.9 ingest-daemon 자동 재시작 워치독

§6.29.5의 ingest-daemon 응답 불능이 일회성이 아니라 **반복 재발**함을 실측으로 확인 — 첫 발생 후 `npm run ingest:restart`로 복구했으나, 새로 뜬 데몬(신선한 프로세스)이 정확히 55분 뒤 동일 증상(`/health` 무응답, SIGTERM 무응답으로 SIGKILL 필요)으로 다시 멎었다. 프로세스 재시작 직후부터 재발한다는 것은 "누적된 낡은 상태" 때문이 아니라 **가동 시간에 비례해 커지는 근본적 리소스 문제**(메모리/스레드/커넥션 누수 등, §6.29.5의 GIL 경합 가설과 별개로 검증 필요)임을 시사한다.

매번 사용자가 증상을 보고해야만 복구되는 상황을 없애기 위해 `server/src/utils/ingestDaemonWatchdog.js` 신규 추가 — `index.js`의 `main()`에서 `CAPTURE_BACKEND=ingest-daemon`일 때 기동:

- 20초 간격으로 `GET /health`를 3초 타임아웃으로 폴링 (타임아웃 발생 시 데몬이 멎어있다는 뜻이므로 짧게 설정)
- 연속 2회(약 40초) 실패 시 `restartIngestDaemon.js`를 자식 프로세스로 spawn — 기존 검증된 크로스플랫폼 포트 종료·재기동·카메라 재등록 로직을 그대로 재사용(재구현하지 않음, 로직 drift 방지)
- 재시작 직후 90초 쿨다운 — 재시작 자체가 ~10초 걸리고 카메라 재등록도 시간이 필요하므로, 그 사이 또 실패로 오인해 재시작을 연타하지 않도록 함
- 서버 부팅 직후 30초 유예 — 데몬이 정상적으로 포트 바인딩 중인 것을 응답 불능으로 오인하지 않도록 함

이 워치독은 증상(응답 불능)을 자동 복구할 뿐, §6.29.5에서 남겨둔 근본 원인(왜 반복적으로 멎는지)은 여전히 미해결이다 — py-spy 프로파일링이 가능해지면 다음 우선 조사 대상.

**배포 중 발견된 버그**: 최초 배포판은 `spawn(process.execPath, [scriptPath], ...)`로 재시작 스크립트를 실행했으나, 이 호스트에서는 `process.execPath`가 이 환경 전용 glibc-호환 로더 바이너리(`ld-linux-x86-64.so.2`) 자체로 resolve되어(`ps aux`로 실행 중인 프로세스가 `ld-linux-x86-64.so.2 --library-path ... node-24_15_0 src/index.js` 형태임을 확인) `--library-path`/`node-24_15_0` 인자 없이 스크립트 경로만 넘기면 로더가 `.js` 파일 자체를 ELF 바이너리로 실행하려다 실패(`invalid ELF header`)했다. 실측으로 확인(워치독이 정상적으로 응답 불능을 감지했으나 복구 spawn이 매번 실패). `process.execPath` 대신 PATH 기반 `'node'` 문자열로 spawn하도록 수정 — `~/.local/bin/node`의 래퍼 스크립트가 올바른 인자로 재실행해주며, `npm run ingest:restart`가 이미 쓰는 것과 동일한 경로.

#### 6.29.10 Streaming Dashboard 상태 배지 — ingest-daemon / Analysis 서버 연결 표시

§6.29.5~6.29.9의 ingest-daemon 응답 불능 사건들은 지금까지 전부 WebRTC 재생 실패·재연결 루프 같은 **간접 증상**으로만 발견되었다 — 사용자가 매번 직접 원인을 추적해야 했다. 대시보드에서 바로 확인 가능하도록 Channel Group nav(하단 중앙 바) 우측에 상태 배지 2종 추가:

- **Ingest-Daemon**: `GET /api/ingest-status`(신규, `index.js`) — `ingestDaemonWatchdog.js`의 `fetchIngestDaemonHealth()`를 그대로 재사용해 데몬 `/health`를 확인, watchdog이 "정상"으로 판단하는 것과 정확히 같은 기준으로 표시(로직 이중화 없음). `CAPTURE_BACKEND≠ingest-daemon`이면 배지 자체를 숨김.
- **Analysis**: 기존 `GET /api/analysis/client-status`(streaming 모드 전용) 재사용, 신규 엔드포인트 없음.

두 상태 모두 초록/빨강 점 + 5초 폴링, hover 시 카메라 등록 수·circuit breaker 상태·에러 메시지 등 상세 정보 툴팁 표시. `DashboardDetectionPanel.tsx`에 있던 `useAnalysisClientStatus` 훅 정의를 `client/src/hooks/useSystemStatus.ts`로 추출해 `SystemStatusBadges.tsx`와 함께 공유하도록 리팩터링(중복 정의 제거).

#### 6.29.11 Analysis 서버 좀비 채널 (1) — `_metrics.perCamera` 만료 로직 누락

사용자가 Analysis 서버 대시보드에서 `tc009-cam-alpha`/`tc009-cam-beta`/`test-cam-distributed`라는 정체불명 채널을 발견해 원인·방지책 조사를 요청. 소스를 추적한 결과 `test/api/distributed_pipeline.test.js`의 TC-DAP-005("analysis frame response includes detectedFaces")·TC-DAP-009("다중 채널 동시 추론 시 cameraId 격리 (FR-DAP-027)")가 원인 — 이 테스트들은 카메라별 상태 격리(cross-channel contamination 없음)를 검증하는 게 목적이라, **`POST /api/cameras`로 카메라를 등록하지 않고** `POST /api/analysis/frame`의 body에 임의의 `cameraId: 'tc009-cam-alpha'` 문자열만 실어 보낸다. 즉 이 cameraId들은 애초에 DB에 Camera 레코드가 존재한 적이 없어 `DELETE /api/cameras/:id`로 지울 대상 자체가 없다 — "삭제가 안 되는 버그"가 아니라 "삭제할 것이 없는" 상태.

`analysisApi.js`의 `/frame` 핸들러는 받은 cameraId를 검증 없이 그대로 `_getOrCreateContext()`/`_getCameraMetric()`에 넘겨 lazy하게 상태를 생성한다:
- `_cameraContexts`(tracker/behavior 상태) — `ctx.lastSeenAt` 기준 5분(`CONTEXT_EXPIRY_MS`) idle 시 60초 주기 인터벌이 이미 자동 삭제하고 있었음(정상 동작).
- `_metrics.perCamera`(프레임 수·바이트·감지 수 등 카운터) — **동일 인터벌에 포함되어 있지 않아 만료 로직이 전혀 없었음**. `/api/analysis/metrics`의 `cameras` 배열 자체는 `_cameraContexts`를 순회해 만들어지므로 5분 후엔 목록에서 빠지지만(사용자가 실제로 다시 확인했을 때 이미 사라져 있었던 이유), `_metrics.perCamera`는 프로세스가 살아있는 한 계속 누적되는 별개의 메모리 누수였다.

**수정**: 기존 `_cameraContexts` 60초 프루닝 인터벌에 `_metrics.perCamera`도 함께 정리하도록 편입 — `metric.lastFrameAt`(모든 `/frame` 요청이 이미 갱신하는 필드) 기준 `CONTEXT_EXPIRY_MS` 초과 시 삭제.

원격 Analysis 서버(192.168.214.254)를 직접 조회해 검증: 조사 시점에 이미 uptime ~15분으로 최근 재시작된 상태였고, `/api/analysis/metrics`·`/api/analysis/detection-tracks`(무필터 500건)·`/api/analysis/events`(무필터 500건) 어디에도 해당 cameraId가 없어 DB에 영속화된 흔적은 없음을 확인 — 순수 in-memory 아티팩트였다는 진단을 뒷받침.

#### 6.29.12 Streaming 서버 카메라 삭제 정합성 점검 — 두 가지 관련 결함 발견·수정

사용자의 추가 요청("Streaming 서버에서 채널 삭제가 정상적으로 이루어지는지 확인")에 따라 `DELETE /api/cameras/:id` 전체 경로(`cameras.js` → `pipelineManager.stopCamera()` → ingest-daemon/mediasoup/mediamtx)를 점검, 별개의 결함 2건 발견:

**(1) `pipelineManager.stopCamera()`의 조기 반환** — 함수 최상단이 `const ctx = this._pipelines.get(cameraId); if (!ctx) return;`였다. 즉 **이 Node 프로세스가 현재 그 카메라의 in-memory 파이프라인을 들고 있지 않으면 ingest-daemon/mediasoup/mediamtx 정리를 전혀 시도하지 않고 그냥 리턴**한다 — `_ingestRemoveCamera()`도, `getWebRTCEngine().removeCameraStream()`도 호출되지 않는다. `ctx`가 없는 상황은 드물지 않다: 카메라가 `paused`/`error` 상태로 멈춰있거나, 서버가 재시작된 뒤 해당 카메라가 아직 auto-start 되지 않았거나, `startCamera()`가 실패로 끝난 직후 등. 이런 카메라를 삭제하면 DB 레코드만 사라지고 ingest-daemon(과거 세션에 등록되어 있었다면) 쪽 레지스트리에는 좀비 항목이 남을 수 있다 — §6.29.5~6.29.9에서 다룬 ingest-daemon 좀비 채널의 또 다른 발생 경로.

**수정**: ctx 유무와 무관하게 ingest-daemon/mediasoup/mediamtx 정리를 항상 시도하도록 재구성 — ctx가 있을 때만 필요한 부분(타이머 해제, capture.stop(), behavior 리셋 등 in-memory 상태 정리)만 조건부로 남기고, 외부 시스템 정리 3종(`Promise.allSettled`)은 무조건 실행. 각 정리 함수(`_ingestRemoveCamera`, `removeCameraStream`, `mediamtxManager.removeCameraPath`)가 이미 "등록된 게 없으면 안전하게 no-op"하도록 짜여 있음을 코드 추적으로 확인했으므로 부작용 없음.

**(2) Analysis 서버로의 삭제 통지 부재** — `DELETE /api/cameras/:id`는 로컬 DB·ingest-daemon·mediasoup만 정리할 뿐, 원격 Analysis 서버에는 "이 카메라가 삭제됐다"는 사실을 전혀 알리지 않았다. 등록·기동이 정상이었던 카메라를 정상적으로 삭제해도, Analysis 서버 쪽 `_cameraContexts`/`_metrics.perCamera`는 §6.29.11의 5분 idle-prune이 돌 때까지 그대로 남아있었다 — TC 테스트 아티팩트와는 별개로, **실제 운영 카메라를 지워도 최대 5분간 Analysis 대시보드에 유령처럼 남는** gap.

**수정**: Analysis 서버에 `POST /api/analysis/camera-removed`(신규, `analysisApi.js`) 추가 — `{cameraId}`를 받아 `_cameraContexts`/`_metrics.perCamera`에서 즉시 삭제. `cameras.js`의 `DELETE /api/cameras/:id` 성공 시(streaming 모드 + `ANALYSIS_SERVER_URL` 설정된 경우) fire-and-forget으로 호출 — `faceSearchSync.js`가 이미 쓰고 있는 streaming→analysis 푸시 패턴(짧은 타임아웃, 실패해도 호출자 안 막음, warn만) 그대로 재사용.

**배포 중 발견된 버그**: 최초 구현은 Node 내장 `fetch()`를 사용했는데, 실측 결과 "fetch failed"로 매번 실패했다 — 이 배포 환경의 self-signed HTTPS 인증서를 `fetch()`(undici)가 기본적으로 검증하며, 호출 단위로 `rejectUnauthorized:false`를 줄 방법이 없기 때문. `faceSearchSync.js`가 이미 같은 문제를 `https.Agent({rejectUnauthorized:false})`로 해결해 놓았음을 확인하고 동일하게 `http`/`https` 모듈 직접 사용으로 교체 — 재검증 결과 실제 HTTP 상태 코드(404 — 아직 원격 서버가 이 커밋을 받지 못해 신규 엔드포인트가 없음)까지 정상적으로 받아오는 것을 확인했다.

**주의**: 이 통지가 실제로 Analysis 서버의 상태를 정리하려면 **그 원격 서버(192.168.214.254) 자신도 이 커밋을 pull하고 재시작해야** 한다 — 이 세션은 Streaming 서버 호스트에서만 실행되어 원격 서버를 직접 재시작할 수 없었으므로, 배포 전까지는 fire-and-forget 호출이 404로 무해하게 실패하고 기존의 5분 idle-prune으로만 정리된다(회귀 없음, 순수 개선 대기 상태).

#### 6.29.13 오늘 세션의 반복 재시작이 유발한 고아 TC 테스트 카메라 14건 정리

위 조사 도중 발견: 서버는 부팅 시 `TcRunnerService.runOnStartup()`이 30초 뒤 43개 TC 스위트를 자동 실행한다(Admin Dashboard Audit 패널용). `camera_discovery.test.js`(TC-B/TC-A 그룹)처럼 실제로 `POST /api/cameras`를 호출하는 스위트는 `main()` 맨 끝의 `cleanupAll()`에서 일괄 정리하는 구조라, **런 전체가 끝까지 실행돼야** 정리된다. 오늘 세션에서 WebRTC/ingest-daemon 문제를 조사하며 서버를 십수 차례 재시작했는데, 그때마다 진행 중이던 TC 자동 실행이 `cleanupAll()`에 도달하기 전에 중단되어 `TC-B-001 Cam`, `TC-B-005 Del`, `TC-A-003-CamA` 등 이름의 카메라 레코드 14건이 DB에 고아로 쌓여 있었다(RTSP URL이 전부 `10.0.0.x`/`192.0.2.x` TEST-NET(RFC 5737) 대역이라 실제 카메라일 수 없음으로 확인). 사용자 확인 후 전부 삭제해 카메라 목록을 정상 8대로 복원.

**예방**: `server/.env`에 `TC_STARTUP_RUN=false`를 설정하면 부팅 시 자동 TC 실행 자체를 끌 수 있다 — 서버를 빈번히 재시작해야 하는 활성 디버깅 세션에서는 임시로 꺼두는 것을 권장(작업 종료 후 원복). `.claude/skills/api-testing/SKILL.md`(+`.github` 동일본)에 이 패턴과 고아 레코드 식별 기준(이름 `TC-*` 접두사 + TEST-NET RTSP URL)을 기록해 재발 시 빠르게 식별·정리할 수 있도록 했다.

#### 6.29.14 v1.48 배포 직후 "모든 채널 0fps" 긴급 사태 — TC 자동 실행이 라이브 트래픽과 자원 경쟁

§6.29.13 정리 직후, 사용자가 "현재 WebRTC의 모든 채널이 0fps, 0decoded"라고 긴급 보고. 확인 결과 ingest-daemon에 **34개** 카메라가 등록되어 있었다(정상은 8~9개) — §6.29.13에서 이미 진단한 "TC 자동 실행이 재시작으로 중단되며 고아 카메라를 남긴다"는 문제가, 이번엔 재시작 없이 **자동 실행이 끝까지 완주하며 라이브로 카메라를 생성**한 케이스였다. 매 서버 부팅마다 30초 뒤 시작되는 43개 스위트가 실제 카메라 8~9대와 자원을 놓고 경쟁하면서 ingest-daemon 응답성이 전면적으로 저하되어 모든 채널이 동시에 죽었다.

**즉시 조치**: `server/.env`에 `TC_STARTUP_RUN=false` 추가(§6.29.13에서 이미 확인한 옵션을 실제 적용) → ingest-daemon·Node 재시작 → 잔여 테스트 카메라 26건 삭제 → 정상 8~9대로 복구.

이 복구 과정에서 사용자가 한 채널의 ICE 패널에 `profile-level-id=42e01f`(Baseline 폴백값)이 표시되는 것을 추가로 제보했다. `LTS_DEBUG_SDP2` 임시 플래그로 실제 negotiate() 시점의 `spropParameterSets`/`profileLevelId` 변수값과 생성된 SDP fmtp 라인을 직접 덤프해 대조한 결과, **재검증 시점의 코드는 정상**(변수도 올바르고 SDP도 `profile-level-id=640032`로 정확히 생성됨)이었다 — 사용자가 관찰한 42e01f는 34-카메라 과부하가 절정이던 순간(13:54:33)에 맺어진 연결의 것으로, 그 연결은 이미 종료되고 새 연결로 교체된 뒤였다. 정확한 실패 메커니즘(어느 로그 분기를 탔는지)까지는 그 순간의 SDP 레벨 로그가 없어 완전히 재구성하지 못했으나, 시점상 같은 근본 원인(ingest-daemon 과부하)의 파생 증상으로 판단. 이 진단에 쓴 SDP 덤프 코드는 `LTS_DEBUG_SDP=true`(env)로 켜는 상시 진단 도구로 정리해 남겨두었다(재발 시 재추가할 필요 없음).

#### 6.29.15 진짜 데이터 유실 버그 확정 — `MongoDatabase.flushNow()` no-op

위 복구 도중 결정적으로 이상한 현상 발견: `DELETE /api/cameras/:id`로 방금 삭제한 테스트 카메라들이 다음 서버 재시작 후 **원래 생성 시각 그대로** 되살아났다. 추적 결과 `server/src/db/MongoDatabase.js`의 구조적 결함 확정:

- `delete(table, id)`는 **동기 함수** — in-memory `_store`에서 즉시 제거하고 `_persist('remove', ...)`를 호출한 뒤 바로 반환한다.
- `_persist()`는 `this._mongo.remove(table, id).catch(...)`를 **fire-and-forget**으로 던진다 — 반환된 Promise를 아무도 저장·추적하지 않는다.
- `flushNow()`는 `// MongoDB writes are async fire-and-forget — nothing to flush synchronously.`라는 주석과 함께 **완전한 no-op**이었다.
- `DELETE /api/cameras/:id`(`cameras.js`)는 `db.delete(...)`를 호출한 즉시(await 없이, 애초에 await할 Promise를 반환하지도 않음) `{success:true}`를 응답한다.

즉 클라이언트는 in-memory 제거가 끝난 시점에 "성공" 응답을 받지만, 그 뒤에 있는 실제 MongoDB 네트워크 왕복은 아직 진행 중일 수 있다 — 그리고 `index.js`의 graceful shutdown 핸들러가 부르는 `flushNow()`는 이 진행 중인 쓰기에 대해 아무것도 하지 않으므로, **삭제 응답을 받은 직후 서버가 재시작되면 그 삭제가 통째로 유실**되고 다음 부팅의 MongoDB 하이드레이션이 예전 레코드를 그대로 되살린다. 오늘 세션 내내 반복한 "API로 삭제 → 곧바로 다음 진단을 위해 재시작" 패턴이 정확히 이 조건을 매번 충족시키고 있었다 — TC 테스트 카메라 정리가 여러 차례 "되돌아오는" 것처럼 보였던 것도 전부 이 버그였다.

**수정**:
- `MongoDatabase` 생성자에 `_pendingWrites = new Set()` 추가.
- `_persist()`가 만든 write Promise를 `_pendingWrites`에 추가하고, settle 시(`.finally()`) 제거.
- `flushNow()`를 `async`로 변경 — `Promise.allSettled([...this._pendingWrites])`로 실제로 대기(개별 쓰기 실패는 이미 `_persist()`의 `.catch()`가 로그하므로 `allSettled` 사용 — 하나가 실패해도 shutdown이 멈추거나 reject되지 않음).
- `BaseDatabase.flushNow()`도 `async` 시그니처로 통일(JsonDatabase의 동기 구현은 그대로 — `await`되어도 무해).
- `db/index.js`의 export `flushNow()`도 `async function` + `await _db.flushNow()`로 변경.
- `index.js`의 shutdown 핸들러에서 `flushNow();` → `await flushNow();`로 변경.

**검증**: 동일 레이스 컨디션을 실측 재현 — 테스트 카메라 생성 → `DELETE` 호출("success":true 확인) → **지연 없이 즉시** `SIGTERM` 전송 → 재시작 → `GET /api/cameras/:id` 조회. 수정 전 로직이었다면 되살아났을 상황에서, 수정 후에는 `{"success":false,"error":"Camera not found"}` — 삭제가 재시작을 확실히 견뎌내는 것을 확인했다. 수정 배포 이전에 유실됐던 테스트 카메라 잔여분(4건)은 수정이 살아있는 상태에서 재삭제해 이번엔 영구히 정리됨을 재확인.

이 버그는 카메라 삭제에 국한되지 않는다 — `db.delete()`/`db.update()`를 쓰는 모든 테이블(zones, alerts, missing persons 등)이 동일한 유실 위험에 노출되어 있었다. `flushNow()` 수정으로 이 클래스의 데이터 유실 전체가 함께 닫혔다.

### 6.30 WebRTC 통계 패널의 "0fps 반복" — 실제 프리즈가 아니라 raw `framesPerSecond` 통계 표시 결함 (2026-07-22)

사용자가 5MP(2560×1920) 카메라에서 통계 패널에 "0fps"가 반복적으로 표시된다고 보고. 함께 제공된 스냅샷을 보면 `framesDecoded`가 1200으로 healthy하게 증가 중이고 `dropped=0`, `Rate ↓1.4Mbps`(데이터 계속 수신), `Buffer 139ms`/`Latency 140ms`(둘 다 `BAD` 임계치의 절반 이하), `RTT 1ms`, `Loss 1.8%` — 기존 스톨 워치독의 발동 조건(§6.20의 `FRAME_STALL_MS=20s` 프레임 정체, `BUFFER_SATURATED_TICKS_LIMIT`의 `bufferMs≥300ms` 2틱 연속)에는 전혀 해당하지 않는, 겉보기엔 건강한 연결 상태였다.

**근본 원인**: `useWebRTC.ts`의 `rateTimer`(1초 폴링)가 화면에 표시하는 `fps` 값으로 `RTCInboundRtpStreamStats.framesPerSecond`(브라우저가 내부적으로 계산하는 running average, 정확한 갱신 주기/윈도우는 스펙에 명시되지 않은 구현 종속 값)를 그대로 사용하고 있었다 — 이 폴링 주기(1s)와 브라우저 내부 계산 주기가 반드시 일치한다는 보장이 없어, 실제 디코딩은 정상 진행 중인데도 이 stat 자체가 0으로 깜빡이거나 고정되어 보일 수 있다. `bufferMs`가 이미 §buffer-oscillation(2026-07-21, §6.27)에서 동일한 클래스의 문제 — 원본 누적 카운터를 매 틱 순진하게 나누면 진동하는 값이 나옴 — 를 "직전 성공적으로 계산된 값을 이월"하는 방식으로 해결한 전례가 있다.

**수정**: `rtp.vFps`(raw stat) 대신, 이미 매 틱 추적 중인 `framesDecoded` 누적 카운터(`rtp.vFrames`)의 델타를 실제 경과 시간(`elapsed`)으로 나눠 자체 계산한 fps를 사용하도록 `client/src/hooks/useWebRTC.ts`의 `rateTimer` 콜백을 수정 — `ratePrevVideoFrames` 신규 추적 변수 추가, 첫 틱(비교 기준 없음)에서만 raw stat로 폴백. 브라우저의 내부 집계 주기와 무관하게 이 폴링 자체의 실측 프레임 처리율을 반영하므로, decode가 실제로는 정상인데 raw stat만 0을 보고하는 표시 결함을 제거한다.

**영향 범위**: 표시(display) 전용 수정 — 스톨 워치독·재연결 로직(`FRAME_STALL_MS`/`STALL_MS`/`bufferSaturatedTicks`)은 이미 `framesDecoded` 원본 카운터를 직접 비교하고 있어 이번 수정과 무관하게 그대로 유지됨. 즉 이번 건은 재연결 정책의 변경이 아니라 순수히 패널에 찍히는 숫자의 정확도 개선.

`npx tsc --noEmit`/`npm run build` 클린 통과.

#### 6.30.1 재현 확인 — 이번엔 진짜 프리즈, 그리고 재연결 워치독이 "재연결 폭풍" 상태로 이미 상시 작동 중이었음을 로그로 확정 (2026-07-22)

위 수정 배포 직후 사용자가 동일 카메라(2560×1920)에서 재차 보고: `framesDecoded`가 2949에서 완전히 고정, 반면 `Rate`(↓6.3Mbps)·`Speed`(2594kbps)는 계속 상승, `Buffer`/`Latency`/`RTT`/`Loss`도 함께 고정 — §6.30과 달리 이번엔 raw stat 표시 결함이 아니라 **디코더가 실제로 멈춘 상태**임을 다음 근거로 확정:
- `videoKbps`/`audioKbps`(따라서 Rate/Speed)는 `inbound-rtp`의 `bytesReceived` 델타로 계산됨 — 계속 오른다는 것은 RTP 패킷이 계속 도착 중이라는 뜻.
- `framesDecoded`가 안 오른다는 것은 그 패킷들을 디코더가 프레임으로 조립 못하고 있다는 뜻 — 전형적인 "참조하는 키프레임을 못 받은 P-프레임들"(mid-GOP join, `mediasoupEngine.js:1421-1424`의 기존 주석과 동일 클래스) 증상.
- `ingest_daemon.py` 전체를 재확인했으나 RTCP 수신/처리 코드가 전혀 없음 — 카메라→ingest-daemon→mediasoup은 RTP만 한 방향으로 릴레이하는 구조. 즉 브라우저가 디코드 실패 시 자동으로 보내는 RTCP PLI나 `mediasoupEngine.js:1427`의 `videoConsumer.requestKeyFrame()`이 만드는 PLI 모두, 실제 카메라(유일하게 새 키프레임을 만들 수 있는 주체)까지 도달할 경로가 아예 없음 — 구조적 한계.

사용자에게 "20~30초 후 자동 재연결되어 복구되는지"를 물었더니 "재연결 없이 계속 멈춰있다"는 답변 — 그런데 `GET /api/client-logs`로 실제 브라우저 콘솔 로그를 직접 조회한 결과는 그와 달랐다: 카메라 `61813f62`/`4e562747`와 YouTube 스트림 `yt-9bb39`에서 **78분간(01:13~02:31) 총 104건**의 `framesDecoded stuck at N ... reconnecting in 3s` 로그가 25~45초 간격으로 끊임없이 발생 중이었다 — 즉 §6.20의 프레임 스톨 워치독은 정상 작동하며 실제로 재연결을 계속 시도하고 있었다. 다만:
- `stuck at 0`이 절대다수(재연결 직후 다음 키프레임을 못 만나 즉시 재고착)이고, 드물게 `stuck at 26/201/671/2709`처럼 잠깐 디코딩에 성공했다가 다시 고착되는 경우가 섞여 있음 — 재연결이 카메라의 다음 예정 키프레임 타이밍과 우연히 맞아떨어질 때만 일시적으로 회복.
- `CameraView.tsx`는 `webrtcState==='connected'`일 때만 `<video>`를 표시하고, 재연결 중(`connecting`)엔 스피너로 잠깐 전환되지만 매번 수백ms~수초 내로 다시 `connected`로 넘어가 버려 사용자가 "재연결이 일어났다"고 인지하기 어렵고, 재연결 후에도 곧바로 다시 고착되는 경우가 대부분이라 체감상 "계속 멈춰있다"로 보이는 것 — 실제로는 초당 수준으로 빠르게 실패를 반복하는 폭풍 상태.

**결론**: 클라이언트 재연결 로직 자체는 결함이 아니다 — 근본 문제는 (1) 5MP 스트림의 손실률(5.3%)이 커서 키프레임 버스트가 자주 유실되고, (2) 유실된 키프레임을 복구할 RTCP PLI 경로가 이 파이프라인에 구조적으로 없어, 재연결이 사실상 "카메라의 다음 키프레임 타이밍에 운 좋게 걸리길 기다리는" 것 외에는 할 수 있는 게 없다는 점이다. 이는 §6.13/§6.17에 오래 남아있던 "고해상도 카메라 정지 구간 — 카메라측 인코더/대역폭 한계 추정" 미해결 항목의 정확한 메커니즘을 확정한 것이기도 하다.

**검토한 대응 방안** (사용자 결정 대기 — 각각 트레이드오프가 달라 코드만으로 결정할 사안이 아님):
- **(A) 카메라 자체의 키프레임 간격(GOP) 단축** — 카메라 관리자 설정(웹UI/ONVIF)에서 I-frame 주기를 짧게(예: 1~2초) 재설정. 코드 변경 없이 가장 근본적으로 유실 시 복구 윈도우를 줄이는 방법이지만, 대역폭 사용량이 늘고 카메라 접근 권한이 필요.
- **(B) `ingest_daemon.py`에 실제 RTCP PLI/FIR 포워딩 구현** — mediasoup Consumer의 키프레임 요청을 카메라의 RTSP/RTP 세션까지 실제로 전달. 근본적 수정이지만 신규 엔지니어링 범위가 크고, 카메라가 RTP/AVPF(RFC 4585) 피드백을 실제로 지원·반응하는지 사전 확인 없이는 성공을 보장할 수 없음.
- **(C) 클라이언트 상태 표시 개선** — 재연결이 실패를 반복하는 동안 마지막 프레임을 계속 보여주는 대신 "재연결 중" 상태를 더 명확히 노출(현재도 `connecting` 상태에 스피너가 있지만 전환이 너무 빨라 인지하기 어려움). 근본 수정은 아니지만 사용자가 실제 상태를 오인하지 않도록 함.

`npx tsc --noEmit`/`npm run build` 클린 통과(§6.30 자체 수정분). §6.30.1은 진단·근거 기록이며 신규 코드 변경 없음 — 대응 방안 선택은 후속 과제로 남김.

#### 6.30.2 실측으로 확정 — 손실이 "브라우저 쪽 네트워크"가 아니라 ingest-daemon→mediasoup 릴레이 파이프라인 안에서도 발생 중임을 직접 확인, 송신측 버퍼 대칭 수정 (2026-07-22)

사용자가 "RTSP에서는 I-frame을 정상 수신하고 있는데, WebRTC 파이프라인(ingest-daemon→mediasoup→클라이언트) 어딘가에서 프레임이 새는 것 아니냐"는 가설을 제기 — 라이브 호스트에서 직접 검증한 결과 사실로 확인됨:

- `/proc/net/snmp`의 `Udp: RcvbufErrors`를 15초 간격 두 번 샘플링 — 12,468,787 → 12,468,892 (15초간 105건, **초당 ~7건씩 지금도 계속 증가 중**). §6.18에서 고쳤던 것과 같은 클래스의 문제가 여전히 실시간으로 발생하고 있었음.
- `ss -u -a -n -p`로 mediasoup-worker(단일 프로세스) 자신의 UDP 소켓들을 직접 조회 — 여러 소켓의 Recv-Q(커널에 도착했지만 worker가 아직 못 읽은 바이트)가 **최대 3.8MB**까지 쌓여 있었고, 3초 뒤 재조회에도 여러 소켓이 수백KB~3MB대를 유지 — mediasoup-worker가 일부 소켓의 수신 속도를 실시간으로 못 따라가고 있다는 직접 증거. 큐가 소켓 버퍼 상한에 닿으면 그 이후 도착 패킷은 mediasoup가 보기도 전에 커널에서 드롭됨(=`RcvbufErrors`).
- 원인 후보: 이 서버는 `mediasoupEngine.js:252`의 `mediasoup.createWorker()` 호출이 코드 전체에 **단 1회**뿐 — 모든 카메라의 RTP 릴레이·WebRTC 트랜스포트가 하나의 싱글스레드 mediasoup-worker(C++ 프로세스)에 몰려있음. 실측 시점 worker 자체 CPU는 13~14%(호스트는 40코어, `mpstat` 유휴 80%)로 "CPU가 부족해서"는 아니고, 한 카메라(특히 5MP 키프레임처럼 짧은 시간에 대량 패킷이 몰리는 버스트)의 순간 처리가 다른 소켓 읽기를 지연시켜 큐가 쌓이는 구조적 병목으로 추정.
- 비대칭 발견: mediasoup 수신측(video/audio PlainTransport)은 이미 §6.18에서 `recvBufferSize: 8MB`로 키워져 있었지만, 그 반대편 송신자인 `ingest_daemon.py`의 `av.open("rtp://...", format="rtp", ...)` 호출(비디오 RTP 패스스루 2곳, 오디오 패스스루/트랜스코드 각 1곳, 총 4곳)에는 버퍼 크기 옵션이 전혀 없어 OS 기본값(`net.core.wmem_default` ≈ 208KB)을 그대로 쓰고 있었음.

**수정**: `ingest_daemon.py`에 `_RTP_SEND_BUFFER_SIZE = 8*1024*1024` 신규 상수 추가, 비디오/오디오 RTP 출력 4곳의 `av.open()` `options`에 `"buffer_size": str(_RTP_SEND_BUFFER_SIZE)`(ffmpeg `udp` 프로토콜 옵션 → 출력 소켓의 `SO_SNDBUF`) 추가 — `net.core.wmem_max`(16MB 실측)로 커널이 요청을 그대로 허용함을 확인. 옵션 키 유효성은 로컬 `av.open()` 스모크 테스트로 사전 확인, `ingest:restart`로 배포 후 모든 카메라 재등록 및 "Video RTP: ... ssrc=... pt=96" 로그 정상 확인, 에러 없음.

**미해결로 남기는 부분**: 이번 수정은 송신측 버퍼만 대칭으로 키운 것 — mediasoup-worker가 단일 스레드로 모든 카메라를 처리하는 구조적 병목(멀티 Worker 미사용, 40코어 중 1개만 활용) 자체는 그대로다. 사용자와 논의 후 이 구조적 병목은 별도 설계 문서(`docs/design/Design_Mediasoup_Multi_Worker.md`)로 분리해 다루기로 결정 — Producer/Consumer가 반드시 같은 Router에 있어야 하는 mediasoup 제약 때문에 카메라를 여러 Worker/Router에 분산시키려면 라우팅 구조 재설계가 필요해 스코프가 크다. **(2026-07-22 후속) 이 구조적 병목은 같은 날 실제로 구현 완료됨** — `mediasoupEngine.js`를 단일 `_worker`/`_router`에서 8개 Worker 풀(`MEDIASOUP_NUM_WORKERS`, 카메라 ID 해시 배정)로 전환, `npm run stop`/`start`로 배포·정상 복구 확인. 상세는 `Design_Mediasoup_Multi_Worker.md` v2.0 §6 참고.

또한 이 세션 중 사용자가 별도로 "Ctrl+Shift+R 강제 새로고침 후에도 Codec 정보가 `-`로 표시된다"고 보고 — 이 심볼톰 자체는 §6.27 v1.40 "최종 근본 원인 확정" 항목에 이미 `Codec: – / opus`로 한 차례 관찰·기록된 바 있고(원인: `profileLevelId` 캐시가 ingest-daemon 다운 중 Baseline 폴백으로 고착), 이번 세션의 새 가설(릴레이 구간 패킷 손실로 비디오 트랙에 패킷이 전혀 도착 못 해 `RTCStats` `codec` 리포트 자체가 안 생김)도 동일 증상을 설명할 수 있어 — 두 메커니즘 중 어느 쪽인지(혹은 둘 다인지) 이번 세션만으로는 확정하지 못했다. 마침 이번 §6.30.2 수정 배포를 위한 `ingest:restart`가 모든 카메라의 `addCameraStream()`을 새로 실행시켜 `profileLevelId` 캐시도 함께 새로고침됐으므로, 사용자가 다시 새로고침해 재현되는지 확인 필요 — 재현되면 릴레이 손실 쪽에, 재현 안 되면 캐시 고착 쪽에 무게가 실린다.

### 6.31 mediasoup 멀티 Worker 분리 — §6.30.2 구조적 병목의 실제 구현 (2026-07-22)

§6.30.2에서 실측 확정한 mediasoup 단일 Worker 병목을 사용자 요청으로 같은 날 구현. 상세 설계·옵션 비교·검증 결과는 `docs/design/Design_Mediasoup_Multi_Worker.md`(v2.0)에 전담 — 여기서는 요약만 남긴다.

- `mediasoupEngine.js`의 전역 `_worker`/`_router` 싱글턴을 `_workerPool[]`(Worker 풀, 기본 `min(os.cpus().length, 8)` = 8개, `MEDIASOUP_NUM_WORKERS`로 조정 가능)로 교체.
- 카메라는 `cameraId` 문자열 해시로 특정 Worker에 결정적으로 배정되고(`_cameras` 엔트리에 `workerIndex` 저장, negotiate() 등 이후 조회는 재해시하지 않고 저장값 사용 — Producer/Consumer가 같은 Router에 있어야 하는 mediasoup 제약 충족), §6.26의 PT별 alt-Router 캐시도 Worker별로 분리(`workerIndex:videoPt` 복합 키).
- Worker `died` 복구 범위를 죽은 Worker의 카메라만으로 축소(기존 싱글톤은 Worker 1개 죽으면 전체 카메라가 리셋됐음).
- `server/.env`/`.env.example` 3종에 `MEDIASOUP_NUM_WORKERS` 문서화, 이 호스트는 `8`로 명시 설정.
- 검증: 독립 스모크 테스트(8-Worker 정상 부팅, 카메라 5개 여러 Worker 분산 확인 — 테스트 중 실수로 등록된 ingest-daemon 테스트 카메라는 즉시 정리), 실서버 `npm run stop`→`start` 배포 후 전체 카메라 정상 복구(`GET /api/webrtc/monitor` `running:true`), 배포 후 첫 ~3분 관측에서 문제의 5MP 카메라(`61813f62`) 스톨 1건(이전보다 훨씬 건강한 상태에서 발생)·`4e562747` 0건으로 초기 긍정 신호(표본 작음, 장기 관측 필요).

#### 6.31.1 배포 몇 분 뒤 재현 — CPU는 여유로운데 여전히 Worker 하나가 못 따라감, 스케줄링 우선순위로 접근 전환 (2026-07-22)

§6.31 배포 후 다른 고해상도 카메라(`61813f62`, 2048×1536)에서 사용자가 재현 보고(Res 0fps, Frames 22 decoded/0 dropped, Loss 13.7%, Rate는 15.2Mbps로 정상 수신, Buffer/Latency는 14ms로 건강). 실측으로 두 가지를 확정:

- `/proc/net/snmp`의 `Udp.RcvbufErrors` 증가율이 멀티 Worker 적용 전(초당 ~7건)과 적용 후(초당 ~9.8건)가 비슷하거나 오히려 약간 높음.
- `ss -u -a -n -p`로 8개 mediasoup-worker 각각의 Recv-Q/CPU를 대조한 결과, 여전히 최대 4MB Recv-Q가 쌓인 Worker가 있었는데 그 Worker의 CPU는 **2.9~4.7%뿐** — `61813f62`를 해시로 배정받은 Worker(index 3)를 직접 계산해보니 다른 카메라와 전혀 공유하지 않는 **단독 배정**인데도 동일 증상 재현. 즉 "여러 카메라가 한 Worker를 두고 경합"이 아니라 **카메라 하나의 순간적 버스트만으로도, CPU 여유가 충분한 단독 Worker조차 못 따라가는** 근본적으로 다른 문제.

**해석**: CPU 총사용량이 낮다는 것과 "필요한 순간에 즉시 스케줄링된다"는 것은 다른 문제다. 이 호스트는 27명이 동시 로그인한 공유 서버(load average 10~15/40코어)라, 평소엔 거의 유휴 상태인 mediasoup-worker가 5MP 키프레임처럼 수 ms 안에 몰아치는 UDP 패킷 버스트를 처리하려는 바로 그 순간, 커널 스케줄러가 다른 프로세스들과의 경합 속에서 이 프로세스를 충분히 빨리 깨우지 못하면 커널 소켓 버퍼가 먼저 차버릴 수 있다 — CPU 사용량 통계(초 단위 평균)에는 거의 안 잡히는 종류의 지연이다.

**조치**: `_bootWorkerSlot()`에 `os.setPriority(worker.pid, WORKER_NICE_PRIORITY)`(기본 `-5`, `MEDIASOUP_WORKER_PRIORITY`로 조정 가능) 추가 — Worker가 실행 가능한 상태가 됐을 때 커널이 더 우선적으로 스케줄링하도록 요청. 직접 `renice -5`를 시도해본 결과 `Permission denied`(`ulimit -e`도 0)로 확인됐듯, `mediasoup-worker` 바이너리에 `CAP_SYS_NICE`가 없으면 무력화됨 — `sudo setcap cap_sys_nice+ep <mediasoup-worker 바이너리 경로>`를 1회 실행해야 실제로 적용된다(사용자 sudo 필요, 이 세션은 비대화형이라 직접 실행 불가 — 명령어만 안내). 권한이 없을 때는 매 Worker마다 경고 로그만 남기고 조용히 무시하도록 구현(부팅 자체를 막지 않음). 최대치인 `-20`이 아니라 `-5`로 보수적으로 설정한 이유는 이 호스트가 다른 27명과 공유하는 서버라, 모든 카메라 Worker에 실시간급 우선순위를 기본값으로 주는 것은 다른 사용자에게 불친절한 조치이기 때문.

**아직 미결**: setcap 적용 및 재시작 후 실측 재검증 대기 중. 이 조치로도 재현된다면, §6.30.2/§6.31에서부터 이어진 "원인 1 — RTCP PLI 경로 부재"(카메라까지 키프레임 재요청이 도달 못 함)가 여전히 남아있는 진짜 근본 문제라는 뜻 — 손실 자체를 줄이는 접근(스케줄링/버퍼)에는 한계가 있고, 손실 후 빠른 복구(카메라 GOP 단축 또는 RTCP PLI 실제 구현) 쪽으로 넘어가야 한다.

#### 6.31.2 진짜 급성 원인 확정 — NIC 링버퍼 조정 이후에도 재생이 계속 안 되던 것은 ingest-daemon이 조사 도중 완전히 다운돼 있었기 때문 (2026-07-22)

§6.31.1의 setcap 적용 후에도 사용자가 "영상이 안 나온다"고 반복 보고(Loss 76.6%, Codec 완전 공백 `– / –`, Frames 0 decoded 지속) — 3분간 라이브 관측으로 실제로 단 한 프레임도 디코딩되지 않음을 재확인했다. 원인 규명을 위해 다음을 순차로 실측:

1. **NIC 레벨 재확인**: `ethtool -G eth1 rx 4096`(사용자가 sudo로 적용) 이후 `/proc/net/dev`의 eth1 drop 카운터를 재샘플링 — 링버퍼 확장 자체는 drop 발생률을 유의미하게 줄이지 못함(적용 전후 모두 초당 ~10건대) → NIC 링버퍼가 유일한 원인은 아니었음을 확인.
2. **mediasoup 서버측 통계 직접 조회** (`GET /api/webrtc/monitor`의 `producerStats`): 문제 카메라들의 mediasoup Producer `videoScore`가 **완벽한 10점**이고 `videoBytesRx`가 수백MB 단위로 정상 누적 중임을 확인 — ingest-daemon→mediasoup 구간은 실제로는 완전히 건강했다는 뜻. 이는 그동안의 "손실률" 중심 진단(NIC/Worker/스케줄링)이 애초에 잘못된 방향이었을 가능성을 시사.
3. **`LTS_DEBUG_SDP=true`로 실제 SDP 확인 시도** — 예상과 달리 로그에 전혀 안 찍힘. 원인을 추적한 결과 `utils/logger.js`의 `makeLineRelay()`가 라인 텍스트에서 `\bdebug\b`(대소문자 무관, 단어 경계 매칭)를 발견하면 자동으로 DEBUG 레벨로 강등하는 휴리스틱이 있는데, 진단용 로그 태그 이름 자체가 `[SDP-DEBUG]`라 하이픈 경계 때문에 "debug" 단어로 인식되어 `LOG_LEVEL=INFO`(기본값) 하에서 조용히 필터링되고 있었다 — 이름과 로깅 인프라의 우연한 충돌. `LOG_LEVEL=DEBUG`로 낮추고 재시작해 확인 절차를 이어갔다.
4. **재시작 직후 로그에서 결정적 단서 발견**: `ingest-daemon DELETE/register ... failed: fetch failed`, `addCameraStream failed: connect ECONNREFUSED 127.0.0.1:7070`가 연쇄적으로 발생 — **ingest-daemon 프로세스가 조사 도중 완전히 죽어 있었다**(`ps aux`에 프로세스 자체가 없음, `curl :7070/health` connection refused). `/tmp/ingest-daemon.log`의 가장 최근 구간을 대조한 결과, 정상 시에는 `Camera added: <id> [AI+vRTP:PORT+aRTP:PORT+appRTP]`로 video RTP 포트가 함께 등록되는데, 다운 직후의 재등록 시도들은 `[AI+appRTP]`뿐 — **video RTP fan-out 자체가 아예 요청되지 못하고 있었다.** 즉 이번 세션 후반부에 조사했던 "0 프레임 디코딩" 현상 대부분은 mediasoup/Worker/스케줄링 문제가 아니라, **ingest-daemon 자체가 다운되어 있었던 것**이 진짜 원인이었다 — §6.30.2/§6.31에서 조사·수정한 항목들이 무의미했다는 뜻은 아니지만(멀티 Worker/스케줄링 우선순위는 그 자체로 유효한 개선), 최근 수십 분간의 "재생 완전 불가" 급성 증상의 직접 원인은 아니었다.
5. **ingest-daemon 다운 원인**: 확정하지 못함 — 이 세션에서 반복한 짧은 간격의 서버 재시작·파이프라인 재연결 트리거(`/stream/reconnect`)가 ingest-daemon에 누적 부하를 줬을 가능성이 높다(§6.29.5/§6.29.9에 이미 기록된 "반복적으로 응답 불능에 빠지는" 기존 미해결 문제와 같은 계열일 수 있음). `npm run ingest:restart`로 즉시 복구.
6. **복구 검증**: `ingest:restart` 직후 실시간 관측으로 `yt-9bb39`(232프레임), `61813f62`(49프레임, 계속 증가), `4e562747`(재연결 1회 후 19프레임)까지 **3개 카메라 전부 정상 디코딩 재개**를 직접 확인. `4e562747`은 재등록 직후 한 차례 Consumer `bytesSent=0`가 지속되는 잔여 증상을 보였으나(Producer는 정상 수신 중이었음 — Consumer만 0바이트, 원인 미확정, 반복된 재연결의 타이밍 경합 가능성) `/stream/reconnect` 1회로 해소.
7. **후속 정리**: `LOG_LEVEL=DEBUG`/`LTS_DEBUG_SDP=true`는 진단 완료 후 원복(`LOG_LEVEL=INFO`, `LTS_DEBUG_SDP` 주석 처리), 서버 재시작으로 반영 완료.

**교훈**: 이번 세션 후반부의 "재생 완전 불가" 급성 증상은 그 이전까지 조사하던 만성 문제(mediasoup Worker 병목, 손실률)와 **다른 사건**이었다 — 라이브 디버깅 중 반복 재시작 자체가 ingest-daemon을 다운시켰을 가능성이 있고, 이후 몇 시간의 조사가 실제로는 "다운된 daemon에 대고 계속 재시도"를 관측한 것이었다. 서버측(`GET /api/webrtc/monitor`)과 ingest-daemon측(`GET /cameras/stats`, `/tmp/ingest-daemon.log`)을 **양쪽 다** 대조 확인하는 것이 이런 "여러 계층이 동시에 문제처럼 보이는" 상황에서 핵심 진단 수단이었다 — 다음에 유사 증상이 재현되면 mediasoup 통계부터 보지 말고 `curl :7070/health`로 ingest-daemon 생존부터 먼저 확인할 것.

#### 6.31.3 재발 — 서버 재시작 직후 재현, 두 가지 별개의 사소한 원인으로 확정 (2026-07-22)

§6.31.2 복구 후 사용자가 "여전히 영상이 안 나온다"고 재차 보고. 서버(`GET /health`)·ingest-daemon(`GET :7070/health`) 둘 다 정상이었고(uptime 8377s, 크래시 없음) — 이번엔 §6.31.2의 "daemon 다운"과는 다른 사건임을 먼저 확인. `GET /api/webrtc/monitor`의 producerStats로 카메라별 상태를 대조:

- `61813f62`: `videoScore: []`(빈 배열, 수신 이력 전무), `videoBytesRx: 0` — 로그 확인 결과 **물리 카메라(192.168.214.40) 자체가 RTSP 연결을 거부**하고 있었음(`Connection refused`). 코드/인프라 문제가 아니라 카메라 자체의 문제 — 잠시 후 카메라가 스스로 복구되며 자동 재생 재개.
- `4e562747`/`yt-9bb39`: Producer(score 10, GB 단위 정상 수신)·Consumer(수십~수백MB 정상 송신) 둘 다 완벽한데 클라이언트 `vFrames`가 300초 이상 0에 고정 — 서버측 관점에선 "완벽히 정상"인데 실제로는 재생이 안 되는, 가장 헷갈리는 패턴.

**SDP 직접 확인 재시도**: 지난번 `LTS_DEBUG_SDP=true`가 로거의 `\bdebug\b` 자동 강등(§6.31.2에서 발견)에 걸려 안 보였던 문제를 근본적으로 고침 — `console.log()` 대신 `fs.appendFile()`로 `<repo-root>/sdp-debug.log`에 직접 쓰도록 `negotiate()` 수정(`mediasoupEngine.js`). `LOG_LEVEL=DEBUG` 없이도 항상 보이므로 향후 재사용 가능. 재시작 후 확인한 실제 SDP는 `4e562747`(profile-level-id=640032, sprop 정상) 완벽했고, 그 직후 클라이언트가 실제로 프레임을 디코딩하기 시작함(수백 프레임까지 정상 증가) — **직전의 "0프레임" 상태는 재시작으로 정리된, 특정 PeerConnection 인스턴스가 어쩌다 나쁜 상태에 갇힌 일시적 현상**이었음을 시사(코드 결함이라기보다 §6.30/6.30.1에서부터 지적해온 "손실 후 복구 경로 부재"의 또 다른 발현).

**`yt-9bb39` 전용 원인**: ingest-daemon 로그(`server/logs/lts-*.log`의 `[Ingest]` 접두사 — **주의: `npm run start`로 전체 스택을 띄우면 ingest-daemon 출력이 `/tmp/ingest-daemon.log`가 아니라 이 통합 로그로 감** — `npm run ingest:restart` 단독 실행 시에만 `/tmp/ingest-daemon.log` 사용, 두 경로를 혼동하지 말 것)를 대조한 결과: 브라우저가 협상을 시도한 시점(07:20:53)에 YouTube RTSP 루프가 마침 URL 갱신 재시도 중(404 반복, §6.16에 이미 기록된 기존 이슈)이라 `negotiate()`의 지연 등록(lazy fan-out, §6.27) POST가 카메라 미준비 상태와 겹쳐 실패 → `cam.videoFanoutRegistered`가 `false`로 롤백 → 이후 카메라 연결이 실제로 성공한 뒤(07:21:06) 약 82초 뒤인 07:22:28에야 fan-out이 최종 등록됨. 그 사이 뷰어는 0바이트 상태로 대기 — 코드가 완전히 고장난 게 아니라 "지연 등록 재시도"가 예상보다 오래 걸린 타이밍 이슈. 등록 완료 후 정상 재생 확인.

**교훈 추가**: (1) 로그 상 `[Ingest]`가 통합 로그와 `/tmp/ingest-daemon.log` 두 곳에 나뉘어 쓰일 수 있다는 것 — 실행 방식(`npm run start` 전체 vs `npm run ingest:restart` 단독)에 따라 확인할 파일이 다르다. (2) `_ingestPost(...).catch(() => { cam.videoFanoutRegistered = false; })`(negotiate()의 지연 등록)가 실패를 완전히 침묵 처리(`console.error` 없음)해 이런 타이밍 문제를 진단하기 어렵게 만듦 — 후속 과제로 최소한 실패 시 경고 로그 추가를 고려할 것.

### 6.32 ingest-daemon RTP 송신 소켓 `buffer_size`가 조용히 무시되던 버그 — 만성 패킷 손실의 진짜 근본 원인 (2026-07-22)

§6.31.3까지의 "재시작하면 낫는다" 패턴 자체를 의심해 재조사. TID-A800(§6.28 이후 videoOnly, alt-PT 파이프라인 사용)에서 사용자가 브라우저 탭을 Chrome+Edge 2개 동시에 띄운 상태로 재현 보고 — 처음엔 "같은 mediasoup Worker를 공유하는 두 Consumer의 경합"으로 가설을 세웠으나, Edge를 닫고 Chrome 단독으로 재확인해도 `packetsLost`/`packetsReceived` 비율이 그대로 55~60%대(`framesReceived=0` 고정)로 나타나 **이 가설은 즉시 기각** — 연결 개수와 무관한, 단일 연결 자체의 구조적 문제임을 확인.

`GET /api/client-logs/webrtc`의 raw `RTCStatsReport`를 시계열로 대조한 결과: `nackCount`가 수천 회 발생하는데도 `packetsLost` 비율이 전혀 개선되지 않음 — RTX(`enableRtx`)는 alt-PT 파이프라인에서도 정상적으로 `true`였음(browser가 offer한 RTX-PT=114가 라우터 선언과 일치, `rtxMatched` 확인됨). NACK을 아무리 보내도 회복이 안 된다는 것은 **mediasoup이 애초에 그 패킷을 받은 적이 없어 재전송할 대상 자체가 없다**는 뜻 — 즉 손실이 mediasoup→브라우저(WebRtcTransport) 구간이 아니라 **ingest-daemon→mediasoup(PlainTransport) 수신 구간**에서 이미 발생하고 있다는 결론에 도달.

**근본 원인**: §6.18에서 도입한 `_RTP_SEND_BUFFER_SIZE`(8MB, ingest-daemon의 RTP 송신 소켓 SO_SNDBUF)가 `av.open(..., format="rtp", options={"buffer_size": ...})` 형태로 전달되고 있었는데, 실제 라이브 로그에 `Some options were not used: {'buffer_size': '8388608'}` 경고가 계속 찍히고 있음을 발견 — **§6.18 커밋 이후 지금까지 단 한 번도 실제로 적용된 적이 없었다.** 같은 딕셔너리의 `ssrc`/`payload_type`은 정상 적용되는 것으로 보아, libav의 "rtp" 먹서(muxer)가 이 옵션들은 자신의 AVOption으로 소비하지만 `buffer_size`는 내부적으로 별도로 여는 "udp" 프로토콜 컨텍스트로 전달하지 않는 것으로 확인 — muxer-level 옵션과 protocol-level 옵션이 섞인 딕셔너리를 `av.open()`에 넘길 때 흔히 발생하는 FFmpeg/libav의 알려진 함정. 결과적으로 이 소켓은 지금까지 계속 OS 기본 SO_SNDBUF(~208KB, `net.core.wmem_default`)로 동작해왔고, 5MP 카메라의 키프레임이 만드는 촘촘한 UDP 패킷 버스트를 송신 시점에 이미 커널이 드롭하고 있었다 — §6.18에서 고쳤다고 여겼던 "송신측" 절반이 실제로는 전혀 적용되지 않은 채, 그동안 관측해온 만성적 손실·재생 정지의 실질적 근본 원인이었던 것으로 확인됨.

**수정**: `buffer_size`를 `options` 딕셔너리에서 제거하고, `rtp://127.0.0.1:{port}?buffer_size={_RTP_SEND_BUFFER_SIZE}` 형태로 URL 쿼리스트링에 직접 포함 — FFmpeg URL 레이어는 쿼리 파라미터를 muxer의 옵션 전달 방식과 무관하게 대상 프로토콜(이 경우 "udp")의 AVOption으로 직접 파싱하므로 이 경로는 항상 적용된다. `ingest_daemon.py`의 4곳(video 기본 fan-out, video 추가 fan-out `add_video_fanout()`, audio passthrough, audio transcode) 전부 동일하게 수정.

**검증**: `npm run ingest:restart`로 적용 후 `Some options were not used` 경고가 완전히 사라짐을 확인(재시작 전에는 매 fan-out 등록마다 반복 출력). 다만 ingest-daemon만 재시작하면 mediasoup 쪽 alt-PT 파이프라인 캐시(`_altPipelines`, 카메라+PT별로 한 번만 빌드되고 재사용됨)는 새 ingest-daemon 프로세스를 모른 채 예전 fan-out 등록 상태를 그대로 신뢰하므로 — `addCameraStream()` 안에 이미 있던 "기존 alt 파이프라인 재-fan-out" 로직(§6.26, fire-and-forget)에 의존해 `POST /api/internal/ingest/reregister`를 별도 호출해야 실제로 반영됨을 확인. 그 직후에도 해당 카메라의 **이미 열려있던** 브라우저 탭은 서버 변경 이전 상태로 굳어있어 Consumer `bytesSent=0`(DTLS는 connected인데 전송 0바이트)로 멈춰있었고, 브라우저 새로고침(완전히 새 `RTCPeerConnection` 생성) 후에야 정상화 — 새로고침 전: `packetsLost`/`packetsReceived` 비율 55~63%, `framesDecoded=0` 고정. 새로고침 후 40초 관측: 손실률 **0.2~0.4%**, `framesDecoded`/`framesReceived`가 초당 프레임 수만큼 정상적으로 계속 증가, PLI 0회. 이번 세션에서 추적해온 "패킷 손실 계열" 문제의 진짜 근본 원인으로 확정.

**교훈**: (1) `av.open()`의 `options` 딕셔너리에 muxer 옵션과 protocol 옵션을 섞어 넘기면 일부가 조용히 무시될 수 있다 — 반드시 라이브 로그에서 `Some options were not used` 경고 유무로 실제 적용 여부를 확인할 것, 코드가 "그렇게 짜여 있다"는 것과 "실제로 적용되고 있다"는 것은 별개다. (2) ingest-daemon을 단독 재시작(`npm run ingest:restart`)하면 mediasoup 쪽에 캐시된 alt-PT 파이프라인의 fan-out 등록이 새 프로세스 기준으로 깨지므로, 재시작 직후에는 `POST /api/internal/ingest/reregister`를 함께 호출해야 한다 — 이 문서 §6.31.2에서 이미 "daemon 다운→복구" 케이스에 대해 `reregisterAllWithIngestDaemon()`이 존재하는 이유가 바로 이것이며, 수동 `ingest:restart` 후에도 동일하게 호출이 필요하다는 점은 이번에 처음 명시적으로 확인됨. (3) 서버측 변경(ingest-daemon 재시작, 파이프라인 재등록) 도중 이미 연결되어 있던 브라우저 탭은 그 변경 이전 상태에 고정될 수 있으므로, 진단 중 서버측을 건드렸다면 클라이언트도 반드시 새로고침해서 재검증할 것.

### 6.33 §6.32 배포 후에도 손실 재발 — 호스트 부하 급증(다른 사용자) + Worker 스케줄링 한계, ingest-daemon 자체 우선순위 부스트는 원인 불명으로 미적용 (2026-07-22)

§6.32 배포·검증 직후(재시작 후 새로고침, 손실 0.2~0.4%) 정상 확인했으나, 약 10~15분 뒤 사용자가 다시 "영상이 안 나온다"고 재보고. 단일 연결이 시간이 지나며 손실이 서서히 증가(0.2%→2.5%→12%)하다 정지되는 패턴과, 재연결해도 즉시 45~60%대로 시작하는 패턴이 반복 관측됨 — 여러 가설을 실측으로 순차 배제:

1. **Chrome+Edge 동시 시청(같은 Worker 경합) 가설** — Edge를 닫고 Chrome 단독으로도 동일하게 재현되어 기각.
2. **탭 백그라운드 가설** — 사용자가 탭이 최상단(포그라운드)에 있다고 확인해 기각.
3. **ingest-daemon 장시간 구동 누적 열화 가설** — `npm run ingest:restart`로 완전히 새 프로세스를 띄운 직후에도 즉시 45~50%대로 시작해 기각.
4. **호스트 부하(다른 20명 사용자) 가설** — `uptime`의 load average가 5.3~8.1 사이로 오르내렸지만, 부하가 낮을 때(5.26)도 손실이 오히려 최고치(61%)를 기록해 **단독 원인으로는** 기각. 다만 완전히 무관하지는 않음(아래 §6.33.1 참고).
5. **mediasoup-worker 자체 큐 확인** — 이 시점 처음으로 `ss -u -a -n -p`가 (이전 세션들에서 겪은 `ptrace_scope` 차단과 달리) 정상 동작함을 확인 — 환경이 언제 바뀌었는지는 불명. `127.0.0.1` 소켓(ingest-daemon→mediasoup PlainTransport 구간) 중 하나에서 Recv-Q 약 80만 바이트(823552B) 확인 — mediasoup-worker가 자기 수신 큐를 실시간으로 못 비우고 있다는 직접 증거. 이미 nice=-5로 스케줄링 우선순위를 올려둔 상태에서도 부족했다는 뜻.

사용자 승인 하에 `MEDIASOUP_WORKER_PRIORITY`를 -5→**-15**로 상향(`.env`에 이미 반영되어 있었으나, 이 값을 로드한 시점 이후 프로세스가 재시작되지 않아 미반영 상태였음 — `.env`는 프로세스 시작 시 1회만 읽히므로 파일만 고쳐서는 실행 중 프로세스에 반영되지 않는다는 점 재확인). `npm run stop && npm run start`로 전체 재기동 후 8개 Worker 전부 `ni=-15` 확인. 재시작 직후 손실이 즉시 17~24%로 개선(기존 45~60%대 대비)됐으나 여전히 `framesDecoded`가 거의 멈춰있는("거의 정지") 수준 — **완전 해결은 아님, 그러나 유의미한 개선.**

#### 6.33.1 ingest-daemon이 mediasoup-worker보다 더 뜨거운 프로세스임을 발견 — 동일 우선순위 부스트를 ingest-daemon에도 적용 시도, 원인 불명의 실패로 미적용 확정

`ps -eo pid,pcpu,ni,comm --sort=-pcpu`로 확인한 결과 이 시점 ingest-daemon(python3, PID 가변)이 CPU 299%로 **mediasoup-worker 전체를 합친 것보다 훨씬 뜨거운, 호스트에서 가장 바쁜 프로세스**였음 — `MEDIASOUP_WORKER_PRIORITY`는 mediasoup-worker에만 적용되고 ingest-daemon 자신에는 아무 우선순위 조치가 없었다는 것을 재확인. 병목이 mediasoup-worker에서 ingest-daemon 쪽으로 한 단계 더 상류로 옮겨갔을 가능성이 높다고 판단.

기존 `tools/mediasoup-worker-priority-wrapper`(§6.31.1) 바이너리를 재빌드·재setcap 없이 그대로 재사용(env var `MEDIASOUP_WORKER_REAL_BIN`/`MEDIASOUP_WORKER_PRIORITY`를 읽는 범용 동작이므로, 이름은 mediasoup 전용처럼 보이지만 실제로는 어떤 대상이든 감쌀 수 있음 — capability는 setcap이 적용된 바이너리 파일(inode) 자체에 귀속되므로 재빌드 없이도 유효) — `startServer.js`(2곳)/`startIngestDaemon.js`/`restartIngestDaemon.js` 4개 spawn 지점 전부에 wrapper 적용 로직 추가, `INGEST_DAEMON_PRIORITY` 환경변수(기본 -5) 신설, `.env`/`.env.example`/`.env.streaming.example`에 문서화.

**실측 결과 — 적용되지 않음**: 코드 배포 후 반복 재시작하며 검증한 결과, wrapper가 올바른 인자로 호출되는 것(`spawnExec`/`MEDIASOUP_WORKER_REAL_BIN` 디버그 로그로 직접 확인)까지는 맞지만, 실제로 살아남아 포트 7070을 리슨하는 최종 ingest-daemon 프로세스는 매번 `ni=0`이었다 — 심지어 Node의 spawn() 호출부가 기록한 `child.pid`와 실제 리슨 중인 PID가 매번 다른(오프셋 100+) 현상까지 재현됨(원인 미확정 — 동일 포트를 두고 경합하는 별도 자동복구 경로가 있는 것으로 추정되나 특정하지 못함). 반면 완전히 동일한 wrapper 바이너리를 **bash에서 직접**(`timeout ... env MEDIASOUP_WORKER_REAL_BIN=... wrapper -c "print nice"`) 호출하면 매번 정확히 `-15`가 적용됨을 반복 확인 — wrapper 자체·capability(getcap으로 `cap_sys_nice+ep` 유지 확인)·`NoNewPrivs`(0, 정상) 전부 문제없음.

**결론(잠정)**: mediasoup-worker는 mediasoup 자신의 네이티브(C++) 프로세스 생성 코드가 직접 fork/exec하는 반면, ingest-daemon은 Node.js의 `child_process.spawn()`(내부적으로 libuv의 `posix_spawn()` 경로를 탈 가능성)을 통해 띄워진다 — 이 두 경로가 동일한 `setcap` 파일 capability에 대해 다르게 동작하는 것으로 보이나, 정확한 메커니즘(예: `posix_spawn`이 capability 계산에 관여하는 특정 조건)은 root 권한 없이 `strace`/`capsh` 등으로 더 깊이 파지 못해 **확정하지 못함**. 코드(spawn 4곳의 wrapper 적용 로직·`INGEST_DAEMON_PRIORITY` 환경변수)는 실해가 없으므로(wrapper 미작동 시 기존과 동일하게 우선순위 없이 정상 기동) 그대로 남겨두되, **현재 상태로는 효과가 없다는 것을 명시**한다. 후속 조사 시 `strace -f`(sudo 필요) 또는 `capsh --print`를 ingest-daemon 프로세스 자체에서 실행해 실제 effective capability set을 직접 확인하는 것이 다음 단계.

**최종 상태**: `MEDIASOUP_WORKER_PRIORITY=-15`(mediasoup-worker, 정상 작동)만으로 재확인한 직후 손실률은 카메라별로 2.4~5%, `framesDecoded`가 초당 약 30프레임 페이스로 정상 증가 — 실사용 가능한 수준으로 복구. `buffer_size` 수정(§6.32)과 Worker 우선순위 상향(§6.31.1, 이번에 -15로 강화)의 조합이 실질적 개선을 만들었으나, 공유 호스트의 순간적 부하 스파이크에 따라 재발 가능성은 여전히 남아있다.

#### 6.29.8 최종 결론 — 고해상도 카메라 Buffer/Latency 급상승의 진짜 원인은 수동 jitterBufferTarget 제어 자체

§6.29.5의 ingest-daemon 복구 후에도, 사용자가 "원래는 문제없었다"며 근본 해결을 요구 — 2048×1536/15fps 카메라에서 Buffer 1439ms/Latency 1440ms가 재현됨(Frames 702 decoded/231 dropped, Loss 0.4%, RTT 1ms — 네트워크·손실은 정상 범위). 대시보드에 같은 열상 카메라의 Primary/Secondary(서로 다른 센서) 스트림이 동시에 4개 표시되는 것이 원인일 가능성도 검토했으나, 사용자가 의도된 구성임을 확인해 기각.

`useWebRTC.ts`의 escalation 코드를 다시 정독한 결과, 이 파일 자체에 이미 "manual jitterBufferTarget control이 v1.20(도입)→v1.36(버그)→v1.37(되돌림)→v1.41(재수정)"로 세 번 문제를 일으켰다는 이력이 주석으로 남아있었다 — 그리고 지금 보는 증상이 그 네 번째 재발이었다:

- `JITTER_TARGET_STEP_UP_MS=150`(이벤트당) vs `JITTER_TARGET_STEP_DOWN_MS=30`(5초 틱당) — 완전히 감쇠(1000ms→100ms)하려면 무손실 상태가 **2.5분** 연속 유지되어야 한다.
- 실사용 환경의 링크는 간헐적으로 실제 손실/프리즈가 발생하므로(0.4%대 Loss는 "낮지만 0은 아님"), 장시간 연결에서 이 2.5분의 클린 윈도우를 얻기 어렵고 `jitterTargetMs`가 상한(1000ms) 근처에 계속 머무르게 된다.
- 이 값을 `videoReceiver.jitterBufferTarget = jitterTargetMs`로 **브라우저에 직접 명령**해 프레임을 최대 1초까지 붙들게 만들었다 — 즉 "디코더가 못 따라간다"와 지표상 구분 불가능한 증상(Buffer/Latency 급상승)을 스스로 유발하고 있었다.

**수정**: `JITTER_TARGET_FLOOR_MS`/`MAX_MS`/`STEP_UP_MS`/`STEP_DOWN_MS` 상수와 `videoReceiver.jitterBufferTarget` 명령 코드를 전부 제거 — 브라우저 자체의 적응형 지터 버퍼(별도 힌트 없이도 동작하도록 설계됨)에 위임한다. freeze/loss 델타 계산 자체는 유지하되 더 이상 아무 것도 명령하지 않는 순수 관찰값으로 남긴다. 부수적으로 재연결 안전장치(`bufferSaturatedTicks`)도 `jitterTargetMs` 상한 도달을 조건으로 요구하지 않도록 완화(§6.29.1의 v1.41 수정 이후에도 순수 디코드 처리량 부족 상황에서는 freeze/loss가 거의 없어 `jitterTargetMs`가 상한에 도달하지 못해 안전장치 자체가 무력화되는 gap이 있었음).

`npx tsc --noEmit`/`npm run build` 클린 통과, 새 번들 배포 완료. 실제 재현 여부는 사용자 확인 대기 중 — 이 수정으로도 재현된다면 §6.29.5에서 남겨둔 ingest-daemon 자체의 GIL 경합(버스트성 RTP 전달) 쪽이 진짜 원인일 가능성이 높아진다.

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

### 6.34 AI_DECODE_THREADS가 카메라 대수만큼 곱해져 `/health`·SIGTERM이 무응답 상태에 빠짐 — fleet-wide 상한 도입 (2026-07-23)

`npm run ingest:restart` 실행 중 새 daemon 프로세스는 `:7070`에 정상 바인딩했는데도 `/health`가 8~10초 넘게 무응답이라 헬스체크가 타임아웃되고 재시작이 실패로 보고되는 현상이 재현됨. 프로세스를 강제 종료하지 않고 `SIGUSR1`(§6.10에서 이미 등록된 `faulthandler` 스택 덤프, `/tmp/ingest-daemon-stacks.log`)로 진단한 결과:

- `serve_forever()`의 accept 루프(메인 스레드)는 `select()`에서 idle 상태로 정상 대기 중 — HTTP 서버 자체가 멈춘 게 아니었음.
- 그런데 `/proc/<pid>/status`의 `Threads:` 값은 140인 반면 SIGUSR1 덤프에 찍힌 파이썬 스레드는 약 40개뿐 — 나머지 100개는 §6.10에서 이미 식별된 것과 동일한 패턴인 libav 내부 네이티브 디코드 스레드(파이썬 `threading`/`faulthandler`에는 보이지 않음).

**원인**: `_INGEST_SETUP_SEMAPHORE`(§6.10/§6.12)는 RTSP 연결 수립(`av.open()`) 단계만 동시 5개로 제한할 뿐, 연결이 끝나고 각 카메라가 steady-state 디코딩에 들어간 뒤에는 아무 제한이 없다. 각 카메라의 AI 디코드 워커(`_ai_decode_worker`)는 독립된 `CodecContext`에 `thread_count = AI_DECODE_THREADS`(고정값, §6.10에서 "카메라 수 × nproc" 폭증을 막기 위해 카메라당 고정 캡으로 도입)를 설정하는데, 이 캡 자체가 **카메라 대수와 무관한 고정값**이라 fleet-wide 네이티브 스레드 총수 = `카메라 수 × AI_DECODE_THREADS`로 무한정 비례해서 늘어난다. 실측: `AI_DECODE_THREADS=8`(§6.27에서 GIL 경합 실험 목적으로 기본값 4에서 상향)  × 카메라 9대 = 네이티브 디코드 스레드 72개(전체 140 OS 스레드) — `/health` 응답이 10초 이상 지연되고, `restartIngestDaemon.js`의 8초 SIGKILL 에스컬레이션에 상시 의존하게 됨(graceful SIGTERM 종료 경로가 사실상 항상 우회됨).

**수정**: `AI_DECODE_THREADS_TOTAL`(기본값 `os.cpu_count()`) 신규 도입 — 카메라별 실제 `thread_count`를 고정값이 아니라 `max(1, min(AI_DECODE_THREADS, AI_DECODE_THREADS_TOTAL // 활성_카메라수))`로 매 (재)연결마다 동적으로 계산한다. 카메라가 늘어나거나 `AI_DECODE_THREADS`를 개별 카메라(예: TID-A800 2560×1920 열상)를 위해 높게 설정해도, fleet-wide 네이티브 디코드 스레드 총수는 `AI_DECODE_THREADS_TOTAL`을 넘지 않도록 상한이 걸려 `/health`·SIGTERM 응답성이 카메라 대수·설정값과 무관하게 안정적으로 유지된다. `ingest_daemon.py`, `server/.env`/`.env.example`/`.env.streaming.example`/`.env.analysis.example` 4종 동시 수정.

---

### 6.35 `restartIngestDaemon.js`의 포트-해제 확인이 `ptrace_scope=1` 호스트에서 조용히 no-op — bind 테스트로 교체 (2026-07-23)

§6.34 배포 후에도 (별도 진단 세션에서 시작된) ingest-daemon 프로세스가 여전히 HTTP API 무응답 상태로 좀비화되는 사례가 재현됨(전 카메라 대시보드에 RETRY/error로 표시). `npm run ingest:restart`로 복구를 시도했으나 로그에 `daemon exited (code=1)`과 `OSError: [Errno 98] Address already in use` 반복이 남고, 옛 프로세스는 계속 살아있었음.

**원인**: `killExistingDaemon()`의 "SIGTERM 후 포트가 실제로 풀렸는지" 폴링 루프(§6.12, §6.16에서 도입한 TERM→8초 대기→KILL 승급 로직)가 `_getPortPid()`(내부적으로 `lsof -ti tcp:PORT -sTCP:LISTEN`)의 반환값으로만 "포트 해제 여부"를 판단하고 있었다. `lsof`가 소켓 inode→PID를 매핑하려면 대상 프로세스의 `/proc/<pid>/fd`를 읽어야 하는데, 이 읽기는 ptrace와 동일한 권한 검사를 받는다. 이 호스트의 `kernel.yama.ptrace_scope=1`(Ubuntu 기본값)에서는 **직계 부모-자식 관계가 아닌 프로세스는 같은 uid라도 ptrace 불가** — 좀비 daemon이 다른 세션/셸에서 기동된 경우 정확히 이 조건에 걸려 `lsof`가 항상 빈 결과를 반환한다(`ls /proc/<pid>/fd` 자체도 `Permission denied`로 직접 재현·확인). 그 결과 폴링 루프의 첫 체크 `_getPortPid().length === 0`가 SIGTERM을 보내자마자 무조건 참이 되어 즉시 `return` — 8초 대기도, SIGKILL 에스컬레이션도 전혀 발동하지 못한 채 `startDaemon()`이 여전히 점유 중인 포트로 경합해 매번 `EADDRINUSE`로 크래시하는 루프에 빠졌다. `pkill -f 'ingest_daemon.py'`(이미 존재하던 폴백, `/proc/<pid>/cmdline` 매칭이라 ptrace 무관하게 SIGTERM 자체는 정상 전달됨)로 신호는 갔지만, 좀비 프로세스가 스레드 과부하로 SIGTERM을 즉시 처리하지 못했고, 루프가 그 사실을 확인하지 않고 이미 리턴해버린 뒤였다.

**수정**: `server/src/scripts/restartIngestDaemon.js`에 `isPortFree(port)` 헬퍼 신규 추가 — PID 조회 없이 해당 포트에 실제로(`net.createServer().listen()`) bind를 시도해 성공/`EADDRINUSE`로 점유 여부를 직접 판단한다. 이는 곧 이어질 `startDaemon()`의 실제 bind 시도와 동일한 동작이라 ptrace 권한과 완전히 무관하고 크로스플랫폼(Windows 포함)으로도 그대로 동작한다. `killExistingDaemon()`의 8초 대기 루프와 SIGKILL 에스컬레이션 판단 기준을 전부 `_getPortPid().length === 0` → `await isPortFree(addrPort)`로 교체했고, SIGKILL 단계에도 `pkill -9 -f 'ingest_daemon.py'` 폴백을 동일한 이유로 추가했다(기존에는 PID 타겟 SIGKILL만 있었고 그 PID 목록 자체가 `_getPortPid()`발 빈 배열이라 무력화될 수 있었음).

**검증**: 실제로 재발한 좀비 daemon(다른 세션에서 기동, `/health` 5초 타임아웃 확인) 대상으로 수정판 스크립트를 실행 — 로그에 `SIGTERM 후 8000ms 내 종료되지 않음 — SIGKILL로 강제 종료`가 정확히 찍히고 새 daemon이 정상 기동, 카메라 9대(RTSP 8 + YouTube 1) 전부 `POST /api/internal/ingest/reregister`를 통해 재등록되어 `streaming` 상태와 `frameCount` 증가를 확인. `ingestDaemonWatchdog.js`(§6.29.9)가 이 스크립트를 그대로 자식 프로세스로 spawn하는 구조이므로, 이번 수정으로 watchdog 자동 복구 경로도 동일하게 정상화됨. **미해결**: daemon의 HTTP 스레드가 왜 반복적으로 굶주리는지 자체(§6.29.5의 GIL/스레드 경합 가설, §6.34의 fleet-wide 상한 도입 이후에도 재발)는 여전히 근본 미해결 — 이번 수정은 "멎었을 때 복구 경로가 실제로 작동하는지"만 고친 것.

---

### 6.36 `startServer.js`의 크래시 자동재시작 루프에도 동일한 `fuser`/ptrace_scope 결함 발견·수정 (2026-07-23)

§6.35에서 `restartIngestDaemon.js`(수동 `npm run ingest:restart` 경로)는 고쳤지만, ingest-daemon이 예기치 않게 죽었을 때 자동으로 재기동하는 **별도의** 코드 경로 — `startServer.js`의 `_respawnIngest()` → `_killPortOrphan()` — 는 `fuser -k ${port}/tcp` 한 줄만으로 orphan을 정리하고 있었다. `fuser`도 `lsof`와 동일하게 소켓→PID 매핑에 `/proc/<pid>/fd` 읽기가 필요해 같은 `ptrace_scope=1` 제약을 받는다 — 실측으로 `fuser 7070/tcp`가 실제 LISTEN 소켓이 있는데도 종료 코드 1(찾지 못함)을 반환함을 확인했다. 그 결과 `_killPortOrphan()`이 조용히 no-op하고, `_respawnIngest()`가 매 30초(지수 백오프, 최대치)마다 이미 점유된 포트로 새 daemon을 spawn → `OSError: [Errno 98] Address already in use`로 즉시 크래시 → 재시도, 를 무한 반복하는 것을 실제 로그(`attempt #14`)로 확인. 당시 포트를 쥐고 있던 프로세스 자체도 §6.29.5와 동일한 GIL 경합성 응답 불능 상태(`/health`가 200 → 무응답으로 수 초 만에 전환, CPU 232%)였어서, 자동 복구가 사실상 완전히 무력화되어 있었다.

**수정**: `_killPortOrphan()`을 §6.35와 동일한 패턴으로 교체 — `fuser -k`는 유지하되(효과가 있을 때는 더 빠름) 실패를 가정하고 `pkill -f 'ingest_daemon.py'`(cmdline 매칭, ptrace 무관)를 항상 함께 실행한다. 종료 확인은 고정 sleep 대신 `_isPortFree(port)`(실제 bind 시도) 폴링으로 교체(8초 유예), 그래도 안 풀리면 `pkill -9 -f`로 SIGKILL 에스컬레이션 후 3초 추가 폴링. 세 함수(`restartIngestDaemon.js`/`startServer.js`/`ingestDaemonWatchdog.js`가 spawn하는 것도 결국 이 둘 중 하나) 모두 이제 동일한 ptrace-무관 판단 기준을 쓴다.

**검증**: 실제로 재현된 크래시 루프(위 attempt #14 상태) 대상 — 좀비 프로세스를 수동으로 `SIGTERM`→(무응답)→`SIGKILL`로 제거하자 `startServer.js`의 자체 supervisor가 다음 spawn에서 바로 정상 bind, `/health` 200 확인. 코드 수정은 `_killPortOrphan()`이 향후 이 개입을 자동으로 수행하도록 함 — `node --check`로 구문 검증 완료, 라이브 크래시 루프 재현을 통한 종단 검증은 후속 발생 시 확인 예정.

---

### 6.37 §6.29.5의 미해결 GIL 경합 가설을 실측으로 확정 — PyAV RTSP `mux()`는 블로킹 쓰기 동안 GIL을 놓지 않는다 (2026-07-24)

§6.29.5는 "CPython GIL 경합이 유력한 메커니즘으로 의심되나... py-spy로 확인하려면 root 권한이 필요해 차단됨"이라며 미확정으로 남겼던 사안이다. RTSP-over-WebSocket(`/StreamingServer`) 채널6 재생 처리량을 조사하던 중(전체 경위는 `Design_RTSP_Over_WebSocket.md` §8.12 참고) 같은 벽(`ptrace_scope=1`, `perf_event_paranoid=3` 모두 sudo 없이 차단)에 다시 부딪혔으나, **py-spy 없이도 확정 가능한 격리 실험**으로 우회했다:

같은 프로세스에서 (1) 아무 것도 안 읽는 소켓을 만들고, (2) pure-Python 카운터를 계속 증가시키기만 하는 스레드를 하나 띄운 뒤, (3) 다른 스레드에서 그 소켓으로 `av.open(..., format="rtsp").mux(큰_packet)`을 호출해 블로킹시켰다. 결과: 카운터 스레드가 `mux()` 호출이 끝날 때까지 **완전히 정지**했다(`time.sleep(3)` 한 줄만 있는 메인 스레드조차 3초를 못 끝냄). CPython의 GIL은 프로세스 전체에 하나뿐이므로, **PyAV의 RTSP `mux()`가 블로킹 네트워크 쓰기 동안 GIL을 놓지 않는 한, 그 호출을 어느 OS 스레드에서 실행하든 같은 프로세스의 다른 모든 파이썬 스레드가 함께 멈춘다** — §6.29.5가 의심했던 것과 정확히 같은 메커니즘이 카메라 fan-out(mux 쓰기) 경로에도 있었음을 실측으로 확정.

실제 영향(채널6, RTSP-over-WebSocket rtsp-publish fan-out): 이 fan-out 엔트리 하나가 붙어있는 동안 **그 카메라 자신의 원본 RTSP 읽기 루프**(`video_packets_total`, 어떤 fan-out과도 무관하게 매 패킷 증가하는 카운터)가 카메라 실측 30fps 대비 6fps 안팎까지 떨어졌다 — 엔트리를 떼면 즉시 회복. 별도 스레드로 옮겨도(순수 threading, GIL은 공유) 효과가 없었던 이유가 이걸로 설명된다.

**해결**: `rtsp_publish_worker.py`라는 완전히 별도의 OS 프로세스(자체 GIL)를 신설해 실제 `av.open()`/`add_stream()`/`mux()`를 전담시키고, ingest-daemon은 stdin 파이프로 raw 패킷 바이트만 전달한다. **이 패턴은 채널6/RTSP-over-WebSocket에 국한되지 않는 일반적인 교훈이다** — ingest-daemon이 앞으로 카메라 데이터를 네트워크로 쓰는(mux하는) 새 fan-out을 추가할 때마다, 그 쓰기가 io 스레드나 다른 어떤 파이썬 스레드와도 GIL을 공유하지 않도록 프로세스 경계로 격리해야 한다는 것 — 스레드 분리만으로는 원천적으로 불충분하다. §6.29.5/§6.29.9의 "ingest-daemon이 반복적으로 응답 불능에 빠진다"는 미해결 문제도 (다중 카메라의 mux 쓰기 경합이 HTTP 서버 스레드까지 밀어내는) 같은 근본 메커니즘일 가능성이 높다 — 후속 조사 시 이 항목부터 검증 권장.

전체 조사 경위(실험 스크립트 포함), `rtsp_publish_worker.py`의 정확한 wire 프로토콜, 그리고 이후 발견한 §6.38(다음 항목)의 상위 아키텍처 변경은 `Design_RTSP_Over_WebSocket.md` §8.12/§8.13에 기록.

### 6.38 아키텍처 변경 — fleet 부하가 근본 원인일 때는 GIL 회피가 아니라 ingest-daemon 자체를 우회 (2026-07-24)

§6.37로 개별 fan-out의 GIL 블로킹은 없앴지만, 카메라 10대의 RTSP 읽기+AI 디코드를 여전히 **하나의 파이썬 프로세스(하나의 GIL)**가 처리하는 이상 fleet 전체 부하가 개별 카메라의 실효 프레임레이트를 깎아먹는 현상은 남았다(실측: 채널6 raw 읽기 속도가 카메라 실제 전송량의 40~63%, AI 디코드를 꺼도 63%까지만 회복 — 나머지는 다른 9개 카메라의 io/AI 스레드와의 경합). §6.29.5/§6.31.2~6.31.3에서 반복 관찰된 "ingest-daemon이 부하 상황에서 응답성을 잃는다"는 패턴과 같은 계열의 제약이다.

`WEBRTC_ENGINE=mediamtx` 배포에서는 `mediamtxManager.addCameraPath()`가 `webrtcEnabled` 카메라마다 **MediaMTX 자신의(Go, non-GIL) RTSP 클라이언트로 카메라를 직접 pull**해 상시 서빙 중이라는 점에 착안 — 이 경로는 ingest-daemon의 파이썬 프로세스를 전혀 거치지 않으므로 fleet 부하와 무관하게 항상 안정적이다(실측: WebRTC 뷰어가 이 경로로 `framesPerSecond: 30`, 손실 0.01% 미만 확인). RTSP-over-WebSocket(`rtspOverWebSocketServer.js`)가 ingest-daemon에 재발행을 요청하기 전에 이 기존 경로가 이미 준비돼 있는지 먼저 확인하고, 있으면 그대로 재사용하도록 변경 — ingest-daemon 완전 우회. 상세는 `Design_RTSP_Over_WebSocket.md` §8.13.

**일반화 가능한 원칙**: ingest-daemon의 GIL 경합이 근본 원인으로 의심되는 다른 증상(§6.29.5의 반복적 응답 불능 등)에서도, "그 데이터를 이미 GIL과 무관한 다른 컴포넌트(MediaMTX 등)가 갖고 있는가"를 먼저 확인하는 것이 스레드/프로세스 최적화보다 우선순위가 높은 해결책일 수 있다.

### 6.39 §6.38 우회 경로가 RTSP-over-WebSocket 전용 카메라에는 적용되지 않던 결함 (2026-07-24)

**증상**: §6.38의 MediaMTX 직접 우회를 배포한 당일, `webrtcEnabled`도 함께 켜진 카메라에서는 30fps가 확인됐지만, **RTSP-over-WebSocket만 켜고 WebRTC는 꺼둔 카메라**(channelSlot 6)에서 다시 ~13.5fps로 저하됨을 실측(ffmpeg로 MediaMTX loopback에 직접 붙어 15초 측정, 187 frames/13.84s).

**원인**: `pipelineManager.js`의 `needsMediaMTX` 조건이 `camera.webrtcEnabled`만 보고 있었다 — `camera.rtspOverWebSocketEnabled`는 전혀 고려되지 않았다. 즉 §6.38의 우회가 전제하는 "MediaMTX가 이미 이 카메라를 pull하고 있다"는 조건 자체가, WebRTC를 안 쓰는 순수 RTSP-over-WebSocket 카메라에서는 **애초에 성립하지 않았다** — `mediamtxManager.addCameraPath(camera.id, ...)`가 한 번도 호출되지 않으므로 `rtspOverWebSocketServer.js`의 `waitForPathReady(camera.id, ...)`가 항상 실패하고, 매번 ingest-daemon의 (느린) 재발행 폴백으로 떨어지고 있었다.

**수정**: `needsMediaMTX`를 `(requestedWebRTC || requestedRTSPOverWebSocket) && WEBRTC_ENGINE === 'mediamtx'`로 확장 — RTSP-over-WebSocket 전용 카메라도 `camera.id` 경로가 등록되도록 함. 브라우저에 WHEP를 노출할지 여부(`useWebRTC`)는 `requestedWebRTC`만으로 별도 게이트되어 있어(§4.3 아키텍처상 이미 분리됨) 이 변경이 WebRTC 노출 범위에는 영향 없음을 코드 확인. `server/src/api/cameras.js`의 `needsRestart`도 `rtspOverWebSocketEnabled` 변경 시 재시작하도록 함께 수정 — 이제 `rtspOverWebSocketEnabled` 토글이 MediaMTX 등록 여부에 실질적으로 영향을 주므로 "재시작 불필요"였던 기존 예외가 더는 성립하지 않음.

재시작 후 재측정: 카메라 자신의 `camera.id` 경로로 정상 전환(`6/media.smp` ingest-daemon 폴백 경로는 더 이상 사용되지 않음), 424 frames/15.00s ≈ 28~31fps로 복구 확인.

**교훈**: "이미 GIL과 무관한 컴포넌트가 데이터를 갖고 있는가"(§6.38 원칙)를 적용할 때는, 그 전제 조건이 **이번에 문제가 된 카메라/모드 조합에도 실제로 성립하는지**까지 확인해야 한다 — 다른 조합(webrtcEnabled 카메라)에서 성립을 확인한 것만으로는 부족하다.

---

### 6.40 `INGEST_WATCHDOG_ENABLED=false`가 디버깅 세션 종료 후에도 방치되어 자동 복구가 무력화된 결함 (2026-07-27)

**증상**: Streaming Dashboard 카메라 리스트의 8개 IP 카메라가 전부 RETRY/Offline으로 표시됨. 그런데 사용자가 실제로 확인한 바로는 **WebRTC 영상 재생 자체는 계속 정상**이었다 — 상태 배지만 잘못된 값을 보이고 있었던 것.

**진단**:
- `curl --max-time 5 http://127.0.0.1:7070/health`가 timeout — ingest-daemon 프로세스는 살아있고 CPU도 도는데(12%) HTTP 스레드만 응답 불능인, §6.29.5/§6.29.9와 동일한 패턴.
- `GET /api/ingest-status`도 `{"enabled":true,"healthy":false,"error":"timeout"}` 확인, 서버 로그에는 `pipelineManager.js`의 프레임 정체 워치독(`FRAME_STALL_MS=45s`)이 "no frame for Ns — restarting capture" → "ingest-daemon re-registration failed"를 684회 이상 반복 중이었음(재등록 HTTP 호출도 같은 wedged daemon을 향하므로 매번 실패).
- "영상은 재생되는데 상태만 RETRY"였던 이유: WebRTC 비디오/오디오 RTP는 mediasoup을 통해 한 번 established되면 **UDP 소켓 기반으로 HTTP 제어 평면과 완전히 독립**되어 유지된다(architecture invariant, §4.3). 대시보드의 `status` 필드는 AI JPEG 프레임 경로의 정체 여부만 반영하는 별도 신호(`_updateCameraStatus()`, `pipelineManager.js`)라서, ingest-daemon의 HTTP 스레드만 wedged되어도 "영상은 정상, 상태는 RETRY"라는 조합이 그대로 나타난다.
- **핵심 원인**: §6.29.9에서 이미 도입한 `ingestDaemonWatchdog.js`(20초 간격 `/health` 폴링, 연속 2회 실패 시 `restartIngestDaemon.js` 자동 트리거)가 있었음에도 자동 복구가 전혀 작동하지 않았다 — `server/.env`의 `INGEST_WATCHDOG_ENABLED=false`가 과거의 라이브 디버깅 세션(주석: "temporarily... 이후 재활성화") 이후 원복되지 않고 그대로 방치되어 있었다. `index.js`는 이 값이 `false`면 `console.warn` 한 줄만 남기고 워치독을 아예 기동하지 않으므로, 자동 복구 경로 자체가 존재하지 않는 상태로 최소 수일간 운영되고 있었다.

**수정**:
1. `server/.env`의 `INGEST_WATCHDOG_ENABLED`를 `true`로 원복.
2. `ingestDaemonWatchdog.js`에 `armDebugDisableSafetyNet()` 신규 추가 — `INGEST_WATCHDOG_ENABLED=false`로 기동될 때 `index.js`가 이 함수를 대신 호출한다. 5분마다 "아직 비활성화됨" 경고를 반복 출력하고, **30분이 지나면 값과 무관하게 강제로 `startIngestDaemonWatchdog()`를 기동**시킨다. `.env` 주석이 명시한 "임시" 전제를 코드로 강제해, 디버깅 세션을 정리하지 않고 넘어가도 자동 복구가 영구적으로 무력화되는 일이 재발하지 않도록 함.
3. `npm run ingest:restart`로 wedged된 daemon 즉시 복구 — 10개 카메라(IP 8대 + YouTube 2개) 전부 재등록, IP 카메라 8대는 `streaming` 상태로 정상 복귀 확인. YouTube 2개(`yt-1a647`, `yt-e54f2`)는 MediaMTX 경로 404로 남았는데, 이는 §6.16의 기존 YouTube URL 갱신 이슈와 동일한 계열로 이번 wedge와는 무관한 별도 사안.

**교훈**: 자동 복구 워치독 자체가 정상 작동해도, "디버깅용 임시 비활성화" 플래그처럼 사람이 되돌려야 하는 수동 스텝이 남아있으면 그 워치독은 언제든 조용히 무력화될 수 있다 — 이런 종류의 플래그에는 처음부터 자동 만료(TTL)를 넣어 "임시"라는 전제를 코드가 스스로 강제하도록 설계하는 편이 안전하다. 또한 "영상 재생"과 "대시보드 상태 배지"가 서로 다른 독립 경로(WebRTC RTP vs AI JPEG 프레임)에서 나온다는 것은 이 코드베이스의 근본적인 아키텍처 특성이므로, 유사 증상(영상은 정상인데 상태만 이상) 진단 시 참고할 것.

---

### 6.41 고아 `startServer.js`가 정상 데몬을 반복적으로 죽이던 결함 — 복구 로직에 헬스체크 없이 무조건 kill (2026-07-28)

**증상**: analysis 서버(streaming 모드)가 보고하는 카메라별 수신 fps가 간헐적으로 0이 되는 현상. 처음엔 YouTube 스트림에서만 관찰됐지만, 실제로는 IP 카메라 8대를 포함한 전체 fleet이 동시에 영향받고 있었다. `/tmp/ingest-daemon.log`를 보면 ingest-daemon 전체가 ~6분 간격으로 정상적으로("Shutting down…" → "Ingest daemon stopped") 죽었다 재시작되길 반복하고 있었고, 그 사이 수 분간 전 카메라의 프레임 공급이 완전히 끊겼다.

**진단**: 같은 워킹 디렉토리에 `startServer.js` 슈퍼바이저 프로세스가 **2개** 떠 있었다 — 하나는 실제로 서비스 중인 최신 인스턴스(`:3443`/`:7070` 보유), 다른 하나는 자신의 `index.js`/`mediamtx` 자식은 이미 죽고 ingest-daemon 자식만 좀비로 남은 5일 전 고아 인스턴스(`child.on('exit')`가 관리 중인 index.js 종료 시 자기 자신도 함께 종료하도록 되어 있어 현재 코드 기준으로는 이런 고아가 새로 생기지 않지만, 그 보장이 없던 더 오래된 코드가 메모리에 올라간 채 실행 중이었던 것으로 추정). 이 고아 인스턴스의 `_respawnIngest()`는 자신의 ingest-daemon 자식이 죽을 때마다 재시작을 시도하는데, 그 안의 `_killPortOrphan()`이 **포트를 점유 중인 프로세스가 실제로 정상 동작 중인지 전혀 확인하지 않고 `pkill -f 'ingest_daemon.py'`로 무조건 죽인 뒤** 자신의 새 자식을 스폰하고 있었다 — 이 pkill은 이름 기반이라 PID·소유 인스턴스와 무관하게 매칭되는 모든 프로세스를 죽인다. 결과적으로 고아 인스턴스가 재시도할 때마다 실제 서비스 중인 건강한 데몬을 죽이고, 두 인스턴스가 서로 자기 자식으로 교체하려 경쟁하면서 fleet 전체의 프레임 공급이 반복적으로 끊겼다.

**수정**: `startServer.js`의 `_respawnIngest()`에 `_isIngestHealthy()`(`GET /health` 실제 응답 확인) 게이트를 추가 — 재시작 시도 직전 포트의 데몬이 이미 정상 응답하면(다른 슈퍼바이저가 서비스 중이라는 뜻) 이 인스턴스는 그 데몬을 죽이지 않고 즉시 물러난다(`_ingestRestartAttempts` 리셋 후 return — 이후 이 인스턴스는 ingest-daemon을 더 이상 관리하지 않음). 아무도 없어 헬스체크가 실패하는 정상적인 단일-인스턴스 크래시 복구 시나리오는 기존과 동일하게 동작하므로 회귀 없음.

**주의(중요)**: 이 수정은 코드 레벨 재발 방지일 뿐, **이미 메모리에 구버전 코드를 올려둔 채 실행 중이던 기존 고아 프로세스에는 적용되지 않는다** — 그 프로세스를 직접 종료해야 지금 당장의 flapping이 멈춘다. 이후 동일 유형(원인 불문, `startServer.js`의 관리 대상 `index.js`는 죽고 슈퍼바이저만 남는 경우)이 재발해도, 이 수정 이후에는 그 슈퍼바이저가 건강한 데몬을 죽이지 않고 스스로 물러나므로 fleet 전체 장애로 번지지 않는다.

`ingestDaemonControl.js`(Admin API·CLI `ingest:restart`가 쓰는 별도 경로)의 `killDaemon()`은 의도적으로 헬스체크에 의존하지 않는다(§6.29.5의 "zombie 데몬은 포트는 잡고 있지만 `/health`가 응답하지 않을 수 있다" 문제 때문) — 이 경로는 호출부(watchdog의 연속 2회 실패 확인, 또는 사람이 명시적으로 요청한 restart)가 이미 "죽여야 한다"는 판단을 끝낸 뒤에만 호출되므로 이번 결함과는 다른 계열이라 손대지 않았다.

**교훈**: 여러 슈퍼바이저 세대가 같은 리소스(포트)를 두고 경쟁할 수 있는 구조에서는, "내가 관리하던 게 죽었으니 재시작한다"는 판단과 "지금 그 자리에 있는 게 실제로 건강한지" 확인이 분리되어 있으면 안 된다 — 후자를 먼저 확인하지 않는 복구 로직은 정상 인스턴스를 반복적으로 몰아내는 자기 자신보다 더 위험한 장애 유발원이 될 수 있다.

---

### 6.42 고아 프로세스 정리 이후에도 남아있던 ingest-daemon 자체의 주기적 응답 불능 — 실증 GIL 테스트 + HTTP 컨트롤플레인 프로세스 분리 (2026-07-28)

**증상**: §6.41의 고아 `startServer.js`를 종료한 뒤에도, 단일 정상 인스턴스 상태에서 `IngestWatchdog`이 `/health` 2회 연속 실패 → 재시작을 **~2.3분 간격으로 계속** 반복. 이번엔 중복 슈퍼바이저 문제가 아니라 ingest-daemon 프로세스 자체가 주기적으로 실제 응답 불능 상태에 빠지는 것으로 확인됨 (CPU 245%, NLWP 127, 공유 호스트 load average 16~18).

**실증 진단 (라이브 SIGUSR1 스택 덤프)**: 헬스체크를 초 단위로 폴링하다 실제 무응답 순간을 잡아 `kill -USR1`로 전체 스레드 스택을 떴다 — accept 루프를 도는 메인 스레드는 `select()`에서 완전히 유휴 상태였고(데드락 아님), 반면 카메라 io 스레드 다수가 `container.demux()`(§979)에 몰려 있었다. 이는 §6.10에서 실측된 "accept 스레드는 idle인데 /health만 무응답"과 동일한 패턴.

**가설 검증 — PyAV read측(demux/decode)이 mux()처럼 GIL을 계속 쥐고 있는가**: 실제 라이브 카메라 스트림을 대상으로 3단계 합성 테스트를 진행 (메인 스레드에서 순수 Python 카운팅 루프를 돌리며 처리량으로 GIL 점유를 간접 측정):
1. `demux()` 1개, 블로킹 대기 위주(5초간 패킷 1개) → 처리량 99.6% 유지
2. `demux()` 7개 동시(실제 패킷 흐르는 상태) → 처리량 90.6%, 초 단위 정지 없음
3. 대형 프레임(2560x1920, 2048x1536) 실제 디코드+PIL 변환(프레임당 최대 224~314ms) 3개 동시 → 처리량 87.7%, 최대 배치 지연 20ms

세 테스트 모두 초 단위로 GIL을 통째로 쥐는 지점을 찾지 못함 — **mux()(쓰기, §6.24 이전에 이미 서브프로세스로 분리됨)와 달리 demux()/decode()(읽기) 개별 호출은 이 PyAV 11.0.0 빌드에서 GIL을 정상적으로 놓아준다.** 단, 이 테스트는 실제 운영 중인 동시성 규모(스레드 127개)를 재현하지 못했으므로 "다수 스레드의 GIL 획득 경합 누적 효과(convoy effect)" 자체를 완전히 배제하지는 못함 — 더 이상의 재현은 라이브 시스템에 위험 부하를 추가해야 해서 중단.

**수정 — 근본 메커니즘을 확정하지 못해도 구조적으로 면역이 되는 길을 선택**:

1. **`ingest_health_proxy.py`(신규)** — `/health`만 담당하는 완전히 별도의 OS 프로세스. `ingest_daemon.py`의 기존 API 서버는 이제 외부 포트가 아니라 `127.0.0.1:<내부 포트>`(기본 외부 포트+1, `INGEST_INTERNAL_HTTP_PORT`로 override)에서만 리슨하고, 이 프록시가 외부 포트를 대신 리슨한다.
   - `/health`: `_stats_sampler()`(1초 주기, 기존 스레드)가 매 tick 원자적으로(temp+`os.replace`) 남기는 heartbeat 파일(`{"ts", "cameras"}`, `INGEST_HEARTBEAT_FILE`)의 신선도만으로 즉답 — 실제 daemon의 GIL/스케줄링 상태와 완전히 무관. 5초(`HEARTBEAT_STALE_S`) 넘게 갱신 안 되면 503 반환 → 기존 Node측 watchdog(`ingestDaemonWatchdog.js`, 변경 없음)이 그대로 "진짜 죽었다"고 판단해 재시작 — 일시적 스케줄링 지연과 실제 다운을 구분하되, 진짜 다운일 때의 기존 복구 경로는 그대로 유지.
   - 나머지 모든 경로(`/cameras`, `/cameras/stats`, `POST/DELETE /cameras/...`)는 내부 포트로 투명 프록시. 이 경로들은 daemon이 실제로 바쁘면 여전히 느려질 수 있음 — 의도된 트레이드오프(watchdog이 보는 건 `/health`뿐).
   - 부모(`ingest_daemon.py`) 프로세스가 사라지면(`--parent-pid` 폴링, 2초 주기) 프록시도 몇 초 안에 스스로 종료 — 죽은 daemon이 외부 포트를 물고 있는 좀비 프록시를 남기지 않음. `start_new_session=True`로 별도 세션에 스폰해 부모의 프로세스 그룹에 무슨 일이 생겨도 안전.
   - **검증(라이브 시뮬레이션)**: 별도 포트로 독립 인스턴스를 띄워 (a) 평시 프록시 정상 동작, (b) `SIGSTOP`으로 메인 프로세스를 인위로 얼린 뒤 5초 후 503 확인 → `SIGCONT` 후 즉시 200 복귀, (c) `SIGKILL`로 메인 프로세스 종료 후 프록시가 ~2~3초 내 자체 종료+포트 반환 — 세 시나리오 모두 의도대로 동작 확인.
   - Node 측(`ingestDaemonWatchdog.js`, `ingestDaemonControl.js`, Admin API)은 **전혀 수정 불필요** — 외부에서 보는 포트·응답 형식이 그대로이므로 완전히 하위 호환.

2. **스레드 수 자체 축소** (§6.10/§6.34에서 이미 도입된 상한값들이 방치돼 있었음):
   - `AI_DECODE_THREADS_TOTAL`이 `server/.env`에서 주석 처리된 채라 기본값 `os.cpu_count()=40`이 그대로 적용 중 — 카메라 10대 기준 카메라당 4개(=40/10) 네이티브 디코드 스레드 허용. `20`으로 명시(카메라당 2개)해 ~20개 절감.
   - `INGEST_PUSH_WORKERS`(16→10)/`INGEST_STOP_WORKERS`(8→4) — 라이브 스택 덤프에서 두 풀 합쳐 idle 스레드 22개가 상시 대기 중임을 확인, 실사용량 대비 여유가 과했음.
   - `server/.env`·`.env.example`·`.env.streaming.example`·`.env.analysis.example` 전부 동기화.

**교훈**: "어느 한 줄이 GIL을 오래 쥐고 있는가"를 실증적으로 반증했다고 해서 문제가 사라지는 건 아니다 — 스레드 수 자체(합성 테스트로는 재현 못 한 규모)나 호스트 스케줄링 경합처럼 한 줄로 특정할 수 없는 누적 원인일 수 있고, 이런 경우 원인을 100% 특정하기보다 **원인과 무관하게 면역이 되는 구조(프로세스 경계)**를 세우는 편이 실용적이다. 단, 헬스체크만 우회하고 끝내면 "겉보기엔 건강한데 실제로는 서비스 불능"이 될 위험이 있으므로, 반드시 heartbeat처럼 실제 작업 루프에 연동된 살아있음 신호를 근거로 삼아야 한다(단순 프로세스 존재 여부만 확인하는 얕은 헬스체크였다면 오히려 상황을 악화시켰을 것).

**배포 직후 회귀 — 중복 `Content-Length` 헤더로 인한 실제 카메라 등록/삭제 전면 장애 (2026-07-28, 배포 당일 발견·즉시 수정)**: 이 daemon은 재시작할 때마다 디스크의 최신 코드를 그대로 로드하므로, 코드를 커밋한 직후 (아직 라이브 검증 전에) 진행 중이던 정상적인 watchdog 재시작 사이클을 통해 프록시가 프로덕션에 그대로 적용돼버렸다. 그 직후 `DELETE /cameras/:id`/`POST /cameras`가 대량으로 `fetch failed`(Node 측)/`ConnectionResetError`(내부 서버 측)로 실패하기 시작 — `curl`로는 재현되지 않아(관대한 파서) 처음엔 원인이 안 보였으나, 문제의 Node `fetch()` 패턴을 그대로 재현하는 별도 스크립트로 즉시 재현됨(격리 환경에서, 프로덕션은 그 사이 프록시를 `INGEST_HEALTH_PROXY_ENABLED=false`로 즉시 되돌려 정상화). 원인: `_proxy()`가 내부 서버 응답의 모든 헤더를 그대로 복사하면서 내부 서버 자신의 `Content-Length`까지 같이 복사하고, 그 뒤에 자기 `Content-Length`를 또 추가 — 응답에 `Content-Length`가 두 번 들어감(RFC 7230 위반). `curl`은 이를 관대하게 넘어가지만 Node의 `http`/`fetch`(undici) 파서는 `Parse Error: Duplicate Content-Length`로 하드 실패 — **curl로 프록시를 검증한 것은 이 버그를 놓치는 가짜 통과(false pass)였다.** 수정: 헤더 복사 시 `content-length`도 함께 제외. 격리 환경에서 Node `fetch()`/`http.request` 양쪽으로 20회 반복 재현 테스트 통과 확인 후 재배포.

**교훈**: 실제 소비자(Node)가 아니라 `curl`로만 새 HTTP 경로를 검증하면 클라이언트별 파서 엄격도 차이로 인한 버그를 놓칠 수 있다 — 프록시/게이트웨이류를 검증할 때는 반드시 실제 호출자가 쓰는 것과 동일한 클라이언트 라이브러리(여기서는 Node의 `fetch`)로 재현해야 한다. 또한 이번 배포 경로 자체가 "커밋 직후, 아직 아무도 재시작을 트리거하지 않았는데 daemon의 자체 watchdog 사이클이 알아서 최신 코드를 라이브에 실어 날랐다"는 것을 보여준다 — 이런 자동 재시작형 데몬에 코드를 수정할 때는 "다음 자연 재시작에서 바로 라이브에 적용된다"는 전제하에 작업해야 한다.

---

### 6.43 CAPTURE_FPS 보장 강화 — 카메라별 전용 슬롯 + latest-frame-wins 큐 + 스레드 우선순위 조정 (2026-07-28)

**증상**: §6.42 배포 후에도 daemon이 완전히 근절되지는 않고 간헐적으로 재차 wedge — 실측(3분 관측 창 1회): `08:10:32`~`08:10:52` 사이 `/health` 2회 연속 실패(즉 heartbeat 파일 자체가 5초 넘게 stale) → `IngestWatchdog`이 daemon 강제 재시작, 각 카메라는 "no frame for 46~49s" 후 캡처 재개. 이 구간 동안 streaming→analysis 전송 카운터(`total`)가 정확히 멈춰 있었음 — §6.42가 재발 **빈도**는 줄였지만(이전 관측 시 ~2분 간격) 근절은 못 했다는 뜻.

**추가 관찰 — 같은 wedge 구간에도 WebRTC 영상 재생은 멈추지 않음**: 사용자가 "analysis 전송은 끊기는데 영상 재생은 왜 안 끊기나"를 질의해 코드 추적한 결과, 두 경로의 근본적인 메커니즘 차이를 확인:

| 경로 | 메커니즘 | wedge 시 영향 |
|---|---|---|
| 영상/오디오 RTP → mediasoup | `_mux_passthrough()`가 카메라 io 스레드 안에서 **동기적으로** 로컬(`127.0.0.1`) UDP에 `out.mux(packet)` — 응답 대기 전혀 없는 fire-and-forget | 영향 없음(브라우저 jitter buffer가 짧은 지연도 흡수) |
| AI JPEG → Node → analysis 서버 | `_push_jpeg()`가 (당시) 전체 카메라 공유 세마포어를 확인 후 공유 스레드풀에 제출, 그 워커가 `urlopen()`으로 **Node 응답을 기다림** | 풀이 스케줄링을 못 받으면 지연·드롭 |

즉 "응답을 기다릴 필요 없는 로컬 fire-and-forget 전송"은 스레드 기아에 면역이고, "HTTP 응답을 기다려야 하는 공유 자원 작업"만 선택적으로 막힌다 — §6.41/§6.42의 스레드-수-축소 방향과는 별개로, **push 경로 자체의 동시성 모델**도 CAPTURE_FPS 보장을 깨는 원인이었다: 목표 fps 계산(`_ai_push_interval`)은 카메라별로 정확했지만, 실제 전송 성공 여부는 전체 카메라가 나눠 쓰는 세마포어 하나에 달려 있었고 실패 시 그냥 조용히 드롭했다(재시도·큐잉 없음).

**수정 — 3가지 병행 적용**:

1. **카메라별 전용 슬롯 분리** (`_ai_own_slot`) — 기존 전체 카메라 공유 `_SHARED_PUSH_SEMAPHORE`를 폐지. 카메라마다 전용 예약 1개(`threading.Semaphore(1)`) + 소량의 공유 overflow(`_AI_PUSH_OVERFLOW`, 기본 4)로 재구성해, 한 카메라의 push 부하가 다른 카메라의 fps를 빼앗지 못하도록 함. 또한 AI JPEG push(`_AI_PUSH_EXECUTOR`)와 App RTP(ONVIF) push(`_APP_RTP_EXECUTOR`)를 완전히 별도 풀/큐로 분리 — 이전엔 하나의 공유 `ThreadPoolExecutor`(FIFO 큐)를 같이 써서 ONVIF 이벤트 버스트가 AI 프레임 앞에 줄을 서 지연시킬 수 있었음.
2. **드롭 대신 latest-frame-wins 큐** (`_push_jpeg`/`_drain_ai_push`) — 세마포어가 가득 차면 프레임을 그냥 버리던 기존 방식을 폐지. `_push_jpeg()`는 이제 디코드 스레드에서 절대 블록되지 않고 `_ai_pending_frame`에 최신 프레임만 남긴 뒤(이미 draining 루프가 돌고 있으면 그걸로 끝), 이미 실행 중이 아니면 `_drain_ai_push()`를 새로 제출한다. `_drain_ai_push()`는 자기 전용 슬롯(또는 overflow)을 쥔 채 `_ai_pending_frame`이 빌 때까지 루프를 돌며 항상 "가장 최근 프레임"으로 수렴 — Node 쪽 `pipelineManager.js`의 `ctx._pendingFrame`/`_runPendingAnalysis()` latest-frame-wins 패턴과 동일한 설계를 daemon 쪽에도 적용한 것.
3. **스레드 스케줄링 우선순위 조정** (`_deprioritize_current_thread()`) — App RTP·stopper(teardown) 풀에만 `ThreadPoolExecutor(initializer=...)`로 각 워커 스레드 시작 시 `os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), +8)`를 적용해 스케줄링 우선순위를 낮춤. Linux는 POSIX 명세(프로세스 전체)와 달리 nice를 스레드별로 구현하므로 특정 스레드만 정확히 타겟팅 가능하고, nice를 **올리는**(우선순위를 낮추는) 방향은 무권한으로 허용되어 루트가 필요 없음(반대로 낮추는/올리는 방향은 `CAP_SYS_NICE` 필요). AI push·io/demux 스레드는 손대지 않아 상대적으로 스케줄러 관심을 더 받게 됨.

**검증**: 실제 `CameraSession` 클래스의 `_push_jpeg`/`_drain_ai_push`/`_encode_and_post_ai` 메서드를 `object.__new__(CameraSession)`으로 `__init__`(RTSP 연결 등) 없이 인스턴스화하고 `_encode_and_post_ai`만 페이크로 교체하는 격리 스크립트로 확인(재구현이 아니라 실제 코드 경로 실행):
- 자기 자신의 encode가 느려도(50ms) 빠르게 연속 push된 프레임 중 최신 프레임은 반드시 전달됨, 중간 프레임은 의도대로 coalesce되어 스킵됨
- 공유 overflow가 완전히 고갈된 상태에서도 카메라 자신의 전용 슬롯으로 정상 전달됨(다른 카메라 부하로 starve 안 됨)
- 한 카메라가 300ms 느리게 encode하는 동안, 다른 카메라는 0ms 지연으로 독립적으로 완료(공유 직렬화 지점 없음)

**신규 환경변수**: `INGEST_AI_PUSH_WORKERS`(24)/`INGEST_AI_PUSH_OVERFLOW`(4)/`INGEST_APP_RTP_WORKERS`(4) — 기존 `INGEST_PUSH_WORKERS`는 폐지(대체). `server/.env`+3개 `.env*.example` 전부 동기화.

**교훈**: 목표 fps를 정확히 "계산"하는 것과 그 프레임을 실제로 "전달"하는 것은 별개의 보장이다 — 계산이 맞아도 전달 경로가 공유·drop-on-full 자원 모델이면 fps 보장은 깨진다. 또한 같은 장애 상황에서 어떤 경로는 멀쩡하고 어떤 경로는 끊기는 비대칭이 관찰되면, 그 자체가 "응답 대기가 필요 없는 로컬 전송 vs. 응답을 기다려야 하는 공유 자원 작업"처럼 중요한 아키텍처 단서가 된다 — 증상의 비대칭성을 근본 원인 진단에 적극 활용할 것.

---

### 6.44 TCP listen backlog 확대 + GIL switch interval 조정 (2026-07-28)

**증상**: §6.43 배포 후에도 daemon이 여전히 간헐적(수십초~수 분 간격)으로 wedge — `dmesg`에서 `TCP: request_sock_TCP: Possible SYN flooding on port 7070`을 반복 확인. `ThreadingHTTPServer`(`ingest_daemon.py`, `ingest_health_proxy.py` 양쪽 모두)의 listen backlog가 Python `socketserver`의 기본값 **5**로 방치되어 있었음 — 카메라 9대 + Node의 각종 폴러(watchdog 20초, stats aggregator 1.5초, Admin Dashboard)가 겹치면 이 작은 큐가 순식간에 차서 SYN flood 상태로 전환되고, accept 지연 → backlog 추가 적체의 악순환 가능성.

**1차 조치 — listen backlog 128로 확대**: `ingest_daemon.py`/`ingest_health_proxy.py` 양쪽에 `ThreadingHTTPServer`를 상속한 `request_queue_size` 오버라이드 클래스 추가 (`INGEST_LISTEN_BACKLOG`, 기본 128, 커널 `net.core.somaxconn`=65535로 clamp 없이 적용 확인). **재검증 결과 wedge 재발은 막지 못함** — SYN flood는 원인이 아니라 "daemon이 이미 멈춰있는 동안 쌓인 연결 시도"의 **증상**이었던 것으로 판명.

**실증 진단(strace)**: wedge 순간을 자동 감지해 즉시 `strace -f -tt -T`를 붙이는 스크립트로 실제 wedge 초입을 포착 — **4초 동안 49,533회의 `futex()` 호출(초당 ~22,000회, 96개 스레드 관여)이 발생했고, 그 사이 `connect`/`read`/`write` 등 실제 I/O syscall은 단 하나도 없었음**. CPython GIL의 기본 전환 간격(5ms)마다 다수 스레드가 동시에 깨어나 GIL을 재요청하는 "GIL 스래싱(thrashing)" 라이브록 — §6.42가 "재현 못했다"고 남겨둔 "스레드 127개 규모의 GIL convoy effect"를 실측으로 확인한 것.

**2차 조치 — `sys.setswitchinterval()` 확대**: daemon 시작 시 `sys.setswitchinterval(INGEST_GIL_SWITCH_INTERVAL)`(기본 0.05초, 5ms 기본값 대비 10배) 적용 — 스레드가 GIL을 덜 자주 재요청하도록 해 스래싱 자체를 줄이려는 시도. **단독 재시작 검증 결과 재발 간격(약 90초)에 뚜렷한 개선 없음** — 근본 원인이 스레드 수 자체(GIL 재요청 빈도와 무관하게, 스레드 개수가 많으면 매 전환마다 경합할 후보가 많음)임을 시사.

**신규 환경변수**: `INGEST_LISTEN_BACKLOG`(128), `INGEST_GIL_SWITCH_INTERVAL`(0.05) — 둘 다 이 자체만으로는 wedge 재발을 막지 못했지만, 향후 스레드 수 자체를 줄이는 §6.45와 함께면 유효할 수 있어 유지.

**교훈**: 증상(SYN flood 경고)과 원인을 혼동하기 쉽다 — "이미 멈춘 프로세스에 몰리는 연결 시도"가 만드는 로그가 "연결 처리 능력 부족"처럼 보일 수 있음. 실측(strace)으로 실제 syscall 패턴을 잡기 전까지는 완화책(backlog 확대)이 진짜 원인을 다루는지 확신할 수 없다.

---

### 6.45 멀티 프로세스 ingest-daemon 플릿 — 구조적 GIL 분리 (2026-07-28)

**배경**: §6.41~§6.44까지 총 6가지 단일 프로세스 완화책(스레드 수 축소, HTTP 컨트롤플레인 분리, 카메라별 push 슬롯+latest-frame-wins, nice 우선순위 상승, listen backlog 확대, GIL switch interval 조정)을 시도했으나 전부 wedge 재발 자체를 막지 못했다. §6.44의 strace 실증(스레드 96개, 초당 futex() ~22,000회, 실제 I/O 0회)은 이 문제가 daemon 내부의 어떤 한 줄이 아니라 **단일 GIL을 두고 경합하는 스레드 수 자체**가 임계치를 넘었을 때 발생하는 구조적 한계임을 시사했다.

**결정**: 카메라를 카메라ID 해시 기반으로 **여러 독립 OS 프로세스**(각자 자기 GIL)로 분산 — `webrtc/mediasoupEngine.js`가 이미 mediasoup Worker pool에 쓰고 있는 것과 동일한 패턴(`_workerIndexFor`)을 그대로 재사용. 코드 레벨 튜닝으로는 해결 안 되는 문제이므로, 프로세스 경계로 GIL 자체를 나누는 구조적 해법을 택함.

**구현**:
- **`server/src/utils/cameraHash.js`(신규)** — `mediasoupEngine.js`의 해시 함수(`h = h*31 + charCode`, `% modulus`)를 그대로 추출한 공용 유틸. `mediasoupEngine.js`의 `_workerIndexFor()`는 이 유틸을 호출하도록 리팩터링(동작 변화 없음, 순수 추출).
- **`server/src/services/ingestDaemonPool.js`(신규)** — "인스턴스가 몇 개인지, 각각의 포트/URL이 무엇인지, 어떤 cameraId가 어느 인스턴스 소속인지"의 단일 소스. `INGEST_DAEMON_INSTANCES`(기본 1) × `INGEST_DAEMON_BASE_PORT`(기본: `INGEST_DAEMON_ADDR`에서 유도)로 인스턴스 i의 외부 포트 = `base + i*10`(10 간격은 각 인스턴스 자신의 내부 health-proxy 포트=외부+1을 위한 여유). 카메라→인스턴스 배정은 **재시작마다 다시 해싱, 저장 안 함**(mediasoup의 `workerIndex` 캐싱과 달리 ingest-daemon 인스턴스는 서로 독립된 HTTP 서비스라 "같은 슬롯 유지" 제약이 없음 — cameraId 해시의 순수 함수라 항상 같은 결과, DB 스키마 변경 불필요).
- **인스턴스별 heartbeat 파일** — `ingest_daemon.py`의 `INGEST_HEARTBEAT_FILE`(기존 env var, 코드 변경 없음)을 인스턴스마다 고유 경로로 spawn — 안 그러면 여러 인스턴스의 `_stats_sampler()`가 같은 파일을 덮어써 서로 다른 인스턴스의 health-proxy가 남의 heartbeat를 읽는 문제 발생.
- **`server/src/scripts/startServer.js`** — 단일 자식 프로세스 spawn/감시/재시작 로직을 인스턴스 배열로 일반화. 각 인스턴스는 독립된 재시작 시도 횟수·헬스체크·orphan kill을 가지며, `_killPortOrphan()`의 `pkill -f 'ingest_daemon.py'`(이름만 매칭 — 다중 인스턴스에서 전부 죽이는 버그)를 `pkill -f "ingest_daemon.py --addr :PORT"`(이 인스턴스의 cmdline만 매칭)로 수정. 재시작 후 재등록(`POST /api/internal/ingest/reregister`)에 `instanceIndex`를 실어 보내 **그 인스턴스의 카메라만** 재등록(다른 인스턴스는 멀쩡하므로 건드릴 필요 없음).
- **`server/src/services/ingestDaemonControl.js`** — `getConfig(instanceIndex=0)`이 `ingestDaemonPool`에서 포트/URL을 가져오도록 변경. `startDaemon`/`stopDaemon`/`restartDaemon`은 `instanceIndex` 생략 시 전체 인스턴스에 대해 동작하는 `_runAllInstances()`로 위임 — **인스턴스가 1개면 기존과 완전히 동일한 flat 응답**을 반환(하위 호환의 핵심 분기점), 2개 이상이면 `{ok, instances:[...]}`로 래핑. `reregisterCameras()`의 DB-직접-읽기 폴백 경로도 이 인스턴스 소속 카메라만 필터링하도록 수정.
- **CLI(`{start,stop,restart}IngestDaemon.js`) + `POST /admin/ingest/{start,stop,restart}`** — `--instance=<n>` 플래그 / `body.instance`로 특정 인스턴스 타겟팅, 생략 시 전체.
- **`ingestDaemonWatchdog.js`** — 인스턴스마다 독립된 `setInterval`(자기만의 실패 카운터/쿨다운) — 한 인스턴스의 장애가 다른 인스턴스의 헬스체크 주기를 밀리지 않게 하고, 재시작도 실패한 인스턴스만 대상으로 함.
- **`ingestStatsAggregator.js`** — 모든 인스턴스의 `/cameras/stats`를 병렬로 fetch 후 flatten. Admin Dashboard 페이로드가 이미 카메라별 배열이라 클라이언트 쪽 변경 불필요.

**하위 호환**: `INGEST_DAEMON_INSTANCES` 미설정 시 위 모든 모듈이 정확히 인스턴스 1개(포트 7070)로 동작 — 기존 단일 배포는 코드·설정 변경 없이 그대로 동작.

**이번 배포**: 9대 카메라 플릿에 `INGEST_DAEMON_INSTANCES=3`(카메라당 ~3대, 스레드 수 96→인스턴스당 ~32개 예상) 적용.

**신규 환경변수**: `INGEST_DAEMON_INSTANCES`(기본 1), `INGEST_DAEMON_BASE_PORT`(선택, 기본은 `INGEST_DAEMON_ADDR`에서 유도).

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
| 1.37 | 2026-07-21 | §6.27 재보완 — v1.36의 프로액티브 재연결을 사용자 실측 피드백("재연결로 채널 영상이 정지되고 refresh됨, 근본원인 파악 필요")에 따라 되돌림: `bufferSaturatedTicks`/`BUFFER_SATURATED_TICKS_LIMIT` 및 관련 카운터 갱신·리셋·판정 분기 전부 제거, 프로액티브 jitterBufferTarget escalation(버퍼 목표치만 올리는 부분)은 유지, 스톨 감지는 기존 20~25초 프레임/바이트 워치독으로 환원 — 재연결이 증상을 매번 리셋해 근본 원인 관찰을 방해하던 부작용 제거, `chrome://media-internals` 대조를 통한 근본 원인 확정이 다음 단계로 여전히 열려있음. `npx tsc --noEmit`/`npm run build` 클린 통과 확인 |
| 1.38 | 2026-07-21 | §6.27 재보완 — 사용자가 제공한 `chrome://media-internals` `kWebMediaPlayerDestroyed` 이벤트(재생 38.029초만에 발생, UTC 05:15:12.539)를 서버 로그와 밀리초 단위로 대조: 동일 카메라의 `DTLS ... closed` 로그가 정확히 같은 시각에 기록되고 연결 수명이 매번 33~38초로 반복됨을 확인 — `TRANSPORT_MAX_LIFETIME_MS=90s`와는 무관하며, 클라이언트 자체 `STALL_MS`/`FRAME_STALL_MS`(25~33초/20~28초) + 폴링 지연 + `AUTO_RETRY_DELAY`(3초) 합산 범위(23~41초)와 거의 정확히 겹쳐, 서버가 아니라 **클라이언트 자신의 스톨 워치독이 방아쇠일 가능성**으로 조사 방향 전환(브라우저 콘솔 로그로 최종 확인 필요, 여전히 미확정). 별개로 사용자가 보고한 "Buffer/Latency가 0ms↔900ms+로 반복 진동" 결함의 원인도 확정·수정: 최근 `rxHistory` 샘플링이 1초 주기 `rateTimer`로 이전되며 `bufferMs`가 emit된 새 프레임이 없는 틱마다 0으로 폴백해 다음 틱에 보정 스파이크가 발생하던 톱니파 버그 — `lastKnownBufferMs` 이월 방식으로 수정(5초 주기 `statsTimer`의 스톨 워치독/escalation 로직은 미변경). `npx tsc --noEmit`/`npm run build` 클린 통과 확인 |
| 1.39 | 2026-07-21 | §6.28 신규 — 카메라별 Pause/Resume 기능 추가: `pipelineManager.pauseCamera()`(기존 `stopCamera()` 재사용 후 상태만 `'paused'`로 오버라이드) + `updateCameraStatus()` public 래퍼, `youtubeStreamService.pauseStream()`/`resumeStream()`(기존 `restartStream()`의 `_stopEntry(entry, false)` 재사용), `POST /api/cameras/:id/stream/pause`·`/resume` 신규 라우트, 서버 재시작 시 `status==='paused'` 카메라를 자동시작 스윕에서 제외(`index.js`, `youtubeStreamService.init()`). 프론트엔드 반영은 `Design_Channel_Slot.md` §5.3b 참고 |
| 1.40 | 2026-07-21 | §6.27 최종 결론 — 이번 세션 전체를 관통한 재생 불가 증상의 실제 근본 원인 2건 확정: (1) `ingest-daemon` 프로세스가 완전히 다운되어 있어(포트 7070 connection refused) 서버 재시작마다 카메라가 mediasoup에 등록 안 되고 "WebRTC disabled"로 시작(`npm run ingest:start`로 복구), (2) `profileLevelId`가 `addCameraStream()` 시점 1회만 캐싱되는 구조라 ingest-daemon 다운 중 폴링 예산(5초) 초과 시 폴백값 Baseline(`42e01f`)이 영구 고착 — 실제로는 High Profile(`640032`)인데도 낮은 Level(3.1)로 협상되어 고해상도 카메라가 일부 프레임만 디코드하다 멈춤(`POST /stream/reconnect`로 캐시 재고침해 미봉책 적용, 근본 수정은 후속 과제로 명시). 조사용 임시 SDP 디버그 로그 제거 |
| 1.41 | 2026-07-21 | §6.27 재재보완 — "데이터 수신은 정상인데 Buffer만 주기적으로 900ms+" 현상의 진짜 근본 원인 확정: 프로액티브 jitterBufferTarget escalation이 `bufferMs`(우리가 `videoReceiver.jitterBufferTarget`으로 직접 명령한 결과가 그대로 반영되는 지표)를 트리거로 삼아 자기강화 피드백 루프를 형성 — STEP_UP/STEP_DOWN 5~10배 비대칭 때문에 정상적인 지터 한 번만으로도 15~20초 만에 상한(1000ms)까지 폭주. `useWebRTC.ts` escalation 트리거에서 `bufferMs` 조건 제거, 우리가 직접 조작하지 않는 `freezeDelta`/`lossDeltaForAdapt`(진짜 프리즈·패킷손실)만으로 판단하도록 수정 — 데이터 수신량과 무관했던 자기유발 문제였음을 확정. 별도로 Node.js 이벤트 루프 지연 모니터(`eventLoopLag.js`) 신규 추가(200ms+ 블로킹 시 로그, 실측 233ms/217ms 확인). `npx tsc --noEmit`/`npm run build` 클린 통과 |
| 1.42 | 2026-07-21 | §6.27 재재재보완 — `profile-level-id=42e01f`가 재연결마다 무작위로 재발하던 진짜 원인 확정: `negotiate()`가 WHEP 재협상마다 매번 `_ingestGetVideoParams()`를 재시도 없이 2초 타임아웃으로 단발 호출하는데, ingest-daemon이 바쁠 때(250%+ CPU) 실패하면(로그 `video-params not available yet` 하루 133회 확인) Producer의 하드코딩 Baseline(`42e01f`) 기본값으로 조용히 폴백하던 구조 — `addCameraStream()` 시점 1회 캐싱이라는 v1.40의 이해는 부정확했음, 실제로는 매 negotiate마다 fresh fetch. `mediasoupEngine.js`에 `_lastKnownVideoParams` 캐시 신규 추가 — fetch 성공 시 갱신, 실패 시 Baseline이 아니라 마지막 성공값으로 폴백(카메라 실제 프로파일은 재연결 사이 안 바뀌므로), 기존 H.265 진단용 `_pollVideoCodec()`도 성공 시 같은 캐시를 선제 예열, `removeCameraStream()`에서 캐시 정리 추가 |
| 1.70 | 2026-07-28 | §6.45 신규 — §6.41~§6.44의 단일 프로세스 완화책 6가지가 전부 GIL 스래싱 재발을 못 막은 뒤, 카메라를 cameraId 해시 기반 여러 독립 ingest-daemon OS 프로세스(각자 GIL)로 분산하는 구조적 해법 도입. `cameraHash.js`/`ingestDaemonPool.js` 신규, `mediasoupEngine.js`/`pipelineManager.js`/`ingestDaemonControl.js`/`startServer.js`/`ingestDaemonWatchdog.js`/`ingestStatsAggregator.js`/admin API/CLI 전부 인스턴스 인식형으로 수정. `INGEST_DAEMON_INSTANCES` 미설정 시 기존과 완전 동일(하위호환), 이번 배포는 9카메라에 인스턴스 3개 적용 |
| 1.69 | 2026-07-28 | §6.44 신규 — TCP listen backlog(기본 5→128) 확대 시도했으나 wedge 재발 못 막음(SYN flood는 원인 아닌 증상으로 판명). 자동 strace 캡처로 wedge 초입 실증: 96스레드에서 초당 futex() ~22,000회, 실제 I/O 0회 — GIL 스래싱 확인. `sys.setswitchinterval()` 5ms→50ms 조정도 단독으로는 개선 미미 |
| 1.68 | 2026-07-28 | §6.43 신규 — §6.42 이후에도 재발하던 wedge 구간 중 WebRTC 영상은 안 끊기고 analysis 전송만 끊기는 비대칭을 근거로, push 경로 자체의 동시성 모델(전체 카메라 공유 세마포어 + drop-on-full)을 재설계. 카메라별 전용 슬롯(`_ai_own_slot`) + latest-frame-wins 드레인 루프(`_drain_ai_push`)로 드롭 대신 항상 최신 프레임 수렴을 보장, AI JPEG push(`_AI_PUSH_EXECUTOR`)와 App RTP push(`_APP_RTP_EXECUTOR`)를 별도 풀로 분리, App RTP·stopper 풀은 `os.setpriority`로 스케줄링 우선순위 하향(무권한). 실제 `CameraSession` 메서드를 구동하는 격리 검증 스크립트로 3개 시나리오(자기-지연 coalescing, overflow 고갈 시 전용 슬롯 보장, 카메라 간 독립성) 확인 |
| 1.67 | 2026-07-28 | §6.42 신규 — §6.41 조치 후에도 남아있던 ingest-daemon 자체의 주기적(~2.3분) 응답 불능을 라이브 SIGUSR1 스택 덤프 + 실증 GIL 테스트(demux/decode는 GIL을 정상적으로 놓아줌을 확인)로 진단. `ingest_health_proxy.py` 신규(HTTP 컨트롤플레인을 별도 프로세스로 분리, heartbeat 파일 기반 /health 즉답 + 나머지 경로 투명 프록시), `AI_DECODE_THREADS_TOTAL`/`INGEST_PUSH_WORKERS`/`INGEST_STOP_WORKERS`로 스레드 수 자체도 축소 |
| 1.66 | 2026-07-28 | §6.41 신규 — 고아 `startServer.js`(관리 대상 index.js는 죽고 슈퍼바이저만 잔존)가 재시작 시도마다 헬스체크 없이 `pkill -f 'ingest_daemon.py'`로 정상 데몬을 죽여 fleet 전체 fps가 간헐적으로 0이 되던 결함 수정. `_respawnIngest()`에 `_isIngestHealthy()` 게이트 추가 — 포트의 데몬이 이미 healthy면 죽이지 않고 물러남 |
| 1.65 | 2026-07-27 | §6.40 신규 — Streaming Dashboard 8개 카메라가 RETRY/Offline(WebRTC 영상 자체는 정상 재생 중)이던 원인 확정: ingest-daemon HTTP 스레드 wedged(§6.29.5 계열) + 이미 있던 자동 복구 `ingestDaemonWatchdog.js`(§6.29.9)가 `server/.env`의 `INGEST_WATCHDOG_ENABLED=false`(과거 디버깅 세션 후 원복 누락)로 비활성화돼 있어 자동 복구가 무력화된 상태로 최소 수일 방치. `.env` 원복 + `ingest:restart`로 즉시 복구, `armDebugDisableSafetyNet()` 신규 추가로 디버깅용 비활성화가 30분 후 자동 강제 재활성화되도록 안전장치 도입 |
| 1.64 | 2026-07-24 | §6.39 신규 — §6.38의 MediaMTX 직접 우회가 `webrtcEnabled` 카메라에만 적용되고 RTSP-over-WebSocket 전용(`rtspOverWebSocketEnabled`, `webrtcEnabled=false`) 카메라에는 적용되지 않던 결함 수정. `needsMediaMTX`에 `rtspOverWebSocketEnabled` 반영, `cameras.js`의 `needsRestart`도 `rtspOverWebSocketEnabled` 변경 시 재시작하도록 동기화. 재측정 ~13.5fps → 28~31fps 복구 확인 |
| 1.63 | 2026-07-24 | §6.38 신규(아키텍처) — fleet 부하로 인한 개별 카메라 프레임레이트 저하가 §6.37 이후에도 잔존(GIL 경합은 fan-out 하나만의 문제가 아니었음). `WEBRTC_ENGINE=mediamtx`가 이미 만들어둔 MediaMTX 직접(non-GIL) 경로를 RTSP-over-WebSocket가 우선 재사용하도록 변경 — ingest-daemon 완전 우회. "GIL 회피보다 우회가 우선일 수 있다"는 일반 원칙으로 정리 |
| 1.62 | 2026-07-24 | §6.37 신규 — §6.29.5에서 미확정으로 남겼던 CPython GIL 경합 가설을 실측으로 확정: PyAV RTSP `mux()`가 블로킹 네트워크 쓰기 동안 GIL을 놓지 않아, 스레드 분리만으로는 카메라 자신의 읽기 루프를 못 지킴(py-spy 없이 spin-counter 스레드로 격리 실험). `rtsp_publish_worker.py` 별도 프로세스로 근본 해결 — 향후 유사 fan-out 추가 시 일반 원칙으로 기록 |
| 1.61 | 2026-07-23 | §6.36 신규 — §6.35과 동일한 `fuser`/`lsof` ptrace_scope 결함이 `startServer.js`의 크래시 자동재시작 경로(`_killPortOrphan()`)에도 남아있어 무한 재시작 크래시 루프를 실측(`attempt #14`)로 확인, `restartIngestDaemon.js`와 동일하게 `pkill -f`/`isPortFree()` 폴링/`pkill -9 -f` 에스컬레이션으로 교체 |
| 1.60 | 2026-07-23 | §6.35 신규 — `restartIngestDaemon.js`의 포트-해제 확인이 `_getPortPid()`(`lsof`)에 의존해, `kernel.yama.ptrace_scope=1` 호스트에서 다른 세션이 기동한 좀비 daemon을 `lsof`가 못 찾아 "포트 해제됨"으로 즉시 오판 → SIGKILL 에스컬레이션이 건너뛰어져 새 daemon이 `EADDRINUSE`로 무한 재시작 크래시하던 결함 수정. `isPortFree()`(실제 bind 시도, ptrace 무관·크로스플랫폼)로 판단 기준 교체, SIGKILL 단계에 `pkill -9 -f` 폴백 추가. 재발한 좀비 daemon 대상 실측 검증(SIGKILL 정상 에스컬레이션, 카메라 9대 전부 재등록·`streaming` 복구 확인) — `ingestDaemonWatchdog.js`(§6.29.9)의 자동 복구 경로도 동일하게 정상화됨. daemon 자체가 왜 반복 좀비화되는지(§6.29.5/§6.34)는 여전히 미해결 |
| 1.59 | 2026-07-23 | §6.34 신규 — `AI_DECODE_THREADS`가 카메라 대수만큼 곱해져(9대×8=72 네이티브 디코드 스레드, 전체 140 OS 스레드) `/health`가 8~10초+ 무응답이 되고 재시작이 SIGKILL 에스컬레이션에 상시 의존하던 결함을 SIGUSR1 스택 덤프(프로세스 kill 없이 진단)로 확정 — `AI_DECODE_THREADS_TOTAL`(기본값 `os.cpu_count()`) 신규 도입, 카메라별 `thread_count`를 고정값 대신 `max(1, min(AI_DECODE_THREADS, AI_DECODE_THREADS_TOTAL // 활성_카메라수))`로 매 (재)연결마다 동적 계산해 fleet-wide 네이티브 스레드 총수를 카메라 대수·설정값과 무관하게 상한. `ingest_daemon.py` + `.env`/`.env.example`/`.env.streaming.example`/`.env.analysis.example` 4종 동시 수정 |
| 1.57 | 2026-07-22 | §6.32 신규 — ingest-daemon RTP 송신 소켓 `buffer_size` 옵션이 §6.18 이후 계속 조용히 무시되던 버그(muxer-vs-protocol 옵션 혼동) 발견·수정(URL 쿼리스트링 방식으로 전환), 4개 fan-out 지점 전부 적용. 만성 패킷 손실(NACK 무응답, framesDecoded=0)의 진짜 근본 원인으로 확정 — 수정 후 손실률 55~63%→0.2~0.4%. ingest-daemon 단독 재시작 후에는 `POST /api/internal/ingest/reregister` 호출이 필요함을 명시적으로 확인 |
| 1.56 | 2026-07-22 | §6.31.3 신규 — §6.31.2 복구 후 재차 "영상 안 나옴" 보고, 이번엔 daemon 다운이 아님을 먼저 확인(둘 다 healthy). `LTS_DEBUG_SDP`를 `console.log` 대신 `fs.appendFile`로 직접 파일 기록하도록 수정(로거의 debug-강등 문제 근본 회피) — 실제 SDP 확인 결과 이상 없음, 재시작 자체가 "나쁜 상태에 갇힌 PeerConnection"을 정리하며 정상화. 두 가지 개별 원인 확정: (1) `61813f62` 물리 카메라가 일시적으로 RTSP 연결 거부(코드 무관, 카메라측), (2) `yt-9bb39`는 YouTube URL 갱신 재시도 타이밍과 브라우저 협상이 겹쳐 지연 fan-out 등록이 82초 지연됨(§6.16 기존 이슈와 연관). `npm run start`(전체 스택) 시 ingest-daemon 로그가 `/tmp/ingest-daemon.log`가 아니라 통합 로그의 `[Ingest]` 접두사로 감을 발견·기록(향후 진단 시 경로 혼동 방지) |
| 1.55 | 2026-07-22 | §6.31.2 신규 — §6.31.1(스케줄링 우선순위) 적용 후에도 "영상 재생 완전 불가" 지속 보고. NIC 링버퍼 확장(사용자 sudo 적용)만으로는 drop률 개선 없음을 재확인 후, `GET /api/webrtc/monitor`의 서버측 통계로 mediasoup Producer가 실제로는 완벽(score 10, 수백MB 정상 수신)했음을 발견 — 진단 방향이 잘못됐을 가능성 포착. `LTS_DEBUG_SDP=true`가 로거의 `debug` 단어 자동 강등 휴리스틱(`[SDP-DEBUG]`의 하이픈 경계가 "debug" 단어로 인식됨)에 걸려 `LOG_LEVEL=INFO`에서 조용히 필터링되고 있었음을 발견, `LOG_LEVEL=DEBUG`로 전환해 재시작한 직후 진짜 원인 확정: **ingest-daemon 프로세스가 조사 도중 완전히 다운**(`ECONNREFUSED 127.0.0.1:7070`) — 재등록 로그에 video RTP 포트 자체가 빠져있었음(`[AI+appRTP]`만, `vRTP:PORT` 없음). 이번 세션 후반부의 "0 프레임" 급성 증상 대부분은 mediasoup/Worker 튜닝과 무관하게 **ingest-daemon 다운**이 직접 원인이었다는 뜻 — 다만 §6.30.2/§6.31의 멀티 Worker·스케줄링 개선 자체는 별도로 유효. `npm run ingest:restart`로 즉시 복구, 실시간 관측으로 3개 카메라 전부(`yt-9bb39` 232프레임, `61813f62` 740+프레임, `4e562747` 882+프레임, 모두 계속 증가) 정상 디코딩 재개 확인. 진단용 `LOG_LEVEL=DEBUG`/`LTS_DEBUG_SDP=true`는 원복(`INFO`/주석 처리) 후 재시작 반영 완료. 교훈: 이런 다계층 증상은 mediasoup 통계보다 `curl :7070/health`로 ingest-daemon 생존부터 먼저 확인할 것 |
| 1.54 | 2026-07-22 | §6.31.1 신규 — §6.31 배포 후 재현된 `61813f62`(2048×1536) 스톨을 재조사, 해시 배정으로 해당 카메라가 Worker를 단독 사용 중인데도(경합 없음) CPU 2.9~4.7%에서 Recv-Q 적체 재현됨을 확인 — Worker 개수가 아니라 공유 호스트(27명)의 스케줄링 지연이 원인일 가능성으로 이동. `os.setPriority()`로 Worker 프로세스 nice값을 낮추는(`-5`, `MEDIASOUP_WORKER_PRIORITY`) 조치 추가, `CAP_SYS_NICE` 없이는 조용히 경고만 남기고 무해하게 스킵 — `sudo setcap` 1회 필요(비대화형 세션이라 사용자 실행 안내만). 검증은 setcap 적용 후 재시작 대기 중 |
| 1.53 | 2026-07-22 | §6.31 신규 — §6.30.2에서 확정한 mediasoup 단일 Worker 병목을 사용자 요청으로 같은 날 구현: 전역 `_worker`/`_router`를 8-Worker 풀로 교체(카메라 해시 배정, `MEDIASOUP_NUM_WORKERS` 신규 env var, `.env`/`.env.example` 3종 문서화). 상세는 `Design_Mediasoup_Multi_Worker.md` v2.0. 스모크 테스트+실배포 검증, 초기 3분 관측에서 5MP 카메라 스톨 빈도 개선 신호(표본 작음) |
| 1.52 | 2026-07-22 | §6.30.2 신규 — 사용자가 "ingest-daemon→mediasoup 릴레이에서 프레임이 새는 것 아니냐" 가설 제기, 라이브 검증으로 확정: `/proc/net/snmp`의 `Udp.RcvbufErrors`가 초당 ~7건씩 실시간 증가 중, `ss -u -a -n -p`로 mediasoup-worker 자신의 UDP 소켓 Recv-Q가 최대 3.8MB까지 쌓여있음을 직접 확인 — 단일 mediasoup Worker(40코어 중 1개만 사용)가 일부 소켓 처리를 못 따라가는 구조적 병목으로 추정. 비대칭 발견: mediasoup 수신측(§6.18에서 8MB로 확장)과 달리 `ingest_daemon.py`의 송신측 RTP 소켓 4곳은 OS 기본 버퍼(~208KB)를 그대로 사용 중이었음 — `_RTP_SEND_BUFFER_SIZE=8MB` 신규 상수로 대칭 수정, `ingest:restart`로 배포 및 정상 재등록 확인. 구조적 병목(멀티 Worker 미사용) 자체는 별도 설계 문서로 분리하기로 사용자와 합의(§6.31 예정). 사용자가 별도 보고한 "새로고침 후 Codec 정보 `-`" 증상은 이번 재시작으로 함께 새로고침된 §6.27의 기존 `profileLevelId` 캐시 고착 가설과 이번 세션의 릴레이 손실 가설이 모두 설명 가능해 원인 미확정 — 재현 여부 재확인 필요 |
| 1.51 | 2026-07-22 | §6.30.1 신규 — §6.30 배포 직후 동일 카메라(2560×1920)에서 재현 보고, 이번엔 raw stat 표시 결함이 아니라 실제 디코더 정지임을 확정(bytesReceived는 계속 증가, framesDecoded만 고정). `ingest_daemon.py`에 RTCP 처리 코드가 전혀 없어 브라우저/mediasoup의 키프레임 재요청(PLI)이 실제 카메라까지 도달할 경로가 구조적으로 없음을 코드로 확인. `GET /api/client-logs` 실측 조회로 "재연결이 전혀 안 된다"는 사용자 체감과 달리 프레임 스톨 워치독이 78분간 104회, 25~45초 간격으로 이미 끊임없이 재연결을 시도 중이었음을 확정(대부분 재고착, 카메라의 다음 키프레임 타이밍과 우연히 맞을 때만 일시 회복) — 클라이언트 재연결 로직 자체는 결함이 아니라는 결론. 대응 방안 3가지(카메라 GOP 단축/ingest-daemon RTCP PLI 포워딩 신규 구현/클라이언트 상태 표시 개선) 제시, 사용자 결정 대기 — 신규 코드 변경 없음, 진단·근거 기록 |
| 1.50 | 2026-07-22 | §6.30 신규 — 사용자가 5MP(2560×1920) 카메라에서 통계 패널 "0fps 반복" 보고, `framesDecoded` 정상 증가/`dropped=0`/Buffer·Latency 정상 범위로 미루어 실제 프리즈가 아니라 raw `RTCInboundRtpStreamStats.framesPerSecond`의 표시 결함으로 진단 — `useWebRTC.ts` `rateTimer`가 `framesDecoded` 델타/경과시간으로 fps를 직접 계산하도록 수정(§buffer-oscillation과 동일 패턴). 스톨 워치독은 이미 raw `framesDecoded` 카운터를 직접 비교해 이번 수정과 무관 — 순수 표시 정확도 개선. `npx tsc --noEmit`/`npm run build` 클린 통과, 실사용 재현 확인 대기 |
| 1.49 | 2026-07-21 | §6.29.14/§6.29.15 신규 — v1.48 배포 직후 사용자가 "현재 WebRTC의 모든 채널이 0fps"라고 긴급 보고, 원인은 ingest-daemon에 34개(!) 카메라가 등록되어 과부하 상태였던 것 — 백그라운드에서 자동 실행 중이던 TC 스위트(TcRunnerService.runOnStartup)가 실제 카메라를 계속 생성/삭제하며 라이브 시청과 ingest-daemon 자원을 놓고 경쟁한 것이 원인. `TC_STARTUP_RUN=false`로 자동 실행을 끄고 잔여 테스트 카메라를 정리해 즉시 복구(§6.29.14). 복구 과정에서 사용자가 특정 채널의 `profile-level-id=42e01f`(Baseline 폴백) 재현을 보고해 SDP 변수 덤프로 재검증했으나 코드 자체는 정상 동작 확인(§6.29.14) — 그러나 삭제했던 테스트 카메라들이 재시작 후 원래 생성시각 그대로 되살아나는 것을 발견하며 훨씬 더 근본적인 버그를 확정: **`MongoDatabase.flushNow()`가 완전한 no-op**이었다 — `_persist()`가 `_mongo.remove()`/`upsert()`를 fire-and-forget으로 던지고 반환값을 아무도 추적하지 않아, `DELETE /api/cameras/:id`가 `{success:true}`를 응답한 직후(in-memory 제거는 동기 완료되지만 실제 MongoDB 네트워크 왕복은 미완료 상태) 서버가 재시작되면 그 삭제가 통째로 유실되고 다음 부팅 시 MongoDB의 예전 레코드가 그대로 재수화(hydrate)되던 구조 — 오늘 세션 내내 반복한 "delete 후 곧바로 재시작" 패턴이 정확히 이 조건을 매번 충족시키고 있었다(§6.29.15). `MongoDatabase`에 `_pendingWrites` Set으로 진행 중인 Mongo 쓰기를 추적하도록 추가하고 `flushNow()`를 실제로 `Promise.allSettled()`로 대기하는 async 함수로 교체, `BaseDatabase`/`db/index.js`의 인터페이스도 async로 통일, `index.js`의 graceful shutdown 핸들러가 `flushNow()`를 `await`하도록 수정. 동일 레이스 컨디션을 재현하는 실측 테스트(카메라 생성→즉시 삭제→즉시 SIGTERM→재시작)로 수정 전/후 대조 검증 완료 — 수정 후 삭제가 재시작을 확실히 견뎌냄을 확인 |
| 1.48 | 2026-07-21 | §6.29.11/§6.29.12/§6.29.13 신규 — 사용자가 Analysis 서버에서 `tc009-cam-alpha`/`tc009-cam-beta`/`test-cam-distributed` 좀비 채널을 보고했다며 원인·방지책 조사 요청. 근본 원인 3건 확정 및 수정: (1) `distributed_pipeline.test.js`의 TC-DAP-005/009가 카메라 등록 없이 `POST /api/analysis/frame`에 cameraId만 실어 보내 Analysis 서버의 `_metrics.perCamera`에 만료 로직 없이 영구 누적되던 버그 — `_cameraContexts`와 같은 60초 프루닝 인터벌에 편입해 수정. (2) Streaming 서버 `pipelineManager.stopCamera()`가 in-memory 파이프라인이 없으면 ingest-daemon/mediasoup/mediamtx 정리를 전혀 시도하지 않고 조기 반환하던 버그(실제 등록된 카메라가 재시작 후 미기동 상태에서 삭제되면 ingest-daemon 쪽에 좀비 등록이 남을 수 있음) — ctx 유무와 무관하게 외부 시스템 정리를 항상 시도하도록 수정, 각 정리 함수가 미등록 상태에 대해 이미 안전한 no-op임을 코드 추적으로 확인. (3) `DELETE /api/cameras/:id`가 Analysis 서버에 삭제를 전혀 통지하지 않아 정상 삭제된 카메라도 5분 idle-prune 전까지는 Analysis 서버에 잔류하던 gap — `POST {ANALYSIS_SERVER_URL}/api/analysis/camera-removed` 신규 fire-and-forget 통지 추가(`faceSearchSync.js` 패턴 재사용, self-signed TLS 대응 위해 `https.Agent({rejectUnauthorized:false})` 필요함을 실측으로 확인 — 최초 구현은 기본 `fetch()`로 "fetch failed" 실패). 부수적으로 오늘 세션 중 반복 재시작이 서버 부팅 시 자동 실행되는 TC 스위트(`TcRunnerService.runOnStartup`)를 매번 중간에 끊어 `TC-B-*`/`TC-A-*` 등 14개 고아 테스트 카메라가 DB에 쌓인 것을 발견·정리(사용자 확인 후 삭제) — `TC_STARTUP_RUN=false`로 끌 수 있음을 확인, `api-testing/SKILL.md`(.claude+.github)에 예방법 기록 |
| 1.47 | 2026-07-21 | §6.29.10 신규 — Streaming Dashboard Channel Group nav 우측에 ingest-daemon/Analysis 서버 연결 상태 배지 추가. 서버에 `GET /api/ingest-status`(§6.29.9의 watchdog 헬스체크 로직 재사용) 신규 추가, 기존 `GET /api/analysis/client-status`(streaming 모드 전용)와 함께 5초 폴링. `DashboardDetectionPanel.tsx`에 있던 `useAnalysisClientStatus` 훅을 `hooks/useSystemStatus.ts`로 추출해 `SystemStatusBadges.tsx`와 공유(중복 제거) — §6.29.5의 ingest-daemon 응답 불능이 지금까지는 WebRTC 증상으로만 간접 드러났는데, 이제 대시보드에서 직접 확인 가능 |
| 1.46 | 2026-07-21 | §6.29.9 신규 — ingest-daemon 응답 불능이 일회성이 아니라 반복 재발함을 실측 확인(첫 복구 후 정확히 55분 뒤 동일 증상 재발, 신선한 프로세스에서도 재현되어 가동시간 비례 리소스 누적 문제로 추정). 매번 수동 보고·복구해야 하는 상황을 없애기 위해 `ingestDaemonWatchdog.js` 신규 추가 — 20초 간격 `/health` 폴링(3초 타임아웃), 연속 2회 실패 시 기존 `restartIngestDaemon.js`를 자식 프로세스로 spawn해 자동 복구(로직 재구현 없이 재사용), 재시작 후 90초 쿨다운으로 재시작 연타 방지. `index.js` `main()`에 `CAPTURE_BACKEND=ingest-daemon`일 때만 기동하도록 연결. 근본 원인(왜 반복적으로 멎는지)은 여전히 미해결 — 증상 자동 복구까지만 |
| 1.45 | 2026-07-21 | §6.29.8 신규 — 사용자가 "원래는 문제없었다"며 근본 해결을 요구, ingest-daemon 재시작 후에도 고해상도 카메라(2048×1536, 15fps)의 Buffer/Latency가 1400ms대로 계속 누적되는 것을 재확인. 4개 카메라(Primary/Secondary)가 같은 물리 유닛의 서로 다른 센서 스트림을 의도적으로 동시 수신 중임을 사용자가 확인해 "중복 등록" 가설은 기각. 최종 근본 원인 확정: `useWebRTC.ts`의 수동 jitterBufferTarget 제어 메커니즘(STEP_UP 150ms/이벤트 vs STEP_DOWN 30ms/5초틱 — 완전히 감쇠하려면 무손실 2.5분 필요) 자체가 이번 세션에서만 4번째 자기유발 버그를 내고 있었음 확정 — 장시간 연결에서 간헐적 실손실/프리즈 몇 번만 있어도 상한(1000ms)까지 누적된 뒤 좀처럼 안 내려오고, 그 값을 `videoReceiver.jitterBufferTarget`으로 직접 명령해 브라우저가 프레임을 최대 1초까지 붙들게 만들어 "디코드가 못 따라간다"와 동일한 증상(Buffer/Latency 급상승)을 자체 유발. `JITTER_TARGET_*` 상수 및 `videoReceiver.jitterBufferTarget` 명령 코드 전체 제거, freeze/loss 델타 계산은 유지하되 더 이상 명령에 사용하지 않음(순수 관찰용) — 브라우저 자체의 적응형 지터 버퍼에 위임. 별도로 §self-reinforcing-buffer-loop 재연결 안전장치도 `jitterTargetMs` 상한 도달 조건 없이 `bufferMs` 단독 기준으로 완화(디코드 처리량 부족처럼 freeze/loss 없이 bufferMs만 오르는 경우도 안전장치가 발동하도록). `npx tsc --noEmit`/`npm run build` 클린 통과, 재현 검증은 사용자 확인 대기 |
| 1.44 | 2026-07-21 | §6.29.5~6.29.7 추가 — v1.43 적용 후에도 재시작 직후 WebRTC 카메라가 등록 실패로 폴백되는 현상이 재현되어 진짜 근본 원인을 추가로 확정: ingest-daemon 프로세스가 살아있고 CPU도 소모하면서도 `/health`/`/cameras` HTTP API에 전혀 응답 못 하는 상태에 빠져 있었음(SIGTERM에도 8초간 무응답 — SIGKILL 필요, 사용자가 ingest-daemon 자체 화면에서 "모든 채널 노란색"으로 직접 확인). `npm run ingest:restart`로 복구. 재발 방지로 `pipelineManager.js`에 `_healWebRTCPipelines()` 30초 주기 self-heal 스윕 신규 추가 — `addCameraStream()` 3회 재시도 소진 후 `useWebRTC=false`로 영구 고착되던 것(기존 프레임 워치독은 이 케이스를 커버 못함, 26분 방치 실측)을 자동 복구, 실측으로 수동 개입 없이 30초 내 복구 확인. ingest-daemon 자체의 GIL 경합 추정 근본 수정은 범위 밖(후속 과제) |
| 1.43 | 2026-07-21 | §6.29 신규 — 사용자가 겪은 "정상 종료 신호에 응답 못 해 SIGKILL 강제 종료" 문제 근본 수정 3건: (1) `index.js`의 `shutdown()` 핸들러에서 강제종료 워치독 `setTimeout`이 `await pipelineManager.stopAll()` 등 행 가능성이 있는 호출 **뒤**에 배치되어 있어, 그 await 자체가 멈추면 워치독이 아예 스케줄되지 못하던 순서 버그를 수정 — 워치독을 함수 최상단, 모든 await보다 먼저 등록하도록 재배치. SIGTERM 전송 후 실측 2~7초 내 `HTTPS server closed` 로그와 함께 정상 종료됨을 확인(이전엔 `stopServer.js`의 외부 10초 타임아웃 SIGKILL에 의존). (2) `getProducerStats()`(`/api/webrtc/monitor`가 사용)가 mediasoup Worker IPC(Node↔C++ 자식 프로세스 채널)가 멎으면 `await producer.getStats()`가 resolve도 reject도 안 해 무한 대기하던 결함 발견·수정 — `WORKER_IPC_TIMEOUT_MS=3000`과 `_withIpcTimeout()` 헬퍼로 `videoProducer`/`audioProducer`/`videoConsumer`/`audioPlain`의 모든 `getStats()` 호출을 `Promise.race`로 감싸 카메라 1개의 IPC 정체가 엔드포인트 전체를 막지 못하도록 수정, 재시작 직후 프레시 상태에서도 재현되어(누적 상태만의 문제가 아님) 근본 원인(IPC 자체가 왜 멎는지)은 별도 과제로 남음. (3) UDP 탐색 로그 스팸 재발 원인 확정 — 이전 세션 수정이 git submodule(`submodules/WiseNetChromeIPInstaller/`)에만 적용되고, 실제 런타임이 로드하는 것은 `server/package.json`에 `git+https://...#nodejs-udp-discovery`로 고정된 **독립적인 npm 설치 사본**(`node_modules/wisenet-chrome-ip-installer/`)이었음 — 두 사본은 완전히 별개이며 submodule 편집은 런타임에 영향 없음. `node_modules` 사본에 동일 수정 적용(업스트림 브랜치 반영 후 재설치 전까지는 재설치 시 유실 주의, 코드 주석에 명시). `node -c` 통과, `/api/webrtc/monitor`가 활성 카메라 상태에서 ~50ms에 응답함을 실측 확인 |
| 1.71 | 2026-08-10 | §6.29.4 후속 노트 추가 — `wisenet-chrome-ip-installer` 의존성 참조를 upstream 머지에 따라 `#master`로 전환(SUNAPI 와이어 포맷 `sunapi/` 이동, `files: ["nodejs","sunapi"]`), parity 테스트·라이브 탐색으로 재검증 |
