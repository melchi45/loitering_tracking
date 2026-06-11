# SRS — RTSP·WebRTC Architecture (Ingest-Daemon + MediaMTX + 확장 Milestones)
**Document ID**: SRS-LTS-RWA-01  
**Version**: 1.0  
**Date**: 2026-06-11  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Active  
**Parent PRD**: [prd/PRD_RTSP_WebRTC_Architecture.md](../prd/PRD_RTSP_WebRTC_Architecture.md)

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-06-11 | 초기 명세 — 현재 구현 행동 명세 및 M1-M5 기능 요구사항 정의 |

---

## Table of Contents

1. [Scope](#1-scope)
2. [Current System Behavior Specification](#2-current-system-behavior-specification)
3. [Functional Requirements — M1 (영상 녹화)](#3-functional-requirements--m1-영상-녹화)
4. [Functional Requirements — M2 (Playback API)](#4-functional-requirements--m2-playback-api)
5. [Functional Requirements — M3 (Qdrant Re-ID)](#5-functional-requirements--m3-qdrant-re-id)
6. [Functional Requirements — M4 (RTCP 피드백)](#6-functional-requirements--m4-rtcp-피드백)
7. [Functional Requirements — M5 (분산 클러스터)](#7-functional-requirements--m5-분산-클러스터)
8. [Interface Contracts](#8-interface-contracts)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Error Handling Requirements](#10-error-handling-requirements)
11. [Configuration Reference](#11-configuration-reference)

---

## 1. Scope

본 SRS는 `server/src/services/` 내 RTSP 인제스트 및 WebRTC 스트리밍 파이프라인의 현재 동작을 명세하고, Milestone M1–M5 기능 요구사항을 정의한다.

### 1.1 범위 내

- `ingest-daemon/ingest_daemon.py` — Python PyAV 독립 캡처 데몬
- `server/src/services/ingestDaemonCapture.js` — HTTP POST 수신 EventEmitter
- `server/src/services/captureFactory.js` — CAPTURE_BACKEND 선택 팩토리
- `server/src/services/mediamtxManager.js` — MediaMTX REST API 경로 관리
- `mediamtx.yml` — MediaMTX 미디어 서버 설정
- `server/src/services/faceService.js` — 얼굴 임베딩 Re-ID (현재 in-memory)
- `server/src/services/pipelineManager.js` — AI 서비스 오케스트레이터 (신규 서비스 등록 포함)
- M1: `recordingService.js` (신규)
- M2: `PlaybackTimeline.tsx`, `PlaybackPlayer.tsx` (신규)
- M3: Qdrant 연동 `faceService.js` 교체
- M4: `mediamtxManager.js` stats 폴링 확장
- M5: `kafkaFrameProducer.js`, `kafkaFrameConsumer.js`, `nodePoolManager.js` (신규)

### 1.2 범위 외

- AI 추론 로직 (`detection.js`, `tracking.js`, `behaviorEngine.js`)
- 알림 생성·에스컬레이션 (`alertService.js`)
- 인증·사용자 관리 (`TokenService.js`, `UserService.js`)
- 구역 관리 (`zoneManager.js`)

---

## 2. Current System Behavior Specification

### FR-RWA-CUR-001: IngestDaemonCapture 동작

**파일**: `server/src/services/ingestDaemonCapture.js`

`IngestDaemonCapture`는 Node.js `EventEmitter`를 상속하며, ingest-daemon으로부터 HTTP POST로 수신한 JPEG 프레임을 `frame` 이벤트로 발행한다.

| 속성 | 값 |
|---|---|
| 수신 엔드포인트 | `POST /api/ingest/frame/{camId}` |
| Content-Type | `image/jpeg` |
| 이벤트 | `frame` — `{ camId, buffer: Buffer, timestamp: number }` |
| 에러 이벤트 | `error` — 프레임 파싱 실패 시 |

**동작 명세**:
1. ingest-daemon이 카메라별 JPEG 프레임을 HTTP POST로 전송한다.
2. `IngestDaemonCapture.injectFrame(camId, buffer)` 호출 시 `frame` 이벤트가 발행된다.
3. `pipelineManager`가 `frame` 이벤트를 구독하여 AI 파이프라인(YOLO → ByteTrack)으로 전달한다.
4. 프레임 수신이 `INGEST_FRAME_TIMEOUT_MS`(기본 5000ms) 이상 없으면 `timeout` 이벤트를 발행한다.

---

### FR-RWA-CUR-002: captureFactory CAPTURE_BACKEND 분기

**파일**: `server/src/services/captureFactory.js`

`createCapture(camConfig)` 함수는 환경변수 `CAPTURE_BACKEND`를 읽어 적절한 캡처 인스턴스를 반환한다.

| CAPTURE_BACKEND 값 | 반환 클래스 | 소스 파일 |
|---|---|---|
| `ingest-daemon` (권장·기본값) | `IngestDaemonCapture` | `ingestDaemonCapture.js` |
| `gstreamer` | `GStreamerCapture` | `gstreamerCapture.js` |
| `pyav` | `PyAVCapture` | `pyavCapture.js` |
| `ffmpeg` 또는 미설정 또는 알 수 없는 값 | `RTSPCapture` | `rtspCapture.js` (폴백, 경고 출력) |

**제약 조건**:
- 모든 캡처 클래스는 `EventEmitter`를 상속하고 `frame` 이벤트를 발행해야 한다.
- 신규 백엔드 추가 시 `captureFactory.js`의 switch/if 분기만 수정, 상위 코드 변경 금지.

---

### FR-RWA-CUR-003: FORCE_NO_WEBRTC 조건

**파일**: `server/src/services/pipelineManager.js`

다음 조건이 모두 참일 때 WebRTC 기능이 강제 비활성화된다:

```javascript
const FORCE_NO_WEBRTC =
  process.env.CAPTURE_BACKEND === 'ingest-daemon' &&
  process.env.WEBRTC_ENGINE === 'mediasoup';
```

| 조건 | FORCE_NO_WEBRTC | 비고 |
|---|---|---|
| `ingest-daemon` + `mediamtx` | `false` | 정상 동작, WHEP 활성 |
| `ingest-daemon` + `mediasoup` | `true` | WebRTC 강제 비활성 |
| `ffmpeg` + `mediamtx` | `false` | 레거시 폴백 동작 |
| `ffmpeg` + `mediasoup` | `false` | 레거시 mediasoup 동작 |

`FORCE_NO_WEBRTC === true` 시 `mediamtxManager.startAll()` 호출이 스킵된다.

---

### FR-RWA-CUR-004: mediamtxManager 경로 등록

**파일**: `server/src/services/mediamtxManager.js`

`mediamtxManager`는 MediaMTX REST API를 통해 카메라 경로를 등록·해제한다.

| 작업 | HTTP 메서드 | 엔드포인트 |
|---|---|---|
| 경로 등록 | `POST` | `http://localhost:9997/v3/config/paths/add/{camId}` |
| 경로 해제 | `DELETE` | `http://localhost:9997/v3/config/paths/remove/{camId}` |
| 경로 목록 조회 | `GET` | `http://localhost:9997/v3/paths/list` |
| 경로 상태 조회 | `GET` | `http://localhost:9997/v3/paths/get/{camId}` |

**경로 등록 요청 바디**:
```json
{
  "source": "rtsp://[username]:[password]@[ip]:[port]/[path]",
  "sourceOnDemand": false,
  "runOnDemand": ""
}
```

**동작 명세**:
1. 서버 시작 시 DB에서 모든 카메라를 로드하여 `startAll()` 메서드로 일괄 등록한다.
2. 카메라 추가 API(`POST /api/cameras`) 호출 시 `addPath(camId, rtspUrl)` 메서드로 단건 등록한다.
3. 카메라 삭제 시 `removePath(camId)` 메서드로 해제한다.
4. MediaMTX API 응답 코드 `200` 또는 `201`이 아닌 경우 에러 로그 출력 후 5초 후 재시도(최대 3회).

---

### FR-RWA-CUR-005: WHEP 연결

**파일**: `server/src/routes/` 또는 MediaMTX 직접 처리

브라우저 클라이언트가 WHEP(WebRTC-HTTP Egress Protocol) 표준으로 MediaMTX에 직접 연결한다.

| 속성 | 값 |
|---|---|
| WHEP 엔드포인트 | `POST http://[host]:8889/{camId}/whep` |
| 요청 Content-Type | `application/sdp` |
| 요청 바디 | SDP offer |
| 응답 상태 코드 | `201 Created` |
| 응답 Content-Type | `application/sdp` |
| 응답 바디 | SDP answer |

**동작 명세**:
1. 브라우저가 `RTCPeerConnection.createOffer()` 후 SDP를 WHEP 엔드포인트에 POST한다.
2. MediaMTX가 SDP answer를 반환하고 ICE candidate 교환을 처리한다.
3. UDP 8189 포트로 미디어 스트림이 전송된다.
4. `CameraView.tsx`는 WHEP URL을 생성하여 `RTCPeerConnection.setRemoteDescription()`으로 연결을 수립한다.

---

### FR-RWA-CUR-006: ingest-daemon HTTP POST 프레임 수신

**파일**: `ingest-daemon/ingest_daemon.py`

ingest-daemon이 RTSP 스트림에서 프레임을 읽어 Node.js 서버와 MediaMTX에 동시 전송한다.

| 경로 | 메서드 | 용도 |
|---|---|---|
| `/api/ingest/frame/{camId}` | POST | Node.js AI 파이프라인용 JPEG 프레임 전송 |
| MediaMTX RTSP push | RTSP | WebRTC 스트리밍용 스트림 전달 |

**동작 명세**:
1. `ingest_daemon.py`는 카메라 RTSP URL을 PyAV로 열어 H.264 스트림을 디코딩한다.
2. 매 프레임마다 JPEG로 인코딩 후 `http://localhost:3080/api/ingest/frame/{camId}`에 POST한다.
3. 동시에 PyAV RTSP 출력 스트림을 `rtsp://localhost:8554/{camId}`로 push한다.
4. POST 실패(5xx, 연결 거부) 시 재시도 없이 다음 프레임으로 진행 (프레임 손실 허용).
5. RTSP 스트림 연결 실패 시 10초 대기 후 재연결 시도.

---

## 3. Functional Requirements — M1 (영상 녹화)

### FR-RWA-M1-001: MediaMTX 세그먼트 녹화 활성화

**구현 파일**: `mediamtx.yml`

| 항목 | 요구사항 |
|---|---|
| 경로별 설정 | `paths.{camId}.record: yes` |
| 세그먼트 길이 | `recordSegmentDuration: 10m` (기본값, `RECORD_SEGMENT_MINUTES`로 조정) |
| 출력 파일 패턴 | `recordPath: ./recordings/{camId}/{camId}_%Y-%m-%d_%H-%M-%S.mp4` |
| 컨테이너 형식 | MP4 (H.264 + AAC) |
| 녹화 완료 훅 | `runOnRecordSegmentComplete: POST http://localhost:3080/api/recording/segment-complete` |

MediaMTX는 세그먼트 완료 시 `runOnRecordSegmentComplete`에 설정된 URL로 HTTP POST를 전송한다. 이 훅이 `recordingService.js`의 MinIO 업로드를 트리거한다.

---

### FR-RWA-M1-002: recordingService 생명주기 관리

**구현 파일**: `server/src/services/recordingService.js`

1. `pipelineManager.js`가 서버 시작 시 `recordingService.init()` 호출.
2. `recordingService`는 세그먼트 완료 POST를 수신하는 Express 라우터를 `/api/recording/segment-complete`에 등록.
3. `RECORDING_ENABLED=false` 환경변수 설정 시 `init()` 즉시 반환, 모든 녹화 비활성화.
4. `recordingService.startRecording(camId)` / `stopRecording(camId)` 메서드 제공.

| 메서드 | 역할 |
|---|---|
| `init()` | 라우터 등록, MinIO 클라이언트 초기화 |
| `startRecording(camId)` | 해당 카메라 MediaMTX 경로에 `record: yes` 패치 |
| `stopRecording(camId)` | 해당 카메라 MediaMTX 경로에 `record: no` 패치 |
| `onSegmentComplete(payload)` | MinIO 업로드 큐에 세그먼트 추가 |

---

### FR-RWA-M1-003: MinIO 업로드

**구현 파일**: `server/src/services/recordingService.js`

1. 세그먼트 완료 시 로컬 MP4 파일을 MinIO 버킷에 업로드.
2. 업로드 실패 시 최대 3회 재시도 (지수 백오프: 5s, 10s, 20s).
3. 3회 모두 실패 시 로컬 파일 보존, `recordingError` Socket.IO 이벤트 발행.
4. 업로드 성공 후 로컬 임시 파일 삭제.
5. 버킷 경로: `{MINIO_BUCKET}/{camId}/{YYYY-MM-DD}/{filename}`.

---

### FR-RWA-M1-004: 녹화 메타데이터 DB 저장

**구현 파일**: `server/src/services/recordingService.js`, `server/src/db.js`

녹화 세그먼트 업로드 완료 후 `db.js`를 통해 메타데이터를 저장한다.

```javascript
// recordings 컬렉션 스키마
{
  id: String,           // UUID
  camId: String,
  startAt: Number,      // Unix timestamp (ms)
  endAt: Number,        // Unix timestamp (ms)
  duration: Number,     // 초
  s3Key: String,        // MinIO 오브젝트 키
  size: Number,         // 바이트
  status: 'uploaded' | 'failed' | 'local-only'
}
```

---

### FR-RWA-M1-005: 녹화 제어 API

**구현 파일**: `server/src/routes/admin.js` 또는 신규 `recordings.js`

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/recordings` | 녹화 목록 (query: camId, startDate, endDate, limit) |
| `POST` | `/api/recording/:camId/start` | 카메라 녹화 시작 |
| `POST` | `/api/recording/:camId/stop` | 카메라 녹화 중지 |
| `DELETE` | `/api/recordings/:id` | 특정 녹화 삭제 (MinIO + DB) |

모든 엔드포인트는 JWT 인증 필수. 삭제 작업은 `AuditService.js`로 감사 로그 기록.

---

## 4. Functional Requirements — M2 (Playback API)

### FR-RWA-M2-001: 세그먼트 목록 API

**구현 파일**: `server/src/routes/` 신규 `playback.js`

```
GET /api/playback/segments?cam={camId}&startTs={unix}&endTs={unix}&limit={n}
```

1. `startTs`–`endTs` 범위와 겹치는 모든 세그먼트를 시간순 정렬하여 반환.
2. `limit` 기본값 100, 최대 500.
3. 각 세그먼트에 MinIO Presigned URL 포함 (`RECORDING_PRESIGNED_TTL_SECONDS` 기본 3600초).
4. 응답 스키마:
```json
{
  "segments": [
    {
      "id": "string",
      "camId": "string",
      "startTs": 0,
      "endTs": 0,
      "duration": 0,
      "url": "string"
    }
  ],
  "total": 0
}
```

---

### FR-RWA-M2-002: 특정 시점 재생 URL API

```
GET /api/playback?cam={camId}&ts={unixTimestamp}
```

1. `ts`를 포함하는 세그먼트를 DB에서 조회.
2. 세그먼트 `startAt`과 `ts`의 차이를 `seekOffset`(초)으로 계산.
3. Presigned URL + seekOffset 반환.
4. 해당 시점의 세그먼트가 없으면 `404` 반환.

---

### FR-RWA-M2-003: 이벤트 연동 재생 API

```
GET /api/playback/event/{alertId}
```

1. `alertId`로 알림 발생 시각(`alert.createdAt`) 조회.
2. `createdAt - 30초` ~ `createdAt + 30초` 범위 세그먼트 반환.
3. `seekOffset` = `createdAt - segment.startAt - 30`.
4. 알림이 없으면 `404`, 해당 시점 녹화가 없으면 `200 { url: null, reason: "no_recording" }` 반환.

---

### FR-RWA-M2-004: PlaybackTimeline.tsx 컴포넌트

**구현 파일**: `client/src/components/PlaybackTimeline.tsx`

1. 24시간 타임라인 바 — 녹화 세그먼트를 색상 블록으로 표시.
2. 알림 발생 시점은 빨간 마커로 표시.
3. 타임라인 클릭 → `GET /api/playback?cam={camId}&ts={ts}` 호출 → 재생.
4. Zustand 스토어 `usePlaybackStore`로 현재 재생 위치 공유.

---

### FR-RWA-M2-005: PlaybackPlayer.tsx 컴포넌트

**구현 파일**: `client/src/components/PlaybackPlayer.tsx`

1. HTML5 `<video>` 태그로 Presigned URL 재생.
2. `seekOffset` 수신 시 `video.currentTime = seekOffset` 설정.
3. 현재 세그먼트 종료 10초 전 다음 세그먼트 URL 프리패치.
4. 다음 세그먼트 시작 시 자동 전환 (무중단 재생).
5. `CameraView.tsx`에 "Live" / "Playback" 탭 전환 UI 추가.

---

## 5. Functional Requirements — M3 (Qdrant Re-ID)

### FR-RWA-M3-001: Qdrant 컬렉션 초기화

**구현 파일**: `server/src/services/faceService.js`

1. 서버 시작 시 `faceService.init()`에서 Qdrant 컬렉션 존재 여부 확인.
2. 없으면 자동 생성:
```json
{
  "name": "face_embeddings",
  "vectors": {
    "size": 512,
    "distance": "Cosine"
  }
}
```
3. `FACE_EMBEDDING_DIM` 환경변수로 차원 조정 (기본 512).
4. Qdrant 연결 실패 시 인메모리 폴백 활성화 + 경고 로그.

---

### FR-RWA-M3-002: 얼굴 임베딩 저장 (Upsert)

**구현 파일**: `server/src/services/faceService.js`

```
POST /collections/face_embeddings/points
```

1. `registerFace(personId, embedding, metadata)` 호출 시 Qdrant에 Upsert.
2. 포인트 ID: `personId`의 UUID.
3. 페이로드: `{ personId, camId, registeredAt, name, thumbnailKey }`.
4. 기존 `POST /api/faces/register` API 시그니처 변경 없음.

---

### FR-RWA-M3-003: 얼굴 검색 (ANN Search)

**구현 파일**: `server/src/services/faceService.js`

```
POST /collections/face_embeddings/points/search
```

1. `searchFace(embedding, topK=5)` 호출 시 코사인 유사도 ANN 검색.
2. `score >= FACE_REID_THRESHOLD`(기본 0.75)인 결과만 반환.
3. 기존 `POST /api/faces/search` API 시그니처 변경 없음.
4. 응답에 `score` 필드 추가 (하위 호환 — 기존 클라이언트는 무시).

---

### FR-RWA-M3-004: 데이터 마이그레이션 스크립트

**구현 파일**: `server/src/scripts/migrateEmbeddingsToQdrant.js`

1. `storage/face_tracking.json`의 임베딩 배열을 Qdrant에 배치 업로드 (배치 크기: 100).
2. 마이그레이션 전 자동 백업: `storage/face_tracking.json.bak`.
3. 완료 후 성공/실패 건수 출력.
4. 실행: `node server/src/scripts/migrateEmbeddingsToQdrant.js`.

---

## 6. Functional Requirements — M4 (RTCP 피드백)

### FR-RWA-M4-001: MediaMTX Stats 폴링

**구현 파일**: `server/src/services/mediamtxManager.js`

1. `startStatsPoll(camId)` 메서드 — 주기적으로 MediaMTX stats API 호출.
2. 엔드포인트: `GET http://localhost:9997/v3/paths/get/{camId}`.
3. 폴링 주기: `RTCP_STATS_INTERVAL_MS` 기본 5000ms.
4. 수집 지표: `bytesReceived`, `bytesSent`, `framesDecoded`, `packetsLost`, `rtt`.
5. 지표 이상값 감지 시 `statsAlert` 이벤트 발행.

---

### FR-RWA-M4-002: PLI (Picture Loss Indication) 트리거

**구현 파일**: `server/src/services/mediamtxManager.js`

1. 다음 조건 중 하나 충족 시 PLI 요청:
   - `packetsLost / totalPackets > RTCP_PLI_THRESHOLD` (기본 5%)
   - `framesDecoded` 값이 10초 이상 증가 없음 (영상 프리즈 감지)
2. MediaMTX 키프레임 요청: `POST http://localhost:9997/v3/paths/{camId}/keyframeRequest` (MediaMTX 버전 지원 시).
3. PLI 트리거 후 500ms 이내 `framesDecoded` 증가 없으면 Socket.IO `cameraStatus` 이벤트로 클라이언트 알림.

---

### FR-RWA-M4-003: REMB 대역폭 조정

**구현 파일**: `server/src/services/mediamtxManager.js`

1. `rtt > 150ms` 지속 (3회 이상 연속) 감지 시 비트레이트 하향.
2. MediaMTX 경로 설정 PATCH: `maxVideoMbitps = Math.max(RTCP_REMB_MIN_BITRATE_KBPS/1000, currentBitrate * 0.7)`.
3. `rtt < 50ms` 복구 후 비트레이트 점진적 상향 (10%/5초, 최대 `RTCP_REMB_MAX_BITRATE_KBPS`).

---

## 7. Functional Requirements — M5 (분산 클러스터)

### FR-RWA-M5-001: Kafka 프레임 Producer

**구현 파일**: `server/src/services/kafkaFrameProducer.js`

1. `KAFKA_ENABLED=true` 시 ingest-daemon으로부터 수신한 프레임을 Kafka `raw-frames` 토픽에 발행.
2. 메시지 키: `camId` (파티션 라우팅).
3. 메시지 값: `{ camId, timestamp, jpegBuffer (base64) }`.
4. `KAFKA_ENABLED=false` 시 기존 인프로세스 파이프라인 유지 (비호환 변경 없음).
5. Kafka 연결 실패 시 인프로세스 폴백 + 경고 로그.

---

### FR-RWA-M5-002: Kafka 프레임 Consumer (GPU 노드)

**구현 파일**: `server/src/services/kafkaFrameConsumer.js`

1. `analysis` 모드 서버에서 `raw-frames` 토픽 소비.
2. 컨슈머 그룹: `lts-analysis-workers`.
3. 파티션 자동 할당 (Kafka 컨슈머 그룹 리밸런싱).
4. 소비한 프레임을 `pipelineManager`의 AI 파이프라인으로 전달.
5. 처리 완료 후 결과를 `analysis-results` 토픽에 발행.

---

### FR-RWA-M5-003: 노드 풀 관리자

**구현 파일**: `server/src/services/nodePoolManager.js`

1. 분석 노드 등록: `POST /api/cluster/nodes` `{ nodeId, host, port, gpuCount }`.
2. 헬스체크: 각 노드 `GET /health` 3초 주기, 3회 연속 실패 시 `offline` 상태로 변경.
3. `offline` 노드의 Kafka 파티션은 나머지 노드로 자동 리밸런싱.
4. 페일오버 목표 시간: < 30초.
5. `GET /api/cluster/status` — 노드 풀 상태, 카메라별 노드 할당 정보 반환.

---

### FR-RWA-M5-004: 분산 환경 WebRTC Sticky Session

1. 클라이언트의 WebRTC 연결은 카메라를 담당하는 MediaMTX 노드로 고정(sticky).
2. 로드 밸런서(Nginx)가 `X-Camera-Id` 헤더 기반으로 upstream 라우팅.
3. `GET /api/cluster/cameras/{camId}/node` — 카메라 담당 노드 정보 반환.

---

## 8. Interface Contracts

### 8.1 ingest-daemon HTTP API

| 엔드포인트 | 메서드 | Content-Type | 설명 |
|---|---|---|---|
| `/api/ingest/frame/{camId}` | POST | `image/jpeg` | JPEG 프레임 수신 |
| `/api/ingest/status` | GET | `application/json` | 데몬 상태 조회 |
| `/api/ingest/cameras` | GET | `application/json` | 활성 카메라 목록 |

**프레임 POST 응답**:
- `200 OK` — 수신 성공
- `404 Not Found` — 등록되지 않은 `camId`
- `413 Payload Too Large` — 프레임 크기 > 2MB

### 8.2 MediaMTX REST API

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/v3/config/paths/add/{id}` | POST | 경로 등록 |
| `/v3/config/paths/remove/{id}` | DELETE | 경로 해제 |
| `/v3/paths/list` | GET | 활성 경로 목록 |
| `/v3/paths/get/{id}` | GET | 경로 상태·통계 |
| `/v3/config/paths/patch/{id}` | PATCH | 경로 설정 런타임 변경 |

### 8.3 WHEP API

| 속성 | 값 |
|---|---|
| 엔드포인트 | `POST http://{host}:8889/{camId}/whep` |
| 요청 헤더 | `Content-Type: application/sdp` |
| 요청 바디 | RFC 8866 SDP offer |
| 응답 상태 | `201 Created` |
| 응답 헤더 | `Content-Type: application/sdp`, `Location: /whep/{sessionId}` |
| 응답 바디 | RFC 8866 SDP answer |

### 8.4 녹화 세그먼트 완료 훅

MediaMTX → Node.js 세그먼트 완료 통보:

```
POST /api/recording/segment-complete
Content-Type: application/json

{
  "path": "/recordings/{camId}/{camId}_2026-06-11_12-00-00.mp4",
  "camId": "{camId}",
  "startTs": 1749600000,
  "endTs": 1749600600,
  "duration": 600
}
```

---

## 9. Non-Functional Requirements

### 9.1 성능

| 항목 | 요구사항 | 측정 방법 |
|---|---|---|
| E2E 레이턴시 | < 300 ms | 카메라 타임스탬프 vs 브라우저 수신 시각 |
| WebRTC 연결 수립 | < 3 s | `RTCPeerConnection` 상태 변경 시각 |
| ingest-daemon 재시작 복구 | < 10 s | 재시작 → 첫 프레임 수신 시간 |
| MediaMTX 경로 재등록 | < 5 s | 서버 시작 → WHEP 연결 가능 시점 |
| Playback API 응답 | < 200 ms (p95) | 서버 처리 시간 (MinIO presign 포함) |
| Qdrant Re-ID 쿼리 | < 50 ms (p95) | ANN 검색 레이턴시 |

### 9.2 신뢰성

| 항목 | 요구사항 |
|---|---|
| WebRTC 연결 성공률 | ≥ 99% (7일 연속 측정) |
| 시스템 월간 가용성 | ≥ 99.5% |
| 녹화 세그먼트 손실 | 0 프레임/분 (네트워크 정상 조건) |
| M5 노드 페일오버 | < 30 s |

### 9.3 보안

| 항목 | 요구사항 |
|---|---|
| RTSP URL 자격증명 | 로그 출력 금지, 마스킹 처리 |
| Presigned URL TTL | 기본 1시간, 최대 24시간 |
| 녹화 API | JWT 인증 필수 (`Authorization: Bearer <token>`) |
| Qdrant API 키 | `QDRANT_API_KEY` 환경변수, 코드 하드코딩 금지 |
| MinIO 자격증명 | `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` 환경변수 |

---

## 10. Error Handling Requirements

### 10.1 ingest-daemon 연결 실패

| 오류 상황 | 처리 방법 |
|---|---|
| HTTP POST 타임아웃 (> `INGEST_FRAME_TIMEOUT_MS`) | `timeout` 이벤트 발행, 다음 프레임 대기 |
| 카메라 RTSP 연결 끊김 | 10초 후 재연결, Socket.IO `cameraStatus: disconnected` 발행 |
| ingest-daemon 프로세스 종료 | `npm run ingest:restart` 자동 또는 수동 재시작 |

### 10.2 MediaMTX 연결 실패

| 오류 상황 | 처리 방법 |
|---|---|
| REST API 응답 4xx | 에러 로그 + 즉시 반환 (재시도 없음) |
| REST API 응답 5xx | 5초 후 재시도, 최대 3회 |
| MediaMTX 프로세스 미실행 | 서버 시작 시 30초 대기 후 자동 재시도 |
| WHEP 연결 실패 (클라이언트) | `CameraView.tsx`에서 5초 후 재시도, 최대 5회 |

### 10.3 MinIO 업로드 실패 (M1)

| 오류 상황 | 처리 방법 |
|---|---|
| 네트워크 오류 | 지수 백오프 재시도 (5s, 10s, 20s) |
| 3회 재시도 모두 실패 | 로컬 파일 보존, `recordingError` Socket.IO 이벤트 |
| 버킷 없음 | `recordingService.init()` 시 자동 생성 |

### 10.4 Qdrant 연결 실패 (M3)

| 오류 상황 | 처리 방법 |
|---|---|
| 초기 연결 실패 | 인메모리 폴백 자동 활성화 + `WARN` 로그 |
| 검색 중 오류 | 빈 배열 반환 + `ERROR` 로그 |
| Upsert 중 오류 | 실패 기록 로그, 다음 임베딩 계속 처리 |

---

## 11. Configuration Reference

### 11.1 현재 구현 환경변수

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `CAPTURE_BACKEND` | `ingest-daemon` | 캡처 백엔드 선택 |
| `WEBRTC_ENGINE` | `mediamtx` | WebRTC 엔진 선택 |
| `MEDIAMTX_API_URL` | `http://localhost:9997` | MediaMTX REST API URL |
| `MEDIAMTX_RTSP_URL` | `rtsp://localhost:8554` | MediaMTX RTSP URL |
| `MEDIAMTX_WHEP_URL` | `http://localhost:8889` | MediaMTX WHEP URL |
| `INGEST_DAEMON_URL` | `http://localhost:7070` | ingest-daemon 베이스 URL |
| `INGEST_FRAME_TIMEOUT_MS` | `5000` | 프레임 수신 타임아웃(ms) |

### 11.2 M1 환경변수 (녹화)

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `RECORDING_ENABLED` | `false` | 녹화 기능 전역 활성화 |
| `RECORD_SEGMENT_MINUTES` | `10` | 녹화 세그먼트 길이(분) |
| `MINIO_ENDPOINT` | `http://localhost:9000` | MinIO 엔드포인트 |
| `MINIO_ACCESS_KEY` | — | MinIO 액세스 키 |
| `MINIO_SECRET_KEY` | — | MinIO 시크릿 키 |
| `MINIO_BUCKET` | `lts-recordings` | 녹화 저장 버킷명 |
| `RECORDING_PRESIGNED_TTL_SECONDS` | `3600` | Presigned URL 유효기간(초) |
| `RECORDING_LOCAL_PATH` | `./recordings` | 로컬 임시 저장 경로 |

### 11.3 M3 환경변수 (Qdrant Re-ID)

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `REID_BACKEND` | `qdrant` | Re-ID 백엔드 (`qdrant` \| `memory`) |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant REST API URL |
| `QDRANT_API_KEY` | — | Qdrant 인증 키 (선택) |
| `QDRANT_COLLECTION` | `face_embeddings` | 컬렉션명 |
| `FACE_EMBEDDING_DIM` | `512` | 임베딩 벡터 차원 |
| `FACE_REID_THRESHOLD` | `0.75` | Re-ID 유사도 임계값 |

### 11.4 M4 환경변수 (RTCP)

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `RTCP_STATS_ENABLED` | `false` | RTCP 통계 폴링 활성화 |
| `RTCP_STATS_INTERVAL_MS` | `5000` | 폴링 주기(ms) |
| `RTCP_PLI_THRESHOLD` | `0.05` | PLI 트리거 패킷 손실률 |
| `RTCP_REMB_MIN_BITRATE_KBPS` | `500` | 최소 비트레이트(kbps) |
| `RTCP_REMB_MAX_BITRATE_KBPS` | `4000` | 최대 비트레이트(kbps) |

### 11.5 M5 환경변수 (분산 클러스터)

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `KAFKA_ENABLED` | `false` | Kafka 분산 파이프라인 활성화 |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka 브로커 주소(콤마 구분) |
| `KAFKA_RAW_FRAMES_TOPIC` | `raw-frames` | 원시 프레임 토픽명 |
| `KAFKA_RESULTS_TOPIC` | `analysis-results` | 분석 결과 토픽명 |
| `KAFKA_CONSUMER_GROUP` | `lts-analysis-workers` | 컨슈머 그룹 ID |
| `CLUSTER_HEALTH_CHECK_INTERVAL_MS` | `3000` | 노드 헬스체크 주기(ms) |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-11 | 초기 명세 — 현재 구현(FR-RWA-CUR-001~006) 및 M1-M5 기능 요구사항(FR-RWA-M1~M5) 정의 |
