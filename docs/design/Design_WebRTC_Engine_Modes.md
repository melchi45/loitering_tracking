# DESIGN DOCUMENT
# WebRTC Engine Modes — mediamtx / mediasoup / werift

| | |
|---|---|
| **Document ID** | DESIGN-LTS-WRTC-03 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-06-16 |
| **Parent SRS** | [srs/SRS_WebRTC_Media_Gateway.md](../srs/SRS_WebRTC_Media_Gateway.md) |
| **Parent TC** | [tc/TC_WebRTC_Media_Gateway.md](../tc/TC_WebRTC_Media_Gateway.md) |
| **Related** | [Design_RTSP_Capture_Backend.md](Design_RTSP_Capture_Backend.md) · [Design_DataChannel_CameraEvents.md](Design_DataChannel_CameraEvents.md) · [Design_ONVIF_Metadata_Pipeline.md](Design_ONVIF_Metadata_Pipeline.md) |

---

## 1. 개요

`WEBRTC_ENGINE` 환경변수로 WebRTC SFU/서버 백엔드를 선택합니다.  
세 가지 엔진이 `server/src/services/webrtcEngineFactory.js`를 통해 통합 인터페이스로 제공됩니다.

```
server/.env (또는 .env_streaming / .env_analysis)
  WEBRTC_ENGINE=mediamtx   ← 기본값 (외부 MediaMTX WHEP)
  WEBRTC_ENGINE=mediasoup  ← Node.js 내장 SFU (DataChannel·정밀 제어)
  WEBRTC_ENGINE=werift     ← 순수 TypeScript 구현 (스텁, 미구현)
```

---

## 2. 엔진 비교

| 특성 | mediamtx | mediasoup | werift |
|------|----------|-----------|--------|
| **구현 상태** | ✅ 운영 중 (기본값) | ✅ 운영 중 | 🚧 스텁 (미구현) |
| **비디오 소스** | MediaMTX RTSP loopback → WHEP | ingest-daemon H.264 RTP → UDP | - |
| **오디오 소스** | MediaMTX WHEP | ingest-daemon Opus RTP → UDP | - |
| **DataChannel** | ❌ 미지원 | ✅ DirectTransport → DataConsumer | - |
| **ONVIF App RTP** | Socket.IO 전용 | Socket.IO + DataChannel | - |
| **SDP 협상** | MediaMTX WHEP endpoint (`/whep/:id`) | 자체 WHEP endpoint (`/api/webrtc/whep/:id`) | - |
| **복잡도** | 낮음 (외부 프로세스 의존) | 높음 (라우터·트랜스포트·프로듀서) | - |
| **의존성** | MediaMTX 바이너리 필수 | mediasoup npm 패키지 (C++ addon) | werift npm 패키지 |

---

## 3. mediamtx 모드 (`WEBRTC_ENGINE=mediamtx`)

### 3.1 아키텍처

```
IP 카메라 (RTSP)
    │
    ▼
MediaMTX (포트 8554 RTSP, 8889 HTTP/WHEP)
    │  RTSP loopback → ingest-daemon JPEG/프레임
    │  WHEP  → 브라우저 WebRTC SDP
    ▼
ingest-daemon (PyAV)
    ├── JPEG → POST /api/internal/frame/:id   (AI 파이프라인)
    └── App RTP → POST /api/internal/apprtp/:id (ONVIF 메타데이터)
    
브라우저 ← MediaMTX WHEP (video+audio SRTP)
브라우저 ← Socket.IO appRtp (ONVIF 메타데이터, DataChannel 없음)
```

### 3.2 환경 설정

```bash
# server/.env_streaming (또는 .env)
WEBRTC_ENGINE=mediamtx
CAPTURE_BACKEND=ingest-daemon
MEDIAMTX_URL=http://localhost:8889  # MediaMTX HTTP API
```

### 3.3 특징

- **DataChannel 없음**: ONVIF 메타데이터는 Socket.IO `appRtp` 이벤트로만 전달
- MediaMTX 프로세스가 필수 (startServer.js가 자동 시작)
- `mediamtx.yml`에서 경로·인증·HLS/RTMP 설정 가능
- WHEP 엔드포인트: `https://localhost:3443/api/webrtc/whep/:cameraId`  
  내부적으로 MediaMTX WHEP `http://localhost:8889/:cameraId/whep`로 프록시

### 3.4 관련 파일

| 파일 | 역할 |
|------|------|
| `server/src/services/webrtc/mediamtxEngine.js` | WHEP 프록시·상태 관리 |
| `mediamtx.yml` | MediaMTX 미디어 서버 설정 |
| `server/src/scripts/startServer.js` | MediaMTX 자동 시작 |

---

