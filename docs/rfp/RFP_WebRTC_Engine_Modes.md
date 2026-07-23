# RFP — WebRTC 엔진 선택: mediamtx vs mediasoup
**Document ID**: RFP-LTS-WEM-01
**Version**: 1.0
**Date**: 2026-07-23
**Project**: Loitering Detection & Tracking System (LTS-2026)
**Status**: Adopted — mediamtx 기본 엔진 채택 완료
**Author**: LTS Engineering Team

### Change Log
| Ver | Date | Summary |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 — 실측 운영 비교 기반 mediamtx 채택 근거 정리 |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Background — 두 Flow의 실제 구현](#2-background--두-flow의-실제-구현)
3. [Problem Statement](#3-problem-statement)
4. [Technology Evaluation](#4-technology-evaluation)
5. [Full Comparison Matrix](#5-full-comparison-matrix)
6. [Recommendation](#6-recommendation)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Risk Assessment](#8-risk-assessment)
9. [Related Documents](#9-related-documents)

---

## 1. Overview

LTS-2026은 `WEBRTC_ENGINE` 환경변수(`server/src/services/webrtcEngineFactory.js`)로 브라우저 WebRTC 영상 전달 백엔드를 mediamtx 또는 mediasoup 중에서 선택할 수 있다. 두 엔진 모두 실제로 동작하는 상태로 구현되어 있으나(werift는 스텁), 실 운영 환경에서 두 엔진을 모두 사용해 본 결과 mediasoup 사용 시 영상 끊김이 반복 관측되었고 mediamtx로 전환한 뒤에는 안정적으로 재생되었다. 본 문서는 두 엔진의 실제 데이터 흐름을 코드 기준으로 비교하고, mediamtx를 기본값으로 채택한 근거를 기록한다.

---

## 2. Background — 두 Flow의 실제 구현

### 2.1 mediamtx 모드 (`WEBRTC_ENGINE=mediamtx`, 현재 기본값)

```
[IP 카메라 RTSP]
      │
      ▼ (MediaMTX가 카메라에서 직접 Pull, 카메라당 접속 1개)
┌─────────────────────────────────────────────┐
│ MediaMTX  (rtsp://127.0.0.1:8554/<cameraId>) │  ← mediamtxManager.addCameraPath()
│  - API:  http://127.0.0.1:9997 (경로 등록)     │     pipelineManager.js:508-528
│  - WHEP: http://127.0.0.1:8889 (WebRTC 송출)  │
└─────────────────────────────────────────────┘
      │                                   │
      │ ① AI 프레임용 재접속(로컬호스트)        │ ② 브라우저 재생 (WHEP)
      ▼                                   ▼
[ingest-daemon]                    [server: POST /api/webrtc/whep/:id]
 rtsp://127.0.0.1:8554/<id> 를        (mediamtxEngine.js가 프록시)
 소스로 PyAV 세션 오픈                        │
      │                                   ▼
      │ POST /api/internal/frame/:id   MediaMTX WHEP endpoint
      ▼                              (http://127.0.0.1:8889/<id>/whep)
  AI 파이프라인 (YOLO 등)                    │
                                        SDP answer
      ▲                                   │
      │ App RTP(ONVIF)는 MediaMTX가        ▼
      │ 재발행하지 않으므로 원본 카메라 URL로   ICE 협상 이후
      │ 별도 연결                          미디어(RTP)는
      └── POST /api/internal/apprtp/:id   브라우저 ↔ MediaMTX
                                          직접 UDP (기본 포트 8189)
```

### 2.2 mediasoup 모드 (`WEBRTC_ENGINE=mediasoup`, 현재 dormant)

```
[IP 카메라 RTSP] ── 단일 PyAV 세션 (ingest-daemon만 접속) ──┐
                                                            │
                    ┌───────────────────────────────────────┤
                    │        ingest-daemon (Python)          │
                    │  POST /cameras { rtspUrl, callbackUrl,  │  ← pipelineManager.js:566-577
                    │    appRtpCallbackUrl, mediasoupAudioPort│     mediasoupEngine.addCameraStream()
                    │  }                                       │     가 이 POST를 대신 보냄
                    └───────────────────────────────────────┘
                          │        │           │           │
              ① AI JPEG   │  ② H.264 RTP │ ③ Opus RTP │ ④ App RTP(ONVIF)
                          ▼        ▼           ▼           ▼
        POST /api/internal/   UDP:videoPort UDP:audioPort  POST /api/internal/
        frame/:cameraId      (PlainTransport) (PlainTransport)  apprtp/:cameraId
                          │        │           │
                    [AI 파이프라인]  └─────┬─────┘
                                          ▼
                          ┌─────────────────────────────────┐
                          │   mediasoup Router (Worker Pool)  │  ← 카메라ID 해시로 Worker 배정
                          │   videoProducer / audioProducer   │     (§6.31 멀티워커)
                          │   directTransport → dataProducer  │  ← App RTP를 DataChannel로 전달
                          └─────────────────────────────────┘
                                          │
                                브라우저가 WHEP 요청 시마다
                                          ▼
                          ┌─────────────────────────────────┐
                          │ 브라우저별 WebRtcTransport 생성      │  ← negotiate(cameraId, sdpOffer)
                          │  + videoConsumer + audioConsumer   │
                          │  + dataConsumer (App RTP)           │
                          └─────────────────────────────────┘
                                          │
                                     SDP answer
                                          ▼
                          브라우저 ↔ mediasoup 간 직접 UDP
                        (SERVER_IP/SERVER_PUBLIC_IP로 announce,
                         MEDIASOUP_MIN_PORT~MAX_PORT, 기본 40000-49999)
```

두 모드 모두 브라우저는 동일한 엔드포인트(`POST /api/webrtc/whep/:cameraId`)를 호출하며, 서버가 `WEBRTC_ENGINE` 값에 따라 내부적으로 `mediamtxEngine.js` 또는 `mediasoupEngine.js`로 디스패치한다(`webrtcEngineFactory.js`).

---

## 3. Problem Statement

| # | 문제 | 영향 |
|---|---|---|
| P-1 | mediasoup 모드에서 영상이 간헐적으로 끊기고 재생이 잘 안 됨(실사용자 보고) | 실시간 모니터링 신뢰도 저하 — 배회 감지 시스템의 핵심 가치 훼손 |
| P-2 | mediasoup은 브라우저별 H.264 RTP payload type(PT)이 세션마다 달라, 고정 PT 하나로는 해결되지 않고 alt-PT Router를 그때그때 새로 만들어야 함(`_ensureAltPipeline`) | 신규 브라우저/OS 조합마다 재현 조사 비용 발생 |
| P-3 | mediasoup 3.21.x는 H.265(HEVC)를 아예 지원하지 않아 해당 카메라의 `addCameraStream()` 자체가 실패함 | 혼합 카메라 fleet에서 mediasoup을 기본으로 쓰면 일부 카메라가 영구히 재생 불가 |
| P-4 | mediasoup Worker(Node 자식 프로세스) 사망 시 그 Worker에 배정된 모든 카메라를 재등록해야 함(`_handleWorkerDied`) | 장애 시 영향 범위가 mediamtx(외부 프로세스 재시작만으로 복구) 대비 넓음 |
| P-5 | 공유 호스트에서 mediasoup-worker의 UDP 수신 큐 백로그가 CPU 사용률과 무관하게 쌓이는 OS 스케줄링 지연 문제가 있어, 별도 `nice` 우선순위 wrapper 바이너리(`tools/mediasoup-worker-priority-wrapper`)까지 필요했음 | 운영 복잡도·빌드 단계 추가 |

---

## 4. Technology Evaluation

### 4.1 mediamtx (Go 바이너리, 외부 프로세스)

| 항목 | 평가 |
|---|---|
| WebRTC 엔진 | Pion(Go 네이티브) — ICE/DTLS/SRTP 내장, WHEP 표준 프로토콜 |
| 카메라 접속 방식 | MediaMTX가 카메라를 1회 Pull, 로컬 루프백으로 재발행 |
| 코덱 제약 | 없음 — 코덱 무관 재발행(passthrough) |
| 장애 복구 | 외부 프로세스 재시작만으로 복구, Node 프로세스는 영향 최소 |
| 구현/유지보수 복잡도 | 낮음 — `mediamtxEngine.js`는 WHEP 프록시 역할만 수행 |
| 실측 안정성(이 프로젝트) | ✅ 양호 — 전환 후 끊김 없음 |
| **결론** | **채택 — 기본 엔진** |

### 4.2 mediasoup (Node.js 내장 SFU)

| 항목 | 평가 |
|---|---|
| WebRTC 엔진 | Node.js 프로세스 내 Worker Pool(C++ addon), Router/Transport/Producer/Consumer 모델 |
| 카메라 접속 방식 | ingest-daemon이 카메라에 직접 1회 접속, RTSP 세션 자체는 하나로 최소화 |
| 코덱 제약 | H.265 미지원(§Problem P-3), H.264 PT가 세션마다 달라 alt-PT Router 캐시 필요 |
| 장애 복구 | Worker 사망 시 해당 Worker 소속 카메라 전체 재등록 필요 |
| 구현/유지보수 복잡도 | 높음 — Worker Pool(§6.31), alt-PT 캐시(§6.26), IPC 타임아웃 방어 등 1,800줄+ |
| 실측 안정성(이 프로젝트) | ❌ 불량 — 영상 끊김/재생 불가 반복 보고 |
| **결론** | **비채택 — 코드는 보존, dormant 상태 유지** |

### 4.3 werift (순수 TypeScript, 스텁)

| 항목 | 평가 |
|---|---|
| 구현 상태 | 미구현(스텁만 존재) |
| **결론** | 평가 대상 아님 — 향후 후보로만 남김 |

---

## 5. Full Comparison Matrix

| 기준 | mediamtx (채택) | mediasoup (비채택, 보존) |
|---|---|---|
| **카메라 RTSP 접속 수** | MediaMTX 1개 | ingest-daemon 1개(4갈래 팬아웃) |
| **미디어 서버 역할** | 외부 프로세스가 SFU/재발행 담당 | Node 프로세스 내 Worker Pool이 담당 |
| **브라우저 프로토콜** | WHEP 표준 | 커스텀 WHEP 스타일 `negotiate()` |
| **미디어 흐름 주체** | 브라우저 ↔ MediaMTX (Node은 미디어 미개입) | 브라우저 ↔ mediasoup Worker(Node 자식) |
| **App RTP(ONVIF) 전달** | Socket.IO 전용 | Socket.IO + DataChannel |
| **코덱 PT 이슈** | 없음 | alt-PT Router 캐시 필요 |
| **H.265/HEVC 지원** | ✅ (코덱 무관) | ❌ 재생 불가 |
| **장애 영향 범위** | 좁음 | 넓음(Worker 단위) |
| **구현 복잡도** | 낮음 | 높음 |
| **실측 안정성** | ✅ 양호 | ❌ 불량 |
| **현재 `.env` 설정** | ✅ 활성(기본값) | dormant |

---

## 6. Recommendation

`WEBRTC_ENGINE=mediamtx`를 기본값으로 유지한다. mediasoup 코드는 삭제하지 않고 보존한다 — 카메라의 동시 RTSP 세션 제한이 매우 엄격한 사이트나, DataChannel 기반 저지연 App RTP가 필수인 사이트가 향후 나타날 경우 재검토 후보로 남긴다. 단, 그런 사이트에서도 카메라 fleet에 H.265가 섞여 있다면 mediasoup은 선택할 수 없다(§4.2).

---

## 7. Acceptance Criteria

- [x] `server/.env`의 `WEBRTC_ENGINE`이 `mediamtx`로 설정되어 있고, 이것이 코드 기본값(`webrtcEngineFactory.js`의 `|| 'mediamtx'`)과 일치함
- [x] mediasoup 관련 파일(`mediasoupEngine.js` 등)이 삭제되지 않고 저장소에 유지됨
- [x] 두 엔진의 실제 데이터 흐름이 Design/RFP/PRD/SRS/ops/TC 문서에 일관되게 기록됨
- [ ] (운영 지속 검증) mediamtx 채택 이후 30일간 "영상 끊김" 운영자 신고 0건 — Admin Dashboard 로그로 주기적 확인 필요

---

## 8. Risk Assessment

| 리스크 | 가능성 | 영향 | 완화 방안 |
|---|---|---|---|
| mediamtx 프로세스 자체 장애(바이너리 크래시) | 낮음 | 높음 | `startServer.js`의 MediaMTX 자동 시작/재시작 로직, Admin Dashboard 헬스체크 모니터링 |
| 향후 요구사항으로 mediasoup 재활성화 시 §Problem의 미해결 이슈(alt-PT, HEVC, Worker 장애 범위)가 그대로 재현 | 중간 | 중간 | 재활성화 전 이 RFP §3/§4.2를 먼저 재검토, HEVC 카메라 유무 사전 확인 |
| mediasoup 코드가 장기간 미사용 상태로 방치되어 mediasoup npm 패키지 버전 드리프트 발생 | 중간 | 낮음 | 재활성화 시점에 `npm outdated mediasoup` 확인 후 마이그레이션 비용 별도 산정 |
| 문서(Design/RFP/PRD/SRS/TC)가 코드 변경을 따라가지 못해 다시 드리프트 발생 | 중간 | 중간 | `.claude/CLAUDE.md` SDLC 문서-코드 동기화 규칙 준수 — WebRTC 엔진 관련 코드 변경 시 이 문서 세트 동시 갱신 |

---

## 9. Related Documents

| 문서 | 경로 | 관계 |
|---|---|---|
| MRD | [mrd/MRD_WebRTC_Engine_Modes.md](../mrd/MRD_WebRTC_Engine_Modes.md) | 비즈니스 결정 근거 |
| PRD | [prd/PRD_WebRTC_Engine_Modes.md](../prd/PRD_WebRTC_Engine_Modes.md) | 제품 요구사항 |
| SRS | [srs/SRS_WebRTC_Engine_Modes.md](../srs/SRS_WebRTC_Engine_Modes.md) | 검증 가능 요구사항 |
| Design | [design/Design_WebRTC_Engine_Modes.md](../design/Design_WebRTC_Engine_Modes.md) | 아키텍처 상세 설계 (Parent Design) |
| ops | [ops/WebRTC_Engine_Modes_Guide.md](../ops/WebRTC_Engine_Modes_Guide.md) | 운영/전환 가이드 |
| TC | [tc/TC_WebRTC_Engine_Modes.md](../tc/TC_WebRTC_Engine_Modes.md) | 테스트 케이스 |
| 레거시 참고 | [rfp/RFP_WebRTC_Media_Gateway.md](RFP_WebRTC_Media_Gateway.md) | 2026-05 작성, 실제로는 구현되지 않은 별개 아키텍처(FFmpeg 듀얼 출력) — 엔진 내부 동작은 본 문서가 정확함 |
| Server Architecture | [design/Design_Server_Architecture.md](../design/Design_Server_Architecture.md) | SERVER_MODE 및 전체 아키텍처 맥락 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 — mediamtx/mediasoup 실측 운영 비교 및 mediamtx 채택 근거 |
