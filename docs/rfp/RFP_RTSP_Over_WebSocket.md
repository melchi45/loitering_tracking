# REQUEST FOR PROPOSAL (RFP)
# RTSP-over-WebSocket 스트리밍 경로

| | |
|---|---|
| **RFP Reference** | LTS-2026-RTSPWS-01 |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-07-22 |
| **Status** | **Active — 구현 진행 중** |
| **Related MRD** | [MRD_RTSP_Over_WebSocket.md](../mrd/MRD_RTSP_Over_WebSocket.md) |
| **Related Design** | [Design_RTSP_Over_WebSocket.md](../design/Design_RTSP_Over_WebSocket.md) |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [배경](#1-배경)
2. [작업 범위](#2-작업-범위)
3. [기능 요구사항](#3-기능-요구사항)
4. [비기능 요구사항](#4-비기능-요구사항)
5. [API / 엔드포인트 계약](#5-api--엔드포인트-계약)
6. [UI 배치](#6-ui-배치)
7. [일정 및 마일스톤](#7-일정-및-마일스톤)
8. [인수 기준](#8-인수-기준)

---

## 1. 배경

LTS-2026의 카메라 재생 경로는 JPEG Capture 스트리밍(`pipelineManager.js` → Socket.IO `frame`)과 WebRTC(mediasoup SFU 또는 MediaMTX WHEP) 두 가지입니다. 이번 RFP는 Hanwha `<rtsp-over-websocket>` 웹 컴포넌트(신규 서브모듈 `melchi45/rtsp-over-websocket`)를 이용한 **세 번째 경로 — RTSP-over-WebSocket**을 정의합니다.

RTSP-over-WebSocket의 실제 와이어 프로토콜을 분석한 결과(Design 문서 §2), `/StreamingServer`는 Hanwha 카메라 펌웨어가 자체 제공하는 SUNAPI 기능이며, 표준 RFC 7826 RTSP-over-TCP-interleaved 프레이밍을 WebSocket 바이너리 메시지에 그대로 실은 것에 불과합니다(§2.4). 즉 서버 측에서 RTSP를 해석할 필요 없이, WS 연결과 내부 RTSP TCP 연결 사이를 순수 바이트로 릴레이하면 됩니다.

이 저장소의 최우선 아키텍처 원칙("ingest-daemon이 카메라별 단일 RTSP 세션만 유지")과 충돌하지 않도록, 카메라에는 신규 세션을 추가하지 않고 ingest-daemon이 이미 열어둔 세션의 6번째 fan-out으로 로컬 MediaMTX에 채널별 재발행(publish)하는 구조로 확정되었습니다(Design 문서 §3, §4.1 — YouTube 카메라가 이미 사용 중인 로컬 publish 패턴과 동일).

---

## 2. 작업 범위

1. 카메라 스키마에 `rtspOverWebSocketEnabled`(boolean) 필드 추가 — 기존 `webrtcEnabled`는 변경 없이 유지.
2. API 계층(`server/src/api/cameras.js`)에 UI 편의 필드 `streamingMode: 'jpeg'|'webrtc'|'rtsp-over-websocket'` 추가 — 저장 시 `{webrtcEnabled, rtspOverWebSocketEnabled}`로 파생, 조회 시 역산. **(구현 완료 — `streamingModeToFlags()`/`deriveStreamingMode()`)**
3. 카메라 Add/Edit UI의 기존 "WebRTC On/Off" 토글을 "JPEG(Default) / WebRTC / RTSP-over-WebSocket" 3-way 세그먼트 컨트롤로 교체 (RTSP·YouTube 폼 공통, YouTube는 RTSP-over-WebSocket 옵션 제외).
4. ingest-daemon(PyAV)에 6번째 fan-out 추가 — 채널별로 `rtsp://127.0.0.1:8554/<channelSlot>/media.smp`에 로컬 MediaMTX publish. 기존 `POST /cameras/:id/video-fanout` API를 on-demand 시작/종료에 재사용.
5. LTS Node 서버에 신규 `/StreamingServer` WebSocket 엔드포인트 추가 — RTSP Digest(MD5) 인증 후 WS↔TCP 순수 바이트 릴레이.
6. 클라이언트 재생 컴포넌트(`CameraGrid.tsx`/`CameraView.tsx`)에 `streamingMode==='rtsp-over-websocket'`일 때 `<rtsp-over-websocket>` 렌더링 통합.
7. 문서 동기화 — `CLAUDE.md` API/이벤트 표, `Design_Server_Architecture.md`, `ingest_daemon.py` 상단 docstring, `.env.example` 3종 (Design 문서 §8-5).

> 구현 진행 상황: 1·2번은 완료됨. 3~6번은 이 RFP 발행 시점 기준 진행 중/미착수이며, 다른 세션이 병행 작업 중입니다.

---

## 3. 기능 요구사항

### 3.1 카메라 세션 — 신규 세션 금지

RTSP-over-WebSocket 재생 경로 추가는 카메라에 대한 ingest-daemon의 RTSP 세션 수를 늘리지 않는다. 몇 개의 브라우저가 동시에 같은 카메라를 RTSP-over-WebSocket로 시청하더라도 카메라 쪽 세션은 항상 1개다(Design 문서 §3).

### 3.2 로컬 RTSP Proxy — MediaMTX 재사용

ingest-daemon이 PyAV `io` 스레드에서 이미 열려있는 packet 스트림을 6번째 출력으로 `rtsp://127.0.0.1:8554/<channelSlot>` 로 muxing해 로컬 MediaMTX에 publish(RECORD)한다. FFmpeg subprocess가 아니라 PyAV(libav in-process)를 사용하므로 "FFmpeg subprocess 금지" 원칙과 충돌하지 않는다. `mediamtx.yml`의 기존 `rtspAddress: 127.0.0.1:8554`(loopback 전용) + `authInternalUsers: any` 신뢰 모델은 그대로 유지한다(Design 문서 §4.1).

### 3.3 `/StreamingServer` WS↔TCP 브릿지

LTS Node 서버에 신규 WebSocket 업그레이드 경로를 추가한다(기존 Socket.IO와는 별개 — `rtsp-over-websocket`는 순수 `WebSocket` 클라이언트). 동작 순서(Design 문서 §4.2):

1. WS 연결 수락.
2. 첫 RTSP 요청(`OPTIONS`/`DESCRIBE`) 라인의 URL에서 `<channelSlot>` 파싱 → `channelSlot`→`cameraId` 매핑 조회(기존 `channelSlotService` 재사용) — 매핑이 없으면 WS 종료.
3. 해당 채널 카메라의 저장된 `username`/`password`로 RTSP Digest(MD5) challenge-response 인증. 인증 성공 전까지 다음 단계로 진행하지 않는다.
4. 인증 성공 후 `rtsp://127.0.0.1:8554/<channelSlot>/media.smp`로 내부 TCP 소켓 연결.
5. 이후 WS↔TCP 순수 바이트 양방향 릴레이(RTSP 파싱 불필요).

### 3.4 채널 매핑

기존 `channelSlot`(1..`MAX_CHANNEL_NUM`, 카메라 CRUD 시 이미 배정) 값을 그대로 RTSP 경로 숫자로 재사용한다. 별도 매핑 테이블을 신설하지 않는다(Design 문서 §4.3).

### 3.5 On-Demand Fan-out

ingest-daemon의 6번째 fan-out(§3.2)은 WS 브릿지의 해당 채널 첫 연결 시 시작하고, 마지막 연결 종료 시 제거한다. WS↔TCP 릴레이(§3.3) 자체는 상시 대기 상태여도 순수 바이트 복사라 비용이 사실상 0이다(Design 문서 §5 항목 3).

### 3.6 카메라 호환성 게이팅 없음

`supportSunapi`와 무관하게 모든 RTSP 카메라에 RTSP-over-WebSocket 옵션이 노출된다 — 로컬 프록시가 재서빙하므로 원본 카메라의 SUNAPI 지원 여부는 게이팅 조건이 아니다. YouTube 카메라는 RTSP-over-WebSocket 대상에서 제외한다(Design 문서 §5 항목 4).

### 3.7 카메라 Add/Edit UI — 3-way 재생 모드 선택

기존 WebRTC On/Off 토글을 JPEG(Default) / WebRTC / RTSP-over-WebSocket 3버튼 세그먼트 컨트롤로 교체한다. RTSP 폼과 YouTube 폼 양쪽에 동일 적용하되 YouTube 폼에는 RTSP-over-WebSocket 옵션을 표시하지 않는다(Design 문서 §7.2).

---

## 4. 비기능 요구사항

| Category | Requirement |
|---|---|
| 아키텍처 정합성 | ingest-daemon 우선 원칙(CLAUDE.md)을 위반하지 않음 — 카메라에 신규 세션 없음, FFmpeg subprocess 없음 |
| 성능/부하 | WS↔TCP 릴레이는 트랜스코딩 없는 순수 바이트 복사로 CPU 비용이 사실상 0; ingest-daemon fan-out은 on-demand로 유휴 상태에서 리소스를 점유하지 않음 |
| 보안 | 별도 인증 체계(JWT 등) 신설 없이 카메라별 저장 RTSP 자격증명 재사용; 인증 성공 전 내부 MediaMTX 연결로 진행하지 않음 |
| 호환성 | `SERVER_MODE=combined`/`streaming`(카메라 캡처 보유 모드)에 적용; `analysis` 모드는 카메라가 없어 해당 없음 |
| 하위 호환성 | 기존 `webrtcEnabled` 필드의 내부 동작(파이프라인 재시작 판단 등)을 건드리지 않음 — `rtspOverWebSocketEnabled`는 완전히 신규 필드 |

---

## 5. API / 엔드포인트 계약

### PUT/POST 카메라 (기존 확장, 구현 완료)

`server/src/api/cameras.js`가 `streamingMode: 'jpeg'|'webrtc'|'rtsp-over-websocket'` UI 편의 필드를 받아 저장 시 다음으로 파생한다:

```
streamingMode === 'webrtc' → webrtcEnabled: true
streamingMode === 'jpeg'   → webrtcEnabled: false
streamingMode === 'rtsp-over-websocket'    → webrtcEnabled: false, rtspOverWebSocketEnabled: true
```

`GET`/응답 시 저장된 `webrtcEnabled`/`rtspOverWebSocketEnabled`로부터 `streamingMode`를 역산해 클라이언트에 내려준다.

### `ws(s)://<SERVER_IP>/StreamingServer` (신규, 미구현)

```
Hanwha SUNAPI 프로토콜과 동일 — <rtsp-over-websocket proxy="SERVER_IP" hostname="SERVER_IP" port="..."
  username="<camera username>" password="<camera password>"> 가 연결하는 단일 WS 엔드포인트.
채널 구분은 최초 RTSP 요청 라인의 URL 경로 숫자(<channelSlot>)로 한다.

인증: RTSP Digest(MD5) challenge-response — 카메라별 저장 자격증명 재사용.
와이어 프로토콜: RFC 7826 §10.12 TCP interleaved 프레이밍을 그대로 WS 바이너리 프레임에 실음
  (텍스트 RTSP 요청/응답 + `$` 매직넘버 기반 RTP/RTCP interleaved 프레임 혼재).
인증 성공 후: WS ↔ rtsp://127.0.0.1:8554/<channelSlot>/media.smp 순수 바이트 릴레이.
```

### `POST /cameras/:id/video-fanout` (기존 API 재사용, on-demand 트리거 연동 미구현)

기존 동적 fan-out 추가 API를 WS 브릿지의 채널 첫 연결/마지막 연결 종료 시 호출해 ingest-daemon의 6번째 fan-out을 시작/종료한다.

---

## 6. UI 배치

- Add Camera 모달(RTSP 탭) — 기존 WebRTC 토글 위치를 JPEG(Default)/WebRTC/RTSP-over-WebSocket 3버튼 세그먼트 컨트롤로 교체
- Add Camera 모달(YouTube 탭) — 동일 컨트롤이되 RTSP-over-WebSocket 옵션 미표시(JPEG/WebRTC 2-way 유지)
- Edit Camera 모달(`CameraEditModal.tsx`) — 동일 3-way 컨트롤, 카메라의 현재 `streamingMode`로 사전 선택
- 카메라 그리드(`CameraGrid.tsx`) / 단일 뷰(`CameraView.tsx`) — `streamingMode==='rtsp-over-websocket'`일 때 `<rtsp-over-websocket>` 렌더링(미구현)

---

## 7. 일정 및 마일스톤

Design 문서 §8의 구현 순서를 따른다:

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 스키마 + 클라이언트 UI (`streamingMode` 필드, 3-way 토글) | API 계층 완료, 클라이언트 UI 진행 중 |
| 2 | ingest-daemon 6번째 fan-out (PyAV publish, on-demand 연동) | 미착수 |
| 3 | `/StreamingServer` WS 브릿지 (RTSP Digest 인증, 채널 라우팅, WS↔TCP 릴레이) | 미착수 |
| 4 | 클라이언트 재생 컴포넌트 통합 (`<rtsp-over-websocket>` 렌더링) | 미착수 |
| 5 | 문서 동기화 (`CLAUDE.md`, `Design_Server_Architecture.md`, `.env.example` 3종) | 이 RFP를 포함한 SDLC 문서군으로 진행 |

---

## 8. 인수 기준

- 카메라 Add/Edit 화면에서 JPEG/WebRTC/RTSP-over-WebSocket 3-way 선택이 가능하고, 저장/조회 시 `webrtcEnabled`/`rtspOverWebSocketEnabled` 파생·역산이 정확히 동작한다 (완료 — API 레벨).
- RTSP-over-WebSocket로 임의 개수의 브라우저가 동시 시청해도 대상 카메라의 ingest-daemon RTSP 세션 수가 1개로 유지된다.
- RTSP-over-WebSocket 뷰어가 모두 종료되면 해당 채널의 ingest-daemon fan-out 및 MediaMTX publish가 자동 정리된다.
- `/StreamingServer`에 카메라 자격증명으로 접속 시 RTSP Digest 인증이 성공하고, 실패 시(잘못된 자격증명) 인증 단계에서 거부되어 내부 MediaMTX로 연결이 진행되지 않는다.
- `<rtsp-over-websocket>`가 `streamingMode==='rtsp-over-websocket'`인 카메라에서 정상적으로 영상을 재생한다.
- YouTube 카메라의 Add/Edit 화면에는 RTSP-over-WebSocket 옵션이 노출되지 않는다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-22 | 초기 작성 |
| 1.1 | 2026-08-04 | 클라이언트 라이브러리를 `melchi45/rtsp-over-websocket` 서브모듈에서 `@melchi45/rtsp-over-websocket` npm 패키지로 전환 — Design_RTSP_Over_WebSocket.md §8.21 참고 |
| 1.2 | 2026-08-10 | 문서 ID `LTS-2026-UMP-WS-01` → `LTS-2026-RTSPWS-01`로 통일(연관 SRS/TC의 `FR-UMP-*`/`TC-UMP-*` 추적 ID가 `FR-RTSPWS-*`/`TC-RTSPWS-*`로 리네임된 것과 일관성 맞춤); 잔존 레거시 명칭 일괄 정리 — `Ump*` 식별자·`submodules/rtsp-over-websocket` 경로를 `@melchi45/rtsp-over-websocket` npm 패키지의 현행 명칭(`RTSPOverWebSocket*`, 별도 저장소 `melchi45/rtsp-over-websocket`)으로 전면 교체 |
