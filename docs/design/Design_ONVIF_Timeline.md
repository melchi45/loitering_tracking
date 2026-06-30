# Design: ONVIF Event Timeline

**Version:** 2.7
**Status:** Implemented
**Related:** [Design_ONVIF_Metadata_Pipeline.md](Design_ONVIF_Metadata_Pipeline.md) · [Design_DataChannel_CameraEvents.md](Design_DataChannel_CameraEvents.md)

---

## 1. Overview

The ONVIF Event Timeline is a full-screen overlay UI that visualises ONVIF metadata events
stored in the `onvif_events` DB table on a scrollable, zoomable horizontal timeline.

Key capabilities:
- **Storage**: server-side state-change deduplication → only meaningful transitions stored
- **REST API**: `GET /api/onvif-events` with filtering; `DELETE /api/onvif-events`
- **Live feed**: Socket.IO `onvif:event` pushes new events to open timelines in real time
- **Overlay UI**: opens over `FullscreenCameraView` or `SearchFullscreen`
- **Zoom**: scroll-wheel or keyboard `↑` / `↓` (1× – 1000×)
- **Pan**: keyboard `←` / `→` or on-screen buttons; scrollbar indicator
- **Range presets**: `1H` · `6H` · `1D` · `1W` · `1M` · `1Y` (both in timeline header and `SearchFullscreen`; default `1H`)
- **Event detail**: click icon → structured ONVIF parsed data + Raw XML toggle
- **Client-side parser**: `DOMParser`-based, mirrors server `onvifParser.js`

---

## 2. Storage Layer

### 2.1 DB Table: `onvif_events`

| Field         | Type   | Description                                     |
|---------------|--------|-------------------------------------------------|
| `id`          | string | UUID v4                                         |
| `cameraId`    | string | Source camera ID                                |
| `topic`       | string | Full ONVIF topic URI                            |
| `topicType`   | string | Normalised type key (e.g. `motionAlarm`)        |
| `topicLabel`  | string | Human-readable label (e.g. `Motion Alarm`)      |
| `severity`    | string | `info` \| `warning` \| `critical`               |
| `utcTime`     | string | ISO timestamp from XML `UtcTime` attribute      |
| `operation`   | string | `PropertyOperation` value (e.g. `Changed`)      |
| `sourceToken` | string | Camera/sensor token from `SourceToken` SimpleItem |
| `state`       | string | `State` SimpleItem value (`true`/`false`)       |
| `items`       | string | JSON-stringified `Record<string, string>`       |
| `rawPayload`  | string | Base64-encoded original packet payload          |
| `serverTs`    | string | ISO timestamp of server receipt                 |
| `createdAt`   | string | Row creation time (added by `db.insert()`)      |

**Row cap**: 50,000 (oldest evicted when exceeded).

### 2.2 State-Change Deduplication

Samsung cameras emit periodic `State=false` heartbeats at ~33 pkt/s even when nothing is happening.
The server maintains a per-`cameraId:topic:sourceToken` `_lastStates` Map in `internalApi.js`.
Only transitions (`lastState !== parsed.state`) result in a `db.insert()` call.

```
33 pkt/s × 5 cameras × 86400 s/day = ~14M raw packets/day
→ with dedup: typically < 100 stored events/day
```

---

## 3. Server API

### 3.1 New Files

| File | Role |
|------|------|
| `server/src/services/onvifParser.js`  | Regex-based ONVIF XML parser, TOPIC_MAP |
| `server/src/routes/onvifApi.js`       | REST API router for `onvif_events` |

### 3.2 Modified Files

| File | Change |
|------|--------|
| `server/src/routes/internalApi.js` | Added ONVIF parse + state-dedup + `db.insert` + `onvif:event` emit; on `state=true` saves frame to `onvif_snapshots` via `pipelineManager.getLatestFrame()` |
| `server/src/db.js`                 | Added `onvif_events`, `onvif_snapshots` to `ALL_TABLES`, `TABLE_ROW_CAPS`, `JSON_FALLBACK_SKIP` |
| `server/src/index.js`              | Mounted `onvifEventsRouter`, `onvifTypesRouter`, `onvifSnapshotsRouter`; called `setOnvifDb(db)` |
| `server/src/services/pipelineManager.js` | Added `ctx._latestJpeg` (frame buffer updated on every frame); added `getLatestFrame(cameraId)` method |

### 3.3 REST Endpoints

| Method   | Path                       | Description |
|----------|----------------------------|-------------|
| `GET`    | `/api/onvif-events`        | Query events. Query params: `cameraId`, `type`, `severity`, `from` (ISO), `to` (ISO), `limit` (max 5000, default 500) |
| `DELETE` | `/api/onvif-events`        | Delete all events. Optional `cameraId` query param to scope deletion |
| `GET`    | `/api/onvif-event-types`   | Returns all ever-seen ONVIF event types (global registry). Response: `{ total, types[] }` |
| `DELETE` | `/api/onvif-event-types`   | Clears event type registry. Admin use only (available from Admin page). Response: `{ deleted }` |
| `GET`    | `/api/onvif-snapshots`     | Query frame snapshots captured at event start. Params: `eventId`, `cameraId`, `topicType`, `from`, `to`, `limit` (max 200). Response: `{ total, snapshots[] }`. `frameData` is `data:image/jpeg;base64,...` |

### 3.4 Event Type Registry (`onvif_event_types` table)

신규 ONVIF 이벤트 수신 시 `internalApi.js`가 `topicType`을 검사하고 처음 보는 타입이면 자동 등록합니다.

