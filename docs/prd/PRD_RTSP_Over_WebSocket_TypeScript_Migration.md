# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# RTSP-over-WebSocket 레거시 JS → TypeScript/ESM 마이그레이션

| | |
|---|---|
| **Document ID** | PRD-LTS-RTSPWS-TS-01 |
| **Version** | 1.3 |
| **Status** | Active (구현 완료 — Layer 1-11) |
| **Date** | 2026-07-30 |
| **Related MRD** | [MRD_RTSP_Over_WebSocket_TypeScript_Migration.md](../mrd/MRD_RTSP_Over_WebSocket_TypeScript_Migration.md) |
| **Related Design** | [Design_RTSP_Over_WebSocket_TypeScript_Migration.md](../design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md) |

---

## Table of Contents

1. [제품 비전](#1-제품-비전)
2. [목표 및 비목표](#2-목표-및-비목표)
3. [사용자 스토리](#3-사용자-스토리)
4. [기술 접근 방식](#4-기술-접근-방식)
5. [기능 명세 — 12-레이어 로드맵](#5-기능-명세--12-레이어-로드맵)
6. [테스트 계약](#6-테스트-계약)
7. [Edge Case / 발견된 기존 이슈](#7-edge-case--발견된-기존-이슈)
8. [마일스톤](#8-마일스톤)

---

## 1. 제품 비전

`melchi45/rtsp-over-websocket/app/media`(레거시 바닐라 JS, 87개 파일)와 100% 기능 동등한 TypeScript/ESM 구현을 `melchi45/rtsp-over-websocket/src/player/`에 병행 작성한다. 핵심 원칙은 **"기존과 동일한 기능"을 테스트로 증명하며, 레거시(`app/media`, 별도 git 서브모듈)는 전혀 건드리지 않는 것**이다. 확인된 기존 버그는 "고치는 것"이 아니라 "동일하게 재현하는 것"이 목표다 — 이 마이그레이션은 리팩터링이 아니라 이식(porting)이다.

---

## 2. 목표 및 비목표

### 2.1 목표

- 레거시 87개 파일 각각에 대응하는 TS 구현과 parity/contract 테스트 확보.
- Vite library mode로 ESM + IIFE(전역 등록) 듀얼 빌드 산출.
- TypeScript strict 모드, `any` 금지(vendor 경계는 `unknown` + 명시적 wrapper로 격리).
- 확인된 레거시 버그를 문서화하고 그대로 재현(사일런트 수정 금지).
- `app/*.html` 레거시 데모, `app/media` 서브모듈은 이번 스코프에서 수정하지 않음.

### 2.2 비목표

- 레거시 HTML 데모 페이지의 즉시 교체(cutover) — 전 레이어 parity 증명 이후의 별도 후속 결정.
- `angularInterface/*`(AngularJS 연동 여부 불명확), `Control/ptz/ptzControlCommand.js`(orphan 모듈, 어디서도 참조되지 않음) — 팀 확인 전까지 최하위 우선순위로 로드맵에만 존재.
- 레거시 버그의 "수정" — 발견된 버그는 문서화하고 동일하게 재현하는 것이 원칙(이번 스코프에서 예외 없음).

---

## 3. 사용자 스토리

- **엔지니어로서** 나는 `<rtsp-over-websocket>` 라이브러리의 특정 파일을 수정할 때, 그 파일에 대응하는 TS 버전과 parity 테스트가 있어서 회귀 여부를 즉시 확인하고 싶다.
- **엔지니어로서** 나는 이 라이브러리를 타입 힌트와 함께 사용해, `info.device.xxx` 같은 느슨한 객체 그래프를 다룰 때 오타나 타입 불일치를 컴파일 타임에 잡고 싶다.
- **엔지니어로서** 나는 레거시의 알려진 버그(예: `playSpeed`의 0.125x 절삭, `background`/`useClockRange` 접근자 충돌)를 코드 주석에서 바로 확인하고 싶다 — 사후에 "왜 이렇게 동작하지?"를 재조사하지 않도록.

---

## 4. 기술 접근 방식

- **빌드**: Vite library mode. ESM(`rtsp-over-websocket.esm.js`) + IIFE(`rtsp-over-websocket.global.js`) 듀얼 아웃풋. 워커 엔트리 6종은 Vite가 `new Worker(new URL(...))` 호출부를 자동 탐지해 별도 번들로 분리(`worker: { format: 'iife' }` — classic-script `importScripts()` vendor 로딩 때문에 명시적으로 고정).
- **테스트**: Vitest 신규 도입.
  - **Parity 티어(PURE)**: Node `vm` 모듈로 레거시 파일을 격리 로드해 신규 구현과 동일 입력에 대한 출력을 비교.
  - **Contract 티어(BROWSER)**: WebSocket/Canvas/Worker/CustomElement 등 부수효과가 있는 클래스는 문서화된 공개 계약을 검증. `custom/RTSPOverWebSocket.ts`(커스텀 엘리먼트)는 jsdom(`// @vitest-environment jsdom`)으로 실제 라이프사이클 구동.
- **Vendor 파일**(`ffmpeg.js`, `ffmpegAAC.js`×2, `minizip-asm.js`): 원본 그대로 복사, `.d.ts` 래핑만 — 로직 재작성 없음.
- **의존성 순서 명시화**: 레거시의 암묵적 스크립트 로딩 순서 의존(`inheritObject()` 등)은 명시적 `import`로 전환(Layer 10에서 강제).

---

## 5. 기능 명세 — 12-레이어 로드맵

전체 로드맵과 각 레이어의 완료 상태는 [Design_RTSP_Over_WebSocket_TypeScript_Migration.md §3](../design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md#3-12-레이어-로드맵--최종-상태)를 참조한다. 요약:

| 레이어 범위 | 상태 |
|---|---|
| Layer 1-9 (Exception, Util, Network, Listen/Talk, MediaSession, Interface/Backup) | ✅ 완료 |
| Layer 10 (Worker 엔트리 6종 + vendor wrap) | ✅ 완료 |
| Layer 11 (`custom/RTSPOverWebSocket.ts` 커스텀 엘리먼트, 최종 레이어) | ✅ 완료 |
| Layer 12 (angularInterface/*, Control/ptz/*) | 부분 완료 — `angularInterface/*` ✅ 완료(+19 tests), `Control/ptz/*` 미착수(최하위 우선순위) |

---

## 6. 테스트 계약

레이어별 자동화된 테스트 케이스는 [TC_RTSP_Over_WebSocket_TypeScript_Migration.md](../tc/TC_RTSP_Over_WebSocket_TypeScript_Migration.md)(TC-RTSPWSTS-001~013)에 전부 기록되어 있다. 요구되는 최소 기준:

- 순수 로직 파일: old-vs-new parity 테스트 필수.
- DOM/Worker/WebSocket 등 부수효과가 있는 클래스: 문서화된 공개 계약(속성/attribute/이벤트명·payload/메서드 시그니처) 대비 Contract 테스트 필수.
- 전체 스위트는 `npx vitest run` 단일 명령으로 실행 가능해야 하며, 수동 검증 단계가 없어야 한다(브라우저/실 카메라 연동이 필요 없는 라이브러리 레벨 코드이므로).

---

## 7. Edge Case / 발견된 기존 이슈

마이그레이션 과정에서 확인된, **이번 스코프에서 수정하지 않는** 기존 결함(전체 목록은 `custom/RTSPOverWebSocket.ts` 등 각 포트 파일의 인라인 주석 및 [Design_RTSP_Over_WebSocket_TypeScript_Migration.md §6.1](../design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md#61-확인된-레거시-버그-포팅-시-그대로-보존-수정하지-않음)):

- `app/camera.html`이 현재 트리에 없는 파일(`Util/sunapi.js`, `Video/Renderer/*`, `Workers/workerManager.js`)을 참조 — 이미 깨져 있었음, 이번 마이그레이션과 무관.
- `Worker/sunapi/sunapiRequestTask.js`가 워커 컨텍스트에서 정의되지 않은 `fastJsonStringfy`(메인 스레드 전역)를 호출 — 사실상 REST 클라이언트 디스패치 로직 전체가 비활성 상태.
- `MediaSession/rtcpSession.js`의 `RTCPSession`과 `VideoSession/videoRtcpSession.js`의 `RtcpSession` — 대소문자만 다른 네이밍 충돌(포팅 시 그대로 유지, 리네이밍하지 않음).
- `custom/RTSPOverWebSocket.ts`(구 `rtsp-over-websocket.js`)의 접근자 버그 20여 건(`background`/`useClockRange` 3중 재선언 충돌, `grunt` getter/setter 불일치, `playSpeed` 절삭, `GMT` 느슨한 검증 등) — Design 문서 §6.1 표 참조.

---

## 8. 마일스톤

| 마일스톤 | 상태 | 비고 |
|---|---|---|
| Phase 0 — 툴체인(tsconfig/vite/vitest) + 문서 계획 | ✅ 완료 | |
| Phase 1 — Exception + 순수 Util (Layer 1-2) | ✅ 완료 | |
| Layer 3-9 | ✅ 완료 | |
| Layer 10 — Worker 엔트리 + vendor wrap | ✅ 완료 | +76 tests |
| Layer 11 — `custom/RTSPOverWebSocket.ts` | ✅ 완료 | +37 tests (jsdom) |
| 전체 빌드/테스트 최종 검증 | ✅ 완료 | 89 files / 539 tests, tsc+vite 0 에러 |
| MRD/PRD/SRS/Ops 문서 소급 작성 | ✅ 완료 (본 문서 포함) | |
| Layer 12 — `angularInterface/*` | ✅ 완료 | +19 tests |
| Layer 12 — `Control/ptz/*` | 미착수 | 팀 확인 후 착수 여부 결정 |
| 레거시 `app/*.html` 데모 cutover | 미착수 | 이번 스코프 밖, 별도 후속 결정 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-30 | 초기 작성 — Layer 1-11 구현 완료 시점에 소급 작성 |
| 1.1 | 2026-07-30 | Layer 12 상태 오기 수정 — `angularInterface/*`는 이미 포팅·테스트 완료(+19 tests) 상태였는데 "미착수"로 잘못 기재되어 있던 것을 수정. 미착수인 것은 `Control/ptz/*`뿐 |
| 1.2 | 2026-08-04 | 이 마이그레이션의 결과물이 `@melchi45/rtsp-over-websocket@1.0.1`로 npm 배포되고 LTS-2026에 채택되면서 `melchi45/rtsp-over-websocket` 서브모듈 자체가 제거됨 — Design_RTSP_Over_WebSocket_TypeScript_Migration.md §9(Superseded/Shipped) 참고 |
| 1.3 | 2026-08-10 | 문서 ID `PRD-LTS-UMP-TS-01` → `PRD-LTS-RTSPWS-TS-01`로 통일(연관 SRS/TC의 `FR-UMPTS-*`/`TC-UMPTS-*` 추적 ID가 `FR-RTSPWSTS-*`/`TC-RTSPWSTS-*`로 리네임된 것과 일관성 맞춤 — 역사적 기록 보존 원칙은 유지, ID 체계만 통일); 잔존 레거시 명칭 일괄 정리 — `Ump*` 식별자·`submodules/rtsp-over-websocket` 경로를 `@melchi45/rtsp-over-websocket` npm 패키지의 현행 명칭(`RTSPOverWebSocket*`, 별도 저장소 `melchi45/rtsp-over-websocket`)으로 전면 교체 |
