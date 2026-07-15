---
name: cross-camera-face-reid
description: "LTS-2026 얼굴 인식 및 크로스 카메라 Re-ID 개발. Use when: 얼굴 등록/검색 기능 구현, 크로스 카메라 동일인 추적, 얼굴 임베딩 벡터 유사도 조정, Face ID 사이드바 UI 수정, 개인정보 보호 마스킹 설정, 얼굴 인식 정확도 개선, 미등록 인물 알림 설정, GDPR 감사 로그 구성, Appearance/Body Re-ID(OSNet, opt-in) 조정, Qdrant 벡터 DB 연동. Covers: faceService.js, appearanceReidService.js, qdrantService.js, Design_Face_Recognition, Design_CrossCamera_Face_Tracking, Design_AI_AppearanceReID, Face ID sidebar component."
argument-hint: "작업 유형 (예: face-registration, reid-threshold, privacy-masking, face-search)"
---

# Cross-Camera Face Re-ID

## 얼굴 인식 파이프라인

```
감지된 person 바운딩 박스
  └─► faceService.js
        ├─► 얼굴 영역 크롭 + 정렬
        ├─► 임베딩 벡터 추출 (512-d)
        ├─► MongoDB face_embeddings 컬렉션과 코사인 유사도 비교
        │     ├─► 일치(threshold 초과) → 등록된 ID 연결
        │     └─► 불일치 → 미등록 인물 임시 ID 부여
        └─► crossCameraTracking → 카메라 간 동선 연결
```

## 핵심 파일 위치

| 파일 | 역할 |
|---|---|
| `server/src/services/faceService.js` | 얼굴 감지·임베딩·검색·등록 전체 로직 |
| `storage/face_tracking.json` | 로컬 얼굴 추적 데이터 (MongoDB 미사용 시) |
| `client/src/components/` | Face ID 사이드바 UI (등록·검색·결과 표시) |
| `server/src/services/mongoDbService.js` | 얼굴 임베딩 벡터 인덱스(Atlas Vector Search) |
| `server/src/services/appearanceReidService.js` | CrossCamera Phase-2 Appearance/Body Re-ID — OSNet 256D 임베딩, opt-in (모델 파일 미배포 시 자동 비활성) |
| `server/src/services/qdrantService.js` | Qdrant 벡터 DB 클라이언트 — `face_embeddings`/`appearance_embeddings` 컬렉션, 서킷브레이커, opt-in (`QDRANT_ENABLED=true`) |
| `server/src/services/pipelineManager.js` | `_weightedAppearSim()` — OSNet 임베딩 80% + 색상 20% 가중 유사도, 모델 미로딩 시 Phase-1 색상 전용으로 자동 폴백 |
| `server/src/services/faceSearchConditions.js` | Face Search Condition 요약/목록/reconcile 적용 — `applyReconcile()`은 streaming↔analysis 양쪽에서 동일 함수 실행, `source:'local'` 행은 절대 재태깅 금지 (§ 아래 "공유 MongoDB reconcile 버그" 참조) |
| `server/src/services/faceSearchSync.js` | streaming→analysis 갤러리/얼굴 스냅샷 push(변경 즉시)+poll(5초) |
| `server/src/api/faceGallery.js` | `/api/galleries` CRUD — `PUT /:id/faces/:faceId`(이름/갤러리·타입 재배정/사진 교체) 포함, 모든 `SERVER_MODE`에 무조건 마운트 |
| `client/src/components/FaceSearchConditionPanel.tsx` | Analysis Server Dashboard 전용 Face Search Condition 상세·추가·수정·삭제 오버레이 |

## 주요 작업 절차

### 얼굴 등록
```http
POST /api/faces/register
Content-Type: multipart/form-data

{
  "image": <file>,
  "name": "홍길동",
  "personId": "EMP001",
  "metadata": { "department": "보안팀", "accessLevel": "A" }
}
```
1. `faceService.js`에서 임베딩 추출 후 MongoDB에 저장
2. `GET /api/faces/:id` 로 등록 확인
3. 대시보드 Face ID 사이드바에서 즉시 반영 확인

### Re-ID 유사도 임계값 조정
1. `server/src/services/faceService.js` 열기
2. `similarityThreshold` 값 수정 (기본값: `0.6`):
   - 값 낮춤 → 더 관대한 매칭 (오탐 증가 가능)
   - 값 높임 → 더 엄격한 매칭 (미탐 증가 가능)
3. 변경 후 `test/` 얼굴 테스트 케이스로 검증

