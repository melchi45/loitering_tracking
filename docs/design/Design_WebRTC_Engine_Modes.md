# DESIGN DOCUMENT
# WebRTC Engine Modes — mediamtx / mediasoup / werift

| | |
|---|---|
| **Document ID** | DESIGN-LTS-WRTC-03 |
| **Version** | 1.2 |
| **Status** | Active |
| **Date** | 2026-07-23 |
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

> **2026-07-23 갱신 — 실제 운영 결과 반영.** `server/.env`는 현재 `WEBRTC_ENGINE=mediamtx`로 고정되어 있다. mediasoup 경로는 코드상 완전히 남아있지만(§4) 이 설정에서는 전혀 실행되지 않는 dormant 상태이며, 실측상 mediamtx 대비 끊김·재생 불가가 반복 관찰되어 기본 엔진에서 제외되었다(§9 운영 비교 결론 참조).

| 특성 | mediamtx (현재 활성) | mediasoup (현재 비활성) | werift |
|------|----------|-----------|--------|
| **구현 상태** | ✅ 운영 중 (기본값, `.env` 고정) | 🟡 코드 존재·dormant (env로만 활성화 가능) | 🚧 스텁 (미구현) |
| **카메라 RTSP 접속** | MediaMTX가 카메라를 Pull(1개) → 로컬 루프백 재발행 | ingest-daemon이 카메라에 직접 단일 PyAV 세션(1개), 그 안에서 4갈래 팬아웃 | - |
| **비디오 소스** | MediaMTX RTSP loopback(`:8554`) → WHEP | ingest-daemon H.264 RTP → UDP PlainTransport | - |
| **오디오 소스** | MediaMTX WHEP | ingest-daemon Opus RTP → UDP PlainTransport (비-Opus는 전용 워커 스레드에서 실시간 트랜스코드) | - |
| **미디어 서버 주체** | 외부 프로세스(Go 바이너리) | Node.js 프로세스 내장 SFU (Worker Pool, §4.8) | - |
| **DataChannel** | ❌ 미지원 | ✅ DirectTransport → DataConsumer | - |
| **ONVIF App RTP** | Socket.IO 전용 | Socket.IO + DataChannel | - |
| **SDP 협상** | MediaMTX WHEP endpoint 프록시 (`/api/webrtc/whep/:id`) | 자체 WHEP 스타일 `negotiate()` (`/api/webrtc/whep/:id`, 동일 엔드포인트를 엔진별로 디스패치) | - |
| **코덱 PT 매칭** | MediaMTX가 표준 WHEP 처리 — 해당 이슈 없음 | 브라우저별 offer PT가 다르면 alt-PT Router를 그때그때 생성(§4.6) | - |
| **H.265/HEVC** | MediaMTX는 코덱 무관 재발행 | ❌ mediasoup 3.21.x 자체가 H.265 미지원 — 재생 불가(§4.9) | - |
| **복잡도** | 낮음 (외부 프로세스에 위임) | 높음 (Worker Pool·Router·Transport·Producer·Consumer·alt-PT 캐시) | - |
| **의존성** | MediaMTX 바이너리 필수 | mediasoup npm 패키지 (C++ addon), Linux에서는 우선순위 wrapper 바이너리(§4.8) | werift npm 패키지 |

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

### 4.6 RTP Payload Type (PT) 제약 — 2026-07-23 갱신: 고정 PT → alt-PT Router 캐시

> **mediasoup은 Producer의 outgoing PT를 Router 부팅 시점에 영구 고정합니다.** `transport.consume()`에 매번 전달하는 `remoteRtpCapabilities`는 코덱 호환성 필터로만 쓰일 뿐 실제 송신 PT를 바꾸지 못합니다(`ortc.js`의 `getConsumableRtpParameters()`/`getConsumerRtpParameters()` 직접 확인). 아래 §4.6-구버전 문단은 "PT=109 하나로 고정하면 된다"는 전제로 작성되었으나, 실측 결과 브라우저(Chrome/Edge)마다, 심지어 같은 Chrome이라도 세션마다 offer PT가 달라 **단일 고정값으로는 해결되지 않는다**는 것이 확인되어 §4.6a의 동적 캐시 방식으로 대체되었습니다.

