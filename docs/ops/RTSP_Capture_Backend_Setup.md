# Operations Guide
# RTSP 캡처 백엔드 설치 및 운영 가이드

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-CAPTURE-002 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-06-04 |
| **Status** | **Active** |
| **Related Design** | [Design_RTSP_Capture_Backend.md](../design/Design_RTSP_Capture_Backend.md) |

---

## 개요

LTS-2026은 RTSP 카메라 스트림 프레임 수집 백엔드를 **3가지 중 하나**로 선택할 수 있습니다.

| 백엔드 | 프로세스 | 특징 |
|---|---|---|
| `ingest-daemon` **(기본·권장)** | `python3 ingest_daemon.py` | 단일 RTSP 연결, MediaMTX WebRTC 통합, B-프레임 처리 |
| `gstreamer` | `gst-launch-1.0` | 낮은 레이턴시, nvdec/vaapi GPU 가속 |
| `pyav` | `python3 pyav_capture.py` | Python ML 통합, CUDA 경로 (인라인 사이드카) |
| `ffmpeg` *(레거시)* | `ffmpeg` 바이너리 | 범용 호환성, 단일 RTSP 연결 원칙 위반 |

백엔드 선택은 `server/.env`의 `CAPTURE_BACKEND` 값으로 결정됩니다.
서버를 재시작하면 즉시 적용됩니다.

---

## Ubuntu 버전별 백엔드 지원 매트릭스

| Ubuntu 버전 | FFmpeg 기본 버전 | GStreamer 기본 버전 | ffmpeg 백엔드 | gstreamer 백엔드 | pyav 백엔드 |
|---|---|---|---|---|---|
| **18.04 LTS** (Bionic) | 3.4.x | 1.14.x | 지원 (stimeout 자동 선택) | 지원 | 지원 (pip 설치) |
| **20.04 LTS** (Focal) | 4.2.x | 1.16.x | 지원 | 지원 | 지원 |
| **22.04 LTS** (Jammy) | 4.4.x | 1.20.x | 지원 | 지원 | 지원 |
| **24.04 LTS** (Noble) | 6.1.x | 1.24.x | 지원 | 지원 (nvdec/vaapi 개선) | 지원 |
| **26.04 LTS** (Oracular) | 7.x | 1.26.x | 지원 (timeout 자동 선택) | 지원 | 지원 |

> **참고:** 이 프로젝트는 Ubuntu 26.04 (ffmpeg 7.x) 환경에서 개발·커밋되었습니다.
> FFmpeg 버전 호환성 상세는 [Design_FFmpeg_RTSP_Capture.md](../design/Design_FFmpeg_RTSP_Capture.md) 참조.

---

## FFmpeg 백엔드 설치

### 방법 1 — apt 기본 패키지 (권장)

```bash
sudo apt update
sudo apt install -y ffmpeg

# 설치 버전 확인
ffmpeg -version | head -1
```

### 방법 2 — 최신 정적 빌드 (버전 고정이 필요한 경우)

```bash
wget -q https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf ffmpeg-release-amd64-static.tar.xz
sudo cp ffmpeg-*-static/ffmpeg /usr/local/bin/ffmpeg
sudo chmod +x /usr/local/bin/ffmpeg

which ffmpeg   # /usr/local/bin/ffmpeg 이어야 함
ffmpeg -version | head -1
```

### 방법 3 — PPA (Ubuntu 20.04 이상)

```bash
sudo add-apt-repository ppa:savoury1/ffmpeg4  # ffmpeg 4.x
# 또는
sudo add-apt-repository ppa:savoury1/ffmpeg5  # ffmpeg 5.x
sudo apt update && sudo apt install -y ffmpeg
```

### FFmpeg 동작 확인

```bash
# 버전 확인
ffmpeg -version | head -1

# RTSP 스트림 직접 테스트 (프레임 1장 캡처)
ffmpeg -rtsp_transport tcp \
  -i 'rtsp://admin:PASSWORD@CAMERA_IP/PATH' \
  -frames:v 1 /tmp/cam_test.jpg && echo "OK" || echo "FAIL"
```

---

## GStreamer 백엔드 설치

### 기본 패키지 설치

```bash
sudo apt update
sudo apt install -y \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav
```

#### 패키지별 역할

