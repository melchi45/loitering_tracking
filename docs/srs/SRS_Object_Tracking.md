# Software Requirements Specification — Object Tracking

| Field         | Value                                   |
|---------------|-----------------------------------------|
| Doc ID        | SRS-TRK-001                             |
| Version       | 1.0.0                                   |
| Date          | 2026-05-26                              |
| Parent PRD    | PRD-LTS-2026 §4.2 Object Tracking       |
| Parent RFP    | RFP-LTS-2026 §3.1 Video Analytics       |
| Status        | Approved                                |
| Author        | LTS Engineering Team                    |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Scope](#2-scope)
3. [Definitions and Abbreviations](#3-definitions-and-abbreviations)
4. [System Context](#4-system-context)
5. [Functional Requirements — Kalman Filter](#5-functional-requirements--kalman-filter)
6. [Functional Requirements — ByteTracker](#6-functional-requirements--bytetracker)
7. [Functional Requirements — BehaviorEngine](#7-functional-requirements--behaviorengine)
8. [Functional Requirements — Zone Management](#8-functional-requirements--zone-management)
9. [Interface Requirements](#9-interface-requirements)
10. [Non-Functional Requirements](#10-non-functional-requirements)
11. [Constraints and Assumptions](#11-constraints-and-assumptions)

---

## 1. Introduction

This document specifies the requirements for the **Object Tracking** subsystem of the LTS-2026 Loitering Tracking System. The subsystem provides multi-object tracking, trajectory analysis, and loitering-risk scoring using a Kalman filter state estimator, ByteTracker multi-object tracker, and a rule-based BehaviorEngine.

---

## 2. Scope

The Object Tracking subsystem covers:

- Per-object state estimation via an 8-dimensional Kalman filter.
- Multi-object tracking across video frames via ByteTracker (IoU-based Hungarian assignment).
- Behavioral feature extraction: dwell time, revisit count, velocity, circular score, pacing score.
- Composite risk-score computation and loitering-alert generation.
- Zone-based suppression (EXCLUDE) and monitoring (MONITOR) logic.
- Real-time event emission over Socket.IO.

---

## 3. Definitions and Abbreviations

| Term             | Definition                                                          |
|------------------|---------------------------------------------------------------------|
| bbox             | Bounding box [x, y, w, h] in pixel coordinates                     |
| IoU              | Intersection over Union — overlap ratio between two bounding boxes  |
| KF               | Kalman Filter — linear state estimator for tracking                 |
| ByteTracker      | Multi-object tracker using IoU-based Hungarian assignment           |
| BehaviorEngine   | Module that computes behavioral features and risk scores            |
| dwellTime        | Cumulative seconds a tracked object has remained inside a zone      |
| riskScore        | Composite floating-point score [0, 1] indicating loitering risk     |
| MONITOR zone     | Zone type where dwell and behavior logic is applied                 |
| EXCLUDE zone     | Zone type where detections are suppressed entirely                  |
| objectId         | UUID persisted across frames for a tracked individual               |
| FPS              | Frames per second                                                   |
| SFU              | Selective Forwarding Unit                                           |

---

## 4. System Context

```
[Video Frames / Detections]
         │
         ▼
   ┌─────────────┐      predict() / update()
   │ KalmanFilter │◄─────────────────────────────┐
   └─────────────┘                               │
         │ smoothed bbox                         │
         ▼                                       │
   ┌─────────────┐   IoU Hungarian  ┌──────────────────┐
   │ ByteTracker  │─────────────────►│ Track Pool       │
   └─────────────┘  assignment      │ (active/lost)    │
         │ objectId + bbox          └──────────────────┘
         ▼
   ┌───────────────┐  dwellTime, velocity,   ┌──────────┐
   │ BehaviorEngine│─ riskScore, isLoitering─►│ Socket.IO│
   └───────────────┘                         └──────────┘
         │ zone evaluation
         ▼
   ┌──────────────┐
   │ Zone Config  │  (MONITOR | EXCLUDE, polygon, dwellThreshold)
   └──────────────┘
```

---

## 5. Functional Requirements — Kalman Filter

### FR-TRK-001 — State Vector

The Kalman filter shall maintain an 8-dimensional state vector `[x, y, w, h, vx, vy, vw, vh]` where `(x, y)` is the bounding-box center, `(w, h)` is width/height, and `(vx, vy, vw, vh)` are the corresponding velocities.

- **Input**: Initial bounding box `[x, y, w, h]`.
- **Output**: 8-D state vector.

### FR-TRK-002 — Measurement Vector

The filter shall accept a 4-dimensional measurement vector `[x, y, w, h]` derived from detector output.

- **Input**: Detection bbox.
- **Output**: Updated state estimate.

### FR-TRK-003 — Initialization

`init(bbox)` shall initialize the state mean from the provided bbox (velocity components = 0), the covariance matrix `P = eye(8) × 10`, process noise `Q = eye(8) × 1`, and measurement noise `R = eye(4) × 10`.

### FR-TRK-004 — Prediction Step

`predict()` shall advance the state estimate by one time step using the linear motion model `x_k = F·x_{k-1}`, updating both the state mean and the covariance `P = F·P·F^T + Q`.

- **Input**: None (uses internal state).
- **Output**: Predicted state mean and covariance.

### FR-TRK-005 — Update Step

`update(bbox)` shall incorporate a new measurement, computing the Kalman gain `K = P·H^T·(H·P·H^T + R)^{-1}` and correcting the state estimate and covariance.

- **Input**: Measured bbox `[x, y, w, h]`.
- **Output**: Corrected state estimate.

---

## 6. Functional Requirements — ByteTracker

### FR-TRK-006 — Multi-Object Tracking

`ByteTracker.update(detections)` shall match incoming detections to existing tracks using IoU-based Hungarian assignment and return a list of active tracked objects.

- **Input**: Array of detection objects `{bbox, class, confidence}`.
- **Output**: Array of tracked objects `{objectId, bbox, class, trackLifetime, isLost}`.

### FR-TRK-007 — Persistent Object ID

Each track shall be assigned a UUID `objectId` at creation that persists for the lifetime of the track, including through missed-frame buffering (lost state).

### FR-TRK-008 — Lost Buffer

Tracks that are not matched in a frame shall enter a "lost" state. The system shall retain lost tracks for a configurable buffer period before pruning them, enabling recovery when the object reappears.

### FR-TRK-009 — Track Lifecycle Tracking

The system shall maintain a `trackLifetime` counter (in frames) for each track, incremented every frame the track is active.

### FR-TRK-010 — IoU-Based Assignment

Hungarian algorithm shall be applied on the IoU cost matrix between predicted track bboxes and incoming detections. A detection with IoU below a configured threshold shall not be matched.

---

## 7. Functional Requirements — BehaviorEngine

### FR-TRK-011 — History Capacity

The BehaviorEngine shall maintain a per-object history buffer of up to `HISTORY_CAPACITY = 300` frames, corresponding to approximately 30 seconds at 10 FPS.

### FR-TRK-012 — Dwell Time Computation

`dwellTime` shall be computed as the elapsed seconds since the object first entered the zone during the current visit, using frame timestamps.

- **Output**: Floating-point seconds.

### FR-TRK-013 — Revisit Count

`revisitCount` shall increment each time an object re-enters a zone after having exited, within the zone's `reentryWindow` configuration.

### FR-TRK-014 — Velocity Computation

Instantaneous velocity shall be estimated in pixels/second using a 10-frame sliding window over the position history.

- **Output**: `velocity` in px/s.

### FR-TRK-015 — Circular Score

`circularScore = 1 − (displacement / pathLength)` where `displacement` is the straight-line distance between first and current position, and `pathLength` is the cumulative path length. A score of 0 indicates straight-line motion; 1 indicates fully circular motion.

### FR-TRK-016 — Pacing Score

`pacingScore` shall be the ratio of x-direction sign reversals over the history window, capped at 10 reversals (i.e., `min(reversals, 10) / 10`).

### FR-TRK-017 — Risk Score Computation

The composite risk score shall be computed as:

```
riskScore = dwellRatio*0.35 + revisitRatio*0.30 + lowVeloScore*0.15
          + pacingScore*0.12 + circularScore*0.08
```

where:
- `dwellRatio = min(dwellTime / dwellThreshold, 1.0)`
- `revisitRatio = min(revisitCount / maxRevisits, 1.0)`
- `lowVeloScore = max(0, 1 − velocity / velocityThreshold)`

- **Output**: Floating-point `riskScore` in [0, 1].

### FR-TRK-018 — Loitering Flag

`isLoitering = true` when `dwellTime >= zone.dwellThreshold`. This flag shall be set independently of `riskScore`.

### FR-TRK-019 — Target Class Filtering

If a zone defines `targetClasses`, only objects whose detected class appears in that list shall be evaluated for dwell/risk logic within that zone.

---

## 8. Functional Requirements — Zone Management

### FR-TRK-020 — Zone Types

The system shall support two zone types:
- `MONITOR` — applies dwell and behavior logic.
- `EXCLUDE` — suppresses all detections within the polygon; no events are emitted.

### FR-TRK-021 — Zone Polygon Validation

A zone polygon shall contain at least 3 `{x, y}` vertex points. Zones with fewer than 3 points shall be rejected with HTTP 400.

### FR-TRK-022 — Zone Schedule

A zone may define an active schedule (time-of-day or day-of-week). Outside the schedule window, the zone shall behave as inactive (no dwell logic applied).

### FR-TRK-023 — Point-in-Polygon Test

The system shall use a ray-casting algorithm to determine whether the object's centroid lies within a zone polygon each frame.

---

## 9. Interface Requirements

### 9.1 Socket.IO Events (Outbound)

| Event                | Payload Fields                                                                                      | Description                              |
|----------------------|-----------------------------------------------------------------------------------------------------|------------------------------------------|
| `detections`         | `cameraId`, `timestamp`, `objects[]` (objectId, bbox, class, riskScore, dwellTime, isLoitering)    | Per-frame tracked object list            |
| `loitering_alert`    | `objectId`, `cameraId`, `zoneId`, `dwellTime`, `riskScore`, `timestamp`, `bbox`                     | Emitted when `isLoitering` becomes true  |
| `detections:summary` | `cameraId`, `timestamp`, `activeCount`, `loiteringCount`, `zones[]`                                 | Aggregated per-frame summary             |

### 9.2 REST API

| Method | Endpoint                              | Description                       |
|--------|---------------------------------------|-----------------------------------|
| GET    | `/api/cameras/:id/zones`              | List zones for a camera           |
| POST   | `/api/cameras/:id/zones`              | Create a zone                     |
| PUT    | `/api/cameras/:id/zones/:zoneId`      | Update zone configuration         |
| DELETE | `/api/cameras/:id/zones/:zoneId`      | Delete a zone                     |

**POST /api/cameras/:id/zones — Request Body:**
```json
{
  "name": "Entrance Zone",
  "type": "MONITOR",
  "polygon": [{"x": 100, "y": 100}, {"x": 300, "y": 100}, {"x": 300, "y": 400}, {"x": 100, "y": 400}],
  "dwellThreshold": 30,
  "minDisplacement": 10,
  "reentryWindow": 60,
  "targetClasses": ["person"],
  "schedule": {"startTime": "08:00", "endTime": "20:00", "days": ["Mon","Tue","Wed","Thu","Fri"]}
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "cameraId": "uuid",
    "name": "Entrance Zone",
    "type": "MONITOR",
    "polygon": [...],
    "dwellThreshold": 30,
    "createdAt": "2026-05-26T00:00:00Z"
  }
}
```

---

## 10. Non-Functional Requirements

| ID       | Category      | Requirement                                                                                            |
|----------|---------------|--------------------------------------------------------------------------------------------------------|
| NFR-TRK-01 | Performance | Tracking pipeline shall process at least 30 detections per frame within 50 ms on a 4-core server CPU. |
| NFR-TRK-02 | Scalability | System shall support simultaneous tracking across at least 8 camera streams.                          |
| NFR-TRK-03 | Accuracy    | ID-switch rate (IDSW) shall be less than 5% over a 60-second test sequence.                           |
| NFR-TRK-04 | Reliability | The tracker shall recover a lost track within 5 frames when the object reappears with IoU > 0.3.      |
| NFR-TRK-05 | Latency     | Socket.IO `loitering_alert` shall be emitted within 500 ms of the dwell threshold crossing.           |
| NFR-TRK-06 | Memory      | Per-track history buffer (300 frames) shall consume no more than 2 MB of heap memory.                 |

---

## 11. Constraints and Assumptions

- The upstream detector provides bboxes in pixel coordinates relative to the original frame resolution.
- Frame rate is assumed to be approximately 10 FPS; all time calculations use real-world timestamps.
- Zone polygons are defined in the same pixel coordinate space as the detection output.
- The KF uses a constant-velocity linear motion model; non-linear motion is approximated.
- `objectId` uniqueness is guaranteed by UUID v4 generation at track initialization.

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Object Tracking |
