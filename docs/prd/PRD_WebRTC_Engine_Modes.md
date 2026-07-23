# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# WebRTC Engine Modes (mediamtx / mediasoup 선택형 백엔드)

| | |
|---|---|
| **Document ID** | PRD-LTS-WEM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-23 |
| **Related RFP** | [rfp/RFP_WebRTC_Engine_Modes.md](../rfp/RFP_WebRTC_Engine_Modes.md) |
| **Related MRD** | [mrd/MRD_WebRTC_Engine_Modes.md](../mrd/MRD_WebRTC_Engine_Modes.md) |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [Technical Requirements](#5-technical-requirements)
6. [API / Interface Contract](#6-api--interface-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Out of Scope](#8-out-of-scope)

---

## 1. Product Vision

운영자가 브라우저에서 카메라 영상을 볼 때, 그 영상이 **어떤 WebRTC 백엔드를 거쳐 오는지 신경 쓸 필요 없이 항상 안정적으로 재생**되어야 한다. LTS-2026은 이를 위해 `WEBRTC_ENGINE` 환경변수로 백엔드를 교체 가능하게 설계했고, 실제 운영 결과에 따라 **mediamtx를 기본값으로 채택**했다. mediasoup은 코드로는 남아있지만 현재 이 배포에서는 사용되지 않는다(dormant).

이 PRD는 "두 엔진 중 하나를 선택해 카메라 영상을 WHEP으로 브라우저에 전달한다"는 기능 자체의 요구사항을 정의한다 — mediasoup을 향후 재도입할 가능성을 열어두되, 지금은 mediamtx 단일 경로가 실제로 어떻게 동작해야 하는지를 명확히 규정하는 데 집중한다.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- 카메라별로 등록된 WHEP 엔드포인트(`POST /api/webrtc/whep/:cameraId`)가 `WEBRTC_ENGINE` 설정값과 무관하게 동일한 요청/응답 계약을 유지한다(엔진 교체가 클라이언트 코드 변경을 요구하지 않는다).
- mediamtx 경로에서 카메라 시작 시 MediaMTX 경로 등록 → 로컬 루프백 재발행 → ingest-daemon AI 프레임 소비 → 브라우저 WHEP 재생까지 전체 흐름이 자동으로 이루어진다.
- App RTP(ONVIF 메타데이터)는 mediamtx 모드에서 Socket.IO로, mediasoup 모드에서는 Socket.IO와 WebRTC DataChannel 양쪽으로 전달된다.
- `GET /health`, `POST /api/webrtc/ice-test` 등 진단 엔드포인트가 현재 활성 엔진과 그 헬스 상태를 운영자에게 노출한다.
- mediasoup 경로는 코드 삭제 없이 유지되며, `.env`에서 `WEBRTC_ENGINE=mediasoup`로 전환 시 즉시 동작 가능한 상태를 유지한다.

### 2.2 Non-Goals

- mediasoup의 관측된 불안정성(끊김/재생 불가)에 대한 근본 원인 수정 — 이 PRD는 "mediamtx를 기본으로 쓴다"는 제품 결정을 반영할 뿐, mediasoup 자체 버그 수정은 범위 밖이다.
- werift 엔진의 실제 구현 — 여전히 스텁 상태로 남는다.
- 녹화(M1), Playback API(M2) 등 WebRTC 게이트웨이의 다른 로드맵 항목 — `RFP_RTSP_WebRTC_Architecture.md`에서 별도로 다룬다.
- 엔진 간 무중단(hot) 전환 — 전환 시 기존 WebRTC 세션은 모두 끊기고 서버 재시작이 필요하다는 기존 제약을 그대로 유지한다.

---

## 3. User Personas

**보안 운영자(Security Operator)** — 대시보드에서 다중 카메라를 실시간으로 감시한다. 엔진이 무엇인지 몰라도 되지만, 영상이 끊기면 즉시 알아채고 "Reconnect" 등 복구 수단을 기대한다.

**System Administrator** — `server/.env`의 `WEBRTC_ENGINE`을 배포 환경에 맞게 설정하고, 문제 발생 시 `/health`나 `POST /api/webrtc/ice-test` 응답으로 현재 엔진과 헬스 상태를 즉시 확인하고 싶어한다.

**Field Engineer** — 카메라의 동시 RTSP 세션 제한이 엄격한 사이트에 배포할 때, mediasoup으로 전환하는 것이 유리한지 판단해야 하며 이때 H.265 카메라 유무를 사전에 확인해야 한다(§5.3).

---

## 4. Functional Specification

### 4.1 엔진 선택 및 기본값

`WEBRTC_ENGINE` 환경변수(`mediamtx` | `mediasoup` | `werift`, 대소문자 무관)로 선택한다. 미설정 또는 알 수 없는 값이면 `mediamtx`로 폴백하고 경고 로그를 남긴다(`webrtcEngineFactory.js`). 현재 `server/.env`의 실제 값은 `mediamtx`이다.

### 4.2 mediamtx 모드 동작 (현재 기본)

카메라 파이프라인 시작 시(`pipelineManager.js`):
1. `webrtcEnabled`이면서 `WEBRTC_ENGINE=mediamtx`인 경우, MediaMTX에 카메라 경로를 등록(`mediamtxManager.addCameraPath()`)하고 업스트림 준비를 최대 8초 대기(`waitForPathReady()`).
2. 등록 성공 시, ingest-daemon의 AI 프레임 소스가 원본 카메라 URL이 아니라 MediaMTX 로컬 루프백(`rtsp://127.0.0.1:{MEDIAMTX_RTSP_PORT}/{cameraId}`)으로 전환된다 — 카메라가 동시 RTSP 세션을 하나만 허용하는 경우에도 MediaMTX 하나만 실제 카메라에 접속한다.
3. App RTP(ONVIF)는 MediaMTX가 재발행하지 않으므로, ingest-daemon이 원본 카메라 URL로 별도 연결해 추출한다.
4. 브라우저는 `POST /api/webrtc/whep/:cameraId`로 SDP offer를 보내고, 서버(`mediamtxEngine.js`)가 이를 MediaMTX WHEP 엔드포인트(`{MEDIAMTX_WEBRTC_URL}/{cameraId}/whep`)로 그대로 프록시한다. ICE 협상 후 미디어는 브라우저와 MediaMTX 사이에 직접 흐른다.
5. YouTube 카메라는 yt-dlp/ffmpeg가 처음부터 MediaMTX `/yt/<id>` 경로로 publish하므로 이중 등록 없이 그 경로를 재사용한다.

### 4.3 mediasoup 모드 동작 (현재 dormant, `WEBRTC_ENGINE=mediasoup` 설정 시 활성화)

1. ingest-daemon이 카메라에 단일 PyAV 세션을 열고, AI JPEG · H.264 RTP · Opus RTP · App RTP 4갈래로 팬아웃한다.
2. H.264/Opus RTP는 mediasoup PlainTransport로 직접 수신되어 Worker Pool(카메라ID 해시 배정) 위의 Router에 Producer로 등록된다.
3. 브라우저가 WHEP 요청 시마다 전용 `WebRtcTransport` + `videoConsumer`/`audioConsumer`/`dataConsumer`가 생성된다.
4. 브라우저 offer의 H.264 payload type이 기본값(108)과 다르면, 그 PT 전용 Router+Producer 세트(alt-PT 파이프라인)가 그 자리에서 새로 생성되고 캐시된다.
5. App RTP는 Socket.IO뿐 아니라 mediasoup DataChannel(`dataProducer`/`dataConsumer`)로도 전달된다.

### 4.4 진단/헬스 노출

- `POST /api/webrtc/ice-test` — 현재 활성 엔진의 헬스 상태와 엔진별 정보(`getEngineInfo()`)를 반환한다. mediamtx는 `{ engine: 'mediamtx-whep', whepProxy, iceCandidates, udpPort }`, mediasoup은 `{ engine: 'mediasoup', announcedIp, rtcPorts, cameras, numWorkers }`를 반환한다. 엔진이 unhealthy면 HTTP 503과 함께 `engine`/`hint` 필드를 반환한다.
- `GET /api/webrtc/monitor` (dev-only/localhost 전용) — `webrtcEngine`, `webrtc.ok`, 카메라별 파이프라인 상태를 노출한다.

---

## 5. Technical Requirements

### 5.1 카메라 접속 원칙

mediamtx 모드에서는 MediaMTX가 카메라에 대한 유일한 RTSP 클라이언트다. mediasoup 모드에서는 ingest-daemon이 유일한 RTSP 클라이언트다. 두 모드 모두 "카메라당 실제 RTSP 접속은 1개"라는 프로젝트 아키텍처 원칙(`.claude/CLAUDE.md` 수집 레이어 아키텍처 원칙)을 지킨다.

### 5.2 엔진 공통 인터페이스

모든 엔진은 `{ ENGINE_NAME, addCameraStream(), removeCameraStream(), waitForStreamReady(), negotiate(), isHealthy(), getEngineInfo() }`를 구현해야 한다(`webrtcEngineFactory.js`). mediasoup은 추가로 App RTP 전달용 `sendAppRtp()`를 노출한다.

### 5.3 H.265/HEVC 제약

mediasoup 엔진은 H.265를 지원하지 않는다(mediasoup 3.21.x 자체 제약). H.265 카메라가 하나라도 포함된 사이트는 `WEBRTC_ENGINE=mediasoup`을 선택해서는 안 된다. mediamtx는 코덱 무관이므로 이 제약이 없다.

### 5.4 엔진 전환 절차

`.env`의 `WEBRTC_ENGINE` 값을 변경한 뒤 서버를 재시작해야 한다(무중단 전환 미지원). 전환 시 기존 WebRTC 세션은 모두 끊기며 브라우저 새로고침이 필요하다.

---

## 6. API / Interface Contract

```
POST /api/webrtc/whep/:cameraId
  Content-Type: application/sdp
  Body: SDP offer
  → 200/201 + SDP answer (엔진 무관 동일 계약)
  → 503 { error } — 엔진 unreachable

POST /api/webrtc/ice-test
  → 200 { testId, engine, ...engineInfo }   (엔진별 engineInfo 필드는 다름, §4.4)
  → 503 { error, engine, hint }

GET /health
  → 200 { status, uptime, timestamp, db, serverMode, maxChannelNum }
  (주의: webrtcEngine 필드는 포함하지 않음 — 엔진 확인은 ice-test 또는 dev-only monitor 사용)

GET /api/webrtc/monitor   (dev-only / localhost 전용)
  → 200 { serverMode, webrtcEngine, webrtc: { engine, ok }, pipelines, producerStats }
```

---

## 7. Acceptance Criteria

- [ ] `WEBRTC_ENGINE` 미설정 시 서버가 `mediamtx`로 폴백하고 경고 로그를 남긴다.
- [ ] mediamtx 모드에서 카메라 추가 → MediaMTX 경로 등록 → WHEP 재생까지 수동 테스트로 확인된다.
- [ ] `POST /api/webrtc/ice-test`가 현재 설정된 엔진에 맞는 `engine` 필드 값을 반환한다(mediamtx: `mediamtx-whep`, mediasoup: `mediasoup`).
- [ ] mediasoup으로 전환 시(`WEBRTC_ENGINE=mediasoup` + 서버 재시작) 기존 코드가 여전히 동작한다(회귀 없음) — TC_WebRTC_Engine_Modes.md TC-B 그룹으로 검증.
- [ ] H.265 카메라가 mediasoup 모드에서 명시적인 경고 로그와 함께 재생 실패함을 확인한다(크래시가 아닌 정상적인 실패).

---

## 8. Out of Scope

- mediasoup 불안정성의 근본 원인 수정 (§2.2)
- werift 엔진 구현
- 엔진 간 무중단 전환
- 브라우저별(Chrome/Edge/Safari) WebRTC 호환성 매트릭스 확장 — 기존 `Design_WebRTC_Engine_Modes.md` §4.6a 범위를 그대로 따른다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 — mediamtx 기본 채택에 따른 제품 요구사항 정의 |
