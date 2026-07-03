# SOFTWARE REQUIREMENTS SPECIFICATION (SRS)
# Camera Discovery & Network Search Subsystem

| | |
|---|---|
| **Document ID** | SRS-LTS-CAM-01 |
| **Version** | 1.15 |
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

- ONVIF service calls must first be attempted unauthenticated when no credentials are supplied to `enrichDevice()`/`enrichDeviceAutoScheme()`.
- A 401 HTTP response must result in an `AUTH_REQUIRED` error that is caught silently; the device is still emitted with basic probe data.
- **Superseded in part by FR-CAM-090 (2026-07-03)**: when `enrichDevice()`/`enrichDeviceAutoScheme()` are given `{ username, password }`, the ONVIF SOAP client SHALL attempt HTTP Basic first and retry with HTTP Digest on a Digest challenge, exactly as FR-CAM-090 specifies — the "credentials are never embedded" clause above now applies only to the WS-Discovery background scan path when `RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD` are unset, and to `POST /api/cameras/probe-channels` calls that resolve no credentials from any source (request body, stored camera record, env default).

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

### FR-CAM-077 — SUNAPI CGI client SHALL follow one same-host HTTP redirect

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-077 |
| **Title** | SUNAPI CGI 클라이언트(`sunapiRequest()`) — 동일 호스트 리다이렉트 1회 추적 |
| **Priority** | Must-Have |

When a SUNAPI CGI request (`querySunapiMaxChannel()`, `querySunapiRtspPort()`) receives a `301`/`302`/`307`/`308` response with a `Location` header whose hostname matches the request's own hostname, the client (`sunapiRequest()`, `discoveryService.js`) **shall** re-issue the same GET to that location, bounded to one redirect hop. A `Location` header pointing at a **different** hostname **shall NOT** be followed (same SSRF-hardening rule as FR-CAM-076).

**Rationale**: companion fix to FR-CAM-076 — the same nginx-forced HTTP→HTTPS redirect observed on 192.168.214.37's ONVIF service (FR-CAM-076) also applies to its SUNAPI web port; before this fix, `querySunapiMaxChannel()` on that device failed with a bare `HTTP 301` regardless of credentials, indistinguishable from the device not running SUNAPI at all.

**Acceptance**: A mock SUNAPI endpoint on plain HTTP that 301-redirects every request to the HTTPS equivalent on the same host **shall** result in the CGI call succeeding (following the redirect) and reporting the correct `MaxChannel`. A redirect to a different hostname **shall NOT** be followed — `MaxChannel` falls back to 1. Verified live against 192.168.214.37 (`querySunapiMaxChannel()` now returns the true `MaxChannel=4` instead of 1). See `docs/tc/TC_Camera_Discovery.md` TC-H-025 (automated, `test/api/nvr_channel_discovery.test.js`).

---

### FR-CAM-078 — `channelRtspUrl()` SHALL recognize both the `/profileN/` and `/N/H.264/` SUNAPI conventions

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-078 |
| **Title** | 채널별 RTSP URL 치환 — 두 SUNAPI 컨벤션 동시 지원 |
| **Priority** | Must-Have |

`channelRtspUrl(baseUrl, channel)` (`server/src/utils/channelRtsp.js` and its client twin `client/src/utils/channelRtsp.ts`) **shall** recognize two distinct SUNAPI/Wisenet RTSP path conventions and substitute the channel segment in whichever one the input `baseUrl` already uses, leaving the rest of the URL (host, port, query) untouched:
- `/profileN/` (1-based) — e.g. `rtsp://ip:port/profile1/media.smp`
- `/N/H.264/` (0-based channel segment) — e.g. `rtsp://ip/0/H.264/media.smp`

The `channel` parameter **shall** remain 1-based at the call site for both conventions — only the second pattern's URL segment is `channel - 1`. A `baseUrl` matching neither convention **shall** be returned unchanged (existing no-op contract, extends FR-CAM-066's priority-order rule).

**Rationale**: a survey of this deployment's actual camera DB records (192.168.214.34/35/37/39/40) found the `/N/H.264/` convention in use on every device except one (TID-A800 at 192.168.214.32, which uses `/profileN/`) — `channelRtspUrl()` previously only recognized `/profileN/`, so channel switching silently no-op'd (returned the unchanged URL) for the majority of real cameras on this network.

**Acceptance**: `channelRtspUrl('rtsp://ip:10030/profile1/media.smp', 3)` → `.../profile3/media.smp` (unchanged behavior). `channelRtspUrl('rtsp://ip/0/H.264/media.smp', 2)` → `rtsp://ip/1/H.264/media.smp`. `channelRtspUrl('rtsp://ip/1/H.264/media.smp', 1)` → `rtsp://ip/0/H.264/media.smp`. An unrecognized shape is returned unchanged. See `docs/tc/TC_Camera_Discovery.md` TC-H-021a/b/c (automated, `test/api/nvr_channel_discovery.test.js`).

---

### FR-CAM-079 — SUNAPI RTSP port SHALL be confirmed via CGI when credentials are available, falling back to 554

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-079 |
| **Title** | SUNAPI RTSP 포트 CGI 확인 + 554 폴백 |
| **Priority** | Must-Have |

When credentials (username + password) are available for a SUNAPI device, the system **shall** query `GET /stw-cgi/network.cgi?msubmenu=portconf&action=view` (`querySunapiRtspPort()`, `discoveryService.js`) to confirm the device's actually-configured RTSP port, and **shall** use that confirmed value (not a hardcoded default) whenever synthesizing a fresh RTSP URL with no prior `baseRtspUrl` to pattern-match against (`defaultSunapiRtspUrl()`, FR-CAM-078's twin functions). Without credentials, or if the query fails/times out/the response has no parseable `RTSPPort` field, the system **shall** fall back to the SUNAPI default port `554` without treating this as an error.

This endpoint's response is **plain `key=value` text, one pair per line** (e.g. `RTSPPort=554`) — **not** XML, unlike `attributes.cgi` (FR-CAM-062a). It requires admin-level authentication (verified live: `HTTP 401` with no credentials); the system **shall NOT** attempt this query when no credentials are resolvable from any source (request body / camera record / `RTSP_DEFAULT_*` env — same three-source precedence as `docs/srs/SRS_Channel_Slot.md` FR-CH-064's cameraId-scoped skip-when-no-credentials gate).

