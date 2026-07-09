# RFP — Cross-Camera Face Tracking (LTS-2026-CCT-001)

**Document**: LTS-2026-CCT-001  
**Status**: ✅ Implemented  
**Author**: Youngho Kim  
**Date**: 2026-05-20  

---

## 1. Overview

### 1.1 Problem Statement

The current Cross-Camera Re-ID system assigns a shared `faceId` (e.g. `F7`) to a face across cameras via the shared ArcFace gallery. However, three gaps remain:

| Gap | Description |
|---|---|
| **Gallery expiry** | Gallery entries expire after 30 s of non-detection. If a person moves slowly between cameras, they receive a new `faceId` and the cross-camera link is lost |
| **No canonical person ID** | There is no persistent "Person #N" identifier that survives gallery expiry or multiple faceId assignments |
| **No trajectory record** | Camera visit history ("Camera A → B → C with timestamps") is not stored or displayed; operators cannot reconstruct a person's path |

### 1.2 Goal

Maintain a **Global Person Registry** that:

1. Assigns a stable **Person ID** (e.g. `P1`, `P2`) on first face detection, persisting for the entire server session regardless of gallery expiry
2. Records a per-person **camera trajectory** — ordered list of camera visits with entry/exit times and tracker objectIds
3. Broadcasts trajectory updates via Socket.IO so the UI can show live camera movement timelines
4. Provides a REST endpoint for initial page-load hydration

---

## 2. Design

### 2.1 Data Model

#### PersonSegment
```
{
  cameraId:  string       // UUID of the camera
  objectId:  number|null  // ByteTracker objectId in this camera (null if body not detected)
  entryTime: number       // Unix timestamp ms — first seen in this camera
  exitTime:  number       // Unix timestamp ms — last seen in this camera (updated each frame)
}
```

#### PersonTrajectory
```
{
  faceId:          string          // Shared ArcFace gallery ID (canonical key)
  alias:           string          // "P1", "P2", … — session-stable display name
  firstSeenAt:     number          // timestamp of first ever detection
  lastSeenAt:      number          // timestamp of most recent detection (any camera)
  currentCameraId: string          // most recent camera
  segments:        PersonSegment[] // ordered list of camera visits
}
```

### 2.2 Server Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  PipelineManager._processFrame()                                     │
│                                                                      │
│  1. _assignFaceIds() → { faces, crossCameraTransitions }            │
│                                                                      │
│  2. For each named face (NOT in crossCameraTransitions):            │
│     a) If faceId absent from _personTrajectory → CREATE new entry   │
│        · alias = "P" + ++_personAliasCounter                        │
│        · segments = [{ cameraId, objectId, entryTime, exitTime }]   │
│        · emit person:trajectory-update                               │
│     b) If present AND same camera → UPDATE exitTime/objectId        │
│        (no broadcast — low-frequency change)                        │
│                                                                      │
│  3. For each crossCameraTransition:                                  │
│     a) Resolve newObjectId via _bboxClose() match on attrObjects    │
│     b) Close last segment: exitTime = transition timestamp          │
│     c) Append new segment: { newCameraId, newObjectId, … }          │
│     d) emit person:trajectory-update  ← meaningful change           │
│     e) emit face:reidentified (existing event, +newObjectId)        │
│                                                                      │
│  4. faceDetObjects carry alias for zero-latency UI label            │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.3 Socket.IO Event: `person:trajectory-update`

Emitted when a person is first detected or changes camera:

```json
{
  "faceId":          "F7",
  "alias":           "P3",
  "firstSeenAt":     1716015540000,
  "lastSeenAt":      1716015620000,
  "currentCameraId": "<camera-B-uuid>",
  "segments": [
    { "cameraId": "<camera-A-uuid>", "objectId": 42, "entryTime": 1716015540000, "exitTime": 1716015610000 },
    { "cameraId": "<camera-B-uuid>", "objectId": 15, "entryTime": 1716015620000, "exitTime": 1716015620000 }
  ]
}
```

### 2.4 REST API: `GET /api/persons/active`

Returns all persons seen in the last 5 minutes (for page-load hydration):

```json
{
  "total": 3,
  "persons": [ <PersonTrajectory>, … ]
}
```

Query param: `?maxAgeMs=300000` (default 5 min)

### 2.5 Updated `face:reidentified` event

