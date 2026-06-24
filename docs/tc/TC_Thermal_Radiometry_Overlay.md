# TC: Thermal Radiometry Overlay — ONVIF BoxTemperatureReading 시각화

**Version:** 1.0
**Status:** Ready for Test
**SDLC:** [SRS](../srs/SRS_Thermal_Radiometry_Overlay.md) · [Design](../design/Design_Thermal_Radiometry_Overlay.md)

---

## 그룹 A — 서버 파서 (FR-THERMAL-001, 002)

### TC-A-001: 단일 Named Box Area 파싱

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-002 |
| **전제** | `onvifParser.js` `parseRadiometryReadings()` 직접 호출 |
| **입력** | `ItemID="D" AreaName="D" MaxTemperature="359.9" MaxTemperatureCoordinatesX="243" MaxTemperatureCoordinatesY="217" MinTemperature="333.8" MinTemperatureCoordinatesX="328" MinTemperatureCoordinatesY="261" AverageTemperature="350.0"` |
| **기대** | readings.length === 1 |
| **기대** | readings[0].itemId === "D", areaName === "D" |
| **기대** | maxTemp === 359.9, maxTempX === 243, maxTempY === 217 |
| **기대** | minTemp === 333.8, minTempX === 328, minTempY === 261 |
| **기대** | avgTemp === 350.0 |

### TC-A-002: FullArea (ItemID="Z") 파싱

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-002 |
| **입력** | `ItemID="Z" AreaName="FullArea" MaxTemperature="370.0" MinTemperature="310.0" AverageTemperature="340.0"` (좌표 속성 없음) |
| **기대** | readings[0].itemId === "Z", areaName === "FullArea" |
| **기대** | maxTempX === null, maxTempY === null |
| **기대** | minTempX === null, minTempY === null |

### TC-A-003: FullArea 좌표 포함 파싱

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-002 |
| **입력** | `ItemID="Z" AreaName="FullArea" MaxTemperature="370.0" MaxTemperatureCoordinatesX="100" MaxTemperatureCoordinatesY="80" MinTemperature="310.0" MinTemperatureCoordinatesX="200" MinTemperatureCoordinatesY="150" AverageTemperature="340.0"` |
| **기대** | 파서는 좌표를 파싱한다 (maxTempX === 100) |
| **참고** | coordSlots 필터에서 제외되는 것은 클라이언트 책임 (FR-THERMAL-023) |

### TC-A-004: 복수 BoxTemperatureReading 파싱

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-002 |
| **입력** | 동일 XML 내 `ItemID="D"` + `ItemID="Z"` 두 개 요소 |
| **기대** | readings.length === 2 |
| **기대** | readings[0].itemId === "D", readings[1].itemId === "Z" |

### TC-A-005: 네임스페이스 접두어 무관 파싱

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-002 |
| **전제** | `<ns2:BoxTemperatureReading .../>` 또는 `<BoxTemperatureReading .../>` 형식 |
| **기대** | readings.length === 1 (접두어와 무관하게 파싱 성공) |

### TC-A-006: MaxTemperature·MinTemperature 모두 null → 무시

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-002 |
| **입력** | `ItemID="D" AreaName="D" AverageTemperature="350.0"` (Max/Min 없음) |
| **기대** | readings.length === 0 (해당 요소 제외) |

### TC-A-007: parseOnvifPayload FullArea → radiometry 포함

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-003 |
| **입력** | BoxTemperatureReading 포함 전체 MetadataStream XML base64 인코딩 |
| **기대** | `parsed.radiometry` !== null |
| **기대** | `parsed.topicType === "boxTemperatureReading"` |
| **기대** | `parsed.radiometry[0].itemId === "D"` |

### TC-A-009: MediaMTX 환경에서 appRtpRtspUrl이 원본 카메라 URL로 설정됨

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-004 |
| **전제** | `mediamtxReady=true`인 환경 시뮬레이션 |
| **입력** | `rtspUrl = rtsp://10.0.0.5/live`, `captureUrl = rtsp://127.0.0.1:8554/{uuid}`, `appRtpCallbackUrl = http://127.0.0.1:3080/api/internal/apprtp/{id}` |
| **기대** | ingest-daemon 등록 body: `rtspUrl === captureUrl` (MediaMTX URL), `appRtpRtspUrl === rtspUrl` (원본 카메라 URL) |
| **자동화** | `test/api/onvif_apprtp.test.js::TC-APPRTP-013` |

### TC-A-008: appRtpCallbackUrl 누락 시 App RTP 스레드 미시작

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-001 |
| **전제** | ingest_daemon.py 소스코드 검토 (단위 테스트 불가 — 코드 리뷰) |
| **확인** | `CameraSession.__init__`: `self.app_rtp_callback_url = cfg.get("appRtpCallbackUrl")` |
| **확인** | `if self.app_rtp_callback_url:` 조건 하에서만 apprtp 스레드 시작 |
| **기대** | `appRtpCallbackUrl` 미포함 시 `_app_rtp_loop` 스레드 미생성 |

---

## 그룹 B — Socket.IO 이벤트 (FR-THERMAL-003)

### TC-B-001: BoxTemperatureReading 수신 → onvif:temperature emit

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-003 |
| **전제** | 서버 실행 중, Socket.IO 클라이언트 연결됨 |
| **절차** | 1. `POST /api/internal/apprtp/:cameraId` — BoxTemperatureReading XML base64 payload 전송 |
| **기대** | Socket.IO 클라이언트가 `onvif:temperature` 이벤트 수신 |
| **기대** | payload: `{ cameraId, utcTime, readings: [{ itemId: "D", maxTemp: 359.9, ... }] }` |

