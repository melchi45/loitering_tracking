# DESIGN DOCUMENT
# Thermal Radiometry Overlay — ONVIF BoxTemperatureReading 시각화

| | |
|---|---|
| **Document ID** | DESIGN-LTS-THERMAL-01 |
| **Version** | 1.2 |
| **Status** | Active |
| **Date** | 2026-06-23 |
| **Related** | [Design_ONVIF_Metadata_Pipeline.md](Design_ONVIF_Metadata_Pipeline.md) · [Design_ONVIF_Timeline.md](Design_ONVIF_Timeline.md) · [Design_Fullscreen_Camera_View.md](Design_Fullscreen_Camera_View.md) · [PRD_Thermal_Sensor_Coordinate_Calibration.md](../prd/PRD_Thermal_Sensor_Coordinate_Calibration.md) |

---

## 1. 개요

열상(Thermal) IP 카메라는 RTSP Application RTP 트랙에 **ONVIF Radiometry BoxTemperatureReading** XML을 실어 각 프레임의 온도 측정 데이터를 전달합니다.

`ThermalOverlay` 컴포넌트는 이 데이터를 실시간으로 수신해 카메라 영상 위에 오버레이합니다.

Area 유형에 따라 표시 방식이 분리됩니다.

| Area 유형 | `isFullArea()` | 표시 방식 |
|---|---|---|
| `AreaName="FullArea"` 또는 `ItemID="Z"` | `true` | 영상 **상단 배너** (최고·최저·평균 온도) |
| 그 외 명명된 Box Area (예: `ItemID="D"`) | `false` | **SVG Crosshair** (max/min 좌표) + 좌하단 정보 패널 |

---

## 2. ONVIF XML 포맷 — BoxTemperatureReading

Samsung 열상 카메라가 전송하는 XML 예시:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tt:MetadataStream
    xmlns:tt="http://www.onvif.org/ver10/schema"
    xmlns:ttr="https://www.onvif.org/ver20/analytics/radiometry"
    xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
    xmlns:tns1="http://www.onvif.org/ver10/topics">
  <tt:Event>
    <wsnt:NotificationMessage>
      <wsnt:Topic Dialect="...ConcreteSet">
        tns1:VideoAnalytics/Radiometry/BoxTemperatureReading
      </wsnt:Topic>
      <wsnt:Message>
        <tt:Message UtcTime="2026-04-20T03:37:22.359Z">
          <tt:Source>
            <tt:SimpleItem Name="VideoSourceToken" Value="VideoSourceToken-0"/>
            <tt:SimpleItem Name="VideoAnalyticsConfigurationToken" Value="VideoAnalyticsConfigToken-0"/>
            <tt:SimpleItem Name="AnalyticsModuleName" Value="TemparetureDetectionModule-01"/>
          </tt:Source>
          <tt:Data>
            <tt:ElementItem Name="Reading">
              <!-- 명명된 Box Area: 좌표 포함 -->
              <ttr:BoxTemperatureReading
                ItemID="D" AreaName="D"
                MaxTemperature="359.9"
                MaxTemperatureCoordinatesX="243" MaxTemperatureCoordinatesY="217"
                MinTemperature="333.8"
                MinTemperatureCoordinatesX="328" MinTemperatureCoordinatesY="261"
                AverageTemperature="350.0"/>
              <!-- FullArea: 좌표 없거나 의미 없음, 상단 배너만 표시 -->
              <!-- ItemID="Z" AreaName="FullArea" ... -->
            </tt:ElementItem>
            <tt:SimpleItem Name="TimeStamp" Value="2026-04-20T03:37:22.359Z"/>
          </tt:Data>
        </tt:Message>
      </wsnt:Message>
    </wsnt:NotificationMessage>
  </tt:Event>
</tt:MetadataStream>
```

---

## 3. 데이터 파이프라인

```
열상 카메라 RTSP
  → ingest_daemon.py _app_rtp_loop()   (PyAV data track demux)
  → POST /api/internal/apprtp/:cameraId  { pt, timestamp, seq, payload }
  → internalApi.js parseOnvifPayload()
      └─ parseRadiometryReadings()      (정규식 파서)
  → _io.emit('onvif:temperature', { cameraId, utcTime, readings[] })
  → ThermalOverlay.tsx socket.on('onvif:temperature', handler)
  → Map<areaKey, AreaSlot> 상태 upsert
  → SVG crosshair / 상단 배너 렌더링
