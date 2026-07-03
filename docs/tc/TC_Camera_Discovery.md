# TEST CASES (TC)
# Camera Discovery (UDP Broadcast + ONVIF WS-Discovery)

| | |
|---|---|
| **Document ID** | TC-LTS-CAM-01 |
| **Version** | 1.12 |
| **Status** | Active |
| **Date** | 2026-07-03 |
| **Parent SRS** | srs/SRS_Camera_Discovery.md |
| **Test Scripts** | test/api/camera_discovery.test.js, test/api/nvr_channel_discovery.test.js |

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
| FR-CAM-068 | TC-H-017 |
| FR-CAM-069 | TC-H-015 |
| FR-CAM-070 | TC-H-016 |
| FR-CAM-071 | TC-H-014, TC-H-015 |
| FR-CAM-072 | TC-CH-F-012, TC-CH-F-012b (`test/api/channel_slot.test.js` — `querySunapiMaxChannel()` is shared with the Channel Slot feature; see `docs/tc/TC_Channel_Slot.md`) |
| FR-CAM-073 | Manual — verified live against 192.168.214.37 (HTTPS-only SUNAPI, self-signed cert); no automated mock-TLS harness in this repo, see §9 Test Group G note |
| FR-CAM-074 | TC-H-019 |
| FR-CAM-075 | TC-H-018, TC-H-018b |
| FR-CAM-076 | TC-H-020 (also verified live against 192.168.214.37 — ONVIF 301 redirect to HTTPS) |
| FR-CAM-077 | TC-H-025 (also verified live against 192.168.214.37 — SUNAPI 301 redirect to HTTPS) |
| FR-CAM-078 | TC-H-021a, TC-H-021b, TC-H-021c |
| FR-CAM-079 | TC-H-022, TC-H-023, TC-H-024 (also verified live against 192.168.214.32, 192.168.214.37 via `curl --digest`) |
| FR-CAM-080 | Manual — verified live via `POST /api/cameras/probe-channels` against 192.168.214.37/192.168.214.40; see §9 Test Group G note |
| FR-CAM-081 | TC-H-026, TC-H-027 |
| FR-CAM-082 | TC-H-028, TC-H-029 (superseded by FR-CAM-087 — `UDPDiscoveryFallback` was removed; these TCs were renamed to test the npm-package-backed copy instead, see their "Note (2026-07-03)") |
| FR-CAM-083 | TC-H-030 |
| FR-CAM-084 | TC-H-031, TC-H-032, TC-H-033, TC-H-034 |
| FR-CAM-085 | TC-H-028, TC-H-029, TC-H-032 (same TCs as FR-CAM-082/084 — `reserved2`/`reserved3` correctness is exactly what the parity comparison in these TCs verifies) |
| FR-CAM-086 | Manual — verified live against 100+ real devices on this network (`nMode=6` request → `nMode=12` responses, `'scanExtConfirmed'` event); no automated mock-network harness in this repo for UDP broadcast round-trips, see §9 Test Group G note |
| FR-CAM-087 | TC-H-028, TC-H-029, TC-H-032, TC-H-034 (parity between npm-package-backed and submodule-loaded copies); manual live verification of `npm install` fetching `wisenet-chrome-ip-installer` and `getUDPDiscovery()` resolving through `discoveryService.js` |
| FR-CAM-088 | TC-H-035 |
| FR-CAM-089 | TC-H-036 |
| FR-CAM-090 | TC-H-037, TC-H-038, TC-H-039, TC-H-039b |
| FR-CAM-091 | TC-H-040 |

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

### TC-G-007 — SUNAPI MaxChannel query over HTTPS with a self-signed certificate (FR-CAM-073, manual)
- **Precondition:** Real camera whose SUNAPI web UI is HTTPS-only (HTTP:80 redirects to HTTPS:443), presenting a self-signed certificate — observed with 192.168.214.37
- **Input:** `node test/api/probe_camera_maxchannel.js --ip <ip> --username <user> --password <pass> --https`
- **Expected:** `querySunapiMaxChannel()` connects and completes Basic/Digest auth (per FR-CAM-072) without a `self-signed certificate` TLS error
- **Acceptance:** Verified live against 192.168.214.37 — `HTTP 200` with the device's actual reported `MaxChannel` after the fix (previously `connection error: self-signed certificate`, failing before the value could even be read). No automated mock-TLS harness exists in this repo for this case (would require generating a throwaway self-signed cert at test time — out of proportion to a one-line `rejectUnauthorized: false` fix that already mirrors existing, working code in `onvifDiscovery.js`); revisit if a cert-generation utility (e.g. `selfsigned`) is added to `server/package.json` for other purposes.

---

## 10. Test Group H — NVR MaxChannel & Channel Selection

**SRS References**: FR-CAM-060, FR-CAM-061, FR-CAM-062, FR-CAM-063, FR-CAM-064, FR-CAM-065, FR-CAM-066, FR-CAM-067  
**Test Script**: `test/api/nvr_channel_discovery.test.js`

---

### TC-H-001 — SourceToken-Based MaxChannel (ONVIF NVR)

| Field | Value |
|---|---|
| **ID** | TC-H-001 |
| **SRS** | FR-CAM-060 |
| **Priority** | P1 |
| **Type** | Unit |

**Precondition**: `enrichDevice()` mock returns a `GetProfiles` response with 4 profiles using 4 distinct `SourceToken` values (VideoSrc_01 … VideoSrc_04).

**Steps**:
1. Call `enrichDevice(ip, xaddr)` with the mocked SOAP server.
2. Inspect `result.MaxChannel`.

**Expected**: `result.MaxChannel === 4`.

---

### TC-H-002 — Single-Channel Camera Is Not Counted as Multi-Channel

| Field | Value |
|---|---|
| **ID** | TC-H-002 |
| **SRS** | FR-CAM-060 |
| **Priority** | P1 |
| **Type** | Unit |

