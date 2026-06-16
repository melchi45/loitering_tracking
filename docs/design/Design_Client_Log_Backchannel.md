# DESIGN DOCUMENT
# Client Log Backchannel — 브라우저 콘솔·WebRTC 통계 서버 수집

| | |
|---|---|
| **Document ID** | DESIGN-LTS-LOG-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-16 |
| **Related** | [Design_WebRTC_Client_Telemetry.md](Design_WebRTC_Client_Telemetry.md) · [Design_WebRTC_Engine_Modes.md](Design_WebRTC_Engine_Modes.md) |

---

## 1. 개요

브라우저에서 발생하는 콘솔 로그와 WebRTC PeerConnection 통계를 Socket.IO를 통해 서버로 실시간 전송하고, REST API로 조회·분석할 수 있게 합니다.  
별도 사이드카 없이 기존 Socket.IO 연결을 **백채널(backchannel)**로 재사용하는 것이 핵심입니다.

---

## 2. 기능 구성

### 2.1 기능 1 — 콘솔 로그 캡처 (event: `client:log`)

- `console.error/warn/info/log/debug`, `window.onerror`, `unhandledrejection` 인터셉트
- 각 항목을 즉시 `client:log` Socket.IO 이벤트로 emit
- 오프라인(소켓 끊김) 시 최대 100개 버퍼 → 재연결 시 flush

### 2.2 기능 2 — WebRTC 통계 수집 (event: `client:webrtc-stats`)

- `RTCPeerConnection` 생성자를 패치해 모든 PC를 자동 추적
- `useWebRTC.ts`에서 `registerPeerConnection(pc, cameraId)` 호출로 `cameraId` 태깅
- 5초마다 `pc.getStats()`를 폴링 → 유효 stat 카테고리만 필터링하여 emit

---

## 3. 아키텍처

```
브라우저
  ├── clientLogger.ts — initClientLogger()
  │     ├── console.* 인터셉트
  │     ├── window.onerror / unhandledrejection
  │     └── RTCPeerConnection 패치 + 5초 stats 폴링
  │
  ├── Socket.IO emit 'client:log'         { entries, sessionId, userAgent, pageUrl }
  └── Socket.IO emit 'client:webrtc-stats' { pcId, cameraId, stats, ... }
           │
           ▼
서버 — socket/streamHandler.js
  ├── on('client:log')         → db.insert('client_logs', ...)
  └── on('client:webrtc-stats') → db.insert('client_webrtc_stats', ...)
           │
           ▼
서버 — routes/clientLogs.js
  ├── POST   /api/client-logs              (브라우저 HTTP 직접 전송 경로 — 백업)
  ├── GET    /api/client-logs?level=&sessionId=&from=&to=&limit=
  ├── DELETE /api/client-logs
  ├── GET    /api/client-logs/webrtc?cameraId=&pcId=&limit=
  └── DELETE /api/client-logs/webrtc
           │
           ▼
db.js — JSON 파일 기반 스토리지
  ├── client_logs         (최대 10,000건)
  └── client_webrtc_stats (최대 5,000건)
```

---

## 4. 클라이언트 구현 (`client/src/clientLogger.ts`)

### 4.1 진입점

```typescript
// client/src/main.tsx
import { initClientLogger } from './clientLogger';
initClientLogger();  // 앱 시작 시 즉시 활성화
```

### 4.2 세션 ID

```typescript
export const SESSION_ID =
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
```

페이지 로드당 1개 생성. 모든 로그·통계에 포함되어 연관 분석 가능.

### 4.3 콘솔 캡처

```typescript
(['log', 'info', 'warn', 'error', 'debug'] as const).forEach((level) => {
  console[level] = (...args) => { _orig[level](...args); capture(level, args); };
});
window.addEventListener('error', (ev) => capture('error', [ev.message], ev.error?.stack));
window.addEventListener('unhandledrejection', (ev) => capture('error', [`UnhandledRejection: ...`]));
```

### 4.4 오프라인 버퍼

```typescript
const MAX_OFFLINE = 100;
let offlineBuffer: LogEntry[] = [];

// 소켓 재연결 시 flush
socket.on('connect', () => {
  if (offlineBuffer.length > 0) {
    const toSend = offlineBuffer.splice(0);
    socket.emit('client:log', { entries: toSend, ... });
  }
});
```

### 4.5 RTCPeerConnection 패치

```typescript
function _patchRTCPeerConnection() {
  const OrigPC = window.RTCPeerConnection;
  (window as any).RTCPeerConnection = function(config?) {
    const pc = new OrigPC(config);
    const pcId = Math.random().toString(36).slice(2, 9);
    pcRegistry.set(pcId, { pc, pcId, cameraId: null, created: new Date().toISOString() });
    pc.addEventListener('connectionstatechange', () => {
      if (['closed','failed'].includes(pc.connectionState)) pcRegistry.delete(pcId);
    });
    return pc;
  };
  (window as any).RTCPeerConnection.prototype = OrigPC.prototype;
}
```

### 4.6 PC 등록 (`useWebRTC.ts`에서 호출)