```javascript
// internalApi.js — triggered on every state-change event insert
const known = db.all('onvif_event_types');
if (!known.some(r => r.topicType === parsed.topicType)) {
  db.insert('onvif_event_types', { id: parsed.topicType, topicType, topicLabel, topic, severity, firstSeenAt });
  io.emit('onvif:type-registered', typeEntry);
}
```

**스키마:**

| Field        | Type   | Description                              |
|--------------|--------|------------------------------------------|
| `id`         | string | `topicType` 값 (자연 키)                 |
| `topicType`  | string | 정규화 타입 키 (예: `motionAlarm`)       |
| `topicLabel` | string | 사람이 읽을 수 있는 레이블               |
| `topic`      | string | 전체 ONVIF 토픽 URI                      |
| `severity`   | string | `info` \| `warning` \| `critical`        |
| `firstSeenAt`| string | 최초 이벤트 수신 시각 (ISO)              |

**특성:**
- 전역(global) — 카메라 종속 없음. 카메라 삭제 후에도 타입 유지
- Row cap 없음 (ONVIF 표준 토픽 종류 ~20개 이내)
- 관리자가 Admin 페이지 → "ONVIF Event Type Registry" 섹션에서 초기화 가능

Response shape (`GET`):
```json
{
  "total": 42,
  "events": [
    {
      "id": "...",
      "cameraId": "...",
      "topic": "tns1:VideoSource/tns1:MotionAlarm",
      "topicType": "motionAlarm",
      "topicLabel": "Motion Alarm",
      "severity": "warning",
      "utcTime": "2026-06-11T10:30:00.000Z",
      "operation": "Changed",
      "sourceToken": "VideoSourceToken",
      "state": "true",
      "items": { "SourceToken": "VideoSourceToken", "State": "true" },
      "rawXml": "<?xml version=\"1.0\"...>",
      "serverTs": "2026-06-11T10:30:00.123Z"
    }
  ]
}
```

### 3.5 Socket.IO Events

| Event                  | Direction        | Payload                 |
|------------------------|------------------|-------------------------|
| `onvif:event`          | Server → Client  | Full `OnvifEvent` object (same shape as REST row, includes decoded `rawXml`) |
| `onvif:type-registered`| Server → Client  | `OnvifEventType` object — 신규 topicType 최초 등록 시 브로드캐스트 |

---

## 4. Client Architecture

### 4.1 New Files

| File | Role |
|------|------|
| `client/src/stores/onvifEventStore.ts`           | Zustand store; events (`pushEvent`, `setEvents`, `clearAll`) + types (`setTypes`, `addType`, `clearTypes`) |
| `client/src/utils/onvifParser.ts`                | Browser `DOMParser`-based ONVIF XML parser |
| `client/src/components/OnvifTimelineOverlay.tsx` | Full-screen overlay (used from `SearchFullscreen`) |
| `client/src/components/OnvifTimelineInline.tsx`  | Compact inline timeline embedded in Camera Events tab |

### 4.2 Modified Files

| File | Change |
|------|--------|
| `client/src/components/FullscreenCameraView.tsx` | Added "ONVIF Timeline" tab (`videoTab='onvif'`); renders `OnvifTimelineInline` |
| `client/src/components/SearchFullscreen.tsx`     | Added "ONVIF Timeline" button in filter row; mounts `OnvifTimelineOverlay` |
| `client/src/pages/admin/AdminUsersPage.tsx`      | Admin Dashboard 재구성 — 좌측 사이드바 (👥 Users / 📡 ONVIF / 📋 Audit Log) + 섹션별 분리 |
| `client/src/i18n/translations/en.ts`            | Added 5 ONVIF timeline keys |
| `client/src/i18n/translations/ko.ts`            | Added 5 ONVIF timeline keys (Korean) |
| `client/src/i18n/translations/{ar,de,es,...}.ts`| Added 5 ONVIF timeline keys (English fallback) |

### 4.3 Zustand Store (`onvifEventStore.ts`)

```typescript
interface OnvifEventStore {
  // ── Events ──────────────────────────────────────────────────────────────────
  events: OnvifEvent[];
  pushEvent(evt: OnvifEvent): void;    // prepend; dedup by id; decode rawPayload/items
  setEvents(evts: OnvifEvent[]): void; // bulk-replace (REST fetch result)
  clearAll(): void;

  // ── Type Registry ────────────────────────────────────────────────────────────
  types: OnvifEventType[];
  setTypes(types: OnvifEventType[]): void; // bulk-replace (GET /api/onvif-event-types)
  addType(type: OnvifEventType): void;     // add single type from onvif:type-registered; dedup
  clearTypes(): void;                      // admin reset
}
```

Events cap: 10,000 in memory. Types: no cap (typically ≤20 types).

### 4.4 Client-Side XML Parser (`onvifParser.ts`)

Uses `DOMParser` (no external deps). Iterates `getElementsByTagName('*')` and matches
`localName` to avoid namespace prefix differences.

Returns `ParsedOnvifData | null`:
```typescript
interface ParsedOnvifData {
  topic: string; topicLabel: string; utcTime: string; operation: string;
  sourceToken: string | null; state: string | null;
  items: Record<string, string>;
}
```

---

## 5. Timeline Components

두 가지 컴포넌트가 동일한 Zustand 스토어를 공유합니다.

| 컴포넌트 | 진입점 | 특이사항 |
|---------|--------|---------|
| `OnvifTimelineInline` | `FullscreenCameraView` "ONVIF Timeline" 탭 | 컴팩트 인라인, 드래그 패닝, 우측 분할 상세 패널, 이벤트 타입 필터 |
| `OnvifTimelineOverlay` | `SearchFullscreen` 필터 행 버튼 | 전체화면 오버레이, 키보드 줌/팬 |