| 패키지 | 포함 플러그인 | RTSP 캡처에서의 역할 |
|---|---|---|
| `gstreamer1.0-tools` | `gst-launch-1.0`, `gst-inspect-1.0` | 파이프라인 실행 바이너리 |
| `gstreamer1.0-plugins-base` | `videoscale`, `videoconvert`, `jpegenc` | 영상 스케일·변환·JPEG 인코딩 |
| `gstreamer1.0-plugins-good` | `rtspsrc`, `rtph264depay`, `videorate` | RTSP 소스, RTP 역다중화, 프레임레이트 조절 |
| `gstreamer1.0-plugins-bad` | `h264parse`, `nvh264dec` (NVIDIA 빌드 시) | H.264 파서, NVIDIA 하드웨어 디코더 |
| `gstreamer1.0-plugins-ugly` | `x264enc` | (옵션) H.264 소프트웨어 인코딩 |
| `gstreamer1.0-libav` | `avdec_h264`, `avdec_h265` | FFmpeg 기반 소프트웨어 코덱 폴백 |

### GStreamer 하드웨어 가속 설치

#### NVIDIA nvdec (CUDA 기반)

```bash
# CUDA 툴킷 설치 (NVIDIA 공식 저장소 필요)
# https://developer.nvidia.com/cuda-downloads

# GStreamer NVIDIA 플러그인 (Ubuntu 22.04+)
sudo apt install -y gstreamer1.0-plugins-bad

# nvdec 플러그인 가용 여부 확인
gst-inspect-1.0 nvh264dec
# 출력 예: "Factory Details: ... nvh264dec"  ← 설치됨
# 오류 출력: "No such element or plugin 'nvh264dec'" ← 미설치
```

> **주의:** `nvh264dec`는 NVIDIA GPU와 CUDA 드라이버가 설치된 시스템에서만 활성화됩니다.
> `gstreamer1.0-plugins-bad` 패키지를 설치해도 GPU가 없으면 플러그인이 로드되지 않습니다.

#### Intel/AMD VA-API

```bash
# VA-API 드라이버 설치
# Intel
sudo apt install -y intel-media-va-driver vainfo

# AMD
sudo apt install -y mesa-va-drivers vainfo

# GStreamer VA-API 플러그인
sudo apt install -y gstreamer1.0-vaapi

# vaapi 플러그인 가용 여부 확인
gst-inspect-1.0 vaapi
# 또는
gst-inspect-1.0 vaapipostproc

# VA-API 드라이버 확인
vainfo 2>&1 | grep "VA-API version"
```

### GStreamer 동작 확인

```bash
# GStreamer 버전 확인
gst-launch-1.0 --version

# rtspsrc 플러그인 확인
gst-inspect-1.0 rtspsrc

# jpegenc 플러그인 확인
gst-inspect-1.0 jpegenc

# RTSP 스트림 소프트웨어 파이프라인 테스트 (5초간 실행)
timeout 5 gst-launch-1.0 -q \
  rtspsrc location="rtsp://admin:PASSWORD@CAMERA_IP/PATH" protocols=tcp latency=200 \
  ! decodebin \
  ! videoscale ! video/x-raw,width=640 \
  ! videoconvert \
  ! jpegenc quality=85 \
  ! fakesink && echo "OK" || echo "FAIL (timeout은 정상)"

# nvdec 파이프라인 테스트 (NVIDIA GPU 환경)
timeout 5 gst-launch-1.0 -q \
  rtspsrc location="rtsp://admin:PASSWORD@CAMERA_IP/PATH" protocols=tcp latency=200 \
  ! rtph264depay ! h264parse ! nvh264dec \
  ! videoscale ! video/x-raw,width=640 \
  ! videoconvert ! jpegenc quality=85 \
  ! fakesink && echo "nvdec OK"
```

---

## PyAV 백엔드 설치

### Python 및 패키지 설치

```bash
# Python 3 확인
python3 --version

# pip 설치 (없는 경우)
sudo apt install -y python3-pip

# PyAV 및 Pillow 설치
pip3 install av Pillow

# 또는 가상환경 사용 시
python3 -m venv /opt/lts-pyav
/opt/lts-pyav/bin/pip install av Pillow
# .env에서: PYAV_PYTHON_BIN=/opt/lts-pyav/bin/python3
```

### CUDA 지원 PyAV 설치 (GPU 서버)

```bash
# CUDA 버전 확인
nvcc --version || nvidia-smi

# PyAV는 시스템의 FFmpeg CUDA 빌드를 사용합니다.
# FFmpeg CUDA 지원 빌드가 필요합니다.
# conda 환경 사용을 권장합니다:
conda install -c conda-forge av
conda install Pillow
```

