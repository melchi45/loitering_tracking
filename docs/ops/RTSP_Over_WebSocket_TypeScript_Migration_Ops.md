# Operations Guide
# RTSP-over-WebSocket TypeScript/ESM 마이그레이션 — 빌드/테스트 운영 가이드

| | |
|---|---|
| **Document Reference** | OPS-LTS2026-RTSPWS-TS-001 |
| **Document Type** | Operations Guide |
| **Parent System** | LTS-2026-001 Loitering Detection & Tracking System (submodule: rtsp-over-websocket) |
| **Issue Date** | 2026-08-04 |
| **Status** | **Superseded** (2026-08-04) — `melchi45/rtsp-over-websocket`는 LTS-2026 저장소에서 제거되었습니다(Design_RTSP_Over_WebSocket_TypeScript_Migration.md §9). 이 문서의 빌드/테스트 절차는 이제 이 저장소가 아니라 별도 저장소 `melchi45/rtsp-over-websocket`에서 수행됩니다 — 아래 §1~§5는 서브모듈이 존재하던 당시의 절차를 **역사적 기록**으로 보존한 것이며, `cd rtsp-over-websocket`로 시작하는 명령은 더 이상 이 저장소에서 실행할 수 없습니다. |
| **Related PRD** | [prd/PRD_RTSP_Over_WebSocket_TypeScript_Migration.md](../prd/PRD_RTSP_Over_WebSocket_TypeScript_Migration.md) |
| **Related SRS** | [srs/SRS_RTSP_Over_WebSocket_TypeScript_Migration.md](../srs/SRS_RTSP_Over_WebSocket_TypeScript_Migration.md) |
| **Related Design** | [design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md](../design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md) |

---

## 개요

`melchi45/rtsp-over-websocket/src/player/`는 레거시 `app/media`(별도 git 서브모듈, 수정 금지)와 병행하는 TypeScript/ESM 구현이다. 이 문서는 로컬 개발, 빌드, 테스트 실행 방법을 다룬다. 아키텍처 자체는 [Design_RTSP_Over_WebSocket_TypeScript_Migration.md](../design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md)를 참고한다.

---

## 1. 사전 준비

