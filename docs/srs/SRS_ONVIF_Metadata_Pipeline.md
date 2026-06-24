# SRS — ONVIF Metadata Pipeline (App RTP)
**Document ID**: SRS-LTS-ONVIF-01  
**Version**: 1.2  
**Date**: 2026-06-23  
**Project**: Loitering Detection & Tracking System (LTS-2026)  
**Status**: Active  
**Related Design**: [Design_ONVIF_Metadata_Pipeline.md](../design/Design_ONVIF_Metadata_Pipeline.md)

---

## 1. 범위 (Scope)

본 SRS는 ingest-daemon의 RTSP Application RTP 트랙 수집(`_app_rtp_loop` / `_app_rtp_ingest_once`)부터 Node.js 서버 라우팅(`/api/internal/apprtp/:cameraId`)을 거쳐 브라우저 DataChannel·Socket.IO 전달까지의 전체 ONVIF 메타데이터 파이프라인 기능 요구사항을 정의한다.

**범위 내:**
- `ingest-daemon/ingest_daemon.py` — `_app_rtp_loop`, `_app_rtp_ingest_once`
- `server/src/routes/internalApi.js` — `POST /api/internal/apprtp/:cameraId`
- `server/src/services/onvifParser.js` — `parseOnvifPayload()`
- `server/src/services/webrtc/mediasoupEngine.js` — `sendAppRtp()`
- `client/src/hooks/useWebRTC.ts` — `socket.on('appRtp')` 리스너

**범위 외:**
- ONVIF WS-Discovery 카메라 탐색 (`onvifDiscovery.js`)
- ONVIF 이벤트 REST API (`onvifApi.js`)
- ThermalOverlay UI 렌더링

---

## 2. 기능 요구사항

### FR-ONVIF-APPRTP-001: App RTP 스레드 시작 조건

ingest-daemon의 `CameraSession.__init__()`은 `appRtpCallbackUrl` 설정이 존재하는 경우에만 `_app_rtp_loop` 스레드를 시작해야 한다.

- `appRtpCallbackUrl`이 None 또는 빈 문자열이면 App RTP 스레드를 시작하지 않는다.
- 스레드 레이블: `"apprtp"`

### FR-ONVIF-APPRTP-002: av.open() 시점에 timeout 옵션 전달

`_app_rtp_ingest_once()`는 `av.open()` 호출 시 FFmpeg `"timeout"` 옵션을 마이크로초 단위로 전달해야 한다.

```
options["timeout"] = str(int(APP_RTP_READ_TIMEOUT * 1_000_000))
```

**근거:** PyAV 버전에 따라 `av.open()` 이후 `inp.read_timeout = N` 속성 설정이 불가능할 수 있다 (`AttributeError: not writable`). `"timeout"` 옵션은 `AVFormatContext.io_timeout`에 매핑되며 libav C 레이어에서 직접 처리되어 RTSP keepalive(OPTIONS/GET_PARAMETER)와 무관하게 진짜 데이터 비수신 시에만 타임아웃을 발생시킨다.

**제약:**
- `inp.read_timeout = N`을 `av.open()` 이후 속성으로 설정하는 코드를 포함하지 않는다.
- `_RTSP_OPTIONS` dict를 복사하고 `"timeout"` 키를 추가한 별도 옵션 dict를 사용한다.

### FR-ONVIF-APPRTP-003: Application 트랙 필터링

`_app_rtp_ingest_once()`는 열린 컨테이너의 스트림 중 `type not in ("video", "audio")`인 트랙만 선택해야 한다. 해당 트랙이 없으면 `RuntimeError("No application stream")`을 발생시킨다.

### FR-ONVIF-APPRTP-004: 재시도 백오프

`_app_rtp_loop()`는 `_app_rtp_ingest_once()` 실패 시 지수 백오프로 재시도한다.

| 파라미터 | 값 |
|---|---|
| 초기 지연 | 0.5s |
| 배수 | 1.5 |
| 최대 지연 | 5.0s |
| 연결 지속 10s 이상 후 실패 시 | 지연 0.5s로 리셋 |

