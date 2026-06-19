# TEST CASES — RTSP → WebRTC 실시간 AI 스트리밍 아키텍처
**Document ID**: TC-LTS-RWA-01  
**Version**: 1.0  
**Date**: 2026-06-11  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Active  
**Parent SRS**: [srs/SRS_RTSP_WebRTC_Architecture.md](../srs/SRS_RTSP_WebRTC_Architecture.md) (작성 예정)  
**Parent Design**: [design/Design_RTSP_WebRTC_Architecture.md](../design/Design_RTSP_WebRTC_Architecture.md)

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-06-11 | 초기 작성 — Groups A–H (단일 인제스트·WHEP·ingest-daemon·AI 통합·M1 녹화·M2 Playback·M4 RTCP·회귀) |

> **범위 주의**: M3(Qdrant 벡터 DB Re-ID) 및 M5(분산 클러스터 Kafka)는 별도 TC 문서로 분리 예정이므로 본 파일에 포함하지 않습니다.

---

## Test Groups

| Group | 범위 | 테스트 수 |
|---|---|---|
| A | 단일 인제스트 프로세서 원칙 검증 | 4 |
| B | MediaMTX WHEP 연결 검증 | 4 |
| C | ingest-daemon 정상 동작 | 5 |
| D | AI 파이프라인 통합 | 4 |
| E | 영상 녹화 — M1 | 5 |
| F | Playback API — M2 | 4 |
| G | RTCP 피드백 처리 — M4 | 3 |
| H | 회귀 및 통합 | 4 |

---

## Group A — 단일 인제스트 프로세서 원칙 검증

> 카메라당 RTSP 연결은 반드시 1개이어야 합니다. MediaMTX가 카메라에 단일 연결을 유지하고,
> loopback RTSP(:8554)를 통한 하위 소비자 연결은 카메라 부하 없이 허용됩니다.

### TC-RWA-A-001: MediaMTX → 카메라 단일 RTSP 연결 확인

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-A-001 |
| **SRS 참조** | FR-RWA-001 |
| **선행 조건** | MediaMTX 실행 중, 카메라 1대 등록됨 (`POST /api/cameras`), ingest-daemon 실행 중 |
| **테스트 단계** | 1. 카메라 시작 API 호출 (`POST /api/cameras/{id}/start`) 2. `ss -tnp \| grep {camera_ip}` 또는 `netstat -tn` 출력 확인 3. MediaMTX 로그에서 RTSP 연결 수 확인 |
| **기대 결과** | 카메라 IP로 향하는 RTSP TCP 연결이 정확히 1개 (MediaMTX 프로세스에서) |
| **판정 기준** | PASS: RTSP 연결 1개 확인됨 FAIL: 2개 이상 또는 0개 |

### TC-RWA-A-002: ingest-daemon + 브라우저 WebRTC 동시 접속 시 카메라 연결 수 불변

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-A-002 |
| **SRS 참조** | FR-RWA-001, FR-RWA-002 |
| **선행 조건** | 카메라 시작됨, ingest-daemon 실행 중 |
| **테스트 단계** | 1. 브라우저 3개 탭에서 동시에 WHEP WebRTC 연결 시도 2. `ss -tnp \| grep {camera_ip}` 재확인 3. MediaMTX API `GET :9997/v3/paths/list` 응답에서 `readersCount` 확인 |
| **기대 결과** | 카메라 IP RTSP 연결은 여전히 1개. MediaMTX `readersCount`는 3 이상 (loopback RTSP + WHEP 브라우저들) |
| **판정 기준** | PASS: 카메라 연결 1개 유지 + `readersCount` 증가 확인 FAIL: 카메라 연결 2개 이상 |

### TC-RWA-A-003: MediaMTX 경로 등록 API 확인 (mediamtxManager.js)

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-A-003 |
| **SRS 참조** | FR-RWA-003 |
| **선행 조건** | MediaMTX 실행 중 (`apiAddress: :9997`), 카메라 미시작 상태 |
| **테스트 단계** | 1. 카메라 시작 API 호출 2. `GET http://localhost:9997/v3/config/paths/list` 응답 확인 |
| **기대 결과** | 카메라 ID가 MediaMTX paths 목록에 포함됨 (`source` 필드에 카메라 RTSP URL 존재) |
| **판정 기준** | PASS: 경로 등록 확인 FAIL: 경로 없음 또는 API 오류 |

