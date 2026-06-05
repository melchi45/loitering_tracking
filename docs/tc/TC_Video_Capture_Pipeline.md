# TEST CASES — Video Capture Pipeline Architecture
**Document ID**: TC-LTS-VCP-01  
**Version**: 1.0  
**Date**: 2026-06-05  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Active  
**Parent SRS**: [srs/SRS_Video_Capture_Pipeline.md](../srs/SRS_Video_Capture_Pipeline.md)  
**Parent Design**: [design/Design_Video_Capture_Pipeline.md](../design/Design_Video_Capture_Pipeline.md)

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-06-05 | Initial test cases — Groups A–G covering Phase 0/1/2 |

---

## Test Groups

| Group | 범위 | 테스트 수 |
|---|---|---|
| A | Phase 0 — ICE 설정 검증 | 6 |
| B | captureFactory 백엔드 선택 | 5 |
| C | RtpIngestion (FFmpeg WebRTC) | 5 |
| D | GStreamer 캡처 백엔드 | 6 |
| E | GStreamerRtpIngestion (Phase 1) | 7 |
| F | MediaMTX Direct WebRTC (Phase 2) | 5 |
| G | 회귀 및 통합 테스트 | 6 |

---

## Group A — Phase 0: ICE 설정 검증

### TC-VCP-A-001: SERVER_IP 루프백 경고

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-A-001 |
| **SRS 참조** | FR-VCP-001 |
| **선행 조건** | `server/.env`: `SERVER_IP=127.0.0.1` |
| **테스트 단계** | 1. 서버 시작 (`node src/index.js`) 2. 서버 stdout/stderr 확인 |
| **기대 결과** | console.warn에 "WARNING: SERVER_IP is set to loopback" 메시지 포함 |
| **판정 기준** | PASS: 경고 메시지 출력됨 FAIL: 경고 없음 |

### TC-VCP-A-002: STUN_URLS 빈 값 허용

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-A-002 |
| **SRS 참조** | FR-VCP-002 |
| **선행 조건** | `server/.env`: `STUN_URLS=` (빈 값), 카메라 1대 추가됨 |
| **테스트 단계** | 1. 서버 시작 2. 브라우저에서 카메라 WebRTC 연결 시도 |
| **기대 결과** | 연결 성공, 서버 로그에 STUN 관련 오류 없음 |
| **판정 기준** | PASS: WebRTC 비디오 재생됨 FAIL: 연결 오류 또는 서버 crash |

### TC-VCP-A-003: LAN IP 설정 후 ICE gather 시간

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-A-003 |
| **SRS 참조** | FR-VCP-003 |
| **선행 조건** | `SERVER_IP=<서버 LAN IP>`, `STUN_URLS=` |
| **테스트 단계** | 1. Settings → ICE Connectivity Test 실행 2. Phase 1 로그에서 gather 완료 타임스탬프 확인 |
| **기대 결과** | ICE gather 완료 < 3 s |
| **판정 기준** | PASS: `[Phase 1 Summary]` gather 시간 < 3 s FAIL: ≥ 3 s 또는 타임아웃 |

### TC-VCP-A-004: Google STUN 제거 후 연결 안정성

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-A-004 |
| **선행 조건** | Google STUN 서버 DNS 조회 불가 환경, 기존 `STUN_URLS=stun:stun.l.google.com:19302` |
| **테스트 단계** | 1. `STUN_URLS=stun:stun.l.google.com:19302` 상태에서 ICE 테스트 실행 → gather 시간 기록 2. `STUN_URLS=`로 변경 후 ICE 테스트 재실행 → gather 시간 기록 |
| **기대 결과** | STUN 제거 후 gather 시간이 12 s 이상 단축됨 |
| **판정 기준** | PASS: 제거 후 < 3 s FAIL: 3 s 이상 |

### TC-VCP-A-005: SERVER_IP LAN 설정 후 ICE 후보 확인

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-A-005 |
| **선행 조건** | `SERVER_IP=192.168.x.x` (실제 LAN IP) |
| **테스트 단계** | 1. ICE 테스트 실행 2. Phase 2 로그에서 "Server ICE candidates" 확인 |
| **기대 결과** | Server ICE candidates에 `192.168.x.x` IP 포함, `127.0.0.1` 없음 |
| **판정 기준** | PASS: LAN IP 후보 존재, 루프백 없음 FAIL: 루프백 IP만 존재 |