Unchanged except now includes `newObjectId` (implemented in previous revision):

```json
{
  "faceId":       "F7",
  "prevCameraId": "<camera-A-uuid>",
  "newCameraId":  "<camera-B-uuid>",
  "newObjectId":  15,
  "similarity":   0.87,
  "timestamp":    1716015620000
}
```

---

## 3. Client-Side Components

| Component | File | Description |
|---|---|---|
| `PersonTrajectory` / `PersonSegment` types | `client/src/types/index.ts` | TypeScript interfaces |
| `usePersonTrajectoryStore` | `client/src/stores/personTrajectoryStore.ts` | Zustand store: `Map<faceId, PersonTrajectory>` |
| Socket listener | `client/src/App.tsx` | Subscribes to `person:trajectory-update`; hydrates store from `/api/persons/active` on mount |
| **Person Trails panel** | `client/src/components/FullscreenCameraView.tsx` | Collapsible section in Detection panel showing persons who visited this camera; timeline arrows `Cam-A → Cam-B ► Cam-C` |
| **Person alias badge** | `client/src/components/FullscreenCameraView.tsx` | `DetectionRow` shows `P3` badge (teal) next to `[F7]` on face detections |

### 3.1 Person Trails Panel — Display Format

```
PERSON TRAILS (2)                                      ▲
 ● P3  [F7]  Camera-A → Camera-B ► Here  87%  2m ago
 ○ P1  [F2]  Entrance → Hallway  ► Here  91%  5m ago
```

- `●` = currently in this camera; `○` = previously visited
- Timeline uses camera names (resolved from cameraStore), falls back to UUID prefix
- `►` marks the current/last camera in the trail
- Segments sorted chronologically; shows last 4 cameras if trail is long
- Clicking a trail entry focuses the camera grid on the current camera

---

## 4. Implementation Files

| File | Change |
|---|---|
| `server/src/services/pipelineManager.js` | Add `_personTrajectory: Map`, `_personAliasCounter`, trajectory update logic in `_processFrame`, `getPersonTrajectories()` method |
| `server/src/index.js` | Add `GET /api/persons/active` route |
| `client/src/types/index.ts` | Add `PersonSegment`, `PersonTrajectory` interfaces |
| `client/src/stores/personTrajectoryStore.ts` | New Zustand store |
| `client/src/App.tsx` | Add `person:trajectory-update` socket listener + hydration fetch |
| `client/src/components/FullscreenCameraView.tsx` | Person Trails panel + alias badge in `DetectionRow` |

---

## 5. Loitering Enhancement

Cross-camera trajectory data enables two additional loitering signals:

### 5.1 Multi-Camera Dwell Aggregation
Total dwell time across all cameras:
```
totalDwell = Σ (segment.exitTime - segment.entryTime) for all segments
```
A person who briefly visits many cameras may not trigger any single-camera loitering alert but accumulates suspicious total dwell.

### 5.2 Return Pattern Detection
If a person's trajectory contains the same `cameraId` more than once (return visit), this can be surfaced as a revisit warning in the Alert panel.

> These enhancements are tracked as Phase-2 items. Phase-1 (implemented) covers trajectory recording and display only.

---

## 6. Scale & Persistence

| Scope | Storage | Notes |
|---|---|---|
| In-process (runtime) | `Map` in PipelineManager | Fast access; rebuilt from DB on server restart |
| DB (`faceTrajectories`) | `lts.json` / MongoDB | Persisted via `_saveFaceTracking()` — debounced 1 s; upsert by faceId; max 5 000 rows |
| Phase-3 (multi-server) | Redis or Qdrant | See §2.3.2 upgrade path in `RFP_LTS2026_Loitering_Tracking_System.md` |

REST endpoints for DB-persisted trajectories:
- `GET  /api/analysis/face-trajectories` — query by faceId / alias / cameraId / from / to / limit
- `DELETE /api/analysis/face-trajectories` — clear all DB records
- MCP tool: `query_face_trajectories` (see `docs/design/Design_LLM_MCP_Server.md`)

---

## 7. Feature Status

