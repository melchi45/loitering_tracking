# Design: ONVIF Event Timeline

**Version:** 1.7
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
- **Range presets**: `1D` · `1W` · `1M` · `1Y` (both in timeline header and `SearchFullscreen`)
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
| `range`   | `'1D'…'1Y'`      | 선택된 범위 프리셋 |
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
| 스크롤 휠 ↑ | Zoom in ×1.4 |
| 스크롤 휠 ↓ | Zoom out ÷1.4 |
| **마우스 드래그 ←** | **pan 감소 → viewEnd가 now에 가까워짐 → 최신 이벤트 노출** |
| **마우스 드래그 →** | **pan 증가 → viewEnd가 과거로 이동 → 과거 이벤트 노출** |
| ◀ ▶ 버튼 (zoom>1) | ±0.1/zoom 패닝 |
| ✕ 버튼 | zoom=1, pan=0 리셋 |

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
  key = cameraId:topicType:sourceToken
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

#### 행(Row) 구조

- 각 `topicType:sourceToken` 조합 → 별도 행
- 행 레이블 = `topicLabel (sourceToken)` (없으면 `topicLabel`만)
- Inline: ROW_H=28px, BAR_H=16px
- Overlay: ROW_H=44px, BAR_H=24px

#### 바 렌더링

```
barLeft  = max(0, (startTs − viewStart) / viewSpan)   // [0, 1]
barRight = min(1, (endTs − viewStart) / viewSpan)      // [0, 1]
barWidth = max(0.003, barRight − barLeft)               // min 0.3% (visibility)
```

- **완료 인터벌**: 단색 바 (`SEV_BAR[severity]`)
- **진행 중 인터벌** (`inProgress=true`): `borderRight: 3px dashed` 로 개방 표시; 라벨에 `↦` 프리픽스
- **포인트 이벤트** (`isPoint=true`): 45° 회전한 다이아몬드(◇)

#### 스냅샷 연동

- `state=true` 이벤트 저장 시 `pipelineManager.getLatestFrame(cameraId)` → `onvif_snapshots` 테이블에 JPEG 저장
- 인터벌 선택 시 클라이언트가 `GET /api/onvif-snapshots?eventId=<id>&limit=1` 요청
- 상세 패널 하단에 인라인 이미지 표시

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
            ├─ parseOnvifPayload()                  ← onvifParser.js
            ├─ state-change dedup                   ← _lastStates Map
            ├─ db.insert('onvif_events', event)
            ├─ [NEW] if first time topicType:
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
