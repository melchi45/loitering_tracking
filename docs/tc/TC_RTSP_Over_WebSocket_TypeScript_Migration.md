# TC — RTSP-over-WebSocket 레거시 JS → TypeScript/ESM 마이그레이션

**Product:** LTS-2026 Loitering Detection & Tracking System (submodule: ump-player)
**Feature:** `submodules/ump-player/app/media/ump` → `submodules/ump-player/src/player` TypeScript/ESM 재작성
**Version:** 1.2
**Date:** 2026-08-04
**SRS Reference:** [SRS_RTSP_Over_WebSocket_TypeScript_Migration.md](../srs/SRS_RTSP_Over_WebSocket_TypeScript_Migration.md)
**Design Reference:** [Design_RTSP_Over_WebSocket_TypeScript_Migration.md](../design/Design_RTSP_Over_WebSocket_TypeScript_Migration.md)

> **TC-ID 넘버링 노트**: 기존 `TC_RTSP_Over_WebSocket.md`는 `TC-UMP-NNN` 프리픽스를 사용 중이므로(서버 통합/프로토콜 테스트), 이 문서는 겹치지 않도록 `TC-UMPTS-NNN` 프리픽스를 사용한다(라이브러리 내부 TypeScript 마이그레이션 테스트).
>
> **실행 방법**: `cd submodules/ump-player/src/player && npx vitest run` — 89개 테스트 파일, 539개 테스트 전부 자동화됨(수동 검증 항목 없음). 이 문서의 "자동화" 표기는 전부 "완료(구현됨)"이다 — 레거시 서버 스위트(`test:tc`, TC-XXX)와 달리 이 마이그레이션은 브라우저 카메라 연동이 필요 없는 라이브러리 레벨 코드이므로 100% 자동화 가능하다.

---

## 레이어별 테스트 케이스

### TC-UMPTS-001: Layer 1 — Exception 클래스군 parity

**SRS:** FR-UMPTS-001
**대상:** `exceptions/{UmpError,AuthError,RTCPError,RTSPError,SunapiError}.ts`
**Steps:** 옵션 객체(`{message,channelId,elementId,errorCode,place}`)로 생성 → `name`/`channel`/`element`/`errorCode`/`place`/`message` 필드가 레거시 `vm` 로드 인스턴스와 동일한지 비교
**Expected:** 전 필드 deep-equal
**자동화:** 완료 (`exceptions/*.test.ts`)

---

### TC-UMPTS-002: Layer 2 — 순수 Util 자료구조/파서 parity

**SRS:** FR-UMPTS-002
**대상:** `UmpMap`(hashMap), `Queue`, `CircularTypedArrayQueue`, `DigestGenerator`, `H264SPSParser`, `H265SPSParser`, `CommonAudioUtil`, `FishEye3D`, `FishEye3DMulti`
**Steps:** 결정적 입력(고정 바이트 시퀀스/SPS NAL 등)에 대해 레거시 `vm` 결과와 신규 구현 결과 비교
**Expected:** deep-equal (타입드 배열은 `normalize()` 경유 비교)
**자동화:** 완료

---

### TC-UMPTS-003: Layer 3 — util.js 분리 모듈 + Network 순수 리프 parity

**SRS:** FR-UMPTS-003
**대상:** `util/{formatBytes,formatBps,hex,binaryString,BrowserDetect,indexOfMulti,fastJsonStringfy,getElementByAttributeValue,dateFormat}.ts`, `network/{HttpStatusCode,SunapiException,RtspStatusCode,WebsocketStatusCode}.ts`
**Steps:** 각 함수의 결정적 입력→출력 비교
**Expected:** deep-equal
**자동화:** 완료

---

### TC-UMPTS-004: Layer 4 — Listen/Decoder, Talk/Encoder parity

**SRS:** FR-UMPTS-004
**대상:** `listen/decoder/{AudioDecoder,G711AudioDecoder,AACAudioDecoder}.ts`, `talk/encoder/G711AudioEncoder.ts`
**Steps:** PCM/G711 샘플 버퍼 인코딩·디코딩 결과 비교 (AAC는 fake asm.js `Module.cwrap`/`HEAPF32` 경유)
**Expected:** deep-equal (부동소수점은 근사 비교)
**자동화:** 완료

---

### TC-UMPTS-005: Layer 5 — MediaSession 코어 + Video/Audio/TextSession parity