| Feature | Status | Notes |
|---|---|---|
| PersonTrajectory data model | ✅ Done | `PersonSegment` + `PersonTrajectory` types |
| Server trajectory tracking | ✅ Done | `_personTrajectory` Map in PipelineManager |
| `person:trajectory-update` event | ✅ Done | Emitted on first detection + camera transition |
| `GET /api/persons/active` | ✅ Done | Query param `maxAgeMs` (in-memory) |
| `usePersonTrajectoryStore` | ✅ Done | Zustand store |
| Socket listener in App.tsx | ✅ Done | + hydration on mount |
| Person Trails panel | ✅ Done | Collapsible, shows trail with camera names |
| Alias badge in DetectionRow | ✅ Done | Teal `P3` chip next to `[F7]` |
| DB persistence (`faceTrajectories`) | ✅ Done | `_saveFaceTracking()` upserts to DB; migration from `face_tracking.json` |
| `GET /api/analysis/face-trajectories` | ✅ Done | DB-persisted query endpoint (FR-CCFR-044) |
| `DELETE /api/analysis/face-trajectories` | ✅ Done | Clear DB records (FR-CCFR-045) |
| MCP tool `query_face_trajectories` | ✅ Done | LLM-accessible trajectory search |
| Multi-camera dwell aggregation | 🔵 Phase-2 | Not yet implemented |
| Return pattern detection | 🔵 Phase-2 | Not yet implemented |

---

## 8. Appearance/Body Re-ID 격차 분석 및 고도화 제안 (Implemented, opt-in — 2026-07-09 코드 구현 완료)

> 2026-07-09 별도 세션에서 실제 구현됨: `appearanceReidService.js`, `qdrantService.js`, `pipelineManager.js#_weightedAppearSim()`. 모델 파일/Qdrant 모두 기본 비활성(opt-in), 장시간 재등장 조회(FR-CCFR-064)는 write만 배선되고 read는 미배선, 정확도 검증 없음(FR-CCFR-065). FR 단위 상세는 `docs/srs/SRS_CrossCamera_Face_Tracking.md` §14, `docs/design/Design_AI_AppearanceReID.md` §12.6 참조.

### 8.1 문제 재정의

§1.1의 "Gallery expiry" 갭은 얼굴 기반 Re-ID(ArcFace)에 한정된 것이었다. 얼굴이 보이지 않는 경우(뒷모습, 마스크 착용, 원거리)를 보완하기 위해 `_clothingAppearSim()`(의상 기반 Re-ID, `Design_AI_AppearanceReID.md`)가 이미 존재하지만, 이는 **실제 Re-ID 임베딩 모델이 없는 RGB 색상 거리 계산일 뿐**이다.

참고 가이드였던 Multi-Camera Tracking Re-ID 가이드(원본 삭제됨, 내용 본 §8에 통합)와 `docs/rfp/ReID_및_색상분석_활용가이드.md`는 공통적으로:
- 색상은 Re-ID의 **보조 신호(20%)**로만 사용해야 하며, 주 신호는 OSNet/FastReID/TransReID 같은 **실제 임베딩 모델(80%)**이어야 한다
- 장시간(1시간 이상) 후 재등장 추적을 위해서는 Feature(임베딩) DB(Vector DB)가 필요하다

현재 시스템은 이 두 조건 모두를 충족하지 못한다 — 색상이 유일한 신호(100%)이고, 의상 갤러리(`_sharedClothingGallery`)는 세션 범위(TTL 5분)로만 유지된다.

### 8.2 제안

1. OSNet-AIN 등 경량 Re-ID 임베딩 모델을 도입하여 `_clothingAppearSim()`의 가중치를 임베딩 80% + 색상 20%로 재조정
2. 기존 MRD 로드맵(Phase 12b, 얼굴 전용 Qdrant)을 재사용해 `appearance_embeddings` 컬렉션을 추가, 장시간 재등장 추적을 지원
3. 검색 API 계층에서는 색상을 Re-ID 임베딩 유사도 계산 전 사전 필터로 활용 (FR-CCFR-066, Design §12.4)
4. 상세 설계: `docs/design/Design_AI_AppearanceReID.md` §12 참조

### 8.3 활용 사례 대비 기존 구현 확인 (2026-07-09)

Multi-Camera Tracking Re-ID 가이드(원본 삭제됨, 내용 본 §8에 통합)가 제시하는 활용 사례 3가지를 현재 구현과 대조한다:

| 가이드 활용 사례 | 현재 구현 대응 |
|---|---|
| 카메라 간 이동 추적 (주차장→출입문→로비) | **이미 구현됨** — §2~§3의 PersonTrajectory/PersonSegment + Person Trails 패널이 정확히 이 시나리오를 표시 (`Camera-A → Camera-B ► Here`) |
| Loitering 대상자 이동경로 분석 (출입구 배회→엘리베이터→복도 재등장) | **이미 구현됨** — 동일 Person Trails 메커니즘, §5 Multi-Camera Dwell Aggregation(Phase-2, 미구현)이 완전한 총 체류시간 합산까지 확장할 계획 |
| 조건 검색 (빨간 상의 + 검은 하의 + 배회 이벤트) | **구현됨(필터 단계만)** — `GET /api/search?types=appearance\|detections&upperColor=&lowerColor=`(FR-CCFR-066, ✅ Done). 원래 §8.2 4번/`PRD_AI_Color_Analysis.md` §8.2가 제안한 `GET /api/events?upperColor=&lowerColor=` 대신 기존 통합검색에 파라미터 추가하는 방식으로 구현됨 — 색상 필터로 후보를 줄인 뒤 Re-ID 임베딩 유사도로 재정렬하는 2단계 중 1단계만 구현(§8.4 참조) |

가이드가 제시하는 활용 사례 중 "카메라 간 이동 추적"과 "이동경로 분석"은 격차가 없다.

### 8.4 `ReID_및_색상분석_활용가이드.md` 최종 정합성 확인 (2026-07-09, 원본 삭제 전)

이 가이드는 §8.1~8.3에서 Multi-Camera Tracking Re-ID 가이드와 함께 근거로만 인용되었을 뿐, 자체 절 단위 확인은 없었다. 가이드의 핵심 절 3개를 재확인한다:

- **§1(색상=보조 Feature), §2(검색 기능)**: 위 §8.1~8.3에서 이미 확인됨 — 80/20 가중치 구현, 색상 사전 필터 구현(1단계만).
- **§3(이벤트 설명/Event Metadata)**: **신규 확인된 격차** — Loitering/Intrusion 알림에 색상 속성이 첨부되지 않는다 (`alertService.js#createAlert()`가 `color`/`cloth` 필드를 저장하지 않음). 상세 격차 분석과 제안은 `docs/design/Design_AI_AppearanceReID.md` §12.7, 요구사항은 `docs/srs/SRS_CrossCamera_Face_Tracking.md` FR-CCFR-067(Proposed, 미구현) 참조. 로드맵: `docs/mrd/MRD_LTS2026.md` §6.4 Phase 12b-5.

이 확인을 마지막으로 원본 가이드 `docs/rfp/ReID_및_색상분석_활용가이드.md`를 삭제한다.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for CrossCamera Face Tracking |
| 1.1 | 2026-06-25 | LTS Engineering Team | §6 Persistence 업데이트 — DB 영속화 완료; §7 Feature Status 업데이트 (Phase-2 항목 완료 표시) |
| 1.2 | 2026-07-09 | Youngho Kim | §8 추가 — Appearance/Body Re-ID 격차 분석 및 OSNet 임베딩 모델 도입 제안 (Proposed, 미구현) |
| 1.3 | 2026-07-09 | Youngho Kim | §8.3 추가 — Multi-Camera 가이드 활용사례(이동추적/이동경로분석) 기존 구현 확인, 색상 검색 API 사전필터 제안(§8.2 4번) — 원본 가이드 삭제 전 최종 반영 확인 |
| 1.4 | 2026-07-09 | Youngho Kim | 원본 가이드 `docs/rfp/Multi_Camera_Tracking_ReID_가이드.md` 삭제 완료 — 내용 전체가 §8에 반영되었음을 확인하고 본 문서 내 인용을 아카이브 표기로 변경 |
| 1.5 | 2026-07-09 | Youngho Kim | 코드 동기화 — §8을 Proposed→Implemented(opt-in)로 갱신 (`appearanceReidService.js`/`qdrantService.js` 구현 확인) |
| 1.6 | 2026-07-09 | Youngho Kim | §8.3 색상 조건 검색 상태 정정(미구현→구현됨, FR-CCFR-066); §8.4 신설 — `ReID_및_색상분석_활용가이드.md` 최종 정합성 확인, 신규 격차(알림 속성 미첨부, Phase 12b-5) 발견, 원본 가이드 삭제 |