### FR-ONVIF-APPRTP-005: "No application stream" 처리

`RuntimeError("No application stream")` 발생 시 — 해당 카메라에 Application 트랙이 없다는 의미 — `_app_rtp_loop()`는 경고 없이 조용히 스레드를 종료해야 한다. 재시도하지 않는다.

### FR-ONVIF-APPRTP-006: 컨테이너 정리 보장

`_app_rtp_ingest_once()`는 정상 종료·예외·조기 반환 여부와 관계없이 `inp.close()`를 호출해야 한다. `try … finally` 블록을 사용하여 이를 보장한다.

**근거:** `inp.close()` 미호출 시 ingest-daemon에서 MediaMTX로의 RTSP 연결이 즉시 해제되지 않고 MediaMTX의 i/o timeout(약 7–10초)까지 좀비 세션으로 잔존하여 `maxReaders` 한도를 소진시킨다.

### FR-ONVIF-APPRTP-007: MediaMTX 최대 리더 수 보호

`_app_rtp_loop()`의 재시도가 `av.open()` 단계에서 반복 실패하더라도 MediaMTX 경로의 RTSP 리더 수가 `maxReaders` 한도(기본 10)를 초과하지 않아야 한다.

**요구 구현:**
- FR-ONVIF-APPRTP-002의 준수 — 즉각 실패 방지
- FR-ONVIF-APPRTP-006의 준수 — 좀비 세션 최소화

### FR-ONVIF-APPRTP-008: 페이로드 HTTP POST

`_app_rtp_ingest_once()`는 수신한 RTP 패킷을 base64 인코딩하여 `appRtpCallbackUrl`에 POST해야 한다.

요청 본문 형식:
```json
{
  "pt":        <int, 스트림 인덱스>,
  "timestamp": <int, PTS 또는 0>,
  "seq":       <int, 단조 증가 시퀀스>,
  "payload":   "<base64 인코딩된 raw RTP 패킷>"
}
```

### FR-ONVIF-APPRTP-009: 서버측 Socket.IO 브로드캐스트

`POST /api/internal/apprtp/:cameraId` 수신 시 서버는:
1. `io.emit('appRtp', { cameraId, ...data })`를 모든 연결된 클라이언트에 브로드캐스트한다.
2. `WEBRTC_ENGINE=mediasoup` 환경에서는 추가로 `mediasoupEngine.sendAppRtp(cameraId, data)`를 호출한다.
3. `data.payload`가 존재하면 `parseOnvifPayload(data.payload)`로 구조화 파싱 후 상태변화 dedup → DB 저장 → `onvif:event` 브로드캐스트를 수행한다.

### FR-ONVIF-APPRTP-010: stop 신호 즉시 반영

`_app_rtp_loop()`는 `self._stop.is_set()`을 demux 루프 내에서 확인하여 `CameraSession._signal_stop()` 호출 후 3초 이내에 스레드가 종료되어야 한다.

---

## 3. 기능 요구사항 — ONVIF 구조화 파싱 (`onvifParser.js`)

### FR-ONVIF-PARSER-001: MetadataStream 식별

`parseOnvifPayload(base64Payload)` 함수는 base64 페이로드를 UTF-8로 디코딩 후 `MetadataStream` 문자열이 없으면 `null`을 반환해야 한다.

**수용 기준:** 임의 base64 (비-ONVIF) → `null` 반환.

---

### FR-ONVIF-PARSER-002: 배열 반환

`parseOnvifPayload()`는 유효한 MetadataStream 파싱 시 항상 `ParsedOnvifEvent[]`를 반환해야 한다.

**수용 기준:** 반환값이 `null`이 아니면 `Array.isArray(result) === true`.

---

### FR-ONVIF-PARSER-003: 다중 NotificationMessage 독립 파싱

