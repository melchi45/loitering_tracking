# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# WebRTC Media Gateway

| | |
|---|---|
| **Document ID** | SRS-LTS-WRTC-01 |
| **Version** | 2.0 |
| **Status** | Active |
| **Date** | 2026-05-26 (rev 2026-07-23) |
| **Parent PRD** | [prd/PRD_WebRTC_Media_Gateway.md](../prd/PRD_WebRTC_Media_Gateway.md) |
| **Parent RFP** | [rfp/RFP_WebRTC_Media_Gateway.md](../rfp/RFP_WebRTC_Media_Gateway.md) |
| **Sibling SRS** | [srs/SRS_WebRTC_Engine_Modes.md](SRS_WebRTC_Engine_Modes.md) (엔진 내부 동작) |
| **Child TC** | [tc/TC_WebRTC_Media_Gateway.md](../tc/TC_WebRTC_Media_Gateway.md) |
| **Test Script** | test/api/webrtc.test.js |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Signaling](#3-functional-requirements--signaling)
4. [Functional Requirements — Video Delivery](#4-functional-requirements--video-delivery)
5. [Functional Requirements — Audio Delivery](#5-functional-requirements--audio-delivery)
6. [Functional Requirements — Application RTP](#6-functional-requirements--application-rtp)
7. [Functional Requirements — AI Event Delivery](#7-functional-requirements--ai-event-delivery)
8. [Functional Requirements — Diagnostics](#8-functional-requirements--diagnostics)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Interface Requirements](#10-interface-requirements)
11. [Constraints & Assumptions](#11-constraints--assumptions)
12. [Stability Requirements](#12-stability-requirements)

---

## 1. Introduction

### 1.1 Purpose

이 SRS는 LTS-2026 WebRTC Media Gateway(WHEP 시그널링 + Socket.IO 하이브리드 전달)의 검증 가능한 기능 요구사항을 정의한다. 각 요구사항은 FR-WRTC-NNN ID로 식별되며 `TC_WebRTC_Media_Gateway.md`의 테스트 케이스로 추적된다.

**v2.0 재작성 사유**: v1.x는 FFmpeg 듀얼출력 + mediasoup-client Socket.IO capabilities-exchange 시그널링을 전제로 작성되었으나, 이는 실제로 구현되지 않았다. 현재 코드는 ingest-daemon(Python PyAV) + 단일 WHEP 엔드포인트 + Socket.IO/WebRTC/DataChannel 하이브리드 전달 모델을 사용한다. FR-WRTC ID 전체가 재정의되었다 — v1.x의 동일 ID가 서로 다른 요구사항을 가리켰을 수 있으므로, 과거 커밋의 FR-WRTC 참조는 이 문서의 §부속 이력이 아니라 git blame으로 재확인해야 한다.

### 1.2 Scope

- `POST /api/webrtc/whep/:cameraId` WHEP 시그널링 계약
- 카메라별 `webrtcEnabled` 분기(WebRTC ↔ Socket.IO JPEG)
- 오디오 패스스루/트랜스코드
- Application RTP(ONVIF) 이중 전달(Socket.IO raw+parsed, 조건부 DataChannel)
- AI 이벤트(감지/배회/알림)의 Socket.IO 전용 전달 원칙
- 진단 엔드포인트(`ice-test`, `ice-config`, `monitor`)

범위 밖: mediamtx/mediasoup 엔진 내부 구현(`SRS_WebRTC_Engine_Modes.md`), 녹화/Playback(M1/M2, `SRS_RTSP_WebRTC_Architecture.md`), werift 엔진.

### 1.3 Definitions

| Term | Definition |
|---|---|
| WHEP | WebRTC-HTTP Egress Protocol — 이 게이트웨이의 유일한 시그널링 방식 |
| Active engine | `WEBRTC_ENGINE` 환경변수로 선택된 mediamtx 또는 mediasoup 구현체 |
| App RTP | 카메라가 ONVIF 메타데이터를 실어 보내는 동적 payload type RTP 트랙 |
| DataChannel | mediasoup 모드에서만 존재하는 WebRTC SCTP 채널 — App RTP 원본의 중복 전달 전용 |

---

## 2. System Overview

```
ingest-daemon (카메라당 단일 RTSP 세션)
  ├─ JPEG(10fps)  → POST /api/internal/frame/:id     → pipelineManager
  ├─ H.264 RTP    → 활성 엔진(mediamtx|mediasoup)      → §4
  ├─ Opus RTP     → 활성 엔진                            → §5
  └─ App RTP      → POST /api/internal/apprtp/:id     → §6

pipelineManager.js
  camera.webrtcEnabled === true
    → 활성 엔진 사용, Socket.IO `frame` 미전송
  camera.webrtcEnabled === false
    → Socket.IO `frame`(JPEG) 전송, 활성 엔진 미사용
  (무관, 항상) → Socket.IO detections/loitering/alert:new/... 전송

브라우저 (useWebRTC.ts)
  POST /api/webrtc/whep/:cameraId → SDP answer → RTCPeerConnection
    ontrack → <video>
    ondatachannel (mediasoup만 실데이터) → appRtp 중복 소스, seq dedup
  Socket.IO (항상 별도 연결) → detections/loitering/alert/appRtp/onvif:event 수신
```

---

## 3. Functional Requirements — Signaling

| ID | Requirement |
|---|---|
| FR-WRTC-001 | 시스템은 `POST /api/webrtc/whep/:cameraId` 단일 엔드포인트로만 WebRTC 시그널링을 수행해야 한다(`Content-Type: application/sdp`, body는 원문 SDP offer). |
| FR-WRTC-002 | 서버는 요청을 현재 `WEBRTC_ENGINE`의 `negotiate(cameraId, sdpOffer)`로 위임하고, 그 결과(HTTP status, SDP answer, `Location`/`Link`/`ETag` 헤더)를 그대로 클라이언트에 반환해야 한다. |
| FR-WRTC-003 | SDP body가 비어있거나 없으면 엔진 호출 전에 HTTP 400을 반환해야 한다. |
| FR-WRTC-004 | 활성 엔진이 예외를 던지거나 응답하지 않으면 HTTP 503과 `{ error }`를 반환해야 하며, 처리되지 않은 예외로 인한 5xx가 발생해서는 안 된다. |
| FR-WRTC-005 | 이 엔드포인트 외의 WebRTC 시그널링 경로(Socket.IO 이벤트 등)가 존재해서는 안 된다. |

---

## 4. Functional Requirements — Video Delivery

| ID | Requirement |
|---|---|
| FR-WRTC-010 | `camera.webrtcEnabled === true`인 카메라는 H.264 RTP를 서버 재인코딩 없이 활성 엔진을 통해 브라우저로 전달해야 한다. |
| FR-WRTC-011 | 클라이언트는 SDP answer에 `a=msid`가 없는 경우 수신된 트랙으로부터 `MediaStream`을 직접 합성해야 한다. |
| FR-WRTC-012 | `camera.webrtcEnabled === false`인 카메라는 Socket.IO `frame` 이벤트(어노테이션된 JPEG)로만 영상을 전달해야 하며, WebRTC 협상을 시도해서는 안 된다. |
| FR-WRTC-013 | 두 모드(FR-WRTC-010/012)는 카메라별로 상호 배타적이어야 한다 — 동일 카메라가 동시에 두 경로로 영상을 전달해서는 안 된다. |

---

## 5. Functional Requirements — Audio Delivery

| ID | Requirement |
|---|---|
| FR-WRTC-020 | 오디오 트랙이 있는 카메라는 코덱과 무관하게 브라우저에 오디오를 전달할 수 있어야 한다. |
| FR-WRTC-021 | 카메라 오디오 코덱이 이미 Opus인 경우, ingest-daemon은 디코드/인코드 없이 순수 RTP mux 패스스루해야 한다. |
| FR-WRTC-022 | 카메라 오디오 코덱이 Opus가 아닌 경우, ingest-daemon은 메인 RTSP I/O 스레드와 분리된 전용 워커 스레드에서 Opus로 트랜스코드해야 한다. |
| FR-WRTC-023 | 오디오 트랙이 없는 카메라는 오류 없이 영상만 정상 동작해야 한다. |
| FR-WRTC-024 | 클라이언트는 카메라별 음소거 컨트롤을 제공해야 하며, 이는 서버 재협상 없이 `videoRef.current.muted` 토글만으로 즉시 처리되어야 한다. |

---

## 6. Functional Requirements — Application RTP

| ID | Requirement |
|---|---|
| FR-WRTC-030 | ingest-daemon은 카메라의 App RTP 패킷을 `POST /api/internal/apprtp/:cameraId`로 `{ pt, timestamp, seq, payload }` 형태로 서버에 전달해야 한다. |
| FR-WRTC-031 | 서버는 ONVIF `MetadataStream` XML을 구조화 파싱하여 Socket.IO `onvif:event`(영속) 또는 `onvif:temperature`(비영속, 열상)로 브로드캐스트해야 한다. |
| FR-WRTC-032 | 서버는 FR-WRTC-031과 독립적으로, 원본 미파싱 패킷을 Socket.IO `appRtp`로 모든 연결된 클라이언트에 브로드캐스트해야 한다. |
| FR-WRTC-033 | `WEBRTC_ENGINE=mediasoup`인 경우, 동일한 원본 패킷을 해당 카메라의 mediasoup DataProducer로도 전달해 WebRTC DataChannel로 전달해야 한다(FR-WRTC-032와 동일 데이터의 중복 전달). |
| FR-WRTC-034 | `WEBRTC_ENGINE=mediamtx`인 경우 DataChannel 경로가 존재하지 않으며, FR-WRTC-032만이 유일한 전달 수단이어야 한다. |
| FR-WRTC-035 | 클라이언트는 FR-WRTC-032와 FR-WRTC-033의 두 소스를 `seq` 기준으로 중복 제거해야 한다(mediasoup 모드에서 동일 이벤트가 UI에 두 번 렌더링되어서는 안 됨). |
| FR-WRTC-036 | 인식할 수 없는 App RTP payload는 로그로 남기고 건너뛰어야 하며, 서버를 크래시시켜서는 안 된다. |

---

## 7. Functional Requirements — AI Event Delivery

| ID | Requirement |
|---|---|
| FR-WRTC-040 | `detections`, `loitering`, `fire:alert`, `alert:new`, `snapshot:new`, `face_match` 등 AI/이벤트 Socket.IO 메시지는 카메라의 `webrtcEnabled`/`WEBRTC_ENGINE`과 무관하게 항상 전송되어야 한다. |
| FR-WRTC-041 | 이 이벤트들은 WebRTC DataChannel로 이전되거나 중복 전달되어서는 안 된다(설계 결정, PRD §2.2). |
| FR-WRTC-042 | 클라이언트는 영상 렌더링 방식(`<video>`/`<img>`)과 무관하게 `camera:subscribe`/`camera:unsubscribe` room 가입 상태를 올바르게 유지해야 한다. |

---

## 8. Functional Requirements — Diagnostics

| ID | Requirement |
|---|---|
| FR-WRTC-050 | `POST /api/webrtc/ice-test`는 활성 엔진이 healthy하면 HTTP 200과 `{ testId, engine, ...engineInfo }`를, unhealthy하면 HTTP 503과 `{ error, engine, hint }`를 반환해야 한다. |
| FR-WRTC-051 | `GET /api/webrtc/ice-config`는 `{ stunUrls, turns }`를 반환해야 하며, `settings` DB 테이블을 우선 조회하고 없으면 `.env`로부터 시드해야 한다. |
| FR-WRTC-052 | `GET /api/webrtc/monitor`는 `NODE_ENV=development` 또는 localhost 요청에서만 응답해야 하며, 그 외에는 HTTP 403을 반환해야 한다. |
| FR-WRTC-053 | `GET /api/capabilities`는 AI 모듈 가용성 맵(`{ai, status}`)이며 WebRTC 코덱/엔진 정보를 포함하지 않는다 — 이 요구사항은 향후 혼동 방지를 위한 명시적 비-요구사항이다. |

---

## 9. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-WRTC-001 | 미디어 암호화 | 모든 WebRTC 미디어는 DTLS-SRTP로 암호화되어야 한다(두 엔진 공통). |
| NFR-WRTC-002 | 오디오 스레드 격리 | 오디오 트랜스코드는 메인 RTSP I/O 스레드를 차단해서는 안 된다(FR-WRTC-022). |
| NFR-WRTC-003 | 엔진 무관성 | `WEBRTC_ENGINE` 전환 시 클라이언트(`useWebRTC.ts`) 코드 변경이 필요 없어야 한다. |
| NFR-WRTC-004 | 이벤트 신뢰성 | AI 이벤트(§7)는 WebRTC 연결 상태와 무관하게 항상 전달 가능해야 한다. |
| NFR-WRTC-005 | 재연결 | 카메라 재연결은 ingest-daemon 자체 재연결 정책을 따라야 한다. |

> 정량적 지연시간(ms)/CPU/동시성 SLA는 코드에서 측정·강제되지 않으므로 이 SRS에서 검증 가능 요구사항으로 명시하지 않는다(v1.x FR-WRTC-060~065의 수치는 검증되지 않은 목표치였음).

---

## 10. Interface Requirements

### 10.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-WRTC-001 | POST | `/api/webrtc/whep/:cameraId` | SDP offer/answer 교환 |
| FR-WRTC-050 | POST | `/api/webrtc/ice-test` | 엔진 헬스체크 |
| FR-WRTC-050 | DELETE | `/api/webrtc/ice-test/:testId` | no-op, `{ok:true}` |
| FR-WRTC-051 | GET | `/api/webrtc/ice-config` | STUN/TURN 설정 |
| FR-WRTC-052 | GET | `/api/webrtc/monitor` | 파이프라인/엔진 상세 (dev-only) |

`GET /api/webrtc/stats`, `GET /api/webrtc/capabilities`는 존재하지 않는다(v1.x 계획, 미구현).

### 10.2 Socket.IO Events

| Event | Direction | Gate | Description |
|---|---|---|---|
| `frame` | Server→Client | `webrtcEnabled === false`만 | 어노테이션 JPEG |
| `detections` | Server→Client | 항상 | 프레임별 감지 박스 |
| `loitering` | Server→Client | 항상 | 배회 이벤트 |
| `fire:alert` / `alert:new` / `snapshot:new` / `face_match` | Server→Client | 항상 | 각종 이벤트 |
| `appRtp` | Server→Client | 항상 | App RTP 원본 |
| `onvif:event` / `onvif:temperature` | Server→Client | 항상 | App RTP 파싱 결과 |
| `camera:subscribe` / `camera:unsubscribe` | Client→Server | 항상 | room 가입/해제 |

### 10.3 WebRTC DataChannel

| 조건 | 내용 |
|---|---|
| `WEBRTC_ENGINE=mediasoup` | App RTP 원본의 중복 전달(§6 FR-WRTC-033), `seq` 기준 클라이언트 dedup 필요 |
| `WEBRTC_ENGINE=mediamtx` | DataChannel 없음 |

---

## 11. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | ingest-daemon(Python PyAV)이 카메라당 유일한 RTSP 클라이언트다 — FFmpeg 듀얼출력 경로는 이 흐름에 존재하지 않는다. |
| C-02 | `WEBRTC_ENGINE`은 `mediamtx`(기본) 또는 `mediasoup`(dormant) — 상세는 `SRS_WebRTC_Engine_Modes.md`. |
| C-03 | 카메라별 `webrtcEnabled` 필드가 영상 전달 경로를 결정하며, 전역 `WEBRTC_ENABLED` 플래그는 존재하지 않는다. |
| C-04 | AI 이벤트(§7)는 Socket.IO 전용이며 DataChannel 이전 계획이 없다. |
| C-05 | `POST /api/webrtc/whep/:cameraId`는 인증을 요구하지 않는다(WHEP 관례) — 접근 제어는 네트워크/리버스 프록시 계층 책임이다. |

---

## 12. Stability Requirements

v1.x §12(Post-Patch Stability)의 4개 항목 중 아키텍처가 바뀌며 더 이상 적용되지 않는 항목이 있어 재평가했다.

| ID | Requirement | 상태 |
|---|---|---|
| FR-WRTC-060 | 동일 소켓이 동일 카메라에 대해 `camera:subscribe`를 반복 요청해도 room join은 1회로 유지되어야 한다(ref-count 기반). | ✅ 유효 — 계속 적용 |
| FR-WRTC-061 | 클라이언트는 미디어 진행 없이 연결만 유지되는("frozen") 상태를 감지하고, 자동으로 통제된 재연결을 수행해야 한다. `video.play()` 완료 지연으로 인한 잘못된 재연결 루프를 방지해야 한다. | ✅ 유효 — `useWebRTC.ts`의 watchdog으로 계속 적용, 단 구현 메커니즘은 v1.x가 전제한 mediasoup 전용이 아니라 두 엔진 공통 |
| ~~FR-WRTC-062~~ | ~~동일 소켓의 중복 `webrtc:createTransport` 요청은 기존 트랜스포트를 재사용해야 한다~~ | ❌ **폐기** — `webrtc:createTransport` Socket.IO 이벤트 자체가 존재하지 않음(§3). WHEP는 매 `negotiate()` 호출마다 새 트랜스포트를 만드는 모델이라 이 요구사항 자체가 성립하지 않는다. |
| ~~FR-WRTC-063~~ | ~~RTP 인제스트 FFmpeg 인자는 단조 타임스탬프를 강제해야 하며 `Non-monotonous DTS`/`Queue input is backward in time` 경고가 재발해서는 안 된다~~ | ❌ **폐기** — 이 경로에 FFmpeg가 없다(ingest-daemon/PyAV). 동등한 PyAV 측 안정성 요구사항이 필요하다면 별도 SRS(`SRS_RTSP_Capture_Backend.md` 등)에서 다뤄야 하며, 이 문서의 책임이 아니다. |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for WebRTC Media Gateway |
| 1.1 | 2026-05-29 | LTS Engineering Team | Added post-patch stability requirements (duplicate guard, timestamp stability, frozen-stream recovery) |
| 1.2 | 2026-06-16 | LTS Engineering Team | FR-WRTC-070/071 추가 — mediasoup Router H.264 PT=109 강제 및 ICE listenIps env-var 전용 제약 (Edge 검은 화면 및 ICE loopback 근본 원인 문서화) |
| 1.3 | 2026-07-23 | LTS Engineering Team | 문서 상단에 정확성 안내 추가 — mediamtx가 현재 기본·활성 엔진이며 mediasoup은 dormant임을 명시, `SRS_WebRTC_Engine_Modes.md`로 연결 |
| 2.0 | 2026-07-23 | LTS Engineering Team | 전면 재작성 — FR-WRTC ID 전체를 실제 코드(단일 WHEP, 카메라별 webrtcEnabled 분기, AI 이벤트 Socket.IO 전용, App RTP 이중 전달) 기준으로 재정의; §12에서 더 이상 적용되지 않는 구 요구사항(createTransport 재사용, FFmpeg 타임스탬프) 폐기 처리; PT=109/mediasoup 엔진 세부는 `SRS_WebRTC_Engine_Modes.md`로 이관 |
