# OPERATIONS GUIDE
# Face Search Condition Sync — 배포 진단 및 Analysis Server Dashboard Face ID 관리

| | |
|---|---|
| Document ID | OPS-FSC-001 |
| Version | 1.0 |
| Status | Active |
| Date | 2026-07-15 |
| Related Design | design/Design_Face_Search_Condition_Sync.md |
| Related SRS | srs/SRS_Face_Search_Condition_Sync.md |
| Related TC | tc/TC_Face_Search_Condition_Sync.md |

---

## 1. 개요

`streaming` + `analysis` 분리 배포에서 얼굴 갤러리(Missing/VIP/General/Blocklist) 등록 정보가 `faceGalleries`/`faceGalleryFaces` 테이블에 저장되는 방식과, 두 서버 간 조건을 동기화하는 `faceSearchConditions.js`/`faceSearchSync.js`의 reconcile 메커니즘을 다룬다. 2026-07-15 이전에는 **streaming과 analysis가 동일 MongoDB 인스턴스를 공유하는 배포**에서 갤러리에 추가한 얼굴이 등록 직후(최대 두 번의 5초 reconcile 주기 이내) 삭제되는 버그가 있었다 — 근본 원인과 수정 내역은 `Design_Face_Search_Condition_Sync.md` §4.1 참고. 이 문서는 운영자가 (1) 자신의 배포가 이 버그의 영향을 받았는지 진단하고, (2) 수정이 실제로 적용되었는지 확인하고, (3) Analysis Server Dashboard에서 Face ID 정보를 추가/수정/삭제하는 방법을 안내한다.

---

## 2. 배포 시나리오와 영향 범위

| 배포 구성 | `DB_TYPE` | `MONGODB_URI` | 버그 영향 |
|---|---|---|---|
| `combined` 단일 서버 | `json` 또는 `mongodb` | (해당 없음 — 단일 프로세스) | **영향 없음** — reconcile 자체가 동작하지 않음 (`SERVER_MODE !== 'streaming'`) |
| `streaming` + `analysis`, 각자 독립 저장소 (`DB_TYPE=json`, 또는 서로 다른 `MONGODB_URI`) | 무관 | 서로 다름 | **영향 없음** — 설계상 가정(§4.1)과 일치하는 구성 |
| `streaming` + `analysis`, **동일 `MONGODB_URI` 공유** | `mongodb` | **동일** | **영향 있음 (수정 전)** — 이 문서가 다루는 케이스 |

공유 MongoDB 구성인지 빠르게 확인:

```bash
# streaming 서버
grep -E '^(DB_TYPE|MONGODB_URI)=' server/.env
# analysis 서버 (SSH 접근 가능한 경우, 별도로 실행)
grep -E '^(DB_TYPE|MONGODB_URI)=' server/.env
# 두 값이 DB_TYPE=mongodb 이고 MONGODB_URI가 동일하면 공유 구성
```

---

## 3. 증상 진단 — "갤러리에 추가한 얼굴이 사라짐"

1. 얼굴을 하나 등록한다 (streaming 대시보드의 Face Gallery 패널, 또는 Analysis Server Dashboard의 "Add condition" 폼 중 어느 쪽이든).
2. 등록 직후 `GET /api/galleries/:id/faces` 로 존재를 확인한다 — 이 시점에는 보통 존재한다 (삭제는 두 번째 reconcile 왕복에서 발생, §4 참고).
3. **11초 이상** 기다린 뒤 다시 조회한다. 사라졌다면 이 버그(수정 전 버전)에 해당한다.
4. 서버 로그에서 `[FaceSearchSync]` 관련 경고나 `[DB:mongo] upsert` 실패 메시지가 없는지도 확인 — 있다면 별개의 네트워크/인증 문제일 수 있다.

---

## 4. 수정 적용 확인

```bash
grep -n "source === 'local'" server/src/services/faceSearchConditions.js
```

`applyReconcile()`의 두 upsert 루프(`faceGalleries`, `faceGalleryFaces`) 각각에서 위 grep이 매치되어야 한다 (총 2곳). 매치되지 않으면 수정이 배포되지 않은 것이다 — `streaming`과 `analysis` **양쪽 프로세스** 모두 이 파일을 갱신해야 한다 (reconcile은 양쪽에서 동일 함수를 실행하므로 한쪽만 고치면 그쪽만 보호되고 반대쪽은 여전히 취약하다).

```bash
node test/api/face_search_condition_sync.test.js
```

`TC-FSC-B-004`/`TC-FSC-B-006`이 SKIP이 아니라 PASS로 나오려면 `ANALYSIS_SERVER_URL`이 실제로 도달 가능해야 한다 (§1.3 Dual-Server Requirement, `TC_Face_Search_Condition_Sync.md`).

---

## 5. Analysis Server Dashboard에서 Face ID 추가/수정/삭제

Analysis Server Dashboard → "Active Face Search" StatCard 클릭 → `FaceSearchConditionPanel` 오버레이:

- **추가**: 상단 폼에 이름 + 갤러리 타입(Missing/VIP/Blocklist/General) + 사진을 입력 후 "Add condition".
- **수정**: 각 얼굴 카드의 ✎ 아이콘 클릭 → 이름/타입/사진(선택)을 인라인으로 변경 후 Save. 내부적으로 `PUT /api/galleries/:galleryId/faces/:faceId`를 호출한다 (`SRS_Face_Search_Condition_Sync.md` FR-FSC-025).
- **삭제**: 각 얼굴 카드의 ✕ 아이콘 클릭 — 확인 대화상자 없이 즉시 삭제된다 (streaming 대시보드의 `FaceGalleryTab`과 동일한 동작).

세 동작 모두 `/api/galleries` 라우터가 모든 `SERVER_MODE`에 무조건 마운트되어 있으므로 analysis 서버에서도 즉시 동작하며, 별도의 `analysisApi.js`/프록시 설정이 필요 없다.

---

## Revision History

| 버전 | 날짜 | 변경 내용 |
|---|---|---|
| 1.0 | 2026-07-15 | 초기 작성 — 공유 MongoDB reconcile 데이터 손실 버그 진단/검증 절차, Analysis Server Dashboard Face ID 추가/수정/삭제 사용법 |