### TC-RWA-A-004: 카메라 중지 시 MediaMTX 경로 해제

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-A-004 |
| **SRS 참조** | FR-RWA-003 |
| **선행 조건** | TC-RWA-A-003 성공 후 카메라 실행 중 |
| **테스트 단계** | 1. 카메라 중지 API 호출 (`POST /api/cameras/{id}/stop`) 2. `GET http://localhost:9997/v3/config/paths/list` 재확인 |
| **기대 결과** | 카메라 ID가 MediaMTX paths 목록에서 제거됨 |
| **판정 기준** | PASS: 경로 제거 확인 FAIL: 경로 잔존 |

---

## Group B — MediaMTX WHEP 연결 검증

### TC-RWA-B-001: WHEP SDP offer/answer 교환 성공

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-B-001 |
| **SRS 참조** | FR-RWA-010 |
| **선행 조건** | 카메라 시작됨, `WEBRTC_ENGINE=mediamtx`, MediaMTX WHEP 포트(:8889) 접근 가능 |
| **테스트 단계** | 1. 브라우저에서 카메라 뷰 접속 2. 브라우저 DevTools → Network 탭 → `whep` 요청 확인 3. HTTP 응답 상태 코드 및 `Content-Type` 확인 |
| **기대 결과** | HTTP 201 Created, `Content-Type: application/sdp`, 응답 body에 SDP answer(`v=0`으로 시작) 포함 |
| **판정 기준** | PASS: 201 + SDP answer 수신 FAIL: 4xx/5xx 또는 SDP 없음 |

### TC-RWA-B-002: WHEP WebRTC 브라우저 영상 재생

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-B-002 |
| **SRS 참조** | FR-RWA-011 |
| **선행 조건** | TC-RWA-B-001 성공 |
| **테스트 단계** | 1. 브라우저 `<video>` 엘리먼트 재생 상태 확인 2. 10초 간 영상 프레임 연속 재생 여부 관찰 3. 브라우저 DevTools → `RTCPeerConnection.getStats()` 호출 |
| **기대 결과** | `<video>` 재생 중 (paused=false), `getStats()` 응답에서 `framesReceived > 0`, `bytesReceived > 0` |
| **판정 기준** | PASS: 영상 재생 + 통계 확인 FAIL: 영상 없음 또는 framesReceived=0 |

### TC-RWA-B-003: ICE UDP 포트(:8189) 개방 여부 확인

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-B-003 |
| **SRS 참조** | FR-RWA-012 |
| **선행 조건** | MediaMTX 실행 중, `webrtcAddress: :8189` 설정됨 |
| **테스트 단계** | 1. `ss -unp \| grep 8189` 또는 `netstat -un \| grep 8189` 실행 2. 방화벽 규칙 확인 (`iptables -L \| grep 8189`) |
| **기대 결과** | UDP 8189 포트 LISTEN 상태, 방화벽 허용 규칙 존재 |
| **판정 기준** | PASS: UDP 8189 리스닝 확인 FAIL: 포트 닫힘 |

### TC-RWA-B-004: 브라우저 다중 동시 WHEP 연결

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-B-004 |
| **SRS 참조** | FR-RWA-011, NFR-RWA-001 |
| **선행 조건** | 카메라 1대 시작됨 |
| **테스트 단계** | 1. 브라우저 3개 탭에서 동시에 동일 카메라 WHEP 연결 시도 2. 각 탭에서 영상 재생 확인 3. 서버 로그에서 오류 여부 확인 |
| **기대 결과** | 3개 탭 모두 영상 재생 성공, 서버 오류 로그 없음 |
| **판정 기준** | PASS: 3개 탭 모두 재생 성공 FAIL: 1개 이상 연결 실패 또는 서버 crash |

---

## Group C — ingest-daemon 정상 동작

