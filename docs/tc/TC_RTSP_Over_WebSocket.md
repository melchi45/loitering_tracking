# TC — RTSP-over-WebSocket 스트리밍 경로

**Product:** LTS-2026 Loitering Detection & Tracking System
**Feature:** RTSP-over-WebSocket (3번째 카메라 재생 경로)
**Version:** 1.3
**Date:** 2026-08-04
**SRS Reference:** [SRS_RTSP_Over_WebSocket.md](../srs/SRS_RTSP_Over_WebSocket.md)
**Design Reference:** [Design_RTSP_Over_WebSocket.md](../design/Design_RTSP_Over_WebSocket.md)

> **실행 상태**: 아래 테스트 케이스는 코드 구현 완료(2026-07-23) 후 작성되었으나, 실제 카메라/브라우저를 통한 라이브 검증(end-to-end)은 아직 수행되지 않았습니다. `npm run test:tc`로 자동화되는 항목과, 실제 `<rtsp-over-websocket>` 재생 확인이 필요한 수동 항목을 구분해 표기합니다.

---

## Test Cases

### 카메라 스키마 및 재생 모드 (FR-RTSPWS-001~005)

#### TC-RTSPWS-001: PUT /api/cameras/:id에 streamingMode='rtsp-over-websocket' 전달 시 webrtcEnabled=false, rtspOverWebSocketEnabled=true로 저장

**SRS:** FR-RTSPWS-001, FR-RTSPWS-002
**Steps:** `PUT /api/cameras/:id` body `{ streamingMode: 'rtsp-over-websocket' }`
**Expected:** `200`; DB에 `webrtcEnabled: false`, `rtspOverWebSocketEnabled: true` 저장; 응답 `data.streamingMode === 'rtsp-over-websocket'`
**자동화**: 가능 (`test/api/`)

---

#### TC-RTSPWS-002: GET /api/cameras/:id 응답에 streamingMode 역산 포함

**SRS:** FR-RTSPWS-003
**Steps:** `webrtcEnabled: true`인 카메라에 `GET /api/cameras/:id`
**Expected:** 응답 `data.streamingMode === 'webrtc'` (저장된 boolean으로부터 역산, 별도 DB 필드 없음)
**자동화**: 가능

---

#### TC-RTSPWS-003: streamingMode 미전달 시 기존 webrtcEnabled 동작 불변

**SRS:** FR-RTSPWS-004
**Steps:** `PUT /api/cameras/:id` body에 `webrtcEnabled: true`만 전달(streamingMode 없음) — 기존 MCP 도구/스크립트 호출 패턴 재현
**Expected:** `200`; `webrtcEnabled: true`로 저장(기존과 동일), `rtspOverWebSocketEnabled` 값 불변, 파이프라인 재시작 로직(`needsRestart`)도 기존과 동일하게 동작
**자동화**: 가능 — 회귀 테스트로 중요

---

#### TC-RTSPWS-004: rtspOverWebSocketEnabled 변경은 파이프라인 재시작을 트리거하지 않음

**SRS:** FR-RTSPWS-001 관련 (설계 §4.2)
**Steps:** 이미 실행 중인 카메라에 `PUT /api/cameras/:id` body `{ streamingMode: 'rtsp-over-websocket' }` (webrtcEnabled 값은 불변)
**Expected:** 응답 `restarted: false` — ByteTracker/파이프라인 재시작 없음
**자동화**: 가능

---

#### TC-RTSPWS-005: YouTube 카메라 폼에는 RTSP-over-WebSocket 옵션이 노출되지 않음

**SRS:** FR-RTSPWS-005
**Steps:** Dashboard에서 "+ Add" → YouTube 탭 확인
**Expected:** Streaming Mode가 JPEG/WebRTC 2-way 토글로만 표시(RTSP-over-WebSocket 버튼 없음) — `CameraList.tsx`의 `AddYouTubeForm`은 `webrtcEnabled: boolean` 그대로 유지
**자동화**: 불가(UI) — 수동 확인

---

