# DESIGN DOCUMENT
# UMP Player 레거시 JS → TypeScript/ESM 마이그레이션

| | |
|---|---|
| **Document ID** | DESIGN-LTS-UMP-TS-001 |
| **Version** | 1.2 |
| **Status** | Active (Layer 1-11 구현 완료, `custom/ump-player.ts`(신규 `custom/UmpPlayer.ts`) 포함 전 레이어 포팅 완료) |
| **Date** | 2026-07-30 |
| **Related Design** | [Design_UMP_Player_RTSP_over_WebSocket.md](Design_UMP_Player_RTSP_over_WebSocket.md) — 스코프 경계: 그 문서는 서버 통합/프로토콜(LTS 서버가 `<ump-player>`를 어떻게 소비하는지), 이 문서는 `submodules/ump-player` 라이브러리 **내부** 아키텍처(레거시 JS를 TS/ESM으로 재작성하는 방법)를 다룸 |
| **Parent PRD** | [PRD_UMP_Player_TypeScript_Migration.md](../prd/PRD_UMP_Player_TypeScript_Migration.md) |
| **Parent SRS** | [SRS_UMP_Player_TypeScript_Migration.md](../srs/SRS_UMP_Player_TypeScript_Migration.md) |
| **Related TC** | [TC_UMP_Player_TypeScript_Migration.md](../tc/TC_UMP_Player_TypeScript_Migration.md) |
| **Related Ops** | [UMP_Player_TypeScript_Migration_Ops.md](../ops/UMP_Player_TypeScript_Migration_Ops.md) |
| **Related Submodule** | [submodules/ump-player](../../submodules/ump-player) (`github.com/melchi45/ump-player`, 자체 `app/media`(`github.com/melchi45/ump`) 서브모듈 포함) |

---

## 1. 목적 및 범위

`submodules/ump-player/app/media/ump/`는 87개 파일·약 4.1만 줄 규모의 레거시 바닐라 JS 미디어 라이브러리로, `import`/`export` 없이 `window.X = ...` 전역 할당과 `<script src>` 순차 로딩에 의존한다. 테스트 러너가 전혀 없고(`"test": "grunt test"`는 jshint 정적분석일 뿐), 타입 안전성도 없다.

이 마이그레이션은 **`app/media`(별도 git 서브모듈)를 전혀 수정하지 않고**, `submodules/ump-player/src/player/`에 병행(parallel) TypeScript/ESM 구현을 새로 작성하며, 레이어별로 레거시와의 동등성(parity)을 테스트로 증명한다. 레거시 HTML 데모(`app/*.html`)와 `app/media` 서브모듈의 교체(cutover)는 이번 스코프에 포함하지 않는다 — 전 레이어가 parity를 증명한 이후의 별도 후속 결정.

---

## 2. 디렉토리 구조 (실제 구현 상태)

```
submodules/ump-player/src/player/
  tsconfig.json / vite.config.ts / vitest.config.ts
  exceptions/          # UmpError, AuthError, RTCPError, RTSPError, SunapiError
  util/                # UmpMap, Queue, CircularTypedArrayQueue, DigestGenerator,
                        # H264/H265 SPS Parser, CommonAudioUtil, IntervalTimer,
                        # BufferList, hex, binaryString, BrowserDetect, indexOfMulti,
                        # fastJsonStringfy, getElementByAttributeValue, fishEyeMesh,
                        # FishEye3D(Multi), Size, Median, Mean, cloneArray,
                        # formatBytes/formatBps, dateFormat(toYYYYMMDDHHMMSS)
  network/{http,rtspOverWebsocket,transport}/   # SunapiClient/Manager, RtspClient, Transport
  mediaSession/{audioSession,videoSession,textSession}/  # Session/RTCP/RTP + 코덱별 세션
  listen/{decoder,renderer}/  talk/{encoder}/    # 오디오 디코더·렌더러, Talk
  video/player/canvas/                           # Canvas/WebGL/MediaSource 렌더러
  interface/           # StreamPlayer, StreamManager (커스텀 엘리먼트가 소비하는 파사드)
  backup/              # BackupProvider
  worker/              # 워커 엔트리 6종 (mjpegSession, backup, videoDecoder,
                        # audioTranscoder, sunapi, zipWorker — 개별 Vite worker 번들)
  vendor/              # ffmpeg.js/.wasm, ffmpegAAC.decoder.js, ffmpegAAC.transcoder.js/.wasm,
                        # minizip-asm.js — 재작성 금지, .d.ts 래핑만
  custom/
    UmpPlayer.ts        # <ump-player> 커스텀 엘리먼트 (Layer 11, 최종 레이어)
    UmpPlayerTypes.ts    # UmpPlayType/UmpPlayState/UmpBestshotFilter/UmpPlaySpeed
    panelStyles.ts       # statistics/network-state/context-menu/gesture-overlay CSS 텍스트
    index.ts
  index.ts              # public entry — ESM export + customElements.define 등록 (`./custom` re-export 경유)
```