### TC-RWA-C-001: ingest-daemon 시작 및 MediaMTX loopback RTSP 연결

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-C-001 |
| **SRS 참조** | FR-RWA-020 |
| **선행 조건** | `CAPTURE_BACKEND=ingest-daemon`, MediaMTX 실행 중 (:8554), Python 환경에 `av` 패키지 설치됨 |
| **테스트 단계** | 1. 카메라 시작 API 호출 2. ingest-daemon 로그에서 `av.open(rtsp://127.0.0.1:8554/{camId})` 성공 확인 3. `ss -tnp \| grep 8554` 확인 |
| **기대 결과** | ingest-daemon이 `127.0.0.1:8554/{camId}`에 RTSP 연결 성공, 로그에 `[ingest-daemon] connected` 출력 |
| **판정 기준** | PASS: loopback RTSP 연결 확인 FAIL: 연결 오류 또는 재시도 무한 반복 |

### TC-RWA-C-002: ingest-daemon JPEG 디코딩 및 HTTP POST 전송

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-C-002 |
| **SRS 참조** | FR-RWA-021 |
| **선행 조건** | TC-RWA-C-001 성공 |
| **테스트 단계** | 1. Node.js 서버 로그에서 `[IngestDaemonCapture] frame received` 확인 2. 5초 간 수신 frame 수 카운트 |
| **기대 결과** | 5초 내 최소 40개 이상 frame 수신 (≥ 8 fps) |
| **판정 기준** | PASS: frame rate ≥ 8/s FAIL: frame 없음 또는 < 5/s |

### TC-RWA-C-003: IngestDaemonCapture.injectFrame → EventEmitter 동작

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-C-003 |
| **SRS 참조** | FR-RWA-022 |
| **선행 조건** | `CAPTURE_BACKEND=ingest-daemon`, 카메라 시작됨 |
| **테스트 단계** | 1. `ingestDaemonCapture.on('frame', cb)` 리스너 등록 (테스트 코드) 2. 10초 간 'frame' 이벤트 수신 여부 확인 3. buf 인자가 JPEG SOI 마커(`FF D8`)로 시작하는지 검증 |
| **기대 결과** | 'frame' 이벤트 정기적 수신, `buf[0]=0xFF, buf[1]=0xD8` 확인됨 |
| **판정 기준** | PASS: 이벤트 수신 + JPEG SOI 확인 FAIL: 이벤트 없음 또는 잘못된 데이터 |

### TC-RWA-C-004: ingest-daemon 연결 끊김 자동 재연결

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-C-004 |
| **SRS 참조** | FR-RWA-023 |
| **선행 조건** | ingest-daemon 실행 중, 카메라 스트리밍 중 |
| **테스트 단계** | 1. MediaMTX 일시 중지 (또는 카메라 RTSP 스트림 강제 차단) 2. ingest-daemon 로그 확인 3. MediaMTX 재시작 후 재연결 여부 확인 |
| **기대 결과** | ingest-daemon이 `reconnecting` 로그 출력 후, 5~10초 내 재연결 성공 및 frame 재수신 |
| **판정 기준** | PASS: 재연결 성공 + frame 재수신 FAIL: 재연결 없음 또는 daemon crash |

### TC-RWA-C-005: ingest-daemon 핫 재시작 (서버 전체 재시작 불필요)

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-C-005 |
| **SRS 참조** | FR-RWA-024 |
| **선행 조건** | ingest-daemon 실행 중, `npm run ingest:restart` 명령 사용 가능 |
| **테스트 단계** | 1. `npm run ingest:restart` 실행 2. 서버 재시작 여부 확인 (Node.js 프로세스 PID 동일 여부) 3. 30초 후 frame 수신 재개 확인 |
| **기대 결과** | Node.js 서버 프로세스는 계속 실행 중, ingest-daemon만 재시작, 30초 내 frame 재수신 |
| **판정 기준** | PASS: 서버 PID 동일 + frame 재수신 FAIL: 서버 전체 재시작 또는 frame 미수신 |

---

## Group D — AI 파이프라인 통합

### TC-RWA-D-001: ingest-daemon frame → YOLOv8 ONNX 감지

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-D-001 |
| **SRS 참조** | FR-RWA-030 |
| **선행 조건** | `CAPTURE_BACKEND=ingest-daemon`, YOLOv8 ONNX 모델 로드됨, 사람이 보이는 RTSP 카메라 |
| **테스트 단계** | 1. 카메라 시작 후 Socket.IO `frameData` 이벤트 수신 2. frameData payload에서 `detections` 배열 확인 3. 사람 감지 결과(`className: 'person'`) 포함 여부 확인 |
| **기대 결과** | `frameData.detections`에 `className: 'person'`, `confidence > 0.5`, `bbox` 포함 |
| **판정 기준** | PASS: person 감지 결과 포함 FAIL: detections 배열 비어 있음 |

