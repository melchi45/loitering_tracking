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
| `ffmpeg` (기본) | `ffmpeg` 바이너리 | 범용, Ubuntu 18.04~ 지원 |
| `gstreamer` | `gst-launch-1.0` | 낮은 레이턴시, nvdec/vaapi GPU 가속 |
| `pyav` | `python3 pyav_capture.py` | Python ML 통합, CUDA 경로 |

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

## 환경변수 (관련 `.env` 항목)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CAPTURE_BACKEND` | `ffmpeg` | 캡처 백엔드 선택: `ffmpeg` / `gstreamer` / `pyav` |
| `GSTREAMER_HW_ACCEL` | `auto` | GStreamer 하드웨어 가속: `auto` / `nvdec` / `vaapi` / `software` |
| `PYAV_PYTHON_BIN` | `python3` | Python 바이너리 경로 |
| `PYAV_HW_ACCEL` | `none` | PyAV 하드웨어 가속: `none` / `cuda` / `videotoolbox` |
| `MAX_PIPELINES` | `0` | 동시 캡처 프로세스 최대 수 (0=무제한) |
| `YTDLP_BIN` | _(empty)_ | yt-dlp 바이너리 경로. 비워두면 PATH 탐색 |
| `MEDIAMTX_BIN` | _(empty)_ | mediamtx 바이너리 경로. 비워두면 PATH 탐색 |

---

## 관련 문서

- [Design_RTSP_Capture_Backend.md](../design/Design_RTSP_Capture_Backend.md) — 3-backend 추상화 설계
- [Design_FFmpeg_RTSP_Capture.md](../design/Design_FFmpeg_RTSP_Capture.md) — FFmpeg 버전 호환성 상세 설계
- [FFmpeg_Installation_Compatibility.md](../ops/FFmpeg_Installation_Compatibility.md) — FFmpeg 전용 설치 가이드
- [Design_LTS2026_YouTube_RTSP_Ingest.md](../design/Design_LTS2026_YouTube_RTSP_Ingest.md) — YouTube 스트림 설계