**Precondition**: Mock `GetProfiles` returns 2 profiles (main + sub stream) with the same `SourceToken = "VideoSrc_00"`.

**Steps**:
1. Call `enrichDevice()`.
2. Inspect `result.MaxChannel`.

**Expected**: `result.MaxChannel === 1` (not 2).

---

### TC-H-003 — channelIndex Assignment

| Field | Value |
|---|---|
| **ID** | TC-H-003 |
| **SRS** | FR-CAM-061 |
| **Priority** | P1 |
| **Type** | Unit |

**Precondition**: Mock `GetProfiles` returns 4 profiles:
- Profile A, B → `SourceToken = "VideoSrc_01"` (channel 1 main + sub)
- Profile C, D → `SourceToken = "VideoSrc_02"` (channel 2 main + sub)

**Expected**:
- Profile A `channelIndex === 1`, Profile B `channelIndex === 1`
- Profile C `channelIndex === 2`, Profile D `channelIndex === 2`

---

### TC-H-004 — SUNAPI MaxChannel Query Success

| Field | Value |
|---|---|
| **ID** | TC-H-004 |
| **SRS** | FR-CAM-062 |
| **Priority** | P2 |
| **Type** | Unit |

**Precondition**: Mock HTTP server at `GET /stw-cgi/attributes.cgi/attributes` returns XML: `<attributes><group name="System"><category name="Limit"><attribute name="MaxChannel" type="int" value="8"/></category></group></attributes>` (2026-07-02: corrected from the non-existent `media.cgi?msubmenu=channellist` JSON path — see FR-CAM-062a).

**Steps**:
1. Call `querySunapiMaxChannel(ip, httpPort, false)`.
2. Inspect return value.

**Expected**: Returns `8`.

---

### TC-H-005 — SUNAPI MaxChannel Query Auth Failure

| Field | Value |
|---|---|
| **ID** | TC-H-005 |
| **SRS** | FR-CAM-062 |
| **Priority** | P1 |
| **Type** | Unit |

**Precondition**: Mock HTTP server returns HTTP 401 for both SUNAPI endpoints.

**Steps**:
1. Call `querySunapiMaxChannel(ip, httpPort, false)`.
2. Inspect return value.

**Expected**: Returns `1` within 2 100 ms (no hang).

---

### TC-H-006 — SUNAPI MaxChannel Query Timeout

| Field | Value |
|---|---|
| **ID** | TC-H-006 |
| **SRS** | FR-CAM-062 |
| **Priority** | P1 |
| **Type** | Unit |

**Precondition**: Mock HTTP server never responds (simulated timeout).

**Steps**:
1. Call `querySunapiMaxChannel(ip, httpPort, false, 500)` (500 ms timeout).
2. Await result.

**Expected**: Returns `1` within 1 200 ms.

---

### TC-H-007 — mergeDevices MaxChannel Max Rule

| Field | Value |
|---|---|
| **ID** | TC-H-007 |
| **SRS** | FR-CAM-063 |
| **Priority** | P1 |
| **Type** | Unit |

**Precondition**: Two device objects for the same IP:
- UDP device: `MaxChannel = 1`
- ONVIF device: `MaxChannel = 4`

**Steps**:
1. Call `mergeDevices(udpDevice, onvifDevice)`.
2. Inspect `merged.MaxChannel`.

**Expected**: `merged.MaxChannel === 4`.

---

### TC-H-008 — Discovery Card MaxChannel Badge Visibility

| Field | Value |
|---|---|
| **ID** | TC-H-008 |
| **SRS** | FR-CAM-064 |
| **Priority** | P1 |
| **Type** | UI / Component |

**Precondition**: A discovered camera entry with `MaxChannel = 8` in the discovery store.

**Steps**:
1. Render the camera discovery list card.
2. Check for amber badge element containing `"8CH"`.

**Expected**: Badge `"8CH"` is visible with amber styling.  
**Negative**: Camera with `MaxChannel = 1` shows **no** channel badge.

---

### TC-H-009 — Channel Selection Buttons Appear for NVR

| Field | Value |
|---|---|
| **ID** | TC-H-009 |
| **SRS** | FR-CAM-065 |
| **Priority** | P1 |
| **Type** | UI / Component |

**Precondition**: `DiscoveredCameraPanel` rendered with `camera.MaxChannel = 4`, `camera.profiles` containing 4 profiles with `channelIndex` 1–4 and valid `rtspUrl`.

**Steps**:
1. Render `DiscoveredCameraPanel`.
2. Check for "Channel Selection" heading.
3. Count channel buttons.
4. Check green ● indicators on buttons with `rtspUrl`.

**Expected**:
- "Channel Selection" heading present.
- 4 buttons labeled "CH 1", "CH 2", "CH 3", "CH 4".
- All 4 buttons show `●` indicator.

---

### TC-H-010 — Channel Button Click Updates RTSP URL

| Field | Value |
|---|---|
| **ID** | TC-H-010 |
| **SRS** | FR-CAM-065, FR-CAM-066 |
| **Priority** | P1 |
| **Type** | UI / Component |

**Precondition**: NVR with 4 channels, channel 2 RTSP = `rtsp://192.168.1.10:554/profile3/media.smp`.

**Steps**:
1. Render panel (default CH 1 selected).
2. Click "CH 2" button.
3. Read displayed RTSP URL.

**Expected**: URL changes to `rtsp://192.168.1.10:554/profile3/media.smp`.

---

### TC-H-011 — channelRtspUrl Fallback URL Generation

| Field | Value |
|---|---|
| **ID** | TC-H-011 |
| **SRS** | FR-CAM-066 |
| **Priority** | P2 |
| **Type** | Unit |

**Precondition**: Base RTSP URL `rtsp://192.168.1.10:554/profile1/media.smp`.