### TC-RWA-D-002: ByteTrack 추적 ID 연속성

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-D-002 |
| **SRS 참조** | FR-RWA-031 |
| **선행 조건** | TC-RWA-D-001 성공, 동일 인물이 카메라 시야 내 연속 이동 |
| **테스트 단계** | 1. Socket.IO `objectTracked` 이벤트 수신 5초 간 기록 2. 동일 인물의 `trackId` 연속성 확인 |
| **기대 결과** | 동일 인물에 대해 `trackId`가 5초 간 동일하게 유지됨 (단락 없이) |
| **판정 기준** | PASS: trackId 연속성 5초 이상 유지 FAIL: trackId가 2초 이내 변경됨 |

### TC-RWA-D-003: BehaviorEngine 배회 알림 발생

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-D-003 |
| **SRS 참조** | FR-RWA-032 |
| **선행 조건** | 구역 생성됨(`zoneType: MONITOR`), `LOITERING_THRESHOLD_SEC` 설정됨 (예: 10초), 사람이 구역 내 체류 |
| **테스트 단계** | 1. 사람이 구역 내에서 `LOITERING_THRESHOLD_SEC` 초 이상 체류 2. Socket.IO `newAlert` 이벤트 수신 확인 |
| **기대 결과** | `newAlert` 이벤트 발생, `type: 'loitering'`, `zoneId`, `objectId`, `dwellTimeSec` 포함 |
| **판정 기준** | PASS: `newAlert` 이벤트 수신 + loitering 타입 확인 FAIL: 임계값 초과 후에도 알림 없음 |

### TC-RWA-D-004: pipelineManager SERVER_MODE=analysis 분리 동작

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-D-004 |
| **SRS 참조** | FR-RWA-033 |
| **선행 조건** | `SERVER_MODE=streaming`, 별도 analysis 서버 실행 중 (`ANALYSIS_SERVER_URL` 설정됨) |
| **테스트 단계** | 1. 스트리밍 서버에서 카메라 시작 2. analysis 서버 로그에서 JPEG POST 수신 확인 3. 스트리밍 서버 Socket.IO `frameData` 이벤트에서 감지 결과 수신 확인 |
| **기대 결과** | analysis 서버가 JPEG를 수신하여 추론 후 감지 결과 반환, 스트리밍 서버가 이를 Socket.IO로 브로드캐스트 |
| **판정 기준** | PASS: 감지 결과 정상 수신 FAIL: 추론 결과 없음 또는 회로차단기 OPEN 상태 |

---

## Group E — 영상 녹화 (M1)

> **전제 조건**: MediaMTX `record: yes` 설정이 `mediamtx.yml`에 적용됨. `recordingService.js` 구현 완료.

### TC-RWA-E-001: MediaMTX record:yes 설정 후 세그먼트 파일 생성

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-E-001 |
| **SRS 참조** | FR-RWA-M1-001 |
| **선행 조건** | `mediamtx.yml`에 `record: yes`, `recordPath: ./recordings/%path/%Y%m%d_%H%M%S-%f`, `recordSegmentDuration: 30s` 설정됨 |
| **테스트 단계** | 1. 카메라 시작 2. 35초 대기 3. `./recordings/{camId}/` 디렉토리 확인 (`ls -la`) |
| **기대 결과** | `{camId}_{timestamp}.mp4` 파일 1개 이상 생성됨, 파일 크기 > 0 bytes |
| **판정 기준** | PASS: MP4 세그먼트 파일 존재 + 크기 > 0 FAIL: 디렉토리 없음 또는 파일 크기 0 |

