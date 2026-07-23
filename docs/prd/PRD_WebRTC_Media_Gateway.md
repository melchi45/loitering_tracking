# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# WebRTC Media Gateway (Video / Audio / Application RTP)

| | |
|---|---|
| **Document ID** | PRD-LTS-003 |
| **Version** | 2.0 |
| **Status** | Active |
| **Date** | 2026-05-21 (rev 2026-07-23) |
| **Related RFP** | [rfp/RFP_WebRTC_Media_Gateway.md](../rfp/RFP_WebRTC_Media_Gateway.md) (LTS-2026-003 v2.0) |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [Technical Requirements](#5-technical-requirements)
6. [API / Interface Contract](#6-api--interface-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Implementation Status](#8-implementation-status)

---

## 1. Product Vision

운영자는 브라우저에서 카메라 영상을 저지연 WebRTC로 보고, 동시에 AI 감지·배회·알림 이벤트를 실시간으로 받는다. 이 두 가지는 **서로 다른 두 전달 경로**로 영구히 공존한다 — 하나가 다른 하나를 대체하는 마이그레이션이 아니다:

- **영상/오디오**: `webrtcEnabled=true`인 카메라는 WHEP 기반 WebRTC(`mediamtx` 기본, `mediasoup` dormant — [PRD_WebRTC_Engine_Modes.md](PRD_WebRTC_Engine_Modes.md) 참조)로 `<video>`에 전달. `webrtcEnabled=false`인 카메라는 어노테이션된 JPEG를 Socket.IO `frame`으로 전달 — 이는 임시 폴백이 아니라 카메라별로 영구히 고정되는 두 갈래 경로다.
- **AI 이벤트(감지/배회/화재/알림)**: WebRTC 상태와 무관하게 항상 Socket.IO로 전달된다. WebRTC DataChannel로 옮기는 계획은 실행되지 않았고 앞으로도 계획되어 있지 않다(RFP §4.3).
- **App RTP(ONVIF)**: Socket.IO(원본 `appRtp` + 파싱된 `onvif:event`)로 항상 전달되며, `mediasoup` 모드에서는 동일 데이터가 WebRTC DataChannel로도 중복 전달된다(클라이언트가 `seq` 기준 중복 제거).

이 PRD는 v1.x가 서술했던, 실제로는 구현되지 않은 아키텍처(FFmpeg 듀얼출력, mediasoup-client Socket.IO 시그널링, DataChannel AI 이벤트)를 대체하여 **실제 동작을 정확히 서술**한다.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- `webrtcEnabled=true`인 카메라의 H.264 영상을 서버 재인코딩 없이 브라우저 `<video>`에 전달한다.
- Opus가 아닌 오디오 코덱을 가진 카메라는 ingest-daemon이 전용 워커 스레드에서 Opus로 트랜스코드하여 전달하고, Opus 카메라는 순수 패스스루한다.
- Application RTP(ONVIF 메타데이터)를 원본(raw) 형태와 파싱된 구조화 이벤트 형태 양쪽으로 제공한다.
- `WEBRTC_ENGINE`이 `mediamtx`/`mediasoup` 어느 쪽이어도 클라이언트 코드 변경 없이 동일하게 동작한다(단일 WHEP 계약).
- AI 감지·배회·알림 이벤트는 WebRTC 상태와 무관하게 항상 Socket.IO로 안정적으로 전달된다.
- 카메라별 음소거 버튼을 서버 재협상 없이 클라이언트에서 즉시 처리한다.

### 2.2 Non-Goals

- AI 이벤트를 WebRTC DataChannel로 이전하는 것 — 명시적으로 계획되어 있지 않다(RFP §4.3의 근거를 뒤집으려면 이 PRD와 RFP를 먼저 개정해야 한다).
- `werift` 엔진 구현 — 여전히 스텁.
- 글로벌 `WEBRTC_ENABLED` 플래그 — 카메라별 `webrtcEnabled` 필드가 그 역할을 대신하며, 별도의 전역 스위치는 없다.
- 영상 녹화·Playback API — `RFP_RTSP_WebRTC_Architecture.md`의 M1/M2 범위이며 이 PRD의 범위 밖이다.
- 엔진 내부 동작(Worker Pool, alt-PT 캐시 등) — `PRD_WebRTC_Engine_Modes.md`에서 다룬다.

---

## 3. User Personas

**보안 운영자(Security Operator)** — 대시보드에서 다중 카메라를 동시에 감시한다. 영상은 `<video>`(WebRTC 카메라) 또는 어노테이션된 `<img>`(JPEG 카메라)로 보이며, 어느 쪽이든 감지·배회·알림은 동일하게 실시간으로 뜬다.

**System Administrator** — 카메라 추가/수정 시 `webrtcEnabled`를 켤지 결정하고, `WEBRTC_ENGINE`(mediamtx/mediasoup)을 배포 환경에 맞게 설정한다. 문제 발생 시 `POST /api/webrtc/ice-test`로 엔진 상태를 우선 확인한다.

**AI/Analytics Developer** — 새로운 AI 이벤트 타입을 추가할 때 이것이 Socket.IO 경로를 사용해야 함을 알아야 한다 — DataChannel에 새 메시지 타입을 얹으려는 시도는 이 PRD의 §2.2 Non-Goals에 위배된다.

---

## 4. Functional Specification

### 4.1 영상 트랙 (RFP FR-WRTC-010~013)

`webrtcEnabled=true`인 카메라는 H.264 RTP를 재인코딩 없이 활성 엔진을 통해 브라우저로 전달한다. 클라이언트(`useWebRTC.ts`)는 `ontrack`으로 트랙을 받고, SDP answer에 `a=msid`가 없는 경우(mediasoup에서 관측됨) `MediaStream`을 직접 합성한다. `webrtcEnabled=false`인 카메라는 대신 Socket.IO `frame` 이벤트로 어노테이션된 JPEG를 전달한다 — `pipelineManager.js`가 `if (!ctx.useWebRTC)`로 이 둘을 배타적으로 분기한다(폴백이 아니라 카메라별 영구 모드).

### 4.2 오디오 트랙 (RFP FR-WRTC-020~024)

오디오 트랙이 있는 카메라는 코덱이 이미 Opus면 ingest-daemon이 순수 RTP mux로 패스스루하고, 그 외 코덱(G.711, AAC 등)은 메인 RTSP I/O 스레드와 분리된 전용 워커 스레드에서 Opus로 트랜스코드한다 — 트랜스코드가 느려도 영상/AI 프레임 전달이 막히지 않는다. 오디오 트랙이 없는 카메라는 오류 없이 영상만 정상 동작한다. 클라이언트는 카메라별 음소거 버튼(`CameraView.tsx`)을 제공하며, `videoRef.current.muted` 토글만으로 즉시 처리되고 서버 재협상이 필요 없다.

### 4.3 Application RTP 트랙 (RFP FR-WRTC-030~035)

ingest-daemon이 추출한 App RTP(ONVIF) 패킷은 `POST /api/internal/apprtp/:cameraId`로 서버에 전달된다. 서버는 이를 (1) ONVIF XML을 구조화 파싱해 Socket.IO `onvif:event`/`onvif:temperature`로, (2) 원본 그대로 Socket.IO `appRtp`로, 두 경로 모두로 브로드캐스트한다. `WEBRTC_ENGINE=mediasoup`일 때만 동일한 원본 패킷이 WebRTC DataChannel로도 추가 전달되며(mediamtx는 DataChannel이 없으므로 해당 없음), 클라이언트는 두 소스를 `seq` 기준으로 중복 제거한다.

### 4.4 AI 이벤트 전달 (RFP FR-WRTC-040~042)

`detections`, `loitering`, `fire:alert`, `alert:new`, `snapshot:new`, `face_match` 등은 카메라의 `webrtcEnabled`/`WEBRTC_ENGINE` 설정과 무관하게 항상 Socket.IO로 전달된다. 클라이언트는 `<video>`/`<img>` 렌더링 방식과 별개로 항상 `camera:subscribe` room에 join해야 이 이벤트들을 수신한다.

### 4.5 시그널링 (RFP FR-WRTC-001~005)

시그널링은 단일 WHEP 엔드포인트(`POST /api/webrtc/whep/:cameraId`) 하나뿐이다 — SDP offer를 body로 보내면 활성 엔진의 SDP answer를 그대로 받는다. Socket.IO 기반 시그널링 이벤트(`webrtc:getCapabilities` 등)는 존재하지 않는다.

### 4.6 진단/헬스 노출 (RFP FR-WRTC-050~053)

`POST /api/webrtc/ice-test`가 활성 엔진의 헬스와 정보를, `GET /api/webrtc/ice-config`가 STUN/TURN 설정을, `GET /api/webrtc/monitor`(dev-only/localhost 전용)가 파이프라인 상세를 노출한다. `GET /api/capabilities`는 AI 모듈 가용성 맵이며 WebRTC와 무관하다.

---

## 5. Technical Requirements

### 5.1 실제 구성 요소

| 컴포넌트 | 역할 |
|---|---|
| `ingest-daemon` (Python PyAV) | 카메라당 단일 RTSP 세션, 4갈래 팬아웃 |
| `webrtcEngineFactory.js` | `WEBRTC_ENGINE`에 따라 mediamtx/mediasoup/werift 중 선택 |
| `webrtc/mediamtxEngine.js` | MediaMTX WHEP 프록시 (기본, 활성) |
| `webrtc/mediasoupEngine.js` | Worker Pool 기반 SFU (구현됨, dormant) |
| `pipelineManager.js` | 카메라별 useWebRTC/JPEG 분기, Socket.IO 이벤트 발신 오케스트레이션 |
| `internalApi.js` | ingest-daemon → 서버 콜백(`/frame/:id`, `/apprtp/:id`) 수신 |
| `useWebRTC.ts` | WHEP negotiation, ontrack, DataChannel appRtp 수신, freeze/ICE 실패 워치독 |

`RtpIngestion`, `WebRTCGateway`, `WebRtcSession`, `webrtcSignaling.js` 등 v1.x가 언급한 파일은 존재하지 않는다.

### 5.2 Non-Functional Requirements

| ID | Requirement | Note |
|---|---|---|
| NFR-1 | 미디어 암호화 | DTLS-SRTP 필수, 두 엔진 모두 적용 |
| NFR-2 | 오디오 전달 | Opus 패스스루 또는 전용 스레드 트랜스코드, 메인 I/O 스레드 비차단 |
| NFR-3 | 엔진 무관 클라이언트 | `WEBRTC_ENGINE` 전환 시 클라이언트 코드 변경 불필요 |
| NFR-4 | AI 이벤트 신뢰성 | Socket.IO 이벤트는 WebRTC 상태와 무관하게 항상 전달 |
| NFR-5 | 재연결 | 카메라 재연결은 ingest-daemon 자체 재연결 로직을 따름(FFmpeg `RETRY_DELAY` 아님) |

구체적 지연시간(ms)·CPU·동시 세션 수 등 정량 SLA는 코드에서 측정/강제되지 않으므로 이 PRD에서 목표치로 명시하지 않는다(v1.x의 "≤300ms", "≤70% CPU" 등은 검증되지 않은 수치였음 — RFP §6 참조).

### 5.3 엔진별 환경변수

`SERVER_IP`, `MEDIASOUP_*`, `MEDIAMTX_*` 등은 엔진별로 다르며 [ops/WebRTC_Engine_Modes_Guide.md](../ops/WebRTC_Engine_Modes_Guide.md) §6에서 관리한다 — 이 PRD에서 중복 기술하지 않는다.

---

## 6. API / Interface Contract

```
POST /api/webrtc/whep/:cameraId
  Content-Type: application/sdp
  Body: SDP offer
  → 200/201 + SDP answer (+ Location/Link/ETag 헤더)
  → 400 { error }  — SDP body 누락
  → 503 { error }  — 엔진 unreachable

POST /api/webrtc/ice-test
  → 200 { testId, engine, ...engineInfo }
  → 503 { error, engine, hint }

GET /api/webrtc/ice-config
  → 200 { stunUrls: string[], turns: [...] }

GET /api/webrtc/monitor          (dev-only / localhost 전용)
  → 200 { serverMode, webrtcEngine, webrtc:{engine,ok}, pipelines, producerStats }
  → 403 { error }

Socket.IO (항상, WebRTC 상태 무관):
  detections, loitering, fire:alert, alert:new, snapshot:new,
  face_match, appRtp, onvif:event, onvif:temperature

Socket.IO (webrtcEnabled=false 카메라 전용):
  frame  (어노테이션 JPEG)
```

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-1 | `webrtcEnabled=true` 카메라의 H.264 영상이 재인코딩 없이 `<video>`에 렌더링된다. |
| AC-2 | `webrtcEnabled=false` 카메라는 Socket.IO `frame`으로만 영상을 받고 WebRTC 협상을 시도하지 않는다. |
| AC-3 | 오디오 트랙이 있는 카메라는 코덱과 무관하게 브라우저에서 정상 재생되며, 없는 카메라는 오류 없이 영상만 재생된다. |
| AC-4 | 음소거 버튼 클릭이 WebRTC 세션을 재시작시키지 않는다. |
| AC-5 | 두 엔진 어느 쪽으로 설정해도 클라이언트 코드 수정 없이 `POST /api/webrtc/whep/:cameraId`로 재생 가능하다. |
| AC-6 | `webrtcEnabled` 값과 무관하게 모든 카메라에서 `detections`/`loitering`/`alert:new`가 Socket.IO로 수신된다. |
| AC-7 | `mediasoup` 모드에서 App RTP가 Socket.IO `appRtp`와 DataChannel 양쪽으로 오되, 클라이언트가 중복 렌더링하지 않는다(seq 중복 제거). |
| AC-8 | `mediamtx` 모드에서 DataChannel이 열리지 않거나 데이터가 오지 않아도 `appRtp` Socket.IO 이벤트로 App RTP가 정상 수신된다. |
| AC-9 | `POST /api/webrtc/ice-test`가 현재 엔진의 정확한 이름과 헬스 상태를 반환한다. |
| AC-10 | `GET /api/webrtc/monitor`가 프로덕션 환경의 원격 요청에는 403을 반환한다. |

---

## 8. Implementation Status

| 항목 | 상태 |
|---|---|
| WHEP 시그널링 단일 엔드포인트 | ✅ 구현 완료 |
| mediamtx 엔진(기본) | ✅ 구현·활성 |
| mediasoup 엔진 | ✅ 구현 완료, dormant (`WEBRTC_ENGINE=mediasoup` 필요) |
| werift 엔진 | 🚧 스텁 |
| 카메라별 webrtcEnabled 분기(JPEG ↔ WebRTC) | ✅ 구현 완료 |
| 오디오 패스스루/트랜스코드 | ✅ 구현 완료 |
| App RTP 원본+파싱 이중 전달 | ✅ 구현 완료 |
| App RTP DataChannel(mediasoup 전용) | ✅ 구현 완료 |
| AI 이벤트 DataChannel 이전 | ❌ 계획 폐기 (§2.2) |
| `GET /api/webrtc/stats` / `GET /api/webrtc/capabilities` | ❌ 구현되지 않음, 계획 없음 — `ice-test`/`ice-config`/`monitor`가 대체 |
| 글로벌 `WEBRTC_ENABLED` 플래그 | ❌ 존재하지 않음, 카메라별 `webrtcEnabled`가 대체 |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for WebRTC Media Gateway |
| 1.1 | 2026-06-11 | LTS Engineering Team | §1 현재 구현(MediaMTX WHEP) 반영; §8 M5 추가(WHEP 완료), M3/M4 DataChannel 참조 추가; Status → Active |
| 1.2 | 2026-06-16 | LTS Engineering Team | §4.1 RTP PT=109 제약 및 ICE listenIps env-var 전용 제약 추가 (mediasoup 모드 Edge 검은 화면 + ICE loopback 근본 원인 명시) |
| 1.3 | 2026-07-23 | LTS Engineering Team | §1 레거시 경로 설명에 mediasoup dormant 상태 및 alt-PT 대체 사실 반영, `PRD_WebRTC_Engine_Modes.md`로 연결 |
| 2.0 | 2026-07-23 | LTS Engineering Team | 전면 재작성 — 실제 코드 기준(단일 WHEP, 카메라별 webrtcEnabled 분기, AI 이벤트는 항상 Socket.IO, App RTP 이중 전달) 재정의; RFP v2.0 FR-WRTC-001~053에 맞춰 §4/§6/§7/§8 전면 교체; 존재하지 않는 API/파일/메시지 스키마 전체 제거 |