### ingest-daemon Fan-out (FR-RTSPWS-010~014)

#### TC-RTSPWS-010: rtsp-publish 시작 시 카메라의 기존 RTSP 세션 수 불변

**SRS:** FR-RTSPWS-011, NFR-RTSPWS-05
**Precondition:** 카메라가 이미 ingest-daemon에 연결되어 AI/WebRTC로 스트리밍 중
**Steps:** `POST http://127.0.0.1:7070/cameras/:id/rtsp-publish { channelSlot }` 호출 전후로 카메라 장비 자체의 동시 RTSP 클라이언트 수(장비 관리 페이지 또는 네트워크 캡처로 확인)
**Expected:** 세션 수 불변(ingest-daemon의 기존 단일 세션만 유지) — 새 세션이 추가로 열리지 않음
**자동화**: 불가(실 장비 필요) — 수동 확인

---

#### TC-RTSPWS-011: rtsp-publish 시작 후 로컬 MediaMTX 경로로 재생 가능

**SRS:** FR-RTSPWS-010
**Steps:** `POST /cameras/:id/rtsp-publish { channelSlot: N }` 성공 후 `ffplay rtsp://127.0.0.1:8554/N/media.smp` (서버 로컬에서)
**Expected:** 정상 재생(비디오 프레임 수신)
**자동화**: 부분 가능 (CI에서 ffplay 대신 `av.open()`으로 첫 패킷 수신 확인하는 스크립트 작성 가능) — 현재 미작성

---

#### TC-RTSPWS-012: on-demand 시작 — 첫 뷰어 연결 시에만 fan-out 활성화

**SRS:** FR-RTSPWS-012, NFR-RTSPWS-02
**Steps:** RTSP-over-WebSocket 뷰어가 0명인 상태에서 ingest-daemon `GET /cameras/stats`의 해당 카메라 `rtspPublishChannel` 필드 확인 → WS 브릿지로 첫 연결 → 다시 확인
**Expected:** 연결 전 `null`, 연결 후 채널 번호로 채워짐
**자동화**: 가능 (WS 클라이언트로 연결 후 daemon stats polling)

---

#### TC-RTSPWS-013: on-demand 종료 — 마지막 뷰어 종료 시 fan-out 비활성화

**SRS:** FR-RTSPWS-013
**Steps:** TC-RTSPWS-012 상태에서 WS 연결 종료 → `GET /cameras/stats`의 `rtspPublishChannel` 재확인
**Expected:** 다시 `null`로 복귀
**자동화**: 가능

---

#### TC-RTSPWS-014: 동시 다중 뷰어 — refcount가 정확히 유지됨

**SRS:** FR-RTSPWS-012, FR-RTSPWS-013, NFR-RTSPWS-05
**Steps:** 같은 카메라에 WS 연결 3개를 순서대로 열고, 순서대로(또는 무작위 순서로) 3개를 닫음
**Expected:** 3번째 연결까지는 fan-out 유지, 마지막(3번째) 연결 종료 시에만 `DELETE .../rtsp-publish` 호출 — 중간에 종료된 연결에서는 fan-out이 꺼지지 않음
**자동화**: 가능 (여러 WS 클라이언트로 시뮬레이션)

---

### `/StreamingServer` WS 브릿지 (FR-RTSPWS-020~026)

#### TC-RTSPWS-020: 알 수 없는 channelSlot 요청 시 404 후 연결 종료

**SRS:** FR-RTSPWS-021
**Steps:** WS로 `/StreamingServer`에 연결 후 `OPTIONS rtsp://host/9999/media.smp RTSP/1.0`(존재하지 않는 channelSlot) 전송
**Expected:** `RTSP/1.0 404 Not Found` 응답 후 WS 연결 종료
**자동화**: 가능

---

#### TC-RTSPWS-021: 인증 없이 요청 시 401 Digest challenge 수신