**SRS:** FR-UMPTS-005
**대상:** `mediaSession/Session.ts`, `RTCPSession`/`RtcpSession`(비디오/오디오 분리 네이밍), `RtpSession`, `videoSession/*`, `audioSession/{G711Session,G726Session}.ts`, `textSession/MetaSession.ts`
**Steps:** RTP/RTCP 패킷 시퀀스 주입 → 버퍼 상태/통계 콜백 페이로드 비교
**Expected:** deep-equal
**자동화:** 완료 (`RtpSession.test.ts`의 버퍼 오버플로우 성장 테스트는 부하 시 5초 타임아웃 발생 가능 — 격리 실행 시 안정적으로 통과, 전체 스위트 동시 실행 시 시스템 부하로 인한 flaky 재시도 필요할 수 있음)

---

### TC-UMPTS-006: Layer 6 — Network transport/RTSPoverWebsocket/http 클라이언트 parity+contract

**SRS:** FR-UMPTS-006
**대상:** `network/transport/Transport.ts`, `network/rtspOverWebsocket/RtspClient.ts`, `network/http/{SunapiClient,SunapiManager}.ts`
**Steps:** WebSocket/XHR을 fake로 대체, RTSP 핸드셰이크(OPTIONS~PLAY) 시퀀스와 SUNAPI 요청 페이로드 검증
**Expected:** 레거시와 동일 상태 전이·이벤트 페이로드
**자동화:** 완료

---

### TC-UMPTS-007: Layer 7 — MediaSession 허브(RtpClient, MediaRouter) contract

**SRS:** FR-UMPTS-007
**대상:** `mediaSession/{RtpClient,MediaRouter}.ts`
**Steps:** fake 세션/렌더러 주입 → 코덱별 RTP 라우팅, 오디오 볼륨/음소거, 타임스탬프 갱신 검증
**Expected:** 문서화된 공개 계약과 동일
**자동화:** 완료

---

### TC-UMPTS-008: Layer 8 — Listen/Renderer, Talk, Video/Player/* contract

**SRS:** FR-UMPTS-008
**대상:** `listen/renderer/AudioPlayerGxx.ts`, `talk/Talk.ts`, `video/player/{canvas/CanvasTagPlayer,video/VideoTagPlayer}.ts`
**Steps:** fake `AudioContext`/`ScriptProcessorNode`/Canvas 2D 컨텍스트로 렌더링 파이프라인 구동
**Expected:** 문서화된 공개 계약과 동일
**자동화:** 완료

---

### TC-UMPTS-009: Layer 9 — Interface(StreamPlayer/StreamManager), Backup(BackupProvider) contract

**SRS:** FR-UMPTS-009
**대상:** `interface/{StreamPlayer,StreamManager}.ts`, `backup/BackupProvider.ts`
**Steps:** fake `MediaRouterFactories`/`TransportFactory` 주입 → `control()`/`controlWorker()` 커맨드 디스패치, URL 빌딩(IE/Edge IPv6-literal 프록시 맹글링 포함) 검증
**Expected:** 문서화된 공개 계약과 동일
**자동화:** 완료 (16 + 13 tests)

---

### TC-UMPTS-010: Layer 10 — Worker 엔트리 6종 + vendor wrap parity/contract

**SRS:** FR-UMPTS-010
**대상:** `worker/mjpegSession/*`, `worker/backup/*`(AviFormatWriter/VideoHeader/AudioHeader/AviFileWriter/BackupSession/backupWorker/zipWorker), `worker/videoDecoder/*`(AssemblyDecoder/decoderWorker), `worker/audioTranscoder/*`, `worker/sunapi/sunapiRequestTask.ts`, `vendor/{ffmpeg,ffmpegAAC.decoder,ffmpegAAC.transcoder,minizip-asm}.*`
**Steps:** fake `importScripts`/`self`/`Module`(Emscripten) 경유로 JPEG RTP 역패킷화, AVI 헤더 바이너리 생성, H264/H265 WASM 디코드, AAC WASM 트랜스코드, SUNAPI Digest 인증 헤더 생성 검증. `Date.prototype.YYYYMMDDHHMMSS` 전역 오염 회피를 위해 `loadLegacyModuleSlice` + 1회성 host `Date.prototype` 설치 기법 사용(`BackupSession.test.ts`)
**Expected:** 레거시와 동일 바이트/메시지 시퀀스, 확인된 버그(예: `fileSplit()`의 `tailSize` null 참조 크래시, `isPlayback` 모듈 스코프 공유 상태) 동일 재현
**자동화:** 완료 (+76 tests)

---

### TC-UMPTS-011: Layer 11 — `<ump-player>` 커스텀 엘리먼트(`custom/UmpPlayer.ts`) contract (jsdom)

**SRS:** FR-UMPTS-011, FR-UMPTS-012, FR-UMPTS-013
**대상:** `custom/UmpPlayer.ts` (37 tests, `// @vitest-environment jsdom`)
**Steps 및 Expected:**

