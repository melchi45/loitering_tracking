# TEST CASES (TC)
# WebRTC Media Gateway

| | |
|---|---|
| **Document ID** | TC-LTS-WRTC-01 |
| **Version** | 2.0 |
| **Status** | Active |
| **Date** | 2026-05-27 (rev 2026-07-23) |
| **Parent SRS** | srs/SRS_WebRTC_Media_Gateway.md |
| **Sibling TC** | [tc/TC_WebRTC_Engine_Modes.md](TC_WebRTC_Engine_Modes.md) (엔진 내부 동작) |
| **Test Scripts** | test/api/webrtc.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Signaling (WHEP)](#3-test-group-a--signaling-whep)
4. [Test Group B — Video Delivery](#4-test-group-b--video-delivery)
5. [Test Group C — Audio Delivery](#5-test-group-c--audio-delivery)
6. [Test Group D — Application RTP](#6-test-group-d--application-rtp)
7. [Test Group E — AI Event Delivery](#7-test-group-e--ai-event-delivery)
8. [Test Group F — Diagnostics / REST](#8-test-group-f--diagnostics--rest)
9. [Test Group G — Stability](#9-test-group-g--stability)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)
12. [Appendix — Retired Test Cases (pre-2026-07-23)](#12-appendix--retired-test-cases-pre-2026-07-23)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | `/api/webrtc/ice-config`, `/api/webrtc/ice-test`, `/api/capabilities`, `/health`, `/api/crosscamera/stats`, `/api/persons/active` | Node.js `fetch` | `test/api/webrtc.test.js` (Group F) |
| Integration (수동) | WHEP negotiation, 카메라별 webrtcEnabled 분기, 오디오 패스스루/트랜스코드, App RTP 이중 전달, AI 이벤트 Socket.IO 전달 | 실제 카메라 + 브라우저 필요 | 미자동화 — §3~§7, §9 수동 절차 |

> 이 TC 세트가 검증하는 것은 **게이트웨이 계약**(WHEP 시그널링, 카메라별 전달 경로 분기, Socket.IO/DataChannel 하이브리드 모델)이다. mediamtx/mediasoup 엔진 내부 동작(Worker Pool, alt-PT 캐시, H.264 PT 협상 등)은 [TC_WebRTC_Engine_Modes.md](TC_WebRTC_Engine_Modes.md)에서 다루며 여기서 중복하지 않는다.

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-WRTC-001~005 | TC-A-001 ~ TC-A-004 (수동) |
| FR-WRTC-010~013 | TC-B-001 ~ TC-B-003 (수동) |
| FR-WRTC-020~024 | TC-C-001 ~ TC-C-004 (수동) |
| FR-WRTC-030~036 | TC-D-001 ~ TC-D-004 (수동) |
| FR-WRTC-040~042 | TC-E-001 ~ TC-E-002 (수동) |
| FR-WRTC-050 | TC-F-005 |
| FR-WRTC-051 | TC-F-006 |
| FR-WRTC-052 | TC-F-007 (수동) |
| FR-WRTC-053 | TC-F-001 ~ TC-F-002 |
| FR-WRTC-060 | TC-G-001 (수동) |
| FR-WRTC-061 | TC-G-002 (수동) |

---

## 2. Test Environment and Prerequisites

- 서버가 `http://localhost:3080`(또는 `LTS_URL`)에서 기동 중
- `GET /health` → `status: 'ok'`
- Group A~E는 최소 1대의 실제(또는 시뮬레이션된) RTSP 카메라가 등록되어 있어야 하며, 일부 항목은 `webrtcEnabled: true`/`false` 두 상태 모두를 필요로 한다.
- Group D는 App RTP(ONVIF)를 지원하는 카메라가 필요하다 — 미지원 카메라에서는 해당 케이스를 스킵으로 표기한다.

---

## 3. Test Group A — Signaling (WHEP)

### TC-A-001 — WHEP 단일 엔드포인트로만 협상
- **SRS:** FR-WRTC-001, FR-WRTC-005
- **Input:** `curl -X POST --data-binary @offer.sdp -H 'Content-Type: application/sdp' http://localhost:3080/api/webrtc/whep/<cameraId>`; 별도로 `webrtc:getCapabilities` 등 Socket.IO 이벤트를 emit 시도
- **Expected:** HTTP 요청은 SDP answer를 반환; Socket.IO 쪽 이벤트는 서버에 핸들러가 없어 아무 응답도 오지 않음(무시됨)
- **Acceptance:** WHEP 응답만으로 연결이 성립, Socket.IO 시그널링 이벤트에 대한 응답이 존재하지 않음

### TC-A-002 — 빈 SDP body 거부
- **SRS:** FR-WRTC-003
- **Input:** `POST /api/webrtc/whep/:cameraId`를 빈 body로 요청
- **Expected:** HTTP 400
- **Acceptance:** 엔진이 호출되지 않고(엔진 관련 로그 없음) 즉시 400 응답

### TC-A-003 — 엔진 실패 시 503
- **SRS:** FR-WRTC-004
- **Input:** 활성 엔진을 unhealthy 상태로 만든 뒤(예: mediamtx 프로세스 중지) WHEP 요청
- **Expected:** HTTP 503 `{ error }`
- **Acceptance:** 처리되지 않은 예외로 인한 500이 아니라 명시적 503

### TC-A-004 — SDP answer 헤더 전달
- **SRS:** FR-WRTC-002
- **Input:** 정상 WHEP 요청
- **Expected:** 응답에 `Location`/`Link`/`ETag` 중 엔진이 제공하는 헤더가 그대로 전달됨
- **Acceptance:** 엔진 응답 헤더가 클라이언트까지 손실 없이 도달

---

## 4. Test Group B — Video Delivery

### TC-B-001 — webrtcEnabled=true 카메라 영상 전달
- **SRS:** FR-WRTC-010
- **Input:** `webrtcEnabled: true` 카메라로 WHEP 연결
- **Expected:** `<video>`에 H.264 영상이 재인코딩 없이 재생됨
- **Acceptance:** 브라우저 `chrome://webrtc-internals`에서 video `inbound-rtp`에 `framesDecoded > 0`

### TC-B-002 — msid 부재 시 MediaStream 합성
- **SRS:** FR-WRTC-011
- **Input:** SDP answer에 `a=msid`가 없는 엔진(mediasoup 일부 세션)으로 연결
- **Expected:** 클라이언트가 트랙으로부터 `MediaStream`을 합성해 정상 렌더링
- **Acceptance:** `<video>`에 프레임이 표시됨(빈 화면 아님)

### TC-B-003 — webrtcEnabled=false 카메라는 JPEG만 사용
- **SRS:** FR-WRTC-012, FR-WRTC-013
- **Input:** `webrtcEnabled: false` 카메라 시작
- **Expected:** Socket.IO `frame` 이벤트가 주기적으로 수신되고, `POST /api/webrtc/whep/:cameraId` 시도 시 해당 카메라에 대한 활성 미디어가 없음(엔진 쪽에 등록되지 않음)
- **Acceptance:** 두 경로가 동시에 활성화되지 않음(배타적)

---

## 5. Test Group C — Audio Delivery

### TC-C-001 — Opus 카메라 패스스루
- **SRS:** FR-WRTC-021
- **Input:** Opus 오디오 트랙을 가진 카메라 연결
- **Expected:** ingest-daemon 로그에 `Audio RTP passthrough opus` 기록, 브라우저에서 오디오 정상 재생
- **Acceptance:** 트랜스코드 워커 스레드가 기동되지 않음(로그로 확인)

### TC-C-002 — 비-Opus 카메라 트랜스코드
- **SRS:** FR-WRTC-022
- **Input:** G.711 등 비-Opus 오디오 트랙을 가진 카메라 연결
- **Expected:** ingest-daemon 로그에 `Audio RTP transcode ... → opus` 기록, 전용 워커 스레드에서 처리되어 영상/AI 프레임 지연 없음
- **Acceptance:** 브라우저에서 오디오 정상 재생, 동시에 영상 프레임 드랍 없음

### TC-C-003 — 오디오 트랙 없는 카메라
- **SRS:** FR-WRTC-023
- **Input:** 오디오 트랙이 없는 카메라 연결
- **Expected:** 오류 없이 영상만 정상 재생
- **Acceptance:** 서버/클라이언트 로그에 오디오 관련 에러 없음

### TC-C-004 — 음소거 버튼 즉시 처리
- **SRS:** FR-WRTC-024
- **Input:** 재생 중 음소거 버튼 클릭
- **Expected:** 서버 재협상(WHEP 재요청) 없이 즉시 음소거됨
- **Acceptance:** 클릭 전후로 네트워크 탭에 추가 WHEP 요청이 발생하지 않음

---

## 6. Test Group D — Application RTP

### TC-D-001 — App RTP 이중 전달(원본 + 파싱)
- **SRS:** FR-WRTC-030, FR-WRTC-031, FR-WRTC-032
- **Input:** ONVIF 이벤트 발생 카메라에서 이벤트 트리거(모션 등)
- **Expected:** Socket.IO `appRtp`(원본)와 `onvif:event`(파싱된 구조화 이벤트)가 모두 수신됨
- **Acceptance:** 두 이벤트 모두 동일 시점 근처에 도착, `onvif:event`는 `{topic, topicType, severity, ...}` 구조

### TC-D-002 — mediasoup 모드 DataChannel 중복 전달 및 dedup
- **SRS:** FR-WRTC-033, FR-WRTC-035
- **Input:** `WEBRTC_ENGINE=mediasoup`에서 ONVIF 이벤트 트리거
- **Expected:** Socket.IO `appRtp`와 DataChannel 양쪽에서 동일 `seq`의 메시지 수신, UI에는 1회만 반영
- **Acceptance:** 클라이언트 로그/상태에 중복 렌더링 없음(seq dedup 동작 확인)

### TC-D-003 — mediamtx 모드 DataChannel 없음
- **SRS:** FR-WRTC-034
- **Input:** `WEBRTC_ENGINE=mediamtx`에서 ONVIF 이벤트 트리거
- **Expected:** DataChannel이 열리지 않거나 데이터가 오지 않음, Socket.IO `appRtp`만으로 정상 수신
- **Acceptance:** `appRtp` 이벤트만으로 UI가 정상 갱신됨

### TC-D-004 — 인식 불가 payload 안전 처리
- **SRS:** FR-WRTC-036
- **Input:** 알 수 없는 payload type의 App RTP 패킷 주입(테스트 도구 또는 비표준 카메라)
- **Expected:** 서버 로그에 경고, 크래시 없음
- **Acceptance:** `GET /health`가 계속 200 반환

---

## 7. Test Group E — AI Event Delivery

> 개별 AI 기능(감지 정확도, 배회 임계값 등)의 상세 테스트는 `TC_Object_Tracking.md`, `TC_AI_Human_Detection.md` 등에서 다룬다. 이 그룹은 **전달 경로**(항상 Socket.IO, WebRTC 상태 무관)만 검증한다.

### TC-E-001 — webrtcEnabled 무관 이벤트 전달
- **SRS:** FR-WRTC-040
- **Input:** `webrtcEnabled: true`와 `false` 카메라 각각에서 배회 이벤트 발생
- **Expected:** 두 카메라 모두 Socket.IO `loitering`/`alert:new`가 동일하게 수신됨
- **Acceptance:** 전달 여부/지연에 유의미한 차이 없음

### TC-E-002 — 렌더링 방식과 무관한 room 유지
- **SRS:** FR-WRTC-042
- **Input:** `<video>` 렌더링 카메라와 `<img>` 렌더링 카메라를 동시에 구독
- **Expected:** 두 카메라 모두 `camera:subscribe` room에 join되어 이벤트 수신
- **Acceptance:** 렌더링 방식 전환(webrtcEnabled 토글) 후에도 room 재가입 없이 이벤트 계속 수신

---

## 8. Test Group F — Diagnostics / REST

> 이 그룹은 `test/api/webrtc.test.js`로 자동화되어 있다.

### TC-F-001 — Capabilities 응답 구조
- **SRS:** FR-WRTC-053 (AI 모듈 가용성 맵임을 확인 — WebRTC 코덱 정보 아님)
- **Input:** `GET /api/capabilities`
- **Expected:** HTTP 200, `{ ai: {...}, status: {...} }`
- **Acceptance:** `ai`/`status` 필드 존재, `codecs` 등 WebRTC 관련 필드는 필수가 아님(참고: 과거 TC-A-008이 `body.codecs`를 조건부로 체크했었으나 실제 API에는 해당 필드가 없어 사실상 항상 스킵됨 — §12 참조)

### TC-F-002 — AI 모듈 키 존재
- **Input:** `GET /api/capabilities`
- **Expected:** `ai.human`/`ai.vehicle`/`ai.face`/`ai.mask`/`ai.hat`/`ai.fire`가 boolean으로 존재
- **Acceptance:** 6개 키 모두 boolean

### TC-F-003 — status 값 유효성
- **Input:** `GET /api/capabilities`
- **Expected:** `status.*` 값이 `builtin|available|loaded|failed|missing|pending` 중 하나
- **Acceptance:** 모든 값이 허용 목록에 포함

### TC-F-004 — 크로스카메라 통계
- **Input:** `GET /api/crosscamera/stats`
- **Expected:** `{ totalTransitions, uniqueFaces, faces: [] }`
- **Acceptance:** 스키마 일치

### TC-F-005 — ice-test 헬스체크
- **SRS:** FR-WRTC-050
- **Input:** `POST /api/webrtc/ice-test`
- **Expected:** 200(healthy) `{testId, engine, ...}` 또는 503(unhealthy) `{error, engine, hint}`
- **Acceptance:** 응답 스키마가 SRS §8과 일치

### TC-F-006 — ICE 설정 조회
- **SRS:** FR-WRTC-051
- **Input:** `GET /api/webrtc/ice-config`
- **Expected:** `{ stunUrls: [], turns: [] }`, loopback(127.x) 주소가 STUN/TURN URL에 포함되지 않음
- **Acceptance:** 배열 타입 확인 + loopback 부재

### TC-F-007 — monitor 엔드포인트 접근 제어 (수동)
- **SRS:** FR-WRTC-052
- **Input:** `NODE_ENV=production`에서 원격 IP로 `GET /api/webrtc/monitor`
- **Expected:** HTTP 403
- **Acceptance:** localhost/dev 외 요청 차단

---

## 9. Test Group G — Stability

### TC-G-001 — 중복 subscribe 무해화 (수동)
- **SRS:** FR-WRTC-060
- **Input:** 동일 소켓이 동일 카메라에 `camera:subscribe`를 여러 번 emit
- **Expected:** room join은 1회만 발생(ref-count 증가만)
- **Acceptance:** 서버 로그에 중복 join 부작용 없음

### TC-G-002 — Frozen 스트림 자동 재연결 (수동)
- **SRS:** FR-WRTC-061
- **Input:** WebRTC 세션이 연결된 상태에서 미디어 진행이 멈추는 상황을 재현(예: 카메라 측 일시 중단)
- **Expected:** 클라이언트가 정체를 감지하고 통제된 재연결을 수행, `video.play()` 지연으로 인한 오탐 재연결 루프가 발생하지 않음
- **Acceptance:** 페이지 새로고침 없이 영상이 재개됨

---

## 10. Test Execution Order

```
Group F (REST, 자동화) → Group A (WHEP 계약) → Group B (영상) → Group C (오디오)
  → Group D (App RTP) → Group E (AI 이벤트) → Group G (안정성)
```

---

## 11. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Signaling | 단일 WHEP 엔드포인트로만 협상 성립, 빈 body 400, 엔진 실패 503 |
| Video | webrtcEnabled 상태별로 배타적 전달, msid 부재 시에도 렌더링 |
| Audio | Opus 패스스루/비-Opus 트랜스코드 모두 정상, 음소거 즉시 처리 |
| App RTP | 원본+파싱 이중 전달, mediasoup DataChannel 중복 시 dedup 정상 |
| AI Events | webrtcEnabled 무관하게 항상 전달 |
| Diagnostics | ice-test/ice-config/monitor/capabilities 응답 스키마 일치 |
| Stability | 중복 subscribe 무해, frozen 스트림 자동 복구 |

---

## 12. Appendix — Retired Test Cases (pre-2026-07-23)

v1.x가 서술한 아키텍처(FFmpeg 듀얼출력 + mediasoup-client Socket.IO 시그널링)를 전제로 한 테스트 케이스는 대응하는 코드가 존재하지 않아 폐기한다. 향후 유사한 "고치려는" 시도를 막기 위해 기록을 남긴다.

| 구 ID | 구 내용 | 폐기 사유 |
|---|---|---|
| TC-A-008 | mediasoup Router H.264 PT=109 강제 검증 | PT 협상 방식이 alt-PT 동적 캐시로 대체됨(고정 PT 아님) — [TC_WebRTC_Engine_Modes.md](TC_WebRTC_Engine_Modes.md)로 이관 |
| TC-A-009 | mediasoup ICE listenIps env-var 전용 검증 | 엔진 내부 동작이므로 [TC_WebRTC_Engine_Modes.md](TC_WebRTC_Engine_Modes.md)로 이관 |
| TC-B-001~006 | Socket.IO `getCapabilities`/`createTransport`/`connectTransport`/`consume`/`resumeConsumer`/`leave` 이벤트 | 이 이벤트들이 존재하지 않음 — WHEP 단일 엔드포인트로 대체(§3) |
| TC-C-001~005 | mediasoup Router/Worker 생명주기(카메라당 Router 1개, PLI/FIR 등) | mediasoup 엔진 내부 동작이므로 [TC_WebRTC_Engine_Modes.md](TC_WebRTC_Engine_Modes.md) Group C로 이관, 모델 자체도 카메라당 Router가 아니라 Worker Pool 해시 배정으로 변경됨 |
| TC-D-001~004 | DataChannel `detections`/`loitering`/`fire`/`stream-stats` 메시지 타입 | 이런 메시지 타입은 존재하지 않음 — DataChannel은 App RTP 원본 중복 전달 전용(§6) |
| TC-E-001~003 | `WEBRTC_ENABLED` 전역 플래그, Socket.IO 폴백, ICE 재연결 버튼 | 전역 플래그 대신 카메라별 `webrtcEnabled`가 사용됨; ICE 재연결은 Group G에서 재정의 |
| TC-G-001~006 | 지연시간 ≤300ms, 오디오 ≤50kbps, CPU ≤70%, 브라우저 호환성 등 정량 SLA | 코드에서 측정·강제되지 않는 미검증 수치였음(SRS §9 참조) — 재도입 시 실측 근거와 함께 별도 NFR로 추가할 것 |
| TC-H-002 | 중복 `createTransport` 재사용 | `createTransport` Socket.IO 이벤트 자체가 존재하지 않음 |
| TC-H-003 | FFmpeg `Non-monotonous DTS`/`Queue input is backward in time` 경고 재발 방지 | 이 경로에 FFmpeg가 없음(ingest-daemon/PyAV) |
| TC-H-001, TC-H-004 | 중복 subscribe 무해화, frozen 스트림 복구 | **유효함** — Group G(TC-G-001/002)로 이름만 변경되어 유지됨 |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for WebRTC Media Gateway |
| 1.1 | 2026-05-29 | LTS Engineering Team | Added post-patch stability verification (TC-H-001 ~ TC-H-004) |
| 1.2 | 2026-06-16 | LTS Engineering Team | TC-A-008/TC-A-009 추가 — mediasoup PT=109 H264 검증, ICE listenIps env-var 전용 검증; SRS Traceability FR-WRTC-070/071 → TC-A-008/009 추가 |
| 1.3 | 2026-07-23 | LTS Engineering Team | 문서 상단에 정확성 안내 추가 — Group B 시그널링 모델은 미구현, 실제는 WHEP 단일 엔드포인트; `TC_WebRTC_Engine_Modes.md`로 연결 |
| 2.0 | 2026-07-23 | LTS Engineering Team | 전면 재작성 — SRS v2.0 FR-WRTC-001~061에 맞춰 Test Group A~G 재정의(시그널링/영상/오디오/AppRTP/AI이벤트/진단/안정성); 실재하지 않는 시그널링·DataChannel 메시지·정량 SLA 테스트 전체를 §12 Appendix로 폐기 기록; Group F는 기존 `test/api/webrtc.test.js` 자동화 내용 유지하되 FR 매핑 정정 |
