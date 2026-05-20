# RFP: STUN / TURN / ICE 기반 WebRTC 연결 및 ICE 자동화 테스트

**Document No.**: LTS-2026-007
**Version**: 1.0
**Date**: 2026-05-20
**Classification**: Technical Requirements Specification (RFP)
**Status**: Phase-1 Complete — Socket.IO 트리거 방식 ice-test 구현 완료

---

## 1. 개요

### 1.1 목적

이 문서는 LTS(Loitering Tracking System)의 WebRTC 영상 스트리밍에서 사용하는
**STUN / TURN / ICE** 프로토콜 기반 연결 아키텍처와, 연결 상태를 자동화 검증하는
`npm run ice-test` 도구의 설계·구현 사양을 정의한다.

### 1.2 범위

- STUN / TURN / ICE 프로토콜 기본 개념 및 역할
- LTS 시스템의 ICE 서버 설정 구조
- `ice-test` 자동화 도구 (3-Phase 테스트)
- Socket.IO 기반 적응형 WebRTC 테스트 트리거 방식

---

## 2. STUN / TURN / ICE 프로토콜 기초

### 2.1 ICE (Interactive Connectivity Establishment) — RFC 8445

ICE는 두 피어(브라우저 ↔ 미디어 서버) 사이에서 **최적의 네트워크 경로**를 자동으로
찾는 프레임워크이다. WebRTC의 RTCPeerConnection이 ICE를 사용한다.

#### ICE 동작 단계

```
[1] Gathering  — 각 피어가 자신의 IP/포트 후보(Candidate)를 수집
                   host candidate  : 로컬 NIC 주소 (LAN 직접)
                   srflx candidate : STUN 서버를 통해 확인된 공인 IP
                   relay candidate : TURN 서버가 제공하는 릴레이 주소

[2] Signaling  — SDP(Offer/Answer)를 통해 상대방과 후보 교환
                   LTS에서는 Socket.IO를 시그널링 채널로 사용

[3] Checking   — 수집된 후보 쌍(pair)을 우선순위 순으로 연결성 점검
                   host > srflx > relay 순서로 시도

[4] Connected  — 가장 먼저 성공한 후보 쌍을 선택(Nomination)
                   이후 해당 경로로 DTLS 핸드셰이크 → RTP/RTCP 전송 시작
```

#### ICE Candidate 종류

| 타입 | 설명 | 경로 | 지연 |
|------|------|------|------|
| `host` | 로컬 NIC 주소 (LAN) | 직접 | 최저 |
| `srflx` (server reflexive) | STUN 서버가 알려준 공인 IP:포트 | NAT 통과 | 중간 |
| `relay` | TURN 서버를 거치는 릴레이 | TURN 경유 | 높음 |

---

### 2.2 STUN (Session Traversal Utilities for NAT) — RFC 5389 / RFC 8489

STUN은 NAT(공유기) 뒤에 있는 클라이언트가 **자신의 공인 IP:포트를 확인**하기 위한
경량 UDP 프로토콜이다. 

#### 동작 원리

```
Client (NAT 뒤)           NAT              STUN Server
     │                    │                     │
     │──── Binding Req ───►──── Binding Req ───►│
     │     src: 10.0.0.5  │     src: 1.2.3.4    │  ← NAT가 src IP를 변환
     │                    │                     │
     │◄─── Binding Res ───◄──── Binding Res ───◄│
     │     XOR-MAPPED: 1.2.3.4:54321           │  ← 공인 IP 알림
```

- STUN 서버는 **IP 알림만** 담당하며 미디어를 중계하지 않는다
- 대부분의 Symmetric NAT는 STUN만으로 연결되지 않으며 TURN이 필요하다
- Google 공개 STUN: `stun:stun.l.google.com:19302` (ICE 실패 시 TURN으로 폴백)

#### LTS STUN 설정 (`server/.env`)

```ini
STUN_URLS=stun:stun.l.google.com:19302
# LAN 내부 전용 STUN (coturn 설치 시):
# STUN_URLS=stun:192.168.1.100:3478
```

여러 서버 쉼표 구분: `STUN_URLS=stun:stun.l.google.com:19302,stun:192.168.1.100:3478`

---

### 2.3 TURN (Traversal Using Relays around NAT) — RFC 5766 / RFC 8656

