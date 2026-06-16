# Design: DataChannel Camera Events Tab

**Feature:** RTSP Application RTP → WebRTC DataChannel → Camera Events UI  
**Version:** 1.0  
**Date:** 2026-06-16  
**Component:** `client/src/components/FullscreenCameraView.tsx` · `client/src/stores/dataChannelStore.ts`

---

## 1. 개요

RTSP 스트림에 포함된 application/data 트랙(Samsung ONVIF 메타데이터 등)을  
WebRTC DataChannel을 통해 브라우저로 전달하고, 전체화면 카메라 뷰의  
**Camera Events 탭**에 실시간으로 표시합니다.

---

## 2. 데이터 플로우

```
RTSP camera (data/subtitle track)
  │
  ▼
ingest_daemon.py  _app_rtp_loop()
  │  PyAV demux → base64 JSON
  │  POST /api/internal/apprtp/:cameraId
  │    { pt, timestamp, seq, payload }
  ▼
server/src/routes/internalApi.js
  │  POST /api/internal/apprtp/:cameraId
  │  → sendAppRtp(cameraId, data)            [mediasoup 모드]
  │  → io.emit('appRtp', { cameraId, ...})   [Socket.IO 동시 emit]
  ▼
server/src/services/webrtc/mediasoupEngine.js
  │  sendAppRtp()
  │  → cam.dataProducer.send(JSON.stringify(data))
  ▼
mediasoup DataConsumer (WebRtcTransport)
  │  SCTP/DTLS — m=application section
  ▼
Browser pc.ondatachannel  (client/src/hooks/useWebRTC.ts)
  │  dc.onmessage → JSON.parse(e.data)
  │  → pushDCMessage({ cameraId, ...msg })
  ▼
dataChannelStore.ts  (Zustand)
  │  messages, counts, history (throttled 5/s, max 100)
  ▼
FullscreenCameraView.tsx  CameraEventsTab
  │  history[cameraId] 구독 → 목록 렌더링
  ▼
사용자 화면 — Camera Events 탭 (영상 하단)
```

---

## 3. 전제 조건

| 조건 | 상태 |
|------|------|
| `WEBRTC_ENGINE=mediasoup` | streaming 모드 `.env_streaming` |
| `CAPTURE_BACKEND=ingest-daemon` | ingest_daemon.py PyAV |
| 카메라 RTSP에 data/subtitle 트랙 존재 | Samsung IP 카메라 ONVIF 메타데이터 |
| 브라우저 `pc.createDataChannel('init', ...)` | `useWebRTC.ts` — m=application SDP 강제 포함 |
| mediasoup negotiate 시 `parsed.hasData === true` | 브라우저 offer에 m=application 섹션 존재 |

---

## 4. 컴포넌트 구조

### 4.1 dataChannelStore.ts

| 필드 | 타입 | 설명 |
|------|------|------|
| `messages` | `Record<string, AppRtpMessage>` | 카메라별 최신 메시지 |
| `counts` | `Record<string, number>` | 카메라별 총 수신 건수 |
| `history` | `Record<string, AppRtpMessage[]>` | 카메라별 최근 100개 메시지 (200ms 스로틀) |
| `_lastHistoryTs` | `Record<string, number>` | 스로틀 기준 타임스탬프 (internal) |

**AppRtpMessage 인터페이스:**

```typescript
interface AppRtpMessage {
  cameraId:   string;   // 소스 카메라 ID
  pt:         number;   // RTSP 스트림 인덱스 (surrogate PT)
  timestamp:  number;   // 카메라 RTP 타임스탬프
  seq:        number;   // 순번 (ingest-daemon 내부 카운터)
  payload:    string;   // Base64 인코딩된 원본 패킷 바이트
  receivedAt: number;   // 브라우저 수신 wall-clock (Date.now())
}
```

**스로틀 정책:**
- `history` 업데이트: 카메라당 200ms 간격 (최대 5회/초)
- `messages`, `counts`: 매 메시지마다 업데이트 (스로틀 없음)
- `HISTORY_MAX = 100`: 초과 시 가장 오래된 항목 제거

### 4.2 CameraEventsTab 컴포넌트

**위치:** `FullscreenCameraView.tsx` — export function  
**Props:** `{ cameraId: string }`

