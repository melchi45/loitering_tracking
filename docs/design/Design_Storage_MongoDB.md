# DESIGN DOCUMENT
# Storage Layer — JSON / MongoDB Persistence

| | |
|---|---|
| **Document ID** | DESIGN-STORAGE-001 |
| **Version** | 1.3 |
| **Status** | Active — amended 2026-05-27 |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_Storage_MongoDB.md |

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File & Module Structure](#2-file--module-structure)
3. [`db.js` — In-Memory Store Design](#3-dbjs--in-memory-store-design)
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
│  (All call db.prepare(sql).run/get/all — synchronous, no storage awareness) │
└─────────────────────────────┬───────────────────────────────────────────────┘
                              │ synchronous SQL-like API
┌─────────────────────────────▼───────────────────────────────────────────────┐
│                           db.js                                              │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    in-memory store                                   │    │
│  │  { cameras:[], zones:[], events:[], alerts:[],                      │    │
│  │    faceGalleries:[], faceGalleryFaces:[], settings:[] }             │    │
│  └──────────────────────────┬──────────────────────────────────────────┘    │
│                             │ afterWrite() / afterDeleteWhere()              │
│  ┌──────────────────────────▼──────────────────────────────────────────┐    │
│  │               persistJson()  [always, sync]                          │    │
│  │               mongoSvc.upsert/remove  [if MongoDB, async]            │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────┬──────────────────────────────────┬──────────────────────────┘
               │                                  │
               ▼                                  ▼
         lts.json                         MongoDB (mongoose)
    (storage/lts.json)                  collections: cameras,
    warm-standby backup                 zones, events, alerts,
    always written                      faceGalleries,
                                        faceGalleryFaces,
                                        settings
```

### 1.2 Dual-Mode Switch

```
DB_TYPE=json  (default)               DB_TYPE=mongodb
┌─────────────────────┐               ┌─────────────────────────────────────┐
│  loadFromJson()      │               │  loadFromJson() → loadAll() (mongo) │
│  reads lts.json      │               │  overwrite in-memory from MongoDB   │
│  into in-memory store│               │                                     │
│                      │               │  afterWrite:                        │
│  afterWrite:         │               │    persistJson() + mongo upsert     │
│    persistJson() only│               │    (fire-and-forget)                │
└─────────────────────┘               └─────────────────────────────────────┘
```

---

## 2. File & Module Structure

```
server/
├── src/
│   ├── db.js                         ← In-memory store + dual-mode dispatch
│   ├── services/
│   │   └── mongoDbService.js         ← Mongoose-based MongoDB adapter
│   └── scripts/
│       └── migrateToMongo.js         ← One-time JSON → MongoDB migration
├── storage/
│   ├── lts.json                      ← JSON warm-standby (cameras/zones/events/alerts/...)
│   ├── analytics.json                ← Analytics config (separate file, not db.js)
│   ├── tracker.json                  ← Tracker config (separate file, not db.js)
│   └── face_tracking.json            ← Face trajectory state (separate file, not db.js)
├── .env.example                      ← Environment variable template
└── docker-compose.yml                ← Includes `mongo` service when DB_TYPE=mongodb
```

> **Note**: `analytics.json`, `tracker.json`, and `face_tracking.json` are managed by their respective service modules directly (not through `db.js`). They are not MongoDB-backed.

---

## 3. `db.js` — In-Memory Store Design

### 3.1 Module-Level State

```js
// ── Constants ─────────────────────────────────────────────────────────────
const ALL_TABLES = [
  'cameras', 'zones', 'events', 'alerts',
  'faceGalleries', 'faceGalleryFaces', 'settings'
];

// ── In-memory store ───────────────────────────────────────────────────────
let store = {};
ALL_TABLES.forEach(t => { store[t] = []; });

// ── MongoDB service reference ─────────────────────────────────────────────
let mongoSvc = null;   // null = MongoDB not active

// ── Internal helpers ──────────────────────────────────────────────────────
function _isMongo() {
  return process.env.DB_TYPE === 'mongodb'
    && mongoSvc !== null
    && mongoSvc.isConnected();
}
```

### 3.2 `prepare(sql)` — SQL Parser

The parser uses regex to extract table name and operation from the SQL string:

```
sql.trim().toLowerCase()
  │
  ├── match /^(select|insert|update|delete)/  → op
  └── match /(?:from|into|update|table)\s+(\w+)/  → table
```

Returns a `Statement` object with `all()`, `get()`, `run()` closures that close over `table` and `op`.

### 3.3 Statement Execution Logic

```
stmt.run(params)
  │
  ├─ op === 'insert'
  │    row = { createdAt: now, ...params }
  │    store[table].push(row)
  │    afterWrite(table, row.id, row, 'insert')
  │    return { changes: 1, lastInsertRowid: row.id }
  │
  ├─ op === 'update'
  │    extract _where from params
  │    map store[table]: matching rows get { ...row, ...data, updatedAt: now }
  │    call afterWrite per updated row
  │    return { changes }
  │
  └─ op === 'delete'
       removedIds = matching row ids
       store[table] = store[table].filter(not matching)
       afterDeleteWhere(table, removedIds)
       return { changes }
```

### 3.4 `initDb()` — Async Startup Hook

```js
async function initDb() {
  loadFromJson();

  if (process.env.DB_TYPE === 'mongodb') {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.warn('[DB] MONGODB_URI not set — falling back to JSON mode');
      return;
    }
    try {
      mongoSvc = require('./services/mongoDbService');
      await mongoSvc.connect(uri, process.env.MONGODB_DB || 'lts2026');
      const mongoStore = await mongoSvc.loadAll();
      for (const t of ALL_TABLES) {
        if (Array.isArray(mongoStore[t])) store[t] = mongoStore[t];
      }
      console.log('[DB] In-memory store hydrated from MongoDB');
    } catch (err) {
      console.error('[DB] MongoDB init failed, using JSON mode:', err.message);
      mongoSvc = null;
    }
  }
}
```

---

## 4. `mongoDbService.js` — MongoDB Adapter Design

### 4.1 Module Structure

```js
// ── State ────────────────────────────────────────────────────────────────
let _connected = false;
const _models = {};

// ── Schema ───────────────────────────────────────────────────────────────
const flexSchema = new mongoose.Schema(
  { id: { type: String, required: true } },
  { strict: false, timestamps: true, minimize: false }
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
module.exports = { connect, disconnect, isConnected, loadAll, upsert, remove };
```

### 4.2 `connect()` Implementation

```js
async function connect(uri, dbName) {
  const opts = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 30000,
    ...(dbName ? { dbName } : {}),
  };
  await mongoose.connect(uri, opts);
  _connected = true;

  // Register lifecycle event listeners
  mongoose.connection.on('disconnected', () => { _connected = false; console.warn(...); });
  mongoose.connection.on('reconnected',  () => { _connected = true;  console.log(...);  });
  mongoose.connection.on('error', err   => { console.error('[MongoDB] error:', err.message); });

  // Ensure indexes exist for all collections
  for (const table of TABLES) {
    await model(table).createIndexes();
  }
  console.log('[MongoDB] connected →', uri);
}
```

### 4.3 `loadAll()` Implementation

```js
async function loadAll() {
  const result = {};
  for (const table of TABLES) {
    const docs = await model(table).find({}).lean();
    // Strip internal Mongoose fields before returning
    result[table] = docs.map(({ _id, __v, ...rest }) => rest);
  }
  return result;
}
```

### 4.4 `upsert()` Implementation

```js
async function upsert(table, id, row) {
  // Use $set to overwrite only provided fields; upsert creates if absent
  await model(table).updateOne(
    { id },
    { $set: row },
    { upsert: true }
  );
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
| `timestamps` | `{ createdAt: 'createdAt', updatedAt: 'updatedAt' }` | Auto-manages timestamps with LTS-2026 field naming |
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
  require('db.js')
      │  initialises store = { cameras:[], ... }
      ▼
  app.js / index.js
      │  await db.initDb()
      ▼
  loadFromJson()
      │  reads lts.json → store
      │
      ├─── DB_TYPE !== 'mongodb' ──────────────────────────────────────────►
      │                                                            server.listen(3001)
      │
      └─── DB_TYPE === 'mongodb'
              │
              ▼
          mongoSvc.connect(MONGODB_URI, MONGODB_DB)
              │
              ├── timeout (5 s) ──► log WARN → fall back to JSON ──► server.listen(3001)
              │
              └── success
                      │
                      ▼
                  mongoSvc.loadAll()
                      │  overwrites store with MongoDB data
                      ▼
                  log '[DB] In-memory store hydrated from MongoDB'
                      │
                      ▼
                  server.listen(3001)
```

---

## 8. Write Dispatch Sequence Diagram

```
Route Handler                 db.js                  mongoDbService.js      MongoDB
     │                          │                           │                  │
     │  db.prepare(sql).run(p)  │                           │                  │
     │─────────────────────────►│                           │                  │
     │                          │  mutate in-memory store   │                  │
     │                          │  (push / map / filter)    │                  │
     │                          │                           │                  │
     │                          │  persistJson() [sync]     │                  │
     │                          │  ──► lts.json written     │                  │
     │                          │                           │                  │
     │◄─ return { changes } ────│                           │                  │
     │                          │                           │                  │
     │    (caller continues)    │  _isMongo() === true?     │                  │
     │                          │───────────────────────────►                  │
     │                          │  mongoSvc.upsert(...)     │                  │
     │                          │  [async, fire-and-forget] │                  │
     │                          │                           │  updateOne()     │
     │                          │                           │─────────────────►│
     │                          │                           │◄── acknowledge ──│
     │                          │  (error → log only)       │                  │
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
  db.prepare('INSERT INTO cameras ...').run({
    id: uuid(), name, rtspUrl, ...
  })
        │
        ├── store.cameras.push(row)          [sync]
        ├── persistJson()                    [sync]  → storage/lts.json
        └── mongoSvc.upsert('cameras', id, row)  [async, Promise]
                │
                ▼
           MongoDB cameras collection
           { id, name, rtspUrl, ..., _id (hidden) }
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
| MongoDB connection timeout | `mongoDbService.connect()` | Throw to `initDb()`; caught → JSON mode | Server starts in JSON mode |
| MongoDB upsert error | `mongoDbService.upsert()` | Propagates to `afterWrite()`; logged | Write lost in MongoDB; JSON backup still written |
| MongoDB remove error | `mongoDbService.remove()` | Same as upsert | |
| MongoDB disconnection | `mongoose.connection.disconnected` | `_connected = false`; logged | Subsequent writes go to JSON only until reconnect |
| `MONGODB_URI` absent | `initDb()` | Log WARN; stay in JSON mode | No MongoDB writes |

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

### 15.4 Implementation Detail (`db.js`)

```js
const PERSIST_DEBOUNCE_MS = 2000;
const TEMP_DB_PATH = DB_PATH + '.tmp';
let _persistTimer  = null;
let _persistPending = false;

function persistJson() {
  _persistPending = true;
  if (_persistTimer) return;  // already scheduled — coalesce writes
  _persistTimer = setTimeout(() => {
    _persistTimer  = null;
    _persistPending = false;
    _flushJson();
  }, PERSIST_DEBOUNCE_MS);
}

function _flushJson() {
  try {
    fs.writeFileSync(TEMP_DB_PATH, JSON.stringify(store, null, 2));
    fs.renameSync(TEMP_DB_PATH, DB_PATH);  // atomic on POSIX
  } catch (err) {
    console.error('[DB] JSON persist error:', err.message);
    try {
      if (fs.existsSync(TEMP_DB_PATH)) fs.unlinkSync(TEMP_DB_PATH);
    } catch (_) {}
  }
}

function flushNow() {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  if (_persistPending) { _persistPending = false; _flushJson(); }
}

module.exports = { initDB, getDB, getStorageMode, flushNow };
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
  'detectionSnapshots',  // added in v1.0
  'faceMatchHistory',    // added in v1.1 (Face ID Live Match)
  'analysisEvents',      // added in v1.2 (Analysis Mode Event Persistence)
];
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

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Technical design for Storage MongoDB |
| 1.2 | 2026-06-10 | LTS Engineering Team | Section 15.8 추가: analysisEvents 컬렉션 스키마 및 저장 정책, ALL_TABLES v1.2 업데이트 |
| 1.3 | 2026-06-10 | LTS Engineering Team | analysisEvents 스키마에 `cropData` 필드 추가 (감지 영역 JPEG Base64) |