### 5.1 State Model (공통)

| State     | Type             | Description |
|-----------|------------------|-------------|
| `range`   | `'1H'\|'6H'\|'1D'…'1Y'` | 선택된 범위 프리셋 (기본: `'1H'`) |
| `zoom`    | number           | 1 = 전체 범위; >1 = 확대 (max 500×) |
| `pan`     | number           | 0..1 오프셋 (0=현재, 1=rangeMs 이전) |
| `selected`| `OnvifInterval \| null` | 상세 패널에 표시 중인 인터벌 |
| `nowMs`   | number           | 5초마다 갱신 — in-progress 인터벌 duration 실시간 표시용 |

### 5.2 Viewport Computation

```
viewSpan  = rangeMs / zoom
viewEnd   = now − pan × rangeMs
viewStart = viewEnd − viewSpan

itemX = (eventTs − viewStart) / viewSpan   // [0..1]
```

pan 범위: `[0, max(0, 1 − 1/zoom)]` — viewEnd가 now를 초과하지 않도록 클램프.

### 5.3 Zoom / Pan Controls

#### OnvifTimelineInline (인라인 패널)

| 입력 | 동작 |
|------|------|
| **[+] 버튼** (컨트롤 바) | **Zoom in ×1.4 — `applyZoom(1.4)` 호출** |
| **[−] 버튼** (컨트롤 바) | **Zoom out ÷1.4 — `applyZoom(1/1.4)` 호출; zoom≤1일 때 disabled** |
| 스크롤 휠 ↑ | Zoom in ×1.4 (동일 함수 호출) |
| 스크롤 휠 ↓ | Zoom out ÷1.4 (동일 함수 호출) |
| **마우스 드래그 ←** | **pan 감소 → viewEnd가 now에 가까워짐 → 최신 이벤트 노출** |
| **마우스 드래그 →** | **pan 증가 → viewEnd가 과거로 이동 → 과거 이벤트 노출** |
| ◀ ▶ 버튼 (zoom>1) | ±0.1/zoom 패닝 |
| ✕ 버튼 | zoom=1, pan=0 리셋 |

**컨트롤 바 레이아웃 (버튼 추가 후):**

```
[1H][6H][1D][1W][1M][1Y][Custom]  [Event Type ▾]  ←spacer→  [×N.N]  [+][−]  [↺]  V/T
                                                              (zoom>1)  ↑  ↑
                                                                     zoom in  zoom out
```

- `[+]` 버튼: `applyZoom(1.4)`, 항상 활성
- `[−]` 버튼: `applyZoom(1/1.4)`, `disabled={zoom <= 1}` + `opacity-30 cursor-not-allowed`
- 두 버튼 모두 `title` 속성으로 툴팁 제공 ("Zoom in" / "Zoom out")
- zoom step `1.4`는 휠 zoom step과 동일 → 두 입력 방식이 동등한 UX 제공

**드래그 패닝 수식:**
```
newPan = startPan + (currentX − startX) / containerWidth / zoom
```
- `startX`, `startPan`: mousedown 시점 기록 (`DragState` ref)
- 임계값 `DRAG_THRESHOLD_PX = 4px` 초과 시 드래그로 인식
- `hasDraggedRef`: 드래그 여부 추적 — true이면 mouseup 시 이벤트 아이콘 클릭 이벤트 무시
- 커서: 정상 = `cursor-grab`, 드래그 중 = `cursor-grabbing`

#### OnvifTimelineOverlay (전체화면)

| 입력 | 동작 |
|------|------|
| 스크롤 휠 ↑ | Zoom in ×1.3 |
| 스크롤 휠 ↓ | Zoom out ÷1.3 |
| 키보드 `↑` | Zoom in ×1.5 |
| 키보드 `↓` | Zoom out ÷1.5 |
| 키보드 `←` | Pan older (−0.1/zoom) |
| 키보드 `→` | Pan newer (+0.1/zoom) |
| "← Older" / "Newer →" 버튼 | ±0.15/zoom 패닝 |
| Reset 버튼 | zoom=1, pan=0 |
| Escape | 오버레이 닫기 |

### 5.3b Custom Date Range (OnvifTimelineInline)

`OnvifTimelineInline`에 `Custom` 버튼이 추가되었습니다.

```
[1D][1W][1M][1Y][Custom]  [Event Type ▾]    ⟳  5/12
─────────────────────────────────────── (Custom 선택 시 아래 행 추가)
From [datetime-local] To [datetime-local] [Apply] [✕]
```

| 상태 | 설명 |
|------|------|
| `range: 'custom'` | `RangeLabel` 타입에 추가된 값 |
| `customStart` | `datetime-local` 입력값 (ISO 문자열) |
| `customEnd` | `datetime-local` 입력값 (ISO 문자열) |
| `customApplied` | Apply 버튼 클릭 시 확정된 `{ from, to }` ISO 쌍 |

**동작 흐름:**
1. `[Custom]` 버튼 클릭 → `range = 'custom'`, 날짜 입력 행 표시
2. From / To 날짜 입력 → Apply 클릭 → `customApplied` 확정
3. fetch effect 재실행: `GET /api/onvif-events?cameraId=…&from=…&to=…&limit=1000`
4. Apply 전까지 fetch 중단 (`if (range === 'custom' && !customApplied) return`)
5. `✕` 버튼 → `customApplied = null`, 입력 초기화

**Viewport 계산 (custom 모드):**

