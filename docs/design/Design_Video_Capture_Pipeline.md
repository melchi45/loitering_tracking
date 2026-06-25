# DESIGN DOCUMENT — Video Capture Pipeline Architecture
**Document ID**: DESIGN-LTS-VCP-01  
**Version**: 2.1  
**Date**: 2026-06-11  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Active  
**Parent SRS**: [srs/SRS_Video_Capture_Pipeline.md](../srs/SRS_Video_Capture_Pipeline.md)  
**Parent PRD**: [prd/PRD_Video_Capture_Pipeline.md](../prd/PRD_Video_Capture_Pipeline.md)

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-06-05 | Initial design — legacy FFmpeg+mediasoup architecture + Phase 0/1/2 design |
| 2.0 | 2026-06-11 | §0 현재 구현 아키텍처 추가 (ingest-daemon + MediaMTX); Phase 1/2 레거시 표기; Phase 3 ingest-daemon 섹션 신규 추가; §5/§7 현행 파일·설정으로 갱신 |
| 2.1 | 2026-06-25 | §0 mediasoup 직접 연결 아키텍처로 업데이트 — MediaMTX relay 제거, WEBRTC_ENGINE=mediasoup 시 카메라 직접 연결 반영; §0.5 FORCE_NO_WEBRTC 로직 정정 |

---

> ⚠️ **문서 구조 안내**  
> - **§0**: 현재 운영 아키텍처 (`CAPTURE_BACKEND=ingest-daemon`, `WEBRTC_ENGINE=mediasoup`)  
> - **§1**: 레거시 아키텍처 (FFmpeg RtpIngestion + mediasoup) — 참조용 보존  
> - **§2~§4**: Phase 0/1/2 설계 이력 — Phase 2(MediaMTX WebRTC)는 구현 완료  
> - **§5**: 현행 파일 구조 요약  
> - **§6**: 시퀀스 다이어그램  
> - **§7**: 현행 설정 결정 트리  
> - **§8**: 마이그레이션 가이드

---

## Table of Contents