전체 141개 소스 파일(`.test.ts` 제외), 89개 테스트 파일, 539 테스트 (`npx vitest run` 기준, 2026-07-30).

---

## 3. 12-레이어 로드맵 — 최종 상태

| # | 레이어 | 상태 |
|---|---|---|
| 1 | Exception/* (5개) | ✅ 완료 |
| 2 | Util 순수 (hashMap, Queue, CircularTypedArrayQueue, digestGenerator, h264/h265SPSParser, audioUtil, fishEye3D×2) | ✅ 완료 |
| 3 | util.js 분리 + Network 순수 리프 | ✅ 완료 |
| 4 | Listen/Decoder/*, Talk/Encoder | ✅ 완료 |
| 5 | MediaSession 코어 + VideoSession/AudioSession/TextSession | ✅ 완료 |
| 6 | Network transport/RTSPoverWebsocket/http 클라이언트 | ✅ 완료 |
| 7 | MediaSession 허브(rtpClient, mediaRouter) | ✅ 완료 |
| 8 | Listen/Renderer, Talk.js, Video/Player/* | ✅ 완료 |
| 9 | Interface/*, Backup/* | ✅ 완료 |
| 10 | Worker 엔트리 6종 + vendor wrap (ffmpeg.js/ffmpegAAC.js×2/minizip-asm.js) | ✅ 완료 (+76 tests) |
| 11 | Custom/UmpPlayer.ts (커스텀 엘리먼트, 최종) | ✅ 완료 (+37 tests, jsdom) |
| 12 | angularInterface/*, Control/ptz/* | 부분 완료 — `angularInterface/*` ✅ 완료 (+19 tests), `Control/ptz/*` 미착수 |

`angularInterface/{streamCanvas,streamInterface,register}.ts`(AngularJS 연동 레이어)는 이미 포팅·테스트 완료되어 있다. `Control/ptz/ptzControlCommand.js`(코드베이스 어디서도 참조되지 않는 orphan 모듈)만 실사용 여부가 확인되지 않아 팀 확인 전까지 착수하지 않는다.

---

## 4. 빌드 산출물

Vite library mode, 듀얼 아웃풋:

- `dist/player/ump-player.esm.js` (ESM) — app-react 등 모던 소비자용
- `dist/player/ump-player.global.js` (IIFE) — 레거시 `<script>` 소비자용 하위호환. `customElements.define('ump-player', UmpPlayer)` 사이드이펙트가 `index.ts` → `custom/index.ts` → `custom/UmpPlayer.ts` 임포트 체인을 통해 이 두 번들 모두에 포함된다.

워커 엔트리 6개(`worker/**/*.ts`)는 `build.lib.entry`에 수동 등록하지 않는다 — Vite가 `new Worker(new URL(...))` 호출부를 자동 탐지해 별도 번들로 분리한다(`custom/UmpPlayer.ts`는 현재 스코프에서 워커를 직접 생성하지 않으며, 그 호출부는 `interface/StreamPlayer.ts`의 `MediaRouter`/`RtpClient` 경로에 있다).

`vite.config.ts`의 `worker: { format: 'iife' }`는 명시적으로 고정되어 있다 — 벤더 번들(ffmpeg.js 등)이 classic-script `importScripts()` 로딩에 의존하기 때문(ESM 워커 포맷에서는 vendor의 top-level `this` 해석이 깨짐).

**중요**: `index.ts`(및 하위 `custom/index.ts`)를 임포트하면 `HTMLElement`/`customElements`가 필요하다 — 브라우저/jsdom 환경 전용이며, 순수 Node 환경에서는 이 배럴을 임포트하면 안 된다. 기존 91개 테스트 파일 중 이 루트 배럴을 임포트하는 파일은 없음을 확인했다(레이어별 개별 모듈만 직접 임포트).

---

## 5. 테스트 전략

### 5.1 Parity 티어 (PURE)

입출력이 결정적인 순수 로직 모듈은 Node `vm` 모듈 기반 `loadLegacyModule`/`loadLegacyModuleExports`/`loadLegacyModuleSlice`(`test-support/loadLegacyModule.ts`)로 레거시 파일을 격리 로드해, 신규 구현과 동일 입력에 대한 출력을 `deep-equal`로 비교한다. Layer 1-10 전 파일이 이 티어로 커버된다.

주요 기법:
- 타입드 배열은 cross-realm `instanceof` 불일치 때문에 `ArrayBuffer.isView` 기반 `normalize()`로 변환 후 비교.
- `Date.prototype`/전역을 영구 변경하는 파일(`backupWorker.js`)은 `loadLegacyModuleSlice`로 위험한 프리앰블을 건너뛰고, 동일 함수를 host `Date.prototype`에 `configurable:true`로 1회만 설치.

### 5.2 Contract 티어 (BROWSER)

WebSocket/Canvas/Worker/CustomElement 등 부수효과가 있는 클래스는 old-vs-new 직접비교가 무의미하므로, 문서화된 공개 계약(속성/attribute/이벤트명·payload/메서드 시그니처)을 신 구현이 동일하게 노출하는지 검증한다. `custom/UmpPlayer.ts`는 **jsdom**(`// @vitest-environment jsdom` 파일별 지시자) 기반으로 실제 `customElements.define`/`connectedCallback`/`attributeChangedCallback` 라이프사이클을 구동해 검증한다(37 tests, `custom/UmpPlayer.test.ts`). 나머지 스위트는 기본 `environment: 'node'`(빠름)를 유지.

