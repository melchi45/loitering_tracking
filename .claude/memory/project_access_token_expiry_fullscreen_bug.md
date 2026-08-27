---
name: project_access_token_expiry_fullscreen_bug
description: "JWT access token 미갱신으로 RTSP-over-WebSocket 풀스크린 전환 시 401 \"Invalid or expired token\" 발생하던 버그 및 수정 (2026-08-25)"
metadata: 
  node_type: memory
  type: project
  originSessionId: edc9bd31-bf44-4840-8347-348c92ea3a11
  modified: 2026-08-25T07:08:55.290Z
---

Streaming Server 모드에서 RTSP-over-WebSocket 채널을 더블클릭해 풀스크린 전환 시 `GET /api/cameras/:id/rtsp-over-websocket-credentials`가 401을 반환하며 재생 실패하던 버그를 진단·수정함 (2026-08-25).

**근본 원인**: SUNAPI/카메라 인증과 무관 — `client/src/stores/authStore.ts`가 JWT access token(`JWT_ACCESS_EXPIRES`, 기본 15분)을 메모리로만 들고 있었고, 앱 최초 로드 시 `App.tsx`의 `auth.refresh()` 1회 호출 외에는 백그라운드 자동 갱신도 401 재시도 로직도 전혀 없었음 — 클라이언트 전역에 401 인터셉터/재시도 wrapper 자체가 없었음. 대시보드를 TTL 이상 열어두면 토큰이 만료되고, 이후 `RTSPOverWebSocketView.tsx`가 (재)마운트되는 시점(풀스크린 전환 등)에 만료 토큰으로 fetch → 401.

**함정**: 마침 `docs/design/Design_RTSP_Over_WebSocket.md` §9에 "SunapiManager로 브라우저→카메라 직접 SUNAPI 로그인" Proposed 항목이 있어 사용자가 그것으로 우회 가능한지 물었으나, §9는 **카메라 자체 인증**이고 이 401은 **이 서버 자체의 JWT 게이트**라 서로 다른 인증 경계 — §9가 구현돼도 이 버그와는 무관함. 두 이슈를 혼동하지 않을 것.

**수정**: `authStore.ts`에 JWT `exp` 클레임을 디코딩해 만료 60초 전 자동 `refresh()`하는 타이머 추가(`scheduleTokenRefresh`/`clearTokenRefresh`, login/register/refresh 성공 시 재스케줄, logout/refresh 실패 시 해제). `RTSPOverWebSocketView.tsx`의 credentials fetch에 401 수신 시 1회 갱신 후 재시도하는 안전망 추가. 설계 문서 §8.22, Revision History 3.9 반영 완료.

**미검증**: 실제 15분+ 세션 방치 후 풀스크린 전환 재현 테스트는 미실시(코드 리뷰/빌드 통과만 확인) — 유사 401 재현 시 이 수정이 실제로 해소하는지 실기 확인 필요.

관련: [[project_ump_missing_bbox_canvas_bugfix]] (같은 RTSPOverWebSocketView.tsx 관련 과거 버그)
