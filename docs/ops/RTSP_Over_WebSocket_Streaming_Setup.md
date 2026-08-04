# Operations Guide
# RTSP-over-WebSocket 설치 및 운영 가이드

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-UMP-001 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System |
| **Issue Date** | 2026-08-04 |
| **Status** | **Active** |
| **Related PRD** | [prd/PRD_RTSP_Over_WebSocket.md](../prd/PRD_RTSP_Over_WebSocket.md) |
| **Related SRS** | [srs/SRS_RTSP_Over_WebSocket.md](../srs/SRS_RTSP_Over_WebSocket.md) |
| **Related Design** | [design/Design_RTSP_Over_WebSocket.md](../design/Design_RTSP_Over_WebSocket.md) |

---

## 개요

RTSP-over-WebSocket은 JPEG Capture / WebRTC에 이은 3번째 카메라 재생 경로입니다. 카메라에는 새로운 RTSP 세션을 열지 않고, ingest-daemon의 기존 단일 세션에서 로컬 MediaMTX로 채널별 재발행(on-demand)한 뒤, 신규 `/StreamingServer` WebSocket 엔드포인트가 RTSP Digest 인증 후 순수 바이트 릴레이를 수행합니다. 아키텍처 전체는 [Design_RTSP_Over_WebSocket.md](../design/Design_RTSP_Over_WebSocket.md)를 참고하십시오.

---

## 1. npm 패키지 인증 설정 (최초 1회, 개발자별) — 2026-08-04 갱신

**서브모듈은 더 이상 필요 없습니다.** `<rtsp-over-websocket>` 웹 컴포넌트는 `@melchi45/rtsp-over-websocket`(GitHub Packages, `npm.pkg.github.com`)로 정식 배포되어 `client/package.json`의 필수 `dependencies`에 등록돼 있습니다(레거시 `submodules/ump-player` 서브모듈과 그 안의 `optionalDependencies`였던 `@melchi45/ump-player`는 2026-08-04 제거됨 — 상세: [Design_RTSP_Over_WebSocket.md](../design/Design_RTSP_Over_WebSocket.md) §8.21).

GitHub Packages는 **public 저장소라도 `npm install`에 항상 인증이 필요**합니다(기본 npmjs.com 레지스트리와의 차이점). `read:packages` 권한의 GitHub Personal Access Token(PAT)이 필요합니다. 토큰은 절대 커밋하거나 채팅/로그에 붙여넣지 마십시오.

```bash
cp client/.npmrc.example client/.npmrc
# client/.npmrc를 열어 YOUR_GITHUB_PAT_WITH_READ_PACKAGES_SCOPE를 실제 토큰으로 교체
```

또는 대화형 로그인:

```bash
npm login --scope=@melchi45 --registry=https://npm.pkg.github.com
```

`client/.npmrc`는 `.gitignore`에 포함되어 있습니다(토큰이 저장되므로) — 커밋하지 마십시오. 토큰이 없거나 잘못되면 `npm install` 자체가 **401/404로 실패**합니다(예전 `optionalDependencies` 시절과 달리 조용히 건너뛰지 않음) — RTSP-over-WebSocket는 이제 다른 스트리밍 모드들과 마찬가지로 필수 의존성입니다.

CI(GitHub Actions)는 리포지토리 시크릿 `NPM_GH_PACKAGES_TOKEN`(동일하게 `read:packages` 권한)을 사용합니다 — `test.yml`/`deploy-pages.yml`의 "Configure npm registry for @melchi45" 스텝이 이 시크릿으로 `.npmrc`를 생성합니다. 시크릿은 저장소 관리자가 GitHub Settings → Secrets and variables → Actions에서 직접 등록해야 합니다.

---

## 2. 클라이언트 설치

```bash
cd client
npm install    # @melchi45/rtsp-over-websocket 포함 정상 설치, 별도 자산 복사 스크립트 없음
```

`import '@melchi45/rtsp-over-websocket'`(`RTSPOverWebSocketView.tsx`)이 패키지의 ESM 번들을 로드하며 side-effect로 `<rtsp-over-websocket>` 커스텀 엘리먼트를 등록합니다 — 레거시 방식(70여 개 `<script>` 태그를 특정 순서로 순차 로드, `client/public/`에 정적 자산 심볼릭 링크)은 더 이상 존재하지 않습니다. Web Worker 등 패키지 내부 자산은 번들러(Vite)가 알아서 해석하므로 `public/` 배치가 필요 없습니다.

---

## 3. 서버 측 설정

별도의 신규 환경변수는 없습니다 — 기존 변수를 재사용합니다:

| 변수 | 기본값 | 용도 |
|---|---|---|
| `MEDIAMTX_RTSP_PORT` | `8554` | ingest-daemon의 6번째 fan-out이 publish하는 로컬 MediaMTX RTSP 포트, `/StreamingServer` WS 브릿지가 연결하는 backend 포트와 동일 |
| `INGEST_DAEMON_URL` | `http://127.0.0.1:7070` | `umpStreamingServer.js`가 on-demand `POST`/`DELETE /cameras/:id/rtsp-publish` 호출 시 사용 |
| `CAPTURE_BACKEND` | `ingest-daemon` | `ingest-daemon`이 아니면 `/StreamingServer` WS 브릿지 자체가 기동되지 않음 (`index.js` 가드) |

`/StreamingServer` WS 브릿지는 `SERVER_MODE`가 `analysis`가 아니고 `CAPTURE_BACKEND=ingest-daemon`일 때만 `server/src/index.js`에서 기동됩니다 — 기존 HTTPS/HTTP 포트(3080/3443)를 그대로 공유하며 별도 포트가 필요 없습니다.

---

## 4. 카메라별 활성화

카메라 Add/Edit 화면의 **Streaming Mode** 3-way 토글(JPEG(Default) / WebRTC / RTSP-over-WebSocket)에서 "RTSP-over-WebSocket"를 선택하면 됩니다. `supportSunapi` 여부와 무관하게 모든 카메라에 노출됩니다 — 로컬 MediaMTX 프록시가 재서빙하므로 원본 카메라의 SUNAPI 지원 여부는 게이팅 조건이 아닙니다.

RTSP-over-WebSocket 재생이 동작하려면 해당 카메라에 **RTSP username/password가 저장되어 있어야 합니다** — `/StreamingServer` 브릿지가 이 값으로 RTSP Digest(MD5) 인증을 수행하기 때문입니다(설계 문서 §4.2). 카메라에 자격증명이 없으면 RTSP-over-WebSocket 재생은 항상 인증 실패합니다.

`<rtsp-over-websocket>`는 **`device="nvr"`**로 렌더링됩니다(`device="camera"`가 아님) — `channel` 속성은 NVR 모드 전용이라, `device="camera"`로는 channelSlot 기반 라우팅을 할 수 없습니다(설계 문서 §8.3). `width`/`height` 속성도 필수이며(누락 시 패키지 자체 문서에 따라 엘리먼트가 아예 렌더링되지 않음), `RTSPOverWebSocketView.tsx`가 카메라 타일의 실제 렌더 크기를 `ResizeObserver`로 측정해 전달합니다.

---

## 5. 트러블슈팅