**현재 구현 (`mediasoupEngine.js`):**

- `DEFAULT_VIDEO_PT = 108` — 기본 Router(`_buildDefaultMediaCodecs()`)는 H.264를 PT=108로 선언합니다. (구버전 문서의 "PT=109 고정"은 더 이상 유효하지 않음 — 실제 Chrome 오프셋 조사 결과 PT=108이 RTX 슬롯과 충돌 없는 Chrome 자체 기본 H264 PT임을 확인.)
- Opus는 PT=111 고정.
- RTX(재전송)는 mediasoup이 자동 생성 — Router의 `_rtxPtReservations` 8개 placeholder 오디오 코덱 엔트리로 PT 100~107을 미리 점유시켜, H264 RTX가 정확히 PT=109(Chrome이 실제 오퍼하는 RTX 슬롯)에 배정되도록 강제합니다.

### 4.6a Alt-PT Router 캐시 (§6.26)

브라우저 offer의 H264 PT가 108이 아닌 경우(관측: Chrome이 109를 offer하는 세션 다수 존재), **그 PT 전용 Router + PlainTransport + Producer 세트를 그 자리에서 새로 생성**합니다.

```javascript
// mediasoupEngine.js — negotiate() 도중 PT 불일치 감지 시
_ensureAltPipeline(cameraId, videoPt, videoRtxPt)
  → _ensurePtRouter(workerIndex, videoPt, videoRtxPt)   // 캐시: "workerIndex:videoPt" → Router
  → _buildAltPipeline(cameraId, cam, videoPt, videoRtxPt)
       videoPlain = router.createPlainTransport(...)
       videoProducer = videoPlain.produce(...)
       POST ingest-daemon /cameras/:id/video-fanout { port }  // 기존 RTSP 세션 재사용, 팬아웃 포트만 추가
```

- 같은 PT를 쓰는 이후 모든 브라우저·카메라 조합은 캐시된 Router를 재사용합니다 — PT는 브라우저+OS+버전의 거의 결정론적 함수이므로 무한정 늘어나지 않습니다.
- alt-PT 파이프라인은 비디오 + App RTP DataChannel만 제공하며(오디오는 §4.6 각주 — 실측상 오디오 PT 불일치 사례가 보고된 적 없어 범위 밖으로 남김), `cam.videoOnly`인 카메라는 App RTP도 생략합니다.
- 워커가 죽으면(`_handleWorkerDied`) 해당 워커의 alt-PT 파이프라인도 함께 폐기되고, 다음 `negotiate()`에서 재구축되는 지연 self-heal 방식입니다.

**진단**: `GET /api/client-logs/webrtc` 응답에서 `inbound-rtp` 항목 부재 + `candidate-pair.bytesReceived > 0` 조합이 PT mismatch의 확실한 신호입니다(§4.6a 도입 이전 구버전 진단 방법과 동일하게 유효).

### 4.6-구버전 (2026-06-16, 폐기됨) — 단일 고정 PT=109 방식

> **아래는 최초 구현 당시의 설계였으나 §4.6a로 대체되었습니다. 실측상 세션마다 다른 PT가 관측되어 단일 값 고정으로는 근본 해결이 안 됨을 확인했습니다. 이력 참고용으로만 남깁니다.**

| 브라우저 | H264 CBP (42e01f, pm=1) PT | RTX PT | Opus PT |
|---------|---------------------------|--------|---------|
| Edge    | 109                        | 114    | 111     |
| Chrome  | 108 (offer) → answer 109 수락(당시 관측) | 109 (offer) → answer 제거 | 111 |

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

