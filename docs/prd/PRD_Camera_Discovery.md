# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Camera Discovery & Network Search Subsystem

| | |
|---|---|
| **Document ID** | PRD-LTS-003 |
| **Version** | 1.6 |
| **Status** | Draft |
| **Date** | 2026-07-03 |
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

### 9.6 RTSP URL Resolution Accuracy (2026-07-02)

**Problem statement**: §9.5's `channelRtspUrl()` fallback only recognized the `/profileN/` path convention. A survey of this deployment's own camera records found that convention covers only one device out of six surveyed — the rest use `/<channel 0-based>/H.264/media.smp` — so channel-switching silently failed (returned the unchanged URL) for the majority of real NVR/multi-channel cameras on this network.

| Goal | Metric |
|---|---|
| Correct URL for either convention | Channel switch produces a distinct, valid RTSP URL regardless of whether the camera uses `/profileN/` or `/N/H.264/` |
| Accurate default port | A fresh (not-yet-added) SUNAPI device's default URL uses the CGI-confirmed RTSP port when credentials are available, not a blind 554 guess |
| Protocol transparency | Operator can see whether SUNAPI or ONVIF (or neither) resolved a given channel's URL |

| Story | Acceptance Criterion |
|---|---|
| As an operator, I want channel switching to work on the NVR models actually deployed here, not just one vendor convention | Selecting CH 2 on a `/N/H.264/`-style camera updates the RTSP URL correctly, same as it already did for `/profileN/`-style cameras |
| As an installer, I want the detected RTSP port to reflect what the camera is actually configured with | Re-detect against a device with credentials shows the CGI-confirmed port, not always 554 |
| As an operator troubleshooting a channel mismatch, I want to see both protocols' answers | Edit/Found panels show a SUNAPI URL row and an ONVIF URL row separately |

| Layer | Implementation |
|---|---|
| Dual-pattern substitution | `channelRtspUrl()` detects `/profileN/` vs `/N/H.264/` and substitutes within whichever shape the base URL already uses |
| Default URL synthesis | `defaultSunapiRtspUrl(ip, rtspPort, channel)` — used when no base URL is known at all |
| RTSP port confirmation | `querySunapiRtspPort()` — `GET /stw-cgi/network.cgi?msubmenu=portconf&action=view`, plain `key=value` response, falls back to 554 |
| Protocol-tagged display | `probe-channels` response `sunapiProfiles`/`onvifProfiles`; rendered as separate rows in `DiscoveredCameraPanel.tsx`/`CameraEditModal.tsx` |

### 9.7 UDP Discovery Fallback Protocol Parity (2026-07-02)

**Problem statement**: discovery has two UDP implementations — a git submodule and a self-contained fallback for when it isn't initialised. The fallback was, in practice, non-functional for its actual purpose: it parsed responses as ONVIF XML while listening on WiseNet's own ports, so a deployment that never ran `git submodule update --init` silently discovered zero SUNAPI/WiseNet cameras — no error, just an empty result indistinguishable from "no cameras on the LAN."

| Goal | Metric |
|---|---|
| Fallback actually works | `UDPDiscoveryFallback` alone (no submodule) discovers the same cameras the submodule does |
| No silent capability loss | Missing the submodule degrades gracefully (a startup log warning already existed) rather than silently losing an entire discovery protocol |

| Story | Acceptance Criterion |
|---|---|
| As an operator on a fresh checkout without submodules initialised, I want camera discovery to still work | UDP broadcast discovery finds SUNAPI cameras identically whether or not the submodule is present |

| Layer | Implementation |
|---|---|
| Real binary parser | `UDPDiscoveryFallback._parseResponse()` (`server/src/utils/udpDiscovery.js`) now implements SUNAPI IP Installer spec §3.4.2 byte-for-byte, matching the submodule (including the FR-CAM-081 bounds-check fix) |
| Verified parity | `test/api/nvr_channel_discovery.test.js` TC-H-028/029 — identical field output for the same captured bytes; live run discovered all cameras on this network's actual subnet |

### 9.8 Correct Field Offsets + Mode-Aware Response Parsing (2026-07-03)

**Problem statement**: a customer review comparing the parser directly against the vendor's own Annex A C structs found two issues. First, a genuine field-offset bug — the parser's `noPassword` read actually captured the byte belonging to the preceding `supported_protocol` field, and the true trailing `no_password` byte was never read. Second, a design gap — whether the parser attempted to read the "extended" block of fields (device alias, model type, etc.) was decided purely by how many bytes were left in the packet, not by the response's own declared mode (`nMode`) as the vendor spec actually documents. This worked by coincidence for every device on this network today, but wasn't correct per spec, and left the door open to misreading a different, unrelated response type (the protocol also defines password-reset and factory-key-exchange response modes sharing the same UDP ports) as if it were a camera.

| Goal | Metric |
|---|---|
| Correct field extraction | `supported_protocol` and `no_password` are each read from their own correct position, never one substituting for the other |
| Spec-correct parsing | Whether the extended field block is read is decided by the response's declared mode, matching the vendor's documented behavior exactly |
| No cross-talk with unrelated response types | A response belonging to a different exchange (e.g. password/key-exchange) is recognized and skipped, never misread as a camera |