```
rangeMs       = customApplied.to - customApplied.from
viewRangeEnd  = new Date(customApplied.to).getTime()  // 프리셋 모드는 Date.now()
viewEnd       = viewRangeEnd - pan × rangeMs
viewStart     = viewEnd - viewSpan
```

**로딩 표시**: `…` 텍스트 → SVG 스피너(`animate-spin text-blue-400`)로 교체

### 5.4 Event Detail Panel

이벤트 아이콘 클릭 시:
- **Inline**: 타임라인 캔버스 오른쪽에 고정 폭(192px) 분할 패널 — 항상 표시, 이벤트 미선택 시 플레이스홀더 ("이벤트를 선택하면 상세 정보가 표시됩니다")
- **Overlay**: 아이콘 위에 절대 위치 팝업 (Parsed 뷰 / Raw XML 전환 토글)

두 컴포넌트 모두 `parseOnvifXml(event.rawXml)` 로 구조화 데이터 렌더링.

#### OnvifTimelineInline 분할 레이아웃

이벤트 미선택 시 타임라인이 전체 너비를 사용합니다. 이벤트 아이콘 클릭 시에만 우측 상세 패널이 열립니다.

```
[미선택 상태 — 타임라인 전체 너비]
┌──────────────────────────────────────────────────────────────┐
│ [1D][1W][1M][1Y]  [Event Type ▾]         ×2.0   5/12        │
├──────────────────────────────────────────────────────────────┤
│  timeline canvas (full width)                                │
├──────────────────────────────────────────────────────────────┤
│  ◀ ━━━━━━━━━ ▶  ✕     (zoom > 1 only)                       │
└──────────────────────────────────────────────────────────────┘

[이벤트 선택 시 — 우측 패널 출현]
┌──────────────────────────────────────────────────────────────┐
│ [1D][1W][1M][1Y]  [Event Type ▾]         ×2.0   5/12        │
├───────────────────────────────────┬──────────────────────────┤
│  timeline canvas (flex-1)         │  event detail (192px)    │
│                                   │  · Parsed / Raw XML tab  │
│                                   │  · ✕ 버튼으로 닫기       │
├───────────────────────────────────┴──────────────────────────┤
│  ◀ ━━━━━━━━━ ▶  ✕     (zoom > 1 only)                       │
└──────────────────────────────────────────────────────────────┘
```

### 5.5 Event Type Filter (OnvifTimelineInline)

상단 컨트롤 행의 `[Event Type ▾]` 드롭다운:

- **기본값**: `All Types` (빈 문자열 — 필터 없음)
- **옵션 목록**: 로드된 이벤트의 `topicType` 값에서 동적으로 생성 (`useMemo`)
- **필터링 범위**: 현재 viewport 내 이벤트에만 적용 (타임라인 캔버스 + 카운트 표시)
- **상태 초기화**: 타입 변경 시 `selected` 이벤트 초기화

```typescript
const typeOptions = useMemo(() => {
  const seen = new Map<string, string>(); // topicType → topicLabel
  events.forEach(e => { if (!seen.has(e.topicType)) seen.set(e.topicType, e.topicLabel); });
  return Array.from(seen.entries()).map(([type, label]) => ({ type, label }));
}, [events]);
```

### 5.6 Severity Colours & Icons

| Severity | Colour | Example Icons |
|----------|--------|---------------|
| `info`   | Blue   | 📞 callRequest, ⬜ fieldExited |
| `warning`| Yellow | 🚶 motionAlarm, 🚧 lineCrossed, ⬛ fieldEntered |
| `critical`| Red  | 🔥 fire, 💨 smoke |

### 5.8 Event Type Filter (OnvifTimelineOverlay)

헤더 Range selector 옆의 `<select>` 드롭다운 — `OnvifTimelineInline`과 동일한 필터 UX를 전체화면 오버레이에 제공합니다.

- **기본값**: `All Types` (빈 문자열 — 필터 없음)
- **옵션 목록**: `onvifEventStore.types` (전역 레지스트리) — 현재 범위에 없는 타입도 표시
- **로드 방식**: 마운트 시 `GET /api/onvif-event-types` fetch → `setTypes()`; `onvif:type-registered` 소켓 구독 → `addType()`
- **필터링 범위**: `items` useMemo 내 `topicType` 비교 — viewport 내 이벤트에만 적용

```typescript
// useOnvifEvents hook (OnvifTimelineOverlay)
useEffect(() => {  // mount-once: 전역 타입 레지스트리 로드
  fetch('/api/onvif-event-types')
    .then(r => r.json())
    .then(data => { if (Array.isArray(data.types)) setTypes(data.types); });
}, [setTypes]);

useEffect(() => {  // 실시간: 신규 타입 감지 시 자동 추가
  socket.on('onvif:type-registered', addType);
  return () => socket.off('onvif:type-registered', addType);
}, [socket, addType]);
```

**OnvifTimelineInline과의 차이점:**

| 항목 | OnvifTimelineInline | OnvifTimelineOverlay |
|------|--------------------|--------------------|
| 타입 옵션 소스 | `onvifEventStore.types` (전역 레지스트리) | `onvifEventStore.types` (전역 레지스트리) |
| 소켓 구독 | `onvif:type-registered` → `addType` | `onvif:type-registered` → `addType` |
| 타입 변경 시 | `selected` 이벤트 초기화 | 자동 필터링만 (상세 팝업 위치 유지) |
| UI 위치 | 상단 컨트롤 행 | 헤더 Range selector 우측 |

---

### 5.7 Range Selector

