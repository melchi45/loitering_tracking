# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Camera Discovery & Network Search Subsystem

| | |
|---|---|
| **Document ID** | SRS-LTS-CAM-01 |
| **Version** | 1.6 |
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

## 7b. Functional Requirements — NVR Multi-Channel (MaxChannel)

### FR-CAM-060 — SourceToken-Based MaxChannel

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-060 |
| **Title** | ONVIF SourceToken 기반 MaxChannel 판별 |
| **Priority** | Must-Have |

The system **shall** determine `MaxChannel` by counting the number of distinct `VideoSourceConfiguration/SourceToken` values in the ONVIF `GetProfiles` response. Using `profiles.length` is explicitly prohibited because single-channel cameras expose multiple stream profiles (main/sub) from the same physical input.

```
MaxChannel = |{unique SourceToken values across all profiles}|
```

If no `SourceToken` is present in the response (non-conformant ONVIF device), `MaxChannel` defaults to `1`.

---

### FR-CAM-061 — channelIndex Assignment

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-061 |
| **Title** | 프로필별 channelIndex 부여 |
| **Priority** | Must-Have |

Each ONVIF profile **shall** be annotated with a `channelIndex` (1-based integer) representing the physical input it belongs to. The index is assigned in insertion order of first-encountered `SourceToken`. Profiles sharing the same `SourceToken` receive the same `channelIndex`.

---

### FR-CAM-062 — SUNAPI MaxChannel Query

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-062 |
| **Title** | SUNAPI 채널 수 best-effort 쿼리 |
| **Priority** | Should-Have |

When a UDP-discovered device has `SupportSunapi = true`, the system **shall** attempt an HTTP GET to retrieve `MaxChannel` (2026-07-02: corrected to the actual SUNAPI capability endpoint — `system.cgi`/`systeminfo` and `media.cgi`/`channellist` are not real SUNAPI CGI paths and never returned data; see FR-CAM-062a):

