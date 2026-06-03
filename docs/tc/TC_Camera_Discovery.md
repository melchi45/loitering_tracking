# TEST CASES (TC)
# Camera Discovery (UDP Broadcast + ONVIF WS-Discovery)

| | |
|---|---|
| **Document ID** | TC-LTS-CAM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-27 |
| **Parent SRS** | srs/SRS_Camera_Discovery.md |
| **Test Scripts** | test/api/camera_discovery.test.js |

---

## Table of Contents

1. [Test Strategy](#1-test-strategy)
2. [Test Environment and Prerequisites](#2-test-environment-and-prerequisites)
3. [Test Group A — Discovery Trigger API](#3-test-group-a--discovery-trigger-api)
4. [Test Group B — Camera Registration API](#4-test-group-b--camera-registration-api)
5. [Test Group C — Device Registry Logic](#5-test-group-c--device-registry-logic)
6. [Test Group D — Socket.IO Events](#6-test-group-d--socketio-events)
7. [Test Group E — UDP Broadcast Scan](#7-test-group-e--udp-broadcast-scan)
8. [Test Group F — ONVIF WS-Discovery](#8-test-group-f--onvif-ws-discovery)
9. [Test Group G — Edge Cases and Error Handling](#9-test-group-g--edge-cases-and-error-handling)
10. [Test Execution Order](#10-test-execution-order)
11. [Pass/Fail Criteria](#11-passfail-criteria)

---

## 1. Test Strategy

### 1.1 Test Levels

| Level | Scope | Tool | Location |
|-------|-------|------|----------|
| API (REST) | Discovery trigger, camera CRUD | Node.js fetch | `test/api/camera_discovery.test.js` |
| Unit | `mapUDPDevice()`, `mergeDevices()`, registry logic | Node.js | `test/unit/discovery.test.js` (Phase-2) |
| Integration | Socket.IO `discovery:result` events | socket.io-client | `test/integration/discovery.test.js` (Phase-2) |
| E2E | Real LAN camera discovery | Manual (LAN required) | Phase-3 |

### 1.2 SRS Traceability

| SRS Requirement | Test Case(s) |
|---|---|
| FR-CAM-001 | TC-E-001 |
| FR-CAM-002 | TC-E-002 |
| FR-CAM-003 | TC-E-003 |
| FR-CAM-004 | TC-E-004 |
| FR-CAM-005 | TC-E-005 |
| FR-CAM-010 | TC-F-001 |
| FR-CAM-011 | TC-F-002 |
| FR-CAM-012 | TC-F-003 |
| FR-CAM-013 | TC-F-004 |
| FR-CAM-014 | TC-F-005 |
| FR-CAM-015 | TC-F-006 |
| FR-CAM-020 | TC-C-001 |
| FR-CAM-021 | TC-C-002 |
| FR-CAM-022 | TC-C-003 |
| FR-CAM-023 | TC-C-004 |
| FR-CAM-024 | TC-C-005 |
| FR-CAM-030 | TC-D-001 |
| FR-CAM-031 | TC-D-002 |
| FR-CAM-032 | TC-D-003 |
| FR-CAM-033 | TC-D-004 |
| FR-CAM-034 | TC-D-005 |
| FR-CAM-040 | TC-A-001 |
| FR-CAM-041 | TC-B-001 |
| FR-CAM-042 | TC-B-002 |
| FR-CAM-043 | TC-B-003, TC-B-004, TC-B-005, TC-B-006, TC-B-007 |
| FR-CAM-044 | TC-A-002 |
| FR-CAM-045 | TC-A-003 |
| FR-CAM-050 | TC-G-001 |
| FR-CAM-051 | TC-G-002 |
| FR-CAM-052 | TC-C-006 |
| FR-CAM-053 | TC-G-003 |
| FR-CAM-054 | TC-G-004 |
| FR-CAM-055 | TC-G-005 |
| FR-CAM-056 | TC-G-006 |

### 1.3 Test Data

| Artifact | Purpose |
|---|---|
| Mock UDP discovery response (160-byte WiseNet) | UDP scan parsing |
| Mock ONVIF ProbeMatch SOAP response | ONVIF discovery parsing |
| Camera fixture (name, rtspUrl) | Registration tests |
| MAC address constants | Registry merge tests |

---

## 2. Test Environment and Prerequisites

- Server running on `http://localhost:3080`
- `GET /health` returns `{ status: 'ok' }`
- Tests use mock network responses for unit tests; real LAN for E2E

---

## 3. Test Group A — Discovery Trigger API

### TC-A-001 — POST /api/cameras/discover
- **Input:** `POST /api/cameras/discover`
- **Expected:** HTTP 200; scan initiated; subsequent `discovery:result` events via Socket.IO
- **Acceptance:** HTTP 200; scan starts; events received within 15 seconds

### TC-A-002 — Rescan Clears Registry
- **Input:** `POST /api/cameras/discover` (rescan while results exist)
- **Expected:** `discovery:cleared` Socket.IO event emitted; registry reset; new scan starts
- **Acceptance:** `discovery:cleared` event received; previous results removed

### TC-A-003 — stop() Releases Resources
- **Input:** Call `stop()` on DiscoveryService
- **Expected:** UDP and ONVIF sockets closed; no new `discovery:result` events after stop
- **Acceptance:** No further events after stop; no resource leak

---

## 4. Test Group B — Camera Registration API

### TC-B-001 — POST /api/cameras (success)
- **Input:** `{ "name": "Test Cam", "rtspUrl": "rtsp://192.168.1.100:554/stream" }`
- **Expected:** HTTP 201; camera record with auto-generated UUID
- **Acceptance:** `id` present in response; `GET /api/cameras` includes new camera

### TC-B-002 — GET /api/cameras
- **Input:** `GET /api/cameras` after adding 3 cameras
- **Expected:** Array of 3 camera records; no password fields
- **Acceptance:** Length 3; no `password` field in any record

### TC-B-003 — GET /api/cameras/:id
- **Input:** Valid camera ID
- **Expected:** HTTP 200 with camera record
- **Acceptance:** Correct camera returned

### TC-B-004 — PUT /api/cameras/:id
- **Input:** Update camera name
- **Expected:** HTTP 200; updated name reflected in subsequent GET
- **Acceptance:** Updated field persisted

### TC-B-005 — DELETE /api/cameras/:id
- **Input:** Valid camera ID
- **Expected:** HTTP 200; camera removed from list
- **Acceptance:** `GET /api/cameras` no longer includes deleted camera

### TC-B-006 — POST /api/cameras/:id/reconnect
- **Input:** Offline camera ID
- **Expected:** HTTP 200; reconnect triggered
- **Acceptance:** Camera status changes to 'connecting' or 'live'

### TC-B-007 — POST /api/cameras (missing required fields)
- **Input:** `{}` (no name or rtspUrl)
- **Expected:** HTTP 400 with validation error message
- **Acceptance:** HTTP 400; error details present

---

## 5. Test Group C — Device Registry Logic

### TC-C-001 — Map<string, DeviceInfo> Structure
- **Input:** Upsert device with MAC `AA:BB:CC:DD:EE:FF`
- **Expected:** Device stored with MAC as key; IP index updated
- **Acceptance:** Registry returns device by MAC and by IP

### TC-C-002 — Same IP Different Sources → source:'both'
- **Input:** UDP device + ONVIF device with same IP
- **Expected:** Merged into one entry with `source: 'both'`
- **Acceptance:** Single registry entry; `source === 'both'`

### TC-C-003 — mergeDevices() Priority Rules
- **Input:** Two devices for same MAC; ONVIF has richer data
- **Expected:** Merged record uses ONVIF data for enriched fields; UDP data for MAC/IP
- **Acceptance:** Merged fields match priority rules

### TC-C-004 — Registry Persists Between Scan Cycles
- **Input:** Device found in scan cycle 1; no new broadcasts in cycle 2
- **Expected:** Device still present in registry after cycle 2
- **Acceptance:** `knownCount` unchanged after silent scan cycle

### TC-C-005 — knownCount Property
- **Input:** Add 5 devices to registry
- **Expected:** `DiscoveryService.knownCount === 5`
- **Acceptance:** Exact count returned

### TC-C-006 — 256 Device Registry Limit
- **Input:** Upsert 256 unique MAC devices
- **Expected:** All 256 stored without error
- **Acceptance:** `knownCount === 256`; no overflow

---

## 6. Test Group D — Socket.IO Events

### TC-D-001 — discovery:result on Upsert
- **Input:** Device upserted to registry
- **Expected:** `discovery:result` event broadcast to all connected Socket.IO clients
- **Acceptance:** Event received within 1 second of upsert

### TC-D-002 — discovery:scanning State Change
- **Input:** `_runScan()` starts and finishes
- **Expected:** `discovery:scanning` event with `{ scanning: true }` then `{ scanning: false }`
- **Acceptance:** Both events received in correct order

### TC-D-003 — discovery:cleared on Rescan
- **Input:** `rescan()` called
- **Expected:** `discovery:cleared` event emitted before new scan starts
- **Acceptance:** Cleared event received first

### TC-D-004 — discovery:error on Socket Error
- **Input:** UDP socket encounters non-fatal error
- **Expected:** `discovery:error` event emitted with error details
- **Acceptance:** Error event received; scan continues

### TC-D-005 — hydrate() for New Client
- **Input:** New Socket.IO client connects after 3 devices already discovered
- **Expected:** 3 `discovery:result` events sent to new client on connect
- **Acceptance:** New client receives all existing devices on join

---

## 7. Test Group E — UDP Broadcast Scan

### TC-E-001 — Magic Packet Format
- **Input:** Capture outbound UDP packet on port 7701
- **Expected:** 160-byte WiseNet magic packet sent to 255.255.255.255:7701
- **Acceptance:** Correct destination and packet size

### TC-E-002 — Response Listener
- **Input:** Mock UDP response on port 7711 within 10 seconds
- **Expected:** Response parsed; `DeviceInfo` extracted
- **Acceptance:** Device appears in registry

### TC-E-003 — mapUDPDevice Normalization
- **Input:** Raw 160-byte WiseNet UDP response
- **Expected:** `DeviceInfo` object with `ip`, `mac`, `port`, `firmwareVersion`, `SupportSunapi`, `source: 'udp'`
- **Acceptance:** All fields mapped correctly

### TC-E-004 — SCAN_TIMEOUT
- **Input:** No UDP responses for 10+ seconds
- **Expected:** Scan completes without hanging; `discovery:scanning` `{ scanning: false }` emitted
- **Acceptance:** Timeout respected; server continues

### TC-E-005 — Auto-Reschedule on Socket Error
- **Input:** UDP socket error mid-scan
- **Expected:** `SCAN_INTERVAL` (15s) after error, scan automatically restarts
- **Acceptance:** New scan initiated without server restart

---

## 8. Test Group F — ONVIF WS-Discovery

### TC-F-001 — Multicast Probe Message
- **Input:** Start discovery
- **Expected:** SOAP WS-Discovery Probe sent to 239.255.255.250:3702
- **Acceptance:** Correct multicast address and SOAP structure

### TC-F-002 — XAddrs Extraction
- **Input:** Mock `ProbeMatch` SOAP response with `XAddrs`
- **Expected:** Basic `DeviceInfo` with extracted IP published immediately
- **Acceptance:** Device appears in registry within 1 second of ProbeMatch

### TC-F-003 — enrichDevice() 4-Step SOAP
- **Input:** Mock ONVIF device at IP; SOAP services available
- **Expected:** `GetCapabilities`, `GetDeviceInformation`, `GetProfiles`, `GetStreamUri` called
- **Acceptance:** All 4 SOAP calls attempted; device enriched with profiles

### TC-F-004 — OnvifProfile Objects
- **Input:** ONVIF device with 2 profiles
- **Expected:** 2 `OnvifProfile` objects created with stream URI
- **Acceptance:** Profile count matches; `rtspUrl` populated

### TC-F-005 — 401 Unauthenticated Fallback
- **Input:** ONVIF device returns HTTP 401 on all SOAP calls
- **Expected:** Basic `DeviceInfo` published without enrichment; no crash
- **Acceptance:** Device appears with partial data; no error thrown

### TC-F-006 — Discovery Window Timeout
- **Input:** ONVIF discovery runs for 10 seconds
- **Expected:** `done` event emitted after 10 seconds
- **Acceptance:** Discovery closes cleanly after timeout

---

## 9. Test Group G — Edge Cases and Error Handling

### TC-G-001 — 2s Discovery Time (LAN)
- **Precondition:** At least 1 real LAN camera present
- **Expected:** Camera appears in dashboard within 2 seconds of scan start
- **Acceptance:** `discovery:result` received within 2 seconds

### TC-G-002 — Network Traffic Budget
- **Input:** One complete scan cycle
- **Expected:** Total broadcast/multicast traffic ≤ 5 KB per cycle
- **Acceptance:** Wireshark capture shows ≤ 5 KB

### TC-G-003 — Auto-Recovery After Error
- **Input:** UDP socket error; wait 15 seconds
- **Expected:** Automatic recovery without server restart
- **Acceptance:** New scan starts; `discovery:scanning` emitted

### TC-G-004 — No Credentials in Server Logs
- **Input:** Full discovery scan with ONVIF camera requiring credentials
- **Expected:** No passwords or ONVIF WS-Security tokens in server log output
- **Acceptance:** Log grep for "password" returns no results

### TC-G-005 — ONVIF Compatibility
- **Input:** Axis / Hikvision / Dahua / Hanwha / Bosch ONVIF device (Phase-3 manual)
- **Expected:** Device discovered and enriched correctly
- **Acceptance:** All 5 vendor types discoverable

### TC-G-006 — Concurrent UDP + ONVIF Scan
- **Input:** Both UDP and ONVIF scans running simultaneously
- **Expected:** Both complete within same scan cycle; `_pendingDone` counter works correctly
- **Acceptance:** Single `discovery:scanning { scanning: false }` emitted after both complete

---

## 10. Test Execution Order

```
Group B (camera API) → Group C (registry) → Group A (trigger API) → Group D (Socket.IO) → Group E (UDP) → Group F (ONVIF) → Group G (edge cases)
```

Group B camera records created during tests must be cleaned up after each group.

---

## 11. Pass/Fail Criteria

| Category | Pass Condition |
|---|---|
| Camera API | All CRUD operations succeed with correct HTTP codes |
| Registry | MAC-keyed merge; `source:'both'` on duplicate IP; 256-device capacity |
| Socket.IO | All 5 event types received at correct times |
| UDP scan | Correct 160-byte packet; 10s timeout respected; auto-recovery |
| ONVIF | Multicast probe; XAddrs extraction; graceful 401 fallback |
| Security | No credentials in logs; discovery-only localhost exposure |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Camera Discovery |
