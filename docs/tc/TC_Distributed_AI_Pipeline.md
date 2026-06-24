# TEST CASES (TC)
# Distributed AI Pipeline (스트리밍 서버 / AI 분석 서버 분리)

| | |
|---|---|
| **Document ID** | TC-LTS-DAP-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-08 |
| **Parent SRS** | [srs/SRS_Distributed_AI_Pipeline.md](../srs/SRS_Distributed_AI_Pipeline.md) |
| **Parent Design** | [design/Design_Distributed_AI_Pipeline.md](../design/Design_Distributed_AI_Pipeline.md) |
| **Test Scripts** | `test/api/distributed_pipeline.test.js` |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [SRS Traceability Matrix](#3-srs-traceability-matrix)
4. [TC-DAP-001: combined 모드 정상 동작](#4-tc-dap-001-combined-모드-정상-동작)
5. [TC-DAP-002: streaming 모드 — 프레임 전송 확인](#5-tc-dap-002-streaming-모드--프레임-전송-확인)
6. [TC-DAP-003: analysis 모드 — /api/analysis/frame 응답](#6-tc-dap-003-analysis-모드--apianalysisframe-응답)
7. [TC-DAP-004: streaming 모드 — 분석 서버 연결 실패 시 graceful degradation](#7-tc-dap-004-streaming-모드--분석-서버-연결-실패-시-graceful-degradation)
8. [TC-DAP-005: 백프레셔 처리](#8-tc-dap-005-백프레셔-처리)
9. [TC-DAP-006: per-camera 상태 유지](#9-tc-dap-006-per-camera-상태-유지)
10. [TC-DAP-007: analysis 서버 5분 비활성 컨텍스트 자동 정리](#10-tc-dap-007-analysis-서버-5분-비활성-컨텍스트-자동-정리)
11. [TC-DAP-008: WebRTC 스트림과 분석 결과 동시 표시](#11-tc-dap-008-webrtc-스트림과-분석-결과-동시-표시)
12. [TC-DAP-009: 모드별 Dashboard 탭 정책](#12-tc-dap-009-모드별-dashboard-탭-정책)
13. [TC-DAP-010: analysis 모드 discovery 비활성](#13-tc-dap-010-analysis-모드-discovery-비활성)
14. [TC-DAP-011: streaming 모드 eager 모델 로드 금지](#14-tc-dap-011-streaming-모드-eager-모델-로드-금지)
15. [TC-DAP-013: TcRunnerService — Analysis-only 스위트 Streaming 모드 스킵](#15-tc-dap-013-tcrunnerservice--analysis-only-스위트-streaming-모드-스킵)
16. [TC-DAP-012: analysis Dashboard 카메라 입력 상태/FPS 표시](#16-tc-dap-012-analysis-dashboard-카메라-입력-상태fps-표시)
17. [Test Execution Order](#17-test-execution-order)
18. [Pass/Fail Criteria](#18-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | 위치 |
|---|---|---|---|
| Unit | `analysisClient.js` 동시성·타임아웃·백프레셔 로직 | Jest + nock(HTTP mock) | `test/api/distributed_pipeline.test.js` |
| Unit | `analysisApi.js` 엔드포인트 요청/응답 | Jest + supertest | `test/api/distributed_pipeline.test.js` |
| Integration | streaming 서버 → analysis 서버 HTTP 왕복 | Jest + 실제 HTTP 서버 | `test/integration/distributed_pipeline.test.js` |
| E2E | WebRTC 스트림 + AI 오버레이 동시 표시 | Playwright (Phase-2) | `test/e2e/` |

### 1.2 Test Isolation

각 테스트 케이스는 독립적인 환경변수 설정으로 실행되어야 합니다. Jest의 `beforeEach`/`afterEach`에서 `process.env.SERVER_MODE` 등 환경변수를 설정하고 복원합니다.

---

## 2. Test Environment and Prerequisites

### 2.1 필수 환경

| 항목 | 요구사항 |
|---|---|
| Node.js | 18.x 이상 |
| 테스트 프레임워크 | Jest 29.x |
| HTTP 목 라이브러리 | `nock` 또는 Node.js 내장 `http.createServer` |
| HTTP 요청 테스트 | `supertest` |

### 2.2 사전 조건

- `server/` 디렉토리에서 `npm install` 완료
- `storage/lts.json` 초기화 상태
- ONNX 모델 파일(`models/yolov8n.onnx`) 존재 (TC-DAP-003 필요)

### 2.3 환경변수 기본값 (테스트용)

```dotenv
SERVER_MODE=combined
ANALYSIS_SERVER_URL=http://127.0.0.1:19999
ANALYSIS_REQUEST_TIMEOUT_MS=1000
ANALYSIS_MAX_CONCURRENT=2
```

---

## 3. SRS Traceability Matrix

| SRS 요구사항 | TC |
|---|---|
| FR-DAP-001 (모드 선택) | TC-DAP-001, TC-DAP-002, TC-DAP-003 |
| FR-DAP-002 (combined 하위 호환) | TC-DAP-001 |
| FR-DAP-003 (streaming 캡처 유지) | TC-DAP-002 |
| FR-DAP-004 (analysis 캡처 스킵) | TC-DAP-003 |
| FR-DAP-005 (streaming 시작 검증) | TC-DAP-002 |
| FR-DAP-010 (프레임 HTTP POST) | TC-DAP-002 |
| FR-DAP-011 (분석 결과 오버레이) | TC-DAP-008 |
| FR-DAP-012 (요청 타임아웃) | TC-DAP-004 |
| FR-DAP-013 (연결 실패 처리) | TC-DAP-004 |
| FR-DAP-020 (추론 엔드포인트) | TC-DAP-003 |
| FR-DAP-021 (컨텍스트 생성) | TC-DAP-006 |
| FR-DAP-022 (컨텍스트 유지) | TC-DAP-006 |
| FR-DAP-023 (컨텍스트 자동 정리) | TC-DAP-007 |
| FR-DAP-030 (streaming 백프레셔) | TC-DAP-005 |
| FR-DAP-031 (analysis 백프레셔) | TC-DAP-005 |
| FR-DAP-032 (에러 격리) | TC-DAP-004 |
| FR-DAP-040 (헬스 엔드포인트) | TC-DAP-005 |
| NFR-DAP-001 (레이턴시 ≤ 200ms) | TC-DAP-003 |
| NFR-DAP-004 (graceful degradation) | TC-DAP-004 |
| NFR-DAP-005 (5분 컨텍스트 정리) | TC-DAP-007 |

---

## 4. TC-DAP-001: combined 모드 정상 동작

### 개요

`SERVER_MODE=combined` (또는 미설정)에서 기존 동작이 완전히 유지되는지 검증합니다.

### 전제 조건

- `SERVER_MODE` 환경변수가 `combined`으로 설정되어 있거나 미설정 상태

### 테스트 단계

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-001-01 | 서버 시작 로그 | `SERVER_MODE=combined` | 로그에 `SERVER_MODE=combined \| (all-in-one mode)` 출력 |
| TC-DAP-001-02 | 서버 시작 로그 (미설정) | `SERVER_MODE=` (빈 값) | `combined` 모드로 시작 |
| TC-DAP-001-03 | 카메라 API | `GET /api/cameras` | 200 OK, 카메라 목록 JSON |
| TC-DAP-001-04 | 구역 API | `GET /api/zones` | 200 OK |
| TC-DAP-001-05 | 알림 API | `GET /api/alerts` | 200 OK |
| TC-DAP-001-06 | 헬스 체크 | `GET /health` | 200 OK |
| TC-DAP-001-07 | combined에서 analysisApi 등록 확인 | `POST /api/analysis/frame` with empty body | 400 Bad Request (라우트 활성) |
| TC-DAP-001-08 | 잘못된 모드 | `SERVER_MODE=invalid` | `process.exit(1)` 호출, 에러 메시지 출력 |
| TC-DAP-001-09 | 기존 Jest 테스트 | `npm test` | 모든 기존 테스트 통과 |

### 합격 기준

- 기존 `test/api/*.test.js` 전체 통과
- `/api/analysis/frame` 엔드포인트 미등록 확인 (404)
- `ANALYSIS_SERVER_URL` 환경변수 없어도 정상 시작

---

## 5. TC-DAP-002: streaming 모드 — 프레임 전송 확인

### 개요

`SERVER_MODE=streaming`에서 카메라 프레임이 분석 서버로 HTTP POST 전송되는지 검증합니다.

### 전제 조건

- `SERVER_MODE=streaming`
- `ANALYSIS_SERVER_URL=http://127.0.0.1:19999` (목 서버)
- 목 HTTP 서버가 19999 포트에서 `/api/analysis/frame`을 수신 대기

### 테스트 단계

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-002-01 | streaming 서버 시작 | `SERVER_MODE=streaming`, URL 설정 | 로그에 `SERVER_MODE=streaming \| ANALYSIS_SERVER_URL=...` 출력 |
| TC-DAP-002-02 | URL 미설정 monitoring-only 동작 | `SERVER_MODE=streaming`, URL 없음 | 서버는 계속 동작, 원격 AI 요청 미전송 |
| TC-DAP-002-03 | 프레임 HTTP POST 발생 | 카메라 프레임 이벤트 시뮬레이션 | 목 서버가 `POST /api/analysis/frame` 수신 |
| TC-DAP-002-04 | 요청 페이로드 구조 | 프레임 수신 | `{ cameraId, frameId, timestamp, frame(base64), zones, analyticsConfig }` 포함 |
| TC-DAP-002-05 | frame 필드가 유효한 base64 | 페이로드 확인 | Buffer.from(frame, 'base64') 디코딩 성공 |
| TC-DAP-002-06 | 카메라 스트리밍 계속 | 목 서버 응답 성공 | Socket.IO 'frame' 이벤트 계속 발행 |
| TC-DAP-002-07 | analysisApi 미등록 | `POST /api/analysis/frame` (streaming 서버) | 404 Not Found |

### 합격 기준

- 카메라 프레임 이벤트마다 목 서버에 HTTP POST 요청 발생
- 페이로드에 필수 필드(`cameraId`, `frame`) 포함
- `ANALYSIS_SERVER_URL` 미설정 시에도 영상 스트리밍 유지
- `ANALYSIS_SERVER_URL` 미설정 시 분석 결과 이벤트는 발생하지 않음

### 테스트 코드 스니펫

```javascript
// test/api/distributed_pipeline.test.js
describe('TC-DAP-002: streaming 모드 프레임 전송', () => {
  let mockServer;
  let receivedRequests = [];

  beforeAll((done) => {
    process.env.SERVER_MODE = 'streaming';
    process.env.ANALYSIS_SERVER_URL = 'http://127.0.0.1:19999';
    process.env.ANALYSIS_MAX_CONCURRENT = '4';

    // 목 analysis 서버 시작
    mockServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/analysis/frame') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          receivedRequests.push(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            cameraId: JSON.parse(body).cameraId,
            frameId: JSON.parse(body).frameId,
            timestamp: new Date().toISOString(),
            detections: [], tracked: [], behaviors: [], fireSmoke: []
          }));
        });
      }
    });
    mockServer.listen(19999, done);
  });

  afterAll((done) => {
    mockServer.close(done);
    delete process.env.SERVER_MODE;
  });

  it('카메라 프레임 이벤트 시 /api/analysis/frame POST 발생', async () => {
    const client = require('../../server/src/services/analysisClient');
    const result = await client.analyzeFrame({
      cameraId: 'test-cam-01',
      frameId: 1,
      timestamp: new Date().toISOString(),
      frame: Buffer.from('fake-jpeg').toString('base64'),
      zones: [],
      analyticsConfig: { detection: true },
    });
    expect(receivedRequests.length).toBeGreaterThanOrEqual(1);
    expect(receivedRequests[0]).toHaveProperty('cameraId', 'test-cam-01');
    expect(receivedRequests[0]).toHaveProperty('frame');
  });
});
```

---

## 6. TC-DAP-003: analysis 모드 — /api/analysis/frame 응답

### 개요

`SERVER_MODE=analysis`에서 추론 엔드포인트가 올바른 JSON 응답을 반환하는지 검증합니다.

### 전제 조건

- `SERVER_MODE=analysis`
- ONNX 모델 파일이 존재하거나 DetectionService가 목(Mock) 처리됨
- `ANALYSIS_MAX_CONCURRENT=4`

### 테스트 단계

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-003-01 | 서버 시작 | `SERVER_MODE=analysis` | 로그에 `SERVER_MODE=analysis` 출력 |
| TC-DAP-003-02 | 카메라 캡처 미실행 | 서버 시작 후 확인 | FFmpeg/GStreamer 프로세스 미생성 |
| TC-DAP-003-03 | 정상 추론 요청 | `POST /api/analysis/frame` with 유효 payload | HTTP 200, JSON 응답 |
| TC-DAP-003-04 | 응답 필드 확인 | 200 응답 | `detections`, `tracked`, `detectedFaces`, `behaviors`, `fireSmoke`, `cameraId`, `frameId`, `timestamp` 포함 |
| TC-DAP-003-05 | cameraId 누락 | `{ frame: "..." }` | 400 Bad Request |
| TC-DAP-003-06 | frame 필드 누락 | `{ cameraId: "cam1" }` | 400 Bad Request |
| TC-DAP-003-07 | 빈 body | `{}` | 400 Bad Request |
| TC-DAP-003-08 | 헬스 엔드포인트 | `GET /api/analysis/health` | 200, `{ status: "ok", mode: "analysis", ... }` |
| TC-DAP-003-09 | combined 모드에서 해당 엔드포인트 | `POST /api/analysis/frame` (SERVER_MODE=combined, empty body) | 400 Bad Request |
| TC-DAP-003-10 | 레이턴시 측정 | 정상 요청 10회 반복 | p95 ≤ 200ms (LAN 환경) |

### 합격 기준

- `POST /api/analysis/frame` → 200 JSON with `detections`, `tracked`, `behaviors`, `fireSmoke`
- 필수 필드 누락 시 400 반환
- `GET /api/analysis/health` → `{ status: "ok", mode: "analysis" }`

### 테스트 코드 스니펫

```javascript
describe('TC-DAP-003: analysis 모드 추론 엔드포인트', () => {
  let app;

  beforeAll(() => {
    process.env.SERVER_MODE = 'analysis';
    process.env.ANALYSIS_MAX_CONCURRENT = '4';
    app = require('../../server/src/app'); // Express app 인스턴스
  });

  it('POST /api/analysis/frame 정상 응답', async () => {
    const fakeJpeg = Buffer.alloc(100, 0xFF); // 더미 JPEG
    const response = await request(app)
      .post('/api/analysis/frame')
      .send({
        cameraId: 'cam-test-01',
        frameId: 1,
        timestamp: new Date().toISOString(),
        frame: fakeJpeg.toString('base64'),
        zones: [],
        analyticsConfig: { detection: false },
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('cameraId', 'cam-test-01');
    expect(response.body).toHaveProperty('detections');
    expect(response.body).toHaveProperty('tracked');
    expect(response.body).toHaveProperty('behaviors');
    expect(response.body).toHaveProperty('fireSmoke');
  });

  it('cameraId 누락 시 400 반환', async () => {
    const response = await request(app)
      .post('/api/analysis/frame')
      .send({ frame: 'aGVsbG8=' });
    expect(response.status).toBe(400);
  });
});
```

---

## 7. TC-DAP-004: streaming 모드 — 분석 서버 연결 실패 시 graceful degradation

### 개요

분석 서버가 응답하지 않을 때 스트리밍 파이프라인이 중단 없이 계속 동작하는지 검증합니다.

### 전제 조건

- `SERVER_MODE=streaming`
- `ANALYSIS_SERVER_URL=http://127.0.0.1:19998` (수신 대기 중인 서버 없음)
- `ANALYSIS_REQUEST_TIMEOUT_MS=500`

### 테스트 단계

| 단계 | 테스트 항목 | 조건 | 예상 결과 |
|---|---|---|---|
| TC-DAP-004-01 | 연결 거부 (ECONNREFUSED) | 분석 서버 미실행 | `analyzeFrame()` → null 반환, 예외 미전파 |
| TC-DAP-004-02 | errorFrames 카운터 증가 | ECONNREFUSED 발생 | `getStats().errorFrames` > 0 |
| TC-DAP-004-03 | 타임아웃 처리 | 분석 서버가 2000ms 지연 응답 | 500ms 타임아웃 초과 → null 반환 |
| TC-DAP-004-04 | timeoutFrames 카운터 | 타임아웃 발생 | `getStats().timeoutFrames` > 0 |
| TC-DAP-004-05 | 카메라 상태 유지 | 연결 실패 10회 연속 | 카메라 상태 'online' 유지, Socket.IO 'cameraStatus' 이벤트 미발행 |
| TC-DAP-004-06 | 프레임 스트리밍 유지 | 연결 실패 중 | Socket.IO 'frame' 이벤트 계속 발행 |
| TC-DAP-004-07 | 분석 서버 복구 | 실패 후 서버 재시작 | 다음 프레임부터 분석 결과 정상 수신 |
| TC-DAP-004-08 | 503 응답 처리 | 분석 서버가 503 반환 | `errorFrames++`, null 반환, 예외 미전파 |

### 합격 기준

- 분석 서버 장애 시 `analyzeFrame()` 반환값이 `null`이며 예외가 전파되지 않음
- 카메라 파이프라인 상태 변경 없음 (스트리밍 계속)
- `errorFrames`, `timeoutFrames` 카운터 증가

### 테스트 코드 스니펫

```javascript
describe('TC-DAP-004: graceful degradation', () => {
  beforeAll(() => {
    process.env.SERVER_MODE = 'streaming';
    process.env.ANALYSIS_SERVER_URL = 'http://127.0.0.1:19998'; // 없는 서버
    process.env.ANALYSIS_REQUEST_TIMEOUT_MS = '500';
  });

  it('ECONNREFUSED 시 null 반환, 예외 미전파', async () => {
    const client = require('../../server/src/services/analysisClient');
    const result = await client.analyzeFrame({
      cameraId: 'cam-01', frameId: 1,
      timestamp: new Date().toISOString(),
      frame: 'aGVsbG8=', zones: [], analyticsConfig: {},
    });
    expect(result).toBeNull(); // null 반환
    expect(client.getStats().errorFrames).toBeGreaterThan(0);
  });

  it('타임아웃 시 null 반환', async () => {
    // 느린 목 서버 (2000ms 지연)
    const slowServer = http.createServer((req, res) => {
      setTimeout(() => res.end('{}'), 2000);
    });
    await new Promise(r => slowServer.listen(19998, r));

    process.env.ANALYSIS_SERVER_URL = 'http://127.0.0.1:19998';
    const client = require('../../server/src/services/analysisClient');

    const start = Date.now();
    const result = await client.analyzeFrame({ cameraId: 'x', frameId: 1,
      timestamp: '', frame: 'aA==', zones: [], analyticsConfig: {} });
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(700); // 500ms 타임아웃 + 여유
    expect(client.getStats().timeoutFrames).toBeGreaterThan(0);

    await new Promise(r => slowServer.close(r));
  });
});
```

---

## 8. TC-DAP-005: 백프레셔 처리

### 개요

`ANALYSIS_MAX_CONCURRENT` 한도 초과 시 프레임이 드롭되고, `health` API에 카운터가 반영되는지 검증합니다.

### 전제 조건

- `SERVER_MODE=streaming` 또는 `analysis`
- `ANALYSIS_MAX_CONCURRENT=2`
- 목 analysis 서버가 각 요청을 200ms 처리 (동시성 지연 시뮬레이션)

### 테스트 단계

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-005-01 | streaming 측 드롭 | 동시에 3개 `analyzeFrame()` 호출 (max=2) | 세 번째 호출 즉시 null 반환 |
| TC-DAP-005-02 | droppedFrames 카운터 | 드롭 발생 | `getStats().droppedFrames` ≥ 1 |
| TC-DAP-005-03 | analysis 측 503 | `POST /api/analysis/frame` 동시 3건 (max=2) | 세 번째 요청 → 503 응답 |
| TC-DAP-005-04 | 503 응답 구조 | 503 수신 | `{ error, concurrentRequests, limit }` 포함 |
| TC-DAP-005-05 | health API droppedFrames | 드롭 후 | `GET /api/analysis/health` → `droppedFrames` ≥ 1 |
| TC-DAP-005-06 | 드롭 후 정상 복구 | 진행 중 요청 완료 후 새 요청 | 정상 처리 (200 OK) |
| TC-DAP-005-07 | 동시 0개 상태 | 모든 요청 완료 후 | `concurrentRequests` = 0 |

### 합격 기준

- `ANALYSIS_MAX_CONCURRENT=2` 시 3번째 요청 즉시 드롭 (streaming) 또는 503 (analysis)
- `health` API의 `droppedFrames` 카운터 정확히 증가
- 한도 초과 이후 새 슬롯 확보 시 정상 처리 재개

### 테스트 코드 스니펫

```javascript
describe('TC-DAP-005: 백프레셔 처리', () => {
  let client;

  beforeAll(() => {
    process.env.SERVER_MODE = 'streaming';
    process.env.ANALYSIS_MAX_CONCURRENT = '2';
    process.env.ANALYSIS_SERVER_URL = 'http://127.0.0.1:20000';
  });

  it('동시 요청 2건 초과 시 드롭 발생', async () => {
    // 200ms 처리하는 목 서버
    const server = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cameraId: 'x', frameId: 0, timestamp: '',
          detections: [], tracked: [], behaviors: [], fireSmoke: [] }));
      }, 200);
    });
    await new Promise(r => server.listen(20000, r));

    client = require('../../server/src/services/analysisClient');
    const payload = { cameraId: 'c', frameId: 1, timestamp: '',
      frame: 'aA==', zones: [], analyticsConfig: {} };

    // 3개 동시 요청 (max=2 → 3번째 드롭)
    const results = await Promise.all([
      client.analyzeFrame(payload),
      client.analyzeFrame(payload),
      client.analyzeFrame(payload),
    ]);

    expect(results.filter(r => r === null).length).toBeGreaterThanOrEqual(1);
    expect(client.getStats().droppedFrames).toBeGreaterThanOrEqual(1);

    await new Promise(r => server.close(r));
  });
});
```

---

## 9. TC-DAP-006: per-camera 상태 유지 (tracker ID 연속성)

### 개요

동일 cameraId의 연속 요청에서 ByteTracker 상태가 유지되어 objectId가 연속적으로 할당되는지 검증합니다.

### 전제 조건

- `SERVER_MODE=analysis`
- DetectionService가 목(Mock) 처리됨 — 각 요청에서 동일 위치의 bounding box 1개 반환

### 테스트 단계

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-006-01 | 첫 요청 — 컨텍스트 생성 | `cameraId=cam-A, frameId=1` | `tracked[0].id`가 존재 (1번 할당) |
| TC-DAP-006-02 | 두 번째 요청 — 컨텍스트 재사용 | `cameraId=cam-A, frameId=2` | 동일 객체에 동일 `tracked[0].id` 할당 |
| TC-DAP-006-03 | 다른 카메라 별도 컨텍스트 | `cameraId=cam-B, frameId=1` | cam-B의 첫 tracker id = 1 (cam-A와 독립) |
| TC-DAP-006-04 | BehaviorEngine 상태 누적 | 동일 카메라로 30개 프레임 전송 | behaviors 배열에 dwell time이 누적 증가 |
| TC-DAP-006-05 | 새 cameraId 최초 요청 | `cameraId=cam-C (최초)` | 새 ByteTracker 생성, objectId 1번 시작 |

### 합격 기준

- 동일 cameraId 연속 요청 시 같은 객체에 동일 `objectId` 재할당
- 다른 cameraId는 별도 ByteTracker를 사용하므로 objectId가 독립적으로 시작
- 배회 시간이 연속 프레임에 걸쳐 누적 증가

---

## 10. TC-DAP-007: analysis 서버 5분 비활성 카메라 컨텍스트 자동 정리

### 개요

마지막 프레임 수신 후 5분 경과한 카메라 컨텍스트가 자동으로 삭제되는지 검증합니다.

### 전제 조건

- `SERVER_MODE=analysis`
- 정리 타이머 간격을 단축하여 빠른 테스트 가능하도록 설정 (`CONTEXT_CLEANUP_INTERVAL_MS=100`, 테스트 전용)
- 컨텍스트 TTL을 단축하여 테스트 (`CONTEXT_TTL_MS=500`, 테스트 전용)

> **참고:** 프로덕션 기본값은 `CONTEXT_TTL_MS=300000` (5분), `CONTEXT_CLEANUP_INTERVAL_MS=60000` (60초). 테스트에서는 이 값을 mock/stub으로 단축합니다.

### 테스트 단계

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-007-01 | 초기 컨텍스트 생성 | `POST /api/analysis/frame` (cameraId=cam-expire) | `activeCameras` = 1 (health API 확인) |
| TC-DAP-007-02 | TTL 경과 전 상태 확인 | TTL의 50% 경과 | `activeCameras` = 1 유지 |
| TC-DAP-007-03 | TTL 경과 후 정리 | TTL + 정리 타이머 간격 경과 | `activeCameras` = 0 |
| TC-DAP-007-04 | 삭제 후 재요청 | 컨텍스트 삭제 후 동일 cameraId 재요청 | 새 컨텍스트 생성, objectId 1번부터 재시작 |
| TC-DAP-007-05 | 활성 카메라 유지 | TTL 이내 주기적 요청 | 컨텍스트 삭제 없음 (`activeCameras` 유지) |
| TC-DAP-007-06 | health API 카운터 갱신 | 정리 후 health API 조회 | `activeCameras` 정확히 반영 |

### 합격 기준

- TTL 경과 후 컨텍스트가 삭제되어 `health.activeCameras` 감소
- 삭제 후 재요청 시 새 ByteTracker가 생성되어 objectId가 1번부터 재시작
- 주기적 요청이 있는 카메라는 컨텍스트 유지

---

## 11. TC-DAP-008: WebRTC 스트림과 분석 결과 동시 표시

### 개요

`streaming` 모드에서 WebRTC 비디오 스트림과 AI 분석 오버레이(bounding box)가 동시에 브라우저에 표시되는지 검증합니다.

### 전제 조건

- `SERVER_MODE=streaming`
- analysis 서버가 정상 동작 중
- 테스트 카메라가 WebRTC 모드로 스트리밍 중 (`webrtcEnabled=true`)
- Playwright 브라우저 환경 또는 supertest + Socket.IO 클라이언트

### 테스트 단계

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-008-01 | Socket.IO 'frame' 이벤트 수신 | 카메라 프레임 이벤트 | 클라이언트가 'frame' 이벤트 수신 (JPEG) |
| TC-DAP-008-02 | Socket.IO 'detections' 이벤트 | 분석 서버 응답 수신 | 클라이언트가 'detections' 이벤트 수신 |
| TC-DAP-008-03 | detections 구조 확인 | 'detections' 이벤트 | `{ cameraId, detections[], tracked[], behaviors[] }` 포함 |
| TC-DAP-008-04 | frameId 일치 | 'frame'과 'detections' 비교 | 같은 frameId에 대한 JPEG와 분석 결과 매칭 |
| TC-DAP-008-05 | WebRTC 스트림 병행 | 분석 결과 수신 중 | WebRTC DataChannel/media도 계속 수신 |
| TC-DAP-008-06 | 분석 지연 시 스트림 계속 | 분석 200ms 지연 | JPEG 프레임은 계속 수신, 분석 결과는 지연 수신 |

### 합격 기준

- `detections` Socket.IO 이벤트가 분석 서버 응답 수신 즉시 발행됨
- JPEG 스트림과 분석 결과가 별개의 이벤트 채널로 독립 동작
- 분석 서버 지연 시 JPEG 스트림에 지연 없음

### 테스트 코드 스니펫

```javascript
// test/integration/distributed_pipeline.test.js
describe('TC-DAP-008: WebRTC 스트림과 분석 결과 동시 표시', () => {
  it('frame 이벤트와 detections 이벤트가 독립적으로 수신됨', (done) => {
    const io = require('socket.io-client');
    const socket = io('http://localhost:3080');

    const received = { frame: false, detections: false };

    socket.on('frame', () => { received.frame = true; checkDone(); });
    socket.on('detections', (data) => {
      received.detections = true;
      expect(data).toHaveProperty('cameraId');
      expect(data).toHaveProperty('detections');
      checkDone();
    });

    function checkDone() {
      if (received.frame && received.detections) {
        socket.disconnect();
        done();
      }
    }

    socket.emit('subscribeCamera', { cameraId: 'test-cam-01' });

    setTimeout(() => done(new Error('타임아웃')), 5000);
  });
});
```

---

## 12. TC-DAP-009: 모드별 Dashboard 탭 정책

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-009-01 | combined 탭 정책 | `SERVER_MODE=combined` | Cameras/Analytics 탭 모두 표시 |
| TC-DAP-009-02 | streaming 탭 정책 | `SERVER_MODE=streaming` | Cameras 탭 표시, Analytics 탭 미표시 |
| TC-DAP-009-03 | analysis 탭 정책 | `SERVER_MODE=analysis` | Cameras 탭 미표시, 메인 영역에 Analysis 상태 패널 표시 |

## 13. TC-DAP-010: analysis 모드 discovery 비활성

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-010-01 | REST discovery 비활성 | `POST /api/cameras/discover` | 409 + `SERVER_MODE=analysis` 에러 메시지 |
| TC-DAP-010-02 | 소켓 discovery 비활성 | `discovery:start` emit | `discovery:disabled` 이벤트 수신 |

---

## 14. TC-DAP-011: streaming 모드 eager 모델 로드 금지

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-011-01 | 서버 시작 eager-load 가드 | `SERVER_MODE=streaming` | 로그에 `skipping eager AI model loading` 또는 동등 메시지 |
| TC-DAP-011-02 | 유닛 계약 검증 | `node test/api/streaming_mode_model_skip.test.js` | `_attrPipeline === null` 유지 |

---

## 15. TC-DAP-013: TcRunnerService — Analysis-only 스위트 Streaming 모드 스킵

**SRS Ref**: FR-DAP-028  
**목적**: `SERVER_MODE=streaming`에서 AI 전용 테스트 스위트(ai_detection_modules, analytics_config, model_catalog)가 실행되지 않고 Audit UI에도 표시되지 않는지 검증한다.

| 단계 | 테스트 항목 | 전제 조건 | 예상 결과 |
|---|---|---|---|
| TC-DAP-013-01 | TcRunnerService analysisOnly 플래그 스킵 | `SERVER_MODE=streaming` 환경 | `ai_detection_modules.test.js`, `analytics_config.test.js`, `model_catalog.test.js` 스위트가 `skip` 상태로 DB 저장 |
| TC-DAP-013-02 | 스킵 메시지 확인 | TC-DAP-013-01 실행 후 | `tc_results`의 `tcDesc` 필드에 `"skipped (SERVER_MODE=streaming, Analysis Server only)"` 포함 |
| TC-DAP-013-03 | 테스트 스크립트 자체 스킵 | `node test/api/ai_detection_modules.test.js` (streaming 서버) | `exit 0`으로 종료, stdout에 `"skipped (SERVER_MODE=streaming"` 출력 |
| TC-DAP-013-04 | analytics_config 스크립트 자체 스킵 | `node test/api/analytics_config.test.js` (streaming 서버) | `exit 0`으로 종료, stdout에 `"skipped (SERVER_MODE=streaming"` 출력 |
| TC-DAP-013-05 | Audit UI — streaming 배너 표시 | Admin Dashboard → Audit → Startup Tests, `SERVER_MODE=streaming` | 노란색 배너: "Streaming Server mode — AI Detection Modules and Analytics Config Toggle suites are hidden" |
| TC-DAP-013-06 | Audit UI — Analysis-only 스위트 미표시 | TC-DAP-013-05 환경 | `ai_detection_modules`, `analytics_config`, `model_catalog` 스위트가 목록에 없음 |
| TC-DAP-013-07 | Audit UI — combined 모드 정상 표시 | `SERVER_MODE=combined` | 배너 없음, 세 스위트 모두 정상 표시 |

**자동화 스크립트**: `test/api/ai_detection_modules.test.js`, `test/api/analytics_config.test.js` (streaming 모드 자체 skip 로직 포함)

---

## 15. TC-DAP-012: analysis Dashboard 카메라 입력 상태/FPS 표시

| 단계 | 테스트 항목 | 입력 | 예상 결과 |
|---|---|---|---|
| TC-DAP-012-01 | 분석 메트릭 카메라 입력 필드 확인 | `GET /api/analysis/metrics` | `cameras[]`에 `streamPresent`, `inputFps1s`, `framesLast1s` 필드 포함 |
| TC-DAP-012-02 | 실시간 입력 존재 표시 | 특정 카메라에서 프레임 연속 입력 | Dashboard의 해당 카메라 `Input=있음` 표시 |
| TC-DAP-012-03 | 입력 중단 표시 | 카메라 입력 중단 후 3초 경과 | Dashboard의 해당 카메라 `Input=없음` 표시 |
| TC-DAP-012-04 | 카메라별 FPS 표시 | 각 카메라 입력률 상이한 상태 | Dashboard 표에 카메라별 `FPS(1s)` 값이 0 이상 숫자로 표시 |

---

## 16. Test Execution Order

```
1. TC-DAP-001 — combined 모드 (가장 기본, 환경 검증)
2. TC-DAP-003 — analysis 모드 단독 엔드포인트 (HTTP 레벨 검증)
3. TC-DAP-006 — per-camera 상태 유지 (analysis 서버 상태 기능)
4. TC-DAP-007 — 컨텍스트 자동 정리 (분리 환경 필요)
5. TC-DAP-005 — 백프레셔 (analysis + streaming 양쪽 검증)
6. TC-DAP-002 — streaming 모드 프레임 전송 (목 서버 필요)
7. TC-DAP-004 — graceful degradation (연결 실패 시뮬레이션)
8. TC-DAP-008 — WebRTC + 분석 동시 표시 (통합/E2E 레벨)
```

---

## 17. Pass/Fail Criteria

### 16.1 통과 기준

| 케이스 | 필수 통과 조건 |
|---|---|
| TC-DAP-001 | 기존 `npm test` 100% 통과 + `/api/analysis/frame` 라우트 활성(400 validation) 확인 |
| TC-DAP-002 | 프레임마다 HTTP POST 발생 확인 + URL 미설정 시 종료 확인 |
| TC-DAP-003 | 200 JSON 응답 + 필수 필드 포함 + 400/404 오류 처리 |
| TC-DAP-004 | `analyzeFrame()` null 반환 + 카메라 상태 변경 없음 |
| TC-DAP-005 | 드롭 발생 + `health` 카운터 반영 + 복구 후 정상 처리 |
| TC-DAP-006 | 연속 요청에서 동일 objectId + 다른 카메라 독립 컨텍스트 |
| TC-DAP-007 | TTL 경과 후 `activeCameras` 감소 + 재생성 시 ID 리셋 |
| TC-DAP-008 | `frame`과 `detections` 이벤트 독립 수신 + WebRTC 계속 동작 |

### 16.2 실패 시 처리

- TC-DAP-001 실패: 하위 호환성 문제 — 병합 차단 (Critical)
- TC-DAP-004 실패: 프로덕션 장애 위험 — 병합 차단 (Critical)
- TC-DAP-005 실패: GPU 과부하 위험 — 병합 차단 (Critical)
- TC-DAP-013 실패: streaming 모드에서 오탐(false positive) 발생 위험 — 높음
- 기타 실패: 기능 결함 — 버그 등록 후 수정 후 재검증

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-08 | 초기 작성 |
| 1.1 | 2026-06-24 | TC-DAP-013 추가: TcRunnerService analysis-only 스위트 streaming 모드 스킵 검증 (FR-DAP-028)
