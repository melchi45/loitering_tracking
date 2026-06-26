# PRODUCT REQUIREMENTS DOCUMENT
# ONVIF Metadata Pipeline — App RTP 기반 카메라 이벤트 수집

| | |
|---|---|
| **Document ID** | PRD-LTS-ONVIF-01 |
| **Version** | 1.4 |
| **Status** | Active |
| **Date** | 2026-06-24 |
| **Related RFP** | [RFP_ONVIF_Metadata_Pipeline.md](../rfp/RFP_ONVIF_Metadata_Pipeline.md) |
| **Related SRS** | [SRS_ONVIF_Metadata_Pipeline.md](../srs/SRS_ONVIF_Metadata_Pipeline.md) |
| **Related Design** | [Design_ONVIF_Metadata_Pipeline.md](../design/Design_ONVIF_Metadata_Pipeline.md) |
| **Related TC** | [TC_ONVIF_Metadata_Pipeline.md](../tc/TC_ONVIF_Metadata_Pipeline.md) |

---

## 1. 제품 요약

LTS-2026 대시보드에서 ONVIF 호환 IP 카메라가 RTSP Application RTP 채널로 전송하는
이벤트(모션 감지·라인 크로싱·온도 알람 등)를 실시간으로 수집·저장하고,
Gantt 타임라인 UI에 표시하는 기능을 제공합니다.

---

## 2. 사용자 스토리

| ID | 역할 | 목표 | 가치 |
|---|---|---|---|
| US-ONVIF-001 | 보안 운영자 | 카메라 ONVIF 이벤트를 대시보드에서 실시간 확인 | 외부 VMS 없이 통합 운영 |
| US-ONVIF-002 | 보안 운영자 | 과거 이벤트 이력을 시간 범위로 검색 | 사고 발생 후 분석 |
| US-ONVIF-003 | 시스템 관리자 | 열상 카메라 온도 데이터를 실시간 오버레이로 확인 | 화재 예방 모니터링 |
| US-ONVIF-004 | 시스템 관리자 | 카메라 ONVIF 이벤트 타입 레지스트리 확인 | 이벤트 분류 검증 |

---

## 3. 기능 요구사항

### 3.1 App RTP 수집 (ingest-daemon)

| 요구사항 ID | 설명 | 우선순위 |
|---|---|---|
| PRD-ONVIF-001 | `appRtpCallbackUrl` 설정 시 App RTP 수집 스레드 자동 시작 | P0 |
| PRD-ONVIF-002 | `av.open(options={"timeout": ...})` 방식으로 타임아웃 설정 (PyAV 버전 독립성) | P0 |
| PRD-ONVIF-003 | Application 트랙 없는 카메라에서 재시도 없이 조용히 종료 | P1 |
| PRD-ONVIF-004 | 연결 실패 시 지수 백오프 재시도 (0.5s → 5.0s, factor 1.5) | P1 |
| PRD-ONVIF-005 | 항상 `inp.close()` 호출 (MediaMTX 세션 누수 방지) | P0 |
| PRD-ONVIF-006 | `_signal_stop()` 후 3초 이내 스레드 종료 | P1 |
| PRD-ONVIF-007 | RTP 패킷을 `{pt, timestamp, seq, payload}` JSON으로 HTTP POST | P0 |
| PRD-ONVIF-008 | MediaMTX 환경에서 `appRtpRtspUrl` (원본 카메라 URL)을 별도 전달해 ONVIF 데이터 트랙 수집 보장 | P0 |
| PRD-ONVIF-009 | `EADDRINUSE` 3회 연속 발생 시 App RTP 스레드 자동 종료 (로그 스팸 방지) | P1 |

### 3.2 서버 라우팅 (`POST /api/internal/apprtp/:cameraId`)

| 요구사항 ID | 설명 | 우선순위 |
|---|---|---|
| PRD-ONVIF-010 | `io.emit('appRtp', ...)` 원시 RTP 브로드캐스트 | P0 |
| PRD-ONVIF-011 | mediasoup 환경에서 DataProducer로 appRtp 전달 | P1 |
| PRD-ONVIF-012 | ONVIF MetadataStream XML 구조화 파싱 | P0 |
| PRD-ONVIF-013 | 열상 데이터는 dedup 없이 즉시 `onvif:temperature` 브로드캐스트 | P0 |
| PRD-ONVIF-014 | topic+sourceToken+state 기준 dedup → DB 저장 → `onvif:event` 브로드캐스트 | P0 |
| PRD-ONVIF-015 | 파싱 오류 시 200 응답 유지 (ingest-daemon 영향 없음) | P1 |

### 3.3 ONVIF XML 파싱 (`onvifParser.js`)

