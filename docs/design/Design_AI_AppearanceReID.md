# DESIGN DOCUMENT
# AI Module — Appearance-Based Re-Identification (Clothing Re-ID)

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-APPREID-01 |
| **Version** | 1.1 |
| **Status** | Active |
| **Date** | 2026-06-10 |
| **Parent SRS** | srs/SRS_CrossCamera_Face_Tracking.md |
| **Related** | design/Design_AI_ReID.md |

---

## 변경 이력 (History)

| 버전 | 날짜 | 작성자 | 변경 내용 |
|------|------|--------|-----------|
| 1.0 | 2026-06-10 | Youngho Kim | 최초 작성 — 의상 색상+타입 기반 Appearance Re-ID 설계 문서화 |
| 1.1 | 2026-06-10 | Youngho Kim | Section 2.1 추가: SERVER_MODE별 적용 범위 — streaming 모드 `_processRemoteResult` 내 의상 Re-ID 코드 반영 |

---

## 목차

1. [개요](#1-개요)
2. [아키텍처 개요](#2-아키텍처-개요)
3. [파일 구조](#3-파일-구조)
4. [서버 사이드 설계](#4-서버-사이드-설계)
   - 4.1 [유사도 함수 — _clothingAppearSim()](#41-유사도-함수--_clothingappearsim)
   - 4.2 [핵심 알고리즘 — _assignClothingIds()](#42-핵심-알고리즘--_assignclothingids)
   - 4.3 [공유 의상 갤러리](#43-공유-의상-갤러리)
   - 4.4 [Face Re-ID와의 연동 (신뢰도 결합 모드)](#44-face-reid와의-연동-신뢰도-결합-모드)
5. [클라이언트 사이드 설계](#5-클라이언트-사이드-설계)
6. [데이터 모델](#6-데이터-모델)
7. [Socket.IO 이벤트](#7-socketio-이벤트)
8. [시퀀스 다이어그램](#8-시퀀스-다이어그램)
9. [임계값 및 설정](#9-임계값-및-설정)
10. [Face Re-ID와의 비교](#10-face-reid와의-비교)
11. [오류 처리 및 한계](#11-오류-처리-및-한계)

---

## 1. 개요

Appearance Re-ID는 **얼굴이 보이지 않는 상황**(마스크 착용, 뒷모습, 먼 거리)에서 의상 색상과 유형으로 크로스카메라 동일인을 추적하는 기능입니다.

### 동작 원리

1. **색상 추출** (`colorClothService.fastColor()`) — 상의/하의 영역 평균 RGB 추출, 별도 모델 불필요, ~0.5ms/person
2. **의상 타입 추출** (선택, `openpar.onnx`) — 상의/하의 종류 분류 (jacket, jeans 등)
3. **_clothingAppearSim()** — RGB 유클리드 거리 + 의상 타입 exact-match 가중 조합
4. **_assignClothingIds()** — 공유 갤러리에서 CLOTHING_MATCH_THRESH (0.75) 이상 시 동일 의상으로 판별
5. 다른 카메라에서 감지 시 `clothing:reidentified` 이벤트 발행

### Face Re-ID와의 관계

| 상황 | 동작 |
|------|------|
| 얼굴 + 의상 모두 매칭 | 신뢰도 결합: `0.70 × faceScore + 0.30 × clothingScore` |
| 의상만 매칭 (얼굴 미감지) | `clothing:reidentified` 단독 발행 |
| 얼굴만 매칭 | `face:reidentified` 단독 발행 (기존 동작 유지) |

---

## 2. 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CLIENT (React + Zustand)                          │
│                                                                              │
│  App.tsx                                                                     │
│   ├─ socket.on('clothing:reidentified') → clothingReIdStore.addEvent()      │
│   └─ socket.on('face:reidentified')     → crossCameraStore.addEvent()       │
│                                                                              │
│  FullscreenCameraView.tsx / DetectionPanel                                   │
│   ├─ Cross-Camera Re-ID 패널 (통합): 얼굴 👤 + 의상 👕 이벤트 함께 표시     │
│   └─ Appearance Re-ID 패널 (신규): 의상 색상 스워치 + combined 신뢰도 표시   │
│                                                                              │
│  clothingReIdStore.ts                                                        │
│   └─ events: ClothingReIdEvent[] (max 20, TTL 60s)                          │
└─────────────────────────────┬───────────────────────────────────────────────┘
                              │ Socket.IO
┌─────────────────────────────▼───────────────────────────────────────────────┐
│                      SERVER (Express + Socket.IO)                            │
│                                                                              │
│  services/pipelineManager.js                                                 │
│   ├─ _sharedClothingGallery[]     — 인메모리 의상 갤러리 (TTL 5분)            │
│   ├─ _clothingCounter             — C1, C2, … 순차 ID                       │
│   ├─ _crossClothingStats Map      — 카메라 전환 횟수 통계                    │
│   ├─ _clothingAppearSim()         — 가중 유사도 함수 (모듈 수준)             │
│   └─ _assignClothingIds()         — 갤러리 검색 + 크로스카메라 감지          │
│                                                                              │
│  services/colorClothService.js                                               │
│   ├─ fastColor() — 모델 없이 RGB 추출 (항상 활성)                            │
│   └─ analyze()   — PAR ONNX 의상 타입 추출 (openpar.onnx 필요)              │
│                                                                              │
│  services/attributePipeline.js                                               │
│   └─ enrich() — color/cloth 속성 enrichedObjects에 포함                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2.1 SERVER_MODE별 의상 Re-ID 적용 범위

| SERVER_MODE | 의상 Re-ID 위치 | emit 방식 |
|-------------|----------------|-----------|
| `combined` | `pipelineManager._processFrame()` — `_assignClothingIds()` 직접 호출 | `.to(cameraId)` (카메라 룸) |
| `streaming` | `pipelineManager._processRemoteResult()` — analysis 서버 응답 수신 후 인라인 호출 | `.to(cameraId)` (카메라 룸) |
| `analysis` | `analysisApi.js` — 향후 지원 예정 (현재 미구현) | `io.emit()` global |

### streaming 모드 구현 (`_processRemoteResult`)

streaming 서버는 analysis 서버의 HTTP 응답(`remoteTracked`)을 받은 후
`_assignClothingIds()`를 호출하여 의상 Re-ID를 수행합니다.
`faceId` 매핑을 위해 응답의 `namedFaces`에서 objectId → faceId 맵을 먼저 구성합니다.

```javascript
// _processRemoteResult() 내 clothing Re-ID 블록
if (analyticsConfig.isEnabled('color') && remoteTracked.length > 0) {
  // 1. objectId → faceId 매핑 구성 (얼굴 매칭 개선용)
  const _oIdToFaceId = new Map();
  for (const fd of faceDetObjects) {
    const p = remoteTracked.find(o =>
      o.className === 'person' && o.face && _bboxClose(o.face.bbox, fd.bbox)
    );
    if (p) _oIdToFaceId.set(String(p.objectId), fd.faceId);
  }

  // 2. 공유 갤러리 검색 + 크로스카메라 전환 감지
  const { crossCameraTransitions: _clothCCT } =
    this._assignClothingIds(_cameraId, remoteTracked, _ts, _oIdToFaceId);

  // 3. 전환 이벤트 emit
  for (const ct of _clothCCT) {
    this._io.emit('clothing:reidentified', {
      clothingId, faceId, prevCameraId, newCameraId,
      similarity, objectId,
      feature: { upper, lower, upperRgb, lowerRgb },
      timestamp,
    });
  }
}
```

**combined 모드와의 차이:**
- combined: `_processFrame()` 안에서 `attributePipeline.enrich()`가 색상을 추출한 결과로 `_assignClothingIds()` 호출
- streaming: analysis 서버가 이미 enriched된 `remoteTracked`를 반환하므로 별도 색상 추출 없이 `_assignClothingIds()` 직접 호출

---

## 3. 파일 구조

```
loitering_tracking/
├── server/
│   ├── models/
│   │   └── openpar.onnx                   # PAR 의상 타입 모델 (선택, 미포함 시 색상만)
│   └── src/
│       └── services/
│           ├── pipelineManager.js         # _clothingAppearSim, _assignClothingIds 포함
│           └── colorClothService.js       # RGB 추출 + PAR 의상 타입 분류
├── client/
│   └── src/
│       ├── stores/
│       │   └── clothingReIdStore.ts       # ClothingReIdEvent 스트림 (신규)
│       ├── components/
│       │   └── FullscreenCameraView.tsx   # Appearance Re-ID 패널 + 통합 Cross-Camera 패널
│       └── types/
│           └── index.ts                  # ClothingReIdEvent, ClothingFeature 타입 추가
└── docs/design/
    ├── Design_AI_ReID.md                  # 얼굴 Re-ID 설계 (참조)
    └── Design_AI_AppearanceReID.md        # 이 문서
```

---

## 4. 서버 사이드 설계

### 4.1 유사도 함수 — `_clothingAppearSim()`

**파일:** `server/src/services/pipelineManager.js` (모듈 수준 함수)

```
입력: a, b  (각각 { upperRgb, lowerRgb, upper, lower })

────── 상의 (Upper, 전체 가중치 60%) ────────────────────────
upperRgb 존재 시:
  RGB 유클리드 거리 = sqrt((R1-R2)² + (G1-G2)² + (B1-B2)²)
  colorSim  = 1 − dist / 441.67  (441.67 = sqrt(3)×255, 최대 거리)
  typeSim   = exact match(upper) → 1.0 | 0.0  (unknown 시 중립 0.5)
  score    += 0.60 × (0.55×colorSim + 0.45×typeSim)
  weight   += 0.60

────── 하의 (Lower, 전체 가중치 40%) ────────────────────────
lowerRgb 존재 시:
  colorSim  = 1 − dist(lowerRgb) / 441.67
  typeSim   = exact match(lower) → 1.0 | 0.0
  score    += 0.40 × (0.50×colorSim + 0.50×typeSim)
  weight   += 0.40

────── 반환 ──────────────────────────────────────────────────
weight > 0 ? score / weight : 0   → [0, 1]
```

**설계 근거:**
- 상의를 하의보다 중요하게 취급 (60:40) — 보행자 영상에서 상의가 더 잘 보임
- colorSim 가중치를 typeSim보다 낮게 (55:45 for upper) — PAR 모델 미로드 시에도 동작하도록
- L2 정규화 없음 (Face와 달리 RGB는 비교 자체가 유클리드 거리)

### 4.2 핵심 알고리즘 — `_assignClothingIds()`

**파일:** `server/src/services/pipelineManager.js`

```
입력:
  cameraId         — 현재 카메라 UUID
  enrichedObjects  — attributePipeline.enrich() 결과 (color, cloth 속성 포함)
  timestamp        — 현재 프레임 시간 (Unix ms)
  objectIdToFaceId — Map<String(objectId), faceId>  (face Re-ID 결과로부터)

Step 1 — TTL 만료 처리
  _sharedClothingGallery = gallery.filter(g => timestamp - g.lastSeenAt < 300,000)

Step 2 — 각 person 객체에 대해
  if (!obj.color?.upperRgb) → skip (색상 미추출)

  feature = { upperRgb, lowerRgb, upper, lower }
  linkedFaceId = objectIdToFaceId.get(String(obj.objectId))

  ── 갤러리 선형 검색 ──────────────────────────────────────────────────
  for g in _sharedClothingGallery:
    sim = _clothingAppearSim(feature, g.feature)
    if sim > CLOTHING_MATCH_THRESH (0.75) → bestEntry = g

  ── 매칭 발견 ─────────────────────────────────────────────────────────
  if bestEntry:
    if bestEntry.lastCameraId ≠ cameraId:
      ★ 크로스카메라 전환!
      _crossClothingStats 업데이트 (transitionCount++)
      crossCameraTransitions.push({ clothingId, faceId, prevCameraId, newCameraId, similarity, ... })

    bestEntry.lastSeenAt = timestamp
    bestEntry.lastCameraId = cameraId
    if linkedFaceId: bestEntry.faceId = linkedFaceId  (faceId 연결)

  ── 신규 의상 ─────────────────────────────────────────────────────────
  else:
    clothingId = 'C{counter++}'
    gallery.push({ clothingId, feature, lastSeenAt, lastCameraId, faceId: linkedFaceId })

Step 3 — 반환
  { assignments: [{ objectId, clothingId, matchScore }],
    crossCameraTransitions: [{ clothingId, faceId, prevCameraId, newCameraId, similarity, ... }] }
```

### 4.3 공유 의상 갤러리

**`_sharedClothingGallery` 항목 구조:**

```javascript
{
  clothingId:   'C7',        // 순차 할당 ID
  feature: {
    upperRgb:   [R, G, B],  // 상의 평균 RGB (0–255)
    lowerRgb:   [R, G, B],  // 하의 평균 RGB (null 가능)
    upper:      'jacket',   // PAR 의상 타입 (null when model not loaded)
    lower:      'jeans',
  },
  lastSeenAt:   number,      // Unix ms — TTL 기준
  lastCameraId: string,      // 가장 최근 감지 카메라 UUID
  faceId:       'F7' | null, // 연결된 face Re-ID ID (있을 경우)
}
```

**TTL 전략:**
- Face 갤러리: 30초 (빠른 만료 — 얼굴 식별은 고유성 높음)
- Clothing 갤러리: **5분** (느린 만료 — 같은 옷을 오래 착용)

### 4.4 Face Re-ID와의 연동 (신뢰도 결합 모드)

`_assignClothingIds()`는 `objectIdToFaceId` 맵을 통해 face Re-ID 결과와 연동됩니다.

```
Frame Processing 순서:
  1. attributePipeline.enrich()  → attrObjects (color, cloth, face 속성 포함)
  2. _assignFaceIds()            → namedFaces (faceId 부여)
  3. faceDetObjects 생성         → [{ faceId, bbox }]
  4. objectId → faceId 맵 구성  → faceDetObjects × attrObjects bbox 매칭
  5. _assignClothingIds()        → clothingAssignMap, crossCameraTransitions

clothing:reidentified 이벤트에 faceId 포함
  → 클라이언트에서 face:reidentified 이벤트와 faceId로 매칭
  → combined = 0.70 × faceScore + 0.30 × clothingScore
```

**클라이언트 결합 계산 (`FullscreenCameraView.tsx`):**

```typescript
const combinedConfidence = (clothingSim: number, faceId: string | null): number | null => {
  if (!faceId) return null;
  const faceEv = crossCameraEvents.find(
    e => e.faceId === faceId && Math.abs(e.timestamp - Date.now()) < 10_000
  );
  if (!faceEv) return null;
  return 0.70 * faceEv.similarity + 0.30 * clothingSim;
};
```

---

## 5. 클라이언트 사이드 설계

### 5.1 clothingReIdStore (`client/src/stores/clothingReIdStore.ts`)

```typescript
const MAX_EVENTS = 20;
const EXPIRY_MS  = 60_000; // 60초 TTL

interface ClothingReIdStore {
  events: ClothingReIdEvent[];
  addEvent: (event: ClothingReIdEvent) => void;
  pruneExpired: () => void;
  clearEvents: () => void;
  getCombinedScore: (event: ClothingReIdEvent, faceSimilarity: number | null) => number | null;
}
```

`App.tsx`에서 `socket.on('clothing:reidentified')` → `addClothingReIdEvent()` 호출

### 5.2 UI 패널 (`FullscreenCameraView.tsx` — DetectionPanel)

**통합 Cross-Camera Re-ID 패널** (기존 + 신규):
- 👤 아이콘: face Re-ID 이벤트 (`[F7] P3 CamA → CamB 87%`)
- 👕 아이콘: clothing Re-ID 이벤트 (`[C3] CamA → CamB 79%`)
- combined 신뢰도 표시 (보라색): face + clothing 둘 다 있을 때

**Appearance Re-ID 패널** (신규, 별도 섹션):
- 의상 RGB 색상 스워치 (■ 상의 ■ 하의)
- PAR 의상 타입 레이블 (jacket/jeans 등)
- `appear XX%` 단독 표시 또는 `comb XX%` 결합 표시 (보라색)
- 카메라 이동 경로 표시

### 5.3 헬퍼 컴포넌트

**`RgbSwatch`** — 2.5×2.5px 컬러 박스 (hex 변환, CSS backgroundColor)

**`clothingLabel(f: ClothingFeature)`** — PAR 타입이 있으면 'jacket/jeans', 없으면 'colour match'

---

## 6. 데이터 모델

### 6.1 ClothingFeature (`client/src/types/index.ts`)

```typescript
export interface ClothingFeature {
  upper?:    string | null;  // PAR 의상 타입 (null = model not loaded)
  lower?:    string | null;
  upperRgb?: [number, number, number] | null;
  lowerRgb?: [number, number, number] | null;
}
```

### 6.2 ClothingReIdEvent (`client/src/types/index.ts`)

```typescript
export interface ClothingReIdEvent {
  clothingId:   string;        // 'C1', 'C2', … gallery-assigned appearance ID
  faceId?:      string | null; // linked face ID (from face Re-ID, when available)
  prevCameraId: string;
  newCameraId:  string;
  similarity:   number;        // _clothingAppearSim score [0, 1]
  objectId?:    string | number | null;
  feature:      ClothingFeature;
  timestamp:    number;
}
```

### 6.3 Detection 타입 확장 (`client/src/types/index.ts`)

```typescript
export interface Detection {
  // 기존 필드 ...
  clothingId?: string;  // 'C1', 'C2', … — clothing Re-ID gallery ID (신규)
}
```

---

## 7. Socket.IO 이벤트

### 서버 → 클라이언트

| 이벤트 | 페이로드 | 발행 조건 | 클라이언트 처리 |
|--------|---------|----------|---------------|
| `clothing:reidentified` | `ClothingReIdEvent` | 동일 의상이 다른 카메라에서 감지 | `clothingReIdStore.addEvent()` |
| `face:reidentified` | `CrossCameraReIdEvent` | 동일 얼굴이 다른 카메라에서 감지 (기존) | `crossCameraStore.addEvent()` |
| `detections` | 기존 구조 + `clothingId?` | 매 분석 프레임 | 캔버스 오버레이 갱신 |

### `clothing:reidentified` 페이로드 상세

```json
{
  "clothingId":   "C7",
  "faceId":       "F3",
  "prevCameraId": "cam-a-uuid",
  "newCameraId":  "cam-b-uuid",
  "similarity":   0.82,
  "objectId":     "tracker-uuid",
  "feature": {
    "upper":    "jacket",
    "lower":    "jeans",
    "upperRgb": [45, 67, 120],
    "lowerRgb": [20, 30, 50]
  },
  "timestamp":    1748000300000
}
```

---

## 8. 시퀀스 다이어그램

### 8.1 의상 Re-ID 단독 (얼굴 미감지)

```
Camera A RTSP         PipelineManager                 Socket.IO Client
    │                       │                               │
    │── JPEG frame ─────────►│                               │
    │ (뒷모습, 얼굴 없음)   │ attributePipeline.enrich()   │
    │                       │  └─ fastColor(): upperRgb[45,67,120]│
    │                       │                               │
    │                       │ _assignClothingIds(cam-A)    │
    │                       │  └─ 신규 C7 갤러리 등록      │
    │                       │                               │
    │                       │── detections [{clothingId:'C7'}] ─►│

    (...잠시 후...)

Camera B RTSP         PipelineManager                 Socket.IO Client
    │── JPEG frame ─────────►│                               │
    │ (같은 사람 뒷모습)    │ _assignClothingIds(cam-B)    │
    │                       │  ├─ feature sim = 0.84 > 0.75 │
    │                       │  ├─ prevCam = cam-A ≠ cam-B  │
    │                       │  └─ ★ 크로스카메라 전환!      │
    │                       │                               │
    │                       │── emit('clothing:reidentified') ──►│
    │                       │   { clothingId:'C7',           │
    │                       │     faceId: null,              │
    │                       │     prevCameraId:'cam-A',      │
    │                       │     newCameraId:'cam-B',       │
    │                       │     similarity:0.84,           │
    │                       │     feature:{upper:'jacket',...}}│
```

### 8.2 얼굴 + 의상 결합 신뢰도

```
PipelineManager                    Socket.IO Client (DetectionPanel)
    │                                        │
    │── emit('face:reidentified') ───────────►│
    │   { faceId:'F7', similarity:0.91, ... } │
    │                                        │ crossCameraStore.addEvent()
    │── emit('clothing:reidentified') ────────►│
    │   { clothingId:'C7', faceId:'F7',       │ clothingReIdStore.addEvent()
    │     similarity:0.82, ... }              │
    │                                        │
    │                                        │ combinedConfidence('F7', 0.82):
    │                                        │   faceSim = 0.91 (from crossCameraStore)
    │                                        │   = 0.70×0.91 + 0.30×0.82
    │                                        │   = 0.637 + 0.246 = 0.883 (88%)
    │                                        │
    │                                        │ UI: 👕 [C7] [F7] CamA→CamB comb 88% ←보라색
```

---

## 9. 임계값 및 설정

| 상수 | 값 | 위치 | 설명 |
|------|------|------|------|
| `CLOTHING_MATCH_THRESH` | `0.75` | `pipelineManager.js` | 의상 유사도 임계값 (face의 0.35보다 높음 — 의상은 식별력 낮음) |
| `CLOTHING_EXPIRY_MS` | `300,000 ms` | `pipelineManager.js` | 의상 갤러리 TTL (5분, face의 30초보다 길음) |
| `CLOTHING_FACE_W` | `0.70` | `pipelineManager.js` | 결합 신뢰도에서 얼굴 가중치 |
| `CLOTHING_APPEAR_W` | `0.30` | `pipelineManager.js` | 결합 신뢰도에서 의상 가중치 |
| Upper weight | `0.60` | `_clothingAppearSim()` | 상의가 전체 유사도에서 차지하는 비중 |
| Lower weight | `0.40` | `_clothingAppearSim()` | 하의가 전체 유사도에서 차지하는 비중 |
| Upper color:type | `0.55:0.45` | `_clothingAppearSim()` | 상의 내 색상 vs 타입 비중 |
| Lower color:type | `0.50:0.50` | `_clothingAppearSim()` | 하의 내 색상 vs 타입 비중 |
| MAX_EVENTS | `20` | `clothingReIdStore.ts` | 클라이언트 최대 이벤트 수 |
| EXPIRY_MS | `60,000 ms` | `clothingReIdStore.ts` | 클라이언트 이벤트 TTL |

---

## 10. Face Re-ID와의 비교

| 항목 | Face Re-ID | Appearance Re-ID |
|------|------------|-----------------|
| 기술 | ArcFace 512-D 임베딩 | RGB 유클리드 거리 + PAR 타입 |
| 추가 모델 | SCRFD + ArcFace (필수) | 없음 (fastColor only) 또는 openpar.onnx (선택) |
| 처리 시간 | ~50–200ms/person (ONNX) | ~0.5ms/person (fastColor) |
| 식별 정확도 | 매우 높음 (생체 정보) | 낮음 (옷 색상은 비고유) |
| 뒷모습 동작 | 불가 | 가능 |
| 마스크 착용 시 | 부정확 | 영향 없음 |
| 동일 복장 타인 | 오탐 없음 | **오탐 가능** (동일 제복 착용자) |
| 갤러리 TTL | 30초 | 5분 |
| 매칭 임계값 | 0.35 (코사인 유사도) | 0.75 (가중 유사도) |
| 옷 갈아입으면 | 영향 없음 | 매칭 실패 |

---

## 11. 오류 처리 및 한계

| 상황 | 처리 방법 |
|------|----------|
| `obj.color?.upperRgb` 없음 | 해당 person 건너뜀 (fastColor 비활성 또는 crop 실패) |
| `analyticsConfig.isEnabled('color')` false | 의상 Re-ID 전체 비활성 |
| 동일 제복 착용자 (경비원, 학생 등) | 높은 임계값(0.75)으로 오탐 최소화; 그러나 구별 불가 |
| 빠른 의상 변경 (3분 이내) | CLOTHING_EXPIRY_MS(5분) 이내 → 동일인으로 잘못 매칭 가능 |
| `openpar.onnx` 미존재 | colorSim만 사용 (typeSim = 0.5 중립), 정확도 소폭 감소 |
| `_clothingAppearSim()` 양측 모두 upper/lower 없음 | `w=0` → 유사도 0 반환 → 매칭 안 됨 |
| 클라이언트 combined 계산 시 face 이벤트 만료 | `Math.abs(timestamp - now) < 10_000` (10초 내) → null 반환 |