단일 MetadataStream 패킷에 N개의 `<wsnt:NotificationMessage>` 블록이 포함된 경우, 각 블록을 독립 파싱하여 N개의 `ParsedOnvifEvent`를 반환해야 한다.

**배경:** Samsung 카메라는 최대 8개의 NotificationMessage를 하나의 RTP 패킷에 담아 전송한다. 이전 구현은 첫 번째 Topic만 추출하여 나머지 이벤트가 누락됐다.

**수용 기준:**
- N개 NotificationMessage → 배열 길이 N
- 각 원소의 `topic`, `utcTime`은 해당 블록의 값 (교차 오염 없음)

---

### FR-ONVIF-PARSER-004: NotificationMessage 없는 폴백

`NotificationMessage` 래퍼 없이 MetadataStream 레벨에 직접 Topic이 있는 레거시 포맷의 경우 전체 XML을 단일 블록으로 파싱하여 길이 1인 배열을 반환해야 한다.

---

### FR-ONVIF-PARSER-005: TOPIC_MAP 정규화 — 표준 ONVIF

아래 표준 ONVIF 토픽은 정해진 `type`, `label`, `severity`로 정규화되어야 한다.

| 토픽 | type | severity |
|------|------|----------|
| `tns1:VideoSource/tns1:MotionAlarm` | `motionAlarm` | `warning` |
| `tns1:VideoSource/MotionAlarm` | `motionAlarm` | `warning` |
| `tns1:Device/tns1:Trigger/tns1:DigitalInput` | `digitalInput` | `info` |
| `tns1:Device/tns1:Trigger/tns1:Relay` | `relay` | `info` |
| `tns1:VideoSource/RadiometryAlarm` | `radiometryAlarm` | `warning` |
| `tns1:RuleEngine/Radiometry/TemperatureAlarm` | `temperatureAlarm` | `warning` |
| `tns1:RuleEngine/Detection/TemperatureDifference` | `temperatureDifference` | `info` |

---

### FR-ONVIF-PARSER-006: TOPIC_MAP 정규화 — Samsung 네임스페이스 변형

Samsung 전용 토픽 경로는 동등한 표준 `type`으로 정규화되어야 한다.

| Samsung 토픽 | 기대 type |
|------|----------|
| `tns1:Device/tns1:Trigger/tnssamsung:DigitalInput` | `digitalInput` |
| `tns1:VideoAnalytics/tnssamsung:MotionDetection` | `motionAlarm` |
| `tns1:AudioSource/tnssamsung:AudioDetection` | `audioAlarm` |
| `tnssamsung:IVA/Fire` | `fire` |
| `tnssamsung:IVA/LoiteringDetection` | `loiteringDetection` |

---

### FR-ONVIF-PARSER-007: Unknown 토픽 처리

`TOPIC_MAP`에 없는 토픽: `topicType` = 전체 경로, `topicLabel` = 마지막 세그먼트(namespace prefix 제거), `severity` = `'info'`.

---

### FR-ONVIF-PARSER-008: State 추출 우선순위

`extractState(items)` 함수의 우선순위:
`State` → `IsMotion` → `IsSoundDetected` → `IsAlarm` → `IsActive` → `Active` → `Enabled` → `IsEnabled` → `IsTriggered` → `IsDetected` → `Value`

`'1'` → `'true'`, `'0'` → `'false'` 정규화 필수. 추출 불가 시 `null`.

---

### FR-ONVIF-PARSER-009: SourceToken 추출

`sourceToken` 필드는 `SourceToken` → `VideoSourceConfigurationToken` → `VideoAnalyticsConfigurationToken` → `AudioSourceConfigurationToken` 순으로 추출.

---

## 3-B. 기능 요구사항 — 서버 라우팅 파싱 처리 (`internalApi.js`)

### FR-ONVIF-ROUTE-001: 다중 이벤트 독립 Dedup

`parseOnvifPayload()`가 N개 배열을 반환하면, 각 원소는 `${cameraId}:${topic}:${sourceToken}` 키로 **독립** dedup 처리되어야 한다.

