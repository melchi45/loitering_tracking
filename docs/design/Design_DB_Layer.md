# DESIGN DOCUMENT
# Storage Layer — JSON / MongoDB Persistence

| | |
|---|---|
| **Document ID** | DESIGN-STORAGE-001 |
| **Version** | 2.1 |
| **Status** | Active — amended 2026-07-21 |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_DB_Layer.md |

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File & Module Structure](#2-file--module-structure)
3. [DB Interface & Backends](#3-db-interface--backends)
4. [`mongoDbService.js` — MongoDB Adapter Design](#4-mongodbservicejs--mongodb-adapter-design)
5. [Mongoose Schema Design](#5-mongoose-schema-design)
6. [Index Strategy](#6-index-strategy)
7. [Startup Sequence Diagram](#7-startup-sequence-diagram)
8. [Write Dispatch Sequence Diagram](#8-write-dispatch-sequence-diagram)
9. [Migration Script Design](#9-migration-script-design)
10. [Docker Compose Integration](#10-docker-compose-integration)
11. [Data Flow Diagrams](#11-data-flow-diagrams)
12. [Security Design](#12-security-design)
13. [Error Handling Strategy](#13-error-handling-strategy)
14. [Configuration Reference](#14-configuration-reference)

---

## 1. Architecture Overview

### 1.1 Layered Storage Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        APPLICATION LAYER                                     │
│  Route Handlers · Services · BehaviorEngine · AlertService                  │
│  (All call db.insert/update/delete/find/all — synchronous, no storage       │
│   awareness)                                                                 │
└─────────────────────────────┬───────────────────────────────────────────────┘
                              │ synchronous in-memory API
┌─────────────────────────────▼───────────────────────────────────────────────┐
│                    db/index.js  (factory + public API)                       │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  BaseDatabase  (abstract — src/db/BaseDatabase.js)                  │     │
│  │  • insert / update / delete / find / findOne / all                  │     │
│  │  • getStats() · getMode() · isConnected()                           │     │
│  │  • prepare() shim (backward-compat)                                 │     │
│  └──────────────┬──────────────────────────────────┬──────────────────┘     │
│                 │                                  │                         │
│  ┌──────────────▼─────────────┐  ┌────────────────▼──────────────────┐     │
│  │  JsonDatabase               │  │  MongoDatabase                     │     │
│  │  (src/db/JsonDatabase.js)   │  │  (src/db/MongoDatabase.js)         │     │
│  │                             │  │                                    │     │
│  │  in-memory store + debounced│  │  in-memory mirror + async          │     │
│  │  async write to lts.json   │  │  fire-and-forget to MongoDB        │     │
│  │  (atomic .tmp rename)       │  │  (disconnect → in-memory only)     │     │
│  └─────────────┬───────────────┘  └────────────────┬──────────────────┘     │
└────────────────┼──────────────────────────────────-┼────────────────────────┘
                 ▼                                   ▼
          storage/lts.json                    MongoDB (mongoose)
          (DB_TYPE=json)                     20 collections
                                             (DB_TYPE=mongodb)
```

### 1.2 Backend Selection

```
DB_TYPE=json  (default)               DB_TYPE=mongodb
┌─────────────────────┐               ┌─────────────────────────────────────┐
│  JsonDatabase.init() │               │  ensureMongoDB() — TCP probe,       │
│  reads lts.json      │               │    auto-restart or install guide    │
│  into in-memory store│               │  MongoDatabase.init()               │
│                      │               │  → mongoSvc.loadAll() direct        │
│  insert/update:      │               │  (lts.json NEVER read or written)   │
│  → _schedulePersist()│               │                                     │
│    [debounced 2s,    │               │  insert/update:                     │
│     atomic rename]   │               │  → _persist() [async upsert]        │
└─────────────────────┘               │  disconnect → in-memory only,       │
                                      │    no JSON fallback                  │
                                      └─────────────────────────────────────┘
```

### 1.3 Extending with a New Backend

```
# To add SQLite (or Oracle, Redis, etc.):
1. Create  server/src/db/SqliteDatabase.js  extending BaseDatabase
2. Override: init(), insert(), update(), delete(), find(), findOne(), all(), getMode()
3. Register in db/index.js:
     case 'sqlite': return new SqliteDatabase();
4. Set  DB_TYPE=sqlite  in server/.env
```

---

## 2. File & Module Structure

```
server/
├── src/
│   ├── db.js                         ← backward-compat shim: module.exports = require('./db/index')
│   ├── db/                           ← DB layer (v1.7+)
│   │   ├── index.js                  ← factory + public API (initDB / getDB / getStorageMode / getDbStats / flushNow)
│   │   ├── BaseDatabase.js           ← abstract interface (extend to add SQLite, Oracle, etc.)
│   │   ├── JsonDatabase.js           ← JSON file backend (DB_TYPE=json, default)
│   │   ├── MongoDatabase.js          ← MongoDB backend   (DB_TYPE=mongodb)
│   │   └── constants.js              ← ALL_TABLES, TABLE_ROW_CAPS, LEGACY_MIGRATIONS
│   ├── services/
│   │   └── mongoDbService.js         ← Mongoose-based MongoDB adapter (used by MongoDatabase)
│   └── scripts/
│       ├── migrateToMongo.js         ← One-time JSON → MongoDB migration
│       └── ensureMongodb.js          ← Startup health check: TCP probe → auto-restart → install guide
├── storage/
│   ├── lts.json                      ← JSON mode only (DB_TYPE=mongodb: never read or written)
│   ├── analytics.json                ← Analytics config (separate file, not db layer)
│   ├── tracker.json                  ← Tracker config (separate file, not db layer)
│   └── face_tracking.json            ← Face trajectory state (separate file, not db layer)
├── .env.example                      ← Environment variable template
└── docker-compose.yml                ← Includes `mongo` service when DB_TYPE=mongodb
```

> **Note**: `analytics.json`, `tracker.json`, and `face_tracking.json` are managed by their respective service modules directly (not through the DB layer). They are not MongoDB-backed.
>
> **Node.js resolution**: `require('./db')` resolves to `db.js` (the shim), which delegates to `db/index.js`. All existing callers work without change.

---

## 3. DB Interface & Backends

### 3.1 `BaseDatabase` — Abstract Interface (`db/BaseDatabase.js`)

모든 백엔드가 상속해야 하는 추상 클래스. 하위클래스는 아래 메서드를 반드시 구현합니다.

```js
class BaseDatabase {
  // ── Abstract CRUD (must override) ─────────────────────────────────────
  insert(table, row)         // row must include id field
  update(table, id, data)    // merge data into matching row
  delete(table, id)          // remove row by id
  find(table, where = {})    // equality filter, returns array
  findOne(table, where = {}) // first match or null
  all(table)                 // shallow copy of all rows

  // ── Abstract lifecycle ────────────────────────────────────────────────
  async init()               // connect, load data, etc.
  flushNow()                 // sync flush on graceful shutdown (no-op for MongoDB)
  close()                    // cleanup timers/connections

  // ── Metadata ─────────────────────────────────────────────────────────
  getMode()                  // 'json' | 'mongodb' | 'sqlite' | …
  isConnected()              // true when ready to accept writes
  getStats()                 // { mode, connected, rates, cumulative }

  // ── Async direct query (v1.9) ────────────────────────────────────────────
  // Bypasses the in-memory store for tables excluded from startup hydration
  // (e.g. onvif_snapshots with large binary blobs).
  async queryAsync(table, where={}, sort={}, limit=null)
    // Default: in-memory find() + sort + slice (JsonDatabase behaviour)
    // MongoDatabase overrides to call mongoDbService.findDirect() directly.

  // ── Shared (inherited) ────────────────────────────────────────────────
  prepare(sql)               // backward-compat SQL shim (INSERT/DELETE/SELECT)
  pragma()                   // no-op shim
  exec()                     // no-op shim
  _sampleRates()             // internal — updates inserts/updates/deletes/finds per-sec
}
```

### 3.2 `JsonDatabase` — JSON File Backend (`db/JsonDatabase.js`)

```
JsonDatabase.init()
  │  storagePath = STORAGE_PATH env || server/storage/
  │  _loadFromDisk()  → reads lts.json into this._store
  │  _runLegacyMigrations()  → one-time import from users.json/tokens.json/audit.json
  │  console.log '[DB] Storage mode: JSON'
  ▼
insert/update/delete:
  │  mutate this._store (in-memory)
  │  enforce TABLE_ROW_CAPS (evict oldest when exceeded)
  └─ _schedulePersist()  → debounced 2 s timer
         └─ _flushAsync()
               ├── fs.promises.writeFile(lts.json.tmp)
               └── fs.promises.rename(lts.json.tmp → lts.json)   ← atomic

flushNow()  (SIGTERM/SIGINT)
  │  clearTimeout(timer)
  └─ fs.writeFileSync(lts.json.tmp) + fs.renameSync(→ lts.json)
```

### 3.3 `MongoDatabase` — MongoDB Backend (`db/MongoDatabase.js`)

```
MongoDatabase.init()
  │  require(mongoDbService).connect(MONGODB_URI, MONGODB_DB_NAME)
  │  mongoSvc.loadAll()  → snapshot from all 21 collections
  │  populate this._store  (in-memory mirror)
  │  NOTE: lts.json is NEVER read or written by MongoDatabase
  │  console.log '[DB] Storage mode: MongoDB'
  ▼
insert/update/delete:
  │  mutate this._store (in-memory mirror, synchronous)
  │  enforce TABLE_ROW_CAPS
  └─ _persist(op, table, id, row)
         ├─ isConnected() → mongoSvc.upsert/remove  [async, fire-and-forget]
         └─ disconnected  → in-memory only, log ERROR (no JSON fallback)

flushNow()  → no-op (MongoDB writes are async fire-and-forget)
```

### 3.4 `db/index.js` — Factory & Public API

```js
// initDB() — called once at server startup
async function initDB() {
  if (DB_TYPE === 'mongodb') {
    if (!MONGODB_URI) {
      // WARN → fall back to JsonDatabase
    } else {
      try {
        backend = new MongoDatabase();
        await backend.init();        // connects, loads from MongoDB
        _db = backend;
      } catch (err) {
        // WARN → fall back to JsonDatabase (warm-start from lts.json)
        _db = new JsonDatabase();
        await _db.init();
      }
    }
  } else {
    _db = new JsonDatabase();
    await _db.init();
  }
  return _db;
}

// Public API (backward-compatible with legacy db.js exports)
module.exports = { initDB, getDB, getStorageMode, getDbStats, flushNow };
```

### 3.5 `db/constants.js` — Shared Constants

```js
ALL_TABLES         // 21-table list (all collections)
TABLE_ROW_CAPS     // per-table in-memory eviction limits
LEGACY_MIGRATIONS  // one-time import: users.json / tokens.json / audit.json
                   // (JSON mode only — runs in JsonDatabase.init())
```

---

## 4. `mongoDbService.js` — MongoDB Adapter Design

### 4.1 Module Structure

```js
// ── State ────────────────────────────────────────────────────────────────
let _connected = false;
const _models = {};

// ── Table list: must match ALL_TABLES in db.js ──────────────────────────
// onvif_snapshots is intentionally EXCLUDED — each row contains a large
// base64 JPEG blob. Loading all rows at startup would exhaust RAM.
// The snapshot endpoint uses queryAsync() / findDirect() to query MongoDB
// directly at request time instead.
const TABLES = [
  'cameras', 'zones', 'events', 'alerts', 'faceGalleries', 'faceGalleryFaces',
  'settings', 'detectionSnapshots', 'faceMatchHistory', 'missing_persons',
  'missing_person_detections', 'analysisEvents', 'client_logs', 'client_webrtc_stats',
  'onvif_events', 'onvif_event_types', 'detectionTracks',
  'faceTrajectories', 'tc_results',
  'users', 'refresh_tokens', 'audit_logs',
];

// ── Row limits applied on startup to bound memory / startup time ──────────
const LOAD_LIMITS = {
  events: 20000, alerts: 10000, detectionSnapshots: 2000,
  faceMatchHistory: 5000, missing_person_detections: 5000,
  client_logs: 10000, client_webrtc_stats: 5000, onvif_events: 50000,
  detectionTracks: 10000, faceTrajectories: 5000, tc_results: 10000,
  refresh_tokens: 10000, audit_logs: 10000, analysisEvents: 10000,
};

// ── Schema ───────────────────────────────────────────────────────────────
// timestamps:false — db.js manages createdAt/updatedAt as ISO strings.
// Mongoose timestamps would store Date objects which break string comparators.
const flexSchema = new mongoose.Schema(
  { id: { type: String, required: true } },
  { strict: false, timestamps: false, minimize: false }
);
flexSchema.index({ id: 1 }, { unique: true });

// ── Model factory ─────────────────────────────────────────────────────────
function model(table) {
  if (!_models[table]) {
    _models[table] = mongoose.model(table, flexSchema.clone(), table);
  }
  return _models[table];
}

// ── Public API ────────────────────────────────────────────────────────────
module.exports = { TABLES, connect, disconnect, isConnected, loadAll, upsert, remove, removeWhere, findDirect };
```

### 4.2 `connect()` 및 Keep-Alive / Retry 설계 (v1.8)

`connect()`는 초기 연결 성공 후 두 가지 백그라운드 루프를 시작합니다.

#### Keep-Alive 핑 (5초 주기)

```
setInterval(5000) → mongoose.connection.db.command({ping:1})
  성공 → [MongoDB] keep-alive ✓ connected | ping Xms | URI: ...
  실패 → [MongoDB] keep-alive ping 실패: <error>
```

연결 상태(`readyState`)를 함께 로깅해 운영 중 DB 상태를 실시간 확인할 수 있습니다.

#### 재연결 Retry (선형 back-off)

`disconnected` 이벤트 발생 시 자동 retry 루프를 시작합니다:

```
attempt #N → delay = min(3000 × N, 30000) ms
  [MongoDB] 재연결 대기 #N — Xs 후 재시도 | URI: ...
  [MongoDB] 재연결 시도 #N | URI: ...
  성공 → reconnected 이벤트 → _cancelRetry() → [MongoDB] 재연결 성공
  실패 → [MongoDB] 재연결 실패 #N: <error> → scheduleRetry(N+1)
```

| 시도 | 대기 | | 시도 | 대기 |
|---|---| |---|---|
| #1 | 3s | | #6 | 18s |
| #2 | 6s | | #7 | 21s |
| #3 | 9s | | … | … |
| #10+ | 30s (최대) | | | |

이벤트 리스너는 `_listenersSet` 플래그로 중복 등록을 방지합니다.

```js
async function connect(uri, dbName) {
  _uri = uri;
  _connectOpts = { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000,
                   heartbeatFrequencyMS: 10000, maxIdleTimeMS: 60000,
                   ...(dbName ? { dbName } : {}) };
  _attachListeners();          // idempotent
  await mongoose.connect(uri, _connectOpts);
  _connected = true;
  _startKeepAlive();           // 5s interval ping
  console.log('[MongoDB] connected | URI:', uri);
}
```

### 4.3 `loadAll()` Implementation

```js
/** Convert any Date objects in a plain document to ISO strings. */
function normalizeDates(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

async function loadAll() {
  const result = {};
  for (const table of TABLES) {
    const limit = LOAD_LIMITS[table];
    // High-volume tables: load only the most recent N rows to bound startup time.
    const query = model(table).find({}).lean();
    if (limit) query.sort({ createdAt: -1 }).limit(limit);
    const docs = await query;
    // Strip internal Mongoose fields; normalize any legacy Date objects to ISO strings.
    result[table] = docs.map(({ _id, __v, ...rest }) => normalizeDates(rest));
  }
  return result;
}
```

### 4.4 `upsert()` Implementation

```js
async function upsert(table, id, row) {
  if (!_connected) return;
  const { _id, __v, ...clean } = row;
  try {
    await model(table).findOneAndUpdate(
      { id },
      { $set: clean },
      { upsert: true, returnDocument: 'before' },
    );
  } catch (err) {
    console.error(`[MongoDB] upsert ${table}/${id} failed:`, err.message);
  }
}
```

### 4.5 `remove()` Implementation

```js
async function remove(table, id) {
  await model(table).deleteOne({ id });
}
```

---

## 5. Mongoose Schema Design

### 5.1 Schema Options Rationale

| Option | Value | Rationale |
|---|---|---|
| `strict` | `false` | Allow any field shape; accommodates schema evolution without migration scripts |
| `timestamps` | `false` | Disabled — db.js manages `createdAt`/`updatedAt` as ISO strings. Mongoose `timestamps:true` stores BSON Date objects which break ISO-string comparators and caused cameras to disappear on refresh |
| `minimize` | `false` | Preserve empty objects (e.g., `aiTargets: {}`) |
| `id` field | `String, required` | UUID v4 string; never ObjectId |

### 5.2 Schema Inheritance

All seven collections share a single `flexSchema` definition. Each collection gets a **clone** via `flexSchema.clone()` to avoid Mongoose model-sharing issues:

```js
_models[table] = mongoose.model(table, flexSchema.clone(), table);
                                              ^^^^^^^^^^^
                                     Independent schema copy per collection
```

### 5.3 Document Identity

```
Application `id` (UUID v4 string)         MongoDB `_id` (ObjectId)
───────────────────────────────────        ─────────────────────────
"f2ed29b1-ad46-47e3-baf9-8f083be954ed"    ObjectId("6654a3c1...")
Exposed in all API responses               Never exposed; stripped by lean()
Unique-indexed                             Default MongoDB primary key
Used in upsert filter: { id }             Ignored in application code
```

---

## 6. Index Strategy

### 6.1 Index Definitions

```js
// cameras
{ id: 1 }   unique

// zones
{ id: 1 }   unique
{ cameraId: 1 }

// events
{ id: 1 }   unique
{ cameraId: 1, timestamp: -1 }   compound (primary query pattern)
{ createdAt: -1 }

// alerts
{ id: 1 }   unique
{ cameraId: 1, createdAt: -1 }   compound
{ acknowledged: 1 }

// faceGalleries
{ id: 1 }   unique

// faceGalleryFaces
{ id: 1 }   unique
{ galleryId: 1 }

// settings
{ id: 1 }   unique
```

### 6.2 Query Pattern Analysis

| Query Pattern | Collection | Index Used | Estimated Frequency |
|---|---|---|---|
| `WHERE cameraId = X ORDER BY timestamp DESC LIMIT 100` | `events` | `{ cameraId, timestamp }` | Very High (dashboard) |
| `WHERE cameraId = X AND timestamp BETWEEN t1 AND t2` | `events` | `{ cameraId, timestamp }` | High (analytics) |
| `WHERE acknowledged = false` | `alerts` | `{ acknowledged }` | High (operator dashboard) |
| `WHERE cameraId = X ORDER BY createdAt DESC LIMIT 50` | `alerts` | `{ cameraId, createdAt }` | High |
| `WHERE galleryId = X` | `faceGalleryFaces` | `{ galleryId }` | Medium (face matching) |
| `WHERE id = X` (single document lookup) | All | `{ id }` unique | High |

### 6.3 Events Collection — Volume Projection

| Cameras | FPS | Events/hour | Events/day | Events/30 days |
|---|---|---|---|---|
| 4 | 10 | ~200 | ~4 800 | ~144 K |
| 16 | 10 | ~800 | ~19 200 | ~576 K |
| 64 | 10 | ~3 200 | ~76 800 | ~2.3 M |

**Recommendation**: Implement TTL index on `events.createdAt` for deployments retaining data ≤ 90 days:
```js
{ createdAt: 1 }  expireAfterSeconds: 7776000  // 90 days
```

---

## 7. Startup Sequence Diagram

```
Server Process Start
      │
      ▼
  require('./db')        ← db.js shim → db/index.js
      │
      ▼
  index.js: await initDB()
      │
      ├─── DB_TYPE !== 'mongodb' (or absent)
      │        │
      │        ▼
      │    new JsonDatabase().init()
      │        │  loadFromDisk() → reads lts.json into _store
      │        │  runLegacyMigrations() (users.json / tokens.json / audit.json)
      │        └─ console '[DB] Storage mode: JSON'
      │                                                            server.listen(3080)
      │
      └─── DB_TYPE === 'mongodb'
              │
              ▼
          MONGODB_URI present?
              │
              ├── NO → [FATAL] process.exit(1) ← MONGODB_URI 설정 필요
              │
              └── YES
                      │
                      ▼
                  ensureMongoDB()  (ensureMongodb.js)  ← index.js에서 initDB() 전에 호출
                      │
                      ├─ 원격 URI (Atlas/SRV/non-localhost) → skip TCP probe (pass-through)
                      │
                      └─ 로컬 URI → TCP probe (1.5 s)
                              │
                              ├── 응답 있음 → 정상 진행
                              │
                              └── 응답 없음
                                      │
                                      ├─ mongod 설치됨 → systemctl/brew/net start → 20 s 대기
                                      │       ├── 성공 → 정상 진행
                                      │       └── 실패 → [FATAL] process.exit(1)
                                      │
                                      └─ mongod 미설치 → 설치 가이드 출력 → [FATAL] process.exit(1)
                      │
                      ▼
                  new MongoDatabase().init()
                      │
                      ├── connect timeout (5 s) → throw → main().catch() → process.exit(1)
                      │
                      └── success
                              │
                              ▼
                          mongoSvc.loadAll()
                              │  sorted by createdAt desc, capped per LOAD_LIMITS
                              │  normalizeDates() converts Date → ISO string
                              │  populates _store (lts.json NOT read)
                              ▼
                          console '[DB] Storage mode: MongoDB'
                              │
                              ▼
                          server.listen(3080)
```

---

## 8. Write Dispatch Sequence Diagram

### 8.1 JSON Mode (`DB_TYPE=json`)

```
Route Handler              JsonDatabase              lts.json
     │                          │                       │
     │  db.insert/update(...)   │                       │
     │─────────────────────────►│                       │
     │                          │  mutate _store        │
     │                          │  _schedulePersist()   │
     │                          │  [debounced 2 s]      │
     │◄─ return (synchronous) ──│                       │
     │                          │  [2 s debounce fires] │
     │                          │  _flushAsync()        │
     │                          │  writeFile → .tmp ───►│
     │                          │  rename(.tmp → lts)  ─┤  (atomic POSIX)
```

### 8.2 MongoDB Mode (`DB_TYPE=mongodb`)

```
Route Handler           MongoDatabase          mongoDbService.js     MongoDB
     │                       │                        │                  │
     │  db.insert/update()   │                        │                  │
     │──────────────────────►│                        │                  │
     │                       │  mutate _store (sync)  │                  │
     │◄─ return (sync) ──────│                        │                  │
     │                       │  _persist('upsert', …) │                  │
     │                       │  [async, fire-and-      │                  │
     │                       │   forget]              │                  │
     │                       │───────────────────────►│                  │
     │                       │                        │  findOneAndUpdate│
     │                       │                        │─────────────────►│
     │                       │                        │◄── acknowledge ──│
     │                       │  (error → log only)    │                  │
     │                       │                        │                  │
     │  [on disconnect]      │                        │                  │
     │                       │  isConnected() === false                  │
     │                       │  → hold in-memory only │                  │
     │                       │  → no JSON write       │                  │
     │                       │  → log ERROR once      │                  │
```

---

## 9. Migration Script Design

### 9.1 Script Flow

```
node server/src/scripts/migrateToMongo.js
      │
      ▼
  Load environment (dotenv)
      │
      ▼
  Read STORAGE_PATH/lts.json
      │  parse JSON → plain JS object
      ▼
  mongoSvc.connect(MONGODB_URI, MONGODB_DB)
      │
      ▼
  For each table in ALL_TABLES:
      │
      ├── For each doc in store[table]:
      │       mongoSvc.upsert(table, doc.id, doc)
      │       ├── success → successCount++
      │       └── error → errorCount++; log error
      │
      └── Print summary line
      │
      ▼
  mongoSvc.disconnect()
      │
      ▼
  process.exit(errorCount > 0 ? 1 : 0)
```

### 9.2 Idempotency Guarantee

`mongoSvc.upsert()` uses `updateOne({ id }, { $set: row }, { upsert: true })`:
- First run: inserts documents.
- Subsequent runs: updates documents in-place (same data = no visible change).
- No document duplication possible.

### 9.3 `createdAt` Preservation

To prevent Mongoose `timestamps` from overwriting the original `createdAt`, the upsert uses `$set` without `$currentDate`:

```js
// Preserves existing createdAt from lts.json
await Model.updateOne(
  { id },
  { $set: { ...doc } },   // includes doc.createdAt from lts.json
  { upsert: true }
);
```

---

## 10. Docker Compose Integration

### 10.1 MongoDB Service Definition

```yaml
# docker-compose.yml (excerpt)
services:
  mongo:
    image: mongo:7.0
    container_name: lts_mongo
    restart: unless-stopped
    environment:
      MONGO_INITDB_DATABASE: lts2026
    volumes:
      - mongo_data:/data/db
    ports:
      - "27017:27017"
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5

  server:
    build: ./server
    depends_on:
      mongo:
        condition: service_healthy
    environment:
      DB_TYPE: mongodb
      MONGODB_URI: mongodb://mongo:27017
      MONGODB_DB: lts2026

volumes:
  mongo_data:
```

### 10.2 `.env.example`

```dotenv
# ── Storage Mode ──────────────────────────────────────────────────────────
# json   = JSON file only (default, no external dependency)
# mongodb = MongoDB write-through (requires MONGODB_URI)
DB_TYPE=json

# ── MongoDB (required only when DB_TYPE=mongodb) ──────────────────────────
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=lts2026

# ── Storage Path ─────────────────────────────────────────────────────────
STORAGE_PATH=./storage
```

---

## 11. Data Flow Diagrams

### 11.1 JSON Mode Data Flow

```
POST /api/cameras  →  camerasRouter.js
        │
        ▼
  db.prepare('INSERT INTO cameras ...').run({
    id: uuid(), name, rtspUrl, ...
  })
        │
        ├── store.cameras.push(row)
        └── persistJson()
              │
              ▼
         storage/lts.json  (written synchronously)
```

### 11.2 MongoDB Mode Data Flow

```
POST /api/cameras  →  camerasRouter.js
        │
        ▼
  db.insert('cameras', { id: uuid(), name, rtspUrl, ... })
        │
        ├── store.cameras.push(row)                  [sync]
        │   (no persistJson() — MongoDB is primary)
        └── mongoSvc.upsert('cameras', id, row)      [async, fire-and-forget]
                │
                ▼
           MongoDB cameras collection
           { id, name, rtspUrl, ..., _id (hidden by lean()) }

  [on MongoDB disconnect]
        └── writes held in-memory only; NO JSON write (DB_TYPE=mongodb)
            log ERROR: "[DB] MongoDB disconnected — writes are in-memory only"
```

### 11.3 Startup Hydration Flow (MongoDB Mode)

```
server start
    │
    ├── loadFromJson()     → store = { cameras:[...], ... }  from lts.json
    │
    └── mongoSvc.loadAll() → mongoStore = { cameras:[...], ... }  from MongoDB
            │
            └── for each table: store[t] = mongoStore[t]
                    (MongoDB data takes precedence on startup)
```

---

## 12. Security Design

### 12.1 Credential Handling

| Risk | Mitigation |
|---|---|
| MongoDB URI in source code | Mandatory environment variable; `.env` in `.gitignore` |
| Camera passwords in logs | `password` field excluded from all `console.log` outputs |
| `_id` ObjectId exposure | Stripped by `lean()` in `loadAll()` and never inserted into in-memory store |
| SQL injection via `prepare(sql)` | `sql` pattern is developer-controlled, not user input; table name extracted by regex, not evaluated |
| MongoDB injection | All filters use literal field equality (`{ id: row.id }`); no `$where` or operator injection possible |

### 12.2 Sensitive Field Policy

The `cameras.password` field is stored in plain text in the current architecture (matching the existing JSON behavior). Future hardening should:
1. Store only a bcrypt hash or AES-256-GCM encrypted value.
2. Decrypt at camera stream startup using a server-side key from environment.

This is tracked as a security enhancement (NFR-STORAGE-007 compliance).

---

## 13. Error Handling Strategy

### 13.1 Error Classification

| Error Type | Location | Handling | Impact |
|---|---|---|---|
| `lts.json` parse error | `loadFromJson()` | Catch, log, reset `store` to empty | Server starts; data lost from corrupted file |
| `lts.json` write error | `persistJson()` | Catch, log ERROR | Data not persisted; in-memory still correct |
| MongoDB connection timeout (startup) | `mongoDbService.connect()` | Throw → `main().catch()` → `process.exit(1)` | 서버 시작 거부 — JSON fallback 없음 |
| `MONGODB_URI` absent (DB_TYPE=mongodb) | `ensureMongoDB()` | `fatalExit()` → `process.exit(1)` | 서버 시작 거부 — server/.env에 MONGODB_URI 설정 필요 |
| 로컬 MongoDB 미실행·재시작 실패 (DB_TYPE=mongodb) | `ensureMongoDB()` | 자동 재시작 시도 → 실패 시 `fatalExit()` → `process.exit(1)` | 서버 시작 거부 — `sudo systemctl start mongod` 필요 |
| MongoDB upsert error | `mongoDbService.upsert()` | Caught inside upsert; logged | Write lost in MongoDB; no JSON fallback |
| MongoDB remove error | `mongoDbService.remove()` | Same as upsert | |
| MongoDB disconnection (runtime) | `mongoose.connection.on('disconnected')` | `_connected = false`; retry 스케줄링 시작 | writes held in-memory; keep-alive 5s 마다 상태 로깅; 자동 재연결 시도 |

### 13.2 Logging Format

```
[DB] <message>              — db.js internal
[MongoDB] <message>         — mongoDbService.js events
[Migration] <message>       — migrateToMongo.js progress
```

---

## 14. Configuration Reference

### 14.1 Complete Configuration Matrix

| `DB_TYPE` | `MONGODB_URI` | `MONGODB_DB` | Behaviour |
|---|---|---|---|
| `json` (or absent) | Any | Any | JSON mode; lts.json only |
| `mongodb` | Valid URI | Set | Full MongoDB write-through |
| `mongodb` | Valid URI | Absent | Database name defaults to `lts2026` |
| `mongodb` | Absent | Any | Log WARN; fall back to JSON mode |
| `mongodb` | Invalid URI | Any | Connect timeout (5 s) → fall back to JSON mode |

### 14.2 Runtime Validation Checklist

Before going to production with MongoDB mode:

- [ ] `MONGODB_URI` is set and tested with `mongosh`
- [ ] `MONGODB_DB` matches the intended database name
- [ ] MongoDB user has `readWrite` role on `MONGODB_DB`
- [ ] `lts.json` is writable by the Node.js process
- [ ] `mongo` Docker service is in `depends_on` for `server`
- [ ] Migration script has been run once: `node server/src/scripts/migrateToMongo.js`
- [ ] Compound indexes verified: `db.events.getIndexes()` shows `{ cameraId, timestamp }` index
- [ ] TTL index considered for `events.createdAt` (for long-running deployments)

---

## 15. v1.1 Amendment — Atomic Write & Write Debounce

### 15.1 Problem Statement

In v1.0, `persistJson()` was called synchronously on every `db.insert()` / `db.update()` invocation. With `detectionSnapshots` growing to 6,000+ records (each containing a base64-encoded JPEG crop), the serialized `lts.json` exceeds 36 MB. This caused two critical issues:

| # | Issue | Impact |
|---|---|---|
| 1 | **Event-loop blocking** | `writeFileSync` of a 36 MB file holds the JS event loop for tens of milliseconds per detection frame | 
| 2 | **File corruption on crash** | `kill -9` during an in-progress write leaves a partially written file; `JSON.parse` fails on next startup; the in-memory store initializes empty; all data appears lost |

### 15.2 Solution Architecture

```
 db.insert() / db.update()
      │
      ▼
  persistJson()
      │  if _persistTimer already set → return (coalesce)
      │  else: set 2 s debounce timer
      ▼
  [2 s debounce fires]
      │
      ▼
  _flushJson()
      ├── writeFileSync(lts.json.tmp)    ← full serialization to temp file
      └── renameSync(lts.json.tmp, lts.json)  ← atomic POSIX rename

  SIGTERM / SIGINT
      │
      ▼
  flushNow()  → clearTimeout + _flushJson()  (immediate, bypass debounce)
      │
      ▼
  httpServer.close()  → process.exit(0)
```

### 15.3 Key Constants & Variables

| Symbol | Value | Description |
|---|---|---|
| `PERSIST_DEBOUNCE_MS` | `2000` | Max milliseconds between write invocations |
| `TEMP_DB_PATH` | `DB_PATH + '.tmp'` | Temp file path for atomic rename |
| `_persistTimer` | `null \| NodeJS.Timeout` | Active debounce timer handle |
| `_persistPending` | `boolean` | Set true on any mutation, cleared before `_flushJson()` |
| `_writingJson` | `boolean` | Set true while async `_flushJson()` is in progress; prevents `flushNow()` from starting a concurrent sync write to the same `.tmp` file |

### 15.4 Implementation Detail (`db.js`)

```js
const PERSIST_DEBOUNCE_MS = 2000;
const TEMP_DB_PATH = DB_PATH + '.tmp';
let _persistTimer   = null;
let _persistPending = false;
let _writingJson    = false;  // true while async _flushJson() is running

// Tables excluded from JSON fallback writes (base64 blobs / high-volume).
// Prevents 20-100 MB serialization stall when MongoDB disconnects.
const JSON_FALLBACK_SKIP = new Set([
  'detectionSnapshots', 'client_logs', 'client_webrtc_stats', 'onvif_events',
  'detectionTracks', 'analysisEvents', 'faceMatchHistory', 'missing_person_detections',
  'events', 'audit_logs',
]);

function persistJson() {
  _persistPending = true;
  if (_persistTimer) return;  // already scheduled — coalesce writes
  _persistTimer = setTimeout(() => {
    _persistTimer  = null;
    _persistPending = false;
    _flushJson();
  }, PERSIST_DEBOUNCE_MS);
}

async function _flushJson() {
  _writingJson = true;
  try {
    const payload = process.env.DB_TYPE === 'mongodb'
      ? Object.fromEntries(Object.entries(store).filter(([t]) => !JSON_FALLBACK_SKIP.has(t)))
      : store;
    await fs.promises.writeFile(TEMP_DB_PATH, JSON.stringify(payload, null, 2));
    await fs.promises.rename(TEMP_DB_PATH, DB_PATH);
  } catch (err) {
    console.error('[DB] JSON persist error:', err.message);
    try { await fs.promises.unlink(TEMP_DB_PATH); } catch (_) {}
  } finally {
    _writingJson = false;
  }
}

function flushNow() {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  if (_persistPending) {
    _persistPending = false;
    if (_writingJson) return;  // async write already in progress — let it finish
    try {
      const payload = process.env.DB_TYPE === 'mongodb'
        ? Object.fromEntries(Object.entries(store).filter(([t]) => !JSON_FALLBACK_SKIP.has(t)))
        : store;
      fs.writeFileSync(TEMP_DB_PATH, JSON.stringify(payload, null, 2));
      fs.renameSync(TEMP_DB_PATH, DB_PATH);
    } catch (err) { console.error('[DB] flushNow error:', err.message); }
  }
}

module.exports = { initDB, getDB, getStorageMode, flushNow, getDbStats };
```

### 15.5 Graceful Shutdown Integration (`index.js`)

```js
const { initDB, flushNow } = require('./db');

function gracefulShutdown(signal) {
  console.log(`[Server] Received ${signal}, shutting down gracefully...`);
  io.close();
  flushNow();          // ← flush any pending debounced write BEFORE closing
  httpServer.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000); // force exit after 10 s
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
```

### 15.6 Correctness Guarantee

- **Atomicity**: `fs.renameSync` on Linux/POSIX replaces the destination file descriptor atomically. Readers always see either the complete old file or the complete new file; never a partial write.
- **SIGKILL safety**: Because `lts.json.tmp` is only renamed to `lts.json` after a complete, successful `writeFileSync`, a `kill -9` during the write leaves `lts.json.tmp` as orphan (incomplete) and `lts.json` as the last valid snapshot.
- **Data staleness window**: At most `PERSIST_DEBOUNCE_MS` (2 s) of inserts may be lost on a `kill -9`. Graceful shutdown (`SIGTERM`/`SIGINT`) has zero data loss.

### 15.7 Impact on `ALL_TABLES`

`faceMatchHistory` was added to `ALL_TABLES` alongside `detectionSnapshots` in this release:

```js
const ALL_TABLES = [
  'cameras', 'zones', 'events', 'alerts',
  'faceGalleries', 'faceGalleryFaces', 'settings',
  'detectionSnapshots',           // added in v1.0
  'faceMatchHistory',             // added in v1.1 (Face ID Live Match)
  'analysisEvents',               // added in v1.2 (Analysis Mode Event Persistence)
  'client_logs',                  // added in v1.3 (client log ingestion)
  'client_webrtc_stats',          // added in v1.3 (WebRTC PeerConnection stats)
  'onvif_events',                 // added in v1.3 (ONVIF event storage)
  'onvif_event_types',            // added in v1.3 (ONVIF type registry)
  'detectionTracks',              // added in v1.3 (detection track history)
  'missing_persons',              // added in v1.3 (missing person registry)
  'missing_person_detections',    // added in v1.3 (missing person detection matches)
  'users',                        // added in v1.4 (Auth service unified storage)
  'refresh_tokens',               // added in v1.4 (Auth service unified storage)
  'audit_logs',                   // added in v1.4 (Auth service unified storage)
];
// Note: MONGO_ONLY_TABLES was removed in v1.5.
// High-volume tables that should not appear in JSON fallback writes are
// listed in JSON_FALLBACK_SKIP instead (see Section 15.4).
```

### 15.8 `analysisEvents` 컬렉션 (v1.2)

Analysis 서버(`SERVER_MODE=analysis` / `combined`)가 감지한 화재·연기·배회 이벤트를 영구 저장합니다.

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string (UUID) | 이벤트 식별자 |
| `type` | `'fire' \| 'smoke' \| 'loitering'` | 이벤트 유형 |
| `cameraId` | string | 출처 카메라 ID |
| `cameraName` | string | 출처 카메라 이름 |
| `timestamp` | ISO 8601 | 이벤트 발생 시각 |
| `confidence` | number 0-1 | 감지 신뢰도 (fire/smoke만) |
| `bbox` | object | 감지 영역 (fire/smoke만) |
| `objectId` | number | 추적 객체 ID (loitering만) |
| `dwellTime` | number | 체류 시간 초 (loitering만) |
| `zoneId` | string | 구역 ID (loitering만) |
| `zoneName` | string | 구역 이름 (loitering만) |
| `riskScore` | number 0-1 | 위험 점수 (loitering만) |
| `cropData` | string? | 감지 영역 JPEG Base64 data URI (fire/smoke/loitering 공통, 없을 수 있음) |

**저장 정책**: 화재/연기 30초 쿨다운, 배회 60초 쿨다운, 컬렉션 최대 500건 유지.
**조회**: `GET /api/analysis/events?limit=N&type=fire,smoke,loitering`
**삭제**: `DELETE /api/analysis/events`

---

## 16. v1.4 Amendment — Auth Service Unified Storage

### 16.1 New Tables

The following three tables were added to `ALL_TABLES` in `db.js` as part of unifying the authentication service storage layer. Previously, `UserService.js`, `TokenService.js`, and `AuditService.js` each wrote directly to separate JSON files (`users.json`, `tokens.json`, `audit.json`). They now use `getDB().insert/update/delete/find/all()` exclusively.

| Table | Purpose | JSON Fallback |
|---|---|---|
| `users` | User accounts — email, passwordHash, role, status, OAuth provider | Yes (included in fallback) |
| `refresh_tokens` | JWT refresh token hashes — tokenHash, userId, expiresAt, revoked | No (in `JSON_FALLBACK_SKIP`) |
| `audit_logs` | Auth audit trail — event, userId, email, ip, ts | No (in `JSON_FALLBACK_SKIP`) |

> `MONGO_ONLY_TABLES` was removed in v1.5. High-volume / sensitive tables that must not appear in JSON fallback writes are now listed in `JSON_FALLBACK_SKIP` inside `db.js`. The `audit_logs` table is excluded from JSON fallback to prevent unbounded growth of `lts.json`.

### 16.2 Row Caps

```js
const ROW_CAPS = {
  refresh_tokens: 10000,
  audit_logs: 10000,
};
```

When a table exceeds its cap, the oldest entries are evicted automatically to keep memory bounded.

### 16.3 One-Time Legacy Migration

On first startup after upgrading, `initDB()` checks whether the target table is empty. If so, it reads each legacy file and imports rows into `db.js`:

| Legacy File | Target Table |
|---|---|
| `storage/users.json` | `users` |
| `storage/tokens.json` | `refresh_tokens` |
| `storage/audit.json` | `audit_logs` |

The migration is **idempotent** — if the target table is already populated, it is skipped. After migration, the legacy files remain on disk but are no longer read or written by the application.

---

## 17. v1.5 Amendment — MongoDB-Only Writes, ensureMongodb.js, Bug Fixes

### 17.1 Changes

| # | Change | Detail |
|---|---|---|
| 1 | **MongoDB-only writes** | `afterWrite()` skips `persistJson()` when `_isMongo()` is true. JSON written only on disconnect. |
| 2 | **`JSON_FALLBACK_SKIP`** | Set of 10 high-volume tables excluded from JSON fallback writes to prevent 20-100 MB event-loop stalls |
| 3 | **`timestamps: false`** | Mongoose timestamps disabled; `db.js` manages `createdAt`/`updatedAt` as ISO strings. Fixes cameras disappearing after refresh (BSON Date → `localeCompare` TypeError) |
| 4 | **`normalizeDates()`** | Applied in `loadAll()` to convert any legacy BSON Date objects to ISO strings |
| 5 | **`LOAD_LIMITS`** | Row caps applied per high-volume table when loading from MongoDB on startup |
| 6 | **`TABLES` expanded** | `mongoDbService.TABLES` now covers all 20 `ALL_TABLES` — previously missing 11 tables caused 401 errors on restart |
| 7 | **Async `_flushJson()`** | Changed from `writeFileSync` to `fs.promises.writeFile`; `_writingJson` flag prevents concurrent writes |
| 8 | **`ensureMongodb.js`** | New startup utility: TCP probe → systemctl restart → 20 s wait → install guide for platform |
| 9 | **`connect()` options** | `socketTimeoutMS` raised to 45000; added `heartbeatFrequencyMS: 10000`, `maxIdleTimeMS: 60000` |
| 10 | **`MONGO_ONLY_TABLES` removed** | Replaced by `JSON_FALLBACK_SKIP` which is applied in both `_flushJson()` and `flushNow()` |

### 17.2 `ensureMongodb.js` Design

```
ensureMongoDB()  (runs once at server startup when DB_TYPE=mongodb)
      │
      ├── Atlas SRV URI detected → skip (remote; no local control)
      │
      ├── tcpConnect(host, port, 3000ms) → success → return (MongoDB already up)
      │
      └── TCP connect failed
              │
              ├── mongodInstalledPath() found
              │       │
              │       ├── trySystemctlStart() → wait 20 s → probe again
              │       │       → success → return
              │       │       → still failing → log WARN (server continues in JSON mode)
              │
              └── mongod not installed
                      → printInstallGuide(platform)
                        (Ubuntu: shows correct apt repo URL via lsb_release -cs)
                      → log WARN (server continues in JSON mode)
```

---

## 18. v1.7 Amendment — Pluggable DB Backend Architecture

### 18.1 Overview

`db.js` (단일 파일 1,000+ 줄)를 추상 인터페이스 + 백엔드 클래스 구조로 분리하여 향후 SQLite, Oracle 등 새 백엔드를 최소 변경으로 추가할 수 있도록 아키텍처를 개선합니다.

### 18.2 변경 요약

| # | 변경 | 상세 |
|---|---|---|
| 1 | **`server/src/db/` 디렉토리 신설** | `BaseDatabase.js`, `JsonDatabase.js`, `MongoDatabase.js`, `constants.js`, `index.js` |
| 2 | **`server/src/db.js` → shim** | `module.exports = require('./db/index')` — 모든 기존 `require('../db')` 호환 유지 |
| 3 | **`BaseDatabase` 추상 클래스** | `insert/update/delete/find/findOne/all/init/getMode/isConnected/getStats` 정의; 미구현 시 Error throw |
| 4 | **`JsonDatabase`** | 기존 JSON 파일 로직을 클래스로 분리; `_loadFromDisk`, `_runLegacyMigrations`, `_schedulePersist`, `_flushAsync` 유지 |
| 5 | **`MongoDatabase`** | `init()` 에서 lts.json 를 **절대 읽지 않음** — MongoDB 스냅샷만 사용; 빈 배열도 정상 처리 |
| 6 | **`constants.js`** | `ALL_TABLES`, `TABLE_ROW_CAPS`, `LEGACY_MIGRATIONS` 공유 상수 분리 |
| 7 | **`db/index.js` 팩토리** | `DB_TYPE` → 백엔드 선택 → `initDB()` 실행; 실패 시 JsonDatabase 폴백 |
| 8 | **`missingPersonService.js` 정리** | 죽은 코드 `_ensureTables()` + 7개 호출부 제거; `db._tables` 직접 접근 제거 |

### 18.3 Analysis 서버 lts.json 오염 버그 수정

이전 `db.js`는 `initDB()` 진입 시 항상 `loadFromJson()`을 먼저 호출하여 로컬 `lts.json`을 인메모리에 로드한 후 MongoDB 스냅샷으로 덮어썼습니다. Analysis 서버(별도 호스트)가 streaming 서버와 다른 lts.json을 갖고 있을 경우 공유 MongoDB를 오염시키는 버그였습니다.

**`MongoDatabase.init()`** 은 lts.json을 읽지 않고 MongoDB snapshot만 사용합니다.

### 18.4 새 백엔드 추가 방법

```js
// 1. server/src/db/SqliteDatabase.js 생성
class SqliteDatabase extends BaseDatabase {
  getMode() { return 'sqlite'; }
  async init() { /* connect, load */ }
  insert(table, row) { /* … */ }
  // … 나머지 메서드 구현
}
module.exports = SqliteDatabase;

// 2. db/index.js _createBackend()에 case 추가
case 'sqlite': return new SqliteDatabase();

// 3. server/.env 설정
DB_TYPE=sqlite
```

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for DB Layer (JSON/MongoDB/pluggable backends) |
| 1.2 | 2026-06-10 | LTS Engineering Team | Section 15.8 추가: analysisEvents 컬렉션 스키마 및 저장 정책, ALL_TABLES v1.2 업데이트 |
| 1.3 | 2026-06-10 | LTS Engineering Team | analysisEvents 스키마에 `cropData` 필드 추가 (감지 영역 JPEG Base64) |
| 1.4 | 2026-06-17 | LTS Engineering Team | users, refresh_tokens, audit_logs 테이블 추가 — 인증 서비스 저장소 통합 |
| 1.5 | 2026-06-18 | LTS Engineering Team | MongoDB-only 쓰기, timestamps:false, normalizeDates, LOAD_LIMITS, JSON_FALLBACK_SKIP, ensureMongodb.js, async _flushJson, 연결 옵션 업데이트 |
| 1.6 | 2026-06-22 | LTS Engineering Team | DB_TYPE=mongodb 시 lts.json JSON fallback 완전 제거 — disconnect 시 in-memory only, flushNow/persistJson/afterWrite 전면 수정 |
| 1.7 | 2026-06-23 | LTS Engineering Team | 플러그어블 DB 백엔드 아키텍처: BaseDatabase 추상 클래스, JsonDatabase/MongoDatabase 분리, db/index.js 팩토리, constants.js 공유, db.js shim |
| 1.8 | 2026-06-23 | LTS Engineering Team | DB_TYPE=mongodb 시작 시 JSON fallback 완전 제거(서버 시작 거부) · mongoDbService 5초 keep-alive 핑 + 선형 back-off 재연결 Retry 추가 |
| 1.9 | 2026-06-25 | LTS Engineering Team | `queryAsync()` 비동기 직접 조회 API 추가 — `BaseDatabase`: 기본 구현(in-memory sort/slice); `MongoDatabase`: MongoDB 직접 조회(연결 해제 시 in-memory fallback); `mongoDbService.findDirect()` 신규. `TABLES` 누락 보완 (`faceTrajectories`, `tc_results`); `onvif_snapshots` 는 frameData 블롭 크기로 in-memory hydration 영구 제외, `queryAsync()` 로 요청 시점 직접 조회. `LOAD_LIMITS`에 `faceTrajectories`(5000), `tc_results`(10000) 추가. |
| 2.0 | 2026-06-26 | LTS Engineering Team | §7 Startup Sequence 개정: DB_TYPE=mongodb 시 MongoDB 미연결 → process.exit(1) (lts.json fallback 완전 제거); §13 Error Handling 업데이트; ensureMongoDB() index.js에서 initDB() 전 호출 명시 |
| 2.1 | 2026-07-21 | Claude | **데이터 유실 버그 수정**: `MongoDatabase.flushNow()`가 완전한 no-op이었음(`_persist()`의 `_mongo.remove()`/`upsert()`가 순수 fire-and-forget이라 in-flight write를 아무도 추적하지 않음) — `DELETE`/`update` API가 in-memory 제거만으로 즉시 성공 응답하고, 실제 MongoDB 쓰기가 아직 진행 중인 상태에서 서버가 재시작되면 그 변경이 통째로 유실되고 다음 부팅의 하이드레이션이 예전 레코드를 되살리는 구조였음(카메라 삭제로 실측 재현·검증). `MongoDatabase`에 `_pendingWrites` Set 추가해 진행 중인 쓰기를 추적, `flushNow()`를 `async`로 변경해 `Promise.allSettled()`로 실제 대기하도록 수정 — `BaseDatabase`/`db/index.js` 인터페이스도 async로 통일, `index.js`의 graceful shutdown이 `await flushNow()`로 호출하도록 수정. 카메라 테이블에 국한되지 않고 `db.delete()`/`db.update()`를 쓰는 모든 테이블에 해당하던 버그. 상세: `Design_RTSP_Capture_Backend.md` §6.29.15 |