| 요구사항 ID | 설명 | 우선순위 |
|---|---|---|
| PRD-ONVIF-020 | base64 페이로드 디코딩 후 MetadataStream 여부 판별 | P0 |
| PRD-ONVIF-021 | 다중 `NotificationMessage` 블록 각각 독립 파싱 (배열 반환) | P0 |
| PRD-ONVIF-022 | 표준 ONVIF 토픽 → `type/label/severity` 정규화 (TOPIC_MAP) | P0 |
| PRD-ONVIF-023 | Samsung namespace 변형 → 동등 표준 type 정규화 | P0 |
| PRD-ONVIF-024 | 미등록 토픽 → 전체 경로를 `topicType`으로 처리 (이벤트 누락 없음) | P1 |
| PRD-ONVIF-025 | State 추출 우선순위: `State > IsMotion > IsSoundDetected > ...` | P1 |
| PRD-ONVIF-026 | `BoxTemperatureReading` 방사측정 데이터 파싱 → `radiometry[]` 배열 | P0 |

### 3.4 이벤트 REST API

| 요구사항 ID | 엔드포인트 | 설명 | 우선순위 |
|---|---|---|---|
| PRD-ONVIF-030 | `GET /api/onvif-events` | cameraId/type/severity/from/to/limit 필터 | P0 |
| PRD-ONVIF-031 | `DELETE /api/onvif-events` | 이벤트 삭제 (cameraId 또는 전체) | P1 |
| PRD-ONVIF-032 | `GET /api/onvif-event-types` | 이벤트 타입 레지스트리 조회 | P1 |
| PRD-ONVIF-033 | `DELETE /api/onvif-event-types` | 타입 레지스트리 초기화 (Admin) | P2 |
| PRD-ONVIF-034 | `GET /api/onvif-snapshots` | 이벤트 발생 시점 스냅샷 이미지 조회 | P1 |

### 3.5 클라이언트 UI

| 요구사항 ID | 컴포넌트 | 설명 | 우선순위 |
|---|---|---|---|
| PRD-ONVIF-040 | `OnvifTimelineOverlay.tsx` | Gantt 타임라인 — 구간 바 + 포인트 마커 | P0 |
| PRD-ONVIF-041 | `OnvifTimelineOverlay.tsx` | 줌/팬 컨트롤, 이벤트 타입 필터 | P1 |
| PRD-ONVIF-042 | `OnvifTimelineOverlay.tsx` | 실시간 Socket.IO `onvif:event` 수신 | P0 |
| PRD-ONVIF-043 | `ThermalOverlay.tsx` | 열상 온도 오버레이 — 영역별 min/max/avg 표시 | P0 |
| PRD-ONVIF-044 | `ThermalOverlay.tsx` | `onvif:temperature` 수신 후 6초 페이드 타이머 | P1 |
| PRD-ONVIF-045 | Admin ONVIF 탭 | 이벤트 타입 레지스트리 테이블 | P1 |
| PRD-ONVIF-046 | `OnvifTimelineInline.tsx` | 범위 프리셋 `1H`/`6H`/`1D`/`1W`/`1M`/`1Y`/`Custom` 제공; 기본값 `1H` | P1 |
| PRD-ONVIF-047 | `onvifParser.js` | Source SimpleItem `RuleName` (또는 `Rule`) 추출 → `parsed.ruleName` 필드 반환 | P0 |
| PRD-ONVIF-048 | `internalApi.js` | dedup 키에 `ruleName` 포함 — 동일 topic/source라도 RuleName이 다르면 별도 스트림 | P0 |
| PRD-ONVIF-049 | `onvif_events` DB | `ruleName` 필드 저장, GET 응답에 포함 | P0 |
| PRD-ONVIF-050 | `OnvifTimelineInline.tsx` `OnvifTimelineOverlay.tsx` | `(topicType, sourceToken, ruleName)` 3-튜플로 행 분리 — RuleName별 독립 타임라인 행 렌더링 | P0 |
| PRD-ONVIF-051 | `server/src/routes/internalApi.js` | `closeOpenEventsForCamera(cameraId)` 함수 구현 및 내보내기 — 카메라별 미결(state='true') ONVIF 이벤트 탐색 → 합성 state='false' 이벤트 삽입 → Socket.IO 브로드캐스트 → `_lastStates` 초기화 | P0 |
| PRD-ONVIF-052 | `server/src/services/pipelineManager.js` | `setOnCameraOfflineHook(fn)` 메서드 추가; `stopCamera()` 내에서 훅 실행 (카메라 오프라인 전 호출) | P0 |
| PRD-ONVIF-053 | `server/src/index.js` | `closeOpenEventsForCamera`를 `internalApi`에서 가져와 `pipelineManager.setOnCameraOfflineHook()`으로 등록 — 순환 의존성 없이 연결 | P0 |

---

## 4. 비기능 요구사항

| ID | 범주 | 요구사항 | 기준 |
|---|---|---|---|
| NFR-ONVIF-001 | 지연 | 카메라 이벤트 → 브라우저 표시 지연 | ≤ 2초 |
| NFR-ONVIF-002 | 안정성 | MediaMTX RTSP 리더 수 | `maxReaders`(10) 미만 유지 |
| NFR-ONVIF-003 | 종료 응답성 | stop 신호 후 스레드 종료 | ≤ 3초 |
| NFR-ONVIF-004 | 호환성 | PyAV 버전 독립 | 10.x / 11.x / 12.x 모두 동작 |
| NFR-ONVIF-005 | 부하 | 동시 카메라 수 | 최소 16채널 App RTP 동시 처리 |
| NFR-ONVIF-006 | 저장소 | DB 이벤트 보존 한도 | `tc_results`: 10,000건 (TABLE_ROW_CAPS) |

