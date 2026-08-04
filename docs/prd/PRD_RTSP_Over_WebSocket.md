# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# RTSP-over-WebSocket 스트리밍 경로

| | |
|---|---|
| **Document ID** | PRD-LTS-UMP-WS-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-07-22 |
| **Related RFP** | [RFP_RTSP_Over_WebSocket.md](../rfp/RFP_RTSP_Over_WebSocket.md) |
| **Related Design** | [Design_RTSP_Over_WebSocket.md](../design/Design_RTSP_Over_WebSocket.md) |

---

## Table of Contents

1. [제품 비전](#1-제품-비전)
2. [목표 및 비목표](#2-목표-및-비목표)
3. [사용자 스토리](#3-사용자-스토리)
4. [기술 접근 방식](#4-기술-접근-방식)
5. [기능 명세](#5-기능-명세)
6. [API / 인터페이스 계약](#6-api--인터페이스-계약)
7. [Edge Case](#7-edge-case)
8. [마일스톤](#8-마일스톤)

---

## 1. 제품 비전

카메라 재생 경로에 RTSP-over-WebSocket(Hanwha `<ump-player>` 웹 컴포넌트) 기반 RTSP-over-WebSocket을 추가해, JPEG(기본)/WebRTC와 나란히 세 번째 선택지로 제공한다. 핵심은 **카메라 세션을 추가하지 않는 것**이다 — ingest-daemon의 기존 단일 RTSP 세션 뒤에 로컬 RTSP Proxy(MediaMTX 재사용)와 단일 WS 브릿지를 추가해, 몇 명이 RTSP-over-WebSocket로 보든 카메라는 영향받지 않는다.

---

## 2. 목표 및 비목표

### 2.1 목표

- Hanwha `<ump-player>`가 기대하는 `/StreamingServer` WebSocket 프로토콜을 LTS Node 서버에서 재현한다.
- ingest-daemon 우선 원칙(카메라별 단일 RTSP 세션)을 위반하지 않는다.
- 카메라별 저장된 RTSP 자격증명을 그대로 재사용해 별도 인증 체계 없이 RTSP-over-WebSocket 재생을 인증한다.
- 뷰어가 실제로 RTSP-over-WebSocket로 볼 때만 리소스를 소비하는 on-demand 모델을 구현한다.
- 카메라 Add/Edit UI의 재생 모드 선택을 JPEG/WebRTC/RTSP-over-WebSocket 3-way로 확장한다.

### 2.2 비목표

- `/StreamingServer` 프로토콜 자체의 재정의 — 표준 RTSP-over-TCP-interleaved 프레이밍을 WS로 감싼 기존 규격을 그대로 릴레이한다(Design 문서 §2.4).
- 신규 인증 체계(JWT 등) 도입 — 카메라별 저장 자격증명 재사용으로 확정됨(Design 문서 §5 항목 2).
- YouTube/RTMP/HLS 소스에 대한 RTSP-over-WebSocket 지원.
- `submodules/ump-player`의 `.gitmodules`(HTTPS URL) 자체 수정 — 별도 리포 관리 사항.

---

## 3. 사용자 스토리

| ID | Story |
|---|---|
| US-01 | 운영자로서, 카메라 Edit 화면에서 재생 모드를 "RTSP-over-WebSocket"로 바꿔 Hanwha 네이티브 뷰어와 동일한 방식으로 스트림을 보고 싶다 |
| US-02 | 시스템 관리자로서, 여러 브라우저 탭에서 동시에 RTSP-over-WebSocket로 같은 카메라를 봐도 카메라 쪽 RTSP 세션이 늘어나지 않기를 원한다 |
| US-03 | 시스템 관리자로서, 아무도 RTSP-over-WebSocket로 보지 않는 카메라는 추가 리소스를 소비하지 않기를 원한다(on-demand) |
| US-04 | 운영자로서, RTSP-over-WebSocket 재생 시 카메라 자격증명을 별도로 다시 입력하지 않고 이미 등록된 카메라 정보로 자동 인증되기를 원한다 |
| US-05 | 시스템 관리자로서, ONVIF 전용(비-Hanwha) 카메라에서도 RTSP-over-WebSocket 옵션을 시도해볼 수 있기를 원한다(로컬 프록시가 재서빙하므로 원본 카메라 제약과 무관) |
| US-06 | 시스템 관리자로서, YouTube 카메라 Add/Edit 화면에는 RTSP-over-WebSocket 옵션이 나타나지 않아 혼선이 없기를 원한다 |

---

## 4. 기술 접근 방식

### 4.1 RTSP Proxy — MediaMTX 재사용 (신규 컴포넌트 아님)

`pipelineManager.js`가 이미 YouTube 카메라에 대해 yt-dlp/ffmpeg → `rtsp://127.0.0.1:8554/yt/<id>` publish → ingest-daemon이 로컬 경로를 읽는 패턴을 사용 중이다(Design 문서 §4.1). RTSP-over-WebSocket도 동일 패턴을 재사용한다 — 신규 RTSP 서버를 구현하지 않고 기존 MediaMTX 인스턴스에 채널별 경로(`/<channelSlot>`)로 publish한다.

**대안 검토**: 신규 경량 RTSP 서버 구현도 검토되었으나, YouTube 경로가 이미 MediaMTX + PyAV publish 조합으로 프로덕션 검증되어 있어 재사용이 리스크·개발 비용 모두 낮다는 결론으로 MediaMTX 재사용이 확정되었다(Design 문서 §5 항목 1).

### 4.2 인증 — RTSP Digest, 신규 인증 체계 없음

`app/media/ump/Network/RTSPoverWebsocket/rtspClient.js`의 `DigestGenerator`가 클라이언트 쪽에서 이미 표준 RTSP Digest challenge-response를 구현하고 있으므로, 서버(WS 브릿지)가 그 반대편(401 challenge 발급 → HA1=MD5(user:realm:pass) 검증)을 구현하면 `<ump-player username="..." password="...">`에 카메라 자격증명을 그대로 넣는 것만으로 동작한다(Design 문서 §4.2-3).

**대안 검토**: 별도 JWT 발급 체계도 검토되었으나, `<ump-player>`가 표준 HTML 속성(`username`/`password`)만 받는 컴포넌트라 JWT를 그 자리에 넣는 것은 부자연스럽고, RTSP Digest는 카메라 자체가 이미 쓰는 인증 방식이라 운영자 학습 비용이 없다는 이유로 카메라별 저장 자격증명 재사용이 확정되었다.

### 4.3 On-demand Fan-out — 기존 API 재사용

ingest-daemon의 6번째 fan-out(PyAV MediaMTX publish)은 기존 `POST /cameras/:id/video-fanout`(동적 fan-out 추가 API)을 재사용해 WS 브릿지의 해당 채널 첫 연결 시 추가, 마지막 연결 종료 시 제거한다(Design 문서 §5 항목 3). 신규 API를 만들지 않는다.

### 4.4 스키마 — API 계층 파생 방식 (리스크 최소화)

`camera.webrtcEnabled`가 `pipelineManager.js`의 파이프라인 재시작 판단·`addCameraStream()` 호출 등 여러 곳에서 이미 깊게 쓰이고 있어(과거 "CameraEditModal이 항상 webrtcEnabled를 보내 변경 감지가 오작동" 버그 이력 포함), 이 필드의 내부 동작을 건드리는 것은 리스크가 크다고 판단했다. 따라서:

- `streamingMode`는 **API 계층에서만** 존재하는 UI 소스-오브-트루스로 두고, 저장 시 서버가 `{webrtcEnabled, umpEnabled}`로 파생한다.
- `umpEnabled`는 완전히 신규 필드라 기존 `webrtcEnabled` 코드 경로에 영향을 주지 않는다.
- 응답(GET) 시 저장된 두 boolean으로부터 `streamingMode`를 역산한다 — 별도 마이그레이션 스크립트가 불필요하다.

**구현 상태**: 이 파생/역산 로직(`streamingModeToFlags()`/`deriveStreamingMode()`)은 `server/src/api/cameras.js`에 구현 완료됨(Design 문서 §7.2).

---

## 5. 기능 명세

### 5.1 카메라 세션 정책

몇 개의 브라우저가 RTSP-over-WebSocket로 동일 카메라를 봐도 ingest-daemon의 카메라 세션 수는 항상 1개다. RTSP Proxy(MediaMTX)와 WS 브릿지는 모두 로컬(loopback) 컴포넌트이므로 부하가 늘어도 카메라 안정성에는 영향이 없다(Design 문서 §3).

### 5.2 채널 라우팅

WS 엔드포인트는 `ws(wss)://SERVER_IP/StreamingServer` 하나이며, 채널 구분은 요청 URL 안의 숫자 경로(`/0/`, `/1/`, ...)로 한다. 이 숫자는 기존 `channelSlot` 개념(`channelSlotService.js`, `ChannelSlotPicker.tsx`, `MAX_CHANNEL_NUM`)을 그대로 재사용한다(Design 문서 §3).

### 5.3 와이어 프로토콜

RFC 7826 §10.12 TCP interleaved 프레이밍을 그대로 WebSocket 바이너리 메시지에 실은 것이다 — RTSP 요청/응답은 `RTSP/1.0 ...` 텍스트 + `Content-Length` 헤더 기반 바디, RTP/RTCP는 `$`(매직넘버) + 1바이트 채널 번호 + 2바이트 빅엔디안 길이 + payload. 서버는 RTSP를 해석할 필요 없이 최초 요청 라인만 파싱해 채널을 식별한 뒤 순수 바이트 릴레이를 수행한다(Design 문서 §2.4).

### 5.4 UI 3-way 토글

기존 단일 WebRTC On/Off 스위치를 JPEG(Default)/WebRTC/RTSP-over-WebSocket 3버튼 세그먼트 컨트롤로 교체한다. RTSP/YouTube 양쪽 폼에 적용하되 YouTube는 RTSP-over-WebSocket 옵션을 제외한다(Design 문서 §7.2).

---

## 6. API / 인터페이스 계약

### 카메라 저장 (구현 완료)

```
POST/PUT body { streamingMode: 'jpeg' | 'webrtc' | 'ump' }
  → 저장: streamingMode==='webrtc' → { webrtcEnabled: true }
          streamingMode==='jpeg'   → { webrtcEnabled: false }
          streamingMode==='ump'    → { webrtcEnabled: false, umpEnabled: true }

GET 응답 { ...camera, streamingMode: deriveStreamingMode(camera) }
  deriveStreamingMode(): camera.umpEnabled ? 'ump' : camera.webrtcEnabled ? 'webrtc' : 'jpeg'
```

### `/StreamingServer` WS 엔드포인트 (미구현 — Design 문서 §4.2 계약)

```
연결: ws(s)://SERVER_IP/StreamingServer
1. 첫 RTSP 요청 라인에서 <channelSlot> 파싱 → channelSlot→cameraId 매핑 조회
2. RTSP Digest(MD5) 인증 — 매핑된 카메라의 저장 username/password 사용
3. 인증 성공 시 rtsp://127.0.0.1:8554/<channelSlot>/media.smp TCP 연결
4. 이후 WS↔TCP 순수 바이트 릴레이
```

---

## 7. Edge Case

| 시나리오 | 동작 |
|---|---|
| RTSP-over-WebSocket로 시청 중인 브라우저가 0개가 됨 | ingest-daemon 6번째 fan-out 및 MediaMTX publish가 해제된다(on-demand 해제) |
| WS 연결의 첫 요청 라인 URL에 존재하지 않는 channelSlot이 포함됨 | WS 연결을 즉시 종료한다 |
| 카메라에 저장된 username/password가 없음 | RTSP Digest 인증이 실패해 WS 연결이 거부된다(별도 익명 접근 허용 없음) |
| YouTube 카메라의 streamingMode를 'ump'로 전송 | 서버가 거부하거나(백엔드 검증 필요) UI 자체가 옵션을 노출하지 않아 발생하지 않음 — 클라이언트 재생 컴포넌트 통합 단계에서 백엔드 방어 로직 필요 여부 확정 |
| `supportSunapi=false`인 ONVIF 전용 카메라에서 RTSP-over-WebSocket 선택 | 정상 노출·동작 대상 — 로컬 프록시가 재서빙하므로 원본 카메라의 SUNAPI 지원 여부는 게이팅 조건이 아님 |

---

## 8. 마일스톤

RFP 문서 §7과 동일 — 스키마/API(완료) → 클라이언트 UI(진행 중) → ingest-daemon fan-out → WS 브릿지 → 클라이언트 재생 통합 → 문서 동기화.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-22 | 초기 작성 |
| 1.1 | 2026-08-04 | 클라이언트 라이브러리를 `submodules/ump-player` 서브모듈에서 `@melchi45/rtsp-over-websocket` npm 패키지로 전환 — Design_RTSP_Over_WebSocket.md §8.21 참고 |