### PyAV 의존성 확인 명령

```bash
# Python + PyAV + Pillow 일괄 확인
python3 -c "import av, PIL; print('ok')"
# 출력: ok  → 정상
# 오류: ModuleNotFoundError → pip3 install av Pillow 재실행

# PyAV 버전 및 FFmpeg 버전 확인
python3 -c "import av; print('PyAV:', av.__version__); print('FFmpeg:', av.library_versions)"

# Pillow 버전 확인
python3 -c "from PIL import Image; print('Pillow:', Image.__version__)"

# pyav_capture.py 직접 테스트 (5프레임 캡처 후 Ctrl+C)
python3 server/src/python/pyav_capture.py \
  'rtsp://admin:PASSWORD@CAMERA_IP/PATH' 10 640 none 2>&1 | head -20
```

---

## 운영 환경별 추천 백엔드 설정

### 범용 서버 (CPU 전용, Ubuntu 18~26)

```bash
# server/.env
CAPTURE_BACKEND=ffmpeg
```

추가 설치 없이 `apt install ffmpeg`만으로 즉시 사용 가능합니다.
Ubuntu 18.04 (ffmpeg 3.4)부터 최신 26.04 (ffmpeg 7.x)까지 버전 차이를 자동 처리합니다.

---

### NVIDIA GPU 서버

```bash
# server/.env
CAPTURE_BACKEND=gstreamer
GSTREAMER_HW_ACCEL=nvdec
```

```bash
# 필수 설치
sudo apt install -y gstreamer1.0-tools gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad

# 설정 확인
gst-inspect-1.0 nvh264dec && echo "nvdec 사용 가능"
```

CPU 디코딩 부하를 GPU로 오프로드하여 다수 카메라 동시 처리 시 CPU 자원을 AI 추론에 집중할 수 있습니다.

---

### Intel/AMD 내장 GPU 서버

```bash
# server/.env
CAPTURE_BACKEND=gstreamer
GSTREAMER_HW_ACCEL=vaapi
```

```bash
# 필수 설치 (Intel 예시)
sudo apt install -y gstreamer1.0-tools gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good gstreamer1.0-vaapi intel-media-va-driver

# 설정 확인
gst-inspect-1.0 vaapipostproc && echo "vaapi 사용 가능"
vainfo 2>&1 | grep "VA-API version"
```

---

### CUDA 기반 ML 통합 서버

```bash
# server/.env
CAPTURE_BACKEND=pyav
PYAV_PYTHON_BIN=/usr/bin/python3
PYAV_HW_ACCEL=cuda
```

```bash
# 필수 설치
pip3 install av Pillow

# 확인
python3 -c "import av, PIL; print('ok')"
```

Python GPU 인퍼런스 파이프라인과 동일한 프로세스에서 프레임을 처리하므로
GPU 메모리 간 복사를 최소화할 수 있습니다.

---

### Docker 컨테이너 환경

```dockerfile
# FFmpeg 백엔드 (이미지 크기 최소)
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
ENV CAPTURE_BACKEND=ffmpeg

# GStreamer 백엔드
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y \
    gstreamer1.0-tools gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-libav && rm -rf /var/lib/apt/lists/*
ENV CAPTURE_BACKEND=gstreamer
ENV GSTREAMER_HW_ACCEL=auto
```

---

## 설치 확인 체크리스트

