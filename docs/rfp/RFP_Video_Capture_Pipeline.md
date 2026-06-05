# RFP — Video Capture Pipeline Architecture
**Document ID**: RFP-LTS-VCP-01  
**Version**: 1.0  
**Date**: 2026-06-05  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Under Evaluation  
**Author**: LTS Engineering Team

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-06-05 | Initial draft — pipeline architecture evaluation triggered by WebRTC stream instability diagnosis |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Background — Current Architecture](#2-background--current-architecture)
3. [Problem Statement](#3-problem-statement)
4. [Technology Evaluation](#4-technology-evaluation)
5. [Full Comparison Matrix](#5-full-comparison-matrix)
6. [Recommended Roadmap](#6-recommended-roadmap)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Risk Assessment](#8-risk-assessment)
9. [Related Documents](#9-related-documents)

---

## 1. Overview

LTS-2026의 영상 수집 파이프라인은 IP 카메라의 RTSP 스트림을 수신하여 AI 추론(YOLOv8 ONNX) 및 WebRTC 브라우저 전송까지 전달하는 핵심 경로입니다.

현재 이 경로는 **FFmpeg 단일 프로세스**가 전담하고 있으며, 운영 중 WebRTC 스트림 불안정(연결 지연 15 s+, 영상 프리즈, 재연결 반복)이 보고되었습니다. 본 문서는 원인 진단 결과를 바탕으로 현재 아키텍처를 기록하고, 대안 기술을 체계적으로 평가하여 개선 로드맵을 제시합니다.

---

## 2. Background — Current Architecture

### 2.1 파이프라인 전체 흐름

```
[IP Camera / YouTube]
        │ RTSP (H.264 + optional AAC/G.711 audio)
        ▼
┌──────────────────────────────────────────────────┐
│  captureFactory.js  — CAPTURE_BACKEND 선택       │
│                                                   │
│  webrtcEnabled=true  →  RtpIngestion (FFmpeg)     │  ← 항상 FFmpeg (CAPTURE_BACKEND 무시)
│  webrtcEnabled=false →  createCapture()           │  ← ffmpeg | gstreamer | pyav 중 선택
└──────────────────────────────────────────────────┘
        │
        ├─ WebRTC ON:  RtpIngestion._buildArgs() → FFmpeg 3-output
        │              ├─ Output 1: H264 RTP → mediasoup PlainTransport (video)
        │              ├─ Output 2: Opus RTP → mediasoup PlainTransport (audio)
        │              └─ Output 3: JPEG image2pipe → stdout (AI inference)
        │
        └─ WebRTC OFF: captureFactory → FFmpeg/GStreamer/PyAV
                       └─ JPEG frames → stdout (AI inference only)
                       (영상 브라우저 전달 없음)

        │ JPEG frames (10 FPS, 640px wide)
        ▼
[pipelineManager.js]
        │ YOLOv8 ONNX Detection → ByteTrack → BehaviorEngine → ZoneManager
        ▼
[Socket.IO]
        │ frameData (base64 JPEG + bbox overlay)
        │ newAlert / objectTracked / loitering
        ▼
[React WebUI]
        │ <video> element ← mediasoup WebRtcTransport (WebRTC ON)
        └─ <img> element  ← Socket.IO frameData (WebRTC OFF)
```

### 2.2 현재 WebRTC 경로 상세 (RtpIngestion)

**파일**: `server/src/services/rtpIngestion.js`

```
rtspUrl
  → FFmpeg 단일 프로세스 (3-output mux)
      ├─ Output 1: -c:v copy → -f rtp rtp://127.0.0.1:{videoPort}
      │             ↓ mediasoup PlainTransport (comedia=true)
      │             ↓ mediasoup Producer (video/H264, PT=96, SSRC=1111)
      ├─ Output 2: -c:a libopus -b:a 32k → -f rtp rtp://127.0.0.1:{audioPort}
      │             ↓ mediasoup PlainTransport (comedia=true)
      │             ↓ mediasoup Producer (audio/opus, PT=111, SSRC=2222)
      └─ Output 3: -vf fps=10,scale=640:-2 → -f image2pipe pipe:1
                    ↓ Node.js stdout 스트림
                    ↓ JPEG SOI/EOI 파싱 → 'frame' 이벤트
```

**핵심 FFmpeg 인수**:
```
-rtsp_transport tcp
-fflags +genpts+igndts
-use_wallclock_as_timestamps 1
-max_interleave_delta 0
-timeout 5000000
-analyzeduration 1000000 -probesize 1000000
```

### 2.3 현재 Capture 백엔드 (WebRTC OFF 전용)

**파일**: `server/src/services/captureFactory.js`

| CAPTURE_BACKEND | 구현 파일 | 특이사항 |
|---|---|---|
| `ffmpeg` (기본값) | `rtspCapture.js` | `-f image2pipe -vcodec mjpeg` |
| `gstreamer` | `gstreamerCapture.js` | nvdec/vaapi 하드웨어 디코딩 지원 |
| `pyav` | `pyavCapture.js` | Python 사이드카 프로세스, cuda/vaapi 지원 |

**주의**: `camera.webrtcEnabled=true`이면 `CAPTURE_BACKEND` 환경변수는 완전히 무시되고 항상 `RtpIngestion`(FFmpeg)이 사용됩니다.

### 2.4 현재 mediasoup 구성

**파일**: `server/src/services/webrtcGateway.js`

- mediasoup Worker 1개, Router는 카메라별 1개 + `__ice-test__` 공유 라우터
- PlainTransport: `comedia=true` — FFmpeg 첫 패킷 수신 시 원격 주소 학습
- WebRtcTransport: 브라우저 연결용, `listenIps` = `[SERVER_IP, 0.0.0.0]`
- 서버 ICE 후보 IP: `.env`의 `SERVER_IP` / `SERVER_PUBLIC_IP`

### 2.5 MediaMTX 연동 현황

- `mediamtx.yml`에 MediaMTX 구성 존재 (포트 8889 WebRTC, 8554 RTSP)
- 현재 MediaMTX의 WebRTC 출력(`localhost:8889`)은 **내부 전용**으로만 구성
- AI 파이프라인과 MediaMTX WebRTC는 직접 연동되어 있지 않음

---

## 3. Problem Statement

### 3.1 진단된 WebRTC 불안정 원인

ICE 연결 테스트(`Settings → ICE Connectivity Test`) 결과 다음 세 가지 근본 원인이 확인되었습니다:

**원인 1 — STUN 서버 DNS 조회 실패 (오류 코드 701)**
```
stun:stun.l.google.com:19302   → DNS lookup failed (error 701)
stun:stun1.l.google.com:19302  → DNS lookup failed (error 701)
```
배포 환경에서 Google STUN 서버에 접근 불가 → ICE 수집 단계에서 **15초 타임아웃** 발생 → 카메라 RTSP 재연결마다 WebRTC 연결이 15초 이상 지연.

**원인 2 — SERVER_IP=127.0.0.1 설정 오류**
```
SERVER_IP=127.0.0.1   # server/.env
```
mediasoup이 루프백 주소를 ICE 후보로 발표 → 브라우저가 서버에 직접 연결 불가 → 모든 WebRTC 트래픽이 외부 TURN 릴레이(`55.101.57.105`)를 경유 → 레이턴시 증가 및 불안정.

**원인 3 — FFmpeg 3-출력 구조의 CPU 부하**
```
RtpIngestion: FFmpeg with 3 simultaneous outputs
  H264 RTP (no transcode)  +  Opus RTP (transcode)  +  JPEG image2pipe (decode+encode)
```
단일 카메라에 FFmpeg 3-출력 동시 처리 → CPU 집약적 → 다수 카메라 운영 시 리소스 경쟁.

### 3.2 아키텍처 한계

| # | 한계 | 영향 |
|---|---|---|
| L-1 | WebRTC ON 시 CAPTURE_BACKEND 무시 — GStreamer/PyAV의 하드웨어 디코더 활용 불가 | AI 추론 경로에서 GPU 디코딩 이점 없음 |
| L-2 | RtpIngestion이 항상 FFmpeg 사용 — GStreamer WebRTC 경로 없음 | NVIDIA nvdec, Intel vaapi 하드웨어 활용 기회 손실 |
| L-3 | AI 추론(JPEG)과 WebRTC(RTP)가 동일 FFmpeg 프로세스 내 결합 | 한 출력 실패 시 전체 파이프라인 재시작 |
| L-4 | MediaMTX WebRTC 출력(포트 8889) 미활용 | 이미 실행 중인 하드웨어 가속 경로 낭비 |
| L-5 | 하드웨어 디코드 경로(nvdec/vaapi)가 JPEG 추론 경로에만 존재 | GPU를 가진 서버에서 WebRTC 경로는 소프트웨어 디코드만 사용 |

---

## 4. Technology Evaluation

### 4.1 FFmpeg (현재 — 기준점)

**역할**: RTSP 수신 → H264/Opus RTP 변환 → JPEG 추출

**구현 위치**: `rtspCapture.js`, `rtpIngestion.js`

| 항목 | 평가 |
|---|---|
| OS 호환성 | Windows / Linux / macOS 모두 지원 |
| 코덱 지원 | H.264/H.265/MJPEG 등 광범위 |
| 하드웨어 가속 디코드 | `-hwaccel cuda`, `-hwaccel vaapi` 지원 (현재 미적용) |
| WebRTC 통합 | RTP 출력 → mediasoup PlainTransport |
| AI 추론 통합 | JPEG image2pipe → pipelineManager |
| 의존성 | FFmpeg 바이너리 (시스템 설치) |
| 레이턴시 | 중간 (JPEG 인코딩 오버헤드 포함) |
| CPU 사용량 | 높음 (3-output + Opus 트랜스코딩) |
| 안정성 | 성숙한 도구, RTSP 재연결 로직 구현됨 |
| **결론** | **현재 사용 중. 즉각 교체보다 보완이 현실적** |

**FFmpeg 하드웨어 가속 미적용 이유**: 현재 `_buildArgs()`에서 `-hwaccel` 옵션이 없음. JPEG 출력(Output 3)에 하드웨어 가속 적용 시 `hwdownload` 필터 추가 필요.

---

### 4.2 GStreamer

**역할**: RTSP 수신 → JPEG 추출 (현재) / RTP 출력 + JPEG 추출 (구현 예정 시)

**구현 위치**: `gstreamerCapture.js` (현재 WebRTC OFF 전용)

**현재 GStreamer 파이프라인**:
```
# 소프트웨어 디코드
rtspsrc ! decodebin ! videorate ! videoscale ! videoconvert ! jpegenc ! fdsink

# nvdec (NVIDIA)
rtspsrc ! rtph264depay ! nvh264dec ! videorate ! videoscale ! videoconvert ! jpegenc ! fdsink

# vaapi (Intel/AMD)
rtspsrc ! decodebin(vaapidecodebin) ! videorate ! videoscale ! vaapipostproc ! jpegenc ! fdsink
```

**GStreamer WebRTC 확장 가능성** (현재 미구현):
```
# GStreamer RTP 출력 + JPEG — RtpIngestion 대체 경로
rtspsrc name=src
  src. ! rtph264depay ! nvh264dec ! tee name=t
    t. ! videorate ! videoscale ! videoconvert ! jpegenc ! fdsink     # AI 경로
    t. ! rtph264pay pt=96 ! udpsink host=127.0.0.1 port={videoPort}  # WebRTC 경로
  src. ! rtpopusdepay ! opusdec ! opusenc ! rtpopuspay pt=111 ! udpsink host=127.0.0.1 port={audioPort}
```

| 항목 | 평가 |
|---|---|
| OS 호환성 | Linux 우선, Windows는 공식 installer 필요 |
| 하드웨어 가속 | nvdec (NVIDIA), vaapi (Intel/AMD) — **현재 이미 구현됨** |
| WebRTC 통합 | webrtcbin 플러그인 (gst-plugins-bad) — 직접 WebRTC 가능 |
| RTP 출력 | udpsink → mediasoup PlainTransport (FFmpeg 방식과 동일) |
| AI 추론 통합 | fdsink → JPEG 스트림 (현재 방식 유지) |
| 레이턴시 | 낮음 (하드웨어 디코드, JPEG 라운드트립 없음 가능) |
| CPU 사용량 | 낮음 (GPU 디코딩 시 CPU 부하 대폭 감소) |
| 의존성 | gstreamer1.0-tools, gstreamer1.0-plugins-good/bad/ugly |
| **결론** | **단기-중기 개선의 핵심 경로. 하드웨어 가속이 이미 구현되어 있어 WebRTC 경로에도 적용 가능** |

---

### 4.3 MediaMTX (Pion WebRTC 기반)

**역할**: RTSP → WebRTC 직접 변환 (현재 실행 중, 미활용)

**현황**: `mediamtx.yml` 구성 존재, 포트 8889(WebRTC), 8554(RTSP) 실행 중

**MediaMTX Direct WebRTC 경로**:
```
[IP Camera]
    │ RTSP
    ▼
[MediaMTX]
    ├─ WebRTC out: http://server:8889/{streamName}  ← 브라우저에서 직접 열람
    └─ RTSP re-stream: rtsp://localhost:8554/{streamName} ← AI 파이프라인이 소비

[pipelineManager.js]
    │ rtsp://localhost:8554/{streamName} (MediaMTX 재스트림)
    └─ captureFactory (ffmpeg/gstreamer/pyav) → JPEG → YOLOv8
```

**이 구조에서 RtpIngestion + mediasoup 완전 우회 가능:**
```
브라우저 ← MediaMTX WebRTC ← (RTSP 카메라)
            (Pion Go WebRTC)

AI 경로: Node.js → FFmpeg/GStreamer → RTSP(MediaMTX 재스트림) → JPEG
```

| 항목 | 평가 |
|---|---|
| OS 호환성 | Linux / Windows / macOS (Go 바이너리) |
| 하드웨어 가속 | Go 레이어에서 직접 지원 없음 (RTSP→WebRTC 변환은 소프트웨어) |
| WebRTC 통합 | **네이티브 WebRTC 출력** — mediasoup 불필요 |
| AI 추론 통합 | MediaMTX RTSP 재스트림을 AI 파이프라인이 소비 |
| 레이턴시 | 낮음 (별도 RTP 변환 없음) |
| ICE 처리 | MediaMTX가 자체 STUN/TURN 설정 보유 (mediasoup ICE와 분리) |
| 의존성 | **이미 실행 중** — 추가 설치 불필요 |
| 구현 복잡도 | 낮음 — mediasoup WebRtcTransport 제거, MediaMTX URL 프록시 |
| **결론** | **이미 실행 중인 자원 활용. mediasoup ICE 문제를 우회하는 즉각적 대안** |

**현재 mediamtx.yml 설정 상태**:
```yaml
# port 8889 WebRTC — 현재 127.0.0.1 바인딩 (내부 전용)
# 브라우저 직접 접근 위해 0.0.0.0 또는 실제 서버 IP로 변경 필요
```

---

### 4.4 NVIDIA DeepStream

**역할**: GPU 엔드-투-엔드 AI 비디오 분석 (TensorRT 기반)

| 항목 | 평가 |
|---|---|
| OS 호환성 | Linux (NVIDIA Jetson / x86+GPU) 전용 |
| 하드웨어 가속 | **완전한 GPU 파이프라인** — 디코딩/추론/인코딩 모두 GPU |
| 처리 용량 | GPU 1개당 30–50 카메라 동시 처리 |
| 추론 성능 | TensorRT 최적화 — YOLOv8보다 2–5× 빠름 |
| WebRTC 통합 | GStreamer webrtcbin을 통해 가능 |
| AI 추론 통합 | **nvinfer 플러그인 직접 통합** — JPEG 변환 불필요 |
| 의존성 | NVIDIA GPU + CUDA + DeepStream SDK 필요 |
| 구현 복잡도 | 높음 — 전체 파이프라인 재설계 필요 |
| 비용 | NVIDIA GPU 서버 필수 |
| **결론** | **30대+ 카메라 대규모 운영 시 권장. 현재 환경에서는 오버스펙** |

---

### 4.5 aiortc (Python WebRTC)

**역할**: Python 환경에서 WebRTC 처리

| 항목 | 평가 |
|---|---|
| OS 호환성 | Linux / macOS / Windows (pip install) |
| 언어 | Python — PyAV 사이드카와 통합 용이 |
| WebRTC 통합 | RTCPeerConnection, RTCRtpSender 완전 구현 |
| AI 추론 통합 | Python 프로세스 내에서 직접 추론 가능 |
| 레이턴시 | Python GIL 영향, Node.js 프로세스 간 IPC 필요 |
| 의존성 | pip install aiortc + libav 헤더 |
| Node.js 연동 | IPC(stdin/stdout 또는 소켓) 필요 |
| **결론** | **PyAV 백엔드 확장 경로. Node.js 주 프로세스와 분리 운영 가능하나 IPC 복잡도 증가** |

---

### 4.6 Pion (Go WebRTC)

**역할**: Go 언어 WebRTC 라이브러리

| 항목 | 평가 |
|---|---|
| OS 호환성 | Linux / Windows / macOS |
| WebRTC 통합 | **완전한 WebRTC 스택** (ICE, DTLS, SRTP) |
| 성능 | Go 런타임 — 낮은 레이턴시, 낮은 메모리 |
| AI 추론 통합 | Node.js와 별도 Go 프로세스 필요 |
| 의존성 | Go 런타임 필요 |
| MediaMTX 관계 | MediaMTX가 Pion 기반으로 구현됨 — MediaMTX 사용으로 대체 가능 |
| **결론** | **MediaMTX를 통해 이미 간접 활용 중. 별도 Go 서비스 구축은 불필요** |

---

### 4.7 live555 (평가 결과: 부적합)

**역할**: C++ RTSP 클라이언트/서버 라이브러리

| 항목 | 평가 |
|---|---|
| 기능 범위 | **RTSP 수신/전송만** — AI 파이프라인/WebRTC 없음 |
| 언어 | C++ — Node.js 바인딩 없음 |
| 하드웨어 가속 | 없음 |
| WebRTC | **미지원** |
| Node.js 통합 | 불가 (FFmpeg가 내부적으로 사용) |
| **결론** | **이 프로젝트에 적합하지 않음. live555는 FFmpeg/GStreamer의 RTSP 레이어 내부에서 사용되는 라이브러리이며 독립 대안이 아님** |

---

## 5. Full Comparison Matrix

### 5.1 기능 비교

| 기준 | FFmpeg (현재) | GStreamer | MediaMTX | DeepStream | aiortc | live555 |
|---|---|---|---|---|---|---|
| **OS 지원** | Win/Lin/Mac | Lin 우선 | Win/Lin/Mac | Linux(NVIDIA) | Win/Lin/Mac | Win/Lin/Mac |
| **RTSP 수신** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **H264 디코딩** | SW/HW 모두 | SW/HW 모두 | SW | GPU only | SW | SW |
| **하드웨어 가속** | 설정 필요 | **구현됨** (nvdec/vaapi) | ❌ | **완전 GPU** | 부분 | ❌ |
| **WebRTC 출력** | RTP→mediasoup | webrtcbin 가능 | **네이티브** | webrtcbin 가능 | 네이티브 | ❌ |
| **AI 추론 통합** | JPEG pipe | JPEG pipe | 별도 경로 필요 | TensorRT 직접 | Python 직접 | ❌ |
| **오디오 처리** | Opus 트랜스코딩 | 가능 | 패스스루 | 가능 | 가능 | ❌ |
| **Node.js 통합** | ✅ (subprocess) | ✅ (subprocess) | ✅ (HTTP API) | ❌ | 부분 (IPC) | ❌ |
| **현재 구현** | ✅ 사용 중 | ✅ (WebRTC OFF 전용) | ✅ 실행 중 | ❌ | ❌ | N/A |

### 5.2 성능 비교 (추정, 1080p 30fps 카메라 기준)

| 지표 | FFmpeg | GStreamer+nvdec | MediaMTX | DeepStream |
|---|---|---|---|---|
| **CPU 사용 (디코딩)** | ~25% | ~5% (GPU 오프로드) | ~15% | ~2% (GPU) |
| **GPU 사용 (디코딩)** | 0% | 40–60% | 0% | 60–80% |
| **WebRTC 연결 지연** | 15 s+ (STUN 실패 시) | 동일 (ICE 의존) | 별도 ICE 설정 | 동일 (ICE 의존) |
| **동시 카메라 (서버 8코어)** | ~8–12 | ~20–30 | ~15–25 | ~30–50 (GPU) |
| **재연결 시 중단 시간** | 2–5 s | 2–5 s | < 1 s | 2–5 s |
| **레이턴시 (카메라→브라우저)** | 300–800 ms | 200–500 ms | 100–300 ms | 200–500 ms |

### 5.3 구현 복잡도 및 리스크

| 대안 | 구현 공수 | 코드 변경 범위 | 배포 리스크 | 롤백 가능성 |
|---|---|---|---|---|
| **ICE 설정 수정** | 0.5일 | `.env` 2줄 | 없음 | 즉시 가능 |
| **GStreamer WebRTC** | 3–5일 | `rtpIngestion.js` 대체 | 낮음 (선택적 활성화) | 높음 (CAPTURE_BACKEND) |
| **MediaMTX Direct** | 2–3일 | `webrtcGateway.js`, `pipelineManager.js` | 중간 (아키텍처 변경) | 중간 |
| **DeepStream** | 2–4주 | 전체 AI 파이프라인 재작성 | 높음 | 낮음 |
| **aiortc** | 1–2주 | PyAV 백엔드 확장 | 중간 | 높음 (CAPTURE_BACKEND) |

---

## 6. Recommended Roadmap

### Phase 0 — 즉시 적용 (0일차, 영상 중단 없음)

**목표**: WebRTC 불안정 즉시 해소

```bash
# server/.env
SERVER_IP=192.168.x.x          # 서버 실제 LAN IP로 변경 (127.0.0.1 제거)
STUN_URLS=                     # 도달 불가 Google STUN 서버 제거
                               # 또는 자체 coturn STUN으로 교체
```

| 조치 | 예상 효과 |
|---|---|
| SERVER_IP LAN IP 설정 | 브라우저가 서버에 직접 연결 → TURN 릴레이 불필요 |
| 도달 불가 STUN 제거 | ICE 수집 15 s 타임아웃 → 1 s 이하로 단축 |
| 자체 coturn 설치 (선택) | 외부망 클라이언트도 안정적 연결 |

**담당**: 운영팀, 설정 변경만으로 완료

---

### Phase 1 — 단기 (1–2주)

**목표**: GStreamer 하드웨어 가속을 WebRTC 경로에도 적용

**현재 상태**: `gstreamerCapture.js`는 WebRTC OFF 전용으로 구현됨. WebRTC ON 시 `RtpIngestion`(FFmpeg)이 강제 사용되어 하드웨어 디코딩 이점이 없음.

**구현 내용**:
1. `GStreamerRtpIngestion` 클래스 신규 작성 (`gstreamerRtpIngestion.js`)
   - 기존 `gstreamerCapture.js`의 nvdec/vaapi 파이프라인 + RTP UDP 출력 결합
   - `pipelineManager.js`: `useWebRTC && CAPTURE_BACKEND=gstreamer` 조건 추가
2. `pipelineManager.js` 분기 확장:
   ```javascript
   if (useWebRTC && CAPTURE_BACKEND === 'gstreamer') {
     capture = new GStreamerRtpIngestion(camera.id, rtspUrl, opts);
   } else if (useWebRTC) {
     capture = new RtpIngestion(camera.id, rtspUrl, opts);  // FFmpeg 유지
   } else {
     capture = createCapture(camera.id, rtspUrl, opts);
   }
   ```

**예상 효과**: nvdec 환경에서 CPU 디코딩 부하 50–80% 감소

---

### Phase 2 — 중기 (1–2개월)

**목표**: MediaMTX 네이티브 WebRTC 활용으로 mediasoup ICE 의존성 완화

**구현 내용**:
1. `mediamtx.yml` WebRTC 바인딩을 `0.0.0.0` 또는 서버 IP로 변경
2. 카메라별 MediaMTX 패스 등록 (`POST /v3/config/paths/add/{name}`)
3. 클라이언트: mediasoup WebRtcTransport 대신 MediaMTX WebRTC URL (`http://server:8889/{pathName}`) 사용
4. `pipelineManager.js`: MediaMTX 경로 등록 후 AI 추론은 MediaMTX RTSP 재스트림 소비

**아키텍처 변화**:
```
현재: Camera → FFmpeg(RtpIngestion) → mediasoup PlainTransport → mediasoup WebRtcTransport → Browser
변경: Camera → MediaMTX → MediaMTX WebRTC → Browser
              └─ RTSP re-stream → captureFactory → JPEG → AI Pipeline
```

**예상 효과**: ICE/DTLS 처리를 Pion(Go) 기반 MediaMTX가 담당 → mediasoup ICE 설정 오류 영향 없음

---

### Phase 3 — 장기 (6개월+, 선택적)

**목표**: NVIDIA DeepStream으로 대규모 카메라 처리

**조건**: 30대 이상 카메라, NVIDIA GPU 서버 가용

**구현 내용**:
1. YOLOv8 모델을 TensorRT `.engine` 파일로 변환
2. GStreamer DeepStream 파이프라인 구축 (`nvinfer`, `nvtracker`, `nvmsgbroker`)
3. `pipelineManager.js`에 DeepStream IPC 인터페이스 추가
4. 감지 결과를 Socket.IO로 중계하는 Node.js 브리지 구현

---

### 로드맵 요약

```
2026-06-05 ─── Phase 0 ─── SERVER_IP / STUN 즉시 수정
                             ↓ WebRTC 즉시 안정화
           ─── Phase 1 ─── GStreamer WebRTC (1-2주)
                             ↓ GPU 디코딩으로 CPU 부하 감소
           ─── Phase 2 ─── MediaMTX WebRTC (1-2개월)
                             ↓ mediasoup ICE 의존성 제거
           ─── Phase 3 ─── DeepStream (6개월+, 선택)
                             ↓ 30대+ 카메라 엔터프라이즈 확장
```

---

## 7. Acceptance Criteria

Phase 0 완료 기준:
- [ ] ICE 수집 시간 < 3 s (기존 15 s+)
- [ ] WebRTC 연결 성공률 > 95% (7일 연속 운영)
- [ ] 브라우저 콘솔에 오류 코드 701 없음

Phase 1 완료 기준:
- [ ] `CAPTURE_BACKEND=gstreamer`, `webrtcEnabled=true` 조합 정상 동작
- [ ] nvdec 환경에서 FFmpeg 대비 CPU 사용량 ≥ 40% 감소
- [ ] `CAPTURE_BACKEND=ffmpeg`로 롤백 시 기존 동작 동일

Phase 2 완료 기준:
- [ ] MediaMTX WebRTC 브라우저 재생 성공
- [ ] AI 파이프라인이 MediaMTX RTSP 재스트림에서 정상 동작
- [ ] mediasoup WebRtcTransport 없이도 브라우저 연결 가능

---

## 8. Risk Assessment

| 리스크 | 가능성 | 영향 | 완화 방안 |
|---|---|---|---|
| GStreamer nvdec 플러그인 미설치 | 중 | 중 | 자동 감지 후 software 폴백 (`HW_DECODER` 변수) |
| MediaMTX API 버전 불일치 | 낮 | 중 | `mediamtx.yml` 버전 고정, API 버전 검증 |
| SERVER_IP 변경 후 ICE 재테스트 필요 | 높 | 낮 | ICE 테스트 UI로 즉시 검증 가능 |
| TURN 서버 없이 외부망 클라이언트 연결 불가 | 중 | 중 | coturn 설치 가이드 제공 (docs/ops/) |
| FFmpeg 3-output 제거 시 오디오 손실 가능 | 낮 | 중 | 오디오 경로 별도 검증, Phase 1 완료 후 전환 |

---

## 9. Related Documents

| 문서 | 경로 | 관계 |
|---|---|---|
| WebRTC Media Gateway RFP | [rfp/RFP_WebRTC_Media_Gateway.md](RFP_WebRTC_Media_Gateway.md) | 상위 WebRTC 아키텍처 |
| WebRTC Media Gateway PRD | [prd/PRD_WebRTC_Media_Gateway.md](../prd/PRD_WebRTC_Media_Gateway.md) | 현재 구현 기준 |
| STUN/TURN ICE Design | [design/Design_STUN_TURN_ICE.md](../design/Design_STUN_TURN_ICE.md) | ICE 설정 세부 사항 |
| ICE Test UI PRD | [prd/PRD_ICE_Test_UI.md](../prd/PRD_ICE_Test_UI.md) | ICE 진단 도구 |
| CUDA Acceleration RFP | [rfp/RFP_AI_CUDA_Acceleration.md](RFP_AI_CUDA_Acceleration.md) | GPU 추론 가속화 |
| ONNX Runtime Source Build | [ops/ONNX_Runtime_Source_Build_CUDA13.md](../ops/ONNX_Runtime_Source_Build_CUDA13.md) | CUDA 빌드 환경 |