### TC-B-002: 중복 패킷도 매번 emit

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-003 |
| **절차** | 동일 BoxTemperatureReading 2회 연속 전송 |
| **기대** | `onvif:temperature` 이벤트 2회 수신 (dedup 없음) |

### TC-B-003: BoxTemperatureReading 없는 ONVIF 패킷 → emit 없음

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-003 |
| **절차** | `tns1:VideoSource/tns1:MotionAlarm` XML payload 전송 |
| **기대** | `onvif:temperature` 이벤트 미수신 |

---

## 그룹 C — 클라이언트 렌더링 규칙 (FR-THERMAL-020~023)

### TC-C-001: FullArea → 상단 배너 표시, crosshair 없음

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-020, FR-THERMAL-023 |
| **전제** | `onvif:temperature` 이벤트: `readings = [{ itemId: "Z", areaName: "FullArea", maxTemp: 370.0, ... }]` |
| **기대** | 영상 상단에 배너 출현: `🌡 FullArea ▲ 370.0 ▼ 310.0 ~ 340.0` |
| **기대** | SVG crosshair가 DOM에 렌더링되지 않는다 |
| **기대** | 좌하단 정보 패널 비표시 |

### TC-C-002: Named Box Area → crosshair + 하단 패널

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-021, FR-THERMAL-022 |
| **전제** | `readings = [{ itemId: "D", areaName: "D", maxTempX: 243, maxTempY: 217, minTempX: 328, minTempY: 261, ... }]` |
| **기대** | SVG crosshair 2개 렌더링: 빨간(maxTempX/Y), 파란(minTempX/Y) |
| **기대** | crosshair 라벨: `"D 86.8°C"` (Kelvin → Celsius 변환) |
| **기대** | 좌하단 패널: `🌡 D ▲ 359.9 (86.8°C) ▼ 333.8 (60.7°C)` |
| **기대** | 상단 배너 미표시 |

### TC-C-003: FullArea + Named Area 혼합 이벤트

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-020, FR-THERMAL-021, FR-THERMAL-023 |
| **전제** | `readings = [{ itemId: "D", ... }, { itemId: "Z", areaName: "FullArea", ... }]` |
| **기대** | 상단 배너: FullArea 온도 표시 |
| **기대** | SVG crosshair: "D" 영역 좌표만 표시 (FullArea crosshair 없음) |
| **기대** | 좌하단 패널: "D" 영역 온도 표시 |

### TC-C-004: FullArea 좌표 포함 → crosshair 렌더링 금지

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-023 |
| **전제** | FullArea 리딩이 `maxTempX=100, maxTempY=80` 좌표를 포함 |
| **기대** | `coordSlots`가 이 리딩을 포함하지 않는다 |
| **기대** | SVG crosshair DOM에 FullArea 좌표 마커 없음 |

### TC-C-005: Area별 독립 fade (6초)

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-011 |
| **전제** | "D" 이벤트 수신 후 "D" 이벤트 추가 미수신 |
| **절차** | 6초 경과 후 DOM 확인 |
| **기대** | "D" crosshair 및 하단 패널 DOM에서 제거됨 |
| **기대** | 다른 Area(예: "Z")에 영향 없음 |

---

## 그룹 D — 온도 표시 포맷 (FR-THERMAL-013)

### TC-D-001: Kelvin 값 변환 표시

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-013 |
| **입력** | `maxTemp = 359.9` (>200 → Kelvin 판정) |
| **기대** | 배너 표시: `"359.9 (86.8°C)"` |
| **기대** | crosshair 라벨: `"86.8°C"` |

### TC-D-002: Celsius 값 직접 표시

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-013 |
| **입력** | `maxTemp = 86.8` (≤200 → Celsius 판정) |
| **기대** | 배너 표시: `"86.8°C"` |
| **기대** | crosshair 라벨: `"86.8°C"` |

### TC-D-003: null 온도 값 — 대시 표시

| 항목 | 내용 |
|------|------|
| **SRS** | FR-THERMAL-013 |
| **입력** | `avgTemp = null` |
| **기대** | 평균 온도 항목 미표시 (null 항목 조건부 렌더링) |

---

## 그룹 E — Non-Functional (NFR-THERMAL-01~03)

### TC-E-001: 렌더링 지연 ≤ 150ms

| 항목 | 내용 |
|------|------|
| **SRS** | NFR-THERMAL-01 |
| **절차** | `onvif:temperature` emit 직후 `performance.now()` 기록, 렌더링 완료 후 차이 측정 |
| **기대** | 갱신 지연 ≤ 150ms |

### TC-E-002: pointer-events-none 확인

| 항목 | 내용 |
|------|------|
| **SRS** | NFR-THERMAL-02 |
| **절차** | DevTools에서 ThermalOverlay 루트 div 클래스 확인 |
| **기대** | `class` 속성에 `pointer-events-none` 포함 |

### TC-E-003: 언마운트 시 리소스 해제

| 항목 | 내용 |
|------|------|
| **SRS** | NFR-THERMAL-03 |
| **절차** | CameraView에서 카메라 제거 → ThermalOverlay 언마운트 → 브라우저 메모리 프로파일링 |
| **기대** | `socket.off('onvif:temperature')` 호출 확인 |
| **기대** | 잔존 setTimeout 없음 (timersRef.current 모두 clearTimeout) |

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-23 | 초기 작성 — TC-A~E 전체 정의 |
| 1.1 | 2026-06-24 | TC-A-009 추가 — MediaMTX 환경 App RTP URL 분리 검증 |