**Rationale**: reported directly by the customer along with the exact endpoint, then independently verified live via `curl --digest` against two real devices (192.168.214.32, 192.168.214.37) before implementation — both returned `RTSPPort=554` in the documented plain-text shape, confirming the endpoint is real and the response format assumption (unlike the FR-CAM-062a precedent, where two previously-assumed endpoints turned out not to exist at all). A worthwhile side-finding: 192.168.214.32's own DB record stores `rtsp://192.168.214.32:10030/profile1/media.smp` — port `10030` — while this CGI reports `RTSPPort=554` for the same device, i.e. an existing camera's stored port can already be stale/incorrect; this feature surfaces the discrepancy (via Re-detect) but does not auto-correct a saved camera without an explicit Save.

**Acceptance**: A mock `network.cgi?msubmenu=portconf&action=view` endpoint returning `RTSPPort=8554` among other `key=value` lines **shall** result in `querySunapiRtspPort()` returning `8554`. Blank credentials **shall** return `null` without any network call being attempted (verified by pointing at a port nothing listens on and confirming no error/timeout occurs). See `docs/tc/TC_Camera_Discovery.md` TC-H-022~024 (automated, `test/api/nvr_channel_discovery.test.js`).

---

### FR-CAM-080 — `POST /api/cameras/probe-channels` SHALL report each protocol's own per-channel URLs independently

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-080 |
| **Title** | probe-channels 응답 — SUNAPI/ONVIF 프로토콜별 URL 독립 보고 |
| **Priority** | Must-Have |

In addition to the existing merged `profiles`/`protocol` fields (the "winning" protocol only, FR-CAM-066), the response **shall** include `sunapiProfiles` and `onvifProfiles` — each protocol's own resolved per-channel RTSP URLs, populated independently of which protocol "won." This follows the same "always report both independently" convention already established for `sunapiMaxChannel`/`onvifMaxChannel` (`docs/srs/SRS_Channel_Slot.md` FR-CH-066). The response **shall** also include `sunapiRtspPort` (FR-CAM-079's confirmed port, or `null` when unconfirmed).

When a `baseRtspUrl` is supplied, `sunapiProfiles` **shall** be synthesized via `channelRtspUrl()` (FR-CAM-078) preserving that URL's existing convention; when no `baseRtspUrl` is known at all (e.g. Add-flow probing a bare IP before any URL has been typed), `sunapiProfiles` **shall** still be populated using `defaultSunapiRtspUrl()` (FR-CAM-079) rather than being left empty, provided SUNAPI reports `maxChannel > 1`.

**Rationale**: requested directly — an operator wants to see which protocol (SUNAPI vs ONVIF) actually resolved a given channel's URL, not just the merged "winner," to diagnose cases where the two disagree or where only one protocol is reachable (e.g. ONVIF blocked by the pre-existing unauthenticated-SOAP limitation, §7 C-06). Also closes a pre-existing gap where `profiles` stayed empty whenever `baseRtspUrl` was omitted, even though `sunapiMax > 1` was already known.

**Acceptance**: A `probe-channels` request with no `baseRtspUrl` against a confirmed 4-channel SUNAPI device **shall** return 4 `sunapiProfiles` entries using the `/N/H.264/` convention and the CGI-confirmed port. `onvifProfiles` **shall** always reflect ONVIF's own result regardless of whether SUNAPI or ONVIF "won" as `protocol`. Verified live against 192.168.214.37 and 192.168.214.40. See `docs/design/Design_Camera_Discovery.md` §5 (API Design).

---

### FR-CAM-081 — UDP discovery's extended fields SHALL be undefined (not a false default) when the packet is too short

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-081 |
| **Title** | UDP Discovery 확장 필드 — 패킷이 짧을 때 거짓 기본값이 아닌 undefined 반환 |
| **Priority** | Must-Have |

`_parseResponse()`'s extended-field block (`alias`, `chDeviceNameNew`, `modelType`, `version`, `httpType`, `nHttpsPort`, `noPassword`) **shall** gate each field on the actual remaining byte count in sequence, stopping at the first field that doesn't fit — every field from that point on **shall** be left `undefined`, not defaulted to `0`/`''`. A byte count that happens to cover a later field in the sequence does not make that field's offset valid when an earlier field was cut off.