```
┌─────────────────────────────────────────────────┐
│ CAMERA EVENTS                         [총 건수] │ ← 탭 헤더
├─────────────────────────────────────────────────┤
│ HH:MM:SS  #seq  pt96  <decoded payload preview> │
│ HH:MM:SS  #seq  pt96  <decoded payload preview> │
│ ...                                             │  ← 스크롤 영역
│ HH:MM:SS  #seq  pt96  <decoded payload preview> │
└─────────────────────────────────────────────────┘
```

**페이로드 디코딩 (`decodePayload`):**
1. Base64 → `Uint8Array`
2. `TextDecoder('utf-8', { fatal: false })` 디코딩
3. 제어문자 제거, 최대 200자로 truncate
4. 빈 결과 → `[binary NB]` 표시

**자동 스크롤:**
- `useEffect([history.length])` → 새 메시지 도착 시 `scrollTop = scrollHeight`

### 4.3 FullscreenCameraView 레이아웃 변경

```
┌────────────────────────────────┬──────────────┐
│  Header (카메라명 + 닫기)       │              │
├────────────────────────────────┤  Detection   │
│                                │  Panel       │
│  CameraView (영상)             │  (우측/하단) │
│  flex-1 min-h-0                │              │
├────────────────────────────────┤              │
│  [Camera Events] tab bar       │              │
├────────────────────────────────┤              │
│  CameraEventsTab               │              │
│  (height: 160px)               │              │
└────────────────────────────────┴──────────────┘
```

- 비디오 영역에 `min-h-0`을 추가해 flex 축소 허용
- 하단 탭 패널은 `height: 160px` 고정

---

## 5. ingest-daemon App RTP 구현

**파일:** `ingest-daemon/ingest_daemon.py`

| 메서드 | 역할 |
|--------|------|
| `_app_rtp_loop()` | 재시도 루프 with 지수 백오프 |
| `_app_rtp_ingest_once()` | PyAV로 RTSP data/subtitle 트랙 demux |

**App RTP 스레드 시작 조건:**
```python
if self.app_rtp_callback_url:
    self._start_thread("apprtp", self._app_rtp_loop)
```

**카메라 등록 시 `appRtpCallbackUrl` 포함:**
- `mediasoupEngine.js` `addCameraStream()` 및 `reregisterAllWithIngest()`가 항상 `appRtpCallbackUrl: ${base}/api/internal/apprtp/${cameraId}` 전달

**트랙 발견 결과 (Samsung IP 카메라 5대 기준):**

| 카메라 | 트랙 타입 | 전송 속도 |
|--------|-----------|-----------|
| `84daa428` | `type=data, codec=unknown` | ~38 pkts/s |
| `b7e9debd` | `type=data, codec=unknown` | ~33 pkts/s |
| `e940e057` | `type=data, codec=unknown` | ~33 pkts/s |
| `66bbc1fb` | `type=data, codec=unknown` | ~33 pkts/s |
| `07e34af3` | `type=data, codec=unknown` | ~33 pkts/s |
| `yt-4a936a83` | (없음) | 스레드 즉시 종료 |

---

## 6. 서버 측 App RTP 라우팅

**파일:** `server/src/routes/internalApi.js`

```
POST /api/internal/apprtp/:cameraId
  Body: { pt, timestamp, seq, payload }

  1. io.emit('appRtp', { cameraId, ...data })        ← Socket.IO 브로드캐스트
  2. getEngine().sendAppRtp(cameraId, data)           ← mediasoup DataProducer
```

**파일:** `server/src/services/webrtc/mediasoupEngine.js`

```javascript
function sendAppRtp(cameraId, payload) {
  const cam = _cameras.get(cameraId);
  if (!cam?.dataProducer || cam.dataProducer.closed) return;
  cam.dataProducer.send(JSON.stringify(payload));
}
```

---

## 7. WebRTC DataChannel 협상

**파일:** `client/src/hooks/useWebRTC.ts`

```typescript
// m=application 강제 포함 (서버가 DataConsumer 생성하도록)
pc.createDataChannel('init', { ordered: false, maxRetransmits: 0 });

// 서버 DataConsumer → 브라우저로 전달
pc.ondatachannel = (event) => {
  const dc = event.channel;
  dc.onmessage = (e) => {
    const msg = JSON.parse(e.data as string);
    pushDCMessage({ cameraId, ...msg });  // → dataChannelStore
  };
};
```

**negotiate 결과 확인:**
```
[WebRTC][mediasoup] negotiate OK [cameraId] audio=true data=true
```

---

## 8. i18n 문자열