### 4.8 Worker Pool (2026-07-22, §6.31)

> 상세: [Design_Mediasoup_Multi_Worker.md](Design_Mediasoup_Multi_Worker.md)

과거에는 서버 전체가 mediasoup Worker(OS 스레드) 1개 + Router 1개를 공유했습니다. 27명이 동시 로그인하는 공유 호스트에서 실측한 결과, 카메라 1대만 붙어 있어도 mediasoup-worker의 UDP 수신 큐(Recv-Q)에 수 MB 백로그가 쌓이고 `/proc/net/snmp`의 `Udp.RcvbufErrors`가 실시간으로 증가하는 반면, 해당 프로세스 CPU 사용률은 2~5%에 불과했습니다 — CPU 용량이 아니라 **OS 스케줄링 지연**이 병목이라는 뜻입니다.

- `MEDIASOUP_NUM_WORKERS`(기본 `min(cpuCount, 8)`)개의 Worker Pool로 전환 — 각 슬롯이 독립된 Worker+Router를 가짐.
- 카메라 → Worker 배정은 `cameraId` 해시 기반 결정론적 매핑(`_workerIndexFor()`), 카메라 생애주기 동안 고정.
- 한 Worker가 죽어도 그 Worker에 배정된 카메라만 영향을 받고(`_handleWorkerDied`), 2초 후 자동 재등록.
- 공유 호스트 배려 차원에서 Worker 프로세스 `nice` 값을 기본 `-5`로 상향(`MEDIASOUP_WORKER_PRIORITY`) — Node 프로세스가 자식 프로세스에 직접 `os.setPriority()`를 걸어도 `CAP_SYS_NICE`는 대상이 아닌 호출자 기준으로 검사되어 무효였고, `tools/mediasoup-worker-priority-wrapper`(C 바이너리, 자신에게 `CAP_SYS_NICE`를 받아 실행 후 우선순위를 올리고 실제 `mediasoup-worker`로 체인 exec)가 필요했습니다. Linux 전용, 미빌드 시 직접 `os.setPriority()` 폴백(효과 제한적).

### 4.9 H.265/HEVC 미지원 (2026-07-20, §6.25)

mediasoup 3.21.x(설치 버전 및 당시 최신 3.21.2 모두 확인)는 `video/H265`를 아예 지원하지 않습니다 — `transport.produce()`에 H265 rtpParameters를 넘기면 `"media codec not supported [mimeType:video/H265]"`로 즉시 거부되어, 실측상 해당 카메라의 `addCameraStream()` 자체가 실패했습니다. 이는 이 코드베이스에서 고칠 수 있는 문제가 아니며(mediasoup 자체 제약), 해결책은 카메라를 H.264로 재설정하거나 향후 H.265 지원 mediasoup 릴리스를 기다리는 것뿐입니다. `_pollVideoCodec()`이 카메라의 실제 SPS를 파싱해 HEVC로 판정되면 로그에 명시적으로 경고를 남기지만, Producer 생성 자체를 막지는 않습니다(항상 H.264로 시도 후 위 에러로 실패).

mediamtx 엔진은 코덱을 해석하지 않고 그대로 재발행하므로 이 제약이 없습니다 — HEVC 카메라의 브라우저 WebRTC 재생이 필요하다면 mediamtx 엔진이 유일한 선택지입니다.

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

## 9. 운영 비교 결론 (2026-07-23)

이 프로젝트의 실제 배포 환경에서 두 엔진을 모두 운영해 본 결과:

| 관측 | mediamtx | mediasoup |
|---|---|---|
| 영상 끊김/재생 불가 보고 | 없음 | 반복 관측 (사용자 보고: "영상이 끊기고 잘 안보임") |
| 카메라 RTSP 접속 횟수 | MediaMTX 1개 (AI용 재접속은 로컬호스트 루프백이라 카메라 부담 없음) | ingest-daemon 1개, 하지만 그 안에서 PT 불일치·Worker 죽음 등 복구 로직이 다수 필요 |
| 장애 시 영향 범위 | MediaMTX 프로세스만 재시작하면 복구, Node 프로세스 자체는 영향 적음 | mediasoup Worker(Node 자식 프로세스) 사망 시 그 Worker의 카메라 전체 재등록 필요 |
| 코덱 제약 | 없음 (코덱 무관 재발행) | H.265 카메라 전면 재생 불가(§4.9) |
| 구현/유지보수 복잡도 | 낮음 (외부 프로세스 프록시) | 높음 (Worker Pool·alt-PT 캐시·IPC 타임아웃 방어 등 1,800줄+) |
| 현재 `.env` 설정 | ✅ `WEBRTC_ENGINE=mediamtx` (기본값, 활성) | 코드 보존, dormant |

**결론**: mediamtx는 "검증된 외부 미디어 서버에 위임"하는 단순 프록시 구조라 실패 지점이 적고 튜닝 부담이 없는 반면, mediasoup은 Node 프로세스 안에 SFU를 직접 내장해 카메라 RTSP 접속 횟수는 줄일 수 있지만 PT 매칭·Worker 스케줄링·HEVC 미지원 등 고유 복잡도와 리소스 경합 문제를 떠안습니다. 이 배포에서는 mediamtx가 안정성 측면에서 명확히 우위였으므로 기본 엔진으로 고정되어 있습니다. mediasoup 코드는 향후(예: 카메라의 동시 RTSP 세션 제한이 매우 엄격한 사이트, 또는 DataChannel을 통한 저지연 App RTP가 필수인 사이트) 재활성화할 가능성을 위해 삭제하지 않고 유지합니다.

관련 문서: [MRD_WebRTC_Engine_Modes.md](../mrd/MRD_WebRTC_Engine_Modes.md) · [RFP_WebRTC_Engine_Modes.md](../rfp/RFP_WebRTC_Engine_Modes.md) · [PRD_WebRTC_Engine_Modes.md](../prd/PRD_WebRTC_Engine_Modes.md) · [SRS_WebRTC_Engine_Modes.md](../srs/SRS_WebRTC_Engine_Modes.md) · [ops/WebRTC_Engine_Modes_Guide.md](../ops/WebRTC_Engine_Modes_Guide.md) · [tc/TC_WebRTC_Engine_Modes.md](../tc/TC_WebRTC_Engine_Modes.md)

> **참고**: `docs/rfp|prd|srs|tc/*_WebRTC_Media_Gateway.md` 문서 세트는 이 프로젝트 초기(2026-05)에 작성된, 실제로는 구현되지 않은 다른 아키텍처(FFmpeg 듀얼 출력 + mediasoup-client 캡차빌리티 교환 프로토콜)를 다룹니다. 현재 코드의 엔진 동작은 본 문서(Design_WebRTC_Engine_Modes.md)와 위 신규 문서 세트가 정확합니다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — mediamtx·mediasoup·werift 세 엔진 상세 비교 |
| 1.1 | 2026-06-16 | §4.6 RTP PT 제약 추가 (PT=109 선택 근거, Edge/Chrome 비교, 진단 방법), §4.7 ICE loopback 방지 `_getListenIps()` 추가 |
| 1.2 | 2026-07-23 | §2 비교표에 카메라 접속 방식·오디오 트랜스코드·PT 매칭 방식·HEVC 지원 여부 컬럼 추가; §4.6 PT=109 고정 방식을 폐기하고 §4.6a 동적 alt-PT Router 캐시로 대체(구버전은 §4.6-구버전으로 이력 보존); §4.8 Worker Pool(§6.31), §4.9 H.265 미지원(§6.25) 신설; §9 운영 비교 결론 신설 — 실측상 mediamtx가 안정적이었고 mediasoup은 dormant 상태임을 명문화, MRD/RFP/PRD/SRS/ops/TC 신규 문서 세트로 연결 |
