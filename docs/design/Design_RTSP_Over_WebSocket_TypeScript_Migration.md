# DESIGN DOCUMENT
# RTSP-over-WebSocket 레거시 JS → TypeScript/ESM 마이그레이션

| | |
|---|---|
| **Document ID** | DESIGN-LTS-RTSPWS-TS-001 |
| **Version** | 1.5 |
| **Status** | **Superseded/Shipped** (2026-08-04) — 이 문서가 다루는 재작성 결과물이 `@melchi45/rtsp-over-websocket@1.0.1`(npm, GitHub Packages)로 정식 배포되고 LTS-2026이 그걸 채택하면서, 이 문서가 다루던 `melchi45/rtsp-over-websocket` 서브모듈 자체가 제거됨(§9). 이하 §1~§8은 그 서브모듈 안에서 이 마이그레이션이 어떻게 진행됐는지의 **역사적 기록**으로 보존 — 이전 상태: Active (Layer 1-11 구현 완료, `custom/rtsp-over-websocket.ts`(신규 `custom/RTSPOverWebSocket.ts`) 포함 전 레이어 포팅 완료; 2026-07-31 실카메라 라이브 재생 검증 및 포팅 회귀 수정 완료) |
| **Date** | 2026-08-04 |
| **Related Design** | [Design_RTSP_Over_WebSocket.md](Design_RTSP_Over_WebSocket.md) — 스코프 경계: 그 문서는 서버 통합/프로토콜(LTS 서버가 `<rtsp-over-websocket>`를 어떻게 소비하는지), 이 문서는 `melchi45/rtsp-over-websocket` 라이브러리 **내부** 아키텍처(레거시 JS를 TS/ESM으로 재작성하는 방법)를 다룸 |
| **Parent PRD** | [PRD_RTSP_Over_WebSocket_TypeScript_Migration.md](../prd/PRD_RTSP_Over_WebSocket_TypeScript_Migration.md) |
| **Parent SRS** | [SRS_RTSP_Over_WebSocket_TypeScript_Migration.md](../srs/SRS_RTSP_Over_WebSocket_TypeScript_Migration.md) |
| **Related TC** | [TC_RTSP_Over_WebSocket_TypeScript_Migration.md](../tc/TC_RTSP_Over_WebSocket_TypeScript_Migration.md) |
| **Related Ops** | [RTSP_Over_WebSocket_TypeScript_Migration_Ops.md](../ops/RTSP_Over_WebSocket_TypeScript_Migration_Ops.md) |
| **Related Package** | [@melchi45/rtsp-over-websocket](https://github.com/melchi45/rtsp-over-websocket) (npm, GitHub Packages — `client/node_modules/@melchi45/rtsp-over-websocket/`로 설치됨; 구 서브모듈은 제거됨, §9 참고) |

---

## 1. 목적 및 범위

`melchi45/rtsp-over-websocket/app/media/`는 87개 파일·약 4.1만 줄 규모의 레거시 바닐라 JS 미디어 라이브러리로, `import`/`export` 없이 `window.X = ...` 전역 할당과 `<script src>` 순차 로딩에 의존한다. 테스트 러너가 전혀 없고(`"test": "grunt test"`는 jshint 정적분석일 뿐), 타입 안전성도 없다.

이 마이그레이션은 **`app/media`(별도 git 서브모듈)를 전혀 수정하지 않고**, `melchi45/rtsp-over-websocket/src/player/`에 병행(parallel) TypeScript/ESM 구현을 새로 작성하며, 레이어별로 레거시와의 동등성(parity)을 테스트로 증명한다. 레거시 HTML 데모(`app/*.html`)와 `app/media` 서브모듈의 교체(cutover)는 이번 스코프에 포함하지 않는다 — 전 레이어가 parity를 증명한 이후의 별도 후속 결정.

---

## 2. 디렉토리 구조 (실제 구현 상태)

```
melchi45/rtsp-over-websocket/src/player/
  tsconfig.json / vite.config.ts / vitest.config.ts
  exceptions/          # RTSPOverWebSocketError, AuthError, RTCPError, RTSPError, SunapiError
  util/                # RTSPOverWebSocketMap, Queue, CircularTypedArrayQueue, DigestGenerator,
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
    RTSPOverWebSocket.ts        # <rtsp-over-websocket> 커스텀 엘리먼트 (Layer 11, 최종 레이어)
    RTSPOverWebSocketTypes.ts    # RTSPOverWebSocketPlayType/RTSPOverWebSocketPlayState/RTSPOverWebSocketBestshotFilter/RTSPOverWebSocketPlaySpeed
    panelStyles.ts       # statistics/network-state/context-menu/gesture-overlay CSS 텍스트
    index.ts
  index.ts              # public entry — ESM export + customElements.define 등록 (`./custom` re-export 경유)
```

전체 141개 소스 파일(`.test.ts` 제외), 89개 테스트 파일, 539 테스트 (`npx vitest run` 기준, 2026-07-31).

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
| 11 | Custom/RTSPOverWebSocket.ts (커스텀 엘리먼트, 최종) | ✅ 완료 (+37 tests, jsdom) |
| 12 | angularInterface/*, Control/ptz/* | 부분 완료 — `angularInterface/*` ✅ 완료 (+19 tests), `Control/ptz/*` 미착수 |

`angularInterface/{streamCanvas,streamInterface,register}.ts`(AngularJS 연동 레이어)는 이미 포팅·테스트 완료되어 있다. `Control/ptz/ptzControlCommand.js`(코드베이스 어디서도 참조되지 않는 orphan 모듈)만 실사용 여부가 확인되지 않아 팀 확인 전까지 착수하지 않는다.

---

## 4. 빌드 산출물

Vite library mode, 듀얼 아웃풋:

- `dist/player/rtsp-over-websocket.esm.js` (ESM) — app-react 등 모던 소비자용
- `dist/player/rtsp-over-websocket.global.js` (IIFE) — 레거시 `<script>` 소비자용 하위호환. `customElements.define('rtsp-over-websocket', RTSPOverWebSocket)` 사이드이펙트가 `index.ts` → `custom/index.ts` → `custom/RTSPOverWebSocket.ts` 임포트 체인을 통해 이 두 번들 모두에 포함된다.

워커 엔트리 6개(`worker/**/*.ts`)는 `build.lib.entry`에 수동 등록하지 않는다 — Vite가 `new Worker(new URL('...', import.meta.url))` 호출부를 자동 탐지해 별도 번들로 분리한다. 실제 호출부 6곳(모두 생성자 기본 파라미터로 팩토리 주입, 테스트에서 교체 가능): `video/player/video/VideoTagPlayer.ts`(audiotranscoderWorker), `video/player/canvas/CanvasTagPlayer.ts`(decoderWorker), `mediaSession/videoSession/MjpegSession.ts`(mjpegDepacketizeWorker), `backup/FileMaker.ts`(zipWorker), `backup/BackupProvider.ts`(backupWorker), `network/http/SunapiRestClient.ts`(sunapiRequestTask). §6에서 이 6곳 전부의 런타임 URL 해석 문제와 수정 내역을 다룬다.

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

WebSocket/Canvas/Worker/CustomElement 등 부수효과가 있는 클래스는 old-vs-new 직접비교가 무의미하므로, 문서화된 공개 계약(속성/attribute/이벤트명·payload/메서드 시그니처)을 신 구현이 동일하게 노출하는지 검증한다. `custom/RTSPOverWebSocket.ts`는 **jsdom**(`// @vitest-environment jsdom` 파일별 지시자) 기반으로 실제 `customElements.define`/`connectedCallback`/`attributeChangedCallback` 라이프사이클을 구동해 검증한다(37 tests, `custom/RTSPOverWebSocket.test.ts`). 나머지 스위트는 기본 `environment: 'node'`(빠름)를 유지.

---

## 6. Worker 런타임 아키텍처 — 경로 해석과 Emscripten 부트스트랩

Layer 10에서 6개 워커 엔트리(`worker/**/*.ts`)의 소스 포팅과 유닛 테스트는 완료되어 있었으나, **번들이 실제로 브라우저·실카메라 환경에서 로드되는지는 검증되지 않은 상태**였다. 2026-07-31에 `wss://<host>/StreamingServer`로 실제 카메라(H.265/G.711)에 연결해 라이브 재생을 검증하는 과정에서, 포팅 과정에 도입된 2가지 회귀(regression)를 발견·수정했다. 레거시 자체의 버그가 아니라 **TS/ESM 재작성 중 새로 생긴 문제**라는 점에서 §7.1의 "레거시 버그 보존" 목록과는 성격이 다르다.

### 6.1 IIFE 빌드의 `import.meta.url` 폴리필 한계 — 데모 페이지는 ESM을 로드해야 함

`new Worker(new URL('./worker.ts', import.meta.url))` 패턴은 Vite의 빌드타임 워커 청크 분리(§4)에는 항상 정상 동작하지만, **IIFE(`rtsp-over-websocket.global.js`) 런타임에서 `import.meta.url`을 흉내내는 폴리필은 `document.currentScript`에 의존**한다. `document.currentScript`는 `<script>` 태그가 파싱되는 동안의 동기 실행 구간에서만 유효하고, 이 플레이어의 워커들은 전부 실제 RTP 데이터가 도착한 뒤 지연 생성되므로(스크립트 로드가 끝난 지 한참 뒤) 그 시점엔 이미 `null`이다. Vite는 이때 `document.baseURI`(현재 **페이지** URL)로 폴백하는데, 이는 스크립트 자신의 실제 위치와 다를 수 있어 워커 청크 경로가 한 디렉토리 얕게(`/assets/foo.js`, 정상은 `/player/assets/foo.js`) 계산되고, 그 경로가 서버의 SPA 폴백에 걸려 HTML을 돌려받으면 `Uncaught SyntaxError: Unexpected token '<'`로 나타난다.

**ESM(`rtsp-over-websocket.esm.js`)은 이 문제가 원천적으로 없다** — ESM의 `import.meta.url`은 폴리필이 아니라 모듈별로 정적 바인딩되는 언어 차원의 값이라, 워커가 스크립트 로드 이후 언제 생성되든 항상 정확하다. 따라서:

- `dist/index.html`(실제 재생 데모)은 `<script type="module" src="./player/rtsp-over-websocket.esm.js">`를 사용한다 — `<script src="...global.js">` 금지.
- `dist/test.html`(순수 계약 테스트 러너, `window.RTSPOverWebSocketLib` 전역 참조)은 실제 Worker를 한 번도 생성하지 않으므로 IIFE(`rtsp-over-websocket.global.js`)를 그대로 사용해도 안전하다.
- `vite.config.ts`에 `base: './'`를 추가했다 — 기본값 `base: '/'`는 워커/청크 URL을 origin-절대경로(`/assets/...`)로 굳혀버려, `dist/player/`가 사이트 루트가 아닌 임의의 서브패스(`/rtsp-ws/`, `/rtsp-over-websocket-react/` 등)에 배포될 때 항상 깨진다. `'./'`는 실행 중인 스크립트 자신의 위치 기준 상대경로를 강제해 배포 경로에 무관하게 동작하게 한다.

### 6.2 `Module.wasmBinary` 경쟁 조건 — wasm 선-fetch 후 `importScripts()`

`AssemblyDecoder.ts`/`AssemblyTranscoder.ts`(§3 Layer 10)는 벤더 Emscripten 글루(`vendor/ffmpeg.js`, `vendor/ffmpegAAC.transcoder.js`)를 `importScripts()`로 로드한다. 이 글루의 `createWasm()`은 자기 자신의 최상위 동기 실행 구간에서 `Module["wasmBinary"]`를 확인해, 있으면 그대로 쓰고 없으면 **자기 안에 하드코딩된 파일명**(`"ffmpeg.wasm"`/`"ffmpegAAC.wasm"`)을 워커 자신의 위치(`self.location.href`) 기준으로 직접 `fetch()`한다.

포팅 시 `importScriptsFn(...)`을 먼저 호출하고 `fetchFn(...).then(buffer => Module.wasmBinary = buffer)`를 그 뒤에 거는 순서였는데, `fetch().then()`은 본질적으로 비동기라 글루의 동기 `createWasm()`이 항상 먼저 실행되어 `Module.wasmBinary`를 못 보고 자체 fetch로 넘어간다. 이 프로젝트의 빌드는 vendor wasm/js를 별도 파일이 아니라 워커 청크 안에 base64 `data:` URL로 인라인하므로(§4), 저 하드코딩된 상대경로 파일은 애초에 디스크에 존재하지 않는다 → 정적 서버가 SPA 폴백 HTML(또는 순수 텍스트 404)을 돌려주고, 그걸 wasm으로 인스턴스화하려다 `WebAssembly.instantiate(): expected magic word 00 61 73 6d, found ...`로 실패한다.

**수정**: 두 클래스 모두 순서를 뒤집었다 — wasm을 먼저 `fetch()`해 `Module.wasmBinary`를 채운 뒤에야 `importScriptsFn(...)`을 호출한다. 이러면 글루의 `createWasm()`이 실행되는 시점에 `Module.wasmBinary`가 이미 채워져 있어 자체 fetch를 아예 시도하지 않는다. 관련 유닛 테스트(`AssemblyDecoder.test.ts`/`AssemblyTranscoder.test.ts`)도 "fetch가 영원히 안 끝나도 constructor는 동기적으로 초기화된다"를 가정하던 픽스처에서 "fetch가 resolve된 뒤 초기화된다"로 갱신했다.

같은 조사 과정에서, `decoderWorker.ts`/`audiotranscoderWorker.ts`가 레거시의 `var Module = typeof Module !== "undefined" ? Module : {};` 사전 선언(워커 엔트리 최상단, 글루 로드 전에 `Module` 전역을 미리 만들어두는 관용구)을 포팅 과정에서 누락했던 것도 함께 발견해 추가했다 — `EmscriptenModule.d.ts`는 `Module`의 **타입**만 선언할 뿐 런타임 값을 만들어주지 않으므로, 저 런타임 대입문이 없으면 `Module.onRuntimeInitialized = ...`에서 `ReferenceError: Module is not defined`가 발생한다.

---

## 7. `custom/RTSPOverWebSocket.ts` — Layer 11 상세

레거시 `Custom/rtsp-over-websocket.js`(7312줄, 단일 `RTSPOverWebSocket extends HTMLElement` 클래스)의 라인 단위 포팅. 다음 원칙을 따른다:

- **Symbol-키 pseudo-private 메서드**(`[dispatch]`, `[statistics_div]`, `[contextmenu_div]` 등 legacy의 `Symbol()` 프로퍼티 키)는 TS `private` 메서드로 기계적 변환 — 아무 것도 이 Symbol들을 리플렉션하지 않으므로 동작 변화 없음.
- **CSS 텍스트 블록**(통계/네트워크상태/컨텍스트메뉴/제스처 오버레이 패널을 빌드하는 `[appendStyle](...)` 인라인 문자열, 약 700줄)은 `custom/panelStyles.ts`로 추출 — 로직 변경 없이 파일 길이만 축소.
- **클래스 자체는 분할하지 않음** — 단일 커스텀 엘리먼트·단일 legacy prototype이며, `this` 바인딩에 의존하는 버그 재현 정확성을 위해 컴포지션으로 쪼개는 리팩터링을 의도적으로 배제했다.

### 7.1 확인된 레거시 버그 (포팅 시 그대로 보존, 수정하지 않음)

아래는 대표적인 항목이며, 전체 목록과 정확한 근거(라인 번호·재현 방법)는 `custom/RTSPOverWebSocket.ts` 각 메서드/접근자의 인라인 주석에 있다.

| 증상 | 근거 위치 (레거시) | 포팅 결과 |
|---|---|---|
| `background`/`useClockRange` 접근자 3중 재선언 충돌 — 마지막 선언(`useClockRange`용으로 오기된 `set background`)만 실제로 적용됨 | rtsp-over-websocket.js:2605-2649 | `background` setter가 `_useClockRange`를 변경, `_updateRendering()` 호출 안 됨. `useClockRange`는 getter-only(대입 시 TypeError) |
| `grunt` getter가 참조하는 `_useGrunt`가 어디서도 초기화되지 않음 | rtsp-over-websocket.js (전역 grep 확인) | `element.grunt`는 항상 `undefined` 반환, setter는 `info.device.serverType`만 갱신 |
| `audioshift` getter가 `type` getter와 동일 본문 복붙 | rtsp-over-websocket.js:2814-2816 | 항상 `info.media.mode`를 반환, 실제 오디오 시프트 값 추적 없음 |
| `seekingTime` setter의 연산자 우선순위 오류(`!this._playType === X`) | rtsp-over-websocket.js:1848 | ISO 시간 형식 검증이 항상 죽은 코드 |
| `GMT` setter의 느슨한 유효성 검사 | rtsp-over-websocket.js:2429 | `v===undefined`일 때만 throw, 그 외 비정상 타입은 무검증 통과 |
| `playSpeed`의 0.125x/-0.125x가 0.12/-0.12로 절삭 | rtsp-over-websocket.js:2150-2156, 2209-2215 | 약 4% 속도 오차 재현 |
| `[generateRTSPURL]`의 `case ' live':` (앞 공백 오타) | rtsp-over-websocket.js:5730 | NVR 분기에서 해당 case 영원히 매치 안 됨(항상 default) |
| `speed()`의 카메라 분기에서 `.url` 대신 `.utl`에 대입(오타) | rtsp-over-websocket.js:6511 | 카메라 재생속도 변경 시 RTSP URL이 실제로 갱신되지 않음 |
| `onRTSPOverWebSocketError`의 `0x0000`/`0x0001` 케이스에서 `playType === LIVE && playType === PLAYBACK` (동시에 참일 수 없음) | rtsp-over-websocket.js:4671-4673, 4695-4697 | 미니맵 갱신 분기가 항상 죽은 코드 |
| `[updateMetaImage]`의 후반부 전체가 `[updateMinimap]` 복붙 | rtsp-over-websocket.js:1475-1589 | `#minimap_<id>` 엘리먼트를 잘못 조회하고 `cmd:'minimap'`을 무조건 전송 |
| `_updateSunapiManager()` catch 핸들러의 404/490/401 분류 가드가 `error instanceof AuthError && error instanceof SunapiError`(동시 성립 불가) | rtsp-over-websocket.js:3047-3048 | 해당 AuthError 재throw 로직 전부 죽은 코드 |
| `connectedCallback`의 `info.media.element !== null && info.media.element !== null` (동일 절 중복, `!== undefined` 의도) | rtsp-over-websocket.js:1117 | `id` 속성 누락 시에도 `_updateRendering()`이 여전히 실행됨(console.warn만 발생) |
| `attributeChangedCallback`의 `'android'` 케이스 — attribute 값은 항상 string이라 `typeof newValue !== 'boolean'`이 항상 참 | rtsp-over-websocket.js:940-956 | 마크업으로 `android` 속성을 설정하면 항상 throw (connectedCallback은 별도 경로로 우회) |

### 7.2 DOM 구조 — `#rtsp-over-websocket-wrapper-<id>` 통합 (2026-07-31)

레거시부터 이어받은 구조에서는 `channel_div`(§7.1 통계 채널 라벨)/`statistics`/`video-container`/`contextmenu` 4개 오버레이 패널이 `<rtsp-over-websocket>`의 직속 자식으로 나란히 붙고, `#rtsp-over-websocket-wrapper-<id>`는 비디오(`canvas`/`video`) 엘리먼트 하나만 감싸는 별개의 형제 노드였다. 이 4개 패널 + 비디오 엘리먼트를 **모두 하나의 `#rtsp-over-websocket-wrapper-<id>` 하위**로 재구성했다:

```
<rtsp-over-websocket>
  └─ div#rtsp-over-websocket-wrapper-<id>
       ├─ div.channel_div
       ├─ div.statistics
       ├─ div.video-container
       ├─ canvas | video            (this.video)
       └─ div#contextmenu.menu      (우클릭 시 지연 생성)
```

`channel_div`/`statistics`는 `statisticsDiv()`에서, `video-container`/비디오 엘리먼트는 `updateRendering()`에서, `contextmenu`는 최초 우클릭 시 `contextmenuDiv()`에서 — 서로 독립적인 3개 경로가 정해진 순서 없이 호출될 수 있으므로(예: `statistics` 속성은 `connectedCallback` 한참 뒤에도 setter로 켜질 수 있음), `ensureRTSPOverWebSocketWrapper()` 헬퍼가 `#rtsp-over-websocket-wrapper-<id>`를 최초 1회만 지연 생성해 `this`에 붙이고, 이미 있으면 그대로 재사용하도록 했다. 세 메서드 모두 `this.appendChild(...)` 대신 `this.ensureRTSPOverWebSocketWrapper().appendChild(...)`를 호출한다.

부수 수정: `statistics`를 끌 때 기존 `this.removeChild(this.statisticsElement)`는 `statisticsElement`가 더 이상 `this`의 직속 자식이 아니게 되어 `NotFoundError`를 던지게 되므로, 부모에 무관하게 안전한 `this.statisticsElement.remove()`로 변경했다.

CSS 영향 없음 확인: `.channel_div`/`.statistics`/`.video-container`/`.menu`는 전부 `position: absolute`이지만, `#rtsp-over-websocket-wrapper-<id>`의 인라인 스타일은 `position`을 지정하지 않아(`static` 유지) 새로운 positioning 컨텍스트를 만들지 않는다 — 즉 이 4개 패널의 절대좌표 기준(containing block)은 이 DOM 재구성 전후로 동일하다.

---

## 8. 문서 세트 현황

원 계획(Phase 0)의 6개 SDD 문서(MRD/PRD/SRS/Design/Ops/TC)가 모두 작성 완료되었다. Layer 12의 `Control/ptz/*`는 팀 확인 전까지 착수하지 않으므로, 착수 시점에 관련 내용을 추가한다.

---

## 9. npm 패키지 배포 및 채택 — 서브모듈 종료 (2026-08-04)

이 문서가 §1~§8에서 다룬 `melchi45/rtsp-over-websocket`의 `src/player/` TypeScript 재작성이 `@melchi45/rtsp-over-websocket@1.0.1`로 GitHub Packages에 정식 배포되었고, LTS-2026이 이 npm 패키지를 직접 의존성으로 채택하면서 `melchi45/rtsp-over-websocket` 서브모듈 자체를 저장소에서 제거했다(`.gitmodules`, `git rm`).

- LTS-2026 쪽 채택 상세는 [Design_RTSP_Over_WebSocket.md](Design_RTSP_Over_WebSocket.md) §8.21 참고 — 패키지의 `observedAttributes`/이벤트명/`channel` 오프셋 규칙이 레거시 `<rtsp-over-websocket>`와 1:1 호환됨을 확인한 뒤 `client/src/components/RTSPOverWebSocketView.tsx`만 교체, 서버 쪽(`rtspOverWebSocketServer.js`)은 무변경.
- 이 문서(§1~§8)와 병렬 SDD 세트(MRD/PRD/SRS/Ops/TC, 위 헤더 링크)는 **서브모듈 내부 개발 과정의 역사적 기록**으로 그대로 보존한다 — 레이어별 포팅 순서, 발견된 버그, 회귀 수정 이력 등은 npm 패키지 자체의 향후 유지보수(별도 저장소 `melchi45/rtsp-over-websocket`)에서도 참고 가치가 있음.
- 이 문서 세트에 대한 신규 작업(레이어 추가, 버그 수정 등)은 이제 LTS-2026 저장소가 아니라 `melchi45/rtsp-over-websocket` 저장소에서 이루어진다 — 이 문서는 더 이상 능동적으로 갱신되지 않는다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-30 | 초기 작성 — Layer 1-11 전체 포팅 완료 반영 (Layer 11: `custom/RTSPOverWebSocket.ts`, 141 source files, 89 test files, 539 tests) |
| 1.1 | 2026-07-30 | MRD/PRD/SRS/Ops 문서 신규 작성 완료 반영 — Related PRD/SRS/Ops 헤더 추가, §7 갱신 |
| 1.2 | 2026-07-30 | Layer 12 상태 오기 수정 — `angularInterface/*`는 이미 포팅·테스트 완료(+19 tests) 상태였는데 "미착수"로 잘못 기재되어 있던 것을 수정. 미착수인 것은 `Control/ptz/*`뿐 |
| 1.3 | 2026-07-31 | 실카메라(H.265/G.711) 라이브 재생 검증 중 발견한 포팅 회귀 2건 수정 반영 — §6(신설) IIFE `import.meta.url` 폴리필 한계로 데모를 ESM 빌드로 전환 + `base:'./'` 추가, `Module.wasmBinary` 경쟁 조건(fetch-then-importScripts 순서 반전) 및 누락된 `Module` 전역 사전 선언 수정. §7.2(신설) `channel_div`/`statistics`/`video-container`/`contextmenu`를 `#rtsp-over-websocket-wrapper-<id>` 하위로 통합한 DOM 재구성 반영. 기존 §6 → §7, §7 → §8로 번호 이동 |
| 1.4 | 2026-08-04 | §9 신규 추가 — 이 마이그레이션의 결과물이 `@melchi45/rtsp-over-websocket@1.0.1`로 npm 배포·LTS-2026에 채택되면서 `melchi45/rtsp-over-websocket` 서브모듈 자체가 제거됨. 문서 상태를 Superseded/Shipped로 변경(§1~§8은 역사적 기록으로 보존), 채택 상세는 Design_RTSP_Over_WebSocket.md §8.21로 링크 |
| 1.5 | 2026-08-10 | 문서 ID `DESIGN-LTS-UMP-TS-001` → `DESIGN-LTS-RTSPWS-TS-001`로 통일 — 연관 SRS/TC의 `FR-UMPTS-*`/`TC-UMPTS-*` 추적 ID가 `FR-RTSPWSTS-*`/`TC-RTSPWSTS-*`로 리네임된 것과 맞춤(§1~§8 역사적 기록 내부의 레거시 소스 코드명 자체는 보존); 잔존 레거시 명칭 일괄 정리 — `Ump*` 식별자·`submodules/rtsp-over-websocket` 경로를 `@melchi45/rtsp-over-websocket` npm 패키지의 현행 명칭(`RTSPOverWebSocket*`, 별도 저장소 `melchi45/rtsp-over-websocket`)으로 전면 교체 |