`[1D][1W][1M][1Y]` 버튼이 표시되는 위치:
- `OnvifTimelineInline` 상단 행
- `OnvifTimelineOverlay` 헤더
- `SearchFullscreen` 필터 행 (오버레이 열기 버튼 옆)

---

### 5.9 Gantt 인터벌 렌더링

#### OnvifInterval 타입

```typescript
interface OnvifInterval {
  id: string;            // = startEvt.id
  cameraId: string;
  topicType: string;
  topicLabel: string;
  severity: OnvifSeverity;
  sourceToken: string | null;
  startTs: number;       // ms
  endTs: number;         // ms (= nowMs if inProgress)
  isPoint: boolean;      // true = no-state event → diamond marker
  inProgress: boolean;   // true = state=true without matching false
  durationMs: number;
  startEvt: OnvifEvent;
  endEvt: OnvifEvent | null;
}
```

#### buildIntervals() 알고리즘

```
sorted events (by serverTs ASC)
for each event:
  key = cameraId:topicType:sourceToken:ruleName   // ruleName 포함으로 Rule별 독립 스트림
  state='true':
    if Map[key] already open  → skip (coalesce: 원본 startTs 유지)
    else                      → Map[key] = new interval (inProgress=true, endTs=nowMs)
  state='false':
    if Map[key] open → close, push to result
    else             → orphaned end → point marker
  no state           → push point marker
flush Map → remaining open intervals (inProgress=true)
```

**Coalesce 처리 (start→start→start→end):**
서버 재시작 후 `_lastStates` Map이 초기화되면, 카메라 heartbeat로 인해 `state='true'`가 연속 저장될 수 있습니다. 클라이언트는 이를 **단일 인터벌**로 합산합니다 — 첫 번째 `state='true'`의 `startTs`를 유지하고 중간 start 이벤트는 무시합니다.

```
DB 이벤트:  true(t1) → true(t2) → true(t3) → false(t4)
렌더 결과:  ───────────[         인터벌         ]───── (t1 ~ t4)
```

#### 행(Row) 레이아웃 — DetectionsTimelineInline 동일 스타일

각 행은 Gantt 바(상단)와 프레임 썸네일 스트립(하단) 두 영역으로 구성됩니다.

```
┌──────────────────────────────────────────────────────────────┐
│  [████ motionAlarm 15s ████████████]  ← Gantt bar (BAR_H)   │ BAR_TOP px 아래
│      [📷]                             ← frame snap 썸네일    │ SNAP_TOP px 아래
└──────────────────────────────────────────────────────────────┘
```

| 상수 | Inline | Overlay | 설명 |
|------|--------|---------|------|
| `ROW_H`   | 52px  | 68px  | 전체 행 높이 |
| `BAR_H`   | 16px  | 22px  | Gantt 바 높이 |
| `BAR_TOP` | 4px   | 6px   | 바 상단 여백 |
| `SNAP_H`  | 30px  | 36px  | 썸네일 높이 |
| `SNAP_W`  | 44px  | 56px  | 썸네일 너비 |
| `SNAP_TOP`| BAR_TOP+BAR_H+2 | BAR_TOP+BAR_H+4 | 썸네일 상단 위치 |

- 각 `topicType:sourceToken:ruleName` 3-튜플 → 별도 행 (RuleName이 다르면 무조건 분리)
- 행 레이블 = `topicLabel (sourceToken) [ruleName]` (있는 것만 조합)

#### 2-Panel Layout — `OnvifTimelineInline` (v2.7 신규)

`OnvifTimelineInline`은 단일 absolute-positioned 캔버스에서 3단 `flex-col` 구조로 전환됩니다:

```
┌──────────────────────────────────────────────────────────────────┐
│  Controls (range / event type filter / refresh)                  │
├──────────┬───────────────────────────────────────────────────────┤
│ All      │ [mini bars: all event types overlaid]    scroll=zoom  │ ← OVERVIEW (50px)
│ Events ▲ │ point event: 2px bar / duration: 8px bar             │   click=showDetail toggle
├──────────┼───────────────────────────────────────────────────────┤
│ Name     │                               (sticky header, 22px)  │ ← when expanded
│ Motion   │ ████████████████████                                  │ ← detail rows
│ DigInput │ ██████                                                │   scroll=vertical only
├──────────┴───────────────────────────────────────────────────────┤
│          │ 08:00    09:00    10:00    11:00                       │ ← tick labels (항상 표시)
└──────────┴───────────────────────────────────────────────────────┘
```

| 영역 | 높이 | 인터랙션 |
|------|------|---------|
| Overview strip | `OVERVIEW_H=50px` | 스크롤 휠 = 줌; 마우스 다운 = 드래그 패닝; 클릭 = `showDetail` 토글 |
| Detail rows | `flex-1 min-h-0 overflow-y-auto` (`showDetail=true`일 때만) | 수직 스크롤 (줌 없음) |
| Tick labels | `TICK_H=20px`, `flex-shrink-0` | 항상 표시 (행 접혀도 유지) |

Overview 미니 바:
- **duration 이벤트**: `MINI_BAR_H=8px`, severity 색상, `opacity: 0.65` (inProgress=`0.45`), `borderRadius: 2`
- **point 이벤트**: 너비 2px, 높이 `MINI_BAR_H * 1.5 = 12px`, `opacity: 0.75`, `borderRadius: 1`

`showDetail` 토글 동작:
- `showDetail=false` 시: Detail rows(`flex-1` 블록) 및 Detail panel(`selected && showDetail`) DOM에서 제거
- `showDetail=true`로 전환 시: Detail rows 복원, 이전 `selected` 상태는 초기화

#### Name 컬럼 — `OnvifTimelineInline` (인라인 탭, v2.6 신규) 및 `OnvifTimelineOverlay` (v2.4 신규)