1. `GET /stw-cgi/attributes.cgi/attributes` → XML response, `<group name="System"><category name="Limit"><attribute name="MaxChannel" type="int" value="N"/></category></group>` → parse the `value` attribute at that group/category/attribute path (matches the vendor SUNAPI IP Installer's own query path, `System/Limit/MaxChannel`)

Rules:
- Timeout: 2 000 ms
- Auth failure (HTTP 401/403): resolve `0` immediately (no retry)
- Network error / XML parse error / attribute not found: resolve `0`
- If the endpoint returns `0`, `MaxChannel` stays `1`

### FR-CAM-062a — Endpoint Correction (2026-07-02)

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-062a |
| **Title** | SUNAPI MaxChannel 쿼리 엔드포인트 정정 |
| **Priority** | Must-Have |

The endpoints originally specified for FR-CAM-062 (`/stw-cgi/media.cgi?msubmenu=channellist&action=view` and `/stw-cgi/system.cgi?msubmenu=systeminfo&action=view`) do not exist in the real SUNAPI CGI surface and were never validated against an actual device — they always returned `404`/connection errors, meaning `querySunapiMaxChannel()` never successfully resolved a `MaxChannel > 1` in practice regardless of credentials. The correct capability endpoint is `GET /stw-cgi/attributes.cgi/attributes`, confirmed against the vendor's own WiseNet IP Installer client (`submodules/WiseNetChromeIPInstaller/media/ump/Network/http/attributes.js`, which queries the identical `System/Limit/MaxChannel` attribute path from the same endpoint). The response is XML (`Content-Type: application/xml`), not JSON — the system **shall** parse it with the `<group>/<category>/<attribute value="...">` structure, not `JSON.parse()`.

---

### FR-CAM-063 — MaxChannel Merge Rule

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-063 |
| **Title** | MaxChannel 병합 규칙 |
| **Priority** | Must-Have |

`mergeDevices()` **shall** set `merged.MaxChannel = Math.max(existing.MaxChannel || 1, incoming.MaxChannel || 1)`. The larger value always wins, ensuring ONVIF and SUNAPI enrichment results are not lost on cross-protocol merge.

---

### FR-CAM-064 — Discovery Card MaxChannel Badge

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-064 |
| **Title** | 탐색 목록 카드 MaxChannel 배지 |
| **Priority** | Must-Have |

When `MaxChannel > 1`, the device card in the CAMERAS panel Found tab **shall** display an amber `{MaxChannel}CH` badge in the top-right badge area of the card, above the SUNAPI/ONVIF protocol badges.

---

### FR-CAM-065 — Channel Selection Panel

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-065 |
| **Title** | 채널 선택 패널 |
| **Priority** | Must-Have |

When a device with `MaxChannel > 1` is opened in `DiscoveredCameraPanel`:

a. A **Channel Selection** section **shall** appear with `MaxChannel` buttons labeled `CH 1` … `CH N`.  
b. Channels with a valid ONVIF RTSP URL **shall** show a green `●` indicator.  
c. Clicking a channel button **shall** update the displayed RTSP URL and the `+Add` button label.  
d. Default selected channel **shall** be `1`.

---

### FR-CAM-066 — Channel RTSP URL Resolution

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-066 |
| **Title** | 채널별 RTSP URL 생성 |
| **Priority** | Must-Have |

The RTSP URL for channel `N` **shall** be resolved in priority order:

1. First ONVIF profile where `channelIndex === N` and `rtspUrl` is non-empty
2. Profile at array index `N-1` (legacy fallback, no `channelIndex` set)
3. `channelRtspUrl(camera.rtspUrl, N)` — replaces `/profile{M}/` with `/profile{N}/` in the base URL

---

### FR-CAM-067 — Channel Camera Name

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-067 |
| **Title** | 채널 추가 시 카메라 이름 |
| **Priority** | Must-Have |

When `MaxChannel > 1` and the operator adds channel `N`, the camera name sent to `POST /api/cameras` **shall** be `"{camera.Model || camera.IPAddress} Ch{N}"`. When `MaxChannel === 1`, the original model/IP name is used unchanged.

---

### FR-CAM-068 — SUNAPI MaxChannel Query with Default Credentials

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-068 |
| **Title** | SUNAPI MaxChannel 쿼리 — env 기본 인증 |
| **Priority** | Should-Have |

`querySunapiMaxChannel()` **shall** include HTTP Basic Authorization header when `RTSP_DEFAULT_USERNAME` and `RTSP_DEFAULT_PASSWORD` env vars are both non-empty. The Authorization value **shall** be `"Basic " + base64("{username}:{password}")`. The function signature **shall** default to env var values so all existing call sites automatically benefit. **Superseded in part by FR-CAM-072 (2026-07-02)**: a `401`/`403` whose `WWW-Authenticate` header advertises `Digest` **shall** trigger one authenticated retry per FR-CAM-072 rather than resolving `0` immediately; a challenge that is `Basic` (or that still 401s after the Digest retry) resolves `0`/falls back to `1` exactly as originally specified here.

---

### FR-CAM-069 — Manual Channel Count Override

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-069 |
| **Title** | 수동 채널 수 오버라이드 |
| **Priority** | Should-Have |

The `DiscoveredCameraPanel` detail panel **shall** display a number input labelled "Channels" that is always visible (not conditional on MaxChannel). The input **shall**:

a. Default to `camera.MaxChannel ?? 1` on mount.  
b. Accept integer values from `1` to `channelCountMax` (see FR-CAM-071).  
c. Clamp entered values to `[1, channelCountMax]` on change.  
d. Reset `selectedChannel` to `1` whenever the channel count is changed.

---

### FR-CAM-070 — channelIndex Persistence in Camera Record

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-070 |
| **Title** | channelIndex 카메라 레코드 저장 |
| **Priority** | Must-Have |

a. `POST /api/cameras` **shall** accept an optional `channelIndex` integer in the request body.  
b. When `channelIndex` is provided, it **shall** be stored in the camera DB record as an integer.  
c. When `MaxChannel > 1` and the operator adds a channel, the client **shall** send `channelIndex = selectedChannel`.  
d. When `MaxChannel === 1`, `channelIndex` **shall** be omitted (stored as `null`).

---

### FR-CAM-071 — Channel Count Input Limit from SUNAPI MaxChannel

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-071 |
| **Title** | SUNAPI MaxChannel 상한 적용 |
| **Priority** | Should-Have |

The `channelCountMax` for the channel count input **shall** be computed as follows:

```
channelCountMax =
  camera.SupportSunapi === true AND camera.MaxChannel > 1
    ? camera.MaxChannel   // SUNAPI MaxChannel is authoritative; cap to known count
    : 64                  // No SUNAPI MaxChannel available; allow liberal manual entry
```

The HTML `<input max>` attribute and the `onChange` clamp **shall** both enforce this limit. When the cap is derived from SUNAPI, the input's tooltip **shall** state `"max {N} from SUNAPI"`.

---

### FR-CAM-072 — SUNAPI MaxChannel Query SHALL retry with HTTP Digest auth when challenged for it (2026-07-02)

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-072 |
| **Title** | SUNAPI MaxChannel 쿼리 — Digest 인증 재시도 |
| **Priority** | Must-Have |

When `querySunapiMaxChannel()`'s Basic-authenticated (or unauthenticated, per FR-CAM-068) request receives a `401`/`403` whose `WWW-Authenticate` response header advertises the `Digest` scheme, and `username`+`password` are both available, the function **shall** compute an RFC 7616 Digest `Authorization` header (MD5, `qop=auth` when offered by the challenge) and retry the request exactly once before falling back to `0`/`1`. A challenge that is `Basic` (not `Digest`), or a Digest retry that itself still 401s, **shall** be treated as a genuine authentication failure — unchanged from FR-CAM-068.

**Rationale**: a real device (SUNAPI web UI fronted by nginx, observed IP 192.168.214.32) advertises `WWW-Authenticate: Digest qop="auth", realm="iPolis_..."` and rejects Basic auth unconditionally — regardless of whether the password is correct. Prior to this requirement, every such device was indistinguishable from a genuinely-misconfigured camera in every SUNAPI-dependent flow (`POST /api/cameras/probe-channels`, `Design_Channel_Slot.md` FR-CH-064/FR-CH-040a's credential-gated paths), always reporting single-channel/auth-rejected even with correct credentials. Independently verified with `curl --digest -u admin:<password> http://<ip>/stw-cgi/attributes.cgi/attributes` → `HTTP 200`, confirming the credentials themselves were valid and the scheme was the only blocker.

**Acceptance**: See `docs/tc/TC_Channel_Slot.md` TC-CH-F-012/F-012b (`querySunapiMaxChannel()` exercised via `POST /api/cameras/probe-channels`, since this function is shared across both feature areas — see `docs/design/Design_Channel_Slot.md` §4.6g for the implementation).

---

### FR-CAM-073 — SUNAPI MaxChannel Query over HTTPS SHALL NOT reject a self-signed certificate (2026-07-02)

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-073 |
| **Title** | SUNAPI MaxChannel 쿼리 — HTTPS 자체 서명 인증서 허용 |
| **Priority** | Must-Have |

When `querySunapiMaxChannel()` queries a camera whose SUNAPI web UI is HTTPS-only (`httpType` true, or the plain-HTTP endpoint redirects to HTTPS), the underlying TLS connection **shall not** reject the server's certificate solely because it is self-signed/untrusted by the system CA store (`rejectUnauthorized: false`) — consistent with `onvifDiscovery.js`'s existing HTTPS SOAP client, which already sets this for the identical reason (on-prem IP cameras/NVRs overwhelmingly ship with self-signed certificates, not certificates from a publicly-trusted CA). This does not weaken authentication — FR-CAM-068/FR-CAM-072's Basic/Digest credential checks still apply on top of the TLS connection; it only affects transport-layer certificate trust.

**Rationale**: found while verifying FR-CAM-072 against a second real camera (192.168.214.37, HTTP:80 redirects to HTTPS:443) — the query failed with `self-signed certificate` before even reaching the HTTP auth layer, using Node's default TLS validation. `onvifDiscovery.js`'s own HTTPS client already carried `rejectUnauthorized: false` for this same class of device; `querySunapiMaxChannel()` had simply never had the equivalent option added.

**Acceptance**: Querying a mock HTTPS SUNAPI endpoint presenting a self-signed certificate, with correct Basic or Digest credentials, **shall** return the reported `MaxChannel` value rather than failing with a TLS certificate error. Verified live against 192.168.214.37: `HTTP 200` with the device's actual reported `MaxChannel` after the fix (previously `connection error: self-signed certificate`, failing before the value could even be read).

---

### FR-CAM-074 — On-demand ONVIF probe SHALL try both HTTP and HTTPS schemes (2026-07-02)

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-074 |
| **Title** | 온디맨드 ONVIF probe — HTTP/HTTPS 동시 시도 |
| **Priority** | Must-Have |

`POST /api/cameras/probe-channels` (§ Channel Slot feature, `docs/design/Design_Channel_Slot.md` §4.6) has no WS-Discovery-asserted XAddr to work from for a fresh, not-yet-scanned IP — it must guess the ONVIF `device_service` URL's scheme. The system **shall** attempt this guessed URL on both `http://{ip}:{onvifPort}` (default port 80) and `https://{ip}:{onvifHttpsPort}` (default port 443) **in parallel**, and use whichever scheme's result is non-empty (has `Manufacturer`, `Model`, at least one profile, or `MaxChannel > 1`). If neither scheme produces a usable result, the historical single-scheme (HTTP) empty-result shape **shall** still be returned, unchanged.

**Rationale**: a device's SUNAPI web UI and ONVIF service do not necessarily agree on scheme even on the same box — observed live on 192.168.214.37, whose SUNAPI CGI is HTTPS-only (forced via an nginx redirect) while its ONVIF `device_service` answers directly on plain HTTP. Guessing only one scheme (the prior behavior, HTTP-only) would silently fail ONVIF enrichment for any device following the opposite pattern.

**Scope note**: this only applies to the on-demand single-IP probe. `ONVIFDiscovery`'s own WS-Discovery scan path uses the XAddr the device itself returned in its ProbeMatch response — that URL's scheme is already known (asserted by the device), not guessed, so no dual-scheme trial is needed or performed there.

**Acceptance**: Probing an IP whose ONVIF service only answers on HTTPS:443 (HTTP:80 refused/empty) **shall** still return a populated result (`Manufacturer`/`Model`/profiles/`MaxChannel`), not the historical HTTP-only empty shape. See `docs/tc/TC_Camera_Discovery.md` TC-H-019 (automated, `test/api/nvr_channel_discovery.test.js`).

---

### FR-CAM-075 — MaxChannel SHALL be derived from ONVIF GetVideoSources, not just GetProfiles' SourceToken set (2026-07-02)

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-075 |
| **Title** | ONVIF GetVideoSources 기반 MaxChannel/channelIndex 판별 |
| **Priority** | Must-Have |

After `GetCapabilities` resolves the Media service XAddr, the system **shall** query `GetVideoSources` at that URL before `GetProfiles`, and enumerate the returned `VideoSources` elements' `token` attributes (e.g. `VideoSource_0`, `VideoSource_1`, ...) as the authoritative, physically-ordered list of video inputs on the device. `MaxChannel` **shall** be the count of these tokens when the call succeeds and returns at least one; this supersedes FR-CAM-060's `GetProfiles`-derived distinct-`SourceToken` count as the **primary** source — that count remains as a fallback for firmware where `GetVideoSources` fails or returns nothing. Each ONVIF profile's `channelIndex` (FR-CAM-061) **shall** likewise prefer the profile's `SourceToken`'s position within this authoritative token list; FR-CAM-061's insertion-order-within-`GetProfiles` rule remains as the fallback ordering when `GetVideoSources` is unavailable.

**Rationale**: deriving `MaxChannel` purely from `GetProfiles` undercounts a device whose vendor UI only auto-creates a profile for channels an operator has actually opened/configured — `GetVideoSources` enumerates the physical inputs directly, independent of profile configuration state, and is the ONVIF-spec-correct way to answer "how many video sources does this device have."

**Acceptance**: Querying a mock ONVIF device with 3 `GetVideoSources` entries (`VideoSource_0/1/2`) but `GetProfiles` returning profiles in a different order than that list **shall** report `MaxChannel: 3`, and each profile's `channelIndex` **shall** match its `SourceToken`'s position within the `GetVideoSources` list — not `GetProfiles`' response order. See `docs/tc/TC_Camera_Discovery.md` TC-H-018/H-018b (automated, `test/api/nvr_channel_discovery.test.js`).

---

### FR-CAM-076 — ONVIF SOAP client SHALL follow one same-host HTTP redirect

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-076 |
| **Title** | ONVIF SOAP 클라이언트 — 동일 호스트 리다이렉트 1회 추적 |
| **Priority** | Must-Have |

When an ONVIF SOAP request receives a `301`/`302`/`307`/`308` response with a `Location` header whose hostname matches the request's own hostname, the client (`soapPost()`) **shall** re-issue the same SOAP body to that location, bounded to one redirect hop. A `Location` header pointing at a **different** hostname **shall NOT** be followed (SSRF hardening — an ONVIF device's own redirect is trusted only to change scheme/port on itself, not to redirect the request elsewhere).

**Rationale**: mirrors FR-CAM-073's finding for SUNAPI — some devices force HTTP→HTTPS at the web-server layer (nginx) for every path, including the guessed ONVIF `device_service` URL (observed live: 192.168.214.37 returns a bare `HTTP 301` for every unauthenticated ONVIF SOAP call on port 80). Without following the redirect, every ONVIF call against such a device fails immediately with an unhelpful `HTTP 301` error, indistinguishable from the device simply not running ONVIF at all.

**Acceptance**: A mock ONVIF endpoint on plain HTTP that 301-redirects every request to the HTTPS equivalent on the same host **shall** result in the SOAP call succeeding (following the redirect), not failing with `HTTP 301`. A redirect to a different hostname **shall NOT** be followed — the original `HTTP 3xx` failure is surfaced instead. See `docs/tc/TC_Camera_Discovery.md` TC-H-020 (automated, `test/api/nvr_channel_discovery.test.js`).

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
  Channel?:       number;           // currently selected channel (1-based, default 1)
  MaxChannel?:    number;           // physical input count; >1 = NVR/DVR (FR-CAM-060)
  SupportSunapi:  boolean;
  SupportOnvif:   boolean;
  SupportPTZ?:    boolean;
  rtspUrl?:       string;
  profiles?:      OnvifProfile[];   // index = profile order; channelIndex maps to physical input
  URL?:           string;           // DDNS URL
}