**Rationale**: the previous single blanket `if (b.length >= 261)` guard let a 262-byte packet (real, observed live on this network) pass the check yet have only 1 trailing byte — far short of the 72 bytes the full extended block needs. `rb(n)`/`bytes2int(rb(1))`/`r16()` silently return `0`/`''` on an out-of-bounds `Uint8Array.subarray()` (only `r8()`'s direct `b[i]` indexing naturally yields `undefined`), so `modelType` came back as a false-but-defined `0` — indistinguishable from a genuine Device Type `0x00` (Camera) — for every device sending this packet shape, which this survey found to be the majority on this network.

**Acceptance**: A 262-byte packet (261-byte common header + 1 trailing byte) **shall** yield `modelType: undefined`, `chDeviceNameNew: undefined`, not `0`/`''`. A genuinely complete 333-byte packet **shall** parse all extended fields correctly (e.g. `modelType: 3` → `DeviceType: 'Recorder'`). See `docs/tc/TC_Camera_Discovery.md` TC-H-026/H-027 (automated, `test/api/nvr_channel_discovery.test.js`).

**Follow-on** — `mapUDPDevice()` (`discoveryService.js`) now also exposes `DeviceType`, a human-readable label for `Type` (`raw.modelType`) per the vendor spec's Device Type enum (0x00 Camera, 0x01 Encoder, 0x02 Decoder, 0x03 Recorder, 0x04 IOBox, 0x05 NetworkSpeaker, 0x06 NetworkMic, 0x07 LEDBox, 0x08 EmergencyBell, 0x09 AccessController), displayed in `DiscoveredCameraPanel.tsx`'s Device info section. `mergeDevices()` fills in `Type`/`DeviceType` from whichever protocol has it (only ever set by UDP discovery, never ONVIF) without overwriting an existing value.

---

### FR-CAM-082 — `UDPDiscoveryFallback` SHALL implement the WiseNet "IP Scan for SUNAPI" binary protocol at parity with the submodule

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-082 |
| **Title** | UDPDiscoveryFallback — SUNAPI IP Installer 스펙 §3.4 준수, 서브모듈과 동등한 파싱 |
| **Priority** | Must-Have |
| **Status** | Superseded by FR-CAM-087 (2026-07-03) — `UDPDiscoveryFallback` was removed entirely; requirement text kept for history |

`server/src/utils/udpDiscovery.js`'s `UDPDiscoveryFallback` (used when `submodules/WiseNetChromeIPInstaller` is not initialised) **shall** broadcast a valid WiseNet SUNAPI "IP Scan for SUNAPI" request (SUNAPI IP Installer spec §3.4.1) on UDP port 7701 and parse responses on port 7711 per §3.4.2's binary field layout — the same layout `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js` parses, including the FR-CAM-081 bounds-check fix. For the same input bytes, both implementations **shall** produce identical field values.

**Rationale**: the fallback previously `toString('utf8')`'d the raw response and regex-matched ONVIF-style XML tags (`MACAddress`, `Model`, `XAddrs`) — a completely different protocol from WiseNet's binary format, despite listening on WiseNet's own ports. A deployment without the git submodule initialised (`git submodule update --init` never run) could not discover any SUNAPI/WiseNet camera via UDP broadcast at all, with no error surfaced — indistinguishable from "no cameras present."

**Acceptance**: `UDPDiscoveryFallback._parseResponse()` and the submodule's `_parseResponse()` **shall** return identical values for every field (`chMac`, `chIP`, `nPort`, `nTcpPort`, `chDeviceName`, `modelType`, etc.) given the same captured real-device response bytes. Verified live: `UDPDiscoveryFallback` run standalone discovered all cameras on this network's actual broadcast domain, matching the submodule's results. See `docs/tc/TC_Camera_Discovery.md` TC-H-028/H-029 (automated, `test/api/nvr_channel_discovery.test.js`).

**Non-goal, informational finding**: §3.4.1 documents the request opcode as `nMode=6` (`DEF_REQ_SCAN_EX`); both implementations' captured request packet uses `nMode=1` instead. A live test confirmed this project's camera fleet responds identically to either opcode, while `nMode=6` additionally drew responses from a much broader, largely unrelated portion of the network — a network-scope observation, not a defect in this requirement. `nMode=1` remains the implementation's request opcode; switching to `nMode=6` is explicitly out of scope for this requirement.

---

### FR-CAM-083 — `supported_protocol` and `no_password` SHALL be parsed from distinct, correctly-ordered offsets

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-083 |
| **Title** | UDP Discovery 확장 필드 — supported_protocol/no_password 오프셋 정정 |
| **Priority** | Must-Have |

`_parseResponse()`'s extended field block **shall** parse `supported_protocol` (1 byte, immediately after `https_port`) and `no_password` (1 byte, the final field of the extended block) as two distinct fields at their own correctly-sequenced offsets, per Annex A's `DATAPACKET_EXT_IPv4_T`/`DATAPACKET_EXT_IPv6_T` struct.

**Rationale**: reported directly by the customer, who cross-referenced the vendor's own C struct (`DATAPACKET_EXT_IPv4_T`, Annex A) against the parser and noticed `supported_protocol` had no corresponding read at all. Investigation found the bug was subtler than a missing field: `_parseResponse()` read a value into `noPassword` immediately after `nHttpsPort`, one field too early — that read actually consumed the byte belonging to `supported_protocol`, and the parser never advanced far enough to read the real, final `no_password` byte. The two fields had silently collapsed into one (the struct's last two 1-byte fields being adjacent made the off-by-one produce a plausible-looking, still-in-bounds value rather than an out-of-range error).

**Acceptance**: Given a fixture with distinct sentinel values in the `supported_protocol` and `no_password` byte positions, `_parseResponse()` **shall** return them as two separate fields (`supportedProtocol`, `noPassword`) with the correct, distinct values — not the same value read twice or one overwriting the other. `mapUDPDevice()` **shall** additionally surface the raw byte as `SupportedProtocol` (undecoded — the vendor spec documents it as a bitmask of `0x01: SVNP, 0x02: SUNAPI1.0, 0x04: SUNAPI2.0, 0x08: SUNAPI2.3.1+, 0x10: SVP`, but no further semantics are needed by this system today). See `docs/tc/TC_Camera_Discovery.md` TC-H-030 (automated, `test/api/nvr_channel_discovery.test.js`).

---

### FR-CAM-084 — The extended field block SHALL be gated on the response's own `nMode`, not merely on remaining packet length

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-084 |
| **Title** | UDP Discovery 확장 필드 블록 — nMode 기반 파싱 분기 (DEF_RES_SCAN_EXT) |
| **Priority** | Must-Have |

Per the vendor's SUNAPI IP Installer spec §3.4.2/§4.4.2 (IPv4/IPv6 "IP Scan for SUNAPI" response — the customer's reported "§4.4.2 / `_response_5`" and Table 1/Table 2's `nMode` enum), a response's `nMode` byte determines the wire format: only `nMode = 12` (`DEF_RES_SCAN_EXT`) carries the extended field block (`alias`/`chDeviceNameNew`/`modelType`/`version`/`httpType`/`nHttpsPort`/`supportedProtocol`/`noPassword`, per Annex A's `DATAPACKET_EXT_IPv4_T`). Every device surveyed on this network instead responds with `nMode = 11` — an undocumented (not in Table 1/2) but consistently-observed base-mode value whose wire format (Annex A's `DATAPACKET_IPv4_T`) has no room for the extended block at any packet length, only a single trailing `reserved3` byte after `ddns_url`.

`_parseResponse()` **shall** define the complete `nMode` enum from spec Table 1/Table 2 (`NMODE` — `DEF_REQ_SCAN_EXT=6`, `DEF_REQ_APPLY_EXT=7`, `DEF_REQ_SCAN_RSA=8`, `DEF_REQ_APPLY_PASSWORD=9`, `DEF_RES_SCAN_EXT=12`, `DEF_RES_SCAN_RSA=13`, `DEF_RES_APPLY_EXT=23`, `DEF_RES_APPLY_PASSWORD_ERR=24`, `DEF_RES_APPLY_PASSWORD=25`, `DEF_RES_PASSWORD_ERR=33`, `DEF_RES_ROUTER_CONN_ERR=66`, `DEF_RES_APPLY_ERR=77`) as a distinct, named module-level constant — not inline magic numbers — and dispatch on it in two stages, immediately after reading the `nMode` byte and before any further field is read:

1. **Non-scan modes** (`DEF_RES_SCAN_RSA`, `DEF_RES_APPLY_EXT`, `DEF_RES_APPLY_PASSWORD_ERR`, `DEF_RES_APPLY_PASSWORD`, `DEF_RES_PASSWORD_ERR`, `DEF_RES_ROUTER_CONN_ERR`, `DEF_RES_APPLY_ERR`) belong to an entirely different request/response exchange (RSA key exchange §3.5, password-apply §3.6/§3.7), each with its own incompatible wire struct (e.g. `tagRsaScanResponse`) — `_parseResponse()` **shall** return `null` immediately for these, before attempting to read any bytes with the IP-Scan struct layout.
2. **Scan modes** (`DEF_RES_SCAN_EXT=12`, or any other/undocumented value — including the empirically-observed base-mode `11`) **shall** proceed with the existing IP-Scan base-field parsing, and the extended-field block **shall** be gated on `result.nMode === NMODE.DEF_RES_SCAN_EXT` specifically; the existing FR-CAM-081 per-field remaining-byte-count check **shall** remain active *within* that gate as a defense against a genuinely truncated `nMode=12` packet (e.g. cut short by a network MTU/fragmentation issue), but **shall NOT** by itself be treated as sufficient evidence that a packet carries the extended block.

**Rationale**: prior to this requirement, whether the extended block was attempted was decided purely by whether enough trailing bytes existed (FR-CAM-081) — a proxy for "is this packet in the extended format," not an authoritative check, and every `nMode` value was implicitly treated as an IP-Scan response regardless of what the spec's own Table 1/2 says that value means. This worked for every packet actually observed on this network only because base-mode (`nMode=11`) responses here also happen to be short (262 bytes) and no RSA/apply-password exchange traffic has ever been observed on this discovery socket. It is not spec-correct on either count: a base-mode response that happened to carry extra vendor-specific trailing data for an unrelated reason would have its trailing bytes misread as `alias`/`modelType`/etc., and a stray RSA/apply-password response (a different exchange entirely, sharing the same UDP ports) would be misread as a scan device using the wrong struct layout. Separating the `nMode` dispatch into an explicit, spec-referenced enum and two-stage branch removes both classes of misparse.

**Acceptance**: A synthetic packet with `nMode=11` (base mode) padded to 334 bytes with plausible-looking extended-field data **shall** still yield `modelType`/`chDeviceNameNew`/`supportedProtocol` all `undefined` — the mode gate takes precedence over the packet being numerically long enough. A synthetic packet with `nMode=12` and the same trailing bytes **shall** parse them as genuine extended fields. A packet whose `nMode` is any of the seven non-scan values **shall** yield `null` rather than a partially/incorrectly parsed device object. Both `UDPDiscovery` (submodule) and `UDPDiscoveryFallback` **shall** apply the identical dispatch. See `docs/tc/TC_Camera_Discovery.md` TC-H-031~034 (automated, `test/api/nvr_channel_discovery.test.js`).

---

### FR-CAM-085 — The SendData/RecvData struct SHALL include Annex A's `reserved2`/`reserved3` fields (334 bytes total)

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-085 |
| **Title** | SendData/RecvData 구조체 — reserved2/reserved3 오프셋 반영 (332→334바이트) |
| **Priority** | Must-Have |

