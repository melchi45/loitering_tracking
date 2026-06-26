# TEST CASES (TC)
# Storage Layer — JSON / MongoDB Persistence

| | |
|---|---|
| **Document ID** | TC-STORAGE-001 |
| **Version** | 1.1 |
| **Status** | Active — amended 2026-05-27 |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_DB_Layer.md |
| **Test Scripts** | test/api/storage_json.test.js · test/integration/storage_mongo.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — JSON Mode: In-Memory Store Operations](#3-test-group-a--json-mode-in-memory-store-operations)
4. [Test Group B — JSON Mode: lts.json Persistence](#4-test-group-b--json-mode-ltsjson-persistence)
5. [Test Group C — MongoDB Mode: Connection Lifecycle](#5-test-group-c--mongodb-mode-connection-lifecycle)
6. [Test Group D — MongoDB Mode: Write Dispatch](#6-test-group-d--mongodb-mode-write-dispatch)
7. [Test Group E — MongoDB Mode: Startup Hydration](#7-test-group-e--mongodb-mode-startup-hydration)
8. [Test Group F — Index Verification](#8-test-group-f--index-verification)
9. [Test Group G — Migration Script](#9-test-group-g--migration-script)
10. [Test Group H — Error Handling & Resilience](#10-test-group-h--error-handling--resilience)
11. [Test Group I — Security](#11-test-group-i--security)
12. [Test Execution Order](#12-test-execution-order)
13. [Pass/Fail Criteria](#13-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | File |
|---|---|---|---|
| Unit | `db.js` in-memory CRUD + JSON I/O (mocked fs) | Jest | `test/api/storage_json.test.js` |
| Unit | `mongoDbService.js` with Mongoose mock | Jest + jest-mock | `test/api/storage_mongo_unit.test.js` |
| Integration | Full MongoDB write-through with live MongoDB instance | Jest + mongodb-memory-server | `test/integration/storage_mongo.test.js` |
| Integration | Migration script end-to-end | Jest + mongodb-memory-server | `test/integration/storage_migration.test.js` |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-STORAGE-001 | TC-C-001, TC-H-001, TC-H-002 |
| FR-STORAGE-002 | TC-A-001 through TC-A-008 |
| FR-STORAGE-003 | TC-E-001 |
| FR-STORAGE-010 | TC-A-001 |
| FR-STORAGE-011 | TC-A-002 |
| FR-STORAGE-012 | TC-A-003 |
| FR-STORAGE-013 | TC-A-004 |
| FR-STORAGE-014 | TC-A-005 |
| FR-STORAGE-015 | TC-A-006 |
| FR-STORAGE-016 | TC-A-007 |
| FR-STORAGE-020 | TC-B-001 |
| FR-STORAGE-021 | TC-B-002 |
| FR-STORAGE-022 | TC-B-003 |
| FR-STORAGE-023 | TC-B-004 |
| FR-STORAGE-030 | TC-C-001 |
| FR-STORAGE-031 | TC-C-002 |
| FR-STORAGE-032 | TC-C-003 |
| FR-STORAGE-033 | TC-E-001 |
| FR-STORAGE-034 | TC-D-001 |
| FR-STORAGE-035 | TC-D-002 |
| FR-STORAGE-036 | TC-D-003 |
| FR-STORAGE-040 | TC-D-004 |
| FR-STORAGE-050 | TC-F-001 |
| FR-STORAGE-051 | TC-F-001 through TC-F-004 |
| FR-STORAGE-052 | TC-F-005 |
| FR-STORAGE-060 | TC-G-001 |
| FR-STORAGE-061 | TC-G-002 |
| FR-STORAGE-062 | TC-G-003 |
| FR-STORAGE-063 | TC-G-004 |
| FR-STORAGE-070 | TC-C-004 |
| FR-STORAGE-071 | TC-C-005 |
| FR-STORAGE-072 | TC-H-003 |
| FR-STORAGE-073 | TC-H-004 |
| FR-STORAGE-074 | TC-H-005 |
| NFR-STORAGE-001 | TC-F-006 |
| NFR-STORAGE-006 | TC-I-001 |
| NFR-STORAGE-007 | TC-I-002 |

---

## 2. Test Environment and Prerequisites

### 2.1 System Requirements

| Component | Version |
|---|---|
| Node.js | >= 18 LTS |
| Jest | >= 29.x |
| mongodb-memory-server | >= 9.x (integration tests) |
| Mongoose | >= 8.x |

### 2.2 Environment Variables for Testing

```dotenv
# JSON mode tests
DB_TYPE=json
STORAGE_PATH=./test/fixtures/storage

# MongoDB mode integration tests (set by test setup)
DB_TYPE=mongodb
MONGODB_URI=mongodb://127.0.0.1:27017   # mongodb-memory-server URI
MONGODB_DB=lts2026_test
```

### 2.3 Test Fixtures

```
test/fixtures/
├── storage/
│   ├── lts_seed.json          ← Seed data for JSON mode tests (5 cameras, 3 zones, 10 events)
│   └── lts_empty.json         ← Empty store skeleton
└── migrate/
    └── lts_migration_seed.json ← Full dataset for migration tests
```

---

## 3. Test Group A — JSON Mode: In-Memory Store Operations

### TC-A-001 — Store Initialisation

| | |
|---|---|
| **ID** | TC-A-001 |
| **SRS Ref** | FR-STORAGE-010 |
| **Priority** | P1 |
| **Type** | Unit |

**Preconditions**: `db.js` loaded fresh with `DB_TYPE=json`.

**Steps**:
1. Require `db.js`.
2. Inspect the internal `store` (or test via `db.prepare('SELECT * FROM cameras').all()`).

**Expected Results**:
- All 7 tables exist: `cameras`, `zones`, `events`, `alerts`, `faceGalleries`, `faceGalleryFaces`, `settings`.
- Each table is an empty array `[]`.

---

### TC-A-002 — `prepare()` SQL Parsing — Valid Patterns

| | |
|---|---|
| **ID** | TC-A-002 |
| **SRS Ref** | FR-STORAGE-011 |
| **Priority** | P1 |
| **Type** | Unit |

**Steps**:
1. Call `db.prepare('SELECT * FROM cameras')`.
2. Call `db.prepare('INSERT INTO zones ...')`.
3. Call `db.prepare('UPDATE events SET ...')`.
4. Call `db.prepare('DELETE FROM alerts WHERE ...')`.

**Expected Results**:
- Each call returns a Statement object with `all`, `get`, `run` functions.
- No exception thrown.

---

### TC-A-003 — `stmt.all()` — Returns Filtered Array

| | |
|---|---|
| **ID** | TC-A-003 |
| **SRS Ref** | FR-STORAGE-012 |
| **Priority** | P1 |
| **Type** | Unit |

**Preconditions**: In-memory `cameras` has 3 rows: camera A (`status: 'streaming'`), camera B (`status: 'stopped'`), camera C (`status: 'streaming'`).

**Steps**:
1. `db.prepare('SELECT * FROM cameras').all({ status: 'streaming' })`.
2. `db.prepare('SELECT * FROM cameras').all()`.
3. `db.prepare('SELECT * FROM cameras').all({ status: 'error' })`.

**Expected Results**:
1. Returns array of length 2 (cameras A and C).
2. Returns array of length 3 (all cameras).
3. Returns empty array `[]`.

---

### TC-A-004 — `stmt.get()` — Returns First Match or null

| | |
|---|---|
| **ID** | TC-A-004 |
| **SRS Ref** | FR-STORAGE-013 |
| **Priority** | P1 |
| **Type** | Unit |

**Preconditions**: In-memory `cameras` has 1 row with `id: 'cam-001'`.

**Steps**:
1. `db.prepare('SELECT * FROM cameras').get({ id: 'cam-001' })`.
2. `db.prepare('SELECT * FROM cameras').get({ id: 'cam-999' })`.

**Expected Results**:
1. Returns the matching row object.
2. Returns `null`.

---

### TC-A-005 — INSERT: Row Added with `createdAt`

| | |
|---|---|
| **ID** | TC-A-005 |
| **SRS Ref** | FR-STORAGE-014 |
| **Priority** | P1 |
| **Type** | Unit |

**Steps**:
1. `db.prepare('INSERT INTO cameras ...').run({ id: 'cam-new', name: 'Test Cam', rtspUrl: 'rtsp://test' })`.
2. Query `db.prepare('SELECT * FROM cameras').get({ id: 'cam-new' })`.

**Expected Results**:
1. Returns `{ changes: 1, lastInsertRowid: 'cam-new' }`.
2. Row exists with `id: 'cam-new'`, `name: 'Test Cam'`, `createdAt` is a valid ISO-8601 timestamp.

---

### TC-A-006 — UPDATE: Only Matching Rows Modified

| | |
|---|---|
| **ID** | TC-A-006 |
| **SRS Ref** | FR-STORAGE-015 |
| **Priority** | P1 |
| **Type** | Unit |

**Preconditions**: Two cameras `cam-001` (status: `streaming`) and `cam-002` (status: `stopped`).

**Steps**:
1. `db.prepare('UPDATE cameras SET ...').run({ _where: { id: 'cam-001' }, status: 'error' })`.
2. Query both cameras.

**Expected Results**:
1. Returns `{ changes: 1 }`.
2. `cam-001.status === 'error'`; `cam-001.updatedAt` is newer than `createdAt`.
3. `cam-002.status === 'stopped'` (unchanged).

---

### TC-A-007 — DELETE: Matching Rows Removed

| | |
|---|---|
| **ID** | TC-A-007 |
| **SRS Ref** | FR-STORAGE-016 |
| **Priority** | P1 |
| **Type** | Unit |

**Preconditions**: `cameras` has 3 rows; `zones` has 5 rows all with `cameraId: 'cam-001'`.

**Steps**:
1. `db.prepare('DELETE FROM zones WHERE ...').run({ cameraId: 'cam-001' })`.
2. Query `db.prepare('SELECT * FROM zones').all({ cameraId: 'cam-001' })`.

**Expected Results**:
1. Returns `{ changes: 5 }`.
2. Returns empty array `[]`.

---

### TC-A-008 — `stmt.all()` with `orderBy` and `limit`

| | |
|---|---|
| **ID** | TC-A-008 |
| **SRS Ref** | FR-STORAGE-012 |
| **Priority** | P2 |
| **Type** | Unit |

**Preconditions**: 10 events with timestamps 1000, 2000, ..., 10000.

**Steps**:
1. Query events with `orderBy: 'timestamp'` and `limit: 3`.

**Expected Results**:
- Returns 3 rows in descending timestamp order: [10000, 9000, 8000].

---

## 4. Test Group B — JSON Mode: lts.json Persistence

### TC-B-001 — `loadFromJson()` Reads Existing File

| | |
|---|---|
| **ID** | TC-B-001 |
| **SRS Ref** | FR-STORAGE-021 |
| **Priority** | P1 |
| **Type** | Unit (mocked fs) |

**Preconditions**: `lts_seed.json` fixture file contains 5 cameras and 3 zones.

**Steps**:
1. Mock `fs.readFileSync` to return `lts_seed.json` content.
2. Call `db.initDb()` in JSON mode.
3. Query all cameras.

**Expected Results**:
- In-memory `cameras` has 5 rows matching the fixture.
- `zones` has 3 rows.

---

### TC-B-002 — `loadFromJson()` — Missing File → Empty Store

| | |
|---|---|
| **ID** | TC-B-002 |
| **SRS Ref** | FR-STORAGE-021 |
| **Priority** | P1 |
| **Type** | Unit (mocked fs) |

**Steps**:
1. Mock `fs.existsSync` to return `false`.
2. Call `db.initDb()` in JSON mode.
3. Query all cameras.

**Expected Results**:
- All tables are empty arrays.
- No exception thrown.

---

### TC-B-003 — `persistJson()` Called on INSERT

| | |
|---|---|
| **ID** | TC-B-003 |
| **SRS Ref** | FR-STORAGE-022, FR-STORAGE-023 |
| **Priority** | P1 |
| **Type** | Unit (mocked fs) |

**Steps**:
1. Spy on `fs.writeFileSync`.
2. `db.prepare('INSERT INTO cameras ...').run({ id: 'cam-x', name: 'X', rtspUrl: 'rtsp://x' })`.

**Expected Results**:
- `fs.writeFileSync` called once with `DB_PATH` and valid JSON string.
- Written JSON contains the new camera row.

---

### TC-B-004 — `persistJson()` Called on UPDATE and DELETE

| | |
|---|---|
| **ID** | TC-B-004 |
| **SRS Ref** | FR-STORAGE-023 |
| **Priority** | P1 |
| **Type** | Unit (mocked fs) |

**Steps**:
1. Spy on `fs.writeFileSync` call count.
2. INSERT one camera (1 write).
3. UPDATE the camera (1 write).
4. DELETE the camera (1 write).

**Expected Results**:
- `fs.writeFileSync` called exactly 3 times.

---

## 5. Test Group C — MongoDB Mode: Connection Lifecycle

### TC-C-001 — Successful Connection

| | |
|---|---|
| **ID** | TC-C-001 |
| **SRS Ref** | FR-STORAGE-030 |
| **Priority** | P1 |
| **Type** | Integration (mongodb-memory-server) |

**Steps**:
1. Start MongoDB in-memory server.
2. Set `DB_TYPE=mongodb`, `MONGODB_URI=<memory-server-uri>`.
3. Call `db.initDb()`.

**Expected Results**:
- `mongoSvc.isConnected()` returns `true`.
- Log contains `[MongoDB] connected →`.
- Server would proceed to listen.

---

### TC-C-002 — `disconnect()` Resets State

| | |
|---|---|
| **ID** | TC-C-002 |
| **SRS Ref** | FR-STORAGE-031 |
| **Priority** | P1 |
| **Type** | Integration |

**Steps**:
1. Connect as in TC-C-001.
2. Call `mongoSvc.disconnect()`.
3. Check `mongoSvc.isConnected()`.

**Expected Results**:
- `isConnected()` returns `false`.

---

### TC-C-003 — `isConnected()` Returns Boolean

| | |
|---|---|
| **ID** | TC-C-003 |
| **SRS Ref** | FR-STORAGE-032 |
| **Priority** | P2 |
| **Type** | Unit |

**Steps**:
1. Before any connection: `mongoSvc.isConnected()`.
2. After successful connection: `mongoSvc.isConnected()`.
3. After `disconnect()`: `mongoSvc.isConnected()`.

**Expected Results**:
1. Returns `false`.
2. Returns `true`.
3. Returns `false`.

---

### TC-C-004 — `DB_TYPE=mongodb` 시 MongoDB 미연결 → 서버 시작 거부

| | |
|---|---|
| **ID** | TC-C-004 |
| **SRS Ref** | FR-STORAGE-070 |
| **Priority** | P1 |
| **Type** | Integration (subprocess) |

**Preconditions**: MongoDB가 실행되지 않은 상태. `MONGODB_URI=mongodb://127.0.0.1:19999/lts` (사용하지 않는 포트).

**Steps**:
1. `DB_TYPE=mongodb`, `MONGODB_URI=mongodb://127.0.0.1:19999/lts`로 서버 프로세스를 `child_process.spawn()`으로 시작.
2. 프로세스가 종료될 때까지 대기 (최대 30 s).
3. 종료 코드와 stderr를 수집.

**Expected Results**:
- 프로세스가 `exit code 1`로 종료된다.
- stderr에 `[FATAL]` 및 `DB_TYPE=mongodb` 문자열이 포함된다.
- stderr에 `process.exit(0)` 또는 `server.listen` 메시지가 **포함되지 않는다** (서버가 실제로 기동되지 않음).

---

### TC-C-005 — `DB_TYPE=mongodb` + `MONGODB_URI` 미설정 → 서버 시작 거부

| | |
|---|---|
| **ID** | TC-C-005 |
| **SRS Ref** | FR-STORAGE-071 |
| **Priority** | P1 |
| **Type** | Integration (subprocess) |

**Preconditions**: `MONGODB_URI` 환경변수 미설정.

**Steps**:
1. `DB_TYPE=mongodb` + `MONGODB_URI` 없이 서버 프로세스 시작.
2. 프로세스 종료 대기 (최대 10 s).
3. 종료 코드와 stderr 수집.

**Expected Results**:
- 프로세스가 `exit code 1`로 종료된다.
- stderr에 `[FATAL]` 및 `MONGODB_URI` 문자열이 포함된다.

---

## 6. Test Group D — MongoDB Mode: Write Dispatch

### TC-D-001 — INSERT Calls `mongoSvc.upsert()`

| | |
|---|---|
| **ID** | TC-D-001 |
| **SRS Ref** | FR-STORAGE-034 |
| **Priority** | P1 |
| **Type** | Integration |

**Preconditions**: Connected to mongodb-memory-server.

**Steps**:
1. `db.prepare('INSERT INTO cameras ...').run({ id: 'cam-001', name: 'Cam 1', rtspUrl: 'rtsp://1' })`.
2. Query MongoDB directly: `mongoSvc model('cameras').findOne({ id: 'cam-001' }).lean()`.

**Expected Results**:
- Document found in MongoDB `cameras` collection.
- `doc.name === 'Cam 1'`.
- `doc._id` exists in MongoDB but is not returned by `loadAll()`.

---

### TC-D-002 — DELETE Calls `mongoSvc.remove()`

| | |
|---|---|
| **ID** | TC-D-002 |
| **SRS Ref** | FR-STORAGE-035 |
| **Priority** | P1 |
| **Type** | Integration |

**Preconditions**: `cam-001` exists in MongoDB.

**Steps**:
1. `db.prepare('DELETE FROM cameras WHERE ...').run({ id: 'cam-001' })`.
2. Query MongoDB for `id: 'cam-001'`.

**Expected Results**:
- Returns `null` — document removed from MongoDB.
- `lts.json` also does not contain `cam-001`.

---

### TC-D-003 — `_isMongo()` Guard — Not Connected

| | |
|---|---|
| **ID** | TC-D-003 |
| **SRS Ref** | FR-STORAGE-036 |
| **Priority** | P1 |
| **Type** | Unit (mock) |

**Steps**:
1. Disconnect MongoDB mid-session (simulate disconnect event).
2. INSERT a new camera.
3. Spy on `mongoSvc.upsert`.

**Expected Results**:
- `mongoSvc.upsert` NOT called.
- `persistJson()` IS called.
- Insert succeeds synchronously.

---

### TC-D-004 — `strict: false` — Extra Fields Stored

| | |
|---|---|
| **ID** | TC-D-004 |
| **SRS Ref** | FR-STORAGE-040 |
| **Priority** | P2 |
| **Type** | Integration |

**Steps**:
1. Insert a camera with an extra field: `{ id: 'cam-001', name: 'X', rtspUrl: 'rtsp://x', customField: 'extra_value' }`.
2. Query MongoDB for `id: 'cam-001'`.

**Expected Results**:
- Document stored with `customField: 'extra_value'` (not rejected by `strict: false` schema).

---

## 7. Test Group E — MongoDB Mode: Startup Hydration

### TC-E-001 — `loadAll()` Overwrites In-Memory Store

| | |
|---|---|
| **ID** | TC-E-001 |
| **SRS Ref** | FR-STORAGE-033 |
| **Priority** | P1 |
| **Type** | Integration |

**Preconditions**:
- `lts.json` has 2 cameras: `cam-A`, `cam-B`.
- MongoDB has 3 cameras: `cam-A` (updated), `cam-B`, `cam-C` (new).

**Steps**:
1. Call `db.initDb()` with `DB_TYPE=mongodb`.
2. Query all cameras from in-memory store.

**Expected Results**:
- In-memory store has 3 cameras: `cam-A` (MongoDB version), `cam-B`, `cam-C`.
- `cam-A` data reflects MongoDB version (not lts.json version).

---

### TC-E-002 — `_id` Not Present in In-Memory Store

| | |
|---|---|
| **ID** | TC-E-002 |
| **SRS Ref** | FR-STORAGE-033, NFR-STORAGE-006 |
| **Priority** | P1 |
| **Type** | Integration |

**Steps**:
1. Run `db.initDb()` → MongoDB hydration.
2. Query `db.prepare('SELECT * FROM cameras').all()`.
3. Inspect returned objects.

**Expected Results**:
- No row has an `_id` field.
- No row has a `__v` field.

---

## 8. Test Group F — Index Verification

### TC-F-001 — Unique Index on `id` — All Collections

| | |
|---|---|
| **ID** | TC-F-001 |
| **SRS Ref** | FR-STORAGE-051 |
| **Priority** | P1 |
| **Type** | Integration |

**Steps**:
1. Connect to mongodb-memory-server.
2. For each of the 7 collections, call `db.collection.listIndexes().toArray()`.

**Expected Results**:
- Each collection has an index on `{ id: 1 }` with `unique: true`.

---

### TC-F-002 — Compound Index on `events`

| | |
|---|---|
| **ID** | TC-F-002 |
| **SRS Ref** | FR-STORAGE-051 |
| **Priority** | P1 |
| **Type** | Integration |

**Steps**:
1. Check indexes on `events` collection.

**Expected Results**:
- Index `{ cameraId: 1, timestamp: -1 }` exists.
- Index `{ createdAt: -1 }` exists.

---

### TC-F-003 — Compound Index on `alerts`

| | |
|---|---|
| **ID** | TC-F-003 |
| **SRS Ref** | FR-STORAGE-051 |
| **Priority** | P1 |
| **Type** | Integration |

**Steps**:
1. Check indexes on `alerts` collection.

**Expected Results**:
- Index `{ cameraId: 1, createdAt: -1 }` exists.
- Index `{ acknowledged: 1 }` exists.

---

### TC-F-004 — Index on `faceGalleryFaces.galleryId`

| | |
|---|---|
| **ID** | TC-F-004 |
| **SRS Ref** | FR-STORAGE-051 |
| **Priority** | P2 |
| **Type** | Integration |

**Steps**:
1. Check indexes on `faceGalleryFaces` collection.

**Expected Results**:
- Index `{ galleryId: 1 }` exists.

---

### TC-F-005 — Events Time-Range Query Uses Index (IXSCAN)

| | |
|---|---|
| **ID** | TC-F-005 |
| **SRS Ref** | FR-STORAGE-052 |
| **Priority** | P1 |
| **Type** | Integration |

**Preconditions**: 1000 events seeded for `cameraId: 'cam-001'` with sequential timestamps.

**Steps**:
1. `await Model('events').find({ cameraId: 'cam-001', timestamp: { $gte: t1, $lte: t2 } }).explain('executionStats')`.

**Expected Results**:
- `executionStats.executionStages.stage === 'IXSCAN'` (not `COLLSCAN`).
- `totalDocsExamined` ≈ number of results (not full collection size).

---

### TC-F-006 — MongoDB Write Latency P99 ≤ 50 ms

| | |
|---|---|
| **ID** | TC-F-006 |
| **SRS Ref** | NFR-STORAGE-001 |
| **Priority** | P2 |
| **Type** | Performance / Integration |

**Steps**:
1. Connect to local MongoDB (same machine as test runner).
2. Insert 1000 cameras in series, recording `Date.now()` before and after each upsert.
3. Calculate P99 of write duration.

**Expected Results**:
- P99 write duration ≤ 50 ms.
- P95 write duration ≤ 30 ms.

---

## 9. Test Group G — Migration Script

### TC-G-001 — Script Runs Without Error

| | |
|---|---|
| **ID** | TC-G-001 |
| **SRS Ref** | FR-STORAGE-060 |
| **Priority** | P1 |
| **Type** | Integration |

**Preconditions**: `lts_migration_seed.json` contains 5 cameras, 3 zones, 10 events.

**Steps**:
1. Set env vars: `MONGODB_URI`, `MONGODB_DB=lts2026_test`, `STORAGE_PATH=./test/fixtures/migrate`.
2. Run `node server/src/scripts/migrateToMongo.js`.
3. Check exit code.

**Expected Results**:
- Exit code `0`.
- Console output includes `[Migration] Done.`.

---

### TC-G-002 — All Documents Migrated

| | |
|---|---|
| **ID** | TC-G-002 |
| **SRS Ref** | FR-STORAGE-061 |
| **Priority** | P1 |
| **Type** | Integration |

**Steps**:
1. After TC-G-001, query each MongoDB collection count.

**Expected Results**:
- `cameras`: 5 documents.
- `zones`: 3 documents.
- `events`: 10 documents.
- All other collections: 0 (empty in seed file).

---

### TC-G-003 — Migration is Idempotent

| | |
|---|---|
| **ID** | TC-G-003 |
| **SRS Ref** | FR-STORAGE-062 |
| **Priority** | P1 |
| **Type** | Integration |

**Steps**:
1. Run migration script (first run).
2. Run migration script again (second run).
3. Query collection counts.

**Expected Results**:
- Collection counts identical after both runs.
- No duplicate documents (total count unchanged).

---

### TC-G-004 — `createdAt` Preserved After Migration

| | |
|---|---|
| **ID** | TC-G-004 |
| **SRS Ref** | FR-STORAGE-063 |
| **Priority** | P1 |
| **Type** | Integration |

**Preconditions**: Seed file camera `cam-001` has `createdAt: "2026-05-01T00:00:00.000Z"`.

**Steps**:
1. Run migration.
2. Query `cameras` collection for `{ id: 'cam-001' }`.

**Expected Results**:
- `doc.createdAt` equals `"2026-05-01T00:00:00.000Z"` (original value preserved).
- `doc.updatedAt` is present (Mongoose timestamp).

---

## 10. Test Group H — Error Handling & Resilience

### TC-H-001 — MongoDB Timeout → JSON Fallback

| | |
|---|---|
| **ID** | TC-H-001 |
| **SRS Ref** | FR-STORAGE-070 |
| **Priority** | P1 |
| **Type** | Unit (mock) |

**Steps**:
1. Mock `mongoSvc.connect` to throw `Error('Server selection timed out')` after 5 s.
2. Call `db.initDb()` with `DB_TYPE=mongodb` and `MONGODB_URI=mongodb://invalid:27017`.
3. Check `mongoSvc.isConnected()`.
4. Perform INSERT on cameras.

**Expected Results**:
- `initDb()` resolves (does not throw).
- `mongoSvc.isConnected()` returns `false`.
- INSERT succeeds; `persistJson()` called; `mongoSvc.upsert` NOT called.

---

### TC-H-002 — `MONGODB_URI` Absent → JSON Fallback

| | |
|---|---|
| **ID** | TC-H-002 |
| **SRS Ref** | FR-STORAGE-071 |
| **Priority** | P1 |
| **Type** | Unit |

**Steps**:
1. Set `DB_TYPE=mongodb` but do NOT set `MONGODB_URI`.
2. Call `db.initDb()`.

**Expected Results**:
- Log contains `[DB] MONGODB_URI not set — falling back to JSON mode`.
- Server continues in JSON mode.
- No MongoDB connection attempt.

---

### TC-H-003 — MongoDB Disconnection During Operation

| | |
|---|---|
| **ID** | TC-H-003 |
| **SRS Ref** | FR-STORAGE-072 |
| **Priority** | P1 |
| **Type** | Integration |

**Steps**:
1. Connect to mongodb-memory-server.
2. Insert a camera (verify MongoDB write).
3. Stop the mongodb-memory-server (simulate disconnect).
4. Insert another camera.

**Expected Results**:
- `_connected` becomes `false` after disconnect event.
- Second insert succeeds (in-memory + JSON).
- `mongoSvc.upsert` NOT called for the second insert.
- Log contains `[MongoDB] disconnected`.

---

### TC-H-004 — MongoDB Reconnection Resumes Writes

| | |
|---|---|
| **ID** | TC-H-004 |
| **SRS Ref** | FR-STORAGE-073 |
| **Priority** | P2 |
| **Type** | Integration |

**Steps**:
1. Connect → Disconnect → Reconnect (restart mongodb-memory-server).
2. Spy on `mongoSvc.upsert`.
3. Insert a camera after reconnect.

**Expected Results**:
- `_connected` becomes `true` after reconnect event.
- `mongoSvc.upsert` IS called.
- Log contains `[MongoDB] reconnected`.

---

### TC-H-005 — Graceful Shutdown Calls `disconnect()`

| | |
|---|---|
| **ID** | TC-H-005 |
| **SRS Ref** | FR-STORAGE-074 |
| **Priority** | P1 |
| **Type** | Unit (mock) |

**Steps**:
1. Spy on `mongoSvc.disconnect`.
2. Emit `process.emit('SIGTERM')`.

**Expected Results**:
- `mongoSvc.disconnect()` called once.

---

## 11. Test Group I — Security

### TC-I-001 — `_id` Never in API Responses

| | |
|---|---|
| **ID** | TC-I-001 |
| **SRS Ref** | NFR-STORAGE-006 |
| **Priority** | P1 |
| **Type** | Integration |

**Steps**:
1. Connect in MongoDB mode with seed data.
2. Call `GET /api/cameras`.
3. Inspect response JSON.

**Expected Results**:
- No camera object in the response has an `_id` field.
- No camera object has a `__v` field.

---

### TC-I-002 — Camera Password Not Logged

| | |
|---|---|
| **ID** | TC-I-002 |
| **SRS Ref** | NFR-STORAGE-007 |
| **Priority** | P1 |
| **Type** | Unit |

**Steps**:
1. Spy on `console.log`, `console.warn`, `console.error`.
2. Insert a camera with `password: 'secret123'`.
3. Simulate MongoDB connection error to trigger error log.

**Expected Results**:
- None of the captured log strings contain `'secret123'`.

---

## 12. Test Execution Order

```
Group A  →  Group B  →  Group C  →  Group D  →  Group E
                                                    │
                             Group F  ←─────────────┘
                                │
                          Group G  →  Group H  →  Group I
```

| Step | Groups | Mode | Tool |
|---|---|---|---|
| 1 | A, B | JSON mode | Jest unit tests (mocked fs) |
| 2 | C | MongoDB mode | Integration (mongodb-memory-server) |
| 3 | D, E | MongoDB mode | Integration |
| 4 | F | MongoDB mode | Integration |
| 5 | G | Migration | Integration |
| 6 | H | Both modes | Unit + Integration |
| 7 | I | MongoDB mode | Integration |

---

## 13. Pass/Fail Criteria

### 13.1 Individual Test Pass Criteria

A test case PASSES if:
- All expected results are met.
- No unhandled exceptions thrown.
- Async tests resolve within 10 seconds (30 seconds for performance tests).

A test case FAILS if:
- Any expected result is not met.
- An unhandled exception is thrown.
- The test times out.

### 13.2 Suite-Level Pass Criteria

| Criterion | Requirement |
|---|---|
| P1 test pass rate | 100% (all priority-1 tests must pass) |
| P2 test pass rate | ≥ 80% |
| Line coverage (`db.js` + `mongoDbService.js`) | ≥ 80% |
| Performance (TC-F-006) | P99 ≤ 50 ms |
| Security (TC-I-001, TC-I-002) | 100% (no failures allowed) |

### 13.3 Blocking Defects

The following test failures are blocking for production release:

- TC-A-005 (INSERT correctness)
- TC-B-003 (JSON persistence on write)
- TC-C-001 (MongoDB connection)
- TC-D-001 (MongoDB write dispatch)
- TC-E-001 (Startup hydration)
- TC-F-001 (Unique index)
- TC-F-005 (Index usage — IXSCAN)
- TC-H-001 (MongoDB timeout fallback)
- TC-I-001 (`_id` not exposed)
- **TC-J-001 (v1.1) Atomic write — `lts.json` valid JSON after crash**
- **TC-J-002 (v1.1) Write debounce — ≤ 1 write per 2 s window**
- **TC-J-003 (v1.1) `flushNow()` called before `httpServer.close()`**

---

## Group J — Atomic Write & Debounce (v1.1)

Covers **NFR-STORE-015**, **NFR-STORE-016**, **NFR-STORE-017**.

### TC-J-001 — `lts.json` Valid After SIGKILL Mid-Write

| Field | Value |
|---|---|
| **Pre-condition** | Server running in JSON mode; active `db.insert()` traffic |
| **Steps** | 1. Identify server PID: `pgrep -f "node.*index.js"`. 2. Issue `kill -9 <PID>` during an active write cycle (repeat until observed). 3. Run: `node -e "JSON.parse(require('fs').readFileSync('server/storage/lts.json', 'utf8'))"`  |
| **Expected** | Command exits 0; output is valid JSON; no `SyntaxError` thrown |
| **Not Expected** | `lts.json` is truncated, empty, or contains partial JSON |
| **Covers** | NFR-STORE-015 |

### TC-J-002 — Temp File Cleaned Up After Write Error

| Field | Value |
|---|---|
| **Pre-condition** | Server running in JSON mode |
| **Steps** | 1. Make `server/storage/` read-only: `chmod 555 server/storage/`. 2. Trigger `db.insert()`. 3. Restore: `chmod 755 server/storage/`. 4. Check for orphaned `.tmp` file. |
| **Expected** | `lts.json.tmp` does NOT exist after the failed write attempt; error logged to console |
| **Covers** | NFR-STORE-015 |

### TC-J-003 — Write Debounce Limits Disk Writes

| Field | Value |
|---|---|
| **Pre-condition** | `PERSIST_DEBOUNCE_MS = 2000` (default); server running |
| **Steps** | 1. Run `inotifywait -m -e close_write server/storage/lts.json &`. 2. Issue 100 rapid `POST /api/snapshots` or internal `db.insert()` calls within a 300 ms window. 3. Count `close_write` events over the next 3 seconds. |
| **Expected** | ≤ 1 `close_write` event within the 3-second window |
| **Covers** | NFR-STORE-016 |

### TC-J-004 — `flushNow()` Before `httpServer.close()`

| Field | Value |
|---|---|
| **Pre-condition** | Server running; at least one pending debounced write (issued insert within last 1 s) |
| **Steps** | 1. Send `SIGTERM`. 2. Capture server stdout/stderr. 3. Check log order. |
| **Expected** | Log line from `_flushJson()` appears before log line from `httpServer.close()` callback |
| **Covers** | NFR-STORE-017 |

### TC-J-005 — Data Survives Graceful Shutdown

| Field | Value |
|---|---|
| **Pre-condition** | Server running |
| **Steps** | 1. Insert 5 records via `POST /api/events` (or `db.insert` calls). 2. Send `SIGTERM`. 3. Wait for process exit. 4. Restart server. 5. `GET /api/events` or `GET /api/search?q=test` |
| **Expected** | All 5 records are present after restart |
| **Covers** | NFR-STORE-017 |

### TC-J-006 — `faceMatchHistory` Persisted and Hydrated

| Field | Value |
|---|---|
| **Pre-condition** | Server running; `faceMatchHistory` table in `ALL_TABLES` |
| **Steps** | 1. Trigger a face match (or directly call `db.insert('faceMatchHistory', {...})`). 2. Restart server gracefully. 3. `GET /api/search?q=face&types=matches` or inspect `db.all('faceMatchHistory')` |
| **Expected** | Face match record appears in response after restart; `faceMatchHistory` array is non-empty |
| **Covers** | NFR-STORE-015, SRS §15.3 |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for DB Layer (JSON/MongoDB backends) |
| 1.2 | 2026-06-26 | LTS Engineering Team | TC-C-004, TC-C-005 추가: DB_TYPE=mongodb 시 MongoDB 미연결/MONGODB_URI 미설정 → process.exit(1) 검증 |
