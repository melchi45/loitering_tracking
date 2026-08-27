---
name: project-mongo-snapshot-archive-incident
description: "2026-07-20 루트 디스크 100% 소진 인시던트 — MongoDatabase의 TABLE_ROW_CAPS가 in-memory mirror만 자르고 실제 MongoDB는 무한 증가하던 버그와 수정 내용"
metadata:
  type: project
  originSessionId: 3cb80be0-4aac-44ae-bb25-270ed1bcbae4
---

2026-07-20, 루트 파티션(`/dev/sda1`, mongod dbPath 위치)이 1.5GB/450GB(100%)까지 찼던 인시던트의 원인과 수정.

**근본 원인:** `server/src/db/MongoDatabase.js`의 `insert()`가 `TABLE_ROW_CAPS`(constants.js)를 인메모리 미러(`this._store[table]`)에만 적용하고 실제 MongoDB 컬렉션에서는 초과분을 전혀 삭제하지 않았음. JsonDatabase는 배열 자체가 저장소라 cap이 곧 파일 크기 제한이지만, MongoDatabase에서는 이 등가성이 깨져 있었음. 결과: `detectionSnapshots`(cap 2000) 실제 727만건/38GB, `onvif_snapshots`(cap 2000) 실제 24만건/40GB, `client_webrtc_stats`(cap 5000) 실제 90만건/6.2GB — 3개 컬렉션만 84GB.

**추가로 확인된 것:** 대용량 컬렉션 3개에 `_id`/`id` 외 조회 인덱스가 전혀 없어 cameraId/objectId 필터 조회가 매번 풀스캔이었음. WiredTiger는 `deleteMany`만으로는 디스크 공간을 반환하지 않고 `compact` 커맨드를 돌려야 실제로 반영됨(84GB 논리 삭제 후 `df` 변화 없다가 compact로 78GB 회수 확인).

**수정 내용 (커밋 전, 이 세션에서 적용):**
1. `MongoDatabase.insert()` — cap 초과 시 evicted id를 실제 Mongo에서도 `removeWhere({id:{$in:ids}})`로 삭제 (단, `ARCHIVED_TABLES`에 속한 테이블은 제외).
2. `onvif_snapshots`/`detectionSnapshots`는 [[project_snapshot_archive_service]] 참고 — 개수 기반 즉시삭제 대신 날짜 기반 아카이브(`SNAPSHOT_ARCHIVE_RETENTION_DAYS`, 기본 1일) 후 `storage/archive/`로 덤프 + Mongo 삭제 + compact를 전담.
3. `mongoDbService.js`에 `compact(table)` 함수 추가, connect() 시 두 컬렉션에 `createdAt` 인덱스 자동 생성.

**How to apply:** 앞으로 `TABLE_ROW_CAPS`에 새 테이블을 추가하거나 Mongo 관련 코드를 만질 때, "인메모리 cap = 실제 DB 삭제"라고 가정하지 말 것 — MongoDatabase에서는 명시적으로 확인해야 함. 대용량 컬렉션에 조회 필터 필드 인덱스가 있는지도 항상 같이 점검. `db.stats()`/`collStats`로 실제 건수·용량을 주기적으로 확인하는 습관이 필요 (앱 코드의 cap 설정값을 신뢰하지 말고 실측할 것).