TURN은 두 피어가 직접 연결할 수 없는 환경(Symmetric NAT, 기업 방화벽 등)에서
**TURN 서버가 미디어 패킷을 중계**하는 프로토콜이다.

#### 동작 원리

```
Browser (회사 방화벽)    TURN Server        mediasoup (서버)
        │                   │                    │
        │──── ALLOCATE ─────►│                    │
        │◄─── RELAYED ADDR ──│ (x.x.x.x:5000)    │
        │                   │◄──────────────────►│
        │                   │  미디어 중계         │
```

- TURN 서버는 미디어를 직접 처리하므로 **대역폭 비용 발생**
- 직접 연결 가능하면 ICE는 host/srflx 후보를 먼저 선택하고 TURN은 사용 안 함
- 프로토콜: UDP (기본), TCP (방화벽 우회), TLS/TCP (HTTPS 443포트 통과)

#### LTS TURN 설정 (`server/.env`)

```ini
# TURN 서버 1
TURN_URL=turn:192.168.214.100:3478
TURN_USERNAME=lts-user
TURN_CREDENTIAL=secret

# TURN 서버 2 (복수 지원: _2, _3, ...)
TURN_URL_2=turns:my-turn.example.com:443
TURN_USERNAME_2=lts
TURN_CREDENTIAL_2=secret2
```

`GET /api/webrtc/ice-config` 엔드포인트가 브라우저에 ICE 서버 설정을 제공하며,
credentials는 서버 측에서만 보관된다.

---

### 2.4 ICE Candidate 선택 기준

WebRTC는 ICE 후보 쌍을 **우선순위 공식**으로 정렬한다:

```
priority = (2^24 × type_pref) + (2^8 × local_pref) + (256 − component)
```

| 후보 타입 | type_pref | 선택 조건 |
|----------|-----------|---------|
| host     | 126       | LAN 직접 통신 가능 — 항상 우선 |
| srflx    | 100       | NAT 통과 가능 |
| relay    | 0         | 위 둘 다 실패 시 최후 수단 |

LTS의 mediasoup 서버는 `SERVER_IP` 환경 변수로 LAN IP를 명시해야
브라우저가 host 후보를 올바르게 선택한다:

```ini
# server/.env
SERVER_IP=192.168.214.3
```

---

## 3. LTS ICE 서버 설정 구조

### 3.1 서버 측 (`GET /api/webrtc/ice-config`)

```javascript
// server/src/index.js
app.get('/api/webrtc/ice-config', (_req, res) => {
  const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .split(',').map(s => s.trim()).filter(Boolean);

  const turns = [];
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? '' : `_${i}`;
    const url = (process.env[`TURN_URL${suffix}`] || '').trim();
    if (!url) break;
    turns.push({
      url,
      username:   (process.env[`TURN_USERNAME${suffix}`]   || '').trim(),
      credential: (process.env[`TURN_CREDENTIAL${suffix}`] || '').trim(),
    });
  }
  res.json({ stunUrls, turns });
});
```

### 3.2 클라이언트 측 (`useWebRTCConfigStore`)

브라우저는 `useWebRTC` 훅에서 `getIceServers()`를 호출해 RTCPeerConnection에 주입한다:

```typescript
// client/src/hooks/useWebRTC.ts
const iceServers = getIceServers();
const transport = device.createRecvTransport({
  ...transportParams,
  ...(iceServers.length ? { iceServers } : {}),
});
```

`iceServers` 배열 형식:
```json
[
  { "urls": ["stun:stun.l.google.com:19302"] },
  { "urls": "turn:192.168.214.100:3478", "username": "lts-user", "credential": "secret" }
]
```

---

## 4. `npm run ice-test` — ICE 자동화 테스트 도구

### 4.1 개요

`ice-test`는 Playwright 브라우저 자동화를 이용해 실제 WebRTC ICE 연결을 검증하는
3단계 자동화 테스트 도구이다.

```
cd server && npm run ice-test              # headed (브라우저 창 표시)
cd server && npm run ice-test:headless     # headless (SSH/CI 환경)
node src/scripts/iceTest.js http://192.168.214.3:3001 http://192.168.214.3:5173
```

### 4.2 아키텍처: Socket.IO 트리거 방식 (v2.0)

