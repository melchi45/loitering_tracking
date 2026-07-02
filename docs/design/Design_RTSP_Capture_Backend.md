# DESIGN DOCUMENT
# RTSP 캡처 백엔드 추상화 — FFmpeg / GStreamer / PyAV 다중 백엔드 설계

| | |
|---|---|
| **Document ID** | DESIGN-LTS-CAPTURE-002 |
| **Version** | 1.6 |
| **Status** | Active |
| **Date** | 2026-06-11 |
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