**Steps**:
1. Call `channelRtspUrl(baseUrl, 3)`.
2. Inspect result.

**Expected**: `rtsp://192.168.1.10:554/profile3/media.smp`.

---

### TC-H-012 — Channel Camera Name Format

| Field | Value |
|---|---|
| **ID** | TC-H-012 |
| **SRS** | FR-CAM-067 |
| **Priority** | P1 |
| **Type** | Integration |

**Precondition**: NVR device with `Model = "XRN-810S"`, `MaxChannel = 8`. User selects CH 5 and clicks "+ Add Ch 5 to System".

**Steps**:
1. Intercept the `POST /api/cameras` request body.
2. Inspect `body.name`.

**Expected**: `body.name === "XRN-810S Ch5"`.

---

### TC-H-013 — Single-Channel Camera Unaffected

| Field | Value |
|---|---|
| **ID** | TC-H-013 |
| **SRS** | FR-CAM-064, FR-CAM-065, FR-CAM-067 |
| **Priority** | P1 |
| **Type** | UI / Integration |

**Precondition**: Single-channel camera `MaxChannel = 1`.

**Steps**:
1. Check discovery card → no channel badge.
2. Open detail panel → no "Channel Selection" section.
3. Click "+ Add to System" → `POST /api/cameras` body.

**Expected**:
- No `NCH` badge on card.
- No Channel Selection section.
- Camera name = `"{Model}"` (no ` Ch1` suffix).

---

### TC-H-014 — channelCountMax = SUNAPI MaxChannel for SUNAPI Cameras

| Field | Value |
|---|---|
| **ID** | TC-H-014 |
| **SRS** | FR-CAM-071 |
| **Priority** | P1 |
| **Type** | Unit |

**Precondition**: Camera with `SupportSunapi = true`, `MaxChannel = 8`.

**Steps**:
1. Compute `channelCountMax` using the FR-CAM-071 rule.

**Expected**: `channelCountMax === 8`.

**Negative**: Camera with `SupportSunapi = false`, `MaxChannel = 8` → `channelCountMax === 64`.

---

### TC-H-015 — channelCountMax = 64 for Non-SUNAPI Cameras

| Field | Value |
|---|---|
| **ID** | TC-H-015 |
| **SRS** | FR-CAM-071 |
| **Priority** | P1 |
| **Type** | Unit |

**Precondition**: Camera with `SupportSunapi = false` (ONVIF-only), `MaxChannel = 4`.

**Steps**:
1. Compute `channelCountMax`.

**Expected**: `channelCountMax === 64` (SUNAPI MaxChannel not authoritative; liberal cap applies).

---

### TC-H-016 — channelIndex Stored in Camera Record

| Field | Value |
|---|---|
| **ID** | TC-H-016 |
| **SRS** | FR-CAM-070 |
| **Priority** | P1 |
| **Type** | Integration (API) |

**Precondition**: Server running; NVR camera with `MaxChannel = 4`.

**Steps**:
1. `POST /api/cameras` with body `{ name: "XRN-810S Ch3", rtspUrl: "...", channelIndex: 3 }`.
2. `GET /api/cameras/:id` for the created camera.

**Expected**:
- HTTP 201 on POST; `body.data.channelIndex === 3`.
- HTTP 200 on GET; `body.data.channelIndex === 3`.

**Cleanup**: `DELETE /api/cameras/:id`.

---

### TC-H-017 — SUNAPI Query Sends Basic Auth Header

| Field | Value |
|---|---|
| **ID** | TC-H-017 |
| **SRS** | FR-CAM-068 |
| **Priority** | P2 |
| **Type** | Unit |

**Precondition**: Mock HTTP server at `/stw-cgi/attributes.cgi/attributes` checks for `Authorization` header; returns the `System/Limit/MaxChannel=4` XML (see TC-H-004) only when auth header is present and valid (2026-07-02: corrected endpoint — see FR-CAM-062a).

**Steps**:
1. Set `RTSP_DEFAULT_USERNAME = "admin"`, `RTSP_DEFAULT_PASSWORD = "password"`.
2. Call `querySunapiMaxChannel(ip, httpPort, false)`.
3. Inspect return value and captured HTTP request headers.

**Expected**:
- Return value `4`.
- HTTP request includes `Authorization: Basic YWRtaW46cGFzc3dvcmQ=` (base64 of `admin:password`).

**Negative**: When `RTSP_DEFAULT_PASSWORD` is empty, no `Authorization` header is sent.

---

### TC-H-018 — MaxChannel/channelIndex derived from GetVideoSources order, not GetProfiles order

| Field | Value |
|---|---|
| **ID** | TC-H-018 |
| **SRS** | FR-CAM-075 |
| **Priority** | P1 |
| **Type** | Unit (mock ONVIF SOAP server) |

**Precondition**: Mock ONVIF server whose `GetVideoSources` response lists 3 tokens in order `VideoSource_0, VideoSource_1, VideoSource_2`, but whose `GetProfiles` response deliberately lists the corresponding profiles in the scrambled order `VideoSource_2, VideoSource_0, VideoSource_1`.

**Steps**: Call `enrichDevice(ip, xaddr)` against the mock server.

**Expected**: `result.MaxChannel === 3` (from `GetVideoSources`' token count, not `GetProfiles`' scrambled order/count); each profile's `channelIndex` matches its `SourceToken`'s position in the `GetVideoSources` list (`VideoSource_0→1, VideoSource_1→2, VideoSource_2→3`), not its position in the `GetProfiles` response.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-018b — MaxChannel falls back to GetProfiles' SourceToken count when GetVideoSources fails

| Field | Value |
|---|---|
| **ID** | TC-H-018b |
| **SRS** | FR-CAM-075 |
| **Priority** | P2 |
| **Type** | Unit (mock ONVIF SOAP server) |

