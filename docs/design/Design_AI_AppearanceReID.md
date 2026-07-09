# DESIGN DOCUMENT
# AI Module — Appearance-Based Re-Identification (Clothing Re-ID)

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-APPREID-01 |
| **Version** | 1.5 |
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
| 1.2 | 2026-07-09 | Youngho Kim | §12 추가 — `Multi_Camera_Tracking_ReID_가이드.md`/`ReID_및_색상분석_활용가이드.md` 격차 분석 기반 실제 Re-ID 임베딩 모델(OSNet 등) 도입 및 Qdrant 벡터 DB 확장 제안 (Proposed, 미구현) |
| 1.3 | 2026-07-09 | Youngho Kim | §12.4 추가 — 색상 사전 필터링 기반 검색 성능 최적화(Proposed); 원본 가이드 삭제 전 최종 반영 확인 |
| 1.4 | 2026-07-09 | Youngho Kim | 원본 가이드 `docs/rfp/Multi_Camera_Tracking_ReID_가이드.md` 삭제 완료 — 내용 전체가 §12에 반영되었음을 확인하고 본 문서 내 인용을 아카이브 표기로 변경 |
| 1.5 | 2026-07-09 | Youngho Kim | 코드 동기화 — §12를 Proposed→Implemented(opt-in)로 갱신, §12.6 구현 현황(FR 단위) 신설. `appearanceReidService.js`/`qdrantService.js`/`_weightedAppearSim()` 실제 구현 확인. FR-CCFR-064(장시간 재등장 조회 미배선)·065(정확도 미검증)는 잔여 격차로 명시 |

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
12. [Phase-2 개선 제안 — 실제 Re-ID 임베딩 모델 도입](#12-phase-2-개선-제안--실제-re-id-임베딩-모델-도입)
    - 12.1 [근본 원인 — 가중치가 뒤바뀐 구조](#121-근본-원인--가중치가-뒤바뀐-구조)
    - 12.2 [제안: 경량 Re-ID 임베딩 모델 도입](#122-제안-경량-re-id-임베딩-모델-도입)
    - 12.3 [Vector DB 확장 — 기존 Qdrant 인프라 재사용](#123-vector-db-확장--기존-qdrant-인프라-재사용)
    - 12.4 [검색 성능 최적화 — 색상 사전 필터링 (Implemented — stage 1만)](#124-검색-성능-최적화--색상-사전-필터링-implemented--stage-1만)
    - 12.5 [비범위 (Non-Goals, 이번 제안)](#125-비범위-non-goals-이번-제안)
    - 12.6 [구현 현황 (2026-07-09 코드 동기화)](#126-구현-현황-2026-07-09-코드-동기화)

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

---

## 12. Phase-2 개선 제안 — 실제 Re-ID 임베딩 모델 도입

> **Status: Implemented, opt-in** (2026-07-09 설계 제안 → 2026-07-09 코드 구현 완료, 기본 비활성). `appearanceReidService.js`(OSNet 임베딩), `qdrantService.js`(Qdrant 클라이언트), `pipelineManager.js#_weightedAppearSim()`(80/20 가중치)로 구현되었으며 모델 파일(`appearance_reid_osnet.onnx`) 미배포 시·`QDRANT_ENABLED=false`(기본값) 시 자동으로 Phase-1 동작으로 폴백한다. 남은 격차는 §12.6 참조. 본 섹션은 §11에서 이미 자인한 한계("동일 제복 착용자 오탐 가능", "옷 갈아입으면 매칭 실패")를 근거로, 외부 참고 가이드였던 Multi-Camera Tracking Re-ID 가이드(내용 전체를 본 §12에 통합 후 2026-07-09 원본 삭제) 및 `docs/rfp/ReID_및_색상분석_활용가이드.md` 대비 격차 분석을 기록한다. 대응 SRS 요구사항은 `docs/srs/SRS_CrossCamera_Face_Tracking.md` §14 (FR-CCFR-060~065) 참조.

### 12.1 근본 원인 — 가중치가 뒤바뀐 구조

`ReID_및_색상분석_활용가이드.md`는 "색상은 Re-ID의 핵심 Feature가 아니라 보조 Feature"라고 명시하며, 예시 가중치로 **Re-ID Feature 80% : Color Attribute 20%**를 제시한다. Multi-Camera Tracking Re-ID 가이드(원본 삭제됨, 내용 §12에 통합)도 동일하게 Re-ID Feature를 주 신호로, 상의/하의 색상·성별·가방 여부를 보조 신호로 사용하라고 권장한다.

현재 `_clothingAppearSim()`(§4.1)은 실제 Re-ID 임베딩 모델이 전혀 없는 상태에서 **RGB 색상 거리(60/40 가중) + PAR 타입 일치만으로 유사도 100%를 산출**한다 — 가이드가 "보조 신호 20%"로 규정한 요소가 현재 시스템에서는 "유일한 신호 100%"로 쓰이고 있다. 이것이 §11의 "동일 제복 착용자 오탐", "옷 갈아입으면 매칭 실패" 한계의 직접적 원인이다.

### 12.2 제안: 경량 Re-ID 임베딩 모델 도입

| 모델 | 특징 | 채택 우선순위 |
|---|---|---|
| **OSNet / OSNet-AIN** | 경량, 실시간 처리 적합, ONNX 변환 가능, Edge 환경 적용 가능 | **1순위** (가이드 공통 추천) |
| FastReID | 높은 정확도, 대규모 검색 지원, 상용 사례 다수 | 2순위 (GPU 여유 있을 때) |
| TransReID | Transformer 기반, 복잡한 장면에 유리 | 3순위 (GPU 요구사항 높음) |

도입 시 `_clothingAppearSim()`의 유사도 계산을 다음과 같이 재구성한다:

```
Phase-1 (기존, OSNet 미로딩 시 폴백):  similarity = colorSim*0.6 + lowerColorSim*0.4  (typeSim 있으면 가중 조정)  → 100% color-based

Phase-2 (구현됨, OSNet 로딩 시):  similarity = osnetCosineSim * 0.8 + colorSim * 0.2   ← 가이드 권장 가중치 그대로 반영
       (OSNet 모델 미로딩 시에만 Phase-1 방식으로 폴백 — 완전 대체가 아니라 상위 계층 추가)
```

**구현 위치**: `pipelineManager.js`의 `_weightedAppearSim(a, b)` — `a.embedding && b.embedding`일 때만 위 Phase-2 수식을 적용하고, 그 외에는 기존 `_clothingAppearSim()`을 그대로 호출한다. `AppearanceReidService.getEmbedding()`은 person crop을 256×128로 리사이즈해 OSNet(`person-reidentification-retail-0287`, Intel Open Model Zoo)에 통과시켜 256-D L2-정규화 임베딩을 반환한다. **주의**: 전처리(BGR 채널 순서·정규화 방식)는 모델 카드 관례를 따랐을 뿐 실제 모델 출력 대비 end-to-end 검증은 수행되지 않았다(모델 다운로드 미실행) — 프로덕션 반영 전 검증 필요.

### 12.3 Vector DB 확장 — 기존 Qdrant 인프라 재사용

`docs/mrd/MRD_LTS2026.md` §6.4 로드맵(Phase 12b)과 `docs/design/Design_RTSP_WebRTC_Architecture.md` Milestone 3는 이미 **얼굴 임베딩 전용** Qdrant 벡터 DB 도입을 계획하고 있다. 이 인프라를 의상/외형(appearance) 임베딩까지 확장하는 것을 제안한다 — 별도 벡터 DB를 새로 두지 않고 같은 Qdrant 인스턴스에 컬렉션만 분리:

```
Qdrant 인스턴스 (M3, 기존 계획)
  ├─ collection: face_embeddings         (기존 계획 — ArcFace 512D)
  └─ collection: appearance_embeddings   (구현됨 — OSNet 256D, qdrantService.js)
        payload: { trackId, cameraId, colorUpper, colorLower, timestamp }
```

**구현 현황**: `qdrantService.js`가 두 컬렉션 생성(`_ensureCollection`)과 `upsertAppearance()`/`queryAppearance()`(kNN)/`scrollAppearanceByFilter()`(색상 필터, §12.4)를 제공한다. `pipelineManager.js#_assignClothingIds()`는 매 프레임 임베딩이 있을 때 best-effort로 `upsertAppearance()`를 호출해 Qdrant에 벡터를 적재한다(write 경로 완료).

**남은 격차**: Multi-Camera Tracking Re-ID 가이드(원본 삭제됨, 내용 §12에 통합)가 강조하는 "장시간 후 재등장 추적"(예: 1시간 후 다른 카메라 재등장)을 위한 **조회(read) 경로는 아직 배선되지 않았다** — 실시간 매칭 루프(`_assignClothingIds()`의 갤러리 검색)는 여전히 `_sharedClothingGallery`(세션 범위, TTL 5분)만 조회하며, `queryAppearance()`는 어디에서도 호출되지 않는다. 즉 벡터는 저장되지만 5분이 지나 인메모리 갤러리에서 만료된 후에는 아직 아무 코드 경로도 그 벡터를 다시 찾아 매칭에 사용하지 않는다 — 장시간 재등장 시나리오는 여전히 미지원.

### 12.4 검색 성능 최적화 — 색상 사전 필터링 (Implemented — stage 1만)

`ReID_및_색상분석_활용가이드.md`의 "검색과 Re-ID의 결합" 절은 실시간 매칭(위 §12.2)과는 별개로, **사후 검색(search) 성능 최적화** 패턴을 별도로 제시한다: 검색 시 먼저 `상의=빨강, 하의=검정` 같은 색상 조건으로 후보를 줄인 뒤, 그 후보 집합 안에서만 Re-ID 임베딩 유사도 계산을 수행 — 이 두 단계 결합이 "검색 속도와 정확도를 동시에 향상"시킨다.

`server/src/api/search.js`에 구현됨 — 실제 배선:

```
1. GET /api/search?types=appearance&upperColor=red&lowerColor=black
   → qdrantService.scrollAppearanceByFilter({ colorUpper, colorLower }, limit)  [구현됨, FR-CCFR-066]
2. (미구현) 축소된 후보 집합 내에서 osnetCosineSim 재정렬 — 현재는 filter 결과를 그대로
   timestamp 내림차순 정렬만 하며, query-by-example(사진/벡터 입력) 기반 유사도 재랭킹은 없음
3. detections 타입 검색(GET /api/search?types=detections&upperColor=&lowerColor=)도 동일 색상
   파라미터를 지원 — snapshot.attributes.color 문자열 매칭 (Qdrant 불필요)
```

색상은 여전히 "Re-ID 대체"가 아니라 "검색 인덱스"로만 쓰인다 — §12.1의 실시간 매칭 가중치(80/20) 재조정과는 별개의, 검색 API 계층에서의 활용이다. **비고**: `docs/prd/PRD_AI_Color_Analysis.md` §8.2가 제안했던 신규 `GET /api/events?upperColor=&lowerColor=` 엔드포인트 대신, 기존 통합검색 `GET /api/search`에 파라미터를 추가하는 방식으로 구현되었다 — PRD는 이 사실을 반영해 갱신 필요.

### 12.5 비범위 (Non-Goals, 이번 제안)

- 얼굴 Re-ID(ArcFace)는 이번 제안의 대상이 아님 — 이미 실제 임베딩 모델을 사용 중이며 별도로 Qdrant 확장이 계획되어 있음(M3)
- OSNet 도입 시에도 색상 보조 신호(`colorSim`)는 완전히 제거하지 않음 — 가이드 권장 20% 가중치로 유지
- 본 절은 설계 제안 기록이며, 실제 코드(`pipelineManager.js`, `analysisApi.js` 등) 구현은 별도 사용자 요청 시 진행

### 12.6 구현 현황 (2026-07-09 코드 동기화)

§12.1~12.5는 설계 제안으로 작성되었으나, 이후 별도 세션에서 실제 코드로 구현되었다. 구현 여부를 FR 단위로 정리한다 (SRS FR-CCFR-060~066 대응):

| FR | 항목 | 상태 | 비고 |
|---|---|---|---|
| FR-CCFR-060 | 임베딩 모델 상태 노출 | ✅ Done | `getServiceStatus().appearanceReid`, `/health` capabilities `appearanceReid` |
| FR-CCFR-061 | 80/20 가중 유사도 | ✅ Done | `_weightedAppearSim()` |
| FR-CCFR-062 | 모델 미로딩 시 폴백 | ✅ Done | `_weightedAppearSim()`이 `_clothingAppearSim()`로 폴백 |
| FR-CCFR-063 | `appearance_embeddings` 컬렉션 | ✅ Done | `qdrantService.js`, write 경로(`upsertAppearance`) 배선 완료 |
| FR-CCFR-064 | 장시간 재등장 지원 | 🟡 Partial | 벡터 저장(write)만 배선됨 — 실시간 매칭이 Qdrant를 조회(read)하지 않아 5분 TTL 밖 재등장은 여전히 미매칭 |
| FR-CCFR-065 | 동일 제복 오탐 감소 | 🟡 Unverified | 가중치 로직은 구현됐으나 OSNet 전처리가 실제 모델 출력 대비 검증되지 않음(§12.2 참조) — 정량 측정 없음 |
| FR-CCFR-066 | 색상 사전 필터 검색 | ✅ Done | `GET /api/search?types=appearance\|detections&upperColor=&lowerColor=` (§12.4) |

**공통 전제**: 세 가지 모두 opt-in이다 — `appearance_reid_osnet.onnx` 모델 파일은 `npm run download-models`에서 기본 비활성(`enabled:false`, 라이선스 검토 후 수동 활성화 필요), `QDRANT_ENABLED=false`가 기본값이며 비활성 시 기존 Phase-1 동작과 100% 동일하게 폴백한다. 자동화 테스트는 없음(TC_CrossCamera_Face_Tracking.md §11 참조).