### TC-VCP-A-006: ICE 테스트 UI 경고 배너 (실패 서버)

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-A-006 |
| **선행 조건** | `STUN_URLS`에 도달 불가 STUN 서버 URL 포함 |
| **테스트 단계** | 1. ICE 테스트 실행 2. 오류 코드 701 발생 확인 3. 황색 경고 배너 표시 여부 확인 |
| **기대 결과** | "Remove unreachable servers" 버튼 포함한 황색 배너 표시됨 |
| **판정 기준** | PASS: 배너 표시 + 버튼 클릭 시 실패 서버 제거됨 FAIL: 배너 미표시 |

---

## Group B — captureFactory 백엔드 선택

### TC-VCP-B-001: CAPTURE_BACKEND=ffmpeg 선택

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-B-001 |
| **SRS 참조** | FR-VCP-CUR-001 |
| **선행 조건** | `CAPTURE_BACKEND=ffmpeg`, `camera.webrtcEnabled=false` |
| **테스트 단계** | 1. 카메라 시작 API 호출 2. 서버 로그에서 캡처 백엔드 확인 |
| **기대 결과** | 서버 로그에 `[RTSPCapture]` 또는 `ffmpeg` 관련 로그 출력 |
| **판정 기준** | PASS: FFmpeg 백엔드 사용 확인 FAIL: GStreamer 또는 PyAV 백엔드 로드됨 |

### TC-VCP-B-002: CAPTURE_BACKEND=gstreamer, WebRTC OFF 선택

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-B-002 |
| **SRS 참조** | FR-VCP-CUR-001, FR-VCP-CUR-005 |
| **선행 조건** | `CAPTURE_BACKEND=gstreamer`, `camera.webrtcEnabled=false`, GStreamer 설치됨 |
| **테스트 단계** | 1. 카메라 시작 2. 로그 확인 |
| **기대 결과** | `[GStreamerCapture]` 로그 출력, HW decoder 감지 로그 표시 |
| **판정 기준** | PASS: GStreamer 백엔드 + HW 감지 확인 FAIL: FFmpeg 사용됨 |

### TC-VCP-B-003: CAPTURE_BACKEND=pyav 선택

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-B-003 |
| **SRS 참조** | FR-VCP-CUR-001, FR-VCP-CUR-006 |
| **선행 조건** | `CAPTURE_BACKEND=pyav`, `camera.webrtcEnabled=false`, Python+PyAV 설치됨 |
| **테스트 단계** | 1. 카메라 시작 2. 로그 확인 |
| **기대 결과** | `[PyAVCapture] Python+PyAV ready` 로그 출력 |
| **판정 기준** | PASS: PyAV 백엔드 사용 확인 |

### TC-VCP-B-004: CAPTURE_BACKEND 알 수 없는 값 폴백

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-B-004 |
| **SRS 참조** | FR-VCP-CUR-001 |
| **선행 조건** | `CAPTURE_BACKEND=unknown_backend`, `camera.webrtcEnabled=false` |
| **테스트 단계** | 1. 서버 시작 2. 카메라 시작 3. 로그 확인 |
| **기대 결과** | 경고 메시지 출력 후 FFmpeg 폴백 동작 |
| **판정 기준** | PASS: 경고 + FFmpeg 사용 FAIL: 서버 crash 또는 오류 |

### TC-VCP-B-005: WebRTC ON 시 CAPTURE_BACKEND 무시 (현재 동작 문서화)

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-B-005 |
| **SRS 참조** | FR-VCP-CUR-002 |
| **선행 조건** | `CAPTURE_BACKEND=gstreamer`, `camera.webrtcEnabled=true`, `WEBRTC_MODE=mediasoup` |
| **테스트 단계** | 1. Phase 1 미적용 상태에서 카메라 시작 2. 로그 확인 |
| **기대 결과** | GStreamer가 아닌 `[RtpIngestion]` (FFmpeg) 로그 출력됨 |
| **판정 기준** | PASS: RtpIngestion 사용 확인 (현재 동작 검증) |

---

## Group C — RtpIngestion (FFmpeg WebRTC)