**Precondition**: Mock ONVIF server with no `GetVideoSources` handler (empty SOAP envelope response — 0 tokens parsed); `GetProfiles` returns 2 profiles with 2 distinct `SourceToken` values.

**Steps**: Call `enrichDevice(ip, xaddr)`.

**Expected**: `result.MaxChannel === 2` — falls back to the `GetProfiles`-derived distinct-`SourceToken` count (FR-CAM-060) rather than defaulting straight to `1`.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-019 — enrichDeviceAutoScheme uses whichever of HTTP/HTTPS produced a usable result

| Field | Value |
|---|---|
| **ID** | TC-H-019 |
| **SRS** | FR-CAM-074 |
| **Priority** | P1 |
| **Type** | Unit (mock ONVIF SOAP server) |

**Precondition**: A mock ONVIF server answering meaningfully on one port (returns `Manufacturer`/`Model`); the HTTPS attempt is pointed at a port nothing listens on (fails outright, e.g. `ECONNREFUSED`).

**Steps**: Call `enrichDeviceAutoScheme(ip, { onvifPort: <mock port>, onvifHttpsPort: <dead port> })`.

**Expected**: The returned result carries the mock server's `Manufacturer`/`Model` — the failed HTTPS attempt does not clobber or null out the working HTTP result. (Live equivalent: 192.168.214.37's SUNAPI is HTTPS-only while its ONVIF service answers on HTTP — see FR-CAM-074's rationale.)

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-020 — ONVIF SOAP client follows one same-host redirect, but not a cross-host one

| Field | Value |
|---|---|
| **ID** | TC-H-020 |
| **SRS** | FR-CAM-076 |
| **Priority** | P1 |
| **Type** | Unit (mock HTTP servers) |

**Precondition (same-host case)**: Mock server A returns `301` with `Location` pointing at mock server B (different port, same `127.0.0.1` host), which answers `GetDeviceInformation` normally.
**Precondition (cross-host case)**: A separate mock server returns `301` with `Location` pointing at a different hostname (`198.51.100.1`, TEST-NET-2 — never actually contacted).

**Steps**: Call `enrichDevice(ip, xaddr)` against each mock in turn.

**Expected**: Same-host case — the redirect is followed and `Manufacturer` comes back populated from server B. Cross-host case — the redirect is **not** followed; `Manufacturer` stays empty (the original `301` is treated as a failure, caught silently by `enrichDevice()`), and the cross-host target is never contacted.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-021 — channelRtspUrl() recognizes both /profileN/ and /N/H.264/ conventions

| Field | Value |
|---|---|
| **ID** | TC-H-021a / TC-H-021b / TC-H-021c |
| **SRS** | FR-CAM-078 |
| **Priority** | P1 |
| **Type** | Unit (direct require, real module — not the inline copy used by TC-H-007) |

**Steps / Expected**:
- **021a** — `channelRtspUrl('rtsp://192.168.214.32:10030/profile1/media.smp', 3)` → `.../profile3/media.smp` (legacy convention unaffected).
- **021b** — `channelRtspUrl('rtsp://192.168.214.40/0/H.264/media.smp', 2)` → `.../1/H.264/media.smp`; and the channel-1 round trip, `channelRtspUrl('rtsp://192.168.214.40/1/H.264/media.smp', 1)` → `.../0/H.264/media.smp`.
- **021c** — `channelRtspUrl('rtsp://foo/bar/baz', 2)` → unchanged (no-op contract preserved).

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-022 — defaultSunapiRtspUrl() synthesizes a 0-based channel URL with port fallback

| Field | Value |
|---|---|
| **ID** | TC-H-022 |
| **SRS** | FR-CAM-079 |
| **Priority** | P1 |
| **Type** | Unit |

**Steps / Expected**: `defaultSunapiRtspUrl('192.168.214.37', null, 1)` → `rtsp://192.168.214.37:554/0/H.264/media.smp` (null port falls back to 554). `defaultSunapiRtspUrl('192.168.214.37', 554, 4)` → `.../3/H.264/media.smp` (confirmed port used directly, channel 4 → segment 3).

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-023 — querySunapiRtspPort() parses RTSPPort from the plain-text portconf response

| Field | Value |
|---|---|
| **ID** | TC-H-023 |
| **SRS** | FR-CAM-079 |
| **Priority** | P1 |
| **Type** | Unit (mock HTTP server) |

**Precondition**: Mock server answers `GET /stw-cgi/network.cgi?msubmenu=portconf&action=view` with plain text: `FixedPorts=3702,49152\nUsedPorts=\nHTTPPort=80\nHTTPSPort=443\nWebSessionTimeout=10\nRTSPPort=8554\nRTSPTimeout=60s\n`.

**Steps**: Call `querySunapiRtspPort('127.0.0.1', mockPort, false, 3000, 'admin', 'pass')`.

**Expected**: Returns `8554` (parsed from the `RTSPPort=` line, not XML-parsed).

Automated in `test/api/nvr_channel_discovery.test.js`. Also verified live via `curl --digest` against 192.168.214.32 and 192.168.214.37 before implementation — both returned `RTSPPort=554` in this exact plain-text shape.

---

### TC-H-024 — querySunapiRtspPort() short-circuits to null with no credentials

| Field | Value |
|---|---|
| **ID** | TC-H-024 |
| **SRS** | FR-CAM-079 |
| **Priority** | P1 |
| **Type** | Unit |

**Steps**: Call `querySunapiRtspPort('127.0.0.1', 1, false, 1000, '', '')` — port `1` is reserved/unlikely-bound, so any actual network attempt would fail/hang rather than return quickly.

**Expected**: Returns `null` immediately (no request attempted) — proves the credential gate runs before any I/O, not just that a request eventually fails.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-025 — SUNAPI CGI client follows one same-host redirect, but not a cross-host one

