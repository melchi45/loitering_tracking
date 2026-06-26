# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Storage Layer — JSON / MongoDB Persistence

| | |
|---|---|
| **Document ID** | PRD-STORAGE-001 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Related RFP** | rfp/RFP_DB_Layer.md |

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Technology Selection](#4-technology-selection)
5. [Functional Specification](#5-functional-specification)
6. [API / Interface Contract](#6-api--interface-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

Provide the LTS-2026 system with a **transparent, dual-mode persistence layer** that allows zero-configuration JSON-file operation during development and on-premise edge deployments, while offering MongoDB write-through for production environments requiring data durability, concurrent writes, and historical querying — all behind a single `db.js` abstraction that requires no changes in any route handler or service above it.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- **G1**: Implement a `DB_TYPE` environment variable switch (`json` | `mongodb`) that selects the storage mode at startup with no code changes above `db.js`.
- **G2**: Maintain an in-memory store as the synchronous read source so all existing route handlers remain unchanged.
- **G3**: Write every mutation to MongoDB asynchronously (fire-and-forget) when in MongoDB mode, logging errors without blocking the AI pipeline.
- **G4**: In `DB_TYPE=json` mode, write `lts.json` on every mutation as the primary durable store. In `DB_TYPE=mongodb` mode, `lts.json` is **not** read or written — MongoDB is the sole durable store.
- **G5**: On startup in MongoDB mode, hydrate the in-memory store from MongoDB (`loadAll`) before accepting API requests.
- **G6**: Provide a migration script (`migrateToMongo.js`) to promote existing `lts.json` data into MongoDB with idempotency and summary logging.
- **G7**: Create compound indexes on high-write collections (`events`, `alerts`) to support time-range queries within acceptable latency.
- **G8**: When `DB_TYPE=mongodb`, verify MongoDB connectivity at startup (`ensureMongoDB()`). If unreachable after auto-restart attempt, exit immediately with exit code 1. No silent fallback to JSON mode.

### 2.2 Non-Goals

- **NG1**: Multi-node distributed in-memory caching (Redis Cluster) — deferred to Phase 4.
- **NG2**: Change-Stream-based real-time sync between multiple server instances — deferred.
- **NG3**: MongoDB Transactions / ACID across multiple collections — not required; each table write is independently atomic.
- **NG4**: Encryption-at-rest for MongoDB (Atlas handles this; standalone requires OS-level configuration outside scope).
- **NG5**: Replacing Socket.IO event delivery with MongoDB Change Streams.
- **NG6**: Full-text search on `events.notes` or `alerts.description` — deferred to Phase 3.

---

## 3. User Personas

### Persona 1 — DevOps / IT Administrator
Responsible for deploying LTS-2026 in production. Needs a `docker-compose.yml` with a `mongo` service, a clear `.env.example`, and a migration script they can run once to seed MongoDB from an existing `lts.json`. Requires monitoring guidance (connection error logging, health endpoint).

### Persona 2 — Backend Developer
Writes route handlers and services against `db.js`. Must never need to know which storage mode is active. Needs the same synchronous `prepare(sql).all/get/run()` API regardless of `DB_TYPE`.

### Persona 3 — Security Operator (Indirect)
Benefits from persistent alert and event history that survives server restarts. In production, relies on MongoDB durability; in offline/edge deployments, relies on `lts.json` backup.

### Persona 4 — Data Analyst
Queries historical loitering event data for trend analysis. Needs MongoDB collections with appropriate indexes for time-range and camera-scoped queries. Not blocked by the JSON fallback path.

---

## 4. Technology Selection

### 4.1 Storage Backend Comparison

| Criterion | JSON File | SQLite | PostgreSQL | MongoDB |
|---|---|---|---|---|
| Zero-config setup | ✅ | ✅ | ❌ | ❌ |
| Async write support | Limited | Via WAL | ✅ | ✅ |
| Schema flexibility | ✅ | ❌ | ❌ | ✅ |
| Horizontal scale | ❌ | ❌ | Limited | ✅ |
| Time-series indexing | ❌ | Limited | ✅ | ✅ |
| Existing codebase fit | ✅ (current) | Medium | Large refactor | Medium |
| Docker footprint | None | None | 300 MB | 500 MB |

**Selected**: JSON (default) + MongoDB (optional write-through). MongoDB was chosen over PostgreSQL because:
1. The existing document shapes are already JSON/BSON-native (nested arrays, mixed types).
2. `strict: false` Mongoose schema accommodates schema evolution without migrations.
3. MongoDB Atlas provides a hosted zero-ops option for cloud deployments.

### 4.2 ODM Selection — Mongoose vs. Native MongoDB Driver

| Criterion | Mongoose | Native Driver |
|---|---|---|
| Schema validation | ✅ | Manual |
| Connection management | ✅ auto-reconnect | Manual |
| `lean()` query for plain JS objects | ✅ | N/A |
| Timestamps plugin | ✅ | Manual |
| Team familiarity | High | Medium |

**Selected**: Mongoose >= 8.x.

### 4.3 In-Memory Store Strategy

The in-memory `store` object (plain JS arrays keyed by table name) remains the authoritative read source. This design:

- Preserves the existing synchronous `prepare(sql).get/all/run()` API.
- Eliminates MongoDB read latency from the hot path (frame processing loop).
- Allows JSON-mode and MongoDB-mode to share identical read paths.

---

## 5. Functional Specification

### 5.1 Startup Initialization Flow

```
initDb()
  │
  ├── loadFromJson()          → populate in-memory store from lts.json
  │
  ├── if DB_TYPE === 'mongodb'
  │     ├── mongoSvc.connect(MONGODB_URI, MONGODB_DB)
  │     │     └── on failure → log warning, stay in JSON mode
  │     │
  │     └── on success
  │           └── mongoSvc.loadAll() → overwrite in-memory store with MongoDB data
  │
  └── server.listen(3001)     → only after store is hydrated
```

### 5.2 Write Dispatch Flow

```
db.prepare(sql).run(params)
  │
  ├── mutate in-memory store
  │
  ├── afterWrite(table, id, row, op)
  │     ├── persistJson()                     (always, sync)
  │     │
  │     └── if _isMongo()
  │           ├── op === 'delete'  → mongoSvc.remove(table, id)   [async]
  │           └── op !== 'delete' → mongoSvc.upsert(table, id, row) [async]
  │
  └── return { changes, lastInsertRowid }    (synchronous to caller)
```

### 5.3 MongoDB Document Identity

- Application `id` field: UUID v4 string (e.g., `"f2ed29b1-ad46-47e3-baf9-8f083be954ed"`).
- MongoDB `_id`: auto-generated `ObjectId`, stripped by `lean()` before returning to application.
- Unique index: `{ id: 1 }` on every collection.

### 5.4 Migration Script

```
node server/src/scripts/migrateToMongo.js
```

- Reads `lts.json`.
- For each table, iterates documents and calls `mongoSvc.upsert(table, doc.id, doc)`.
- Uses `updateOne({ id }, { $set: doc }, { upsert: true })` so repeated runs are safe.
- Prints per-table summary: `cameras: 5 upserted, 0 errors`.

### 5.5 Index Creation

Indexes are created on `mongoDbService.connect()` via `Model.createIndexes()`:

| Collection | Index | Type |
|---|---|---|
| All collections | `{ id: 1 }` | unique |
| `events` | `{ cameraId: 1, timestamp: -1 }` | compound |
| `events` | `{ createdAt: -1 }` | single |
| `alerts` | `{ cameraId: 1, createdAt: -1 }` | compound |
| `alerts` | `{ acknowledged: 1 }` | single |
| `faceGalleryFaces` | `{ galleryId: 1 }` | single |
| `zones` | `{ cameraId: 1 }` | single |

### 5.6 Connection Resilience

| Scenario | Behavior |
|---|---|
| MongoDB unreachable at startup | Log WARN, fall back to JSON mode, server starts normally |
| MongoDB disconnects during operation | Log WARN, writes silently fall back to JSON-only until reconnect |
| MongoDB reconnects | Mongoose auto-reconnects; writes resume to MongoDB |
| `MONGODB_URI` not set but `DB_TYPE=mongodb` | Log ERROR, force JSON mode |

---

## 6. API / Interface Contract

### 6.1 `db.js` Public API (unchanged)

```js
db.prepare(sql)           // Returns statement object
stmt.all(params)          // Returns array of matching rows
stmt.get(params)          // Returns first matching row or null
stmt.run(params)          // Executes insert/update/delete; returns { changes }
db.initDb()               // Async: loads JSON, optionally connects MongoDB
```

### 6.2 `mongoDbService.js` Public API

```js
mongoSvc.connect(uri, dbName)   // Promise<void>  — throws on timeout
mongoSvc.disconnect()            // Promise<void>
mongoSvc.isConnected()           // boolean
mongoSvc.loadAll()               // Promise<Record<string, Array>>
mongoSvc.upsert(table, id, row)  // Promise<void>  — fire-and-forget safe
mongoSvc.remove(table, id)       // Promise<void>  — fire-and-forget safe
```

### 6.3 Environment Configuration

```dotenv
# .env (JSON mode — default, no additional config)
DB_TYPE=json
STORAGE_PATH=./storage

# .env (MongoDB mode)
DB_TYPE=mongodb
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=lts2026
STORAGE_PATH=./storage
```

---

## 7. Acceptance Criteria

| ID | Criterion | Verification |
|---|---|---|
| AC-STORAGE-001 | Setting `DB_TYPE=json` starts server without MongoDB running | Manual test + CI |
| AC-STORAGE-002 | Setting `DB_TYPE=mongodb` with valid URI hydrates in-memory store from MongoDB | Integration test |
| AC-STORAGE-003 | Writing a camera record in MongoDB mode persists to both `lts.json` and MongoDB | Integration test |
| AC-STORAGE-004 | MongoDB connection failure at startup falls back to JSON mode gracefully | Unit test (mock) |
| AC-STORAGE-005 | `migrateToMongo.js` is idempotent — running twice produces no duplicates | Migration test |
| AC-STORAGE-006 | `events` time-range query (`{ cameraId, timestamp: { $gte, $lte } }`) uses compound index (EXPLAIN shows `IXSCAN`) | Index test |
| AC-STORAGE-007 | `_id` field never appears in any application JSON response | API response test |
| AC-STORAGE-008 | Unit + integration test coverage ≥ 80% on `db.js` and `mongoDbService.js` | Coverage report |

---

## 8. Milestones & TODO

| # | Task | Owner | Status |
|---|---|---|---|
| 1 | Finalize Mongoose schema and index strategy | Backend | ✅ Prototype complete |
| 2 | Implement `initDb()` with dual-mode startup | Backend | ✅ Implemented |
| 3 | Implement `afterWrite` dispatcher | Backend | ✅ Implemented |
| 4 | Write `migrateToMongo.js` | Backend | 🔲 TODO |
| 5 | Add `mongo` service to `docker-compose.yml` | DevOps | 🔲 TODO |
| 6 | Write unit tests for `db.js` (JSON mode) | QA | 🔲 TODO |
| 7 | Write integration tests for MongoDB mode | QA | 🔲 TODO |
| 8 | Document `.env.example` with MongoDB variables | Backend | 🔲 TODO |
| 9 | Operational runbook — backup, index management | DevOps | 🔲 TODO |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for DB Layer (pluggable storage backends) |
| 1.1 | 2026-06-26 | LTS Engineering Team | G4 개정 (mongodb 모드에서 lts.json 미사용 명시), G8 추가 (MongoDB 기동 전 필수 확인 + exit(1)) |
