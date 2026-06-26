# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Storage Layer — JSON / MongoDB Persistence

| | |
|---|---|
| **Document ID** | SRS-STORAGE-001 |
| **Version** | 1.1 |
| **Status** | Active — amended 2026-05-27 |
| **Date** | 2026-05-27 |
| **Parent PRD** | prd/PRD_DB_Layer.md |
| **Parent RFP** | rfp/RFP_DB_Layer.md |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — Dual-Mode Operation](#3-functional-requirements--dual-mode-operation)
4. [Functional Requirements — In-Memory Store](#4-functional-requirements--in-memory-store)
5. [Functional Requirements — JSON Persistence](#5-functional-requirements--json-persistence)
6. [Functional Requirements — MongoDB Persistence](#6-functional-requirements--mongodb-persistence)
7. [Functional Requirements — Collection Schemas](#7-functional-requirements--collection-schemas)
8. [Functional Requirements — Index Management](#8-functional-requirements--index-management)
9. [Functional Requirements — Migration](#9-functional-requirements--migration)
10. [Functional Requirements — Connection Lifecycle](#10-functional-requirements--connection-lifecycle)
11. [Non-Functional Requirements](#11-non-functional-requirements)
12. [Interface Requirements](#12-interface-requirements)
13. [Data Dictionary](#13-data-dictionary)
14. [Constraints & Assumptions](#14-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS specifies all functional and non-functional requirements for the **LTS-2026 Storage Layer**, comprising:

- `server/src/db.js` — in-memory store with SQL-like CRUD abstraction.
- `server/src/services/mongoDbService.js` — Mongoose-based MongoDB adapter.
- `server/src/scripts/migrateToMongo.js` — one-time data migration script.

Each requirement is identified by a unique ID (`FR-STORAGE-NNN` / `NFR-STORAGE-NNN`) traceable to acceptance criteria in [PRD_DB_Layer.md](../prd/PRD_DB_Layer.md).

### 1.2 Scope

This document covers:

- JSON file read/write persistence (`lts.json`).
- MongoDB collection CRUD via Mongoose.
- Dual-mode startup and write-dispatch logic.
- Schema and index definitions for all seven collections.
- Data migration from JSON to MongoDB.
- Connection resilience and error handling.

Out of scope: REST API layer (covered in [SRS_LTS2026_Loitering_Tracking_System.md](SRS_LTS2026_Loitering_Tracking_System.md)), Redis caching, multi-instance synchronisation, encrypted-at-rest storage.

### 1.3 Definitions

| Term | Definition |
|---|---|
| `db.js` | In-memory store with SQL-like `prepare/all/get/run` interface; routes writes to JSON and/or MongoDB |
| `mongoDbService.js` | Mongoose-based MongoDB adapter providing `connect`, `disconnect`, `loadAll`, `upsert`, `remove` |
| in-memory store | Plain JavaScript object `store` keyed by table name, containing arrays of row objects |
| JSON mode | `DB_TYPE=json`; all persistence is synchronous `fs.writeFileSync` to `lts.json` |
| MongoDB mode | `DB_TYPE=mongodb`; all mutations also fire async Mongoose upsert/remove |
| warm-standby | `lts.json` written on every mutation regardless of `DB_TYPE`; allows cold-start without MongoDB |
| hot-standby | MongoDB as the primary durable store; `lts.json` is secondary |
| `loadAll()` | MongoDB query that hydrates the in-memory store on startup |
| upsert | Insert-or-update a document by its `id` field using `updateOne({ id }, { $set }, { upsert: true })` |
| `id` | UUID v4 string; application-level primary key; unique-indexed in MongoDB |
| fire-and-forget | Async MongoDB writes that do not block the caller; errors are logged only |
| `initDb()` | Exported async function in `db.js`; called once at server startup |

---

## 2. System Overview

### 2.1 Storage Layer Position in System Architecture

```
HTTP Route Handlers / Socket.IO Handlers / BehaviorEngine
        │
        │  synchronous calls: db.prepare(sql).run/get/all
        ▼
┌───────────────────────────────────────────┐
│               db.js                        │
│  ┌────────────────────────────────────┐   │
│  │  in-memory store { cameras: [],    │   │
│  │    zones: [], events: [],          │   │
│  │    alerts: [], faceGalleries: [],  │   │
│  │    faceGalleryFaces: [],           │   │
│  │    settings: [] }                  │   │
│  └─────────────┬──────────────────────┘   │
│                │ afterWrite()              │
│  ┌─────────────▼──────────────────────┐   │
│  │  persistJson()     mongoSvc.upsert │   │
│  │  (sync, always)    (async, if Mon) │   │
│  └─────────────────────────────────────┘   │
└───────────────────────────────────────────┘
        │                      │
        ▼                      ▼
   lts.json              MongoDB collections
   (warm-standby)        (durable store)
```

### 2.2 Collections

| Collection | Description |
|---|---|
| `cameras` | IP camera and YouTube stream registrations |
| `zones` | Polygon-based monitoring and exclusion zones |
| `events` | Loitering detection events (highest write rate) |
| `alerts` | Triggered alert records |
| `faceGalleries` | Named face gallery groups |
| `faceGalleryFaces` | Enrolled face records with ArcFace embedding vectors |
| `settings` | System-wide configuration singletons (e.g., face tracking state) |

---

## 3. Functional Requirements — Dual-Mode Operation

### FR-STORAGE-001 — Mode Selection

The system shall read the `DB_TYPE` environment variable at process startup.

- If `DB_TYPE=json` (or absent), the system shall operate in **JSON mode**.
- If `DB_TYPE=mongodb`, the system shall attempt MongoDB connection; on failure it shall fall back to JSON mode.
- No restart is required to switch modes; a process restart with the updated environment variable is sufficient.

**Input**: `process.env.DB_TYPE`  
**Output**: `_mongoMode` internal flag set; storage mode logged at INFO level.

### FR-STORAGE-002 — Unchanged Synchronous API

All calls to `db.prepare(sql).all(params)`, `.get(params)`, and `.run(params)` shall return synchronously in both modes.

**Constraint**: No route handler or service shall be modified when switching `DB_TYPE`.

### FR-STORAGE-003 — Startup Sequencing

`initDb()` shall complete the following in order before `server.listen()` is called:

1. `loadFromJson()` — populate in-memory store.
2. If `DB_TYPE=mongodb`: attempt `mongoSvc.connect()`.
3. If connection succeeds: `mongoSvc.loadAll()` — overwrite in-memory store with MongoDB data.
4. Return resolved Promise.

**Error handling**: If `mongoSvc.connect()` throws, `initDb()` shall log the error and return (JSON mode active); it shall not re-throw.

---

## 4. Functional Requirements — In-Memory Store

### FR-STORAGE-010 — Store Initialisation

On module load, the store object shall be initialised with empty arrays for all seven tables:

```js
let store = {
  cameras: [], zones: [], events: [], alerts: [],
  faceGalleries: [], faceGalleryFaces: [], settings: []
};
```

### FR-STORAGE-011 — `prepare(sql)` Parser

`db.prepare(sql)` shall parse the SQL string to extract:

1. The table name from `FROM`, `INTO`, `UPDATE`, or `TABLE` clauses.
2. The operation type (`SELECT`, `INSERT`, `UPDATE`, `DELETE`).

**Supported SQL patterns**:

| Pattern | Maps to |
|---|---|
| `SELECT * FROM cameras` | `op=select, table=cameras` |
| `INSERT INTO cameras ...` | `op=insert, table=cameras` |
| `UPDATE cameras SET ...` | `op=update, table=cameras` |
| `DELETE FROM cameras ...` | `op=delete, table=cameras` |

Unsupported SQL patterns (JOIN, GROUP BY, aggregations) shall throw an `Error` with a descriptive message.

### FR-STORAGE-012 — `stmt.all(params)` Behaviour

- Shall filter `store[table]` rows where all keys in `params` match the row.
- If `opts.orderBy` is specified, results shall be sorted by that field descending.
- If `opts.limit` is specified, results shall be truncated to that count.
- Shall always return an array (empty array if no matches).

### FR-STORAGE-013 — `stmt.get(params)` Behaviour

- Shall return the first matching row or `null`.

### FR-STORAGE-014 — `stmt.run(params)` — INSERT

- Shall add `{ createdAt: <ISO-8601 now>, ...params }` to `store[table]`.
- Shall call `afterWrite(table, row.id, row, 'insert')`.
- Shall return `{ changes: 1, lastInsertRowid: row.id }`.

### FR-STORAGE-015 — `stmt.run(params)` — UPDATE

- `params` shall contain a `_where` object for row matching.
- All matching rows shall be updated with the non-`_where` fields of `params`.
- `updatedAt` shall be set to `new Date().toISOString()` on each updated row.
- Shall call `afterWrite(table, updated.id, updated, 'update')` per updated row.
- Shall return `{ changes: <count> }`.

### FR-STORAGE-016 — `stmt.run(params)` — DELETE

- Shall remove all rows matching `params` from `store[table]`.
- Shall call `afterDeleteWhere(table, removedIds)`.
- Shall return `{ changes: <count> }`.

---

## 5. Functional Requirements — JSON Persistence

### FR-STORAGE-020 — `lts.json` Path

The path shall be `path.join(STORAGE_PATH, 'lts.json')` where `STORAGE_PATH` defaults to `path.resolve(__dirname, '..', 'storage')` and can be overridden by `process.env.STORAGE_PATH`.

### FR-STORAGE-021 — `loadFromJson()`

- If `lts.json` exists, parse it and assign to `store`.
- For any table key absent or not an array in the parsed object, reset that key to `[]`.
- If the file does not exist or parse fails, `store` remains initialised with empty arrays (no error thrown).

### FR-STORAGE-022 — `persistJson()`

- Shall serialise the full `store` object to `JSON.stringify(store, null, 2)`.
- Shall write synchronously via `fs.writeFileSync(DB_PATH, ...)`.
- Parse or write errors shall be caught and logged; they shall not propagate.

### FR-STORAGE-023 — `persistJson()` Invocation

`persistJson()` shall be called inside `afterWrite()` and `afterDeleteWhere()` on every mutation, regardless of `DB_TYPE`.

---

## 6. Functional Requirements — MongoDB Persistence

### FR-STORAGE-030 — `mongoDbService.connect(uri, dbName)`

- Shall call `mongoose.connect(uri, opts)` with `serverSelectionTimeoutMS: 5000`.
- On success, shall set `_connected = true` and log `[MongoDB] connected → <uri>`.
- Shall register event listeners: `disconnected` (set `_connected = false`, log WARN), `reconnected` (set `_connected = true`, log INFO), `error` (log ERROR).
- Shall call `Model.createIndexes()` for all collections after connection.

### FR-STORAGE-031 — `mongoDbService.disconnect()`

- Shall call `mongoose.disconnect()` only if `_connected === true`.
- Shall set `_connected = false`.

### FR-STORAGE-032 — `mongoDbService.isConnected()`

- Shall return `_connected` boolean synchronously.

### FR-STORAGE-033 — `mongoDbService.loadAll()`

- Shall query all seven collections via `Model.find({}).lean()`.
- Shall strip `_id` and `__v` fields from each document.
- Shall return a `Promise<Record<string, Array>>` where keys are table names.
- If any collection query throws, the error shall propagate to the caller.

### FR-STORAGE-034 — `mongoDbService.upsert(table, id, row)`

- Shall call `Model.updateOne({ id }, { $set: row }, { upsert: true })`.
- Shall be `async` / return a Promise.
- Errors shall propagate to the caller (caller is responsible for catch/log).

### FR-STORAGE-035 — `mongoDbService.remove(table, id)`

- Shall call `Model.deleteOne({ id })`.
- Shall be `async` / return a Promise.
- Errors shall propagate to the caller.

### FR-STORAGE-036 — `_isMongo()` Guard

Internal helper `_isMongo()` shall return `true` only when:
- `process.env.DB_TYPE === 'mongodb'` AND
- `mongoSvc !== null` AND
- `mongoSvc.isConnected() === true`.

Writes shall be dispatched to MongoDB only when `_isMongo()` returns `true`.

---

## 7. Functional Requirements — Collection Schemas

### FR-STORAGE-040 — Mongoose Schema Strategy

All collections shall use a single `flexSchema`:

```js
const flexSchema = new mongoose.Schema(
  { id: { type: String, required: true } },
  {
    strict: false,
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    minimize: false,
  }
);
flexSchema.index({ id: 1 }, { unique: true });
```

`strict: false` allows any additional fields. `minimize: false` preserves empty objects.

### FR-STORAGE-041 — `cameras` Collection Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | String (UUID v4) | ✅ | Application primary key |
| `name` | String | ✅ | Human-readable camera label |
| `rtspUrl` | String | ✅ | RTSP stream URL |
| `ip` | String | — | Camera IP address |
| `mac` | String | — | Camera MAC address |
| `httpPort` | Number | — | Default 80 |
| `username` | String | — | Camera auth username |
| `password` | String | — | Camera auth password (store hashed or use env var injection) |
| `status` | String | — | `streaming` \| `stopped` \| `error` \| `connecting` |
| `aiEnabled` | Boolean | — | Default `false` |
| `webrtcEnabled` | Boolean | — | Default `false` |
| `type` | String | — | `rtsp` (default) \| `youtube` |
| `createdAt` | Date | auto | Managed by Mongoose timestamps |
| `updatedAt` | Date | auto | Managed by Mongoose timestamps |

### FR-STORAGE-042 — `zones` Collection Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | String (UUID v4) | ✅ | |
| `cameraId` | String (UUID v4) | ✅ | Foreign key to `cameras.id` |
| `name` | String | ✅ | Zone display name |
| `type` | String | ✅ | `MONITOR` \| `EXCLUDE` |
| `polygon` | Array of [x, y] pairs | ✅ | Normalised coordinates [0,1] |
| `dwellThreshold` | Number | — | Seconds before loitering flag (default 30) |
| `riskThreshold` | Number | — | Risk score threshold [0,1] (default 0.7) |
| `aiTargets` | Object | — | Per-zone AI attribute enable flags |
| `createdAt` | Date | auto | |
| `updatedAt` | Date | auto | |

### FR-STORAGE-043 — `events` Collection Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | String (UUID v4) | ✅ | |
| `cameraId` | String (UUID v4) | ✅ | |
| `zoneId` | String (UUID v4) | — | Zone where event occurred |
| `objectId` | String (UUID v4) | ✅ | Tracker object ID |
| `type` | String | ✅ | `loitering` \| `entry` \| `exit` |
| `dwellTime` | Number | — | Seconds of dwell |
| `riskScore` | Number | — | [0, 1] composite risk score |
| `snapshotPath` | String | — | Relative path to JPEG snapshot |
| `timestamp` | Number | ✅ | Unix milliseconds |
| `createdAt` | Date | auto | |

### FR-STORAGE-044 — `alerts` Collection Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | String (UUID v4) | ✅ | |
| `cameraId` | String (UUID v4) | ✅ | |
| `zoneId` | String (UUID v4) | — | |
| `eventId` | String (UUID v4) | — | |
| `severity` | String | — | `LOW` \| `MEDIUM` \| `HIGH` |
| `acknowledged` | Boolean | — | Default `false` |
| `acknowledgedAt` | Date | — | Null until acknowledged |
| `createdAt` | Date | auto | |
| `updatedAt` | Date | auto | |

### FR-STORAGE-045 — `faceGalleries` Collection Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | String (UUID v4) | ✅ | |
| `name` | String | ✅ | Gallery display name |
| `description` | String | — | |
| `createdAt` | Date | auto | |
| `updatedAt` | Date | auto | |

### FR-STORAGE-046 — `faceGalleryFaces` Collection Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | String (UUID v4) | ✅ | |
| `galleryId` | String (UUID v4) | ✅ | Foreign key to `faceGalleries.id` |
| `name` | String | ✅ | Person name |
| `imagePath` | String | — | Relative path to enrolled face JPEG |
| `embedding` | Array of Number | — | 512-float ArcFace embedding vector |
| `metadata` | Object | — | Arbitrary key-value pairs |
| `createdAt` | Date | auto | |
| `updatedAt` | Date | auto | |

### FR-STORAGE-047 — `settings` Collection Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | String | ✅ | Logical singleton key, e.g. `"face_tracking"` |
| `data` | Object | ✅ | Arbitrary settings payload |
| `createdAt` | Date | auto | |
| `updatedAt` | Date | auto | |

---

## 8. Functional Requirements — Index Management

### FR-STORAGE-050 — Index Creation Timing

All indexes shall be created via `Model.createIndexes()` inside `mongoDbService.connect()`, after the connection is established.

### FR-STORAGE-051 — Required Indexes

| Collection | Index Specification | Options |
|---|---|---|
| All | `{ id: 1 }` | `unique: true` |
| `events` | `{ cameraId: 1, timestamp: -1 }` | compound |
| `events` | `{ createdAt: -1 }` | — |
| `alerts` | `{ cameraId: 1, createdAt: -1 }` | compound |
| `alerts` | `{ acknowledged: 1 }` | — |
| `faceGalleryFaces` | `{ galleryId: 1 }` | — |
| `zones` | `{ cameraId: 1 }` | — |

### FR-STORAGE-052 — Index Verification

The `events` time-range query `{ cameraId, timestamp: { $gte, $lte } }` shall use the compound index. `explain("executionStats")` shall show `IXSCAN` (not `COLLSCAN`) for this query.

---

## 9. Functional Requirements — Migration

### FR-STORAGE-060 — Script Location

Migration script path: `server/src/scripts/migrateToMongo.js`.

### FR-STORAGE-061 — Migration Procedure

1. Load `lts.json` from `STORAGE_PATH`.
2. Connect to MongoDB using `MONGODB_URI` and `MONGODB_DB` from environment.
3. For each table in `['cameras', 'zones', 'events', 'alerts', 'faceGalleries', 'faceGalleryFaces', 'settings']`:
   a. For each document, call `mongoSvc.upsert(table, doc.id, doc)`.
   b. Track success and error counts per table.
4. Print summary:
   ```
   [Migration] cameras:         5 upserted, 0 errors
   [Migration] zones:          12 upserted, 0 errors
   [Migration] events:       1043 upserted, 0 errors
   [Migration] alerts:         87 upserted, 0 errors
   [Migration] faceGalleries:   3 upserted, 0 errors
   [Migration] faceGalleryFaces:28 upserted, 0 errors
   [Migration] settings:        1 upserted, 0 errors
   [Migration] Done.
   ```
5. Disconnect and exit with code `0` on success, `1` on fatal error.

### FR-STORAGE-062 — Idempotency

Running the migration script multiple times on the same `lts.json` shall not produce duplicate documents. Each run shall produce `0 inserts; N updates` on the second run.

### FR-STORAGE-063 — `createdAt` Preservation

Documents migrated from JSON shall retain their original `createdAt` values. The Mongoose `timestamps` option shall not overwrite existing `createdAt` on upsert.

---

## 10. Functional Requirements — Connection Lifecycle

### FR-STORAGE-070 — Startup MongoDB Availability Check

When `DB_TYPE=mongodb`, the server SHALL call `ensureMongoDB()` **before** `initDB()` during startup.

`ensureMongoDB()` shall:
1. If `MONGODB_URI` is not set → call `fatalExit()` → `process.exit(1)`.
2. For remote URIs (Atlas / `mongodb+srv://` / non-localhost): skip TCP probe; proceed to `MongoDatabase.init()`.
3. For local URIs: TCP-probe `host:port` with 1.5 s timeout.
   - If reachable → log `[MongoDB] <host>:<port> — 실행 중` and return normally.
   - If not reachable and `mongod` binary exists → attempt auto-restart (systemctl / brew / net start) with 20 s wait.
     - Restart succeeded and port responds → return normally.
     - Restart succeeded but port still unresponsive after 20 s → `fatalExit()` → `process.exit(1)`.
     - Restart failed (no permissions) → print manual-start guide → `fatalExit()` → `process.exit(1)`.
   - If `mongod` binary not found → print install guide → `fatalExit()` → `process.exit(1)`.

`mongoDbService.connect()` shall use `serverSelectionTimeoutMS: 5000`. If MongoDB is not reachable within 5 seconds, `connect()` shall throw, which propagates to `main().catch()` → `process.exit(1)`.

**lts.json fallback is strictly prohibited when `DB_TYPE=mongodb`.**

### FR-STORAGE-071 — `MONGODB_URI` Absent

If `DB_TYPE=mongodb` and `MONGODB_URI` is not set in `server/.env`, the server SHALL:
- Log the fatal error banner (`[FATAL] DB_TYPE=mongodb — MongoDB에 연결할 수 없어 서버를 시작할 수 없습니다.`)
- Exit with code 1 immediately.

Continuing in JSON mode is **not permitted**.

### FR-STORAGE-072 — Disconnection During Operation

On `mongoose.connection.disconnected` event:
- Set `_connected = false`.
- Log: `[MongoDB] disconnected — writes will be JSON-only until reconnect`.
- Subsequent `_isMongo()` calls return `false` until reconnected.

### FR-STORAGE-073 — Reconnection

On `mongoose.connection.reconnected` event:
- Set `_connected = true`.
- Log: `[MongoDB] reconnected`.
- Subsequent writes resume to MongoDB.

### FR-STORAGE-074 — Graceful Shutdown

On `SIGTERM` / `SIGINT`, the server shall call `mongoDbService.disconnect()` before exiting.

---

## 11. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-STORAGE-001 | Performance — Write | MongoDB upsert P95 ≤ 30 ms, P99 ≤ 50 ms on same-LAN deployment |
| NFR-STORAGE-002 | Performance — Startup | `loadAll()` for ≤ 100 K documents completes in ≤ 5 seconds |
| NFR-STORAGE-003 | Performance — Read | In-memory `stmt.all()` for ≤ 10 K rows completes in ≤ 5 ms |
| NFR-STORAGE-004 | Startup Integrity | When `DB_TYPE=mongodb`, server startup SHALL abort with exit code 1 if MongoDB is unreachable. No silent fallback to JSON mode. Runtime disconnection after startup is tolerated (in-memory only until reconnect). |
| NFR-STORAGE-005 | Security | MongoDB credentials shall be stored only in `.env` / environment variables |
| NFR-STORAGE-006 | Security | `_id` (ObjectId) shall never appear in any HTTP response body |
| NFR-STORAGE-007 | Security | Password fields in `cameras` documents shall not be logged at any log level |
| NFR-STORAGE-008 | Reliability | `lts.json` shall be updated on every mutation as a durable backup |
| NFR-STORAGE-009 | Scalability | Schema and index design shall support sharding on `cameraId` without structural changes |
| NFR-STORAGE-010 | Observability | All MongoDB connection events shall be logged with `[MongoDB]` prefix |
| NFR-STORAGE-011 | Maintainability | `mongoDbService.js` shall expose only the 6 public functions; all Mongoose internals shall be private |
| NFR-STORAGE-012 | Test Coverage | `db.js` + `mongoDbService.js` combined line coverage ≥ 80% |

---

## 12. Interface Requirements

### 12.1 `db.js` → Application Boundary

```
db.prepare(sql: string): Statement
Statement.all(params?: object): Array<object>
Statement.get(params?: object): object | null
Statement.run(params?: object): { changes: number, lastInsertRowid?: string }
db.initDb(): Promise<void>
```

### 12.2 `db.js` → `mongoDbService.js` Boundary

```
mongoSvc.connect(uri: string, dbName?: string): Promise<void>
mongoSvc.disconnect(): Promise<void>
mongoSvc.isConnected(): boolean
mongoSvc.loadAll(): Promise<Record<string, object[]>>
mongoSvc.upsert(table: string, id: string, row: object): Promise<void>
mongoSvc.remove(table: string, id: string): Promise<void>
```

### 12.3 Environment Variables

| Variable | Type | Default | Constraint |
|---|---|---|---|
| `DB_TYPE` | String | `json` | `json` or `mongodb` only |
| `MONGODB_URI` | String | — | Must be a valid MongoDB connection URI when `DB_TYPE=mongodb` |
| `MONGODB_DB` | String | `lts2026` | Alphanumeric + underscore |
| `STORAGE_PATH` | String | `./storage` | Must be a writable directory |

---

## 13. Data Dictionary

| Symbol | Type | Description |
|---|---|---|
| `store` | `Record<string, object[]>` | In-memory store; authoritative for synchronous reads |
| `ALL_TABLES` | `string[]` | `['cameras','zones','events','alerts','faceGalleries','faceGalleryFaces','settings']` |
| `DB_PATH` | `string` | Resolved absolute path to `lts.json` |
| `mongoSvc` | `object \| null` | Reference to loaded `mongoDbService` module; `null` until MongoDB mode is active |
| `_connected` | `boolean` | Mongoose connection state maintained in `mongoDbService.js` |
| `flexSchema` | `mongoose.Schema` | `strict: false` schema used for all collections |
| `_models` | `Record<string, mongoose.Model>` | Lazily-created Mongoose model cache |

---

## 14. Constraints & Assumptions

| # | Constraint / Assumption |
|---|---|
| C-1 | MongoDB >= 6.0 is required. MongoDB 5.x may work but is untested. |
| C-2 | The in-memory store must fit in the Node.js heap. Systems with > 5 M events should implement periodic in-memory pruning or paginated MongoDB queries. |
| C-3 | `lts.json` is the source of truth for JSON mode. Manual edits to `lts.json` are reflected on server restart. |
| C-4 | UUID v4 strings are generated by the caller (route handlers) before passing to `db.prepare().run()`. `db.js` does not generate IDs. |
| C-5 | `events` documents are append-only. Updates to events are not supported. |
| C-6 | The `settings` collection stores arbitrary singleton documents identified by a stable string `id` (e.g., `"face_tracking"`). |
| C-7 | `mongoDbService.js` is dynamically `require()`-ed inside `db.js` only when `DB_TYPE=mongodb` to avoid Mongoose loading overhead in JSON mode. |

---

## 15. v1.1 Amendment — Persistence Safety Requirements

### 15.1 New Non-Functional Requirements

#### NFR-STORE-015 — Atomic JSON Write

`lts.json` MUST be written via an atomic write strategy. The implementation MUST:
1. Serialize the in-memory store to a temporary file (`lts.json.tmp`) using `fs.writeFileSync`.
2. Atomically replace `lts.json` with `lts.json.tmp` via `fs.renameSync`.
3. Delete `lts.json.tmp` if any error occurs before the rename completes.

A `kill -9` issued at any point during a write MUST NOT produce a corrupt or unparseable `lts.json`.

#### NFR-STORE-016 — Write Frequency Limiting (Debounce)

The JSON persistence mechanism MUST coalesce multiple `db.insert()` / `db.update()` calls within a 2-second window into a single disk write. Specifically:
- The default debounce interval MUST be `2000 ms`.
- If multiple mutations occur within the debounce window, exactly one `_flushJson()` call MUST be made.
- The debounce timer MUST be cancelled and `_flushJson()` MUST be called immediately when `flushNow()` is invoked.

#### NFR-STORE-017 — Graceful Shutdown Data Flush

On receiving `SIGTERM` or `SIGINT`, the server MUST call `flushNow()` before closing the HTTP server. This requirement MUST be met regardless of whether the debounce timer is currently active. Data inserted within the last 2 seconds of a graceful shutdown MUST NOT be lost.

### 15.2 Updated Module Exports

`db.js` MUST export `flushNow` as a named export:

```js
module.exports = { initDB, getDB, getStorageMode, flushNow };
```

### 15.3 New `ALL_TABLES` Entry

`faceMatchHistory` MUST be included in `ALL_TABLES` so that face match records are persisted and hydrated on server restart:

```js
const ALL_TABLES = [
  'cameras', 'zones', 'events', 'alerts',
  'faceGalleries', 'faceGalleryFaces', 'settings',
  'detectionSnapshots',  // v1.0
  'faceMatchHistory',    // v1.1 — Face ID Live Match history
];
```

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for DB Layer (pluggable storage backends) |
| 1.2 | 2026-06-26 | LTS Engineering Team | FR-STORAGE-070/071 개정: DB_TYPE=mongodb 시 MongoDB 미연결 → process.exit(1); NFR-STORAGE-004 개정: fallback 금지 |