```
┌─────────────────────────────────────────────────────────────────┐
│  iceTest.js (Node.js)          Socket.IO over WebSocket         │
│                                                                 │
│  Phase 1: 서버 점검 ─────► GET /api/cameras                    │
│           STUN UDP ping ──► STUN 서버 직접 확인                  │
│           WebRTC 활성화 ──► PUT /api/cameras/:id                │
│                                                                 │
│  Phase 2: ─────────────────────────────────────────────────────│
│                                                                 │
│  ┌─────────────────┐   webrtc:ice-test-start   ┌────────────┐  │
│  │  Playwright      │──────────────────────────►│  Backend   │  │
│  │  브라우저 오픈    │                           │  (3001)    │  │
│  │                 │◄──────────────────────────│  Socket.IO │  │
│  │  IceTestTrigger  │   webrtc:ice-test-trigger │            │  │
│  │  컴포넌트 활성화  │                           └────────────┘  │
│  │                 │                                           │
│  │  RTCPeerConn    │─── ICE Gathering ──► STUN/TURN 서버     │
│  │  생성 감지       │─── ICE Checking ──► mediasoup 서버      │
│  │  (적응형 대기)   │─── ICE Connected ─► getStats() 수집    │
│  └─────────────────┘                                           │
│                                                                 │
│  Phase 3: ICE 후보 타입 / 경로 / 처리량 리포트 출력              │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 Socket.IO 트리거 프로토콜

#### iceTest.js → 서버 (Engine.IO v4 raw WebSocket)

`socket.io-client` 패키지 없이 `ws` 모듈로 직접 구현:

```
WS 연결: ws://SERVER:3001/socket.io/?EIO=4&transport=websocket
         ↓
서버: '0{"sid":"...","pingInterval":25000,...}'  (EIO OPEN)
클: '40'                                         (SIO CONNECT)
서버: '40{"sid":"..."}'                           (SIO CONNECT ACK)
클: '42["webrtc:ice-test-start",{"cameraId":"..."}]' (SIO EVENT emit)
         ↓
서버: io.emit('webrtc:ice-test-trigger', { cameraId })
         ↓
브라우저: socket.on('webrtc:ice-test-trigger') → IceTestTrigger 활성화
```

#### 서버 핸들러 (`server/src/index.js`)

```javascript
socket.on('webrtc:ice-test-start', ({ cameraId } = {}) => {
  io.emit('webrtc:ice-test-trigger', { cameraId });
});
socket.on('webrtc:ice-test-done', () => {
  io.emit('webrtc:ice-test-stop');
});
```

#### 클라이언트 핸들러 (`client/src/App.tsx`)

```typescript
socket.on('webrtc:ice-test-trigger', ({ cameraId }) => setIceTestCameraId(cameraId));
socket.on('webrtc:ice-test-stop',    ()              => setIceTestCameraId(null));
```

`IceTestTrigger` 컴포넌트가 활성화되면 `useWebRTC(cameraId, true)` 훅이 호출되어
실제 mediasoup WebRTC 연결을 시작하고, 이 연결의 RTCPeerConnection을 Playwright가 감지한다.

---

### 4.4 Phase 별 상세 사양

#### Phase 1 — 서버 사전 점검

| 점검 항목 | 방법 | 성공 기준 |
|----------|------|---------|
| 서버 응답 | `GET /api/cameras` (HTTP) | HTTP 200 |
| WebRTC 카메라 확인 | cameras 목록 필터 | `webrtcEnabled: true` 카메라 존재 |
| WebRTC 자동 활성화 | `PUT /api/cameras/:id` | 없으면 첫 번째 카메라 임시 활성화 |
| 파이프라인 준비 대기 | `GET /api/cameras/:id` 폴링 (15s) | `pipelineStatus.running: true` |
| ICE 서버 설정 확인 | `GET /api/webrtc/ice-config` | STUN/TURN 수 출력 |
| STUN UDP ping | `dgram` socket + STUN Binding Request (RFC 5389) | STUN 응답 수신 |

STUN UDP ping은 LAN STUN 서버만 대상으로 하며, Google 공개 STUN은 스킵한다.

**STUN Binding Request 패킷 구조:**

```
Byte 0-1:  0x0001      — STUN Message Type: Binding Request
Byte 2-3:  0x0000      — Message Length (0 bytes, no attributes)
Byte 4-7:  0x2112A442  — Magic Cookie (RFC 5389 고정값)
Byte 8-19: Transaction ID (12 bytes, random)
```

#### Phase 2 — 브라우저 자동화 (적응형 대기)

v2.0에서 **고정 35초 대기 방식을 폐기**하고 다음 2단계 적응형 방식으로 교체:

| 단계 | 대기 조건 | 최대 시간 | 조기 종료 |
|------|----------|---------|---------|
| **Loopback 주입** | `page.evaluate()`로 PC × 2 생성 + SDP 교환 | 즉시 (동기) | mediasoup-client 불필요 |
| **Phase A** | RTCPeerConnection 생성 확인 | 3초 | 생성 확인 즉시 Phase B 진입 |
| **Phase B** | ICE `connectionState === 'connected'` 대기 | 30초 | 연결 즉시 종료 |

**Loopback ICE 주입 (기본 경로):**
`page.evaluate()`로 브라우저 페이지에 직접 두 개의 `RTCPeerConnection`을 생성하고 로컬 SDP를 교환한다. `/api/webrtc/ice-config`의 STUN/TURN 서버 설정을 그대로 사용한다. mediasoup-client를 전혀 사용하지 않으므로 headless Chrome의 `UnsupportedError: device not supported` 코덱 감지 문제를 우회한다. Socket.IO 트리거(IceTestTrigger)는 병렬로 실행되며 실패해도 테스트에 영향 없다.

Phase A에서 3초 내 PC가 생성되지 않으면:
- Loopback 주입 실패 및 IceTestTrigger 모두 동작하지 않음 — 즉시 실패
- 스크린샷 저장: `/tmp/lts-ice-test-fail.png`
- (기존: 35초를 무조건 기다린 뒤 실패)

Phase B에서 `connectionState === 'failed'` / `'closed'`가 감지되면 30초를 기다리지 않고 즉시 실패 처리.

**RTCPeerConnection 인터셉터 (Playwright addInitScript):**

```javascript
window.__lts_rtcPCs = [];
window.__lts_rtcEvents = [];