두 컴포넌트 모두 동일한 `LABEL_W = 130px` Name 컬럼을 사용합니다.

```
┌──────────────────────────────────────────────────────────┐
│  [Name]      │ ← sticky 헤더 행 (22px, z-10)            │
│──────────────┼──────────────────────────────────────────│
│  Motion Alarm│ ████████████████████ [bar]  [bar]        │ ROW_H
│  VS-1        │                                          │
│  [Zone1]     │                                          │
│──────────────┼──────────────────────────────────────────│
│  DigitalInput│ ████████ [bar]                           │
│  Index:0     │                                          │
└──────────────┴──────────────────────────────────────────┘
     ↑ LABEL_W=130px             ↑ flex-1 (Gantt 영역)
```

| 요소 | 위치 | 내용 |
|------|------|------|
| "Name" 헤더 | sticky top-0, z-10, height 22px | 회색 uppercase "Name" 레이블 |
| 행 레이블 열 | `LABEL_W=130px`, flex-shrink-0 | topicLabel (severity 색상, bold) + sourceToken (gray, 있을 때) + [ruleName] (indigo, 있을 때) |
| 헤더 카메라 뱃지 | 상단 헤더 바 (`OnvifTimelineOverlay` 전용) | `cameraName` (useCameraStore 조회) 우선; 없으면 `cameraId.slice(0,8)` |

**`OnvifRow` 인터페이스 변경 (`OnvifTimelineInline`):**
```typescript
interface OnvifRow {
  key:         string;
  topicLabel:  string;
  sourceToken: string | null;  // v2.6 신규 — 별도 저장
  ruleName:    string | null;  // v2.6 신규 — 별도 저장
  severity:    OnvifSeverity;
  intervals:   OnvifInterval[];
}
```
이전에는 `topicLabel`에 `topicLabel (sourceToken) [ruleName]` 형태로 합산 저장하였으나, Name 컬럼 분리 표시를 위해 각 필드를 독립 저장하도록 변경.

**드래그 패닝·틱 오프셋 보정 (`OnvifTimelineInline`):**
- 드래그 너비: `containerRef.getBoundingClientRect().width - LABEL_W`
- tick strip: `style={{ left: LABEL_W, right: 0, height: TICK_H }}`

#### 바 렌더링

```
barLeft  = max(0, (startTs − viewStart) / viewSpan)   // [0, 1]
barRight = min(1, (endTs − viewStart) / viewSpan)      // [0, 1]
barWidth = max(0.003, barRight − barLeft)               // min 0.3% (visibility)
```

- **완료 인터벌**: `SEV_COLOR[severity]cc` 배경 + `1px solid` 테두리; 바 내부에 `topicLabel + duration` 라벨
- **진행 중 인터벌** (`inProgress=true`): `SEV_COLOR[severity]88` 반투명 + `1px dashed` 테두리; 라벨에 `↦` 프리픽스
- **포인트 이벤트** (`isPoint=true`): 45° 회전한 다이아몬드(◇), `SEV_COLOR` 채색

#### `getEventState()` — 클라이언트 state 결정 함수

`buildIntervals`는 `evt.state`를 직접 사용하지 않고 `getEventState(evt)`를 통해 state를 결정합니다.

```
getEventState 우선순위:
  1. evt.state ('true'|'false') — 서버 파서가 정상 추출한 경우
  2. evt.items 폴백 — 구버전 파서로 저장된 이벤트(state=null)에서 items.State 등 추출
     (STATE_KEYS: State, IsMotion, IsSoundDetected, IsAlarm, IsActive, Active, Enabled, ...)
  3. 마지막 수단: token/source를 제외한 첫 번째 boolean 값 항목
  → 모두 없으면 null → 포인트 마커
```

**이 패턴이 필요한 이유**: 서버 파서 업그레이드 이전에 저장된 이벤트는 DB에 `state: null`이지만,
`items` 필드에 `State: 'true'`/'false'`가 정상 저장되어 있습니다. DB 마이그레이션 없이 기존 이벤트도
바(bar)로 표시됩니다.

#### 스냅샷 연동 (인라인 필름스트립)

**저장 (서버):**
- `state=true` 이벤트 저장 시 `pipelineManager.getLatestFrame(cameraId)` → `onvif_snapshots` 테이블에 JPEG 저장

**렌더링 (클라이언트):**
- `snapCache: Map<string, string>` — intervalId → frameData URL (또는 빈 문자열)
- `fetchedRef: Set<string>` — 중복 fetch 방지
- 뷰포트 내 보이는 인터벌이 변경될 때마다 `useEffect`에서 `GET /api/onvif-snapshots?eventId=<id>&limit=1` 지연 로딩
- 캐시된 `frameData`가 있으면 Gantt 바 아래 `startTs` x좌표 위치에 썸네일 `<img>` 렌더링
- **상세 패널**: `snapCache.get(selected.id)`로 선택된 인터벌의 원본 크기 이미지 표시 (별도 fetch 불필요)

---

## 6. i18n Keys

| Key | en | ko |
|-----|----|----|
| `onvifTimelineOpen`  | `ONVIF Timeline`           | `ONVIF 타임라인` |
| `onvifTimelineTitle` | `ONVIF Event Timeline`     | `ONVIF 이벤트 타임라인` |
| `onvifTimelineEmpty` | `No ONVIF events in this range` | `이 범위에 ONVIF 이벤트가 없습니다` |
| `onvifTimelineHint`  | `↑↓ Zoom  ←→ Pan`         | `↑↓ 확대/축소  ←→ 이동` |
| `onvifTimelineCount`      | `` `${n} events visible / ${t} total` `` | `` `${n}개 이벤트 표시 / 전체 ${t}개` `` |
| `onvifTimelineSelectHint` | `Select an event to view details`      | `이벤트를 선택하면 상세 정보가 표시됩니다` |

All other languages use English fallback values.

---

## 7. Data Flow

```
ingest-daemon
  └─ POST /api/internal/apprtp/:cameraId
       └─ internalApi.js
            ├─ parseOnvifPayload()                  ← onvifParser.js → ParsedOnvifEvent[]
            └─ for (const parsed of parsedList)     ← 패킷 내 NotificationMessage 1개 이상
                 ├─ state-change dedup              ← _lastStates Map (per cameraId:topic:sourceToken)
                 ├─ db.insert('onvif_events', event)
                 ├─ if first time topicType:
                 │    db.insert('onvif_event_types', ...)
                 │    io.emit('onvif:type-registered', typeEntry)
                 │         └─ OnvifTimelineInline / OnvifTimelineOverlay: addType()
                 └─ io.emit('onvif:event', evt)
                      └─ OnvifTimelineInline / OnvifTimelineOverlay: pushEvent()

