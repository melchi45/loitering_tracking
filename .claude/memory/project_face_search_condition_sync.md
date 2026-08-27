---
name: project-face-search-condition-sync
description: "얼굴 등록 위임 + Face Search Condition 동기화; 2026-07-15에 공유 MongoDB reconcile 데이터손실 버그 수정 + Analysis Dashboard Edit/Delete 추가. analysis 서버(192.168.214.254) 배포 상태 매 세션 재확인 필요"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2f83e181-0882-4f7f-b4b6-0e571cd3cfe5
---

2026-07-08, `POST /api/galleries/:id/faces`가 `SERVER_MODE=streaming`에서 "Face service not available" 503을 반환하는 버그를 수정하고, Analysis Server Dashboard에 얼굴 검색 조건(VIP/Blocklist/Missing/General) 가시성을 추가했다. 커밋 `1ce33e4`, `origin/main`에 push 완료.

**핵심 발견 (재조사 시 참고):** 실시간 카메라 얼굴 매칭(named-gallery 대조)은 streaming+analysis 분산 모드에서 이미 정상 동작하고 있었다 — analysis 서버가 `/api/analysis/frame` 응답의 `detectedFaces`에 임베딩을 그대로 포함해 반환하고, streaming 서버 자체의 `pipelineManager._assignFaceIds()`가 로컬 `_persistentGallery`로 매칭한다. 실제 버그는 등록 사진의 detect+embed 단계뿐이었다 (streaming에 로컬 ONNX 모델이 없어서).

**구현 내용:**
- `server/src/services/faceEnrollHelper.js` — 공용 detect+embed+썸네일 로직
- `POST /api/analysis/face-embed` (analysisApi.js) — 위임 수신 엔드포인트
- `AnalysisClient.extractFaceEmbedding()` — 위임 호출
- `faceGallery.js` — local 모델 없으면 위임, `source:'local'|'synced'` 태그
- `faceSearchConditions.js`/`faceSearchSync.js` — push(변경 시)+poll(5초) 풀스냅샷 동기화, 새 DB 테이블 없이 기존 `faceGalleries`/`faceGalleryFaces` 재사용
- `pipelineManager.reloadPersistentGallery()`에 10초 self-refresh 추가 (공유 Mongo에서 다른 프로세스가 쓴 변경 반영용)
- `AnalysisServerDashboard.tsx`에 "Active Face Search" StatCard + `FaceSearchConditionPanel.tsx` 드릴다운(조건 추가 폼 포함)
- 문서 전체 세트(`docs/mrd|rfp|prd|srs|design|ops|tc/*Face_Search_Condition_Sync*`), `test/api/face_search_condition_sync.test.js` (`streamingOnly`), 양쪽 `SUITES` 배열 등록

**Why:** 사용자가 스트리밍 서버 로컬 대시보드에서 실종자/VIP 등 얼굴을 바로 등록할 수 있어야 하고, GPU analysis 서버 운영자도 자신이 무엇을 검색 중인지 자기 대시보드에서 확인할 수 있어야 한다는 요구였음. 매칭 엔진 중복 방지를 위해 analysis 쪽은 표시 전용 미러로만 설계.

**남은 제약 — 다음 세션에서 확인 필요:** analysis 서버(`192.168.214.254:3443`)는 이 리포지토리와 별도 물리 머신이라 이번 세션에서 코드를 배포/재시작하지 못했다. streaming 서버(local, 192.168.214.3)만 재시작해 검증했고, `pushReconcile`이 analysis 서버에 404로 실패하는 것(엔드포인트 아직 없음)을 로그로 확인해 배선 자체는 정상임을 검증했다. **analysis 서버에도 동일 커밋을 배포하고 재시작해야** `/api/analysis/face-embed` 위임과 대시보드 카운트가 실제로 동작한다. 관련: [[project_loitering_missing_person_troubleshooting]]

---