The shared field layout for §3.2 "SendData Format for SUNAPI" and §3.3 "RecvData Format for SUNAPI" (`submodules/WiseNetChromeIPInstaller/nodejs/protocol.js`'s `FIELDS`) **shall** include two 1-byte fields absent from those sections' own summary tables but present in Annex A §5.1's authoritative `DATAPACKET_(EXT_)IPv4_T` C structs: `reserved2` immediately after `chDeviceName` (offset 119), and `reserved3` immediately after `nHttpMode` (offset 329). Total struct size **shall** be 334 bytes, not 332.

**Rationale**: `FIELDS` was initially built by transcribing §3.2/§3.3's field tables directly, which omit both reserved bytes. `submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js`'s pre-existing `_parseResponse()` already read (and discarded) both correctly, matching real hardware — but the newly-introduced `UdpResponse.parse()` (FR-CAM-086) did not, and every field from `nHttpPort` onward decoded as a plausible-looking but wrong value shifted by one byte (e.g. a real device's `nHttpPort` of `80` decoded as `20596`). This is the same class of vendor-doc-vs-Annex-A gap FR-CAM-083 already found once for `supported_protocol`/`no_password`.

**Acceptance**: `UdpResponse.parse()` and the legacy `_parseResponse()` **shall** produce identical values for every base and extended field, verified against both a real captured packet and live network traffic (100+ real devices, all replying with exactly 334-byte extended responses). See `docs/tc/TC_Camera_Discovery.md` TC-H-028/029/032 (automated, `test/api/nvr_channel_discovery.test.js`).

---

### FR-CAM-086 — The discovery request opcode SHALL default to `nMode=6` (`DEF_REQ_SCAN_EXT`), superseding FR-CAM-082's non-goal

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-086 |
| **Title** | UDP Discovery 요청 옵코드 — nMode=6(DEF_REQ_SCAN_EXT) 기본 전환 |
| **Priority** | Must-Have |
| **Supersedes** | FR-CAM-082's "non-goal, informational finding" (request opcode kept at `nMode=1`) |

`udpDiscovery.js`'s `_sendDiscovery()` **shall** send a request built via `submodules/WiseNetChromeIPInstaller/nodejs/request.js`'s `UdpRequest` class, defaulting to `nMode = DEF_REQ_SCAN_EXT (6)` — the spec-documented opcode (§3.4.1) — with a freshly generated `chPacketID` (local MAC + random bytes, per §3.2's own field description) and every other field left at its "Unused" value. The historical hardcoded `nMode=1` packet (`DISCOVERY_PACKET`) **shall** be preserved in the source, commented out rather than deleted, as an immediate rollback path.

**Rationale**: FR-CAM-082 recorded a live comparison finding `nMode=6` draws responses from a much broader, largely unrelated portion of the network in addition to this project's own camera fleet, and kept `nMode=1` as the default for that reason. This requirement reverses that decision after further live verification found no discovery regression from the switch on this network — see Acceptance below. The commented-out `nMode=1` path exists specifically so a deployment that *does* see the broader-network-response side effect can revert in one line without a re-implementation.

**Acceptance**: `node index.js` (or the server's discovery scan) broadcasting the `nMode=6` request **shall** draw `nMode=12` (`DEF_RES_SCAN_EXT`) responses from real devices on this network, each parsed end-to-end (`chIP`/`chMac`/`rtspUrl`/etc.) — live-verified against 100+ real devices. The socket's `'message'` handler **shall** independently confirm this round-trip via a `'scanExtConfirmed'` event whenever `UdpResponse.parse()` observes `nMode === NMODE.DEF_RES_SCAN_EXT`, without altering what drives the `'device'` event.

---

### FR-CAM-087 — Protocol constants SHALL have a single shared source, and the server SHALL NOT maintain an independent fallback implementation

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-087 |
| **Title** | protocol.js 단일 소스화, server/ 인라인 폴백(UDPDiscoveryFallback) 제거, npm 패키지 설치 경로 추가 |
| **Priority** | Must-Have |
| **Supersedes** | FR-CAM-082 (the `UDPDiscoveryFallback` class it specifies no longer exists) |

`submodules/WiseNetChromeIPInstaller/nodejs/protocol.js` **shall** be the single source for: `SEND_PORT`/`RECEIVE_PORT`/`BROADCAST_ADDR`, the 334-byte `FIELDS` table (FR-CAM-085), the full request+response `NMODE` enum (FR-CAM-084), `NON_SCAN_RESPONSE_MODES`, and response-field enums `NVERSION` (bitmask), `NETWORK_MODE`, `DEVICE_TYPE`, `HTTP_MODE`, `SUPPORTED_PROTOCOL` (bitmask), and `PASSWORD_STATUS` — `request.js`, `response.js`, and `udpDiscovery.js` **shall** import all of these from `protocol.js` rather than redefining any subset locally. `server/src/utils/udpDiscovery.js` **shall NOT** contain an independent socket-opening or byte-parsing implementation, and **shall NOT** read `submodules/WiseNetChromeIPInstaller`'s filesystem path directly — it **shall** re-export the `wisenet-chrome-ip-installer` npm package (below) exclusively, resolved lazily (deferred to first call of `getUDPDiscovery()` or access of a re-exported property, not at module-require time — see the "Lazy resolution" requirement below), and **shall** raise a clear error at that point if the package is not installed, rather than silently degrading. (An initial implementation tried the git submodule path first, then the npm package as fallback; corrected same-day at explicit direction — the git submodule remains the canonical source the npm package is built from, but is not a second runtime install path for `server/` itself to depend on.)

**Lazy resolution (added same-day, regression fix)**: requiring `server/src/utils/udpDiscovery.js` **shall NOT**, by itself, attempt to resolve `wisenet-chrome-ip-installer` or throw if it is unavailable — `discoveryService.js` requires this module unconditionally in every `SERVER_MODE`, including `analysis` (no cameras, `getUDPDiscovery()` never called), so an eager top-level `require()` crashed a real `SERVER_MODE=analysis` server at startup whenever the package wasn't installed, despite that mode never needing camera discovery. Resolution **shall** happen only on first actual use.

`server/package.json` **shall** declare `wisenet-chrome-ip-installer` (the `submodules/WiseNetChromeIPInstaller` repository's `nodejs-udp-discovery` branch) as an `optionalDependencies` entry, fetched by ordinary `npm install` with no separate `git submodule update --init` step. The `WiseNetChromeIPInstaller` repository **shall** carry a root-level `package.json` (`"private": true`, `"main": "nodejs/udpDiscovery.js"`, `"files": ["nodejs"]`) so npm's git-dependency installer recognizes it as an installable package at all.

**Rationale**: `UDPDiscoveryFallback` (FR-CAM-082) existed to keep WiseNet discovery working when the git submodule wasn't initialised, but required an independently-maintained duplicate of the entire wire protocol — which had already drifted once (an endianness bug caught only by a parity test). The team weighed continued duplication-maintenance cost against the risk of removing the fallback (the `wisenet-chrome-ip-installer` repository is private, and this same effort hit real, repeated GitHub authentication failures pushing to it) and concluded `optionalDependencies` — satisfied by the `npm install` every dev/CI/deploy workflow already runs — is a strictly better second line of defense than a second full implementation, accepting the private-repo-access risk as a known, explicit tradeoff rather than an oversight.

**Acceptance**: `npm install` in `server/` **shall** fetch `wisenet-chrome-ip-installer` into `node_modules` (verified: 72KB, `nodejs/` only — `files` correctly excludes the parent repository's ~1.5MB of unrelated Chrome-extension assets) without that package's install failure aborting installation of the rest of `server/`'s dependencies. `getUDPDiscovery()` **shall** resolve to a working `UDPDiscovery` constructor whether sourced from the submodule or the npm package, verified via `test/api/nvr_channel_discovery.test.js`'s renamed TC-H-028/029/032/034 (comparing the npm-package-backed and submodule-loaded copies for parity) and a live discovery run through `server/src/services/discoveryService.js`'s `getUDPDiscovery()` consumption path (100+ real devices found).

---

### FR-CAM-088 — Synthesized RTSP URLs SHALL NOT be derived from `nTcpPort` or `nPort`

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-088 |
| **Title** | RTSP URL 생성 — nTcpPort/nPort 오용 수정, SUNAPI 표준 554 기본값 |
| **Priority** | Must-Have |

Neither `udpDiscovery.js`'s `_parseResponse()` (`result.rtspUrl`) nor `discoveryService.js`'s `mapUDPDevice()` (`rtspPort`/`Port`) **shall** derive a synthesized RTSP URL's port from `nTcpPort` or `nPort`. Both **shall** default to SUNAPI's documented standard RTSP port (`554`) when no independently-confirmed port is available.

**Rationale**: `nTcpPort`'s own spec description (§3.3/§3.4.2) is "Port number to get stream via tcp. This port is valid only if Client uses VNP" — a legacy WiseNet protocol unrelated to RTSP/SUNAPI streaming — and `nPort` is documented as "HTTP port for web-connection" (confirmed live: real devices report their HTTPS web port, e.g. `443`, there). **No field in the UDP discovery response reliably carries the real RTSP port.** `mapUDPDevice()`'s resulting `Port` value is surfaced to operators directly, labeled "RTSP Port" in `DiscoveredCameraPanel.tsx`, and feeds `defaultSunapiRtspUrl()` — this was a user-visible correctness bug, not merely an internal inconsistency. It is almost certainly the root cause of a discrepancy already on record (FR-CAM-079/`docs/ops/Camera_Discovery_Guide.md` §3): a real device (192.168.214.32) whose saved `rtspUrl` port (`10030`) didn't match its CGI-confirmed `RTSPPort` (`554`) — `10030` was never a real RTSP port, just whatever `nTcpPort` happened to contain.

**Acceptance**: Given any UDP discovery response, `result.rtspUrl` **shall** use port `554` regardless of the response's `nTcpPort` value. `mapUDPDevice()`'s `Port`/`rtspUrl` **shall** likewise use `554` regardless of `raw.nPort`. The real, confirmed port (when it differs from `554`) **shall** continue to come only from `querySunapiRtspPort()`'s CGI query (FR-CAM-079), never from the UDP broadcast response.

---

### FR-CAM-089 — SUNAPI CGI Digest-auth challenge detection SHALL recognize combined multi-scheme `WWW-Authenticate` headers

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-089 |
| **Title** | SUNAPI CGI Digest 인증 감지 — 콤바인드 WWW-Authenticate 헤더 대응 |
| **Priority** | Should-Have |

`querySunapiMaxChannel()` and `querySunapiRtspPort()` (`discoveryService.js`) **shall** recognize a `Digest` challenge in a `WWW-Authenticate` response header regardless of its position within the header value, including when the header advertises multiple schemes joined by the runtime's header-folding behavior (e.g. `Basic realm="x", Digest realm="y", qop="auth", nonce="..."`). `buildDigestAuthHeader()` **shall** extract `realm`/`nonce`/`qop`/`opaque` parameters from the Digest-scheme portion of the challenge specifically, not from the full challenge string.

**Rationale**: the existing FR-CAM-072 Digest-retry logic matched the challenge with `/^Digest\s/i`, anchored to the start of the string — correct only when Digest is the sole or first scheme offered. Node's HTTP client joins multiple `WWW-Authenticate` response headers with `", "`, so a server offering both Basic and Digest with Digest listed second would never trigger the retry, silently falling through to the existing "auth rejected" failure path. Widening detection without also scoping parameter extraction would risk a different bug — reading Basic's `realm` into the computed Digest header — so both were fixed together.

**Acceptance**: given a synthetic combined challenge (`Basic realm="BasicRealm", Digest realm="DigestRealm", qop="auth", nonce="abc123nonce", opaque="op1"`), the Digest-challenge check **shall** evaluate true, and `buildDigestAuthHeader()`'s computed `Authorization` header **shall** contain `realm="DigestRealm"` and **shall NOT** contain `realm="BasicRealm"`. A single-scheme Digest challenge (the existing FR-CAM-072 case) **shall** continue to work unchanged.

---

### FR-CAM-090 — ONVIF SOAP client SHALL retry with HTTP Digest auth when challenged for it, after an initial HTTP Basic attempt (2026-07-03)

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-090 |
| **Title** | ONVIF SOAP 클라이언트 — Basic 시도 후 Digest 챌린지 시 재시도 |
| **Priority** | Should-Have |

`onvifDiscovery.js`'s `soapPost()` **shall** accept an optional `credentials` argument (`{ username, password }`), threaded through by `enrichDevice(ip, xaddr, credentials)` and `enrichDeviceAutoScheme(ip, { onvifPort, onvifHttpsPort, username, password })`. When `credentials` is given, the first request to each ONVIF SOAP endpoint (`GetDeviceInformation`, `GetCapabilities`, `GetVideoSources`, `GetProfiles`, `GetStreamUri`) **shall** carry an HTTP `Authorization: Basic ...` header. When that request receives a `401` whose `WWW-Authenticate` response header advertises the `Digest` scheme (via the same combined-header-aware detection as FR-CAM-089's `challengesDigest()`), the client **shall** compute an RFC 7616 Digest `Authorization` header (MD5, `qop=auth` when offered) using the shared `buildDigestAuthHeader()` (moved to `server/src/utils/digestAuth.js`, shared with `discoveryService.js`'s SUNAPI client) and retry the request exactly once. A challenge that is `Basic`-only, or a Digest retry that itself still `401`s, **shall** surface as `AUTH_REQUIRED` unchanged (caught silently by `enrichDevice()`, same as before this requirement). When no `credentials` are given, behavior **shall** be unchanged from FR-CAM-012/014 (unauthenticated best-effort).

`ONVIFDiscovery`'s WS-Discovery background-scan constructor **shall** accept optional `username`/`password` options, defaulting to `RTSP_DEFAULT_USERNAME`/`RTSP_DEFAULT_PASSWORD` env vars (mirroring FR-CAM-068's SUNAPI default), and pass them as `credentials` to every `enrichDevice()` call in its ProbeMatch handler. `POST /api/cameras/probe-channels` (`server/src/api/cameras.js`) **shall** pass its already-resolved `effectiveUsername`/`effectivePassword` (request body → stored camera record → `RTSP_DEFAULT_*` env, per FR-CH-064) to `enrichDeviceAutoScheme()` as well, not just to the SUNAPI probe.

**Rationale**: identical motivation to FR-CAM-072/089 but on the ONVIF side — some devices front their ONVIF `device_service` behind an HTTP server (e.g. nginx) that gates access with Basic or Digest auth before the request ever reaches the ONVIF SOAP handler. Prior to this requirement, `soapPost()` never sent an `Authorization` header at all, so any such device's ONVIF probe always resolved `AUTH_REQUIRED` regardless of whether correct credentials were available elsewhere in the request (the SUNAPI probe already had them via FR-CAM-068/072). This does **not** implement ONVIF's own SOAP-level WS-Security (`wsse:UsernameToken`/`PasswordDigest` inside `<s:Header>`) — that remains a separate, unimplemented mechanism (see `docs/design/Design_Channel_Slot.md` §7 Limitations); this requirement only covers HTTP-transport-layer Basic/Digest.

**Acceptance**: against a mock ONVIF SOAP server requiring HTTP Basic, `enrichDevice(ip, xaddr, { username, password })` with correct credentials **shall** return populated `Manufacturer`/`Model` data. Against a mock server that 401s any Basic attempt and requires Digest, the same call **shall** succeed via the computed Digest retry. The same call with a wrong password **shall** still fail (`Manufacturer` stays empty) even after the Digest retry — this requirement does not weaken the credential check. Without `credentials`, behavior against either mock **shall** be unchanged from before (empty result, no throw). See TC-H-037~039b.

---

### FR-CAM-091 — UDP discovery SHALL derive `MaxChannel` from `nMulticastPort` on an extended (`nMode=12`) scan response (2026-07-03)

| Attribute | Value |
|---|---|
| **ID** | FR-CAM-091 |
| **Title** | UDP Discovery — 확장 스캔 응답에서 nMulticastPort로 MaxChannel 도출 |
| **Priority** | Should-Have |

`UdpResponse` (`submodules/WiseNetChromeIPInstaller/nodejs/response.js`) **shall** expose a `MaxChannel` getter that returns `this.nMulticastPort` when `this.nMode === NMODE.DEF_RES_SCAN_EXT` (12), and `undefined` for any other `nMode`. `nMulticastPort` **shall** continue to decode unconditionally as a base field (present regardless of `nMode`) exactly as before — this requirement only adds a second, conditional interpretation of that same already-decoded value, it does not change how or when `nMulticastPort` itself is parsed.

`_parseResponse()` (`submodules/WiseNetChromeIPInstaller/nodejs/udpDiscovery.js`, the legacy field-shape adapter over `UdpResponse.parse()`) **shall** surface this as `nMaxChannel` in its returned object (`n`-prefixed, matching this adapter's other raw numeric wire-field names — `nPort`/`nHttpPort`/`nMulticastPort`/etc.). `mapUDPDevice()` (`server/src/services/discoveryService.js`) **shall** read `raw.nMaxChannel` (updated from the prior placeholder reference to `raw.MaxChannel`, which `_parseResponse()` never actually set) in its existing forward-compatible `MaxChannel: raw.nMaxChannel > 1 ? raw.nMaxChannel : 1` expression — no other logic changes.

**Rationale**: FR-CAM-081's Document History already noted the vendor spec ties this same `nMulticastPort`/`MaxChannel` slot reinterpretation to `nVersion` bit `0x08` (`SUPPORT_PASSWORD_VERIFICATION_DIGEST`), but every device captured on this network so far sends a base-mode (`nMode=11`) response with no `nVersion` field present at all — that condition is unverifiable here. `nMode === DEF_RES_SCAN_EXT` (12) is used instead: it is the extended-scan-reply indicator the response's own base fields already carry unconditionally, requires no additional field to exist, and is directly testable against a synthetic fixture (a real captured packet with only the `nMode` byte overwritten) even without a real `nMode=12` device on hand.

**Acceptance**: A response parsed with `nMode=11` (base mode, the only mode observed live) **shall** have `MaxChannel: undefined` on the `UdpResponse` instance, `nMaxChannel: undefined` from `_parseResponse()`, and `mapUDPDevice()`'s `MaxChannel` **shall** fall back to `1`. The same underlying bytes reparsed with `nMode` forced to `12` **shall** have `MaxChannel`/`nMaxChannel` equal to the decoded `nMulticastPort` value, and `mapUDPDevice()`'s `MaxChannel` **shall** surface that value when `> 1`. See TC-H-040.

**Known limitation**: no real device sending a genuine `nMode=12` response has been captured on this network — TC-H-040 verifies the parsing *mechanism* (correct gating on `nMode`) against a synthetic fixture, not that a real device's `nMulticastPort`-as-`MaxChannel` value is semantically a valid channel count. The credential-gated SUNAPI CGI fallback (`querySunapiMaxChannel()`, FR-CAM-068) remains a secondary/cross-check source, not superseded by this requirement.

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
| C-06 | ONVIF enrichment calls send no SOAP-level WS-Security (`wsse:UsernameToken`) authentication; a camera requiring that scheme specifically returns partial data. HTTP-transport-layer Basic/Digest auth is supported when `credentials` are supplied (FR-CAM-090) — this only covers devices gating access at the HTTP layer, not ONVIF's own WS-Security mechanism |
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
| 1.7 | 2026-07-02 | LTS Engineering Team | FR-CAM-077 추가 — SUNAPI CGI 클라이언트(`sunapiRequest()`)도 동일 호스트 리다이렉트 1회 추적(FR-CAM-076의 SUNAPI측 대응, 192.168.214.37 실측 검증); FR-CAM-078 추가 — `channelRtspUrl()`이 `/profileN/`과 `/N/H.264/`(0-based) 두 SUNAPI 컨벤션을 모두 인식하도록 확장(이 네트워크 실제 카메라 대다수가 후자를 사용함을 DB 조사로 확인); FR-CAM-079 추가 — SUNAPI RTSP 포트를 `network.cgi?msubmenu=portconf&action=view`(평문 key=value 응답) CGI로 확인, 미확인 시 554 폴백; FR-CAM-080 추가 — `probe-channels` 응답에 `sunapiProfiles`/`onvifProfiles`/`sunapiRtspPort` 필드 추가, 프로토콜별 URL 독립 보고 |
| 1.8 | 2026-07-02 | LTS Engineering Team | FR-CAM-081 추가 — UDP Discovery 확장 필드(`modelType` 등)가 패킷이 짧을 때 `undefined` 대신 거짓 `0`/`''`을 반환하던 파싱 버그 수정(순차 bounds-check로 전환), `DeviceType` 사람이 읽을 수 있는 라벨 필드 신규 노출(벤더 스펙 Device Type enum). 벤더 SUNAPI IP Installer 스펙 §3.4.2를 사용자가 직접 제공해 실측 검증 — MaxChannel/Nonce 필드는 `nVersion 0x08` 지원 기기에서만 조건부로 존재함을 확인(이 네트워크 실 카메라 2대는 262바이트 고정 응답으로 해당 필드 자체가 없음을 raw 패킷 byte-diff로 검증) |
| 1.9 | 2026-07-02 | LTS Engineering Team | FR-CAM-082 추가 — `UDPDiscoveryFallback`이 ONVIF XML 전용 스텁이던 것을 벤더 스펙 §3.4 "IP Scan for SUNAPI" 준수 실제 WiseNet 바이너리 파서로 교체, 서브모듈과 byte-for-byte parity 요구사항 명문화. 서브모듈 미초기화 시 SUNAPI 카메라를 조용히 못 찾던 결함 수정. nMode=6(SCAN_EX) 요청 옵코드 실측 조사(정보성, 비채택) 기록 |
| 1.10 | 2026-07-03 | LTS Engineering Team | FR-CAM-083 추가 — `supported_protocol`/`no_password` 오프셋 정정(고객이 Annex A `DATAPACKET_EXT_IPv4_T` 구조체와 대조해 발견 — `noPassword`가 `supported_protocol`의 바이트를 대신 읽고 실제 `no_password` 바이트는 한 번도 읽힌 적 없던 1-필드 오프셋 버그). FR-CAM-084 추가 — 벤더 스펙 §3.4.2/§4.4.2(고객이 지목한 "§4.4.2/`_response_5`")와 Table 1/2의 `nMode` enum을 분석, 확장 필드 블록 존재 여부가 남은 바이트 수가 아니라 응답의 `nMode`(=12, DEF_RES_SCAN_EXT)로 결정되어야 함을 확인·반영 — 이 네트워크 실 카메라는 전부 미문서화된 base-mode 값(11)으로 응답하며 해당 모드의 와이어 포맷(Annex A `DATAPACKET_IPv4_T`)에는 확장 필드가 애초에 없음 |
| 1.11 | 2026-07-03 | LTS Engineering Team | FR-CAM-084 확장 — 고객 요청으로 Table 1/2의 `nMode` enum 12개 값 전체를 명명된 상수(`NMODE`)로 분리하고, `_parseResponse()`가 RSA 키교환/password-apply 등 IP-Scan과 무관한 7개 모드에 대해 즉시 `null`을 반환하도록 2단계 분기(non-scan 모드 조기 반환 → scan 모드 파싱)로 재구성 — 이전에는 모든 `nMode` 값을 암묵적으로 IP-Scan 응답으로 취급했음. TC-H-033/034 추가 |
| 1.12 | 2026-07-03 | LTS Engineering Team | FR-CAM-085 추가 — SendData/RecvData 구조체 `reserved2`/`reserved3` 오프셋 반영(332→334바이트). FR-CAM-086 추가 — 요청 옵코드 `nMode=6` 기본 전환(FR-CAM-082 non-goal 결정 뒤집음). FR-CAM-087 추가 — `protocol.js` 단일 소스화, `UDPDiscoveryFallback` 인라인 폴백 완전 제거하고 npm `optionalDependencies`(`wisenet-chrome-ip-installer`)로 대체(FR-CAM-082를 대체·상태 갱신). FR-CAM-088 추가 — RTSP URL 생성이 `nTcpPort`/`nPort`를 오용하던 버그 수정(SUNAPI 표준 554 고정). FR-CAM-089 추가 — SUNAPI CGI Digest 인증 감지가 콤바인드 `WWW-Authenticate` 헤더를 인식하도록 보강 |
| 1.13 | 2026-07-03 | LTS Engineering Team | FR-CAM-090 추가 — ONVIF SOAP 클라이언트(`onvifDiscovery.js` `soapPost()`)가 HTTP Basic 시도 후 Digest 챌린지 수신 시 재시도하도록 확장(FR-CAM-072/089의 ONVIF측 대응); `buildDigestAuthHeader()`를 `server/src/utils/digestAuth.js`로 이동해 `discoveryService.js`/`onvifDiscovery.js`가 공유; `enrichDevice()`/`enrichDeviceAutoScheme()`/`ONVIFDiscovery`에 `credentials`/`username`+`password` 스레딩, `POST /api/cameras/probe-channels`가 이미 계산한 `effectiveUsername`/`effectivePassword`를 ONVIF 프로브에도 전달하도록 수정. FR-CAM-014·C-06을 SOAP 레벨 WS-Security(미구현)로 스코프 조정. TC-H-037~039b 추가 |
| 1.14 | 2026-07-03 | LTS Engineering Team | FR-CAM-091 추가 — UDP Discovery가 확장 스캔 응답(`nMode=12`, `DEF_RES_SCAN_EXT`)에서 `nMulticastPort` 값을 `MaxChannel`로 도출하도록 구현(FR-CAM-081 Document History가 미구현으로 남겨둔 부분); 벤더 스펙의 `nVersion 0x08` 조건 대신 이 네트워크에서 검증 가능한 `nMode` 조건 사용. `UdpResponse`(response.js)에 `MaxChannel` getter 신규 추가, `_parseResponse()`(udpDiscovery.js)가 `nMaxChannel`로 노출(다른 raw 숫자 필드와 동일한 `n` 접두사 명명), `mapUDPDevice()`가 `raw.nMaxChannel` 참조로 갱신. 진짜 `nMode=12` 기기는 여전히 미포착 — TC-H-040은 합성 픽스처로 파싱 메커니즘만 검증 |
| 1.15 | 2026-07-03 | LTS Engineering Team | FR-CAM-087 정정 — `server/src/utils/udpDiscovery.js`가 서브모듈 경로와 npm 패키지 중 하나를 우선순위로 시도한다는 요구사항을 npm 패키지(`wisenet-chrome-ip-installer`) **단일** 의존으로 정정(사용자 명시 지시). "지연 로딩" 요구사항 신규 추가 — `require('wisenet-chrome-ip-installer/...')`를 파일 최상단에서 즉시 실행하던 초판이 `SERVER_MODE=analysis`(discovery 미사용) 서버를 패키지 미설치 시 기동 실패시키는 회귀를 실측으로 유발, `getUDPDiscovery()`/재노출 프로퍼티 접근 시점까지 지연시키도록 수정 |
