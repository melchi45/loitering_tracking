---
name: camera-stream-setup
description: "LTS-2026 카메라 스트림 설정 및 관리. Use when: RTSP 카메라 추가/연결, ONVIF 카메라 자동 탐색, YouTube/RTMP 스트림 RTSP 변환 ingestion, WebRTC 미디어 게이트웨이 설정, MediaMTX 프록시 설정, ICE/STUN/TURN 연결 문제 해결, 카메라 스트림 끊김 디버깅, 새 카메라 소스 지원 추가, CAPTURE_BACKEND 전환(ffmpeg/gstreamer/pyav), GStreamer 하드웨어 가속 설정(nvdec/vaapi), PyAV Python 사이드카 설정. Covers: captureFactory.js, rtspCapture.js, gstreamerCapture.js, pyavCapture.js, pyav_capture.py, rtpIngestion.js, webrtcGateway.js, discoveryService.js, onvifDiscovery.js, youtubeStreamService.js, mediamtx.yml."
argument-hint: "카메라 소스 유형 (RTSP / ONVIF / YouTube / WebRTC) 또는 백엔드 (ffmpeg / gstreamer / pyav)"
---

# Camera Stream Setup

## 스트림 수집 아키텍처

```
IP 카메라 (RTSP)   ──┐
YouTube / RTMP     ──┼─► MediaMTX (mediamtx.yml)  ──► captureFactory.js ──► detection pipeline
WebRTC 브라우저    ──┘       ↓                          ├── rtspCapture.js      (CAPTURE_BACKEND=ffmpeg)
ONVIF 자동 탐색             webrtcGateway.js           ├── gstreamerCapture.js  (CAPTURE_BACKEND=gstreamer)
    └──► discoveryService.js ──► 카메라 목록 등록       └── pyavCapture.js       (CAPTURE_BACKEND=pyav)
                                                               └── python/pyav_capture.py
```

## 핵심 파일 위치

| 파일 | 역할 |
|---|---|
| `server/src/services/captureFactory.js` | **캡처 백엔드 팩토리** — CAPTURE_BACKEND env로 선택 |
| `server/src/services/rtspCapture.js` | FFmpeg 기반 RTSP 프레임 캡처 (기본값) |
| `server/src/services/gstreamerCapture.js` | GStreamer 파이프라인 캡처 (nvdec/vaapi 지원) |
| `server/src/services/pyavCapture.js` | Python PyAV 사이드카 캡처 (CUDA 지원) |
| `server/src/python/pyav_capture.py` | Python PyAV 사이드카 스크립트 |
| `server/src/services/rtpIngestion.js` | RTP 패킷 스트림 수신 |
| `server/src/services/webrtcGateway.js` | WebRTC SDP/ICE 협상, 브라우저 스트림 수신 |
| `server/src/services/discoveryService.js` | 네트워크 카메라 자동 탐색 조율 |
| `server/src/services/onvifDiscovery.js` | ONVIF WS-Discovery 프로토콜 |
| `server/src/services/youtubeStreamService.js` | yt-dlp로 YouTube 스트림 → RTSP 변환 |
| `mediamtx.yml` | MediaMTX 프록시 경로·인증·HLS/WebRTC 설정 |

## 주요 작업 절차

### CAPTURE_BACKEND 전환 (ffmpeg / gstreamer / pyav)

`server/.env`에서 선택:
```env
# ffmpeg (기본) — 가장 넓은 호환성
CAPTURE_BACKEND=ffmpeg

# gstreamer — 낮은 지연, 하드웨어 가속
CAPTURE_BACKEND=gstreamer
GSTREAMER_HW_ACCEL=auto   # auto | nvdec | vaapi | software

# pyav — Python PyAV 사이드카, CUDA 최적
CAPTURE_BACKEND=pyav
PYAV_PYTHON_BIN=/usr/bin/python3
PYAV_HW_ACCEL=none         # none | cuda | vaapi | videotoolbox
```