## 2026-07-15 업데이트 — 공유 MongoDB reconcile 데이터손실 버그 수정 + Analysis Dashboard Edit/Delete

**증상:** 사용자가 streaming 대시보드 Face Gallery(Missing/VIP/General/Blocklist)에 얼굴을 추가해도 DB에 저장되지 않는 것처럼 보이고, 서버 재시작 시 전부 사라진다고 보고.

**근본 원인 (코드 추적으로 확정, 실행 재현은 아님):** `server/.env`가 `DB_TYPE=mongodb`로 streaming/analysis가 **동일 `MONGODB_URI`를 공유**하는 구성일 때, `faceSearchConditions.js#applyReconcile()`이 상대방의 push를 반영하며 `db.findOne(table, {id})`으로 찾은 행이 실제로는 "자기 자신이 방금 만든 바로 그 물리 행"인데도 무조건 `source:'synced'`로 덮어썼다. 그 결과 다음 reconcile 왕복(최대 2회, ~10초)에서 `exportLocal()`이 그 행을 자기 것으로 인식하지 못해 제외하고, delete-sweep이 삭제해버림. `TC-FSC-B-004`가 한 번의 왕복만 기다리고 `source` 태그를 검사하지 않아 이 버그를 잡지 못했었다.

**수정:** `applyReconcile()`의 upsert 루프 두 곳(`faceGalleries`, `faceGalleryFaces`) 모두에 `if (existing && existing.source === 'local') continue;` 가드 추가. `TC-FSC-B-004`는 2회 왕복(~11초) 대기 + `source` 필드 검증으로 강화, `TC-FSC-B-006` 신규 추가.

**추가 기능:** `PUT /api/galleries/:id/faces/:faceId` 신규(이름/갤러리·타입 재배정/사진 교체) + `FaceSearchConditionPanel.tsx`(Analysis Server Dashboard)에 Edit/Delete 컨트롤 — 기존엔 add-only였음.

**문서:** 새 문서 세트를 만들지 않고 기존 `docs/mrd|rfp|prd|srs|design|tc/*Face_Search_Condition_Sync*`를 버전업(v1.0/1.1→1.1/1.2)했다 — 이 저장소 관례상 기존 기능의 버그 수정/확장은 새 문서가 아니라 같은 문서의 리비전 추가로 처리한다. `docs/ops/Face_Search_Condition_Sync_Guide.md`는 이번에 신규 작성(이전 메모의 "ops 세트 완료" 서술은 부정확했음 — 실제로는 없었다).

**재사용 가능한 교훈 (향후 cross-server 동기화 코드 작성 시 필수 점검):** 두 프로세스가 물리적으로 같은 DB(같은 MongoDB URI, 같은 컬렉션)를 공유할 수 있는 배포 토폴로지가 존재한다면, "상대방으로부터 받은 걸로 보이는 id"가 사실은 "내가 방금 쓴 바로 그 행"일 수 있다는 것을 반드시 가정하고 테스트해야 한다. 독립 저장소 가정만으로 짠 reconcile/mirror 로직(태그를 덮어쓰고 태그 기준으로 삭제하는 패턴)은 공유 DB 배포에서 조용히 데이터를 파괴한다. missing-person sync 등 향후 유사한 cross-server 미러링 기능을 추가할 때 이 패턴을 먼저 점검할 것.

**남은 제약 (기존과 동일 + 갱신):** 이번 수정도 streaming 로컬 저장소에만 적용됐다 — analysis 서버(`192.168.214.254`)가 별도 물리 머신이면 **거기에도 동일 커밋을 배포해야** 버그가 실제로 해소된다 (reconcile은 양쪽에서 같은 함수를 실행하므로 한쪽만 고치면 그쪽만 보호되고 반대쪽은 여전히 취약함 — 위 "재사용 가능한 교훈" 참고). 다음 세션에서 배포 여부를 먼저 확인할 것.
