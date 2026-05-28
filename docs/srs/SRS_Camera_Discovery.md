# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Camera Discovery & Network Search Subsystem

| | |
|---|---|
| **Document ID** | SRS-LTS-CAM-01 |
| **Version** | 1.0 |
| **Status** | Active |
| **Date** | 2026-05-26 |
| **Parent PRD** | prd/PRD_Camera_Discovery.md |
| **Parent RFP** | rfp/RFP_Camera_Discovery.md |

---

## Table of Contents
1. [Introduction](#1-introduction)
2. [System Overview](#2-system-overview)
3. [Functional Requirements — WiseNet UDP Discovery](#3-functional-requirements--wisenet-udp-discovery)
4. [Functional Requirements — ONVIF WS-Discovery](#4-functional-requirements--onvif-ws-discovery)
5. [Functional Requirements — Unified Device Registry](#5-functional-requirements--unified-device-registry)
6. [Functional Requirements — Real-Time Push](#6-functional-requirements--real-time-push)
7. [Functional Requirements — Scan Control & REST API](#7-functional-requirements--scan-control--rest-api)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Interface Requirements](#9-interface-requirements)
10. [Constraints & Assumptions](#10-constraints--assumptions)

---

## 1. Introduction

### 1.1 Purpose

This SRS defines the complete, verifiable functional requirements for the Camera Discovery subsystem of LTS-2026. Each requirement is identified by a unique ID (FR-CAM-NNN) and is directly traceable to test cases in TC_Camera_Discovery.md.

### 1.2 Scope

This document covers:
- WiseNet/Hanwha proprietary UDP broadcast discovery (port 7701/7711)
- ONVIF WS-Discovery multicast probe (239.255.255.250:3702)
- Unified in-memory device registry with MAC-based deduplication
- Real-time Socket.IO push of discovered devices to dashboard clients
- REST API for scan control and device enumeration
- Camera registration from discovered device data

Out of scope: mDNS/Bonjour discovery, WAN/inter-subnet discovery, PTZ control during discovery, automated credential management.

### 1.3 Definitions

| Term | Definition |
|---|---|
| WiseNet UDP | Hanwha Vision proprietary discovery protocol using UDP broadcast on port 7701/7711 |
| WS-Discovery | OASIS Web Services Discovery standard (SOAP over UDP multicast) used by ONVIF cameras |
| ONVIF | Open Network Video Interface Forum — industry standard for IP camera interoperability |
| XAddr | ONVIF device service endpoint URL returned in a ProbeMatch response |
| ProbeMatch | ONVIF WS-Discovery response message from a discovered camera |
| DeviceInfo | Normalized camera descriptor object in the unified registry |
| MAC deduplication | Using MAC address as the primary key to collapse duplicate records across discovery sources |
| DiscoveryService | Node.js orchestrator class managing both UDP and ONVIF discovery lifecycles |
| hydration | Delivering all currently-known devices to a newly-connected dashboard socket client |

---

## 2. System Overview

### 2.1 Component Dependencies

```
Network (LAN broadcast / multicast)
  ├─ UDPDiscovery (WiseNet)             — 255.255.255.255:7701 send / :7711 receive
  │    └─ mapUDPDevice()                — normalize raw packet to DeviceInfo
  └─ ONVIFDiscovery                     — 239.255.255.250:3702 multicast probe
       ├─ enrichDevice()                — SOAP: GetDeviceInformation, GetProfiles, GetStreamUri
       └─ emits 'device' events

DiscoveryService
  ├─ _upsert(device)                    — merge into _known Map, update _ipIndex
  ├─ _emit(device)                      — io.emit('discovery:result')
  ├─ hydrate(socket)                    — replay _known to new client
  └─ _runScan()                         — start both protocols concurrently

Socket.IO server (io)
  ├─ emit 'discovery:result'            — new/updated device
  ├─ emit 'discovery:scanning'          — scan state change
  ├─ emit 'discovery:cleared'           — registry cleared
  └─ emit 'discovery:error'             — non-fatal error

REST API (/api/cameras, /api/discovery/*)
  └─ cameras.js Router                  — CRUD + discover trigger
```

### 2.2 Startup Sequence

```
Server start
  1. DiscoveryService constructed with io instance
  2. discoveryService.start() called
  3. _runScan() begins — UDP + ONVIF concurrently
  4. Socket.IO 'connection' handler calls hydrate(socket) for each new client
  5. Scan completes after SCAN_TIMEOUT (10s); SCAN_INTERVAL (15s) pause; repeat
```

---

## 3. Functional Requirements — WiseNet UDP Discovery

### FR-CAM-001 — UDP Broadcast Packet

- The system must send a fixed 160-byte WiseNet magic packet to UDP broadcast address 255.255.255.255 on port 7701.
- The packet must be sent using a raw UDP socket with `SO_BROADCAST` enabled.
- Sending is performed via the `UDPDiscovery` class from `server/src/utils/udpDiscovery.js`.

### FR-CAM-002 — UDP Response Listening

- The system must listen for camera responses on UDP port 7711.
- The listening window must remain open for 10 seconds (SCAN_TIMEOUT) after the broadcast is sent.
- Each received response must be parsed as a binary WiseNet device record.

### FR-CAM-003 — UDP Response Parsing

- Standard responses must yield: IP address, MAC address, HTTP port, HTTPS port, device name, firmware version, SUNAPI support flag, DDNS URL.
- Extended-format responses (length >= 261 bytes) must additionally yield: device alias, model type, HTTPS port override.
- Non-printable bytes in string fields must be stripped before storage.

### FR-CAM-004 — UDP Device Normalization

- `mapUDPDevice(raw)` must produce a `DeviceInfo` object with `source: 'udp'` and `Manufacturer: 'Hanwha Vision'`.
- `id` must be set to `"${MAC}_${IP}"`.
- Default HTTP port must be 80 if raw value is 0 or absent; default HTTPS port must be 443 if raw value is 0 or absent.
- Devices with empty IP addresses must be silently discarded (return `null`).

### FR-CAM-005 — UDP Scan Cycle

- The scan must repeat continuously: 10-second scan window followed by a 15-second pause, indefinitely.
- Each cycle must emit a fresh broadcast; cameras are re-discovered and registry entries updated (not duplicated).
- The scan cycle must survive socket errors: on `error` event, `_onProtocolDone()` must be called and the scan rescheduled after SCAN_INTERVAL.

---

## 4. Functional Requirements — ONVIF WS-Discovery

### FR-CAM-010 — ONVIF Probe Transmission

- The system must send a SOAP 1.2 / WS-Discovery `Probe` message to UDP multicast address 239.255.255.250 on port 3702.
- The probe body must specify `d:Types = dn:NetworkVideoTransmitter`.
- A unique `MessageID` UUID must be generated per probe.
- The socket must join the multicast group `239.255.255.250` before sending.

### FR-CAM-011 — ProbeMatch Processing

- On receiving a UDP message containing `ProbeMatch` or `XAddrs` content, the system must extract the `XAddrs` field.
- The first XAddr (space-separated list) must be used as the device service endpoint URL.
- Duplicate IPs (already seen in this scan cycle) must be ignored.
- A basic `DeviceInfo` object with `source: 'onvif'` must be emitted immediately upon ProbeMatch receipt before enrichment.

### FR-CAM-012 — ONVIF Device Enrichment

- After emitting the basic device, the system must asynchronously call `enrichDevice(ip, xaddr)`.
- `enrichDevice` must attempt (best-effort, no auth) the following ONVIF SOAP calls:
  1. `GetDeviceInformation` — extract Manufacturer, Model, FirmwareVersion, SerialNumber.
  2. `GetCapabilities` (Category: Media) — locate the media service XAddr.
  3. `GetProfiles` at the media service XAddr — extract profile tokens, names, encoding, width, height, frame rate.
  4. `GetStreamUri` (RTP-Unicast/RTSP) for each profile (up to 4 profiles) — extract RTSP URL per profile.
- Each SOAP call must time out after 4 seconds (HTTP_TIMEOUT).
- Failures in any individual SOAP call must not abort enrichment of remaining calls.

### FR-CAM-013 — ONVIF Profile Data

- Each profile returned by `GetProfiles` must produce an `OnvifProfile` object with fields: `token`, `name`, `encoding`, `width`, `height`, `fps`, `rtspUrl`.
- The `rtspUrl` of the first profile must be used as the device-level `rtspUrl` if no other URL is set.
- If no profile RTSP URL is obtained, the fallback must be `rtsp://<IP>:554/`.

### FR-CAM-014 — ONVIF Authentication

- ONVIF service calls must first be attempted unauthenticated.
- A 401 HTTP response must result in an `AUTH_REQUIRED` error that is caught silently; the device is still emitted with basic probe data.
- Credentials are never embedded in ONVIF requests by the discovery subsystem (credential injection is a separate operator flow).

### FR-CAM-015 — ONVIF Probe Timeout

- The ONVIF discovery window must close after 10 seconds (PROBE_TIMEOUT).
- On timeout, the `'done'` event must be emitted to notify `DiscoveryService`.
- All pending enrichment calls may continue asynchronously after `'done'` is emitted.

---

## 5. Functional Requirements — Unified Device Registry

### FR-CAM-020 — Registry Data Structure

- The registry must be an in-memory `Map<string, DeviceInfo>` keyed by `deviceKey(device)`.
- A secondary `Map<IPAddress, deviceKey>` index (`_ipIndex`) must support cross-protocol merge by IP.
- `deviceKey(device)` must return `"mac_<MACAddress>"` when a MAC is present (length > 5); otherwise `"ip_<IPAddress>"`.

### FR-CAM-021 — Cross-Protocol Deduplication

- When a device is upserted and `_ipIndex` already contains a different key for that IP, the incoming device must be merged into the existing entry under the existing key.
- After merging, the `source` field of the merged entry must be `'both'` when the two entries had different source values.

### FR-CAM-022 — Merge Rules

- `mergeDevices(existing, incoming)` must apply the following precedence rules:
  - Basic string fields (`Model`, `Manufacturer`, `MACAddress`, `FirmwareVersion`, `SerialNumber`, `Gateway`, `SubnetMask`, `URL`): incoming value fills in only if the existing field is empty/falsy.
  - `rtspUrl`: incoming wins unless it equals the fallback pattern `rtsp://<IP>:554/` and the existing value is already set.
  - `SupportSunapi`, `SupportOnvif`: OR of both values (capability accumulates).
  - `profiles`: the richer (longer) array wins.

### FR-CAM-023 — Persistence Across Scan Cycles

- Registry entries must persist between scan cycles; re-discovered devices update (merge) existing entries rather than replacing them.
- Registry entries are only removed by an explicit `rescan()` call.

### FR-CAM-024 — Device Count

- `DiscoveryService.knownCount` must return the current number of devices in the registry.

---

## 6. Functional Requirements — Real-Time Push

### FR-CAM-030 — New/Updated Device Push

- On each upsert, `DiscoveryService` must emit a Socket.IO `discovery:result` event to all connected clients.
- The event payload must be `{ device: DeviceInfo }` where `DeviceInfo` is the post-merge registry entry.

### FR-CAM-031 — Scan State Push

- On scan start, the system must emit `discovery:scanning` with `{ scanning: true }`.
- On scan end (both protocols done), the system must emit `discovery:scanning` with `{ scanning: false, count: <knownCount> }`.

### FR-CAM-032 — Registry Cleared Push

- `rescan()` must emit `discovery:cleared` (empty payload `{}`) before restarting the scan.

### FR-CAM-033 — Error Push

- Non-fatal socket/network errors must emit `discovery:error` with `{ message: string }`.

### FR-CAM-034 — Client Hydration

- When a new Socket.IO client connects, `DiscoveryService.hydrate(socket)` must be called.
- `hydrate()` must emit one `discovery:result` event per registered device in `_known` directly to that socket (not broadcast).
- `hydrate()` must then emit `discovery:scanning` with the current state and count to that socket.

---

## 7. Functional Requirements — Scan Control & REST API

### FR-CAM-040 — REST Discover Trigger

- `POST /api/cameras/discover` must emit `discovery:trigger` via Socket.IO and return `{ success: true, data: [], message: string }`.
- The endpoint must not block waiting for results; real-time results arrive via Socket.IO events.

### FR-CAM-041 — Camera Registration

- `POST /api/cameras` must accept `{ name, rtspUrl, username?, password?, ip?, mac?, httpPort? }`.
- `name` and `rtspUrl` are required; missing fields must return HTTP 400.
- A UUID must be generated and the camera persisted in the database with `status: 'offline'`.
- The response must be HTTP 201 with the created camera record (password field excluded).

### FR-CAM-042 — Camera List

- `GET /api/cameras` must return all cameras sorted by `createdAt` descending with enriched `pipelineStatus`.
- Passwords must never appear in the list response.
- YouTube cameras must have their `bitrate` normalized from bps to kbps in the response.

### FR-CAM-043 — Camera CRUD

- `GET /api/cameras/:id` must return a single camera or HTTP 404.
- `PUT /api/cameras/:id` must update allowed fields and restart the pipeline when `rtspUrl`, `webrtcEnabled`, `username`, or `password` changes.
- `DELETE /api/cameras/:id` must stop the pipeline, remove the record, and return HTTP 200.
- `POST /api/cameras/:id/stream/reconnect` must stop and restart the pipeline.
- `POST /api/cameras/:id/stream/start` / `stream/stop` must start or stop the inference pipeline without modifying config.

### FR-CAM-044 — Rescan

- `DiscoveryService.rescan()` must clear both `_known` and `_ipIndex`, emit `discovery:cleared`, and call `_runScan()`.
- Rescan is also triggerable via Socket.IO `discovery:rescan` event from the client.

### FR-CAM-045 — Stop Discovery

- `DiscoveryService.stop()` must:
  1. Set `_scanning = false` and `_pendingDone = 0`.
  2. Clear the scan interval timer.
  3. Stop both `_udpDisc` and `_onvifDisc` instances if active.
  4. Null out references to both discovery instances.

---

## 8. Non-Functional Requirements

### FR-CAM-050 — Discovery Latency

- At least one camera on the local LAN must appear in the dashboard within 2 seconds of scan start.

### FR-CAM-051 — Network Traffic Limit

- Total broadcast/multicast traffic per scan cycle must not exceed 5 KB.

### FR-CAM-052 — Scale

- The system must support up to 256 discovered devices in the registry without UI degradation.

### FR-CAM-053 — Reliability

- The discovery service must recover automatically from socket errors (both UDP and ONVIF) without requiring server restart.
- Retry occurs after SCAN_INTERVAL (15 seconds).

### FR-CAM-054 — Security

- Credentials must never be written to server logs.
- ONVIF WS-Security (UsernameToken) is supported via the credential flow but is out of scope for the discovery subsystem itself.

### FR-CAM-055 — Compatibility

- ONVIF Core 2.0 and above.
- Tested against: Axis, Hikvision, Dahua, Hanwha, Bosch.

### FR-CAM-056 — Concurrent Protocol Operation

- Both WiseNet UDP and ONVIF WS-Discovery must run concurrently in the same scan cycle.
- `_pendingDone` counter (initialized to 2) ensures the scan completes only when both protocols finish.

---

## 9. Interface Requirements

### 9.1 REST API

| ID | Method | Endpoint | Description |
|---|---|---|---|
| FR-CAM-040 | POST | `/api/cameras/discover` | Trigger discovery broadcast |
| FR-CAM-041 | POST | `/api/cameras` | Add new camera |
| FR-CAM-042 | GET | `/api/cameras` | List all cameras |
| FR-CAM-043 | GET | `/api/cameras/:id` | Get camera by ID |
| FR-CAM-043 | PUT | `/api/cameras/:id` | Update camera config |
| FR-CAM-043 | DELETE | `/api/cameras/:id` | Remove camera |
| FR-CAM-043 | POST | `/api/cameras/:id/stream/reconnect` | Reconnect pipeline |
| FR-CAM-043 | POST | `/api/cameras/:id/stream/start` | Start pipeline |
| FR-CAM-043 | POST | `/api/cameras/:id/stream/stop` | Stop pipeline |

### 9.2 Socket.IO Events (Server → Client)

| Event | Payload | Condition |
|---|---|---|
| `discovery:result` | `{ device: DeviceInfo }` | New or updated camera discovered |
| `discovery:scanning` | `{ scanning: boolean, count?: number }` | Scan state change |
| `discovery:cleared` | `{}` | Registry cleared on rescan |
| `discovery:error` | `{ message: string }` | Non-fatal scan error |

### 9.3 Socket.IO Events (Client → Server)

| Event | Description |
|---|---|
| `discovery:rescan` | Trigger rescan (clear + restart) |
| `discovery:stop` | Stop all discovery |

### 9.4 DeviceInfo Schema

```typescript
interface DeviceInfo {
  id:             string;           // "{MAC}_{IP}" or "onvif_{IP}"
  source:         'udp' | 'onvif' | 'both';
  IPAddress:      string;
  MACAddress:     string;           // uppercase, colon-separated
  Port:           number;
  HttpPort:       number;
  HttpsPort:      number;
  HttpType:       boolean;          // true = HTTPS only
  Gateway:        string;
  SubnetMask:     string;
  Manufacturer:   string;
  Model:          string;
  FirmwareVersion?: string;
  SerialNumber?:  string;
  SupportSunapi:  boolean;
  SupportOnvif:   boolean;
  SupportPTZ?:    boolean;
  rtspUrl?:       string;
  profiles?:      OnvifProfile[];
  URL?:           string;           // DDNS URL
}

interface OnvifProfile {
  token:     string;
  name:      string;
  encoding:  string;    // "H264" | "H265" | "MJPEG"
  width:     number;
  height:    number;
  fps:       number;
  rtspUrl:   string;
}
```

---

## 10. Constraints & Assumptions

| ID | Constraint / Assumption |
|---|---|
| C-01 | The server host must have `SO_BROADCAST` permission on its UDP socket (Linux root or `CAP_NET_BROADCAST`) |
| C-02 | The server must be on the same LAN subnet as the cameras; broadcast/multicast is not routed |
| C-03 | The `UDPDiscovery` class is sourced from `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js` and is loaded via `getUDPDiscovery()` |
| C-04 | mDNS discovery is explicitly out of scope for this version |
| C-05 | ONVIF credential prompting (UsernameToken injection) is handled by the UI flow after discovery, not by `ONVIFDiscovery` |
| C-06 | ONVIF enrichment calls use no authentication; cameras with mandatory auth will return partial data |
| C-07 | The registry is in-memory only; discovered devices do not persist across server restarts |
| C-08 | `DiscoveryService` is a singleton; `getDiscoveryService(io)` returns the same instance across calls |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — SRS for Camera Discovery |