Client on mount (OnvifTimelineInline 또는 OnvifTimelineOverlay):
  GET /api/onvif-event-types                → onvifEventStore.setTypes()  [type filter combobox]
  GET /api/onvif-events?from=…&limit=2000  → onvifEventStore.setEvents() [timeline canvas]

Admin: DELETE /api/onvif-event-types → registry cleared; types re-registered as events arrive

User action:
  click icon → EventDetailPanel (right split, 192px)
    └─ parseOnvifXml(evt.rawXml) → structured display
    └─ "Show Raw XML" button → <pre> rawXml
  select type filter → filters timeline icons by topicType
```

---

## 8. 카메라 연결 해제 시 미결 이벤트 자동 종료

### 8.1 문제 상황

카메라가 비정상 종료되거나 명시적으로 제거될 때, 해당 카메라에서 `state=true` ONVIF 이벤트가 열린 채로 남아 있는 경우가 발생합니다. 클라이언트 측 `buildIntervals()`는 대응하는 `state=false` 이벤트가 없으면 `inProgress=true`(점선 막대)로 표시하므로, 이 이벤트는 영구적으로 "진행 중"으로 표시됩니다.

### 8.2 처리 흐름

```
pipelineManager.stopCamera(cameraId)
  │
  ├─ _onCameraOfflineHook(cameraId)          ← index.js에서 등록
  │    │
  │    └─ closeOpenEventsForCamera(cameraId)  ← internalApi.js 내부 함수
  │         │
  │         ├─ db.all('onvif_events')         ← 해당 카메라 전체 이벤트
  │         │    └─ group by (topicType, sourceToken, ruleName)
  │         │         └─ 그룹별 최신 이벤트 중 state='true'인 것만
  │         │
  │         ├─ for each open event:
  │         │    ├─ db.insert('onvif_events', { ...closeEvent, state:'false', disconnectClose:true })
  │         │    └─ io.emit('onvif:event', closeEvent)
  │         │
  │         └─ _lastStates 초기화 (해당 cameraId 키 전체 삭제)
  │
  ├─ ctx.running = false
  ├─ capture.stop()
  └─ _updateCameraStatus(cameraId, 'offline')