**수용 기준:** 3개 NotificationMessage, 3개 모두 신규 state → DB에 3개 저장.

---

### FR-ONVIF-ROUTE-002: 상태 변화 시에만 저장

같은 dedup 키의 이전 state와 현재 state가 동일하면 `db.insert('onvif_events')`를 호출하지 않는다.

---

### FR-ONVIF-ROUTE-003: onvif:event 브로드캐스트

state 변화 이벤트 저장 후 `io.emit('onvif:event', event)`를 호출해야 한다.

---

### FR-ONVIF-ROUTE-004: Radiometry dedup 제외

Radiometry 이벤트 (`parsed.radiometry` 존재)는 dedup 없이 매 수신 시마다 `io.emit('onvif:temperature', ...)`를 호출한다.

---

### FR-ONVIF-ROUTE-005: 파싱 오류 격리

`parseOnvifPayload()` 또는 DB 저장 중 예외 발생 시 `console.warn`으로 기록하고 `POST /apprtp` 응답(200)을 중단하지 않아야 한다.

---

## 4. 비기능 요구사항

### NFR-ONVIF-APPRTP-001: PyAV 버전 호환성

구현은 PyAV 9.x ~ 14.x (현재 기준 최신) 에서 `AttributeError` 없이 동작해야 한다. `av.Container.read_timeout` 속성 쓰기에 의존하지 않는다.

### NFR-ONVIF-APPRTP-002: 타임아웃 동작

`APP_RTP_READ_TIMEOUT` (기본 60초) 동안 RTP 패킷을 수신하지 못하면 `av.open()` 내부 io_timeout이 발동하여 블로킹 demux 호출에서 복귀해야 한다. RTSP keepalive(OPTIONS/GET_PARAMETER) 수신은 이 타이머를 리셋하지 않는다.

### NFR-ONVIF-APPRTP-003: 메모리 누수 없음

각 `_app_rtp_ingest_once()` 호출 종료 후 PyAV 컨테이너 객체가 해제되어야 한다. GC 의존 대신 명시적 `inp.close()`를 사용한다.

---

## 4. 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `APP_RTP_READ_TIMEOUT` | `60` | App RTP demux io_timeout (초). ONVIF 이벤트가 드물어 긴 값 필요 |

---

## 5. 알려진 제약사항

### PyAV read_timeout 속성 쓰기 폐지

| PyAV 버전 범주 | `inp.read_timeout = N` 동작 |
|---|---|
| 구 버전 (≤ 9.x 일부) | 쓰기 가능 — 정상 동작 |
| 신 버전 (> 9.x 일부, 10+) | `AttributeError: not writable` |

구현은 `av.open()` 시점 옵션 전달 방식으로 두 버전 모두를 지원한다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-23 | 초기 작성 — App RTP 파이프라인 기능 요구사항 정의 |
| 1.1 | 2026-06-23 | FR-ONVIF-APPRTP-002 추가 — PyAV `read_timeout` 속성 쓰기 폐지 대응, `av.open()` 시점 timeout 옵션 전달 요구사항 명세 |
| 1.2 | 2026-06-23 | §3 FR-ONVIF-PARSER-001~009 추가 — 다중 NotificationMessage 파싱·TOPIC_MAP Samsung 변형·State 추출; §3-B FR-ONVIF-ROUTE-001~005 추가 — 독립 Dedup·저장·브로드캐스트·Radiometry 격리 |
| 1.3 | 2026-06-24 | 연관 문서 링크 추가 — [RFP_ONVIF_Metadata_Pipeline.md](../rfp/RFP_ONVIF_Metadata_Pipeline.md), [PRD_ONVIF_Metadata_Pipeline.md](../prd/PRD_ONVIF_Metadata_Pipeline.md); test/api/onvif_apprtp.test.js node 하네스 전환 완료 (TC-APPRTP-007~009 + PARSER-A~C 9/9 PASS) |
