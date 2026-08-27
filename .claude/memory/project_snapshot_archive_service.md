---
name: project-snapshot-archive-service
description: "snapshotArchiveService.js — onvif_snapshots/detectionSnapshots 날짜 기반 보관 서비스 (2026-07-20 신규)"
metadata:
  type: project
  originSessionId: 3cb80be0-4aac-44ae-bb25-270ed1bcbae4
---

`server/src/services/snapshotArchiveService.js` (2026-07-20 신규) — [[project_mongo_snapshot_archive_incident]]의 후속 조치로, 사용자 요청("MongoDB 저장 한계를 날짜로 설정, 이전 데이터는 server storage로 백업")에 따라 구현.

**동작:** `onvif_snapshots`(카메라 이벤트 프레임), `detectionSnapshots`(AI 탐지 crop 이미지) 두 컬렉션 대상, `SNAPSHOT_ARCHIVE_RETENTION_DAYS`(기본 1일, `server/.env`) 경과한 문서를 이미지 blob 포함 전체 그대로 `storage/archive/<table>/<YYYY-MM-DD>.ndjson`(문서 자신의 createdAt 날짜로 버킷팅)에 append한 뒤 MongoDB에서 삭제하고, 배치가 있었으면 `db.runCommand({compact})`까지 수행. 서버 부팅 시 `index.js`에서 `.start()` 호출, 이후 1시간 간격 self-schedule. `DB_TYPE=mongodb`가 아니면 no-op(JsonDatabase는 파일 자체가 cap이라 불필요).

MongoDatabase.js의 `ARCHIVED_TABLES`(`onvif_snapshots`, `detectionSnapshots`)는 이 두 테이블에 한해 개수 기반(`TABLE_ROW_CAPS`) 즉시삭제를 건너뛴다 — burst insert가 아카이브 잡보다 먼저 이미지를 지워버리는 것을 막기 위함. 즉 이 두 테이블의 MongoDB 라이프사이클은 전적으로 이 서비스가 소유한다.

**How to apply:** storage/archive/ 아래 ndjson 파일도 무한정 쌓이므로(디스크는 `/data6`, mongod와 분리되어 있어 급하진 않지만) 장기적으로는 이 파일들에도 별도 보관정책이 필요할 수 있음 — 아직 미구현. 보관 기간을 바꾸려면 `server/.env`의 `SNAPSHOT_ARCHIVE_RETENTION_DAYS`만 수정하면 됨(재시작 필요).
