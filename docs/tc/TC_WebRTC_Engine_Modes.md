# TEST CASES (TC)
# WebRTC Engine Modes (mediamtx / mediasoup)

| | |
|---|---|
| **Document ID** | TC-LTS-WEM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-23 |
| **Parent SRS** | srs/SRS_WebRTC_Engine_Modes.md |
| **Test Scripts** | test/api/webrtc_engine_modes.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Engine Selection & Config](#3-test-group-a--engine-selection--config)
4. [Test Group B — mediamtx Flow](#4-test-group-b--mediamtx-flow)
5. [Test Group C — mediasoup Flow](#5-test-group-c--mediasoup-flow)
6. [Test Group D — Diagnostics](#6-test-group-d--diagnostics)
7. [Test Execution Order](#7-test-execution-order)
8. [Pass/Fail Criteria](#8-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | `/api/webrtc/ice-test`, `/api/webrtc/whep/:id`, `/health` 계약 검증 — 현재 서버에 설정된 엔진 기준 | Node.js `fetch` | `test/api/webrtc_engine_modes.test.js` |
| Integration (수동/Phase-2) | mediamtx 경로 등록·WHEP 실재생, mediasoup Worker Pool·alt-PT 파이프라인 실동작 | 카메라+브라우저 필요 | 미자동화 — §4/§5 수동 절차 |

> 이 TC 세트는 서버가 **하나의 엔진으로 이미 기동된 상태**에서 그 엔진의 공통 계약(요청/응답 스키마)을 검증한다. 엔진을 코드 한 번의 실행으로 양쪽 다 띄워 비교하는 것은 서버 재시작이 필요해 범위 밖이며(§1.1 Integration 참고), 그런 비교는 `docs/ops/WebRTC_Engine_Modes_Guide.md` §3 절차를 사람이 수동으로 두 번 수행해 검증한다.

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-WEM-001 | TC-A-001 |
| FR-WEM-002 | TC-A-002 (수동 — §3 비고) |
| FR-WEM-003 | TC-A-003 (수동) |
| FR-WEM-004 | TC-A-004 |
| FR-WEM-010~015 | TC-B-001 ~ TC-B-006 (수동/Integration) |
| FR-WEM-020~025 | TC-C-001 ~ TC-C-006 (수동/Integration) |
| FR-WEM-030 | TC-D-001 |
| FR-WEM-031 | TC-D-002 (수동 — 엔진 다운 상태 재현 필요) |
| FR-WEM-032 | TC-D-003 (수동 — 원격 IP 스푸핑 필요) |
| FR-WEM-033 | TC-D-004 |

---

## 2. Test Environment and Prerequisites

- 서버가 `http://localhost:3080` (또는 `LTS_URL`)에서 기동 중
- `GET /health` → `status: 'ok'`
- 현재 `server/.env`의 `WEBRTC_ENGINE` 값을 사전에 확인(`mediamtx` 또는 `mediasoup`) — 테스트는 이 값에 맞춰 동적으로 기대값을 조정한다.

---

## 3. Test Group A — Engine Selection & Config

### TC-A-001 — ice-test 응답의 engine 필드가 현재 설정과 일치
- **SRS:** FR-WEM-001, FR-WEM-030
- **Input:** `POST /api/webrtc/ice-test`
- **Expected:** HTTP 200 (엔진 healthy 시) 또는 503(unhealthy 시); 200인 경우 `engine` 필드가 mediamtx면 `"mediamtx-whep"`, mediasoup이면 `"mediasoup"`
- **Acceptance:** 응답 `engine` 값이 `WEBRTC_ENGINE` 설정과 모순되지 않음
- **Test script:** `test/api/webrtc_engine_modes.test.js` — TC-A-001

### TC-A-002 — WEBRTC_ENGINE 미설정 시 mediamtx 폴백 (수동)
- **SRS:** FR-WEM-002
- **Input:** `server/.env`에서 `WEBRTC_ENGINE` 라인을 주석 처리 후 서버 기동
- **Expected:** 서버 시작 로그에 `Unknown WEBRTC_ENGINE` 또는 유사 경고 없이 `mediamtx`로 동작(값 자체가 없으면 경고 없이 기본값 채택; 값이 오타 등 유효하지 않으면 `[WebRTC] Unknown WEBRTC_ENGINE="..."` 경고 출력)
- **Acceptance:** `POST /api/webrtc/ice-test`의 `engine`이 `mediamtx-whep`
- **비고:** `.env` 조작 후 재시작이 필요해 CI 자동화 대상에서 제외 — 배포 전 수동 1회 확인 권장

### TC-A-003 — 런타임 중 엔진 재선택 없음 (수동)
- **SRS:** FR-WEM-003
- **Input:** 서버 기동 중 `server/.env`의 `WEBRTC_ENGINE`을 변경(파일만 수정, 재시작 없음)
- **Expected:** 이미 기동된 프로세스의 `POST /api/webrtc/ice-test` 응답은 변경 전 값을 계속 반환
- **Acceptance:** 재시작 전까지 `engine` 필드 불변

### TC-A-004 — 엔진 공통 인터페이스 존재
- **Input:** 소스 코드 검사 — `mediamtxEngine.js`, `mediasoupEngine.js` 각각의 `module.exports`
- **Expected:** 두 파일 모두 `ENGINE_NAME`, `addCameraStream`, `removeCameraStream`, `waitForStreamReady`, `negotiate`, `isHealthy`, `getEngineInfo`를 export
- **Acceptance:** 7개 심볼 모두 두 파일에 존재 (정적 검사, 자동화 시 `require()` 후 `typeof` 체크로 구현 가능)
- **Test script:** `test/api/webrtc_engine_modes.test.js` — TC-A-004 (같은 프로세스에서 두 엔진 모듈을 `require`만 하고 인터페이스 shape만 확인 — 실제 부팅은 하지 않음)

---

## 4. Test Group B — mediamtx Flow (수동/Integration, `WEBRTC_ENGINE=mediamtx` 필요)

### TC-B-001 — 카메라 시작 시 MediaMTX 경로 등록
- **SRS:** FR-WEM-010
- **Input:** `webrtcEnabled: true`인 카메라를 `POST /api/cameras`로 추가
- **Expected:** 서버 로그에 MediaMTX 경로 등록 성공 로그, `curl http://127.0.0.1:9997/v3/paths/get/<cameraId>`가 200
- **Acceptance:** MediaMTX API가 해당 카메라 경로를 인식

### TC-B-002 — MediaMTX 업스트림 대기 타임아웃 시 비차단
- **SRS:** FR-WEM-011
- **Input:** 존재하지 않는 RTSP URL로 카메라 추가
- **Expected:** 8초 후 경고 로그(`MediaMTX upstream not ready after 8 s`)와 함께 카메라 시작 자체는 계속 진행(에러로 전체 실패하지 않음)
- **Acceptance:** 카메라 레코드가 `error` 상태로 멈추지 않고 재시도 루프에 진입

### TC-B-003 — AI 프레임 소스가 MediaMTX 루프백으로 전환
- **SRS:** FR-WEM-012
- **Input:** TC-B-001 이후 ingest-daemon 등록 로그 확인
- **Expected:** `Ingest daemon registered → AI:rtsp://127.0.0.1:8554/<cameraId>`
- **Acceptance:** 로그의 AI 소스 URL이 원본 카메라 URL이 아닌 루프백

### TC-B-004 — App RTP는 원본 카메라 URL 사용
- **SRS:** FR-WEM-013
- **Input:** TC-B-001 이후 ONVIF 이벤트 발생(테스트 카메라가 지원 시)
- **Expected:** `GET /api/onvif-events?cameraId=<id>`에 이벤트 기록됨
- **Acceptance:** MediaMTX 등록 여부와 무관하게 ONVIF 이벤트 수신

### TC-B-005 — YouTube 카메라 이중 등록 없음
- **SRS:** FR-WEM-014
- **Input:** `POST /api/youtube-streams`로 YouTube 소스 추가
- **Expected:** MediaMTX API에 `/yt/<id>` 경로 1개만 존재(추가 경로 생성 없음)
- **Acceptance:** `curl http://127.0.0.1:9997/v3/paths/list`에 해당 카메라 경로가 정확히 1개

### TC-B-006 — WHEP 프록시 SDP 교환
- **SRS:** FR-WEM-015
- **Input:** 브라우저(또는 `curl -X POST --data-binary @offer.sdp -H 'Content-Type: application/sdp' http://localhost:3080/api/webrtc/whep/<id>`)
- **Expected:** HTTP 201 + SDP answer body, `Location`/`Link` 헤더 포함
- **Acceptance:** 반환된 SDP answer로 ICE/DTLS 연결 성공, 영상 재생 확인

---

## 5. Test Group C — mediasoup Flow (수동/Integration, `WEBRTC_ENGINE=mediasoup` 필요)

### TC-C-001 — ingest-daemon 단일 요청 등록
- **SRS:** FR-WEM-020
- **Input:** 카메라 추가 시 ingest-daemon 로그 확인
- **Expected:** `POST /cameras` 요청 바디에 `mediasoupAudioPort` 포함, 별도의 AI-only 등록 요청이 발생하지 않음(단, `videoOnly` 카메라는 오디오 관련 필드 생략)
- **Acceptance:** ingest-daemon 로그에 단일 등록 확인

### TC-C-002 — Worker 배정 결정론성
- **SRS:** FR-WEM-021
- **Input:** 동일 카메라를 재시작(pause/resume 또는 reconnect) 반복
- **Expected:** `cam.workerIndex`가 매번 동일(로그 또는 `/api/webrtc/monitor`의 `producerStats`로 간접 확인)
- **Acceptance:** Worker 배정 불변

### TC-C-003 — alt-PT 파이프라인 생성 및 재사용
- **SRS:** FR-WEM-022
- **Input:** PT=108이 아닌 브라우저(예: 특정 Chrome 버전)로 WHEP 연결
- **Expected:** 서버 로그에 `alt-pipeline ready ... videoPt=<PT>`, 동일 PT의 두 번째 뷰어는 재생성 로그 없이 재사용
- **Acceptance:** 두 번째 연결 시 alt-PT Router 재생성 로그가 나타나지 않음

### TC-C-004 — Worker 사망 시 영향 범위 격리
- **SRS:** FR-WEM-023
- **Input:** 특정 Worker에 배정된 카메라들이 다수 스트리밍 중일 때 해당 Worker 프로세스를 강제 종료
- **Expected:** 해당 Worker 소속 카메라만 재등록 로그 발생, 다른 Worker 소속 카메라는 스트리밍 유지
- **Acceptance:** 무관 카메라의 WHEP 세션이 끊기지 않음

### TC-C-005 — H.265 카메라 명시적 실패
- **SRS:** FR-WEM-024
- **Input:** H.265 스트림 카메라를 mediasoup 모드에서 추가
- **Expected:** 서버 로그 `mediasoup has no H.265 support` 경고, `addCameraStream()`은 실패하되 프로세스 크래시 없음
- **Acceptance:** 서버가 계속 정상 응답(`/health` 200 유지)

### TC-C-006 — App RTP DataChannel 이중 전달
- **SRS:** FR-WEM-025
- **Input:** ONVIF 이벤트 발생 + 브라우저 WHEP 세션(DataChannel 포함) 연결
- **Expected:** Socket.IO `onvif:event`와 브라우저 `ondatachannel` 양쪽에서 동일 이벤트 수신
- **Acceptance:** 두 경로 모두에서 이벤트 확인, `videoOnly` 카메라는 DataChannel 미수신

---

## 6. Test Group D — Diagnostics

### TC-D-001 — ice-test 정상 응답 스키마
- **SRS:** FR-WEM-030
- **Input:** `POST /api/webrtc/ice-test` (엔진 healthy 상태)
- **Expected:** HTTP 200, `testId` 필드가 `"<engine>-<timestamp>"` 패턴
- **Acceptance:** `testId`가 문자열이고 현재 엔진 이름으로 시작
- **Test script:** `test/api/webrtc_engine_modes.test.js` — TC-D-001

### TC-D-002 — ice-test unhealthy 응답 스키마 (수동)
- **SRS:** FR-WEM-031
- **Input:** MediaMTX 프로세스를 중지한 상태에서(`WEBRTC_ENGINE=mediamtx`) `POST /api/webrtc/ice-test`
- **Expected:** HTTP 503, `{ error, engine: "mediamtx", hint }`
- **Acceptance:** `hint` 필드에 MediaMTX 기동 안내 문구 포함

### TC-D-003 — monitor 엔드포인트 접근 제어 (수동)
- **SRS:** FR-WEM-032
- **Input:** `NODE_ENV=production`에서 원격 IP로 `GET /api/webrtc/monitor` 요청
- **Expected:** HTTP 403 `{ error: 'monitor endpoint is dev-only' }`
- **Acceptance:** localhost가 아닌 요청은 차단

### TC-D-004 — health 엔드포인트에 엔진 필드 없음 (회귀 가드)
- **SRS:** FR-WEM-033
- **Input:** `GET /health`
- **Expected:** 응답에 `webrtcEngine` 키가 존재하지 않음
- **Acceptance:** `!('webrtcEngine' in body)`
- **Test script:** `test/api/webrtc_engine_modes.test.js` — TC-D-004

---

## 7. Test Execution Order

```
Group A (엔진 계약) → Group D (진단 엔드포인트) → Group B/C (엔진별 실동작, 수동)
```

---

## 8. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Engine Selection | ice-test 응답이 현재 설정된 엔진과 일관됨, 공통 인터페이스 7개 심볼 존재 |
| mediamtx Flow | 경로 등록·AI 소스 전환·App RTP·YouTube 예외·WHEP 프록시가 모두 로그/API로 확인됨 |
| mediasoup Flow | 단일 등록·Worker 결정론성·alt-PT 재사용·Worker 장애 격리·HEVC 명시적 실패·DataChannel 이중 전달이 모두 확인됨 |
| Diagnostics | ice-test/health/monitor 응답 스키마가 SRS와 일치 |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-07-23 | LTS Engineering Team | 초기 작성 — mediamtx/mediasoup 엔진 계약 및 플로우 테스트 케이스 정의 |