---

## 6. `custom/UmpPlayer.ts` — Layer 11 상세

레거시 `Custom/ump-player.js`(7312줄, 단일 `UmpPlayer extends HTMLElement` 클래스)의 라인 단위 포팅. 다음 원칙을 따른다:

- **Symbol-키 pseudo-private 메서드**(`[dispatch]`, `[statistics_div]`, `[contextmenu_div]` 등 legacy의 `Symbol()` 프로퍼티 키)는 TS `private` 메서드로 기계적 변환 — 아무 것도 이 Symbol들을 리플렉션하지 않으므로 동작 변화 없음.
- **CSS 텍스트 블록**(통계/네트워크상태/컨텍스트메뉴/제스처 오버레이 패널을 빌드하는 `[appendStyle](...)` 인라인 문자열, 약 700줄)은 `custom/panelStyles.ts`로 추출 — 로직 변경 없이 파일 길이만 축소.
- **클래스 자체는 분할하지 않음** — 단일 커스텀 엘리먼트·단일 legacy prototype이며, `this` 바인딩에 의존하는 버그 재현 정확성을 위해 컴포지션으로 쪼개는 리팩터링을 의도적으로 배제했다.

### 6.1 확인된 레거시 버그 (포팅 시 그대로 보존, 수정하지 않음)

아래는 대표적인 항목이며, 전체 목록과 정확한 근거(라인 번호·재현 방법)는 `custom/UmpPlayer.ts` 각 메서드/접근자의 인라인 주석에 있다.