```

### 3.1 ingest-daemon 등록 필수 조건

카메라 등록 시 `appRtpCallbackUrl` 필드를 반드시 포함해야 합니다.  
누락 시 ingest-daemon이 App RTP 스레드를 시작하지 않아 온도 데이터가 서버에 전달되지 않습니다.

```python
# ingest_daemon.py L210–211
if self.app_rtp_callback_url:
    self._start_thread("apprtp", self._app_rtp_loop)
```

`appRtpCallbackUrl`은 `pipelineManager.js`와 `restartIngestDaemon.js` 양쪽에서 반드시 payload에 포함해야 합니다.

---

## 4. 서버 파서 — `parseRadiometryReadings()`

**파일:** `server/src/services/onvifParser.js`

```javascript
function parseRadiometryReadings(xml) {
  const re = /<(?:[^:>\s]+:)?BoxTemperatureReading\s+([^>]+?)\/>/g;
  // ...
  readings.push({
    itemId:   getAttr('ItemID'),
    areaName: getAttr('AreaName') || getAttr('ItemID'),
    maxTemp:  parseFloat(getAttr('MaxTemperature')),
    maxTempX: parseInt(getAttr('MaxTemperatureCoordinatesX'), 10),
    maxTempY: parseInt(getAttr('MaxTemperatureCoordinatesY'), 10),
    minTemp:  parseFloat(getAttr('MinTemperature')),
    minTempX: parseInt(getAttr('MinTemperatureCoordinatesX'), 10),
    minTempY: parseInt(getAttr('MinTemperatureCoordinatesY'), 10),
    avgTemp:  parseFloat(getAttr('AverageTemperature')),
  });
}
```

- `ttr:BoxTemperatureReading` 등 네임스페이스 접두어 자동 처리
- 온도 단위: 카메라가 Kelvin(K) 값을 전송하는 경우 값 > 200이면 Kelvin으로 판단
- 좌표는 **프레임 픽셀 단위** — `toScreen()`으로 실제 렌더 영역으로 변환

---

## 5. 클라이언트 — `ThermalOverlay.tsx`

**파일:** `client/src/components/ThermalOverlay.tsx`

### 5.1 상태 구조

```typescript
// Area별 독립 Map — 각 Area가 독립적으로 수신·fade됨
const [areas, setAreas] = useState<Map<string, AreaSlot>>(new Map());
const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

// areaKey: itemId → areaName → "area-{idx}" 순서
function areaKey(r: ThermalReading, fallback: string): string {
  return r.itemId ?? r.areaName ?? fallback;
}
```

### 5.2 FullArea 판별

```typescript
// AreaName="FullArea" 또는 ItemID="Z" → 상단 배너 전용
function isFullArea(r: ThermalReading): boolean {
  return r.areaName === 'FullArea' || r.itemId === 'Z';
}
```

### 5.3 렌더링 슬롯 분류

```typescript
const allReadings   = Array.from(areas.values());
const fullAreaSlots = allReadings.filter(s => isFullArea(s.reading));
const pointSlots    = allReadings.filter(s => !isFullArea(s.reading));

