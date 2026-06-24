# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Camera Discovery & Network Search Subsystem

| | |
|---|---|
| **Document ID** | PRD-LTS-003 |
| **Version** | 1.1 |
| **Status** | Draft |
| **Date** | 2026-05-21 |
| **Related RFP** | RFP_Camera_Discovery.md |

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Functional Specification](#4-functional-specification)
5. [Technical Requirements](#5-technical-requirements)
6. [API / Interface Contract](#6-api--interface-contract)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Milestones & TODO](#8-milestones--todo)

---

## 1. Product Vision

Automatically locate all IP cameras on the local network — using both Hanwha/WiseNet proprietary UDP discovery and the standard ONVIF WS-Discovery protocol — and present them to the operator in real time through the dashboard, enabling a single-click path from network scan to active monitoring pipeline.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- **G1**: Run WiseNet proprietary UDP broadcast discovery (port 7701/7711) as a continuously repeating background scan.
- **G2**: Run ONVIF WS-Discovery multicast probe (239.255.255.250:3702) concurrently with the WiseNet scan.
- **G3**: Deduplicate discovered cameras by MAC address across both mechanisms and persist the registry across scan cycles.
- **G4**: Push newly discovered cameras to all connected dashboard clients in real time via Socket.IO.
- **G5**: Retrieve RTSP stream URLs and device metadata (manufacturer, model, firmware, profiles) for all discovered cameras.
- **G6**: Support operator-triggered rescan and provide scan status (scanning/idle/device count) to the UI.

### 2.2 Non-Goals

- **NG1**: mDNS-based camera discovery — listed as a future consideration only.
- **NG2**: Discovery over WAN or non-local subnets — broadcast/multicast is LAN-scoped only.
- **NG3**: Automated camera credential management beyond configurable presets — operators must supply credentials manually for secured ONVIF devices.
- **NG4**: Active PTZ control via the discovery subsystem — PTZ capability is detected but not exercised during discovery.

---

## 3. User Personas

### Persona 1 — Security Operator / Installer
Sets up the system on a new site. Needs to scan the network, see all cameras listed automatically within seconds, and add them to the monitoring pipeline without manually entering IP addresses.

### Persona 2 — Security Administrator
Reviews discovered cameras, selects appropriate RTSP profiles (main vs. sub stream), and manages access credentials for ONVIF-secured devices.

### Persona 3 — System Integrator / Developer
Integrates the discovery subsystem into a larger camera management workflow. Needs reliable REST and Socket.IO APIs with a normalized device data model regardless of discovery source.

---

## 4. Functional Specification

### 4.1 WiseNet UDP Discovery

- Send a fixed 160-byte magic packet to UDP broadcast address 255.255.255.255 on port 7701.
- Listen for camera responses on UDP port 7711.
- Parse binary-encoded response records containing IP address, MAC address, HTTP/HTTPS ports, device name, firmware version, SUNAPI support flag, and DDNS URL.
- Extended-format responses (length ≥ 261 bytes) additionally include device alias, model type, and HTTPS port.
- Run continuously: 8-second scan window followed by a 2-second pause, repeating indefinitely.

### 4.2 ONVIF WS-Discovery

- Send a SOAP 1.2 / XML Probe message to UDP multicast 239.255.255.250:3702.
- Probe type: `dn:NetworkVideoTransmitter`.
- On receiving a `ProbeMatch`, extract the device XAddr (service endpoint URL).
- Perform secondary ONVIF service calls:
  - `GetDeviceInformation` — manufacturer, model, firmware, serial number.
  - `GetNetworkInterfaces` — MAC address.
  - `GetProfiles` + `GetStreamUri` — available stream profiles and RTSP URLs per profile.
  - `GetNodes` (PTZ service, optional) — PTZ capability flag.
- Default profile selection: lowest-resolution profile (width ≤ 640 preferred) for AI analysis efficiency.
- Allow operator to select an alternate profile before adding the camera.
- Credential handling: attempt unauthenticated probe first; prompt for credentials before device service calls; support configurable manufacturer presets; never log credentials.

### 4.3 Unified Device Registry

- Merge results from both mechanisms into a single in-memory Map keyed by MAC address.
- Deduplication: if the same MAC is found by both WiseNet UDP and ONVIF, merge fields and set `source: 'both'`.
- Registry persists across scan cycles; entries are updated (not removed) on re-discovery.
- A newly connected dashboard client receives all currently-known devices immediately (hydration on connect).

### 4.4 Real-Time Push

- Emit `discovery:result` Socket.IO event for each new or updated device.
- Emit `discovery:scanning` on scan state changes (start/stop).
- Emit `discovery:cleared` when the registry is cleared on rescan.
- Emit `discovery:error` for non-fatal scan errors.

### 4.5 Scan Control

- Operator may trigger a rescan (clears registry and restarts both mechanisms simultaneously).
- Manual start/stop available via both REST API and Socket.IO event.
- Discovery service handles socket/network errors gracefully and retries automatically.

### 4.6 Camera Registration

- Operator may select a discovered camera from the dashboard panel and add it to the monitoring pipeline with a single action.
- Credential input is required for ONVIF-secured devices before registration.
- RTSP URL is pre-filled from discovery data; operator may override.

---

## 5. Technical Requirements

### 5.1 Runtime & Stack

| Component | Technology |
|---|---|
| Server runtime | Node.js |
| WiseNet UDP driver | `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js` |
| ONVIF client | `node-onvif` (npm) or custom SOAP/UDP client |
| Discovery orchestrator | `server/src/services/discoveryService.js` |
| Real-time push | Socket.IO |
| UI panel | `client/src/components/DiscoveredCameraPanel.tsx` |
| Client state | `client/src/stores/discoveryStore.ts` |

### 5.2 Non-Functional Requirements

| Category | Requirement |
|---|---|
| Latency | First camera visible in dashboard within 2 s of scan start |
| Compatibility | ONVIF Core 2.0 and above; tested against Axis, Hikvision, Dahua, Hanwha, Bosch |
| Network impact | Total broadcast/multicast traffic < 5 KB per scan cycle |
| Reliability | Automatic recovery from socket errors; no manual restart required |
| Security | Credentials never logged; ONVIF WS-Security (UsernameToken) supported |
| Scalability | Handle up to 256 discovered devices without UI degradation |
| Platform | Linux (primary); sockets require `SO_BROADCAST` and multicast join permissions |

### 5.3 Discovery Packet Specifications

| Mechanism | Transport | Send Target | Send Port | Receive Port | Timeout |
|---|---|---|---|---|---|
| WiseNet UDP | UDP IPv4 | 255.255.255.255 (broadcast) | 7701 | 7711 | 8 s |
| ONVIF WS-Discovery | UDP IPv4 | 239.255.255.250 (multicast) | 3702 | 3702 | 8 s |

---

## 6. API / Interface Contract

### 6.1 REST API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/discovery/start` | Start discovery (if not running) |
| `POST` | `/api/discovery/stop` | Stop all discovery |
| `POST` | `/api/discovery/rescan` | Clear registry and restart scan |
| `GET` | `/api/discovery/devices` | Return all currently-known devices |
| `GET` | `/api/discovery/status` | Return `{ scanning, count, mechanisms[] }` |

### 6.2 Socket.IO Events (Server → Client)

| Event | Payload | Description |
|---|---|---|
| `discovery:result` | `{ device: DeviceInfo }` | New or updated camera found |
| `discovery:scanning` | `{ scanning: boolean, count: number }` | Scan state change |
| `discovery:cleared` | `{}` | Registry cleared on rescan |
| `discovery:error` | `{ message: string }` | Non-fatal scan error |

### 6.3 Socket.IO Events (Client → Server)

| Event | Description |
|---|---|
| `discovery:rescan` | Trigger rescan |
| `discovery:stop` | Stop scanning |

### 6.4 DeviceInfo Data Model

```typescript
interface DeviceInfo {
  id:             string;              // "{MAC}_{IP}"
  source:         'udp' | 'onvif' | 'both';
  IPAddress:      string;
  MACAddress:     string;              // uppercase, colon-separated
  Port:           number;
  HttpPort:       number;
  HttpsPort:      number;
  HttpType:       boolean;             // true = HTTPS only
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
  URL?:           string;              // DDNS URL
}

interface OnvifProfile {
  token:     string;
  name:      string;
  encoding:  string;   // "H264" | "H265" | "MJPEG"
  width:     number;
  height:    number;
  frameRate: number;
  rtspUrl:   string;
}
```

---

## 7. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-01 | At least one WiseNet/Hanwha camera on the LAN is discovered and displayed in the dashboard within 10 seconds of scan start. |
| AC-02 | The same camera found by both UDP and ONVIF appears as a single entry in the device list (MAC-based deduplication). |
| AC-03 | A newly connected browser client receives all already-discovered devices within 1 second of connecting (hydration). |
| AC-04 | Triggering a rescan clears the device list in the UI and repopulates it as cameras are rediscovered. |
| AC-05 | ONVIF-discovered cameras include at least one RTSP profile URL populated from `GetStreamUri`. |
| AC-06 | ONVIF credential prompt appears before device service calls; credentials are not written to server logs. |
| AC-07 | `GET /api/discovery/devices` returns all currently-known devices with normalized `DeviceInfo` schema. |
| AC-08 | `GET /api/discovery/status` returns correct `scanning` state and device `count`. |
| AC-09 | Network broadcast/multicast traffic does not exceed 5 KB per scan cycle. |
| AC-10 | Discovery service recovers automatically from a socket error without requiring a server restart. |

---

## 8. Milestones & TODO

### 8.1 Milestone Progress

| Milestone | Description | Target | Completed | Status |
|---|---|---|---|---|
| M1 | WiseNet UDP discovery core + Socket.IO real-time push | TBD | May 2026 | ✅ Done |
| M2 | Dashboard panel UI + discoveryStore + add-to-pipeline action | TBD | May 2026 | ✅ Done |
| M3 | ONVIF WS-Discovery UDP probe sender + SOAP client | TBD | - | ⏳ Pending |
| M4 | ONVIF `GetDeviceInformation` + `GetProfiles` + `GetStreamUri` | TBD | - | ⏳ Pending |
| M5 | Merge ONVIF into DiscoveryService + MAC deduplication | TBD | - | ⏳ Pending |
| M6 | Credential prompt UI + ONVIF profile selection UI | TBD | - | ⏳ Pending |

### 8.2 TODO

- [ ] Implement `server/src/services/onvifDiscovery.js` — ONVIF WS-Discovery UDP probe sender
- [ ] Implement `server/src/services/onvifClient.js` — ONVIF SOAP client for device service calls
- [ ] Implement `GetDeviceInformation` ONVIF call (manufacturer, model, firmware, serial)
- [ ] Implement `GetProfiles` + `GetStreamUri` ONVIF calls (RTSP URL enumeration)
- [ ] Merge ONVIF discovery results into `DiscoveryService` with MAC-based deduplication
- [ ] Add credential input prompt to `DiscoveredCameraPanel.tsx` for ONVIF-secured devices
- [ ] Add RTSP profile selection UI before camera registration
- [ ] Implement camera subnet filter (by manufacturer, model, or IP subnet)
- [ ] Write integration tests for WiseNet UDP parsing against captured real-device response packets
- [ ] Write integration tests for ONVIF SOAP probe/response round-trip (mock camera or test device)
- [ ] Validate compatibility against Axis, Hikvision, Dahua, and Bosch ONVIF devices

---

## 9. NVR Multi-Channel Support

### 9.1 Problem Statement

WiseNet NVR devices (Network Video Recorders) contain multiple physical camera channels under a single IP address. Prior to this feature, the system treated every discovered device as a single-channel camera, making it impossible to add individual NVR channels to the monitoring pipeline.

### 9.2 Product Goals

| Goal | Metric |
|---|---|
| Correct channel count | `MaxChannel` ≥ 2 for any NVR device discovered on the LAN |
| UI clarity | Channel count badge visible on all NVR cards in the discovery list |
| Zero-friction add | Operator can select a channel and add it in ≤ 3 clicks |
| RTSP correctness | Each channel produces a valid, distinct RTSP URL |
| Channel override | Operator can manually set channel count when auto-detection fails |
| SUNAPI auth | `RTSP_DEFAULT_USERNAME`/`PASSWORD` env vars used for SUNAPI MaxChannel query |
| channelIndex persistence | Selected channel index stored in camera record |

### 9.3 User Stories

| Story | Acceptance Criterion |
|---|---|
| As an operator, I want to see how many channels an NVR has at a glance | `MaxChannel` badge (e.g., `4CH`) visible on the discovery card |
| As an operator, I want to select a specific NVR channel to monitor | Channel selection grid visible in the detail panel when MaxChannel > 1 |
| As an operator, I want the correct RTSP URL auto-populated for each channel | RTSP URL changes when a different channel button is clicked |
| As an operator, I want the camera name to reflect the channel I added | Camera added as `"{Model} Ch{N}"` in the camera list |
| As an operator, I want to manually specify channel count when auto-detection fails | Channels number input always visible in detail panel; adjustable from 1 to 64 (or SUNAPI MaxChannel limit) |
| As an installer, I want the system to use site credentials to get accurate channel count | SUNAPI MaxChannel query sends HTTP Basic auth from `RTSP_DEFAULT_USERNAME`/`PASSWORD` |
| As an operator, I want to know which channel I added | `channelIndex` stored in camera record; retrievable via `GET /api/cameras/:id` |

### 9.4 Out of Scope

- Bulk-adding all NVR channels at once (add one at a time)
- Real-time NVR channel status (connected / disconnected per channel)
- ONVIF Digest auth for GetProfiles during discovery (post-add credential flow only)

### 9.5 Technical Approach

| Layer | Implementation |
|---|---|
| ONVIF enrichment | `enrichDevice()` counts distinct `SourceToken` values → `MaxChannel` |
| SUNAPI with auth | `querySunapiMaxChannel()` — HTTP Basic auth from `RTSP_DEFAULT_USERNAME`/`PASSWORD` env vars; 2 s timeout |
| Merge rule | `mergeDevices()` takes `max(existing.MaxChannel, incoming.MaxChannel)` |
| UI card badge | `{MaxChannel}CH` amber badge when `MaxChannel > 1` |
| Channel panel | `channelIndex`-based profile lookup; `channelRtspUrl()` fallback |
| Channel count input | Number input in detail panel; `max = camera.MaxChannel` when SUNAPI MaxChannel known; otherwise `max = 64` |
| channelIndex storage | `POST /api/cameras` body includes `channelIndex`; stored in DB camera record |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Camera Discovery |
| 1.1 | 2026-06-23 | LTS Engineering Team | §9 추가 — NVR MaxChannel 다중 채널 제품 요구사항, 사용자 스토리, 기술 접근법 |
| 1.2 | 2026-06-24 | LTS Engineering Team | §9 업데이트 — SUNAPI env 인증, 수동 채널 수 오버라이드, SUNAPI MaxChannel 상한 적용, channelIndex DB 저장 |
