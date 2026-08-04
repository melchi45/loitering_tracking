# DESIGN DOCUMENT
# RTSP-over-WebSocket 스트리밍 경로 추가 (3번째 재생 파이프라인)

| | |
|---|---|
| **Document ID** | DESIGN-LTS-UMP-WS-001 |
| **Version** | 3.6 |
| **Status** | Active (구현 완료, 라이브 검증 완료 — channelSlot=6 실 카메라 30fps 확인; 클라이언트 라이브러리는 2026-08-04 npm 패키지로 전환, §8.21) |
| **Date** | 2026-08-04 |
| **Related Design** | [Design_RTSP_Capture_Backend.md](Design_RTSP_Capture_Backend.md) · [Design_Server_Architecture.md](Design_Server_Architecture.md) · [Design_RTSP_Over_WebSocket_TypeScript_Migration.md](Design_RTSP_Over_WebSocket_TypeScript_Migration.md) |
| **Related Package** | [@melchi45/rtsp-over-websocket](https://github.com/melchi45/rtsp-over-websocket) (npm, GitHub Packages) — `submodules/ump-player` 서브모듈은 2026-08-04 제거됨, §8.21 |

---

## 1. 목적 및 범위

현재 LTS-2026의 카메라 재생 경로는 두 가지입니다:

1. **JPEG Capture 스트리밍** — ingest-daemon이 AI용으로 디코딩한 프레임을 JPEG로 인코딩해 Node.js로 POST, Socket.IO `frame` 이벤트로 room(카메라 ID) 기반 브로드캐스트 (`pipelineManager.js:704-717`).
2. **WebRTC** — ingest-daemon이 fan-out한 H.264/Opus RTP를 mediasoup(SFU) 또는 MediaMTX(WHEP)를 통해 브라우저에 전달.

이번 작업은 여기에 **세 번째 경로로 RTSP-over-WebSocket**을 추가하는 것입니다. `submodules/ump-player`(Hanwha `<ump-player>` 웹 컴포넌트)를 사용해 브라우저가 RTSP 스트림을 WebSocket으로 직접 재생합니다.

이 문서는 구현에 앞서 **RTSP-over-WebSocket의 실제 프로토콜을 분석한 결과**와, 기존 아키텍처(특히 ingest-daemon 단일 RTSP 세션 원칙)와 충돌하는 지점을 정리하고, 구현 방향을 결정하기 위한 미결정 사항을 나열합니다.

---

## 2. RTSP-over-WebSocket 프로토콜 분석 (소스 확인 결과)

`submodules/ump-player`는 중첩 서브모듈 `app/media`(`github.com/melchi45/ump`)와 `app/external-lib`를 가지고 있으며, 이번에 `git submodule update --init`으로 함께 체크아웃했습니다.

### 2.1 연결 대상

`app/media/ump/Interface/streamPlayer.js:282-339` (`startStreaming()`):

```js
var protocol = (connectionInfo.protocol == "http" ...) ? "ws://" : "wss://";
...
if (connectionInfo.proxy !== '') {
  address = protocol + connectionInfo.proxy + port + "/StreamingServer" + pathName;
} else {
  address = protocol + deviceIp + port + "/StreamingServer" + pathName;
}
```

- `<ump-player hostname="..." proxy="..." port="..." secure>` 속성으로 최종 WebSocket 주소가 결정됩니다.
- `proxy` 속성이 비어있으면 **브라우저가 카메라 IP(`hostname`)로 직접** `ws(s)://<camera-ip>:<port>/StreamingServer` 에 연결합니다.
- `proxy` 속성이 있으면 그 주소로 연결합니다 (브라우저 입장에선 목적지만 바뀔 뿐 프로토콜은 동일).

### 2.2 `/StreamingServer`의 정체

`/StreamingServer`는 **Hanwha/Wisenet 카메라 펌웨어에 내장된 SUNAPI 기능**입니다 — 카메라 자신의 HTTP 서버가 WebSocket↔RTSP 브릿지 역할을 합니다 (`app/media/ump/Network/RTSPoverWebsocket/rtspClient.js`가 WS 위에서 RTSP OPTIONS/DESCRIBE/SETUP/PLAY 텍스트 커맨드와 RTP interleaved 바이너리를 직접 조립·파싱). 즉 **우리가 새로 구현해야 하는 프로토콜이 아니라, 카메라가 이미 제공하는 엔드포인트**입니다.

- README의 `grunt proxy` 커맨드는 이 흐름을 로컬 개발 시 재현하기 위한 **Node.js 기반 개발용 프록시**(호스트/포트/프로토콜을 실제 카메라로 치환)입니다 — 프로덕션 컴포넌트가 아닙니다.
- 자격증명(`username`/`password`)은 URL이 아니라 `deviceInfo.id`/`deviceInfo.pw`로 별도 전달되어 RTSP Digest/Basic Authorization 헤더 생성에 쓰입니다 (`rtspClient.js`의 `DigestGenerator`) — URL 노출은 아니지만, **브라우저 JS 메모리에 카메라 평문 비밀번호가 존재**하게 됩니다.

### 2.3 카메라 호환성

`/StreamingServer`는 SUNAPI 기능이므로, 이미 `server/src/api/cameras.js`에 있는 카메라별 `supportSunapi` 판별 결과를 그대로 게이팅 조건으로 재사용할 수 있습니다 — ONVIF 전용(비-Hanwha) 카메라는 이 경로를 지원하지 않을 가능성이 높습니다.

### 2.4 와이어 프로토콜 — 표준 RTSP-over-TCP-Interleaved를 WS로 감쌀 뿐 (v0.2 갱신)

`app/media/ump/Network/transport/transport.js:54-207` (`OnReceive`) 확인 결과, `/StreamingServer`는 **Hanwha 전용 커스텀 프로토콜이 아니라 RFC 7826(RTSP 2.0) §10.12 TCP interleaved 프레이밍을 그대로 WebSocket 바이너리 메시지에 실은 것**입니다:

- RTSP 요청/응답: `RTSP/1.0 ...` 텍스트 + `Content-Length` 헤더 기반 바디 — 일반 RTSP-over-TCP와 동일.
- RTP/RTCP: `$`(매직 넘버) + 1바이트 채널 번호 + 2바이트 빅엔디안 길이 + payload — 표준 RTSP interleaved 프레임 그대로.
- 두 종류가 하나의 바이트 스트림에 섞여 오며, `OnReceive`는 그냥 앞의 4바이트가 `"RTSP"`인지 `$`(0x24)인지로 분기해서 파싱합니다.

**의미**: 서버 쪽 `/StreamingServer` 구현체는 RTSP를 해석할 필요가 전혀 없습니다. WS 연결이 열리면 최초 RTSP 요청 라인(`OPTIONS rtsp://.../<channel>/media.smp RTSP/1.0`)만 파싱해서 대상 채널을 식별한 뒤에는, 그 WS 연결과 내부 TCP RTSP 연결 사이를 **바이트 그대로 양방향 릴레이**하면 됩니다 (WS binary frame ↔ TCP bytes, 프로토콜 변환 없음). RTSP 해석·응답 조립은 실제 RTSP 서버(§3의 로컬 프록시)가 다 해줍니다.

---

## 3. 확정된 아키텍처 (v0.2 — 사용자 확인 완료)

사용자가 제시한 실제 구조는 카메라에 새 RTSP 세션을 만들지 않습니다. ingest-daemon이 이미 열어둔 단일 카메라 세션(§ `CLAUDE.md` "ingest-daemon 우선 원칙")은 그대로 두고, 그 뒤에 **로컬 RTSP 프록시 서버**를 추가로 두어 ingest-daemon이 이미 받은 데이터를 채널별로 재발행(push)하는 구조입니다.

```
카메라 RTSP (원본, 세션 1개만)
  rtsp://192.168.214.40/0/H.264/media.smp
        │  (기존 ingest-daemon 단일 세션 — 변경 없음)
        ▼
  ingest-daemon (카메라별 채널 ID로 데이터 수신,
                 AI JPEG / mediasoup RTP와 동일한 소스에서 5번째 fan-out 추가)
        │  (신규: 로컬 loopback push — 카메라 재접속 아님)
        ▼
  RTSP Proxy Server #<channelSlot>  (신규 컴포넌트, 채널별 매핑)
        │  rtsp://SERVER_IP/<channelSlot>/media.smp 로 로컬 서빙
        ▼
  ws(wss)://SERVER_IP/StreamingServer  (신규, 단일 엔드포인트)
        │  (첫 RTSP 요청 라인에서 <channelSlot> 파싱 → 대상 RTSP Proxy로 라우팅
        │   이후는 순수 바이트 릴레이, §2.4)
        ▼
  브라우저 <ump-player proxy="SERVER_IP" hostname="SERVER_IP" ...>
```

예시(사용자 제공):
- 카메라 A `rtsp://192.168.214.40/0/H.264/media.smp` → ingest-daemon → RTSP Proxy #0 → `rtsp://SERVER_IP/0/media.smp`
- 카메라 B `rtsp://192.168.214.39/0/BLAZEPrimary/media.smp` → ingest-daemon → RTSP Proxy #1 → `rtsp://SERVER_IP/1/media.smp`
- WS 엔드포인트는 `ws(wss)://SERVER_IP/StreamingServer` **하나**이며, 채널 구분은 요청 URL 안의 숫자 경로(`/0/`, `/1/`, ...)로 합니다 — 이 숫자는 이미 시스템에 있는 `channelSlot` 개념(`channelSlotService.js`, `ChannelSlotPicker.tsx`, `MAX_CHANNEL_NUM`)을 그대로 재사용할 수 있습니다.

이 구조는 §3(구 버전)에서 지적했던 "카메라당 세션 N+1개" 문제를 **원천적으로 제거**합니다 — 브라우저가 몇 개든 RTSP-over-WebSocket로 같은 카메라를 봐도 카메라 쪽 RTSP 세션은 여전히 ingest-daemon의 1개뿐입니다. RTSP Proxy Server와 WS 브릿지는 모두 로컬(loopback) 컴포넌트라 부하는 늘어도 카메라 안정성에는 영향이 없습니다.

> **(2026-07-24, §8.13) 위 그림은 이제 "fallback 경로"입니다.** 카메라가 `webrtcEnabled: true`라면 `mediamtxManager.addCameraPath()`가 이미 MediaMTX 자신의(Go, non-GIL) RTSP 클라이언트로 그 카메라를 직접 pull해 `rtsp://127.0.0.1:8554/<camera.id>`로 상시 서빙 중이다 — WebRTC(WHEP)가 실제로 쓰는 바로 그 경로. `umpStreamingServer.js`는 이제 이 경로가 `ready`인지 먼저 확인해서, 있으면 **ingest-daemon에는 아무 요청도 보내지 않고** 그 경로로 바로 붙는다(§4.2 3-4번). ingest-daemon의 6번째 fan-out(위 그림)은 그 카메라가 `webrtcEnabled: false`이거나 MediaMTX 등록 전일 때만 쓰인다. 이렇게 바뀐 이유: 카메라 10대를 한 파이썬 프로세스(GIL 1개)로 처리하는 ingest-daemon 경유 경로는 fleet 부하에 따라 원본 프레임레이트의 40~60%까지 떨어질 수 있는 반면, MediaMTX 직접 경로는 GIL과 무관해 항상 안정적이다(실측: 86%+ vs 40~63%, §8.13).

---

## 4. 신규 컴포넌트 3종

### 4.1 RTSP Proxy Server (채널별 로컬 재발행) — MediaMTX 재사용 확정

`pipelineManager.js:495-558` 확인 결과 **YouTube 카메라가 이미 정확히 같은 패턴**을 씁니다 — yt-dlp/ffmpeg가 `rtsp://127.0.0.1:8554/yt/<id>`로 publish하고, ingest-daemon은 그 로컬 경로를 그냥 읽습니다. 같은 방식을 재사용합니다:

- ingest-daemon(PyAV)이 `io` 스레드에서 이미 열려있는 packet 스트림을 6번째 출력으로 로컬 MediaMTX에 publish(RECORD)합니다. FFmpeg subprocess가 아니라 PyAV(libav)이므로 "FFmpeg subprocess 금지" 원칙과 충돌하지 않습니다.
- `mediamtx.yml`은 현재 `rtspAddress: 127.0.0.1:8554` (loopback 전용) + `authInternalUsers: any/무인증` 입니다 — 이 신뢰 모델은 그대로 둡니다. 브라우저는 MediaMTX에 절대 직접 닿지 않고(§4.2의 WS 브릿지만 loopback으로 접근), 실제 인증은 WS 브릿지 계층에서 처리합니다(§4.2 3번).
- **(2026-07-24, §8.12로 대체됨)** 원래는 `av.open("rtsp://127.0.0.1:8554/<channelSlot>", mode="w", format="rtsp")`를 ingest-daemon의 io 스레드에서 그대로(in-process) 호출했으나, PyAV의 RTSP `mux()`가 블로킹 네트워크 쓰기 동안 GIL을 놓지 않는다는 게 실측으로 확인되어 카메라 10대를 동시 처리하는 fleet 환경에서 이 fan-out 하나가 **해당 카메라 자신의 원본 읽기 루프까지 끌어내리는** 문제가 있었음. §8.12에서 `rtsp_publish_worker.py`라는 **완전히 별도의 OS 프로세스**로 옮겨 GIL 공유 자체를 없앴다 — 이 서브프로세스가 실제 `av.open()`/`add_stream()`/`mux()`를 전담하고, ingest-daemon은 파이프(stdin)로 raw 패킷 바이트만 전달한다.

### 4.2 `/StreamingServer` WS↔TCP 브릿지 (+ RTSP Digest 인증)

LTS Node 서버(HTTPS 3443과 같은 포트, 별도 `ws` 라이브러리 업그레이드 핸들러 — `ump-player`는 Socket.IO 클라이언트가 아니라 순수 `WebSocket`이므로 기존 Socket.IO 서버와는 별개 경로)에 신규 라우트 추가:

1. WS 연결 수락.
2. 첫 RTSP 요청(`OPTIONS`/`DESCRIBE`) 라인에서 URL의 `<channelSlot>` 파싱 → `channelSlot` → `cameraId` 매핑 조회 (기존 channelSlotService 재사용) — 존재하지 않으면 WS 종료.
3. **RTSP Digest(MD5) 인증** — 사용자 확정: 별도 JWT 없이, **해당 채널에 등록된 카메라의 `username`/`password`(DB에 이미 저장된 RTSP 자격증명)를 그대로 재사용**합니다. `rtspClient.js`의 `DigestGenerator`가 클라이언트 쪽에서 이미 표준 RTSP Digest challenge-response를 구현하고 있으므로, 브릿지가 서버 역할로 그 반대편(401 challenge 발급 → HA1=MD5(user:realm:pass) 검증)을 구현하면 `<ump-player username="..." password="...">`에 카메라 자격증명을 그대로 넣는 것만으로 별도 인증체계 없이 동작합니다. 인증 성공 전까지는 4번(내부 MediaMTX 연결)로 넘어가지 않습니다.
4. **(2026-07-24 변경, §8.13)** 인증 성공 후, ingest-daemon에 재발행을 요청하기 **전에** MediaMTX가 이 카메라를 위해 **이미 갖고 있는 직접 경로**(`rtsp://127.0.0.1:8554/<camera.id>` — `mediamtxManager.addCameraPath()`가 `webrtcEnabled` 카메라마다 등록해두는, WebRTC가 실제로 쓰는 바로 그 경로)가 `ready` 상태인지 짧게(400ms) 확인합니다.
   - **있으면**: 그 경로로 바로 연결하고 §4.1의 on-demand fan-out(ingest-daemon `add_rtsp_publish`)은 아예 요청하지 않습니다 — ingest-daemon의 GIL을 완전히 우회. 이 경로는 MediaMTX 자신의 RTSP 클라이언트(Go, non-GIL)가 카메라에서 직접 받으므로 fleet 부하와 무관하게 항상 원본 프레임레이트를 유지합니다(§8.13에서 실측: 동일 카메라를 ingest-daemon 경유로 받으면 40~60%, MediaMTX 직접 경로는 86%+).
   - **없으면(카메라가 `webrtcEnabled=false`이거나 MediaMTX가 아직 등록 전)**: 기존과 동일하게 §4.1의 on-demand fan-out으로 폴백 — `rtsp://127.0.0.1:8554/<channelSlot>/media.smp`로 연결.
5. 이후 WS ↔ TCP 순수 바이트 릴레이 (RTSP 파싱 불필요, §2.4) — 이 구간은 트랜스코딩이 없는 단순 바이트 복사라 CPU 비용이 사실상 0에 가깝습니다(사용자 설명과 일치).

### 4.3 채널 매핑

기존 `channelSlot`(카메라 CRUD 시 이미 배정되는 1..MAX_CHANNEL_NUM 값)을 그대로 RTSP 경로의 숫자로 사용 — 새 매핑 테이블 불필요.

---

## 5. 결정 사항 (전체 확정)

1. ~~RTSP Proxy 구현 방식~~ → **확정: MediaMTX 재사용** (§4.1, YouTube와 동일 패턴).
2. ~~인증~~ → **확정: WS 브릿지 계층에서 카메라별 저장된 username/password로 RTSP Digest(MD5) 인증** (§4.2-3). 별도 JWT 불필요.
3. ~~부하~~ → **확정: on-demand.** ingest-daemon의 6번째 fan-out(§4.1, MediaMTX publish)은 기존 `POST /cameras/:id/video-fanout`(§6.26, 동적 fan-out 추가 API)을 재사용해 **WS 브릿지의 해당 채널 첫 연결 시 추가, 마지막 연결 종료 시 제거**합니다. WS↔TCP 릴레이(§4.2) 자체는 순수 바이트 복사라 상시 대기 상태여도 비용이 사실상 0입니다.
4. ~~카메라 호환성 게이팅~~ → **확정: `supportSunapi`와 무관하게 노출.** 프록시가 로컬에서 재서빙하므로 원본 카메라의 SUNAPI 지원 여부는 더 이상 게이팅 조건이 아닙니다. 대신 카메라 Add/Edit 화면의 기존 **WebRTC On/Off 토글을 3-way 선택(JPEG(Default) / WebRTC / RTSP-over-WebSocket)으로 교체**합니다 (§7).
5. **서브모듈 중첩 관리** (미결정, 낮은 우선순위) — `app/media`, `app/external-lib`는 이번에 로컬에서만 `git config submodule.*.url`을 SSH로 override해서 체크아웃했습니다. `.gitmodules` 자체(HTTPS URL)를 SSH로 고칠지는 `ump-player` 리포 쪽 관리 사항이라 이 저장소 범위 밖입니다 — 다른 개발자가 `git submodule update --init --recursive`를 그대로 실행하면 지금 겪은 "Repository not found" 에러가 재현된다는 점만 기록해둡니다.

---

## 7. 카메라 재생 모드 UI/스키마 (신규)

### 7.1 현재 상태

`CameraEditModal.tsx:561-582` — RTSP/YouTube 폼 모두 `webrtcEnabled: boolean` 토글 하나로 "JPEG(Default) ↔ WebRTC"를 전환합니다. DB 스키마상 `camera.webrtcEnabled`(boolean)가 이를 저장합니다.

### 7.2 변경 후

`webrtcEnabled` boolean을 3-way 문자열 필드로 대체합니다:

```ts
type StreamingMode = 'jpeg' | 'webrtc' | 'ump';
```

- **저장 방식(리스크 최소화로 조정)**: `pipelineManager.js`에서 `camera.webrtcEnabled`가 파이프라인 재시작 판단·`addCameraStream()` 호출 등 여러 곳에서 이미 깊게 쓰이고 있고(과거 "CameraEditModal이 항상 webrtcEnabled를 보내서 변경 감지 로직이 오작동" 버그 이력도 있음, `cameras.js:581`), 이 필드의 내부 동작을 건드리는 건 리스크가 큽니다. 그래서 `streamingMode`는 **API 계층에서만** 존재하는 UI 소스-오브-트루스로 두고, 저장 시 서버가 기존/신규 필드로 파생합니다:
  - `streamingMode === 'webrtc'` → `webrtcEnabled: true` (기존 로직 그대로)
  - `streamingMode === 'jpeg'` → `webrtcEnabled: false` (기존 로직 그대로)
  - `streamingMode === 'ump'` → `webrtcEnabled: false` (WebRTC 파이프라인 불필요) + 신규 `umpEnabled: true`
  - `umpEnabled`는 완전히 새 필드라 기존 `webrtcEnabled` 관련 코드 경로에 전혀 영향을 주지 않습니다. `pipelineManager.js` 쪽은 §4.1/§8 phase 2에서 `umpEnabled`만 별도로 읽는 새 코드를 추가합니다.
  - 응답(GET) 시 `streamingMode`는 저장된 `webrtcEnabled`/`umpEnabled`로부터 역산해서 클라이언트에 내려줍니다 — 별도 마이그레이션 스크립트 불필요.
- **UI**: 기존 단일 토글 스위치 자리에 3버튼 세그먼트 컨트롤(JPEG(Default) / WebRTC / RTSP-over-WebSocket)로 교체. RTSP 폼과 YouTube 폼 양쪽에 동일 적용(YouTube는 RTSP-over-WebSocket 대상에서 제외 — YouTube 소스는 이미 MediaMTX 경로라 원본 카메라가 없고 SUNAPI 개념 자체가 없음).
- **파이프라인 연동**: `pipelineManager.js`가 아니라 `umpStreamingServer.js`(§4.2 WS 브릿지)가 직접 뷰어 수를 카운트해 첫 뷰어 진입/마지막 뷰어 이탈 시 ingest-daemon의 `POST`/`DELETE /cameras/:id/rtsp-publish`를 호출합니다 — `pipelineManager.js`는 이 경로에 관여하지 않습니다(카메라 파이프라인 시작/재시작 로직과 완전히 분리).

---

## 8. 구현 현황 (2026-07-23 갱신)

모든 주요 결정이 확정되어 v1.0으로 승격했고, 아래 5단계가 모두 구현 완료되었습니다:

1. **스키마 + 클라이언트 UI** (§7) — ✅ `server/src/api/cameras.js`(`streamingModeToFlags`/`deriveStreamingMode`), `CameraEditModal.tsx`/`CameraList.tsx` 3-way 토글, `client/src/types/index.ts`.
2. **ingest-daemon 6번째 fan-out** (§4.1) — ✅ `ingest_daemon.py`(`CameraSession.add_rtsp_publish`/`remove_rtsp_publish`, `POST`/`DELETE /cameras/:id/rtsp-publish`).
3. **`/StreamingServer` WS 브릿지** (§4.2) — ✅ `server/src/services/umpStreamingServer.js` (RTSP Digest 인증, 채널 라우팅, WS↔TCP 릴레이, on-demand fan-out 트리거), `server/src/index.js`에 연결. 신규 `GET /api/cameras/:id/ump-credentials`(JWT 게이트)로 카메라 자격증명을 브라우저에 전달.
4. **클라이언트 재생 컴포넌트 통합** — ✅ `client/src/components/RTSPOverWebSocketView.tsx`(신규), `CameraView.tsx`에 `streamingMode==='ump'` 분기 연동. `@melchi45/ump-player`(GitHub Packages, `optionalDependencies`)를 `client/scripts/copyUmpPlayerAssets.js`(`postinstall`)로 `public/`에 정적 자산 복사.
5. **문서 동기화** — ✅ `CLAUDE.md`/`copilot-instructions.md` API 표, `.claude`+`.github` skills. **미완료**: MRD/RFP/PRD/SRS/TC SDLC 문서 세트(계정 월간 사용량 한도로 백그라운드 에이전트 실패 — 한도 해제 후 재시도 필요).

### 8.1 알려진 제약 (2026-07-24 갱신)

- ~~실제 카메라/브라우저로 end-to-end 재생 검증 미완료~~ → **완료(2026-07-24)**: channelSlot=6 실 카메라로 브라우저 재생 검증, §8.9~8.13의 크래시/세그폴트/스로틀링 버그를 모두 실측으로 잡아 30fps 정상 수신 확인.
- `client/.npmrc`에 `npm.pkg.github.com` 개인 토큰이 로컬에만 있음 — 다른 개발자/CI 환경은 별도 설정 필요(토큰 없으면 `optionalDependencies`라 설치는 실패하지 않지만 RTSP-over-WebSocket 모드가 비활성 상태로 남음).
- `<ump-player>` 재생 시 줌/오버레이(구역 편집 캔버스)는 아직 JPEG/WebRTC 경로와 통합되지 않음 — RTSP-over-WebSocket 모드는 순수 비디오만 표시.
- §8.13의 MediaMTX 직접 경로 재사용은 카메라가 `webrtcEnabled: true`일 때만 적용됨 — `webrtcEnabled: false`인 RTSP-over-WebSocket 전용 카메라는 여전히 §8.12의 ingest-daemon 경유 fan-out(fleet 부하에 따라 프레임레이트 저하 가능)을 탄다.

### 8.2 버그 수정 — "Loading RTSP-over-WebSocket player…" 무한 대기 (2026-07-23)

라이브 확인 중 카메라 타일이 로딩 placeholder에서 멈추는 문제 발견. 1차 조치로 `crypto-js`/`ffmpegAAC.js` 로드 순서를 추가했으나 재현됨 — **jsdom으로 실제 스크립트를 그대로 실행해 진짜 원인을 확인**(`/tmp` 스크래치 하네스, `JSDOM({ runScripts: 'dangerously' })`로 `ump-player.min.js`를 그대로 `eval`):

```
TypeError: Logger is not a constructor
```

`ump-player.min.js` 최상단 초기화 코드가 다음과 같이 되어 있음(번들 자체 코드):
```js
window.log = typeof window.log4javascript != 'undefined' ? window.log4javascript :
  typeof log4js != 'undefined' ? log4js : new Logger();
```
`window.log4javascript`도 `log4js`도 없으면 `new Logger()` 폴백으로 가는데, 이 폴백 자체가 번들 내부에서 깨져 있어(자체 버그) throw함 — 이 시점에서 스크립트 전체 평가가 중단되어 `customElements.define('ump-player', ...)`까지 도달하지 못하고, `customElements.whenDefined('ump-player')`가 영원히 resolve되지 않음. `crypto-js`(RTSP Digest 인증, `digestGenerator.js`가 참조)도 별도의 외부 전역 의존성으로 확인됨 — 이건 스크립트 실행 자체를 막지는 않지만(참조 시점이 함수 본문 내부라 지연 평가) 인증 단계에서 필요.

jsdom으로 `log4javascript.js`를 `crypto-js.js` 앞에 로드한 뒤 재실행하니 `customElements.get('ump-player')`가 정상적으로 정의됨을 확인.

추가로 확인된 것: `device="camera"` 모드에서 `profile`/`profile_number` 속성이 없으면 `generateRTSPURL()`이 즉시 throw하고(`"profile information is empty"`), `autoplay` 속성만으로는 `connectedCallback()`의 조건부 게이트(`_autoplay && (_profile || _profile_number) && _deviceType`)를 항상 만족하지 못해 재생이 시작되지 않음 — 패키지 자체 예제도 `autoplay` 속성이 아니라 `body onload="play()"`로 명시적 `.play()` 호출을 사용.

**수정**: `client/scripts/copyUmpPlayerAssets.js`가 `node_modules/log4javascript/js/log4javascript.js`와 `node_modules/crypto-js/crypto-js.js`를 각각 `public/ump-player/`로 복사, `RTSPOverWebSocketView.tsx`가 **`log4javascript.js` → `crypto-js.js` → `ffmpegAAC.js`(이미 복사되던 `media/`에 포함) → `ump-player.min.js`** 순서로 로드, `profile_number="1"` 속성 추가, `autoplay` 속성 제거하고 엘리먼트 ref에 명시적 `.play()` 호출 + `'error'` CustomEvent 리스너로 재생 실패를 UI에 노출. jsdom으로 unminified `dist/@melchi45/ump-player.js`도 동일하게 재현해 확인 — 이 버그는 minify 과정 문제가 아니라 패키지 소스 자체의 버그.

### 8.3 버그 수정 — `device`/`width`/`height` 속성 누락 (2026-07-23, npm 패키지 `dist/html`·`dist/docs` 확인 결과)

§8.2 수정 후에도 여전히 재생되지 않아, `client/node_modules/@melchi45/ump-player/dist/html/*.html`(패키지가 실제로 배포하는 사용 예제)과 `dist/docs`(JSDoc API 문서)를 직접 확인해 두 가지 추가 문제를 확정:

1. **`width`/`height` 속성 누락** — JSDoc: `width` "width of HTML element **{optional, but element can not be display}**" — 즉 이 속성이 없으면 엘리먼트가 아예 렌더링될 수 없음. 이전 구현은 CSS(`style={{width:'100%',height:'100%'}}`)만 설정하고 이 속성 자체를 빼먹었음.
2. **`device="camera"` 대신 `device="nvr"` 사용** — `dist/html/ump-player-play.html`(패키지가 실제로 배포하는, 주석 처리 안 된 유일한 살아있는 예제)이 `channel`을 쓰는 유일한 조합은 `device="nvr"` + `profile_number`. JSDoc도 "device type {mandatary: camera or nvr}"이고, `channel` JSDoc은 "channel number of NVR device"라고 명시 — `channel` 속성 자체가 NVR 모드 전용. `device="camera"` 예제는 `channel` 없이 `profile="H.264"` 같은 스트림 프로파일명만 씀. 우리 사용 사례(하나의 WS 엔드포인트 뒤에서 channelSlot으로 카메라를 구분)는 구조적으로 NVR 모드에 해당.
3. **NVR 모드의 RTSP 경로 형식이 다름** — `device="nvr"`의 `generateRTSPURL()`은 `"LiveChannel/" + channel + "/media.smp"`를 만듦(camera 모드처럼 채널 번호로 시작하지 않고 `LiveChannel/` 접두사가 붙음). `umpStreamingServer.js`의 `extractChannelSlot()`이 경로 **맨 앞** 숫자만 찾던 것을 **경로 어디든** 첫 숫자 세그먼트를 찾도록 일반화(`/^\/?(\d+)(?:\/|$)/` → `/\/(\d+)(?:\/|$)/`) — camera 모드(채널 우선) 형식도 그대로 호환.

**수정**: `RTSPOverWebSocketView.tsx`에 컨테이너 `<div>` + `ResizeObserver`를 추가해 타일의 실제 렌더 크기를 측정, `width`/`height` 속성으로 전달(크기 확정 전에는 로딩 표시 유지). `device="camera"` → `device="nvr"`로 변경. `umpStreamingServer.js`의 채널 추출 정규식을 위와 같이 일반화.

### 8.4 코드 리뷰 반영 — `port` 폴백을 서버 실제 설정값으로 (2026-07-23)

`port={window.location.port || (secure ? '443' : '80')}` — `window.location.port`가 비어있는 경우(페이지 자체가 프로토콜 기본 포트로 서빙된 경우, 예: 리버스 프록시가 443/80으로 종단)의 폴백값이 범용 웹 표준 포트(443/80)로 하드코딩되어 있었음. 이 프로젝트의 실제 기본값은 `HTTPS_PORT=3443`/`HTTP_PORT=3080`(비표준)이라 이 하드코딩은 이 프로젝트 배포 환경에서는 사실상 항상 틀린 값 — 리뷰 지적으로 확인.

**수정**: `vite.config.ts`가 이미 `server/.env`를 파싱해 `HTTPS_PORT`/`HTTP_PORT`를 읽고 있던 기존 패턴(`loadServerEnv()`, dev 프록시 target 계산용)을 재사용 — `define`으로 `__LTS_HTTPS_PORT__`/`__LTS_HTTP_PORT__` 빌드타임 상수를 클라이언트 번들에 주입하고, `RTSPOverWebSocketView.tsx`의 폴백을 이 값으로 교체. `vite build`로 실제 번들에 `3443`/`3080`이 올바르게 주입되는지 확인.

### 8.5 버그 수정 — 릴레이 시 RTSP 요청 URI를 재작성하지 않던 문제 (2026-07-23, 실 카메라 라이브 테스트 중 발견)

§8.2~8.4 수정 후 실제로 재생을 시도한 결과 (라이브 로그로 확인):
1. `/StreamingServer` WS 연결 정상 open
2. RTSP Digest 인증도 정상 성공 (`digest auth OK — switching to relay` 서버 로그 확인)
3. 그 직후 WS가 코드 **1005(No Status Recvd — 비정상 종료)**로 끊김

인증 성공한 첫 요청의 URI가 `rtsp://dev.hanwhavision.com/LiveChannel/3/media.smp/profile=1`(브라우저가 `hostname`/`channel`/`profile_number` 속성으로 만든 자체 URI)이었는데, §4.2 설계상 "인증 이후엔 순수 바이트 릴레이"라서 **이 URI를 그대로 MediaMTX로 전달하고 있었음**. 하지만 MediaMTX가 실제로 서빙 중인 경로는 ingest-daemon이 publish한 `rtsp://127.0.0.1:{MEDIAMTX_RTSP_PORT}/{channelSlot}/media.smp`(예: `3/media.smp`)로 완전히 다른 문자열 — MediaMTX가 인식 못 하는 경로 요청을 받고 TCP 연결을 끊어버렸고, 그게 브라우저에 1005로 나타남. 이어지는 `DESCRIBE` 요청도 동일하게 잘못된 URI로 나가는 것을 서버 로그로 재확인.

**"순수 바이트 릴레이" 설계 자체가 이 지점에서는 틀렸음** — 클라이언트→백엔드 방향의 RTSP 요청 URI만큼은 MediaMTX가 실제로 아는 경로로 재작성해야 함(클라이언트→서버 방향 메시지는 RTP/RTCP 바이너리가 섞이지 않고 항상 RTSP 텍스트 요청뿐이라 안전하게 요청 라인만 치환 가능).

**수정**: `umpStreamingServer.js`에 `rewriteRequestUri(text, targetUri)` 추가 — 요청 라인의 URI만 `rtsp://127.0.0.1:{MEDIAMTX_RTSP_PORT}/{channelSlot}/media.smp`로 치환하고 나머지 헤더/바디는 그대로 둠. 인증 성공 직후의 최초 forward와, 이후 `state==='relaying'`일 때의 매 메시지(`relayToBackend()`) 양쪽 모두에 적용 — 인증 후 첫 요청만이 아니라 DESCRIBE/SETUP/PLAY 등 세션 전체에 걸쳐 재작성됨. 재작성이 실제로 일어나면 서버 로그에 남도록 함.

### 8.6 버그 수정 — on-demand fan-out과 DESCRIBE 사이의 레이스 컨디션 (2026-07-23, 실 카메라 라이브 테스트 중 발견)

§8.5 수정 후 재시도한 결과, MediaMTX가 이번엔 경로 자체는 정확히 인식했지만(`no stream is available on path '3/media.smp'`) 곧바로 연결을 닫음 — 로그 타임라인상 ingest-daemon의 `RTSP publish added` 로그와 MediaMTX가 DESCRIBE를 거부하는 시점 사이 간격이 10ms 미만. `_acquireViewer()`는 ingest-daemon의 `POST /rtsp-publish` **HTTP 응답**(자신의 `av.open()` 호출이 리턴)만 기다릴 뿐, MediaMTX가 그 publish 세션을 실제로 "활성" 상태로 인식하기까지의 시간은 기다리지 않음 — `pipelineManager.js`가 다른 MediaMTX 경로들(YouTube 등)에서 이미 겪고 고쳤던 것과 정확히 같은 레이스(§4.1 참고, "MediaMTX 업스트림이 준비되기 전에 캡처 클라이언트가 연결").

**수정**: 그 기존 해법을 그대로 재사용 — `_connectBackend()` 호출 전에 `mediamtxManager.waitForPathReady(\`${channelSlot}/media.smp\`, 8000, 250)`(250ms 간격으로 최대 8초 폴링, MediaMTX REST API `/v3/paths/get/:name`의 `ready` 플래그 확인)를 추가. 타임아웃돼도 치명적 오류로 취급하지 않고 경고 로그만 남긴 뒤 그대로 연결 시도(기존 `pipelineManager.js`의 동일 패턴과 일관되게 best-effort).

### 8.7 심각한 버그 수정 — `add_rtsp_publish()`의 동기 `av.open()`이 ingest-daemon 전체를 멈춤 (2026-07-23, 실 카메라 라이브 테스트 중 발견)

§8.6 수정 후에도 `waitForPathReady()`가 8초 내내 "path not found"만 받다가 타임아웃되는 것을 확인 — 로그를 보니 원인이 훨씬 심각했음:

```
[UmpStreamingServer] rtsp-publish start failed: The operation was aborted due to timeout   (5초 타임아웃)
[IngestWatchdog] health check failed (1/2) — http://127.0.0.1:7070/health                  ← 워치독 헬스체크도 실패
[UmpStreamingServer] rtsp-publish stop failed: The operation was aborted due to timeout
```

`POST /rtsp-publish` 요청만 실패한 게 아니라 **ingest-daemon 워치독의 `/health` 체크까지 같은 시간대에 실패** — ingest-daemon의 HTTP 서버 전체가 응답 불능 상태에 빠졌던 것. 원인: `add_rtsp_publish()`의 `av.open(pub_url, "w", format="rtsp", ...)` 호출에 **타임아웃 옵션이 전혀 없었고**(읽기 쪽 RTSP 연결엔 이미 `stimeout`을 쓰고 있었는데 publish 쪽엔 빠져 있었음), 이걸 HTTP 요청 핸들러 스레드에서 그대로(동기) 실행하고 있어서, MediaMTX와의 ANNOUNCE 핸드셰이크가 응답 없이 오래 걸리면 그 스레드가 무기한 블로킹됨.

**수정**: `add_rtsp_publish()`가 락 범위 안에서는 빠른 북키핑만 하고, 실제 `av.open()` 핸드셰이크는 기존 `_SHARED_STOP_EXECUTOR`(bounded thread pool, teardown용으로 이미 존재)에 제출해 백그라운드로 돌리도록 변경 — HTTP 핸들러는 즉시 응답 반환(Node 쪽은 이미 `waitForPathReady()` 폴링으로 지연을 감내하도록 설계돼 있어 호환). 백그라운드 완료 시점엔 락을 다시 잡고 `_rtsp_publish_requested`/`_video_template_stream`이 그사이 바뀌지 않았는지 재검증 후 등록. `av.open()`에도 `rw_timeout`(RTSP_READ_TIMEOUT과 동일값, 마이크로초)을 추가해 핸드셰이크 자체에 상한을 둠 — io 스레드의 (재)연결 시점 publish 오픈 경로에도 동일하게 추가.

### 8.8 버그 수정 — SETUP 요청이 "invalid SETUP path"로 거부되어 OPTIONS→SETUP 무한 재시도 (2026-07-23, 실 카메라 라이브 테스트 중 발견)

§8.5~8.7 수정 후 DESCRIBE까지는 정상 처리되고(`stream is available and online, 1 track (H265)`) MediaMTX가 실제로 publish를 서빙하는 것도 확인됐지만, 곧이어 온 SETUP 요청마다 MediaMTX가 다음 로그와 함께 연결을 끊었음:

```
closed: invalid SETUP path. This typically happens when VLC fails a request,
and then switches to an unsupported RTSP dialect
```

연결이 끊기면 클라이언트(`<ump-player>`)는 처음부터(OPTIONS CSeq:1) 재시도하고, 매번 SETUP에서 동일하게 거부당해 **OPTIONS→DESCRIBE→SETUP→종료**가 무한 반복됨.

원인은 §8.5에서 도입한 `rewriteRequestUri()`가 요청 메서드와 무관하게 요청 라인의 URI 전체를 항상 동일한 고정 문자열(`rtsp://127.0.0.1:{MEDIAMTX_RTSP_PORT}/{channelSlot}/media.smp`)로 통째로 치환하고 있었던 것. OPTIONS/DESCRIBE는 애초에 클라이언트가 그 베이스 URI를 그대로 재사용하므로 문제가 없었지만, `rtspClient.js`의 `CommandConstructor`는 SETUP 요청 URI를 `<Content-Base 또는 최초 요청의 베이스 URI> + <트랙 식별자>` 형태로 만든다(트랙 식별자는 DESCRIBE 응답 SDP를 파싱해서 얻음) — 즉 SETUP의 URI는 베이스 뒤에 트랙별 접미사(예: `/trackID=0`)가 붙은 문자열인데, 이걸 통째로 같은 베이스 문자열로 덮어써버리면 SETUP 요청이 DESCRIBE와 완전히 동일한 URI가 되어버림. MediaMTX 입장에서는 트랙 지정 없는 SETUP이라 "invalid SETUP path"로 거부.

**1차 수정**: `rewriteRequestUri(text, clientBaseUri, targetUri)`로 시그니처 변경 — 채널을 처음 매칭한 요청의 URI를 `clientBaseUri`로 세션 내내 보관해두고, 이후 모든 요청은 "URI가 그 `clientBaseUri`로 시작하면, 그 **접두사만** `targetUri`로 치환하고 나머지(트랙 접미사 등)는 그대로 보존"하도록 변경.

**1차 수정 배포 후 재현된 잔여 버그**: 실제 라이브 로그로 재확인한 결과 여전히 `SETUP ... -> "SETUP rtsp://127.0.0.1:8554/3/media.smp RTSP/1.0"`로 트랙 접미사가 사라지고 있었음. 원인은 클라이언트가 SETUP URI를 만들 때 자기 자신의 `clientBaseUri`가 아니라 **DESCRIBE 응답의 `Content-Base` 헤더**(MediaMTX가 알려준 자기 자신의 베이스, 예: `rtsp://127.0.0.1:8554/3/media.smp/`)를 사용했기 때문 — 이 헤더는 백엔드→클라이언트 방향이라 재작성하지 않고 그대로 전달했으므로, 클라이언트가 만든 SETUP URI(`rtsp://127.0.0.1:8554/3/media.smp/trackID=0`)는 **이미 MediaMTX 기준으로 완벽히 올바른 값**이었음. 그런데 이 문자열은 `clientBaseUri`(`rtsp://dev.hanwhavision.com/...`)로 시작하지 않으므로 접두사 매칭에 실패해 "알 수 없는 접두사" 폴백 분기로 빠지고, 거기서 다시 통째 치환되며 트랙 접미사가 지워짐 — 고치려던 버그를 폴백 분기가 그대로 재현하고 있었음.

**최종 수정**: `rewriteRequestUri()`에 우선순위 있는 3단 분기 추가 — ① URI가 이미 `targetUri`로 시작하면(클라이언트가 MediaMTX의 Content-Base로 이미 올바르게 만든 경우) **아무것도 건드리지 않고 그대로 통과**, ② `clientBaseUri`로 시작하면 그 접두사만 치환(기존 로직), ③ 둘 다 아니면 통째 치환으로 폴백. Node로 실제 로그에서 캡처된 두 SETUP URI 패턴(`<clientBaseUri>/trackID=0`과 `<targetUri>/trackID=0` 둘 다) 및 DESCRIBE를 모두 재현해 검증함(`server/src/services/umpStreamingServer.js`).

부수적으로, §8.7에서 추가했던 `rw_timeout` AVOption이 매 publish마다 `WARNING Some options were not used: {'rw_timeout': '5000000'}`로 무시되고 있던 것도 함께 조사 — `ingest_daemon.py`가 이미 읽기 쪽 RTSP 연결 전체에서 일관되게 써온 `stimeout`(FFmpeg의 `rtsp.c` 공용 AVOption 클래스가 실제로 인식하는 타임아웃 키)이 아니라, 인식되지 않는 `rw_timeout`을 썼던 게 원인 — publish 쪽 두 곳(io 스레드 재연결 경로, `_open_rtsp_publish_async()`) 모두 `stimeout`으로 교정. 경고만 나던 게 아니라 §8.7에서 의도한 핸드셰이크 타임아웃 보호 자체가 동작하지 않고 있었던 것이므로, 방치하지 않고 바로잡음.

### 8.9 버그 수정 — on-demand fan-out이 GOP 중간에 합류해 VPS/SPS/PPS 없이 시작, 플레이어가 첫 프레임에서 크래시 (2026-07-23, 실 카메라 라이브 테스트 중 발견)

§8.8까지 수정 후 OPTIONS→DESCRIBE→SETUP→PLAY 전체 RTSP 핸드셰이크가 정상 완료되고 WS로 실제 RTP 데이터가 들어오기 시작했지만(라이브 로그에서 세션 성립 확인), 브라우저에 `RTSP-over-WebSocket playback error: Cannot read properties of null (reading 'byteLength')`가 표시됨:

```
TypeError: Cannot read properties of null (reading 'byteLength')
    at ... i.parse ... x.onVideoData ... x.depacketize ... RtspClient.d.RtpDataHandler ... Transport.r.OnReceive
```

사용자 지적("RTSP-over-WebSocket는 RTSP의 SDP에서 처리하고 있는데")을 계기로 `submodules/ump-player`의 실제 소스(`MediaSession/VideoSession/h265Session.js`, `Util/h265SPSParser.js`)를 직접 확인: SDP의 `a=fmtp` 라인에 있는 `sprop-vps`/`sprop-sps`/`sprop-pps`(base64 파라미터셋)는 `rtspClient.js`가 파싱은 하지만(`session.VPS`/`.SPS`/`.PPS`), 실제로 디코더 상태를 시딩하는 데 쓰이는 곳이 코드베이스 어디에도 없음 — H265 세션은 **오직 인밴드 RTP NAL 유닛**(VPS/SPS/PPS 타입)이 들어와야만 `vpsPayload`/`spsPayload`/`ppsPayload`를 채우고, 그 전에 마커비트(프레임 완성)가 찍힌 패킷이 오면 `spsParse(null, "H265")` → `nal_unit_extract_rbsp(null)`에서 `null.byteLength`로 그대로 크래시(npm 배포 번들의 난독화된 스택트레이스 `i.parse`/`x.onVideoData`/`x.depacketize`와 정확히 일치).

원인은 우리 파이프라인 쪽에 있었음: `ingest_daemon.py`의 카메라 세션 자체는 최초 접속 시 `idr_seen`/`IDR_WAIT_TIMEOUT` 게이트로 첫 키프레임까지 대기한 뒤에만 패킷 루프를 시작하지만(라인 865-891, 세션 전체에 1회 적용), **`add_rtsp_publish()`/`add_video_fanout()`로 세션이 이미 돌고 있는 도중에 동적으로 추가되는 새 fan-out 대상은 이 게이트를 전혀 거치지 않고, 그 시점에 흘러가던 아무 패킷부터 즉시 전달받기 시작**했음. H.265 RTSP 소스는 보통 VPS/SPS/PPS를 IDR 슬라이스 NAL과 함께 같은 libav 패킷(Annex-B로 합쳐진 access unit)에 담아 GOP마다 한 번씩만 보내므로, on-demand fan-out이 GOP 중간에 합류하면 파라미터셋 없는 P-슬라이스만 받다가 그대로 플레이어가 크래시.

**수정**: `self._video_fanout`에 동적으로(세션이 이미 러닝 중일 때) 추가되는 두 진입점 — `add_rtsp_publish()`의 `_open_rtsp_publish_async()`와 `add_video_fanout()`의 즉시-오픈 분기 — 모두에 `"needsKeyframe": True` 플래그를 부여. 패킷 루프의 fan-out 디스패치(`for _o in self._video_fanout: ...`)가 엔트리별로 이 플래그를 확인해, `True`인 동안은 `packet.is_keyframe`이 아닌 패킷을 건너뛰다가 다음 키프레임(=VPS/SPS/PPS+IDR이 함께 담긴 패킷)에서 플래그를 내리고 그때부터 전달 시작. 연결 시점에 세션 전체 게이트를 통과한 뒤 구성되는 기존 진입점들(재연결 시 매번 새로 만들어지는 `_video_fanout` 리스트, 라인 783/816)은 이미 안전하므로 변경 없음. `add_video_fanout()`(mediasoup RTP fan-out)에도 동일 클래스의 버그가 잠재해 있어 함께 수정 — WebRTC 쪽은 PLI로 자연 치유되지만 일관성과 견고성을 위해 동일하게 게이팅.

### 8.10 버그 수정 — STAP-A 집합 패킷 미처리로 SPS/PPS null 크래시 (H.264, 2026-07-24, channelSlot=6 실 카메라)

§8.9와 증상은 동일(`Cannot read properties of null (reading 'byteLength')`, `nal_unit_extract_rbsp(null)`)하지만 원인은 다른 카메라·다른 코덱(H.264)·다른 메커니즘. `submodules/ump-player`의 `h264Session.js` `depacketize()`의 switch문은 단독 SPS(NAL 타입 7)/PPS(타입 8)와 FU-A 프래그먼트(타입 28)만 처리했고, RFC 6184 §5.7.1의 **STAP-A 집합 패킷(타입 24 — 인코더가 SPS+PPS+IDR을 한 RTP 패킷에 묶어 보내는 방식)은 처리 케이스가 아예 없어 `default:` 분기로 흘러가 원본 바이트를 그대로 밀어 넣기만 했다** — `H264NalUnit` enum에도 24~27번이 `H264_NAL_UNSPECIFIED24..27`로만 정의되어 있어 STAP-A라는 사실 자체가 코드에 드러나지 않았음. 이 카메라(channelSlot=6)의 인코더가 정확히 이 방식으로 패킷화하고 있어 `sps_segment`/`pps_segment`가 영원히 null로 남았고, `mediaRouter.js`가 매 프레임(marker bit 세팅 시) `spsParse()`를 호출할 때마다 크래시.

**수정**: `h264Session.js`에 STAP-A(24) 케이스 추가 — 내부 `[2바이트 길이][NAL]` 반복 구조를 순회하며 SPS/PPS를 추출해 정상적으로 `sps_segment`/`pps_segment`에 반영. STAP-B/MTAP16/MTAP24(25~27)는 조용히 오염되는 대신 명시적 미지원 에러로 즉시 실패하도록 별도 처리(enum도 `H264_NAL_STAP_A`/`STAP_B`/`MTAP16`/`MTAP24`로 개명). `mediaRouter.js`의 `spsParse()`에도 SPS가 여전히 없을 때 원인 불명의 `TypeError` 대신 명확한 `umpError`(0x0304)를 던지도록 방어 가드 추가 — 이후 유사 상황이 재발해도 진단이 빨라짐.

### 8.11 심각한 버그 수정 — `_open_rtsp_publish_async()`의 use-after-free 세그폴트 (2026-07-24, dmesg로 확인)

§8.10 수정 배포 후 channelSlot=6을 반복적으로 Play/재연결하면서 ingest-daemon 자체가 간헐적으로 죽는 현상 발견 — 재현할 때마다 `startServer.js`의 자동 재시작 로그(`ingest-daemon crashed — restarting`)는 남지만 Python 트레이스백은 전혀 없었음. `dmesg`로 확인한 결과 매번:

```
python3[<pid>]: segfault ... in libavformat.so.58.76.100
```

세그폴트는 Python 예외 처리 밖(OS 레벨)에서 프로세스를 즉사시키므로 트레이스백이 남지 않았던 것. 원인: `_open_rtsp_publish_async()`가 io 스레드가 소유한 살아있는 PyAV `Stream` 객체(`vs`)를 인자로 받아, `self._video_fanout_lock` **없이** `pub_out.add_stream(template=vs)`를 호출했음. 같은 카메라가 재연결로 컨테이너를 `close()`하면 `vs`가 가리키는 `AVStream`이 그 순간 해제되는데, 이 백그라운드 스레드가 마침 그 `vs`를 역참조하는 중이면 use-after-free. 게다가 io 스레드 쪽의 `self._video_template_stream` 대입/해제(연결/해제 시점)도 애초에 같은 락 없이 이루어지고 있어, "재검증 후 사용"이라는 기존 방어(`self._video_template_stream is not vs` 체크)조차 다른 스레드의 대입과 경쟁 상태였음.

**수정**: (1) io 스레드의 `_video_template_stream` 대입(연결 시)·해제(연결 종료 시) 양쪽을 `_video_fanout_lock`으로 보호. (2) `_open_rtsp_publish_async()`에서 `add_stream(template=vs)` 호출 자체를 락 안으로 옮기고, **`vs`를 건드리기 전에** 재검증하도록 순서를 바꿈(기존엔 검증이 호출 *뒤*에 있어 이미 늦은 체크였음). io 스레드가 재연결로 같은 락을 잡으려 대기하는 동안은 `vs`가 가리키는 컨테이너가 `close()`될 수 없으므로 구조적으로 안전. 같은 채널에 40회 동시 rapid start/stop을 반복하는 스트레스 테스트로 신규 세그폴트 0건 확인.

### 8.12 아키텍처 변경 — PyAV RTSP `mux()`가 GIL을 놓지 않아 카메라 읽기 자체가 스로틀링되는 문제 (2026-07-24)

§8.11 수정 후에도 RTSP-over-WebSocket로 보는 영상이 계속 끊겨서 조사한 결과, ingest-daemon 자체의 카메라 읽기 속도(`video_packets_total`, 팬아웃과 무관하게 매 패킷 증가)가 채널6에 rtsp-publish 엔트리가 붙어있을 때만 카메라의 실측 30fps(ffprobe로 카메라에 직접 붙어 확인) 대비 6fps 안팎으로 떨어짐 — 엔트리를 떼면 즉시 34fps로 회복. `_video_fanout` 디스패치 루프에서 `_mux_passthrough()`(내부적으로 `out.mux()`) 호출 자체가 io 스레드에서 동기적으로 실행되고 있었으므로, 이 호출 하나가 io 스레드를 오래 붙잡으면 다음 패킷을 읽는 시점도 그만큼 밀린다는 가설을 세워 별도 스레드로 옮겨봤으나(순수 threading, GIL은 공유) **효과가 없었음**.

직접 실험으로 원인 확정: 같은 프로세스에서 pure-Python spin 카운터 스레드를 하나 띄우고, 다른 스레드에서 `out.mux()`를 (아무도 읽지 않는 소켓에) 블로킹되도록 호출했더니 — spin 카운터가 그 `mux()` 호출이 끝날 때까지 **완전히 멈췄음**(`time.sleep(3)` 한 줄만 있는 메인 스레드조차 3초를 못 끝냄). **PyAV의 RTSP `mux()`는 블로킹 네트워크 쓰기 동안 GIL을 놓지 않는다** — CPython의 GIL은 프로세스 전체에 하나뿐이므로, 이 호출을 어느 OS 스레드에서 하든 같은 프로세스의 다른 모든 파이썬 스레드(카메라를 읽는 io 스레드 포함)가 똑같이 멈춘다. 스레드 분리로는 원천적으로 해결 불가능한 문제였음.

**수정**: `rtsp_publish_worker.py`라는 완전히 별도의 파이썬 서브프로세스를 신설 — 실제 `av.open()`/`add_stream()`/`mux()`는 이 프로세스가 전담하고(자체 GIL), ingest-daemon은 stdin 파이프로 `[pts(8) dts(8) time_base_num(4) time_base_den(4)][길이][raw NAL bytes]` 프레임만 흘려보낸다. 발견된 부수 버그 2개도 실 카메라 데이터로 재현·수정: PyAV는 `add_stream()`(인코더 컨텍스트)에 `extradata`를 직접 대입하는 것을 금지(`"Can only set extradata for decoders"`) — 기존 §8.9의 in-band 파라미터셋 주입 메커니즘을 그대로 재사용해 우회. `av.Fraction`은 이 PyAV 버전에 존재하지 않아 `fractions.Fraction`으로 교체. 세그폴트 스트레스 테스트를 이 신규 아키텍처에서도 재실행해 이상 없음을 재확인.

### 8.13 아키텍처 변경 — ingest-daemon 우회: 기존 MediaMTX 직접 경로 재사용 (2026-07-24)

§8.12로 개별 카메라 하나의 fan-out은 더 이상 io 스레드를 막지 않게 됐지만, 여전히 카메라 10대 분량의 RTSP 읽기+AI 디코드를 **하나의 파이썬 프로세스(하나의 GIL)**가 처리하는 구조라 fleet 전체 부하가 개별 카메라의 실효 프레임레이트를 깎아먹는 현상은 남아있었음(실측: 채널6 raw 읽기 속도가 카메라 실제 전송량의 40~63% 수준, AI 디코드 끄면 63%까지 회복 — 나머지는 다른 9개 카메라의 io/AI 스레드와의 GIL 경합).

사용자 지적("WebRTC는 30fps를 다 받던데")을 계기로 재확인: 이 배포는 `WEBRTC_ENGINE=mediamtx`로 설정되어 있고, `mediamtxManager.addCameraPath()`가 **`webrtcEnabled` 카메라마다 MediaMTX 자신의 RTSP 클라이언트(Go, non-GIL)로 카메라를 직접 pull**해 `rtsp://127.0.0.1:8554/<camera.id>` 경로로 이미 상시 서빙하고 있었음 — 브라우저의 WebRTC(WHEP) 연결도 이 경로에 MediaMTX가 직접 응답하므로 **ingest-daemon의 파이썬 프로세스를 전혀 거치지 않는다**. 실측(브라우저 WebRTC 통계 `RTCInboundRtpStreamStats`): `framesPerSecond: 30`, 패킷 손실 0.01% 미만 — fleet 부하와 무관하게 항상 healthy. channelSlot=6 카메라도 마찬가지로 이 직접 경로가 이미 `ready` 상태였고(`webrtcEnabled: true`), MediaMTX API로 실측한 inbound 처리량도 카메라 실제 전송량의 86%(ingest-daemon 경유의 40~63%보다 훨씬 건강).

**결론**: RTSP-over-WebSocket가 카메라의 원본 프레임레이트를 안정적으로 받으려면, ingest-daemon에 "6번째 fan-out"을 새로 요청할 이유가 없는 경우가 많다 — 그 카메라가 이미 MediaMTX에 직접 ingest되어 있다면(=`webrtcEnabled: true`) 그 경로를 그대로 재사용하면 된다.

**수정**: `umpStreamingServer.js`의 인증 성공 핸들러에서, ingest-daemon에 `add_rtsp_publish()`를 요청하기 **전에** MediaMTX가 이 카메라의 직접 경로(`camera.id`로 명명된 기존 경로)를 이미 `ready` 상태로 갖고 있는지 짧게(400ms) 확인한다. 있으면 그 경로로 바로 연결하고 ingest-daemon 요청 자체를 생략(§4.2 개정). 없으면(카메라가 `webrtcEnabled=false`인 경우 등) §4.1/§8.12의 on-demand fan-out으로 그대로 폴백 — 기존 경로는 삭제하지 않고 fallback으로 유지. 채널6 실 카메라로 브라우저에서 재생해 30fps 수신 확인 완료.

> **2026-07-24 후속 수정 (§8.14) — 위 "없으면(webrtcEnabled=false 등) 폴백" 문구는 더 이상 정확하지 않습니다.** `webrtcEnabled=false`이면서 `umpEnabled=true`인 순수 RTSP-over-WebSocket 카메라는 §8.14 수정 이전엔 **MediaMTX 직접 경로가 애초에 존재하지 않아** 항상 폴백만 탔습니다 — 아래 §8.14 참고.

### 8.14 버그 수정 — §8.13 우회가 RTSP-over-WebSocket 전용(webrtcEnabled=false) 카메라에는 적용되지 않던 결함 (2026-07-24)

**증상**: §8.13 배포 당일, `webrtcEnabled`도 함께 켜진 카메라는 30fps가 나왔지만 channelSlot=6(**RTSP-over-WebSocket만 켜고 WebRTC는 꺼둔** 카메라)이 다시 ~13.5fps로 저하됨을 ffmpeg 직접 측정(MediaMTX loopback에 15초, 187 frames/13.84s)으로 확인. 사용자 지적("이전에 mediamtx랑 확인하면서 30fps 나왔다고")을 계기로 재조사.

**원인**: `pipelineManager.js`의 `needsMediaMTX` 조건이 `camera.webrtcEnabled`만 검사하고 있었음 — §8.13의 우회가 전제하는 "MediaMTX가 이미 이 카메라를 pull 중"이라는 조건 자체가, WebRTC를 안 쓰는 순수 RTSP-over-WebSocket 카메라에서는 **한 번도 성립한 적이 없었음**(`mediamtxManager.addCameraPath(camera.id, ...)`가 호출된 적이 없으므로). 그래서 §4.2의 400ms `waitForPathReady(camera.id, ...)` 체크가 이 카메라에서는 항상 실패하고, 매번 ingest-daemon 폴백(§4.1/§8.12)만 탔음.

**수정**: `needsMediaMTX`를 `(requestedWebRTC || requestedUmp) && WEBRTC_ENGINE === 'mediamtx'`로 확장 — RTSP-over-WebSocket 전용 카메라도 `camera.id` MediaMTX 경로가 등록되도록 함. 브라우저 WHEP 노출 여부(`useWebRTC`)는 `requestedWebRTC`만으로 별도 게이트돼 있어 이 변경이 WebRTC 노출 범위에 영향 없음을 코드로 확인. `server/src/api/cameras.js`의 `needsRestart`도 `umpEnabled` 변경 시 파이프라인을 재시작하도록 동기화(기존엔 "재시작 불필요" 예외였으나, 이제 MediaMTX 등록 여부에 실질적 영향을 주므로). 상세: [Design_RTSP_Capture_Backend.md](Design_RTSP_Capture_Backend.md) §6.39.

서버 재시작 후 재측정: MediaMTX 경로 목록에서 `6/media.smp`(ingest-daemon 폴백)가 사라지고 `camera.id` 경로로 전환됨, 424 frames/15.00s ≈ 28~31fps로 복구 확인.

### 8.15 버그 수정 — 클라이언트가 회복 가능한 `error` 이벤트에도 플레이어를 영구 언마운트하던 문제 (2026-07-24)

**증상**: standalone `ump-player-example.html`(channelSlot=6)은 정상 재생되는데, 같은 심링크 파일을 로드하는 LTS 대시보드(`RTSPOverWebSocketView.tsx`)는 `umpError {message: 'The video element do not exist...', channel: 6, errorCode: 2304, place: 'mediaRouter.js:onVideoData'}`로 계속 실패. 실패 직후 DevTools에서 `document.getElementById('ump-player-<camera.id>')`가 `null` — `<ump-player>` 엘리먼트 자체가 DOM에서 사라져 있었음.

**원인**: `ump-player.js`의 `onUmpError()`는 거대한 switch문으로 에러코드별 특수 처리를 하는데, `0x0304`(SPS payload not available)와 `0x0900`(video element not found) 둘 다 **전용 case가 없어** `default:` 분기로 떨어져 그냥 `[dispatch]("error", ...)`로 dispatch됨 — 벤더 자신도 이 둘을 "RTSP 핸드셰이크 초반에 흔히 나는, 다음 프레임에서 자연 회복되는 상태"로 취급하고 있다는 뜻(§8.9의 GOP-mid-join 크래시와 같은 계열의 초기 레이스). standalone 페이지는 이 `error` 이벤트를 콘솔에 로그만 남기고 플레이어는 그대로 두므로, 몇 프레임 뒤 SPS/PPS가 도착하면 자연 회복됨(실측 로그로 확인). 반면 `RTSPOverWebSocketView.tsx`의 `onError` 리스너는 `error` 이벤트를 받을 때마다 무조건 `setError()`를 호출했고, JSX가 `error ? <에러 메시지> : <ump-player>`로 **엘리먼트 자체를 언마운트**했음 — 회복될 세션 자체를 첫 에러에서 파괴해버림.

**수정**: `error`(스크립트 로드 실패·자격증명 조회 실패 등 진짜 치명적 상황 전용)와 `playerNotice`(마운트된 `<ump-player>`가 보내는 런타임 `error` 이벤트 — 비차단)를 분리. `<ump-player>`는 `playerNotice`가 있어도 계속 마운트된 채로 두고, 알림은 위에 겹치는 배너로만 표시. `statechange` 이벤트로 `readyState === window.UmpPlayState.PLAYING`이 오면(`UmpPlayState`는 `ump-player.js`가 classic `<script>`로 로드되며 top-level `var`라 `window`에 노출됨) `playerNotice`를 자동으로 지움.

관련 파일: `client/src/components/RTSPOverWebSocketView.tsx`

### 8.16 기능 추가 — WS 브릿지에 H.264 키프레임 게이팅 추가 (신규 뷰어 접속 시 SPS 대기 에러 노이즈 제거, 2026-07-24)

**증상**: §8.9/§8.15와는 별개의 경로에서 재확인된 동일 계열 증상 — 이미 라이브 중인 스트림에 신규 RTSP-over-WebSocket WS 뷰어(예: channelSlot=5)가 접속하면 `umpError {message: 'SPS payload is not available for channel 5. ...', errorCode: 772, place: 'mediaRouter.js:spsParse'}`가 수차례 반복된 뒤 정상 재생됨.

**원인**: `umpStreamingServer.js`는 신규 WS 뷰어가 붙을 때마다 MediaMTX RTSP 포트에 **새 TCP 리더 세션**을 열고(`_connectBackend`), 인증 이후로는 `backendSocket`의 데이터를 그대로 `ws.send()`하는 순수 바이트 릴레이였다(RTP/NAL을 전혀 들여다보지 않음). MediaMTX는 신규 리더의 PLAY에 대해 다음 키프레임을 기다리지 않고 "지금" 흐르는 GOP 중간부터 곧바로 데이터를 흘려보내므로, 신규 뷰어는 SPS/PPS가 캐시되기 전에 non-IDR 슬라이스부터 받게 되어 인코더의 다음 GOP 경계(키프레임)가 올 때까지 위 에러가 반복된다. §8.9의 `needsKeyframe` 게이트는 "카메라→MediaMTX 최초 발행" 구간에만 적용되고, 이 "MediaMTX→신규 WS 뷰어" 구간은 커버하지 않는다.

**수정**: `umpStreamingServer.js`의 backend→client 릴레이를 RTSP-over-TCP interleaved framing(RFC 7826 §10.12) 인식 파서로 교체(`_connectBackend()`의 콜백 내부):
- DESCRIBE 응답의 SDP 본문을 파싱(`parseSdpVideoTrack()`)해 비디오 트랙의 `a=control:` 값과 코덱(H264 또는 H265 — rtpmap의 `H264`/`H265`/`HEVC` 이름으로 판별)을 확인.
- 해당 트랙의 SETUP 요청/응답을 CSeq로 상관관계 매칭해 `Transport: ...;interleaved=X-Y` 헤더에서 비디오 RTP 인터리브 채널 번호를 확정.
- 그 채널의 RTP 패킷만 코덱별 분류기로 검사(`classifyVideoRtpPacket()` → `classifyH264RtpPacket()`/`classifyH265RtpPacket()` 디스패치):
  - **H.264(RFC 6184)**: 단일 NAL·FU-A 프래그먼트·STAP-A 집합 모두 처리 — non-IDR 슬라이스(타입 1/2/3/4/19/20 및 그 FU-A 프래그먼트)는 첫 IDR(타입 5, 또는 IDR을 포함한 STAP-A)이 지나갈 때까지 드롭.
  - **H.265(RFC 7798, 2026-07-24 추가)**: NAL 헤더가 2바이트이고 타입 번호 체계·집계/분할 패킷 포맷이 H.264와 전혀 다름 — non-IRAP VCL 슬라이스(타입 0~15 및 그 FU 프래그먼트)는 첫 IRAP(타입 16~23 — BLA/IDR/CRA, 또는 IRAP을 포함한 Aggregation Packet, 타입 48)이 지나갈 때까지 드롭.
  - 두 코덱 모두 VPS/SPS/PPS/SEI/미지 타입은 항상 통과시켜 클라이언트의 캐시를 미리 채운다.
- 첫 키프레임을 통과시킨 순간 게이트를 영구 오픈 — 이후는 다시 순수 릴레이.
- Fail-open 설계: 비디오 트랙 코덱이 H264/H265 어느 쪽으로도 확인되지 않거나(예: MJPEG), 채널 매핑을 못 찾거나(SETUP Transport 파싱 실패 등), 4초(`KEYFRAME_GATE_TIMEOUT_MS`) 안에 키프레임을 못 찾으면 게이팅을 포기하고 바로 통과 — 재생 자체를 막는 하드 요구사항이 아니라 노이즈/지연 최적화이므로 실패 시 예전 동작(순수 릴레이)으로 완전히 되돌아간다.

순수 함수(`extractRtspResponseText`/`parseSdpVideoTrack`/`rtpPayload`/`classifyH264RtpPacket`/`classifyH265RtpPacket`/`classifyVideoRtpPacket`)는 단위 테스트 가능하도록 `module.exports`에 포함, `server/src/services/umpStreamingServer.test.js`(Jest, 30 케이스 — H264/H265 양쪽 커버)로 검증.

관련 파일: `server/src/services/umpStreamingServer.js`, `server/src/services/umpStreamingServer.test.js`

### 8.17 기능 추가 — RTSP-over-WebSocket 통계 패널 (WebRTC ICE 버튼과 동일한 UX, 2026-07-24)

**요청**: `ump-player.js`의 `onUmpStatistics()`(벤더 자신의 내장 통계 오버레이를 채우는 콜백, `app/ump-player-example.html`이 `elements[i].addEventListener('statistics', onstatistics)`로 구독하는 것과 동일한 공개 이벤트)를 분석해, WebRTC 경로의 "ICE" 배지/토글 버튼과 같은 UX로 RTSP-over-WebSocket 경로에도 통계를 표시.

**분석**: `onUmpStatistics(statistics)`는 `statistics.type`이 `'rtp'`(트랙별 코덱/fps/누적 프레임 수, 세션당 트랙 하나씩 ~1초 간격 — `rtpSession.js`의 `statisticsTimer`)일 때와 `'fps'`(디코드 측 fps/평균 fps/바이트레이트/드롭 프레임/해상도/레이턴시/청크 크기, 마찬가지로 ~1초 간격)일 때 각각 `this[dispatch]("statistics", {statistics})`로 **무조건** 재발행함 — `<ump-player statistics>` 속성이 켜져 있는지 여부는 벤더 자신의 내장 오버레이 DOM 엘리먼트(`this.videoCodecElement` 등, `_statistics`가 true일 때만 생성됨)를 채울지만 결정할 뿐, 이벤트 발행 자체는 막지 않음 — 즉 `statistics` 속성 없이도 `addEventListener('statistics', ...)`로 동일 데이터를 받을 수 있음(벤더 예제와 동일 패턴).

**구현**: WebRTC 경로가 `useWebRTC` 훅(`iceStats`/`rxHistory`/`rxCodec`)으로 `CameraView.tsx`에 통계를 공급하고 `WebRtcStatsPanel.tsx`로 렌더링하는 것과 동일한 구조를 RTSP-over-WebSocket 경로에 이식:
- `client/src/hooks/useUmpStats.ts`(신규) — `<ump-player>`의 `'statistics'` CustomEvent 페이로드(`type: 'rtp'`/`'fps'`)를 누적해 `WebRtcStatsPanel`과 동형인 스냅샷(`UmpStatsSnapshot`) + ~2분 샘플 히스토리(`UmpSample[]`, `'fps'` 틱에서만 샘플링 — 트랙별 `'rtp'` 틱마다 중복 샘플링되지 않도록)를 반환.
- `client/src/components/UmpStatsPanel.tsx`(신규) — `WebRtcStatsPanel.tsx`와 동일한 label:value 그리드 + `Sparkline`/`HeatStrip` 레이아웃으로 해상도/코덱/프레임/비트레이트/fps/레이턴시/드롭/청크 표시.
- `RTSPOverWebSocketView.tsx`에 `onStatistics?: (raw: unknown) => void` prop 추가 — 기존 `error`/`statechange` 리스너와 같은 effect에서 `'statistics'` 리스너도 등록해 `e.detail.statistics`를 그대로 부모로 전달.
- `CameraView.tsx`가 `useUmpStats()`를 호출하고 `onStatistics`를 `RTSPOverWebSocketView`에 내려줌. 상단 우측 코너에 WebRTC와 동일한 구조(배지 + 토글 버튼 + Zone 버튼이 같은 `flex-col` 안에 세로로 쌓임)로 "RTSP-over-WebSocket" 배지와 "STATS" 토글 버튼을 렌더링 — 토글은 `webrtcState === 'connected'` 같은 연결 상태 enum이 RTSP-over-WebSocket 쪽엔 없어서, 첫 `'statistics'` 틱을 받았는지(`umpStats !== null`)로 게이팅. 기존에는 `CameraView.tsx`가 `!useWebRTCMode`(=RTSP-over-WebSocket 포함) 조건으로 자체 Zone 버튼을 렌더링했으나, RTSP-over-WebSocket 배지 컨테이너 안으로 옮기면서 조건을 `!useWebRTCMode && !useUmpMode`로 좁힘 — WebRTC와 완전히 대칭인 구조.

관련 파일: `client/src/hooks/useUmpStats.ts`, `client/src/components/UmpStatsPanel.tsx`, `client/src/components/RTSPOverWebSocketView.tsx`, `client/src/components/CameraView.tsx`

**후속 버그 수정 (같은 날 배포 직후)**: 실제 카메라로 STATS 패널을 열자마자 `TypeError: e.decodedFpsMean.toFixed is not a function`로 전체 페이지가 크래시. 원인은 벤더 라이브러리 자체의 타입 비일관성 — `app/media/ump/Util/util.js`의 `Mean.prototype.mean()`이 `return this.count ? (this.sum / this.count).toFixed(3) : 0;`로 정의돼 있어, 표본이 하나라도 쌓이면(count > 0) **숫자가 아니라 문자열**을 반환함(count===0일 때만 진짜 숫자 `0`). `videoTagPlayer.js`(카메라가 실제로 사용하는 `<video>` + MSE blob 재생 경로 — DOM에서 `<video src="blob:...">` 확인됨, canvas 렌더러가 아님)의 `'fps'` 이벤트가 이 `mean()` 반환값을 그대로 `decodedFramesMean`/`decodedBytesMean`/`dropFramesMean`에 담고, `latency` 필드도 별도로 항상 `latency.toFixed(4)`(역시 문자열)로 채움. `useUmpStats.ts`가 이 필드들을 `number` 타입으로 그대로 받아, `UmpStatsPanel.tsx`가 그 위에 `.toFixed()`를 다시 호출하면서 크래시(문자열엔 `.toFixed`가 없음 — `stats.dropFramesMean.toFixed(2)`는 가드조차 없어 표본이 하나만 쌓여도 항상 실패). **수정**: 벤더 페이로드 타입을 `number` 대신 `unknown`으로 선언하고, `toNum(v, fallback)` 헬퍼(문자열이든 숫자든 `Number()`로 강제 변환, `NaN`이면 이전 값 유지)를 모든 수신 필드에 일괄 적용 — 신뢰할 수 없는 외부 라이브러리 데이터를 소비 경계에서 방어적으로 정규화.

**후속 버그 수정 2 — Rate 그래프가 우상향 직선으로만 표시됨 (같은 날, 사용자 확인)**: STATS 패널의 "Rate" 스파크라인이 오르내림 없이 계속 우상향하는 직선으로만 그려짐. 원인은 필드 하나 더 있던 벤더의 오해의 소지가 있는 네이밍 — `videoTagPlayer.js`가 보내는 `decodedBytesDecodedPerSec` 필드는 이름과 달리 초당 값(rate)이 아니라 `videoElement.webkitVideoDecodedByteCount`(재생 시작 이후 누적 총 디코드 바이트 수)를 그대로 담고 있음 — 진짜 초당 델타(`videoBytesDecodedPerSec = webkitVideoDecodedByteCount - <이전 값>`)는 `videoMean.record()`로 `decodedBytesMean`(= 진짜 평균 bps)에만 반영되고 별도 필드로는 전송되지 않음. `useUmpStats.ts`가 이 누적 카운터를 그래프 값으로 사용하고 있었으니 우상향 직선이 나오는 게 당연했음. **수정**: `decodedBytesPerSec` 필드를 `decodedBytesTotal`로 이름을 바로잡아 "누적 총량 — 그래프 대상 아님"으로 명확히 하고, `UmpStatsPanel.tsx`의 Rate 행을 재구성 — 실제로 값이 오르내리는 `decodedBpsMean`(평균 bps)을 헤드라인 숫자 + 스파크라인으로, `decodedBytesTotal`은 그래프 없이 "Total 1.2 GB" 같은 정적 숫자로만 별도 표시.

### 8.18 기능 추가 — RTP 패킷 손실/복구 알림 (`'waiting'` 이벤트, 2026-07-24)

**요청**: `app/ump-player-example.html`이 구독하는 `elements[i].addEventListener(...)` 전체 목록(`error`/`meta`/`close`/`resize`/`statechange`/`timestamp`/`capture`/`statistics`/`backupstatechange`/`changeplayermode`/`instantplayback`/`waiting`/`networkstate`/`metaImage`/`rtsp`/`changedevicetype`/`changeprofilenumber`/`changeprofile`/`changechannel`/`changehostname`/`changevolume`/`changeport`/`changefullscreen`/`changesunapiclient`/`changebestshotfilter`/`changebestshot`/`stream`/`changetimezone`, 26종)를 분석해 필요한 것을 구현.

**분석**: `src/ump/custom/ump-player.js`(우리가 실제로 쓰는 소스)가 `this[dispatch](...)`로 실제 발행하는 이벤트 이름을 전수 조사한 결과 — 예제가 구독하는 26종 중 **`close`/`networkstate`/`stream`은 이 버전에서 아예 발행되지 않음**(예제는 다른 벤더 버전 기준으로 작성된 것으로 보임 — 리스너를 달아도 죽은 코드가 됨). 나머지 대부분(`meta`/`metaImage`/`rtsp`/`timestamp`/`capture`/`change*` 계열 12종)은 예제 자신도 디버그 textarea에 JSON을 덤프하는 것 외에 기능적으로 하는 일이 없거나(속성 변경 echo — 우리는 마운트 후 속성을 다시 바꾸지 않으므로 해당 없음), 우리 UI에 대응되는 기능이 없음(backup/instant playback 모드 전용, snapshot capture 버튼 없음 등). `resize`는 디코드된 실제 해상도를 주지만 이미 `'statistics'`의 `'fps'` 틱(`statistics.width`/`height`)으로 동일 정보를 받고 있어 중복.

유일하게 **실제로 발행되면서도 우리 UI에 아직 대응이 없던** 이벤트는 `'waiting'` — `mediaRouter.js:onWaiting()`이 RTP 패킷 손실/복구를 감지할 때마다(`rtpSession.js`의 `statisticsTimer`, ~1초 간격) errorCode `0x0107`로 발행하며, `onUmpError()`의 switch문 안에서 `error`와 완전히 동일한 코드 경로를 타지만 별도 CustomEvent(`'waiting'`)로 분리 발행됨 — 즉 §8.15에서 다룬 "일시적·자연 회복되는 상태"와 개념적으로 같은 부류인데, 지금까지는 `'error'`만 구독하고 있어서 패킷 손실이 발생해도 UI에 아무 신호가 없었음.

**구현**: `RTSPOverWebSocketView.tsx`에 `'waiting'` 리스너 추가 — 기존 `'error'`/`'statechange'`와 같은 effect, 같은 정리(cleanup) 구조. `detail.waiting`(= `waiting.islost`)이 `true`면 `${media} packet loss — recovering…`를 기존 `playerNotice` 배너에 표시(§8.15의 배너를 재사용 — 같은 "치명적이지 않은 일시적 상태" 카테고리이므로 새 배너를 따로 만들지 않음), `false`(복구 완료 신호)면 지움.

관련 파일: `client/src/components/RTSPOverWebSocketView.tsx`

### 8.19 기능 추가 — RTSP-over-WebSocket 'meta' 이벤트 → 서버 ONVIF 이벤트 relay (2026-07-27)

**배경**: §8.18 조사 중 발견한 `'meta'`(json/xml)는 RTSP 세션 자체의 메타데이터 트랙(`metaSession.js`가 별도 RTP Application 트랙을 직접 depacketize)으로, `server/src/services/onvifParser.js`가 ingest-daemon의 Application RTP fan-out에서 파싱하는 것과 **같은 부류의 ONVIF MetadataStream XML**. RTSP-over-WebSocket 모드는 ingest-daemon을 완전히 우회하므로(§8.13) RTSP-over-WebSocket 전용 카메라(`webrtcEnabled=false`, `umpEnabled=true`)는 지금까지 ONVIF 이벤트를 서버 쪽에서 전혀 받지 못하고 있었음 — `'meta'`가 그 유일한 경로.

**1차 확인 — 이벤트가 발행조차 안 되고 있었음**: `Util/metaDataParser.js`는 `window.parser`(fast-xml-parser)가 있어야 `meta.json`을 채우는데, `ump-player.js`의 `onUmpMeta()`는 `meta.json`과 `meta.xml`이 **둘 다** 있어야 공개 `'meta'` CustomEvent를 dispatch한다. 우리 `UMP_PLAYER_SCRIPTS` 목록엔 XML 파서가 없었고 `ump-player` 서브모듈에도 해당 파일 자체가 없어(예제 HTML의 CDN 로드도 주석 처리돼 죽어있음) `'meta'`가 원천적으로 한 번도 발행되지 않고 있었음. 같은 저장소의 형제 서브모듈 `submodules/WiseNetChromeIPInstaller/external-lib/fast-xml-parser/parser.min.js`(동일 벤더 계열, `window.parser` 전역을 그대로 노출하는 UMD 빌드)를 재사용 — `copyUmpPlayerAssets.js`에 심링크 항목 추가, `RTSPOverWebSocketView.tsx`의 `UMP_PLAYER_SCRIPTS`에 `/ump-player/parser.min.js` 추가.

**구현**:
- `server/src/services/onvifParser.js` — `parseOnvifPayload(base64Payload)`에서 base64 디코드 이후 로직을 `parseOnvifXml(xml)`로 분리(이미 디코딩된 평문 XML을 받는 새 진입점 — 브라우저가 이미 UTF-8 텍스트로 디코딩해서 주므로 base64 재인코딩 없이 바로 사용). `server/src/routes/internalApi.js`의 `/apprtp/:cameraId` 핸들러에 인라인돼 있던 dedup+저장+스냅샷+타입등록+브로드캐스트 로직을 `ingestOnvifEvents(cameraId, parsedList, {db, io, pipelineManager, rawPayload})`로 추출(같은 모듈의 `_lastStates` dedup 맵을 공유 — 카메라가 두 경로 모두에 동시 노출돼도 dedup이 어긋나지 않음), `clearDedupStateForCamera(cameraId)`도 함께 export해 `closeOpenEventsForCamera()`가 재사용.
- `server/src/api/cameras.js` — 신규 `POST /:id/ump-meta`(JWT 인증, `ump-credentials`와 동일한 인증 근거) 추가: `{ xml }` 바디를 `parseOnvifXml()`로 파싱 후 `ingestOnvifEvents()`로 저장/브로드캐스트. 라우터 팩토리에 `io` 파라미터 추가(`server/src/index.js`의 `camerasRouter(db, pipelineManager, youtubeSvc, io)` 호출부 갱신) — 기존엔 Socket.IO 인스턴스에 접근할 수 없었음.
- `client/src/components/RTSPOverWebSocketView.tsx` — 기존 error/statechange/waiting/statistics와 같은 effect에 `'meta'` 리스너 추가, `detail.xml`을 위 엔드포인트로 POST. 요청 빈도는 500ms 클라이언트 사이드 스로틀로 제한(서버의 상태-변화 dedup이 최종 안전장치이므로 순전히 요청량 방어 목적).

**검증**: 신규 `test/api/onvif_ump_meta_relay.test.js`(9케이스) — `parseOnvifXml`/`ingestOnvifEvents`/`clearDedupStateForCamera`를 직접 호출(재구현이 아닌 실제 export 함수 대상)하고, `camerasRouter`가 등록한 실제 라우트 핸들러를 `router.stack`에서 추출해 404/400/204 경로까지 검증. 기존 `test/api/onvif_apprtp.test.js`(13케이스)·`test/api/onvif_metadata_pipeline.test.js`(11케이스) 전부 재통과 확인 — 리팩터링이 ingest-daemon 경로의 기존 동작을 깨지 않았음을 확인.

**보류**: `'metaImage'`/`bestshot`/`bestshotfilter`(카메라 온보드 AI — Person/Face/FaceRecognition/Vehicle/LicensePlate bestshot 이미지)는 실카메라 라이선스 검증 없이는 얼굴 갤러리/detectionSnapshots 중 어디에 연동할지 결정하기 위험이 커서 이번 범위에서 제외(사용자 확인).

관련 파일: `client/scripts/copyUmpPlayerAssets.js`, `client/src/components/RTSPOverWebSocketView.tsx`, `server/src/services/onvifParser.js`, `server/src/routes/internalApi.js`, `server/src/api/cameras.js`, `server/src/index.js`, `test/api/onvif_ump_meta_relay.test.js`

### 8.20 버그 수정 — Streaming Dashboard RTSP-over-WebSocket 재생 시 detection bounding box가 전혀 표시되지 않던 결함 (2026-07-30)

**증상**: `streamingMode='ump'`인 카메라에서 ingest-daemon → analysis 파이프라인의 capture image 전송·AI 추론은 정상 동작(analysis 서버에 프레임이 정상 입력됨)함에도, Streaming Dashboard의 `<ump-player>` 영상 위에 detection bounding box 오버레이가 전혀 그려지지 않았음.

**근본 원인**: `client/src/components/CameraView.tsx`의 `useUmpMode` 분기(`<RTSPOverWebSocketView>`를 렌더링하는 JSX 블록)에 `<canvas ref={canvasRef}>` 요소 자체가 처음부터 없었음 — WebRTC/JPEG 분기는 각각 `<video>`/`<img>` 옆에 bbox용 `<canvas>`를 함께 렌더링하지만, RTSP-over-WebSocket 분기는 `<RTSPOverWebSocketView>`와 배지/통계 UI만 렌더링하고 canvas를 빠뜨리고 있었음. `drawOverlay()`를 호출하는 `useEffect`(`detections`/`zones`/`hasVideo`/`frameWidth`/`frameHeight` 의존)는 RTSP-over-WebSocket 모드에서도 정상적으로 매 detection 업데이트마다 실행되고 있었으나, `if (!canvas || !hasVideo) return;` 가드에서 `canvasRef.current`가 `null`이라 매번 조용히 no-op — 소켓 이벤트 수신(`useCamera.ts`의 `frame`/`detections` 핸들러)은 `streamingMode`와 무관하게 무조건 동작하므로 데이터 자체는 정상 도착하고 있었고, 오직 "그릴 대상 canvas가 애초에 없다"는 것이 유일한 문제였음.

**수정**: RTSP-over-WebSocket 분기에 `<canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />`를 `<RTSPOverWebSocketView>` 바로 다음(배지/통계 UI보다 먼저, DOM 순서상 아래 z-index)에 추가 — WebRTC/JPEG 분기와 동일한 canvas 엘리먼트·동일한 `drawOverlay()` 로직을 그대로 재사용. `drawOverlay()`의 스케일링은 `canvas.clientWidth/clientHeight`(CSS 크기)와 `useCamera()`가 제공하는 `frameWidth`/`frameHeight`(AI JPEG 프레임의 원본 해상도, 스트리밍 모드와 무관하게 항상 동일 파이프라인에서 옴) 기준이라 `<ump-player>` 자체의 네이티브 디코드 해상도(`'resize'`/`'statistics'` 커스텀 이벤트로 노출됨, 현재는 RTSP-over-WebSocket 통계 패널 표시에만 사용 중)를 별도로 읽어올 필요 없이 그대로 작동함.

**미해결 참고**: `<ump-player>`가 노출하는 `'resize'` CustomEvent(네이티브 비디오 width/height)는 현재 어디서도 구독되지 않음 — 향후 RTSP-over-WebSocket 재생 화면 종횡비가 AI 프레임 해상도와 다른 카메라가 생기면 이 이벤트를 canvas 스케일링에 반영하는 추가 작업이 필요할 수 있으나, 이번 수정 범위에서는 기존 JPEG/WebRTC와 동일한 `frameWidth`/`frameHeight` 기준으로 충분히 해결됨.

관련 파일: `client/src/components/CameraView.tsx`

---

### 8.21 아키텍처 변경 — `submodules/ump-player` 서브모듈 제거, `@melchi45/rtsp-over-websocket` npm 패키지로 전환 (2026-08-04)

§8.1~§8.20의 모든 항목은 `submodules/ump-player` 서브모듈(레거시 `app/media/ump/` JS를 `<script>` 태그로 순차 로드해 `<ump-player>` 커스텀 엘리먼트를 등록하던 방식) 기준으로 작성됐습니다. 이 서브모듈 안에서 병행 진행되던 TypeScript 재작성(`src/player/` — `Design_RTSP_Over_WebSocket_TypeScript_Migration.md` 참고)이 `@melchi45/rtsp-over-websocket@1.0.1`(GitHub Packages)로 정식 배포되면서, 서브모듈 자체를 제거하고 이 npm 패키지로 전환했습니다.

**마이그레이션 전 호환성 확인** (패키지 소스 `melchi45/rtsp-over-websocket`을 직접 확인): `<rtsp-over-websocket>` 엘리먼트의 `observedAttributes`에 이 프로젝트가 쓰는 속성(`hostname`/`proxy`/`port`/`secure`/`device`/`channel`/`profile_number`/`username`/`password`/`width`/`height`) 전부 포함, `channel`은 동일하게 "마크업 1-based, 와이어 0-based", `device === 'nvr'` 분기 동일 존재, `play(): void` public 메서드 존재, 이벤트명(`error`/`statechange`/`waiting`/`statistics`/`meta`) 전부 동일 — 위 §8.1~§8.20에 기록된 속성 의미·채널 오프셋(§8.3의 `channelSlot + 1`)·이벤트 스위치 분기(§8.15/§8.18)·`umpStreamingServer.js` 프로토콜(§8.5~§8.9, §8.16)은 새 패키지에서도 그대로 유효합니다 — **서버 쪽 코드는 이번 변경으로 손대지 않았습니다.**

**변경 내용**:
- `client/src/components/RTSPOverWebSocketView.tsx` — 순차 `<script>` 로더(`UMP_PLAYER_SCRIPTS` 배열, ~70개 파일) 전체 삭제, `import '@melchi45/rtsp-over-websocket'`(side-effect로 커스텀 엘리먼트 등록) + `import { RTSPOverWebSocketPlayState }`로 교체. `window.UmpPlayState` 전역 참조(§8.15) → 패키지의 정식 named export로 교체.
- `client/scripts/copyUmpPlayerAssets.js`(서브모듈 자산을 `public/`에 심볼릭 링크하던 postinstall 스크립트) 삭제, `client/package.json`의 `postinstall` 훅 제거.
- `client/package.json`에 `"@melchi45/rtsp-over-websocket": "1.0.1"` 정식 dependency 추가 — 예전 `optionalDependencies`의 `@melchi45/ump-player`(§8절 "구현 현황" 4번 항목, 2026-07-23에 이미 서브모듈로 대체돼 실제로는 안 쓰이고 있었음)와 달리 필수 dependency.
- `.gitmodules`에서 `submodules/ump-player` 항목 제거, `git rm`으로 서브모듈 디렉토리 삭제. `WiseNetChromeIPInstaller` 서브모듈(UDP 카메라 탐색용, 완전히 별개)은 영향 없음.
- `server/src/index.js`의 `/ump-player`·`/ump-react`·`/rtsp-ws` TEMP DIAGNOSTIC 정적 서빙 라우트 3개 삭제 — 전부 `submodules/ump-player/...` 콘텐츠를 서빙하던 것이라 서브모듈 삭제로 소스 자체가 없어짐. `/StreamingServer` WS 브릿지(`attachUmpStreamingServer`)는 이 라우트들과 무관한 별개 코드라 영향 없음.
- CI(`.github/workflows/test.yml`의 E2E 잡, `deploy-pages.yml`) — `@melchi45/rtsp-over-websocket`이 GitHub Packages 배포라 `npm ci`에 인증이 항상 필요해짐(public repo라도 예외 없음). 두 워크플로 모두 `client/npm ci` 전에 `secrets.NPM_GH_PACKAGES_TOKEN`으로 `.npmrc`를 쓰는 스텝 추가 — **리포지토리 시크릿은 저장소 관리자가 직접 등록해야 함** (Settings → Secrets and variables → Actions, `read:packages` 권한의 GitHub PAT).

**미채택**: 패키지가 함께 제공하는 React wrapper(`@melchi45/rtsp-over-websocket`의 `src/player/react/Player.tsx`)는 `SunapiManager.init()`으로 브라우저가 카메라의 SUNAPI REST API에 직접 로그인하는 흐름을 전제합니다 — 이 프로젝트는 브라우저가 카메라와 절대 직접 통신하지 않고 항상 이 서버의 `/api/cameras/:id/ump-credentials`에서 자격증명을 받아오는 Proxy 아키텍처(§3)라 이 wrapper와 맞지 않아 채택하지 않았습니다. `RTSPOverWebSocketView.tsx`는 기존과 동일하게 raw custom element를 직접 다루는 얇은 wrapper로 유지됩니다.

관련 파일: `client/src/components/RTSPOverWebSocketView.tsx`, `client/package.json`, `client/.npmrc.example`(신규), `client/src/vite-env.d.ts`, `server/src/index.js`, `.gitmodules`, `.github/workflows/test.yml`, `.github/workflows/deploy-pages.yml`. 스킬 문서: `.claude/skills/camera-stream-setup/SKILL.md` § RTSP-over-WebSocket.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 0.1 | 2026-07-22 | 초기 작성 — RTSP-over-WebSocket 프로토콜 분석 및 미결정 사항 정리 (Draft) |
| 0.2 | 2026-07-22 | 사용자 확인: Proxy 모드 + 그리드 전체 병행 확정. 실제 아키텍처(로컬 RTSP Proxy + 단일 WS 브릿지, 카메라 세션 추가 없음) 반영, 와이어 프로토콜이 표준 RTSP interleaved-over-WS임을 확인, 신규 컴포넌트 3종 정의 |
| 0.3 | 2026-07-22 | 사용자 확인: RTSP Proxy는 MediaMTX 재사용(YouTube와 동일 패턴), 인증은 카메라별 저장 자격증명으로 WS 브릿지 계층 RTSP Digest(MD5). 부하 이슈를 WS 릴레이(0에 가까움)와 ingest-daemon fan-out(별도, on-demand 제안)으로 분리 정리 |
| 1.0 | 2026-07-22 | 사용자 확인: on-demand fan-out 확정, `supportSunapi` 게이팅 대신 카메라 Add/Edit UI를 JPEG/WebRTC/RTSP-over-WebSocket 3-way 토글로 확장. 모든 미결정 사항 해소, 구현 착수 단계로 승격 |
| 1.1 | 2026-07-23 | 구현 완료 반영(§8) — 스키마/API, ingest-daemon fan-out, WS 브릿지, 클라이언트 통합 전 단계 코드 작성 완료. SDLC 문서 세트(MRD/RFP/PRD/SRS/TC)는 계정 사용량 한도로 미완료. §7.2 파이프라인 연동 설명을 실제 구현(umpStreamingServer.js가 직접 트리거, pipelineManager.js 미관여)에 맞게 정정 |
| 1.2 | 2026-07-23 | §8.2 추가 — "Loading RTSP-over-WebSocket player…" 무한 대기 버그(CryptoJS/ffmpegAAC 스크립트 로드 순서 누락, profile_number 속성 누락) 원인 분석 및 1차 수정 반영 |
| 1.3 | 2026-07-23 | jsdom 재현으로 진짜 원인 확정 — `ump-player.min.js`의 `new Logger()` 폴백이 `window.log4javascript` 부재 시 throw. `log4javascript.js` 추가, 최종 로드 순서 정정(§8.2) |
| 1.4 | 2026-07-23 | §8.3 추가 — npm 패키지 `dist/html`·`dist/docs` 확인 결과 `width`/`height` 속성 필수, `device="nvr"`가 올바른 모드임을 확정. `RTSPOverWebSocketView.tsx`에 ResizeObserver 기반 크기 측정 추가, `umpStreamingServer.js` 채널 추출 정규식을 NVR 모드의 `LiveChannel/` 접두사 경로에 맞게 일반화 |
| 1.5 | 2026-07-23 | §8.4 추가 — 코드 리뷰 지적으로 `port` 폴백을 하드코딩된 443/80에서 `vite.config.ts` `define` 경유 `server/.env`의 실제 HTTPS_PORT/HTTP_PORT로 교체 |
| 1.6 | 2026-07-23 | §8.5 추가 — 실 카메라 라이브 테스트로 발견: 인증 이후 "순수 바이트 릴레이"가 RTSP 요청 URI를 그대로 넘겨 MediaMTX가 인식 못 하고 연결을 끊던 문제(WS 1005). `rewriteRequestUri()`로 클라이언트→백엔드 방향 요청 라인만 MediaMTX 실제 경로로 재작성하도록 수정 |
| 1.7 | 2026-07-23 | §8.6 추가 — on-demand fan-out 시작과 DESCRIBE 도착 사이 레이스로 MediaMTX가 "no stream is available"로 거부하던 문제, `mediamtxManager.waitForPathReady()` 재사용으로 수정 |
| 1.8 | 2026-07-23 | §8.7 추가(심각) — `add_rtsp_publish()`의 동기 `av.open()`이 타임아웃 없이 HTTP 핸들러 스레드를 블로킹해 ingest-daemon 전체(`/health` 포함)가 응답 불능에 빠지던 버그. `_SHARED_STOP_EXECUTOR`로 백그라운드 처리 + `rw_timeout` 추가로 수정 |
| 1.9 | 2026-07-23 | §8.8 추가 — SETUP 요청 URI를 통째로 덮어써 트랙 접미사가 사라지는 바람에 MediaMTX가 "invalid SETUP path"로 거부, OPTIONS→SETUP 무한 재시도 루프에 빠지던 버그. `rewriteRequestUri()`를 접두사 치환(베이스만 교체, 트랙 접미사는 보존) 방식으로 변경해 수정. 부수 발견: `rw_timeout`이 rtsp.c에서 인식되지 않는 옵션이라 §8.7의 핸드셰이크 타임아웃이 실제로는 무효였음 — `stimeout`으로 교정 |
| 2.0 | 2026-07-23 | §8.8 갱신 — 1.9의 접두사 치환 수정을 배포해도 실 로그로 SETUP 트랙 접미사가 여전히 사라짐을 재확인. 진짜 원인: 클라이언트가 SETUP URI를 자기 자신의 베이스가 아니라 DESCRIBE 응답의 `Content-Base`(MediaMTX 자신이 알려준, 이미 올바른 베이스)로 만들고 있어 접두사 매칭에 실패, 폴백 분기가 버그를 재현하고 있었음. `rewriteRequestUri()`에 "이미 targetUri로 시작하면 손대지 않고 통과" 분기를 최우선으로 추가해 최종 수정 |
| 2.1 | 2026-07-23 | §8.9 추가 — RTSP 핸드셰이크(OPTIONS~PLAY) 전부 성공한 뒤에도 플레이어가 첫 프레임에서 "Cannot read properties of null (reading 'byteLength')"로 크래시하던 버그. on-demand fan-out이 세션의 GOP 중간에 합류해 VPS/SPS/PPS 없는 P-슬라이스부터 전달되던 것이 원인 — `ingest_daemon.py`에 fan-out 엔트리별 `needsKeyframe` 게이트 추가로 수정 (`add_rtsp_publish`/`add_video_fanout` 동적 추가 경로 모두) |
| 2.2 | 2026-07-24 | §8.10 추가 — §8.9와 별개로, H.264(channelSlot=6)에서 동일 증상의 크래시 재확인. `h264Session.js`가 STAP-A 집합 패킷(NAL 타입 24)을 처리하지 않아 SPS/PPS가 영원히 null로 남던 것이 원인 — STAP-A 처리 추가, `mediaRouter.js`에 명확한 에러 가드 추가 |
| 2.3 | 2026-07-24 | §8.11 추가(심각) — `_open_rtsp_publish_async()`가 io 스레드 소유 PyAV 객체를 락 없이 use-after-free해 `libavformat.so`에서 세그폴트(dmesg로 확인). `_video_template_stream` 대입/해제 전체를 락으로 보호하고, `vs`를 건드리기 전에 재검증하도록 순서 수정 — 40회 동시 stress test로 검증 |
| 2.4 | 2026-07-24 | §8.12 추가(아키텍처) — PyAV RTSP `mux()`가 블로킹 네트워크 쓰기 동안 GIL을 놓지 않아, 스레드로 분리해도 카메라 자신의 읽기 루프가 멈추는 문제를 실험으로 확정. `rtsp_publish_worker.py` 별도 프로세스로 이전해 GIL 공유 자체를 제거 — §4.1 설명 갱신 |
| 2.7 | 2026-07-24 | §8.15 추가 — `RTSPOverWebSocketView.tsx`가 회복 가능한 `error` 이벤트(SPS-not-available, video-element-not-found — 둘 다 `ump-player.js`의 `onUmpError()`에서 전용 case 없이 `default:`로 dispatch됨)에도 `<ump-player>`를 영구 언마운트하던 결함 수정. `error`(치명적)와 `playerNotice`(런타임 비차단 알림) 분리, `statechange`의 `PLAYING` 신호로 알림 자동 해제 |
| 2.6 | 2026-07-24 | §8.14 추가 — §8.13의 MediaMTX 직접 우회가 `webrtcEnabled` 카메라에만 적용되고 RTSP-over-WebSocket 전용(`umpEnabled`, `webrtcEnabled=false`) 카메라에는 적용되지 않던 결함 수정. `pipelineManager.js`의 `needsMediaMTX`에 `umpEnabled` 반영, `cameras.js`의 `needsRestart`도 동기화. 재측정 ~13.5fps → 28~31fps 복구 확인 |
| 2.8 | 2026-07-24 | §8.16 추가(기능) — 신규 RTSP-over-WebSocket WS 뷰어 접속 시 반복되던 "SPS payload is not available"(errorCode 772) 노이즈 원인 확정(MediaMTX가 신규 RTSP 리더에게 키프레임을 기다리지 않고 GOP 중간부터 전달) 및 수정: `umpStreamingServer.js`의 backend→client 릴레이에 RTSP interleaved framing 파싱 + H.264 RTP 키프레임 게이팅 추가(DESCRIBE SDP로 비디오 트랙 확인 → SETUP Transport로 인터리브 채널 확정 → 첫 IDR 전까지 non-IDR 슬라이스만 드롭, fail-open). 순수 함수 단위로 분리해 Jest 유닛 테스트 18건 추가(`umpStreamingServer.test.js`) |
| 2.9 | 2026-07-24 | §8.16 갱신 — 코드 리뷰 지적으로 H.265(HEVC) 카메라가 키프레임 게이팅 대상에서 빠져 있던 것을 확인(2바이트 NAL 헤더, IRAP 타입 번호 체계, AP(48)/FU(49) 패킷 포맷이 H.264와 전혀 다름). `parseSdpVideoTrack()`이 코덱을 `'H264'`/`'H265'`로 구분해 반환하도록 변경, `classifyH265RtpPacket()` 추가 + `classifyVideoRtpPacket()` 디스패처로 통합. H264 전용이던 기존 필드명(`isH264Confirmed`)도 `videoCodec`으로 일반화. Jest 유닛 테스트 18→30건으로 확장 |
| 2.5 | 2026-07-24 | §8.13 추가(아키텍처) — fleet 부하로 인한 개별 카메라 프레임레이트 저하가 §8.12 이후에도 잔존(GIL 경합은 fan-out 하나만의 문제가 아니었음). `WEBRTC_ENGINE=mediamtx`가 이미 만들어둔, MediaMTX 자신이 카메라를 직접 pull하는 non-GIL 경로를 RTSP-over-WebSocket가 우선 재사용하도록 변경 — ingest-daemon 완전 우회, WebRTC와 동일한 안정성 확보. §3/§4.2 갱신, channelSlot=6 실 카메라 30fps 최종 확인 |
| 3.0 | 2026-07-24 | §8.17 추가(기능) — WebRTC ICE 배지/토글과 동일한 UX로 RTSP-over-WebSocket 통계 패널 추가. `onUmpStatistics()`가 `statistics` 속성과 무관하게 `'statistics'` CustomEvent를 무조건 재발행함을 확인(벤더 예제와 동일 구독 패턴), `useUmpStats.ts`/`UmpStatsPanel.tsx` 신규 + `RTSPOverWebSocketView.tsx`에 `onStatistics` prop 추가 + `CameraView.tsx` 상단 우측 코너를 WebRTC와 대칭 구조로 재구성(Zone 버튼을 RTSP-over-WebSocket 배지 컨테이너 안으로 이동) |
| 3.1 | 2026-07-24 | §8.17 후속 수정 — STATS 패널을 열자마자 "e.decodedFpsMean.toFixed is not a function"로 크래시하던 버그. 원인은 벤더 `Util/util.js`의 `Mean.mean()`이 표본 1개 이상부터 문자열(`.toFixed(3)`)을 반환하는 타입 비일관성(count===0일 때만 진짜 숫자) — `videoTagPlayer.js`가 이를 `decodedFramesMean`/`decodedBytesMean`/`dropFramesMean`/`latency`에 그대로 흘려보냄. `useUmpStats.ts`의 벤더 페이로드 타입을 `unknown`으로 바꾸고 `toNum()` 헬퍼로 전 필드 방어적 정규화 |
| 3.2 | 2026-07-24 | §8.17 후속 수정 2 — Rate 스파크라인이 오르내림 없이 우상향 직선으로만 그려지던 버그(사용자 확인). `decodedBytesDecodedPerSec` 필드가 이름과 달리 누적 총 바이트 카운터였음(진짜 초당 델타는 `decodedBytesMean`에만 반영됨) — `decodedBytesPerSec`를 `decodedBytesTotal`로 재명명하고 Rate 행을 재구성: `decodedBpsMean`(평균 bps)을 헤드라인+그래프로, `decodedBytesTotal`은 그래프 없이 정적 숫자("Total X GB")로 분리 |
| 3.3 | 2026-07-24 | §8.18 추가(기능) — `app/ump-player-example.html`의 `addEventListener` 26종 전수 분석. `close`/`networkstate`/`stream`은 우리가 쓰는 소스에서 아예 발행되지 않음을 확인(죽은 이벤트), 대부분은 디버그 전용이거나 해당 없는 모드용. 유일하게 실제 발행되면서 미대응이던 `'waiting'`(RTP 패킷 손실/복구, errorCode 0x0107 — `'error'`와 같은 switch의 sibling case)을 `RTSPOverWebSocketView.tsx`에 추가, §8.15의 `playerNotice` 배너 재사용 |
| 3.4 | 2026-07-27 | §8.19 추가(기능) — RTSP-over-WebSocket `'meta'` 이벤트(ONVIF MetadataStream XML) → 서버 relay. fast-xml-parser 미탑재로 이벤트가 원천 발행조차 안 되던 것을 확인해 벤더링(WiseNetChromeIPInstaller 서브모듈 재사용), `onvifParser.js`에 `parseOnvifXml`/`ingestOnvifEvents`/`clearDedupStateForCamera` 분리(ingest-daemon 경로와 dedup 상태 공유), `POST /api/cameras/:id/ump-meta` 신설. `bestshot`/`metaImage`(카메라 온보드 AI)는 실카메라 검증 필요로 보류(사용자 확인). 신규 테스트 9건 + 기존 onvif 테스트 24건 재통과 확인 |
| 3.5 | 2026-07-30 | §8.20 버그 수정 추가 — RTSP-over-WebSocket 재생 시 bounding box 오버레이가 전혀 표시되지 않던 결함. `CameraView.tsx`의 RTSP-over-WebSocket 분기에 `<canvas>` 엘리먼트 자체가 누락돼 있었음(WebRTC/JPEG 분기는 있었음) — `drawOverlay()`는 정상 호출되고 있었으나 canvasRef.current가 null이라 매번 no-op. RTSP-over-WebSocket 분기에 canvas 추가로 해결, 기존 JPEG/WebRTC와 동일한 frameWidth/frameHeight 스케일링 재사용 |
| 3.6 | 2026-08-04 | §8.21 추가(아키텍처) — `submodules/ump-player` 서브모듈 제거, 같은 저자의 TS 재작성 결과물인 `@melchi45/rtsp-over-websocket@1.0.1`(npm, GitHub Packages)로 전환. 패키지 소스 확인 결과 속성/이벤트/채널 오프셋이 기존 `<ump-player>`와 1:1 호환돼 서버 쪽(`umpStreamingServer.js`) 무변경, `RTSPOverWebSocketView.tsx`만 로더 방식 교체. CI에 `.npmrc` 인증 스텝 추가(신규 리포지토리 시크릿 `NPM_GH_PACKAGES_TOKEN` 필요) |
