# PRD — Video Capture Pipeline Architecture
**Document ID**: PRD-LTS-VCP-01  
**Version**: 1.1  
**Date**: 2026-06-05  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Approved  
**Parent RFP**: [rfp/RFP_Video_Capture_Pipeline.md](../rfp/RFP_Video_Capture_Pipeline.md)

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-06-05 | Initial version — derived from RFP evaluation and ICE instability diagnosis |
| 1.1 | 2026-06-11 | 현재 구현(ingest-daemon + MediaMTX WHEP) §2 반영; §3 기술 선택 표 업데이트; WEBRTC_ENGINE → WEBRTC_ENGINE 전면 교체 |

---

## Table of Contents

1. [Product Goal](#1-product-goal)
2. [Current Architecture Summary](#2-current-architecture-summary)
3. [Technology Selection](#3-technology-selection)
4. [Implementation Priorities](#4-implementation-priorities)
5. [Phase 0 — Immediate ICE Fix](#5-phase-0--immediate-ice-fix)
6. [Phase 1 — GStreamer WebRTC Backend](#6-phase-1--gstreamer-webrtc-backend)
7. [Phase 2 — MediaMTX Direct WebRTC](#7-phase-2--mediamtx-direct-webrtc)
8. [Phase 3 — DeepStream (Optional)](#8-phase-3--deepstream-optional)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Compatibility & Rollback Policy](#10-compatibility--rollback-policy)
11. [Dependencies](#11-dependencies)

---

## 1. Product Goal

WebRTC 스트림 불안정(연결 지연 15 s+, 영상 프리즈, 반복 재연결)을 해소하고, 장기적으로 다수 카메라를 안정적으로 운영할 수 있는 영상 수집 파이프라인 아키텍처를 구현한다.

**성공 기준**:
- Phase 0 완료 후 7일 연속 WebRTC 연결 성공률 ≥ 95%
- Phase 1 완료 후 8코어 서버에서 동시 처리 가능 카메라 수 ≥ 20대 (현재 ~8대)
- Phase 2 완료 후 mediasoup ICE 관련 연결 실패 0건

---

## 2. Current Architecture Summary

### 2.1 현재 구현 (ingest-daemon + MediaMTX WHEP — 기본값)

> **현재 LTS-2026 배포 기본값**: `CAPTURE_BACKEND=ingest-daemon`, `WEBRTC_ENGINE=mediamtx`

```
카메라 RTSP
  │
  ▼
MediaMTX (:8554)        ← RTSP pull (카메라당 1개 연결)
  ├── WHEP (:8889)      → 브라우저 직접 WebRTC (H.264 SRTP)
  └── RTSP loopback     → ingest-daemon (PyAV)
         │ JPEG POST (:7070)
         ▼
      Node.js pipelineManager → AI 파이프라인 (YOLO/ByteTrack)
```

핵심 파일:
```
server/src/services/
├── captureFactory.js          # CAPTURE_BACKEND 선택 팩토리
├── ingestDaemonCapture.js     # 현재 기본 — 수동 EventEmitter (수신 전용)
├── mediamtxManager.js         # MediaMTX 경로 등록/해제 (WEBRTC_ENGINE=mediamtx)
├── rtspCapture.js             # 레거시 FFmpeg JPEG 백엔드
├── gstreamerCapture.js        # 레거시 GStreamer JPEG 백엔드
├── pyavCapture.js             # 레거시 Python PyAV JPEG 백엔드
├── rtpIngestion.js            # 레거시 FFmpeg RTP+JPEG (mediasoup 전용)
├── webrtcGateway.js           # 레거시 mediasoup Worker/Router/Transport
└── pipelineManager.js         # 전체 파이프라인 오케스트레이터
```

### 2.2 현재 분기 로직 (현재 구현)

```javascript
const FORCE_NO_WEBRTC = (CAPTURE_BACKEND === 'ingest-daemon')
                     && (WEBRTC_ENGINE === 'mediasoup');

const useWebRTC = camera.webrtcEnabled
               && !FORCE_NO_WEBRTC
               && (WEBRTC_ENGINE === 'mediamtx' || webrtcGateway.enabled);
```

- `WEBRTC_ENGINE=mediamtx` (현재 기본): `mediamtxManager.js`가 MediaMTX에 카메라 경로를 등록하고 WHEP URL을 클라이언트에 전달.
- `CAPTURE_BACKEND=ingest-daemon` (현재 기본): AI 파이프라인은 ingest-daemon이 보내는 JPEG 버퍼를 수신.

### 2.3 레거시 분기 로직 (ICE 문제 진단 당시 기준)

| 원인 | 당시 설정 | 수정값 |
|---|---|---|
| STUN 서버 DNS 실패 | `stun:stun.l.google.com:19302` | 빈 값 또는 로컬 STUN |
| SERVER_IP 오류 | `SERVER_IP=127.0.0.1` | `SERVER_IP=<서버 LAN IP>` |

### 2.3 ICE 연결 문제 진단 결과

| 원인 | 현재 설정 | 올바른 설정 |
|---|---|---|
| STUN 서버 DNS 실패 | `stun:stun.l.google.com:19302` (DNS 조회 불가) | 도달 가능한 STUN 서버 또는 빈 값 |
| SERVER_IP 오류 | `SERVER_IP=127.0.0.1` | `SERVER_IP=<서버 LAN IP>` |

---

## 3. Technology Selection

RFP 평가 결과에 따른 단계별 기술 선택:

| 단계 | 채택 기술 | 이유 | 상태 |
|---|---|---|---|
| **현재 (기본값)** | **ingest-daemon + MediaMTX WHEP** | PyAV 데몬이 MediaMTX RTSP loopback 소비 → JPEG 전달; MediaMTX가 WHEP WebRTC 처리 | ✅ **구현 완료** |
| Phase 0 | 설정 수정 (ICE 수정) | 코드 변경 없이 즉시 효과 | ✅ 완료 |
| Phase 1 | **GStreamer RTP Ingestion** | 기존 `gstreamerCapture.js` nvdec/vaapi 코드 재활용 | 🔲 미착수 |
| Phase 2 | **MediaMTX Direct WebRTC** | Pion WebRTC로 mediasoup ICE 의존성 제거 | ✅ 기본 경로로 채택 완료 |
| Phase 3 | NVIDIA DeepStream (선택) | 30대+ 카메라 엔터프라이즈 확장 시에만 | 🔲 미착수 |

**채택하지 않은 기술**:
- **live555**: RTSP 레이어 라이브러리에 불과, WebRTC/AI 기능 없음 → 제외
- **aiortc**: Python IPC 복잡도 증가, PyAV 경로와 중복 → 제외 (PyAV 경로 자체 개선으로 대체)
- **Pion (독립)**: MediaMTX가 이미 Pion 기반 → 별도 Go 서비스 불필요

---

## 4. Implementation Priorities

### 우선순위 매트릭스

| 구현 항목 | 우선순위 | 기간 | 코드 변경 | 담당 |
|---|---|---|---|---|
| SERVER_IP LAN IP 변경 | **P0 — 즉시** | 1시간 | `.env` 1줄 | 운영 |
| STUN 서버 제거/교체 | **P0 — 즉시** | 1시간 | `.env` 1줄 | 운영 |
| GStreamerRtpIngestion 구현 | P1 — 단기 | 3–5일 | 신규 파일 1개 + 수정 1개 | 개발 |
| pipelineManager WebRTC 분기 확장 | P1 — 단기 | 1일 | `pipelineManager.js` | 개발 |
| MediaMTX WebRTC 바인딩 변경 | P2 — 중기 | 0.5일 | `mediamtx.yml` | 운영 |
| MediaMTX 카메라 경로 연동 | P2 — 중기 | 2–3일 | `webrtcGateway.js` | 개발 |
| DeepStream 파이프라인 | P3 — 장기 | 2–4주 | 전체 재설계 | 개발 |

---

## 5. Phase 0 — Immediate ICE Fix

### 5.1 변경 내용

**파일**: `server/.env`

```bash
# 변경 전
SERVER_IP=127.0.0.1
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302

# 변경 후
SERVER_IP=192.168.x.x        # 서버 실제 LAN IP (hostname -I | awk '{print $1}')
STUN_URLS=                   # 도달 불가 서버 제거 (자체 coturn 있으면 입력)
```

### 5.2 서버 IP 확인 명령

```bash
# Linux
hostname -I | awk '{print $1}'

# Windows PowerShell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' })[0].IPAddress
```

### 5.3 변경 후 검증

Settings Modal → ICE Connectivity Test 실행:
- `[Phase 1 Summary]`에서 gather 시간 < 3 s 확인
- `[Phase 2]`에서 Server ICE candidates IP가 실제 LAN IP인지 확인
- 오류 코드 701 없음 확인

### 5.4 자체 coturn 설치 (선택 — 외부망 접근 시)

```bash
sudo apt install coturn
# /etc/turnserver.conf 설정 후:
sudo systemctl enable coturn && sudo systemctl start coturn
```

```bash
# server/.env
STUN_URLS=stun:your-server-ip:3478
TURN_URL=turn:your-server-ip:3478
TURN_USERNAME=lts
TURN_CREDENTIAL=secure-password
```

---

## 6. Phase 1 — GStreamer WebRTC Backend

### 6.1 목표

`CAPTURE_BACKEND=gstreamer` + `camera.webrtcEnabled=true` 조합에서 NVIDIA nvdec 또는 Intel/AMD vaapi 하드웨어 디코더를 사용하여 H264 RTP → mediasoup + JPEG → AI 추론을 동시 처리.

### 6.2 신규 구현: GStreamerRtpIngestion

**파일**: `server/src/services/gstreamerRtpIngestion.js` (신규)

```
GStreamer 파이프라인 설계:
  rtspsrc name=src
    src. ! rtph264depay ! {hw_decoder} ! tee name=t
      t. ! queue ! videorate ! videoscale ! videoconvert ! jpegenc quality=85 ! fdsink
      t. ! queue ! rtph264pay pt=96 ssrc=1111 ! udpsink host=127.0.0.1 port={videoPort}
    src. ! rtpopusdepay ! opusdec ! opusenc bitrate=32000 ! rtpopuspay pt=111 ssrc=2222
         ! udpsink host=127.0.0.1 port={audioPort}
```

- `RtpIngestion`과 동일한 EventEmitter 인터페이스 구현 (`frame`, `started`, `warn`, `reconnecting`, `error`)
- mediasoup PlainTransport 설정은 `RtpIngestion._setupMediasoup()`와 동일
- hw_decoder: `nvh264dec` (nvdec) | `vaapidecodebin` (vaapi) | `avdec_h264` (software)

### 6.3 pipelineManager.js 분기 확장

```javascript
// server/src/services/pipelineManager.js (기존 185–195 라인 수정)
const useWebRTC = !!(camera.webrtcEnabled && webrtcGateway.enabled);

let capture;
if (useWebRTC && CAPTURE_BACKEND === 'gstreamer') {
  const GStreamerRtpIngestion = require('./gstreamerRtpIngestion');
  capture = new GStreamerRtpIngestion(camera.id, rtspUrl, { fps: captureFps, width: 640 });
  await capture.start();
} else if (useWebRTC) {
  capture = new RtpIngestion(camera.id, rtspUrl, { fps: captureFps, width: 640 });
  await capture.start();
} else {
  capture = createCapture(camera.id, rtspUrl, { fps: captureFps, width: 640 });
}
```

### 6.4 활성화 방법

```bash
# server/.env
CAPTURE_BACKEND=gstreamer
GSTREAMER_HW_ACCEL=nvdec    # 또는 vaapi, auto, software
```

### 6.5 폴백 정책

GStreamer 또는 nvdec 플러그인이 없을 경우:
- `gstreamerRtpIngestion.js` 내부에서 자동 감지
- `CAPTURE_BACKEND=gstreamer`이지만 GStreamer 미설치 시 → 경고 로그 출력 후 FFmpeg RtpIngestion으로 폴백

---

## 7. Phase 2 — MediaMTX Direct WebRTC

### 7.1 목표

mediasoup WebRtcTransport를 우회하고 MediaMTX의 네이티브 WebRTC(Pion 기반) 출력을 브라우저에 직접 전달. ICE/DTLS 처리를 MediaMTX가 담당하여 mediasoup ICE 설정 문제 원천 차단.

### 7.2 아키텍처 변화

```
현재 경로:
  Camera → FFmpeg(RtpIngestion) → mediasoup PlainTransport
         → mediasoup WebRtcTransport (SERVER_IP ICE 의존) → Browser

변경 경로 (MediaMTX mode):
  Camera → MediaMTX
         └─ WebRTC: http://server:8889/{camId} → Browser  (Pion ICE)
         └─ RTSP: rtsp://localhost:8554/{camId} → captureFactory → JPEG → AI
```

### 7.3 주요 변경 사항

**파일**: `mediamtx.yml`
```yaml
# WebRTC 외부 접근 허용
webrtcAddress: :8889      # 0.0.0.0 바인딩 (기존 127.0.0.1 → 전체)
```

**파일**: `server/src/services/webrtcGateway.js` (신규 모드 추가)
- `WEBRTC_ENGINE=mediamtx` 환경변수 시: mediasoup Worker 생성 생략
- MediaMTX REST API (`/v3/config/paths`) 로 카메라 경로 등록/삭제

**파일**: `client/src/hooks/useWebRTC.ts`
- `WEBRTC_ENGINE=mediamtx` 시: mediasoup-client 대신 `<video>` 에 MediaMTX WebRTC URL 직접 사용
- 폴백: MediaMTX 미응답 시 기존 mediasoup 경로 사용

### 7.4 활성화 방법

```bash
# server/.env
WEBRTC_ENGINE=mediamtx          # 신규 환경변수
MEDIAMTX_API_URL=http://localhost:9997   # MediaMTX API 포트
MEDIAMTX_WEBRTC_URL=http://192.168.x.x:8889  # 브라우저 접근 URL
```

---

## 8. Phase 3 — DeepStream (Optional)

### 8.1 적용 조건

- 동시 처리 카메라 30대 이상
- NVIDIA GPU 서버 (Tesla T4, A100, RTX 시리즈)
- 현재 아키텍처에서 CPU 병목 확인됨

### 8.2 구현 방향

1. YOLOv8 ONNX → TensorRT `.engine` 변환 (`trtexec`)
2. GStreamer DeepStream 파이프라인 (`nvinfer`, `nvtracker`, `nvmsgbroker`)
3. Node.js 브리지: DeepStream MQTT/Kafka 메시지 → Socket.IO 이벤트 변환
4. `pipelineManager.js`에 `CAPTURE_BACKEND=deepstream` 분기 추가

### 8.3 관련 문서

- [rfp/RFP_AI_CUDA_Acceleration.md](../rfp/RFP_AI_CUDA_Acceleration.md)
- [ops/ONNX_Runtime_Source_Build_CUDA13.md](../ops/ONNX_Runtime_Source_Build_CUDA13.md)

---

## 9. Non-Functional Requirements

| ID | 요구사항 | 측정 방법 |
|---|---|---|
| NFR-VCP-001 | Phase 0 후 ICE 수집 시간 < 3 s | ICE Test UI Phase 1 gather 시간 |
| NFR-VCP-002 | Phase 0 후 WebRTC 연결 성공률 ≥ 95% (7일) | 연결 실패 로그 모니터링 |
| NFR-VCP-003 | Phase 1 후 nvdec 환경에서 CPU 디코딩 사용량 ≤ 10% per camera | `htop` / `nvidia-smi` |
| NFR-VCP-004 | CAPTURE_BACKEND 변경이 런타임에 새 카메라에 즉시 적용 | 카메라 추가 API 테스트 |
| NFR-VCP-005 | GStreamer 미설치 시 FFmpeg로 자동 폴백 | 의존성 없는 환경 테스트 |
| NFR-VCP-006 | Phase 1/2 전환 중 기존 카메라 연결 중단 없음 | 스트리밍 중 `.env` 변경 후 재시작 테스트 |
| NFR-VCP-007 | 레이턴시 (카메라→브라우저) Phase 1 후 ≤ 500 ms | WebRTC stats `currentRoundTripTime` |

---

## 10. Compatibility & Rollback Policy

### 10.1 하위 호환성

| 변경 | 기존 동작 영향 |
|---|---|
| `SERVER_IP` 변경 | 서버 재시작 필요, ICE 재수집 발생 — 영상 재연결 1회 |
| `CAPTURE_BACKEND=gstreamer` | GStreamer 미설치 시 폴백 → 기존 FFmpeg 동작 유지 |
| `CAPTURE_BACKEND=ffmpeg` (기본값) | 변경 없음 |
| Phase 2 `WEBRTC_ENGINE=mediamtx` | 기존 mediasoup 경로 동시 유지 (폴백 조건 설정) |

### 10.2 롤백 절차

**Phase 0 롤백**:
```bash
# server/.env를 이전 값으로 복원 후 서버 재시작
SERVER_IP=127.0.0.1
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
```

**Phase 1 롤백**:
```bash
CAPTURE_BACKEND=ffmpeg    # FFmpeg RtpIngestion 복귀
```

**Phase 2 롤백**:
```bash
# WEBRTC_ENGINE 환경변수 제거 또는 mediasoup으로 설정
WEBRTC_ENGINE=mediasoup
```

---

## 11. Dependencies

### 11.1 Phase 0

| 의존성 | 설치 방법 | 필수 여부 |
|---|---|---|
| 서버 LAN IP 접근 | 네트워크 관리자 확인 | 필수 |
| coturn (TURN 서버) | `apt install coturn` | 외부망 클라이언트 시 |

### 11.2 Phase 1

| 의존성 | 설치 방법 | 필수 여부 |
|---|---|---|
| GStreamer 1.0 | `apt install gstreamer1.0-tools gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly` | 필수 |
| nvdec 플러그인 | `apt install gstreamer1.0-plugins-bad` + NVIDIA 드라이버 | nvdec 사용 시 |
| vaapi 플러그인 | `apt install gstreamer1.0-vaapi` | vaapi 사용 시 |

### 11.3 Phase 2

| 의존성 | 설치 방법 | 필수 여부 |
|---|---|---|
| MediaMTX | 이미 실행 중 | 필수 |
| MediaMTX API 포트 9997 | `mediamtx.yml: apiAddress: :9997` | 필수 |