```bash
# ── FFmpeg 백엔드 ───────────────────────────────────────────
# 1. 설치 여부 및 버전
ffmpeg -version | head -1

# 2. RTSP 스트림 직접 테스트
ffmpeg -rtsp_transport tcp \
  -i 'rtsp://admin:PASSWORD@CAMERA_IP/PATH' \
  -frames:v 1 /tmp/cam_test_ffmpeg.jpg && echo "FFmpeg OK" || echo "FFmpeg FAIL"

# ── GStreamer 백엔드 ─────────────────────────────────────────
# 3. GStreamer 설치 여부
gst-launch-1.0 --version | head -1

# 4. 필수 플러그인 확인
gst-inspect-1.0 rtspsrc   2>/dev/null && echo "rtspsrc OK"   || echo "rtspsrc MISSING"
gst-inspect-1.0 decodebin 2>/dev/null && echo "decodebin OK" || echo "decodebin MISSING"
gst-inspect-1.0 jpegenc   2>/dev/null && echo "jpegenc OK"   || echo "jpegenc MISSING"

# 5. 하드웨어 가속 플러그인 확인 (선택)
gst-inspect-1.0 nvh264dec   2>/dev/null && echo "nvdec OK"   || echo "nvdec 없음 (정상일 수 있음)"
gst-inspect-1.0 vaapipostproc 2>/dev/null && echo "vaapi OK" || echo "vaapi 없음 (정상일 수 있음)"

# ── PyAV 백엔드 ─────────────────────────────────────────────
# 6. Python + PyAV 확인
python3 -c "import av, PIL; print('PyAV OK')" || echo "PyAV MISSING — pip3 install av Pillow"

# ── LTS-2026 서버 기동 후 확인 ───────────────────────────────
# 7. 서버 로그에서 백엔드 초기화 확인
grep -E "CaptureFactory|GStreamerCapture|PyAVCapture|FFMPEG_MAJOR" /tmp/lts-server.log 2>/dev/null | head -10

# 8. 카메라 파이프라인 상태 확인
curl -sk https://localhost:3443/api/cameras | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); \
  (d.data||d).forEach(c=>console.log(c.name, c.status, 'frames:', c.pipelineStatus?.frameCount))"
```

---

## 알려진 문제 및 해결

### GStreamer: `rtspsrc` 플러그인 없음

**증상:**
```
No such element or plugin 'rtspsrc'
```

**해결:**
```bash
sudo apt install -y gstreamer1.0-plugins-good
gst-inspect-1.0 rtspsrc  # 재확인
```

---

### GStreamer: nvdec 파이프라인 실패

**증상:**
```
ERROR: from element /GstPipeline:pipeline0/nvh264dec:...
Could not create NV decoder: CUDA not available
```

**해결:**
NVIDIA 드라이버와 CUDA 툴킷이 올바르게 설치되었는지 확인합니다.

```bash
nvidia-smi                  # GPU 인식 확인
nvcc --version              # CUDA 툴킷 확인
```

GPU 없는 환경에서는 `GSTREAMER_HW_ACCEL=software`로 폴백합니다:

```bash
# server/.env
GSTREAMER_HW_ACCEL=software
```

---

### PyAV: `import av` 실패

**증상:**
```
ModuleNotFoundError: No module named 'av'
```

**해결:**
```bash
pip3 install av Pillow

# Python 버전이 여러 개인 경우 명시적으로 지정
python3.11 -m pip install av Pillow
# server/.env에서: PYAV_PYTHON_BIN=/usr/bin/python3.11
```

---

### PyAV: CUDA HW 가속 오류

**증상:**
```
av.error.InvalidOperationError: [Errno 1] Operation not permitted: 'cuda'
```

**해결:**
PyAV의 CUDA 지원은 FFmpeg CUDA 빌드를 필요로 합니다. conda 환경 사용을 권장합니다.

```bash
# CUDA 지원 없이 소프트웨어 디코딩으로 폴백
# server/.env
PYAV_HW_ACCEL=none
```

---

## Ingest-Daemon 백엔드 설치 (권장)

### 의존성 설치

```bash
pip3 install av Pillow

# 설치 확인
python3 -c "import av, PIL; print('OK')"
```

### `server/.env` 설정

```env
CAPTURE_BACKEND=ingest-daemon
WEBRTC_ENGINE=mediamtx
PYAV_PYTHON_BIN=/home/user/.local/bin/python3   # PyAV가 설치된 Python 경로
INGEST_DAEMON_BIN=../ingest-daemon/ingest_daemon.py
INGEST_DAEMON_ADDR=:7070
```

### 데몬 시작 확인

서버 시작 시 자동으로 기동됩니다. 수동 확인:

```bash
# 데몬 상태
curl http://127.0.0.1:7070/health
# {"status":"ok","cameras":N}

# 데몬 단독 재시작 (서버 재시작 불필요)
npm run ingest:restart             # workspace 루트
cd server && npm run ingest:restart  # server/ 경로
```

### 문제 해결

| 증상 | 원인 | 해결 |
|---|---|---|
| `ingest-daemon register failed: fetch failed` | 데몬 미기동 또는 포트 충돌 | `fuser 7070/tcp` 확인, `npm run ingest:restart` |
| 프레임 미수신 (MediaMTX ready=false) | MediaMTX 경로 미등록 | 서버 재시작 또는 `npm run ingest:restart` |
| `ModuleNotFoundError: av` | PyAV 미설치 | `pip3 install av Pillow` |
| 빈 프레임 (B-프레임 카메라) | 구 버전 패킷 스킵 코드 | `ingest_daemon.py` 최신 버전 확인 |

