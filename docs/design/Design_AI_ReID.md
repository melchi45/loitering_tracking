# DESIGN DOCUMENT
# AI Module — Re-Identification (Re-ID)

| | |
|---|---|
| **Document ID** | DESIGN-LTS-AI-REID-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-06-10 |
| **Parent SRS** | srs/SRS_CrossCamera_Face_Tracking.md, srs/SRS_AI_Face_Recognition.md |

---

## 변경 이력 (History)

| 버전 | 날짜 | 작성자 | 변경 내용 |
|------|------|--------|-----------|
| 1.0 | 2026-06-10 | Youngho Kim | 최초 작성 — SCRFD+ArcFace 기반 Re-ID 파이프라인 전 구간 설계 문서화 |

---

## 목차

1. [개요](#1-개요)
2. [아키텍처 개요](#2-아키텍처-개요)
3. [파일 구조](#3-파일-구조)
4. [서버 사이드 설계](#4-서버-사이드-설계)
   - 4.1 [얼굴 임베딩 추출 (FaceService)](#41-얼굴-임베딩-추출-faceservice)
   - 4.2 [속성 파이프라인 오케스트레이션 (AttributePipeline)](#42-속성-파이프라인-오케스트레이션-attributepipeline)
   - 4.3 [Re-ID 핵심 알고리즘 (PipelineManager)](#43-re-id-핵심-알고리즘-pipelinemanager)
   - 4.4 [공유 갤러리 관리](#44-공유-갤러리-관리)
   - 4.5 [영구 갤러리 (Named Identity)](#45-영구-갤러리-named-identity)
   - 4.6 [Person Registry & Trajectory](#46-person-registry--trajectory)
   - 4.7 [얼굴 갤러리 REST API](#47-얼굴-갤러리-rest-api)
5. [클라이언트 사이드 설계](#5-클라이언트-사이드-설계)
6. [데이터 모델](#6-데이터-모델)
7. [Socket.IO 이벤트](#7-socketio-이벤트)
8. [시퀀스 다이어그램](#8-시퀀스-다이어그램)
9. [환경변수 및 임계값 설정](#9-환경변수-및-임계값-설정)
10. [오류 처리](#10-오류-처리)

---

## 1. 개요

Re-ID(Re-Identification)는 서로 다른 카메라에서 촬영된 영상에서 **동일 인물을 식별·추적**하는 기술입니다. LTS-2026은 다음 두 단계 딥러닝 파이프라인으로 Re-ID를 구현합니다.

1. **얼굴 감지 (SCRFD)** — 640×640 프레임에서 얼굴 영역 및 5개 랜드마크 추출
2. **얼굴 임베딩 (ArcFace)** — 112×112 정렬 얼굴 작물에서 512차원 L2 정규화 특징 벡터 추출

추출된 임베딩 벡터는 **코사인 유사도**(내적)로 비교하여 동일인 여부를 판별합니다. 임계값(0.35) 이상이면 동일인으로 간주하고, 이전 감지 카메라와 다를 경우 **크로스카메라 Re-ID 이벤트**를 발행합니다.

### 관련 설계 문서

| 문서 | 설명 |
|------|------|
| [Design_AI_Face_Recognition.md](Design_AI_Face_Recognition.md) | SCRFD/ArcFace 모델 상세 설계 |
| [Design_CrossCamera_Face_Tracking.md](Design_CrossCamera_Face_Tracking.md) | 크로스카메라 추적 및 Global Person Registry 아키텍처 |
| [Design_AI_Missing_Person_Detection.md](Design_AI_Missing_Person_Detection.md) | 영구 갤러리 기반 실종자 매칭 |

---

## 2. 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CLIENT (React + Zustand)                          │
│                                                                              │
│  App.tsx                                                                     │
│   ├─ socket.on('face:reidentified')       → crossCameraStore.addEvent()     │
│   ├─ socket.on('person:trajectory-update')→ personTrajectoryStore.update()  │
│   ├─ socket.on('face_match')              → faceMatchStore / toast alert     │
│   └─ socket.on('missing_person_match')    → 실종자 알림 팝업                 │
│                                                                              │
│  FullscreenCameraView.tsx                                                    │
│   ├─ DetectionRow — teal alias badge 'P3 [F7]' (크로스카메라 동선 표시)       │
│   ├─ Person Trails 패널 — 이 카메라를 방문한 모든 인물 궤적                  │
│   └─ CrossCamera ReID 패널 — 실시간 크로스카메라 이벤트 스트림               │
│                                                                              │
│  FaceGalleryTab.tsx                                                          │
│   ├─ GET /api/galleries → 갤러리 목록                                        │
│   ├─ POST /api/galleries/:id/faces → 얼굴 등록 (사진 업로드)                │
│   └─ DELETE /api/galleries/:id/faces/:faceId → 개인정보 삭제 (GDPR)         │
└─────────────────────────────┬───────────────────────────────────────────────┘
                              │ HTTP / WebSocket
┌─────────────────────────────▼───────────────────────────────────────────────┐
│                      SERVER (Express + Socket.IO)                            │
│                                                                              │
│  index.js                                                                    │
│   ├─ GET  /api/galleries                  → 갤러리 목록                      │
│   ├─ POST /api/galleries/:id/faces        → 얼굴 등록                       │
│   ├─ GET  /api/faces/cross-camera-stats   → 크로스카메라 통계               │
│   ├─ GET  /api/faces/trajectories         → 인물 궤적                       │
│   └─ GET  /api/persons/active             → 현재 활성 인물                   │
│                                                                              │
│  services/faceService.js           — SCRFD + ArcFace ONNX 추론              │
│   ├─ detectFaces(jpegBuf, W, H)    → [{ bbox, score, landmarks }]          │
│   └─ getEmbedding(jpegBuf, bbox)   → number[] | null (512-D L2)            │
│                                                                              │
│  services/attributePipeline.js     — 프레임 속성 강화 오케스트레이터         │
│   └─ enrich(jpegBuf, W, H, objs)   → { enrichedObjects, detectedFaces }   │
│                                                                              │
│  services/pipelineManager.js       — Re-ID 핵심 로직                        │
│   ├─ _sharedFaceGallery[]          — 인메모리 단기 갤러리 (TTL 30s)          │
│   ├─ _persistentGallery[]          — DB 기반 영구 갤러리 (named identity)   │
│   ├─ _crossCameraStats Map         — 카메라 전환 횟수 통계                   │
│   ├─ _personTrajectory Map         — 세션 내 인물 동선 레지스트리            │
│   └─ _assignFaceIds()              — 코사인 유사도 매칭 + Re-ID 이벤트 발행 │
│                                                                              │
│  storage/face_tracking.json        — 세션 간 trajectory 영속성              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 파일 구조

```
loitering_tracking/
├── server/
│   ├── models/
│   │   ├── scrfd_2.5g.onnx               # 얼굴 감지 모델 (3.3 MB)
│   │   └── arcface_w600k_r50.onnx        # 얼굴 임베딩 모델 (249 MB)
│   └── src/
│       ├── services/
│       │   ├── faceService.js            # SCRFD + ArcFace ONNX 추론
│       │   ├── attributePipeline.js      # 얼굴 감지 → 임베딩 오케스트레이션
│       │   └── pipelineManager.js        # Re-ID 알고리즘, 갤러리, trajectory
│       ├── api/
│       │   └── faceGallery.js            # 갤러리 CRUD REST API
│       └── index.js                      # /api/persons, /api/faces 라우트
├── client/
│   └── src/
│       ├── stores/
│       │   ├── crossCameraStore.ts       # 크로스카메라 Re-ID 이벤트 스트림
│       │   └── personTrajectoryStore.ts  # 인물 궤적 상태
│       ├── components/
│       │   ├── FaceGalleryTab.tsx        # 갤러리 UI (등록/삭제)
│       │   └── FullscreenCameraView.tsx  # Re-ID 배지 및 궤적 패널
│       └── types/
│           └── index.ts                 # CrossCameraReIdEvent, PersonTrajectory 등
└── storage/
    └── face_tracking.json               # trajectory 영속 저장소
```

---

## 4. 서버 사이드 설계

### 4.1 얼굴 임베딩 추출 (FaceService)

**파일:** `server/src/services/faceService.js`

#### Stage 1 — SCRFD 얼굴 감지

```
JPEG 프레임 (원본 해상도)
        │
        ▼ sharp 디코드
640×640 레터박싱 + 검정 패딩
        │
        ▼ 정규화: (pixel − 127.5) / 128.0
ONNX 입력 텐서 [1, 3, 640, 640] NCHW
        │
        ▼ scrfd_2.5g.onnx
출력: score_8, score_16, score_32       ← 신뢰도 맵 (stride 8/16/32)
      bbox_8,  bbox_16,  bbox_32        ← bbox 오프셋
      kps_8,   kps_16,   kps_32         ← 5-포인트 랜드마크
        │
        ▼ 신뢰도 필터 (confThresh = 0.5)
        ▼ NMS (nmsThresh = 0.4, IoU 기반)
        ▼ 좌표 역변환 (640×640 → 원본 해상도)
결과: [{ bbox: {x,y,width,height}, score, landmarks: [[x,y]×5] }]
```

#### Stage 2 — ArcFace 임베딩 추출

```javascript
// faceService.js:getEmbedding(jpegBuffer, faceBbox)
const ARCFACE_SIZE = 112;

// 1. 얼굴 bbox 영역을 원본 프레임에서 작물
// 2. 5-포인트 랜드마크 기준점으로 어파인 변환 정렬 (InsightFace 표준)
// 3. 112×112 리사이즈
// 4. 정규화: (pixel − 127.5) / 128.0
// 5. ONNX 입력 [1, 3, 112, 112] NCHW
// 6. arcface_w600k_r50.onnx 실행
// 7. 출력 512-D 벡터 L2 정규화

const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0)) || 1;
return emb.map(v => v / norm);  // 결과: 코사인 유사도 = 내적
```

**L2 정규화 후 두 벡터의 내적은 코사인 유사도와 동일합니다** — 별도의 나눗셈 없이 `Σ(aᵢ × bᵢ)` 만으로 유사도 계산.

#### 함수 시그니처 요약

| 함수 | 입력 | 출력 |
|------|------|------|
| `detectFaces(jpegBuffer, origW, origH)` | JPEG 바이너리, 프레임 너비/높이 | `Array<{bbox, score, landmarks}>` |
| `getEmbedding(jpegBuffer, faceBbox)` | JPEG 바이너리, 얼굴 bbox | `number[]` (512-D L2) 또는 `null` |

---

### 4.2 속성 파이프라인 오케스트레이션 (AttributePipeline)

**파일:** `server/src/services/attributePipeline.js`

```javascript
// attributePipeline.js:enrich(jpegBuffer, origW, origH, trackedObjects, zones, config)

// 1. SCRFD 실행 (전체 프레임, 트래킹과 독립)
let faces = await this._face.detectFaces(jpegBuffer, origW, origH);

// 2. 감지된 모든 얼굴에 대해 ArcFace 병렬 실행
if (faces.length > 0) {
  const embeddings = await Promise.all(
    faces.map(f => this._face.getEmbedding(jpegBuffer, f.bbox))
  );
  faces = faces.map((f, i) => ({ ...f, embedding: embeddings[i] }));
}

// 3. person bbox 상단 35%(headRoi)와 얼굴 bbox IoU 매칭
//    → 가장 IoU가 높은 얼굴을 해당 person에 연결
const headRoi = _headRoi(obj.bbox);
const matched = _bestMatch(headRoi, faces);
if (matched) {
  obj.faceEmbedding = matched.embedding;
  obj.faceBbox      = matched.bbox;
  obj.faceScore     = matched.score;
}

return { enrichedObjects: [...], detectedFaces: faces };
```

`detectedFaces` 배열은 `pipelineManager._assignFaceIds()`로 전달되어 Re-ID 처리됩니다.

---

### 4.3 Re-ID 핵심 알고리즘 (PipelineManager)

**파일:** `server/src/services/pipelineManager.js`

#### 코사인 유사도 계산 (라인 66–70)

```javascript
function _cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;  // L2 정규화 벡터 → dot = cosine similarity
}
```

- 입력: 두 512-D L2 정규화 벡터
- 출력: [-1, 1] (실제 범위: [0, 1], 얼굴 특징은 반구 상에 분포)
- 임계값: **0.35** (같은 사람으로 판별)

#### `_assignFaceIds()` 알고리즘 (라인 1225–1363)

```
입력: cameraId, detectedFaces[], timestamp
      (각 face: { bbox, score, landmarks, embedding })

Step 1 — 갤러리 TTL 만료 처리
  _sharedFaceGallery = _sharedFaceGallery.filter(
    g => timestamp - g.lastSeenAt < FACE_EXPIRY_MS (30,000 ms)
  )

Step 2 — 각 감지 얼굴에 대해
  ┌─ embedding 없음?
  │   → 임시 ID 할당 ('F{counter++}'), 갤러리 추가 없음
  │
  └─ embedding 있음 → 공유 갤러리 선형 검색
      for g in _sharedFaceGallery:
        sim = _cosineSim(face.embedding, g.embedding)
        if sim > bestScore: bestEntry = g, bestScore = sim

      ┌─ bestEntry 없음 (새 얼굴)?
      │   → 새 ID 할당 ('F{counter++}')
      │   → 갤러리에 추가 { faceId, embedding, lastSeenAt, lastCameraId }
      │   → 영구 갤러리 검색 (named identity 매칭)
      │
      └─ bestEntry 있음 (기존 얼굴)?
          → faceId = bestEntry.faceId
          → 갤러리 업데이트 { lastSeenAt, lastCameraId }
          │
          ├─ prevCameraId == cameraId?
          │   → 같은 카메라 지속 추적 (무음)
          │
          └─ prevCameraId != cameraId? ★ 크로스카메라 전환!
              → crossCameraTransitions 목록에 추가:
                { faceId, prevCameraId, newCameraId, similarity, timestamp, faceBbox }
              → _crossCameraStats 업데이트 (transitionCount++)
              → 영구 갤러리 검색 (named identity 매칭)

Step 3 — 영구 갤러리 매칭 (named identity)
  for pg in _persistentGallery:
    sim = _cosineSim(face.embedding, pg.embedding)
    if sim > FACE_MATCH_THRESH:
      → pendingMatchEvents에 추가 (30초 쿨다운 적용)

출력: { faces: result[], crossCameraTransitions[], pendingMatchEvents[] }
```

---

### 4.4 공유 갤러리 관리

**파일:** `server/src/services/pipelineManager.js` — `_sharedFaceGallery` (라인 120)

공유 갤러리는 **모든 카메라가 참조하는 인메모리 단기 갤러리**입니다.

```javascript
// 갤러리 항목 구조
{
  faceId:       'F7',          // 순차 할당 ID (서버 재시작 시 초기화)
  embedding:    number[],      // 512-D L2 정규화 ArcFace 임베딩
  lastSeenAt:   number,        // Unix ms — TTL 추적용
  lastCameraId: string,        // 가장 최근 감지된 카메라 UUID
}
```

**갤러리 탐색 방법:** 선형 탐색 (O(n))
- 일반적 운영 환경 기준 동시 추적 인물은 수십 명 이하로, 선형 탐색이 충분히 빠릅니다.
- TTL 만료(30초)로 인해 갤러리 크기는 자연 제한됩니다.

**크로스카메라 전환 통계 — `_crossCameraStats`** (라인 132)

```javascript
// Map<faceId, TransitionStat>
{
  faceId:          'F7',
  firstCameraId:   'cam-a-uuid',
  lastCameraId:    'cam-b-uuid',
  transitionCount: 3,           // 누적 카메라 전환 횟수
  lastSeenAt:      number,
}
```

---

### 4.5 영구 갤러리 (Named Identity)

**파일:** `server/src/services/pipelineManager.js` — `_persistentGallery` (라인 1454)

영구 갤러리는 **DB(lts.json 또는 MongoDB)에 저장된 등록 얼굴 목록**입니다.  
관리자가 `POST /api/galleries/:galleryId/faces` 로 사진을 업로드하면 SCRFD+ArcFace 처리 후 저장됩니다.

```javascript
// 영구 갤러리 항목 구조 (DB 컬렉션: faceGalleryFaces)
{
  id:        'uuid',
  galleryId: 'uuid',          // 소속 갤러리 (general / vip / blocklist / missing)
  name:      'John Doe',      // 등록 시 지정한 이름
  embedding: number[],        // 512-D L2 정규화
  thumbnail: 'data:image/jpeg;base64,...', // 64×64 썸네일
  bbox:      { x, y, width, height },
  score:     0.95,            // SCRFD 신뢰도
}
```

**등록 워크플로우 (`server/src/api/faceGallery.js`):**

```
POST /api/galleries/:galleryId/faces  (multipart/form-data: photo, name)
  │
  ▼ Multer 수신 (메모리, 10 MB 제한)
  │
  ▼ Sharp로 JPEG 정규화
  │
  ▼ faceService.detectFaces()   — SCRFD 실행
  │   얼굴 없음 → HTTP 422 반환
  │
  ▼ 최대 face 선택 (width × height 최대 면적)
  │
  ▼ faceService.getEmbedding()  — ArcFace 실행
  │   임베딩 실패 → HTTP 422 반환
  │
  ▼ 64×64 thumbnail 생성 (base64 JPEG)
  │
  ▼ DB 저장 (faceGalleryFaces)
  │
  ▼ pipelineManager.reloadPersistentGallery() 호출
      → 라이브 파이프라인에 즉시 반영

응답 201: { success, data: { id, galleryId, name, thumbnail, bbox, score } }
         (embedding은 보안상 응답에서 제외)
```

**쿨다운 제어:** 같은 `(faceId, galleryId)` 쌍에 대해 30,000 ms 이내 재이벤트 억제  
→ `face_match` 이벤트 폭주 방지

---

### 4.6 Person Registry & Trajectory

**파일:** `server/src/services/pipelineManager.js` — `_personTrajectory` (라인 138)

모든 Re-ID 이벤트는 **세션 내 인물 동선 레지스트리**를 업데이트합니다.

```javascript
// Map<faceId, PersonTrajectory>
{
  faceId:          'F7',          // 세션 내 얼굴 ID
  alias:           'P3',          // 사용자 표시용 인물 ID (절대 변경 안 됨)
  firstSeenAt:     number,        // 최초 감지 시간 (Unix ms)
  lastSeenAt:      number,        // 최근 감지 시간
  currentCameraId: 'cam-b-uuid',  // 현재 위치 카메라
  segments: [
    {
      cameraId:  'cam-a-uuid',    // 방문한 카메라
      objectId:  42,              // ByteTracker 할당 ID
      entryTime: number,          // 이 카메라 입장 시간
      exitTime:  number,          // 이 카메라 퇴장 시간 (프레임마다 업데이트)
    },
    {
      cameraId:  'cam-b-uuid',
      objectId:  15,
      entryTime: number,
      exitTime:  number,
    },
  ],
}
```

**Trajectory 업데이트 규칙:**

| 상황 | 동작 |
|------|------|
| 신규 얼굴 최초 감지 | alias 할당 (`P{counter++}`), 첫 번째 segment 생성 |
| 같은 카메라에서 재감지 | 마지막 segment의 `exitTime`만 업데이트 (무음) |
| 다른 카메라에서 감지 (크로스카메라) | 이전 segment `exitTime` 종료, 신규 segment 추가 |

**Trajectory 영속성 (`storage/face_tracking.json`):**

```json
{
  "faceCounter": 15,
  "personAliasCounter": 8,
  "trajectories": [
    {
      "faceId": "F7",
      "alias": "P3",
      "firstSeenAt": 1748000000000,
      "lastSeenAt": 1748000620000,
      "currentCameraId": "cam-b-uuid",
      "segments": [...]
    }
  ]
}
```

저장 디바운스: 1,000 ms (새 얼굴 감지 시 1초 후 저장, 연속 감지 시 재스케줄)

---

### 4.7 얼굴 갤러리 REST API

**파일:** `server/src/api/faceGallery.js`, `server/src/index.js`

| 메서드 | 경로 | 설명 | 응답 |
|--------|------|------|------|
| GET | `/api/galleries` | 모든 갤러리 목록 | `[{ id, name, type, faceCount }]` |
| POST | `/api/galleries` | 갤러리 생성 | `{ id, name, type }` |
| DELETE | `/api/galleries/:id` | 갤러리 + 소속 얼굴 일괄 삭제 | `{ success }` |
| GET | `/api/galleries/:id/faces` | 갤러리 내 등록 얼굴 목록 | `[{ id, name, thumbnail, bbox, score }]` |
| POST | `/api/galleries/:id/faces` | 사진 업로드 → 등록 | `{ id, name, thumbnail, bbox, score }` |
| DELETE | `/api/galleries/:id/faces/:faceId` | 개별 얼굴 삭제 (GDPR) | `{ success }` |
| GET | `/api/faces/cross-camera-stats` | 크로스카메라 전환 통계 | `[TransitionStat]` |
| GET | `/api/faces/trajectories?maxAgeMs=300000` | 활성 인물 궤적 | `[PersonTrajectory]` |
| GET | `/api/persons/active?maxAgeMs=300000` | 현재 활성 인물 목록 | `{ total, persons: [...] }` |

---

## 5. 클라이언트 사이드 설계

### 5.1 Zustand 스토어

#### crossCameraStore (`client/src/stores/crossCameraStore.ts`)

```typescript
const MAX_EVENTS = 20;      // 최신 이벤트 최대 보관 수
const EXPIRY_MS  = 60_000;  // 60초 경과 이벤트 자동 제거

interface CrossCameraStore {
  events:       CrossCameraReIdEvent[];
  addEvent:     (event: CrossCameraReIdEvent) => void;
  pruneExpired: () => void;
  clearEvents:  () => void;
}
```

- `socket.on('face:reidentified')` → `addEvent()` 호출
- 용량 초과 시 가장 오래된 이벤트 자동 제거
- `FullscreenCameraView`의 Cross-Camera ReID 패널에서 렌더링

#### personTrajectoryStore (`client/src/stores/personTrajectoryStore.ts`)

```typescript
interface PersonTrajectoryStore {
  persons:       Map<string, PersonTrajectory>;  // faceId → trajectory
  updatePerson:  (p: PersonTrajectory) => void;
  hydrate:       (list: PersonTrajectory[]) => void;  // 초기 로드
}
```

- `socket.on('person:trajectory-update')` → `updatePerson()` 호출
- 앱 마운트 시 `GET /api/persons/active` → `hydrate()` 호출 (세션 복원)

### 5.2 TypeScript 타입 (`client/src/types/index.ts`)

```typescript
export interface CrossCameraReIdEvent {
  faceId:       string;       // 'F7'
  alias?:       string | null;// 'P3' (canonical person ID)
  prevCameraId: string;
  newCameraId:  string;
  newObjectId?: string | number | null;
  similarity:   number;       // cosine similarity [0, 1]
  timestamp:    number;
}

export interface PersonSegment {
  cameraId:  string;
  objectId:  string | number | null;
  entryTime: number;
  exitTime:  number;
}

export interface PersonTrajectory {
  faceId:          string;      // 'F7'
  alias:           string;      // 'P3' — 세션 안정적
  firstSeenAt:     number;
  lastSeenAt:      number;
  currentCameraId: string;
  segments:        PersonSegment[];
}

export interface FaceMatchEvent {
  faceId:      string;
  cameraId:    string;
  identity:    string;         // 영구 갤러리 등록 이름
  galleryId:   string;
  galleryType: 'general' | 'vip' | 'blocklist' | 'missing';
  matchScore:  number;         // cosine similarity
  thumbnail:   string;         // 갤러리 저장 썸네일
  liveCropData?: string;       // 라이브 얼굴 작물 (base64 JPEG)
  timestamp:   number;
}

// Detection 타입 내 Re-ID 관련 필드
export interface Detection {
  // ... 공통 필드 ...
  faceId?:      string;         // 'F7'
  alias?:       string;         // 'P3'
  matchScore?:  number;
  crossCamera?: { prevCameraId: string };
}
```

### 5.3 UI 렌더링

**FullscreenCameraView.tsx:**

- DetectionRow에 teal 색상 alias 배지 (`P3 [F7]`) 표시
- Person Trails 패널: `P3 [F7]  Cam-A → Cam-B ► 현재  87%  2분 전`
- Cross-Camera ReID 패널: 실시간 이벤트 스트림 (최신 20개)

---

## 6. 데이터 모델

### 6.1 공유 갤러리 항목 (인메모리)

| 필드 | 타입 | 설명 |
|------|------|------|
| `faceId` | `string` | `'F{n}'` 형식의 순차 ID |
| `embedding` | `number[]` | 512-D L2 정규화 ArcFace 벡터 |
| `lastSeenAt` | `number` | Unix ms — TTL(30s) 기준 |
| `lastCameraId` | `string` | 마지막 감지 카메라 UUID |

### 6.2 영구 갤러리 항목 (DB: `faceGalleryFaces`)

| 필드 | 타입 | 설명 |
|------|------|------|
| `id` | `string` | UUID |
| `galleryId` | `string` | 소속 갤러리 UUID |
| `name` | `string` | 등록자 지정 이름 |
| `embedding` | `number[]` | 512-D L2 정규화 |
| `thumbnail` | `string` | `data:image/jpeg;base64,...` (64×64) |
| `bbox` | `object` | `{ x, y, width, height }` |
| `score` | `number` | SCRFD 신뢰도 (0–1) |

### 6.3 face_tracking.json (파일 DB)

| 필드 | 타입 | 설명 |
|------|------|------|
| `faceCounter` | `number` | 다음 faceId 번호 (재시작 후 계속 증가) |
| `personAliasCounter` | `number` | 다음 alias 번호 |
| `trajectories` | `PersonTrajectory[]` | 세션 간 보존 인물 동선 |

---

## 7. Socket.IO 이벤트

### 서버 → 클라이언트

| 이벤트 | 페이로드 타입 | 발행 조건 | 수신 처리 |
|--------|-------------|----------|----------|
| `face:reidentified` | `CrossCameraReIdEvent` | 동일 얼굴이 다른 카메라에서 감지됨 | `crossCameraStore.addEvent()` |
| `person:trajectory-update` | `PersonTrajectory` | 신규 인물 등록 또는 크로스카메라 전환 | `personTrajectoryStore.updatePerson()` |
| `face_match` | `FaceMatchEvent` | 라이브 얼굴이 영구 갤러리와 매칭 (30s 쿨다운) | 토스트 알림, 이력 저장 |
| `missing_person_match` | `FaceMatchEvent` | `face_match` + `galleryType === 'missing'` | 실종자 경보 팝업 |
| `detections` | `DetectionsEvent` | 매 분석 프레임 (faceId/alias 포함) | 카메라 뷰 오버레이 갱신 |

### 클라이언트 → 서버

| 이벤트 | 페이로드 | 용도 |
|--------|---------|------|
| `camera:subscribe` | `{ cameraId }` | 특정 카메라 감지 수신 시작 |
| `camera:unsubscribe` | `{ cameraId }` | 수신 종료 |

---

## 8. 시퀀스 다이어그램

### 8.1 기본 Re-ID 흐름 (같은 카메라 지속 추적)

```
Camera A RTSP         PipelineManager                  Socket.IO Client
    │                       │                                │
    │── JPEG frame ─────────►│                                │
    │                       │  attributePipeline.enrich()    │
    │                       │   ├─ SCRFD: 얼굴 감지          │
    │                       │   └─ ArcFace: 512-D 임베딩     │
    │                       │                                │
    │                       │  _assignFaceIds(cam-A, faces)  │
    │                       │   ├─ 갤러리 검색               │
    │                       │   ├─ sim=0.82 > 0.35 → F7      │
    │                       │   └─ prevCam=cam-A (같음 → 무음)│
    │                       │                                │
    │                       │── emit('detections') ──────────►│
    │                       │   [{ faceId:'F7', alias:'P3' }]│
```

### 8.2 크로스카메라 Re-ID 이벤트 흐름

```
Camera A RTSP         PipelineManager                  Socket.IO Client
    │                       │                                │
    │── JPEG frame ─────────►│                                │
    │                       │  _assignFaceIds(cam-A, faces)  │
    │                       │   └─ F7 등록 (lastCam=cam-A)   │
    │                       │── emit('person:trajectory-update')──►│
    │                       │   { alias:'P3', segments:[cam-A] }  │
                                    (잠시 후)
Camera B RTSP         PipelineManager                  Socket.IO Client
    │                       │                                │
    │── JPEG frame ─────────►│                                │
    │                       │  _assignFaceIds(cam-B, faces)  │
    │                       │   ├─ 갤러리 검색               │
    │                       │   ├─ sim=0.87 → F7 매칭        │
    │                       │   ├─ prevCam=cam-A ≠ cam-B     │
    │                       │   └─ ★ 크로스카메라 전환!       │
    │                       │                                │
    │                       │  trajectory 업데이트           │
    │                       │   ├─ segments[-1].exitTime 종료│
    │                       │   └─ segments.push(cam-B entry)│
    │                       │                                │
    │                       │── emit('person:trajectory-update')──►│
    │                       │   { alias:'P3', segments:[cam-A, cam-B] }│
    │                       │                                │
    │                       │── emit('face:reidentified') ───►│
    │                       │   { faceId:'F7', alias:'P3',   │
    │                       │     prevCameraId:'cam-A',       │
    │                       │     newCameraId:'cam-B',        │
    │                       │     similarity:0.87,            │
    │                       │     timestamp:... }             │
    │                       │                                │
    │                       │── emit('detections') ──────────►│
    │                       │   [{ faceId:'F7', alias:'P3',  │
    │                       │      crossCamera:{prevCam:cam-A}}]│
```

### 8.3 영구 갤러리 매칭 (`face_match`) 흐름

```
Camera RTSP           PipelineManager                  Socket.IO Client
    │                       │                                │
    │── JPEG frame ─────────►│                                │
    │                       │  _assignFaceIds()              │
    │                       │   ├─ 공유 갤러리 매칭           │
    │                       │   └─ 영구 갤러리 검색           │
    │                       │       sim('John Doe')=0.91     │
    │                       │       쿨다운 미경과 → 이벤트 발행│
    │                       │                                │
    │                       │  snapshotSvc.cropJpeg() [async]│
    │                       │   (라이브 얼굴 작물 생성)       │
    │                       │                                │
    │                       │── emit('face_match') ──────────►│
    │                       │   { identity:'John Doe',        │
    │                       │     galleryType:'general',      │
    │                       │     matchScore:0.91,            │
    │                       │     liveCropData:base64JPEG }   │
    │                       │                                │
    │                       │  db.insert('faceMatchHistory') │
```

### 8.4 얼굴 등록 흐름

```
Client (Browser)          Server (Express)              PipelineManager
    │                           │                              │
    │── POST /api/galleries     │                              │
    │   /:id/faces              │                              │
    │   (photo: JPEG, name: ..) │                              │
    │                           │── Multer 수신 (메모리)       │
    │                           │── Sharp JPEG 정규화          │
    │                           │── faceService.detectFaces()  │
    │                           │   SCRFD 실행                 │
    │                           │   얼굴 없음 → 422            │
    │                           │── 최대 얼굴 선택             │
    │                           │── faceService.getEmbedding() │
    │                           │   ArcFace 실행               │
    │                           │   실패 → 422                 │
    │                           │── 64×64 thumbnail 생성       │
    │                           │── db.insert('faceGalleryFaces')│
    │                           │── reloadPersistentGallery()─►│
    │                           │                              │  _persistentGallery 갱신
    │◄── 201 { id, thumbnail }  │                              │
```

---

## 9. 환경변수 및 임계값 설정

### 9.1 소스코드 상수 (`server/src/services/pipelineManager.js`)

| 상수 | 값 | 설명 |
|------|------|------|
| `FACE_MATCH_THRESH` | `0.35` | 코사인 유사도 임계값 (같은 사람 판별) |
| `FACE_EXPIRY_MS` | `30,000 ms` | 공유 갤러리 항목 TTL |

### 9.2 모델 파라미터 (`server/src/services/faceService.js`)

| 파라미터 | 값 | 설명 |
|---------|------|------|
| `SCRFD_SIZE` | `640` | SCRFD 입력 해상도 (px) |
| `ARCFACE_SIZE` | `112` | ArcFace 입력 해상도 (px) |
| `confThresh` | `0.5` | SCRFD 얼굴 감지 신뢰도 임계값 |
| `nmsThresh` | `0.4` | NMS IoU 임계값 |
| Embedding dim | `512` | ArcFace 출력 벡터 차원 |

### 9.3 클라이언트 상수 (`client/src/stores/crossCameraStore.ts`)

| 상수 | 값 | 설명 |
|------|------|------|
| `MAX_EVENTS` | `20` | 클라이언트 측 최대 이벤트 보관 수 |
| `EXPIRY_MS` | `60,000 ms` | 클라이언트 측 이벤트 만료 시간 |

### 9.4 API 파라미터 (`server/src/index.js`)

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `maxAgeMs` (trajectories) | `300,000 ms` | 활성 인물 필터 윈도우 (5분) |
| face_match cooldown | `30,000 ms` | 같은 (faceId, galleryId) 쌍 재이벤트 억제 |
| snapshot file size limit | `10 MB` | Multer 업로드 제한 |
| thumbnail size | `64×64 px` | 갤러리 썸네일 해상도 |

### 9.5 ONNX 관련 환경변수 (`.env`)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `ONNX_CUDA` | `0` | `1` 설정 시 CUDA 실행 프로바이더 활성화 |
| `ONNX_THREADS_DEV` | `10` | 개발 모드 스레드 수 |
| `ONNX_THREADS_PROD` | `50` | 프로덕션 스레드 수 |
| `YOLO_MODEL` | `models/yolov8n.onnx` | YOLO 모델 경로 (Re-ID와 별개) |

---

## 10. 오류 처리

| 오류 상황 | 처리 방법 |
|----------|----------|
| ArcFace 임베딩 추출 실패 | `getEmbedding()` → `null` 반환; `_assignFaceIds()`에서 임시 ID 할당 후 갤러리 추가 없음 |
| SCRFD 얼굴 없음 | `detectedFaces = []`; Re-ID 단계 스킵, `detections` 이벤트는 정상 발행 |
| 갤러리 등록 시 얼굴 미감지 | HTTP 422 `{ error: 'No face detected' }` |
| 갤러리 등록 시 임베딩 실패 | HTTP 422 `{ error: 'Could not extract face embedding' }` |
| ONNX 모델 파일 없음 | 서버 시작 시 경고 로그; 해당 서비스 비활성화 (Re-ID 비동작) |
| face_match 이벤트 폭주 | 30초 쿨다운 적용; 같은 (faceId, galleryId) 쌍은 30초 내 1회만 발행 |
| 공유 갤러리 메모리 증가 | TTL 30초 만료 항목 매 프레임 정리; 최대 크기 제한 없음 (운영 환경 주의) |
| face_tracking.json 쓰기 실패 | `console.error` 기록; 서버는 계속 동작 (다음 프레임에서 재시도) |