### 크로스 카메라 동선 조회
```http
GET /api/faces/:personId/tracking?startTime=2026-06-01T00:00:00Z&endTime=2026-06-01T23:59:59Z
```
- MCP 도구: `mcp_lts_get_tracking_history`
- 반환 데이터: 카메라 ID별 출현 시각·좌표 시계열

### 얼굴 검색 (스냅샷 기반)
```http
POST /api/faces/search
Content-Type: multipart/form-data

{ "image": <query_face_image>, "topK": 5 }
```
- 유사도 상위 K명 반환 (등록된 인물 + 임시 ID)

### 개인정보 마스킹 설정
1. `server/src/services/faceService.js`에서 `privacyMode` 옵션 확인
2. `blurFaces: true` 설정 시 미등록 인물 얼굴 블러 처리
3. GDPR 감사 로그: `server/src/services/AuditService.js` 로그 출력 확인

### Cross-Camera Re-ID 피드 영속성 (v1.2 버그 수정, 2026-07-02)

> Streaming Dashboard DETECTIONS 패널의 "Cross-Camera Re-ID" 이력이 사라지는 버그가
> 있었습니다 (`client/src/stores/crossCameraStore.ts`). 원인과 재발 방지 규칙:

1. **시간 기반 만료(prune) 절대 사용 금지** — `crossCameraStore.ts`/`clothingReIdStore.ts`는
   과거 `EXPIRY_MS = 60_000`으로 60초 지난 항목을 매 `addEvent()` 호출마다 필터링했습니다.
   AI 분석 서버가 60초 이상 응답이 없으면(회로차단기 open 등) 다음 이벤트 수신 시
   기존 이력이 전부 사라지는 것이 실제 원인이었습니다. **"history/log/feed" 성격의 패널은
   반드시 개수(`MAX_EVENTS`) 기반으로만 캡핑하고, 시간 기반 만료를 두지 않습니다.**
2. **마운트 시 DB hydration 필수** — `useCrossCameraStore`는 `usePersonTrajectoryStore`와
   달리 마운트 시 서버에서 이력을 가져오지 않아 새로고침마다 빈 목록으로 시작했습니다.
   `App.tsx`에서 `GET /api/analysis/face-trajectories?limit=100` 호출 후 트랜지션
   (`segments[i-1] → segments[i]`)을 `CrossCameraReIdEvent[]`로 재구성해 `hydrate()`에
   전달하도록 수정했습니다. 신규 "이력형" Zustand 스토어를 추가할 때는 이 패턴
   (`hydrate` 액션 + `App.tsx` `useEffect` fetch)을 반드시 함께 구현하세요.
3. **`PersonSegment.similarity` 필드** — 위 hydration이 신뢰도(%)까지 재구성할 수 있도록
   `pipelineManager.js`가 세그먼트 생성/추가 시 `similarity: ev.similarity`를 함께 저장하고
   `_upsertTrajectoryToDb()`/`_saveFaceTracking()`이 이를 DB/JSON 백업에 영속화합니다.

> 상세 설계: `docs/design/Design_CrossCamera_Face_Tracking.md` §4.6 참조.

### Face Search Condition Sync — 공유 MongoDB reconcile 데이터 손실 버그 수정 (2026-07-15)

> streaming↔analysis가 `DB_TYPE=mongodb`로 **동일 `MONGODB_URI`를 공유**하는 배포에서, 갤러리에
> 등록한 얼굴이 등록 직후(최대 두 번의 5초 reconcile 왕복 이내) 삭제되는 버그가 있었습니다
> (`faceSearchConditions.js#applyReconcile`). 원인과 재발 방지 규칙:

1. **`applyReconcile()`은 `source:'local'` 행을 절대 재태깅해서는 안 됩니다** — 이 함수는
   streaming/analysis 양쪽에서 동일하게 실행되는데, 두 서버가 같은 물리 MongoDB를 공유하면
   `db.findOne(table, {id})`이 "상대 서버의 행"이 아니라 **자기 자신이 방금 만든 바로 그 행**을
   찾아냅니다. 기존 코드는 이를 구분하지 않고 무조건 `source:'synced'`로 덮어썼고, 그 결과
   다음 왕복에서 `exportLocal()`이 그 행을 제외하게 되어 이후 delete-sweep이 삭제해버렸습니다.
   수정: upsert 직전 `existing.source === 'local'`이면 upsert를 완전히 건너뜁니다.