interface OnvifProfile {
  token:         string;
  name:          string;
  encoding:      string;    // "H264" | "H265" | "MJPEG"
  width:         number;
  height:        number;
  fps:           number;
  rtspUrl:       string;
  sourceToken?:  string;    // VideoSourceConfiguration/SourceToken (FR-CAM-060)
  channelIndex?: number;    // 1-based physical channel index (FR-CAM-061)
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
| 1.1 | 2026-06-23 | LTS Engineering Team | §7b 추가 — FR-CAM-060~067 NVR MaxChannel 요구사항; DeviceInfo/OnvifProfile 스키마에 Channel·MaxChannel·sourceToken·channelIndex 필드 추가 |
| 1.2 | 2026-06-24 | LTS Engineering Team | §7b 확장 — FR-CAM-068(SUNAPI env 인증), FR-CAM-069(수동 오버라이드), FR-CAM-070(channelIndex 저장), FR-CAM-071(SUNAPI MaxChannel 상한) 추가 |
| 1.3 | 2026-07-02 | LTS Engineering Team | FR-CAM-062a 추가 — SUNAPI MaxChannel 쿼리 엔드포인트 정정 (`system.cgi`/`media.cgi` 존재하지 않는 CGI 경로였음 → 실제 엔드포인트 `GET /stw-cgi/attributes.cgi/attributes`, XML `group=System/category=Limit/attribute=MaxChannel`로 수정) |
| 1.4 | 2026-07-02 | LTS Engineering Team | FR-CAM-072 추가 — SUNAPI MaxChannel 쿼리가 Digest 챌린지를 받으면 Basic 대신 계산된 Digest로 재시도해야 함 (FR-CAM-068의 "재시도 없음" 서술을 이 경우에 한해 보완); 실 카메라(192.168.214.32, nginx 기반 iPolis)에서 정상 자격증명도 Basic-only 요청으로는 항상 401로 거부되던 문제를 근거로 도입 |
| 1.5 | 2026-07-02 | LTS Engineering Team | FR-CAM-073 추가 — SUNAPI MaxChannel 쿼리가 HTTPS 접속 시 자체 서명 인증서를 거부하면 안 됨 (`onvifDiscovery.js`는 이미 동일하게 처리 중이었음); 두 번째 실 카메라(192.168.214.37, HTTPS-only)에서 `self-signed certificate` 오류로 발견 |
| 1.6 | 2026-07-02 | LTS Engineering Team | FR-CAM-074 추가 — 온디맨드 ONVIF probe가 HTTP/HTTPS 양쪽을 병렬 시도해야 함; FR-CAM-075 추가 — MaxChannel/channelIndex를 GetProfiles의 SourceToken 집합이 아니라 GetVideoSources의 물리적 채널 목록에서 우선 도출해야 함; FR-CAM-076 추가 — ONVIF SOAP 클라이언트가 동일 호스트 리다이렉트를 1회 추적해야 함(SUNAPI FR-CAM-073과 동일한 nginx 강제 리다이렉트 패턴이 ONVIF 경로에도 있었음) |