백엔드별 의존성 확인:
```bash
# GStreamer
gst-launch-1.0 --version
gst-inspect-1.0 decodebin
gst-inspect-1.0 nvdec      # NVIDIA 확인
gst-inspect-1.0 vaapidecodebin  # Intel/AMD 확인

# PyAV
python3 -c "import av, PIL; print('OK')"
```

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

### YouTube 스트림 수집
1. 대상 YouTube URL 준비 (라이브 또는 녹화)
2. `server/src/services/youtubeStreamService.js`에서 yt-dlp 경로 확인
3. API 호출: `POST /api/streams/youtube` `{ "url": "https://youtube.com/..." }`
4. MediaMTX 내부 경로로 RTSP 변환 후 파이프라인 연결 확인
5. 참고: [Design_LTS2026_YouTube_RTSP_Ingest.md](../../../docs/design/Design_LTS2026_YouTube_RTSP_Ingest.md)

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

## ffmpeg 버전 호환성

> **개발/커밋 환경과 운영 환경의 Ubuntu 버전이 다르면 ffmpeg 플래그가 다르게 동작합니다.**
> 특히 `-timeout` vs `-stimeout` 차이는 RTSP 스트림이 아예 열리지 않는 무증상 장애를 유발합니다.

### Ubuntu 버전별 ffmpeg 매트릭스

| Ubuntu | ffmpeg | RTSP timeout 플래그 | `-stimeout` | `-timeout` | 비고 |
|--------|--------|---------------------|-------------|------------|------|
| 18.04 LTS | 3.4.x | **`-stimeout`** | ✅ 사용 | ❌ 글로벌 옵션 충돌 | `-timeout` 사용 시 "Unable to open RTSP for listening" 오류 |
| 20.04 LTS | 4.2.x | `-timeout` 권장 | ✅ 호환 | ✅ 사용 | 둘 다 동작 |
| 22.04 LTS | 4.4.x | `-timeout` 권장 | ✅ 호환 | ✅ 사용 | 둘 다 동작 |
| 24.04 LTS | 6.1.x | **`-timeout`** | ⚠️ deprecated | ✅ 사용 | `-stimeout` 경고 발생 |
| 26.04 LTS | 7.x | **`-timeout`** | ❌ 제거됨 | ✅ 사용 | `-stimeout` 옵션 없음 |

### 코드에서의 처리 방식 (`rtspCapture.js`)

```javascript
// 서버 기동 시 ffmpeg 버전 자동 감지
const FFMPEG_MAJOR = _detectFfmpegMajor(); // spawnSync('ffmpeg', ['-version'])

const RTSP_TIMEOUT_ARGS = FFMPEG_MAJOR < 4
  ? ['-stimeout', '5000000']   // ffmpeg 3.x (Ubuntu 18.04)
  : ['-timeout',  '5000000'];  // ffmpeg 4+  (Ubuntu 20.04+)
```

### ffmpeg 버전 확인 명령

```bash
ffmpeg -version | head -1
# → ffmpeg version 3.4.11  (Ubuntu 18.04)
# → ffmpeg version 4.4.2   (Ubuntu 22.04)
# → ffmpeg version 6.1.1   (Ubuntu 24.04)
# → ffmpeg version 7.x.x   (Ubuntu 26.04)

# 설치된 버전으로 RTSP 연결 직접 테스트 (timeout 플래그 없이)
ffmpeg -rtsp_transport tcp -i 'rtsp://user:pass@IP/path' -frames:v 1 /tmp/test.jpg
```

### 자주 발생하는 버전 관련 장애

| 증상 | 원인 | 해결 |
|------|------|------|
| `Unable to open RTSP for listening` + `Cannot assign requested address` | Ubuntu 18.04 ffmpeg 3.4에서 `-timeout` 글로벌 옵션이 RTSP 리스닝 모드로 해석됨 | `FFMPEG_MAJOR` 자동 감지 → `-stimeout` 사용 |
| 스트림이 시작되지만 3~5초 후 끊김 | `-timeout`을 `-i` 뒤에 배치 (출력 옵션으로 해석) | `-i` 앞에 배치 (입력 AVOption) |
| `Option stimeout not found` | ffmpeg 7.x에서 `-stimeout` 제거됨 | `-timeout` 사용 |

