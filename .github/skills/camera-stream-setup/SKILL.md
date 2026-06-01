---
name: camera-stream-setup
description: "LTS-2026 카메라 스트림 설정 및 관리. Use when: RTSP 카메라 추가/연결, ONVIF 카메라 자동 탐색, YouTube/RTMP 스트림 RTSP 변환 ingestion, WebRTC 미디어 게이트웨이 설정, MediaMTX 프록시 설정, ICE/STUN/TURN 연결 문제 해결, 카메라 스트림 끊김 디버깅, 새 카메라 소스 지원 추가. Covers: rtspCapture.js, rtpIngestion.js, webrtcGateway.js, discoveryService.js, onvifDiscovery.js, youtubeStreamService.js, mediamtx.yml."
argument-hint: "카메라 소스 유형 (RTSP / ONVIF / YouTube / WebRTC)"
---

# Camera Stream Setup

## 스트림 수집 아키텍처

```
IP 카메라 (RTSP)   ──┐
YouTube / RTMP     ──┼─► MediaMTX (mediamtx.yml)  ──► rtspCapture.js ──► detection pipeline
WebRTC 브라우저    ──┘                                └─► webrtcGateway.js
ONVIF 자동 탐색    ──► discoveryService.js ──► 카메라 목록 등록
```

## 핵심 파일 위치

| 파일 | 역할 |
|---|---|
| `server/src/services/rtspCapture.js` | FFmpeg 기반 RTSP 프레임 캡처 |
| `server/src/services/rtpIngestion.js` | RTP 패킷 스트림 수신 |
| `server/src/services/webrtcGateway.js` | WebRTC SDP/ICE 협상, 브라우저 스트림 수신 |
| `server/src/services/discoveryService.js` | 네트워크 카메라 자동 탐색 조율 |
| `server/src/services/onvifDiscovery.js` | ONVIF WS-Discovery 프로토콜 |
| `server/src/services/youtubeStreamService.js` | yt-dlp로 YouTube 스트림 → RTSP 변환 |
| `mediamtx.yml` | MediaMTX 프록시 경로·인증·HLS/WebRTC 설정 |

## 주요 작업 절차

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
5. `server/src/services/rtspCapture.js`에서 스트림 소비 확인

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
5. 참고: [Design_LTS2026_YouTube_RTSP_Ingest.md](../../docs/design/Design_LTS2026_YouTube_RTSP_Ingest.md)

### WebRTC 연결 문제 해결
1. `server/src/services/webrtcGateway.js` ICE candidate 로그 확인
2. STUN/TURN 서버 설정 검토 (환경변수 `TURN_URL`, `TURN_USER`, `TURN_PASS`)
3. 방화벽에서 UDP 10000–20000 포트 허용 여부 확인
4. 브라우저 콘솔에서 `RTCPeerConnection` 상태 확인
5. 참고: [Design_STUN_TURN_ICE.md](../../docs/design/Design_STUN_TURN_ICE.md)

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

## 스트림 상태 진단 명령

```bash
# MediaMTX 경로 목록 확인
curl http://localhost:9997/v3/paths/list

# RTSP 스트림 직접 테스트
ffplay rtsp://localhost:8554/cam_01

# yt-dlp 스트림 품질 확인
yt-dlp -F https://youtube.com/watch?v=...
```

## 관련 설계 문서
- [Design_WebRTC_Media_Gateway.md](../../docs/design/Design_WebRTC_Media_Gateway.md)
- [Design_Camera_Discovery.md](../../docs/design/Design_Camera_Discovery.md)
- [Design_YouTube_RTSP_Ingest.md](../../docs/design/Design_YouTube_RTSP_Ingest.md)
- [Design_STUN_TURN_ICE.md](../../docs/design/Design_STUN_TURN_ICE.md)
