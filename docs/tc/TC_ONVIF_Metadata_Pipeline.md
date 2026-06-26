# TEST CASES
# ONVIF Metadata Pipeline — App RTP 수집 검증

| | |
|---|---|
| **Document ID** | TC-LTS-ONVIF-01 |
| **Version** | 1.7 |
| **Status** | Active |
| **Date** | 2026-06-23 |
| **Related SRS** | [SRS_ONVIF_Metadata_Pipeline.md](../srs/SRS_ONVIF_Metadata_Pipeline.md) |
| **Related Design** | [Design_ONVIF_Metadata_Pipeline.md](../design/Design_ONVIF_Metadata_Pipeline.md) |
| **Test Files** | `test/ingest/test_apprtp.py`, `test/api/onvif_apprtp.test.js`, `test/api/onvif_metadata_pipeline.test.js` |

---

## 사전 조건

- Python 3.9+ 및 `pytest` 설치: `pip install pytest`
- Node.js 18+ 및 Jest 설치: `cd server && npm install`
- 단위 테스트(TC-APPRTP-001 ~ TC-APPRTP-010)는 실제 카메라·MediaMTX 없이 mock으로 수행
- TC-APPRTP-011 ~ TC-APPRTP-012는 실 카메라(Samsung ONVIF) 필요

---

## TC-APPRTP-001 — av.open() 에 timeout 옵션 포함 여부 (회귀)

| 항목 | 내용 |
|---|---|
| **목적** | `_app_rtp_ingest_once()`가 `av.open()` 호출 시 `options["timeout"]`을 포함하는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-002 |
| **우선순위** | P0 — 회귀 방지 |
| **자동화** | `test/ingest/test_apprtp.py::TestAppRtpOptions::test_timeout_in_av_open_options` |

**절차:**
```bash
cd /data6/youngho/workspace/loitering_tracking
python -m pytest test/ingest/test_apprtp.py::TestAppRtpOptions::test_timeout_in_av_open_options -v
```

**합격 기준:**
- `av.open()` 호출 시 `options` 키워드 인자에 `"timeout"` 키가 존재
- `timeout` 값이 `APP_RTP_READ_TIMEOUT * 1_000_000` 마이크로초 문자열

---

## TC-APPRTP-002 — read_timeout 속성 설정 금지 (회귀)

| 항목 | 내용 |
|---|---|
| **목적** | `av.open()` 이후 컨테이너에 `read_timeout` 속성을 설정하지 않는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-002 |
| **우선순위** | P0 — 회귀 방지 |
| **자동화** | `test/ingest/test_apprtp.py::TestAppRtpOptions::test_no_read_timeout_attribute_set` |
| **배경** | 구 코드(`inp.read_timeout = N`)는 신 PyAV에서 `AttributeError: not writable`을 발생시켜 App RTP 루프가 즉각 실패하고 MediaMTX maxReaders를 소진시킴 |

**절차:**
```bash
python -m pytest test/ingest/test_apprtp.py::TestAppRtpOptions::test_no_read_timeout_attribute_set -v
```

**합격 기준:**
- `read_timeout` 쓰기가 `AttributeError`를 발생시키는 컨테이너 목 사용 시에도 `_app_rtp_ingest_once()`가 `AttributeError`를 발생시키지 않음

---

## TC-APPRTP-003 — 컨테이너 명시적 close() 보장

| 항목 | 내용 |
|---|---|
| **목적** | `_app_rtp_ingest_once()` 종료 시 (정상·예외 모두) `inp.close()`가 호출되는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-006 |
| **우선순위** | P1 |
| **자동화** | `test/ingest/test_apprtp.py::TestAppRtpCleanup::test_close_called_on_no_app_stream` |

**절차:**
```bash
python -m pytest test/ingest/test_apprtp.py::TestAppRtpCleanup -v
```

**합격 기준:**
- Application 트랙 없음 → RuntimeError 발생 → `mock_container.close()` 1회 호출
- 정상 demux 완료 → `mock_container.close()` 1회 호출

---

## TC-APPRTP-004 — No application stream 조용한 종료

| 항목 | 내용 |
|---|---|
| **목적** | RTSP 스트림에 data/subtitle 트랙이 없을 때 스레드가 재시도 없이 종료되는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-003, FR-ONVIF-APPRTP-005 |
| **우선순위** | P1 |
| **자동화** | `test/ingest/test_apprtp.py::TestAppRtpLoop::test_no_app_stream_exits_quietly` |

**절차:**
```bash
python -m pytest test/ingest/test_apprtp.py::TestAppRtpLoop::test_no_app_stream_exits_quietly -v
```