| Story | Acceptance Criterion |
|---|---|
| As an operator, I want the "Type"/protocol-support info discovery shows to reflect what the camera actually reported, not misaligned bytes | `SupportedProtocol` reflects the camera's actual reported value, verified against a byte-exact test fixture with distinct sentinel values in each field |
| As a developer extending this parser later, I want response-type handling to be explicit, not inferred from length | The parser recognizes every response mode value the vendor spec defines and only applies the camera-scan field layout to modes that are actually camera-scan responses |

| Layer | Implementation |
|---|---|
| Offset fix | `_parseResponse()` now reads `supportedProtocol` and `noPassword` as two distinct fields, in the vendor spec's documented order |
| Mode-aware dispatch | The parser now checks the response's declared mode before deciding whether to read the extended field block, and skips entirely any response mode belonging to a different (non-camera-scan) exchange |
| Verified parity | `test/api/nvr_channel_discovery.test.js` TC-H-030~034 — both the submodule and the self-contained fallback parser apply the identical logic and produce identical results |

### 9.9 Struct Correction, Request Opcode Switch, Fallback Retirement, RTSP Port Fix (2026-07-03)

**Problem statement**: further Annex A cross-checking (§9.8) found the shared struct also omitted two 1-byte reserved fields, shifting every field after `chDeviceName` by one byte. Separately, an architecture review retired §9.7's inline fallback in favor of a proper npm dependency (same code, installed a second way — no more independently-maintained duplicate), switched the request opcode to the vendor-documented value, and fixed two field-misuse bugs (RTSP port synthesis, Digest-auth detection) found along the way.

| Goal | Metric |
|---|---|
| Correct struct layout | Every field decodes identically between implementations on both a real captured packet and live network traffic (100+ devices) |
| No duplicate maintenance burden | `server/src/utils/udpDiscovery.js` contains no independent protocol implementation — one shared source (submodule/npm package), not two that can drift |
| Correct RTSP port default | Discovery never presents a non-RTSP port (VNP-only `nTcpPort`, or the HTTPS web port `nPort`) as if it were the camera's RTSP port |

| Story | Acceptance Criterion |
|---|---|
| As an operator who forgot `git submodule update --init`, I want discovery to still work | `npm install` alone (already part of every setup) installs `wisenet-chrome-ip-installer`, no extra step to remember |
| As an operator, I want the "RTSP Port" shown in the Found/Edit panels to actually be an RTSP port | `camera.Port` defaults to SUNAPI's standard `554`, never a VNP-only or HTTP-web port value |

| Layer | Implementation |
|---|---|
| Struct fix | `protocol.js`'s `FIELDS` gains Annex A's `reserved2`/`reserved3` (334 bytes total, not 332) |
| Opcode switch | `_sendDiscovery()` sends `nMode=6` (`DEF_REQ_SCAN_EXT`) by default; the prior `nMode=1` packet is kept, commented out, as a one-line rollback |
| Fallback retirement | `server/src/utils/udpDiscovery.js` re-exports the submodule or the new `wisenet-chrome-ip-installer` npm `optionalDependencies` package — no independent implementation remains |
| RTSP port fix | `_parseResponse()`/`mapUDPDevice()` no longer read `nTcpPort`/`nPort` for the RTSP port; both default to `554` |
| Verified | `test/api/nvr_channel_discovery.test.js` TC-H-028/029/032/034 (renamed for the new architecture) and new TC-H-035/036; live discovery against 100+ real devices |

---

## Document History

| Version | Date | Author | Description |
|---|---|---|---|
| 1.0 | 2026-05-28 | LTS Engineering Team | Initial release — PRD for Camera Discovery |
| 1.1 | 2026-06-23 | LTS Engineering Team | §9 추가 — NVR MaxChannel 다중 채널 제품 요구사항, 사용자 스토리, 기술 접근법 |
| 1.2 | 2026-06-24 | LTS Engineering Team | §9 업데이트 — SUNAPI env 인증, 수동 채널 수 오버라이드, SUNAPI MaxChannel 상한 적용, channelIndex DB 저장 |
| 1.3 | 2026-07-02 | LTS Engineering Team | §9.6 신규 추가 — RTSP URL 컨벤션 이중화(`/profileN/`+`/N/H.264/`), RTSP 포트 CGI 확인, 프로토콜별 URL 구분 표시. 헤더 Version을 이력 표 최신값과 일치하도록 정정(1.1→1.2 누락 반영) |
| 1.4 | 2026-07-02 | LTS Engineering Team | §9.7 신규 추가 — UDP Discovery 인라인 폴백이 ONVIF XML만 파싱해 서브모듈 미초기화 시 SUNAPI 카메라를 전혀 못 찾던 결함을 실제 WiseNet 바이너리 파서 구현으로 수정, 서브모듈과의 parity 검증 |
| 1.5 | 2026-07-03 | LTS Engineering Team | §9.8 신규 추가 — 고객이 발견한 `supported_protocol`/`no_password` 필드 오프셋 버그 수정, 확장 필드 블록 파싱을 패킷 길이가 아닌 응답의 선언된 모드(nMode) 기반으로 전환, 카메라 스캔과 무관한 응답 타입을 인식해 건너뛰도록 개선 |
| 1.6 | 2026-07-03 | LTS Engineering Team | §9.9 신규 추가 — `reserved2`/`reserved3` 구조체 반영(334바이트), 요청 옵코드 `nMode=6` 기본 전환, §9.7 인라인 폴백을 npm 패키지 설치 경로로 완전 대체(중복 유지 부담 해소), RTSP URL이 `nTcpPort`/`nPort`를 오용하던 버그 수정(554 고정) |