| Field | Value |
|---|---|
| **ID** | TC-H-025 |
| **SRS** | FR-CAM-077 |
| **Priority** | P1 |
| **Type** | Unit (mock HTTP servers) |

**Precondition (same-host case)**: Mock server A returns `301` with `Location` pointing at mock server B (different port, same `127.0.0.1` host), which answers `attributes.cgi/attributes` with `MaxChannel=4`.
**Precondition (cross-host case)**: A separate mock server returns `301` with `Location` pointing at a different hostname (`198.51.100.1`, TEST-NET-2 — never actually contacted).

**Steps**: Call `querySunapiMaxChannel('127.0.0.1', mockPort, false, 3000, '', '')` against each mock in turn.

**Expected**: Same-host case — the redirect is followed and `MaxChannel` comes back as `4`. Cross-host case — the redirect is **not** followed; `MaxChannel` falls back to `1` (the original `301` is treated as a failure), and the cross-host target is never contacted.

Automated in `test/api/nvr_channel_discovery.test.js`. Companion to TC-H-020 (identical redirect-following requirement, applied to the SUNAPI CGI client instead of the ONVIF SOAP client) — also verified live against 192.168.214.37, where `querySunapiMaxChannel()` now correctly returns `4` instead of `1`.

---

### TC-H-026 — UDP extended fields are undefined, not a false default, when the packet is too short

| Field | Value |
|---|---|
| **ID** | TC-H-026 |
| **SRS** | FR-CAM-081 |
| **Priority** | P1 |
| **Type** | Unit (real captured packet bytes, direct require) |

**Precondition**: A real 262-byte WiseNet UDP response captured live from a camera on this network (261-byte common header + 1 trailing byte) — numerically satisfies the old `b.length >= 261` gate but is 71 bytes short of the 72-byte extended block.

**Steps**: Call `_parseResponse()` directly against the captured bytes, then `mapUDPDevice()` on the result.

**Expected**: `modelType`, `chDeviceNameNew` **shall** be `undefined` — not a false `0`/`''` that would be indistinguishable from real data. `mapUDPDevice()`'s `Type`/`DeviceType` **shall** also be `undefined`, not `0`/`"Camera"`.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-027 — UDP extended fields parse correctly when the packet is genuinely complete

| Field | Value |
|---|---|
| **ID** | TC-H-027 |
| **SRS** | FR-CAM-081 |
| **Priority** | P1 |
| **Type** | Unit (synthetic 333-byte packet, direct require) |

**Precondition**: The same real 261-byte common header, with a synthetic 72-byte extended block appended (`modelType = 0x03`, i.e. Recorder) — 333 bytes total, matching the full documented extended-field layout.

**Steps**: Call `_parseResponse()`, then `mapUDPDevice()` on the result.

**Expected**: `modelType: 3`, `chDeviceNameNew` parses as set. `mapUDPDevice()`'s `Type: 3`, `DeviceType: 'Recorder'`.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-028 — UDPDiscoveryFallback parses a real captured packet correctly

| Field | Value |
|---|---|
| **ID** | TC-H-028 |
| **SRS** | FR-CAM-082 |
| **Priority** | P1 |
| **Type** | Unit (real captured packet bytes, direct require) |

**Precondition**: The same real 262-byte WiseNet UDP response used in TC-H-026, from `192.168.214.37` (device: PNM-C32083).

**Steps**: Call `UDPDiscoveryFallback._parseResponse()` (`server/src/utils/udpDiscovery.js`) directly against the captured bytes.