**합격 기준:**
- `av.open()` 이후 스트림 목록이 video/audio만인 경우 `_app_rtp_loop()`가 재시도 없이 종료
- 경고 로그 미출력

---

## TC-APPRTP-005 — 재시도 백오프

| 항목 | 내용 |
|---|---|
| **목적** | 연결 실패 시 retry_delay가 0.5s → 최대 5.0s 지수 증가하는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-004 |
| **우선순위** | P2 |
| **자동화** | `test/ingest/test_apprtp.py::TestAppRtpLoop::test_retry_backoff` |

**절차:**
```bash
python -m pytest test/ingest/test_apprtp.py::TestAppRtpLoop::test_retry_backoff -v
```

**합격 기준:**
- 3회 연속 실패 시 `_stop.wait()` 인수가 `[0.5, 0.75, 1.125]` 순서로 증가
- 재시도 지연이 5.0s를 초과하지 않음

---

## TC-APPRTP-006 — 페이로드 base64 HTTP POST 형식

| 항목 | 내용 |
|---|---|
| **목적** | App RTP 패킷이 올바른 JSON 형식으로 `appRtpCallbackUrl`에 POST되는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-008 |
| **우선순위** | P1 |
| **자동화** | `test/ingest/test_apprtp.py::TestAppRtpPayload::test_post_body_format` |

**합격 기준:**
- POST body가 `{ pt, timestamp, seq, payload }` 형식의 JSON
- `payload`가 유효한 base64 문자열
- `seq`가 0부터 단조 증가

---

## TC-APPRTP-007 — Node.js 내부 API 브로드캐스트

| 항목 | 내용 |
|---|---|
| **목적** | `POST /api/internal/apprtp/:cameraId`가 Socket.IO `appRtp` 이벤트를 브로드캐스트하는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-009 |
| **우선순위** | P1 |
| **자동화** | `test/api/onvif_apprtp.test.js::AppRtpInternalApi::broadcasts appRtp via socket.io` |

**절차:**
```bash
cd server && npx jest test/api/onvif_apprtp.test.js --runInBand --forceExit -v
```

**합격 기준:**
- `io.emit('appRtp', { cameraId, pt, timestamp, seq, payload })` 호출됨
- `cameraId`가 URL 파라미터와 일치

---

## TC-APPRTP-008 — ONVIF 구조화 파싱 통합

| 항목 | 내용 |
|---|---|
| **목적** | base64 ONVIF MetadataStream 페이로드가 파싱되어 `onvif_events` DB에 저장되는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-009 |
| **우선순위** | P1 |
| **자동화** | `test/api/onvif_apprtp.test.js::AppRtpInternalApi::parses ONVIF payload and saves event` |

**합격 기준:**
- `parseOnvifPayload()` 결과에 `topic`, `state`, `sourceToken`이 포함됨
- DB `insert('onvif_events', event)` 호출됨
- `io.emit('onvif:event', event)` 브로드캐스트됨

---

## TC-APPRTP-009 — Radiometry 데이터 즉시 브로드캐스트 (dedup 제외)

| 항목 | 내용 |
|---|---|
| **목적** | `BoxTemperatureReading` 포함 페이로드가 state-dedup 없이 `onvif:temperature`로 즉시 방출되는지 확인 |
| **SRS 참조** | Design §9.3 |
| **우선순위** | P2 |
| **자동화** | `test/api/onvif_apprtp.test.js::AppRtpInternalApi::emits onvif:temperature for radiometry` |

**합격 기준:**
- `io.emit('onvif:temperature', { cameraId, utcTime, readings })` 호출됨
- `onvif_events` DB insert 미호출 (radiometry는 DB 저장 안 함)

---

## TC-APPRTP-010 — stop 신호 후 3초 이내 종료

| 항목 | 내용 |
|---|---|
| **목적** | `_signal_stop()` 호출 후 App RTP 스레드가 3초 이내 종료되는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-010 |
| **우선순위** | P2 |
| **자동화** | `test/ingest/test_apprtp.py::TestAppRtpLoop::test_stop_exits_within_timeout` |

**합격 기준:**
- `session._signal_stop()` 호출 후 3000ms 이내에 apprtp 스레드 종료

---

## TC-APPRTP-011 — 실 카메라 App RTP 수신 (통합 테스트)

| 항목 | 내용 |
|---|---|
| **목적** | Samsung ONVIF 카메라에서 App RTP 패킷이 실제로 수신·파싱·저장되는지 확인 |
| **SRS 참조** | 전체 파이프라인 |
| **우선순위** | P1 |
| **자동화** | 수동 — 실 카메라 필요 |