// FullArea 제외 — 명명 Box Area만 crosshair 렌더링
const coordSlots    = allReadings.filter(s => {
  const r = s.reading;
  return !isFullArea(r) && (
    (r.maxTempX !== null && r.maxTempY !== null) ||
    (r.minTempX !== null && r.minTempY !== null)
  );
});
```

> **중요:** `coordSlots`는 `isFullArea()` 가 `true`인 리딩을 명시적으로 제외합니다.  
> FullArea 리딩에 좌표 속성이 있더라도 crosshair를 렌더링하지 않습니다.

### 5.4 렌더링 구조

```
┌────────────────────────────────────────────────────────┐
│  🌡 FullArea ▲359.9 (86.8°C) ▼333.8 (60.7°C) ~350.0  │  ← fullAreaSlots 상단 배너
├────────────────────────────────────────────────────────┤
│                                                        │
│          ╋── 86.8°C  (maxTempX, maxTempY)  [빨간]     │  ← coordSlots SVG crosshair
│          ╋── 60.7°C  (minTempX, minTempY)  [파란]     │
│                                                        │
│  🌡 D                                                  │  ← pointSlots 좌하단 패널
│  ▲ 86.8°C  ▼ 60.7°C  ~ 76.9°C                        │
└────────────────────────────────────────────────────────┘
```

### 5.5 좌표 변환 — `toScreen()`

> **v1.2 변경:** 정규화 분모가 `frameWidth`/`frameHeight`에서 `sensorWidth`/`sensorHeight`로 분리되었다. §8 참조.

```typescript
function toScreen(px, py, sensorW, sensorH, fw, fh, cw, ch) {
  if (!fw || !fh || !cw || !ch || !sensorW || !sensorH) return { sx: -9999, sy: -9999 };
  const { rw, rh, ox, oy } = getRenderArea(fw, fh, cw, ch);
  const sx = Math.max(ox, Math.min(ox + rw, ox + (px / sensorW) * rw));
  const sy = Math.max(oy, Math.min(oy + rh, oy + (py / sensorH) * rh));
  return { sx, sy };
}
```

- `getRenderArea(fw, fh, cw, ch)`: CameraView `drawOverlay()`와 동일한 레터박스 보정 적용 — 계속 **영상 프레임 해상도**(`frameWidth`/`frameHeight`) 기준
- 원시 좌표 정규화(`px / sensorW`, `py / sensorH`)는 **열상 센서 원본 해상도** 기준 — Camera Edit 모달의 Sensor Coordinate 설정값
- `frameWidth`/`frameHeight`/`sensorWidth`/`sensorHeight` 중 하나라도 미전달(0/falsy) 시 좌표 `-9999` → off-screen 렌더 (화면 미표시)
- 결과 좌표는 렌더 영역(`ox..ox+rw`, `oy..oy+rh`) 내로 clamp되어 letterbox 바 안에는 표시되지 않음

### 5.6 온도 표시 포맷

```typescript
// 단위 heuristic: 값 > 200 → Kelvin
function formatTemp(t: number | null): string {
  if (t === null) return '—';
  if (t > 200) return `${t.toFixed(1)} (${(t - 273.15).toFixed(1)}°C)`;
  return `${t.toFixed(1)}°C`;
}

// crosshair 라벨: 변환값만 표시
function crosshairLabel(t: number | null): string {
  if (t === null) return '';
  if (t > 200) return `${(t - 273.15).toFixed(1)}°C`;
  return `${t.toFixed(1)}°C`;
}
```

### 5.7 Fade 타이머

Area별 독립 타이머: 마지막 이벤트 수신 후 6초(`FADE_MS = 6000`) 경과 시 해당 Area 제거.

```typescript
const FADE_MS = 6000;
// React 18 Concurrent Mode 안전성을 위해 타이머는 상태 updater 외부에서 관리
```

---

## 6. Socket.IO 이벤트

| 이벤트 | 방향 | 설명 |
|--------|------|------|
| `onvif:temperature` | Server → Client | BoxTemperatureReading 실시간 스트림. DB 미저장, ThermalOverlay 전용 |

Payload 구조:
```typescript
{
  cameraId: string;
  utcTime:  string;         // ISO 8601
  readings: ThermalReading[];  // 1개 이상
}
```

---

## 8. Sensor Coordinate Calibration (v1.2)

### 8.1 배경

BoxTemperatureReading의 `MaxTemperatureCoordinatesX/Y`, `MinTemperatureCoordinatesX/Y`는 **열상 센서 자체의 원본 해상도**(예: 160×120) 기준 픽셀 좌표다. 반면 카메라가 실제로 스트리밍하는 영상 해상도(`frameWidth`/`frameHeight`, 예: 640×480)는 이와 무관하게 별개로 결정된다. 두 해상도가 다른 카메라에서 §5.5의 예전 `toScreen()`(정규화 분모 = `frameWidth`/`frameHeight`)을 그대로 쓰면, crosshair가 영상 좌상단 160×120 픽셀 영역 안에만 몰려서 표시되는 문제가 발생한다.

### 8.2 Camera 스키마 확장

**파일:** `client/src/types/index.ts`, `server/src/api/cameras.js` (스키마리스 DB — `server/src/db/JsonDatabase.js`는 변경 불필요)

```typescript
interface Camera {
  // ...
  thermalSensorWidth?: number | null;
  thermalSensorHeight?: number | null;
}
```

`POST /api/cameras`, `PUT /api/cameras/:id` 둘 다 whitelist 방식 필드 추출(`req.body`에서 destructuring 후 `!== undefined` 체크)이므로 신규 필드는 두 핸들러 모두에 추가해야 반영된다.

### 8.3 Camera Edit UI

**파일:** `client/src/components/CameraEditModal.tsx`

RTSP/IP 카메라 폼(WebRTC 토글 아래)에 **Sensor Coordinate** Width/Height 숫자 입력란 2개를 추가한다. YouTube 폼에는 노출하지 않는다 (열상 calibration은 IP 카메라 전용 개념).

```typescript
const [thermalSensorWidth,  setThermalSensorWidth]  = useState(camera.thermalSensorWidth  ?? '');
const [thermalSensorHeight, setThermalSensorHeight] = useState(camera.thermalSensorHeight ?? '');
// 저장 시:
thermalSensorWidth:  thermalSensorWidth  === '' ? null : Number(thermalSensorWidth),
thermalSensorHeight: thermalSensorHeight === '' ? null : Number(thermalSensorHeight),
```

### 8.4 `toScreen()` 정규화 기준 분리

`ThermalOverlay`는 `sensorWidth`/`sensorHeight` prop을 새로 받는다 (`CameraView.tsx`가 `camera.thermalSensorWidth/Height`를 전달). 미설정 시 `frameWidth`/`frameHeight`로 폴백해 calibration 도입 이전과 동일하게 동작한다.

```typescript
const sensorW = sensorWidth  || fw;  // fw = frameWidth
const sensorH = sensorHeight || fh;  // fh = frameHeight