### TC-RWA-E-002: 세그먼트 MP4 파일 재생 가능 여부

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-E-002 |
| **SRS 참조** | FR-RWA-M1-001, NFR-RWA-M1-001 |
| **선행 조건** | TC-RWA-E-001 성공, ffprobe 설치됨 |
| **테스트 단계** | 1. `ffprobe -v error -show_format -show_streams ./recordings/{camId}/{segment}.mp4` 실행 2. 출력에서 video stream 존재 여부 및 duration 확인 |
| **기대 결과** | `codec_name=h264`, `duration >= 25.0` (30초 세그먼트 기준) |
| **판정 기준** | PASS: H264 스트림 존재 + duration ≥ 25초 FAIL: 파일 깨짐 또는 재생 불가 |

### TC-RWA-E-003: recordingService.js → MinIO/S3 업로드

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-E-003 |
| **SRS 참조** | FR-RWA-M1-002 |
| **선행 조건** | `recordingService.js` 구현됨, MinIO 실행 중 (`MINIO_ENDPOINT`, `MINIO_BUCKET` 환경변수 설정됨) |
| **테스트 단계** | 1. 카메라 시작 후 세그먼트 생성 대기 2. MinIO Console 또는 `aws s3 ls s3://{bucket}/recordings/` 확인 3. Node.js 로그에서 업로드 완료 메시지 확인 |
| **기대 결과** | MinIO 버킷에 `recordings/{camId}/{date}/{segment}.mp4` 파일 업로드됨, 로그에 `[RecordingService] uploaded` 출력 |
| **판정 기준** | PASS: MinIO 파일 존재 + 업로드 로그 확인 FAIL: 파일 없음 또는 업로드 오류 |

### TC-RWA-E-004: 세그먼트 메타데이터 DB 저장

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-E-004 |
| **SRS 참조** | FR-RWA-M1-003 |
| **선행 조건** | TC-RWA-E-003 성공 |
| **테스트 단계** | 1. `GET /api/recordings?cam={camId}` API 호출 2. 응답 JSON 내 세그먼트 목록 확인 |
| **기대 결과** | 응답에 `[{ camId, startTs, endTs, durationSec, objectPath }]` 형태의 세그먼트 메타데이터 포함 |
| **판정 기준** | PASS: 메타데이터 반환 + startTs/endTs 유효 FAIL: 응답 빈 배열 또는 필드 누락 |

### TC-RWA-E-005: 서버 재시작 시 진행 중 세그먼트 처리

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-E-005 |
| **SRS 참조** | FR-RWA-M1-004, NFR-RWA-M1-002 |
| **선행 조건** | 카메라 실행 중, 세그먼트 녹화 진행 중 (20초 경과 시점) |
| **테스트 단계** | 1. Node.js 서버 강제 재시작 (`pm2 restart` 또는 `kill -9 + restart`) 2. `./recordings/{camId}/` 디렉토리 확인 3. 재시작 후 새 세그먼트 생성 여부 확인 |
| **기대 결과** | 재시작 전 진행 중이던 세그먼트가 완료 또는 불완전하더라도 유효한 MP4 파일로 저장됨. 재시작 후 새 세그먼트 정상 생성됨 |
| **판정 기준** | PASS: 재시작 후 신규 세그먼트 생성됨, 서버 crash 없음 FAIL: 재시작 후 녹화 중단 |

---

## Group F — Playback API (M2)

> **전제 조건**: M1 완료 (세그먼트 메타데이터 DB에 저장됨), `GET /api/playback` 엔드포인트 구현됨.

### TC-RWA-F-001: GET /api/playback?cam={id}&ts={unix_ms} 기본 동작

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-F-001 |
| **SRS 참조** | FR-RWA-M2-001 |
| **선행 조건** | M1 완료, 해당 timestamp에 세그먼트 메타데이터 존재 |
| **테스트 단계** | 1. `GET /api/playback?cam={camId}&ts={known_ts}` 호출 2. 응답 JSON 구조 확인 |
| **기대 결과** | HTTP 200, 응답에 `videoUrl`, `events[]`, `segmentStart`, `segmentEnd` 필드 포함 |
| **판정 기준** | PASS: 4개 필드 모두 존재, videoUrl이 유효한 URL FAIL: 필드 누락 또는 4xx/5xx |