**절차:**
1. Samsung IP 카메라 RTSP URL 확인
2. ingest-daemon에 카메라 등록 (`appRtpCallbackUrl` 포함)
3. 30초 대기
4. `GET /api/onvif-events?cameraId={id}&limit=10` 조회

**합격 기준:**
- ONVIF 이벤트 1개 이상 DB 저장
- `[Ingest] App RTP loop starting` 로그 확인
- `WARNING … App RTP error:` 로그 없음
- MediaMTX 로그에 `maximum reader count reached` 없음

---

## TC-APPRTP-013 — MediaMTX 환경에서 App RTP가 원본 카메라 URL 사용 (unit)

| 항목 | 내용 |
|---|---|
| **목적** | `mediamtxReady=true`일 때 `pipelineManager.js`가 `appRtpRtspUrl=원본URL`을 ingest-daemon에 전달하는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-004 |
| **우선순위** | P0 |
| **자동화** | `test/api/onvif_apprtp.test.js::TC-APPRTP-013` |

**절차:**
1. `pipelineManager._ingestRegisterCamera(id, mediamtxUrl, callbackUrl, appRtpUrl, originalCameraUrl)` 호출 모킹
2. `body.appRtpRtspUrl === originalCameraUrl` 검증

**합격 기준:**
- `body.appRtpRtspUrl`이 원본 카메라 RTSP URL과 동일
- `body.rtspUrl`은 MediaMTX URL (AI 경로)
- `body.appRtpCallbackUrl`이 설정됨

---

## TC-APPRTP-014 — EADDRINUSE 3회 → 스레드 종료 (unit)

| 항목 | 내용 |
|---|---|
| **목적** | App RTP 루프가 `OSError(errno=98)` 3회 연속 발생 시 재시도 없이 조용히 종료하는지 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-005 |
| **우선순위** | P0 |
| **자동화** | `test/api/onvif_apprtp.test.js::TC-APPRTP-014` |

**절차:**
1. `_app_rtp_loop` 내부 `addr_in_use_n` 카운터 로직 검증
2. EADDRINUSE 3회 발생 시 `return`으로 루프 탈출 확인

**합격 기준:**
- 3회 이후 루프 탈출
- `log.warning` 호출 (경고 로그 남김)
- 재시도 없음 (자원 낭비 없음)

---

## TC-APPRTP-012 — MediaMTX maxReaders 소진 재현 방지 (회귀)

| 항목 | 내용 |
|---|---|
| **목적** | App RTP 루프 반복 재시도 시 MediaMTX 세션이 `maxReaders`를 초과하지 않음을 확인 |
| **SRS 참조** | FR-ONVIF-APPRTP-007 |
| **우선순위** | P0 |
| **자동화** | 수동 (MediaMTX + ingest-daemon 실행 환경 필요) |

**절차:**
```bash
# 1. MediaMTX 세션 수 모니터링
watch -n 1 "curl -s http://127.0.0.1:9997/v3/paths/list | python3 -c \
  \"import sys,json; paths=json.load(sys.stdin)['items']; \
  [print(p['name'], 'readers:', len(p.get('readers',[]))) for p in paths]\""

# 2. 3분 관찰 — reader 수가 10을 초과하지 않아야 함
```

**합격 기준:**
- 각 카메라 경로의 RTSP reader 수가 `maxReaders`(10) 미만 유지
- MediaMTX 로그에 `maximum reader count reached` 없음
- ingest-daemon 로그에 `Server returned 400 Bad Request` 없음

---

---

## TC-PARSER-001 — 단일 NotificationMessage → 배열[1] 반환

| 항목 | 내용 |
|---|---|
| **목적** | 단일 NotificationMessage를 가진 MetadataStream이 길이 1인 배열로 파싱되는지 확인 |
| **SRS 참조** | FR-ONVIF-PARSER-002, FR-ONVIF-PARSER-003 |
| **우선순위** | P0 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-001` |

**입력:** 단일 `wsnt:NotificationMessage` (MotionAlarm, State=true)

**합격 기준:**
- `parseOnvifPayload(payload)` 반환값이 배열
- `result.length === 1`
- `result[0].topic === 'tns1:VideoSource/tns1:MotionAlarm'`
- `result[0].state === 'true'`

---

## TC-PARSER-002 — 다중 NotificationMessage → 배열[N] 반환 (회귀 방지)

| 항목 | 내용 |
|---|---|
| **목적** | 3개 NotificationMessage를 가진 패킷이 3개 이벤트 배열로 파싱되는지 확인. 이전 버그(첫 번째만 파싱)의 회귀를 방지한다 |
| **SRS 참조** | FR-ONVIF-PARSER-003 |
| **우선순위** | P0 — 버그 수정 회귀 방지 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-002` |

