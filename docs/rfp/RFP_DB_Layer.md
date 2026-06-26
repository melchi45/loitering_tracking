# REQUEST FOR PROPOSAL (RFP)
# Storage Layer — JSON / MongoDB Persistence

| | |
|---|---|
| **RFP Reference** | LTS-2026-STORAGE-001 |
| **Issue Date** | May 27, 2026 |
| **Proposal Deadline** | June 30, 2026 |
| **Repository** | [github.com/melchi45/loitering_tracking](https://github.com/melchi45/loitering_tracking) |

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Technical Requirements](#3-technical-requirements)
4. [Functional Requirements](#4-functional-requirements)
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Project Milestones & Deliverables](#6-project-milestones--deliverables)
7. [Proposal Evaluation Criteria](#7-proposal-evaluation-criteria)
8. [Terms and Conditions](#8-terms-and-conditions)
9. [Appendix — Data Model Overview](#9-appendix--data-model-overview)

---

## 1. Project Overview

### 1.1 Purpose

This RFP solicits proposals to design, implement, and validate a **dual-mode persistent storage layer** for the LTS-2026 Loitering Detection and Tracking System. The storage layer must operate in two modes — a zero-configuration **JSON file mode** (default) and a high-availability **MongoDB mode** — controlled by a single environment variable, without changing any application code above the `db.js` abstraction boundary.

### 1.2 Background

The LTS-2026 system currently persists all state in a single flat JSON file (`storage/lts.json`). This approach is ideal for rapid development and offline deployments, but it does not scale to production scenarios where multiple server instances, concurrent write bursts, or long-term historical querying are required. A MongoDB write-through layer has been implemented as a technical prototype; this RFP requests a full production-ready specification, implementation, and test suite.

### 1.3 Scope of Work

The selected vendor shall deliver:

- A finalized `db.js` abstraction that routes reads and writes through either JSON or MongoDB depending on the `DB_TYPE` environment variable.
- A `mongoDbService.js` that connects to MongoDB via Mongoose, exposes upsert/remove/loadAll, and manages reconnection.
- MongoDB collection schemas for all six LTS-2026 data tables.
- Migration scripts to promote an existing `lts.json` snapshot into MongoDB collections.
- A comprehensive test suite (unit + integration) covering both storage modes.
- Operational runbook — connection string configuration, Docker Compose setup, backup strategy, index management.

---

## 2. Background & Problem Statement

### 2.1 Current Architecture

```
Application Layer (route handlers, services)
        │  synchronous read/write calls
        ▼
      db.js  ──── lts.json  (single file, fsSync)
```

**Limitations of the JSON-only approach:**

| Concern | Impact |
|---|---|
| Single writer | Concurrent requests may cause partial-write race conditions |
| No indexing | Full-table scans on queries with WHERE clauses degrade linearly |
| File size growth | `events` and `alerts` arrays grow unbounded; file I/O slows |
| No replication | System outage = data loss; no hot-standby replica |
| Query power | No aggregation, no time-range index, no full-text search |

### 2.2 Target Architecture

```
Application Layer (unchanged synchronous API)
        │
        ▼
      db.js  ──── in-memory store  (source of truth for reads)
        │              │
        │         fsWriteSync (JSON backup — always written)
        │
        └──── mongoDbService.js (async, fire-and-forget)
                    │
                    ▼
               MongoDB Atlas / standalone  (collections = tables)
```

### 2.3 Key Design Decisions

| Decision | Rationale |
|---|---|
| In-memory store as read source | Keeps all existing synchronous route handlers unchanged |
| JSON as hot-standby | Allows instant cold-start even if MongoDB is unavailable |
| `id` as logical key (UUID string) | Prevents ObjectId leakage into application JSON responses |
| `strict: false` Mongoose schema | Accommodates evolving document shapes without migrations |
| Fire-and-forget writes | Prevents blocking the AI pipeline on MongoDB write latency |

---

## 3. Technical Requirements

### 3.1 Runtime Environment

| Component | Specification |
|---|---|
| Node.js | >= 18 LTS |
| MongoDB | >= 6.0 (Community or Atlas M0+) |
| Mongoose | >= 8.x |
| Docker Compose | Optional; provided `docker-compose.yml` must include a `mongo` service |
| OS | Linux (Ubuntu 22.04 LTS target) |

### 3.2 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DB_TYPE` | `json` | `json` = JSON-only mode; `mongodb` = MongoDB write-through mode |
| `MONGODB_URI` | — | Full MongoDB connection URI (required when `DB_TYPE=mongodb`) |
| `MONGODB_DB` | `lts2026` | Target database name |
| `STORAGE_PATH` | `./storage` | Directory for JSON fallback files |

### 3.3 Collections / Tables

| Collection | Description | Approximate volume |
|---|---|---|
| `cameras` | IP camera and YouTube stream registrations | < 100 documents |
| `zones` | Polygon-based monitoring and exclusion zones | < 500 documents |
| `events` | Loitering detection events (high write rate) | 10 K – 1 M documents |
| `alerts` | Triggered alert records | 1 K – 100 K documents |
| `faceGalleries` | Named face gallery groups | < 50 documents |
| `faceGalleryFaces` | Enrolled face records with ArcFace embedding references | < 10 K documents |
| `settings` | System-wide configuration singletons | 1–5 documents |

---

## 4. Functional Requirements

### 4.1 Dual-Mode Operation

- **FR-STORAGE-001**: The system shall select storage mode at startup based on `DB_TYPE`. No code change shall be required to switch modes.
- **FR-STORAGE-002**: In JSON mode, all reads and writes shall operate entirely on the in-memory store, with synchronous `lts.json` persistence after each write.
- **FR-STORAGE-003**: In MongoDB mode, the system shall load all collections from MongoDB into the in-memory store on startup before accepting any API requests.
- **FR-STORAGE-004**: In MongoDB mode, every in-memory write shall also fire an async MongoDB upsert or remove. Failures shall be logged but shall not propagate to the caller.
- **FR-STORAGE-005**: In MongoDB mode, the JSON file shall still be written after every mutation as a warm-standby backup.

### 4.2 Schema & Document Shape

- **FR-STORAGE-010**: Every document in every collection shall carry a UUID string field named `id` as the application-level primary key.
- **FR-STORAGE-011**: MongoDB shall use `id` as a unique index. The native `_id` field shall never be exposed to application code or API responses.
- **FR-STORAGE-012**: All documents shall carry ISO-8601 `createdAt` and `updatedAt` timestamps managed by Mongoose `timestamps` option.

### 4.3 Migration

- **FR-STORAGE-020**: A migration script (`server/src/scripts/migrateToMongo.js`) shall read `lts.json` and upsert all documents into MongoDB, preserving existing `createdAt` values.
- **FR-STORAGE-021**: The migration shall be idempotent — re-running it on the same data shall produce no duplicate documents.
- **FR-STORAGE-022**: The script shall print a per-collection summary (inserted / updated / unchanged counts) on completion.

### 4.4 Index Management

- **FR-STORAGE-030**: The `events` collection shall have a compound index on `{ cameraId: 1, timestamp: -1 }` to support time-range queries.
- **FR-STORAGE-031**: The `alerts` collection shall have a compound index on `{ cameraId: 1, createdAt: -1 }`.
- **FR-STORAGE-032**: The `faceGalleryFaces` collection shall have an index on `{ galleryId: 1 }`.
- **FR-STORAGE-033**: All collections shall have a unique index on `{ id: 1 }`.

### 4.5 Connection Lifecycle

- **FR-STORAGE-040**: When `DB_TYPE=mongodb`, the server SHALL verify MongoDB connectivity before accepting any API requests. `ensureMongoDB()` shall attempt TCP probe and automatic restart (local only). If MongoDB is unreachable after all attempts, the server SHALL exit immediately with exit code 1 and a diagnostic error banner. **Fallback to JSON mode is NOT permitted when `DB_TYPE=mongodb`.**
- **FR-STORAGE-040a**: When `DB_TYPE=mongodb` and `MONGODB_URI` is not set in `server/.env`, the server SHALL exit immediately with exit code 1.
- **FR-STORAGE-041**: On MongoDB disconnection *after* a successful startup, the server shall continue operating in in-memory-only mode; async MongoDB writes are silently dropped until reconnect.
- **FR-STORAGE-042**: `mongoDbService.disconnect()` shall be called during graceful server shutdown.

---

## 5. Non-Functional Requirements

| Category | Requirement |
|---|---|
| **Write latency** | MongoDB upsert P99 ≤ 50 ms on the same LAN as the server |
| **Startup load time** | Full MongoDB `loadAll()` for ≤ 100 K documents shall complete in ≤ 5 s |
| **Startup integrity** | When `DB_TYPE=mongodb`, server startup SHALL fail with exit code 1 if MongoDB is unreachable — no silent fallback to JSON |
| **Security** | MongoDB URI (including credentials) shall be stored only in environment variables or `.env` files, never in source code |
| **Scalability** | Schema shall support horizontal sharding on `cameraId` without structural changes |
| **Observability** | Connection, disconnection, reconnection, and write-error events shall be logged at WARN/ERROR level |
| **Test coverage** | Unit tests for `db.js` and `mongoDbService.js` combined ≥ 80% line coverage |

---

## 6. Project Milestones & Deliverables

| Phase | Milestone | Deliverable | Target Date |
|---|---|---|---|
| Phase 1 | Schema & Environment Setup | Mongoose schema file, Docker Compose `mongo` service, `.env.example` | Sprint 1 |
| Phase 2 | `mongoDbService.js` — Core | `connect`, `disconnect`, `loadAll`, `upsert`, `remove` | Sprint 1 |
| Phase 3 | `db.js` Integration | Dual-mode `afterWrite` dispatcher, `initDb()` startup hook | Sprint 2 |
| Phase 4 | Migration Script | `migrateToMongo.js` with idempotent upsert and summary log | Sprint 2 |
| Phase 5 | Index Management | Index creation on startup; documented index strategy | Sprint 2 |
| Phase 6 | Test Suite | Unit + integration tests, ≥ 80% coverage | Sprint 3 |
| Phase 7 | Operational Runbook | Connection guide, backup procedure, monitoring checklist | Sprint 3 |

---

## 7. Proposal Evaluation Criteria

| Criterion | Weight |
|---|---|
| Technical approach — dual-mode design clarity | 30% |
| Schema and index design quality | 20% |
| Test coverage and methodology | 25% |
| Operational runbook completeness | 15% |
| Schedule adherence | 10% |

---

## 8. Terms and Conditions

- All deliverables become property of the project under the existing repository license.
- MongoDB Community Edition is the minimum target; Atlas compatibility is required.
- No MongoDB-specific query syntax shall leak above the `db.js` boundary.

---

## 9. Appendix — Data Model Overview

### 9.1 `cameras` Document Shape

```json
{
  "id": "<UUID>",
  "name": "Camera 01",
  "rtspUrl": "rtsp://192.168.1.10/stream",
  "ip": "192.168.1.10",
  "mac": "00:11:22:33:44:55",
  "httpPort": 80,
  "username": "admin",
  "password": "<encrypted>",
  "status": "streaming",
  "aiEnabled": true,
  "webrtcEnabled": false,
  "createdAt": "2026-05-01T00:00:00.000Z",
  "updatedAt": "2026-05-01T00:00:00.000Z"
}
```

### 9.2 `zones` Document Shape

```json
{
  "id": "<UUID>",
  "cameraId": "<camera-UUID>",
  "name": "Entrance Zone",
  "type": "MONITOR",
  "polygon": [[0.1, 0.2], [0.5, 0.2], [0.5, 0.8], [0.1, 0.8]],
  "dwellThreshold": 30,
  "riskThreshold": 0.7,
  "createdAt": "2026-05-01T00:00:00.000Z",
  "updatedAt": "2026-05-01T00:00:00.000Z"
}
```

### 9.3 `events` Document Shape

```json
{
  "id": "<UUID>",
  "cameraId": "<camera-UUID>",
  "zoneId": "<zone-UUID>",
  "objectId": "<tracker-UUID>",
  "type": "loitering",
  "dwellTime": 45,
  "riskScore": 0.82,
  "snapshotPath": "storage/snapshots/<UUID>.jpg",
  "timestamp": 1748390400000,
  "createdAt": "2026-05-27T12:00:00.000Z"
}
```

### 9.4 `alerts` Document Shape

```json
{
  "id": "<UUID>",
  "cameraId": "<camera-UUID>",
  "zoneId": "<zone-UUID>",
  "eventId": "<event-UUID>",
  "severity": "HIGH",
  "acknowledged": false,
  "acknowledgedAt": null,
  "createdAt": "2026-05-27T12:00:00.000Z",
  "updatedAt": "2026-05-27T12:00:00.000Z"
}
```

### 9.5 `faceGalleries` Document Shape

```json
{
  "id": "<UUID>",
  "name": "VIP List",
  "description": "Known VIP faces for re-identification",
  "createdAt": "2026-05-01T00:00:00.000Z",
  "updatedAt": "2026-05-01T00:00:00.000Z"
}
```

### 9.6 `faceGalleryFaces` Document Shape

```json
{
  "id": "<UUID>",
  "galleryId": "<gallery-UUID>",
  "name": "John Doe",
  "imagePath": "storage/faces/<UUID>.jpg",
  "embedding": [0.123, -0.456, 0.789, "...512 floats..."],
  "metadata": { "department": "Security", "employeeId": "EMP-001" },
  "createdAt": "2026-05-01T00:00:00.000Z",
  "updatedAt": "2026-05-01T00:00:00.000Z"
}
```

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for DB Layer (pluggable storage backends) |
| 1.1 | 2026-06-26 | LTS Engineering Team | FR-STORAGE-040 개정: DB_TYPE=mongodb 시 MongoDB 미연결 → process.exit(1) (lts.json fallback 제거) |