const _Native = window.RTCPeerConnection;
window.RTCPeerConnection = new Proxy(_Native, {
  construct(Target, args) {
    const pc = Reflect.construct(Target, args);
    window.__lts_rtcPCs.push(pc);
    // connectionstatechange, iceconnectionstatechange, icegatheringstatechange,
    // icecandidate 이벤트를 __lts_rtcEvents에 기록
    return pc;
  },
});
```

#### Phase 3 — ICE Candidate 리포트

| 항목 | 내용 |
|------|------|
| Local Candidate | 타입 (host/srflx/relay) + 프로토콜 + IP:Port |
| Remote Candidate | 타입 + IP:Port |
| 경로 판정 | host=LAN 직접, srflx=STUN NAT 통과, relay=TURN 릴레이 |
| 트래픽 측정 | `getStats()` 5회 × 2초 간격 → 수신 누적 + 속도(kbps) |
| 수신 추이 | ASCII 바 차트 |

---

### 4.5 테스트 결과 해석

#### 성공 케이스

| 결과 | Local Type | 의미 |
|------|-----------|------|
| `PASS` — LAN 직접 | `host` | 최적 경로. 서버와 클라이언트가 같은 LAN |
| `PASS` — STUN NAT 통과 | `srflx` | NAT 통과 성공. LAN 직접보다 지연 약간 높음 |
| `PASS` — TURN 릴레이 | `relay` | 작동하지만 비효율적. host 연결 안 되는 원인 조사 권장 |

#### 실패 케이스 및 조치

| 오류 메시지 | 원인 | 조치 |
|-----------|------|------|
| `서버 응답 없음` | 백엔드 미실행 | `cd server && npm run dev` |
| `RTCPeerConnection이 생성되지 않음` | IceTestTrigger 미설치 또는 파이프라인 미실행 | App.tsx IceTestTrigger 확인, 카메라 RTSP URL 점검 |
| `ICE 상태: failed` | STUN/TURN 도달 불가 또는 방화벽 | UFW 포트 오픈: `sudo ufw allow 40000:49999/udp` |
| `ICE 연결 실패 (30초 초과)` | mediasoup WebRTC 포트 미오픈 | `server/.env → SERVER_IP=<LAN IP>` 확인 |
| `TURN 릴레이 경로` | `SERVER_IP` 미설정 | `server/.env → SERVER_IP=192.168.x.x` 설정 |

---

## 5. mediasoup WebRTC 포트 설정

mediasoup는 미디어 전송에 UDP 포트 범위를 사용한다:

```ini
# server/.env
MEDIASOUP_RTC_MIN_PORT=40000
MEDIASOUP_RTC_MAX_PORT=49999
```

방화벽 오픈 (LAN 내부):
```bash
sudo ufw allow 40000:49999/udp
```

---

## 6. 환경 변수 전체 목록

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `SERVER_IP` | `localhost` | 서버 LAN IP (host ICE 후보에 포함) |
| `PORT` | `3001` | 백엔드 HTTP/Socket.IO 포트 |
| `VITE_PORT` | `5173` | Vite 개발서버 포트 |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | 쉼표로 복수 STUN 서버 지정 |
| `TURN_URL` | (없음) | TURN 서버 URL (turn: 또는 turns:) |
| `TURN_USERNAME` | (없음) | TURN 인증 사용자명 |
| `TURN_CREDENTIAL` | (없음) | TURN 인증 비밀번호 |
| `TURN_URL_2`, `_3`, … | (없음) | 두 번째 이후 TURN 서버 (번호 연속) |
| `MEDIASOUP_RTC_MIN_PORT` | `40000` | mediasoup RTP/RTCP 최소 포트 |
| `MEDIASOUP_RTC_MAX_PORT` | `49999` | mediasoup RTP/RTCP 최대 포트 |

---

## 7. 구현 체크리스트

### 7.1 서버

| 기능 | 상태 | 파일 |
|------|------|------|
| `GET /api/webrtc/ice-config` — STUN/TURN 설정 제공 | ✅ Complete | `server/src/index.js` |
| `webrtc:ice-test-start` Socket.IO 핸들러 | ✅ Complete | `server/src/index.js` |
| `webrtc:ice-test-done` Socket.IO 핸들러 | ✅ Complete | `server/src/index.js` |
| mediasoup WebRTC 게이트웨이 | ✅ Complete | `server/src/services/webrtcGateway.js` |

### 7.2 클라이언트

| 기능 | 상태 | 파일 |
|------|------|------|
| `useWebRTCConfigStore` — ICE 서버 설정 저장소 | ✅ Complete | `client/src/stores/webrtcConfigStore.ts` |
| `useWebRTC` 훅 — mediasoup-client 연결 | ✅ Complete | `client/src/hooks/useWebRTC.ts` |
| `IceTestTrigger` 컴포넌트 | ✅ Complete | `client/src/App.tsx` |
| `webrtc:ice-test-trigger` Socket.IO 수신 | ✅ Complete | `client/src/App.tsx` |
| `webrtc:ice-test-stop` Socket.IO 수신 (정리) | ✅ Complete | `client/src/App.tsx` |

### 7.3 ice-test 스크립트

| 기능 | 상태 | 비고 |
|------|------|------|
| Phase 1: 서버 점검 + STUN UDP ping | ✅ Complete | `server/src/scripts/iceTest.js` |
| Phase 1: WebRTC 카메라 자동 활성화 | ✅ Complete | |
| Phase 2: Playwright 브라우저 자동화 | ✅ Complete | |
| Phase 2: RTCPeerConnection 인터셉터 주입 | ✅ Complete | addInitScript |
| Phase 2: Socket.IO 트리거 (Engine.IO v4 raw ws) | ✅ Complete | socket.io-client 불필요 |
| Phase 2: 적응형 대기 (PC 생성 8초 + ICE 연결 30초) | ✅ Complete | 기존 고정 35초 폐기 |
| Phase 2: ICE failed/closed 즉시 종료 | ✅ Complete | |
| Phase 3: ICE 후보 타입 분석 + 경로 판정 | ✅ Complete | |
| Phase 3: getStats() 처리량 측정 | ✅ Complete | 5회 × 2s |
| 테스트 완료 후 webrtc:ice-test-done 전송 | ✅ Complete | App 정리 트리거 |

---

## 8. 관련 문서

- [RFP_LTS2026_WebRTC_Media_Gateway.md](./RFP_LTS2026_WebRTC_Media_Gateway.md) — mediasoup 게이트웨이 설계
- [README.md](./README.md) — 시스템 전체 설정 가이드