| 증상 | 근거 위치 (레거시) | 포팅 결과 |
|---|---|---|
| `background`/`useClockRange` 접근자 3중 재선언 충돌 — 마지막 선언(`useClockRange`용으로 오기된 `set background`)만 실제로 적용됨 | ump-player.js:2605-2649 | `background` setter가 `_useClockRange`를 변경, `_updateRendering()` 호출 안 됨. `useClockRange`는 getter-only(대입 시 TypeError) |
| `grunt` getter가 참조하는 `_useGrunt`가 어디서도 초기화되지 않음 | ump-player.js (전역 grep 확인) | `element.grunt`는 항상 `undefined` 반환, setter는 `info.device.serverType`만 갱신 |
| `audioshift` getter가 `type` getter와 동일 본문 복붙 | ump-player.js:2814-2816 | 항상 `info.media.mode`를 반환, 실제 오디오 시프트 값 추적 없음 |
| `seekingTime` setter의 연산자 우선순위 오류(`!this._playType === X`) | ump-player.js:1848 | ISO 시간 형식 검증이 항상 죽은 코드 |
| `GMT` setter의 느슨한 유효성 검사 | ump-player.js:2429 | `v===undefined`일 때만 throw, 그 외 비정상 타입은 무검증 통과 |
| `playSpeed`의 0.125x/-0.125x가 0.12/-0.12로 절삭 | ump-player.js:2150-2156, 2209-2215 | 약 4% 속도 오차 재현 |
| `[generateRTSPURL]`의 `case ' live':` (앞 공백 오타) | ump-player.js:5730 | NVR 분기에서 해당 case 영원히 매치 안 됨(항상 default) |
| `speed()`의 카메라 분기에서 `.url` 대신 `.utl`에 대입(오타) | ump-player.js:6511 | 카메라 재생속도 변경 시 RTSP URL이 실제로 갱신되지 않음 |
| `onUmpError`의 `0x0000`/`0x0001` 케이스에서 `playType === LIVE && playType === PLAYBACK` (동시에 참일 수 없음) | ump-player.js:4671-4673, 4695-4697 | 미니맵 갱신 분기가 항상 죽은 코드 |
| `[updateMetaImage]`의 후반부 전체가 `[updateMinimap]` 복붙 | ump-player.js:1475-1589 | `#minimap_<id>` 엘리먼트를 잘못 조회하고 `cmd:'minimap'`을 무조건 전송 |
| `_updateSunapiManager()` catch 핸들러의 404/490/401 분류 가드가 `error instanceof AuthError && error instanceof SunapiError`(동시 성립 불가) | ump-player.js:3047-3048 | 해당 AuthError 재throw 로직 전부 죽은 코드 |
| `connectedCallback`의 `info.media.element !== null && info.media.element !== null` (동일 절 중복, `!== undefined` 의도) | ump-player.js:1117 | `id` 속성 누락 시에도 `_updateRendering()`이 여전히 실행됨(console.warn만 발생) |
| `attributeChangedCallback`의 `'android'` 케이스 — attribute 값은 항상 string이라 `typeof newValue !== 'boolean'`이 항상 참 | ump-player.js:940-956 | 마크업으로 `android` 속성을 설정하면 항상 throw (connectedCallback은 별도 경로로 우회) |

---

## 7. 문서 세트 현황

원 계획(Phase 0)의 6개 SDD 문서(MRD/PRD/SRS/Design/Ops/TC)가 모두 작성 완료되었다. Layer 12의 `Control/ptz/*`는 팀 확인 전까지 착수하지 않으므로, 착수 시점에 관련 내용을 추가한다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-30 | 초기 작성 — Layer 1-11 전체 포팅 완료 반영 (Layer 11: `custom/UmpPlayer.ts`, 141 source files, 89 test files, 539 tests) |
| 1.1 | 2026-07-30 | MRD/PRD/SRS/Ops 문서 신규 작성 완료 반영 — Related PRD/SRS/Ops 헤더 추가, §7 갱신 |
| 1.2 | 2026-07-30 | Layer 12 상태 오기 수정 — `angularInterface/*`는 이미 포팅·테스트 완료(+19 tests) 상태였는데 "미착수"로 잘못 기재되어 있던 것을 수정. 미착수인 것은 `Control/ptz/*`뿐 |
