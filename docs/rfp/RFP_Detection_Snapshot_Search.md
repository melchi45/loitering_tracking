# RFP — Detection Snapshot Storage & Global Search

**Document ID:** RFP-LTS2026-SNAP-001  
**Issue Date:** 2026-05-27  
**Module:** Detection Snapshot Storage & Global Search  
**Status:** Released

---

## 1. Background

The current LTS-2026 system detects persons, vehicles, faces, fire, and smoke in real-time and emits bounding-box annotations to the browser via Socket.IO. However:

- **No visual evidence is retained** — detection frames are discarded after transmission; there is no way to review what was detected after the fact.
- **Post-event investigation is text-only** — alerts and events stored in the DB contain metadata (timestamps, zone names) but no visual reference.
- **No cross-entity search** — alerts, detection events, and face-recognition hits are stored in separate tables with no unified query interface; investigators must navigate multiple tabs to correlate data.

---

## 2. Objectives

| ID | Objective |
|---|---|
| OBJ-SNAP-01 | Crop and persist the bounding-box region from each significant detection frame as a JPEG thumbnail |
| OBJ-SNAP-02 | Link each saved snapshot to the full detection metadata (camera, class, confidence, attributes, zone, loitering state) |
| OBJ-SNAP-03 | Display the saved crop thumbnail alongside detection entries in the Detections tab |
| OBJ-SNAP-04 | Provide a unified search bar in the dashboard header to query across Alerts, Detections, and Face Recognition data |
| OBJ-SNAP-05 | Show crop thumbnails in search results for visual confirmation |

---

## 3. Scope

| In Scope | Out of Scope |
|---|---|
| Server-side JPEG crop from detection bounding box | Full-frame video recording / VOD storage |
| `detectionSnapshots` DB table (JSON + MongoDB) | Long-term cold storage / cloud archival |
| REST API: `GET /api/snapshots`, `GET /api/search` | Video export / download |
| Detections tab: crop thumbnail column | PDF report generation |
| Header SearchBar component | Natural language / AI-based search |
| Snapshot rate limiting (throttle per track) | Browser push notifications |

---

## 4. Functional Requirements

| ID | Requirement |
|---|---|
| FR-SNAP-01 | Server MUST crop the bounding-box region from the JPEG frame buffer on each qualifying detection |
| FR-SNAP-02 | Crop MUST be stored as base64 JPEG in the `detectionSnapshots` DB table |
| FR-SNAP-03 | Each snapshot record MUST include: cameraId, timestamp, objectId, className, confidence, bbox, frameWidth, frameHeight, attributes, isLoitering, dwellTime, zoneId, zoneName |
| FR-SNAP-04 | Snapshot saving MUST be throttled per objectId (default: max 1 per 30 s per track) to prevent storage exhaustion |
| FR-SNAP-05 | Loitering events MUST always trigger a snapshot regardless of throttle |
| FR-SNAP-06 | `GET /api/snapshots` MUST support filtering by cameraId, className, isLoitering, from/to timestamp, and pagination |
| FR-SNAP-07 | `GET /api/search?q=` MUST search across alerts, detectionSnapshots, and faceGalleryFaces; return unified results with type tag and crop thumbnail |
| FR-SNAP-08 | Detections tab MUST show crop thumbnails next to each detection row |
| FR-SNAP-09 | Search results panel MUST open below the header search bar and show paginated results with crop thumbnails |
| FR-SNAP-10 | Search MUST support filtering by type (alerts / detections / faces) and date range |

---

## 5. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-SNAP-01 | Crop operation MUST complete in < 50 ms per detection (uses `sharp` native library) |
| NFR-SNAP-02 | Snapshot crop size MUST NOT exceed 100 KB per image (JPEG quality 70, max 320×320 px) |
| NFR-SNAP-03 | Storage growth rate MUST be bounded: default max 500 snapshots per camera per 24 hours |
| NFR-SNAP-04 | Search response MUST return within 200 ms for up to 10,000 snapshot records |
| NFR-SNAP-05 | Crop saving MUST be non-blocking (async, does not delay frame processing) |
| NFR-SNAP-06 | Base64 JPEG crops MUST be gzip-compressed in JSON storage (handled by HTTP transport) |

---

## 6. Acceptance Criteria

1. After a loitering event, `GET /api/snapshots?isLoitering=true` returns at least one record with `cropData` (non-empty base64 string)
2. Detections tab shows a thumbnail image for each detection entry that has a saved snapshot
3. Typing a class name (e.g., "person") in the header search bar returns matching detection snapshots within 500 ms
4. Search results include face name matches (e.g., searching "John" returns face recognition hits for that name)
5. All existing Phase-1 tests continue to pass (no regression)

---

## 7. Schedule

| Milestone | Target |
|---|---|
| SDLC Documentation | Sprint 7 (2026-05-27) |
| Server Implementation | Sprint 7 |
| Client Implementation | Sprint 7 |
| Integration Test | Sprint 7 |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — RFP for Detection Snapshot Search |