### 참조 문서
- [Design_FFmpeg_RTSP_Capture.md](../../../docs/design/Design_FFmpeg_RTSP_Capture.md)
- [Design_RTSP_Capture_Backend.md](../../../docs/design/Design_RTSP_Capture_Backend.md)
- [FFmpeg_Installation_Compatibility.md](../../../docs/ops/FFmpeg_Installation_Compatibility.md)
- [RTSP_Capture_Backend_Setup.md](../../../docs/ops/RTSP_Capture_Backend_Setup.md)
- [TC_FFmpeg_RTSP_Capture.md](../../../docs/tc/TC_FFmpeg_RTSP_Capture.md)
- [TC_RTSP_Capture_Backend.md](../../../docs/tc/TC_RTSP_Capture_Backend.md)

## server/.env 필수 설정 체크리스트

> **이 섹션을 먼저 확인하세요.** 잘못된 환경 변수 설정이 스트림 오류의 가장 흔한 원인입니다.

### 키 이름 주의사항

| 잘못된 키 (사용 금지) | 올바른 키 | 비고 |
|---|---|---|
| `PORT` | `HTTP_PORT` | Express HTTP 포트 |
| `TURN_USER` / `TURN_PASS` | `TURN_USERNAME` / `TURN_CREDENTIAL` | TURN 인증 |

### 캡처 백엔드 필수 변수