## 4. mediasoup 모드 (`WEBRTC_ENGINE=mediasoup`)

### 4.1 아키텍처

```
IP 카메라 (RTSP)
    │
    ▼
ingest-daemon (PyAV)
    ├── JPEG    → POST /api/internal/frame/:id      (AI 파이프라인)
    ├── H.264   → UDP:{mediasoupPort}               (비디오 RTP)
    ├── Opus    → UDP:{mediasoupAudioPort}           (오디오 RTP)
    └── App RTP → POST /api/internal/apprtp/:id     (ONVIF 메타데이터)

mediasoup Router
    ├── PlainTransport  ← H.264 RTP (videoProducer)
    ├── PlainTransport  ← Opus RTP  (audioProducer)
    ├── DirectTransport ← Node.js dataProducer.send() (dataProducer)
    └── WebRtcTransport → 브라우저
           ├── videoConsumer  → SRTP video
           ├── audioConsumer  → SRTP audio
           └── dataConsumer   → SCTP DataChannel
```

### 4.2 환경 설정

```bash
# server/.env_streaming
WEBRTC_ENGINE=mediasoup
CAPTURE_BACKEND=ingest-daemon
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=192.168.1.100  # 서버 LAN IP (브라우저가 접근 가능한 IP)
MEDIASOUP_RTC_MIN_PORT=40000
MEDIASOUP_RTC_MAX_PORT=49999
```

### 4.3 SDP 협상 흐름

```
브라우저 (useWebRTC.ts)
  1. pc.createDataChannel('init', ...)   ← m=application 강제 포함
  2. createOffer() → SDP offer
  3. ICE gathering (host candidates only — srflx/relay 필터링)
  4. POST /api/webrtc/whep/:cameraId  {SDP offer}

서버 (mediasoupEngine.js negotiate())
  5. SDP 파싱 → hasVideo, hasAudio, hasData 추출
  6. WebRtcTransport 생성 (SCTP 활성화)
  7. videoConsumer, audioConsumer 생성
  8. hasData && dataProducer.alive → dataConsumer 생성
  9. _buildAnswer() → SDP answer (m=application SCTP 포함)
  10. 응답 {SDP answer}

브라우저
  11. setRemoteDescription(answer)
  12. ICE/DTLS 연결
  13. pc.ondatachannel → DataChannel 수신 대기
```

### 4.4 DataProducer → DataConsumer 연결

```javascript
// addCameraStream() — 카메라당 1회 생성
const directTransport = await router.createDirectTransport({ maxMessageSize: 262144 });
const dataProducer = await directTransport.produceData({
  label: `apprtp-${cameraId}`,
  protocol: 'raw',
});

// negotiate() — 브라우저 접속 시마다
const dataConsumer = await transport.consumeData({
  dataProducerId: cam.dataProducer.id,
});

// sendAppRtp() — ingest-daemon POST 수신 시
cam.dataProducer.send(JSON.stringify(payload));
// → DirectTransport → DataConsumer → 브라우저 SCTP → ondatachannel
```

### 4.5 관련 파일

| 파일 | 역할 |
|------|------|
| `server/src/services/webrtc/mediasoupEngine.js` | Router·Transport·Producer·Consumer 관리 |
| `server/src/routes/internalApi.js` | `sendAppRtp()` 호출 (경로 수정: `../services/webrtcEngineFactory`) |
| `client/src/hooks/useWebRTC.ts` | `pc.createDataChannel('init')`, `ondatachannel` |

### 4.6 RTP Payload Type (PT) 제약

> **mediasoup v3.19+ 는 Consumer의 PT를 Router의 `preferredPayloadType` 에서 고정으로 가져옵니다.**  
> `transport.consume({ rtpCapabilities })` 에 전달하는 `preferredPayloadType` 은 무시됩니다.

| 브라우저 | H264 CBP (42e01f, pm=1) PT | RTX PT | Opus PT |
|---------|---------------------------|--------|---------|
| Edge    | **109**                   | 114    | 111     |
| Chrome  | 108 (offer) → answer 109 수락 | 109 (offer) → answer 제거 | 111 |

**Router 설정 (`_boot()`):**
```javascript
_router = await _worker.createRouter({
  mediaCodecs: [
    { kind: 'video', mimeType: 'video/H264', preferredPayloadType: 109, ... },
    { kind: 'audio', mimeType: 'audio/opus', preferredPayloadType: 111, ... },
  ],
});
```