**Expected**: `chIP: '192.168.214.37'`, `chMac: '00:09:18:21:95:85'`, `chDeviceName: 'PNM-C32083'`, `nPort: 443`, `nTcpPort: 10030`, `modelType: undefined`. The port assertions specifically catch an endianness inversion bug found and fixed during implementation (`ntohs()`'s `big` flag means little-endian on the wire, not big-endian — a naive reimplementation produced a plausible-looking but wrong port number that only a byte-exact fixture like this one would catch).

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-029 — UDPDiscoveryFallback matches the submodule end-to-end (parity)

| Field | Value |
|---|---|
| **ID** | TC-H-029 |
| **SRS** | FR-CAM-082 |
| **Priority** | P1 |
| **Type** | Unit (direct require of both implementations, skips if submodule unavailable) |

**Steps**: Parse the same real 262-byte packet with both `UDPDiscoveryFallback._parseResponse()` and the submodule's `_parseResponse()`; compare every field, then run both results through `mapUDPDevice()` and compare `Model`/`Port`/`DeviceType`.

**Expected**: All compared fields are identical between the two implementations.

Automated in `test/api/nvr_channel_discovery.test.js`. Also verified live (manual, not part of this automated suite): `UDPDiscoveryFallback` run standalone against this network's real broadcast domain discovered all 13 known cameras on the 192.168.214.x subnet, matching model names and ports exactly.

---

### TC-H-030 — `supported_protocol`/`no_password` read from distinct, correctly-ordered offsets

| Field | Value |
|---|---|
| **ID** | TC-H-030 |
| **SRS** | FR-CAM-083 |
| **Priority** | P1 |
| **Type** | Unit (synthetic extended-block bytes with distinct sentinel values, direct require) |

**Precondition**: A real 261-byte base-field prefix (from the same captured packet as TC-H-026), with a synthetic extended block appended carrying distinct sentinel values for `supported_protocol` (`0x07`) and `no_password` (`0x01`).

**Steps**: Call the submodule's `_parseResponse()` against the fixture; check `supportedProtocol` and `noPassword` independently, then run the result through `mapUDPDevice()`.

**Expected**: `supportedProtocol === 7` and `noPassword === 1` — two distinct values, neither aliasing the other. `mapUDPDevice()` surfaces the raw byte as `SupportedProtocol: 7`. Regression guard for a real bug: prior to the fix, `noPassword` read the byte belonging to `supported_protocol` (one field too early) and the real trailing `no_password` byte was never read at all — two adjacent 1-byte struct fields silently collapsing into one.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-031 — Extended field block is gated on `nMode`, not merely on remaining packet length

| Field | Value |
|---|---|
| **ID** | TC-H-031 |
| **SRS** | FR-CAM-084 |
| **Priority** | P1 |
| **Type** | Unit (synthetic 334-byte packet, base-mode `nMode=11`, direct require) |

**Precondition**: The same real captured 261-byte prefix (which itself carries `nMode=11`, a base-mode response), padded with a full, plausible-looking 73-byte extended block (`modelType=3`, `chDeviceNameNew='XRN-1610S-TEST'`, etc.) — 334 bytes total, numerically long enough for the whole extended block.

**Steps**: Call the submodule's `_parseResponse()` against this fixture, without altering its `nMode` byte.

**Expected**: `nMode === 11`; `modelType`, `chDeviceNameNew`, and `supportedProtocol` are all `undefined` — the mode gate (`nMode !== 12`) takes precedence over the packet being numerically long enough for the block. `mapUDPDevice()`'s `DeviceType` stays `undefined` too. Regression guard proving the length-based heuristic (FR-CAM-081) is no longer, by itself, sufficient evidence that the extended block is present.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-032 — npm-package-backed `UDPDiscovery` matches the submodule-loaded copy for a genuine `nMode=12` (DEF_RES_SCAN_EXT) response

| Field | Value |
|---|---|
| **ID** | TC-H-032 |
| **SRS** | FR-CAM-084, FR-CAM-087 |
| **Priority** | P1 |
| **Type** | Unit (synthetic 334-byte packet, `nMode` forced to 12, direct require of both install paths, skips if submodule unavailable) |
| **Note (2026-07-03)** | Renamed from "`UDPDiscoveryFallback` vs submodule" — `server/src/utils/udpDiscovery.js` no longer has an independent implementation (FR-CAM-087); this now compares the npm-package-backed copy (`server/src/utils/udpDiscovery.js`'s re-export) against the copy loaded directly from the git submodule path — both are the same source, loaded via two different install paths |

**Steps**: Take the same 261-byte prefix used in TC-H-031, overwrite its `nMode` byte to `12`, append the same synthetic extended block, and parse with both `UDPDiscovery` (`server/src/utils/udpDiscovery.js`, npm-package-backed) and `UDPDiscovery` loaded directly from `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js`. Compare `modelType`, `chDeviceNameNew`, `version`, `httpType`, `nHttpsPort`, `supportedProtocol`, `noPassword`; run both through `mapUDPDevice()` and compare `DeviceType`/`SupportedProtocol`.

**Expected**: `modelType === 3`, `supportedProtocol === 5`, `DeviceType === 'Recorder'`, and every compared field identical between the two loaded copies.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-033 — `_parseResponse()` rejects response modes belonging to a different exchange (RSA/password-apply)

| Field | Value |
|---|---|
| **ID** | TC-H-033 |
| **SRS** | FR-CAM-084 |
| **Priority** | P1 |
| **Type** | Unit (real 261-byte prefix with `nMode` overwritten to each of 7 non-scan values, direct require) |

**Precondition**: The vendor spec's Table 1/2 `nMode` enum defines 7 response values that belong to exchanges other than "IP Scan" (RSA key exchange §3.5, password-apply §3.6/§3.7): `13, 23, 24, 25, 33, 66, 77`.

**Steps**: For each of the 7 values, overwrite the real captured prefix's `nMode` byte and call the submodule's `_parseResponse()`. Then confirm the same bytes with `nMode` restored to a real scan value (`11`) still parse normally.

**Expected**: Every one of the 7 non-scan `nMode` values yields `null` — not a partially/incorrectly parsed device object built from an incompatible struct layout. The sanity check (`nMode=11`) still returns a normally-parsed device (`chIP: '192.168.214.37'`).

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-034 — npm-package-backed `UDPDiscovery` also rejects non-scan `nMode` values

| Field | Value |
|---|---|
| **ID** | TC-H-034 |
| **SRS** | FR-CAM-084, FR-CAM-087 |
| **Priority** | P1 |
| **Type** | Unit (same 7 non-scan `nMode` values as TC-H-033, npm-package-backed copy, direct require) |
| **Note (2026-07-03)** | Renamed from "`UDPDiscoveryFallback`" — see TC-H-032's note |

**Steps**: Same as TC-H-033, but against `server/src/utils/udpDiscovery.js`'s `UDPDiscovery._parseResponse()` (npm-package-backed) instead of the submodule.

**Expected**: Identical outcome to TC-H-033 — all 7 values yield `null`, confirming both loaded copies apply the same dispatch.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-035 — RTSP URL/Port never derived from `nTcpPort` or `nPort`

| Field | Value |
|---|---|
| **ID** | TC-H-035 |
| **SRS** | FR-CAM-088 |
| **Priority** | P1 |
| **Type** | Unit (real captured packet, direct require of `server/src/utils/udpDiscovery.js` + `discoveryService.js`) |

**Steps (TC-H-035a)**: Parse the same real 262-byte captured packet used by TC-H-028 (`nTcpPort=10030`, a VNP-only field) via `UDPDiscovery._parseResponse()` and inspect `result.rtspUrl`.

**Expected (TC-H-035a)**: `rtspUrl` contains port `554`, not `10030`.

**Steps (TC-H-035b)**: Pass the same parsed result (`nPort=443`, the device's HTTPS web port) through `mapUDPDevice()` and inspect `Port`/`rtspUrl`.

**Expected (TC-H-035b)**: `Port` is `554`, not `443`; `rtspUrl` uses port `554`.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-036 — SUNAPI CGI Digest-auth challenge detection recognizes combined multi-scheme `WWW-Authenticate` headers

| Field | Value |
|---|---|
| **ID** | TC-H-036 |
| **SRS** | FR-CAM-089 |
| **Priority** | P2 |
| **Type** | Unit (synthetic challenge string, direct require of `buildDigestAuthHeader()` from `discoveryService.js`) |

**Steps**: Call `buildDigestAuthHeader()` with a synthetic challenge offering both schemes in one string — `Basic realm="BasicRealm", Digest realm="DigestRealm", qop="auth", nonce="abc123nonce", opaque="op1"` — and inspect the computed `Authorization` header. Also verify the old anchored regex (`/^Digest\s/i`) would *not* have matched this string (regression guard), and that a single-scheme Digest challenge (the pre-existing FR-CAM-072 case) still works unchanged.

**Expected**: The computed header contains `realm="DigestRealm"` and the correct `nonce`, and does **not** contain `realm="BasicRealm"` (i.e. parameter extraction is scoped to the Digest portion of the challenge, not the full string).

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-037 — ONVIF `enrichDevice()` authenticates via HTTP Basic when the device accepts it

| Field | Value |
|---|---|
| **ID** | TC-H-037 |
| **SRS** | FR-CAM-090 |
| **Priority** | P1 |
| **Type** | Unit (mock ONVIF SOAP server enforcing Basic auth, direct require of `onvifDiscovery.js`) |

**Steps**: Start a mock ONVIF SOAP server that requires HTTP Basic auth (`admin`/`right-pass`) on every request. Call `enrichDevice(ip, xaddr, { username: 'admin', password: 'right-pass' })`.

**Expected**: `result.Manufacturer` is populated from `GetDeviceInformation` — the Basic-authenticated request succeeds on the first attempt, no Digest retry needed.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-038 — ONVIF `enrichDevice()` retries with computed RFC 7616 Digest after a Digest-only device rejects Basic

| Field | Value |
|---|---|
| **ID** | TC-H-038 |
| **SRS** | FR-CAM-090 |
| **Priority** | P1 |
| **Type** | Unit (mock ONVIF SOAP server performing real RFC 7616 Digest verification, direct require of `onvifDiscovery.js`) |

**Steps**: Start a mock ONVIF SOAP server that 401s any `Basic` `Authorization` attempt outright and, on a `Digest` attempt, verifies the response hash server-side (computes its own expected `response` from `username`/`realm`/`password`/`nonce`/`nc`/`cnonce`/`qop`/method/URI and compares). Call `enrichDevice(ip, xaddr, { username: 'admin', password: 'right-pass' })`.

**Expected**: `result.Manufacturer` is populated — `soapPost()`'s first (Basic) attempt is 401-rejected, and the computed Digest retry succeeds.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-039 — ONVIF Digest retry with a wrong password still fails (does not mask bad credentials)

| Field | Value |
|---|---|
| **ID** | TC-H-039 |
| **SRS** | FR-CAM-090 |
| **Priority** | P1 |
| **Type** | Unit (same mock server as TC-H-038, direct require of `onvifDiscovery.js`) |

**Steps**: Against the same Digest-only mock server as TC-H-038 (real credentials `admin`/`right-pass`), call `enrichDevice(ip, xaddr, { username: 'admin', password: 'wrong-pass' })`.

**Expected**: `result.Manufacturer` stays empty — the Digest retry itself receives a mismatched `response` hash and is rejected, exactly as FR-CAM-072/089's SUNAPI equivalent behaves: a genuinely wrong password is never masked by the scheme-mismatch retry.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-039b — ONVIF `enrichDevice()` without credentials against an auth-required device is unchanged from pre-FR-CAM-090 behavior

| Field | Value |
|---|---|
| **ID** | TC-H-039b |
| **SRS** | FR-CAM-090 |
| **Priority** | P2 |
| **Type** | Regression (same Digest-only mock server as TC-H-038, direct require of `onvifDiscovery.js`) |

**Steps**: Against the same Digest-only mock server as TC-H-038, call `enrichDevice(ip, xaddr)` with no third argument (no `credentials`).

**Expected**: `result.Manufacturer` stays empty and the call does not throw — `soapPost()` sends no `Authorization` header at all (matching FR-CAM-012/014's original best-effort behavior) and never attempts a Digest retry, since `credentials` was never given.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

### TC-H-040 — UDP discovery `MaxChannel` is derived from `nMulticastPort` only when `nMode` is `DEF_RES_SCAN_EXT` (12)

| Field | Value |
|---|---|
| **ID** | TC-H-040 |
| **SRS** | FR-CAM-091 |
| **Priority** | P2 |
| **Type** | Unit (real captured packet with `nMode` byte overwritten, direct require of `server/src/utils/udpDiscovery.js` + `discoveryService.js`) |

**Steps**: Parse the same real 262-byte captured packet used by TC-H-028/035 (`nMode=11`, base mode; `nMulticastPort=10050`) via `UDPDiscovery._parseResponse()` and `mapUDPDevice()`. Then reparse the identical bytes with only the `nMode` byte overwritten to `12` (`DEF_RES_SCAN_EXT`).

**Expected**: With `nMode=11`, `_parseResponse()`'s `nMaxChannel` is `undefined` and `mapUDPDevice()`'s `MaxChannel` falls back to `1`. With `nMode=12` (same underlying bytes, so `nMulticastPort` still decodes to `10050`), `nMaxChannel` equals `10050` and `mapUDPDevice()`'s `MaxChannel` surfaces `10050`.

Automated in `test/api/nvr_channel_discovery.test.js`.

---

## 11. Test Execution Order

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
| NVR MaxChannel | SourceToken-based count; SUNAPI query with Basic auth; merge takes max; card badge visible; channel selection panel; RTSP URL per channel; name suffix Ch{N}; channelIndex stored; SUNAPI MaxChannel as input cap |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — Test cases for Camera Discovery |
| 1.1 | 2026-06-23 | LTS Engineering Team | §10 Test Group H 추가 — NVR MaxChannel TC-H-001~TC-H-013 (SourceToken, channelIndex, SUNAPI, mergeDevices, UI badge, channel panel, RTSP URL) |
| 1.2 | 2026-06-24 | LTS Engineering Team | TC-H-014~017 추가 — SUNAPI MaxChannel 상한, 비-SUNAPI 상한, channelIndex API 저장, SUNAPI Basic 인증 헤더 |
| 1.3 | 2026-07-02 | LTS Engineering Team | TC-H-004/TC-H-017 목 서버 엔드포인트 정정 — 존재하지 않는 `media.cgi?msubmenu=channellist` JSON 응답 대신 실제 엔드포인트 `GET /stw-cgi/attributes.cgi/attributes`의 XML 응답으로 수정 (FR-CAM-062a) |
| 1.4 | 2026-07-02 | LTS Engineering Team | Traceability에 FR-CAM-072(TC-CH-F-012/F-012b, Channel Slot 스위트로 자동화)·FR-CAM-073(TC-G-007, 수동) 추가; §9에 TC-G-007 신규 추가 — SUNAPI HTTPS 자체 서명 인증서 수정을 실 카메라(192.168.214.37)로 검증 |
| 1.5 | 2026-07-02 | LTS Engineering Team | §10에 TC-H-018/H-018b/H-019/H-020 신규 추가 — ONVIF GetVideoSources 기반 MaxChannel/channelIndex(FR-CAM-075), 온디맨드 probe HTTP/HTTPS 동시 시도(FR-CAM-074), ONVIF SOAP 동일 호스트 리다이렉트 추적(FR-CAM-076) 모두 mock 서버로 자동화(`test/api/nvr_channel_discovery.test.js`); TC-G-007의 오래된 "MaxChannel=1" 서술 정정(실 카메라 상태가 이후 4채널로 변경됨을 확인) |
| 1.6 | 2026-07-02 | LTS Engineering Team | §10에 TC-H-021~025 신규 추가 — `channelRtspUrl()` 이중 컨벤션(FR-CAM-078), `defaultSunapiRtspUrl()`/`querySunapiRtspPort()` RTSP 포트 확인(FR-CAM-079), SUNAPI CGI 클라이언트 동일 호스트 리다이렉트 추적(FR-CAM-077, TC-H-020의 SUNAPI측 대응) 모두 실제 모듈 direct-require + mock 서버로 자동화; Traceability에 FR-CAM-077~080 추가; Test Scripts 필드에 `nvr_channel_discovery.test.js` 누락분 반영 |
| 1.7 | 2026-07-02 | LTS Engineering Team | §10에 TC-H-026/H-027 신규 추가 — UDP Discovery 확장 필드 bounds-check 버그 수정 검증(FR-CAM-081), 실제 캡처한 262바이트 패킷 + 합성 333바이트 패킷으로 자동화; Traceability에 FR-CAM-081 추가 |
| 1.8 | 2026-07-02 | LTS Engineering Team | §10에 TC-H-028/H-029 신규 추가 — `UDPDiscoveryFallback`이 서브모듈과 byte-for-byte parity를 갖도록 수정한 것을 검증(FR-CAM-082), 엔디언 버그(포트 번호) 회귀 방지용 실측 바이트 fixture 포함; Traceability에 FR-CAM-082 추가 |
| 1.9 | 2026-07-03 | LTS Engineering Team | §10에 TC-H-030~034 신규 추가 — `supported_protocol`/`no_password` 오프셋 회귀 검증(FR-CAM-083), `nMode` 기반 확장 필드 게이팅(FR-CAM-084, TC-H-027 fixture를 nMode=12로 수정)과 non-scan 모드 조기 거부(TC-H-033/034, 서브모듈+폴백 양쪽) 검증; Traceability에 FR-CAM-083/084 추가 |
| 1.10 | 2026-07-03 | LTS Engineering Team | §10에 TC-H-035(RTSP URL/Port가 nTcpPort/nPort를 쓰지 않음, FR-CAM-088)·TC-H-036(콤바인드 WWW-Authenticate 헤더 Digest 감지, FR-CAM-089) 신규 추가; TC-H-032/034를 `server/src/utils/udpDiscovery.js`의 인라인 폴백 완전 제거(FR-CAM-087)에 맞춰 "UDPDiscoveryFallback vs 서브모듈" → "npm 패키지 재노출 vs 서브모듈 직접 로드" 비교로 명칭·본문 정정; Traceability에 FR-CAM-085~089 추가, FR-CAM-082를 FR-CAM-087로 superseded 표시 |
| 1.11 | 2026-07-03 | LTS Engineering Team | §10에 TC-H-037~039b 신규 추가 — ONVIF SOAP 클라이언트의 HTTP Basic→Digest 인증 재시도(FR-CAM-090): Basic 수락 기기 인증 성공(TC-H-037), Digest 전용 기기에서 계산된 RFC 7616 Digest로 재시도 성공(TC-H-038), 잘못된 비밀번호는 Digest 재시도 후에도 여전히 실패(TC-H-039, mock 서버가 서버측에서 실제 해시를 검증), credentials 미제공 시 기존 무인증 동작 불변(TC-H-039b); Traceability에 FR-CAM-090 추가 |
| 1.12 | 2026-07-03 | LTS Engineering Team | §10에 TC-H-040 신규 추가 — UDP Discovery `MaxChannel`이 확장 응답(`nMode=12`)에서만 `nMulticastPort`로부터 도출되고 base 모드(`nMode=11`)에서는 도출되지 않음을 검증(FR-CAM-091, 실 캡처 패킷의 `nMode` 바이트만 덮어쓴 합성 픽스처로 파싱 메커니즘 확인 — 진짜 nMode=12 기기는 미포착); Traceability에 FR-CAM-091 추가 |