### TC-VCP-C-001: RtpIngestion PlainTransport 초기화

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-C-001 |
| **SRS 참조** | FR-VCP-CUR-003, FR-VCP-CUR-004 |
| **선행 조건** | mediasoup 활성화, WebRTC 카메라 시작 |
| **테스트 단계** | 1. `POST /api/cameras/{id}/start` 2. 서버 로그 확인 |
| **기대 결과** | `[RtpIngestion] PlainTransports ready — video:{port} audio:{port}` 출력 |
| **판정 기준** | PASS: 두 포트 모두 할당됨 FAIL: 포트 할당 실패 |

### TC-VCP-C-002: RtpIngestion FFmpeg 3-출력 구조 검증

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-C-002 |
| **SRS 참조** | FR-VCP-CUR-003 |
| **선행 조건** | RtpIngestion 시작됨 |
| **테스트 단계** | 1. `started` 이벤트의 `cmdline` 필드 확인 |
| **기대 결과** | cmdline에 `rtp://127.0.0.1:{videoPort}`, `rtp://127.0.0.1:{audioPort}`, `pipe:1` 모두 포함 |
| **판정 기준** | PASS: 3개 출력 모두 존재 FAIL: 하나라도 없음 |

### TC-VCP-C-003: RtpIngestion JPEG frame 이벤트

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-C-003 |
| **선행 조건** | RtpIngestion 시작, RTSP 카메라 연결됨 |
| **테스트 단계** | 1. `capture.on('frame', ...)` 이벤트 리스너 등록 2. 5 s 대기 |
| **기대 결과** | 5 s 내 최소 40개 이상 frame 이벤트 수신 (≥ 8 fps) |
| **판정 기준** | PASS: frame rate ≥ 8/s FAIL: frame 없음 또는 부족 |

### TC-VCP-C-004: RtpIngestion RTSP 재연결

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-C-004 |
| **선행 조건** | RtpIngestion 실행 중인 카메라 |
| **테스트 단계** | 1. FFmpeg 프로세스 강제 종료 (`kill -9`) 2. `reconnecting` 이벤트 대기 3. 자동 재연결 확인 |
| **기대 결과** | 1 s 내 `reconnecting` 이벤트 발생, 5 s 내 재연결 완료 및 frame 재수신 |
| **판정 기준** | PASS: 재연결 후 frame 수신 재개됨 FAIL: 재연결 없거나 30 s 초과 |

### TC-VCP-C-005: RtpIngestion 오디오 없는 카메라

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-C-005 |
| **SRS 참조** | FR-VCP-CUR-003 |
| **선행 조건** | 오디오 트랙 없는 RTSP 카메라 또는 오디오 없는 테스트 스트림 |
| **테스트 단계** | 1. 카메라 시작 2. FFmpeg 로그 확인 |
| **기대 결과** | 오류 없이 정상 시작, 비디오 frame 수신됨 (Opus 출력만 생략) |
| **판정 기준** | PASS: 비디오 정상 + 서버 crash 없음 FAIL: 오류 종료 |

---

## Group D — GStreamer 캡처 백엔드 (WebRTC OFF)

### TC-VCP-D-001: GStreamer 설치 감지

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-D-001 |
| **SRS 참조** | FR-VCP-CUR-005 |
| **선행 조건** | GStreamer 설치됨 (`gst-launch-1.0 --version` 성공) |
| **테스트 단계** | 1. 서버 시작 2. GStreamer 관련 시작 로그 확인 |
| **기대 결과** | `[GStreamerCapture] GStreamer available — hw decoder: {mode}` 출력 |
| **판정 기준** | PASS: 감지 로그 출력됨 |

### TC-VCP-D-002: GStreamer nvdec 감지

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-D-002 |
| **선행 조건** | NVIDIA GPU + nvdec 플러그인 설치됨 (`gst-inspect-1.0 nvdec` 성공) |
| **테스트 단계** | 1. `GSTREAMER_HW_ACCEL=auto` 상태에서 서버 시작 2. 로그 확인 |
| **기대 결과** | `hw decoder: nvdec` 또는 `nvh264dec` 포함 로그 출력 |
| **판정 기준** | PASS: nvdec 선택 확인 |

### TC-VCP-D-003: GStreamer software 폴백

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-D-003 |
| **선행 조건** | nvdec, vaapi 플러그인 없음 또는 `GSTREAMER_HW_ACCEL=software` |
| **테스트 단계** | 1. 서버 시작 2. GStreamer 파이프라인 시작 |
| **기대 결과** | `hw decoder: software` 로그, `decodebin` 또는 `avdec_h264` 사용 확인 |
| **판정 기준** | PASS: 소프트웨어 디코딩으로 정상 동작 |