---

## 5. Socket.IO 이벤트 목록

| 이벤트 | 방향 | 페이로드 | 설명 |
|---|---|---|---|
| `appRtp` | Server → Client | `{ cameraId, pt, timestamp, seq, payload }` | 원시 RTP 패킷 (raw base64) |
| `onvif:event` | Server → Client | `{ id, cameraId, topic, topicType, topicLabel, severity, state, sourceToken, utcTime, serverTs, items }` | 구조화 ONVIF 이벤트 |
| `onvif:temperature` | Server → Client | `{ cameraId, utcTime, readings: [{itemId, areaName, maxTemp, maxTempX, maxTempY, minTemp, minTempX, minTempY, avgTemp}] }` | 열상 온도 데이터 (dedup 없음) |
| `onvif:type-registered` | Server → Client | `{ topicType, topicLabel, severity }` | 신규 이벤트 타입 최초 감지 알림 |

---

## 6. 구현 현황 (2026-06-24 기준)

| 컴포넌트 | 상태 | 파일 |
|---|---|---|
| ingest-daemon App RTP 수집 | ✅ 완료 | `ingest-daemon/ingest_daemon.py` |
| PyAV timeout 옵션 방식 수정 | ✅ 완료 (v892e852) | `ingest_daemon.py:612` |
| 서버 내부 API 라우트 | ✅ 완료 | `server/src/routes/internalApi.js:50-175` |
| ONVIF XML 파서 | ✅ 완료 | `server/src/services/onvifParser.js` |
| 다중 NotificationMessage 지원 | ✅ 완료 (v892e852) | `onvifParser.js:225-250` |
| 이벤트 REST API | ✅ 완료 | `server/src/routes/onvifApi.js` |
| Socket.IO 이벤트 브로드캐스트 | ✅ 완료 | `internalApi.js:68-175` |
| OnvifTimelineOverlay UI | ✅ 완료 | `client/src/components/OnvifTimelineOverlay.tsx` |
| ThermalOverlay UI | ✅ 완료 | `client/src/components/ThermalOverlay.tsx` |
| Admin ONVIF 탭 | ✅ 완료 | `client/src/pages/admin/AdminUsersPage.tsx` |
| 단위 테스트 (Python) | ✅ 완료 | `test/ingest/test_apprtp.py` |
| 단위 테스트 (Node.js) | ✅ 완료 | `test/api/onvif_apprtp.test.js` |
| 통합 테스트 (Node.js) | ✅ 완료 | `test/api/onvif_metadata_pipeline.test.js` |

---

## 7. 주요 버그 수정 이력

| 버전/커밋 | 날짜 | 수정 내용 |
|---|---|---|
| v892e852 | 2026-05-?? | PyAV `read_timeout` 속성 AttributeError 수정 → `av.open(options={"timeout":...})` |
| v892e852 | 2026-05-?? | `onvifParser.js` 다중 NotificationMessage 첫 번째만 파싱하던 버그 수정 |
| v892e852 | 2026-05-?? | Samsung namespace 변형 토픽(`tnssamsung:`) TOPIC_MAP 추가 |
| v892e852 | 2026-05-?? | State 추출 우선순위 로직 개선 (`IsMotion`, `IsSoundDetected` 등 폴백) |

---

## 8. 승인 기준 (Definition of Done)

- [ ] `test/ingest/test_apprtp.py` — TC-APPRTP-001~010 모두 통과
- [ ] `test/api/onvif_apprtp.test.js` — TC-APPRTP-007~009 모두 통과
- [ ] `test/api/onvif_metadata_pipeline.test.js` — TC-PARSER-001~010 모두 통과
- [ ] `test/api/thermal_radiometry_overlay.test.js` — TC-B-001~003 모두 통과
- [ ] Admin Dashboard → Audit → Startup Tests 에서 ONVIF 테스트 결과 표시
- [ ] 실 카메라 연동 시 MediaMTX 로그에 `maximum reader count reached` 없음

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-24 | 초기 작성 — ONVIF App RTP 수집 파이프라인 PRD |
| 1.1 | 2026-06-24 | PRD-ONVIF-008~009 추가 — MediaMTX 환경 App RTP URL 분리 및 EADDRINUSE 방어 처리 |
| 1.2 | 2026-06-24 | PRD-ONVIF-046 추가 — OnvifTimelineInline 범위 프리셋 1H/6H 추가, 기본값 1H |
| 1.3 | 2026-06-24 | PRD-ONVIF-047~050 추가 — RuleName 기반 이벤트 분리: 파싱·dedup·DB 저장·타임라인 행 분리 |
| 1.4 | 2026-06-26 | PRD-ONVIF-051~053 추가 — 카메라 연결 해제 시 미결 ONVIF 이벤트 자동 종료: closeOpenEventsForCamera() + setOnCameraOfflineHook() + index.js 훅 등록 |