| 키 | en | ko |
|----|----|----|
| `cameraEventsTab` | `Camera Events` | `카메라 이벤트` |
| `cameraEventsNoData` | `No events — waiting for RTSP metadata stream…` | `이벤트 없음 — RTSP 메타데이터 스트림 대기 중…` |

---

## 9. 관련 파일 변경 목록

| 파일 | 변경 내용 |
|------|----------|
| `client/src/stores/dataChannelStore.ts` | `history` 필드 추가 (스로틀 200ms, max 100) |
| `client/src/components/FullscreenCameraView.tsx` | `CameraEventsTab` 컴포넌트, 탭 바, 레이아웃 조정 |
| `client/src/i18n/translations/en.ts` | `cameraEventsTab`, `cameraEventsNoData` 키 추가 |
| `client/src/i18n/translations/ko.ts` | 동일 키 한국어 추가 |
| `ingest-daemon/ingest_daemon.py` | `_app_rtp_loop()`, `_app_rtp_ingest_once()` 추가 |
| `server/src/routes/internalApi.js` | `POST /api/internal/apprtp/:cameraId` (기존 구현) |
| `server/src/services/webrtc/mediasoupEngine.js` | `sendAppRtp()`, `directTransport`, `dataProducer` (기존 구현) |
| `server/src/scripts/restartIngestDaemon.js` | 데몬 로그를 `/tmp/ingest-daemon.log`로 리디렉션, 이벤트루프 블로킹 제거 |

---

## 10. 크로스 참조

- **WebRTC 아키텍처:** [Design_WebRTC_Media_Gateway.md](Design_WebRTC_Media_Gateway.md)
- **RTSP 캡처 백엔드:** [Design_RTSP_Capture_Backend.md](Design_RTSP_Capture_Backend.md)
- **대시보드 레이아웃:** [Design_Dashboard_Layout.md](Design_Dashboard_Layout.md)
- **감지 표시:** [Design_Dashboard_Detection_Display.md](Design_Dashboard_Detection_Display.md)
- **React 대시보드 스킬:** [react-dashboard-dev SKILL.md](../../.claude/skills/react-dashboard-dev/SKILL.md)

---

## 10. 크로스 참조 (추가)

- **ONVIF 메타데이터 구조**: [Design_ONVIF_Metadata_Pipeline.md](Design_ONVIF_Metadata_Pipeline.md)
- **WebRTC 엔진 모드**: [Design_WebRTC_Engine_Modes.md](Design_WebRTC_Engine_Modes.md)
- **클라이언트 로그 백채널**: [Design_Client_Log_Backchannel.md](Design_Client_Log_Backchannel.md)

---

## 11. 버그 수정 이력

### 2026-06-16: internalApi.js require 경로 오류 수정

**증상**: mediasoup DataChannel로 ONVIF 메타데이터가 전혀 전달되지 않음.

**원인**: `internalApi.js`에서 `require('../webrtcEngineFactory')`가 존재하지 않는 경로를  
참조 → `try/catch`에 의해 조용히 삼켜짐 → `sendAppRtp()` 한 번도 호출되지 않음.

```javascript
// Before (오류):
const { getEngine, WEBRTC_ENGINE } = require('../webrtcEngineFactory');
// After (수정):
const { getEngine, WEBRTC_ENGINE } = require('../services/webrtcEngineFactory');
```

### 2026-06-16: Socket.IO appRtp 리스너 별도 useEffect 분리

**증상**: Case A (기존 세션 재사용) 시 fullscreen 진입 후 CameraEventsTab에 이벤트 미표시.

**원인**: Socket.IO `appRtp` 리스너가 Case C (신규 협상)에서만 등록됨.

**수정**: 별도 `useEffect([cameraId, enabled, socket, pushDCMessage])`로 분리하여  
Case A/B/C 모든 경우에서 등록되도록 변경. mediamtx 모드 fallback도 동시 지원.

### 2026-06-16: dataChannelStore seq 기반 dedup 추가

DataChannel + Socket.IO 이중 경로에서 동일 패킷 double-count 방지.  
`_lastSeqs: Record<string, number>` 추가 — `msg.seq <= lastSeq` 시 상태 변경 없음.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — RTSP App RTP → DataChannel → Camera Events Tab 전체 파이프라인 |
| 1.1 | 2026-06-16 | 버그 수정 3건 반영 (require 경로·useEffect 분리·seq dedup) 및 크로스 참조 추가 |