**SRS:** FR-RTSPWS-022
**Steps:** 유효한 channelSlot으로 `Authorization` 헤더 없이 `OPTIONS` 요청 전송
**Expected:** `RTSP/1.0 401 Unauthorized`, `WWW-Authenticate: Digest realm="lts-rtsp-over-websocket", nonce="..."` 포함, qop/algorithm/opaque는 포함하지 않음(단순 모드)
**자동화**: 가능

---

#### TC-RTSPWS-022: 올바른 자격증명으로 Digest 재시도 시 인증 성공 + 릴레이 전환

**SRS:** FR-RTSPWS-022, FR-RTSPWS-024, FR-RTSPWS-025
**Steps:** TC-RTSPWS-021의 nonce로 `HA1=MD5(username:lts-rtsp-over-websocket:password)`, `HA2=MD5(OPTIONS:uri)`, `response=MD5(HA1:nonce:HA2)` 계산해 `Authorization: Digest ...` 재전송
**Expected:** 이후 메시지부터 로컬 MediaMTX로부터의 RTSP 응답이 그대로 릴레이됨(우리 서버가 직접 응답 조립하지 않음)
**자동화**: 가능 — 인증 로직의 핵심 회귀 테스트

---

#### TC-RTSPWS-023: 잘못된 비밀번호로 3회 연속 실패 시 연결 종료

**SRS:** FR-RTSPWS-023
**Steps:** 틀린 password로 Digest response를 3회 연속 전송
**Expected:** 4번째 시도 전에 WS 연결이 `1008`로 종료됨(`MAX_AUTH_ATTEMPTS=3`)
**자동화**: 가능

---

#### TC-RTSPWS-024: 인증 성공 후 순수 바이트 릴레이 — RTSP 파싱 없이 임의 바이너리도 통과

**SRS:** FR-RTSPWS-025
**Steps:** 인증 성공 후 SETUP/PLAY까지 정상 진행한 뒤, 이후 수신되는 RTP interleaved(`$`로 시작하는) 바이너리 프레임이 손상 없이 전달되는지 바이트 단위로 비교
**Expected:** WS로 보낸 바이트와 TCP로 MediaMTX에 도달한 바이트가 완전히 동일(변형 없음)
**자동화**: 가능(로컬 mock TCP 서버로 바이트 비교)

---

#### TC-RTSPWS-025: 카메라에 저장된 자격증명이 없으면 인증 항상 실패

**SRS:** §10 제약사항 (SRS §10)
**Steps:** `username`/`password`가 비어있는 카메라의 channelSlot으로 Digest 인증 시도(빈 문자열로 HA1 계산)
**Expected:** 클라이언트가 어떤 자격증명을 보내도 실질적으로 인증 불가(빈 값과 일치하는 요청이 아닌 한) — 별도 익명 접근 경로 없음을 확인
**자동화**: 가능

---

### 채널 매핑 (FR-RTSPWS-030~031)

#### TC-RTSPWS-030: channelSlot 변경 시 RTSP-over-WebSocket RTSP URL도 함께 변경됨

**SRS:** FR-RTSPWS-030
**Steps:** 카메라의 `channelSlot`을 `PUT /api/cameras/:id`로 변경 → 이전 channelSlot으로 WS 접속 시도
**Expected:** 이전 channelSlot으로는 카메라를 찾지 못함(404), 새 channelSlot으로는 정상 인증/릴레이
**자동화**: 가능

---

### 클라이언트 UI (FR-RTSPWS-040~042)

#### TC-RTSPWS-040: 카메라 Add/Edit 화면에 3-way Streaming Mode 토글 표시

**SRS:** FR-RTSPWS-040
**Steps:** Dashboard → 카메라 "+ Add" 또는 기존 카메라 Edit 모달 열기
**Expected:** "JPEG (Default) / WebRTC / RTSP-over-WebSocket" 3버튼 세그먼트 컨트롤 표시, 클릭 시 선택 상태 전환
**자동화**: 불가(UI) — 수동 확인 또는 Playwright E2E(미작성)

---

#### TC-RTSPWS-041: streamingMode='rtsp-over-websocket' 카메라 타일에 <rtsp-over-websocket> 렌더링