function toScreen(px, py, sensorW, sensorH, fw, fh, cw, ch) {
  if (!fw || !fh || !cw || !ch || !sensorW || !sensorH) return { sx: -9999, sy: -9999 };
  const { rw, rh, ox, oy } = getRenderArea(fw, fh, cw, ch);  // fw/fh — letterbox 종횡비 기준 불변
  const sx = Math.max(ox, Math.min(ox + rw, ox + (px / sensorW) * rw));  // sensorW — 정규화 기준
  const sy = Math.max(oy, Math.min(oy + rh, oy + (py / sensorH) * rh));  // sensorH — 정규화 기준
  return { sx, sy };
}
```

**핵심 원칙:** `getRenderArea()`의 종횡비 계산은 계속 `frameWidth`/`frameHeight`(letterbox는 실제 영상 크기 문제)를 쓰고, 원시 좌표 정규화만 `sensorWidth`/`sensorHeight`(센서 원본 해상도 문제)를 쓴다 — 두 해상도는 서로 다른 문제를 풀기 때문에 절대 같은 변수로 합치면 안 된다.

### 8.5 데이터 흐름 (calibration 반영판)

```
Camera Edit 모달 (Sensor Coordinate 입력)
  → PUT /api/cameras/:id { thermalSensorWidth, thermalSensorHeight }
  → db.update('cameras', id, updates)   (스키마리스 저장)
  → GET /api/cameras 응답에 포함 → cameraStore
  → CameraView.tsx: camera.thermalSensorWidth/Height
  → <ThermalOverlay sensorWidth=... sensorHeight=... frameWidth=... frameHeight=... />
  → toScreen(px, py, sensorW, sensorH, fw, fh, w, h)
```

서버 파서(`onvifParser.js`)와 `onvif:temperature` emit 로직은 변경되지 않는다 — calibration은 전적으로 클라이언트 렌더링 단계에서만 이뤄진다.

---

## 9. 설계 불변 조건 (Invariants)

1. `FullArea` 리딩(ItemID="Z" 또는 AreaName="FullArea")은 **절대 crosshair를 렌더링하지 않는다.**
2. `appRtpCallbackUrl`은 카메라 등록 시 항상 payload에 포함되어야 한다.
3. `coordSlots`는 `isFullArea()` 조건을 명시적으로 평가한 후 구성한다.
4. 온도 단위 판별은 값 > 200 Kelvin 기준 heuristic을 따른다.
5. 좌표 없는 리딩(maxTempX=null)은 crosshair 렌더링에서 제외된다.
6. `toScreen()`의 letterbox 종횡비 계산(`getRenderArea`)은 항상 `frameWidth`/`frameHeight`를 쓰고, 원시 좌표 정규화는 항상 `sensorWidth`/`sensorHeight`(미설정 시 `frameWidth`/`frameHeight` 폴백)를 쓴다 — 두 기준을 혼용하지 않는다.
7. Sensor Coordinate 미설정 카메라는 calibration 도입 이전과 동일하게 렌더링된다 (하위 호환).

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-23 | 초기 작성 — ThermalOverlay 설계 전체 기술 |
| 1.1 | 2026-06-23 | FullArea coordSlots 제외 규칙 명문화 (버그 수정 반영) |
| 1.2 | 2026-07-10 | §8 Sensor Coordinate Calibration 추가 — Camera.thermalSensorWidth/Height, CameraEditModal 입력 UI, toScreen() 정규화 기준(sensorWidth/Height) 분리 |