`melchi45/rtsp-over-websocket`는 private 저장소이며 중첩 서브모듈(`app/media`, `app/external-lib`)을 가진다. 최초 체크아웃 절차는 [RTSP_Over_WebSocket_Streaming_Setup.md §1](RTSP_Over_WebSocket_Streaming_Setup.md#1-서브모듈-설정-최초-1회)의 SSH override 절차를 그대로 따른다 — TypeScript 마이그레이션 작업 시에도 레거시 소스(`app/media/*.js`)를 parity 테스트가 `vm`으로 로드하므로 서브모듈 체크아웃이 반드시 되어 있어야 한다.

의존성 설치:

```bash
cd rtsp-over-websocket
npm install
```

`typescript`, `vite`, `vitest`, `jsdom`은 루트 `package.json`의 devDependencies에 이미 포함되어 있다 — 별도 설치 불필요.

---

## 2. 빌드

```bash
cd rtsp-over-websocket
npm run build:player
# 내부적으로: cd src/player && tsc -b && vite build
```

성공 시 산출물:

- `dist/player/rtsp-over-websocket.esm.js` — ESM 빌드 (app-react 등 모던 소비자용)
- `dist/player/rtsp-over-websocket.global.js` — IIFE 빌드 (`customElements.define('rtsp-over-websocket', RTSPOverWebSocket)` 자동 등록, 레거시 `<script>` 소비자용)
- 워커 청크(6종, `worker/**/*.ts` — Vite가 `new Worker(new URL(...))` 호출부 자동 탐지, 수동 entry 등록 불필요)

`tsc -b`가 실패하면(타입 에러) `vite build`는 실행되지 않는다 — 항상 `tsc` 에러부터 해결한다.

**주의(작업 디렉토리)**: `tsc`/`vite`/`vitest` 명령은 반드시 `melchi45/rtsp-over-websocket/src/player/` 디렉토리에서 실행해야 한다(해당 위치의 `tsconfig.json`/`vite.config.ts`/`vitest.config.ts`를 참조). 상위 디렉토리에서 실행하면 `Cannot read file 'tsconfig.json'` 에러가 발생하거나(tsc), 명령이 응답 없이 멎는 것처럼 보일 수 있다(vitest가 잘못된 스코프에서 파일을 탐색). 증상이 나타나면 먼저 `pwd`로 현재 위치를 확인한다.

---

## 3. 테스트

```bash
cd rtsp-over-websocket
npm run test:player          # 전체 스위트 1회 실행 (vitest run)
npm run test:player:watch    # watch 모드
```

또는 `src/player` 디렉토리에서 직접:

```bash
cd rtsp-over-websocket/src/player
npx vitest run                              # 전체 스위트
npx vitest run custom/RTSPOverWebSocket.test.ts     # 특정 파일만
```

**환경**: 기본 환경은 `environment: 'node'`(빠름)이다. DOM/CustomElement가 필요한 파일(`custom/RTSPOverWebSocket.test.ts`)은 파일 최상단에 `// @vitest-environment jsdom` docblock을 선언해 파일 단위로 jsdom 환경을 사용한다 — `vitest.config.ts`의 전역 환경을 바꾸지 않는다.

**알려진 flaky 테스트**: `mediaSession/RtpSession.test.ts`의 "appendBuffer grows the buffer identically when it would overflow" 테스트는 전체 스위트를 동시 실행할 때 시스템 부하로 인해 5초 기본 타임아웃을 초과할 수 있다(격리 실행 시에는 안정적으로 통과). 재현되면 해당 파일만 단독으로 재실행해 확인한다:

```bash
npx vitest run mediaSession/RtpSession.test.ts
```

---

## 4. 신규 파일 포팅 작업 흐름 (Layer 12 등 후속 작업 시)

1. 레거시 소스 전체를 직접 읽는다(서브에이전트 요약만으로 포팅하지 않는다 — 정확한 버그 재현을 위해 원문 확인 필수).
2. 대응하는 `.ts` 파일을 `src/player/` 하위 적절한 디렉토리에 작성. Symbol-키 pseudo-private 메서드는 TS `private` 메서드로, `window.X = ...` 전역 할당은 named export로 변환.
3. 확인된 버그는 고치지 말고 인라인 주석(근거: 레거시 파일:라인번호)과 함께 그대로 포팅.
4. 순수 로직이면 `loadLegacyModule`/`loadLegacyModuleExports`/`loadLegacyModuleSlice`(`test-support/loadLegacyModule.ts`)로 parity 테스트 작성. DOM/Worker 등 부수효과가 있으면 fake/jsdom 기반 Contract 테스트 작성.
5. `tsc -b --force && vite build && npx vitest run`으로 전체 검증.
6. `docs/design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md`(레이어 상태 표), `docs/tc/TC_RTSP_Over_WebSocket_TypeScript_Migration.md`(신규 TC-RTSPWSTS-NNN)를 갱신.

---

## 5. 트러블슈팅

| 증상 | 원인 | 조치 |
|---|---|---|
| `tsc: error TS5083: Cannot read file 'tsconfig.json'` | 잘못된 디렉토리에서 실행 (`melchi45/rtsp-over-websocket/` 루트 등) | `cd rtsp-over-websocket/src/player`로 이동 후 재실행 |
| `vitest run`이 응답 없이 멎음 | 위와 동일 원인 — 잘못된 스코프에서 config 탐색 | `pwd`로 확인 후 올바른 디렉토리에서 재실행 |
| `RtpSession.test.ts`의 버퍼 성장 테스트 타임아웃 | 전체 스위트 동시 실행 시 시스템 부하(flaky) | 해당 파일만 단독 재실행하여 확인 |
| parity 테스트에서 `Cannot redefine property` (Date.prototype 등) | 레거시 파일이 `Date.prototype`을 `configurable:false`로 몽키패치하는데, 같은 테스트 파일 내에서 `loadLegacyModule`을 2회 이상 호출 | `loadLegacyModuleSlice`로 위험한 프리앰블 라인을 건너뛰고, 동일 함수를 host `Date.prototype`에 `configurable:true`로 1회만 별도 설치 (`worker/backup/BackupSession.test.ts` 참고) |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-30 | 초기 작성 — Layer 1-11 구현 완료 시점에 소급 작성 |
| 1.1 | 2026-08-04 | `melchi45/rtsp-over-websocket` 제거에 따라 Superseded로 상태 변경 — 이 문서가 다루는 빌드/테스트 워크플로는 이제 별도 저장소 `melchi45/rtsp-over-websocket`에서 수행됨. Design_RTSP_Over_WebSocket_TypeScript_Migration.md §9 참고 |
| 1.2 | 2026-08-10 | 문서 ID `OPS-LTS2026-UMP-TS-001` → `OPS-LTS2026-RTSPWS-TS-001`로 통일(연관 SRS/TC 추적 ID 리네임과 일관성 맞춤); 잔존 레거시 명칭 일괄 정리 — `Ump*` 식별자·`submodules/rtsp-over-websocket` 경로를 `@melchi45/rtsp-over-websocket` npm 패키지의 현행 명칭(`RTSPOverWebSocket*`, 별도 저장소 `melchi45/rtsp-over-websocket`)으로 전면 교체 |