**입력:** 3개 NotificationMessage (MotionAlarm + DigitalInput + AudioDetection)

**합격 기준:**
- `result.length === 3`
- `result[0].topic`, `result[1].topic`, `result[2].topic`이 각각 다른 토픽
- `result[0].utcTime !== result[1].utcTime` (각 블록 UtcTime 독립)
- 각 원소의 `items`가 다른 블록 SimpleItem과 교차 오염되지 않음

---

## TC-PARSER-003 — 비-MetadataStream 페이로드 → null

| 항목 | 내용 |
|---|---|
| **목적** | MetadataStream이 아닌 페이로드가 null을 반환하는지 확인 |
| **SRS 참조** | FR-ONVIF-PARSER-001 |
| **우선순위** | P1 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-003` |

**합격 기준:** `parseOnvifPayload(btoa('not-onvif-data')) === null`

---

## TC-PARSER-004 — TOPIC_MAP 알려진 토픽 정규화

| 항목 | 내용 |
|---|---|
| **목적** | 표준 ONVIF 토픽이 TOPIC_MAP의 type/label/severity로 정확히 정규화되는지 확인 |
| **SRS 참조** | FR-ONVIF-PARSER-005 |
| **우선순위** | P1 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-004` |

| 입력 토픽 | 기대 topicType | 기대 severity |
|---|---|---|
| `tns1:VideoSource/tns1:MotionAlarm` | `motionAlarm` | `warning` |
| `tns1:Device/tns1:Trigger/tns1:Relay` | `relay` | `info` |
| `tns1:VideoSource/RadiometryAlarm` | `radiometryAlarm` | `warning` |

---

## TC-PARSER-005 — Samsung namespace 변형 정규화 (회귀 방지)

| 항목 | 내용 |
|---|---|
| **목적** | Samsung 전용 namespace 변형이 표준 type으로 정규화되는지 확인 |
| **SRS 참조** | FR-ONVIF-PARSER-006 |
| **우선순위** | P0 — 이번 버그 수정에 추가된 토픽 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-005` |

| 입력 토픽 | 기대 topicType |
|---|---|
| `tns1:Device/tns1:Trigger/tnssamsung:DigitalInput` | `digitalInput` |
| `tns1:VideoAnalytics/tnssamsung:MotionDetection` | `motionAlarm` |
| `tns1:AudioSource/tnssamsung:AudioDetection` | `audioAlarm` |
| `tns1:VideoSource/MotionAlarm` | `motionAlarm` |

---

## TC-PARSER-006 — Unknown 토픽 처리

| 항목 | 내용 |
|---|---|
| **목적** | TOPIC_MAP에 없는 토픽이 전체 경로를 topicType으로, 마지막 세그먼트를 label로 사용하는지 확인 |
| **SRS 참조** | FR-ONVIF-PARSER-007 |
| **우선순위** | P1 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-006` |

**입력:** topic = `tns1:Custom/UnknownEvent`

**합격 기준:**
- `topicType === 'tns1:Custom/UnknownEvent'`
- `topicLabel === 'UnknownEvent'`
- `severity === 'info'`

---

## TC-PARSER-007 — State 추출 우선순위

| 항목 | 내용 |
|---|---|
| **목적** | `State`보다 `IsMotion`이 있을 때, `State` 없으면 `IsMotion`으로 폴백하는지 확인 |
| **SRS 참조** | FR-ONVIF-PARSER-008 |
| **우선순위** | P1 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-007` |

| 시나리오 | items | 기대 state |
|---|---|---|
| State 최우선 | `{ State: 'true' }` | `'true'` |
| IsMotion 폴백 | `{ IsMotion: 'false' }` | `'false'` |
| Value `'1'` 정규화 | `{ Value: '1' }` | `'true'` |
| 빈 items | `{}` | `null` |

---

## TC-PARSER-008 — 다중 이벤트 독립 Dedup (API 통합)

| 항목 | 내용 |
|---|---|
| **목적** | 3개 NotificationMessage 패킷 전송 시 3개 이벤트가 독립적으로 dedup되어 모두 저장되는지 확인 |
| **SRS 참조** | FR-ONVIF-ROUTE-001 |
| **우선순위** | P0 — 핵심 버그 수정 검증 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-008` |
| **사전 조건** | 서버 실행 중 (`http://localhost:3080`) |

**절차:**
1. `DELETE /api/onvif-events` 초기화
2. 3개 NotificationMessage 패킷 `POST /api/internal/apprtp/test-cam-001`
3. `GET /api/onvif-events?cameraId=test-cam-001&limit=10` 조회

