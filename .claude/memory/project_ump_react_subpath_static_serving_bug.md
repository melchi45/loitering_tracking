---
name: project-ump-react-subpath-static-serving-bug
description: /ump-react가 서버에서 404→HTML fallback으로 스크립트 파싱 에러 나던 버그 원인+수정 (2026-07-24)
metadata: 
  node_type: memory
  type: project
  originSessionId: e2bd50e6-c29e-4aad-9c78-343b894a56ac
  modified: 2026-08-10T04:02:49.216Z
---

**STALE (2026-08-10):** the entire `/ump-react` TEMP DIAGNOSTIC static-serving route this memory is about was deleted 2026-08-04 along with `submodules/ump-player` (and its `app-react` React port) when the player switched to the npm package `@melchi45/rtsp-over-websocket`. `server/src/index.js` no longer has an `/ump-react` route at all — this memory is pure historical record now, with no current route/file to apply it to. The main client component this memory references (`client/src/components/UmpPlayerView.tsx`) was also renamed to `client/src/components/RTSPOverWebSocketView.tsx` as part of the same 2026-08-04 switch.

`https://dev.hanwhavision.com:3443/ump-react/`(UMP Player React 포팅, `submodules/ump-player/app-react`) 접속 시 crypto.js/log4javascript.js/main.tsx 등 전 스크립트가 "Unexpected token '<'" / MIME text/html 에러로 실패하던 버그.

**원인**: `server/src/index.js`의 `app.use('/ump-react', express.static(...))`가 Vite 빌드 결과물(`app-react/dist`)이 아니라 **프로젝트 원본 디렉토리**(`app-react/`)를 그대로 정적 서빙하고 있었음. 원본 `index.html`(dev용)은 `base` 미설정 상태라 `/media/ump/...`, `/favicon.svg`, `/src/main.tsx`를 **절대 루트 경로**로 참조 — `/ump-react` 프리픽스가 없으므로 브라우저가 도메인 루트로 요청. 매칭되는 라우트가 없으니 client(React 대시보드)의 SPA catch-all(`index.js` 정규식 — `/api|/auth|/admin|/health|/internal|/socket.io`만 제외)이 그 자리에서 대신 `index.html`을 반환 → 모든 JS 요청이 HTML을 받는 결과.

**수정** (2026-07-24):
1. `submodules/ump-player/app-react/vite.config.ts`에 `base: '/ump-react/'` 추가
2. `server/src/index.js`의 express.static 경로를 `app-react/dist`로 변경 (client 서빙과 동일 패턴)
3. `cd submodules/ump-player/app-react && npm run build` 재빌드 필수

**Why**: 서브패스(`/ump-react/`)에 마운트되는 SPA는 반드시 `vite.config.ts`의 `base`를 그 서브패스로 맞추고, express에는 항상 `dist/`(빌드 산출물)만 정적 서빙해야 함. 원본 프로젝트 디렉토리를 그대로 서빙하면 안 됨 — `src/`, `node_modules/` 등도 함께 노출되고, dev용 `index.html`은 Vite 개발서버 없이는 동작 불가. (일반 원칙으로는 여전히 유효 — 다만 아래 "How to apply"가 가리키던 구체적 라우트는 이제 존재하지 않음.)

**How to apply (해당 라우트 자체가 삭제됨 — 더 이상 적용 대상 없음)**: app-react를 수정할 때마다 `npm run build`로 재빌드 안 하면 서버가 옛 dist를 계속 서빙함(자동 반영 안 됨). 이 라우트는 `index.js`상 "TEMP DIAGNOSTIC (2026-07-24) — Remove once the UMP React port is done" 주석이 달린 임시 진단용이었고, 실제로 2026-08-04 서브모듈 삭제와 함께 제거됨. 관련: [[project_ump_stap_a_sps_null_bugfix]]

**후속 버그 (같은 날, 정적 서빙 수정 후 발견)**: 정적 서빙을 고친 뒤에도 Play 버튼이 무반응 — 별개의 두 원인:
1. `app-react/src/App.tsx`가 `<UmpPlayer>`에 `secure` prop을 안 넘겨 기본 `false` → `ump-player.js`의 play()가 `ws://`(non-secure)로 StreamingServer WS를 열려다 HTTPS 페이지의 mixed-content 차단에 걸려 조용히 실패. 메인 클라이언트(당시 `client/src/components/UmpPlayerView.tsx:280`, 현재는 `RTSPOverWebSocketView.tsx`)는 이미 `secure = window.location.protocol === 'https:'`로 올바르게 설정 중 — 동일 패턴을 App.tsx에도 적용해 수정.
2. `streamPlayer.js`(canonical: `submodules/ump-player/app/media/ump/Interface/streamPlayer.js`, client·app-react 공용— symlink로 연결됨)가 `/StreamingServer` 뒤에 `window.location.pathname`을 그대로 잘라 붙이는 로직을 무조건 실행 — 카메라 임베디드 웹서버에 페이지가 직접 서빙된다는(즉 WS 서버와 페이지가 같은 origin/경로 구조라는) 가정이 깔려 있어, `/ump-react/`처럼 다른 origin 서브패스에 있는 외부 클라이언트에서는 `/StreamingServer/ump-react`라는 잘못된 접미사가 붙음. 기존에 SUNAPI 쪽에만 연결돼 있던 `grunt`(외부 클라이언트 플래그, `serverType==='grunt'`)를 이 WS 경로 로직에도 연결해서 grunt 모드일 때는 `window.location` 유도를 건너뛰도록 수정 — 메인 클라이언트는 grunt를 안 켜므로 회귀 없음.

**Why**: 레거시 ump-player 라이브러리는 "카메라 자체 임베디드 웹서버가 페이지를 서빙한다"는 단일 배포 시나리오를 가정하고 만들어짐. LTS 서버가 그 페이지를 대신 서빙하는(외부 클라이언트) 시나리오에서는 프로토콜(ws/wss)과 경로 유도 둘 다 `window.location` 대신 명시적 설정(`secure`, `grunt`)에 의존해야 함.
