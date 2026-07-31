# MARKET REQUIREMENTS DOCUMENT (MRD)
# UMP Player 레거시 JS → TypeScript/ESM 마이그레이션

| | |
|---|---|
| **Document Reference** | MRD-LTS2026-UMP-TS-01 |
| **Product** | LTS-2026 Loitering Detection & Tracking System (submodule: ump-player) |
| **Feature** | `submodules/ump-player/app/media/ump` 레거시 바닐라 JS → `submodules/ump-player/src/player` TypeScript/ESM 병행 재작성 |
| **Version** | 1.1 |
| **Date** | 2026-07-30 |
| **Status** | Active (구현 완료 — Layer 1-11) |
| **Related Design** | [Design_UMP_Player_TypeScript_Migration.md](../design/Design_UMP_Player_TypeScript_Migration.md) |
| **Related PRD** | [PRD_UMP_Player_TypeScript_Migration.md](../prd/PRD_UMP_Player_TypeScript_Migration.md) |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) (submodule: [github.com/melchi45/ump-player](https://github.com/melchi45/ump-player)) |

---

## 1. Executive Summary

LTS-2026은 카메라 재생 경로 중 하나로 Hanwha(Wisenet) `<ump-player>` 웹 컴포넌트를 사용한다([Design_UMP_Player_RTSP_over_WebSocket.md](../design/Design_UMP_Player_RTSP_over_WebSocket.md) 참고). 이 컴포넌트가 속한 라이브러리(`submodules/ump-player/app/media/ump`)는 87개 파일·약 4.1만 줄 규모의 2010년대식 바닐라 JavaScript로, `import`/`export`가 전혀 없고 `window.X = ...` 전역 할당과 `<script src>` 순차 로딩에 전적으로 의존한다. 테스트 러너가 설치되어 있지 않아(`"test": "grunt test"`는 실제로는 jshint 정적분석일 뿐) 회귀 방지 수단이 없고, 타입 시스템이 없어 리팩터링·신규 기능 추가 시 런타임 오류를 사전에 잡을 수 없다.

이 문서는 이 라이브러리를 TypeScript/ESM으로 병행 재작성(`submodules/ump-player/src/player/`)하는 시장/엔지니어링 필요성을 정리한다. LTS-2026 프로젝트 전체가 React/TypeScript 스택으로 이동하는 시점에서, 이 서드파티 유래 라이브러리만 타입 안전성·테스트 가능성이 없는 상태로 남아 있는 것이 기술 부채로 확인되었다.

---

## 2. Pain Point (엔지니어링/운영 관점)

| Pain Point | Impact |
|---|---|
| 테스트 러너 부재 — 회귀를 검증할 자동화된 수단이 전혀 없음 | 카메라 재생 관련 버그 수정 시마다 실제 카메라로 수동 검증해야 하며, 회귀가 프로덕션에서야 발견됨(실제로 `Design_UMP_Player_RTSP_over_WebSocket.md`의 revision history에 기록된 다수의 사후 발견 버그가 이를 방증) |
| 타입 시스템 부재 | `this.info.device.xxx`처럼 느슨하게 형성된 객체 그래프에 오타·타입 불일치가 있어도 컴파일 타임에 잡히지 않고 런타임에야 드러남(예: `speed()`의 `.url` vs `.utl` 오타, `grunt` getter/setter 필드명 불일치 등 — 이번 마이그레이션 과정에서 다수 확인) |
| ESM 부재로 인한 암묵적 전역 스코프 의존 | `Worker/Backup/backupWorker.js`가 `inheritObject()`를 정의하기 *전에* 이를 사용하는 파일을 `importScripts`하는 등, 스크립트 로딩 순서에 암묵적으로 의존하는 코드가 존재 — 번들러 기반 빌드로 전환 시 명시적 import 없이는 재현 불가능한 구조 |
| 빌드 도구 노후화 | Grunt + Browserify + Babel(ES2015→ES5) 체인으로, LTS-2026 프로젝트의 나머지 부분(Vite + React 19 + TS)과 완전히 이질적인 툴체인 |
| 신규 개발자 온보딩 부담 | 87개 파일이 서로 어떻게 연결되는지 타입/모듈 경계 없이 전역 스코프로만 추적 가능해, 코드 이해·안전한 수정에 필요한 시간이 김 |

---

## 3. 대상 세그먼트

| 이해관계자 | 컨텍스트 |
|---|---|
| LTS-2026 서버/클라이언트 개발팀 | `app-react`(Vite+React19+TS) 개발 하네스가 이미 이 라이브러리를 심볼릭 링크로 소비 중 — 타입 안전한 소비 경험이 필요 |
| 향후 이 라이브러리를 유지보수할 엔지니어 | 회귀 테스트 없이 프로덕션 카메라 재생 로직을 수정해야 하는 리스크를 낮출 필요 |

---

## 4. 성공 지표

- 87개 레거시 파일에 대응하는 TypeScript 구현이 `src/player/`에 존재하고, 각각 old-vs-new parity 테스트 또는 문서화된 공개 계약(Contract) 테스트로 검증됨.
- `tsc -b`(strict 모드) + `vite build`(ESM+IIFE 듀얼 아웃풋)가 0 에러로 통과.
- `app/media`(레거시, 별도 git 서브모듈) 저장소는 전혀 수정하지 않음 — 병행 구현만 추가.
- 확인된 기존 버그는 문서화하되, 사용자 동의 없이 임의로 "수정"하지 않음(동작 회귀를 피하기 위해 레거시와 100% 동일한 버그-호환 동작 유지).

**달성 현황(2026-07-30 기준):** 12개 레이어 중 11개 완료(Layer 1-11), 141개 소스 파일·89개 테스트 파일·539개 테스트, `tsc`/`vite build`/`vitest` 전부 clean. Layer 12는 `angularInterface/*`(streamCanvas.ts/streamInterface.ts/register.ts, 19 tests)까지는 이미 포팅되어 있으나, `Control/ptz/ptzControlCommand.js`(어디서도 참조되지 않는 orphan 모듈)는 실사용 여부 미확인으로 아직 포팅하지 않았다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-30 | 초기 작성 — Layer 1-11 구현 완료 시점에 소급 작성 |
| 1.1 | 2026-07-30 | 달성 현황 Layer 12 상태 오기 수정 — `angularInterface/*`는 이미 포팅 완료(+19 tests) 상태였는데 "로드맵만"으로 잘못 기재되어 있던 것을 수정. 미착수인 것은 `Control/ptz/*`뿐 |
