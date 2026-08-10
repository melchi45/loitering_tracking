# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# RTSP-over-WebSocket 스트리밍 경로

| | |
|---|---|
| **Document ID** | SRS-LTS-RTSPWS-01 |
| **Version** | 1.3 |
| **Status** | Active |
| **Date** | 2026-07-22 |
| **Parent PRD** | [prd/PRD_RTSP_Over_WebSocket.md](../prd/PRD_RTSP_Over_WebSocket.md) |
| **Parent RFP** | [rfp/RFP_RTSP_Over_WebSocket.md](../rfp/RFP_RTSP_Over_WebSocket.md) |
| **Child Design** | [design/Design_RTSP_Over_WebSocket.md](../design/Design_RTSP_Over_WebSocket.md) |
| **Child TC** | [tc/TC_RTSP_Over_WebSocket.md](../tc/TC_RTSP_Over_WebSocket.md) |

---

## Table of Contents

1. [개요](#1-개요)
2. [시스템 개요](#2-시스템-개요)
3. [기능 요구사항 — 카메라 스키마 및 재생 모드](#3-기능-요구사항--카메라-스키마-및-재생-모드)
4. [기능 요구사항 — ingest-daemon Fan-out](#4-기능-요구사항--ingest-daemon-fan-out)
5. [기능 요구사항 — `/StreamingServer` WS 브릿지](#5-기능-요구사항--streamingserver-ws-브릿지)
6. [기능 요구사항 — 채널 매핑](#6-기능-요구사항--채널-매핑)
7. [기능 요구사항 — 클라이언트 UI](#7-기능-요구사항--클라이언트-ui)
8. [비기능 요구사항](#8-비기능-요구사항)
9. [인터페이스 요구사항](#9-인터페이스-요구사항)
10. [제약 사항 및 가정](#10-제약-사항-및-가정)

---

## 1. 개요

### 1.1 목적

본 SRS는 LTS-2026의 세 번째 카메라 재생 경로인 RTSP-over-WebSocket 기능의 검증 가능한 기능 요구사항을 정의한다. 각 요구사항은 `FR-RTSPWS-NNN` ID로 식별되며 `TC_RTSP_Over_WebSocket.md`의 테스트 케이스와 추적 가능하다.

### 1.2 범위

본 문서가 다루는 범위:
- 카메라 스키마 `rtspOverWebSocketEnabled` 필드 및 API 계층 `streamingMode` UI 편의 필드
- ingest-daemon의 6번째 fan-out(PyAV → 로컬 MediaMTX publish)의 on-demand 시작/종료
- 신규 `/StreamingServer` WebSocket 엔드포인트 — RTSP Digest 인증 + WS↔TCP 바이트 릴레이
- `channelSlot` 재사용에 의한 채널 라우팅
- 카메라 Add/Edit UI의 JPEG/WebRTC/RTSP-over-WebSocket 3-way 선택

범위 밖: `/StreamingServer` 프로토콜 자체의 재정의(표준 RTSP-over-TCP-interleaved 프레이밍 그대로 릴레이), YouTube/RTMP/HLS 소스에 대한 RTSP-over-WebSocket 지원, 신규 인증 체계(JWT 등) 도입.

### 1.3 용어

| 용어 | 정의 |
|---|---|
| RTSP-over-WebSocket | Hanwha(Wisenet) `<rtsp-over-websocket>` 웹 컴포넌트, `melchi45/rtsp-over-websocket` |
| `/StreamingServer` | Hanwha SUNAPI가 정의하는 RTSP-over-WebSocket 엔드포인트 경로 규약 |
| RTSP Proxy | 이 기능이 신설하는 로컬 MediaMTX publish 대상(채널별 `rtsp://127.0.0.1:8554/<channelSlot>`) |
| WS 브릿지 | `/StreamingServer` WebSocket 연결을 수락하고 인증 후 내부 RTSP Proxy로 바이트 릴레이하는 신규 LTS Node 서버 컴포넌트 |
| Fan-out | ingest-daemon이 카메라의 단일 RTSP 세션에서 파생하는 출력 스트림(AI JPEG, mediasoup RTP, 그리고 이번에 추가되는 로컬 MediaMTX publish) |
| Interleaved framing | RFC 7826 §10.12 — RTSP 텍스트 메시지와 `$`-프레임 RTP/RTCP 바이너리가 하나의 TCP(여기서는 WS) 스트림에 혼재하는 프레이밍 |
| streamingMode | API 계층에서만 존재하는 UI 편의 필드(`'jpeg'\|'webrtc'\|'rtsp-over-websocket'`), 저장 시 `{webrtcEnabled, rtspOverWebSocketEnabled}`로 파생 |

---

## 2. 시스템 개요

### 2.1 컴포넌트 의존 관계

```
카메라 RTSP (원본, 세션 1개만)
  └─ ingest-daemon (PyAV, 기존 단일 세션)
       ├─ AI JPEG fan-out            [기존, 변경 없음]
       ├─ mediasoup RTP fan-out       [기존, 변경 없음]
       └─ 로컬 MediaMTX publish       [신규 6번째 fan-out, on-demand]
            rtsp://127.0.0.1:8554/<channelSlot>/media.smp
                 │
                 ▼
       WS 브릿지 (`/StreamingServer`, 신규)
            ├─ 채널 라우팅 (channelSlot → cameraId)
            ├─ RTSP Digest(MD5) 인증 (카메라 저장 자격증명)
            └─ WS ↔ TCP 순수 바이트 릴레이
                 │
                 ▼
       브라우저 <rtsp-over-websocket proxy="SERVER_IP" hostname="SERVER_IP" ...>
```

### 2.2 카메라 스키마 필드 흐름

```
CameraEditModal.tsx (streamingMode 3-way 선택)
  → POST/PUT /api/cameras { streamingMode }
       → server/src/api/cameras.js: streamingModeToFlags(streamingMode)
            → DB: { webrtcEnabled, rtspOverWebSocketEnabled }
  ← GET /api/cameras
       ← server/src/api/cameras.js: deriveStreamingMode(camera)
       ← { ...camera, streamingMode }
```

---

## 3. 기능 요구사항 — 카메라 스키마 및 재생 모드

### FR-RTSPWS-001 — `rtspOverWebSocketEnabled` 필드

모든 카메라 레코드는 boolean 필드 `rtspOverWebSocketEnabled`를 가져야 한다(SHALL). 기본값은 `false`이며, 기존 `webrtcEnabled` 필드와 완전히 독립적으로 존재해야 한다.

### FR-RTSPWS-002 — `streamingMode` API 편의 필드

`POST /api/cameras`, `PUT /api/cameras/:id`는 `streamingMode: 'jpeg'|'webrtc'|'rtsp-over-websocket'` 필드를 선택적으로 받아야 한다(SHALL). 이 필드는 DB에 그대로 저장되지 않으며, 아래 규칙으로 `{webrtcEnabled, rtspOverWebSocketEnabled}`로 파생되어야 한다:

| streamingMode | webrtcEnabled | rtspOverWebSocketEnabled |
|---|---|---|
| `'jpeg'`(기본) | `false` | `false` |
| `'webrtc'` | `true` | `false` |
| `'rtsp-over-websocket'` | `false` | `true` |

**구현 상태: 완료** — `server/src/api/cameras.js`의 `streamingModeToFlags()`.

### FR-RTSPWS-003 — `streamingMode` 역산

`GET /api/cameras`, `GET /api/cameras/:id` 및 카메라 생성/수정 응답은 저장된 `webrtcEnabled`/`rtspOverWebSocketEnabled` 값으로부터 `streamingMode`를 역산해 포함해야 한다(SHALL): `rtspOverWebSocketEnabled === true` → `'rtsp-over-websocket'`, 그 외 `webrtcEnabled === true` → `'webrtc'`, 그 외 → `'jpeg'`.

**구현 상태: 완료** — `server/src/api/cameras.js`의 `deriveStreamingMode()`.

### FR-RTSPWS-004 — 기존 `webrtcEnabled` 동작 불변

`rtspOverWebSocketEnabled` 필드 추가는 `pipelineManager.js`의 파이프라인 재시작 판단, `addCameraStream()` 호출 등 기존 `webrtcEnabled` 관련 코드 경로의 동작을 변경해서는 안 된다(SHALL NOT).

### FR-RTSPWS-005 — YouTube 카메라의 RTSP-over-WebSocket 제외

YouTube 카메라(가상 카메라)는 `streamingMode` 선택지에서 `'rtsp-over-websocket'`를 지원하지 않아야 한다(SHALL NOT) — YouTube 소스는 원본 카메라 개념이 없어 SUNAPI/RTSP Digest 인증 재사용이 성립하지 않는다.

---

## 4. 기능 요구사항 — ingest-daemon Fan-out

### FR-RTSPWS-010 — 6번째 fan-out (로컬 MediaMTX publish)

ingest-daemon은 카메라의 기존 단일 PyAV 세션에서 파생되는 6번째 출력으로, 채널별 `rtsp://127.0.0.1:8554/<channelSlot>/media.smp`에 PyAV in-process muxing으로 publish할 수 있어야 한다(SHALL). FFmpeg subprocess를 사용해서는 안 된다(SHALL NOT) — "FFmpeg subprocess 금지" 원칙 준수.

### FR-RTSPWS-011 — 신규 카메라 세션 금지

FR-RTSPWS-010의 fan-out은 카메라에 대한 신규 RTSP 연결/세션을 생성해서는 안 된다(SHALL NOT). ingest-daemon이 이미 열어둔 단일 세션에서 파생되어야 한다.

### FR-RTSPWS-012 — On-demand 시작

FR-RTSPWS-010의 fan-out은 해당 채널에 대한 WS 브릿지 연결이 0개에서 1개로 전환될 때 시작되어야 한다(SHALL) — 기존 `POST /cameras/:id/video-fanout` API를 재사용한다.

### FR-RTSPWS-013 — On-demand 종료

FR-RTSPWS-010의 fan-out은 해당 채널에 대한 WS 브릿지 연결이 1개에서 0개로 전환될 때(마지막 뷰어 종료) 제거되어야 한다(SHALL).

### FR-RTSPWS-014 — MediaMTX 신뢰 모델 불변

`mediamtx.yml`의 기존 `rtspAddress: 127.0.0.1:8554`(loopback 전용) + `authInternalUsers: any` 설정은 이 기능으로 변경되어서는 안 된다(SHALL NOT). 브라우저는 MediaMTX에 직접 접근하지 않으며, 실제 인증은 WS 브릿지 계층(§5)에서 처리한다.

---

## 5. 기능 요구사항 — `/StreamingServer` WS 브릿지

### FR-RTSPWS-020 — WS 엔드포인트

LTS Node 서버는 `/StreamingServer` 경로에 대해 WebSocket 업그레이드를 수락해야 한다(SHALL). 이 경로는 기존 Socket.IO 서버와 별개의 순수 `ws` 라이브러리 기반 핸들러여야 한다(`<rtsp-over-websocket>`는 Socket.IO 클라이언트가 아님).

### FR-RTSPWS-021 — 채널 식별

WS 브릿지는 연결 수립 후 최초로 수신되는 RTSP 요청 라인(`OPTIONS`/`DESCRIBE`)의 요청 URL에서 `<channelSlot>` 숫자를 파싱해야 한다(SHALL). 매핑되는 `cameraId`가 존재하지 않으면 WS 연결을 종료해야 한다(SHALL).

### FR-RTSPWS-022 — RTSP Digest(MD5) 인증

WS 브릿지는 FR-RTSPWS-021에서 식별된 카메라의 DB에 저장된 `username`/`password`를 이용해 RTSP Digest(MD5) challenge-response 인증을 수행해야 한다(SHALL). 별도의 JWT 또는 신규 인증 체계를 요구해서는 안 된다(SHALL NOT).

### FR-RTSPWS-023 — 인증 실패 처리

RTSP Digest 인증에 실패하면(자격증명 불일치, 또는 카메라에 저장된 자격증명이 없음) WS 브릿지는 내부 MediaMTX 연결 단계(§FR-RTSPWS-024)로 진행해서는 안 된다(SHALL NOT).

### FR-RTSPWS-024 — 내부 RTSP Proxy 연결

인증 성공 후 WS 브릿지는 `rtsp://127.0.0.1:8554/<channelSlot>/media.smp`로 내부 TCP 소켓을 연결해야 한다(SHALL).

### FR-RTSPWS-025 — 순수 바이트 릴레이

인증 및 내부 연결 완료 후, WS 브릿지는 RTSP 프로토콜을 해석하지 않고 WS 바이너리 프레임 ↔ TCP 바이트를 그대로 양방향 릴레이해야 한다(SHALL) — RFC 7826 §10.12 interleaved 프레이밍(텍스트 RTSP + `$` 매직넘버 RTP/RTCP 프레임)을 그대로 통과시킨다.

### FR-RTSPWS-026 — 마지막 연결 종료 감지

WS 브릿지는 특정 채널에 대한 활성 WS 연결 수가 0이 되는 시점을 감지해 FR-RTSPWS-013의 fan-out 종료를 트리거해야 한다(SHALL).

---

## 6. 기능 요구사항 — 채널 매핑

### FR-RTSPWS-030 — `channelSlot` 재사용

RTSP-over-WebSocket 재생의 채널 식별은 기존 `channelSlot`(1..`MAX_CHANNEL_NUM`) 값을 그대로 재사용해야 한다(SHALL). 신규 채널 매핑 테이블을 도입해서는 안 된다(SHALL NOT).

### FR-RTSPWS-031 — `channelSlotService` 재사용

WS 브릿지의 `channelSlot → cameraId` 조회는 기존 `channelSlotService.js`의 조회 로직을 재사용해야 한다(SHALL).

---

## 7. 기능 요구사항 — 클라이언트 UI

### FR-RTSPWS-040 — 3-way 재생 모드 선택

카메라 Add 모달(RTSP 탭)과 Edit 모달(`CameraEditModal.tsx`)은 기존 WebRTC On/Off 토글을 JPEG(Default)/WebRTC/RTSP-over-WebSocket 3버튼 세그먼트 컨트롤로 교체해야 한다(SHALL).

### FR-RTSPWS-041 — YouTube 폼의 RTSP-over-WebSocket 제외

YouTube Add/Edit 폼은 동일한 3-way 컨트롤 대신, RTSP-over-WebSocket 옵션이 제외된 JPEG/WebRTC 2-way 컨트롤을 유지해야 한다(SHALL).

### FR-RTSPWS-042 — `<rtsp-over-websocket>` 렌더링

`streamingMode === 'rtsp-over-websocket'`인 카메라를 표시할 때 `CameraGrid.tsx`/`CameraView.tsx`는 기존 `<img>`(JPEG) 또는 WebRTC `<video>` 대신 `<rtsp-over-websocket>` 컴포넌트를 렌더링해야 한다(SHALL), `proxy`/`hostname`을 LTS 서버 주소로, `username`/`password`를 해당 카메라의 저장 자격증명으로 설정한다.

### FR-RTSPWS-043 — Detection Bounding Box 오버레이 (2026-07-30 추가)

`streamingMode === 'rtsp-over-websocket'`인 카메라도 JPEG/WebRTC 모드와 동일하게 `<rtsp-over-websocket>` 위에 detection bounding box/라벨 오버레이를 표시해야 한다(SHALL) — `CameraView.tsx`는 RTSP-over-WebSocket 분기에도 다른 재생 모드와 동일한 `<canvas>` 엘리먼트를 렌더링하고, 동일한 `drawOverlay()`/`frameWidth`/`frameHeight` 스케일링 로직을 재사용한다. capture image가 analysis 파이프라인에 정상 입력되고 있다면(재생 모드와 무관하게 항상 동일 경로), 오버레이도 항상 함께 표시되어야 한다. 상세: `Design_RTSP_Over_WebSocket.md` §8.20.

---

## 8. 비기능 요구사항

| ID | Requirement |
|---|---|
| NFR-RTSPWS-01 | WS 브릿지의 WS↔TCP 릴레이(§FR-RTSPWS-025)는 트랜스코딩을 수행하지 않으며, CPU 오버헤드가 무시 가능한 수준(순수 바이트 복사)이어야 한다 |
| NFR-RTSPWS-02 | ingest-daemon의 fan-out(§4)은 뷰어가 없는 유휴 상태에서 리소스를 점유해서는 안 된다(on-demand) |
| NFR-RTSPWS-03 | 이 기능은 `SERVER_MODE`가 `combined` 또는 `streaming`일 때만 적용되며, `analysis` 모드(카메라 없음)는 영향을 받지 않는다 |
| NFR-RTSPWS-04 | 카메라 자격증명(username/password)은 로그에 출력되어서는 안 된다(SHALL NOT) — 기존 RTSP URL 자격증명 로깅 금지 규칙과 동일 |
| NFR-RTSPWS-05 | 임의 개수의 RTSP-over-WebSocket 브라우저 세션이 동일 카메라를 동시 시청해도 해당 카메라의 ingest-daemon RTSP 세션 수는 항상 1이어야 한다 |

---

## 9. 인터페이스 요구사항

### 9.1 REST — 카메라 저장/조회 (기존 확장, 구현 완료)

```
POST /api/cameras, PUT /api/cameras/:id
  Body 추가 필드: streamingMode?: 'jpeg' | 'webrtc' | 'rtsp-over-websocket'

GET /api/cameras, GET /api/cameras/:id, POST/PUT 응답
  추가 필드: streamingMode: 'jpeg' | 'webrtc' | 'rtsp-over-websocket' (파생값, 저장되지 않음)
```

### 9.2 WebSocket — `/StreamingServer` (신규, 미구현)

```
연결: ws(s)://<SERVER_IP>/StreamingServer
요청 URL 경로에 <channelSlot> 포함 (예: /0/media.smp, /1/media.smp)
인증: RTSP Digest(MD5), 카메라 저장 username/password
성공 후: WS binary frame ↔ TCP byte 순수 릴레이 (RTSP-over-TCP-interleaved, RFC 7826 §10.12)
```

### 9.3 내부 — ingest-daemon Fan-out 제어 (기존 API 재사용, 연동 미구현)

```
POST /cameras/:id/video-fanout   (ingest-daemon API, 기존)
  RTSP-over-WebSocket WS 브릿지가 채널의 첫 연결/마지막 연결 종료 시 호출해 fan-out 시작/종료
```

---

## 10. 제약 사항 및 가정

- `/StreamingServer` 프로토콜은 Hanwha SUNAPI가 이미 정의한 규격이며, 이 기능은 이를 로컬에서 재현할 뿐 새로 설계하지 않는다(Design 문서 §2).
- 카메라에 RTSP 자격증명(username/password)이 없는 경우 RTSP-over-WebSocket 재생은 인증에 실패한다(§FR-RTSPWS-023) — 별도 익명 접근 경로를 제공하지 않는다.
- 서브모듈 `melchi45/rtsp-over-websocket`의 중첩 서브모듈(`app/media`, `app/external-lib`) 관리는 이 저장소 범위 밖이며, 운영 절차는 `docs/ops/RTSP_Over_WebSocket_Streaming_Setup.md`를 따른다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-22 | 초기 작성 |
| 1.1 | 2026-07-30 | FR-RTSPWS-043 추가 — RTSP-over-WebSocket 모드 detection bounding box 오버레이 요구사항 (버그 수정 반영) |
| 1.2 | 2026-08-04 | 클라이언트 라이브러리를 `melchi45/rtsp-over-websocket` 서브모듈에서 `@melchi45/rtsp-over-websocket` npm 패키지로 전환 — Design_RTSP_Over_WebSocket.md §8.21 참고. 기능 요구사항 자체는 변경 없음(패키지가 기존 속성/이벤트 계약과 호환) |
| 1.3 | 2026-08-10 | 문서 ID `SRS-LTS-UMP-WS-01` → `SRS-LTS-RTSPWS-01`, 요구사항 추적 ID `FR-UMP-NNN`/`NFR-UMP-NN` → `FR-RTSPWS-NNN`/`NFR-RTSPWS-NN`으로 전면 리네임(TC_RTSP_Over_WebSocket.md와 동시 갱신, 요구사항 내용 변경 없음); 잔존 레거시 명칭 일괄 정리 — `Ump*` 식별자·`submodules/rtsp-over-websocket` 경로를 `@melchi45/rtsp-over-websocket` npm 패키지의 현행 명칭(`RTSPOverWebSocket*`, 별도 저장소 `melchi45/rtsp-over-websocket`)으로 전면 교체 |