### TC-RWA-F-002: videoUrl로 브라우저 영상 재생

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-F-002 |
| **SRS 참조** | FR-RWA-M2-002, NFR-RWA-M2-001 |
| **선행 조건** | TC-RWA-F-001 성공, `videoUrl` 접근 가능 환경 |
| **테스트 단계** | 1. TC-RWA-F-001에서 반환된 `videoUrl`을 브라우저 `<video src="...">` 에 설정 2. 재생 시작 시간 측정 3. seek 동작 테스트 |
| **기대 결과** | 3초 이내 재생 시작, seek 후 < 2초 내 해당 위치 재생, 영상 끊김 없음 |
| **판정 기준** | PASS: 재생 시작 ≤ 3초 + seek 정상 FAIL: 재생 불가 또는 재생 시작 > 3초 |

### TC-RWA-F-003: 세그먼트 없는 시간 범위 요청 시 HTTP 404

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-F-003 |
| **SRS 참조** | FR-RWA-M2-003 |
| **선행 조건** | `GET /api/playback` 구현됨 |
| **테스트 단계** | 1. 녹화 데이터가 없는 과거 timestamp로 `GET /api/playback?cam={camId}&ts={far_past_ts}` 호출 |
| **기대 결과** | HTTP 404, 응답 body에 `{ error: "No segment found for the requested time" }` 또는 유사 메시지 |
| **판정 기준** | PASS: HTTP 404 응답 FAIL: 200 + 빈 videoUrl 또는 500 오류 |

### TC-RWA-F-004: PlaybackTimeline UI 이벤트 마커 클릭 → 해당 시점 이동

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-F-004 |
| **SRS 참조** | FR-RWA-M2-004 |
| **선행 조건** | `PlaybackTimeline.tsx` 구현됨, 녹화 세그먼트 및 알림 이벤트 존재 |
| **테스트 단계** | 1. PlaybackTimeline 컴포넌트 렌더링 2. 알림 이벤트 마커 클릭 3. `<video>` 요소의 `currentTime` 값 확인 |
| **기대 결과** | 마커 클릭 후 `<video>.currentTime`이 해당 이벤트 발생 시각(segmentOffset)으로 이동, ±2초 오차 허용 |
| **판정 기준** | PASS: currentTime 이동 ±2초 이내 FAIL: 이동 없음 또는 오차 > 5초 |

---

## Group G — RTCP 피드백 처리 (M4)

> **전제 조건**: `mediamtxManager.js`에 WHEP 세션 통계 폴링 구현됨, `cameraStatus` Socket.IO 이벤트에 rtcpStats 필드 추가됨.

### TC-RWA-G-001: MediaMTX WHEP 세션 통계 API 폴링

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-G-001 |
| **SRS 참조** | FR-RWA-M4-001 |
| **선행 조건** | M4 구현됨, 브라우저 WHEP 연결 1개 이상 존재 |
| **테스트 단계** | 1. `GET http://localhost:9997/v3/whepsessions/list` 직접 호출하여 응답 구조 확인 2. Node.js 서버 로그에서 주기적 폴링 로그 확인 (`RTCP_POLL_INTERVAL_MS` 기본값 5초) |
| **기대 결과** | MediaMTX API 응답에 `bytesReceived`, `nackCount`, `pliCount` 필드 포함, 서버 로그에 5초 주기 폴링 확인 |
| **판정 기준** | PASS: 통계 필드 존재 + 폴링 로그 확인 FAIL: API 오류 또는 필드 없음 |

### TC-RWA-G-002: cameraStatus Socket.IO 이벤트에 rtcpStats 포함

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-G-002 |
| **SRS 참조** | FR-RWA-M4-002 |
| **선행 조건** | TC-RWA-G-001 성공, Socket.IO 클라이언트 연결됨 |
| **테스트 단계** | 1. Socket.IO `cameraStatus` 이벤트 리스너 등록 2. 10초 대기 후 이벤트 payload 확인 |
| **기대 결과** | `cameraStatus` 이벤트 payload에 `rtcpStats: { bytesReceived, nackCount, pliCount }` 포함 |
| **판정 기준** | PASS: rtcpStats 필드 존재 + 숫자 값 FAIL: rtcpStats 없음 또는 null |