| # | 항목 | Expected |
|---|---|---|
| 1 | `customElements.get('ump-player')` 등록 확인 | `HTMLElement` 상속 인스턴스 생성 가능 |
| 2 | `static observedAttributes` | 문서화된 attribute 목록 포함 |
| 3 | 생성자 기본값 | `info.device.ClientIPAddress==='127.0.0.1'`, `info.media.type==='live'`, `readyState===STOPPED`, `isplay===false` |
| 4 | `attributeChangedCallback('channel', ..., '0')` | `UmpError` throw (1 미만 채널 거부) — **CEReactions 주의**: `setAttribute()` 경유 호출은 스펙상 예외가 비동기 report되어 동기 propagate 안 됨; 메서드 직접 호출로 검증 |
| 5 | `attributeChangedCallback('gmt', ..., 'null')` | 문자열 `'null'`이 실제 `null`로 파싱됨 |
| 6 | `background`/`useClockRange` 3중 접근자 충돌 버그 | `background=true` 대입 시 `useClockRange`가 `true`로 변경됨; `useClockRange` 자체는 대입 시 `TypeError` |
| 7 | `grunt` getter/setter 불일치 버그 | `grunt=true` 대입 후에도 `grunt` getter는 `undefined` 반환 |
| 8 | `audioshift` 복붙 버그 | `info.media.mode` 변경 시 `audioshift` getter도 동일하게 반환 |
| 9 | `GMT` 느슨한 검증 버그 | `undefined` 대입은 throw, 비숫자 문자열은 통과, 범위 밖 숫자(99)는 throw, `null`은 허용 |
| 10 | `seekingTime` 연산자 우선순위 버그 | 비-ISO 문자열 대입도 throw 안 됨(단, 비-문자열 타입은 여전히 throw) |
| 11 | `playSpeed` 절삭 버그 | `0.125`→`0.12`, `-0.125`→`-0.12`, `2`(정상 프리셋)는 그대로 |
| 12 | `playType`/`mode` 접근자 상호 동기화 | 기본값 `live`; `mode='playback'` → `playType===PLAYBACK`; 비-문자열 `mode` 대입 시 throw |
| 13 | `player` 없는 상태에서 `stop()`/`pause()`/`resume()`/`capture()`/`isPlay()` | 전부 `UmpError` throw (`isPlay()`는 deprecated로 상태 무관 항상 throw) |
| 14 | `play()` 입력 검증 | username 미설정 시 `AuthError`; playback 모드에서 `startTime` 미설정 시 `UmpError` |
| 15 | 커스텀 `addEventListener`/`removeEventListener`/`dispatchEvent` 레지스트리 | 이벤트 detail에 `channelId`/`elementId` 자동 병합; 동일 타입 중복 등록 무시; 해제 후 미호출; null 리스너 등록 시 `UmpError` |
| 16 | `connectedCallback` | `device` 속성 미지정 시 `deviceType==='camera'` 기본값, `hostname` 미지정 시 `document.location.hostname` 사용; 잘못된 `mode` 속성은 내부에서 catch되어 `console.error`만 발생(예외 전파 안 됨) |
| 17 | `bestshotfilter` 접근자 | 유효 값 왕복; 음수 값 `UmpError` throw |

**자동화:** 완료 (`custom/UmpPlayer.test.ts`, 37 tests)

---

### TC-UMPTS-012: 전체 빌드 검증

**SRS:** NFR-UMPTS-001, NFR-UMPTS-002
**Steps:** `cd submodules/ump-player/src/player && npx tsc -b --force && npx vite build`
**Expected:** `tsc` 0 에러; Vite가 `dist/player/ump-player.{esm,global}.js` 2종 산출, `custom/UmpPlayer.ts`의 `customElements.define` 사이드이펙트가 두 번들 모두에 포함(루트 `index.ts`가 `./custom`을 re-export)
**자동화:** 완료 (CI 스크립트화는 후속)

---

### TC-UMPTS-013: 전체 회귀 스위트

**SRS:** NFR-UMPTS-003
**Steps:** `npx vitest run`
**Expected:** 89 test files / 539 tests 전부 통과
**자동화:** 완료

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-30 | 초기 작성 — Layer 1-11 전체 TC-ID 기록 (TC-UMPTS-001~013), 전부 자동화 완료 상태로 표기 |
| 1.1 | 2026-07-30 | SRS 신규 작성 완료 반영 — 각 TC 항목에 `**SRS:** FR-UMPTS-NNN` 추적 라인 추가, 헤더에 SRS Reference 추가 |
| 1.2 | 2026-08-04 | 이 마이그레이션의 결과물이 `@melchi45/rtsp-over-websocket@1.0.1`로 npm 배포되고 LTS-2026에 채택되면서 `submodules/ump-player` 서브모듈 자체가 제거됨 — Design_RTSP_Over_WebSocket_TypeScript_Migration.md §9(Superseded/Shipped) 참고 |
