# SRS — Video Capture Pipeline Architecture
**Document ID**: SRS-LTS-VCP-01  
**Version**: 1.0  
**Date**: 2026-06-05  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Active  
**Parent PRD**: [prd/PRD_Video_Capture_Pipeline.md](../prd/PRD_Video_Capture_Pipeline.md)

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-06-05 | Initial specification — covers Phase 0, 1, 2 |

---

## Table of Contents

1. [Scope](#1-scope)
2. [Current System Behavior Specification](#2-current-system-behavior-specification)
3. [Functional Requirements — Phase 0 (ICE Fix)](#3-functional-requirements--phase-0-ice-fix)
4. [Functional Requirements — Phase 1 (GStreamer WebRTC)](#4-functional-requirements--phase-1-gstreamer-webrtc)
5. [Functional Requirements — Phase 2 (MediaMTX Direct)](#5-functional-requirements--phase-2-mediamtx-direct)
6. [Interface Contracts](#6-interface-contracts)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [Error Handling Requirements](#8-error-handling-requirements)
9. [Configuration Reference](#9-configuration-reference)

---

## 1. Scope

본 SRS는 `server/src/services/` 내 영상 수집 파이프라인의 현재 동작을 명세하고, Phase 0–2 개선 사항의 기능 요구사항을 정의한다.

**범위 내**:
- `captureFactory.js`, `rtspCapture.js`, `gstreamerCapture.js`, `pyavCapture.js`
- `rtpIngestion.js` (현재 FFmpeg RTP+JPEG)
- `pipelineManager.js` 내 capture 백엔드 선택 로직
- `webrtcGateway.js` ICE/전송 설정
- `mediamtx.yml` WebRTC 바인딩
- `server/.env` ICE 관련 설정

**범위 외**:
- AI 추론 로직 (`detection.js`, `tracking.js`, `behaviorEngine.js`)
- 알림/구역 관리
- 인증/사용자 관리

---

## 2. Current System Behavior Specification

### FR-VCP-CUR-001: captureFactory 백엔드 선택

`server/src/services/captureFactory.js`의 `createCapture()` 함수는 환경변수 `CAPTURE_BACKEND`에 따라 백엔드를 선택한다.

| CAPTURE_BACKEND 값 | 반환 클래스 | 소스 파일 |
|---|---|---|
| `ffmpeg` (기본값 또는 미설정) | `RTSPCapture` | `rtspCapture.js` |
| `gstreamer` | `GStreamerCapture` | `gstreamerCapture.js` |
| `pyav` | `PyAVCapture` | `pyavCapture.js` |
| 기타 알 수 없는 값 | `RTSPCapture` (폴백, 경고 출력) | `rtspCapture.js` |

### FR-VCP-CUR-002: WebRTC 모드에서 captureFactory 무시

`pipelineManager.js:185`에서 `camera.webrtcEnabled && webrtcGateway.enabled`가 `true`이면 `createCapture()`를 호출하지 않고 `RtpIngestion`(FFmpeg)을 항상 사용한다. `CAPTURE_BACKEND` 환경변수는 무시된다.

### FR-VCP-CUR-003: RtpIngestion FFmpeg 3-출력 구조

`RtpIngestion._buildArgs()`는 다음 3개 출력을 가진 FFmpeg 명령어를 구성한다:
1. `-map 0:v:0 -c:v copy -f rtp rtp://127.0.0.1:{videoPort}` — H264 RTP
2. `-map 0:a? -c:a libopus -f rtp rtp://127.0.0.1:{audioPort}` — Opus RTP (오디오 없을 시 조용히 생략)
3. `-map 0:v:0 -vf fps={fps},scale={width}:-2 -f image2pipe -vcodec mjpeg pipe:1` — JPEG stdout

### FR-VCP-CUR-004: mediasoup PlainTransport comedia 모드

`RtpIngestion._setupMediasoup()`은 `comedia=true`로 PlainTransport를 생성한다. mediasoup은 FFmpeg가 보내는 첫 번째 RTP 패킷을 수신한 후 원격 주소(127.0.0.1:{FFmpeg 임시 포트})를 자동 학습한다.

### FR-VCP-CUR-005: GStreamer 하드웨어 자동 감지

`gstreamerCapture.js` 시작 시 `gst-inspect-1.0 nvdec`, `gst-inspect-1.0 vaapi` 순서로 플러그인 존재 여부를 확인한다. 첫 번째로 발견되는 플러그인을 `HW_DECODER` 변수에 설정하며, 모두 없으면 `software`로 설정한다.

`GSTREAMER_HW_ACCEL` 환경변수:
- `auto` (기본): nvdec → vaapi → software 순 자동 감지
- `nvdec`: NVIDIA nvdec 강제 사용
- `vaapi`: Intel/AMD vaapi 강제 사용
- `software`: 소프트웨어 디코딩 강제

### FR-VCP-CUR-006: PyAV Python 사이드카

`pyavCapture.js`는 Python 인터프리터를 서브프로세스로 실행하여 `pyav_capture.py` 스크립트를 구동한다. Python 프로세스는 JPEG 스트림을 stdout에 출력하며 Node.js가 SOI/EOI 마커로 파싱한다.

---

## 3. Functional Requirements — Phase 0 (ICE Fix)

### FR-VCP-001: SERVER_IP 검증 경고

**조건**: `server/.env`의 `SERVER_IP` 값이 `127.0.0.1` 또는 `::1`인 경우  
**동작**: 서버 시작 시 console.warn으로 경고 메시지 출력

```
[WebRTC] WARNING: SERVER_IP is set to loopback (127.0.0.1). Browsers cannot connect
directly — all WebRTC traffic will be relayed through TURN. Set SERVER_IP to the
server's LAN IP to enable direct connections.
```

**검증**: 단위 테스트 TC-VCP-A-001

### FR-VCP-002: STUN 서버 미설정 허용

**조건**: `STUN_URLS`가 빈 문자열이거나 설정되지 않은 경우  
**동작**: mediasoup WebRtcTransport 생성 시 STUN 서버 없이 host 후보만 사용. 오류 없이 정상 동작.

```javascript
// 현재: iceServers에 STUN 추가
// 변경 후: STUN_URLS 비어있으면 iceServers=[] 허용
const iceServers = stunUrls.length > 0 ? [...] : [];
```

**검증**: TC-VCP-A-002

### FR-VCP-003: ICE 수집 성능 지표

**조건**: `SERVER_IP`가 실제 LAN IP이고 `STUN_URLS`가 비어있거나 도달 가능한 서버만 포함  
**동작**: ICE 수집 완료(`icegatheringstate=complete`) 시간 < 3 s

**검증**: ICE Test UI의 Phase 1 gather 시간 로그, TC-VCP-A-003

---

## 4. Functional Requirements — Phase 1 (GStreamer WebRTC)

### FR-VCP-010: GStreamerRtpIngestion 클래스

신규 클래스 `GStreamerRtpIngestion` (`server/src/services/gstreamerRtpIngestion.js`)은 다음 인터페이스를 구현해야 한다:

**생성자**: `new GStreamerRtpIngestion(cameraId, rtspUrl, opts)`
- `opts.fps`: 프레임 속도 (기본 10)
- `opts.width`: JPEG 너비 (기본 640)

**메서드**:
- `async start()`: mediasoup PlainTransport 설정 후 GStreamer 프로세스 시작
- `stop()`: GStreamer 프로세스 종료, mediasoup 정리

**이벤트** (EventEmitter):
- `frame` (Buffer): JPEG 프레임 — `pipelineManager.js`가 구독
- `started` ({cameraId, cmdline}): GStreamer 파이프라인 시작됨
- `warn` ({cameraId, message}): 비치명적 경고
- `reconnecting` ({cameraId}): 자동 재연결 시도 중
- `error` (Error): 치명적 오류

**동작 요구사항**:

FR-VCP-011: GStreamer 파이프라인은 tee 엘리먼트를 사용하여 단일 디코딩 스트림을 두 경로로 분기한다:
- 경로 A: JPEG 인코딩 → fdsink (stdout) → `frame` 이벤트
- 경로 B: H264 RTP 패킷화 → UDP (mediasoup PlainTransport 포트)

FR-VCP-012: 오디오 처리:
- RTSP 스트림에 오디오 트랙이 있으면: Opus RTP → UDP (mediasoup audio PlainTransport)
- 오디오 없으면: 오류 없이 오디오 경로 생략

FR-VCP-013: 하드웨어 가속 적용:
- `GSTREAMER_HW_ACCEL=nvdec`: `rtph264depay ! nvh264dec` 디코더 사용
- `GSTREAMER_HW_ACCEL=vaapi`: `vaapidecodebin` 사용
- `GSTREAMER_HW_ACCEL=software`: `avdec_h264` 또는 `decodebin` 사용
- `GSTREAMER_HW_ACCEL=auto`: FR-VCP-CUR-005 자동 감지 결과 사용

FR-VCP-014: GStreamer 미설치 폴백:
- `gst-launch-1.0` 바이너리가 없으면 `console.warn` 출력 후 내부적으로 `RtpIngestion`(FFmpeg) 인스턴스를 반환하는 폴백 수행

FR-VCP-015: 자동 재연결:
- GStreamer 프로세스가 종료되면 지수 백오프(1 s, 2 s, 4 s, … 최대 30 s)로 재시작
- 재연결 시도 중 `reconnecting` 이벤트 발생

### FR-VCP-020: pipelineManager WebRTC 분기 확장

**현재** (`pipelineManager.js:185–195`):
```javascript
if (useWebRTC) {
  capture = new RtpIngestion(...);
} else {
  capture = createCapture(...);
}
```

**변경 후**:
```javascript
if (useWebRTC && CAPTURE_BACKEND === 'gstreamer') {
  capture = new GStreamerRtpIngestion(cameraId, rtspUrl, opts);
  await capture.start();
} else if (useWebRTC) {
  capture = new RtpIngestion(cameraId, rtspUrl, opts);
  await capture.start();
} else {
  capture = createCapture(cameraId, rtspUrl, opts);
}
```

FR-VCP-021: `CAPTURE_BACKEND=ffmpeg`(기본값)인 경우 기존 `RtpIngestion` 동작 그대로 유지. 기능 변경 없음.

FR-VCP-022: `CAPTURE_BACKEND=gstreamer`이지만 WebRTC OFF(`camera.webrtcEnabled=false`)이면 기존 `GStreamerCapture`(JPEG만) 사용. 변경 없음.

---

## 5. Functional Requirements — Phase 2 (MediaMTX Direct)

### FR-VCP-030: WEBRTC_MODE 환경변수

신규 환경변수 `WEBRTC_MODE` 도입:
- `mediasoup` (기본값, 미설정 시): 현재 동작 그대로
- `mediamtx`: MediaMTX WebRTC 직접 경로 활성화

### FR-VCP-031: MediaMTX 카메라 경로 등록

`WEBRTC_MODE=mediamtx` 시 카메라 시작 시:
1. MediaMTX REST API (`POST /v3/config/paths/add/{cameraId}`) 로 RTSP 소스 등록
2. MediaMTX가 RTSP → WebRTC 변환 처리

```javascript
// webrtcGateway.js 신규 메서드
async registerMediaMTXPath(cameraId, rtspUrl) {
  await fetch(`${MEDIAMTX_API_URL}/v3/config/paths/add/${cameraId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: rtspUrl }),
  });
}
```

### FR-VCP-032: MediaMTX WebRTC URL 제공

카메라 상태 API(`GET /api/cameras`)의 응답에 `mediamtxWebrtcUrl` 필드 추가:
```json
{
  "id": "cam-01",
  "mediamtxWebrtcUrl": "http://192.168.1.100:8889/cam-01"
}
```

클라이언트는 `WEBRTC_MODE=mediamtx` 시 해당 URL로 WebRTC 연결.

### FR-VCP-033: AI 파이프라인 MediaMTX RTSP 재스트림 소비

`WEBRTC_MODE=mediamtx` 시 AI 추론 경로:
- 원본 RTSP URL 대신 `rtsp://localhost:8554/{cameraId}` (MediaMTX 재스트림) 소비
- `captureFactory.js`를 통한 기존 방식 유지 (ffmpeg/gstreamer/pyav 선택 가능)
- `RtpIngestion` 사용 안 함 (mediasoup PlainTransport 불필요)

### FR-VCP-034: mediasoup 선택적 비활성화

`WEBRTC_MODE=mediamtx` 시 `webrtcGateway.js`에서 mediasoup Worker 생성을 건너뛸 수 있도록 옵션 제공. 기존 mediasoup 코드는 제거하지 않고 조건부로 비활성화.

---

## 6. Interface Contracts

### 6.1 Capture 백엔드 공통 인터페이스

모든 캡처 백엔드 클래스 (`RTSPCapture`, `GStreamerCapture`, `PyAVCapture`, `RtpIngestion`, `GStreamerRtpIngestion`)는 동일한 EventEmitter 인터페이스를 구현해야 한다:

```typescript
interface CaptureBackend extends EventEmitter {
  // 생성자
  constructor(cameraId: string, rtspUrl: string, opts?: { fps?: number; width?: number }): void;

  // 메서드
  start(): void | Promise<void>;  // RtpIngestion 계열은 async
  stop(): void;

  // 이벤트
  on('frame', (jpegBuffer: Buffer) => void): this;
  on('started', (info: { cameraId: string; cmdline: string }) => void): this;
  on('warn', (info: { cameraId: string; message: string }) => void): this;
  on('reconnecting', (info: { cameraId: string }) => void): this;
  on('error', (err: Error) => void): this;
}
```

### 6.2 mediasoup PlainTransport 설정 (공통)

RTP Ingestion 계열의 mediasoup 설정은 통일한다:

```javascript
{
  listenIp: { ip: '127.0.0.1' },
  rtcpMux:  false,
  comedia:  true,   // FFmpeg/GStreamer 첫 패킷으로 원격 주소 학습
}
```

**Codec 파라미터**:
- 비디오: `mimeType: 'video/H264'`, `payloadType: 96`, `ssrc: 1111`
- 오디오: `mimeType: 'audio/opus'`, `payloadType: 111`, `ssrc: 2222`

### 6.3 환경변수 인터페이스

| 변수 | 기본값 | Phase | 설명 |
|---|---|---|---|
| `CAPTURE_BACKEND` | `ffmpeg` | 0 (현재) | capture 백엔드 선택 |
| `GSTREAMER_HW_ACCEL` | `auto` | 1 | GStreamer 하드웨어 가속 모드 |
| `SERVER_IP` | `127.0.0.1` | 0 | mediasoup ICE 후보 IP |
| `STUN_URLS` | *(empty)* | 0 | STUN 서버 목록 |
| `WEBRTC_MODE` | `mediasoup` | 2 | WebRTC 백엔드 선택 |
| `MEDIAMTX_API_URL` | `http://localhost:9997` | 2 | MediaMTX REST API URL |
| `MEDIAMTX_WEBRTC_URL` | *(empty)* | 2 | 브라우저용 MediaMTX WebRTC 기본 URL |

---

## 7. Non-Functional Requirements

| ID | 요구사항 | 측정 기준 | 대상 Phase |
|---|---|---|---|
| NFR-VCP-001 | ICE 수집 완료 시간 < 3 s (정상 환경) | ICE Test UI gather timestamp 차이 | Phase 0 |
| NFR-VCP-002 | WebRTC 연결 성공률 ≥ 95% (7일 연속) | 연결 실패 로그 카운트 | Phase 0 |
| NFR-VCP-003 | nvdec 환경에서 1080p 카메라 1대당 CPU ≤ 10% | `htop` / `pidstat` | Phase 1 |
| NFR-VCP-004 | GStreamer 미설치 환경에서 자동 FFmpeg 폴백 (오류 없음) | `gst-launch-1.0` 없는 환경 테스트 | Phase 1 |
| NFR-VCP-005 | `CAPTURE_BACKEND` 변경 후 다음 카메라 시작 시 즉시 반영 (서버 재시작 없이) | 런타임 카메라 추가 테스트 | Phase 1 |
| NFR-VCP-006 | Phase 2 활성화 시 AI 감지 결과 누락 없음 | 감지 이벤트 수 비교 (MediaMTX 모드 vs mediasoup 모드) | Phase 2 |
| NFR-VCP-007 | 카메라→브라우저 레이턴시 ≤ 500 ms (LAN 환경) | WebRTC `currentRoundTripTime` + `jitterBufferDelay` | Phase 1/2 |
| NFR-VCP-008 | RtpIngestion 재시작 시 AI 추론 중단 < 5 s | 재연결 로그 타임스탬프 | Phase 0 이후 |
| NFR-VCP-009 | 동시 카메라 20대 처리 (Phase 1, nvdec 환경, 8코어 서버) | CPU ≤ 70%, 메모리 ≤ 8 GB | Phase 1 |

---

## 8. Error Handling Requirements

### FR-VCP-ERR-001: GStreamer 프로세스 비정상 종료

**시나리오**: GStreamer 프로세스가 코드 1로 종료  
**요구사항**: `reconnecting` 이벤트 발생 후 1 s 뒤 재시작. 최대 10회 재시도 후 `error` 이벤트 발생.

### FR-VCP-ERR-002: mediasoup PlainTransport 할당 실패

**시나리오**: mediasoup Worker 포트 소진 또는 Worker 종료  
**요구사항**: `error` 이벤트 발생, `pipelineManager.js`가 해당 카메라 파이프라인을 `error` 상태로 마킹. 다른 카메라 파이프라인에 영향 없음.

### FR-VCP-ERR-003: nvdec 디코딩 오류

**시나리오**: nvdec 플러그인이 특정 H264 프로파일 디코딩 실패  
**요구사항**: `warn` 이벤트 발생, GStreamer 파이프라인을 software 디코더로 재시작.

### FR-VCP-ERR-004: MediaMTX API 응답 없음

**시나리오**: `WEBRTC_MODE=mediamtx` 상태에서 MediaMTX REST API 요청 실패  
**요구사항**: 오류 로그 출력 후 `WEBRTC_MODE=mediasoup` 폴백 또는 해당 카메라를 오류 상태로 마킹. 서버 전체 중단 없음.

### FR-VCP-ERR-005: RTSP 연결 실패 재시도

**시나리오**: 카메라 RTSP URL 접근 불가 (네트워크 단절, 카메라 재시작)  
**요구사항**: 모든 백엔드(FFmpeg, GStreamer, PyAV)에서 동일하게 지수 백오프 재연결 수행. 최대 지연 30 s.

---

## 9. Configuration Reference

### 9.1 Phase 0 설정

```bash
# server/.env
# ── WebRTC ICE ──────────────────────────────────────────
# 서버 실제 LAN IP (127.0.0.1 대신)
SERVER_IP=192.168.1.100

# 빈 값: host 후보만 사용 (STUN 없음) — 자체 네트워크에서 권장
# 또는 자체 coturn STUN 서버 URL 입력
STUN_URLS=

# TURN 서버 (외부망 클라이언트 접근 시 필요)
TURN_URL=turn:192.168.1.100:3478
TURN_USERNAME=lts
TURN_CREDENTIAL=password
```

### 9.2 Phase 1 설정

```bash
# server/.env
# ── RTSP Capture Backend ─────────────────────────────────
CAPTURE_BACKEND=gstreamer

# GStreamer 하드웨어 가속
# auto: nvdec → vaapi → software 순 자동 탐색
# nvdec: NVIDIA GPU 강제
# vaapi: Intel/AMD GPU 강제
# software: CPU 소프트웨어만
GSTREAMER_HW_ACCEL=auto
```

### 9.3 Phase 2 설정

```bash
# server/.env
# ── MediaMTX WebRTC 모드 ────────────────────────────────
WEBRTC_MODE=mediamtx
MEDIAMTX_API_URL=http://localhost:9997
MEDIAMTX_WEBRTC_URL=http://192.168.1.100:8889
```

```yaml
# mediamtx.yml
webrtcAddress: :8889     # 0.0.0.0 바인딩 (외부 접근 허용)
apiAddress: :9997        # REST API 활성화
```

### 9.4 전체 설정 우선순위

```
WEBRTC_MODE=mediamtx
  → Phase 2 경로: MediaMTX WebRTC + captureFactory(AI 경로)

WEBRTC_MODE=mediasoup (기본값), camera.webrtcEnabled=true, CAPTURE_BACKEND=gstreamer
  → Phase 1 경로: GStreamerRtpIngestion + mediasoup

WEBRTC_MODE=mediasoup (기본값), camera.webrtcEnabled=true, CAPTURE_BACKEND=ffmpeg (기본값)
  → 현재 경로: RtpIngestion(FFmpeg) + mediasoup

camera.webrtcEnabled=false, CAPTURE_BACKEND=gstreamer
  → 현재 GStreamer JPEG 경로 (변경 없음)

camera.webrtcEnabled=false, CAPTURE_BACKEND=ffmpeg (기본값)
  → 현재 FFmpeg JPEG 경로 (변경 없음)
```