0. [현재 구현 아키텍처 — ingest-daemon + MediaMTX](#0-현재-구현-아키텍처--ingest-daemon--mediamtx)
1. [Legacy Architecture — FFmpeg RtpIngestion + mediasoup](#1-legacy-architecture--ffmpeg-rtpingestion--mediasoup)
2. [Phase 0 — ICE Fix Design](#2-phase-0--ice-fix-design)
3. [Phase 1 — GStreamerRtpIngestion Design](#3-phase-1--gstreamerrtpingestion-design)
4. [Phase 2 — MediaMTX Direct WebRTC (구현 완료)](#4-phase-2--mediamtx-direct-webrtc-구현-완료)
5. [File Structure Summary (현행)](#5-file-structure-summary-현행)
6. [Sequence Diagrams](#6-sequence-diagrams)
7. [Configuration Decision Tree (현행)](#7-configuration-decision-tree-현행)
8. [Migration Guide](#8-migration-guide)

---

## 0. 현재 구현 아키텍처 — ingest-daemon + mediasoup

> **현재 기본 설정**: `CAPTURE_BACKEND=ingest-daemon`, `WEBRTC_ENGINE=mediasoup`  
> 서버 `server/.env`의 실제 운영 설정. `captureFactory.js`의 코드 폴백은 `ffmpeg` (미설치 환경 대비).

### 0.1 전체 파이프라인 다이어그램

```
┌────────────────────────────────────────────────────────────────────────────────┐
│         LTS-2026 Video Pipeline (현재 — ingest-daemon + mediasoup)             │
│                                                                                 │
│  [IP Camera]──RTSP(직접)──►[ingest_daemon.py :7070]  (PyAV 단일 세션)          │
│                                      │                                          │
│              ┌───────────────────────┼───────────────────────┐                 │
│              │                       │                       │                 │
│        ① JPEG (AI)           ② H.264 RTP              ③ App RTP (ONVIF)      │
│   HTTP POST /frame/{id}     UDP:{mediasoupPort}    HTTP POST /apprtp/{id}      │
│              │               ④ Opus RTP                      │                 │
│              │              UDP:{mediasoupAudioPort}          │                 │
│              ▼                       │                       ▼                 │
│  [pipelineManager.js]       [mediasoup Worker]      [onvifParser.js]           │
│  YOLOv8 → ByteTrack         PlainTransport           onvif_events DB           │
│  BehaviorEngine             WebRtcTransport           Socket.IO onvif:event    │
│              │              → SRTP → Browser                                   │
│              ▼              <video>/<audio>                                    │
│       [Socket.IO]                                                               │
│  frameData/newAlert/objectTracked                                               │
└────────────────────────────────────────────────────────────────────────────────┘
```

> **MediaMTX는 mediasoup 모드에서 사용하지 않습니다.**  
> ingest-daemon이 카메라에 직접 연결하여 AI JPEG, H.264/Opus RTP, App RTP를 단일 세션에서 팬아웃합니다.  
> MediaMTX는 `WEBRTC_ENGINE=mediamtx` 또는 YouTube/RTMP 스트림에서만 사용됩니다.

### 0.2 주요 서비스 파일

| 파일 | 역할 |
|---|---|
| `ingest-daemon/ingest_daemon.py` | Python PyAV 독립 데몬; RTSP 수신 → JPEG → HTTP POST to Node |
| `server/src/services/ingestDaemonCapture.js` | 수동 EventEmitter; `injectFrame()` → `emit('frame')` |
| `server/src/services/captureFactory.js` | `CAPTURE_BACKEND` 환경변수 기반 캡처 인스턴스 생성 |
| `server/src/services/mediamtxManager.js` | MediaMTX API (:9997)로 RTSP 경로 등록/해제 |
| `server/src/services/pipelineManager.js` | 카메라 시작/중지, AI 파이프라인 오케스트레이션 |
| `server/src/scripts/restartIngestDaemon.js` | `npm run ingest:restart` — 데몬만 핫 재시작 |

### 0.3 환경변수

| 변수 | 현재값 | 설명 |
|---|---|---|
| `CAPTURE_BACKEND` | `ingest-daemon` | 캡처 백엔드 선택 (코드 폴백: `ffmpeg`) |
| `WEBRTC_ENGINE` | `mediasoup` | WebRTC 엔진 선택 (`mediamtx` = WHEP 전용 레거시) |
| `INGEST_DAEMON_BIN` | `../ingest-daemon/ingest_daemon.py` | 데몬 스크립트 경로 |
| `INGEST_DAEMON_ADDR` | `:7070` | 데몬 수신 주소 |
| `MEDIAMTX_BIN` | `mediamtx` | MediaMTX 바이너리 경로 (YouTube/RTMP 전용) |
| `MEDIAMTX_API_URL` | `http://localhost:9997` | MediaMTX 관리 API (YouTube/RTMP 전용) |

### 0.4 ingest-daemon 흐름 상세

```
startServer.js
  needsIngestDaemon = CAPTURE_BACKEND==='ingest-daemon' && mode!=='analysis'
     │
     └─► spawn ingest_daemon.py --addr :7070
            │ B-frame 카메라: decodes every packet, rate-limits by AI_FRAME_INTERVAL
            │
            └─► HTTP POST http://localhost:{nodePort}/api/ingest/frame/{camId}
                     │
                     └─► cameras.js route → ingestDaemonCapture.injectFrame(buf)
                                                    │
                                                    └─► emit('frame', jpegBuf)
                                                              │
                                                    pipelineManager frame handler
```

### 0.5 WebRTC 활성화 조건

```javascript
// pipelineManager.js (현재 구현)

// MediaMTX 등록 조건: mediamtx 엔진 또는 mediamtx 캡처 백엔드일 때만
const needsMediaMTX = !isYouTube && (
  (requestedWebRTC && WEBRTC_ENGINE === 'mediamtx')
  || CAPTURE_BACKEND === 'mediamtx'
  // mediasoup 모드는 포함하지 않음 — ingest-daemon이 카메라에 직접 연결
);

// captureUrl: mediamtxReady=false → 카메라 RTSP URL 직접 사용
const captureUrl = mediamtxReady
  ? `rtsp://127.0.0.1:${mediamtxRtspPort}/${camera.id}`
  : rtspUrl;  // mediasoup 모드에서는 항상 이 경로

// App RTP: 엔진 무관하게 항상 카메라 직접 URL (MediaMTX는 App RTP 미중계)
const daemonAppRtpRtspUrl = isYouTube ? null : rtspUrl;

const useWebRTC = requestedWebRTC && (WEBRTC_ENGINE === 'mediamtx' ? mediamtxReady : altWebRTCReady);
```

---

## 1. Legacy Architecture — FFmpeg RtpIngestion + mediasoup

> ⚠️ **이 섹션은 레거시 참조용입니다.** `WEBRTC_ENGINE=mediasoup` + `CAPTURE_BACKEND=ffmpeg` 환경에만 해당합니다.  
> 현재 기본 배포는 §0 (ingest-daemon + MediaMTX)를 따릅니다.

---

## 1. Current Architecture Design

### 1.1 전체 파이프라인 다이어그램

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         LTS-2026 Video Pipeline (현재)                   │
│                                                                          │
│  [IP Camera]──RTSP─►[pipelineManager.js]                                │
│                              │                                           │
│              ┌───────────────┴───────────────┐                          │
│              │ camera.webrtcEnabled?          │                          │
│              │                               │                          │
│           YES│                            NO │                          │
│              ▼                               ▼                          │
│   [RtpIngestion]                    [captureFactory]                    │
│   (항상 FFmpeg)                      CAPTURE_BACKEND                   │
│       │                              ffmpeg│ gstreamer│ pyav            │
│       │─ H264 RTP ──►[mediasoup]          │          │    │             │
│       │─ Opus RTP ──►[PlainTransport]     ▼          ▼    ▼             │
│       │─ JPEG ──────►[pipelineManager]  JPEG       JPEG  JPEG           │
│                              │                (nvdec/vaapi 가능)        │
│                              ▼                                          │
│                      [YOLOv8 Detection]                                 │
│                      [ByteTrack]                                        │
│                      [BehaviorEngine]                                   │
│                              │                                          │
│                      [Socket.IO 전송]                                   │
│                      frameData(JPEG+bbox)│newAlert│objectTracked        │
│                              │                                          │
│                      [React WebUI]                                      │
│                      <video> (WebRTC) │ <img> (Socket.IO)               │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 RtpIngestion 내부 구조

```
rtpIngestion.js
│
├── _setupMediasoup()
│   ├── webrtcGateway.getOrCreateRouter(cameraId)
│   ├── router.createPlainTransport({ listenIp:'127.0.0.1', comedia:true })  ← video
│   │   └── videoPort = transport.tuple.localPort
│   ├── videoTransport.produce({ kind:'video', H264, PT=96, SSRC=1111 })
│   ├── router.createPlainTransport({ listenIp:'127.0.0.1', comedia:true })  ← audio
│   │   └── audioPort = transport.tuple.localPort
│   └── audioTransport.produce({ kind:'audio', opus, PT=111, SSRC=2222 })
│
└── _buildArgs() → FFmpeg CLI 인수
    ├── Input: -rtsp_transport tcp -fflags +genpts+igndts
    │          -use_wallclock_as_timestamps 1
    │          -analyzeduration 1000000 -probesize 1000000
    │          -i {rtspUrl}
    ├── Output 1: -map 0:v:0 -c:v copy -payload_type 96 -ssrc 1111
    │             -f rtp rtp://127.0.0.1:{videoPort}
    ├── Output 2: -map 0:a? -af aresample=async=1:first_pts=0
    │             -c:a libopus -b:a 32k -vbr on -application voip
    │             -payload_type 111 -ssrc 2222
    │             -f rtp rtp://127.0.0.1:{audioPort}
    └── Output 3: -map 0:v:0 -vf fps={fps},scale={width}:-2
                  -f image2pipe -vcodec mjpeg -q:v 5 pipe:1
```

### 1.3 GStreamerCapture 현재 구현 (WebRTC OFF 전용)

```
gstreamerCapture.js
│
├── _detectHwDecoder()         ← 시작 시 1회 실행
│   gst-inspect-1.0 nvdec → nvdec
│   gst-inspect-1.0 vaapi → vaapi
│   else → software
│
└── _buildPipeline() → GStreamer 파이프라인 문자열
    ├── software: rtspsrc ! decodebin ! videorate ! videoscale
    │             ! videoconvert ! jpegenc ! fdsink
    ├── nvdec:    rtspsrc ! rtph264depay ! nvh264dec ! videorate
    │             ! videoscale ! videoconvert ! jpegenc ! fdsink
    └── vaapi:    rtspsrc ! decodebin(vaapidecodebin) ! videorate
                  ! videoscale ! vaapipostproc ! jpegenc ! fdsink

[fdsink] ──► stdout ──► Node.js SOI/EOI 파싱 ──► 'frame' 이벤트
```

### 1.4 mediasoup WebRTC 연결 흐름

```
Browser (mediasoup-client)
  │
  │ Socket.IO 'webrtc:connect' {cameraId}
  ▼
server/socket/webrtcSignaling.js
  │
  ├── webrtcGateway.createConsumerTransport()
  │   └── router.createWebRtcTransport({
  │         listenIps: [{ ip: SERVER_IP, announcedIp: SERVER_IP },
  │                     { ip: '0.0.0.0' }],
  │         enableUdp: true, enableTcp: true
  │       })
  │
  ├── Socket.IO 'webrtc:transport-params' → Browser
  │   { transportId, iceParameters, iceCandidates, dtlsParameters }
  │   (iceCandidates[0].ip = SERVER_IP ← 문제: 127.0.0.1이면 브라우저 연결 불가)
  │
  ├── Browser: transport.connect({ dtlsParameters })
  ├── Browser: transport.consume({ producerId_video, ... })
  └── Browser: <video>.srcObject = remoteStream
```

---

## 2. Phase 0 — ICE Fix Design

### 2.1 변경 범위

| 파일 | 변경 유형 | 내용 |
|---|---|---|
| `server/.env` | 설정값 변경 | `SERVER_IP` → LAN IP, `STUN_URLS` → 비우거나 교체 |
| `server/src/services/webrtcGateway.js` | 경고 추가 (선택) | 로그백 IP 감지 시 startup warning |

### 2.2 SERVER_IP 효과 분석

```
SERVER_IP=127.0.0.1 (현재)
  mediasoup WebRtcTransport listenIps:
    [{ ip: '127.0.0.1', announcedIp: '127.0.0.1' }]
  ICE candidates:
    host 127.0.0.1:40001 udp  ← 브라우저에서 도달 불가
  결과: 모든 연결이 TURN 릴레이 경유 → 불안정

SERVER_IP=192.168.1.100 (수정 후)
  mediasoup WebRtcTransport listenIps:
    [{ ip: '192.168.1.100', announcedIp: '192.168.1.100' }]
  ICE candidates:
    host 192.168.1.100:40001 udp  ← 브라우저에서 직접 도달 가능
  결과: 직접 연결(host candidate), TURN 불필요
```

### 2.3 STUN 서버 제거 효과

```
Google STUN 서버 (DNS 조회 실패 환경):
  stun:stun.l.google.com:19302  → 오류 701 → ICE gather 15 s 대기
  stun:stun1.l.google.com:19302 → 오류 701 → ICE gather 15 s 대기
  총 gather 시간: ~15 s

STUN_URLS="" (수정 후):
  host 후보만 수집 (loopback 제외, LAN 인터페이스)
  총 gather 시간: < 200 ms
```

---

## 3. Phase 1 — GStreamerRtpIngestion Design

### 3.1 신규 파일: gstreamerRtpIngestion.js

**위치**: `server/src/services/gstreamerRtpIngestion.js`

**클래스 구조**:

```javascript
'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const webrtcGateway = require('./webrtcGateway');

const PT_H264 = 96;
const PT_OPUS = 111;
const SSRC_VIDEO = 1111;
const SSRC_AUDIO = 2222;

class GStreamerRtpIngestion extends EventEmitter {
  constructor(cameraId, rtspUrl, opts = {}) { ... }
  async start() { ... }              // _setupMediasoup() 후 _spawn()
  stop() { ... }                     // kill + closeMediasoup
  async _setupMediasoup() { ... }    // rtpIngestion.js와 동일
  _buildPipeline() { ... }           // GStreamer 파이프라인 문자열 반환
  _spawn() { ... }                   // gst-launch-1.0 프로세스 시작
  _onData(chunk) { ... }             // stdout JPEG SOI/EOI 파싱
  async _restart() { ... }           // 지수 백오프 재시작
}

module.exports = GStreamerRtpIngestion;
```

### 3.2 GStreamer 파이프라인 설계

**기본 구조** (H264 카메라, nvdec):

```gst-launch
gst-launch-1.0 \
  rtspsrc location={rtspUrl} latency=200 protocols=tcp name=src \
  src. ! rtph264depay ! nvh264dec ! tee name=vt \
    vt. ! queue max-size-buffers=5 ! videorate ! video/x-raw,framerate={fps}/1 \
         ! videoscale ! video/x-raw,width={width} ! videoconvert \
         ! jpegenc quality=85 ! fdsink fd=1 \
    vt. ! queue max-size-buffers=30 ! videoconvert ! x264enc tune=zerolatency \
         ! rtph264pay config-interval=1 pt={PT_H264} ssrc={SSRC_VIDEO} \
         ! udpsink host=127.0.0.1 port={videoPort} \
  src. ! rtpopusdepay ! opusdec ! opusenc bitrate=32000 \
         ! rtpopuspay pt={PT_OPUS} ssrc={SSRC_AUDIO} \
         ! udpsink host=127.0.0.1 port={audioPort}
```

**중요 설계 결정**:

1. `tee` 엘리먼트로 단일 decode 스트림을 JPEG 경로와 RTP 경로로 분기 → FFmpeg 3-output과 동일한 효과
2. JPEG 경로: `videorate`로 fps 제한 → AI 추론 부하 제어
3. RTP 경로: `queue max-size-buffers=30` → 버퍼 언더런 방지
4. 오디오는 `src. !` 별도 브랜치 → H264-only 카메라에서 오디오 없어도 영상 정상 동작

**hw_decoder 선택 로직**:

```javascript
function _getHwDecoder(hwMode) {
  // hwMode: 'nvdec' | 'vaapi' | 'software' | 'auto'
  switch (hwMode) {
    case 'nvdec':     return 'rtph264depay ! nvh264dec';
    case 'vaapi':     return 'rtph264depay ! vaapidecodebin';
    case 'software':  return 'rtph264depay ! avdec_h264';
    case 'auto':
    default:          return detectedHwDecoder;  // _detectHwDecoder() 결과
  }
}
```

### 3.3 RTP 출력 H264 처리 주의사항

nvdec 디코딩 후 RTP 재인코딩 불가피:
- nvdec가 NV12 (YUV 4:2:0 planar) 픽셀 포맷 출력
- `rtph264pay`는 H264 비트스트림 필요 → `x264enc`로 재인코딩 필요
- `tune=zerolatency`: B-프레임 없음, 레이턴시 최소화
- FFmpeg RtpIngestion의 `-c:v copy`와 달리 GPU 디코딩 후 CPU 재인코딩 발생

**최적화 옵션** (nvenc 사용 시):
```gst-launch
nvh264dec ! nvh264enc rc-mode=cbr bitrate=4000 ! rtph264pay ...
```
→ GPU 디코딩 + GPU 인코딩으로 CPU 사용 최소화

### 3.4 pipelineManager.js 수정 설계

**수정 위치**: `server/src/services/pipelineManager.js`, 기존 line 185–195 범위

```javascript
// 추가 import (파일 상단)
const { CAPTURE_BACKEND } = require('./captureFactory');
// GStreamerRtpIngestion은 조건부 require (항상 로드하지 않음)

// startCamera() 내 변경
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

**조건부 require 이유**: GStreamer 미설치 환경에서 `require('./gstreamerRtpIngestion')`이 실패하지 않도록 런타임 로드.

### 3.5 GStreamer 미설치 폴백 설계

`gstreamerRtpIngestion.js` 내부:

```javascript
// 모듈 로드 시 GStreamer 확인
const GST_AVAILABLE = _gstAvailable();  // gstreamerCapture.js에서 공유 가능

function createGStreamerRtpIngestion(cameraId, rtspUrl, opts) {
  if (!GST_AVAILABLE) {
    console.warn('[GStreamerRtpIngestion] gst-launch-1.0 not found, falling back to FFmpeg RtpIngestion');
    const RtpIngestion = require('./rtpIngestion');
    return new RtpIngestion(cameraId, rtspUrl, opts);
  }
  return new GStreamerRtpIngestion(cameraId, rtspUrl, opts);
}

module.exports = GStreamerRtpIngestion;
module.exports.create = createGStreamerRtpIngestion;
```

`pipelineManager.js`에서 `require('./gstreamerRtpIngestion').create(...)` 사용.

---

## 4. Phase 2 — MediaMTX Direct WebRTC (구현 완료)

> ✅ **구현 완료** — `WEBRTC_ENGINE=mediamtx` 설정 시 활성화.  
> 설계 당시 `WEBRTC_MODE` 변수명을 사용했으나 실제 구현은 `WEBRTC_ENGINE`으로 명명됨.  
> 경로 등록은 설계의 `webrtcGateway.js` 확장이 아닌 `mediamtxManager.js` 별도 서비스로 구현됨.

### 4.1 구현 아키텍처

```
┌─────────────────────────────────────────────────────────────────────────┐
│                 LTS-2026 Pipeline (Phase 2 — MediaMTX mode)              │
│                                                                          │
│  [IP Camera]──RTSP──►[MediaMTX]                                         │
│                           │                                             │
│                   ┌───────┴────────┐                                    │
│                   │                │                                    │
│             WebRTC out         RTSP re-stream                           │
│             :8889/{camId}       localhost:8554/{camId}                  │
│                   │                │                                    │
│                   │         [captureFactory]                            │
│                   │         ffmpeg│gstreamer│pyav                       │
│                   │                │                                    │
│                   │         [JPEG frames → AI pipeline]                 │
│                   │         YOLOv8 → ByteTrack → BehaviorEngine         │
│                   │                │                                    │
│                   ▼         [Socket.IO]                                 │
│             [Browser]       frameData│newAlert                          │
│             <video src="http://server:8889/{camId}">                    │
│             (Pion WebRTC, MediaMTX ICE)                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 webrtcGateway.js 신규 모드

```javascript
// server/src/services/webrtcGateway.js

const WEBRTC_MODE = (process.env.WEBRTC_MODE || 'mediasoup').toLowerCase();
const MEDIAMTX_API_URL = process.env.MEDIAMTX_API_URL || 'http://localhost:9997';
const MEDIAMTX_WEBRTC_URL = process.env.MEDIAMTX_WEBRTC_URL || '';

// MediaMTX 모드에서 추가되는 메서드들:

async function registerMediaMTXPath(cameraId, rtspUrl) {
  const res = await fetch(`${MEDIAMTX_API_URL}/v3/config/paths/add/${cameraId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: rtspUrl }),
  });
  if (!res.ok) throw new Error(`MediaMTX path registration failed: ${res.status}`);
}

async function removeMediaMTXPath(cameraId) {
  await fetch(`${MEDIAMTX_API_URL}/v3/config/paths/remove/${cameraId}`, {
    method: 'DELETE',
  }).catch(() => {});  // 카메라 중지 시 best-effort
}

function getMediaMTXWebRTCUrl(cameraId) {
  const base = MEDIAMTX_WEBRTC_URL || `http://${process.env.SERVER_IP || 'localhost'}:8889`;
  return `${base}/${cameraId}`;
}

module.exports.WEBRTC_MODE = WEBRTC_MODE;
module.exports.registerMediaMTXPath = registerMediaMTXPath;
module.exports.removeMediaMTXPath = removeMediaMTXPath;
module.exports.getMediaMTXWebRTCUrl = getMediaMTXWebRTCUrl;
```

### 4.3 pipelineManager.js MediaMTX 경로 설계

```javascript
// startCamera() — WEBRTC_MODE=mediamtx 분기
if (WEBRTC_MODE === 'mediamtx' && camera.webrtcEnabled) {
  // 1. MediaMTX에 카메라 경로 등록 (원본 RTSP)
  await webrtcGateway.registerMediaMTXPath(camera.id, rtspUrl);

  // 2. AI 파이프라인은 MediaMTX RTSP 재스트림 소비
  const mediamtxRtspUrl = `rtsp://localhost:8554/${camera.id}`;
  capture = createCapture(camera.id, mediamtxRtspUrl, { fps: captureFps, width: 640 });

  // 3. RtpIngestion 사용 안 함 — mediasoup 불필요
} else if (useWebRTC && CAPTURE_BACKEND === 'gstreamer') {
  // Phase 1 경로
  ...
}

// stopCamera() — MediaMTX 경로 제거
if (WEBRTC_MODE === 'mediamtx') {
  await webrtcGateway.removeMediaMTXPath(cameraId).catch(() => {});
}
```

### 4.4 클라이언트 MediaMTX WebRTC 연결 설계

**파일**: `client/src/hooks/useWebRTC.ts`

```typescript
// MediaMTX 모드 감지 (서버에서 제공)
const webrtcMode = camera.webrtcMode || 'mediasoup';  // 카메라 API 응답에 포함

if (webrtcMode === 'mediamtx' && camera.mediamtxWebrtcUrl) {
  // MediaMTX 내장 WebRTC 클라이언트 사용
  const videoElement = document.getElementById(`video-${cameraId}`);
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch(`${camera.mediamtxWebrtcUrl}/whep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offer.sdp,
  });
  const answerSdp = await res.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  pc.ontrack = (e) => { videoElement.srcObject = e.streams[0]; };
} else {
  // 기존 mediasoup-client 경로 (현재 구현 유지)
}
```

MediaMTX는 WHEP (WebRTC-HTTP Egress Protocol)을 지원하므로 별도 SDP 협상 라이브러리 불필요.

### 4.5 mediamtx.yml 변경 설계

```yaml
# 현재 (내부 전용)
webrtcAddress: 127.0.0.1:8889

# 변경 (외부 접근 허용)
webrtcAddress: :8889

# API 활성화 (경로 관리용)
apiAddress: :9997
api: yes
```

---

## 5. File Structure Summary (현행)

### 5.1 현재 파일 구조 (ingest-daemon + MediaMTX 기본)

```
server/src/services/
├── captureFactory.js           ← CAPTURE_BACKEND별 캡처 인스턴스 팩토리
├── ingestDaemonCapture.js      ← ingest-daemon 수신 EventEmitter (현재 기본)
├── rtspCapture.js              ← FFmpeg JPEG 백엔드 (레거시)
├── gstreamerCapture.js         ← GStreamer JPEG 백엔드 (nvdec/vaapi)
├── pyavCapture.js              ← Python PyAV JPEG 백엔드
├── mediamtxSnapshotCapture.js  ← MediaMTX JPEG 스냅샷 캡처
├── mediamtxManager.js          ← MediaMTX API 경로 등록/해제
└── pipelineManager.js          ← 오케스트레이터

server/src/scripts/
└── restartIngestDaemon.js      ← npm run ingest:restart 핫 재시작

ingest-daemon/
└── ingest_daemon.py            ← Python PyAV 독립 캡처 데몬 (:7070)
```

> **레거시 파일 (미사용 시 참조만)**: `rtpIngestion.js`, `webrtcGateway.js` (mediasoup WebRTC 경로)

### 5.2 Phase 2 구현 결과 (설계와의 차이점)

| 설계 (Phase 2) | 실제 구현 |
|---|---|
| `WEBRTC_MODE=mediamtx` 환경변수 | `WEBRTC_ENGINE=mediamtx` 환경변수 |
| `webrtcGateway.js`에 `registerMediaMTXPath()` 추가 | 별도 `mediamtxManager.js` 서비스 |
| `captureFactory.js` RTSP 재스트림 사용 | `ingestDaemonCapture.js` + ingest-daemon이 MediaMTX loopback RTSP 소비 |

---

## 6. Sequence Diagrams

### 6.1 현재 — WebRTC ON (FFmpeg RtpIngestion)

```
Camera    FFmpeg(RtpIngestion)    mediasoup    Browser
  │               │                  │           │
  │←─RTSP connect─│                  │           │
  │─video/audio──►│                  │           │
  │               │─H264 RTP─────────►│           │
  │               │─Opus RTP─────────►│           │
  │               │─JPEG──────────────────────────►[pipelineManager AI]
  │               │                  │           │
  │               │                  │◄──Socket.IO 'webrtc:connect'──│
  │               │                  │──WebRtcTransport params───────►│
  │               │                  │──DTLS handshake───────────────►│
  │               │                  │──SRTP video───────────────────►│
  │               │                  │──SRTP audio───────────────────►│
```

### 6.2 Phase 1 — GStreamer RtpIngestion

```
Camera    GStreamer(RtpIngestion)    mediasoup    Browser
  │               │                    │           │
  │←─RTSP connect─│                    │           │
  │─video/audio──►│                    │           │
  │               │─(nvdec decode)─►tee│           │
  │               │   tee─H264 RTP─────►│           │
  │               │   tee─JPEG─────────────────────►[pipelineManager AI]
  │               │─Opus RTP───────────►│           │
  │               │                    │           │
  │               │                    │◄──Socket.IO 'webrtc:connect'──│
  │               │                    │──WebRtcTransport params───────►│
  │               │                    │──SRTP video───────────────────►│
```

### 6.3 Phase 2 — MediaMTX Direct WebRTC

```
Camera    MediaMTX    captureFactory(AI)    Browser
  │           │               │               │
  │─RTSP─────►│               │               │
  │           │─RTSP restream─►│               │
  │           │               │─JPEG──────────►[pipelineManager AI]
  │           │               │               │
  │           │◄──── WHEP POST (offer SDP) ───│
  │           │──── 200 OK (answer SDP) ──────►│
  │           │──── ICE candidates ───────────►│
  │           │──── DTLS + SRTP ──────────────►│
  │           │                               │
  │           │ (Pion WebRTC, 별도 ICE 설정)   │
```

---

## 7. Configuration Decision Tree (현행)

```
서버 시작
    │
    ├─ WEBRTC_ENGINE=mediamtx ? (현재 기본값)
    │   YES → Phase 2/3 경로
    │          mediamtxManager.js로 MediaMTX RTSP 경로 등록
    │          CAPTURE_BACKEND=ingest-daemon → ingest_daemon.py 기동
    │          ingest-daemon이 MediaMTX loopback RTSP(:8554) 소비 → JPEG → Node
    │          Browser: WHEP at :8889/{camId}/whep
    │
    └─ WEBRTC_ENGINE=mediasoup (레거시)
        │
        ├─ camera.webrtcEnabled=true ?
        │   │
        │   ├─ CAPTURE_BACKEND=gstreamer ?
        │   │   YES → Phase 1: GStreamerRtpIngestion
        │   │
        │   └─ CAPTURE_BACKEND=ffmpeg|pyav|기타
        │       → 레거시 경로: RtpIngestion (FFmpeg)
        │
        └─ camera.webrtcEnabled=false
            → CAPTURE_BACKEND 선택
              ingest-daemon → ingestDaemonCapture
              ffmpeg → rtspCapture (레거시)
              gstreamer → gstreamerCapture
              pyav → pyavCapture
```

---

## 8. Migration Guide

### 8.1 Phase 0 적용 (즉시, 서버 재시작 1회)

```bash
# 1. LAN IP 확인
hostname -I | awk '{print $1}'
# 예: 192.168.1.100

# 2. server/.env 수정
sed -i 's/SERVER_IP=127.0.0.1/SERVER_IP=192.168.1.100/' server/.env
sed -i 's/STUN_URLS=.*/STUN_URLS=/' server/.env

# 3. 서버 재시작
cd server && npm restart

# 4. ICE 테스트 (브라우저 Settings → ICE Connectivity Test)
# Phase 1 Summary: gather < 3 s 확인
# Phase 2: Server ICE candidates IP = 192.168.1.100 확인
```

### 8.2 Phase 1 적용

```bash
# 1. GStreamer 설치 (Ubuntu/Debian)
sudo apt update
sudo apt install -y gstreamer1.0-tools gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav

# NVIDIA nvdec 추가 (NVIDIA GPU 환경)
sudo apt install -y gstreamer1.0-plugins-bad   # nvh264dec 포함

# Intel/AMD vaapi 추가
sudo apt install -y gstreamer1.0-vaapi

# 2. gstreamerRtpIngestion.js 배포
cp server/src/services/gstreamerRtpIngestion.js <배포 경로>

# 3. server/.env 변경
CAPTURE_BACKEND=gstreamer
GSTREAMER_HW_ACCEL=auto

# 4. 서버 재시작 후 로그 확인
# [GStreamerRtpIngestion] GStreamer available — hw decoder: nvdec
# [GStreamerRtpIngestion][cam-01] PlainTransports ready — video:XXXXX audio:XXXXX
```

### 8.3 Phase 1 롤백

```bash
# server/.env
CAPTURE_BACKEND=ffmpeg     # RtpIngestion(FFmpeg)으로 즉시 복귀
```

### 8.4 Phase 2 적용

```bash
# 1. mediamtx.yml 수정
# webrtcAddress: 127.0.0.1:8889 → :8889
# apiAddress: :9997 추가

# 2. server/.env 변경 (설계 변수명과 실제 구현 변수명 차이에 주의)
WEBRTC_ENGINE=mediamtx          # 실제 구현 변수명 (설계서의 WEBRTC_MODE와 다름)
MEDIAMTX_API_URL=http://localhost:9997
SERVER_IP=192.168.1.100

# 3. MediaMTX 재시작
mediamtx mediamtx.yml

# 4. 서버 재시작
cd server && npm restart

# 5. 브라우저에서 카메라 연결 확인
# <video> 재생 → HTTP log: POST http://192.168.1.100:8889/{camId}/whep
```

### 8.5 ingest-daemon 마이그레이션 (ffmpeg → ingest-daemon)

```bash
# 1. Python 의존성 설치
pip install av httpx

# 2. server/.env 변경
CAPTURE_BACKEND=ingest-daemon
WEBRTC_ENGINE=mediamtx
INGEST_DAEMON_BIN=../ingest-daemon/ingest_daemon.py
INGEST_DAEMON_ADDR=:7070

# 3. 서버 재시작 (startServer.js가 ingest_daemon.py 자동 기동)
cd server && npm run dev

# 4. 데몬 헬스체크 확인
curl http://localhost:7070/health
# {"status":"ok","cameras":["cam-01","cam-02",...]}

# 5. 데몬만 핫 재시작 (서버 재시작 불필요)
npm run ingest:restart
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-05 | 초기 작성 — 레거시 FFmpeg+mediasoup 아키텍처 + Phase 0/1/2 설계 |
| 2.0 | 2026-06-11 | §0 현재 구현 아키텍처(ingest-daemon+MediaMTX) 추가; Phase 2 구현 완료 표기; §5/§7 현행화; §8.5 ingest-daemon 마이그레이션 추가 |