```typescript
// useWebRTC.ts
registerPeerConnection(pc, cameraId);

// clientLogger.ts
export function registerPeerConnection(pc: RTCPeerConnection, cameraId: string) {
  const pcId = Math.random().toString(36).slice(2, 9);
  pcRegistry.set(pcId, { pc, pcId, cameraId, created: new Date().toISOString() });
  pc.addEventListener('connectionstatechange', () => {
    if (['closed','failed'].includes(pc.connectionState)) pcRegistry.delete(pcId);
  });
}
```

### 4.7 수집하는 Stat 카테고리

```typescript
const STAT_TYPES_KEEP = new Set([
  'candidate-pair', 'inbound-rtp', 'outbound-rtp', 'remote-inbound-rtp',
  'transport', 'peer-connection', 'local-candidate', 'remote-candidate',
  'media-source', 'codec',
]);
```

---

## 5. 서버 구현

### 5.1 Socket.IO 핸들러 (`socket/streamHandler.js`)

```javascript
socket.on('client:log', ({ entries, sessionId, userAgent, pageUrl } = {}) => {
  for (const entry of entries) {
    db.insert('client_logs', {
      id: uuidv4(), sessionId, clientIp, userAgent, pageUrl,
      level: entry.level, message: entry.message,
      args: entry.args, stack: entry.stack,
      clientTs: entry.timestamp, serverTs: new Date().toISOString(),
    });
  }
});

socket.on('client:webrtc-stats', ({ sessionId, pcId, cameraId, stats, ... } = {}) => {
  db.insert('client_webrtc_stats', {
    id: uuidv4(), sessionId, pcId, cameraId,
    connectionState, iceConnectionState, signalingState,
    stats: JSON.stringify(stats), serverTs: new Date().toISOString(),
  });
});
```

### 5.2 REST API (`routes/clientLogs.js`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/client-logs` | 브라우저 HTTP 직접 전송 (소켓 불가 시 백업) |
| `GET` | `/api/client-logs` | 콘솔 로그 조회 (`level`, `sessionId`, `from`, `to`, `limit`) |
| `DELETE` | `/api/client-logs` | 콘솔 로그 전체 삭제 |
| `GET` | `/api/client-logs/webrtc` | WebRTC 통계 조회 (`cameraId`, `pcId`, `sessionId`) |
| `DELETE` | `/api/client-logs/webrtc` | WebRTC 통계 전체 삭제 |

### 5.3 DB 스키마 (`db.js`)

```javascript
// JSON 파일 기반, 최대 보존 건수 자동 순환
client_logs:         10_000건   // console.* 로그
client_webrtc_stats:  5_000건   // WebRTC getStats() 폴링 결과
```

---

## 6. Socket.IO 이벤트 스펙

### 6.1 `client:log` (Client → Server)

```typescript
{
  sessionId: string;           // 페이지 세션 고유 ID
  userAgent: string;           // 브라우저 user-agent
  pageUrl:   string;           // 현재 페이지 URL
  entries: Array<{
    level:     'log'|'info'|'warn'|'error'|'debug';
    message:   string;         // 최대 2000자
    args?:     string[];       // 추가 인수
    stack?:    string;         // Error.stack (에러 시)
    timestamp: string;         // ISO 8601
  }>;
}
```

### 6.2 `client:webrtc-stats` (Client → Server)

```typescript
{
  sessionId:          string;
  pcId:               string;    // 내부 PC 추적 ID
  cameraId:           string | null;
  created:            string;    // PC 생성 시각 ISO
  signalingState:     RTCSignalingState;
  connectionState:    RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  timestamp:          string;
  stats:              Record<string, RTCStats>;  // STAT_TYPES_KEEP 필터링됨
}
```

---

## 7. WebRTCPCSummary (StatsPanelModal 연동)

`client/src/components/StatsPanelModal.tsx`에서 `getWebRTCSnapshotAsync()`를 호출해  
현재 활성 PeerConnection의 요약 지표를 표시합니다:

```typescript
interface WebRTCPCSummary {
  pcId:               string;
  cameraId:           string | null;
  connectionState:    string;
  iceConnectionState: string;
  signalingState:     string;
  rttMs:              number | null;    // current RTT in ms
  packetLoss:         number | null;    // 0~1
  bytesReceived:      number;           // 총 수신 바이트 (audio+video)
  framesPerSecond:    number | null;    // 비디오 FPS
  localCandidateType: string | null;    // host / srflx / relay
}
```

---

## 8. 관련 파일

| 파일 | 역할 |
|------|------|
| `client/src/clientLogger.ts` | 콘솔 캡처·WebRTC 통계 수집·emit |
| `client/src/main.tsx` | `initClientLogger()` 호출 |
| `client/src/hooks/useWebRTC.ts` | `registerPeerConnection(pc, cameraId)` |
| `client/src/components/StatsPanelModal.tsx` | `getWebRTCSnapshotAsync()` 표시 |
| `server/src/socket/streamHandler.js` | `client:log`, `client:webrtc-stats` 수신 |
| `server/src/routes/clientLogs.js` | REST API 라우터 |
| `server/src/index.js` | `/api/client-logs` 라우터 마운트 |
| `server/src/db.js` | `client_logs`, `client_webrtc_stats` 테이블 정의 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — 브라우저 콘솔 로그·WebRTC stats 서버 수집 백채널 전체 기술 |