2. **cross-server 미러링/reconcile 코드를 새로 추가할 때는 반드시 "두 프로세스가 같은
   물리 저장소를 공유하는 배포"를 가정하고 테스트하세요** — 독립 저장소 가정만으로는
   이런 종류의 버그를 잡을 수 없습니다 (`TC-FSC-B-004`가 독립 저장소 가정 하의 단일 왕복
   검증만 하다가 이 버그를 놓쳤던 사례 참고).
3. **`PUT /api/galleries/:id/faces/:faceId`** (2026-07-15 신규) — 이름 변경, 갤러리/타입
   재배정, 사진 교체(재임베딩)를 지원하며 `POST /:id/faces`와 동일한 로컬/위임 이중 경로를
   재사용합니다. `FaceSearchConditionPanel.tsx`(Analysis Server Dashboard)에 Edit/Delete
   컨트롤로 노출되어, 기존에는 add-only였던 그 패널에 `FaceGalleryTab.tsx`와 동등한
   CRUD가 갖춰졌습니다.

> 상세 설계: `docs/design/Design_Face_Search_Condition_Sync.md` §4.1, `docs/ops/Face_Search_Condition_Sync_Guide.md` 참조.

## 임베딩 데이터 구조

```js
// MongoDB face_embeddings 컬렉션 도큐먼트
{
  personId: "EMP001",
  name: "홍길동",
  embedding: [0.12, -0.34, ...],  // 512차원 float 벡터
  sourceCamera: "cam_01",
  capturedAt: ISODate("2026-06-01T10:00:00Z"),
  metadata: { department: "보안팀" }
}
```

## 주의 사항 (개인정보 보호)
- 얼굴 데이터는 GDPR/개인정보보호법 적용 대상
- `AuditService.js`를 통해 모든 얼굴 검색·등록·삭제 기록 유지
- 동의 없는 얼굴 등록 금지 — 시스템 접근 권한 관리 필수
- 데이터 보존 기간 설정: MongoDB TTL 인덱스로 자동 만료

## 관련 문서 (SDLC 참조)

> 구현·수정 전 아래 문서를 확인하고, **코드 변경 시 해당 문서를 반드시 동기화**하세요.

| 구분 | 문서 |
|------|------|
| RFP | [RFP_AI_Face_Recognition](../../../docs/rfp/RFP_AI_Face_Recognition.md) · [RFP_CrossCamera_Face_Tracking](../../../docs/rfp/RFP_CrossCamera_Face_Tracking.md) · [RFP_Dashboard_Sidebar_Face_ID](../../../docs/rfp/RFP_Dashboard_Sidebar_Face_ID.md) · [RFP_Detection_Snapshot_Search](../../../docs/rfp/RFP_Detection_Snapshot_Search.md) · [RFP_AI_Missing_Person_Detection](../../../docs/rfp/RFP_AI_Missing_Person_Detection.md) · [RFP_Face_Search_Condition_Sync](../../../docs/rfp/RFP_Face_Search_Condition_Sync.md) |
| PRD | [PRD_AI_Face_Recognition](../../../docs/prd/PRD_AI_Face_Recognition.md) · [PRD_CrossCamera_Face_Tracking](../../../docs/prd/PRD_CrossCamera_Face_Tracking.md) · [PRD_Dashboard_Sidebar_Face_ID](../../../docs/prd/PRD_Dashboard_Sidebar_Face_ID.md) · [PRD_Detection_Snapshot_Search](../../../docs/prd/PRD_Detection_Snapshot_Search.md) · [PRD_Face_Search_Condition_Sync](../../../docs/prd/PRD_Face_Search_Condition_Sync.md) |
| SRS | [SRS_AI_Face_Recognition](../../../docs/srs/SRS_AI_Face_Recognition.md) · [SRS_CrossCamera_Face_Tracking](../../../docs/srs/SRS_CrossCamera_Face_Tracking.md) · [SRS_Dashboard_Sidebar_Face_ID](../../../docs/srs/SRS_Dashboard_Sidebar_Face_ID.md) · [SRS_Detection_Snapshot_Search](../../../docs/srs/SRS_Detection_Snapshot_Search.md) · [SRS_Face_Search_Condition_Sync](../../../docs/srs/SRS_Face_Search_Condition_Sync.md) |
| Design | [Design_AI_ReID](../../../docs/design/Design_AI_ReID.md) · [Design_AI_AppearanceReID](../../../docs/design/Design_AI_AppearanceReID.md) · [Design_AI_Face_Recognition](../../../docs/design/Design_AI_Face_Recognition.md) · [Design_CrossCamera_Face_Tracking](../../../docs/design/Design_CrossCamera_Face_Tracking.md) · [Design_Dashboard_Sidebar_Face_ID](../../../docs/design/Design_Dashboard_Sidebar_Face_ID.md) · [Design_Detection_Snapshot_Search](../../../docs/design/Design_Detection_Snapshot_Search.md) · [Design_Face_Search_Condition_Sync](../../../docs/design/Design_Face_Search_Condition_Sync.md) |
| TC | [TC_AI_Face_Recognition](../../../docs/tc/TC_AI_Face_Recognition.md) · [TC_CrossCamera_Face_Tracking](../../../docs/tc/TC_CrossCamera_Face_Tracking.md) · [TC_Dashboard_Sidebar_Face_ID](../../../docs/tc/TC_Dashboard_Sidebar_Face_ID.md) · [TC_Detection_Snapshot_Search](../../../docs/tc/TC_Detection_Snapshot_Search.md) · [TC_Face_Search_Condition_Sync](../../../docs/tc/TC_Face_Search_Condition_Sync.md) |
| Ops | [Face_Search_Condition_Sync_Guide](../../../docs/ops/Face_Search_Condition_Sync_Guide.md) |