**SRS:** FR-RTSPWS-042
**Steps:** RTSP-over-WebSocket 모드로 저장된 카메라의 CameraGrid 타일 확인
**Expected:** `<rtsp-over-websocket>` 커스텀 엘리먼트가 DOM에 렌더링되고 비디오가 재생됨(브라우저 개발자 도구로 WS 연결이 `/StreamingServer`로 열리는 것 확인)
**자동화**: 불가(실 브라우저+실 카메라 필요) — **아직 라이브 검증 전, 최우선 수동 확인 필요**

---

#### TC-RTSPWS-042: rtsp-over-websocket-credentials 엔드포인트는 미인증 요청을 거부

**SRS:** 설계 §4.2 (`GET /api/cameras/:id/rtsp-over-websocket-credentials`)
**Steps:** `Authorization` 헤더 없이 `GET /api/cameras/:id/rtsp-over-websocket-credentials` 호출
**Expected:** `401` — 카메라 자격증명이 노출되지 않음(다른 `/api/cameras` 엔드포인트와 달리 이 엔드포인트만 JWT 필수)
**자동화**: 가능 — 보안 회귀 테스트로 중요

---

#### TC-RTSPWS-043: RTSP-over-WebSocket 재생 화면에 detection bounding box 오버레이가 표시됨 (2026-07-30 회귀 테스트)

**SRS:** FR-RTSPWS-043
**Precondition:** `streamingMode='rtsp-over-websocket'` 카메라가 실제로 감지 대상(사람 등)을 촬영 중이고, ingest-daemon → analysis 파이프라인이 정상 동작 중(analysis 서버에 capture image가 입력되고 있음)
**Steps:**
1. Streaming Dashboard에서 해당 카메라 타일을 확인
2. `<rtsp-over-websocket>` 영상 위에 bounding box가 그려지는지 관찰
3. 브라우저 개발자 도구로 `CameraView.tsx`의 `canvasRef` DOM 노드가 RTSP-over-WebSocket 분기에도 존재하는지 확인(Elements 탭에서 `<rtsp-over-websocket>` 형제로 `<canvas>` 존재 확인)

**Expected:** WebRTC/JPEG 모드와 동일하게 bounding box, 라벨, 신뢰도가 영상 위에 실시간으로 그려짐
**자동화**: 불가(실 브라우저+실 카메라+실제 감지 대상 필요) — 수동 확인 필요. 회귀 방지 목적으로는 `canvasRef` 엘리먼트가 RTSP-over-WebSocket 분기 JSX에 존재하는지를 컴포넌트 스냅샷/렌더 테스트로 자동화하는 것도 고려 가능(현재 미구현)

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 — SRS FR-RTSPWS-NNN 전체 항목 대응 테스트 케이스 정의 |
| 1.1 | 2026-07-30 | TC-RTSPWS-043 추가 — RTSP-over-WebSocket 재생 시 detection bounding box 미표시 버그 회귀 테스트 (Design §8.20) |
| 1.2 | 2026-08-04 | 클라이언트 라이브러리를 `melchi45/rtsp-over-websocket` 서브모듈에서 `@melchi45/rtsp-over-websocket` npm 패키지로 전환 — Design §8.21 참고. 기존 TC 케이스는 속성/이벤트 계약이 호환되므로 그대로 유효 |
| 1.3 | 2026-08-10 | 테스트 케이스 ID `TC-UMP-NNN` → `TC-RTSPWS-NNN`으로 전면 리네임, 참조하는 `**SRS:** FR-UMP-*` 라인도 `FR-RTSPWS-*`로 동시 갱신(SRS_RTSP_Over_WebSocket.md와 동시 갱신, 테스트 내용 변경 없음); 잔존 레거시 명칭 일괄 정리 — `Ump*` 식별자·`submodules/rtsp-over-websocket` 경로를 `@melchi45/rtsp-over-websocket` npm 패키지의 현행 명칭(`RTSPOverWebSocket*`, 별도 저장소 `melchi45/rtsp-over-websocket`)으로 전면 교체 |