### TC-RWA-G-003: MediaMTX API 조회 실패 시 서버 영향 없음

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-G-003 |
| **SRS 참조** | NFR-RWA-M4-001 |
| **선행 조건** | M4 구현됨, MediaMTX API 포트(:9997) 의도적 차단 |
| **테스트 단계** | 1. `iptables -A OUTPUT -p tcp --dport 9997 -j DROP` (또는 방화벽으로 9997 차단) 2. 30초 대기 3. Node.js 서버 상태 및 AI 파이프라인 동작 확인 |
| **기대 결과** | RTCP 통계 폴링 오류 로그 출력되지만 서버 전체 crash 없음, AI 파이프라인 정상 동작, Socket.IO `frameData` 이벤트 계속 수신 |
| **판정 기준** | PASS: 서버 계속 실행 + AI 파이프라인 정상 FAIL: 서버 crash 또는 AI 파이프라인 중단 |

---

## Group H — 회귀 및 통합

### TC-RWA-H-001: M1/M2 구현 후 기존 AI 파이프라인 회귀

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-H-001 |
| **SRS 참조** | NFR-RWA-REG-001 |
| **선행 조건** | M1, M2 코드 배포됨 |
| **테스트 단계** | 1. `cd server && npm test` 실행 2. `node test/run_all.js` 실행 3. 핵심 API 테스트 통과 여부 확인 |
| **기대 결과** | 기존 테스트 스위트 모두 PASS (0 failures), 감지·추적·알림 API 정상 동작 |
| **판정 기준** | PASS: 전체 테스트 PASS FAIL: 1개 이상 failure |

### TC-RWA-H-002: 카메라 4대 동시 처리 및 녹화 안정성

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-H-002 |
| **SRS 참조** | NFR-RWA-001, NFR-RWA-M1-003 |
| **선행 조건** | M1 완료, RTSP 테스트 카메라 4대, MinIO 실행 중 |
| **테스트 단계** | 1. 카메라 4대 동시 시작 2. 10분 간 운영 3. 각 카메라 세그먼트 생성 수 및 업로드 성공 여부 확인 4. 서버 CPU/메모리 사용량 기록 |
| **기대 결과** | 4대 모두 세그먼트 정상 생성 및 MinIO 업로드 성공, 서버 CPU < 80%, 메모리 증가 없음 |
| **판정 기준** | PASS: 4대 모두 녹화 + 업로드 성공 + 서버 안정 FAIL: 1대 이상 실패 또는 서버 비정상 |

### TC-RWA-H-003: WebRTC 영상 + AI 파이프라인 + 녹화 동시 동작

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-H-003 |
| **SRS 참조** | NFR-RWA-002, FR-RWA-001 |
| **선행 조건** | M1 완료, `record: yes`, 브라우저 WHEP 연결 1개, ingest-daemon 실행 중 |
| **테스트 단계** | 1. 브라우저에서 카메라 WebRTC 영상 재생 확인 2. Socket.IO `frameData` 이벤트 수신 확인 (AI 파이프라인 동작) 3. 녹화 세그먼트 파일 생성 확인 4. 3가지 경로 동시 동작 30초 간 유지 |
| **기대 결과** | WebRTC 영상 재생 중 + frameData 수신 ≥ 8/s + 30초 후 세그먼트 파일 생성됨 (3경로 동시) |
| **판정 기준** | PASS: 3경로 모두 동시 정상 동작 FAIL: 1경로라도 중단 |

### TC-RWA-H-004: 서버 모드 전환 (combined → streaming + analysis) 후 녹화 동작

| 항목 | 내용 |
|---|---|
| **ID** | TC-RWA-H-004 |
| **SRS 참조** | FR-RWA-033, NFR-RWA-REG-002 |
| **선행 조건** | M1 완료, `SERVER_MODE=streaming` + 별도 analysis 서버 실행 중 |
| **테스트 단계** | 1. `SERVER_MODE=streaming`으로 스트리밍 서버 시작 2. 카메라 시작 후 세그먼트 생성 확인 3. analysis 서버로 JPEG POST 전송 확인 |
| **기대 결과** | 스트리밍 서버에서 MediaMTX 녹화 정상 동작, analysis 서버로 AI 추론 요청 전달, 두 기능 동시 동작 |
| **판정 기준** | PASS: 녹화 + 분석 분리 모드 동시 동작 FAIL: 한 기능이 다른 기능을 방해 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-11 | 초기 작성 |
