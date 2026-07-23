# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# WebRTC Engine Modes (mediamtx / mediasoup)

| | |
|---|---|
| **Document ID** | SRS-LTS-WEM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-07-23 |
| **Parent PRD** | [prd/PRD_WebRTC_Engine_Modes.md](../prd/PRD_WebRTC_Engine_Modes.md) |
| **Parent RFP** | [rfp/RFP_WebRTC_Engine_Modes.md](../rfp/RFP_WebRTC_Engine_Modes.md) |
| **Child Design** | [design/Design_WebRTC_Engine_Modes.md](../design/Design_WebRTC_Engine_Modes.md) |
| **Child TC** | [tc/TC_WebRTC_Engine_Modes.md](../tc/TC_WebRTC_Engine_Modes.md) |
| **Test Script** | test/api/webrtc_engine_modes.test.js |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Engine Selection](#3-functional-requirements--engine-selection)
4. [Functional Requirements — mediamtx Flow](#4-functional-requirements--mediamtx-flow)
5. [Functional Requirements — mediasoup Flow](#5-functional-requirements--mediasoup-flow)
6. [Functional Requirements — Diagnostics](#6-functional-requirements--diagnostics)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [Interface Requirements](#8-interface-requirements)
9. [Constraints & Assumptions](#9-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

이 SRS는 `WEBRTC_ENGINE`으로 선택되는 mediamtx/mediasoup 두 백엔드의 검증 가능한 기능 요구사항을 정의한다. 각 요구사항은 FR-WEM-NNN ID로 식별되며 `TC_WebRTC_Engine_Modes.md`의 테스트 케이스로 추적된다.

### 1.2 Scope

- `webrtcEngineFactory.js`의 엔진 선택 로직
- mediamtx 모드의 카메라 경로 등록/WHEP 프록시 흐름
- mediasoup 모드의 RTP 팬아웃/Worker Pool/alt-PT 캐시 흐름
- 두 모드 공통 진단 엔드포인트(`/api/webrtc/ice-test`, `/api/webrtc/monitor`)

범위 밖: werift 엔진(스텁), 녹화/Playback(M1/M2, `SRS_RTSP_WebRTC_Architecture.md` 참조), mediasoup 자체의 안정성 결함 수정.

### 1.3 Definitions

| Term | Definition |
|---|---|
| WHEP | WebRTC-HTTP Egress Protocol — SDP offer/answer를 단일 HTTP POST로 교환하는 표준 |
| dormant 엔진 | 코드는 존재하고 정상 동작하지만 현재 `.env` 설정상 실행되지 않는 엔진(현재 mediasoup) |
| alt-PT 파이프라인 | mediasoup에서 브라우저 offer의 H.264 PT가 기본값과 다를 때 그 PT 전용으로 새로 생성하는 Router+Producer 세트 |
| PlainTransport | mediasoup이 로컬 프로세스(ingest-daemon)로부터 암호화되지 않은 RTP를 받는 트랜스포트 |
| WebRtcTransport | mediasoup이 브라우저와 DTLS-SRTP로 통신하는 트랜스포트 |

---

## 2. System Overview

```
webrtcEngineFactory.js (WEBRTC_ENGINE env var)
  ├── 'mediamtx'  (기본값) → webrtc/mediamtxEngine.js  → mediamtxManager.js → MediaMTX 프로세스
  ├── 'mediasoup'           → webrtc/mediasoupEngine.js → mediasoup npm 패키지 (Worker Pool)
  └── 'werift'    (스텁)    → webrtc/weriftEngine.js
```

두 실동작 엔진 모두 `pipelineManager.js`의 카메라 시작 로직(`startCamera()`)과 `index.js`의 `POST /api/webrtc/whep/:cameraId`/`POST /api/webrtc/ice-test`에서 동일한 인터페이스로 호출된다.

---

## 3. Functional Requirements — Engine Selection

| ID | Requirement |
|---|---|
| FR-WEM-001 | 시스템은 `WEBRTC_ENGINE` 환경변수 값(`mediamtx`\|`mediasoup`\|`werift`, 대소문자 무관)에 따라 사용할 WebRTC 엔진을 결정해야 한다. |
| FR-WEM-002 | `WEBRTC_ENGINE`이 미설정이거나 유효하지 않은 값이면 시스템은 `mediamtx`로 폴백하고 경고 로그를 남겨야 한다. |
| FR-WEM-003 | 엔진 선택은 프로세스 시작 시 1회 결정되며(`getEngine()` lazy 싱글톤), 런타임 중 재선택되지 않아야 한다. |
| FR-WEM-004 | 모든 엔진 구현체는 `ENGINE_NAME`, `addCameraStream()`, `removeCameraStream()`, `waitForStreamReady()`, `negotiate()`, `isHealthy()`, `getEngineInfo()`를 공통 인터페이스로 노출해야 한다. |

---

## 4. Functional Requirements — mediamtx Flow

| ID | Requirement |
|---|---|
| FR-WEM-010 | `WEBRTC_ENGINE=mediamtx`이고 카메라의 `webrtcEnabled`가 true인 경우, 카메라 시작 시 시스템은 `mediamtxManager.addCameraPath()`로 MediaMTX에 카메라 RTSP 경로를 등록해야 한다. |
| FR-WEM-011 | 경로 등록 성공 시 시스템은 최대 8초간 `waitForPathReady()`로 MediaMTX 업스트림 준비를 대기해야 하며, 타임아웃 시 경고 로그를 남기되 카메라 시작을 차단하지 않아야 한다. |
| FR-WEM-012 | MediaMTX 등록이 성공한 카메라는 이후 AI 프레임 추출용 ingest-daemon 세션이 원본 카메라 URL이 아니라 MediaMTX 로컬 루프백(`rtsp://127.0.0.1:{MEDIAMTX_RTSP_PORT}/{cameraId}`)을 사용해야 한다. |
| FR-WEM-013 | App RTP(ONVIF 메타데이터) 추출은 MediaMTX 등록 여부와 무관하게 항상 원본 카메라 URL로 이루어져야 한다(MediaMTX는 App RTP 트랙을 재발행하지 않음). |
| FR-WEM-014 | YouTube 소스 카메라는 이미 MediaMTX `/yt/<id>` 경로로 publish되어 있으므로, 별도의 MediaMTX 경로 재등록을 수행하지 않아야 한다. |
| FR-WEM-015 | `POST /api/webrtc/whep/:cameraId`로 수신한 SDP offer는 `mediamtxEngine.negotiate()`를 통해 MediaMTX WHEP 엔드포인트(`{MEDIAMTX_WEBRTC_URL}/{cameraId}/whep`)로 그대로 프록시되어야 하며, 응답의 `location`/`link`/`etag`/`access-control-expose-headers` 헤더는 클라이언트로 전달되어야 한다. |

---

## 5. Functional Requirements — mediasoup Flow

| ID | Requirement |
|---|---|
| FR-WEM-020 | `WEBRTC_ENGINE=mediasoup`인 경우, 카메라 등록은 ingest-daemon `POST /cameras`에 `mediasoupAudioPort`(및 비디오 RTP 팬아웃 포트)를 포함해 단일 요청으로 이루어져야 한다. |
| FR-WEM-021 | 시스템은 카메라ID 해시 기반으로 각 카메라를 Worker Pool의 특정 Worker에 결정론적으로 배정해야 하며, 해당 카메라의 생애주기 동안 이 배정이 변경되지 않아야 한다. |
| FR-WEM-022 | 브라우저 SDP offer의 H.264 payload type이 기본값(`DEFAULT_VIDEO_PT=108`)과 다를 경우, 시스템은 그 PT 전용 Router+PlainTransport+Producer(alt-PT 파이프라인)를 지연 생성하고 이후 동일 PT 요청에 재사용해야 한다. |
| FR-WEM-023 | mediasoup Worker가 예기치 않게 종료되면, 시스템은 해당 Worker에 배정된 카메라만 재등록해야 하며 다른 Worker의 카메라는 영향받지 않아야 한다. |
| FR-WEM-024 | H.265(HEVC)로 판정된 카메라는 mediasoup Producer 생성이 실패해야 하며(H.264로 항상 시도), 시스템은 그 사유를 명확히 로그로 남겨야 한다(서버 크래시 금지). |
| FR-WEM-025 | App RTP(ONVIF)는 mediasoup 모드에서 Socket.IO와 WebRTC DataChannel(`dataProducer`→`dataConsumer`) 양쪽으로 전달되어야 한다. `videoOnly` 카메라는 DataChannel 경로를 생략해야 한다. |

---

## 6. Functional Requirements — Diagnostics

| ID | Requirement |
|---|---|
| FR-WEM-030 | `POST /api/webrtc/ice-test`는 현재 활성 엔진이 healthy하면 HTTP 200과 함께 `{ testId, ...engineInfo }`를 반환해야 하며, engineInfo는 엔진별로 `engine` 필드를 포함해야 한다(mediamtx: `"mediamtx-whep"`, mediasoup: `"mediasoup"`). |
| FR-WEM-031 | 엔진이 unhealthy하면 `POST /api/webrtc/ice-test`는 HTTP 503과 함께 `{ error, engine, hint }`를 반환해야 한다. |
| FR-WEM-032 | `GET /api/webrtc/monitor`는 개발 환경(`NODE_ENV=development`) 또는 localhost 요청에서만 응답해야 하며, 그 외에는 HTTP 403을 반환해야 한다. |
| FR-WEM-033 | `GET /health`는 `webrtcEngine` 필드를 포함하지 않는다 — 엔진 확인은 FR-WEM-030/032의 엔드포인트를 사용해야 한다(회귀 방지용 명시적 비-요구사항). |

---

## 7. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-WEM-001 | 안정성 | mediamtx 모드는 이 프로젝트 실측 기준 "영상 끊김" 발생률이 mediasoup 모드보다 유의미하게 낮아야 한다(정성적 기준 — Design §9 참조). |
| NFR-WEM-002 | 장애 격리 | mediasoup Worker 하나의 사망이 다른 Worker에 배정된 카메라의 스트리밍에 영향을 주지 않아야 한다(§6.31 Worker Pool 설계). |
| NFR-WEM-003 | 호환성 | mediamtx 모드는 카메라의 비디오 코덱(H.264/H.265 등)과 무관하게 동작해야 한다. |
| NFR-WEM-004 | 복구 가능성 | 엔진 전환(`.env` 변경 + 재시작) 후 기존에 정상 동작하던 카메라 파이프라인이 코드 변경 없이 새 엔진에서도 등록·재생되어야 한다. |
| NFR-WEM-005 | 리소스 절약 | mediasoup의 기본(PT=108) 비디오 팬아웃은 실제로 그 PT를 사용하는 뷰어가 없으면 ingest-daemon에 등록되지 않아야 한다(지연 등록, §6.27) — 불필요한 CPU 낭비 방지. |

---

## 8. Interface Requirements

| ID | Interface | Requirement |
|---|---|---|
| IR-WEM-001 | `POST /api/webrtc/whep/:cameraId` | `Content-Type: application/sdp`, body는 원문 SDP offer 문자열이어야 한다. 빈 body는 HTTP 400을 반환해야 한다. |
| IR-WEM-002 | `POST /api/webrtc/ice-test` | 인증 불필요, 응답 스키마는 §6 참조 |
| IR-WEM-003 | ingest-daemon `POST /cameras` | mediamtx 모드는 `rtspUrl`(MediaMTX 루프백 또는 원본), `callbackUrl`, `appRtpCallbackUrl`, `appRtpRtspUrl`을 전달; mediasoup 모드는 추가로 `mediasoupAudioPort`를 전달해야 한다. |

---

## 9. Constraints & Assumptions

- MediaMTX 바이너리가 시스템에 설치되어 있고 `startServer.js`가 자동으로 기동함을 전제한다(mediamtx 모드).
- mediasoup npm 패키지의 네이티브 addon(`mediasoup-worker`)이 대상 플랫폼에서 빌드 가능함을 전제한다(mediasoup 모드, 현재 dormant이므로 재활성화 시점에 재검증 필요).
- 두 엔진 모두 `SERVER_IP`/`SERVER_PUBLIC_IP` 환경변수가 ICE candidate 구성에 사용된다는 전제는 mediasoup에만 해당하며, mediamtx는 `mediamtx.yml`의 자체 설정을 따른다.
- 이 SRS는 werift 엔진의 미래 구현을 전제하지 않는다 — 스텁으로 유지되는 한 FR-WEM-* 요구사항의 적용 대상이 아니다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 — mediamtx/mediasoup 엔진 선택·플로우·진단에 대한 검증 가능 요구사항(FR-WEM-001~033, NFR-WEM-001~005) 정의 |