### TC-VCP-D-004: GStreamer 미설치 경고

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-D-004 |
| **SRS 참조** | FR-VCP-004 (폴백) |
| **선행 조건** | GStreamer 미설치 환경, `CAPTURE_BACKEND=gstreamer` |
| **테스트 단계** | 1. 서버 시작 2. 카메라 시작 시도 |
| **기대 결과** | `[GStreamerCapture] gst-launch-1.0 not found` 경고 후 오류 이벤트 또는 FFmpeg 폴백 |
| **판정 기준** | PASS: 서버 crash 없음, 경고 출력 |

### TC-VCP-D-005: GStreamer JPEG frame rate

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-D-005 |
| **선행 조건** | `CAPTURE_BACKEND=gstreamer`, RTSP 카메라 연결됨 |
| **테스트 단계** | 1. 카메라 시작 2. 5 s 간 frame 이벤트 수 카운트 |
| **기대 결과** | 40개 이상 frame (≥ 8 fps) |
| **판정 기준** | PASS: ≥ 8 fps FAIL: < 5 fps |

### TC-VCP-D-006: GSTREAMER_HW_ACCEL 강제 설정

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-D-006 |
| **선행 조건** | nvdec 설치됨, `GSTREAMER_HW_ACCEL=nvdec` |
| **테스트 단계** | 1. 서버 시작 2. GStreamer 파이프라인 cmdline 로그 확인 |
| **기대 결과** | 파이프라인에 `nvh264dec` 포함 |
| **판정 기준** | PASS: nvdec 사용 확인 |

---

## Group E — GStreamerRtpIngestion (Phase 1)

### TC-VCP-E-001: GStreamerRtpIngestion 시작

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-E-001 |
| **SRS 참조** | FR-VCP-010, FR-VCP-020 |
| **선행 조건** | `CAPTURE_BACKEND=gstreamer`, `camera.webrtcEnabled=true`, GStreamer 설치됨 |
| **테스트 단계** | 1. 카메라 시작 2. 로그 확인 |
| **기대 결과** | `[GStreamerRtpIngestion][cam-id] PlainTransports ready — video:{port} audio:{port}` 출력, GStreamer 프로세스 시작 |
| **판정 기준** | PASS: PlainTransports 할당 + GStreamer 시작 FAIL: FFmpeg RtpIngestion 사용됨 |

### TC-VCP-E-002: GStreamerRtpIngestion tee JPEG + RTP 동시 동작

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-E-002 |
| **SRS 참조** | FR-VCP-011 |
| **선행 조건** | TC-VCP-E-001 성공 후 |
| **테스트 단계** | 1. frame 이벤트 수신 확인 2. 브라우저 WebRTC 연결 시도 |
| **기대 결과** | frame 이벤트 수신됨(AI 경로) AND 브라우저 WebRTC 비디오 재생됨 |
| **판정 기준** | PASS: 두 경로 동시 동작 FAIL: 하나라도 동작 안 함 |

### TC-VCP-E-003: GStreamerRtpIngestion nvdec 사용

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-E-003 |
| **SRS 참조** | FR-VCP-013 |
| **선행 조건** | `GSTREAMER_HW_ACCEL=nvdec`, NVIDIA GPU 환경 |
| **테스트 단계** | 1. 카메라 시작 2. `nvidia-smi` 출력에서 GStreamer 프로세스 확인 |
| **기대 결과** | `nvidia-smi`에서 gst-launch 프로세스가 GPU 메모리 사용 |
| **판정 기준** | PASS: GPU 사용 확인 FAIL: GPU 사용 없음 |

### TC-VCP-E-004: GStreamerRtpIngestion 재연결

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-E-004 |
| **SRS 참조** | FR-VCP-015 |
| **선행 조건** | GStreamerRtpIngestion 실행 중 |
| **테스트 단계** | 1. GStreamer 프로세스 강제 종료 2. 5 s 대기 |
| **기대 결과** | `reconnecting` 이벤트 발생 후 재시작, 5 s 내 frame 재수신 |
| **판정 기준** | PASS: 재연결 성공 FAIL: 재연결 없음 |