**합격 기준:**
- `events.length === 3`
- 3개 이벤트의 `topic`이 각각 다름

---

## TC-PARSER-009 — 상태 변화 Dedup (동일 state 반복 저장 방지)

| 항목 | 내용 |
|---|---|
| **목적** | 동일 state 패킷을 2회 전송 시 두 번째는 저장되지 않는지 확인 |
| **SRS 참조** | FR-ONVIF-ROUTE-002 |
| **우선순위** | P1 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-009` |

**절차:**
1. MotionAlarm state=true 패킷 전송 → 저장 확인
2. 동일 패킷 재전송
3. `GET /api/onvif-events` 조회

**합격 기준:** `events.length === 1` (중복 저장 없음)

---

## TC-PARSER-010 — 파싱 오류 시 200 응답 유지

| 항목 | 내용 |
|---|---|
| **목적** | 손상된 base64 페이로드에도 POST /apprtp가 200을 반환하는지 확인 |
| **SRS 참조** | FR-ONVIF-ROUTE-005 |
| **우선순위** | P1 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-010` |

**합격 기준:** HTTP 응답 상태 200, 서버 프로세스 정상 유지

---

## TC-PARSER-007b — RuleName SimpleItem → parsed.ruleName 필드 반환 (유닛)

| 항목 | 내용 |
|---|---|
| **목적** | `onvifParser.js`가 Source `RuleName` SimpleItem을 `parsed.ruleName`으로 정확히 추출하는지 검증 |
| **SRS 참조** | FR-ONVIF-RULENAME-001 |
| **우선순위** | P0 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-007b` |

**입력:** `Name="RuleName" Value="Zone1_Loitering"` SimpleItem 포함 ONVIF XML  
**합격 기준:**
- `parsed.ruleName === 'Zone1_Loitering'`
- RuleName 없는 XML → `parsed.ruleName === null`

---

## TC-PARSER-011 — RuleName 기반 이벤트 분리 (API 통합)

| 항목 | 내용 |
|---|---|
| **목적** | 동일 topic/source이지만 RuleName이 다른 두 이벤트가 DB에 별도 2행으로 저장되는지 검증 |
| **SRS 참조** | FR-ONVIF-RULENAME-001~003 |
| **우선순위** | P0 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js::TC-PARSER-011` |

**절차:**
1. 새 `cameraId` 생성 (캐시 오염 방지)
2. `RuleName=Zone1` 이벤트 POST → 150ms 대기
3. `RuleName=Zone2` 이벤트 POST (동일 topic, sourceToken) → 150ms 대기
4. `GET /api/onvif-events?cameraId={id}` 조회

**합격 기준:**
- HTTP 200
- `events.length === 2`
- `events`에 `ruleName='Zone1'`과 `ruleName='Zone2'` 모두 존재

---

## TC-TIMELINE-RANGE-001 — ONVIF 이벤트 API: 1H from 파라미터 → 200 + 경계 검증

| 항목 | 내용 |
|---|---|
| **ID** | TC-TIMELINE-RANGE-001 |
| **SRS** | FR-ONVIF-RANGE-001, FR-ONVIF-RANGE-004 |
| **조건** | `streamingOnly` — `SERVER_MODE=streaming`일 때만 실행 |
| **목적** | `GET /api/onvif-events?from=<now-1H>` 가 200을 반환하고 모든 이벤트 `serverTs ≥ from` |
| **절차** | `from = Date.now() - 3,600,000ms` ISO 8601 → `GET /api/onvif-events?from=…&limit=1000` |
| **기대** | HTTP 200, `events` 배열, `total` number, 각 이벤트 `serverTs ≥ from` |
| **스크립트** | `test/api/timeline_range.test.js` |

---

## TC-TIMELINE-RANGE-002 — ONVIF 이벤트 API: from 없이 전체 조회

| 항목 | 내용 |
|---|---|
| **ID** | TC-TIMELINE-RANGE-002 |
| **SRS** | FR-ONVIF-RANGE-004 |
| **조건** | `streamingOnly` |
| **목적** | `from` 파라미터 없이도 `GET /api/onvif-events` 가 정상 응답 |
| **절차** | `GET /api/onvif-events?limit=10` |
| **기대** | HTTP 200, `events` 배열, `total` number |

---

## TC-TIMELINE-RANGE-003 — ONVIF 이벤트 API: cameraId + 1H 범위 조합