```env
CAPTURE_BACKEND=ffmpeg        # ffmpeg | gstreamer | pyav

# gstreamer 사용 시
GSTREAMER_HW_ACCEL=auto       # auto | nvdec | vaapi | software

# pyav 사용 시
PYAV_PYTHON_BIN=/usr/bin/python3
PYAV_HW_ACCEL=none            # none | cuda | vaapi | videotoolbox
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

### 자주 발생하는 오설정 패턴

| 증상 | 원인 | 해결책 |
|---|---|---|
| YouTube 스트림이 `error` 상태로 전환 | `YTDLP_BIN` 또는 `MEDIAMTX_BIN` 공란 또는 경로 오류 | 절대경로 지정 및 실행 권한 확인 |
| WebRTC ICE 연결 실패 | `SERVER_IP`가 브라우저와 다른 서브넷 | 서버의 실제 LAN IP로 수정 |
| TURN 인증 오류 | `TURN_USER` / `TURN_PASS` 사용 (구 키명) | `TURN_USERNAME` / `TURN_CREDENTIAL`로 교체 |
| HTTP 서버 미기동 | `PORT` 사용 (구 키명) | `HTTP_PORT`로 교체 |
| GStreamer 스트림 미동작 | `gst-launch-1.0` 미설치 | `apt install gstreamer1.0-tools gstreamer1.0-plugins-good` |
| PyAV import 오류 | PyAV/Pillow 미설치 | `pip3 install av Pillow` |

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
| PRD | [PRD_LTS2026_YouTube_RTSP_Ingest](../../../docs/prd/PRD_LTS2026_YouTube_RTSP_Ingest.md) · [PRD_Camera_Discovery](../../../docs/prd/PRD_Camera_Discovery.md) · [PRD_WebRTC_Media_Gateway](../../../docs/prd/PRD_WebRTC_Media_Gateway.md) · [PRD_STUN_TURN_ICE](../../../docs/prd/PRD_STUN_TURN_ICE.md) |
| SRS | [SRS_LTS2026_YouTube_RTSP_Ingest](../../../docs/srs/SRS_LTS2026_YouTube_RTSP_Ingest.md) · [SRS_Camera_Discovery](../../../docs/srs/SRS_Camera_Discovery.md) · [SRS_WebRTC_Media_Gateway](../../../docs/srs/SRS_WebRTC_Media_Gateway.md) · [SRS_STUN_TURN_ICE](../../../docs/srs/SRS_STUN_TURN_ICE.md) |
| Design | [Design_RTSP_Capture_Backend](../../../docs/design/Design_RTSP_Capture_Backend.md) · [Design_FFmpeg_RTSP_Capture](../../../docs/design/Design_FFmpeg_RTSP_Capture.md) · [Design_WebRTC_Media_Gateway](../../../docs/design/Design_WebRTC_Media_Gateway.md) |
| Design | [Design_Camera_Discovery](../../../docs/design/Design_Camera_Discovery.md) · [Design_YouTube_RTSP_Ingest](../../../docs/design/Design_YouTube_RTSP_Ingest.md) · [Design_STUN_TURN_ICE](../../../docs/design/Design_STUN_TURN_ICE.md) |
| TC | [TC_RTSP_Capture_Backend](../../../docs/tc/TC_RTSP_Capture_Backend.md) · [TC_FFmpeg_RTSP_Capture](../../../docs/tc/TC_FFmpeg_RTSP_Capture.md) · [TC_WebRTC_Media_Gateway](../../../docs/tc/TC_WebRTC_Media_Gateway.md) · [TC_STUN_TURN_ICE](../../../docs/tc/TC_STUN_TURN_ICE.md) |
| Ops | [RTSP_Capture_Backend_Setup](../../../docs/ops/RTSP_Capture_Backend_Setup.md) · [FFmpeg_Installation_Compatibility](../../../docs/ops/FFmpeg_Installation_Compatibility.md) |

## 코드 수정 시 문서 동기화 의무

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `rtspCapture.js`, `captureFactory.js` | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/design/Design_FFmpeg_RTSP_Capture.md`, `docs/tc/TC_RTSP_Capture_Backend.md` |
| `gstreamerCapture.js` | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| `pyavCapture.js`, `python/pyav_capture.py` | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| `webrtcGateway.js`, `rtpIngestion.js` | `docs/design/Design_WebRTC_Media_Gateway.md`, `docs/srs/SRS_WebRTC_Media_Gateway.md`, `docs/tc/TC_WebRTC_Media_Gateway.md` |
| `socket/webrtcSignaling.js` | `docs/design/Design_WebRTC_Media_Gateway.md`, `docs/tc/TC_WebRTC_Media_Gateway.md` |
| `discoveryService.js`, `onvifDiscovery.js` | `docs/design/Design_Camera_Discovery.md`, `docs/srs/SRS_Camera_Discovery.md`, `docs/tc/TC_Camera_Discovery.md` |
| `youtubeStreamService.js` | `docs/design/Design_YouTube_RTSP_Ingest.md`, `docs/srs/SRS_LTS2026_YouTube_RTSP_Ingest.md`, `docs/tc/TC_LTS2026_YouTube_RTSP_Ingest.md` |
| `mediamtx.yml` | `docs/design/Design_RTSP_Capture_Backend.md`, `docs/ops/RTSP_Capture_Backend_Setup.md` |
| ffmpeg 버전 호환성 변경 | `docs/design/Design_FFmpeg_RTSP_Capture.md`, `docs/ops/FFmpeg_Installation_Compatibility.md`, `docs/tc/TC_FFmpeg_RTSP_Capture.md` |
| coturn / TURN 설정 변경 | `docs/design/Design_STUN_TURN_ICE.md`, `docs/tc/TC_STUN_TURN_ICE.md` |

**공통 규칙**
- **새 기능 추가** → PRD + SRS + Design + TC 문서 모두 신규 작성 또는 기존 문서에 항목 추가
- **버그 수정** → 스펙 오류가 원인이면 SRS·Design 수정, TC에 회귀 케이스 추가
- **설정 파라미터 변경** → SRS 제약 조건 + Ops 가이드 + TC 경계값 반영
- **새 캡처 백엔드 추가** → Design_RTSP_Capture_Backend + SRS + TC + Ops 가이드 신규 추가