### TC-VCP-E-005: GStreamer 미설치 시 FFmpeg 폴백

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-E-005 |
| **SRS 참조** | FR-VCP-014 |
| **선행 조건** | `CAPTURE_BACKEND=gstreamer`, GStreamer 미설치 환경, `camera.webrtcEnabled=true` |
| **테스트 단계** | 1. 카메라 시작 2. 로그 확인 |
| **기대 결과** | 경고 로그 출력 후 FFmpeg RtpIngestion으로 폴백, 카메라 정상 동작 |
| **판정 기준** | PASS: 경고 + FFmpeg 폴백 + 서버 crash 없음 |

### TC-VCP-E-006: pipelineManager CAPTURE_BACKEND=ffmpeg 분기 불변

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-E-006 |
| **SRS 참조** | FR-VCP-021 |
| **선행 조건** | `CAPTURE_BACKEND=ffmpeg` (기본값), `camera.webrtcEnabled=true` |
| **테스트 단계** | Phase 1 코드 적용 후, 기존 RtpIngestion(FFmpeg) 경로 동작 확인 |
| **기대 결과** | `[RtpIngestion]` 로그 출력, GStreamerRtpIngestion 사용 없음 |
| **판정 기준** | PASS: 기존 동작 동일 FAIL: 동작 변경됨 |

### TC-VCP-E-007: CPU 사용량 비교 (nvdec vs FFmpeg)

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-E-007 |
| **SRS 참조** | NFR-VCP-003 |
| **선행 조건** | NVIDIA GPU 환경, 1080p RTSP 카메라 |
| **테스트 단계** | 1. `CAPTURE_BACKEND=ffmpeg`으로 카메라 시작, 30 s 간 CPU 사용량 기록 2. `CAPTURE_BACKEND=gstreamer`, `GSTREAMER_HW_ACCEL=nvdec`으로 재시작, CPU 기록 |
| **기대 결과** | GStreamer nvdec 사용 시 FFmpeg 대비 CPU ≥ 40% 감소 |
| **판정 기준** | PASS: 40%+ 감소 FAIL: 차이 없음 |

---

## Group F — MediaMTX Direct WebRTC (Phase 2)

### TC-VCP-F-001: MediaMTX 경로 등록

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-F-001 |
| **SRS 참조** | FR-VCP-031 |
| **선행 조건** | `WEBRTC_MODE=mediamtx`, MediaMTX 실행 중 (`apiAddress: :9997`) |
| **테스트 단계** | 1. 카메라 시작 2. `GET http://localhost:9997/v3/config/paths/list` 확인 |
| **기대 결과** | 카메라 ID가 MediaMTX paths 목록에 포함됨 |
| **판정 기준** | PASS: 경로 등록 확인 FAIL: 경로 없음 |

### TC-VCP-F-002: MediaMTX WebRTC URL 브라우저 접근

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-F-002 |
| **SRS 참조** | FR-VCP-032 |
| **선행 조건** | TC-VCP-F-001 성공, `MEDIAMTX_WEBRTC_URL` 설정됨 |
| **테스트 단계** | 1. `GET /api/cameras` 응답에서 `mediamtxWebrtcUrl` 확인 2. 해당 URL로 WHEP 요청 테스트 |
| **기대 결과** | `mediamtxWebrtcUrl` 필드 포함, WHEP POST 응답 200 OK |
| **판정 기준** | PASS: URL 필드 존재 + WHEP 응답 성공 |

### TC-VCP-F-003: MediaMTX 모드에서 AI 추론 정상 동작

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-F-003 |
| **SRS 참조** | FR-VCP-033, NFR-VCP-006 |
| **선행 조건** | `WEBRTC_MODE=mediamtx`, RTSP 카메라 연결됨 |
| **테스트 단계** | 1. 카메라 시작 2. Socket.IO `frameData` 이벤트 수신 확인 3. 감지 결과 Socket.IO 이벤트 수신 확인 |
| **기대 결과** | frameData 이벤트 정상 수신, YOLOv8 감지 결과 포함 |
| **판정 기준** | PASS: AI 추론 결과 수신됨 FAIL: frameData 없음 |

### TC-VCP-F-004: MediaMTX 경로 제거 (카메라 중지 시)

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-F-004 |
| **SRS 참조** | FR-VCP-031 |
| **선행 조건** | TC-VCP-F-001 성공 후 카메라 실행 중 |
| **테스트 단계** | 1. 카메라 중지 API 호출 2. MediaMTX paths 목록 재확인 |
| **기대 결과** | 카메라 ID가 MediaMTX paths 목록에서 제거됨 |
| **판정 기준** | PASS: 경로 제거 확인 |