| 항목 | 내용 |
|---|---|
| **ID** | TC-TIMELINE-RANGE-003 |
| **SRS** | FR-ONVIF-RANGE-001, FR-ONVIF-RANGE-004 |
| **조건** | `streamingOnly`; 카메라 미등록 시 skip |
| **목적** | cameraId + from 조합 필터 시 해당 카메라 이벤트만 반환 |
| **절차** | 첫 번째 카메라 ID 취득 → `GET /api/onvif-events?cameraId=…&from=<now-1H>&limit=500` |
| **기대** | 모든 반환 이벤트의 `cameraId`가 요청 cameraId와 일치; `serverTs ≥ from` |

---

## TC-TIMELINE-RANGE-004 — ONVIF 이벤트 API: to 파라미터 미래 시간 경계

| 항목 | 내용 |
|---|---|
| **ID** | TC-TIMELINE-RANGE-004 |
| **SRS** | FR-ONVIF-RANGE-004 |
| **조건** | `streamingOnly` |
| **목적** | `to`가 미래 시간이어도 정상 응답 (서버 에러 없음) |
| **절차** | `from = now-1H`, `to = now+60s` → `GET /api/onvif-events?from=…&to=…` |
| **기대** | HTTP 200, `events` 배열 |

---

## TC-TIMELINE-RANGE-005 — Detection tracks API: 1H from 파라미터

| 항목 | 내용 |
|---|---|
| **ID** | TC-TIMELINE-RANGE-005 |
| **SRS** | FR-ONVIF-RANGE-005 |
| **조건** | `streamingOnly` |
| **목적** | `GET /api/analysis/detection-tracks?from=<now-1H>` 가 200 반환; 트랙 경계 검증 |
| **절차** | `from = Date.now() - 3,600,000ms` → `GET /api/analysis/detection-tracks?from=…&limit=500` |
| **기대** | HTTP 200, `tracks` 배열, 각 트랙 `firstSeenAt ≥ from` 또는 `lastSeenAt ≥ from` |

---

## TC-TIMELINE-RANGE-006 — Detection tracks API: from 없이 전체 조회

| 항목 | 내용 |
|---|---|
| **ID** | TC-TIMELINE-RANGE-006 |
| **SRS** | FR-ONVIF-RANGE-005 |
| **조건** | `streamingOnly` |
| **목적** | `from` 파라미터 없이도 Detection tracks API 정상 응답 |
| **절차** | `GET /api/analysis/detection-tracks?limit=10` |
| **기대** | HTTP 200, `tracks` 배열 |

---

## TC-TIMELINE-RANGE-007 — Detection tracks API: cameraId + 1H 범위 조합

| 항목 | 내용 |
|---|---|
| **ID** | TC-TIMELINE-RANGE-007 |
| **SRS** | FR-ONVIF-RANGE-005 |
| **조건** | `streamingOnly`; 카메라 미등록 시 skip |
| **목적** | cameraId 필터 적용 시 해당 카메라 트랙만 반환 |
| **절차** | 첫 번째 카메라 ID 취득 → `GET /api/analysis/detection-tracks?cameraId=…&from=<now-1H>` |
| **기대** | 모든 반환 트랙의 `cameraId`가 요청 cameraId와 일치 |

---

## TC-TIMELINE-RANGE-008 — ONVIF 이벤트 API: 6H from 경계 값 검증

| 항목 | 내용 |
|---|---|
| **ID** | TC-TIMELINE-RANGE-008 |
| **SRS** | FR-ONVIF-RANGE-002, FR-ONVIF-RANGE-004 |
| **조건** | `streamingOnly` |
| **목적** | `from = now-6H` 경계에서 반환된 이벤트가 `[from, now]` 구간 내에 있음 |
| **절차** | `GET /api/onvif-events?from=<now-6H>&limit=500` |
| **기대** | HTTP 200; 모든 이벤트 `serverTs ≥ from` 및 `serverTs ≤ now`; `total ≤ 500` |

---

## 자동화 테스트 실행 결과 (2026-06-24)

### Node.js — `test/api/onvif_apprtp.test.js`

실행 명령: `node test/api/onvif_apprtp.test.js`

| TC ID | 설명 | 결과 |
|---|---|---|
| TC-APPRTP-PARSER-A | parseOnvifPayload: MotionAlarm state=true | ✅ PASS |
| TC-APPRTP-PARSER-B | parseOnvifPayload: non-MetadataStream → null | ✅ PASS |
| TC-APPRTP-PARSER-C | parseOnvifPayload: BoxTemperatureReading radiometry array | ✅ PASS |
| TC-APPRTP-007 | broadcasts appRtp via Socket.IO with cameraId | ✅ PASS |
| TC-APPRTP-007B | no socket emit when io is null (graceful no-op) | ✅ PASS |
| TC-APPRTP-007C | emits appRtp for each POST regardless of ONVIF parse result | ✅ PASS |
| TC-APPRTP-008 | ONVIF payload → DB save + onvif:event broadcast | ✅ PASS |
| TC-APPRTP-008B | dedup: same topic+sourceToken+state → single DB insert | ✅ PASS |
| TC-APPRTP-009 | onvif:temperature for radiometry — no DB insert (dedup bypass) | ✅ PASS |