---

## Ingest-Daemon Watchdog 및 자동 복구

### 복구 계층 구조

LTS-2026은 세 계층의 Watchdog이 중첩되어 스트림 고착 및 프로세스 충돌을 자동 복구합니다.

```
계층 1  ingest_daemon.py / _Watchdog (Python)
        └── RTSP 세션별: RTP 패킷이 RTSP_READ_TIMEOUT(기본 5s) 동안 없으면
            PyAV 컨테이너 강제 종료 → _*_loop()가 자동 재연결

계층 2  pipelineManager.js / frameWatchdogTimer (Node.js)
        └── 카메라별: 마지막 JPEG 수신 후 20s 경과 시
            ingest-daemon에 DELETE + POST 재등록 (mediamtx/mediasoup 모두 처리)

계층 3  startServer.js / _respawnIngest (Node.js)
        └── ingest-daemon 프로세스 자체가 종료되면
            지수 백오프 후 자동 재시작 →
            /api/internal/ingest/reregister 호출로 모든 카메라 즉시 재등록
```

### 계층 1 — PyAV 내부 Watchdog

`RTSP_READ_TIMEOUT` 환경변수로 민감도를 조정할 수 있습니다:

```env
# server/.env
RTSP_READ_TIMEOUT=5   # 기본값 (초). 불안정한 네트워크에서는 10–15로 늘림
```

RTSP keepalive(OPTIONS/GET_PARAMETER)는 카운터를 초기화하지 않으므로
"keepalive는 살아있지만 영상이 없는" 고착 상태도 감지됩니다.

### 계층 2 — Node.js 프레임 Watchdog

로그에서 이 동작을 확인할 수 있습니다:

```
[INFO]  [PipelineManager][cam-id] Frame watchdog: no frame for 24s — restarting capture
[INFO]  [PipelineManager][cam-id] Capture started (ingest-daemon): ...
```

`ECONNREFUSED 127.0.0.1:7070` 에러가 함께 보이면 ingest-daemon 자체가 죽은 것입니다 —
계층 3 자동 재시작이 이어서 처리합니다.

### 계층 3 — 프로세스 자동 재시작

서버 로그에서 이 동작을 확인할 수 있습니다:

```
[WARNING] [Start] ingest-daemon exited (code=1)
[WARNING] [Start] ingest-daemon crashed — restarting in 1.0s (attempt #1)
[INFO]    [Start] ingest-daemon restarting on :7070
[INFO]    [Start] ingest-daemon restarted on :7070 — re-registering cameras
[INFO]    [Start] ingest reregister: HTTP 200
```

재시작 백오프: `1s → 1.5s → 2.25s → ... → 최대 30s (성공 시 0으로 리셋)`

### 수동 개입이 필요한 경우

자동 복구가 실패할 때(데몬이 반복 충돌하는 경우):

```bash
# 1. 로그에서 Python traceback 확인
grep -A5 "ingest-daemon crashed" /var/log/lts/lts-$(date +%Y-%m-%d).log

# 2. 데몬 단독 재시작 (서버 재시작 불필요)
cd server && npm run ingest:restart

# 3. PyAV 환경 확인
python3 -c "import av, PIL; print(av.__version__)"

# 4. RTSP 소스 직접 확인
python3 -c "
import av
c = av.open('rtsp://127.0.0.1:8554/<cameraId>', options={'rtsp_transport':'tcp'})
print([s.type for s in c.streams])
c.close()
"
```

### 환경변수 (Watchdog 관련)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `RTSP_READ_TIMEOUT` | `5` | PyAV 내부 watchdog 타임아웃(초). 불안정 네트워크에서 증가 |

설계 상세 → [Design_RTSP_Capture_Backend.md §6.7](../design/Design_RTSP_Capture_Backend.md)

---