- **PT=109** 를 사용하는 이유: Edge 브라우저는 H264에 PT=109를 할당하며, 서버 answer가 PT=108이면 `candidate-pair.bytesReceived`는 증가하지만 `inbound-rtp`가 생성되지 않아 검은 화면이 됩니다.
- Chrome은 H264를 PT=108로 offer하지만 answer에서 PT=109=H264로 재정의해도 RFC 8829 JSEP 규정에 따라 수락합니다.
- 진단: `GET /api/client-logs/webrtc` 응답에서 `inbound-rtp` 항목 부재 + `candidate-pair.bytesReceived > 0` 조합이 PT mismatch의 확실한 신호입니다.

### 4.7 ICE Candidate 필터링 (`_getListenIps()`)

mediasoup WebRtcTransport의 listenIps는 `SERVER_IP` / `SERVER_PUBLIC_IP` 환경변수만 사용합니다.  
`os.networkInterfaces()` 전체를 사용하면 서버 자신의 공인 IP가 후보로 들어가고, 브라우저 PC가 같은 IP를 host candidate로 갖고 있을 때 **loopback ICE path** 가 형성돼 SRTP가 브라우저가 아닌 서버 자신에게 전달됩니다.

```javascript
function _getListenIps() {
  const ips = new Set();
  const serverIp    = (process.env.SERVER_IP        || '').trim();
  const serverPubIp = (process.env.SERVER_PUBLIC_IP || '').trim();
  if (serverIp    && serverIp    !== '0.0.0.0') ips.add(serverIp);
  if (serverPubIp && serverPubIp !== '0.0.0.0') ips.add(serverPubIp);
  if (ANNOUNCED_IP  && ANNOUNCED_IP  !== '0.0.0.0') ips.add(ANNOUNCED_IP);
  const list = [...ips];
  if (list.length === 0) return [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }];
  return list.map(ip => ({ ip, announcedIp: ip }));
}
```

서버 시작 로그에서 `announcedIps=[192.168.x.x]` 가 단일 LAN IP인지 확인하세요.

---

## 5. werift 모드 (`WEBRTC_ENGINE=werift`)

> **현재 스텁(stub) 상태입니다. 아래 인터페이스만 정의되어 있으며 실제 동작하지 않습니다.**

```javascript
// server/src/services/webrtc/weriftEngine.js (스텁)
module.exports = {
  ENGINE_NAME: 'werift',
  async addCameraStream() { throw new Error('werift not implemented'); },
  async negotiate()       { throw new Error('werift not implemented'); },
  // ...
};
```

**구현 시 고려사항:**
- `werift` npm 패키지 — 순수 TypeScript WebRTC 구현
- MediaMTX/mediasoup 없이 Node.js 단독으로 SFU 가능
- DataChannel 지원 예정

---

## 6. 공통 인터페이스 (`webrtcEngineFactory.js`)

모든 엔진이 노출해야 하는 인터페이스:

```javascript
// server/src/services/webrtcEngineFactory.js
module.exports = { getEngine, WEBRTC_ENGINE };

// 모든 엔진 공통 인터페이스
{
  ENGINE_NAME:              string,
  addCameraStream(cameraId, rtspUrl)     → Promise<boolean>,
  removeCameraStream(cameraId)           → Promise<void>,
  waitForStreamReady(cameraId, ms)       → Promise<boolean>,
  negotiate(cameraId, sdpOffer)          → Promise<{ status, sdpAnswer, headers }>,
  isHealthy()                            → Promise<boolean>,
  getEngineInfo()                        → object,
  // mediasoup 전용 — 다른 엔진은 no-op
  sendAppRtp(cameraId, payload)          → void,
}
```

엔진은 `getEngine()` lazy 싱글톤으로 제공되므로 프로세스 내 모든 모듈에서 동일 인스턴스를 공유합니다.

---

## 7. App RTP(ONVIF) 전달 경로 비교

| 경로 | mediamtx | mediasoup | werift |
|------|----------|-----------|--------|
| Socket.IO `appRtp` | ✅ (유일) | ✅ (redundant) | 미구현 |
| WebRTC DataChannel | ❌ | ✅ (primary) | 미구현 |
| 클라이언트 dedup | - | seq 기반 `_lastSeqs` | - |

---

## 8. 엔진 전환 방법

```bash
# streaming 서버 환경파일 수정
vi server/.env_streaming
# WEBRTC_ENGINE=mediamtx  →  WEBRTC_ENGINE=mediasoup

# 서버 재시작
cd server && npm run stop:streaming && npm run streaming
```

엔진 전환 시 기존 WebRTC 세션은 모두 끊깁니다 — 브라우저 새로고침 필요.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — mediamtx·mediasoup·werift 세 엔진 상세 비교 |
| 1.1 | 2026-06-16 | §4.6 RTP PT 제약 추가 (PT=109 선택 근거, Edge/Chrome 비교, 진단 방법), §4.7 ICE loopback 방지 `_getListenIps()` 추가 |