```

### 8.3 합성 종료 이벤트 스키마

| 필드 | 값 | 설명 |
|---|---|---|
| `id` | UUID v4 | 새로 생성 |
| `state` | `'false'` | 종료 상태 |
| `operation` | `'Changed'` | ONVIF 표준 값 |
| `utcTime` / `serverTs` | `new Date().toISOString()` | 카메라 중지 시각 |
| `disconnectClose` | `true` | 합성 이벤트 식별자 (실제 카메라 전송과 구별) |
| `items` / `rawPayload` | `null` | 합성이므로 원본 없음 |
| 나머지 필드 | 원본 미결 이벤트에서 복사 | `topic`, `topicType`, `topicLabel`, `severity`, `sourceToken`, `ruleName` |

### 8.4 클라이언트 영향

클라이언트의 `buildIntervals()`는 변경 없이 동작합니다.
- 실시간: `onvif:event` 소켓 이벤트 수신 → `pushEvent()` → `buildIntervals()` 재실행 → 막대 종료
- 페이지 새로고침: `GET /api/onvif-events`에서 합성 종료 이벤트 포함 반환 → 정상 Gantt 막대 표시

### 8.5 dedup 상태 초기화 목적

`_lastStates`에서 해당 카메라 항목을 삭제하면 재연결 시 첫 수신 이벤트부터 저장됩니다.
삭제하지 않을 경우, 재연결 후 카메라가 동일 `state`를 재전송하면 dedup에 의해 무시됩니다.

### 8.6 훅 등록 위치 (순환 의존성 회피)

`pipelineManager.js`는 `internalApi.js`를 직접 `require()`하면 순환 의존이 발생합니다.
(`internalApi.js` → `pipelineManager` 참조, `pipelineManager.js` → `internalApi` 참조)

해결책: `index.js`가 양쪽 모듈을 모두 알고 있으므로, 훅 등록을 `index.js`에서 수행합니다:

```javascript
// server/src/index.js
const { closeOpenEventsForCamera } = require('./routes/internalApi');
pipelineManager.setOnCameraOfflineHook(closeOpenEventsForCamera);
```

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-06-16 | 초기 작성 — ONVIF 이벤트 저장, REST API, 타임라인 오버레이 UI 전체 설계 |
| 1.1 | 2026-06-16 | OnvifTimelineInline 추가 (인라인 탭), 마우스 드래그 패닝 수식 문서화, FullscreenCameraView 탭 구조 업데이트 |
| 1.2 | 2026-06-16 | OnvifTimelineInline 우측 분할 상세 패널 추가 (이벤트 선택 시에만 표시, 192px), Event Type 필터 콤보박스, 기본 탭 ONVIF Timeline 으로 변경 |
| 1.3 | 2026-06-16 | ONVIF 이벤트 타입 전역 레지스트리 추가 (`onvif_event_types` DB 테이블, GET/DELETE /api/onvif-event-types, `onvif:type-registered` 소켓 이벤트, Admin Dashboard ONVIF 섹션) |
| 1.4 | 2026-06-16 | OnvifTimelineInline Custom 날짜 범위 기능 추가 (Custom 버튼, datetime-local 입력, Apply, viewRangeEnd), SVG 로딩 스피너 교체 |
| 1.5 | 2026-06-22 | OnvifTimelineOverlay Type 필터 추가 (§5.8) — 마운트 시 `/api/onvif-event-types` fetch + `onvif:type-registered` 소켓 구독 → `onvifEventStore.types` 기반 드롭다운 |
| 1.6 | 2026-06-22 | Gantt 인터벌 바 렌더링 추가 (§5.9) — state=true/false 쌍으로 수평 막대, 진행 중 대시 바, 포인트 이벤트 다이아몬드; ONVIF 스냅샷 저장 (`onvif_snapshots` DB + `/api/onvif-snapshots`); `pipelineManager.getLatestFrame()` 추가 |
| 1.7 | 2026-06-22 | buildIntervals() coalesce 수정 — start→start→…→end 시퀀스를 단일 인터벌로 합산 (서버 재시작 artifact 처리) |
| 1.8 | 2026-06-22 | §5.9 행 레이아웃 DetectionsTimelineInline 스타일 통합 — ROW_H 확장(Inline 52px/Overlay 68px), 인라인 필름스트립 스냅샷(snapCache + lazy-fetch), SEV_COLOR 인라인 스타일 바 |
| 1.9 | 2026-06-23 | §5.9 getEventState() 함수 추가 — evt.state=null인 구버전 이벤트도 items 폴백으로 bar 렌더링; DB 마이그레이션 불필요 |
| 2.0 | 2026-06-23 | §7 데이터 플로우 업데이트 — parseOnvifPayload() 배열 반환 반영; 패킷 내 다중 NotificationMessage 각각 독립 dedup·저장·브로드캐스트 |
| 2.1 | 2026-06-24 | 범위 프리셋 `1H` · `6H` 추가 — ONVIF 이벤트 기본 범위를 1D → 1H로 단축; §5.1 range state 타입 업데이트 |
| 2.2 | 2026-06-24 | RuleName 기반 타임라인 행 분리 — buildIntervals/buildRows 키에 ruleName 포함; 행 레이블 `[RuleName]` 표시; detail panel RuleName 항목 추가; `OnvifEvent.ruleName` 필드 추가 |
| 2.3 | 2026-06-25 | `onvif_snapshots` MongoDB 모드 서버 재시작 후 사라짐 버그 수정 — `snapshotsRouter.get()` 을 async 전환 후 `db.queryAsync('onvif_snapshots', …)` 사용. `onvif_snapshots` 는 frameData 블롭 때문에 시작 시 인메모리 hydration 제외 → `BaseDatabase.queryAsync()` / `MongoDatabase.queryAsync()` / `mongoDbService.findDirect()` 추가로 MongoDB 직접 조회 경로 구현. `mongoDbService.TABLES`에 누락됐던 `faceTrajectories`, `tc_results` 도 추가. |
| 2.4 | 2026-06-26 | §5.9 Name 컬럼 추가 — `OnvifTimelineOverlay`에 sticky "Name" 헤더 행(22px) 및 행 레이블 열 문서화; 헤더 카메라 뱃지 `cameraName` 우선 표시 (`useCameraStore`); `DetectionsTimelineInline` `LABEL_W=100px` Name 컬럼 신규 추가 문서화 |
| 2.5 | 2026-06-26 | §8 카메라 연결 해제 시 미결 이벤트 자동 종료 설계 추가 — `closeOpenEventsForCamera()` 처리 흐름·합성 이벤트 스키마·dedup 초기화·훅 등록 패턴(순환 의존 회피) 문서화 |
| 2.6 | 2026-06-26 | §5.9 Name 컬럼 `OnvifTimelineInline` 누락 보완 — `LABEL_W=130px`, `OnvifRow.sourceToken/ruleName` 독립 저장, sticky 헤더, 드래그 너비 보정, tick 오프셋; `OnvifTimelineOverlay`와 동일 레이아웃 |
| 2.7 | 2026-06-26 | §5.9 `OnvifTimelineInline` 2-Panel Layout 추가 — 3단 flex-col 구조(Overview strip 50px + Detail rows + Tick labels 항상 표시); `showDetail` 상태; Overview 미니 바(point 2px/duration 8px); scroll isolation; Detail panel `showDetail && selected` 조건 |
| 2.8 | 2026-06-30 | §5.3 `OnvifTimelineInline` 줌 버튼 추가 — `[+]`/`[−]` 버튼을 Refresh 버튼 왼쪽에 배치; `applyZoom(1.4)` / `applyZoom(1/1.4)` 호출; `−` 버튼 zoom≤1 시 disabled; 컨트롤 바 레이아웃 다이어그램 갱신 |