## 환경변수 (관련 `.env` 항목)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CAPTURE_BACKEND` | `ingest-daemon` | 캡처 백엔드: `ingest-daemon` / `gstreamer` / `pyav` / `ffmpeg` |
| `WEBRTC_ENGINE` | `mediamtx` | WebRTC 엔진: `mediamtx` (권장) / `mediasoup` |
| `INGEST_DAEMON_BIN` | `../ingest-daemon/ingest_daemon.py` | Python 데몬 스크립트 경로 |
| `INGEST_DAEMON_ADDR` | `:7070` | 데몬 HTTP bind 주소 |
| `INGEST_DAEMON_URL` | `http://127.0.0.1:7070` | Node.js → 데몬 URL |
| `PYAV_PYTHON_BIN` | `python3` | Python 바이너리 경로 (ingest-daemon과 pyav 공용) |
| `GSTREAMER_HW_ACCEL` | `auto` | GStreamer 하드웨어 가속: `auto` / `nvdec` / `vaapi` / `software` |
| `PYAV_HW_ACCEL` | `none` | PyAV 인라인 사이드카 가속: `none` / `cuda` / `videotoolbox` |
| `MAX_PIPELINES` | `0` | 동시 캡처 파이프라인 최대 수 (0=무제한) |
| `YTDLP_BIN` | _(empty)_ | yt-dlp 바이너리 경로 |
| `MEDIAMTX_BIN` | _(empty)_ | mediamtx 바이너리 경로 |

---

## 관련 문서

- [Design_RTSP_Capture_Backend.md](../design/Design_RTSP_Capture_Backend.md) — 4-backend 추상화 설계 (ingest-daemon §6, §6.7 Watchdog)
- [Design_RTSP_WebRTC_Architecture.md](../design/Design_RTSP_WebRTC_Architecture.md) — WebRTC 아키텍처 (MediaMTX WHEP)
- [Design_FFmpeg_RTSP_Capture.md](../design/Design_FFmpeg_RTSP_Capture.md) — FFmpeg 설계 (Deprecated)
- [FFmpeg_Installation_Compatibility.md](../ops/FFmpeg_Installation_Compatibility.md) — FFmpeg 호환성 (레거시)
- [Design_LTS2026_YouTube_RTSP_Ingest.md](../design/Design_LTS2026_YouTube_RTSP_Ingest.md) — YouTube 스트림 설계
- [Process_Management.md](../ops/Process_Management.md) — 프로세스 종료·재시작·수동 정리
- [Design_ONVIF_Timeline.md](../design/Design_ONVIF_Timeline.md) — ONVIF 이벤트 타임라인 설계 (Name 컬럼·Gantt 바·카메라 연결 해제 자동 종료)

---

## ONVIF 이벤트 타임라인 운영 안내

> **v1.2 신규** — 서버 설정 변경 없음; 클라이언트 UI 기능 운영 안내

### 전체화면 ONVIF Timeline (하단 탭)

카메라 전체화면 뷰 하단의 **ONVIF Timeline 탭**(`OnvifTimelineInline`)에서 수신된 ONVIF 이벤트를 Gantt 타임라인으로 시각화합니다.

| 요소 | 설명 |
|------|------|
| **Name 컬럼 (130px)** | 각 트랙 행 좌측에 이벤트 유형(`topicLabel`) · 소스 토큰(`sourceToken`) · 규칙명(`[ruleName]`)을 표시. 운영자가 스크롤 없이 행 유형을 즉시 식별 |
| **sticky 헤더** | "Name" 레이블 행(22px)이 스크롤 시 상단에 고정 |
| **범위 프리셋** | 1H · 6H · 1D · 1W · 1M · 1Y · Custom (기본: 1H) |
| **상세 패널** | 이벤트 클릭 시 우측 패널에 Parsed 정보 및 Raw XML 표시 |
| **자동 종료** | 카메라 연결 해제(`stopCamera`) 시 미결 이벤트(state=true)가 자동 닫힘(disconnectClose=true 표시) |

### 트러블슈팅

```bash
# ONVIF 이벤트가 타임라인에 표시되지 않을 때
curl http://localhost:3080/api/onvif-events?cameraId=<CAM_ID>&limit=10

# sourceToken / ruleName 필드 확인
curl http://localhost:3080/api/onvif-events?cameraId=<CAM_ID>&limit=1 | python3 -m json.tool
# → sourceToken, ruleName 필드가 null 또는 문자열로 반환되어야 정상
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-04 | 초기 작성 |
| 1.1 | 2026-06-19 | Ingest-Daemon Watchdog 및 자동 복구 섹션 추가 (RTSP_READ_TIMEOUT, 계층 3 프로세스 재시작, 수동 진단 절차)
| 1.2 | 2026-06-26 | ONVIF 이벤트 타임라인 운영 안내 섹션 추가 — 전체화면 하단 탭 Name 컬럼 설명·트러블슈팅 curl 예시 |
