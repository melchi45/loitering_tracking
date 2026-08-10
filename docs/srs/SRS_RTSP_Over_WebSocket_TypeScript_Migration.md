# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# RTSP-over-WebSocket 레거시 JS → TypeScript/ESM 마이그레이션

| | |
|---|---|
| **Document ID** | SRS-LTS-RTSPWS-TS-01 |
| **Version** | 1.3 |
| **Status** | Active (구현 완료 — Layer 1-11) |
| **Date** | 2026-07-30 |
| **Parent PRD** | [prd/PRD_RTSP_Over_WebSocket_TypeScript_Migration.md](../prd/PRD_RTSP_Over_WebSocket_TypeScript_Migration.md) |
| **Parent MRD** | [mrd/MRD_RTSP_Over_WebSocket_TypeScript_Migration.md](../mrd/MRD_RTSP_Over_WebSocket_TypeScript_Migration.md) |
| **Child Design** | [design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md](../design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md) |
| **Child TC** | [tc/TC_RTSP_Over_WebSocket_TypeScript_Migration.md](../tc/TC_RTSP_Over_WebSocket_TypeScript_Migration.md) |

---

## Table of Contents

1. [개요](#1-개요)
2. [시스템 개요](#2-시스템-개요)
3. [기능 요구사항 — 레이어별](#3-기능-요구사항--레이어별)
4. [기능 요구사항 — 버그 보존 원칙](#4-기능-요구사항--버그-보존-원칙)
5. [비기능 요구사항](#5-비기능-요구사항)
6. [인터페이스 요구사항](#6-인터페이스-요구사항)
7. [제약 사항 및 가정](#7-제약-사항-및-가정)

---

## 1. 개요

### 1.1 목적

본 SRS는 `melchi45/rtsp-over-websocket/app/media`(레거시)를 `melchi45/rtsp-over-websocket/src/player`(TypeScript/ESM)로 병행 재작성하는 마이그레이션의 검증 가능한 기능 요구사항을 정의한다. 각 요구사항은 `FR-RTSPWSTS-NNN` ID로 식별되며 `TC_RTSP_Over_WebSocket_TypeScript_Migration.md`의 `TC-RTSPWSTS-NNN` 테스트 케이스와 1:1 추적 가능하다.

### 1.2 범위

본 문서가 다루는 범위:
- `src/player/` 하위 141개 TypeScript 소스 파일(87개 레거시 파일 + 신규 barrel/타입/vendor `.d.ts`)의 기능 동등성 요구사항.
- old-vs-new parity 검증 방법론(Node `vm` 기반) 및 Contract 검증 방법론(jsdom 등)의 요구사항.
- 빌드 산출물(ESM/IIFE 듀얼 아웃풋) 요구사항.

범위 밖: 레거시 `app/media` 서브모듈 자체의 수정, `app/*.html` 데모 페이지 cutover, LTS-2026 서버(`server/`)·클라이언트(`client/`)의 RTSP-over-WebSocket 통합 방식 변경(이는 [SRS_RTSP_Over_WebSocket.md](SRS_RTSP_Over_WebSocket.md)의 범위).

### 1.3 용어

| 용어 | 정의 |
|---|---|
| Parity 테스트 | 레거시 파일을 Node `vm`으로 격리 로드해 신규 TS 구현과 동일 입력에 대한 출력을 deep-equal 비교하는 테스트 |
| Contract 테스트 | 부수효과가 있는 클래스에 대해, 문서화된 공개 인터페이스(속성/이벤트/메서드 시그니처)가 신규 구현에서도 동일하게 노출되는지 검증하는 테스트 |
| 버그 보존(bug preservation) | 레거시에서 확인된 결함을 "고치지 않고" 신규 구현에서 동일하게 재현하는 원칙 |

---

## 2. 시스템 개요

`src/player/`는 12개 레이어로 구성되며, 하위 레이어(Exception/Util)부터 상위 레이어(커스텀 엘리먼트)까지 의존성 순서대로 포팅된다. 전체 구조는 [Design_RTSP_Over_WebSocket_TypeScript_Migration.md §2](../design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md#2-디렉토리-구조-실제-구현-상태)를 참조.

---

## 3. 기능 요구사항 — 레이어별

### FR-RTSPWSTS-001: Exception 클래스군 (Layer 1)

`exceptions/{RTSPOverWebSocketError,AuthError,RTCPError,RTSPError,SunapiError}.ts`는 레거시의 옵션 객체 생성 형태(`new XError({message, channelId, elementId, errorCode, place})`)를 지원하고, `name`/`channel`/`element`/`errorCode`/`place`/`message` 필드가 레거시와 동일해야 한다.
**TC:** TC-RTSPWSTS-001

### FR-RTSPWSTS-002: 순수 Util 자료구조/파서 (Layer 2)

`RTSPOverWebSocketMap`, `Queue`, `CircularTypedArrayQueue`, `DigestGenerator`, `H264SPSParser`, `H265SPSParser`, `CommonAudioUtil`, `FishEye3D`, `FishEye3DMulti`는 결정적 입력에 대해 레거시와 동일한 출력을 산출해야 한다.
**TC:** TC-RTSPWSTS-002

### FR-RTSPWSTS-003: util.js 분리 모듈 + Network 순수 리프 (Layer 3)

`util/{formatBytes,formatBps,hex,binaryString,BrowserDetect,indexOfMulti,fastJsonStringfy,getElementByAttributeValue,dateFormat}.ts`, `network/{HttpStatusCode,SunapiException,RtspStatusCode,WebsocketStatusCode}.ts`는 레거시와 동일한 함수 시그니처·출력을 가져야 한다.
**TC:** TC-RTSPWSTS-003

### FR-RTSPWSTS-004: Listen/Decoder, Talk/Encoder (Layer 4)

오디오 디코더(`AudioDecoder`, `G711AudioDecoder`, `AACAudioDecoder`)와 인코더(`G711AudioEncoder`)는 동일 PCM/G711/AAC 입력에 대해 레거시와 동일한 디코딩/인코딩 결과를 산출해야 한다.
**TC:** TC-RTSPWSTS-004

### FR-RTSPWSTS-005: MediaSession 코어 + Video/Audio/TextSession (Layer 5)

`Session`, `RTCPSession`/`RtcpSession`, `RtpSession`, `videoSession/*`, `audioSession/{G711Session,G726Session}`, `textSession/MetaSession`은 동일 RTP/RTCP 패킷 시퀀스에 대해 레거시와 동일한 버퍼 상태·통계 콜백을 산출해야 한다.
**TC:** TC-RTSPWSTS-005

### FR-RTSPWSTS-006: Network transport/RTSPoverWebsocket/http 클라이언트 (Layer 6)

`Transport`, `RtspClient`, `SunapiClient`/`SunapiManager`는 fake WebSocket/XHR 대비 레거시와 동일한 RTSP 핸드셰이크 상태 전이 및 SUNAPI 요청 페이로드를 산출해야 한다.
**TC:** TC-RTSPWSTS-006

### FR-RTSPWSTS-007: MediaSession 허브 — RtpClient/MediaRouter (Layer 7)

`RtpClient`, `MediaRouter`는 fake 세션/렌더러 주입 시 코덱별 RTP 라우팅, 오디오 볼륨/음소거, 타임스탬프 갱신을 문서화된 공개 계약과 동일하게 수행해야 한다.
**TC:** TC-RTSPWSTS-007

### FR-RTSPWSTS-008: Listen/Renderer, Talk, Video/Player/* (Layer 8)

`AudioPlayerGxx`, `Talk`, `CanvasTagPlayer`/`VideoTagPlayer`는 fake `AudioContext`/Canvas 2D 컨텍스트 대비 문서화된 공개 계약과 동일하게 동작해야 한다.
**TC:** TC-RTSPWSTS-008

### FR-RTSPWSTS-009: Interface(StreamPlayer/StreamManager), Backup(BackupProvider) (Layer 9)

`StreamPlayer`/`StreamManager`/`BackupProvider`는 fake `MediaRouterFactories`/`TransportFactory` 주입 시 `control()`/`controlWorker()` 커맨드 디스패치와 URL 빌딩(IE/Edge IPv6-literal 프록시 맹글링 포함)을 레거시와 동일하게 수행해야 한다.
**TC:** TC-RTSPWSTS-009

### FR-RTSPWSTS-010: Worker 엔트리 6종 + vendor wrap (Layer 10)

`worker/{mjpegSession,backup,videoDecoder,audioTranscoder,sunapi}/*`, `worker/backup/zipWorker.ts`는 fake `importScripts`/`self`/`Module`(Emscripten) 경유로 레거시와 동일한 바이트/메시지 시퀀스를 산출해야 한다. Vendor 파일(`ffmpeg.js`, `ffmpegAAC.js`×2, `minizip-asm.js`)은 원본 그대로 유지되어야 하며 로직 재작성이 없어야 한다.
**TC:** TC-RTSPWSTS-010

### FR-RTSPWSTS-011: `<rtsp-over-websocket>` 커스텀 엘리먼트 (Layer 11)

`custom/RTSPOverWebSocket.ts`는 `customElements.define('rtsp-over-websocket', RTSPOverWebSocket)`로 등록되는 `HTMLElement` 서브클래스로서, 레거시 `Custom/rtsp-over-websocket.js`의 다음 공개 계약을 동일하게 노출해야 한다:
- `static observedAttributes` 28개 속성 목록.
- `attributeChangedCallback`/`connectedCallback` 라이프사이클 동작(속성별 파싱·검증·throw 조건 포함).
- 55개+ 프로퍼티 접근자(`playType`, `mode`, `GMT`, `playSpeed`, `background`/`useClockRange` 등).
- `play()`/`stop()`/`pause()`/`resume()`/`speed()`/`forward()`/`backward()`/`seeking()`/`capture()`/`talk()`/`backup()`/`startBackup()`/`endBackup()` 재생 제어 메서드.
- 15개 `onRTSPOverWebSocket*` 콜백 핸들러(`onRTSPOverWebSocketError`, `onRTSPOverWebSocketBackup`, `onRTSPOverWebSocketTimestamp` 등).
- 커스텀 `addEventListener`/`removeEventListener`/`dispatchEvent` 이벤트 레지스트리(Map 기반, native `EventTarget`이 아닌 legacy 자체 구현).

**TC:** TC-RTSPWSTS-011

---

## 4. 기능 요구사항 — 버그 보존 원칙

### FR-RTSPWSTS-012: 확인된 레거시 버그의 동일 재현

레거시에서 확인된 결함(전체 목록: [Design_RTSP_Over_WebSocket_TypeScript_Migration.md §6.1](../design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md#61-확인된-레거시-버그-포팅-시-그대로-보존-수정하지-않음))은 신규 구현에서 **동일한 조건에서 동일하게 재현**되어야 하며, 사용자 승인 없이 임의로 수정되어서는 안 된다. 각 버그는 포팅된 소스 파일의 인라인 주석에 근거 라인(레거시 파일:라인번호)과 함께 문서화되어야 한다.

**Rationale:** 이 마이그레이션은 리팩터링이 아니라 이식이다. 버그를 "고치면" 프로덕션에서 이미 그 버그에 맞춰 동작하는 다른 코드(예: `app-react`, LTS 서버 통합 코드)와의 동작 불일치가 발생할 수 있다.

**TC:** TC-RTSPWSTS-011 (항목 4, 6-11)

### FR-RTSPWSTS-013: 100% 확인된 dead code만 제거 허용

Grep 등으로 호출부가 전무함이 확인된 코드(예: `AviFormatWriter`의 `aviHeader` 필드, `custom/RTSPOverWebSocket.ts`의 `_videoElementStyle` 필드)에 한해서만 포팅에서 제외할 수 있다. 확실하지 않은 경우 포팅하고 주석으로 사유를 남긴다.

---

## 5. 비기능 요구사항

### NFR-RTSPWSTS-001: 빌드 산출물 이중화

`vite build`는 ESM(`rtsp-over-websocket.esm.js`)과 IIFE(`rtsp-over-websocket.global.js`) 두 산출물을 생성해야 한다.

### NFR-RTSPWSTS-002: TypeScript strict 모드

`tsconfig.json`은 strict 모드를 사용하며, `tsc -b`는 0 에러로 통과해야 한다. `any` 타입은 애플리케이션 코드에서 금지되며, vendor 경계에서만 `unknown` + 명시적 wrapper로 격리한다.

### NFR-RTSPWSTS-003: 회귀 방지 — 테스트 커버리지

레거시 87개 파일 각각에 대응하는 TS 구현은 최소 1개 이상의 parity 또는 contract 테스트를 가져야 한다.

### NFR-RTSPWSTS-004: 순수 Node 환경 격리

루트 `index.ts`(및 `custom/index.ts`)는 `customElements.define(...)` 사이드이펙트를 가지므로 브라우저/jsdom 전용이다. `environment: 'node'`로 실행되는 기존 테스트 파일이 이 배럴을 임포트해서는 안 된다.

---

## 6. 인터페이스 요구사항

### IFR-RTSPWSTS-001: 워커 번들 포맷

`vite.config.ts`의 `worker.format`은 `'iife'`로 고정되어야 한다(classic-script `importScripts()` vendor 로딩과의 호환성 때문).

### IFR-RTSPWSTS-002: 공유 앰비언트 타입

Emscripten `Module` 전역은 `vendor/EmscriptenModule.d.ts` 단일 위치에서만 `declare global`로 선언되어야 한다(TypeScript는 동일 앰비언트 `var`의 모든 선언이 동일 타입이어야 함을 요구하므로, 파일별 중복 선언은 컴파일 에러를 유발한다).

---

## 7. 제약 사항 및 가정

- `app/media`(레거시)는 별도 git 서브모듈이며 이번 마이그레이션에서 전혀 수정하지 않는다.
- Layer 12 중 `angularInterface/*`는 이미 포팅·테스트 완료되어 있다(+19 tests). `Control/ptz/*`만 실사용 여부가 팀 내에서 확인되지 않아 이번 SRS의 필수 요구사항에서 제외한다.
- 레거시 `app/*.html` 데모 페이지의 신규 빌드 전환(cutover)은 이번 SRS의 범위 밖이다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-30 | 초기 작성 — Layer 1-11 구현 완료 시점에 소급 작성, FR-RTSPWSTS-001~013 정의 |
| 1.1 | 2026-07-30 | §7 Layer 12 상태 오기 수정 — `angularInterface/*`는 이미 포팅·테스트 완료(+19 tests) 상태였는데 "미확인"으로 잘못 기재되어 있던 것을 수정. 미착수인 것은 `Control/ptz/*`뿐 |
| 1.2 | 2026-08-04 | 이 마이그레이션의 결과물이 `@melchi45/rtsp-over-websocket@1.0.1`로 npm 배포되고 LTS-2026에 채택되면서 `melchi45/rtsp-over-websocket` 서브모듈 자체가 제거됨 — Design_RTSP_Over_WebSocket_TypeScript_Migration.md §9(Superseded/Shipped) 참고 |
| 1.3 | 2026-08-10 | 문서 ID `SRS-LTS-UMP-TS-01` → `SRS-LTS-RTSPWS-TS-01`, 요구사항 추적 ID `FR-UMPTS-NNN`/`NFR-UMPTS-NNN`/`IFR-UMPTS-NNN` → `FR-RTSPWSTS-NNN`/`NFR-RTSPWSTS-NNN`/`IFR-RTSPWSTS-NNN`으로 전면 리네임(TC 문서와 동시 갱신, 요구사항 내용 변경 없음 — 역사적 기록 보존 원칙은 유지); 잔존 레거시 명칭 일괄 정리 — `Ump*` 식별자·`submodules/rtsp-over-websocket` 경로를 `@melchi45/rtsp-over-websocket` npm 패키지의 현행 명칭(`RTSPOverWebSocket*`, 별도 저장소 `melchi45/rtsp-over-websocket`)으로 전면 교체 |