### TC-VCP-F-005: MediaMTX API 실패 시 폴백

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-F-005 |
| **SRS 참조** | FR-VCP-ERR-004 |
| **선행 조건** | `WEBRTC_MODE=mediamtx`, MediaMTX API 포트 닫힘 (의도적 장애) |
| **테스트 단계** | 1. MediaMTX 중지 2. 카메라 시작 시도 |
| **기대 결과** | 오류 로그 출력, 서버 전체 crash 없음, 해당 카메라만 오류 상태 |
| **판정 기준** | PASS: 서버 계속 실행, 오류 로그 출력 FAIL: 서버 crash |

---

## Group G — 회귀 및 통합 테스트

### TC-VCP-G-001: Phase 1 적용 후 기존 기능 회귀

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-G-001 |
| **선행 조건** | Phase 1 코드(`gstreamerRtpIngestion.js`) 배포됨, `CAPTURE_BACKEND=ffmpeg` (기본값) |
| **테스트 단계** | 1. 기존 `test/api/webrtc.test.js` 실행 2. `test/api/main_system.test.js` 실행 |
| **기대 결과** | 모든 기존 테스트 PASS |
| **판정 기준** | PASS: 0 fail FAIL: 1+ fail |

### TC-VCP-G-002: Phase 2 적용 후 기존 기능 회귀

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-G-002 |
| **선행 조건** | Phase 2 코드 배포됨, `WEBRTC_MODE=mediasoup` (기본값 유지) |
| **테스트 단계** | 1. `test/api/webrtc.test.js` 실행 2. WebRTC ICE 테스트 실행 |
| **기대 결과** | 기존 mediasoup 경로 정상 동작 |
| **판정 기준** | PASS: 기존 테스트 PASS |

### TC-VCP-G-003: 다중 카메라 동시 처리 (Phase 0 후)

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-G-003 |
| **SRS 참조** | NFR-VCP-008 |
| **선행 조건** | Phase 0 적용됨, RTSP 테스트 카메라 4대 |
| **테스트 단계** | 1. 카메라 4대 동시 시작 2. 30 s 간 WebRTC 연결 안정성 확인 |
| **기대 결과** | 4대 모두 안정적 WebRTC 연결 유지, 연결 끊김 0회 |
| **판정 기준** | PASS: 30 s 동안 모든 카메라 연결 유지 FAIL: 1회 이상 끊김 |

### TC-VCP-G-004: 카메라 재시작 후 WebRTC 재연결

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-G-004 |
| **선행 조건** | Phase 0 적용됨, WebRTC 카메라 1대 실행 중 |
| **테스트 단계** | 1. 카메라 API 중지 → 2 s → 재시작 2. WebRTC 연결 복구 시간 측정 |
| **기대 결과** | 재시작 후 10 s 이내 WebRTC 연결 복구 |
| **판정 기준** | PASS: ≤ 10 s FAIL: > 10 s 또는 복구 실패 |

### TC-VCP-G-005: CAPTURE_BACKEND 런타임 변경 (서버 재시작 없이)

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-G-005 |
| **SRS 참조** | NFR-VCP-005 |
| **선행 조건** | Phase 1 적용됨 |
| **테스트 단계** | 1. `CAPTURE_BACKEND=ffmpeg`으로 카메라 1대 시작 2. `.env` 변경 → `CAPTURE_BACKEND=gstreamer` 3. 서버 재시작 없이 새 카메라 추가 |
| **기대 결과** | 새로 추가된 카메라는 GStreamer 백엔드 사용 |
| **판정 기준** | PASS: 기존 카메라 영향 없음 + 신규 카메라 GStreamer 사용 |

### TC-VCP-G-006: ICE Test UI에서 Phase 0 효과 검증

| 항목 | 내용 |
|---|---|
| **ID** | TC-VCP-G-006 |
| **선행 조건** | Phase 0 적용됨 (SERVER_IP=LAN IP, STUN_URLS=) |
| **테스트 단계** | 1. Settings → ICE Connectivity Test 실행 2. 전체 로그 다운로드 3. 로그 분석 |
| **기대 결과** | Phase 1 gather < 3 s, Phase 2 server candidates에 LAN IP 포함, 오류 코드 701 없음, `=== ICE Test Complete ===` 정상 완료 |
| **판정 기준** | PASS: 모든 항목 충족 FAIL: 하나라도 미충족 |