## 코드 수정 시 문서 동기화 의무

| 변경 파일 | 업데이트 필요 문서 |
|-----------|------------------|
| `faceService.js` (임베딩·검색·등록) | `docs/design/Design_AI_Face_Recognition.md`, `docs/srs/SRS_AI_Face_Recognition.md`, `docs/tc/TC_AI_Face_Recognition.md` |
| `faceService.js` (유사도 임계값 변경) | `docs/srs/SRS_AI_Face_Recognition.md` 정확도 요구사항 + `docs/tc/TC_AI_Face_Recognition.md` 경계값 케이스 |
| `mongoDbService.js` (Vector Search 인덱스) | `docs/design/Design_CrossCamera_Face_Tracking.md`, `docs/design/Design_DB_Layer.md` |
| `AuditService.js` (감사 로그 범위) | `docs/srs/SRS_AI_Face_Recognition.md` 개인정보 섹션 |
| `snapshotService.js` | `docs/design/Design_Detection_Snapshot_Search.md`, `docs/tc/TC_Detection_Snapshot_Search.md` |
| `FaceGalleryTab.tsx` | `docs/design/Design_Dashboard_Sidebar_Face_ID.md`, `docs/tc/TC_Dashboard_Sidebar_Face_ID.md` |
| 개인정보 마스킹 정책 변경 | `docs/srs/SRS_AI_Face_Recognition.md` GDPR 섹션 + `docs/design/Design_AI_Face_Recognition.md` |
| `crossCameraStore.ts` / `clothingReIdStore.ts` (만료·hydration 로직) | `docs/design/Design_CrossCamera_Face_Tracking.md` §4.6 — 시간 기반 만료 재도입 금지, hydrate() 패턴 유지 확인 |
| `appearanceReidService.js` / `qdrantService.js` / `pipelineManager.js#_weightedAppearSim()` | `docs/design/Design_AI_AppearanceReID.md` §12.6, `docs/srs/SRS_CrossCamera_Face_Tracking.md` §14 (FR-CCFR-060~066) — 2026-07-09 opt-in 구현 완료; 장시간 재등장 Qdrant 조회(kNN)는 아직 미배선(write만 존재)이므로 이 부분을 구현할 경우 FR-CCFR-064 상태를 Done으로 갱신할 것 |
| `faceSearchConditions.js#applyReconcile()` (reconcile 태깅/삭제 로직 변경) | `docs/design/Design_Face_Search_Condition_Sync.md` §4/§4.1, `docs/srs/SRS_Face_Search_Condition_Sync.md` FR-FSC-017, `docs/tc/TC_Face_Search_Condition_Sync.md` TC-FSC-B-004/B-006 — 공유 MongoDB 배포 시나리오로 반드시 재검증 |
| `faceGallery.js`의 `PUT /:id/faces/:faceId` (편집 필드 추가/변경) | `docs/srs/SRS_Face_Search_Condition_Sync.md` FR-FSC-025, `docs/tc/TC_Face_Search_Condition_Sync.md` Group D |

**공통 규칙**
- **새 기능 추가** → PRD + SRS + Design + TC 문서 모두 추가
- **임베딩 모델 교체** → Design 아키텍처 다이어그램 + SRS 성능·정확도 요구사항 + TC 갱신
- **개인정보 처리 변경** → SRS GDPR 섹션 필수 업데이트 (법적 요구사항)
- **Atlas Vector Search 인덱스 변경** → `docs/design/Design_DB_Layer.md` 인덱스 명세 업데이트