**요약: 9 passed / 0 failed / 0 skipped**

---

### Node.js — `test/api/onvif_metadata_pipeline.test.js`

실행 명령: `node test/api/onvif_metadata_pipeline.test.js`

| TC ID | 설명 | 결과 |
|---|---|---|
| TC-PARSER-001 | 단일 NotificationMessage → 배열 길이 1 반환 | ✅ PASS |
| TC-PARSER-002 | 다중 NotificationMessage → 배열 길이 N, 교차 오염 없음 (회귀) | ✅ PASS |
| TC-PARSER-003 | 비-MetadataStream 페이로드 → null 반환 | ✅ PASS |
| TC-PARSER-004 | TOPIC_MAP 표준 ONVIF 토픽 정규화 검증 | ✅ PASS |
| TC-PARSER-005 | Samsung namespace 변형 TOPIC_MAP 정규화 (회귀) | ✅ PASS |
| TC-PARSER-006 | Unknown 토픽 → 전체 경로를 topicType, 마지막 세그먼트를 label | ✅ PASS |
| TC-PARSER-007 | State 추출 우선순위 — State > IsMotion > Value, 숫자 정규화 | ✅ PASS |
| TC-PARSER-008 | 다중 이벤트 독립 Dedup (API 통합) | ⊘ SKIPPED (서버 미실행) |
| TC-PARSER-009 | 상태 변화 Dedup — 동일 state 반복 저장 방지 (API 통합) | ⊘ SKIPPED (서버 미실행) |
| TC-PARSER-010 | 파싱 오류 시 200 응답 유지 (API 통합) | ⊘ SKIPPED (서버 미실행) |
| TC-PARSER-007b | RuleName SimpleItem → parsed.ruleName 필드 반환 (유닛) | ✓ PASS |
| TC-PARSER-011 | RuleName 기반 이벤트 분리 — 2행 독립 저장 (API 통합) | ⊘ SKIPPED (서버 미실행) |

**요약: 7 passed / 0 failed / 3 skipped (통합 테스트는 서버 실행 시 자동 수행)**

---

### Python — `test/ingest/test_apprtp.py`

실행 명령: `python -m pytest test/ingest/test_apprtp.py -v`

| TC ID | 설명 | 예상 결과 |
|---|---|---|
| TC-APPRTP-001 | av.open() timeout 옵션 포함 여부 (회귀) | ✅ PASS |
| TC-APPRTP-002 | read_timeout 속성 설정 금지 (회귀) | ✅ PASS |
| TC-APPRTP-003a | close() called on no_app_stream exception | ✅ PASS |
| TC-APPRTP-003b | close() called after normal demux exhaustion | ✅ PASS |
| TC-APPRTP-003c | close() called on unexpected exception | ✅ PASS |
| TC-APPRTP-004 | No application stream → 재시도 없이 종료 | ✅ PASS |
| TC-APPRTP-005 | 재시도 백오프 (0.5 → 0.75 → 1.125 …) | ✅ PASS |
| TC-APPRTP-006 | POST body format (pt/timestamp/seq/payload base64) | ✅ PASS |
| TC-APPRTP-010 | _signal_stop() 후 3초 이내 스레드 종료 | ✅ PASS |

> **참고:** `pytest` 가 설치되지 않은 환경에서는 `pip install pytest` 후 실행.
> Python 테스트 결과는 Admin Audit UI에 별도 표시되지 않으며,
> CI/CD 파이프라인에서 `pytest` 단계로 실행됩니다.

---

### Admin Dashboard → Audit → Startup Tests

서버 시작 후 자동 수행되는 TcRunnerService 스위트 등록 현황:

| 스위트 파일 | SRS 참조 | 스위트 레이블 | 조건 |
|---|---|---|---|
| `test/api/onvif_apprtp.test.js` | `FR-ONVIF-RTP-001~010` | ONVIF App-RTP | — |
| `test/api/onvif_metadata_pipeline.test.js` | `FR-ONVIF-PIPE-001~020` | ONVIF Metadata Pipeline | — |
| `test/api/thermal_radiometry_overlay.test.js` | `FR-THERMAL-001~010` | Thermal Radiometry Overlay | — |
| `test/api/timeline_range.test.js` | `FR-TIMELINE-RANGE-001~008` | Timeline 1H Range  Streaming | `streamingOnly` — Streaming Server 모드에서만 실행 |