| 증상 | 원인 | 조치 |
|---|---|---|
| `npm install`이 `client/`에서 401/404로 실패 | `client/.npmrc`가 없거나 `@melchi45:registry`/토큰이 잘못됨 — GitHub Packages는 public repo라도 인증 없이는 `@melchi45/rtsp-over-websocket`을 못 받음 | `client/.npmrc.example`을 `client/.npmrc`로 복사 후 `read:packages` 권한 PAT 채워넣기(§1). CI는 `NPM_GH_PACKAGES_TOKEN` 리포지토리 시크릿 등록 여부 확인 |
| 카메라 타일에 "Loading RTSP-over-WebSocket player…"가 계속 표시됨 | `customElements.whenDefined('rtsp-over-websocket')`가 resolve되지 않음 — 보통 위 npm install 실패로 패키지 자체가 `node_modules`에 없거나, 번들 로드 중 JS 에러 | 브라우저 개발자도구 Console에서 `@melchi45/rtsp-over-websocket` 관련 에러 확인, `node_modules/@melchi45/rtsp-over-websocket` 존재 여부 확인 후 필요 시 `npm install` 재실행 |
| "RTSP-over-WebSocket playback error: ..." 표시 | `GET /api/cameras/:id/ump-credentials` 실패(401 등) | 로그인 세션(accessToken) 확인 — 이 엔드포인트만 JWT 필수 |
| 재생이 시작되지 않고 조용히 멈춤 | `/StreamingServer` WS 연결이 안 열림 | `CAPTURE_BACKEND=ingest-daemon` 확인, 브라우저 개발자도구 Network 탭에서 WS 연결 상태 확인 |
| WS는 연결되나 401 반복 | 카메라에 저장된 username/password 불일치 또는 공란 | 카메라 Edit 화면에서 RTSP 자격증명 재입력 |
| 인증은 성공하나 영상이 안 나옴 | ingest-daemon의 rtsp-publish fan-out이 MediaMTX에 아직 준비되지 않음(레이스) 또는 MediaMTX 미기동 | `curl http://127.0.0.1:7070/cameras/stats`에서 해당 카메라 `rtspPublishChannel` 값 확인, MediaMTX 프로세스 상태 확인 |
| 개발 모드(`npm run dev`)에서 WS 연결 실패 | Vite dev 서버 프록시에 `/StreamingServer` 규칙 누락 | `client/vite.config.ts`의 `server.proxy['/StreamingServer']`(`ws: true`) 확인 |
| 인증 성공 후 OPTIONS→DESCRIBE→SETUP까지 갔다가 계속 재시도(무한 루프), MediaMTX 로그에 `invalid SETUP path` | 구버전 `rewriteRequestUri()`가 SETUP 요청 URI의 트랙 접미사(예: `/trackID=0`)까지 통째로 지우고 DESCRIBE와 같은 URI로 덮어써 MediaMTX가 거부. 클라이언트가 SETUP URI를 DESCRIBE 응답의 `Content-Base`(MediaMTX 자신의 베이스, 이미 올바른 값)로 만드는 경우까지 감안해야 함(2026-07-23 실 카메라 라이브 테스트로 확인, 두 차례 수정) | 이미 수정됨(§8.8, v2.0) — `umpStreamingServer.js`의 `rewriteRequestUri()`가 "이미 MediaMTX 타깃으로 시작하면 그대로 통과 → 클라이언트 베이스 접두사면 그 부분만 치환 → 둘 다 아니면 통째 치환" 3단 분기인지 확인. 재발 시 `[UmpStreamingServer] rewrote request line "..." -> "..."` 로그로 SETUP 라인이 실제로 어떻게 바뀌는지 확인 |
| RTSP 핸드셰이크(OPTIONS~PLAY)는 전부 성공하고 WS로 데이터도 들어오는데 첫 프레임에서 `RTSP-over-WebSocket playback error: Cannot read properties of null (reading 'byteLength')` | on-demand fan-out이 카메라 스트림의 GOP 중간에 합류해 VPS/SPS/PPS 없는 P-슬라이스부터 전달됨 — `<rtsp-over-websocket>`의 H265 파서는 SDP의 sprop-vps/sprop-sps/sprop-pps를 쓰지 않고 오직 인밴드 RTP NAL(VPS/SPS/PPS)로만 디코더 상태를 시딩하므로, 그게 없는 첫 프레임에서 그대로 크래시(2026-07-23 실 카메라 라이브 테스트로 확인) | 이미 수정됨(§8.9, v2.1) — `ingest_daemon.py`의 `add_rtsp_publish()`/`add_video_fanout()` 동적 추가 경로에 `needsKeyframe` 게이트가 있는지 확인(다음 키프레임까지 해당 fan-out 엔트리에는 패킷을 보내지 않아야 함). 재발 시 `ingest-daemon.log`에서 `RTSP publish added` 직후 첫 전달 패킷이 키프레임인지 확인 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-23 | 초기 작성 |
| 1.1 | 2026-07-23 | "Loading RTSP-over-WebSocket player…" 무한 대기 버그 1차 수정 반영 — `crypto-js.js` 정적 자산 추가, 스크립트 로드 순서(`crypto-js.js` → `ffmpegAAC.js` → `ump-player.min.js`) 명시, 트러블슈팅 표 갱신 |
| 1.2 | 2026-07-23 | jsdom 재현으로 진짜 원인 확인 — `ump-player.min.js`의 `new Logger()` 폴백이 `window.log4javascript` 부재 시 throw. `log4javascript.js` 정적 자산 추가, 최종 로드 순서를 `log4javascript.js` → `crypto-js.js` → `ffmpegAAC.js` → `ump-player.min.js`로 정정 |
| 1.3 | 2026-07-23 | npm 패키지 `dist/html`·`dist/docs` 확인 결과 반영 — `device="nvr"`(camera 아님)가 올바른 모드, `width`/`height` 속성 필수(없으면 렌더링 자체 불가) |
| 1.4 | 2026-07-23 | SETUP 요청 URI 트랙 접미사가 지워져 MediaMTX가 "invalid SETUP path"로 거부하며 무한 재시도하던 버그(§5 트러블슈팅 표에 항목 추가) — Design 문서 §8.8 참조 |
| 1.5 | 2026-07-23 | 위 버그의 진짜 원인(클라이언트가 MediaMTX의 Content-Base로 SETUP URI를 만드는 경우)과 최종 3단 분기 수정 반영 — Design 문서 §8.8/v2.0 참조 |
| 1.6 | 2026-07-23 | RTSP 핸드셰이크 성공 후 첫 프레임에서 "Cannot read properties of null (reading 'byteLength')"로 크래시하던 버그(§5 트러블슈팅 표에 항목 추가) — on-demand fan-out의 GOP 중간 합류가 원인, `needsKeyframe` 게이트로 수정. Design 문서 §8.9/v2.1 참조 |
| 2.0 | 2026-08-04 | §1/§2 전면 재작성 — `submodules/ump-player` 서브모듈 설정 절차와 `optionalDependencies` `@melchi45/ump-player` 설치·정적 자산 복사 안내를 제거하고, 필수 dependency `@melchi45/rtsp-over-websocket` 설치 + `client/.npmrc.example` 기반 인증 설정으로 교체. CI `NPM_GH_PACKAGES_TOKEN` 시크릿 안내 추가. `<ump-player>` 태그명 참조를 `<rtsp-over-websocket>`으로 갱신, §5 트러블슈팅 표의 스크립트 로드 순서 항목을 npm install 인증 실패 항목으로 교체. Design 문서 §8.21 참조 |
