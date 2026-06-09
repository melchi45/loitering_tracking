# DESIGN DOCUMENT
# Distributed AI Pipeline (스트리밍 서버 / AI 분석 서버 분리)

| | |
|---|---|
| **Document ID** | DESIGN-LTS-DAP-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-08 |
| **Parent SRS** | [srs/SRS_Distributed_AI_Pipeline.md](../srs/SRS_Distributed_AI_Pipeline.md) |
| **Parent PRD** | [prd/PRD_Distributed_AI_Pipeline.md](../prd/PRD_Distributed_AI_Pipeline.md) |

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Component Description](#2-component-description)
3. [Data Flow](#3-data-flow)
4. [State Management — Per-Camera Context](#4-state-management--per-camera-context)
5. [Backpressure Strategy](#5-backpressure-strategy)
6. [Backward Compatibility — combined 모드](#6-backward-compatibility--combined-모드)
7. [Sequence Diagrams](#7-sequence-diagrams)
8. [File & Module Layout](#8-file--module-layout)
9. [Configuration & Environment](#9-configuration--environment)
10. [Error Handling](#10-error-handling)

---

## 1. Architecture Overview

### 1.1 세 가지 모드 아키텍처 다이어그램

#### combined 모드 (현재 동작, 변경 없음)

```
┌────────────────────────────────────────────────────────────────┐
│                   SINGLE NODE.JS SERVER                        │
│                   SERVER_MODE=combined                         │
│                                                                │
│  [IP Camera] ──RTSP──► [CaptureBackend]                       │
│                               │ JPEG frame                     │
│                               ▼                                │
│                    [PipelineManager]                           │
│                    ├─ DetectionService (YOLOv8 ONNX)          │
│                    ├─ ByteTracker                              │
│                    ├─ BehaviorEngine                           │
│                    ├─ AttributePipeline                        │
│                    └─ FireSmokeService                         │
│                               │ results                        │
│                               ▼                                │
│                    [Socket.IO / WebRTC] ──► [Browser]         │
└────────────────────────────────────────────────────────────────┘
```

#### streaming 모드

```
┌───────────────────────────────────────────────────────────────┐
│                   STREAMING SERVER (CPU)                       │
│                   SERVER_MODE=streaming                        │
│                                                                │
│  [IP Camera] ──RTSP──► [CaptureBackend]                      │
│                               │ JPEG frame                    │
│                               ▼                               │
│                    [PipelineManager]                          │
│                    (AI 추론 단계 제거됨)                        │
│                               │                               │
│                    [analysisClient.js]                        │
│                    ├─ concurrentRequests 추적                 │
│                    ├─ backpressure 적용                       │
│                    └─ HTTP POST /api/analysis/frame           │
│                       (cameraId + cameraName + zones meta)    │
│                               │                               │
│              ◄────────────────┘ JSON 응답                     │
│   (detections + tracked + behaviors + fireSmoke)              │
│                               │                               │
│                    [Socket.IO / WebRTC] ──► [Browser]        │
└───────────────────────────────────────────────────────────────┘
                               │
                    HTTP POST (LAN)
                               │
┌──────────────────────────────▼────────────────────────────────┐
│                   ANALYSIS SERVER (GPU)                        │
│                   SERVER_MODE=analysis                         │
│                                                                │
│  POST /api/analysis/frame ──► [analysisApi.js]               │
│                                      │                        │
│                           [Per-Camera Context Map]            │
│                           ├─ cameraId-A: ByteTracker+BE      │
│                           ├─ cameraId-B: ByteTracker+BE      │
│                           └─ ...                              │
│                                      │                        │
│                      ┌───────────────┴──────────────┐        │
│               [DetectionService]  [AttributePipeline]         │
│               (YOLOv8 ONNX CUDA)  [FireSmokeService]         │
│                      └───────────────────────────────┘        │
│                                      │                        │
│                               JSON 응답 ◄─────────────────── │
└───────────────────────────────────────────────────────────────┘
```

#### analysis 모드 (독립 실행)

```
┌───────────────────────────────────────────────────────────────┐
│                   ANALYSIS SERVER (GPU)                        │
│                   SERVER_MODE=analysis                         │
│                                                                │
│  (카메라 캡처/Discovery 없음)                                   │
│  (Dashboard는 카메라 레이아웃 대신 Analysis 상태 패널 표시)      │
│                                                                │
│  Express Routes:                                              │
│   POST /api/analysis/frame  ──► analysisApi.js               │
│   GET  /api/analysis/health ──► analysisApi.js               │
│   GET  /api/analysis/metrics ─► analysisApi.js               │
│                                                                │
│  Shared Services:                                             │
│   DetectionService (YOLOv8 ONNX — 1개 인스턴스 공유)          │
│   AttributePipeline                                           │
│   FireSmokeService                                            │
│                                                                │
│  Per-Camera Map:                                              │
│   Map<cameraId, { tracker, behavior, lastSeenAt }>           │
│   (60초마다 5분 초과 항목 자동 삭제)                           │
└───────────────────────────────────────────────────────────────┘
```

---

## 2. Component Description

### 2.0 Dashboard Mode Policy

| SERVER_MODE | Cameras Tab | Analytics Tab | Main Area |
|---|---|---|---|
| `combined` | 표시 | 표시 | CameraGrid |
| `streaming` | 표시 | 미표시 | CameraGrid |
| `analysis` | 미표시 | 표시 | Analysis metrics dashboard |

- `analysis` 모드에서는 카메라 discovery 기능(`POST /api/cameras/discover`, `discovery:*` socket events, background discovery scheduler)이 비활성화됩니다.
- `streaming` 모드에서는 원격 분석 응답(`tracked`, `behaviors`, `fireSmoke`, `detectedFaces`)을 기반으로 Face ID 매칭/크롭/스냅샷 저장까지 로컬에서 후처리합니다.
- `streaming` 모드에서는 서버 기동 시 `loadFaceServiceEagerly()`를 호출하지 않아 로컬 AI 모델(PAR/ArcFace 포함)을 선로딩하지 않습니다.
- `streaming` 모드에서는 analysis 서버로 프레임을 전송할 때 `cameraId`와 함께 `cameraName`도 메타에 포함합니다.
- `analysis` 모드에서는 수신한 `cameraName`을 per-camera context와 `/api/analysis/metrics` 응답에 보존해 대시보드에 표시합니다.
- `analysis` 모드의 `/api/analysis/metrics` per-camera 항목은 최근 입력 상태(`streamPresent`)와 최근 1초 입력 FPS(`inputFps1s`)를 포함하며, Dashboard는 이를 통해 카메라별 영상 입력 존재 여부를 표시합니다.

### 2.1 analysisClient.js (신규)

**경로:** `server/src/services/analysisClient.js`
**역할:** streaming 서버에서 analysis 서버로 JPEG 프레임을 HTTP POST 전송하는 클라이언트

**핵심 설계:**

```javascript
'use strict';

const http  = require('http');
const https = require('https');

class AnalysisClient {
  constructor() {
    this._serverUrl   = process.env.ANALYSIS_SERVER_URL || '';
    this._timeoutMs   = parseInt(process.env.ANALYSIS_REQUEST_TIMEOUT_MS || '5000', 10);
    this._maxConcurrent = parseInt(process.env.ANALYSIS_MAX_CONCURRENT || '4', 10);

    // 통계 카운터
    this._concurrentRequests = 0;
    this._sentFrames         = 0;
    this._droppedFrames      = 0;
    this._timeoutFrames      = 0;
    this._errorFrames        = 0;
  }

  async analyzeFrame(payload) {
    // 백프레셔: 한도 초과 시 즉시 드롭
    if (this._concurrentRequests >= this._maxConcurrent) {
      this._droppedFrames++;
      return null;
    }
    this._concurrentRequests++;
    try {
      // payload metadata includes both stable cameraId and human-readable
      // cameraName so the analysis dashboard can show source names.
      const result = await this._post('/api/analysis/frame', payload);
      this._sentFrames++;
      return result;
    } catch (err) {
      if (err.name === 'AbortError') this._timeoutFrames++;
      else this._errorFrames++;
      return null;
    } finally {
      this._concurrentRequests--;
    }
  }

  getStats() {
    return {
      analysisServerUrl: this._serverUrl,
      concurrentRequests: this._concurrentRequests,
      maxConcurrent: this._maxConcurrent,
      sentFrames: this._sentFrames,
      droppedFrames: this._droppedFrames,
      timeoutFrames: this._timeoutFrames,
      errorFrames: this._errorFrames,
    };
  }
}

module.exports = new AnalysisClient(); // 싱글턴
```

### 2.2 analysisApi.js (신규)

**경로:** `server/src/routes/analysisApi.js`
**역할:** analysis 서버의 HTTP 엔드포인트 라우터

**핵심 설계 — 모델 Eager Loading (Promise Mutex 패턴):**

```javascript
'use strict';

const express = require('express');
const router  = express.Router();

// 공유 서비스 (싱글턴)
const DetectionService  = require('../services/detection');
const { ByteTracker }  = require('../services/tracking');
const BehaviorEngine   = require('../services/behaviorEngine');
const FireSmokeService = require('../services/fireSmokeService');
const AttributePipeline = require('../services/attributePipeline');

// Per-camera 컨텍스트 Map: cameraId → { tracker, behavior, lastSeenAt }
const _cameras = new Map();
const CONTEXT_TTL_MS = 5 * 60 * 1000; // 5분

// 정기 정리 타이머 (60초마다)
setInterval(() => {
  const now = Date.now();
  for (const [id, ctx] of _cameras) {
    if (now - ctx.lastSeenAt > CONTEXT_TTL_MS) _cameras.delete(id);
  }
}, 60_000);

// 공유 서비스 인스턴스
let _detector         = null;
let _attrPipeline     = null;
let _fireSmokeService = null;

// Promise mutex — 동시 다중 로드 방지
let _servicesReady = false;
let _loadPromise   = null;

async function _ensureServices() {
  if (_servicesReady) return;
  if (!_loadPromise) _loadPromise = _loadServices();
  await _loadPromise;
}

async function _loadServices() {
  try {
    _detector = new DetectionService();
    await _detector.load();
  } catch (err) { console.error('[AnalysisAPI] DetectionService load error:', err.message); }
  try {
    _attrPipeline = new AttributePipeline();
    await _attrPipeline.load();
  } catch (err) { console.error('[AnalysisAPI] AttributePipeline load error:', err.message); }
  try {
    _fireSmokeService = new FireSmokeService();
    await _fireSmokeService.load();
  } catch (err) { console.error('[AnalysisAPI] FireSmokeService load error:', err.message); }
  _servicesReady = true;
}

// 모듈 로드 직후 즉시 모델 사전 로딩 시작 (첫 요청 대기 없음)
setImmediate(() => {
  _ensureServices().catch(err =>
    console.error('[AnalysisAPI] Startup model load error:', err.message)
  );
});

// 동시 요청 카운터
let _concurrentRequests = 0;
let _processedFrames    = 0;
let _droppedFrames      = 0;
const _maxConcurrent    = parseInt(process.env.ANALYSIS_MAX_CONCURRENT || '4', 10);
const _startTime        = Date.now();

router.post('/frame', async (req, res) => {
  const { cameraId, frameId, timestamp, frame, zones } = req.body;
  if (!cameraId || !frame) return res.status(400).json({ error: 'cameraId and frame are required' });

  if (_concurrentRequests >= _maxConcurrent) {
    _droppedFrames++;
    return res.status(503).json({
      error: 'Too many concurrent analysis requests',
      concurrentRequests: _concurrentRequests,
      limit: _maxConcurrent,
    });
  }

  _concurrentRequests++;
  try {
    // 서비스 준비 완료까지 대기 (최초 요청 시 로딩 중이면 여기서 블록)
    await _ensureServices();

    const ctx = await getOrCreateContext(cameraId);
    const jpegBuf = Buffer.from(frame, 'base64');

    // 추론 파이프라인
    let detections = [];
    if (_detector) {
      const r = await _detector.detect(jpegBuf);
      detections = r.detections;
    }
    const tracked   = ctx.tracker.update(detections);
    const behaviors = ctx.behavior.update(tracked, zones || []);
    const fireSmoke = _fireSmokeService ? await _fireSmokeService.analyze(jpegBuf) : [];

    _processedFrames++;
    res.json({ cameraId, frameId, timestamp: new Date().toISOString(), detections, tracked, behaviors, fireSmoke });
  } finally {
    _concurrentRequests--;
  }
});

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'analysis',
    servicesReady: _servicesReady,
    activeCameras: _cameras.size,
    concurrentRequests: _concurrentRequests,
    maxConcurrent: _maxConcurrent,
    processedFrames: _processedFrames,
    droppedFrames: _droppedFrames,
    timeoutFrames: 0,
    uptime: Math.floor((Date.now() - _startTime) / 1000),
  });
});

module.exports = router;
```

**Eager Loading 설계 원칙:**
- `setImmediate()` — 이벤트 루프 첫 tick에서 모델 로딩 시작. 서버 시작 후 첫 프레임 수신 전에 ONNX 모델이 준비됨
- Promise mutex (`_loadPromise`) — 동시에 여러 요청이 도착해도 `_loadServices()`는 한 번만 실행
- 각 서비스는 독립적 try-catch: 한 모델이 실패해도 나머지 서비스는 계속 작동
- `/api/analysis/health` 응답에 `servicesReady` 필드 포함 — 준비 상태 모니터링 가능

### 2.3 pipelineManager.js (수정)

`frame` 이벤트 핸들러 내 AI 추론 섹션에 모드 분기 추가:

```javascript
const SERVER_MODE   = (process.env.SERVER_MODE || 'combined').toLowerCase();
const analysisClient = SERVER_MODE === 'streaming'
  ? require('./analysisClient')
  : null;

// ANALYSIS_FPS per-camera 전송 레이트 리미터
// 0 = unlimited (latest-frame-wins 자동 조절)
// N > 0 = 카메라당 N fps로 하드 캡
const _ANALYSIS_FPS         = Math.max(0, parseFloat(process.env.ANALYSIS_FPS || '0'));
const _ANALYSIS_INTERVAL_MS = _ANALYSIS_FPS > 0 ? 1000 / _ANALYSIS_FPS : 0;

// per-camera ctx 초기화 시 포함
// _lastAnalysisQueueAt: 0,   // epoch ms — ANALYSIS_FPS 레이트 리미터 기준점

// frame 이벤트 핸들러 내부 (기존 코드 블록 교체)
if (SERVER_MODE === 'streaming') {
  // ── Streaming 모드: 외부 analysis 서버로 위임 ─────────────────
  if (!this._analysisClient) return;

  // ANALYSIS_FPS 레이트 리미터: 이전 큐잉 후 충분한 시간이 지나지 않으면 프레임 드롭
  if (_ANALYSIS_INTERVAL_MS > 0) {
    if (timestamp - ctx._lastAnalysisQueueAt < _ANALYSIS_INTERVAL_MS) return;
  }
  ctx._lastAnalysisQueueAt = timestamp;

  // latest-frame-wins 패턴: 이전 inflight가 완료되기 전에 새 프레임 도착 시
  // _pendingFrame을 덮어써서 가장 최신 프레임만 전송
  ctx._pendingFrame = {
    cameraId: camera.id,
    cameraName: camera.name,
    frameId: currentFrameId,
    ts: timestamp,
    buf: jpegBuffer,
    fw: frameWidth,
    fh: frameHeight,
    zones: this._zoneManager.getActiveZones(camera.id),
  };
  if (!ctx._analyzing) this._runPendingAnalysis(ctx, camera, analyticsConfig);
  return;
} else {
  // ── Combined 모드: 기존 로직 100% 유지 ──────────────────────────
  // (기존 DetectionService, ByteTracker, BehaviorEngine 코드)
}
```

### 2.4 index.js (수정)

```javascript
const SERVER_MODE = (process.env.SERVER_MODE || 'combined').toLowerCase();

// analysis 모드에서만 analysisApi 라우터 등록
if (SERVER_MODE === 'analysis') {
  const analysisApi = require('./routes/analysisApi');
  app.use('/api/analysis', analysisApi);
}

// streaming 모드 시작 검증
if (SERVER_MODE === 'streaming' && !process.env.ANALYSIS_SERVER_URL) {
  console.warn('[Server] ANALYSIS_SERVER_URL is empty — monitoring-only mode (no remote AI results)');
}
```

---

## 3. Data Flow

### 3.1 streaming 모드 데이터 플로우

```
[RTSP Camera]
     │ H.264 stream
     ▼
[CaptureBackend (FFmpeg/GStreamer/PyAV)]
     │ JPEG buffer (10 FPS)
     ▼
[PipelineManager.frame 이벤트]
     │
     ├── [Socket.IO emit 'frame'] ──────────────────────────► [Browser] (JPEG 미리보기)
     │    (WebRTC 미사용 카메라만)
     │
     └── [analysisClient.analyzeFrame(payload)]
              │
              │ HTTP POST /api/analysis/frame
              │ Body: { cameraId, frameId, timestamp, frame(base64), zones, analyticsConfig }
              │
              ▼
         [ANALYSIS SERVER]
              │ HTTP 200 JSON
              │ { detections, tracked, behaviors, fireSmoke }
              │
              ▼
         [PipelineManager]
              │
              ├── [Socket.IO emit 'detections'] ─────────────► [Browser]
              └── [AlertService.createAlert] (loitering behaviors)
```

### 3.2 analysis 모드 데이터 플로우

```
[STREAMING SERVER]
     │
     │ HTTP POST /api/analysis/frame
     │ Content-Type: application/json
     │ Body: { cameraId, frameId, timestamp, frame(base64), zones, analyticsConfig }
     │
     ▼
[analysisApi.js — POST /frame]
     │
     ├── [백프레셔 체크] — concurrentRequests >= maxConcurrent → 503
     │
     ├── [Per-Camera Context 조회/생성]
     │      Map<cameraId, { tracker: ByteTracker, behavior: BehaviorEngine, lastSeenAt }>
     │
     ├── [Base64 디코딩] → JPEG Buffer
     │
     ├── [DetectionService.detect()] → detections[]
     │
     ├── [ctx.tracker.update(detections)] → tracked[]
     │
     ├── [ctx.behavior.update(tracked, zones)] → behaviors[]
     │
     └── [FireSmokeService.analyze()] → fireSmoke[]
              │
              ▼
     HTTP 200 JSON: { cameraId, frameId, timestamp, detections, tracked, behaviors, fireSmoke }
```

---

## 4. State Management — Per-Camera Context

### 4.1 컨텍스트 생명주기

```
[첫 번째 요청 수신]
       │
       ▼
[Map.has(cameraId)?]
       │
  No ──┼──► [ByteTracker 생성] + [BehaviorEngine 생성]
       │              │
       │    [Map.set(cameraId, { tracker, behavior, lastSeenAt: now })]
       │
  Yes ─┤
       │
       ▼
[ctx.lastSeenAt = now]
       │
       ▼
[추론 실행]
       │
       ▼
[결과 반환]

─────────────────────────────────────────
[60초마다 실행되는 정리 타이머]
       │
       ▼
[Map 순회]
       │
       ├── lastSeenAt < now - 5min → Map.delete(cameraId)
       │
       └── 그 외 → 유지
```

### 4.2 tracker ID 연속성 보장

동일 cameraId에 대해 `ByteTracker` 인스턴스를 재사용하므로 tracker의 내부 상태(`nextId`, track history)가 유지됩니다. 이로 인해:
- 연속 프레임에서 동일 객체에 같은 `objectId` 할당
- ByteTrack의 Kalman Filter 예측 상태 유지
- 배회 시간 측정의 연속성 보장

5분 비활성 후 컨텍스트가 삭제되면 새 요청 시 새 `ByteTracker`가 생성되어 `objectId` 1번부터 재시작합니다. 이 동작은 TC-DAP-007에서 검증됩니다.

### 4.3 BehaviorEngine 상태

`BehaviorEngine`은 구역 내 체류 시간 누적을 위해 내부 상태를 유지합니다. Per-camera 컨텍스트에서 같은 인스턴스를 재사용하므로 배회 점수가 연속적으로 누적됩니다.

`analysis` 모드의 BehaviorEngine은 `zones` 배열을 직접 인자로 받아 사용합니다. `zoneManager`는 `null`로 초기화되며 zones는 요청 페이로드에서 직접 전달받습니다.

---

## 5. Backpressure Strategy

### 5.1 streaming 서버 측 (analysisClient.js)

```
[frame 이벤트 발생]
       │
       ▼
[concurrentRequests >= maxConcurrent?]
       │
  Yes ─┴──► [droppedFrames++] → return null (즉시 드롭)
       │
  No  ──► [concurrentRequests++]
       │
       ▼
[HTTP POST 요청 전송]
       │
       ├── 성공: sentFrames++, concurrentRequests--
       ├── 타임아웃: timeoutFrames++, concurrentRequests--
       └── 에러: errorFrames++, concurrentRequests--
```

**설계 원칙:**
- 드롭은 서버 시작부터 단조 증가하는 카운터로만 기록 (로그 스팸 방지)
- 연속 10개 이상 드롭 시 `console.warn` 1회 출력 (10개 배치 단위)
- 스트리밍 파이프라인에 어떠한 예외도 전파하지 않음 (`return null` 패턴)

### 5.2 analysis 서버 측 (analysisApi.js)

분석 서버가 자체적으로도 한도를 초과하는 요청에 `503`을 반환합니다. streaming 서버의 `analysisClient`는 503 응답을 에러로 처리하여 `errorFrames`에 카운트합니다.

**이중 방어 구조:**
```
[streaming 서버 backpressure] → concurrentRequests 한도로 1차 방어
       │ (한도 내에서만 HTTP POST)
       ▼
[analysis 서버 backpressure] → 503 응답으로 2차 방어
```

### 5.3 ANALYSIS_FPS per-camera 레이트 리미터 (pipelineManager.js)

streaming 서버가 analysis 서버로 프레임을 전송하는 속도를 카메라별로 제어합니다.

```
[frame 이벤트 발생]
       │
       ▼
[ANALYSIS_FPS > 0?]
       │
  Yes ─┤  [now - ctx._lastAnalysisQueueAt < _ANALYSIS_INTERVAL_MS?]
       │         │
       │    Yes ─┴──► return (프레임 드롭 — 레이트 캡 적용)
       │         │
       │    No ──┘
       │
  No ──┤  (ANALYSIS_FPS=0: 레이트 캡 없음)
       │
       ▼
[ctx._lastAnalysisQueueAt = timestamp]
       │
       ▼
[ctx._pendingFrame 갱신 (latest-frame-wins)]
       │
       ▼
[_runPendingAnalysis() 실행]
```

**ANALYSIS_FPS=0 (기본값, 권장):**
- 레이트 리미터를 완전히 비활성화
- analysis 서버 추론 속도가 직접 처리량을 결정 ("latest-frame-wins" 자동 조절)
- 추론이 빨라지면 fps가 자동으로 증가; 별도 설정 변경 불필요

**ANALYSIS_FPS=N (> 0):**
- 카메라당 N fps로 하드 캡
- 원격 분석 서버나 대역폭 제한 환경에서 부하 제어 목적으로 사용
- N fps 이하로만 전송되므로 추론이 빨라져도 N fps 이상으로 증가하지 않음

**CPU 추론 환경 실측 처리량 참고:**
| 활성화 모듈 | 카메라 1대 | 카메라 4대 (동시) |
|---|---|---|
| detection only | ~5 fps | ~1.25 fps |
| detection + face | ~1.8 fps | ~0.7 fps |
| detection + face + fire/smoke | ~1.2 fps | ~0.5 fps |
| GPU (ONNX_CUDA=1) | ~20 fps | ~15 fps |

---

## 6. Backward Compatibility — combined 모드

### 6.1 코드 수정 원칙

기존 `pipelineManager.js`의 AI 추론 코드 블록은 삭제하지 않고 `combined` 모드 분기 안으로 이동합니다:

```javascript
// 변경 전 (기존)
const result = await this._detector.detect(jpegBuffer);
// ... ByteTracker, BehaviorEngine 코드

// 변경 후 (분기 추가)
if (SERVER_MODE === 'streaming') {
  // analysisClient로 위임
} else {
  // combined: 기존 코드 100% 유지
  const result = await this._detector.detect(jpegBuffer);
  // ... ByteTracker, BehaviorEngine 코드
}
```

### 6.2 분기 비용 최소화

`SERVER_MODE`는 서버 시작 시 한 번만 읽어 모듈 스코프 상수로 저장합니다. 프레임마다 환경변수를 읽지 않아 성능 영향이 없습니다.

```javascript
const SERVER_MODE = (process.env.SERVER_MODE || 'combined').toLowerCase();
```

---

## 7. Sequence Diagrams

### 7.1 streaming 모드 — 정상 흐름

```
Browser          StreamingServer          AnalysisServer
   │                    │                       │
   │ WebSocket sub      │                       │
   │──────────────────►│                       │
   │                    │                       │
   │             [frame 이벤트 (JPEG)]           │
   │                    │                       │
   │◄────────────────── │ Socket.IO 'frame'     │
   │   (미리보기 JPEG)   │                       │
   │                    │ HTTP POST /api/       │
   │                    │  analysis/frame       │
   │                    │──────────────────────►│
   │                    │                       │ [YOLOv8 추론]
   │                    │                       │ [ByteTracker]
   │                    │                       │ [BehaviorEngine]
   │                    │   HTTP 200 JSON       │
   │                    │◄──────────────────────│
   │                    │                       │
   │◄────────────────── │ Socket.IO 'detections'│
   │   (bbox 오버레이)  │                       │
   │                    │                       │
```

### 7.2 streaming 모드 — 분석 서버 장애 (graceful degradation)

```
Browser          StreamingServer          AnalysisServer (down)
   │                    │                       │
   │             [frame 이벤트]                  │
   │◄────────────────── │ Socket.IO 'frame'     │
   │   (미리보기 유지)   │                       │
   │                    │ HTTP POST (실패)      │
   │                    │──────────────────────►│ ECONNREFUSED
   │                    │◄──────────────────────│
   │                    │ errorFrames++          │
   │                    │ return null            │
   │                    │                       │
   │  (bbox 오버레이 없음, 스트림 계속)           │
   │                    │                       │
```

### 7.3 streaming 모드 — 백프레셔

```
StreamingServer          AnalysisServer
      │                       │
      │ [frame#1 도착]         │
      │ concurrentRequests=1  │
      │──────────────────────►│ 처리 중...
      │                       │
      │ [frame#2 도착]         │
      │ concurrentRequests=2  │
      │──────────────────────►│ 처리 중...
      │                       │
      │ [frame#3, #4 도착]     │
      │ concurrentRequests=4  │ (maxConcurrent=4)
      │ 처리 중...             │
      │                       │
      │ [frame#5 도착]         │
      │ concurrentRequests>=4 │
      │ droppedFrames++ ✗     │ (HTTP 요청 안 보냄)
      │                       │
      │ [frame#1 완료]         │
      │ concurrentRequests=3  │
      │                       │
      │ [frame#6 도착]         │
      │ concurrentRequests=4  │
      │──────────────────────►│ 처리 재개
```

### 7.4 per-camera context 자동 정리

```
AnalysisServer
      │
      │ [카메라 A 프레임 수신 — lastSeenAt 갱신]
      │
      │ ... 5분 경과 ...
      │
      │ [60초 타이머 tick]
      │ for each ctx in Map:
      │   if now - ctx.lastSeenAt > 300_000ms:
      │     Map.delete(cameraId)  ← 카메라 A 컨텍스트 삭제
      │
      │ [카메라 A 프레임 재수신]
      │ Map.has('camera-A')? → false
      │ → new ByteTracker() + new BehaviorEngine()
      │ → objectId 1번부터 재시작
```

---

## 8. File & Module Layout

### 8.1 신규 파일

```
server/src/
├── services/
│   └── analysisClient.js    # HTTP POST 클라이언트 (streaming 서버용, 싱글턴)
└── routes/
    └── analysisApi.js       # Express 라우터 (analysis 서버용)
```

### 8.2 수정 파일

```
server/src/
├── services/
│   └── pipelineManager.js   # streaming 모드 분기 추가 (frame 핸들러 내)
├── index.js                 # 모드별 초기화, analysisApi 라우터 등록
└── .env.example             # SERVER_MODE 등 4개 환경변수 추가
```

---

## 9. Configuration & Environment

| 환경변수 | 기본값 | 적용 모드 | 설명 |
|---|---|---|---|
| `SERVER_MODE` | `combined` | 전체 | 서버 운영 모드 |
| `ANALYSIS_SERVER_URL` | (없음) | streaming | analysis 서버 기본 URL |
| `ANALYSIS_REQUEST_TIMEOUT_MS` | `5000` | streaming | 분석 요청 타임아웃 (ms). 최악의 경우 추론 시간보다 크게 설정 (CPU: 5000, GPU: 2000) |
| `ANALYSIS_MAX_CONCURRENT` | `4` | streaming, analysis | 최대 동시 요청 수 |
| `ANALYSIS_FPS` | `0` | streaming | 카메라당 analysis 서버 전송 fps 상한. `0` = unlimited (latest-frame-wins 자동 조절, 권장). `N > 0` = 하드 캡 N fps |

---

## 10. Error Handling

| 오류 상황 | 처리 방식 | 영향 범위 |
|---|---|---|
| analysis 서버 연결 실패 (ECONNREFUSED) | `errorFrames++`, `return null`, `console.warn` | 해당 프레임만 드롭 |
| analysis 서버 타임아웃 | AbortController 취소, `timeoutFrames++`, `return null` | 해당 프레임만 드롭 |
| analysis 서버 503 (백프레셔) | `errorFrames++`, `return null` | 해당 프레임만 드롭 |
| analysis 서버 4xx 오류 | `errorFrames++`, `console.warn` | 해당 프레임만 드롭 |
| Base64 디코딩 실패 (analysis 서버) | `400 Bad Request` 반환, 파이프라인 중단 없음 | 해당 요청만 실패 |
| ONNX 추론 오류 (analysis 서버) | `500 Internal Server Error`, `console.error` | 해당 요청만 실패 |
| `ANALYSIS_SERVER_URL` 미설정 (streaming 시작) | 경고 로그 출력 후 원격 분석 비활성 | 영상 스트리밍 유지, AI 결과 미수신 |
| 잘못된 `SERVER_MODE` 값 | `process.exit(1)`, 에러 메시지 출력 | 서버 시작 실패 |