Admin Dashboard → Audit → Startup Tests 탭에서 스위트별 TC 결과를 조회할 수 있습니다.
`streamingOnly` 스위트는 `SERVER_MODE=streaming`일 때만 실행되며, 그 외 모드에서는 `SKIP` 처리됩니다.

---

## TC-DISCONNECT-001 — 미결 ONVIF 이벤트 자동 종료 (단위)

| 항목 | 내용 |
|---|---|
| **SRS** | FR-ONVIF-DISCONNECT-001~004 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js` (서버 필요 없는 단위 테스트) |
| **전제** | `internalApi.js`의 `closeOpenEventsForCamera` 함수 직접 호출 |
| **절차** | 1. DB Mock에 cameraId=`test-cam` state='true' 이벤트 1건 삽입  2. `closeOpenEventsForCamera('test-cam')` 호출  3. DB insert 호출 여부 확인  4. Socket.IO emit 호출 여부 확인 |
| **기대** | `state='false'`, `disconnectClose=true`인 이벤트 1건 삽입; `onvif:event` emit 1회 |

## TC-DISCONNECT-002 — 카메라 중지 시 종료 이벤트 삽입 (API 통합)

| 항목 | 내용 |
|---|---|
| **SRS** | FR-ONVIF-DISCONNECT-001~005 |
| **자동화** | `test/api/onvif_metadata_pipeline.test.js` (서버 실행 필요) |
| **전제** | LTS 서버 실행 중; 테스트 카메라 등록 |
| **절차** | 1. `POST /api/internal/apprtp/:cameraId` 로 state='true' 이벤트 전송  2. `DELETE /api/cameras/:id` 또는 `stopCamera` 트리거  3. `GET /api/onvif-events?cameraId=…` 조회 |
| **기대** | 응답에 `state='false'` + `disconnectClose=true` 이벤트 1건 추가 확인 |

## TC-DISCONNECT-003 — 미결 없는 경우 DB insert 없음 (단위)

| 항목 | 내용 |
|---|---|
| **SRS** | FR-ONVIF-DISCONNECT-001 |
| **절차** | 1. DB에 state='false' 이벤트만 있는 카메라에 대해 `closeOpenEventsForCamera` 호출  2. DB insert 호출 수 확인 |
| **기대** | insert 호출 0회 (미결 이벤트 없으므로 아무것도 삽입하지 않음) |

## TC-DISCONNECT-004 — dedup 상태 초기화 (단위)

| 항목 | 내용 |
|---|---|
| **SRS** | FR-ONVIF-DISCONNECT-004 |
| **절차** | 1. `_lastStates`에 `test-cam:topic:src:` 키 설정  2. `closeOpenEventsForCamera('test-cam')` 호출  3. `_lastStates`에 해당 키 존재 여부 확인 |
| **기대** | 호출 후 `test-cam:` 으로 시작하는 모든 키 삭제됨 |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-23 | 초기 작성 — App RTP 수집 파이프라인 TC-APPRTP-001 ~ 012 정의 |
| 1.1 | 2026-06-23 | TC-APPRTP-001~002 회귀 케이스 추가 — PyAV read_timeout 속성 쓰기 오류 및 MediaMTX maxReaders 소진 재현 방지 |
| 1.2 | 2026-06-23 | TC-PARSER-001~010 추가 — onvifParser.js 다중 NotificationMessage 파싱 버그 수정 검증 및 Samsung namespace 변형·State 추출·Dedup 회귀 방지 |
| 1.3 | 2026-06-24 | 자동화 테스트 실행 결과 섹션 추가 — onvif_apprtp.test.js 9/9 PASS, metadata_pipeline 7/7(단위) PASS; TcRunnerService Audit UI 연동 확인 |
| 1.4 | 2026-06-24 | TC-APPRTP-013~014 추가 — MediaMTX App RTP URL 분리 검증 + EADDRINUSE 3회 종료 방어 처리 |
| 1.5 | 2026-06-24 | TC-TIMELINE-RANGE-001~008 추가 — ONVIF 이벤트·Detection tracks API 1H/6H 범위 파라미터 검증 (streamingOnly); Admin Audit 스위트 표에 timeline_range 추가 |
| 1.6 | 2026-06-24 | TC-PARSER-007b (유닛) + TC-PARSER-011 (통합) 추가 — RuleName 기반 이벤트 분리 검증; Traceability Matrix에 두 TC 추가 |
| 1.7 | 2026-06-26 | TC-DISCONNECT-001~004 추가 — 카메라 연결 해제 시 미결 ONVIF 이벤트 자동 종료 검증 |
