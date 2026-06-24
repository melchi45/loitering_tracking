# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Thermal Radiometry Overlay — ONVIF BoxTemperatureReading 시각화

| | |
|---|---|
| **Document ID** | SRS-LTS-THERMAL-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-23 |
| **Design** | [Design_Thermal_Radiometry_Overlay.md](../design/Design_Thermal_Radiometry_Overlay.md) |
| **TC** | [TC_Thermal_Radiometry_Overlay.md](../tc/TC_Thermal_Radiometry_Overlay.md) |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [FR — 서버 파이프라인](#3-fr--서버-파이프라인)
4. [FR — 클라이언트 렌더링](#4-fr--클라이언트-렌더링)
5. [FR — Area 유형별 표시 규칙](#5-fr--area-유형별-표시-규칙)
6. [Non-Functional Requirements](#6-non-functional-requirements)
7. [Constraints](#7-constraints)

---

## 1. Introduction

### 1.1 Purpose

본 SRS는 열상 카메라 ONVIF Radiometry BoxTemperatureReading 데이터를 수집·파싱·시각화하는 **ThermalOverlay** 기능의 검증 가능한 요구사항을 정의합니다.

### 1.2 Scope

- RTSP App RTP 트랙의 ONVIF Radiometry XML 수신 및 파싱
- Socket.IO `onvif:temperature` 이벤트를 통한 실시간 클라이언트 전달
- 카메라 영상 위 온도 오버레이 렌더링 (Area 유형별 분리)

Out of scope: 온도 히스토리 저장, DB 기록, 알림 생성.

### 1.3 Definitions

| 용어 | 정의 |
|---|---|
| BoxTemperatureReading | ONVIF Radiometry 표준의 온도 측정 요소. Area 이름·최고·최저·평균 온도·좌표 포함 |
| FullArea | `AreaName="FullArea"` 또는 `ItemID="Z"` 리딩. 전체 화면 온도 측정을 의미 |
| Named Box Area | FullArea 외 사용자 정의 영역 (예: `ItemID="D"`, `AreaName="D"`) |
| appRtpCallbackUrl | ingest-daemon이 App RTP 패킷을 Node.js 서버로 POST 전달할 URL |
| crosshair | SVG 십자선 마커. 최고·최저 온도 픽셀 좌표에 표시 |

---

## 2. System Overview

```
열상 카메라 RTSP
  → [ingest_daemon.py] App RTP 수신 (PyAV data track)
  → POST /api/internal/apprtp/:cameraId
  → [onvifParser.js] parseRadiometryReadings()
  → Socket.IO emit('onvif:temperature', { cameraId, utcTime, readings[] })
  → [ThermalOverlay.tsx] 영상 위 오버레이 렌더링
```

---

## 3. FR — 서버 파이프라인

### FR-THERMAL-001: appRtpCallbackUrl 필수 전달

카메라를 ingest-daemon에 등록할 때 `appRtpCallbackUrl` 필드를 payload에 포함해야 한다.

- **조건:** `pipelineManager.js` 및 `restartIngestDaemon.js` 모두 해당
- **검증:** ingest-daemon 로그에 `[cameraId] App RTP loop starting → <url>` 출력 확인

### FR-THERMAL-004: MediaMTX 환경 App RTP URL 분리

MediaMTX RTSP 프록시 사용 시(`mediamtxReady=true`), App RTP는 MediaMTX 재전송 URL 대신 **원본 카메라 RTSP URL**에서 데이터를 수집해야 한다.

- `pipelineManager.js`: `appRtpRtspUrl = rtspUrl` (원본 카메라 URL)을 ingest-daemon 등록 body에 포함
- ingest-daemon: `self.app_rtp_rtsp_url = cfg.get("appRtpRtspUrl", cfg["rtspUrl"])` 사용
- `_app_rtp_ingest_once()`: `av.open(self.app_rtp_rtsp_url, ...)` 사용

**근거:** MediaMTX는 ONVIF BoxTemperatureReading 데이터 트랙을 제거하므로, 열상 카메라 온도 데이터가 MediaMTX URL에서는 수신되지 않는다.

### FR-THERMAL-002: BoxTemperatureReading 정규식 파싱

`parseRadiometryReadings(xml)` 함수는 XML에서 `BoxTemperatureReading` 요소를 모두 추출해야 한다.

- `ItemID`, `AreaName`, `MaxTemperature`, `MaxTemperatureCoordinatesX/Y`, `MinTemperature`, `MinTemperatureCoordinatesX/Y`, `AverageTemperature` 속성을 파싱한다.
- 네임스페이스 접두어(`ttr:`, `ns:` 등) 존재 여부와 무관하게 매칭된다.
- `MaxTemperature`와 `MinTemperature` 모두 null이면 해당 요소를 무시한다.

### FR-THERMAL-003: 실시간 Socket.IO 이벤트 발행

서버는 BoxTemperatureReading 수신 시마다 `onvif:temperature` 이벤트를 즉시 emit한다.

- **중복 제거 없음:** 동일 상태 반복 패킷도 매번 emit (실시간 온도 갱신 필요)
- Payload: `{ cameraId, utcTime, readings: ThermalReading[] }`

---

## 4. FR — 클라이언트 렌더링

### FR-THERMAL-010: Area별 독립 상태 관리

`ThermalOverlay`는 `Map<areaKey, AreaSlot>` 구조로 Area별 상태를 독립 관리한다.

- areaKey 우선순위: `itemId` → `areaName` → `"area-{idx}"`
- 이벤트 수신 시 해당 Area만 갱신하고 다른 Area 상태를 유지한다.

### FR-THERMAL-011: Area 자동 fade

Area별 독립 타이머: 마지막 이벤트로부터 6초 경과 시 해당 Area를 Map에서 제거한다.

### FR-THERMAL-012: 좌표 변환

픽셀 좌표는 `getRenderArea()` 레터박스 보정을 적용해 화면 좌표로 변환한다.

- `frameWidth` 또는 `frameHeight`가 0이면 crosshair를 off-screen(-9999, -9999)으로 렌더링한다 (화면에 보이지 않음).

### FR-THERMAL-013: 온도 단위 heuristic

- 값 > 200 → Kelvin으로 간주 → `"{K} ({K−273.15}°C)"` 포맷
- 값 ≤ 200 → Celsius → `"{value}°C"` 포맷

---

## 5. FR — Area 유형별 표시 규칙

### FR-THERMAL-020: FullArea 상단 배너 전용

`AreaName="FullArea"` 또는 `ItemID="Z"` 인 리딩은 영상 상단 배너로만 표시한다.

- 배너 위치: `absolute top-0 left-0 right-0`, flex 중앙 정렬
- 표시 내용: 🌡 Area 이름, ▲ 최고 온도, ▼ 최저 온도, ~ 평균 온도
- **crosshair SVG를 렌더링하지 않는다.**

### FR-THERMAL-021: Named Box Area crosshair 표시

`isFullArea()` 가 `false`이고 `maxTempX/Y` 또는 `minTempX/Y` 가 non-null인 리딩은 SVG crosshair를 렌더링한다.

- 최고 온도 좌표: 빨간 십자선(`#ef4444`) + 라벨 `"{AreaName} {temp}°C"`
- 최저 온도 좌표: 파란 십자선(`#38bdf8`) + 라벨 `"{AreaName} {temp}°C"`

### FR-THERMAL-022: Named Box Area 하단 정보 패널

`isFullArea()` 가 `false`인 리딩은 `coordSlots.length > 0` 조건 하에 좌하단 정보 패널에 표시한다.

- 표시 항목: Area 이름, ▲ 최고 온도, ▼ 최저 온도, ~ 평균 온도

### FR-THERMAL-023: coordSlots FullArea 명시적 제외

`coordSlots` 필터는 `isFullArea()` 조건을 명시적으로 평가해 FullArea 리딩을 제외해야 한다.

```typescript
// 요구사항 충족 코드
const coordSlots = allReadings.filter(s => {
  const r = s.reading;
  return !isFullArea(r) && (
    (r.maxTempX !== null && r.maxTempY !== null) ||
    (r.minTempX !== null && r.minTempY !== null)
  );
});
```

> **배경:** 일부 카메라는 FullArea 리딩에도 좌표 속성을 포함해 전송한다.  
> `!isFullArea(r)` 체크 없이 좌표 존재 여부만 확인하면 FullArea에 crosshair가 잘못 렌더링된다.

---

## 6. Non-Functional Requirements

### NFR-THERMAL-01: 실시간성

`onvif:temperature` 수신 후 150ms 이내에 렌더링이 갱신되어야 한다.

### NFR-THERMAL-02: 렌더링 안전성

`pointer-events-none` 클래스 적용 — 오버레이가 카메라 뷰 조작을 방해하지 않는다.

### NFR-THERMAL-03: 메모리 누수 방지

컴포넌트 언마운트 시 socket 핸들러와 모든 fade 타이머를 반드시 해제한다.

---

## 7. Constraints

1. `onvif:temperature` 이벤트는 DB에 저장하지 않는다 (휘발성 실시간 스트림).
2. `ThermalOverlay`는 `CameraView` 내부에 항상 마운트된다 (데이터 유무와 무관).
3. FullArea crosshair 금지 규칙은 카메라 벤더·모델과 무관하게 적용된다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-23 | 초기 작성 — FR-THERMAL-001~023, NFR 정의 |
| 1.1 | 2026-06-24 | FR-THERMAL-004 추가 — MediaMTX 환경에서 App RTP가 원본 카메라 URL 사용 (온도 데이터 수신 보장) |
